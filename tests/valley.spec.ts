import { describe, expect, it } from 'vitest'
import { isPeakHour, isValleyHour, nextValleyStart } from '../src/valley.js'

// 北京时间固定 UTC+8（Asia/Shanghai 无夏令时），本地墙钟 H 对应 UTC H-8。
function beijing(date: string, hour: number, minute = 0): number {
  const [year, month, day] = date.split('-').map(Number)
  return Date.UTC(year!, month! - 1, day!, hour - 8, minute, 0)
}

describe('valley-hour windows', () => {
  it.each([
    // [日期, 小时, 分钟, 是否高峰]
    ['2026-08-15', 0, 0, false],
    ['2026-08-15', 8, 0, false],
    ['2026-08-15', 8, 59, false],
    ['2026-08-15', 9, 0, true],
    ['2026-08-15', 11, 0, true],
    ['2026-08-15', 11, 59, true],
    ['2026-08-15', 12, 0, false],
    ['2026-08-15', 13, 0, false],
    ['2026-08-15', 13, 59, false],
    ['2026-08-15', 14, 0, true],
    ['2026-08-15', 17, 0, true],
    ['2026-08-15', 17, 59, true],
    ['2026-08-15', 18, 0, false],
    ['2026-08-15', 23, 0, false],
  ])('北京 %s %02d:%02d 高峰=%s', (date, hour, minute, peak) => {
    const ms = beijing(date, hour, minute)
    expect(isPeakHour(ms)).toBe(peak)
    expect(isValleyHour(ms)).toBe(!peak)
  })

  it('returns the end of the current peak window while peaking', () => {
    // 北京 10:00（第一高峰内）→ 北京 12:00 = 04:00Z
    expect(nextValleyStart(beijing('2026-08-15', 10))).toBe(beijing('2026-08-15', 12))
    // 北京 15:00（第二高峰内）→ 北京 18:00 = 10:00Z
    expect(nextValleyStart(beijing('2026-08-15', 15))).toBe(beijing('2026-08-15', 18))
  })

  it('returns now while already in valley hours', () => {
    const noon = beijing('2026-08-15', 12)
    expect(nextValleyStart(noon)).toBe(noon)
    const evening = beijing('2026-08-15', 20)
    expect(nextValleyStart(evening)).toBe(evening)
    const midnight = beijing('2026-08-15', 0)
    expect(nextValleyStart(midnight)).toBe(midnight)
  })
})
