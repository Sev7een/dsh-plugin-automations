import { describe, expect, it } from 'vitest'
import {
  canonicalTaskContent,
  createScheduledTask,
  createTaskIdempotent,
  findActiveTask,
  nextCronAfter,
  parseCreateTaskInput,
  RequestError,
} from '../src/domain.js'
import { AsyncTaskMutationLock } from '../src/mutex.js'
import { renderTaskTitle } from '../src/template.js'
import { MemoryTaskTable, task } from './helpers.js'

const NOW = Date.parse('2026-08-14T12:00:00.000Z')

describe('task creation contract', () => {
  it('normalizes a future once schedule', () => {
    expect(parseCreateTaskInput({
      prompt: ' run tests ',
      schedule: { type: 'once', scheduledAt: '2026-08-15T01:00:00+08:00' },
      mode: 'on_time',
    }, NOW)).toEqual({
      prompt: 'run tests',
      schedule: { type: 'once', scheduledAt: '2026-08-14T17:00:00.000Z' },
      scheduledAt: '2026-08-14T17:00:00.000Z',
      mode: 'on_time',
    })
  })

  it('computes the first cron occurrence in the local timezone', () => {
    expect(nextCronAfter('0 0 8 * * *', NOW)).toBe('2026-08-15T00:00:00.000Z')
  })

  it.each([
    [{ prompt: 'x', schedule: { type: 'once', scheduledAt: '2026-08-14T11:00:00Z' }, mode: 'on_time' }, 'not_future'],
    [{ prompt: 'x', schedule: { type: 'cron', expression: '0 8 * * *' }, mode: 'on_time' }, 'invalid_cron'],
    [{ prompt: 'x', schedule: { type: 'cron', expression: '0 0 8 * * 8' }, mode: 'on_time' }, 'invalid_cron'],
    [{ prompt: 'x', schedule: { type: 'once', scheduledAt: '2026-08-15T01:00:00Z' }, mode: 'later' }, 'invalid_mode'],
    [{ prompt: 'x', schedule: { type: 'once', scheduledAt: '2026-08-15T01:00:00Z' }, mode: 'on_time', extra: true }, 'invalid_request'],
  ])('rejects invalid input %#', (input, code) => {
    try {
      parseCreateTaskInput(input, NOW)
      throw new Error('expected validation error')
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError)
      expect((error as RequestError).code).toBe(code)
    }
  })

  it('rejects terminal-only and unknown title template fields', () => {
    for (const template of ['Daily Feed · {{finishedAt}}', '{{unknown}}']) {
      expect(() => parseCreateTaskInput({
        prompt: 'x', schedule: { type: 'cron', expression: '0 0 8 * * *' }, mode: 'on_time', sessionTitleTemplate: template,
      }, NOW)).toThrowError(RequestError)
    }
  })

  it('renders the claimed occurrence title with task fields and requested precision', () => {
    const scheduled = createScheduledTask(parseCreateTaskInput({
      prompt: 'x', schedule: { type: 'cron', expression: '0 0 8 * * *' }, mode: 'on_time',
      sessionTitleTemplate: 'Daily Feed · {{scheduledAt:YYYY-MM-DD}} · {{mode}} · {{sessionId}}',
    }, NOW), NOW)
    const claimed = {
      ...scheduled,
      state: 'running' as const,
      sessionId: 'session-1',
      startedAt: '2026-08-15T00:00:00.000Z',
    }
    expect(renderTaskTitle(claimed)).toBe('Daily Feed · 2026-08-15 · on_time · session-1')
  })
})

describe('content-idempotent creation', () => {
  it('reuses an active task but ignores terminal records', async () => {
    const active = createScheduledTask(parseCreateTaskInput({
      prompt: 'x', schedule: { type: 'cron', expression: '0 0 8 * * *' }, mode: 'on_time',
    }, NOW), NOW)
    const terminal = task({ id: '5cf516f4-d771-48c0-8be7-c58334136189', state: 'completed', schedule: { type: 'once', scheduledAt: '2026-08-15T00:00:00.000Z' }, scheduledAt: '2026-08-15T00:00:00.000Z' })
    const table = new MemoryTaskTable([active, terminal])
    expect(findActiveTask(table, active)).toBe(active)
    expect(findActiveTask(table, terminal)).toBeUndefined()
    const comparable = {
      prompt: active.prompt, schedule: active.schedule, mode: active.mode,
      ...(active.sessionTitleTemplate === undefined ? {} : { sessionTitleTemplate: active.sessionTitleTemplate }),
    }
    expect(canonicalTaskContent(active)).toBe(canonicalTaskContent(comparable))
  })

  it('serializes concurrent identical creations into one record', async () => {
    const table = new MemoryTaskTable()
    const lock = new AsyncTaskMutationLock()
    const input = { prompt: 'x', schedule: { type: 'cron', expression: '0 0 8 * * *' }, mode: 'on_time' }
    const results = await Promise.all(Array.from({ length: 12 }, () => createTaskIdempotent(table, input, lock, undefined, NOW)))
    expect(new Set(results.map(result => result.task.id)).size).toBe(1)
    expect(results.filter(result => result.created)).toHaveLength(1)
    expect([...table.records]).toHaveLength(1)
  })
})
