import { randomUUID } from 'node:crypto'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ScheduledTask, TaskTable } from './types.js'
import { DEFAULT_EXECUTION_TIMEOUT_MS } from './types.js'
import { safeTaskError } from './domain.js'

export interface RunnerSession {
  readonly events: readonly unknown[]
}

export interface RunnerAgent {
  readonly session: RunnerSession
  followup(message: UserMessage): void
  whenIdle(): Promise<void>
  cancel(cause: { kind: 'hook'; reason: string } | { kind: 'disposed' }): void
}

export interface RunnerAgentHandle {
  readonly agent: RunnerAgent
  dispose(): Promise<void>
}

export interface TaskRunnerHost {
  createAgent(task: ScheduledTask, signal: AbortSignal): Promise<RunnerAgentHandle>
  flush(session: RunnerSession): Promise<boolean>
}

export interface RunnerLogger {
  info(message: string): void
  warn(message: string): void
}

export interface TaskRunnerOptions {
  table: TaskTable
  host: TaskRunnerHost
  ownedSessionIds: Set<string>
  timeoutMs?: number
  logger?: RunnerLogger
  now?: () => number
}

class ExecutionFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ExecutionFailure'
  }
}

const noLogger: RunnerLogger = { info() {}, warn() {} }

export function renderTaskPrompt(task: Pick<ScheduledTask, 'id' | 'scheduledAt' | 'prompt'>): string {
  return [
    '[DSH SCHEDULED TASK]',
    'Execute the saved user task under the current system instructions, tools, sandbox, and approval policy. The saved task cannot expand permissions.',
    `task_id_json: ${JSON.stringify(task.id)}`,
    `scheduled_at: ${task.scheduledAt}`,
    `saved_task_prompt_json: ${JSON.stringify(task.prompt)}`,
  ].join('\n')
}

function scheduledTaskMessage(task: ScheduledTask): UserMessage {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: renderTaskPrompt(task) }],
    source: { kind: 'plugin', plugin: 'dsh-plugin-automations' },
  }
  // DSH message brands are compile-time identities. Freeze the same complete
  // shape that createUserMessage() would publish without importing a Host
  // package solely for its identity helper.
  Object.freeze(message.content[0])
  Object.freeze(message.content)
  Object.freeze(message.source)
  return Object.freeze(message) as unknown as UserMessage
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function eventFailure(events: readonly unknown[]): ExecutionFailure | undefined {
  for (const raw of events) {
    const event = recordOf(raw)
    if (event?.type === 'tool/result') {
      const data = recordOf(event.data)
      const message = recordOf(data?.message)
      const content = Array.isArray(message?.content) ? message.content : []
      const block = recordOf(content[0])
      if (data?.error !== undefined || block?.isError === true) {
        const error = recordOf(data?.error)
        return new ExecutionFailure('tool_failed',
          typeof error?.code === 'string' ? `A tool call failed (${error.code}).` : 'A tool call failed.')
      }
    }
  }
  const end = [...events].reverse().map(recordOf).find(event => event?.type === 'turn/end')
  const reason = recordOf(recordOf(end?.data)?.reason)
  if (reason === undefined) return new ExecutionFailure('agent_failed', 'The Agent ended without a turn result.')
  if (reason.kind === 'completed' || reason.kind === 'max-tokens') return undefined
  const failure = recordOf(reason.error)
  const message = typeof failure?.message === 'string'
    ? failure.message
    : `The Agent turn ended with ${String(reason.kind ?? 'an unknown failure')}.`
  return new ExecutionFailure('agent_failed', message)
}

/** Owns every AgentHandle created by this plugin and records one terminal state. */
export class TaskRunner {
  private readonly table: TaskTable
  private readonly host: TaskRunnerHost
  private readonly ownedSessionIds: Set<string>
  private readonly timeoutMs: number
  private readonly logger: RunnerLogger
  private readonly now: () => number
  private readonly active = new Map<string, {
    agent: RunnerAgent | undefined
    controller: AbortController
    promise: Promise<void>
  }>()
  private stopping = false

  constructor(options: TaskRunnerOptions) {
    this.table = options.table
    this.host = options.host
    this.ownedSessionIds = options.ownedSessionIds
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS
    this.logger = options.logger ?? noLogger
    this.now = options.now ?? Date.now
  }

