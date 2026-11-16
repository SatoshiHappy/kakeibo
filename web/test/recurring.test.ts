// 毎月決まった支出(データと照合 §1.17・表 Q・§4.12)。表 Q の各行と、月末・日 31・止まっていた日の分の境
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { dateIn, firstOn, MAX_PER_RUN, nextAfter, runRecurring } from '../worker/recurring'
import type { Bindings } from '../worker/types'
import { accessToken, addUser, request, serveTestCerts } from './helpers'

let token: string
let seq = 0
const db = env.DB
const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const get = (path: string) => request(path, { headers: { 'cf-access-jwt-assertion': token } })
/** 日本時間のその日の 9 時(Cron の 0 時 UTC) */
const at = (date: string) => new Date(`${date}T00:00:00Z`)

beforeEach(async () => {
  serveTestCerts()
  await addUser('alice@example.com')
  token = await accessToken()
  await db.batch([db.prepare('DELETE FROM expenses'), db.prepare('DELETE FROM recurring_expenses'), db.prepare('UPDATE categories SET retired_at = NULL')])
})

/** 登録を直接入れる(次に作る日を過去にするため。口は今日より前を断る) */
async function seed(o: { day: number; nextOn: string; ended?: boolean; amount?: number; payment?: string; category?: number }) {
  const key = `seed-${++seq}`
  const user = (await db.prepare("SELECT id FROM users WHERE email = 'alice@example.com'").first<{ id: number }>())!
  await db
    .prepare(
      `INSERT INTO recurring_expenses (client_request_id, name, category_id, amount, payment_method, day_of_month, next_on, ended_at, created_by, created_at, updated_at)
       VALUES (?, '家賃', ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    )
    .bind(key, o.category ?? 4, o.amount ?? 101500, o.payment ?? 'bank_transfer', o.day, o.nextOn, o.ended ? '2026-01-02T00:00:00Z' : null, user.id)
    .run()
  return (await db.prepare('SELECT id FROM recurring_expenses WHERE client_request_id = ?').bind(key).first<{ id: number }>())!.id
}
const made = async (id: number) =>
  (
    await db
      .prepare(
        `SELECT e.spent_on, e.store_name, e.payment_method, e.origin, i.category_id, i.amount FROM expenses e JOIN items i ON i.expense_id = e.id
         WHERE e.recurring_id = ? ORDER BY e.spent_on`,
      )
      .bind(id)
      .all<{ spent_on: string; store_name: string; payment_method: string; origin: string; category_id: number; amount: number }>()
  ).results
const nextOn = async (id: number) => (await db.prepare('SELECT next_on FROM recurring_expenses WHERE id = ?').bind(id).first<{ next_on: string }>())!.next_on

describe('日付の計算', () => {
  it('その月に無い日は月末(2 月 31 日 → 28 日、うるう年 → 29 日)', () => {
    expect(dateIn('2026-02', 31)).toBe('2026-02-28')
    expect(dateIn('2028-02', 31)).toBe('2028-02-29')
    expect(dateIn('2026-04', 31)).toBe('2026-04-30')
    expect(dateIn('2026-11', 27)).toBe('2026-11-27')
  })
  it('次の月は登録の日で決める(月末に寄せた後も 31 日に戻る)・年をまたぐ', () => {
    expect(nextAfter('2026-02-28', 31)).toBe('2026-03-31')
    expect(nextAfter('2026-12-27', 27)).toBe('2027-01-27')
  })
  it('最初の日: 今日がその日なら今日、過ぎていれば次の月', () => {
    expect(firstOn('2026-11-16', 16)).toBe('2026-11-16')
    expect(firstOn('2026-11-16', 15)).toBe('2026-12-15')
    expect(firstOn('2026-11-16', 27)).toBe('2026-11-27')
  })
})

describe('表 Q 毎月決まった支出を作るか', () => {
  it('Q1: next_on が今日なら作り、次の月へ進める(人の支出と同じ形・照合も掛かる)', async () => {
    const id = await seed({ day: 27, nextOn: '2026-10-27' })
    expect(await runRecurring(env as unknown as Bindings, at('2026-10-27'))).toEqual({ created: 1, skipped: 0 })
    expect(await made(id)).toEqual([
      { spent_on: '2026-10-27', store_name: '家賃', payment_method: 'bank_transfer', origin: 'person', category_id: 4, amount: 101500 },
    ])
    expect(await nextOn(id)).toBe('2026-11-27')
  })

  it('Q1: 止まっていた日の分は続けて作り、上限の 12 か月で止める(残りは次の判定)', async () => {
    const id = await seed({ day: 31, nextOn: '2024-01-31' })
    const run = await runRecurring(env as unknown as Bindings, at('2026-10-27'))
    expect(run.created).toBe(MAX_PER_RUN)
    const rows = await made(id)
    expect(rows.map((r) => r.spent_on).slice(0, 3)).toEqual(['2024-01-31', '2024-02-29', '2024-03-31'])
    expect(await nextOn(id)).toBe('2025-01-31')
  })

  it('Q2: next_on が明日なら作らない(境: 今日の前日まで作り、今日の翌日は作らない)', async () => {
    const id = await seed({ day: 28, nextOn: '2026-10-28' })
    expect(await runRecurring(env as unknown as Bindings, at('2026-10-27'))).toEqual({ created: 0, skipped: 0 })
    expect(await made(id)).toEqual([])
    expect(await nextOn(id)).toBe('2026-10-28')
  })

  it('Q3: 止めた登録は next_on が過ぎていても作らない', async () => {
    const id = await seed({ day: 1, nextOn: '2026-10-01', ended: true })
    expect(await runRecurring(env as unknown as Bindings, at('2026-10-27'))).toEqual({ created: 0, skipped: 0 })
    expect(await made(id)).toEqual([])
  })

  it('同じ日に 2 回走っても 1 つだけ作る・作った支出を消しても作り直さない', async () => {
    const id = await seed({ day: 27, nextOn: '2026-10-27' })
    await runRecurring(env as unknown as Bindings, at('2026-10-27'))
    await runRecurring(env as unknown as Bindings, at('2026-10-27'))
    expect(await made(id)).toHaveLength(1)
    await db.prepare('DELETE FROM expenses WHERE recurring_id = ?').bind(id).run()
    await runRecurring(env as unknown as Bindings, at('2026-10-27'))
    expect(await made(id)).toEqual([])
  })

  it('楽天カードで登録すると、人の支出と同じく明細の行と照合して結ぶ(表 A-1 の 2 行。特別扱いしない)', async () => {
    const jst = new Date(Date.now() + 9 * 3600_000)
    const thisMonth = jst.toISOString().slice(0, 7)
    const prev = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() - 1, 5)).toISOString().slice(0, 10)
    const m = Number(thisMonth.slice(5, 7))
    const csv = [
      `"利用日","利用店名・商品名","利用者","支払方法","利用金額","手数料/利息","支払総額","${m}月支払金額","当月請求額","${(m % 12) + 1}月繰越残高","新規サイン"`,
      `"${prev.replace(/-/g, '/')}","NET","本人","1回払い","3980","0","3980","3980","3980","0","*"`,
    ].join('\n')
    await db.batch([db.prepare('DELETE FROM match_rejections'), db.prepare('DELETE FROM card_charges'), db.prepare('DELETE FROM statement_imports')])
    const form = new FormData()
    form.set('file', new File([csv], 'a.csv'))
    expect((await request('/api/statements', { method: 'POST', headers: { 'cf-access-jwt-assertion': token }, body: form })).status).toBe(201)
    // 取り込みが作った明細の支出を消し、行を自由に戻す(人の支出だけを結ぶ形にする)
    await db.prepare("DELETE FROM expenses WHERE origin = 'statement_purchase'").run()
    const id = await seed({ day: 5, nextOn: prev, payment: 'rakuten_card', amount: 3980 })
    await runRecurring(env as unknown as Bindings, at(prev))
    const linked = await db
      .prepare('SELECT e.recurring_id FROM card_charges c JOIN expenses e ON e.id = c.expense_id WHERE c.amount = 3980')
      .first<{ recurring_id: number }>()
    expect(linked?.recurring_id).toBe(id)
  })
})

describe('毎月決まった支出の口(§4.12)', () => {
  const base = { name: '家賃', categoryId: 4, amount: 101500, paymentMethod: 'bank_transfer', dayOfMonth: 27 }

  it('登録すると一覧に出て、次に作る日は今日以後で最初のその日', async () => {
    const res = await request('/api/recurring', json('POST', { clientRequestId: `r-${++seq}`, ...base }))
    expect(res.status).toBe(201)
    const body = await (await get('/api/recurring')).json<{ items: { name: string; nextOn: string }[]; today: string; paymentMethods: { code: string }[] }>()
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.nextOn).toBe(firstOn(body.today, 27))
    expect(body.paymentMethods.map((p) => p.code)).toContain('bank_transfer')
  })

  it('同じ要求の再送は 2 つにならない(reused)', async () => {
    const key = `r-${++seq}`
    expect((await request('/api/recurring', json('POST', { clientRequestId: key, ...base }))).status).toBe(201)
    const again = await request('/api/recurring', json('POST', { clientRequestId: key, ...base }))
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ reused: true })
  })

  it('断る: 体が読めない・やめた費目・知らない支払い方法・今日より前の日(結果の優先順どおり)', async () => {
    const post = (b: object) => request('/api/recurring', json('POST', { clientRequestId: `r-${++seq}`, ...base, ...b }))
    expect((await post({ amount: 0 })).status).toBe(400)
    await db.prepare("UPDATE categories SET retired_at = '2026-01-01T00:00:00Z' WHERE id = 7").run()
    expect(await (await post({ categoryId: 7, paymentMethod: 'nope' })).json()).toEqual({ error: 'invalid_category' })
    expect(await (await post({ paymentMethod: 'nope', nextOn: '2000-01-01' })).json()).toEqual({ error: 'invalid_payment_method' })
    expect(await (await post({ nextOn: '2000-01-01' })).json()).toEqual({ error: 'past_date' })
  })

  it('直すと次から効き、止めると一覧から消える。止めた登録は直せない(404)', async () => {
    const res = await request('/api/recurring', json('POST', { clientRequestId: `r-${++seq}`, ...base }))
    const { id } = await res.json<{ id: number }>()
    const today = (await (await get('/api/recurring')).json<{ today: string }>()).today
    expect((await request(`/api/recurring/${id}`, json('PUT', { ...base, amount: 99000, nextOn: today }))).status).toBe(200)
    expect((await db.prepare('SELECT amount FROM recurring_expenses WHERE id = ?').bind(id).first<{ amount: number }>())!.amount).toBe(99000)
    expect((await request(`/api/recurring/${id}`, json('DELETE'))).status).toBe(204)
    expect((await (await get('/api/recurring')).json<{ items: unknown[] }>()).items).toEqual([])
    expect(await (await request(`/api/recurring/${id}`, json('PUT', { ...base, nextOn: today }))).json()).toEqual({ error: 'not_found' })
    expect((await request(`/api/recurring/${id}`, json('DELETE'))).status).toBe(404)
  })

  it('止めていない登録が指す費目はやめられない(409 used_by_recurring)。止めればやめられる', async () => {
    const id = await seed({ day: 27, nextOn: '2030-01-27', category: 6 })
    const retire = () => request('/api/categories/6', json('PATCH', { retired: true }))
    const refused = await retire()
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'used_by_recurring' })
    await request(`/api/recurring/${id}`, json('DELETE'))
    expect((await retire()).status).toBe(200)
  })

  it('一覧の口は自動で作った支出に recurring の印を付ける', async () => {
    const id = await seed({ day: 27, nextOn: '2026-10-27' })
    await runRecurring(env as unknown as Bindings, at('2026-10-27'))
    const list = await (await get('/api/expenses?month=2026-10')).json<{ expenses: { storeName: string; recurring: boolean }[] }>()
    expect(list.expenses.find((e) => e.storeName === '家賃')!.recurring).toBe(true)
    expect(id).toBeGreaterThan(0)
  })
})
