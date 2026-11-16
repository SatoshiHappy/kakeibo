// 照合を掛ける(読む → 評価する → 書く)。正本: docs/設計/データと照合.md §3.0・§2.3・§2.4
// 書く文は、元の操作(支出の保存・直し・削除、明細の取り込み)の文と同じ 1 つの batch に入れる。
// そのため評価は「読んだデータに、今回の操作が書くものを重ねた写し」で行う(overlay)。
import { Matcher, type FreeExpense, type FreeRow } from './match'

type Env = { DB: D1Database; MATCH_WINDOW_DAYS: string }

/** batch の中で行・支出を指す SQL の式(既にある行は id、同じ batch で入る行は自然な鍵の副問い合わせ) */
export type Ref = { sql: string; binds: unknown[] }
export const idRef = (id: number): Ref => ({ sql: '?', binds: [id] })

export type Overlay = {
  /** 同じ batch で入る新しい行(id は負の仮の番号) */
  newRows?: (FreeRow & { ref: Ref })[]
  /** 同じ batch で入る・直される人の支出(自由なときだけ渡す。id は新しいなら負の仮の番号) */
  expense?: FreeExpense & { ref: Ref }
  /** 同じ batch で消える人の支出(結ばれていた行は自由になる) */
  removedExpenseId?: number
  /** 同じ batch で人の支出から外れる行(自由になる) */
  freedRowIds?: number[]
  /** 同じ batch で人の支出に結ばれる行・結ばれる支出(自由でなくなる) */
  excludeRowIds?: number[]
  excludeExpenseIds?: number[]
  /** 同じ batch で入る拒否の組 */
  extraRejections?: { rowId: number; expenseId: number }[]
}

function shift(date: string, days: number) {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10)
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * dates の各日の前後(照合の日の幅)に入る自由な行に表 A-1 を掛ける文を返す。
 * 呼ぶ側は、操作の前と後の支出の日付と、操作で人の支出から外れた行の利用日を dates に入れる(§3.0 の掛け直す範囲)。
 */
