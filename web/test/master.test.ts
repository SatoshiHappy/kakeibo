// 費目・予算・集計の口
import { jstDate } from '../worker/time'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { accessToken, addUser, request, serveTestCerts } from './helpers'

let token: string
let seq = 0
const db = env.DB
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const get = (path: string) => request(path, { headers: { 'cf-access-jwt-assertion': token } })

beforeEach(async () => {
  serveTestCerts()
  await addUser('alice@example.com')
  token = await accessToken()
  await db.batch([db.prepare('DELETE FROM expenses'), db.prepare('DELETE FROM budgets')])
})

async function expense(spentOn: string, items: [number, number][]) {
  const res = await request(
    '/api/expenses',
    json('POST', {
      clientRequestId: `m-${++seq}`,
      receiptId: null,
      spentOn,
      storeName: 's',
      paymentMethod: 'cash',
      items: items.map(([categoryId, baseAmount]) => ({ name: 'x', categoryId, taxRate: null, baseAmount })),
      adjustments: [],
    }),
  )
  expect(res.status).toBe(201)
}

describe('費目', () => {
  it('足す・名前と種類を変える・やめる', async () => {
    const res = await request('/api/categories', json('POST', { name: 'ペット', kind: 'variable' }))
    expect(res.status).toBe(201)
    const { id } = await res.json<{ id: number }>()
    expect((await request(`/api/categories/${id}`, json('PATCH', { name: 'ペット用品', kind: 'extra', retired: true }))).status).toBe(200)
    const { categories } = await (await get('/api/categories')).json<{ categories: { id: number; name: string; kind: string; retired: boolean }[] }>()
    expect(categories.find((c) => c.id === id)).toMatchObject({ name: 'ペット用品', kind: 'extra', retired: true })
  })
  it('種類が無い・知らない種類は 400', async () => {
    expect((await request('/api/categories', json('POST', { name: '犬' }))).status).toBe(400)
    expect(await (await request('/api/categories', json('POST', { name: '犬', kind: 'monthly' }))).json()).toEqual({ error: 'invalid_kind' })
    expect(await (await request('/api/categories/1', json('PATCH', { kind: 'monthly' }))).json()).toEqual({ error: 'invalid_kind' })
    const { categories } = await (await get('/api/categories')).json<{ categories: { id: number; kind: string }[] }>()
    expect(categories.find((c) => c.id === 1)!.kind).toBe('variable')
  })
  it('同じ名前は 409', async () => {
    expect((await request('/api/categories', json('POST', { name: '食費', kind: 'variable' }))).status).toBe(409)
  })
  it('未分類はやめられない(409)', async () => {
    expect((await request('/api/categories/19', json('PATCH', { retired: true }))).status).toBe(409)
  })
  it('結果の優先順: 体 400 → 種類 400 → 費目が無い 404 → 未分類をやめる 409 → 名前が重なる 409(§1.3)', async () => {
    const err = async (path: string, method: string, body: unknown) => {
      const res = await request(path, json(method, body))
      return [res.status, (await res.json<{ error: string }>()).error]
    }
    expect(await err('/api/categories/999', 'PATCH', { sortOrder: 'a', kind: 'monthly' })).toEqual([400, 'invalid_body'])
    expect(await err('/api/categories', 'POST', { name: '食費', kind: 'monthly' })).toEqual([400, 'invalid_kind'])
    expect(await err('/api/categories/999', 'PATCH', { kind: 'monthly' })).toEqual([400, 'invalid_kind'])
    expect(await err('/api/categories/999', 'PATCH', { name: '食費' })).toEqual([404, 'not_found'])
    expect(await err('/api/categories/19', 'PATCH', { name: '食費', retired: true })).toEqual([409, 'system_category'])
    expect(await err('/api/categories/2', 'PATCH', { name: '食費' })).toEqual([409, 'duplicate_name'])
  })
  it('並びを入れ直す: すべての費目を 1 回ずつ渡すと、その順で返る。足りない・知らない id は 409、重なりは 400', async () => {
    const list = async () => (await (await get('/api/categories')).json<{ categories: { id: number }[] }>()).categories.map((c) => c.id)
    const before = await list()
    const reversed = [...before].reverse()
    expect((await request('/api/categories/order', json('PUT', { ids: reversed }))).status).toBe(200)
    expect(await list()).toEqual(reversed)
    const err = async (body: unknown) => {
      const res = await request('/api/categories/order', json('PUT', body))
      return [res.status, (await res.json<{ error: string }>()).error]
    }
    expect(await err({ ids: [...before, before[0]] })).toEqual([400, 'invalid_body'])
    expect(await err({ ids: 'x' })).toEqual([400, 'invalid_body'])
    expect(await err({ ids: before.slice(1) })).toEqual([409, 'order_mismatch'])
    expect(await err({ ids: [...before.slice(1), 9999] })).toEqual([409, 'order_mismatch'])
    expect(await list()).toEqual(reversed)
    expect((await request('/api/categories/order', json('PUT', { ids: before }))).status).toBe(200)
    expect(await list()).toEqual(before)
  })
  it('やめた費目は新しい支出に使えない', async () => {
    await request('/api/categories/12', json('PATCH', { retired: true }))
    try {
      const res = await request(
        '/api/expenses',
        json('POST', {
          clientRequestId: `m-${++seq}`,
          receiptId: null,
          spentOn: '2026-10-01',
          storeName: 's',
          paymentMethod: 'cash',
          items: [{ name: 'x', categoryId: 12, taxRate: null, baseAmount: 100 }],
          adjustments: [],
        }),
      )
      expect(res.status).toBe(400)
    } finally {
      await request('/api/categories/12', json('PATCH', { retired: false })) // 落ちても後のテストにやめた費目を残さない
    }
  })
})

