export type ExecutionMode = 'on_time' | 'when_idle'

/** 重复方式：仅执行一次，或每天在同一本地时刻重复执行。 */
export type RepeatMode = 'once' | 'daily'

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
  scheduledAt: string
  timeZone: string
  mode: ExecutionMode
  /**
   * 重复方式。存储中可选以保证旧记录（v0.1.0 无此字段）可继续加载；
   * 缺失等价于 'once'。新建任务与 API 响应中始终为显式值。
   */
  repeat?: RepeatMode
  state: TaskState
  sessionId?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  error?: TaskError
}

export interface CreateTaskInput {
  prompt: string
  scheduledAt: string
  timeZone: string
  mode: ExecutionMode
  repeat: RepeatMode
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
