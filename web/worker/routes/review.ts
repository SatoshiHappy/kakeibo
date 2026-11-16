// 確かめる一覧と、一覧での人の操作。正本: docs/設計/データと照合.md 表 A-2・表 A-3・表 L・§2.2〜§2.4
import { Hono } from 'hono'
import { z } from 'zod'
import { dayDiff, Matcher, type FreeExpense, type FreeRow } from '../domain/match'
import { idRef, reconcileStatements } from '../domain/reconcile'
import { nowIso } from '../time'
import type { AppEnv } from '../types'

type ChargeRow = {
  id: number
  used_on: string
  merchant: string
  card_user: string
  amount: number
  expense_id: number | null
  expense_origin: string | null
}
type ExpenseRow = {
  id: number
  spent_on: string
  store_name: string
  payment_method: string
  card_compatible: number
  statement_expected: number
  amount: number
  charge_count: number
  charge_total: number | null
  acked: number
  accepted_diff: number | null
}

const presentCharge = (c: ChargeRow) => ({ id: c.id, usedOn: c.used_on, merchant: c.merchant, cardUser: c.card_user, amount: c.amount })
const presentExpense = (e: ExpenseRow) => ({ id: e.id, spentOn: e.spent_on, storeName: e.store_name, paymentMethod: e.payment_method, amount: e.amount })

/** 取り込み済みの明細の期間: 取り込んだ請求月 M ごとに M の前の月(§3.0・J2) */
function coveredMonths(billingMonths: string[]) {
  return new Set(
    billingMonths.map((m) => {
      const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 2, 1))
      return d.toISOString().slice(0, 7)
    }),
  )
}

