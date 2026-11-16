// 支出の口。正本: docs/設計/データと照合.md §1.6・§2.2・§2.3・§5
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { distribute, NoDistributionTarget } from '../domain/distribute'
import { reconcileStatements } from '../domain/reconcile'
import { jstDate, nowIso } from '../time'
import { isoDate, month } from '../schemas'
import type { AppEnv } from '../types'

// 入力の型は画面と MCP(worker/mcp.ts)の両方が使う。説明(describe)は MCP の道具の説明になるので、正本(データと照合 §1.6・§5)の定義どおりに書く
const date = isoDate.describe('YYYY-MM-DD(買った日。通販は注文日。本当にある日で、今日(日本時間)より後は不可)')
const rate = z.union([z.literal(0), z.literal(8), z.literal(10)]).nullable()

// 在庫の品物の欄: 作るときは省ける(null)。直す(PUT・update_expense)ときは品目を全部置き換えるので省けない
// (省くと黙って在庫の結び付きが外れ、在庫の数が減るため)
const stockItemIdOf = (create: boolean) => {
  const t = z
    .number()
    .int()
    .nullable()
    .describe(
      create
        ? '在庫の品物の id(在庫の品物に当たる品目だけ。やめた品物は使えない。額が正の品目だけ)。無ければ null'
        : '在庫の品物の id(額が正の品目だけ)。無ければ null。省けない: get_expense の値をそのまま写す(null にすると在庫の結び付きが外れる)',
    )
  return create ? t.default(null) : t
}
const stockQuantityOf = (create: boolean) => {
  const t = z.number().int().min(1).nullable().describe('在庫に足す個数(買った単位。12 ロール入り 1 つ = 1)。品物が無ければ null')
  return create ? t.default(null) : t
}
const itemOf = (create: boolean) =>
  z
    .object({
      name: z.string().max(200).nullable().describe('品名'),
      categoryId: z.number().int().describe('費目の id(費目の一覧の id。やめた費目は使えない)'),
      taxRate: rate.describe('品目の税率(%)。不明なら null'),
      baseAmount: z
        .number()
        .int()
        .describe('値札の額から、その品目の直下の値引き行を引いた額(円)。値引き行は単独の品目にせず真上の品目から引く。返品は負'),
      stockItemId: stockItemIdOf(create),
      stockQuantity: stockQuantityOf(create),
    })
    .refine((it) => (it.stockItemId === null) === (it.stockQuantity === null), { message: 'stockItemId と stockQuantity は両方入れるか両方 null' })
    .refine((it) => it.stockItemId === null || it.baseAmount > 0, { message: '在庫の品物は額が正の品目だけに付けられる(返品で在庫は増えない)' })
const adjustmentSchema = z.object({
  kind: z.enum(['discount', 'tax']).describe('レシート全体にかかる値引き(discount)か外税(tax)。内税・ポイントで払った分は入れない'),
  amount: z
    .number()
    .int()
    .refine((v) => v !== 0)
    .describe('レシートに印字された額(円。0 は不可)。値引きは品目と逆の符号、外税は品目と同じ符号(買い物は値引きが負・外税が正、返品のレシートは外税が負)'),
  taxRate: rate.describe('その率の品目だけにかかるなら率、全部の品目にかかるなら null'),
})
const bodyOf = (create: boolean) =>
  z.object({
    spentOn: date,
    storeName: z.string().max(200).describe('店の名前(レシートの表記。支店名があれば含める)'),
    paymentMethod: z.string().describe('支払い方法のコード(支払い方法の一覧の code)'),
    items: z.array(itemOf(create)).min(1).max(200),
    adjustments: z.array(adjustmentSchema).max(20).describe('レシート全体にかかる値引き・外税。無ければ []'),
  })
/** 直す(PUT・MCP の update_expense) */
export const expenseBody = bodyOf(false)
/** 作る(POST・MCP の add_expense) */
export const createBody = bodyOf(true).extend({
  clientRequestId: z.string().min(1).max(100).describe('この支出を表す一意の文字列(UUID など)。送り直すときは同じ値'),
  receiptId: z.number().int().nullable(),
})
export const itemCategoryBody = z.object({ categoryId: z.number().int().describe('費目の id(やめた費目は、この支出の品目にすでに付いているものだけ使える)') })

type ExpenseRow = {
  id: number
  origin: 'person' | 'statement_purchase' | 'statement_fee'
  receipt_id: number | null
  spent_on: string
  store_name: string
  payment_method: string
  registered_by: number
  registered_by_name: string
  amount: number
  charge_count: number
  charge_total: number | null
  updated_at: string
  recurring_id: number | null
  no_statement_acked: number
  accepted_diff: number | null
}