export async function reconcileStatements(env: Env, dates: string[], overlay: Overlay = {}): Promise<D1PreparedStatement[]> {
  if (dates.length === 0) return []
  const db = env.DB
  const w = Number(env.MATCH_WINDOW_DAYS)
  const sorted = [...dates].sort()
  // 対象の行は ±w、その候補の支出と D(P) の行は ±2w の中にある
  const from = shift(sorted[0], -2 * w)
  const to = shift(sorted[sorted.length - 1], 2 * w)
  const removed = overlay.removedExpenseId ?? -1
  const freed = overlay.freedRowIds ?? []

  const [rowsRes, expensesRes, rejectionsRes] = await db.batch([
    db
      .prepare(
        `SELECT id, used_on, amount, CASE WHEN expense_origin = 'statement_purchase' THEN expense_id END AS statement_expense_id
         FROM card_charges
         WHERE amount IS NOT NULL AND used_on BETWEEN ? AND ?
           AND (expense_id IS NULL OR expense_origin = 'statement_purchase' OR expense_id = ?
                OR id IN (SELECT value FROM json_each(?)))`,
      )
      .bind(from, to, removed, JSON.stringify(freed)),
    db
      .prepare(
        `SELECT e.id, e.spent_on, pm.card_compatible, (SELECT SUM(amount) FROM items WHERE expense_id = e.id) AS amount
         FROM expenses e JOIN payment_methods pm ON pm.code = e.payment_method
         WHERE e.origin = 'person' AND e.spent_on BETWEEN ? AND ?
           AND NOT EXISTS (SELECT 1 FROM card_charges c WHERE c.expense_id = e.id)`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT mr.card_charge_id, mr.expense_id FROM match_rejections mr
         JOIN card_charges c ON c.id = mr.card_charge_id WHERE c.used_on BETWEEN ? AND ?`,
      )
      .bind(from, to),
  ])

  const refs = new Map<number, Ref>()
  const excludedRows = new Set(overlay.excludeRowIds ?? [])
  const rows: FreeRow[] = (rowsRes.results as Record<string, number | string | null>[])
    .map((r) => ({
      id: r.id as number,
      usedOn: r.used_on as string,
      amount: r.amount as number,
      statementExpenseId: (r.statement_expense_id as number | null) ?? null,
    }))
    .filter((r) => !excludedRows.has(r.id))
  for (const nr of overlay.newRows ?? []) {
    rows.push({ id: nr.id, usedOn: nr.usedOn, amount: nr.amount, statementExpenseId: null })
    refs.set(nr.id, nr.ref)
  }
  let expenses: FreeExpense[] = (expensesRes.results as Record<string, number | string>[]).map((e) => ({
    id: e.id as number,
    spentOn: e.spent_on as string,
    amount: e.amount as number,
    cardCompatible: e.card_compatible === 1,
  }))
  const excludedExpenses = new Set(overlay.excludeExpenseIds ?? [])
  expenses = expenses.filter((e) => e.id !== removed && e.id !== overlay.expense?.id && !excludedExpenses.has(e.id))
  const expenseRefs = new Map<number, Ref>()
  if (overlay.expense) {
    const { ref, ...e } = overlay.expense
    expenses.push(e)
    expenseRefs.set(e.id, ref)
  }
  const rejections = (rejectionsRes.results as Record<string, number>[])
    .map((r) => ({ rowId: r.card_charge_id, expenseId: r.expense_id }))
    .filter((r) => r.expenseId !== removed)
    .concat(overlay.extraRejections ?? [])

  const inRange = (r: FreeRow) => dates.some((d) => Math.abs(Date.parse(r.usedOn) - Date.parse(d)) <= w * 86_400_000)
  const targetIds = new Set(rows.filter(inRange).map((r) => r.id))
  const decisions = new Matcher(rows, expenses, rejections, w).evaluate(targetIds)

  const rowRef = (id: number) => refs.get(id) ?? idRef(id)
  const expRef = (id: number) => expenseRefs.get(id) ?? idRef(id)
  const now = nowIso()
  const statements: D1PreparedStatement[] = []
  const createdKeys: string[] = []
  for (const d of decisions) {
    const r = rowRef(d.rowId)
    if (d.kind === 'link') {
      const p = expRef(d.expenseId)
      // 読んだときの値を WHERE に入れる(書き込みの守り)。消える支出に結ばれていた行は、同じ batch の前の文で NULL になっている
      statements.push(
        db
          .prepare(
            `UPDATE card_charges SET expense_id = ${p.sql}, expense_origin = 'person'
             WHERE id = ${r.sql} AND expense_id IS ?`,
          )
          .bind(...p.binds, ...r.binds, d.statementExpenseId),
      )
      if (d.statementExpenseId !== null) {
        // まとめる(§2.4): 行が人の支出に移ったら明細の支出を消す
        statements.push(
          db
            .prepare(
              `DELETE FROM expenses WHERE id = ? AND origin = 'statement_purchase'
               AND NOT EXISTS (SELECT 1 FROM card_charges WHERE expense_id = ?)`,
            )
            .bind(d.statementExpenseId, d.statementExpenseId),
        )
      }
    } else {
      const key = `stmt-purchase-${crypto.randomUUID()}`
      createdKeys.push(key)
      const e = '(SELECT id FROM expenses WHERE client_request_id = ?)'
      statements.push(
        db
          .prepare(
            `INSERT INTO expenses (origin, client_request_id, spent_on, store_name, payment_method, registered_by, created_at, updated_at)
             SELECT 'statement_purchase', ?, c.used_on, c.merchant, 'rakuten_card', si.imported_by, ?, ?
             FROM card_charges c JOIN statement_imports si ON si.id = c.import_id
             WHERE c.id = ${r.sql} AND c.expense_id IS NULL`,
          )
          .bind(key, now, now, ...r.binds),
        db
          .prepare(
            `INSERT INTO items (expense_id, position, name, category_id, tax_rate, base_amount, amount)
             SELECT ${e}, 1, NULL, (SELECT category_id FROM system_categories WHERE role = 'uncategorized'), NULL, c.amount, c.amount
             FROM card_charges c WHERE c.id = ${r.sql} AND ${e} IS NOT NULL`,
          )
          .bind(key, ...r.binds, key),
        db
          .prepare(
            `UPDATE card_charges SET expense_id = ${e}, expense_origin = 'statement_purchase'
             WHERE id = ${r.sql} AND expense_id IS NULL AND ${e} IS NOT NULL`,
          )
          .bind(key, ...r.binds, key),
      )
    }
  }
  if (createdKeys.length > 0) {
    // この batch で作った明細の支出のうち、どの行からも指されないものを消す(他の人が先に同じ行を結んだとき)
    statements.push(
      db
        .prepare(
          `DELETE FROM expenses WHERE client_request_id IN (${createdKeys.map(() => '?').join(',')})
           AND NOT EXISTS (SELECT 1 FROM card_charges WHERE expense_id = expenses.id)`,
        )
        .bind(...createdKeys),
    )
  }
  return statements
}
