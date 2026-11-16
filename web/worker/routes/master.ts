// 費目・予算・支払い方法・集計の口。正本: docs/仕様/要求.md の集計・docs/設計/データと照合.md §1.3・§1.4・§4
import { Hono } from 'hono'
import { z } from 'zod'
import { jstDate, nowIso } from '../time'
import { month } from '../schemas'
import type { AppEnv } from '../types'


export const master = new Hono<AppEnv>()

master.get('/payment-methods', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT code, label FROM payment_methods ORDER BY sort_order').all()
  return c.json({ paymentMethods: results })
})

master.get('/categories', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.sort_order AS sortOrder, c.kind, c.retired_at IS NOT NULL AS retired, sc.role AS systemRole
     FROM categories c LEFT JOIN system_categories sc ON sc.category_id = c.id ORDER BY c.sort_order, c.id`,
  ).all<{ id: number; name: string; sortOrder: number; kind: string; retired: number; systemRole: string | null }>()
  return c.json({ categories: results.map((r) => ({ ...r, retired: r.retired === 1 })) })
})

// 種類の値は参照の表 category_kinds が正本(§1.3)。書く前に確かめ、無ければ 400(結果の優先順は §1.3)
const kind = z.string().min(1).max(20).describe('費目の種類: variable(毎月変わる)・fixed(固定費)・extra(臨時)')
const kindExists = async (db: D1Database, k: string) => (await db.prepare('SELECT 1 FROM category_kinds WHERE code = ?').bind(k).first()) !== null

master.post('/categories', async (c) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(30), kind }).safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  if (!(await kindExists(c.env.DB, parsed.data.kind))) return c.json({ error: 'invalid_kind' }, 400)
  try {
    const res = await c.env.DB.prepare(
      'INSERT INTO categories (name, sort_order, kind) VALUES (?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories), ?)',
    )
      .bind(parsed.data.name, parsed.data.kind)
      .run()
    return c.json({ id: res.meta.last_row_id }, 201)
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) return c.json({ error: 'duplicate_name' }, 409)
    throw e
  }
})

// 費目の並びを入れ直す(§4.11)。ids = すべての費目(やめた費目を含む)を新しい並びで 1 回ずつ。1 つの batch で書く。
// 結果の優先順: 体の形・同じ id の重なり 400 → 今の費目の組と違う 409 order_mismatch(画面の一覧が古い)
master.put('/categories/order', async (c) => {
  const parsed = z
    .object({ ids: z.array(z.number().int()).min(1).max(500) })
    .refine((b) => new Set(b.ids).size === b.ids.length)
    .safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const db = c.env.DB
  const ids = parsed.data.ids
  const { results } = await db.prepare('SELECT id FROM categories').all<{ id: number }>()
  const now = new Set(results.map((r) => r.id))
  if (now.size !== ids.length || ids.some((id) => !now.has(id))) return c.json({ error: 'order_mismatch' }, 409)
  await db.batch(ids.map((id, i) => db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?').bind(i + 1, id)))
  return c.json({ ids })
})

// 名前・並び・種類を変える・やめる/戻す(§1.3)。規則が指す費目はやめられない(トリガー。BEFORE UPDATE なので名前の UNIQUE より先に当たる)
master.patch('/categories/:id{[0-9]+}', async (c) => {
  const parsed = z
    .object({ name: z.string().trim().min(1).max(30).optional(), sortOrder: z.number().int().optional(), kind: kind.optional(), retired: z.boolean().optional() })
    .safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const b = parsed.data
  if (b.kind !== undefined && !(await kindExists(db, b.kind))) return c.json({ error: 'invalid_kind' }, 400)
  const before = await db.prepare('SELECT retired_at FROM categories WHERE id = ?').bind(id).first<{ retired_at: string | null }>()
  if (!before) return c.json({ error: 'not_found' }, 404)
  // やめる = やめた月(日本時間)から予算なし(§1.4 の「この月から予算なし」の行を書く)。前の月は当時の予算のまま。戻しても予算は戻らない
  const retiring = b.retired === true && before.retired_at === null
  try {
    const [res] = await db.batch([
      db
      .prepare(
        `UPDATE categories SET
           name = COALESCE(?, name),
           sort_order = COALESCE(?, sort_order),
           kind = COALESCE(?, kind),
           retired_at = CASE WHEN ? IS NULL THEN retired_at WHEN ? = 1 THEN COALESCE(retired_at, ?) ELSE NULL END
         WHERE id = ?`,
      )
      .bind(b.name ?? null, b.sortOrder ?? null, b.kind ?? null, b.retired === undefined ? null : 1, b.retired ? 1 : 0, nowIso(), id),
      ...(retiring
        ? [
            db
              .prepare(
                `INSERT INTO budgets (category_id, from_month, amount) VALUES (?, ?, NULL)
                 ON CONFLICT (category_id, from_month) DO UPDATE SET amount = NULL`,
              )
              .bind(id, jstDate().slice(0, 7)),
          ]
        : []),
    ])
    if (res!.meta.changes === 0) return c.json({ error: 'not_found' }, 404)
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('UNIQUE constraint failed')) return c.json({ error: 'duplicate_name' }, 409)
    if (msg.includes('system category cannot be retired')) return c.json({ error: 'system_category' }, 409)
    if (msg.includes('category used by recurring expense')) return c.json({ error: 'used_by_recurring' }, 409)
    throw e
  }
  return c.json({ id })
})

// 費目と予算の画面(データと照合 §4.11): やめた費目も返し、その月に効く予算を添える
master.get('/prefs', async (c) => {
  const m = month.safeParse(c.req.query('month'))
  if (!m.success) return c.json({ error: 'invalid_month' }, 400)
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.kind, c.retired_at IS NOT NULL AS retired, sc.role AS systemRole,
            (SELECT b.amount FROM budgets b WHERE b.category_id = c.id AND b.from_month <= ? ORDER BY b.from_month DESC LIMIT 1) AS budget
     FROM categories c LEFT JOIN system_categories sc ON sc.category_id = c.id ORDER BY c.sort_order, c.id`,
  )
    .bind(m.data)
    .all<{ id: number; name: string; kind: string; retired: number; systemRole: string | null; budget: number | null }>()
  return c.json({
    month: m.data,
    categories: results.map((r) => ({ ...r, retired: r.retired === 1 })),
  })
})

