// 費目と予算の画面の計算(データと照合 §4.11)
import { parseYen } from './expenseForm'

export type PrefCategory = { id: number; name: string; kind: string; retired: boolean; systemRole: string | null; budget: number | null }
export type PrefsResponse = { month: string; categories: PrefCategory[] }

export const KINDS: { code: string; label: string }[] = [
  { code: 'variable', label: '毎月変わる' },
  { code: 'fixed', label: '固定費' },
  { code: 'extra', label: '臨時' },
]
export const kindLabel = (code: string) => KINDS.find((k) => k.code === code)?.label ?? code

/** 予算の計と種類ごとの計(やめた費目は数えない。0 の種類は出さない) */
/** 予算の計: やめていない毎月変わる費目の予算の合計(ホームの「予算」と同じ範囲。固定費・臨時は予算を持たない = §4.11) */
export function budgetTotal(cats: PrefCategory[]) {
  return cats.filter((c) => !c.retired && c.kind === 'variable').reduce((a, c) => a + (c.budget ?? 0), 0)
}

/** 予算の入力欄の値: 空なら null(予算なし)、0 以上の整数ならその額、ほかは読めない(undefined) */
export function parseBudget(s: string): number | null | undefined {
  if (s.trim() === '') return null
  const n = parseYen(s)
  return n !== null && n >= 0 ? n : undefined
}

/** 費目 id を 1 つ前(-1)か後ろ(+1)へ動かした並び。端を越えるときは同じ並びを返す(§4.11) */
export function moveId(ids: number[], id: number, dir: -1 | 1): number[] {
  const i = ids.indexOf(id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= ids.length) return ids
  const next = [...ids]
  next[i] = ids[j]!
  next[j] = id
  return next
}
