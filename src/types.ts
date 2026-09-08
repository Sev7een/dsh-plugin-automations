export type ExecutionMode = 'on_time' | 'when_idle'

export interface OnceSchedule {
  type: 'once'
  scheduledAt: string
}

export interface CronSchedule {
  type: 'cron'
  expression: string
}

/** A one-shot instant or a standard six-field local cron expression. */
export type TaskSchedule = OnceSchedule | CronSchedule

export type TaskState =
  | 'pending'
  | 'waiting_idle'
  | 'running'
  | 'completed'
  | 'failed'

export interface TaskError {
  code: string
  message: string
}

export interface ScheduledTask {
  id: string
  prompt: string
  schedule: TaskSchedule
  /** Current occurrence instant; for cron this is the next occurrence. */
  scheduledAt: string
  mode: ExecutionMode
  sessionTitleTemplate?: string
  state: TaskState
  sessionId?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  error?: TaskError
}

export interface CreateTaskInput {
  prompt: string
  schedule: TaskSchedule
  mode: ExecutionMode
  sessionTitleTemplate?: string
}

export interface TaskMutationLock {
  run<T>(operation: () => Promise<T> | T): Promise<T>
}

export interface TaskTable {
  get(id: string): ScheduledTask | undefined
  entries(): IterableIterator<[string, ScheduledTask]>
  put(id: string, task: ScheduledTask): Promise<void>
  update(id: string, update: (current: ScheduledTask) => ScheduledTask): Promise<ScheduledTask>
}

export interface AgentView {
  id: string
  status: 'idle' | 'running'
}

export interface AgentRegistryView {
  roots(): AgentView[]
}

export interface TimerPort {
  timeout(callback: () => void, delayMs: number): () => void
}

export const MAX_PROMPT_BYTES = 64 * 1024
export const MAX_ERROR_MESSAGE_BYTES = 4 * 1024
export const DEFAULT_EXECUTION_TIMEOUT_MS = 30 * 60 * 1000
export const MAX_TIMER_DELAY_MS = 2_147_483_647