// 予算: ある月から効く額を入れる。null は「この月から予算なし」(§1.4)
master.put('/budgets', async (c) => {
  const parsed = z
    .object({ categoryId: z.number().int(), fromMonth: month, amount: z.number().int().min(0).nullable() })
    .safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const b = parsed.data
  // 予算は毎月変わる費目だけ(固定費・臨時は比べない。§4.11・2026-11-17 ユーザー回答)。結果の優先順: 体 → 費目が無い → 種類
  const cat = await c.env.DB.prepare('SELECT kind FROM categories WHERE id = ?').bind(b.categoryId).first<{ kind: string }>()
  if (!cat) return c.json({ error: 'invalid_category' }, 400)
  if (cat.kind !== 'variable') return c.json({ error: 'budget_not_variable' }, 409)
  // 種類は読んだ後に変わりうるが、変わっても予算の行が残るだけ(固定費・臨時の予算はどこでも使わない)
  await c.env.DB.prepare(
    `INSERT INTO budgets (category_id, from_month, amount) VALUES (?, ?, ?)
     ON CONFLICT (category_id, from_month) DO UPDATE SET amount = excluded.amount`,
  )
    .bind(b.categoryId, b.fromMonth, b.amount)
    .run()
  return c.json({ ok: true })
})

/**
 * 費目ごとの額(§4.2・§4.4)。期間は [start, start の months か月後)、range が null なら通算。budgetMonth を渡せばその月に効く予算も付ける。
 * やめた費目は額が 0 でないか、budgetMonth に効く予算があるときだけ返す。種類で合計を分けるのは画面(表 G・表 H)。
 */