describe('集計と予算', () => {
  it('月の費目別の合計と、その月に効く予算', async () => {
    await expense('2026-09-30', [[1, 500]])
    await expense('2026-10-01', [[1, 1000], [3, 300]])
    await expense('2026-10-31', [[1, 200]])
    await expense('2026-11-01', [[1, 700]])
    await request('/api/budgets', json('PUT', { categoryId: 1, fromMonth: '2026-08', amount: 30000 }))
    await request('/api/budgets', json('PUT', { categoryId: 1, fromMonth: '2026-11', amount: 40000 }))
    await request('/api/budgets', json('PUT', { categoryId: 3, fromMonth: '2026-10', amount: null }))
    const oct = await (await get('/api/summary?month=2026-10')).json<{ categories: { categoryId: number; kind: string; amount: number; budget: number | null }[] }>()
    expect(oct).not.toHaveProperty('total') // 合計を種類で分けるのは画面(表 G・表 H)
    expect(oct.categories.find((c) => c.categoryId === 1)).toMatchObject({ kind: 'variable', amount: 1200, budget: 30000 })
    expect(oct.categories.find((c) => c.categoryId === 4)).toMatchObject({ kind: 'fixed', amount: 0 })
    expect(oct.categories.find((c) => c.categoryId === 3)).toMatchObject({ amount: 300, budget: null })
    const nov = await (await get('/api/summary?month=2026-11')).json<{ categories: { categoryId: number; budget: number | null }[] }>()
    expect(nov.categories.find((c) => c.categoryId === 1)!.budget).toBe(40000)
  })
  it('月ごとの推移は月をまたいで累計しない', async () => {
    await expense('2026-09-10', [[1, 500]])
    await expense('2026-10-10', [[1, 200]])
    const { points } = await (await get('/api/summary/trend?from=2026-09&to=2026-10')).json<{ points: { month: string; categoryId: number; amount: number }[] }>()
    expect(points).toEqual([
      { month: '2026-09', categoryId: 1, kind: 'variable', amount: 500 },
      { month: '2026-10', categoryId: 1, kind: 'variable', amount: 200 },
    ])
  })
  it('推移の応答に、最後の月の費目ごとの額と予算(表 G を分ける)と費目の名前を添える', async () => {
    await expense('2026-10-10', [[1, 200]])
    await request('/api/budgets', json('PUT', { categoryId: 1, fromMonth: '2026-10', amount: 30000 }))
    const body = await (await get('/api/summary/trend?from=2026-09&to=2026-10')).json<{
      lastMonth: { categoryId: number; amount: number; budget: number | null }[]
      categories: { id: number; name: string; kind: string }[]
    }>()
    expect(body.lastMonth.find((c) => c.categoryId === 1)).toMatchObject({ amount: 200, budget: 30000 })
    expect(body.categories.find((c) => c.id === 14)).toEqual({ id: 14, name: '旅行', kind: 'extra' })
  })
  it('12 月の集計と推移は翌年の 1/1 を含まない(境の前後)', async () => {
    await expense('2024-11-30', [[14, 1]])
    await expense('2024-12-01', [[14, 10]])
    await expense('2024-12-31', [[14, 100]])
    await expense('2025-01-01', [[14, 1000]])
    const dec = await (await get('/api/summary?month=2024-12')).json<{ categories: { categoryId: number; kind: string; amount: number }[] }>()
    expect(dec.categories.find((c) => c.categoryId === 14)).toMatchObject({ kind: 'extra', amount: 110 })
    const { points } = await (await get('/api/summary/trend?from=2024-12&to=2024-12')).json<{ points: { amount: number }[] }>()
    expect(points.map((p) => p.amount)).toEqual([110])
  })
  it('読めない月は 400', async () => {
    expect((await get('/api/summary?month=2024-13')).status).toBe(400)
  })
  it('費目ごとの総計: 年はその年の 1/1〜12/31(境の前後)、渡さなければ通算', async () => {
    await expense('2023-12-31', [[14, 100]])
    await expense('2024-01-01', [[14, 1000], [1, 50]])
    await expense('2024-12-31', [[14, 2000]])
    await expense('2025-01-01', [[14, 4000]])
    type T = { year: number | null; categories: { categoryId: number; kind: string; amount: number }[] }
    const y = await (await get('/api/summary/totals?year=2024')).json<T>()
    expect(y.year).toBe(2024)
    expect(y.categories.find((c) => c.categoryId === 14)).toMatchObject({ kind: 'extra', amount: 3000 })
    expect(y.categories.find((c) => c.categoryId === 1)).toMatchObject({ amount: 50 })
    const all = await (await get('/api/summary/totals')).json<T>()
    expect(all.year).toBeNull()
    expect(all.categories.find((c) => c.categoryId === 14)!.amount).toBe(7100)
    // 記録のいちばん古い年(画面が去年より前の年を選ぶため)
    const min = (await env.DB.prepare('SELECT MIN(spent_on) AS d FROM expenses').first<{ d: string }>())!.d
    expect((await (await get('/api/summary/totals?year=2024')).json<{ firstYear: number }>()).firstYear).toBe(Number(min.slice(0, 4)))
    expect(Number(min.slice(0, 4))).toBeLessThanOrEqual(2023)
    expect((await get('/api/summary/totals?year=26')).status).toBe(400)
  })
  it('やめた費目は額が 0 でないときだけ出る(総計・月の集計)', async () => {
    await expense('2026-03-01', [[12, 300]])
    await request('/api/categories/12', json('PATCH', { retired: true }))
    await request('/api/categories/11', json('PATCH', { retired: true }))
    try {
      type T = { categories: { categoryId: number }[] }
      const ids = async (path: string) => (await (await get(path)).json<T>()).categories.map((c) => c.categoryId)
      for (const path of ['/api/summary/totals?year=2026', '/api/summary?month=2026-03']) {
        expect(await ids(path)).toContain(12)
        expect(await ids(path)).not.toContain(11)
      }
      expect(await ids('/api/summary?month=2026-04')).not.toContain(12) // その月の額が 0 なら出ない(§4.2)
    } finally {
      await request('/api/categories/12', json('PATCH', { retired: false }))
      await request('/api/categories/11', json('PATCH', { retired: false }))
    }
  })
})