/** 確かめる一覧の項目(表 L)。一覧の口と、ホームの件数(ホームの口)が使う */
export async function reviewItems(db: D1Database, w: number) {
  const [chargesRes, expensesRes, rejectionsRes, monthsRes] = await db.batch([
    db.prepare(
      `SELECT id, used_on, merchant, card_user, amount, expense_id, expense_origin FROM card_charges WHERE amount IS NOT NULL`,
    ),
    db.prepare(
      `SELECT e.id, e.spent_on, e.store_name, e.payment_method, pm.card_compatible, pm.statement_expected,
              (SELECT SUM(amount) FROM items WHERE expense_id = e.id) AS amount,
              (SELECT count(*) FROM card_charges WHERE expense_id = e.id) AS charge_count,
              (SELECT SUM(amount) FROM card_charges WHERE expense_id = e.id) AS charge_total,
              EXISTS (SELECT 1 FROM no_statement_acks WHERE expense_id = e.id) AS acked,
              (SELECT accepted_diff FROM diff_acks WHERE expense_id = e.id) AS accepted_diff
       FROM expenses e JOIN payment_methods pm ON pm.code = e.payment_method
       WHERE e.origin = 'person'`,
    ),
    db.prepare('SELECT card_charge_id, expense_id FROM match_rejections'),
    db.prepare('SELECT DISTINCT billing_month FROM statement_imports'),
  ])
  const charges = chargesRes.results as ChargeRow[]
  const expenses = expensesRes.results as ExpenseRow[]
  const rejections = (rejectionsRes.results as { card_charge_id: number; expense_id: number }[]).map((r) => ({
    rowId: r.card_charge_id,
    expenseId: r.expense_id,
  }))
  const covered = coveredMonths((monthsRes.results as { billing_month: string }[]).map((m) => m.billing_month))

  const freeCharges = charges.filter((ch) => ch.expense_id === null || ch.expense_origin === 'statement_purchase')
  const freeRows: FreeRow[] = freeCharges.map((ch) => ({
    id: ch.id,
    usedOn: ch.used_on,
    amount: ch.amount,
    statementExpenseId: ch.expense_origin === 'statement_purchase' ? ch.expense_id : null,
  }))
  const freeExpenseRows = expenses.filter((e) => e.charge_count === 0)
  const freeExpenses: FreeExpense[] = freeExpenseRows.map((e) => ({
    id: e.id,
    spentOn: e.spent_on,
    amount: e.amount,
    cardCompatible: e.card_compatible === 1,
  }))
  const matcher = new Matcher(freeRows, freeExpenses, rejections, w)
  const chargeById = new Map(charges.map((ch) => [ch.id, ch]))
  const expenseById = new Map(expenses.map((e) => [e.id, e]))
  const rejected = new Set(rejections.map((r) => `${r.rowId}:${r.expenseId}`))

  const items: unknown[] = []
  // L1: 結ばれていない行で候補がある(表 A-1 の 3〜6 行)
  for (const r of freeRows.filter((r) => r.statementExpenseId === null)) {
    const cands = matcher.candidates(r)
    if (cands.length === 0) continue
    items.push({ type: 'row_candidates', charge: presentCharge(chargeById.get(r.id)!), candidates: cands.map((p) => presentExpense(expenseById.get(p.id)!)) })
  }
  for (const p of freeExpenses) {
    const e = expenseById.get(p.id)!
    const cRows = matcher.candidateRows(p)
    const statementRows = cRows.filter((r) => r.statementExpenseId !== null)
    if (statementRows.length > 0) {
      // L2: まとめる候補(表 A-2 の 1 行)
      items.push({ type: 'merge_candidates', expense: presentExpense(e), charges: statementRows.map((r) => presentCharge(chargeById.get(r.id)!)) })
      continue
    }
    if (cRows.length > 0) continue // 表 A-2 の 2 行: L1 の候補として出る
    if (!covered.has(p.spentOn.slice(0, 7))) continue // 3 行: 明細がまだ来ていない
    if (e.statement_expected !== 1) continue // 6 行
    if (e.acked === 1) continue // 5 行
    // 4 行: 明細に無い。別の人の支出に結ばれた似た行(E(P))があれば重複の疑いの印
    const similar = charges.filter(
      (ch) =>
        ch.expense_origin === 'person' &&
        ch.expense_id !== p.id &&
        ch.amount === p.amount &&
        dayDiff(ch.used_on, p.spentOn) <= w &&
        (ch.used_on === p.spentOn || p.cardCompatible) &&
        !rejected.has(`${ch.id}:${p.id}`),
    )
    items.push({ type: 'no_statement', expense: presentExpense(e), duplicateSuspects: similar.map(presentCharge) })
  }
  // L4: 結び済みの支出の差(表 A-3)
  for (const e of expenses.filter((e) => e.charge_count > 0)) {
    const diff = (e.charge_total ?? 0) - e.amount
    if (diff === 0 || e.accepted_diff === diff) continue
    items.push({
      type: 'diff',
      expense: presentExpense(e),
      diff,
      charges: charges.filter((ch) => ch.expense_id === e.id).map(presentCharge),
    })
  }
  return items
}

export const review = new Hono<AppEnv>()

review.get('/', async (c) => {
  const db = c.env.DB
  const [items, methods] = await Promise.all([
    reviewItems(db, Number(c.env.MATCH_WINDOW_DAYS)),
    db.prepare('SELECT code, label FROM payment_methods ORDER BY sort_order').all<{ code: string; label: string }>(),
  ])
  return c.json({ items, paymentMethods: methods.results })
})

const SEARCH_DAYS = 31
const SEARCH_LIMIT = 20
const searchQuery = z.union([
  z.object({ charge: z.coerce.number().int().positive(), expense: z.undefined() }),
  z.object({ charge: z.undefined(), expense: z.coerce.number().int().positive() }),
])

