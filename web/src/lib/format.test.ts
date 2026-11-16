import { describe, expect, it } from 'vitest'
import { currentMonth, isMonth, jstToday, monthLabel, shiftMonth, shortDate, yen } from './format'

describe('表示の書き方', () => {
  it('金額は ¥ と 3 桁ごとの , 。負は −', () => {
    expect(yen(48800)).toBe('¥48,800')
    expect(yen(0)).toBe('¥0')
    expect(yen(-300)).toBe('−¥300')
  })
  it('今日と今月は日本時間で決める(UTC の 15 時は日本の翌日 0 時)', () => {
    expect(jstToday(new Date('2026-11-30T14:59:59Z'))).toBe('2026-11-30')
    expect(jstToday(new Date('2026-11-30T15:00:00Z'))).toBe('2026-12-01')
    expect(currentMonth(new Date('2026-12-31T15:00:00Z'))).toBe('2027-01')
  })
  it('月をずらす(年をまたぐ)', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  })
  it('月と日の見出し', () => {
    expect(monthLabel('2026-03')).toBe('2026年3月')
    expect(shortDate('2026-11-05')).toBe('11/5')
  })
  it('月の形だけを受ける', () => {
    expect(isMonth('2026-11')).toBe(true)
    expect(isMonth('2026-13')).toBe(false)
    expect(isMonth(null)).toBe(false)
  })
})
