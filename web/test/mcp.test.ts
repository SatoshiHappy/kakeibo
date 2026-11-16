// Claude Code からの入力の口(基盤 §5)。入口の判定(基盤 §3.1)が掛かること・範囲(M1)・画面の API と同じ規則が掛かることを通す
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../worker/app'
import { jsonOrText } from '../worker/mcp'
import { accessToken, addUser, ORIGIN, request, serveTestCerts } from './helpers'

const db = env.DB
let token: string
let rpcId = 0

const now = new Date(Date.now() + 9 * 3600_000)
const thisMonth = now.toISOString().slice(0, 7)
const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
const prevMonth = prev.toISOString().slice(0, 7)
const day = (d: number) => `${prevMonth}-${String(d).padStart(2, '0')}`
const m = Number(thisMonth.slice(5, 7))
const HEADER = `"利用日","利用店名・商品名","利用者","支払方法","利用金額","手数料/利息","支払総額","${m}月支払金額","当月請求額","${(m % 12) + 1}月繰越残高","新規サイン"`
type Line = { date: string; amount: number | '-' }
const csvOf = (lines: Line[]) =>
  [HEADER, ...lines.map((l) => `"${l.date.replace(/-/g, '/')}","ショップ","本人","1回払い","${l.amount}","0","${l.amount}","${l.amount}","${l.amount}","0","*"`)].join('\n')

beforeEach(async () => {
  serveTestCerts()
  await addUser('alice@example.com', 'アリス')
  token = await accessToken()
  await db.batch([
    db.prepare('DELETE FROM match_rejections'),
    db.prepare('DELETE FROM expenses'),
    db.prepare('DELETE FROM card_charges'),
    db.prepare('DELETE FROM statement_imports'),
  ])
})

function rpc(method: string, params: unknown, headers: Record<string, string> = { 'cf-access-jwt-assertion': token }) {
  return request('/api/mcp', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
}

type ToolOutcome = { isError: boolean; status: number; body: Record<string, unknown> | null }
async function callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const res = await rpc('tools/call', { name, arguments: args })
  expect(res.status).toBe(200)
  const json = await res.json<{ result: { isError?: boolean; content: { type: string; text: string }[] } }>()
  const payload = JSON.parse(json.result.content[0].text) as { status: number; body: Record<string, unknown> | null }
  return { isError: json.result.isError === true, ...payload }
}

const expense = (over: Record<string, unknown> = {}) => ({
  clientRequestId: crypto.randomUUID(),
  spentOn: day(10),
  storeName: 'スーパー',
  paymentMethod: 'cash',
  items: [{ name: '牛乳', categoryId: 1, taxRate: 8, baseAmount: 200, stockItemId: null, stockQuantity: null }],
  adjustments: [],
  ...over,
})

