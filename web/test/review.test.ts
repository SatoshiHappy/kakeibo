// 確かめる一覧(表 L)と表 A-2・表 A-3、一覧での人の操作
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { accessToken, addUser, request, serveTestCerts } from './helpers'

let token: string
let seq = 0
const db = env.DB
const now = new Date(Date.now() + 9 * 3600_000)
const thisMonth = now.toISOString().slice(0, 7)
const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
const day = (d: number) => `${prevMonth}-${String(d).padStart(2, '0')}`
const m = Number(thisMonth.slice(5, 7))
const HEADER = `"利用日","利用店名・商品名","利用者","支払方法","利用金額","手数料/利息","支払総額","${m}月支払金額","当月請求額","${(m % 12) + 1}月繰越残高","新規サイン"`

beforeEach(async () => {
  serveTestCerts()
  await addUser('alice@example.com')
  token = await accessToken()
  await db.batch([
    db.prepare('DELETE FROM match_rejections'),
    db.prepare('DELETE FROM expenses'),
    db.prepare('DELETE FROM card_charges'),
    db.prepare('DELETE FROM statement_imports'),
  ])
})

const send = (path: string, method: string, body?: unknown) =>
  request(path, {
    method,
    headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function importCsv(lines: { date: string; amount: number; shop?: string }[]) {
  const text = [HEADER, ...lines.map((l) => `"${l.date.replace(/-/g, '/')}","${l.shop ?? 'S'}","本人","1回払い","${l.amount}","0","${l.amount}","${l.amount}","${l.amount}","0","*"`)].join('\n')
  const form = new FormData()
  form.set('file', new File([text], 'a.csv'))
  const res = await request('/api/statements', { method: 'POST', headers: { 'cf-access-jwt-assertion': token }, body: form })
  expect(res.status).toBe(201)
}

async function saveExpense(spentOn: string, amount: number, paymentMethod = 'rakuten_card') {
  const res = await send('/api/expenses', 'POST', {
    clientRequestId: `v-${++seq}`,
    receiptId: null,
    spentOn,
    storeName: '店',
    paymentMethod,
    items: [{ name: 'x', categoryId: 1, taxRate: null, baseAmount: amount }],
    adjustments: [],
  })
  expect(res.status).toBe(201)
  return (await res.json<{ id: number }>()).id
}

type Item = { type: string; charge?: { id: number }; expense?: { id: number }; candidates?: { id: number }[]; charges?: { id: number }[]; diff?: number; duplicateSuspects?: unknown[] }
const list = async () => (await (await send('/api/review', 'GET')).json<{ items: Item[] }>()).items
const chargeIds = async () => ((await db.prepare('SELECT id FROM card_charges ORDER BY id').all<{ id: number }>()).results).map((r) => r.id)

describe('L1 行の候補', () => {
  it('日付がずれた候補がある行は L1 に出て、選ぶと結ばれる', async () => {
    const p = await saveExpense(day(10), 500)
    await importCsv([{ date: day(12), amount: 500 }])
    const [l1] = await list()
    expect(l1).toMatchObject({ type: 'row_candidates', candidates: [{ id: p }] })
    expect((await send('/api/review/link', 'POST', { chargeId: l1.charge!.id, expenseId: p })).status).toBe(200)
    expect(await list()).toEqual([])
  })
  it('「どれでもない」で候補を拒否し、明細の支出になる', async () => {
    const p = await saveExpense(day(10), 500)
    await importCsv([{ date: day(12), amount: 500 }])
    const [r] = await chargeIds()
    expect((await send('/api/review/none', 'POST', { chargeId: r })).status).toBe(200)
    const ch = await db.prepare('SELECT expense_origin FROM card_charges WHERE id = ?').bind(r).first<{ expense_origin: string }>()
    expect(ch!.expense_origin).toBe('statement_purchase')
    // P は「明細に無い」に出る(表 A-2 の 4 行)
    const items = await list()
    expect(items).toEqual([expect.objectContaining({ type: 'no_statement', expense: expect.objectContaining({ id: p }) })])
  })
})

describe('表 A-2(自由な支出 P の側)', () => {
  it('A-2 の 1 行: 候補に明細の支出の行がある → L2 まとめる候補。選ぶとまとまる', async () => {
    await importCsv([{ date: day(10), amount: 800 }])
    const p = await saveExpense(day(13), 800) // 日付ずれ → 自動ではまとめない
    const [l2] = await list()
    expect(l2).toMatchObject({ type: 'merge_candidates', expense: { id: p } })
    await send('/api/review/link', 'POST', { chargeId: l2.charges![0].id, expenseId: p })
    const origins = (await db.prepare('SELECT origin FROM expenses').all<{ origin: string }>()).results.map((r) => r.origin)
    expect(origins).toEqual(['person'])
  })
  it('A-2 の 3 行: 明細がまだ来ていない月は出さない', async () => {
    await saveExpense(`${thisMonth}-01`, 100)
    await importCsv([{ date: day(1), amount: 999 }])
    expect((await list()).filter((i) => i.type === 'no_statement')).toEqual([])
  })
  it('A-2 の 4 行: 期間に入る楽天カードの支出で行が無い → L3 明細に無い。A-2 の 5 行: 確認済みで消える', async () => {
    const p = await saveExpense(day(20), 100)
    await importCsv([{ date: day(1), amount: 999 }])
    expect(await list()).toContainEqual(expect.objectContaining({ type: 'no_statement', expense: expect.objectContaining({ id: p }) }))
    expect((await send('/api/review/ack-no-statement', 'POST', { expenseId: p })).status).toBe(200)
    expect((await list()).filter((i) => i.type === 'no_statement')).toEqual([])
  })
  it('A-2 の 6 行: 現金の支出は出さない', async () => {
    await saveExpense(day(20), 100, 'cash')
    await importCsv([{ date: day(1), amount: 999 }])
    expect((await list()).filter((i) => i.type === 'no_statement')).toEqual([])
  })
  it('L3 の重複の疑い: 同じ額の結び済みの行があれば印が付く', async () => {
    await saveExpense(day(10), 300) // 行と自動で結ばれる
    await importCsv([{ date: day(10), amount: 300 }])
    const dup = await saveExpense(day(10), 300) // 同じレシートを 2 回登録した
    const l3 = (await list()).find((i) => i.type === 'no_statement' && i.expense!.id === dup)!
    expect(l3.duplicateSuspects).toHaveLength(1)
  })
})

describe('表 A-3(差あり)', () => {
  async function linkedWithDiff() {
    const p = await saveExpense(day(10), 1000)
    await importCsv([{ date: day(12), amount: 1001 }])
    const [r] = await chargeIds()
    await send('/api/review/link', 'POST', { chargeId: r, expenseId: p })
    return { p, r }
  }
  it('A-3 の 1 行: 差 0 は出さない', async () => {
    await saveExpense(day(10), 1000)
    await importCsv([{ date: day(10), amount: 1000 }])
    expect(await list()).toEqual([])
  })
  it('このままは画面で見た差を送り、今の差と違えば 409 changed で覚えない(見ていない差を確認済みにしない)', async () => {
    const { p } = await linkedWithDiff()
    const res = await send('/api/review/ack-diff', 'POST', { expenseId: p, diff: 5 })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'changed' })
    expect(await list()).toEqual([expect.objectContaining({ type: 'diff', diff: 1 })])
    expect((await send('/api/review/ack-diff', 'POST', { expenseId: p, diff: 1 })).status).toBe(200)
    expect(await list()).toEqual([])
  })
  it('A-3 の 3 行: 差 1 は L4。A-3 の 2 行: このままにすると出ない。差が変わるとまた出る', async () => {
    const { p } = await linkedWithDiff()
    expect(await list()).toEqual([expect.objectContaining({ type: 'diff', diff: 1 })])
    expect((await send('/api/review/ack-diff', 'POST', { expenseId: p })).status).toBe(200)
    expect(await list()).toEqual([])
    // 支出の額を直して差が -1 → また出る
    await send(`/api/expenses/${p}`, 'PUT', {
      spentOn: day(10),
      storeName: '店',
      paymentMethod: 'rakuten_card',
      items: [{ name: 'x', categoryId: 1, taxRate: null, baseAmount: 1002, stockItemId: null, stockQuantity: null }],
      adjustments: [],
    })
    expect(await list()).toEqual([expect.objectContaining({ type: 'diff', diff: -1 })])
  })
  it('「別の買い物」で外すと、行は明細の支出になり、組は候補に戻らない', async () => {
    const { p, r } = await linkedWithDiff()
    expect((await send('/api/review/reject', 'POST', { chargeId: r, expenseId: p })).status).toBe(200)
    const ch = await db.prepare('SELECT expense_origin FROM card_charges WHERE id = ?').bind(r).first<{ expense_origin: string }>()
    expect(ch!.expense_origin).toBe('statement_purchase')
    expect((await list()).some((i) => i.type === 'row_candidates')).toBe(false)
  })
})