// 探して足す(データと照合 §4.9): 相手の日付の前後 31 日から、額の差・日付の差の小さい順に 20 件
review.get('/search', async (c) => {
  const q = searchQuery.safeParse({ charge: c.req.query('charge'), expense: c.req.query('expense') })
  if (!q.success) return c.json({ error: 'invalid_query' }, 400)
  const db = c.env.DB
  if (q.data.charge !== undefined) {
    const ch = await db.prepare('SELECT used_on, amount FROM card_charges WHERE id = ? AND amount IS NOT NULL').bind(q.data.charge).first<{ used_on: string; amount: number }>()
    if (!ch) return c.json({ error: 'not_found' }, 404)
    const { results } = await db
      .prepare(
        `SELECT e.id, e.spent_on, e.store_name, e.payment_method, (SELECT SUM(amount) FROM items WHERE expense_id = e.id) AS amount
         FROM expenses e
         WHERE e.origin = 'person' AND e.spent_on BETWEEN date(?, '-${SEARCH_DAYS} days') AND date(?, '+${SEARCH_DAYS} days')
           AND NOT EXISTS (SELECT 1 FROM match_rejections m WHERE m.card_charge_id = ? AND m.expense_id = e.id)
         ORDER BY abs(amount - ?), abs(julianday(e.spent_on) - julianday(?)), e.id
         LIMIT ${SEARCH_LIMIT}`,
      )
      .bind(ch.used_on, ch.used_on, q.data.charge, ch.amount, ch.used_on)
      .all<{ id: number; spent_on: string; store_name: string; payment_method: string; amount: number }>()
    return c.json({
      expenses: results.map((e) => ({ id: e.id, spentOn: e.spent_on, storeName: e.store_name, paymentMethod: e.payment_method, amount: e.amount })),
    })
  }
  const e = await db
    .prepare(`SELECT e.spent_on, (SELECT SUM(amount) FROM items WHERE expense_id = e.id) AS amount FROM expenses e WHERE e.id = ? AND e.origin = 'person'`)
    .bind(q.data.expense)
    .first<{ spent_on: string; amount: number }>()
  if (!e) return c.json({ error: 'not_found' }, 404)
  const { results } = await db
    .prepare(
      `SELECT id, used_on, merchant, card_user, amount FROM card_charges ch
       WHERE amount IS NOT NULL AND (expense_id IS NULL OR expense_origin = 'statement_purchase')
         AND used_on BETWEEN date(?, '-${SEARCH_DAYS} days') AND date(?, '+${SEARCH_DAYS} days')
         AND NOT EXISTS (SELECT 1 FROM match_rejections m WHERE m.card_charge_id = ch.id AND m.expense_id = ?)
       ORDER BY abs(amount - ?), abs(julianday(used_on) - julianday(?)), id
       LIMIT ${SEARCH_LIMIT}`,
    )
    .bind(e.spent_on, e.spent_on, q.data.expense, e.amount, e.spent_on)
    .all<ChargeRow>()
  return c.json({ charges: results.map(presentCharge) })
})

const pair = z.object({ chargeId: z.number().int(), expenseId: z.number().int() })

async function load(db: D1Database, chargeId: number, expenseId?: number) {
  const charge = await db
    .prepare('SELECT id, used_on, amount, expense_id, expense_origin FROM card_charges WHERE id = ?')
    .bind(chargeId)
    .first<{ id: number; used_on: string; amount: number | null; expense_id: number | null; expense_origin: string | null }>()
  const expense =
    expenseId === undefined
      ? null
      : await db.prepare("SELECT id, spent_on FROM expenses WHERE id = ? AND origin = 'person'").bind(expenseId).first<{ id: number; spent_on: string }>()
  return { charge, expense }
}

