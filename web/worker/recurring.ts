// 毎月決まった支出を作る(Cron Trigger。正本: docs/設計/データと照合.md §1.17・表 Q)
import { reconcileStatements } from './domain/reconcile'
import { jstDate, nowIso } from './time'
import type { Bindings } from './types'

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
  updated_at: string
  created_by: number
  card_compatible: number
}

/** 1 回の判定で作る支出の数の上限(全部の登録で合わせて)。1 つ作るのに D1 を 3 回呼ぶので、Worker の 1 回の呼び出しの上限(無料の 50 回)と在庫の通知の分を残す */
export const MAX_TOTAL_PER_RUN = 10

export type RecurringRun = { created: number; skipped: number; failed: number }

/** 表 Q: 止めていない登録の next_on が今日(日本時間)以前なら作る(Q1)。今日より後(Q2)・止めた(Q3)は作らない。
 * 作り切れなかった分(上限)は次の日の判定で続ける */
export async function runRecurring(env: Bindings, now: Date): Promise<RecurringRun> {
  const db = env.DB
  const today = jstDate(now)
  const { results } = await db
    .prepare(
      `SELECT r.id, r.name, r.category_id, r.amount, r.payment_method, r.day_of_month, r.next_on, r.updated_at, r.created_by, p.card_compatible
       FROM recurring_expenses r JOIN payment_methods p ON p.code = r.payment_method
       WHERE r.ended_at IS NULL AND r.next_on <= ? ORDER BY r.next_on, r.id`,
    )
    .bind(today)
    .all<Row>()
  const run: RecurringRun = { created: 0, skipped: 0, failed: 0 }
  // 日付の古い順に 1 つずつ作る(上限に当たっても、1 つの登録だけが進み続けない)。上限は試した回数で数える(D1 の呼び出しの上限のため)
  const queue = results.map((r) => ({ r, on: r.next_on, updatedAt: r.updated_at }))
  for (let tries = 0; tries < MAX_TOTAL_PER_RUN; tries++) {
    const live = queue.filter((q) => q.on <= today)
    if (live.length === 0) break
    const q = live.reduce((a, b) => (b.on < a.on || (b.on === a.on && b.r.id < a.r.id) ? b : a))
    let result: CreateResult
    try {
      result = await createOne(env, q.r, q, now)
    } catch (e) {
      // 1 つの登録の失敗で、ほかの登録と在庫の通知を止めない。batch ごと戻るので next_on も進んでいない(次の日にやり直す)
      console.error('recurring create failed', q.r.id, q.on, e)
      run.failed += 1
      queue.splice(queue.indexOf(q), 1)
      continue
    }
    if (result.kind === 'changed') {
      queue.splice(queue.indexOf(q), 1) // 読んだ後に直された・止められた・ほかの判定が進めた。次の日に読み直す
      continue
    }
    if (result.kind === 'created') run.created += 1
    else run.skipped += 1 // その日の支出がもうある(作り直さない。next_on は進めた)
    q.on = nextAfter(q.on, q.r.day_of_month)
    q.updatedAt = result.updatedAt
  }
  return run
}

type CreateResult = { kind: 'created' | 'exists'; updatedAt: string } | { kind: 'changed' }

/** 1 つ作る。1 つの batch で、先に next_on を進め(読んだ時の next_on・updated_at・止めていないときだけ)、
 * この batch が進めたときだけ支出を作る(進めていなければ支出の client_request_id を NULL にして batch ごと失敗させる = 何も書かない)。
 * その日の支出がもうある(UNIQUE)ときは作り直さず、next_on だけを進める */
export async function createOne(env: Bindings, r: Row, cur: { on: string; updatedAt: string }, now: Date): Promise<CreateResult> {
  const db = env.DB
  const { on } = cur
  const next = nextAfter(on, r.day_of_month)
  const key = `recurring-${r.id}-${on}`
  const at = nowIso(now)
  const claim = db
    .prepare('UPDATE recurring_expenses SET next_on = ?, updated_at = ? WHERE id = ? AND next_on = ? AND updated_at = ? AND ended_at IS NULL')
    .bind(next, at, r.id, on, cur.updatedAt)
  const ref = { sql: '(SELECT id FROM expenses WHERE client_request_id = ?)', binds: [key] }
  // 人の支出と同じに照合を掛ける(§1.17: 特別扱いしない)。書き込みは同じ batch に入れる(§3.0)
  const matching = await reconcileStatements(env, [on], {
    expense: { id: -1, spentOn: on, amount: r.amount, cardCompatible: r.card_compatible === 1, ref },
  })
  try {
    await db.batch([
      claim,
      db
        .prepare(
          `INSERT INTO expenses (origin, client_request_id, receipt_id, spent_on, store_name, payment_method, registered_by, created_at, updated_at, recurring_id)
           SELECT 'person', CASE WHEN changes() = 1 THEN ? END, NULL, ?, ?, ?, ?, ?, ?, ?`,
        )
        // changes() = 直前の claim が進めた行の数(同じ batch = 同じ接続の続き)。同じ時刻の判定が 2 回走っても、進めた方だけが作る
        .bind(key, on, r.name, r.payment_method, r.created_by, at, at, r.id),
      db
        .prepare(
          `INSERT INTO items (expense_id, position, name, category_id, tax_rate, base_amount, amount, stock_item_id, stock_quantity)
           VALUES (${ref.sql}, 1, ?, ?, NULL, ?, ?, NULL, NULL)`,
        )
        .bind(key, r.name, r.category_id, r.amount, r.amount),
      ...matching,
    ])
    return { kind: 'created', updatedAt: at }
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('NOT NULL constraint failed: expenses.client_request_id')) return { kind: 'changed' }
    if (msg.includes('UNIQUE constraint failed: expenses.client_request_id')) {
      // その日の支出がもうある(次に作る日を作った日に戻した・同時に走った)。作り直さず進める(止まらない)
      const res = await claim.run()
      return res.meta.changes === 1 ? { kind: 'exists', updatedAt: at } : { kind: 'changed' }
    }
    throw e
  }
}
