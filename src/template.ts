import moment from 'moment'
import type { ScheduledTask } from './types.js'

const DATE_FIELDS = new Set(['scheduledAt', 'createdAt', 'startedAt', 'finishedAt'])
const TERMINAL_FIELDS = new Set(['finishedAt', 'error'])
const KNOWN_FIELDS = new Set([
  'id', 'prompt', 'schedule', 'schedule.type', 'schedule.expression', 'schedule.scheduledAt',
  'scheduledAt', 'mode', 'state', 'sessionId', 'createdAt', 'startedAt', 'finishedAt', 'error',
])
const TOKEN = /{{\s*([^{}]+?)\s*}}/g
const FIELD = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/

export class TaskTemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskTemplateError'
  }
}

function getField(task: ScheduledTask, path: string): unknown {
  let value: unknown = task
  for (const part of path.split('.')) {
    if (typeof value !== 'object' || value === null || !(part in value)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

function validateToken(raw: string): { field: string; format?: string } {
  const separator = raw.indexOf(':')
  const field = (separator < 0 ? raw : raw.slice(0, separator)).trim()
  const format = separator < 0 ? undefined : raw.slice(separator + 1)
  if (!FIELD.test(field)) throw new TaskTemplateError(`Unknown or invalid task template field: ${field || '(empty)'}`)
  const root = field.split('.', 1)[0]!
  if (!KNOWN_FIELDS.has(field)) throw new TaskTemplateError(`Unknown or invalid task template field: ${field}`)
  if (TERMINAL_FIELDS.has(root)) throw new TaskTemplateError(`Task template field is unavailable before completion: ${field}`)
  if (format !== undefined) {
    if (format.length === 0 || !DATE_FIELDS.has(root) || field.includes('.')) {
      throw new TaskTemplateError(`Datetime formatting requires a timestamp field: ${field}`)
    }
  }
  return format === undefined ? { field } : { field, format }
}

/** Validate a template at task creation time without needing an occurrence. */
export function validateTaskTemplate(template: string | undefined): void {
  if (template === undefined) return
  let end = 0
  for (const match of template.matchAll(TOKEN)) {
    if (match.index !== end && /{{|}}/.test(template.slice(end, match.index))) {
      throw new TaskTemplateError('Task title template contains an unmatched brace.')
    }
    validateToken(match[1] ?? '')
    end = (match.index ?? 0) + match[0].length
  }
  if (/{{|}}/.test(template.slice(end))) throw new TaskTemplateError('Task title template contains an unmatched brace.')
}

/** Expand a validated task title template for one claimed occurrence. */
export function renderTaskTitle(task: ScheduledTask): string | undefined {
  const template = task.sessionTitleTemplate
  if (template === undefined) return undefined
  validateTaskTemplate(template)
  return template.replace(TOKEN, (_whole, raw: string) => {
    const { field, format } = validateToken(raw)
    const value = getField(task, field)
    if (value === undefined || value === null) throw new TaskTemplateError(`Task template field is unavailable for this occurrence: ${field}`)
    if (format !== undefined) return moment(String(value)).format(format)
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  })
}
