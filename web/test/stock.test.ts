// 設計書 §2.5 の式と表 S の各行・境の値を通す(k = 1・2、S = 0・1 日、n = −1・0・1、d = N − 1・N・N + 1、N = 0)。
import { describe, expect, it } from 'vitest'
import { stockStatus, type StockInput } from '../worker/domain/stock'

const TODAY = '2026-11-16'
const run = (over: Partial<StockInput>) =>
  stockStatus({ quantity: 1, useDatesNewestFirst: [], notifyDays: 7, today: TODAY, ...over })

describe('表 S: ペースなし', () => {
  it.each([
    ['記録 0 回', []],
    ['記録 1 回(k = 1)', ['2026-11-10']],
    ['記録 2 回でも同じ日(S = 0)', ['2026-11-10', '2026-11-10']],
  ])('S1: %s・n = 0 → そろそろ買う(予測なし)', (_, dates) => {
    expect(run({ quantity: 0, useDatesNewestFirst: dates })).toEqual({ state: 'soon', forecast: null })
  })

  it('S1: n = −1 → そろそろ買う', () => {
    expect(run({ quantity: -1, useDatesNewestFirst: ['2026-11-10'] })).toEqual({ state: 'soon', forecast: null })
  })

  it.each([
    ['記録 1 回(k = 1)', ['2026-11-10']],
    ['記録 2 回でも同じ日(S = 0)', ['2026-11-10', '2026-11-10']],
  ])('S2: %s・n = 1 → まだある(予測なし)', (_, dates) => {
    expect(run({ quantity: 1, useDatesNewestFirst: dates })).toEqual({ state: 'ok', forecast: null })
  })
})

describe('表 S: ペースあり', () => {
  // 最新 11-10・p = 10 日・n = 1 → なくなる日 = 11-10 + 10 × 2 = 11-30、今日 11-16 から d = 14
  const tenDays = { quantity: 1, useDatesNewestFirst: ['2026-11-10', '2026-10-31'] }

  it('k = 2・S = 1 日でペースができる(p = 1)', () => {
    const r = run({ quantity: 0, useDatesNewestFirst: ['2026-11-10', '2026-11-09'], today: '2026-11-10' })
    expect(r.forecast).toEqual({ paceDays: 1, runOutOn: '2026-11-11', daysLeft: 1 })
  })

  it('S3: d = N − 1 → そろそろ買う', () => {
    expect(run({ ...tenDays, notifyDays: 15 })).toEqual({
      state: 'soon',
      forecast: { paceDays: 10, runOutOn: '2026-11-30', daysLeft: 14 },
    })
  })

  it('S3: d = N → そろそろ買う', () => {
    expect(run({ ...tenDays, notifyDays: 14 }).state).toBe('soon')
  })

  it('S4: d = N + 1 → まだある', () => {
    expect(run({ ...tenDays, notifyDays: 13 })).toEqual({
      state: 'ok',
      forecast: { paceDays: 10, runOutOn: '2026-11-30', daysLeft: 14 },
    })
  })

  it('N = 0: d = 0 はそろそろ買う、d = 1 はまだある', () => {
    expect(run({ ...tenDays, notifyDays: 0, today: '2026-11-30' }).state).toBe('soon')
    expect(run({ ...tenDays, notifyDays: 0, today: '2026-11-29' }).state).toBe('ok')
  })

  it.each([
    [-1, '2026-11-20'],
    [0, '2026-11-20'],
    [1, '2026-11-30'],
  ])('S3・S4: n = %i は max(n, 0) で数える(なくなる日 %s)', (quantity, runOutOn) => {
    expect(run({ ...tenDays, quantity }).forecast?.runOutOn).toBe(runOutOn)
  })

  it('S3: ペースがあれば n = 0 でも予測で決める(d > N ならまだある)', () => {
    // n = 0 → なくなる日 11-20、今日 11-16 → d = 4
    expect(run({ ...tenDays, quantity: 0, notifyDays: 3 }).state).toBe('ok')
    expect(run({ ...tenDays, quantity: 0, notifyDays: 4 }).state).toBe('soon')
  })

  it('なくなる日は切り捨て(p = 3.5)', () => {
    const dates = ['2026-11-10', '2026-11-07', '2026-11-03']
    expect(run({ quantity: 0, useDatesNewestFirst: dates }).forecast).toEqual({ paceDays: 3.5, runOutOn: '2026-11-13', daysLeft: -3 })
    expect(run({ quantity: 1, useDatesNewestFirst: dates }).forecast?.runOutOn).toBe('2026-11-17')
  })

  it('窓は新しい 4 回だけ(古い記録は外れる)', () => {
    const r = run({ quantity: 0, useDatesNewestFirst: ['2026-11-10', '2026-11-08', '2026-11-06', '2026-11-04', '2026-01-01'] })
    expect(r.forecast?.paceDays).toBe(2)
  })

  it('d は負になりうる(押し忘れ)', () => {
    const r = run({ quantity: 0, useDatesNewestFirst: ['2026-11-01', '2026-10-30'] })
    expect(r).toEqual({ state: 'soon', forecast: { paceDays: 2, runOutOn: '2026-11-03', daysLeft: -13 } })
  })

  it('月と年をまたぐ', () => {
    const r = run({ quantity: 2, useDatesNewestFirst: ['2026-12-25', '2026-12-15'], today: '2026-12-26' })
    expect(r.forecast).toEqual({ paceDays: 10, runOutOn: '2027-01-24', daysLeft: 29 })
  })
})