describe('入口の判定(基盤 §3.1 の表がそのまま掛かる)', () => {
  it('JWT が無い → 401', async () => {
    expect((await rpc('tools/list', {}, {})).status).toBe(401)
  })
  it('利用者の表に無いメール → 403', async () => {
    const stranger = await accessToken({ email: 'stranger@example.com' })
    expect((await rpc('tools/list', {}, { 'cf-access-jwt-assertion': stranger })).status).toBe(403)
  })
  it('別のサイトのフォーム・文字の POST は CSRF の検査で 403(JSON 以外は MCP にも届かない)', async () => {
    const res = await request('/api/mcp', {
      method: 'POST',
      headers: { 'cf-access-jwt-assertion': token, origin: 'https://evil.example', 'content-type': 'text/plain', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBe(403)
  })
  it('Origin の無い JSON の要求(Claude Code の形)は CSRF の検査の行で通る', async () => {
    const res = await app.request(
      `${ORIGIN}/api/mcp`,
      {
        method: 'POST',
        headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
      env,
    )
    expect(res.status).toBe(200)
  })
  it('POST のほかは 405(状態を持たない形)', async () => {
    const auth = { 'cf-access-jwt-assertion': token }
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const res = await request('/api/mcp', { method, headers: auth })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
    }
  })
})

describe('範囲(ユーザー回答 M1)', () => {
  it('道具は支出の追加・直し・取り消し・明細の取り込みと読むものだけ', async () => {
    const res = await rpc('tools/list', {})
    const json = await res.json<{ result: { tools: { name: string }[] } }>()
    expect(json.result.tools.map((t) => t.name).sort()).toEqual(
      [
        'add_expense',
        'delete_expense',
        'get_expense',
        'get_summary',
        'import_statement_csv',
        'list_categories',
        'list_expenses',
        'list_payment_methods',
        'set_item_category',
        'update_expense',
      ].sort(),
    )
  })
  it('道具の入力の説明は画面の API の型から出る(正本の定義: 値引き行は真上の品目から引く・調整の税率の null は全部の品目)', async () => {
    const res = await rpc('tools/list', {})
    const json = await res.json<{ result: { tools: { name: string; inputSchema: unknown }[] } }>()
    const add = JSON.stringify(json.result.tools.find((t) => t.name === 'add_expense')!.inputSchema)
    expect(add).toContain('真上の品目から引く')
    expect(add).toContain('全部の品目にかかるなら null')
    expect(add).toContain('外税は品目と同じ符号')
  })
})

describe('画面の API と同じ規則が掛かる', () => {
  it('add_expense: ログインした人の支出として保存し、同じ clientRequestId は 1 件にしかならない', async () => {
    const body = expense()
    const first = await callTool('add_expense', body)
    expect(first).toMatchObject({ isError: false, status: 201 })
    const again = await callTool('add_expense', body)
    expect(again).toMatchObject({ isError: false, status: 200, body: { id: first.body!.id } })
    const row = await db
      .prepare('SELECT u.email FROM expenses e JOIN users u ON u.id = e.registered_by WHERE e.id = ?')
      .bind(first.body!.id)
      .first<{ email: string }>()
    expect(row!.email).toBe('alice@example.com')
    expect((await db.prepare('SELECT count(*) AS n FROM expenses').first<{ n: number }>())!.n).toBe(1)
  })

  it('add_expense: 検査に外れたら道具の失敗として返す(400・書かない)', async () => {
    const out = await callTool('add_expense', expense({ items: [{ name: 'x', categoryId: 9999, taxRate: null, baseAmount: 100 }] }))
    expect(out).toMatchObject({ isError: true, status: 400, body: { error: 'invalid_category' } })
    expect((await db.prepare('SELECT count(*) AS n FROM expenses').first<{ n: number }>())!.n).toBe(0)
  })

  const importCsv = (lines: Line[], expectedRows = lines.length, expectedTotal = lines.reduce((a, l) => a + (l.amount === '-' ? 0 : l.amount), 0)) =>
    callTool('import_statement_csv', { csv: csvOf(lines), expectedRows, expectedTotal })
  const book = (spentOn: string, amount: number) =>
    callTool('add_expense', expense({ spentOn, paymentMethod: 'rakuten_card', items: [{ name: '本', categoryId: 10, taxRate: 10, baseAmount: amount }] }))

  it('import_statement_csv: 取り込みの側で、先にある同じ日・同じ額の支出と自動で結ぶ(表 A-1)', async () => {
    const added = await book(day(5), 1200)
    const out = await importCsv([{ date: day(5), amount: 1200 }, { date: day(6), amount: 800 }])
    expect(out).toMatchObject({ isError: false, status: 201, body: { rowsInFile: 2, totalAmount: 2000, rowsNew: 2 } })
    expect((await callTool('get_expense', { id: added.body!.id })).body).toMatchObject({ chargeCount: 1, diff: 0 })
  })

  it('add_expense: 支出の側で、先に取り込んだ同じ日・同じ額の行と自動で結ぶ(表 A-1)', async () => {
    await importCsv([{ date: day(5), amount: 1200 }])
    const added = await book(day(5), 1200)
    expect((await callTool('get_expense', { id: added.body!.id })).body).toMatchObject({ chargeCount: 1, diff: 0 })
  })

  it('C17: 期待の合計額・行数がファイルと合わなければ何も書かずに 422(境: どちらも −1・0・+1)', async () => {
    const lines: Line[] = [{ date: day(5), amount: 1200 }, { date: day(6), amount: 800 }]
    for (const [rows, total] of [[2, 1999], [2, 2001], [1, 2000], [3, 2000]]) {
      expect(await importCsv(lines, rows, total)).toMatchObject({ isError: true, status: 422, body: { error: 'mismatch', check: 'C17', rowsInFile: 2, totalAmount: 2000 } })
    }
    expect((await db.prepare('SELECT count(*) AS n FROM card_charges').first<{ n: number }>())!.n).toBe(0)
    expect((await db.prepare('SELECT count(*) AS n FROM expenses').first<{ n: number }>())!.n).toBe(0)
    expect(await importCsv(lines, 2, 2000)).toMatchObject({ isError: false, status: 201 })
  })

  it('C17: 行数は利用金額が - の行も数え、合計額は - の行を数えない', async () => {
    const lines: Line[] = [{ date: day(5), amount: 1200 }, { date: day(3), amount: '-' }]
    expect(await importCsv(lines, 2, 1200)).toMatchObject({ isError: false, status: 201, body: { rowsInFile: 2, totalAmount: 1200 } })
  })

  it('要求の形の検査: 期待値が片方だけ・整数でない・行数が負なら 400(ファイルの中身より先に見る)。渡さなければ C17 を掛けない', async () => {
    const send = async (fields: Record<string, string>, csv = csvOf([{ date: day(5), amount: 100 }])) => {
      const form = new FormData()
      form.set('file', new File([csv], 'enavi.csv', { type: 'text/csv' }))
      for (const [k, v] of Object.entries(fields)) form.set(k, v)
      const res = await request('/api/statements', { method: 'POST', headers: { 'cf-access-jwt-assertion': token }, body: form })
      return { status: res.status, body: await res.json<Record<string, unknown>>() }
    }
    expect((await send({ expectedRows: '1' })).status).toBe(400)
    expect((await send({ expectedTotal: '100' })).status).toBe(400)
    expect((await send({ expectedRows: '1', expectedTotal: '1.5' })).status).toBe(400)
    expect((await send({ expectedRows: '-1', expectedTotal: '100' })).status).toBe(400)
    // 優先: 要求の形 → C1〜C9 → C17
    expect(await send({ expectedRows: '1' }, 'broken')).toMatchObject({ status: 400, body: { error: 'invalid_expected' } })
    expect(await send({ expectedRows: '9', expectedTotal: '9' }, 'broken')).toMatchObject({ status: 422, body: { check: 'C2' } })
    expect((await send({})).status).toBe(201)
  })

  it('月の検査は画面の口と同じ(13 月は受けない)', async () => {
    expect((await request(`/api/expenses?month=${thisMonth.slice(0, 4)}-13`, { headers: { 'cf-access-jwt-assertion': token } })).status).toBe(400)
    const res = await rpc('tools/call', { name: 'list_expenses', arguments: { month: '2026-13' } })
    const json = await res.json<{ result?: { isError?: boolean }; error?: unknown }>()
    expect(json.result?.isError === true || json.error !== undefined).toBe(true)
  })

  it('中の API の応答が JSON でなければ、文字のまま道具の結果にする', () => {
    expect(jsonOrText('{"error":"x"}')).toEqual({ error: 'x' })
    expect(jsonOrText('Forbidden')).toBe('Forbidden')
  })

  it('明細から作った支出は直せず消せない(409)が、費目は set_item_category で直せる', async () => {
    await importCsv([{ date: day(7), amount: 500 }])
    const list = await callTool('list_expenses', { month: prevMonth })
    const st = (list.body!.expenses as { id: number; origin: string }[]).find((e) => e.origin === 'statement_purchase')!
    expect(await callTool('update_expense', { id: st.id, ...expense(), clientRequestId: undefined, baseUpdatedAt: 'x' })).toMatchObject({ isError: true, status: 409 })
    expect(await callTool('delete_expense', { id: st.id })).toMatchObject({ isError: true, status: 409 })
    expect(await callTool('set_item_category', { id: st.id, position: 1, categoryId: 16 })).toMatchObject({ isError: false, status: 200 })
    const item = await db.prepare('SELECT category_id FROM items WHERE expense_id = ?').bind(st.id).first<{ category_id: number }>()
    expect(item!.category_id).toBe(16)
  })

  it('update_expense・delete_expense: 人が入れた支出を直して取り消せる', async () => {
    const added = await callTool('add_expense', expense())
    const id = added.body!.id
    const { clientRequestId: _omit, ...rest } = expense({ storeName: '八百屋' })
    const { updatedAt } = (await callTool('get_expense', { id })).body as { updatedAt: string }
    expect(await callTool('update_expense', { id, ...rest, baseUpdatedAt: updatedAt })).toMatchObject({ isError: false, status: 200 })
    expect((await callTool('get_expense', { id })).body).toMatchObject({ storeName: '八百屋' })
    expect(await callTool('delete_expense', { id })).toMatchObject({ isError: false, status: 204 })
    expect((await callTool('get_expense', { id })).status).toBe(404)
  })
})
