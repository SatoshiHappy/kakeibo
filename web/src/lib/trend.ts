// 推移の画面の表と内訳(データと照合 §4.1・表 G)。表は負の額のまま出す(§6 の J10)
import type { TrendPoint } from './categories'
import { shiftMonth } from './format'

export type NamedCategory = { id: number; name: string; kind: string }

/** 今月で終わる n か月 */
export const periodMonths = (to: string, n: number) => Array.from({ length: n }, (_, i) => shiftMonth(to, i - n + 1))

/** 月ごとの毎月変わる支出の計・前の月との差・臨時の計 */
export function monthRows(months: string[], points: TrendPoint[]) {
  const variable = months.map((m) => points.filter((p) => p.month === m && p.kind === 'variable').reduce((a, p) => a + p.amount, 0))
  const extra = months.map((m) => points.filter((p) => p.month === m && p.kind === 'extra').reduce((a, p) => a + p.amount, 0))
  return months.map((month, i) => ({ month, variable: variable[i]!, diff: i === 0 ? null : variable[i]! - variable[i - 1]!, extra: extra[i]! }))
}

/** ある月の毎月変わる費目の内訳(費目の並び順。0 の費目は出さない) */
export function monthBreakdown(month: string, points: TrendPoint[], categories: NamedCategory[]) {
  const amount = new Map(points.filter((p) => p.month === month && p.kind === 'variable').map((p) => [p.categoryId, p.amount]))
  return categories.filter((c) => (amount.get(c.id) ?? 0) !== 0).map((c) => ({ id: c.id, name: c.name, amount: amount.get(c.id)! }))
}

export type TotalCategory = { categoryId: number; name: string; kind: string; amount: number }

/** 費目ごとの総計を種類でまとめる(臨時 → 毎月変わる → 固定費。要求「費目ごとの総計」・データと照合 §4.4) */
export function totalsByKind(cats: TotalCategory[]) {
  const groups = [
    { kind: 'extra', label: '臨時' },
    { kind: 'variable', label: '毎月変わる' },
    { kind: 'fixed', label: '固定費' },
  ]
  return groups.map((g) => {
    const rows = cats.filter((c) => c.kind === g.kind)
    return { ...g, total: rows.reduce((a, c) => a + c.amount, 0), rows }
  })
}

/** 縦軸の目盛り: 0 と、最大を超える切りのよい額まで 3〜4 本(1 万・2 万・5 万…の刻み) */
export function axisTicks(max: number): number[] {
  const steps = [1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000]
  const step = steps.find((s) => max / s <= 3) ?? steps.at(-1)!
  const n = Math.max(1, Math.ceil(max / step))
  return Array.from({ length: n + 1 }, (_, i) => i * step)
}

/** 目盛りの字: 1 万円より上は「5万」、下は「5千」 */
export const manYen = (v: number) => (v === 0 ? '0' : v % 10_000 === 0 ? `${v / 10_000}万` : `${v / 1000}千`)
