import { describe, expect, it } from 'vitest'
import { TaskScheduler } from '../src/scheduler.js'
import { AsyncTaskMutationLock } from '../src/mutex.js'
import { FakeTimer, MemoryTaskTable, task } from './helpers.js'

const NOW = Date.parse('2026-08-15T00:00:01.000Z')

describe('cron occurrence rollover', () => {
  it('advances a completed cron task to the next matching occurrence', async () => {
    const table = new MemoryTaskTable([task({
      schedule: { type: 'cron', expression: '0 0 8 * * *' },
      scheduledAt: '2026-08-15T00:00:00.000Z',
      state: 'completed', sessionId: 'session-done', startedAt: '2026-08-15T00:00:00.000Z', finishedAt: '2026-08-15T00:00:01.000Z',
    })])
    const scheduler = new TaskScheduler({ table, timer: new FakeTimer(), executor: { run: async () => {} }, now: () => NOW })
    await scheduler.rollCronOccurrences()
    expect(table.get(task().id)).toMatchObject({ state: 'pending', scheduledAt: '2026-08-16T00:00:00.000Z' })
    expect(table.get(task().id)?.sessionId).toBeUndefined()
  })

  it('advances a failed occurrence without retrying it', async () => {
    const table = new MemoryTaskTable([task({
      schedule: { type: 'cron', expression: '*/10 * * * * *' },
      scheduledAt: '2026-08-15T00:00:00.000Z', state: 'failed', finishedAt: '2026-08-15T00:00:01.000Z',
    })])
    const scheduler = new TaskScheduler({ table, timer: new FakeTimer(), executor: { run: async () => {} }, now: () => NOW })
    await scheduler.rollCronOccurrences()
    expect(table.get(task().id)).toMatchObject({ state: 'pending', scheduledAt: '2026-08-15T00:00:10.000Z' })
  })

  it('leaves a once task terminal', async () => {
    const done = task({ state: 'completed', scheduledAt: '2026-08-15T00:00:00.000Z' })
    const table = new MemoryTaskTable([done])
    const scheduler = new TaskScheduler({ table, timer: new FakeTimer(), executor: { run: async () => {} }, now: () => NOW })
    await scheduler.rollCronOccurrences()
    expect(table.get(done.id)?.state).toBe('completed')
  })

  it('serializes rollover with task creation through the shared lock', async () => {
    const table = new MemoryTaskTable([task({ schedule: { type: 'cron', expression: '0 0 8 * * *' }, scheduledAt: '2026-08-15T00:00:00.000Z', state: 'completed' })])
    const lock = new AsyncTaskMutationLock()
    const scheduler = new TaskScheduler({ table, lock, timer: new FakeTimer(), executor: { run: async () => {} }, now: () => NOW })
    await Promise.all([lock.run(() => scheduler.rollCronOccurrences()), lock.run(() => scheduler.rollCronOccurrences())])
    expect(table.get(task().id)?.scheduledAt).toBe('2026-08-16T00:00:00.000Z')
  })
})
