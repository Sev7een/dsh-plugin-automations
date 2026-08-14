import { describe, expect, it } from 'vitest'
import { TaskScheduler } from '../src/scheduler.js'
import { FakeTimer, MemoryTaskTable, task } from './helpers.js'

// 北京时间 = UTC + 8。
// 2026-08-15T02:00:00Z = 北京 10:00（高峰 09:00-12:00 内）
const BEIJING_10_PEAK = Date.parse('2026-08-15T02:00:00.000Z')
// 2026-08-15T00:00:00Z = 北京 08:00（谷时段）
const BEIJING_08_VALLEY = Date.parse('2026-08-15T00:00:00.000Z')
// 2026-08-15T04:00:00Z = 北京 12:00（谷时段开始，上一高峰结束）
const BEIJING_12_VALLEY = Date.parse('2026-08-15T04:00:00.000Z')
// 2026-08-15T07:00:00Z = 北京 15:00（高峰 14:00-18:00 内）
const BEIJING_15_PEAK = Date.parse('2026-08-15T07:00:00.000Z')
// 2026-08-15T10:00:00Z = 北京 18:00（谷时段开始，第二高峰结束）
const BEIJING_18_VALLEY = Date.parse('2026-08-15T10:00:00.000Z')

describe('when-idle（谷时段）admission', () => {
  it('keeps a due task waiting_idle during Beijing peak hours and arms the next valley-start timer', async () => {
    const table = new MemoryTaskTable([task({ mode: 'when_idle', scheduledAt: new Date(BEIJING_10_PEAK).toISOString() })])
    let count = 0
    const timer = new FakeTimer()
    const scheduler = new TaskScheduler({
      table,
      timer,
      executor: { run: async () => { count += 1 } },
      now: () => BEIJING_10_PEAK,
    })
    scheduler.start()
    await scheduler.settle()

    expect(table.get(task().id)?.state).toBe('waiting_idle')
    expect(count).toBe(0)
    // 下一个谷时段开始：北京 12:00 = 04:00 UTC，距当前 10:00（02:00 UTC）2 小时。
    expect(timer.callbacks.at(-1)?.delay).toBe(2 * 60 * 60 * 1000)
  })

  it('arms the timer at the end of the second peak window', async () => {
    const table = new MemoryTaskTable([task({ mode: 'when_idle', scheduledAt: new Date(BEIJING_15_PEAK).toISOString() })])
    const timer = new FakeTimer()
    const scheduler = new TaskScheduler({
      table,
      timer,
      executor: { run: async () => {} },
      now: () => BEIJING_15_PEAK,
    })
    scheduler.start()
    await scheduler.settle()

    expect(table.get(task().id)?.state).toBe('waiting_idle')
    // 下一个谷时段开始：北京 18:00 = 10:00 UTC，距当前 15:00（07:00 UTC）3 小时。
    expect(timer.callbacks.at(-1)?.delay).toBe(3 * 60 * 60 * 1000)
  })

  it('claims a due task immediately during valley hours', async () => {
    const table = new MemoryTaskTable([task({ mode: 'when_idle', scheduledAt: new Date(BEIJING_08_VALLEY).toISOString() })])
    let count = 0
    const timer = new FakeTimer()
    const scheduler = new TaskScheduler({
      table,
      timer,
      executor: { run: async () => { count += 1 } },
      now: () => BEIJING_08_VALLEY,
    })
    scheduler.start()
    await scheduler.settle()

    expect(count).toBe(1)
    expect(table.get(task().id)?.state).toBe('running')
  })

  it('claims a waiting_idle task when the valley-start timer fires', async () => {
    let now = BEIJING_10_PEAK
    const table = new MemoryTaskTable([task({ mode: 'when_idle', scheduledAt: new Date(BEIJING_10_PEAK).toISOString() })])
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
    expect(count).toBe(0)

    now = BEIJING_12_VALLEY
    timer.fireNext()
    await scheduler.settle()
    expect(count).toBe(1)
    expect(table.get(task().id)?.state).toBe('running')
  })

  it('claims a waiting_idle task when the second valley-start timer fires', async () => {
    let now = BEIJING_15_PEAK
    const table = new MemoryTaskTable([task({ mode: 'when_idle', scheduledAt: new Date(BEIJING_15_PEAK).toISOString() })])
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
    expect(count).toBe(0)

    now = BEIJING_18_VALLEY
    timer.fireNext()
    await scheduler.settle()
    expect(count).toBe(1)
    expect(table.get(task().id)?.state).toBe('running')
  })

  it('keeps exactly one valley-start wakeup across repeated pumps while peak persists', async () => {
    const table = new MemoryTaskTable([task({ mode: 'when_idle', scheduledAt: new Date(BEIJING_10_PEAK).toISOString() })])
    const timer = new FakeTimer()
    const scheduler = new TaskScheduler({
      table,
      timer,
      executor: { run: async () => {} },
      now: () => BEIJING_10_PEAK,
    })
    scheduler.requestPump()
    await scheduler.settle()
    scheduler.requestPump()
    await scheduler.settle()
    // 任务已进入 waiting_idle，之后不再有可认领项；定时器只保留谷时段边界唤醒。
    expect(timer.callbacks.filter(callback => callback.active).length).toBe(1)
    expect(timer.callbacks.at(-1)?.delay).toBe(2 * 60 * 60 * 1000)
  })

  it('claims an on_time task even during Beijing peak hours', async () => {
    const table = new MemoryTaskTable([task({ scheduledAt: new Date(BEIJING_10_PEAK).toISOString() })])
    let count = 0
    const scheduler = new TaskScheduler({
      table,
      timer: new FakeTimer(),
      executor: { run: async () => { count += 1 } },
      now: () => BEIJING_10_PEAK,
    })
    scheduler.start()
    await scheduler.settle()
    expect(count).toBe(1)
    expect(table.get(task().id)?.state).toBe('running')
  })
})