// 新しく付ける品物はやめていないものだけ。直すときは、直す前に付いていた品物ならやめていても付けられる(費目と同じ。§1.6)
async function validStockItemIds(db: D1Database, ids: (number | null)[], allowRetired: Set<number>) {
  const wanted = ids.filter((id): id is number => id !== null)
  if (wanted.length === 0) return true
  const { results } = await db.prepare('SELECT id, retired_at FROM stock_items').all<{ id: number; retired_at: string | null }>()
  const usable = new Set(results.filter((r) => r.retired_at === null || allowRetired.has(r.id)).map((r) => r.id))
  return wanted.every((id) => usable.has(id))
}

async function validCategoryIds(db: D1Database, ids: number[], allowRetired: Set<number>) {
  const { results } = await db.prepare('SELECT id, retired_at FROM categories').all<{ id: number; retired_at: string | null }>()
  const usable = new Set(results.filter((r) => r.retired_at === null || allowRetired.has(r.id)).map((r) => r.id))
  return ids.every((id) => usable.has(id))
}

function amounts(body: z.infer<typeof expenseBody>) {
  const positioned = body.items.map((it, i) => ({ position: i + 1, baseAmount: it.baseAmount, taxRate: it.taxRate }))
  return distribute(positioned, body.adjustments)
}