describe('費目と予算の画面の口(データと照合 §4.11)', () => {
  type Prefs = { month: string; categories: { id: number; name: string; kind: string; retired: boolean; systemRole: string | null; budget: number | null }[] }
  it('やめた費目も返し、その月に効く予算を添える(やめると、やめた月から予算なし。前の月は当時の予算のまま)', async () => {
    const thisMonth = jstDate().slice(0, 7)
    const prev = new Date(Date.parse(`${thisMonth}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 7)
    await request('/api/budgets', json('PUT', { categoryId: 1, fromMonth: '2026-08', amount: 30000 }))
    await request('/api/budgets', json('PUT', { categoryId: 1, fromMonth: '2099-12', amount: 40000 }))
    await request('/api/budgets', json('PUT', { categoryId: 12, fromMonth: '2026-08', amount: 5000 }))
    expect((await request('/api/categories/12', json('PATCH', { retired: true }))).status).toBe(200)
    try {
      const p = await (await get(`/api/prefs?month=${thisMonth}`)).json<Prefs>()
      expect(p.month).toBe(thisMonth)
      expect(p.categories.find((c) => c.id === 1)).toMatchObject({ name: '食費', kind: 'variable', retired: false, budget: 30000 })
      expect(p.categories.find((c) => c.id === 12)).toMatchObject({ retired: true, budget: null })
      expect(p.categories.find((c) => c.systemRole === 'uncategorized')).toMatchObject({ name: '未分類', budget: null })
      // 前の月: やめた費目の予算は当時のまま。その月に使っていなくても、月の集計に予算つきで残る(予算の計が後から変わらない)
      expect((await (await get(`/api/prefs?month=${prev}`)).json<Prefs>()).categories.find((c) => c.id === 12)).toMatchObject({ budget: 5000 })
      type S = { categories: { categoryId: number; amount: number; budget: number | null }[] }
      const past = await (await get(`/api/summary?month=${prev}`)).json<S>()
      expect(past.categories.find((c) => c.categoryId === 12)).toMatchObject({ amount: 0, budget: 5000 })
      const now = await (await get(`/api/summary?month=${thisMonth}`)).json<S>()
      expect(now.categories.find((c) => c.categoryId === 12)).toBeUndefined()
      // 戻しても予算は戻らない(入れ直す)
      await request('/api/categories/12', json('PATCH', { retired: false }))
      expect((await (await get(`/api/prefs?month=${thisMonth}`)).json<Prefs>()).categories.find((c) => c.id === 12)).toMatchObject({ budget: null })
      expect((await get('/api/prefs?month=2026-13')).status).toBe(400)
    } finally {
      await db.prepare('UPDATE categories SET retired_at = NULL WHERE id = 12').run()
    }
  })
})
