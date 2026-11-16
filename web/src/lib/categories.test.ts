// 表 H(ホームの費目の行)・表 G(円グラフと推移)の各行。設計書 §4・§6 の J9・J10
import { describe, expect, it } from 'vitest'
import { homeRows, pieSlices, trend, type CategoryAmount } from './categories'

const cat = (categoryId: number, kind: string, amount: number, budget: number | null, name = `費目${categoryId}`): CategoryAmount => ({
  categoryId,
  name,
  kind,
  amount,
  budget,
})

describe('表 H ホームの費目の行', () => {
  it('H1: 固定費は費目の行を出さず「固定費」の 1 行に足す。額が 0 でも行は出す(J9)', () => {
    const r = homeRows([cat(4, 'fixed', 80000, null, '家賃'), cat(6, 'fixed', 0, 5000, '通信')])
    expect(r.fixed).toEqual({ amount: 80000, names: ['家賃', '通信'] })
    expect(r.budgetRows).toEqual([])
    expect(homeRows([cat(4, 'fixed', 0, null)]).fixed).toEqual({ amount: 0, names: ['費目4'] })
    expect(homeRows([cat(1, 'variable', 10, 100)]).fixed).toBeNull()
  })
  it('H2: 臨時は出さない(合計にも入れない)', () => {
    const r = homeRows([cat(14, 'extra', 30000, 50000)])
    expect(r).toMatchObject({ budgetRows: [], other: null, fixed: null, variableTotal: 0, budgetTotal: 0 })
  })
  it('H3: 予算のある毎月変わる費目は自分の行(予算 0 を含む)。色は並び順', () => {
    const r = homeRows([cat(1, 'variable', 48800, 65000, '食費'), cat(2, 'variable', 500, 0, '外食')])
    expect(r.budgetRows.map((b) => [b.name, b.amount, b.budget, b.color])).toEqual([
      ['食費', 48800, 65000, '--c1'],
      ['外食', 500, 0, '--c2'],
    ])
    expect(r.budgetTotal).toBe(65000)
  })
  it('H4: 予算の無い毎月変わる費目で額が 0 でないものは「ほか」にまとめ、名前と額を並べる', () => {
    const r = homeRows([cat(8, 'variable', 800, null, '医療'), cat(19, 'variable', 3980, null, '未分類')])
    expect(r.other).toEqual({ amount: 4780, items: [{ name: '医療', amount: 800 }, { name: '未分類', amount: 3980 }] })
  })
  it('H4: 返品で負の額も「ほか」に入れる(0 でないため)', () => {
    expect(homeRows([cat(8, 'variable', -300, null)]).other).toEqual({ amount: -300, items: [{ name: '費目8', amount: -300 }] })
  })
  it('H5: 予算の無い毎月変わる費目で額が 0 は出さない(「ほか」の行も無い)', () => {
    expect(homeRows([cat(8, 'variable', 0, null)]).other).toBeNull()
  })
  it('ホームの合計 = H3 と H4 の和(固定費・臨時は入れない)', () => {
    const r = homeRows([cat(1, 'variable', 1000, 5000), cat(8, 'variable', 200, null), cat(4, 'fixed', 9000, null), cat(14, 'extra', 7000, null)])
    expect(r.variableTotal).toBe(1200)
  })
})

describe('表 G 円グラフ(その月)', () => {
  it('G1: 予算のある毎月変わる費目は自分の塊(予算 0 を含む)。G2: 予算なしは「ほか」に足して最後に', () => {
    const s = pieSlices([cat(1, 'variable', 100, 50), cat(8, 'variable', 30, null), cat(2, 'variable', 20, 0), cat(19, 'variable', 5, null)])
    expect(s.map((x) => [x.key, x.value, x.color])).toEqual([
      ['c1', 100, '--c1'],
      ['c2', 20, '--c2'],
      ['other', 35, '--c7'],
    ])
  })
  it('G3・G4: 固定費と臨時は塊を出さない', () => {
    expect(pieSlices([cat(4, 'fixed', 100, null), cat(14, 'extra', 100, 10)])).toEqual([{ key: 'other', name: 'ほか', value: 0, color: '--c7' }])
  })
  it('負の額(返品が上回った月)は 0 として描く(J10)', () => {
    expect(pieSlices([cat(1, 'variable', -50, 100)])[0]!.value).toBe(0)
  })
})

describe('表 G 推移(月ごと)', () => {
  const months = ['2026-09', '2026-10', '2026-11']
  const last = [cat(1, 'variable', 0, 1000, '食費'), cat(8, 'variable', 0, null, '医療'), cat(4, 'fixed', 0, null), cat(14, 'extra', 0, null)]
  const p = (month: string, categoryId: number, kind: string, amount: number) => ({ month, categoryId, kind, amount })
  it('G1: 予算のある費目は自分の帯を積む。G2: 予算なしは「ほか」の帯', () => {
    const t = trend(months, [p('2026-09', 1, 'variable', 500), p('2026-10', 8, 'variable', 70), p('2026-11', 1, 'variable', 300)], last)
    expect(t.bands.map((b) => [b.key, b.values])).toEqual([
      ['c1', [500, 0, 300]],
      ['other', [0, 70, 0]],
    ])
  })
  it('G3: 固定費は出さない。G4: 臨時は積まず、月ごとの和を印に(縦軸は臨時を除いた最大)', () => {
    const t = trend(months, [p('2026-09', 4, 'fixed', 90000), p('2026-10', 14, 'extra', 40000), p('2026-10', 1, 'variable', 800)], last)
    expect(t.extra).toEqual([0, 40000, 0])
    expect(t.maxStack).toBe(800)
  })
  it('分け方は期間の最後の月の予算で全部の月に当てる(J10): 前の月に予算があっても、最後の月に無ければ「ほか」', () => {
    const lastNoBudget = [cat(1, 'variable', 0, null, '食費')]
    const t = trend(months, [p('2026-09', 1, 'variable', 500)], lastNoBudget)
    expect(t.bands.map((b) => [b.key, b.values])).toEqual([['other', [500, 0, 0]]])
  })
  it('負の額は帯では 0 として描く(J10)', () => {
    const t = trend(months, [p('2026-11', 1, 'variable', -200)], last)
    expect(t.bands[0]!.values).toEqual([0, 0, 0])
  })
})
