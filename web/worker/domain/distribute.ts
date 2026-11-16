// レシート全体の値引き・外税を品目へ配る。正本: docs/設計/データと照合.md §5
// 品目の amount の合計 = 支出の額 になるように、比で割った額との差が 1 円未満になるよう配る。

export type TaxRate = 0 | 8 | 10

export type ItemInput = {
  position: number
  baseAmount: number
  taxRate: TaxRate | null
}

export type Adjustment = {
  kind: 'discount' | 'tax'
  amount: number
  taxRate: TaxRate | null
}

export class NoDistributionTarget extends Error {
  constructor(readonly adjustment: Adjustment) {
    super('no item to distribute the adjustment to')
    this.name = 'NoDistributionTarget'
  }
}

function targetsOf(items: ItemInput[], adj: Adjustment): ItemInput[] {
  const inRate = adj.taxRate === null ? items : items.filter((i) => i.taxRate === adj.taxRate)
  // 外税は a と同じ符号の品目、値引きは a と逆の符号の品目に配る
  const wantSign = adj.kind === 'tax' ? Math.sign(adj.amount) : -Math.sign(adj.amount)
  return inRate.filter((i) => Math.sign(i.baseAmount) === wantSign)
}

function share(items: ItemInput[], adj: Adjustment): Map<number, number> {
  const targets = targetsOf(items, adj)
  if (targets.length === 0) throw new NoDistributionTarget(adj)
  const abs = Math.abs(adj.amount)
  const weights = targets.map((t) => Math.abs(t.baseAmount))
  const total = weights.reduce((a, b) => a + b, 0)
  const parts = targets.map((t, k) => ({
    position: t.position,
    floor: Math.floor((abs * weights[k]) / total),
    rem: (abs * weights[k]) % total,
  }))
  let left = abs - parts.reduce((a, p) => a + p.floor, 0)
  const order = [...parts].sort((a, b) => b.rem - a.rem || a.position - b.position)
  for (const p of order) {
    if (left === 0) break
    p.floor += 1
    left -= 1
  }
  const sign = Math.sign(adj.amount)
  return new Map(parts.map((p) => [p.position, sign * p.floor]))
}

/** 品目ごとの配った後の額を position → amount で返す。 */
export function distribute(items: ItemInput[], adjustments: Adjustment[]): Map<number, number> {
  const result = new Map(items.map((i) => [i.position, i.baseAmount]))
  for (const adj of adjustments) {
    for (const [position, delta] of share(items, adj)) {
      result.set(position, result.get(position)! + delta)
    }
  }
  return result
}
