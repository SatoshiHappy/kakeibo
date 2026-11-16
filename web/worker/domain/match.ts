// 照合の評価(純粋な関数)。正本: docs/設計/データと照合.md §3.0・表 A-1・表 B
// 読む → 評価する → 書く の「評価する」だけを担う。DB には触れない。

export type FreeRow = {
  id: number
  usedOn: string
  amount: number
  /** 明細の支出に結ばれていれば、その支出の id。結ばれていなければ null */
  statementExpenseId: number | null
}

export type FreeExpense = {
  id: number
  spentOn: string
  amount: number
  cardCompatible: boolean
}

export type Decision =
  | { kind: 'link'; rowId: number; expenseId: number; statementExpenseId: number | null }
  | { kind: 'create_statement_expense'; rowId: number }

const DAY = 24 * 60 * 60 * 1000
export const dayDiff = (a: string, b: string) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / DAY)

/** 額ごとに引ける形(候補の条件 (1) は額が等しいこと。全部を総当たりで比べないため) */
function byAmount<T extends { amount: number }>(list: T[]) {
  const m = new Map<number, T[]>()
  for (const x of list) m.set(x.amount, [...(m.get(x.amount) ?? []), x])
  return m
}

export class Matcher {
  private readonly rejected: Set<string>
  private readonly expensesByAmount: Map<number, FreeExpense[]>
  private readonly rowsByAmount: Map<number, FreeRow[]>

  constructor(
    private readonly rows: FreeRow[],
    private readonly expenses: FreeExpense[],
    rejections: { rowId: number; expenseId: number }[],
    private readonly windowDays: number,
  ) {
    this.rejected = new Set(rejections.map((r) => `${r.rowId}:${r.expenseId}`))
    this.expensesByAmount = byAmount(expenses)
    this.rowsByAmount = byAmount(rows)
  }

  private ok(r: FreeRow, p: FreeExpense) {
    if (p.amount !== r.amount) return false
    const diff = dayDiff(p.spentOn, r.usedOn)
    if (diff > this.windowDays) return false
    if (diff !== 0 && !p.cardCompatible) return false // §6 の J3: 方法が矛盾するなら同じ日だけ
    return !this.rejected.has(`${r.id}:${p.id}`)
  }

  /** C(R): 候補の自由な支出。expenses を渡さなければ、全部の自由な支出のうち同じ額のものから探す */
  candidates(r: FreeRow, expenses?: FreeExpense[]) {
    return (expenses ?? this.expensesByAmount.get(r.amount) ?? []).filter((p) => this.ok(r, p))
  }

  /** C(P): 候補の自由な行(同じ額のものから探す) */
  candidateRows(p: FreeExpense) {
    return (this.rowsByAmount.get(p.amount) ?? []).filter((r) => this.ok(r, p))
  }

  /** D(R): 同じ日の候補 */
  sameDay(r: FreeRow, expenses = this.expenses) {
    return this.candidates(r, expenses).filter((p) => p.spentOn === r.usedOn)
  }

  /** D(P): 同じ日の候補の行 */
  sameDayRows(p: FreeExpense) {
    return this.candidateRows(p).filter((r) => r.usedOn === p.spentOn)
  }

  /**
   * targets の行を 2 段で評価する(順によらず結果が同じ):
   * (1) 表 A-1 の 2 行(自動で結ぶ)を今のデータで決める
   * (2) (1) を当てた後のデータで、残りの結ばれていない行に 7 行(明細の支出を作る)を決める
   */
  evaluate(targetIds: Set<number>): Decision[] {
    const targets = this.rows.filter((r) => targetIds.has(r.id))
    const links: Decision[] = []
    const linkedRows = new Set<number>()
    const linkedExpenses = new Set<number>()
    for (const r of targets) {
      const d = this.sameDay(r)
      if (d.length !== 1) continue // 表 A-1 の 5・6 行
      const p = d[0]
      if (this.sameDayRows(p).length !== 1) continue // 4 行
      if (!p.cardCompatible) continue // 3 行
      links.push({ kind: 'link', rowId: r.id, expenseId: p.id, statementExpenseId: r.statementExpenseId })
      linkedRows.add(r.id)
      linkedExpenses.add(p.id)
    }
    const creates: Decision[] = targets
      .filter((r) => !linkedRows.has(r.id) && r.statementExpenseId === null)
      .filter((r) => this.candidates(r).filter((p) => !linkedExpenses.has(p.id)).length === 0) // 7 行
      .map((r) => ({ kind: 'create_statement_expense', rowId: r.id }))
    return [...links, ...creates]
  }
}
