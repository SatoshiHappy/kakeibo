// 確かめて保存の画面の口(データと照合 §4.7)
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { accessToken, addUser, request, serveTestCerts } from './helpers'

let token: string
let userId: number
let seq = 0
const db = env.DB
const AT = '2026-11-01T00:00:00Z'
const headers = () => ({ 'cf-access-jwt-assertion': token, 'content-type': 'application/json' })
const get = (path: string) => request(path, { headers: { 'cf-access-jwt-assertion': token } })

type Form = {
  categories: { id: number; name: string; retired: boolean; systemRole: string | null }[]
  paymentMethods: { code: string; label: string; cardCompatible: boolean }[]
  stockItems: { id: number; name: string; retired: boolean }[]
  receipt: { id: number; expenseId: number | null } | null
  expense: { id: number; receiptId: number | null; items: { categoryId: number; stockItemId: number | null }[] } | null
}

beforeEach(async () => {
  serveTestCerts()
  await addUser('alice@example.com')
  token = await accessToken()
  userId = (await db.prepare("SELECT id FROM users WHERE email = 'alice@example.com'").first<{ id: number }>())!.id
  await db.batch([
    db.prepare('DELETE FROM expenses'),
    db.prepare('DELETE FROM receipt_images'),
    db.prepare('DELETE FROM receipts'),
    db.prepare('DELETE FROM stock_moves'),
    db.prepare('DELETE FROM stock_items'),
    db.prepare("UPDATE categories SET retired_at = NULL"),
  ])
})

async function receipt() {
  const r = await db
    .prepare("INSERT INTO receipts (client_request_id, uploaded_by, uploaded_at, ai_status, ai_attempt, ai_requested_at) VALUES (?, ?, ?, 'waiting', 1, ?)")
    .bind(`f-${++seq}`, userId, AT, AT)
    .run()
  return r.meta.last_row_id
}

async function expense(receiptId: number | null, categoryId: number, stockItemId: number | null = null) {
  const res = await request('/api/expenses', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      clientRequestId: `fe-${++seq}`,
      receiptId,
      spentOn: '2026-11-03',
      storeName: 's',
      paymentMethod: 'cash',
      items: [{ name: 'x', categoryId, taxRate: null, baseAmount: 100, stockItemId, stockQuantity: stockItemId === null ? null : 1 }],
      adjustments: [],
    }),
  })
  expect(res.status).toBe(201)
  return (await res.json<{ id: number }>()).id
}

describe('確かめて保存の画面の口', () => {
  it('引数は receipt と expense のどちらか 1 つまで。数でなければ 400', async () => {
    expect((await get('/api/expense-form?receipt=1&expense=1')).status).toBe(400)
    expect((await get('/api/expense-form?receipt=x')).status).toBe(400)
  })
  it('表 V の V8: 下書き・支出が無ければ 404', async () => {
    expect((await get('/api/expense-form?receipt=999999')).status).toBe(404)
    expect((await get('/api/expense-form?expense=999999')).status).toBe(404)
  })
  it('手入力: レシートも支出も null。費目・在庫の品物はやめていないものだけ。支払い方法は全部', async () => {
    await db.prepare("UPDATE categories SET retired_at = ? WHERE id = 2").bind(AT).run()
    const f = await (await get('/api/expense-form')).json<Form>()
    expect(f.receipt).toBeNull()
    expect(f.expense).toBeNull()
    expect(f.categories.map((c) => c.id)).not.toContain(2)
    expect(f.categories.find((c) => c.systemRole === 'uncategorized')).toMatchObject({ name: '未分類' })
    expect(f.paymentMethods.map((p) => p.code)).toEqual(['rakuten_card', 'credit', 'unknown', 'other_card', 'cash', 'emoney', 'point', 'other'])
  })
  it('下書き: レシートを返す(もう保存したなら expenseId が入る = V4 の手がかり)', async () => {
    const r = await receipt()
    expect((await (await get(`/api/expense-form?receipt=${r}`)).json<Form>()).receipt).toMatchObject({ id: r, expenseId: null })
    const e = await expense(r, 1)
    expect((await (await get(`/api/expense-form?receipt=${r}`)).json<Form>()).receipt).toMatchObject({ id: r, expenseId: e })
  })
  it('支出を直す: 支出とそのレシートを返し、今付いているやめた費目・品物も選べる', async () => {
    const r = await receipt()
    const s = await request('/api/stock', { method: 'POST', headers: headers(), body: JSON.stringify({ name: '紙', count: 0 }) })
    const stockId = (await s.json<{ id: number }>()).id
    const e = await expense(r, 2, stockId)
    await db.prepare("UPDATE categories SET retired_at = ? WHERE id IN (2, 3)").bind(AT).run()
    await db.prepare('UPDATE stock_items SET retired_at = ? WHERE id = ?').bind(AT, stockId).run()
    const f = await (await get(`/api/expense-form?expense=${e}`)).json<Form>()
    expect(f.expense).toMatchObject({ id: e, receiptId: r })
    expect(f.receipt).toMatchObject({ id: r, expenseId: e })
    expect(f.categories.find((c) => c.id === 2)).toMatchObject({ retired: true })
    expect(f.categories.map((c) => c.id)).not.toContain(3)
    expect(f.stockItems).toEqual([{ id: stockId, name: '紙', retired: true }])
  })
})
