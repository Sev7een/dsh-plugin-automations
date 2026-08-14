import { describe, expect, it } from 'vitest'
import { TaskScheduler } from '../src/scheduler.js'
import { FakeTimer, MemoryTaskTable, task } from './helpers.js'

// 2026-08-15T02:00:00Z = 北京 10:00（高峰）；2026-08-15T01:30:00Z = 北京 09:30（高峰）
const NOW = Date.parse('2026-08-15T02:00:00.000Z')

describe('daily repeat rollover', () => {
  it('rolls a completed daily task to the next local day and resets it to pending', async () => {
    const table = new MemoryTaskTable([task({
      mode: 'on_time',
      repeat: 'daily',
      scheduledAt: '2026-08-15T01:30:00.000Z',
      state: 'completed',
      sessionId: 'session-done',
      startedAt: '2026-08-15T01:30:00.000Z',
      finishedAt: '2026-08-15T02:00:00.000Z',
    })])
    let count = 0
    const scheduler = new TaskScheduler({
      table,
      timer: new FakeTimer(),
      executor: { run: async () => { count += 1 } },
      now: () => NOW,
    })
    scheduler.start()
    await scheduler.settle()

    const rolled = table.get(task().id)
    expect(rolled).toMatchObject({
      state: 'pending',
      repeat: 'daily',
      scheduledAt: '2026-08-16T01:30:00.000Z', // 北京 09:30 的次日同一时刻
      mode: 'on_time',
    })
    expect(rolled?.sessionId).toBeUndefined()
    expect(rolled?.startedAt).toBeUndefined()
    expect(rolled?.finishedAt).toBeUndefined()
    expect(rolled?.error).toBeUndefined()
    expect(count).toBe(0) // 明天才到期，今天不重复执行
  })

  it('rolls a failed daily task too', async () => {
    const table = new MemoryTaskTable([task({
      repeat: 'daily',
      scheduledAt: '2026-08-15T01:30:00.000Z',
      state: 'failed',
      finishedAt: '2026-08-15T02:00:00.000Z',
      error: { code: 'agent_failed', message: 'boom' },
    })])
    const scheduler = new TaskScheduler({
      table,
      timer: new FakeTimer(),
      executor: { run: async () => {} },
      now: () => NOW,
    })
    scheduler.start()
    await scheduler.settle()

    const rolled = table.get(task().id)
    expect(rolled).toMatchObject({ state: 'pending', scheduledAt: '2026-08-16T01:30:00.000Z' })
    expect(rolled?.error).toBeUndefined()
    expect(rolled?.finishedAt).toBeUndefined()
  })

  it('leaves a one-shot completed task terminal', async () => {
    const done = task({
      repeat: 'once',
      scheduledAt: '2026-08-15T01:30:00.000Z',
      state: 'completed',
      finishedAt: '2026-08-15T02:00:00.000Z',
    })
    const table = new MemoryTaskTable([done])
    const scheduler = new TaskScheduler({
      table,
      timer: new FakeTimer(),
      executor: { run: async () => {} },
      now: () => NOW,
    })
    scheduler.start()
    await scheduler.settle()
    expect(table.get(done.id)).toMatchObject({ state: 'completed' })
    expect(table.get(done.id)?.scheduledAt).toBe('2026-08-15T01:30:00.000Z')
  })

  it('keeps the same wall-clock time across a DST transition', async () => {
    // 2026-03-07 10:00 EST（UTC-5）→ 次日 10:00 EDT（UTC-4）
    const table = new MemoryTaskTable([task({
      timeZone: 'America/New_York',
      repeat: 'daily',
      scheduledAt: '2026-03-07T15:00:00.000Z',
      state: 'completed',
      finishedAt: '2026-03-07T16:00:00.000Z',
    })])
    const scheduler = new TaskScheduler({
      table,
      timer: new FakeTimer(),
      executor: { run: async () => {} },
      now: () => Date.parse('2026-03-07T17:00:00.000Z'),
    })
    scheduler.start()
    await scheduler.settle()
    expect(table.get(task().id)?.scheduledAt).toBe('2026-03-08T14:00:00.000Z')
  })

  it('re-admits a daily idle task through the valley gate on its next occurrence', async () => {
    let now = NOW
    const table = new MemoryTaskTable([task({
      mode: 'when_idle',
      repeat: 'daily',
      scheduledAt: '2026-08-15T01:30:00.000Z', // 北京 09:30（高峰）
      state: 'completed',
      finishedAt: '2026-08-15T02:00:00.000Z',
    })])
    let count = 0
    const timer = new FakeTimer()
    const scheduler = new TaskScheduler({
      table,
      timer,
      executor: { run: async () => { count += 1 } },
      now: () => now,
    })
    scheduler.start()
    await scheduler.settle()

    // 滚动后：明天北京 09:30 到期，仍为高峰，进入 waiting_idle 并等待谷时段。
    const rolled = table.get(task().id)
    expect(rolled).toMatchObject({ state: 'pending', scheduledAt: '2026-08-16T01:30:00.000Z' })
    expect(count).toBe(0)

    now = Date.parse('2026-08-16T01:30:00.000Z') // 次日北京 09:30（高峰）
    timer.fireNext()
    await scheduler.settle()
    expect(table.get(task().id)?.state).toBe('waiting_idle')
    expect(count).toBe(0)
    // 边界定时器：下一个谷时段北京 12:00 = 04:00Z，距 01:30Z 2.5 小时。
    expect(timer.callbacks.at(-1)?.delay).toBe(2.5 * 60 * 60 * 1000)

    now = Date.parse('2026-08-16T04:00:00.000Z') // 次日北京 12:00（谷时段）
    timer.fireNext()
    await scheduler.settle()
    expect(count).toBe(1)
    expect(table.get(task().id)?.state).toBe('running')
  })
})
