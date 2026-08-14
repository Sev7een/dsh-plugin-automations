import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import type { CreateTaskInput, ScheduledTask, TaskError, TaskTable } from './types.js'
import { MAX_ERROR_MESSAGE_BYTES, MAX_PROMPT_BYTES } from './types.js'

const rfc3339Instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const executionModeSchema = z.union([z.literal('on_time'), z.literal('when_idle')])
const repeatModeSchema = z.union([z.literal('once'), z.literal('daily')])
const taskStateSchema = z.union([
  z.literal('pending'),
  z.literal('waiting_idle'),
  z.literal('running'),
  z.literal('completed'),
  z.literal('failed'),
])

export const taskErrorSchema: z.ZodType<TaskError> = z.object({
  code: z.string().min(1).max(128),
  message: z.string().refine(value => Buffer.byteLength(value, 'utf8') <= MAX_ERROR_MESSAGE_BYTES),
}).strict()

export const scheduledTaskSchema = z.object({
  id: z.string().uuid(),
  prompt: z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= MAX_PROMPT_BYTES),
  scheduledAt: z.string().regex(rfc3339Instant),
  timeZone: z.string().min(1).max(255),
  mode: executionModeSchema,
  // Optional so records persisted before the repeat field existed still load.
  repeat: repeatModeSchema.optional(),
  state: taskStateSchema,
  sessionId: z.string().min(1).optional(),
  createdAt: z.string().regex(rfc3339Instant),
  startedAt: z.string().regex(rfc3339Instant).optional(),
  finishedAt: z.string().regex(rfc3339Instant).optional(),
  error: taskErrorSchema.optional(),
}).strict()

export const scheduledTasksDomainSpec = {
  // Current DSH storage units accept SQL-safe identifiers only. This is the
  // runtime spelling of the SDD's logical `scheduled-tasks` domain.
  name: 'scheduled_tasks',
  version: 1,
  tables: {
    tasks: { valueSchema: scheduledTaskSchema as unknown as z.ZodType<ScheduledTask> },
  },
} as const satisfies DomainSpec

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'RequestError'
  }
}

function requireObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RequestError('invalid_request', 'Request body must be a JSON object.')
  }
  return raw as Record<string, unknown>
}

function validateExactKeys(value: Record<string, unknown>): void {
  const expected = ['mode', 'prompt', 'repeat', 'scheduledAt', 'timeZone']
  const keys = Object.keys(value).sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new RequestError('invalid_request', 'Request body contains missing or unsupported fields.')
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone !== 'UTC' && !timeZone.includes('/')) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
    return true
  } catch {
    return false
  }
}

export function parseCreateTaskInput(raw: unknown, now = Date.now()): CreateTaskInput {
  const value = requireObject(raw)
  validateExactKeys(value)

  if (typeof value.prompt !== 'string') {
    throw new RequestError('invalid_prompt', 'prompt must be a string.')
  }
  const prompt = value.prompt.trim()
  if (prompt.length === 0) throw new RequestError('invalid_prompt', 'prompt must not be empty.')
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new RequestError('prompt_too_large', 'prompt must not exceed 64 KiB.')
  }

  if (typeof value.scheduledAt !== 'string' || !rfc3339Instant.test(value.scheduledAt)) {
    throw new RequestError('invalid_scheduled_at', 'scheduledAt must be an RFC 3339 instant with an offset.')
  }
  const epoch = Date.parse(value.scheduledAt)
  if (!Number.isFinite(epoch)) {
    throw new RequestError('invalid_scheduled_at', 'scheduledAt is not a valid instant.')
  }
  if (epoch <= now) throw new RequestError('not_future', 'scheduledAt must be later than the current time.')

  if (typeof value.timeZone !== 'string' || !isValidTimeZone(value.timeZone)) {
    throw new RequestError('invalid_time_zone', 'timeZone must be UTC or a valid IANA Area/Location name.')
  }
  if (value.mode !== 'on_time' && value.mode !== 'when_idle') {
    throw new RequestError('invalid_mode', 'mode must be on_time or when_idle.')
  }
  if (value.repeat !== 'once' && value.repeat !== 'daily') {
    throw new RequestError('invalid_repeat', 'repeat must be once or daily.')
  }

  return {
    prompt,
    scheduledAt: new Date(epoch).toISOString(),
    timeZone: value.timeZone,
    mode: value.mode,
    repeat: value.repeat,
  }
}

export function createScheduledTask(input: CreateTaskInput, now = Date.now()): ScheduledTask {
  const task: ScheduledTask = {
    id: randomUUID(),
    ...input,
    scheduledAt: new Date(Date.parse(input.scheduledAt)).toISOString(),
    state: 'pending',
    createdAt: new Date(now).toISOString(),
  }
  scheduledTaskSchema.parse(task)
  return task
}

export function listTasks(table: TaskTable): ScheduledTask[] {
  return [...table.entries()].map(([, task]) => ({
    ...task,
    // Records persisted before the repeat field existed read back without it;
    // the API contract always exposes an explicit value.
    repeat: task.repeat ?? 'once',
  }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let out = ''
  for (const char of value) {
    if (Buffer.byteLength(out + char + '…', 'utf8') > maxBytes) break
    out += char
  }
  return `${out}…`
}

export function safeTaskError(code: string, error: unknown): TaskError {
  const raw = error instanceof Error ? error.message : String(error)
  return {
    code,
    message: truncateUtf8(raw || 'The task failed.', MAX_ERROR_MESSAGE_BYTES),
  }
}

export async function recoverInterruptedTasks(table: TaskTable, now = Date.now()): Promise<number> {
  const finishedAt = new Date(now).toISOString()
  const running = [...table.entries()].filter(([, task]) => task.state === 'running')
  for (const [id] of running) {
    await table.update(id, (current) => current.state !== 'running' ? current : {
      ...current,
      state: 'failed',
      finishedAt,
      error: {
        code: 'host_interrupted',
        message: 'The host stopped before the scheduled task reached a terminal state.',
      },
    })
  }
  return running.length
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function localParts(ms: number, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const value = (type: string): number => {
    const part = parts.find(candidate => candidate.type === type)
    return part === undefined ? NaN : Number(part.value)
  }
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  }
}

/**
 * 把 RFC 3339 instant 按 `timeZone` 的本地钟面时间平移 `days` 天，
 * 返回平移后的 UTC instant。用于每天重复任务：保持同一本地时刻，
 * 并且跨夏令时切换时仍落在正确的本地钟面时刻。
 */
export function addLocalDays(instantIso: string, timeZone: string, days: number): string {
  const original = Date.parse(instantIso)
  const parts = localParts(original, timeZone)
  // 把“本地钟面时间”当作 UTC 求值，即可用纯算术处理日历进位。
  const localAsUtc = (ms: number): number => {
    const p = localParts(ms, timeZone)
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  }
  const target = Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second)
  // 先按原时刻的时区偏移估算，再按目标时刻附近的实际偏移修正（覆盖夏令时）。
  let guess = target + (original - localAsUtc(original))
  guess += target - localAsUtc(guess)
  guess += target - localAsUtc(guess)
  return new Date(guess).toISOString()
}
