// 在庫の口。設計書 §2.5・表 S(一覧に出ること)・表 U の各行と境の値(n = −1・0・1、取り消しの経過 10 分ちょうど・10 分 1 秒)
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { undoCutoff } from '../worker/domain/stock'
import { nowIso } from '../worker/time'
import { accessToken, addUser, request, serveTestCerts, versionOf } from './helpers'

let token: string
let seq = 0
const db = env.DB
const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const get = (path: string) => request(path, { headers: { 'cf-access-jwt-assertion': token } })

type Item = { id: number; name: string; notifyDays: number; retired: boolean; quantity: number; state: string | null; forecast: { daysLeft: number } | null }
const list = async () => (await (await get('/api/stock')).json<{ items: Item[] }>()).items
const find = async (id: number) => (await list()).find((i) => i.id === id)!

beforeEach(async () => {
  serveTestCerts()
  await addUser('alice@example.com')
  token = await accessToken()
  await db.batch([db.prepare('DELETE FROM expenses'), db.prepare('DELETE FROM stock_moves'), db.prepare('DELETE FROM stock_items')])
})

async function register(count: number, notifyDays?: number) {
  const res = await request('/api/stock', json('POST', { name: `品物${++seq}`, count, ...(notifyDays === undefined ? {} : { notifyDays }) }))
  expect(res.status).toBe(201)
  return (await res.json<{ id: number }>()).id
}

async function buy(stockItemId: number | null, stockQuantity: number | null) {
  const res = await request(
    '/api/expenses',
    json('POST', {
      clientRequestId: `s-${++seq}`,
      receiptId: null,
      spentOn: '2026-11-10',
      storeName: 's',
      paymentMethod: 'cash',
      items: [{ name: '洗剤', categoryId: 3, taxRate: 10, baseAmount: 300, stockItemId, stockQuantity }],
      adjustments: [],
    }),
  )
  return res
}

const use = (id: number) => request(`/api/stock/${id}/use`, json('POST'))
const recount = (id: number, count: unknown) => request(`/api/stock/${id}/count`, json('POST', { count }))
const undo = (id: number, moveId: number) => request(`/api/stock/${id}/moves/${moveId}`, json('DELETE'))
const retire = (id: number) => request(`/api/stock/${id}`, json('PATCH', { retired: true }))

describe('品物の登録と一覧(§1.14・§2.5)', () => {
  it('最初の数・既定の知らせる日数 7 で登録され、一覧に数と表 S の状態が出る', async () => {
    const id = await register(2)
    expect(await find(id)).toMatchObject({ notifyDays: 7, retired: false, quantity: 2, state: 'ok', forecast: null })
    const zero = await register(0)
    expect(await find(zero)).toMatchObject({ quantity: 0, state: 'soon', forecast: null })
  })
  it('同じ名前は 409・数が負や名前が空は 400', async () => {
    await request('/api/stock', json('POST', { name: '洗剤', count: 1 }))
    expect((await request('/api/stock', json('POST', { name: '洗剤', count: 1 }))).status).toBe(409)
    expect((await request('/api/stock', json('POST', { name: '紙', count: -1 }))).status).toBe(400)
    expect((await request('/api/stock', json('POST', { name: ' ', count: 1 }))).status).toBe(400)
  })
  it('名前・知らせる日数を直す・やめる・戻す。無い品物は 404', async () => {
    const id = await register(1)
    expect((await request(`/api/stock/${id}`, json('PATCH', { name: 'ラップ', notifyDays: 3, retired: true }))).status).toBe(200)
    expect(await find(id)).toMatchObject({ name: 'ラップ', notifyDays: 3, retired: true, state: null, forecast: null })
    expect((await request(`/api/stock/${id}`, json('PATCH', { retired: false }))).status).toBe(200)
    expect((await find(id)).retired).toBe(false)
    expect((await request('/api/stock/999999', json('PATCH', { name: 'x' }))).status).toBe(404)
  })
  it('一覧は「使った」の日からペースを出す(表 S の S3)', async () => {
    const id = await register(3)
    await db.batch(
      ['2026-11-01T01:00:00Z', '2026-11-11T01:00:00Z'].map((at) =>
        db.prepare("INSERT INTO stock_moves (stock_item_id, kind, delta, moved_by, moved_at) VALUES (?, 'use', -1, 1, ?)").bind(id, at),
      ),
    )
    const item = await find(id)
    expect(item.quantity).toBe(1)
    expect(item.forecast).toMatchObject({ paceDays: 10, runOutOn: '2026-12-01' })
  })
})

