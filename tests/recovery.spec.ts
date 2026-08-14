import { describe, expect, it } from 'vitest'
import { recoverInterruptedTasks } from '../src/domain.js'
import { MemoryTaskTable, task } from './helpers.js'

describe('startup recovery', () => {
  it('fails orphaned running tasks and leaves terminal/pending tasks unchanged', async () => {
    const running = task({ state: 'running', sessionId: 'session-old', startedAt: '2026-08-14T00:01:00.000Z' })
    const pending = task({ id: '5cf516f4-d771-48c0-8be7-c58334136189' })
    const completed = task({ id: '5cf516f4-d771-48c0-8be7-c58334136190', state: 'completed' })
    const table = new MemoryTaskTable([running, pending, completed])

    await expect(recoverInterruptedTasks(table, Date.parse('2026-08-15T00:00:00Z'))).resolves.toBe(1)
    expect(table.get(running.id)).toMatchObject({
      state: 'failed',
      error: { code: 'host_interrupted' },
      finishedAt: '2026-08-15T00:00:00.000Z',
    })
    expect(table.get(pending.id)?.state).toBe('pending')
    expect(table.get(completed.id)?.state).toBe('completed')
  })
})