describe('支出 1 : 明細の行 N(通販の分割発送)', () => {
  it('2 行を 1 つの支出に足すと、差は 0 になり明細の支出は消える', async () => {
    const p = await saveExpense(day(10), 5000)
    await importCsv([
      { date: day(12), amount: 3200, shop: 'A' },
      { date: day(14), amount: 1800, shop: 'B' },
    ])
    const [r1, r2] = await chargeIds()
    await send('/api/review/link', 'POST', { chargeId: r1, expenseId: p })
    await send('/api/review/link', 'POST', { chargeId: r2, expenseId: p })
    expect(await list()).toEqual([])
    const origins = (await db.prepare('SELECT origin FROM expenses').all<{ origin: string }>()).results.map((r) => r.origin)
    expect(origins).toEqual(['person'])
  })
  it('人の支出に結ばれた行は付け替えられない(先に外す)', async () => {
    const a = await saveExpense(day(10), 100)
    const b = await saveExpense(day(11), 100)
    await importCsv([{ date: day(10), amount: 100 }])
    const [r] = await chargeIds()
    const ch = await db.prepare('SELECT expense_id FROM card_charges WHERE id = ?').bind(r).first<{ expense_id: number }>()
    expect(ch!.expense_id).toBe(a)
    expect((await send('/api/review/link', 'POST', { chargeId: r, expenseId: b })).status).toBe(409)
  })
})

