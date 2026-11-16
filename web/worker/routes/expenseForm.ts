// 確かめて保存の画面の口(1 つの画面は API 1 回。基盤 §2.3)。正本: docs/設計/データと照合.md §4.7・表 V
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../types'
import { expenseDetail } from './expenses'
import { receiptDetail } from './receipts'

const id = z.coerce.number().int().positive()
const query = z.union([
  z.object({ receipt: id, expense: z.undefined() }),
  z.object({ receipt: z.undefined(), expense: id }),
  z.object({ receipt: z.undefined(), expense: z.undefined() }),
])

export const expenseForm = new Hono<AppEnv>()

expenseForm.get('/', async (c) => {
  const q = query.safeParse({ receipt: c.req.query('receipt'), expense: c.req.query('expense') })
  if (!q.success) return c.json({ error: 'invalid_query' }, 400)
  const db = c.env.DB

  const expense = q.data.expense === undefined ? null : await expenseDetail(db, q.data.expense)
  if (q.data.expense !== undefined && !expense) return c.json({ error: 'not_found' }, 404)
  const receiptId = q.data.receipt ?? expense?.receiptId ?? null
  const receipt = receiptId === null ? null : await receiptDetail(db, receiptId)
  if (q.data.receipt !== undefined && !receipt) return c.json({ error: 'not_found' }, 404)

  // やめた費目・品物は、直す支出に今付いているものだけ選べる(§1.6)
  const usedCategories = new Set(expense?.items.map((i) => i.categoryId as number) ?? [])
  const usedStock = new Set(expense?.items.map((i) => i.stockItemId as number | null).filter((v) => v !== null) ?? [])
  const [categories, methods, stockItems] = await db.batch<Record<string, unknown>>([
    db.prepare(
      `SELECT c.id, c.name, c.kind, c.retired_at IS NOT NULL AS retired, sc.role AS systemRole
       FROM categories c LEFT JOIN system_categories sc ON sc.category_id = c.id ORDER BY c.sort_order, c.id`,
    ),
    db.prepare('SELECT code, label, card_compatible FROM payment_methods ORDER BY sort_order'),
    db.prepare('SELECT id, name, retired_at IS NOT NULL AS retired FROM stock_items ORDER BY name, id'),
  ])
  return c.json({
    categories: categories!.results
      .filter((r) => r.retired === 0 || usedCategories.has(r.id as number))
      .map((r) => ({ id: r.id, name: r.name, kind: r.kind, retired: r.retired === 1, systemRole: r.systemRole })),
    paymentMethods: methods!.results.map((r) => ({ code: r.code, label: r.label, cardCompatible: r.card_compatible === 1 })),
    stockItems: stockItems!.results
      .filter((r) => r.retired === 0 || usedStock.has(r.id as number))
      .map((r) => ({ id: r.id, name: r.name, retired: r.retired === 1 })),
    receipt,
    expense,
  })
})