describe('数は品目と動きから導く(§2.5)', () => {
  it('支出の保存で増え、直すと差だけ動き、消すと戻る', async () => {
    const id = await register(1)
    const res = await buy(id, 2)
    expect(res.status).toBe(201)
    const { id: expenseId } = await res.json<{ id: number }>()
    expect((await find(id)).quantity).toBe(3)
    const detail = await (await get(`/api/expenses/${expenseId}`)).json<{ items: { stockItemId: number; stockQuantity: number }[] }>()
    expect(detail.items[0]).toMatchObject({ stockItemId: id, stockQuantity: 2 })

    const put = await request(
      `/api/expenses/${expenseId}`,
      json('PUT', {
        baseUpdatedAt: await versionOf(expenseId),
        spentOn: '2026-11-10',
        storeName: 's',
        paymentMethod: 'cash',
        items: [{ name: '洗剤', categoryId: 3, taxRate: 10, baseAmount: 300, stockItemId: id, stockQuantity: 1 }],
        adjustments: [],
      }),
    )
    expect(put.status).toBe(200)
    expect((await find(id)).quantity).toBe(2)
    expect((await request(`/api/expenses/${expenseId}`, json('DELETE'))).status).toBe(204)
    expect((await find(id)).quantity).toBe(1)
  })
  it('品物か個数の片方だけ・個数 0 は 400。無い品物・やめた品物は invalid_stock_item', async () => {
    const id = await register(1)
    expect((await buy(id, null)).status).toBe(400)
    expect((await buy(null, 1)).status).toBe(400)
    expect((await buy(id, 0)).status).toBe(400)
    expect(await (await buy(999999, 1)).json()).toEqual({ error: 'invalid_stock_item' })
    await retire(id)
    expect(await (await buy(id, 1)).json()).toEqual({ error: 'invalid_stock_item' })
  })
  it('直すときは、もとから付いていたやめた品物ならそのまま付けられる(費目と同じ)', async () => {
    const id = await register(0)
    const { id: expenseId } = await (await buy(id, 1)).json<{ id: number }>()
    await retire(id)
    const put = await request(
      `/api/expenses/${expenseId}`,
      json('PUT', {
        baseUpdatedAt: await versionOf(expenseId),
        spentOn: '2026-11-11',
        storeName: 's',
        paymentMethod: 'cash',
        items: [{ name: '洗剤', categoryId: 3, taxRate: 10, baseAmount: 300, stockItemId: id, stockQuantity: 1 }],
        adjustments: [],
      }),
    )
    expect(put.status).toBe(200)
  })
  it('品物を付けない支出は今までどおり保存できる(体に書かなくてよい)', async () => {
    const res = await request(
      '/api/expenses',
      json('POST', {
        clientRequestId: `s-${++seq}`,
        receiptId: null,
        spentOn: '2026-11-10',
        storeName: 's',
        paymentMethod: 'cash',
        items: [{ name: 'パン', categoryId: 1, taxRate: 8, baseAmount: 200 }],
        adjustments: [],
      }),
    )
    expect(res.status).toBe(201)
  })
})