// 表の行の検査(基盤 §6)で見つかったテストの無い行(A-1 の 1 行・A-2 の 2 行・表 B の B1・B2・B4・B5・B8・B9)
async function editExpense(id: number, spentOn: string, amount: number, paymentMethod = 'rakuten_card') {
  const res = await send(`/api/expenses/${id}`, 'PUT', {
    spentOn,
    storeName: '店',
    paymentMethod,
    items: [{ name: 'x', categoryId: 1, taxRate: null, baseAmount: amount, stockItemId: null, stockQuantity: null }],
    adjustments: [],
  })
  expect(res.status).toBe(200)
}
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const chargeRows = async () =>
  (await db.prepare('SELECT id, expense_id, expense_origin FROM card_charges ORDER BY id').all<{ id: number; expense_id: number | null; expense_origin: string | null }>()).results
const mergeFor = async (p: number) => (await list()).find((i) => i.type === 'merge_candidates' && i.expense!.id === p)

describe('表 A-1・表 A-2 の残りの行', () => {
  it('A-1 の 1 行: 人の支出に結ばれた行は、同じ日・同じ額の支出が増えても外さない', async () => {
    const p1 = await saveExpense(day(10), 400)
    await importCsv([{ date: day(10), amount: 400 }])
    expect((await chargeRows())[0]).toMatchObject({ expense_id: p1, expense_origin: 'person' })
    await saveExpense(day(10), 400)
    expect((await chargeRows())[0]).toMatchObject({ expense_id: p1, expense_origin: 'person' })
  })
  it('A-2 の 2 行: 候補が結ばれていない行だけの支出は、P の項目を出さない(L1 の候補として出る)', async () => {
    const p = await saveExpense(day(10), 500)
    await importCsv([{ date: day(12), amount: 500 }])
    const items = await list()
    expect(items).toEqual([expect.objectContaining({ type: 'row_candidates', candidates: [expect.objectContaining({ id: p })] })])
  })
})

