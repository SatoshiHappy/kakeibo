// 一覧の画面の口(データと照合 §4.8)
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { accessToken, addUser, request, serveTestCerts } from './helpers'

let token: string
let seq = 0
const db = env.DB
const headers = () => ({ 'cf-access-jwt-assertion': token, 'content-type': 'application/json' })

type List = {
  expenses: { id: number; spentOn: string; categoryIds: number[]; chargeCount: number; diff: number | null }[]
  categories: { id: number; name: string; kind: string; systemRole: string | null }[]
  paymentMethods: { code: string; label: string; statementExpected: boolean }[]
}

beforeEach(async () => {
  serveTestCerts()
  await addUser('alice@example.com')
  token = await accessToken()
  await db.batch([db.prepare('DELETE FROM expenses'), db.prepare('DELETE FROM receipts')])
})

async function expense(spentOn: string, categoryIds: number[]) {
  const res = await request('/api/expenses', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      clientRequestId: `l-${++seq}`,
      receiptId: null,
      spentOn,
      storeName: 's',
      paymentMethod: 'cash',
      items: categoryIds.map((categoryId) => ({ name: 'x', categoryId, taxRate: null, baseAmount: 100 })),
      adjustments: [],
    }),
  })
  expect(res.status).toBe(201)
  return (await res.json<{ id: number }>()).id
}

describe('一覧の口', () => {
  it('その月の支出に、品目の順で重なりを除いた費目の id を添える。費目と支払い方法の一覧も返す', async () => {
    const a = await expense('2026-11-03', [3, 1, 3, 19])
    await expense('2026-10-31', [1])
    const list = await (await request('/api/expenses?month=2026-11', { headers: headers() })).json<List>()
    expect(list.expenses.map((e) => [e.id, e.categoryIds])).toEqual([[a, [3, 1, 19]]])
    expect(list.expenses[0]).toMatchObject({ chargeCount: 0, diff: null })
    expect(list.categories.find((c) => c.id === 19)).toMatchObject({ name: '未分類', systemRole: 'uncategorized' })
    expect(list.categories.find((c) => c.id === 4)).toMatchObject({ kind: 'fixed' })
    expect(list.paymentMethods.filter((p) => p.statementExpected).map((p) => p.code)).toEqual(['rakuten_card', 'credit'])
  })
})