// 行を人の支出に結ぶ(候補を選ぶ・支出を探して足す・まとめる候補を選ぶ)。額が違ってもよい(差は表 A-3)
review.post('/link', async (c) => {
  const parsed = pair.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const db = c.env.DB
  const { charge, expense } = await load(db, parsed.data.chargeId, parsed.data.expenseId)
  if (!charge || !expense) return c.json({ error: 'not_found' }, 404)
  if (charge.amount === null) return c.json({ error: 'charge_without_amount' }, 409)
  if (charge.expense_origin === 'person') return c.json({ error: 'charge_already_linked' }, 409) // 付け替えは先に外す
  const statementExpenseId = charge.expense_origin === 'statement_purchase' ? charge.expense_id : null
  const writes = [
    db
      .prepare("UPDATE card_charges SET expense_id = ?, expense_origin = 'person' WHERE id = ? AND expense_id IS ?")
      .bind(expense.id, charge.id, statementExpenseId),
    ...(statementExpenseId !== null
      ? [
          db
            .prepare("DELETE FROM expenses WHERE id = ? AND origin = 'statement_purchase' AND NOT EXISTS (SELECT 1 FROM card_charges WHERE expense_id = ?)")
            .bind(statementExpenseId, statementExpenseId),
        ]
      : []),
  ]
  const matching = await reconcileStatements(c.env, [charge.used_on, expense.spent_on], {
    excludeRowIds: [charge.id],
    excludeExpenseIds: [expense.id],
  })
  await db.batch([...writes, ...matching])
  return c.json({ ok: true })
})

// 「別の買い物」: 組を拒否に入れ、結ばれていれば外す(§2.2)
review.post('/reject', async (c) => {
  const parsed = pair.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const db = c.env.DB
  const user = c.get('user')
  const { charge, expense } = await load(db, parsed.data.chargeId, parsed.data.expenseId)
  if (!charge || !expense) return c.json({ error: 'not_found' }, 404)
  const linked = charge.expense_origin === 'person' && charge.expense_id === expense.id
  const writes = [
    db
      .prepare(
        `INSERT INTO match_rejections (card_charge_id, expense_id, rejected_by, rejected_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (card_charge_id, expense_id) DO NOTHING`,
      )
      .bind(charge.id, expense.id, user.id, nowIso()),
    ...(linked ? [db.prepare('UPDATE card_charges SET expense_id = NULL, expense_origin = NULL WHERE id = ? AND expense_id = ?').bind(charge.id, expense.id)] : []),
  ]
  // 外したことで支出に行が 1 つも残らなければ、その支出も自由になる(評価に重ねる)
  const freedExpense = linked
    ? await db
        .prepare(
          `SELECT e.id, e.spent_on, pm.card_compatible, (SELECT SUM(amount) FROM items WHERE expense_id = e.id) AS amount,
                  (SELECT count(*) FROM card_charges WHERE expense_id = e.id) AS n
           FROM expenses e JOIN payment_methods pm ON pm.code = e.payment_method WHERE e.id = ?`,
        )
        .bind(expense.id)
        .first<{ id: number; spent_on: string; card_compatible: number; amount: number; n: number }>()
    : null
  const matching = await reconcileStatements(c.env, [charge.used_on, expense.spent_on], {
    freedRowIds: linked ? [charge.id] : [],
    extraRejections: [{ rowId: charge.id, expenseId: expense.id }],
    ...(freedExpense && freedExpense.n === 1
      ? {
          expense: {
            id: freedExpense.id,
            spentOn: freedExpense.spent_on,
            amount: freedExpense.amount,
            cardCompatible: freedExpense.card_compatible === 1,
            ref: idRef(freedExpense.id),
          },
        }
      : {}),
  })
  await db.batch([...writes, ...matching])
  return c.json({ ok: true })
})