describe('表 B(明細の支出のある行と、保存・直した人の支出 P)', () => {
  it('B1: P に結んだ行があれば、明細の支出の行とは関係しない', async () => {
    const p = await saveExpense(day(5), 700)
    await importCsv([{ date: day(5), amount: 700, shop: 'A' }, { date: day(10), amount: 700, shop: 'B' }])
    const [x, r] = await chargeRows()
    expect(x).toMatchObject({ expense_id: p, expense_origin: 'person' })
    expect(r!.expense_origin).toBe('statement_purchase')
    await editExpense(p, day(10), 700) // 同じ日・同じ額になっても P は自由でない
    expect((await chargeRows())[1]!.expense_origin).toBe('statement_purchase')
    expect(await mergeFor(p)).toBeUndefined()
  })
  it('B2: 拒否済みの組は、同じ日・同じ額に直してもまとめない', async () => {
    await importCsv([{ date: day(10), amount: 1200 }])
    const p = await saveExpense(day(12), 1200)
    const [r] = await chargeRows()
    expect((await send('/api/review/reject', 'POST', { chargeId: r!.id, expenseId: p })).status).toBe(200)
    await editExpense(p, day(10), 1200)
    expect((await chargeRows())[0]!.expense_origin).toBe('statement_purchase')
    expect(await mergeFor(p)).toBeUndefined()
  })
  it('B4: 日の差 31 日は関係しない。境の 30 日は B6 でまとめる候補', async () => {
    await importCsv([{ date: day(1), amount: 900 }])
    const far = await saveExpense(addDays(day(1), 31), 900)
    expect(await mergeFor(far)).toBeUndefined()
    const near = await saveExpense(addDays(day(1), 30), 900)
    expect(await mergeFor(near)).toBeDefined()
    expect((await chargeRows())[0]!.expense_origin).toBe('statement_purchase')
  })
  it('B5: 日の差 1〜30 日で方法が矛盾する(現金)なら関係しない', async () => {
    await importCsv([{ date: day(10), amount: 600 }])
    const p = await saveExpense(day(11), 600, 'cash')
    expect(await mergeFor(p)).toBeUndefined()
    expect((await chargeRows())[0]!.expense_origin).toBe('statement_purchase')
  })
  it('B8: 同じ日・同じ額でも D(P) が 2 つ(明細の支出が 2 行)なら自動でまとめず、まとめる候補に両方出す', async () => {
    await importCsv([{ date: day(10), amount: 1200, shop: 'A' }, { date: day(10), amount: 1200, shop: 'B' }])
    const p = await saveExpense(day(10), 1200)
    expect((await chargeRows()).map((c) => c.expense_origin)).toEqual(['statement_purchase', 'statement_purchase'])
    expect((await mergeFor(p))!.charges).toHaveLength(2)
  })
  it('B9: 同じ日・同じ額で方法が矛盾する(現金)なら、自動でまとめずまとめる候補に出す', async () => {
    await importCsv([{ date: day(10), amount: 1200 }])
    const p = await saveExpense(day(10), 1200, 'cash')
    expect((await chargeRows())[0]!.expense_origin).toBe('statement_purchase')
    expect(await mergeFor(p)).toBeDefined()
  })
})

describe('探して足す(データと照合 §4.9)', () => {
  type Found = { expenses?: { id: number; amount: number }[]; charges?: { id: number; amount: number }[] }
  const search = async (q: string) => (await send(`/api/review/search?${q}`, 'GET')).json<Found>()
  it('明細の行から: 前後 31 日の人の支出を、額の差・日付の差の小さい順に。拒否した組と 32 日離れたものは出さない', async () => {
    await importCsv([{ date: day(10), amount: 1000 }])
    const [row] = await chargeIds()
    // 明細の取り込みで行は明細の支出になる(同じ額の支出が無い)。その後に人の支出を作る
    const near = await saveExpense(day(11), 1100)
    const exact = await saveExpense(day(20), 900)
    const farDate = new Date(Date.parse(`${day(10)}T00:00:00Z`) + 32 * 86_400_000).toISOString().slice(0, 10)
    await saveExpense(farDate, 1000)
    const rejected = await saveExpense(day(12), 1000)
    expect((await send('/api/review/reject', 'POST', { chargeId: row, expenseId: rejected })).status).toBe(200)
    const found = await search(`charge=${row}`)
    expect(found.expenses!.map((e) => e.id)).toEqual([near, exact])
  })
  it('人の支出から: 人の支出に結ばれていない行(明細の支出の行を含む)を額の差の小さい順に', async () => {
    await importCsv([
      { date: day(10), amount: 1000, shop: 'A' },
      { date: day(11), amount: 2000, shop: 'B' },
    ])
    const [a, b] = await chargeIds()
    const p = await saveExpense(day(15), 1900, 'cash')
    const found = await search(`expense=${p}`)
    expect(found.charges!.map((c) => c.id)).toEqual([b, a])
  })
  it('引数はどちらか 1 つ。相手が無ければ 404', async () => {
    expect((await send('/api/review/search', 'GET')).status).toBe(400)
    expect((await send('/api/review/search?charge=1&expense=1', 'GET')).status).toBe(400)
    expect((await send('/api/review/search?charge=999999', 'GET')).status).toBe(404)
    expect((await send('/api/review/search?expense=999999', 'GET')).status).toBe(404)
  })
  it('一覧の口は支払い方法の名前も返す', async () => {
    const body = await (await send('/api/review', 'GET')).json<{ paymentMethods: { code: string; label: string }[] }>()
    expect(body.paymentMethods.find((p) => p.code === 'cash')).toEqual({ code: 'cash', label: '現金' })
  })
})
