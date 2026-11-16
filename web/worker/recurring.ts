// 毎月決まった支出を作る(Cron Trigger。正本: docs/設計/データと照合.md §1.17・表 Q)
import { reconcileStatements } from './domain/reconcile'
import { jstDate, nowIso } from './time'
import type { Bindings } from './types'

/** 1 回の判定で 1 つの登録から作る月の数の上限(止まっていた日の分を続けて作るとき) */
export const MAX_PER_RUN = 12

/** 月 `YYYY-MM` の day 日。その月に無い日は月末 */
export function dateIn(month: string, day: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`
}

function addMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, m, 1)) // m は 1 始まりなので、これが次の月
  return d.toISOString().slice(0, 7)
}

/** 次の月の day 日(作った後に next_on を進める先) */
export function nextAfter(date: string, day: number): string {
  return dateIn(addMonth(date.slice(0, 7)), day)
}

/** 登録した日(today)以後で最初の day 日(next_on の初めの値) */
export function firstOn(today: string, day: number): string {
  const here = dateIn(today.slice(0, 7), day)
  return here >= today ? here : nextAfter(today, day)
}

type Row = {
  id: number
  name: string
  category_id: number
  amount: number
  payment_method: string
  day_of_month: number
  next_on: string
  created_by: number
  card_compatible: number
}

export type RecurringRun = { created: number; skipped: number }

/** 表 Q: 止めていない登録の next_on が今日(日本時間)以前なら作る(Q1)。今日より後(Q2)・止めた(Q3)は作らない */
export async function runRecurring(env: Bindings, now: Date): Promise<RecurringRun> {
  const db = env.DB
  const today = jstDate(now)
  const { results } = await db
    .prepare(
      `SELECT r.id, r.name, r.category_id, r.amount, r.payment_method, r.day_of_month, r.next_on, r.created_by, p.card_compatible
       FROM recurring_expenses r JOIN payment_methods p ON p.code = r.payment_method
       WHERE r.ended_at IS NULL AND r.next_on <= ? ORDER BY r.id`,
    )
    .bind(today)
    .all<Row>()
  const run: RecurringRun = { created: 0, skipped: 0 }
  for (const r of results) {
    let on = r.next_on
    for (let i = 0; i < MAX_PER_RUN && on <= today; i++) {
      const done = await createOne(env, r, on, now)
      if (!done) {
        run.skipped += 1 // ほかの判定が先に作った・登録が変わった。次の日の判定で読み直す
        break
      }
      run.created += 1
      on = nextAfter(on, r.day_of_month)
    }
  }
  return run
}

async function createOne(env: Bindings, r: Row, on: string, now: Date): Promise<boolean> {
  const db = env.DB
  const key = `recurring-${r.id}-${on}`
  const at = nowIso(now)
  const ref = { sql: '(SELECT id FROM expenses WHERE client_request_id = ?)', binds: [key] }
  // 人の支出と同じに照合を掛ける(§1.17: 特別扱いしない)。書き込みは同じ batch に入れる(§3.0)
  const matching = await reconcileStatements(env, [on], {
    expense: { id: -1, spentOn: on, amount: r.amount, cardCompatible: r.card_compatible === 1, ref },
  })
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO expenses (origin, client_request_id, receipt_id, spent_on, store_name, payment_method, registered_by, created_at, updated_at, recurring_id)
           VALUES ('person', ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(key, on, r.name, r.payment_method, r.created_by, at, at, r.id),
      db
        .prepare(
          `INSERT INTO items (expense_id, position, name, category_id, tax_rate, base_amount, amount, stock_item_id, stock_quantity)
           VALUES (${ref.sql}, 1, ?, ?, NULL, ?, ?, NULL, NULL)`,
        )
        .bind(key, r.name, r.category_id, r.amount, r.amount),
      ...matching,
      // 読んだ時の next_on のときだけ進める(読んだ後に人が次に作る日を直していれば、直した値を残す)
      db
        .prepare('UPDATE recurring_expenses SET next_on = ?, updated_at = ? WHERE id = ? AND next_on = ?')
        .bind(nextAfter(on, r.day_of_month), at, r.id, on),
    ])
    return true
  } catch (e) {
    // 同じ日の支出がもうある(同時に 2 回走った)。batch ごと戻るので何も書かれていない
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed: expenses.client_request_id')) return false
    throw e
  }
}
