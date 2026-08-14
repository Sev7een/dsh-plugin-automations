import { describe, expect, it } from 'vitest'
import { TaskScheduler } from '../src/scheduler.js'
import { FakeTimer, MemoryTaskTable, task } from './helpers.js'

const NOW = Date.parse('2026-08-15T00:00:01.000Z')

describe('on-time scheduler', () => {
  it('claims a due task even while a foreground root Agent is running', async () => {
    const table = new MemoryTaskTable([task()])
    const runs: string[] = []
    const scheduler = new TaskScheduler({
      table,
      timer: new FakeTimer(),
      executor: { run: async claimed => { runs.push(claimed.id) } },
      now: () => NOW,
    })
    scheduler.start()
    await scheduler.settle()

    expect(runs).toEqual([task().id])
    expect(table.get(task().id)).toMatchObject({ state: 'running', startedAt: expect.any(String) })
  })

  it('serializes repeated wakeups and never claims one task twice', async () => {
    const table = new MemoryTaskTable([task()])
    let count = 0
    const scheduler = new TaskScheduler({
      table,
      timer: new FakeTimer(),
      executor: { run: async () => { count += 1 } },
      now: () => NOW,
    })
    scheduler.requestPump()
    scheduler.requestPump()
    scheduler.requestPump()
    await scheduler.settle()
    scheduler.requestPump()
    await scheduler.settle()
    expect(count).toBe(1)
  })

  it('rechecks wall clock after a segmented future timer', async () => {
    let now = NOW
    const table = new MemoryTaskTable([task({ scheduledAt: new Date(NOW + 5_000).toISOString() })])
    const timer = new FakeTimer()
    let count = 0
    const scheduler = new TaskScheduler({
      table, timer,
      executor: { run: async () => { count += 1 } }, now: () => now,
    })
    scheduler.start()
    await scheduler.settle()
    expect(timer.callbacks.at(-1)?.delay).toBe(5_000)
    now += 5_000
    timer.fireNext()
    await scheduler.settle()
    expect(count).toBe(1)
  })
})
