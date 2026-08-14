import { describe, expect, it } from 'vitest'
import { addLocalDays, listTasks, parseCreateTaskInput, RequestError } from '../src/domain.js'
import { MemoryTaskTable, task } from './helpers.js'

const NOW = Date.parse('2026-08-14T12:00:00.000Z')

function valid() {
  return {
    prompt: ' run tests ',
    scheduledAt: '2026-08-15T01:00:00+08:00',
    timeZone: 'Asia/Shanghai',
    mode: 'when_idle',
    repeat: 'daily',
  }
}

describe('create task validation', () => {
  it('normalizes a future RFC 3339 instant and trims the prompt', () => {
    expect(parseCreateTaskInput(valid(), NOW)).toEqual({
      prompt: 'run tests',
      scheduledAt: '2026-08-14T17:00:00.000Z',
      timeZone: 'Asia/Shanghai',
      mode: 'when_idle',
      repeat: 'daily',
    })
  })

  it.each([
    [{ ...valid(), prompt: '  ' }, 'invalid_prompt'],
    [{ ...valid(), scheduledAt: '2026-08-14T12:00:00Z' }, 'not_future'],
    [{ ...valid(), scheduledAt: '2026-08-15 01:00' }, 'invalid_scheduled_at'],
    [{ ...valid(), timeZone: 'CST' }, 'invalid_time_zone'],
    [{ ...valid(), mode: 'later' }, 'invalid_mode'],
    [{ ...valid(), repeat: 'weekly' }, 'invalid_repeat'],
    [{ ...valid(), extra: true }, 'invalid_request'],
    [{ ...valid(), repeat: undefined }, 'invalid_repeat'],
  ])('rejects invalid input %#', (input, code) => {
    try {
      parseCreateTaskInput(input, NOW)
      throw new Error('expected validation error')
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError)
      expect((error as RequestError).code).toBe(code)
    }
  })

  it('enforces the prompt byte limit rather than a code-unit limit', () => {
    expect(() => parseCreateTaskInput({ ...valid(), prompt: '界'.repeat(22_000) }, NOW))
      .toThrowError(/64 KiB/)
  })
})

describe('daily occurrence rollover', () => {
  it('keeps the same local wall-clock time on the next day', () => {
    // 2026-08-15 09:30 Asia/Shanghai = 2026-08-15T01:30:00Z
    const next = addLocalDays('2026-08-15T01:30:00.000Z', 'Asia/Shanghai', 1)
    expect(next).toBe('2026-08-16T01:30:00.000Z')
  })

  it('crosses a month boundary', () => {
    // 2026-08-31 23:00 Asia/Shanghai = 2026-08-31T15:00:00Z
    const next = addLocalDays('2026-08-31T15:00:00.000Z', 'Asia/Shanghai', 1)
    expect(next).toBe('2026-09-01T15:00:00.000Z')
  })

  it('preserves wall-clock time across the spring-forward DST transition', () => {
    // 2026-03-07 10:00 America/New_York (EST, UTC-5) -> 2026-03-08 10:00 EDT (UTC-4)
    const next = addLocalDays('2026-03-07T15:00:00.000Z', 'America/New_York', 1)
    expect(next).toBe('2026-03-08T14:00:00.000Z')
  })

  it('preserves wall-clock time across the fall-back DST transition', () => {
    // 2026-10-31 10:00 America/New_York (EDT, UTC-4) -> 2026-11-01 10:00 EST (UTC-5)
    const next = addLocalDays('2026-10-31T14:00:00.000Z', 'America/New_York', 1)
    expect(next).toBe('2026-11-01T15:00:00.000Z')
  })
})

describe('list normalization', () => {
  it('fills repeat for records persisted before the field existed', () => {
    const { repeat: _repeat, ...legacy } = task()
    const table = new MemoryTaskTable([legacy])
    expect(listTasks(table)[0]?.repeat).toBe('once')
  })
})