function itemStatements(db: D1Database, expenseRef: { sql: string; bind: unknown }, body: z.infer<typeof expenseBody>, dist: Map<number, number>) {
  return [
    ...body.items.map((it, i) =>
      db
        .prepare(
          `INSERT INTO items (expense_id, position, name, category_id, tax_rate, base_amount, amount, stock_item_id, stock_quantity)
           VALUES (${expenseRef.sql}, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(expenseRef.bind, i + 1, it.name, it.categoryId, it.taxRate, it.baseAmount, dist.get(i + 1)!, it.stockItemId, it.stockQuantity),
    ),
    ...body.adjustments.map((a) =>
      db
        .prepare(`INSERT INTO expense_adjustments (expense_id, kind, amount, tax_rate) VALUES (${expenseRef.sql}, ?, ?, ?)`)
        .bind(expenseRef.bind, a.kind, a.amount, a.taxRate),
    ),
  ]
}

async function cardCompatible(db: D1Database, code: string) {
  const pm = await db.prepare('SELECT card_compatible FROM payment_methods WHERE code = ?').bind(code).first<{ card_compatible: number }>()
  return pm ? pm.card_compatible === 1 : null
}

const total = (dist: Map<number, number>) => [...dist.values()].reduce((a, b) => a + b, 0)

async function parse<T extends z.ZodType>(c: Context<AppEnv>, schema: T) {
  const json = await c.req.json().catch(() => undefined)
  return schema.safeParse(json)
}

const EXPENSE_SELECT = `
  SELECT e.id, e.origin, e.receipt_id, e.spent_on, e.store_name, e.payment_method, e.registered_by, e.updated_at, e.recurring_id,
         u.display_name AS registered_by_name,
         (SELECT SUM(amount) FROM items WHERE expense_id = e.id) AS amount,
         (SELECT count(*) FROM card_charges WHERE expense_id = e.id) AS charge_count,
         (SELECT SUM(amount) FROM card_charges WHERE expense_id = e.id) AS charge_total,
         EXISTS (SELECT 1 FROM no_statement_acks WHERE expense_id = e.id) AS no_statement_acked,
         (SELECT accepted_diff FROM diff_acks WHERE expense_id = e.id) AS accepted_diff
  FROM expenses e JOIN users u ON u.id = e.registered_by`

function presentRow(r: ExpenseRow) {
  return {
    id: r.id,
    origin: r.origin,
    receiptId: r.receipt_id,
    spentOn: r.spent_on,
    storeName: r.store_name,
    paymentMethod: r.payment_method,
    registeredBy: r.registered_by_name,
    amount: r.amount,
    chargeCount: r.charge_count,
    diff: r.charge_count > 0 ? (r.charge_total ?? 0) - r.amount : null,
    updatedAt: r.updated_at,
    // 確かめる一覧で人が片付けたか(表 W の W6・W7)
    noStatementAcked: r.no_statement_acked === 1,
    acceptedDiff: r.accepted_diff,
    // 毎月決まった支出から自動で作った(一覧の「自動」の印。データと照合 §4.12)
    recurring: r.recurring_id !== null,
  }
}

export const expenses = new Hono<AppEnv>()

expenses.get('/', async (c) => {
  const m = month.safeParse(c.req.query('month'))
  if (!m.success) return c.json({ error: 'invalid_month' }, 400)
  // 一覧の画面(データと照合 §4.8)が 1 回で出せるよう、品目の費目の並び・費目・支払い方法を添える
  const db = c.env.DB
  const [rows, items, categories, methods] = await db.batch<Record<string, unknown>>([
    db.prepare(`${EXPENSE_SELECT} WHERE e.spent_on BETWEEN ? AND ? ORDER BY e.spent_on DESC, e.id DESC`).bind(`${m.data}-01`, `${m.data}-31`),
    db
      .prepare(
        `SELECT i.expense_id, i.category_id FROM items i JOIN expenses e ON e.id = i.expense_id
         WHERE e.spent_on BETWEEN ? AND ? ORDER BY i.expense_id, i.position`,
      )
      .bind(`${m.data}-01`, `${m.data}-31`),
    db.prepare(
      `SELECT c.id, c.name, c.kind, c.retired_at IS NOT NULL AS retired, sc.role AS systemRole
       FROM categories c LEFT JOIN system_categories sc ON sc.category_id = c.id ORDER BY c.sort_order, c.id`,
    ),
    db.prepare('SELECT code, label, statement_expected FROM payment_methods ORDER BY sort_order'),
  ])
  const catIds = new Map<number, number[]>()
  for (const i of items!.results) {
    const list = catIds.get(i.expense_id as number) ?? []
    if (!list.includes(i.category_id as number)) list.push(i.category_id as number)
    catIds.set(i.expense_id as number, list)
  }
  return c.json({
    expenses: (rows!.results as ExpenseRow[]).map((r) => ({ ...presentRow(r), categoryIds: catIds.get(r.id) ?? [] })),
    categories: categories!.results.map((r) => ({ id: r.id, name: r.name, kind: r.kind, retired: r.retired === 1, systemRole: r.systemRole })),
    paymentMethods: methods!.results.map((r) => ({ code: r.code, label: r.label, statementExpected: r.statement_expected === 1 })),
  })
})

/** 支出 1 件の詳しい形(`GET /api/expenses/:id` と確かめて保存の画面の口 §4.7)。無ければ null */
export async function expenseDetail(db: D1Database, id: number) {
  const row = await db.prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).bind(id).first<ExpenseRow>()
  if (!row) return null
  const [items, adjustments, charges] = await db.batch([
    db
      .prepare('SELECT position, name, category_id, tax_rate, base_amount, amount, stock_item_id, stock_quantity FROM items WHERE expense_id = ? ORDER BY position')
      .bind(id),
    db.prepare('SELECT kind, amount, tax_rate FROM expense_adjustments WHERE expense_id = ? ORDER BY id').bind(id),
    db.prepare('SELECT id, billing_month, used_on, merchant, card_user, amount FROM card_charges WHERE expense_id = ? ORDER BY used_on, id').bind(id),
  ])
  return {
    ...presentRow(row),
    items: (items.results as Record<string, unknown>[]).map((i) => ({
      position: i.position,
      name: i.name,
      categoryId: i.category_id,
      taxRate: i.tax_rate,
      baseAmount: i.base_amount,
      amount: i.amount,
      stockItemId: i.stock_item_id,
      stockQuantity: i.stock_quantity,
    })),
    adjustments: (adjustments.results as Record<string, unknown>[]).map((a) => ({ kind: a.kind, amount: a.amount, taxRate: a.tax_rate })),
    charges: (charges.results as Record<string, unknown>[]).map((ch) => ({
      id: ch.id,
      billingMonth: ch.billing_month,
      usedOn: ch.used_on,
      merchant: ch.merchant,
      cardUser: ch.card_user,
      amount: ch.amount,
    })),
  }
}

expenses.get('/:id{[0-9]+}', async (c) => {
  const detail = await expenseDetail(c.env.DB, Number(c.req.param('id')))
  return detail ? c.json(detail) : c.json({ error: 'not_found' }, 404)
})

// 下書きから保存 / 手入力で保存(§2.2)
expenses.post('/', async (c) => {
  const parsed = await parse(c, createBody)
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const body = parsed.data
  if (body.spentOn > jstDate()) return c.json({ error: 'future_date' }, 400)
  const db = c.env.DB
  const user = c.get('user')

  const existing = await db.prepare('SELECT id FROM expenses WHERE client_request_id = ?').bind(body.clientRequestId).first<{ id: number }>()
  // 送り直し: 前の要求で保存済み。reused を付け、画面は今の入力で直す(PUT)かを決める(§4.7)
  if (existing) return c.json({ id: existing.id, reused: true }, 200)

  if (!(await validCategoryIds(db, body.items.map((i) => i.categoryId), new Set()))) return c.json({ error: 'invalid_category' }, 400)
  if (!(await validStockItemIds(db, body.items.map((i) => i.stockItemId), new Set()))) return c.json({ error: 'invalid_stock_item' }, 400)
  if (body.receiptId !== null) {
    const r = await db
      .prepare(
        `SELECT r.id, (SELECT count(*) FROM receipt_images WHERE receipt_id = r.id AND stored_at IS NULL) AS unstored,
                (SELECT count(*) FROM expenses WHERE receipt_id = r.id) AS saved
         FROM receipts r WHERE r.id = ?`,
      )
      .bind(body.receiptId)
      .first<{ id: number; unstored: number; saved: number }>()
    if (!r) return c.json({ error: 'receipt_not_found' }, 404)
    if (r.unstored > 0) return c.json({ error: 'images_not_stored' }, 409)
    if (r.saved > 0) return c.json({ error: 'receipt_already_saved' }, 409)
  }

  let dist: Map<number, number>
  try {
    dist = amounts(body)
  } catch (e) {
    if (e instanceof NoDistributionTarget) return c.json({ error: 'no_distribution_target' }, 422)
    throw e
  }

  const compatible = await cardCompatible(db, body.paymentMethod)
  if (compatible === null) return c.json({ error: 'invalid_payment_method' }, 400)

  const now = nowIso()
  const ref = { sql: '(SELECT id FROM expenses WHERE client_request_id = ?)', bind: body.clientRequestId }
  // 照合の書き込みも同じ batch に入れる(§3.0)。新しい支出は自由なので評価に重ねる
  const matching = await reconcileStatements(c.env, [body.spentOn], {
    expense: {
      id: -1,
      spentOn: body.spentOn,
      amount: total(dist),
      cardCompatible: compatible,
      ref: { sql: ref.sql, binds: [ref.bind] },
    },
  })
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO expenses (origin, client_request_id, receipt_id, spent_on, store_name, payment_method, registered_by, created_at, updated_at)
           VALUES ('person', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(body.clientRequestId, body.receiptId, body.spentOn, body.storeName, body.paymentMethod, user.id, now, now),
      ...itemStatements(db, ref, body, dist),
      ...(body.receiptId !== null
        ? [db.prepare('UPDATE receipts SET first_saved_at = COALESCE(first_saved_at, ?) WHERE id = ?').bind(now, body.receiptId)]
        : []),
      ...matching,
    ])
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('UNIQUE constraint failed: expenses.receipt_id')) return c.json({ error: 'receipt_already_saved' }, 409)
    if (msg.includes('UNIQUE constraint failed: expenses.client_request_id')) {
      const again = await db.prepare('SELECT id FROM expenses WHERE client_request_id = ?').bind(body.clientRequestId).first<{ id: number }>()
      return c.json({ id: again!.id, reused: true }, 200)
    }
    if (msg.includes('FOREIGN KEY constraint failed')) return c.json({ error: 'invalid_reference' }, 400)
    throw e
  }
  const created = (await db.prepare('SELECT id FROM expenses WHERE client_request_id = ?').bind(body.clientRequestId).first<{ id: number }>())!
  return c.json({ id: created.id }, 201)
})

// 人の支出を直す(日付・店・支払い方法・品目・調整)。結びは今のまま(§2.2)
expenses.put('/:id{[0-9]+}', async (c) => {
  const parsed = await parse(c, expenseBody)
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const body = parsed.data
  if (body.spentOn > jstDate()) return c.json({ error: 'future_date' }, 400)
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const row = await db.prepare('SELECT origin, spent_on FROM expenses WHERE id = ?').bind(id).first<{ origin: string; spent_on: string }>()
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (row.origin !== 'person') return c.json({ error: 'statement_expense_is_fixed' }, 409)

  const current = await db
    .prepare('SELECT category_id, stock_item_id FROM items WHERE expense_id = ?')
    .bind(id)
    .all<{ category_id: number; stock_item_id: number | null }>()
  const keep = new Set(current.results.map((r) => r.category_id)) // やめた費目でも、すでに付いている品目はそのまま直せる
  if (!(await validCategoryIds(db, body.items.map((i) => i.categoryId), keep))) return c.json({ error: 'invalid_category' }, 400)
  const keepStock = new Set(current.results.flatMap((r) => (r.stock_item_id === null ? [] : [r.stock_item_id]))) // 品物も費目と同じ
  if (!(await validStockItemIds(db, body.items.map((i) => i.stockItemId), keepStock))) return c.json({ error: 'invalid_stock_item' }, 400)

  let dist: Map<number, number>
  try {
    dist = amounts(body)
  } catch (e) {
    if (e instanceof NoDistributionTarget) return c.json({ error: 'no_distribution_target' }, 422)
    throw e
  }
  const compatible = await cardCompatible(db, body.paymentMethod)
  if (compatible === null) return c.json({ error: 'invalid_payment_method' }, 400)
  const linked = await db.prepare('SELECT count(*) AS n FROM card_charges WHERE expense_id = ?').bind(id).first<{ n: number }>()
  const ref = { sql: '?', bind: id }
  // 直す前と後の日付の周りを掛け直す(§3.0 の掛け直す範囲)。自由な支出なら直した後の値で評価に重ねる
  const matching = await reconcileStatements(
    c.env,
    [row.spent_on, body.spentOn],
    linked!.n === 0
      ? { expense: { id, spentOn: body.spentOn, amount: total(dist), cardCompatible: compatible, ref: { sql: '?', binds: [id] } } }
      : {},
  )
  try {
    await db.batch([
      db.prepare('DELETE FROM items WHERE expense_id = ?').bind(id),
      db.prepare('DELETE FROM expense_adjustments WHERE expense_id = ?').bind(id),
      db
        .prepare('UPDATE expenses SET spent_on = ?, store_name = ?, payment_method = ?, updated_at = ? WHERE id = ?')
        .bind(body.spentOn, body.storeName, body.paymentMethod, nowIso(), id),
      ...itemStatements(db, ref, body, dist),
      ...matching,
    ])
  } catch (e) {
    if (e instanceof Error && e.message.includes('FOREIGN KEY constraint failed')) return c.json({ error: 'invalid_reference' }, 400)
    throw e
  }
  return c.json({ id })
})

// 費目だけを直す(明細の支出・手数料の支出で直せるのはここだけ。§6 の J6)
expenses.patch('/:id{[0-9]+}/items/:position{[0-9]+}', async (c) => {
  const parsed = await parse(c, itemCategoryBody)
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const position = Number(c.req.param('position'))
  const item = await db.prepare('SELECT category_id FROM items WHERE expense_id = ? AND position = ?').bind(id, position).first<{ category_id: number }>()
  if (!item) return c.json({ error: 'not_found' }, 404)
  // やめた費目は、この支出の品目にすでに付いているものなら使える(PUT と同じ支出の単位。§1.6)
  const onExpense = await db.prepare('SELECT category_id FROM items WHERE expense_id = ?').bind(id).all<{ category_id: number }>()
  if (!(await validCategoryIds(db, [parsed.data.categoryId], new Set(onExpense.results.map((r) => r.category_id))))) return c.json({ error: 'invalid_category' }, 400)
  await db.batch([
    db.prepare('UPDATE items SET category_id = ? WHERE expense_id = ? AND position = ?').bind(parsed.data.categoryId, id, position),
    db.prepare('UPDATE expenses SET updated_at = ? WHERE id = ?').bind(nowIso(), id),
  ])
  return c.json({ id })
})

// 人の支出を消す。結ばれていた行は結ばれていない状態に戻り、レシートは下書きに戻る(§2.2)
expenses.delete('/:id{[0-9]+}', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const row = await db.prepare('SELECT origin, spent_on FROM expenses WHERE id = ?').bind(id).first<{ origin: string; spent_on: string }>()
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (row.origin !== 'person') return c.json({ error: 'statement_expense_is_fixed' }, 409)
  const { results: freed } = await db.prepare('SELECT used_on FROM card_charges WHERE expense_id = ?').bind(id).all<{ used_on: string }>()
  // 消した支出の日付と、外れた行の利用日の周りを掛け直す。同じ batch で、消した後のデータとして評価する
  const matching = await reconcileStatements(c.env, [row.spent_on, ...freed.map((f) => f.used_on)], { removedExpenseId: id })
  await db.batch([db.prepare('DELETE FROM expenses WHERE id = ?').bind(id), ...matching])
  return c.body(null, 204)
})
