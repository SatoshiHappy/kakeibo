// 確かめて保存の画面の口(データと照合 §4.7)
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { claimVersion } from '../worker/routes/expenses'
import { jstDate } from '../worker/time'
import { accessToken, addUser, request, serveTestCerts, versionOf } from './helpers'

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
    expect(f.paymentMethods.map((p) => p.code)).toEqual(['rakuten_card', 'credit', 'unknown', 'other_card', 'cash', 'bank_transfer', 'emoney', 'point', 'other'])
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

describe('保存の送り直し(§4.7)', () => {
  it('同じ clientRequestId の 2 回目は前の支出の id と reused を 200 で返し、支出を増やさない', async () => {
    const body = {
      clientRequestId: 'resend-1',
      receiptId: null,
      spentOn: '2026-11-03',
      storeName: 's',
      paymentMethod: 'cash',
      items: [{ name: 'x', categoryId: 1, taxRate: null, baseAmount: 100, stockItemId: null, stockQuantity: null }],
      adjustments: [],
    }
    const send = (b: unknown) => request('/api/expenses', { method: 'POST', headers: headers(), body: JSON.stringify(b) })
    const first = await send(body)
    expect(first.status).toBe(201)
    const { id } = await first.json<{ id: number }>()
    const again = await send({ ...body, items: [{ ...body.items[0], baseAmount: 90 }] })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ id, reused: true, updatedAt: await versionOf(id) })
    const { n } = (await db.prepare("SELECT count(*) AS n FROM expenses WHERE client_request_id = 'resend-1'").first<{ n: number }>())!
    expect(n).toBe(1)
  })
})

