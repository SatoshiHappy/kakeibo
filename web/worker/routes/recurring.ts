// 毎月決まった支出の登録の口。正本: docs/設計/データと照合.md §1.17・§4.12
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { firstOn } from '../recurring'
import { isoDate } from '../schemas'
import { jstDate, nowIso } from '../time'
import type { AppEnv } from '../types'

const fields = {
  name: z.string().trim().min(1).max(100),
  categoryId: z.number().int(),
  amount: z.number().int().min(1).max(100_000_000),
  paymentMethod: z.string().min(1),
  dayOfMonth: z.number().int().min(1).max(31),
}
const createBody = z.object({ clientRequestId: z.string().min(1).max(100), ...fields, nextOn: isoDate.nullable().default(null) })
const updateBody = z.object({ ...fields, nextOn: isoDate })

type Row = {
  id: number
  name: string
  category_id: number
  amount: number
  payment_method: string
  day_of_month: number
  next_on: string
}

async function body<T extends z.ZodType>(c: Context<AppEnv>, schema: T) {
  const json = await c.req.json().catch(() => undefined)
  return schema.safeParse(json)
}

/** 結果の優先順(§4.12)の 3 つ目以降: やめた費目 → 知らない支払い方法 → 今日より前の日(直すときは次に作る日を変えたときだけ) */
async function refusal(db: D1Database, b: { categoryId: number; paymentMethod: string; nextOn: string }, currentNextOn: string | null) {
  const [cat, pm] = await db.batch<{ retired_at?: string | null }>([
    db.prepare('SELECT retired_at FROM categories WHERE id = ?').bind(b.categoryId),
    db.prepare('SELECT 1 AS ok FROM payment_methods WHERE code = ?').bind(b.paymentMethod),
  ])
  const category = cat!.results[0]
  if (!category || category.retired_at !== null) return 'invalid_category'
  if (pm!.results.length === 0) return 'invalid_payment_method'
  if (b.nextOn !== currentNextOn && b.nextOn < jstDate()) return 'past_date'
  return null
}

/** 読んでから書くまでの間に費目がやめられた(トリガー recurring_category_active_on_*) */
const retiredMeanwhile = (e: unknown) => e instanceof Error && e.message.includes('recurring expense category retired')

export const recurring = new Hono<AppEnv>()

// 止めていない登録の一覧と、選べる費目・支払い方法(画面は API 1 回。基盤 §2.3)
recurring.get('/', async (c) => {
  const db = c.env.DB
  const [items, categories, methods] = await db.batch<Record<string, unknown>>([
    db.prepare(
      `SELECT id, name, category_id, amount, payment_method, day_of_month, next_on
       FROM recurring_expenses WHERE ended_at IS NULL ORDER BY day_of_month, id`,
    ),
    db.prepare('SELECT id, name FROM categories WHERE retired_at IS NULL ORDER BY sort_order, id'),
    db.prepare('SELECT code, label FROM payment_methods ORDER BY sort_order'),
  ])
  return c.json({
    items: (items!.results as Row[]).map((r) => ({
      id: r.id,
      name: r.name,
      categoryId: r.category_id,
      amount: r.amount,
      paymentMethod: r.payment_method,
      dayOfMonth: r.day_of_month,
      nextOn: r.next_on,
    })),
    categories: categories!.results,
    paymentMethods: methods!.results,
    today: jstDate(),
  })
})

recurring.post('/', async (c) => {
  const parsed = await body(c, createBody)
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const b = parsed.data
  const db = c.env.DB
  const existing = await db.prepare('SELECT id FROM recurring_expenses WHERE client_request_id = ?').bind(b.clientRequestId).first<{ id: number }>()
  if (existing) return c.json({ id: existing.id, reused: true }, 200)
  const nextOn = b.nextOn ?? firstOn(jstDate(), b.dayOfMonth)
  const refused = await refusal(db, { ...b, nextOn }, null)
  if (refused) return c.json({ error: refused }, 400)
  const now = nowIso()
  try {
    await db
      .prepare(
        `INSERT INTO recurring_expenses (client_request_id, name, category_id, amount, payment_method, day_of_month, next_on, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(b.clientRequestId, b.name, b.categoryId, b.amount, b.paymentMethod, b.dayOfMonth, nextOn, c.get('user').id, now, now)
      .run()
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed: recurring_expenses.client_request_id')) {
      const again = (await db.prepare('SELECT id FROM recurring_expenses WHERE client_request_id = ?').bind(b.clientRequestId).first<{ id: number }>())!
      return c.json({ id: again.id, reused: true }, 200)
    }
    if (retiredMeanwhile(e)) return c.json({ error: 'invalid_category' }, 400)
    throw e
  }
  const created = (await db.prepare('SELECT id FROM recurring_expenses WHERE client_request_id = ?').bind(b.clientRequestId).first<{ id: number }>())!
  return c.json({ id: created.id }, 201)
})

// 直す: 次に作る支出から効く(作った支出は変えない。§1.17)
recurring.put('/:id{[0-9]+}', async (c) => {
  const parsed = await body(c, updateBody)
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const b = parsed.data
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const row = await db.prepare('SELECT ended_at, next_on FROM recurring_expenses WHERE id = ?').bind(id).first<{ ended_at: string | null; next_on: string }>()
  if (!row || row.ended_at !== null) return c.json({ error: 'not_found' }, 404)
  const refused = await refusal(db, b, row.next_on)
  if (refused) return c.json({ error: refused }, 400)
  let res: D1Result
  try {
    res = await db
      .prepare(
        `UPDATE recurring_expenses SET name = ?, category_id = ?, amount = ?, payment_method = ?, day_of_month = ?, next_on = ?, updated_at = ?
         WHERE id = ? AND ended_at IS NULL`,
      )
      .bind(b.name, b.categoryId, b.amount, b.paymentMethod, b.dayOfMonth, b.nextOn, nowIso(), id)
      .run()
  } catch (e) {
    if (retiredMeanwhile(e)) return c.json({ error: 'invalid_category' }, 400)
    throw e
  }
  if (res.meta.changes === 0) return c.json({ error: 'not_found' }, 404)
  return c.json({ id })
})

// 止める(行は消さない。作った支出が指すため)
recurring.delete('/:id{[0-9]+}', async (c) => {
  const res = await c.env.DB.prepare('UPDATE recurring_expenses SET ended_at = ?, updated_at = ? WHERE id = ? AND ended_at IS NULL')
    .bind(nowIso(), nowIso(), Number(c.req.param('id')))
    .run()
  if (res.meta.changes === 0) return c.json({ error: 'not_found' }, 404)
  return c.body(null, 204)
})
