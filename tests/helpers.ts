import type { ScheduledTask, TaskTable, TimerPort } from '../src/types.js'

export class MemoryTaskTable implements TaskTable {
  readonly records = new Map<string, ScheduledTask>()

  constructor(tasks: ScheduledTask[] = []) {
    for (const task of tasks) this.records.set(task.id, task)
  }

  get(id: string): ScheduledTask | undefined { return this.records.get(id) }
  entries(): IterableIterator<[string, ScheduledTask]> { return new Map(this.records).entries() }
  async put(id: string, task: ScheduledTask): Promise<void> { this.records.set(id, task) }
  async update(id: string, update: (current: ScheduledTask) => ScheduledTask): Promise<ScheduledTask> {
    const current = this.records.get(id)
    if (current === undefined) throw new Error(`missing task ${id}`)
    const next = update(current)
    this.records.set(id, next)
    return next
  }
}

export class FakeTimer implements TimerPort {
  callbacks: Array<{ callback: () => void; delay: number; active: boolean }> = []

  timeout(callback: () => void, delay: number): () => void {
    const record = { callback, delay, active: true }
    this.callbacks.push(record)
    return () => { record.active = false }
  }

  fireNext(): void {
    const next = this.callbacks.find(item => item.active)
    if (next === undefined) throw new Error('no active timer')
    next.active = false
    next.callback()
  }
}

export function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: '6c7543c8-42ad-44ea-999f-5b00b5da9c5f',
    prompt: 'check tests',
    scheduledAt: '2026-08-15T00:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    mode: 'on_time',
    repeat: 'once',
    state: 'pending',
    createdAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  }
}
