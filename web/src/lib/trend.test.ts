import { describe, expect, it } from 'vitest'
import { axisTicks, extraLabel, extraRows, manYen, monthBreakdown, monthRows, periodMonths, totalsByKind } from './trend'

const p = (month: string, categoryId: number, kind: string, amount: number) => ({ month, categoryId, kind, amount })

describe('推移の表と内訳', () => {
  it('期間は今月で終わる n か月(年をまたぐ)', () => {
    expect(periodMonths('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })
  it('月ごとに毎月変わる支出の計・前の月との差・臨時の計。固定費は数えず、負はそのまま', () => {
    const rows = monthRows(['2026-10', '2026-11'], [p('2026-10', 1, 'variable', 1000), p('2026-10', 4, 'fixed', 9000), p('2026-11', 1, 'variable', -200), p('2026-11', 14, 'extra', 5000)])
    expect(rows).toEqual([
      { month: '2026-10', variable: 1000, diff: null, extra: 0 },
      { month: '2026-11', variable: -200, diff: -1200, extra: 5000 },
    ])
  })
  it('内訳は毎月変わる費目だけを費目の並び順に、0 の費目は出さない', () => {
    const cats = [
      { id: 1, name: '食費', kind: 'variable' },
      { id: 3, name: '日用品', kind: 'variable' },
      { id: 2, name: '外食', kind: 'variable' },
      { id: 14, name: '旅行', kind: 'extra' },
    ]
    expect(monthBreakdown('2026-11', [p('2026-11', 2, 'variable', 300), p('2026-11', 1, 'variable', 100), p('2026-11', 3, 'variable', 0), p('2026-11', 14, 'extra', 9)], cats)).toEqual([
      { id: 1, name: '食費', amount: 100 },
      { id: 2, name: '外食', amount: 300 },
    ])
  })
})

describe('費目ごとの総計', () => {
  it('種類ごとに臨時・毎月変わる・固定費の順でまとめ、小計を出す(0 の費目も並べる)', () => {
    const g = totalsByKind([
      { categoryId: 1, name: '食費', kind: 'variable', amount: 100 },
      { categoryId: 4, name: '家賃', kind: 'fixed', amount: 9000 },
      { categoryId: 14, name: '旅行', kind: 'extra', amount: 0 },
      { categoryId: 8, name: '医療', kind: 'variable', amount: 50 },
    ])
    expect(g.map((x) => [x.label, x.total, x.rows.map((r) => r.name)])).toEqual([
      ['臨時', 0, ['旅行']],
      ['毎月変わる', 150, ['食費', '医療']],
      ['固定費', 9000, ['家賃']],
    ])
  })
})

describe('推移の縦軸の目盛り', () => {
  it('最大を超える切りのよい額まで、1・2・5 の刻みで 4 本前後(0 も入れる)', () => {
    expect(axisTicks(0)).toEqual([0, 1000])
    expect(axisTicks(101_530)).toEqual([0, 50_000, 100_000, 150_000])
    expect(axisTicks(100_000)).toEqual([0, 50_000, 100_000])
    expect(axisTicks(30_000)).toEqual([0, 10_000, 20_000, 30_000])
    expect(axisTicks(30_001)).toEqual([0, 20_000, 40_000])
  })
  it('目盛りの字は万の単位で小数 1 桁まで(千の単位は使わない)', () => {
    expect(manYen(0)).toBe('0')
    expect(manYen(50_000)).toBe('5万')
    expect(manYen(150_000)).toBe('15万')
    expect(manYen(2000)).toBe('0.2万')
  })
  it('臨時の札は 1 万円以上なら「¥9.8万」(.0 は省く)、それより下は円のまま。境は 9,999・10,000', () => {
    expect(extraLabel(98_000)).toBe('¥9.8万')
    expect(extraLabel(100_000)).toBe('¥10万')
    expect(extraLabel(10_000)).toBe('¥1万')
    expect(extraLabel(9_999)).toBe('¥9,999')
    expect(extraLabel(123_456)).toBe('¥12.3万')
    expect(extraLabel(-50_000)).toBe('−¥5万')
  })
})

describe('臨時の札の段', () => {
  it('間が札の幅に足りれば上の段、足りなければ下の段、どちらにも置けなければ出さない(境は幅ちょうど)', () => {
    expect(extraRows([0, 5, 0, 0, 5, 0], 56)).toEqual([null, 0, null, null, 0, null])
    expect(extraRows([5, 5, 5], 76)).toEqual([0, 0, 0])
    expect(extraRows([5, 5, 5], 75)).toEqual([0, 1, 0])
    expect(extraRows([5, 5, 5], 30)).toEqual([0, 1, null])
    expect(extraRows([5, 5, 5, 5], 38)).toEqual([0, 1, 0, 1])
  })
})
