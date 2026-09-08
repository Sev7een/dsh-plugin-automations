import { randomUUID } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'
import { z } from 'zod'
import type { DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import type { CreateTaskInput, ScheduledTask, TaskError, TaskTable, TaskSchedule, TaskMutationLock } from './types.js'
import { MAX_ERROR_MESSAGE_BYTES, MAX_PROMPT_BYTES } from './types.js'
import { validateTaskTemplate, TaskTemplateError } from './template.js'

const rfc3339Instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const executionModeSchema = z.union([z.literal('on_time'), z.literal('when_idle')])
const onceScheduleSchema = z.object({ type: z.literal('once'), scheduledAt: z.string().regex(rfc3339Instant) }).strict()
const cronScheduleSchema = z.object({ type: z.literal('cron'), expression: z.string().min(1).max(512) }).strict()
const taskScheduleSchema: z.ZodType<TaskSchedule> = z.union([onceScheduleSchema, cronScheduleSchema])
const taskStateSchema = z.union([
  z.literal('pending'), z.literal('waiting_idle'), z.literal('running'), z.literal('completed'), z.literal('failed'),
])

export const taskErrorSchema: z.ZodType<TaskError> = z.object({
  code: z.string().min(1).max(128),
  message: z.string().refine(value => Buffer.byteLength(value, 'utf8') <= MAX_ERROR_MESSAGE_BYTES),
}).strict()

export const scheduledTaskSchema = z.object({
  id: z.string().uuid(),
  prompt: z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= MAX_PROMPT_BYTES),
  schedule: taskScheduleSchema,
  scheduledAt: z.string().regex(rfc3339Instant),
  mode: executionModeSchema,
  sessionTitleTemplate: z.string().min(1).optional(),
  state: taskStateSchema,
  sessionId: z.string().min(1).optional(),
  createdAt: z.string().regex(rfc3339Instant),
  startedAt: z.string().regex(rfc3339Instant).optional(),
  finishedAt: z.string().regex(rfc3339Instant).optional(),
  error: taskErrorSchema.optional(),
}).strict()

export const scheduledTasksDomainSpec = {
  name: 'scheduled_tasks',
  version: 2,
  tables: {
    tasks: { valueSchema: scheduledTaskSchema as unknown as z.ZodType<ScheduledTask> },
  },
} as const satisfies DomainSpec

export class RequestError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
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

function exactKeys(value: Record<string, unknown>, expected: readonly string[], message = 'Request body contains missing or unsupported fields.'): void {
  const keys = Object.keys(value).sort()
  const sorted = [...expected].sort()
  if (keys.length !== sorted.length || keys.some((key, index) => key !== sorted[index])) {
    throw new RequestError('invalid_request', message)
  }
}

function allowedKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const allowed = new Set(expected)
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new RequestError('invalid_request', 'Request body contains unsupported fields.')
  }
}

function parseCronExpression(expression: string, code = 'invalid_cron'): string {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 6) throw new RequestError(code, 'cron expression must contain six fields: second minute hour day-of-month month day-of-week.')
  try {
    CronExpressionParser.parse(expression, { currentDate: new Date() }).next()
  } catch (error) {
    throw new RequestError(code, `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`)
  }
  return expression.trim()
}

