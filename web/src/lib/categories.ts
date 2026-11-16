// 画面が集計の応答から作る規則。正本: docs/設計/データと照合.md 表 G(グラフ)・表 H(ホームの行)・§6 の J9・J10
// 費目の色は基盤 §2.2(予算のある毎月変わる費目に並び順で --c1〜--c6、「ほか」は --c7、臨時は --c9)

export type CategoryAmount = {
  categoryId: number
  name: string
  kind: string // variable(毎月変わる)・fixed(固定費)・extra(臨時)。値を足すときは表 G・表 H とここに行を足す
  amount: number
  budget: number | null
}

const BUDGET_COLORS = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6']
export const OTHER_COLOR = '--c7'
export const EXTRA_COLOR = '--c9'

/** 予算のある毎月変わる費目(G1・H3)に、並び順で色を振る(7 個目からは初めに戻る) */
function budgetColors(cats: CategoryAmount[]) {
  const colors = new Map<number, string>()
  cats
    .filter((c) => c.kind === 'variable' && c.budget !== null)
    .forEach((c, i) => colors.set(c.categoryId, BUDGET_COLORS[i % BUDGET_COLORS.length]!))
  return colors
}

export type HomeRows = {
  /** H3: 自分の行(使った額 / 予算・ゲージ) */
  budgetRows: (CategoryAmount & { budget: number; color: string })[]
  /** H4: 「ほか」の 1 行(H4 が 1 つ以上あるときだけ) */
  other: { amount: number; items: { name: string; amount: number }[] } | null
  /** H1: 「固定費」の 1 行(固定費の費目が 1 つ以上あれば額が 0 でも出す = J9) */
  fixed: { amount: number; names: string[] } | null
  /** ホームの合計 = H3 と H4 の額の和(毎月変わる支出) */
  variableTotal: number
  /** H3 の予算の和(「予算 ¥… · 残り ¥…」の元。残り = 予算の和 − ホームの合計) */
  budgetTotal: number
}

/** 表 H。応答の並び(費目の決まった順)を保つ */
export function homeRows(cats: CategoryAmount[]): HomeRows {
  const colors = budgetColors(cats)
  const budgetRows: HomeRows['budgetRows'] = []
  const otherItems: { name: string; amount: number }[] = []
  const fixed: CategoryAmount[] = []
  for (const c of cats) {
    if (c.kind === 'fixed') fixed.push(c) // H1
    else if (c.kind === 'variable' && c.budget !== null) budgetRows.push({ ...c, budget: c.budget, color: colors.get(c.categoryId)! }) // H3
    else if (c.kind === 'variable' && c.amount !== 0) otherItems.push({ name: c.name, amount: c.amount }) // H4
    // H2(臨時)・H5(予算なしで 0)は出さない
  }
  const otherAmount = otherItems.reduce((a, x) => a + x.amount, 0)
  return {
    budgetRows,
    other: otherItems.length > 0 ? { amount: otherAmount, items: otherItems } : null,
    fixed: fixed.length > 0 ? { amount: fixed.reduce((a, c) => a + c.amount, 0), names: fixed.map((c) => c.name) } : null,
    variableTotal: budgetRows.reduce((a, c) => a + c.amount, 0) + otherAmount,
    budgetTotal: budgetRows.reduce((a, c) => a + c.budget, 0),
  }
}

export type Slice = { key: string; name: string; value: number; color: string }

/** 表 G の円グラフ(その月)。費目の決まった順・「ほか」は最後。負の額は 0 として描く(J10) */
export function pieSlices(cats: CategoryAmount[]): Slice[] {
  const colors = budgetColors(cats)
  const slices: Slice[] = []
  let other = 0
  for (const c of cats) {
    if (c.kind !== 'variable') continue // G3・G4
    if (c.budget !== null) slices.push({ key: `c${c.categoryId}`, name: c.name, value: Math.max(c.amount, 0), color: colors.get(c.categoryId)! }) // G1
    else other += c.amount // G2
  }
  slices.push({ key: 'other', name: 'ほか', value: Math.max(other, 0), color: OTHER_COLOR })
  return slices
}

export type TrendPoint = { month: string; categoryId: number; kind: string; amount: number }
export type Trend = {
  months: string[]
  /** 積む帯(G1 の費目ごと + G2 の「ほか」)。values は月ごと。描く値なので負は 0(J10) */
  bands: { key: string; name: string; color: string; values: number[] }[]
  /** G4: 月ごとの臨時の費目の和(0 の月は印を付けない) */
  extra: number[]
  /** 縦軸の最大 = 積んだ額の最大(臨時を除く) */
  maxStack: number
}

/**
 * 表 G の推移。G1 と G2 を分ける予算は、期間の最後の月に効く予算(lastMonth = その月の §4.2 の応答)で全部の月に当てる(J10)
 */
export function trend(months: string[], points: TrendPoint[], lastMonth: CategoryAmount[]): Trend {
  const colors = budgetColors(lastMonth)
  const budgeted = lastMonth.filter((c) => c.kind === 'variable' && c.budget !== null)
  const budgetedIds = new Set(budgeted.map((c) => c.categoryId))
  const index = new Map(months.map((m, i) => [m, i]))
  const own = new Map(budgeted.map((c) => [c.categoryId, months.map(() => 0)]))
  const other = months.map(() => 0)
  const extra = months.map(() => 0)
  for (const p of points) {
    const i = index.get(p.month)
    if (i === undefined) continue
    if (p.kind === 'variable' && budgetedIds.has(p.categoryId)) own.get(p.categoryId)![i]! += p.amount // G1
    else if (p.kind === 'variable') other[i]! += p.amount // G2
    else if (p.kind === 'extra') extra[i]! += p.amount // G4
    // G3(固定費)は出さない
  }
  const clamp = (v: number[]) => v.map((x) => Math.max(x, 0))
  const bands = [
    ...budgeted.map((c) => ({ key: `c${c.categoryId}`, name: c.name, color: colors.get(c.categoryId)!, values: clamp(own.get(c.categoryId)!) })),
    { key: 'other', name: 'ほか', color: OTHER_COLOR, values: clamp(other) },
  ]
  const maxStack = Math.max(0, ...months.map((_, i) => bands.reduce((a, b) => a + b.values[i]!, 0)))
  return { months, bands, extra, maxStack }
}
