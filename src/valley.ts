/**
 * DeepSeek 峰谷算力价格时段（valley-hour window）。
 *
 * `when_idle`（空闲执行）语义 = 只在谷时段执行命令：
 * - 每日高峰时段为北京时间 09:00 - 12:00 与 14:00 - 18:00；
 * - 其余时间为谷时段（空闲时段）。
 *
 * 北京时间为 Asia/Shanghai（UTC+8，无夏令时）。窗口以小时为粒度，
 * 边界约定为 [startHour, endHour)（如 12:00 属于谷时段）。
 */

export const VALLEY_TIME_ZONE = 'Asia/Shanghai'

export interface HourWindow {
  /** 窗口起始小时（北京时间，含）。 */
  readonly startHour: number
  /** 窗口结束小时（北京时间，不含）。 */
  readonly endHour: number
}

/** 每日高峰窗口；其余时间均为谷时段。 */
export const PEAK_WINDOWS: readonly HourWindow[] = [
  { startHour: 9, endHour: 12 },
  { startHour: 14, endHour: 18 },
]

const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: VALLEY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
})

export interface BeijingParts {
  year: number
  month: number
  day: number
  hour: number
}

/** 将 UTC instant 投影为北京时间（Asia/Shanghai）的日期与小时。 */
export function beijingParts(now: number): BeijingParts {
  const parts = dateTimeFormat.formatToParts(new Date(now))
  const value = (type: string): number => {
    const part = parts.find(candidate => candidate.type === type)
    return part === undefined ? NaN : Number(part.value)
  }
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
  }
}

/** 当前时刻是否处于高峰时段（北京时间的峰值窗口内）。 */
export function isPeakHour(now: number): boolean {
  const { hour } = beijingParts(now)
  return PEAK_WINDOWS.some(window => hour >= window.startHour && hour < window.endHour)
}

/** 当前时刻是否处于谷时段（高峰时段之外）。 */
export function isValleyHour(now: number): boolean {
  return !isPeakHour(now)
}

/**
 * 下一个谷时段开始时刻（epoch ms）。
 *
 * - 当前处于高峰时段时，返回当前高峰窗口结束时刻（即下一个谷时段开始）；
 * - 当前已处于谷时段时，返回 `now` 本身（边界已过，调用方不应据此安排定时器）。
 */
export function nextValleyStart(now: number): number {
  const { year, month, day, hour } = beijingParts(now)
  const window = PEAK_WINDOWS.find(candidate => hour >= candidate.startHour && hour < candidate.endHour)
  if (window === undefined) return now
  // Asia/Shanghai 固定为 UTC+8：北京当地时间 H 对应 UTC 时间 H - 8。
  return Date.UTC(year, month - 1, day, window.endHour - 8, 0, 0)
}