describe('保存の口の検査(§1.6)', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    clientRequestId: `chk-${++seq}`,
    receiptId: null,
    spentOn: '2026-11-03',
    storeName: 's',
    paymentMethod: 'cash',
    items: [{ name: 'x', categoryId: 1, taxRate: null, baseAmount: 100, stockItemId: null, stockQuantity: null }],
    adjustments: [],
    ...over,
  })
  const post = (b: unknown) => request('/api/expenses', { method: 'POST', headers: headers(), body: JSON.stringify(b) })
  // 版は今のもの(テストで上書きできる)
  const put = async (id: number, b: object) => request(`/api/expenses/${id}`, { method: 'PUT', headers: headers(), body: JSON.stringify({ baseUpdatedAt: await versionOf(id), ...b }) })
  const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

  it('日付: 今日(日本時間)までは保存でき、明日は future_date で断る(作る・直すとも)', async () => {
    const today = jstDate()
    expect((await post(base({ spentOn: addDay(today, -1) }))).status).toBe(201)
    const res = await post(base({ spentOn: today }))
    expect(res.status).toBe(201)
    const { id } = await res.json<{ id: number }>()
    const tomorrow = await post(base({ spentOn: addDay(today, 1) }))
    expect(tomorrow.status).toBe(400)
    expect(await tomorrow.json()).toEqual({ error: 'future_date' })
    const { clientRequestId: _c, receiptId: _r, ...body } = base()
    expect(await (await put(id, { ...body, spentOn: addDay(today, 1) })).json()).toEqual({ error: 'future_date' })
  })
  it('同時の直し: 開いた時の版(baseUpdatedAt)が今と違えば 409 changed で何も書かない。版が無ければ 400。送り直しの応答は版を返す', async () => {
    const first = base({ spentOn: '2026-10-01', storeName: '前' })
    const { id } = await (await post(first)).json<{ id: number }>()
    const opened = await versionOf(id) // 2 人が同じ版で開いた
    const { clientRequestId: _c, receiptId: _r, ...body } = base({ spentOn: '2026-10-01' })
    expect((await put(id, { ...body, storeName: 'さとの直し', baseUpdatedAt: opened })).status).toBe(200)
    const late = await put(id, { ...body, storeName: 'みさの直し', baseUpdatedAt: opened })
    expect(late.status).toBe(409)
    expect(await late.json()).toEqual({ error: 'changed' })
    expect((await env.DB.prepare('SELECT store_name FROM expenses WHERE id = ?').bind(id).first<{ store_name: string }>())!.store_name).toBe('さとの直し')
    const { baseUpdatedAt: _b, ...noVersion } = { ...body, baseUpdatedAt: '' }
    expect((await request(`/api/expenses/${id}`, { method: 'PUT', headers: headers(), body: JSON.stringify(noVersion) })).status).toBe(400)
    // 送り直し(同じ clientRequestId)は reused と今の版を返す
    const again = await post(first)
    expect(await again.json()).toEqual({ id, reused: true, updatedAt: await versionOf(id) })
  })
  it('同時の直し: 口の確かめの後・書く前に版が進んでいたら、batch ごと断って品目も消さない(claimVersion)', async () => {
    const { id } = await (await post(base({ spentOn: '2026-10-02' }))).json<{ id: number }>()
    const opened = await versionOf(id)
    await env.DB.prepare("UPDATE expenses SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?").bind(id).run() // ほかの直しが入った
    const db = env.DB
    const write = db.batch([...claimVersion(db, id, { spentOn: '2026-10-02', storeName: '遅れた直し', paymentMethod: 'cash', baseUpdatedAt: opened }, '2026-11-17T00:00:00Z'), db.prepare('DELETE FROM items WHERE expense_id = ?').bind(id)])
    await expect(write).rejects.toThrow('NOT NULL constraint failed: expenses.updated_at')
    expect(await db.prepare('SELECT count(*) AS n FROM items WHERE expense_id = ?').bind(id).first<{ n: number }>()).toEqual({ n: 1 })
    expect((await db.prepare('SELECT store_name FROM expenses WHERE id = ?').bind(id).first<{ store_name: string }>())!.store_name).not.toBe('遅れた直し')
    // 読んだ版のままなら通る
    await db.batch([...claimVersion(db, id, { spentOn: '2026-10-02', storeName: '間に合った直し', paymentMethod: 'cash', baseUpdatedAt: '2000-01-01T00:00:00Z' }, '2026-11-17T00:00:00Z')])
    expect(await versionOf(id)).toBe('2026-11-17T00:00:00Z')
  })
  it('日付: 本当にない日(2026-02-29・2026-11-31)は 400 invalid_body。うるう日は通る', async () => {
    expect((await post(base({ spentOn: '2026-02-29' }))).status).toBe(400)
    for (const spentOn of ['2026-11-31', '2026-11-00', '2026-13-01', '2026-12-32']) expect((await post(base({ spentOn }))).status).toBe(400)
    expect((await post(base({ spentOn: '2024-02-29' }))).status).toBe(201)
  })
  it('在庫の品物は額が正の品目だけ(返品・0 円には付けられない)', async () => {
    const stock = (
      await db.prepare('INSERT INTO stock_items (name, notify_days, created_by, created_at) VALUES (?, 7, ?, ?)').bind('洗剤', userId, AT).run()
    ).meta.last_row_id
    const item = (baseAmount: number) => [{ name: 'x', categoryId: 1, taxRate: null, baseAmount, stockItemId: stock, stockQuantity: 1 }]
    expect((await post(base({ items: item(-300) }))).status).toBe(400)
    expect((await post(base({ items: item(0) }))).status).toBe(400)
    expect((await post(base({ items: item(1) }))).status).toBe(201)
  })
  it('直す(PUT)は品目の在庫の欄を省けない(省くと黙って在庫の結び付きが外れるため)。作る(POST)は省ける', async () => {
    const { clientRequestId: _c, receiptId: _r, ...body } = base()
    const created = await post({ ...base(), items: [{ name: 'x', categoryId: 1, taxRate: null, baseAmount: 100 }] })
    expect(created.status).toBe(201)
    const { id } = await created.json<{ id: number }>()
    expect((await put(id, { ...body, items: [{ name: 'x', categoryId: 1, taxRate: null, baseAmount: 100 }] })).status).toBe(400)
    expect((await put(id, body)).status).toBe(200)
  })
  it('品目の費目だけ直す(PATCH): やめた費目は、同じ支出のほかの品目に付いていれば使える', async () => {
    const created = await post(
      base({
        items: [
          { name: 'a', categoryId: 1, taxRate: null, baseAmount: 100, stockItemId: null, stockQuantity: null },
          { name: 'b', categoryId: 3, taxRate: null, baseAmount: 100, stockItemId: null, stockQuantity: null },
        ],
      }),
    )
    const { id } = await created.json<{ id: number }>()
    await db.prepare('UPDATE categories SET retired_at = ? WHERE id = 3').bind(AT).run()
    const patch = (position: number, categoryId: number) =>
      request(`/api/expenses/${id}/items/${position}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ categoryId }) })
    expect((await patch(1, 3)).status).toBe(200)
    expect((await patch(2, 4)).status).toBe(200)
    await db.prepare('UPDATE categories SET retired_at = ? WHERE id = 4').bind(AT).run()
    // 4 はもうこの支出の品目 2 に付いているので使える。やめた 5 は付いていないので使えない
    expect((await patch(1, 4)).status).toBe(200)
    await db.prepare('UPDATE categories SET retired_at = ? WHERE id = 5').bind(AT).run()
    expect((await patch(1, 5)).status).toBe(400)
  })
})
