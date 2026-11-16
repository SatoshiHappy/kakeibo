// ホームの口(設計書 §4.5)
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { accessToken, addUser, request, serveTestCerts } from './helpers'

let token: string
let userId: number
let seq = 0
const db = env.DB
const AT = '2026-11-01T00:00:00Z'
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const get = async (path: string) => request(path, { headers: { 'cf-access-jwt-assertion': token } })

type Home = {
  month: string
  categories: { categoryId: number; kind: string; amount: number; budget: number | null }[]
  draftCount: number
  reviewCount: number
  stockSoon: { id: number; name: string; quantity: number; forecast: { daysLeft: number } | null }[]
}
const home = async (month: string) => (await (await get(`/api/home?month=${month}`)).json<Home>())

beforeEach(async () => {
  serveTestCerts()
  await addUser('alice@example.com')
  token = await accessToken()
  userId = (await db.prepare("SELECT id FROM users WHERE email = 'alice@example.com'").first<{ id: number }>())!.id
  await db.batch([
    db.prepare('DELETE FROM expenses'),
    db.prepare('DELETE FROM card_charges'),
    db.prepare('DELETE FROM statement_imports'),
    db.prepare('DELETE FROM receipt_images'),
    db.prepare('DELETE FROM receipts'),
    db.prepare('DELETE FROM stock_moves'),
    db.prepare('DELETE FROM stock_items'),
    db.prepare('DELETE FROM budgets'),
  ])
})

async function expense(spentOn: string, categoryId: number, amount: number, paymentMethod = 'cash') {
  const res = await request(
    '/api/expenses',
    json('POST', {
      clientRequestId: `h-${++seq}`,
      receiptId: null,
      spentOn,
      storeName: 's',
      paymentMethod,
      items: [{ name: 'x', categoryId, taxRate: null, baseAmount: amount }],
      adjustments: [],
    }),
  )
  expect(res.status).toBe(201)
}

describe('ホームの口', () => {
  it('月が読めなければ 400', async () => {
    expect((await get('/api/home?month=2026-13')).status).toBe(400)
  })
  it('費目ごとの額と予算は §4.2 と同じ', async () => {
    await expense('2026-11-03', 1, 1200)
    await request('/api/budgets', json('PUT', { categoryId: 1, fromMonth: '2026-11', amount: 50000 }))
    const h = await home('2026-11')
    expect(h.categories.find((c) => c.categoryId === 1)).toMatchObject({ kind: 'variable', amount: 1200, budget: 50000 })
    const summary = await (await get('/api/summary?month=2026-11')).json<{ categories: unknown[] }>()
    expect(h.categories).toEqual(summary.categories)
  })
  it('下書きの数 = どの支出からも指されないレシート', async () => {
    for (const k of ['a', 'b']) {
      await db
        .prepare("INSERT INTO receipts (client_request_id, uploaded_by, uploaded_at, ai_status, ai_attempt, ai_requested_at) VALUES (?, ?, ?, 'waiting', 1, ?)")
        .bind(`r-${k}-${++seq}`, userId, AT, AT)
        .run()
    }
    expect((await home('2026-11')).draftCount).toBe(2)
  })
  it('確かめることの数は確かめる一覧の項目の数と同じ', async () => {
    await expense('2026-10-10', 1, 500, 'rakuten_card')
    const imp = await db
      .prepare("INSERT INTO statement_imports (client_request_id, billing_month, imported_by, imported_at, rows_in_file, rows_new, rows_changed, rows_missing) VALUES (?, '2026-11', ?, ?, 1, 1, 0, 0)")
      .bind(`i-${++seq}`, userId, AT)
      .run()
    await db
      .prepare("INSERT INTO card_charges (import_id, billing_month, used_on, merchant, card_user, payment_type, amount_cell, amount, fee, ordinal) VALUES (?, '2026-11', '2026-10-12', 'shop', '本人', '1回払い', '500', 500, 0, 1)")
      .bind(imp.meta.last_row_id)
      .run()
    const review = await (await get('/api/review')).json<{ items: unknown[] }>()
    expect(review.items).toHaveLength(1)
    expect((await home('2026-11')).reviewCount).toBe(1)
  })
  it('そろそろ買うの品物だけを、予測なし(残り 0)を先に、あと何日の少ない順で返す', async () => {
    const reg = async (name: string, count: number) =>
      (await (await request('/api/stock', json('POST', { name, count }))).json<{ id: number }>()).id
    const empty = await reg('紙', 0) // S1
    const plenty = await reg('洗剤', 5) // S2(まだある)
    const paced = await reg('ラップ', 0)
    // ラップ: 2 日前と 12 日前に使った → ペース 10 日・なくなる日は 2 日前 + 10 日 → あと 8 日(既定の 7 日より後)
    // 知らせる日数を 30 にして、そろそろ買うに入れる
    await request(`/api/stock/${paced}`, json('PATCH', { notifyDays: 30 }))
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    await db.batch(
      [12, 2].map((n) => db.prepare("INSERT INTO stock_moves (stock_item_id, kind, delta, moved_by, moved_at) VALUES (?, 'use', -1, ?, ?)").bind(paced, userId, day(n))),
    )
    const soon = (await home('2026-11')).stockSoon
    expect(soon.map((s) => s.id)).toEqual([empty, paced])
    expect(soon[0]).toMatchObject({ name: '紙', quantity: 0, forecast: null })
    expect(soon[1]!.forecast).toMatchObject({ paceDays: 10 })
    expect(soon.map((s) => s.id)).not.toContain(plenty)
  })
})