/** Return the next strict match using the host process's local timezone. */
export function nextCronAfter(expression: string, after = Date.now()): string {
  const normalized = parseCronExpression(expression)
  try {
    const next = CronExpressionParser.parse(normalized, { currentDate: new Date(after) }).next().toDate()
    if (!Number.isFinite(next.getTime())) throw new Error('cron parser returned an invalid occurrence')
    return next.toISOString()
  } catch (error) {
    throw new RequestError('invalid_cron', `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseSchedule(raw: unknown, now: number): { schedule: TaskSchedule; scheduledAt: string } {
  const value = requireObject(raw)
  if (value.type === 'once') {
    exactKeys(value, ['type', 'scheduledAt'])
    if (typeof value.scheduledAt !== 'string' || !rfc3339Instant.test(value.scheduledAt)) {
      throw new RequestError('invalid_scheduled_at', 'schedule.scheduledAt must be an RFC 3339 instant with an offset.')
    }
    const epoch = Date.parse(value.scheduledAt)
    if (!Number.isFinite(epoch)) throw new RequestError('invalid_scheduled_at', 'schedule.scheduledAt is not a valid instant.')
    if (epoch <= now) throw new RequestError('not_future', 'schedule.scheduledAt must be later than the current time.')
    const scheduledAt = new Date(epoch).toISOString()
    return { schedule: { type: 'once', scheduledAt }, scheduledAt }
  }
  if (value.type === 'cron') {
    exactKeys(value, ['type', 'expression'])
    if (typeof value.expression !== 'string' || value.expression.trim() === '') {
      throw new RequestError('invalid_cron', 'schedule.expression must be a non-empty string.')
    }
    const expression = parseCronExpression(value.expression)
    return { schedule: { type: 'cron', expression }, scheduledAt: nextCronAfter(expression, now) }
  }
  throw new RequestError('invalid_schedule', 'schedule must be a once or cron object.')
}

export function parseCreateTaskInput(raw: unknown, now = Date.now()): CreateTaskInput & { scheduledAt: string } {
  const value = requireObject(raw)
  allowedKeys(value, ['mode', 'prompt', 'schedule', 'sessionTitleTemplate'])
  if (typeof value.prompt !== 'string') throw new RequestError('invalid_prompt', 'prompt must be a string.')
  const prompt = value.prompt.trim()
  if (prompt.length === 0) throw new RequestError('invalid_prompt', 'prompt must not be empty.')
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) throw new RequestError('prompt_too_large', 'prompt must not exceed 64 KiB.')
  if (value.mode !== 'on_time' && value.mode !== 'when_idle') throw new RequestError('invalid_mode', 'mode must be on_time or when_idle.')

  let sessionTitleTemplate: string | undefined
  if (value.sessionTitleTemplate !== undefined) {
    if (typeof value.sessionTitleTemplate !== 'string' || value.sessionTitleTemplate.trim() === '') {
      throw new RequestError('invalid_title_template', 'sessionTitleTemplate must be a non-empty string when provided.')
    }
    sessionTitleTemplate = value.sessionTitleTemplate
    try {
      validateTaskTemplate(sessionTitleTemplate)
    } catch (error) {
      if (error instanceof TaskTemplateError) throw new RequestError('invalid_title_template', error.message)
      throw error
    }
  }
  const parsed = parseSchedule(value.schedule, now)
  return {
    prompt,
    schedule: parsed.schedule,
    scheduledAt: parsed.scheduledAt,
    mode: value.mode,
    ...(sessionTitleTemplate === undefined ? {} : { sessionTitleTemplate }),
  }
}

export function createScheduledTask(input: CreateTaskInput & { scheduledAt?: string }, now = Date.now()): ScheduledTask {
  const scheduledAt = input.scheduledAt ?? (input.schedule.type === 'once'
    ? input.schedule.scheduledAt
    : nextCronAfter(input.schedule.expression, now))
  const task: ScheduledTask = {
    id: randomUUID(),
    prompt: input.prompt,
    schedule: input.schedule,
    scheduledAt,
    mode: input.mode,
    ...(input.sessionTitleTemplate === undefined ? {} : { sessionTitleTemplate: input.sessionTitleTemplate }),
    state: 'pending',
    createdAt: new Date(now).toISOString(),
  }
  scheduledTaskSchema.parse(task)
  return task
}

export function canonicalTaskContent(input: Pick<ScheduledTask, 'prompt' | 'schedule' | 'mode' | 'sessionTitleTemplate'>): string {
  return JSON.stringify({
    mode: input.mode,
    prompt: input.prompt,
    schedule: input.schedule,
    sessionTitleTemplate: input.sessionTitleTemplate ?? null,
  })
}

export function findActiveTask(table: TaskTable, input: Pick<ScheduledTask, 'prompt' | 'schedule' | 'mode' | 'sessionTitleTemplate'>): ScheduledTask | undefined {
  const expected = canonicalTaskContent(input)
  return [...table.entries()]
    .map(([, task]) => task)
    .filter(task => task.state === 'pending' || task.state === 'waiting_idle' || task.state === 'running')
    .find(task => canonicalTaskContent(task) === expected)
}

export async function createTaskIdempotent(
  table: TaskTable,
  raw: unknown,
  lock: TaskMutationLock,
  beforeCreate?: () => Promise<void>,
  now = Date.now(),
): Promise<{ task: ScheduledTask; created: boolean }> {
  const input = parseCreateTaskInput(raw, now)
  return lock.run(async () => {
    await beforeCreate?.()
    const existing = findActiveTask(table, input)
    if (existing !== undefined) return { task: existing, created: false }
    const task = createScheduledTask(input, now)
    await table.put(task.id, task)
    return { task, created: true }
  })
}

export function listTasks(table: TaskTable): ScheduledTask[] {
  return [...table.entries()].map(([, task]) => task)
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
  return { code, message: truncateUtf8(raw || 'The task failed.', MAX_ERROR_MESSAGE_BYTES) }
}

export async function recoverInterruptedTasks(table: TaskTable, now = Date.now()): Promise<number> {
  const finishedAt = new Date(now).toISOString()
  const running = [...table.entries()].filter(([, task]) => task.state === 'running')
  for (const [id] of running) {
    await table.update(id, current => current.state !== 'running' ? current : {
      ...current,
      state: 'failed',
      finishedAt,
      error: { code: 'host_interrupted', message: 'The host stopped before the scheduled task reached a terminal state.' },
    })
  }
  return running.length
}