describe('表 U 在庫の操作', () => {
  it('U1: 無い品物は、使った・入れ直す・取り消すのどれも 404', async () => {
    expect((await use(999999)).status).toBe(404)
    expect((await recount(999999, 1)).status).toBe(404)
    expect((await undo(999999, 1)).status).toBe(404)
  })
  it('U2: やめた品物は、使った・入れ直す・取り消すのどれも 409', async () => {
    const id = await register(2)
    const { moveId } = await (await use(id)).json<{ moveId: number }>()
    await retire(id)
    expect(await (await use(id)).json()).toEqual({ error: 'retired' })
    expect(await (await recount(id, 1)).json()).toEqual({ error: 'retired' })
    const res = await undo(id, moveId)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'retired' })
  })
  it('U3: 数 0 で使ったは 409(書かない)', async () => {
    const id = await register(0)
    const res = await use(id)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'no_stock' })
    expect((await find(id)).quantity).toBe(0)
  })
  it('U3: 数 −1(使った後に買った支出を消した)で使ったは 409', async () => {
    const id = await register(0)
    const { id: expenseId } = await (await buy(id, 1)).json<{ id: number }>()
    expect((await use(id)).status).toBe(201)
    await request(`/api/expenses/${expenseId}`, json('DELETE'))
    expect((await find(id)).quantity).toBe(-1)
    expect((await use(id)).status).toBe(409)
  })
  it('U4: 数 1 で使ったは書いて 0 になる', async () => {
    const id = await register(1)
    const res = await use(id)
    expect(res.status).toBe(201)
    expect((await res.json<{ moveId: number }>()).moveId).toBeGreaterThan(0)
    expect((await find(id)).quantity).toBe(0)
  })
  it('U5: 入れ直すと、品目と前の動きがあっても数はその値になる(0 を含む)', async () => {
    const id = await register(1)
    await buy(id, 3)
    await use(id)
    expect((await find(id)).quantity).toBe(3)
    expect((await recount(id, 5)).status).toBe(201)
    expect((await find(id)).quantity).toBe(5)
    expect((await recount(id, 0)).status).toBe(201)
    expect((await find(id)).quantity).toBe(0)
  })
  it('U5: 入れ直す数が負・整数でない・無いは 400', async () => {
    const id = await register(1)
    expect((await recount(id, -1)).status).toBe(400)
    expect((await recount(id, 1.5)).status).toBe(400)
    expect((await request(`/api/stock/${id}/count`, json('POST', {}))).status).toBe(400)
  })
  it('U6: この品物の「使った」でない動き(無い・入れ直し・別の品物)は 404', async () => {
    const id = await register(2)
    const other = await register(2)
    const { moveId: countMove } = await (await recount(id, 2)).json<{ moveId: number }>()
    const { moveId: otherUse } = await (await use(other)).json<{ moveId: number }>()
    // 品物の not_found(U1)と分けた code(ほかの端末が先に取り消したときに「品物が外れた」と誤って出さない)
    for (const m of [999999, countMove, otherUse]) {
      const res = await undo(id, m)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'move_not_found' })
    }
  })
  it('U7: 後に動き(使った・入れ直し)があれば 409', async () => {
    const id = await register(3)
    const { moveId: first } = await (await use(id)).json<{ moveId: number }>()
    await use(id)
    expect(await (await undo(id, first)).json()).toEqual({ error: 'not_latest' })
    const { moveId: third } = await (await use(id)).json<{ moveId: number }>()
    await recount(id, 0)
    expect(await (await undo(id, third)).json()).toEqual({ error: 'not_latest' })
  })
  it('U8: 押してから 10 分 1 秒(以上)たつと 409', async () => {
    const id = await register(2)
    const { moveId } = await (await use(id)).json<{ moveId: number }>()
    const old = nowIso(new Date(Date.now() - 11 * 60 * 1000))
    await db.prepare('UPDATE stock_moves SET moved_at = ? WHERE id = ?').bind(old, moveId).run()
    expect(await (await undo(id, moveId)).json()).toEqual({ error: 'undo_expired' })
    expect((await find(id)).quantity).toBe(1)
  })
  it('U9: 最新の動きで 10 分以内なら消え、数が 1 戻り、ペースからも消える', async () => {
    const id = await register(2)
    const { moveId } = await (await use(id)).json<{ moveId: number }>()
    expect((await undo(id, moveId)).status).toBe(204)
    expect((await find(id)).quantity).toBe(2)
    const left = await db.prepare("SELECT count(*) AS n FROM stock_moves WHERE stock_item_id = ? AND kind = 'use'").bind(id).first<{ n: number }>()
    expect(left!.n).toBe(0)
  })
  it('一覧は U9 に当たる「使った」の id を返す(最新で 10 分以内だけ。後に入れ直しがあれば null)', async () => {
    const id = await register(3)
    expect((await find(id) as Item & { undoableMoveId: number | null }).undoableMoveId).toBeNull()
    const { moveId } = await (await use(id)).json<{ moveId: number }>()
    expect((await find(id) as Item & { undoableMoveId: number | null }).undoableMoveId).toBe(moveId)
    await db.prepare('UPDATE stock_moves SET moved_at = ? WHERE id = ?').bind(nowIso(new Date(Date.now() - 11 * 60 * 1000)), moveId).run()
    expect((await find(id) as Item & { undoableMoveId: number | null }).undoableMoveId).toBeNull()
    const { moveId: second } = await (await use(id)).json<{ moveId: number }>()
    expect((await find(id) as Item & { undoableMoveId: number | null }).undoableMoveId).toBe(second)
    await recount(id, 1)
    expect((await find(id) as Item & { undoableMoveId: number | null }).undoableMoveId).toBeNull()
  })
  it('取り消せる境: 10 分ちょうどは取り消せる、10 分 1 秒は取り消せない(undoCutoff)', () => {
    const now = new Date('2026-11-16T12:10:00.000Z')
    const cutoff = undoCutoff(now)
    expect('2026-11-16T12:00:00Z' >= cutoff).toBe(true)
    expect('2026-11-16T11:59:59Z' >= cutoff).toBe(false)
  })
})
