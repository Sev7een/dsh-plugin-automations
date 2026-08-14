import { describe, expect, it } from 'vitest'
import { TaskRunner } from '../src/runner.js'
import { MemoryTaskTable, task } from './helpers.js'

describe('task runner', () => {
  it('uses plugin message provenance, flushes, completes, and disposes its handle', async () => {
    const claimed = task({ state: 'running', sessionId: 'session-owned', startedAt: '2026-08-15T00:00:00.000Z' })
    const table = new MemoryTaskTable([claimed])
    const messages: unknown[] = []
    const events: unknown[] = []
    let flushed = 0
    let disposed = 0
    const runner = new TaskRunner({
      table,
      ownedSessionIds: new Set(),
      host: {
        createAgent: async () => ({
          agent: {
            session: { events },
            followup(message) {
              messages.push(message)
              events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
            },
            whenIdle: async () => {},
            cancel() {},
          },
          dispose: async () => { disposed += 1 },
        }),
        flush: async () => { flushed += 1; return true },
      },
      now: () => Date.parse('2026-08-15T00:02:00Z'),
    })
    await runner.run(claimed)

    expect(messages[0]).toMatchObject({
      role: 'user',
      source: { kind: 'plugin', plugin: 'dsh-plugin-automations' },
    })
    expect(JSON.stringify(messages[0])).toContain('[DSH SCHEDULED TASK]')
    expect(flushed).toBe(1)
    expect(disposed).toBe(1)
    expect(table.get(claimed.id)).toMatchObject({ state: 'completed', finishedAt: '2026-08-15T00:02:00.000Z' })
  })

  it('bounds Agent creation with the execution timeout', async () => {
    const claimed = task({ state: 'running', sessionId: 'session-timeout' })
    const table = new MemoryTaskTable([claimed])
    const runner = new TaskRunner({
      table,
      ownedSessionIds: new Set(),
      timeoutMs: 5,
      host: {
        createAgent: async () => await new Promise(() => {}),
        flush: async () => true,
      },
    })
    await runner.run(claimed)
    expect(table.get(claimed.id)).toMatchObject({
      state: 'failed',
      error: { code: 'execution_timeout' },
    })
  })
})