export async function categoryAmounts(db: D1Database, range: { start: string; months: 1 | 12 } | null, budgetMonth: string | null) {
  const { results } = await db
    .prepare(
      `WITH spent AS (
         SELECT i.category_id, SUM(i.amount) AS total
         FROM items i JOIN expenses e ON e.id = i.expense_id
         ${range ? `WHERE e.spent_on >= ? AND e.spent_on < date(?, '+${range.months} month')` : ''}
         GROUP BY i.category_id
       )
       SELECT c.id AS categoryId, c.name, c.kind, c.retired_at IS NOT NULL AS retired, COALESCE(spent.total, 0) AS amount
              ${budgetMonth ? ', (SELECT b.amount FROM budgets b WHERE b.category_id = c.id AND b.from_month <= ? ORDER BY b.from_month DESC LIMIT 1) AS budget' : ''}
       FROM categories c LEFT JOIN spent ON spent.category_id = c.id
       ORDER BY c.sort_order, c.id`,
    )
    .bind(...(range ? [range.start, range.start] : []), ...(budgetMonth ? [budgetMonth] : []))
    .all<{ categoryId: number; name: string; kind: string; retired: number; amount: number; budget?: number | null }>()
  // やめた費目は、額が 0 でないか、その月に効く予算があるときだけ返す(やめる前の月の予算の計を変えない。§4.2)
  return results
    .filter((r) => r.retired === 0 || r.amount !== 0 || (r.budget ?? null) !== null)
    .map((r) => ({ categoryId: r.categoryId, name: r.name, kind: r.kind, amount: r.amount, ...(budgetMonth ? { budget: r.budget ?? null } : {}) }))
}

// 月の費目別の合計と予算(円グラフ・予算との比較。§4.2)
master.get('/summary', async (c) => {
  const m = month.safeParse(c.req.query('month'))
  if (!m.success) return c.json({ error: 'invalid_month' }, 400)
  return c.json({ month: m.data, categories: await categoryAmounts(c.env.DB, { start: `${m.data}-01`, months: 1 }, m.data) })
})

// 費目ごとの総計(§4.4): year を渡せばその年、渡さなければ通算
master.get('/summary/totals', async (c) => {
  const year = c.req.query('year')
  if (year !== undefined && !/^\d{4}$/.test(year)) return c.json({ error: 'invalid_year' }, 400)
  const range = year === undefined ? null : ({ start: `${year}-01-01`, months: 12 } as const)
  // firstYear: 記録のいちばん古い年(画面が去年より前の年を選べるように。記録が無ければ null)
  const [categories, first] = await Promise.all([
    categoryAmounts(c.env.DB, range, null),
    c.env.DB.prepare('SELECT MIN(spent_on) AS d FROM expenses').first<{ d: string | null }>(),
  ])
  return c.json({ year: year === undefined ? null : Number(year), firstYear: first?.d ? Number(first.d.slice(0, 4)) : null, categories })
})

// 月ごとの費目別の合計(積み上げ折れ線。月をまたいで累計しない。§4.1)。種類で分けるのは画面(表 G)
master.get('/summary/trend', async (c) => {
  const q = z.object({ from: month, to: month }).safeParse({ from: c.req.query('from'), to: c.req.query('to') })
  if (!q.success || q.data.from > q.data.to) return c.json({ error: 'invalid_range' }, 400)
  const { results } = await c.env.DB.prepare(
    `SELECT substr(e.spent_on, 1, 7) AS month, i.category_id AS categoryId, c.kind, SUM(i.amount) AS amount
     FROM items i JOIN expenses e ON e.id = i.expense_id JOIN categories c ON c.id = i.category_id
     WHERE e.spent_on >= ? AND e.spent_on < date(?, '+1 month')
     GROUP BY month, i.category_id ORDER BY month, i.category_id`,
  )
    .bind(`${q.data.from}-01`, `${q.data.to}-01`)
    .all<{ month: string; categoryId: number; kind: string; amount: number }>()
  // 推移の画面を 1 回で出す(データと照合 §4.1): 最後の月の §4.2(表 G の予算)と費目の名前
  const [lastMonth, names] = await Promise.all([
    categoryAmounts(c.env.DB, { start: `${q.data.to}-01`, months: 1 }, q.data.to),
    c.env.DB.prepare('SELECT id, name, kind FROM categories ORDER BY sort_order, id').all<{ id: number; name: string; kind: string }>(),
  ])
  return c.json({ from: q.data.from, to: q.data.to, points: results, lastMonth, categories: names.results })
})