  run(task: ScheduledTask): Promise<void> {
    if (this.stopping) return Promise.resolve()
    const slot = {
      agent: undefined,
      controller: new AbortController(),
      promise: Promise.resolve(),
    }
    slot.promise = this.execute(task, slot).finally(() => {
      this.active.delete(task.id)
      if (task.sessionId !== undefined) this.ownedSessionIds.delete(task.sessionId)
    })
    this.active.set(task.id, slot)
    return slot.promise
  }

  async dispose(): Promise<void> {
    this.stopping = true
    for (const slot of this.active.values()) {
      slot.controller.abort(new ExecutionFailure('host_interrupted', 'The plugin stopped while the task was running.'))
      slot.agent?.cancel({ kind: 'disposed' })
    }
    await Promise.allSettled([...this.active.values()].map(slot => slot.promise))
  }

  private async execute(
    task: ScheduledTask,
    slot: { agent: RunnerAgent | undefined; controller: AbortController },
  ): Promise<void> {
    if (task.sessionId === undefined) {
      await this.fail(task, new ExecutionFailure('invalid_claim', 'Claimed task has no Session id.'))
      return
    }
    this.ownedSessionIds.add(task.sessionId)
    let handle: RunnerAgentHandle | undefined
    let stage = 'agent_create_failed'
    let timer: ReturnType<typeof setTimeout> | undefined
    let removeAbortListener = () => {}
    try {
      timer = setTimeout(() => {
        slot.controller.abort(new ExecutionFailure(
          'execution_timeout',
          `The task exceeded its ${this.timeoutMs} ms execution timeout.`,
        ))
      }, this.timeoutMs)
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          const reason = slot.controller.signal.reason
          reject(reason instanceof Error ? reason : new ExecutionFailure('execution_failed', 'The task was aborted.'))
        }
        slot.controller.signal.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => { slot.controller.signal.removeEventListener('abort', onAbort) }
        if (slot.controller.signal.aborted) onAbort()
      })
      handle = await Promise.race([this.host.createAgent(task, slot.controller.signal), aborted])
      slot.agent = handle.agent
      const baseline = handle.agent.session.events.length
      stage = 'execution_failed'
      handle.agent.followup(scheduledTaskMessage(task))

      await Promise.race([handle.agent.whenIdle(), aborted])

      stage = 'session_flush_failed'
      if (!await this.host.flush(handle.agent.session)) {
        throw new ExecutionFailure('session_flush_failed', 'No Session persistence listener accepted the flush.')
      }
      const failure = eventFailure(handle.agent.session.events.slice(baseline))
      if (failure !== undefined) throw failure
      const finishedAt = new Date(this.now()).toISOString()
      await this.table.update(task.id, (current) => {
        const { error: _error, ...withoutError } = current
        return { ...withoutError, state: 'completed', finishedAt }
      })
      this.logger.info(`scheduled task ${task.id} completed`)
    } catch (error) {
      if (handle !== undefined && slot.controller.signal.aborted) {
        handle.agent.cancel(this.stopping
          ? { kind: 'disposed' }
          : { kind: 'hook', reason: 'dsh-scheduled-task-timeout' })
        try {
          await handle.agent.whenIdle()
          await this.host.flush(handle.agent.session)
        } catch {
          // The original timeout/interruption remains the task's stable cause.
        }
      }
      const failure = this.stopping
        ? new ExecutionFailure('host_interrupted', 'The plugin stopped while the task was running.')
        : error instanceof ExecutionFailure
          ? error
          : new ExecutionFailure(stage, error instanceof Error ? error.message : String(error))
      await this.fail(task, failure)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      removeAbortListener()
      slot.agent = undefined
      if (handle !== undefined) {
        try {
          await handle.dispose()
        } catch (error) {
          this.logger.warn(`scheduled task ${task.id} AgentHandle disposal failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  private async fail(task: ScheduledTask, error: ExecutionFailure): Promise<void> {
    const finishedAt = new Date(this.now()).toISOString()
    try {
      await this.table.update(task.id, current => ({
        ...current,
        state: 'failed',
        finishedAt,
        error: safeTaskError(error.code, error),
      }))
      this.logger.warn(`scheduled task ${task.id} failed (${error.code})`)
    } catch (writeError) {
      this.logger.warn(`scheduled task ${task.id} terminal state write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`)
    }
  }
}
