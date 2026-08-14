import { randomUUID } from 'node:crypto'
import type {
  ScheduledTask,
  TaskTable,
  TimerPort,
} from './types.js'
import { MAX_TIMER_DELAY_MS } from './types.js'
import { addLocalDays } from './domain.js'
import { isPeakHour, nextValleyStart } from './valley.js'

export interface ScheduledTaskExecutor {
  run(task: ScheduledTask): Promise<void>
}

export interface SchedulerLogger {
  info(message: string): void
  warn(message: string): void
}

export interface SchedulerOptions {
  table: TaskTable
  timer: TimerPort
  executor: ScheduledTaskExecutor
  logger?: SchedulerLogger
  now?: () => number
}

const noLogger: SchedulerLogger = { info() {}, warn() {} }

/**
 * One serialized wall-clock pump. Persistent task state is authoritative;
 * timers and HTTP wakeups merely wake this object to read it again.
 *
 * Execution semantics:
 * - `on_time`（准点执行）：到期后立即认领，不等待任何窗口。
 * - `when_idle`（空闲执行）：只在北京时间谷时段（09:00-12:00、14:00-18:00
 *   高峰之外）认领；高峰时段内保持 `waiting_idle`，并在下一个谷时段开始时
 *   被定时器唤醒。
 * - `repeat: 'daily'`（每天执行）：任务进入终态（completed/failed）后，
 *   自动把 scheduledAt 平移到下一自然日的同一本地时刻并重置为 pending。
 */
export class TaskScheduler {
  private readonly table: TaskTable
  private readonly timer: TimerPort
  private readonly executor: ScheduledTaskExecutor
  private readonly logger: SchedulerLogger
  private readonly now: () => number
  private disposed = false
  private rerun = false
  private pumping: Promise<void> | undefined
  private cancelTimer: (() => void) | undefined

  constructor(options: SchedulerOptions) {
    this.table = options.table
    this.timer = options.timer
    this.executor = options.executor
    this.logger = options.logger ?? noLogger
    this.now = options.now ?? Date.now
  }

  start(): void {
    this.requestPump()
  }

  /** Coalesce any number of timer, HTTP, and wakeups. */
  requestPump(): void {
    if (this.disposed) return
    this.rerun = true
    if (this.pumping !== undefined) return
    this.pumping = this.runPumps().finally(() => {
      this.pumping = undefined
      if (this.rerun && !this.disposed) this.requestPump()
    })
  }

  async settle(): Promise<void> {
    while (this.pumping !== undefined) await this.pumping
  }

  dispose(): void {
    this.disposed = true
    this.rerun = false
    this.clearTimer()
  }

  private async runPumps(): Promise<void> {
    while (this.rerun && !this.disposed) {
      this.rerun = false
      try {
        await this.pumpOnce()
      } catch (error) {
        this.logger.warn(`scheduled task pump failed: ${error instanceof Error ? error.message : String(error)}`)
        this.scheduleIn(1_000)
      }
    }
  }

  private async pumpOnce(): Promise<void> {
    this.clearTimer()
    const now = this.now()
    await this.rollDailyOccurrences()
    const candidates = [...this.table.entries()].map(([, task]) => task)
      .filter(task => task.state === 'pending' || task.state === 'waiting_idle')
      .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt)
        || left.createdAt.localeCompare(right.createdAt))

    for (let task of candidates) {
      if (this.disposed) return
      const target = Date.parse(task.scheduledAt)
      if (target > now) continue

      if (task.mode === 'when_idle' && task.state === 'pending') {
        task = await this.table.update(task.id, current => ({
          ...current,
          state: current.state === 'pending' ? 'waiting_idle' : current.state,
        }))
      }
      if (task.state !== 'pending' && task.state !== 'waiting_idle') continue
      // 空闲执行 = 谷时段执行：高峰时段内不认领，等待下一个谷时段。
      if (task.mode === 'when_idle' && isPeakHour(now)) continue

      const startedAt = new Date(this.now()).toISOString()
      const sessionId = `session-${randomUUID()}`
      const claimed = await this.table.update(task.id, current => {
        if (current.state !== 'pending' && current.state !== 'waiting_idle') return current
        const { error: _error, ...withoutError } = current
        return {
          ...withoutError,
          state: 'running',
          sessionId,
          startedAt,
        }
      })
      if (claimed.state !== 'running' || claimed.sessionId !== sessionId) continue

      this.logger.info(`scheduled task ${claimed.id} claimed (${claimed.mode})`)
      void this.executor.run(claimed).catch((error) => {
        this.logger.warn(`scheduled task ${claimed.id} runner escaped: ${error instanceof Error ? error.message : String(error)}`)
      }).finally(() => { this.requestPump() })
    }

    // 统一使用本次 pump 开始时读取的墙钟：claim 判定与下一次唤醒都基于同一
    // 时刻，避免边界跨过时出现 waiting_idle 任务无人唤醒。
    const pendingFutures = [...this.table.entries()].map(([, task]) => task)
      .filter(task => task.state === 'pending')
      .map(task => Date.parse(task.scheduledAt))
      .filter(target => target > now)
    let delay: number | undefined
    if (pendingFutures.length > 0) delay = Math.min(...pendingFutures) - now

    // 高峰时段内仍有 waiting_idle 任务时，在下一个谷时段开始时唤醒 pump。
    const hasWaitingIdle = [...this.table.entries()].some(([, task]) => task.state === 'waiting_idle')
    if (hasWaitingIdle) {
      const boundaryDelay = nextValleyStart(now) - now
      if (boundaryDelay > 0 && (delay === undefined || boundaryDelay < delay)) delay = boundaryDelay
    }
    if (delay !== undefined) this.scheduleIn(delay)
  }

  /**
   * 每天重复任务进入终态后，把 scheduledAt 平移到下一自然日的同一本地时刻，
   * 清空本次执行痕迹并重置为 pending，等待下一次到期。
   */
  private async rollDailyOccurrences(): Promise<void> {
    for (const [id, task] of this.table.entries()) {
      if (this.disposed) return
      if (task.repeat !== 'daily') continue
      if (task.state !== 'completed' && task.state !== 'failed') continue
      const nextScheduledAt = addLocalDays(task.scheduledAt, task.timeZone, 1)
      await this.table.update(id, current => {
        if (current.repeat !== 'daily'
          || (current.state !== 'completed' && current.state !== 'failed')) return current
        const { sessionId: _sessionId, startedAt: _startedAt, finishedAt: _finishedAt, error: _error, ...rest } = current
        return {
          ...rest,
          scheduledAt: nextScheduledAt,
          state: 'pending',
        }
      })
      this.logger.info(`scheduled task ${id} rolled to next daily occurrence (${nextScheduledAt})`)
    }
  }

  private scheduleIn(delayMs: number): void {
    if (this.disposed) return
    const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, delayMs))
    this.cancelTimer = this.timer.timeout(() => {
      this.cancelTimer = undefined
      this.requestPump()
    }, delay)
  }

  private clearTimer(): void {
    this.cancelTimer?.()
    this.cancelTimer = undefined
  }
}
