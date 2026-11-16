// ホームの口(1 つの画面は API 1 回。基盤 §2.3)。正本: docs/設計/データと照合.md §4.5
import { Hono } from 'hono'
import { soonOrder } from '../domain/stock'
import { month } from '../schemas'
import type { AppEnv } from '../types'
import { categoryAmounts } from './master'
import { reviewItems } from './review'
import { stockOverview } from './stock'

export const home = new Hono<AppEnv>()

home.get('/', async (c) => {
  const m = month.safeParse(c.req.query('month'))
  if (!m.success) return c.json({ error: 'invalid_month' }, 400)
  const db = c.env.DB
  const [categories, drafts, review, stock] = await Promise.all([
    categoryAmounts(db, { start: `${m.data}-01`, months: 1 }, m.data),
    // 下書き = どの支出からも指されないレシート(§1.0)
    db.prepare('SELECT count(*) AS n FROM receipts r WHERE NOT EXISTS (SELECT 1 FROM expenses e WHERE e.receipt_id = r.id)').first<{ n: number }>(),
    reviewItems(db, Number(c.env.MATCH_WINDOW_DAYS)),
    stockOverview(db, new Date()),
  ])
  const soon = stock.filter((s) => s.status?.state === 'soon').sort((a, b) => soonOrder({ id: a.id, status: a.status! }, { id: b.id, status: b.status! }))
  return c.json({
    month: m.data,
    categories,
    draftCount: drafts!.n,
    reviewCount: review.length,
    stockSoon: soon.map((s) => ({ id: s.id, name: s.name, quantity: s.quantity, forecast: s.status!.forecast })),
  })
})