// 「どれでもない」: 今の候補を全部拒否に入れ、表 A-1(7 行 → 明細の支出)を掛ける(§2.3)
review.post('/none', async (c) => {
  const parsed = z.object({ chargeId: z.number().int() }).safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const db = c.env.DB
  const user = c.get('user')
  const { charge } = await load(db, parsed.data.chargeId)
  if (!charge) return c.json({ error: 'not_found' }, 404)
  if (charge.expense_id !== null || charge.amount === null) return c.json({ error: 'not_free' }, 409)
  const w = Number(c.env.MATCH_WINDOW_DAYS)
  const { results } = await db
    .prepare(
      `SELECT e.id, e.spent_on, pm.card_compatible, (SELECT SUM(amount) FROM items WHERE expense_id = e.id) AS amount
       FROM expenses e JOIN payment_methods pm ON pm.code = e.payment_method
       WHERE e.origin = 'person' AND NOT EXISTS (SELECT 1 FROM card_charges c WHERE c.expense_id = e.id)`,
    )
    .all<{ id: number; spent_on: string; card_compatible: number; amount: number }>()
  const { results: rej } = await db.prepare('SELECT expense_id FROM match_rejections WHERE card_charge_id = ?').bind(charge.id).all<{ expense_id: number }>()
  const matcher = new Matcher(
    [{ id: charge.id, usedOn: charge.used_on, amount: charge.amount, statementExpenseId: null }],
    results.map((e) => ({ id: e.id, spentOn: e.spent_on, amount: e.amount, cardCompatible: e.card_compatible === 1 })),
    rej.map((r) => ({ rowId: charge.id, expenseId: r.expense_id })),
    w,
  )
  const cands = matcher.candidates({ id: charge.id, usedOn: charge.used_on, amount: charge.amount, statementExpenseId: null })
  const now = nowIso()
  const writes = cands.map((p) =>
    db
      .prepare(
        `INSERT INTO match_rejections (card_charge_id, expense_id, rejected_by, rejected_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (card_charge_id, expense_id) DO NOTHING`,
      )
      .bind(charge.id, p.id, user.id, now),
  )
  const matching = await reconcileStatements(c.env, [charge.used_on], {
    extraRejections: cands.map((p) => ({ rowId: charge.id, expenseId: p.id })),
  })
  await db.batch([...writes, ...matching])
  return c.json({ ok: true })
})

// 「明細に無い」を確認済みにする(表 A-2 の 5 行)
review.post('/ack-no-statement', async (c) => {
  const parsed = z.object({ expenseId: z.number().int() }).safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  try {
    await c.env.DB.prepare(
      `INSERT INTO no_statement_acks (expense_id, acked_by, acked_at) VALUES (?, ?, ?) ON CONFLICT (expense_id) DO NOTHING`,
    )
      .bind(parsed.data.expenseId, c.get('user').id, nowIso())
      .run()
  } catch (e) {
    if (e instanceof Error && e.message.includes('FOREIGN KEY constraint failed')) return c.json({ error: 'not_found' }, 404)
    throw e
  }
  return c.json({ ok: true })
})

// 「差あり」を「このまま」にする: 今の差を覚える。差が変わればまた出る(表 A-3)
review.post('/ack-diff', async (c) => {
  // diff: 画面で見た差(明細 − 支出)。渡したら、今の差が同じときだけ覚える(見ていない差を確認済みにしない)
  const parsed = z.object({ expenseId: z.number().int(), diff: z.number().int().optional() }).safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const db = c.env.DB
  const diffSql = `(SELECT SUM(amount) FROM card_charges WHERE expense_id = e.id) - (SELECT SUM(amount) FROM items WHERE expense_id = e.id)`
  const row = await db
    .prepare(`SELECT ${diffSql} AS diff FROM expenses e WHERE e.id = ? AND e.origin = 'person'`)
    .bind(parsed.data.expenseId)
    .first<{ diff: number | null }>()
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (row.diff === null || row.diff === 0) return c.json({ error: 'no_diff' }, 409)
  const seen = parsed.data.diff ?? row.diff
  if (seen !== row.diff) return c.json({ error: 'changed' }, 409)
  // 読んだ後に差が変わっていたら書かない(書くときに差をもう一度確かめる)
  const res = await db
    .prepare(
      `INSERT INTO diff_acks (expense_id, accepted_diff, acked_by, acked_at)
       SELECT e.id, ${diffSql}, ?, ? FROM expenses e WHERE e.id = ? AND ${diffSql} = ?
       ON CONFLICT (expense_id) DO UPDATE SET accepted_diff = excluded.accepted_diff, acked_by = excluded.acked_by, acked_at = excluded.acked_at`,
    )
    .bind(c.get('user').id, nowIso(), parsed.data.expenseId, seen)
    .run()
  if (res.meta.changes === 0) return c.json({ error: 'changed' }, 409)
  return c.json({ ok: true })
})
