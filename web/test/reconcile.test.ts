// 取り込み(表 C の C10〜C16)と照合(表 A-1・表 B・§2.2〜§2.4)を口から通す
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { accessToken, addUser, request, serveTestCerts } from './helpers'

let token: string
let seq = 0
const db = env.DB

// 今日から見た「先月の日付」と請求月(今月)を作る。見出しの M は今月の月
const now = new Date(Date.now() + 9 * 3600_000)
const thisMonth = now.toISOString().slice(0, 7)
const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
const prevMonth = prev.toISOString().slice(0, 7)
const day = (d: number) => `${prevMonth}-${String(d).padStart(2, '0')}`
const m = Number(thisMonth.slice(5, 7))
const HEADER = `"利用日","利用店名・商品名","利用者","支払方法","利用金額","手数料/利息","支払総額","${m}月支払金額","当月請求額","${(m % 12) + 1}月繰越残高","新規サイン"`

type Line = { date: string; shop?: string; amount: number | '-'; fee?: number; payment?: string }
const csv = (lines: Line[]) =>
  [
    HEADER,
    ...lines.map(
      (l) =>
        `"${l.date.replace(/-/g, '/')}","${l.shop ?? 'ショップ'}","本人","${l.payment ?? '1回払い'}","${l.amount}","${l.fee ?? 0}","${l.amount}","${l.amount}","${l.amount}","0","*"`,
    ),
  ].join('\n')

beforeEach(async () => {
  serveTestCerts()
  await addUser('alice@example.com', 'アリス')
  token = await accessToken()
  // テストごとに明細とすべての支出を消して始める(D1 はファイルの中でテストどうし共有されるため)
  await db.batch([
    db.prepare('DELETE FROM match_rejections'),
    db.prepare('DELETE FROM expenses'),
    db.prepare('DELETE FROM card_charges'),
    db.prepare('DELETE FROM statement_imports'),
  ])
})

const auth = () => ({ 'cf-access-jwt-assertion': token })

async function importCsv(lines: Line[]) {
  const form = new FormData()
  form.set('file', new File([csv(lines)], 'enavi.csv', { type: 'text/csv' }))
  const res = await request('/api/statements', { method: 'POST', headers: auth(), body: form })
  return { status: res.status, body: await res.json<Record<string, unknown>>() }
}

async function saveExpense(spentOn: string, amount: number, paymentMethod = 'rakuten_card') {
  const res = await request('/api/expenses', {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: `e-${++seq}`,
      receiptId: null,
      spentOn,
      storeName: 'レシートの店',
      paymentMethod,
      items: [{ name: '品物', categoryId: 1, taxRate: null, baseAmount: amount }],
      adjustments: [],
    }),
  })
  expect(res.status).toBe(201)
  return (await res.json<{ id: number }>()).id
}

const charges = async () =>
  (await db.prepare('SELECT id, used_on, amount, fee, expense_id, expense_origin FROM card_charges ORDER BY id').all()).results as {
    id: number
    used_on: string
    amount: number | null
    fee: number
    expense_id: number | null
    expense_origin: string | null
  }[]
const expenseRows = async () =>
  (await db.prepare('SELECT id, origin, spent_on, (SELECT SUM(amount) FROM items WHERE expense_id = e.id) AS amount FROM expenses e ORDER BY id').all())
    .results as { id: number; origin: string; spent_on: string; amount: number }[]

describe('取り込み(表 C)', () => {
  it('C14: 候補の無い新しい行は明細の支出(未分類)になる', async () => {
    const r = await importCsv([{ date: day(10), amount: 1200 }])
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ billingMonth: thisMonth, rowsNew: 1 })
    const [ch] = await charges()
    expect(ch.expense_origin).toBe('statement_purchase')
    const cat = await db.prepare('SELECT i.category_id, sc.role FROM items i JOIN system_categories sc ON sc.category_id = i.category_id WHERE i.expense_id = ?').bind(ch.expense_id).first()
    expect(cat).toMatchObject({ role: 'uncategorized' })
  })
  it('「未分類」の行(system_categories)が無ければ、品目の費目が NOT NULL で断られ batch ごと何も書かない(§1.3)', async () => {
    const row = (await db.prepare("SELECT category_id FROM system_categories WHERE role = 'uncategorized'").first<{ category_id: number }>())!
    // 消すのはトリガーが止める(起きない作り)ので、試しの間だけ外して無い状態を作る
    await db.prepare('DROP TRIGGER system_categories_no_delete').run()
    await db.prepare("DELETE FROM system_categories WHERE role = 'uncategorized'").run()
    try {
      const r = await importCsv([{ date: day(10), amount: 1200 }])
      expect(r.status).toBe(500)
      expect(await charges()).toEqual([])
      expect(await expenseRows()).toEqual([])
    } finally {
      await db.prepare("INSERT INTO system_categories (role, category_id) VALUES ('uncategorized', ?)").bind(row.category_id).run()
      await db.prepare("CREATE TRIGGER system_categories_no_delete BEFORE DELETE ON system_categories BEGIN SELECT RAISE(ABORT, 'system_categories is fixed'); END").run()
    }
    await expect(db.prepare("DELETE FROM system_categories WHERE role = 'uncategorized'").run()).rejects.toThrow('system_categories is fixed')
  })
  it('C10: 同じファイルの取り込み直しは何も増やさない', async () => {
    await importCsv([{ date: day(10), amount: 1200 }])
    const r = await importCsv([{ date: day(10), amount: 1200 }])
    expect(r.body).toMatchObject({ rowsNew: 0, rowsChanged: 0, rowsMissing: 0 })
    expect(await charges()).toHaveLength(1)
    expect(await expenseRows()).toHaveLength(1)
  })
  it('C11: 支払方法・手数料が変わった行は飛ばして「変わった行」に数える', async () => {
    await importCsv([{ date: day(10), amount: 1200 }])
    const r = await importCsv([{ date: day(10), amount: 1200, payment: '分割', fee: 30 }])
    expect(r.body).toMatchObject({ rowsNew: 0, rowsChanged: 1 })
    expect((await charges())[0].fee).toBe(0)
  })
  it('C12: 利用金額 - ・手数料 0 は行だけ入れる(照合しない)', async () => {
    await importCsv([{ date: day(1), amount: '-' }, { date: day(10), amount: 100 }])
    const dash = (await charges()).find((c) => c.amount === null)!
    expect(dash.expense_id).toBeNull()
  })
  it('C13・C15: 手数料が 0 でなければ手数料の支出(請求月の 1 日)を作る(境: -1・0・1)', async () => {
    await importCsv([
      { date: day(1), amount: '-', fee: 1, shop: 'A' },
      { date: day(2), amount: 500, fee: 0, shop: 'B' },
      { date: day(3), amount: 600, fee: -1, shop: 'C' },
    ])
    const fees = (await expenseRows()).filter((e) => e.origin === 'statement_fee')
    expect(fees.map((f) => [f.spent_on, f.amount]).sort()).toEqual([
      [`${thisMonth}-01`, -1],
      [`${thisMonth}-01`, 1],
    ])
  })
  it('C16: 前回にあって今回に無い行を数える(消さない)', async () => {
    await importCsv([{ date: day(10), amount: 1200, shop: 'A' }, { date: day(11), amount: 300, shop: 'B' }])
    const r = await importCsv([{ date: day(10), amount: 1200, shop: 'A' }])
    expect(r.body).toMatchObject({ rowsMissing: 1 })
    expect(await charges()).toHaveLength(2)
  })
  it('止めた取り込みは何も書かない', async () => {
    const form = new FormData()
    form.set('file', new File(['"x"\n'], 'a.csv'))
    const res = await request('/api/statements', { method: 'POST', headers: auth(), body: form })
    expect(res.status).toBe(422)
    expect((await db.prepare('SELECT count(*) AS n FROM statement_imports').first<{ n: number }>())!.n).toBe(0)
  })
})

describe('照合: レシートが先、明細が後', () => {
  it('同じ日・同じ額は自動で結ぶ(表 A-1 の 2 行)。明細の支出は作らない', async () => {
    const p = await saveExpense(day(10), 1200)
    await importCsv([{ date: day(10), amount: 1200 }])
    const [ch] = await charges()
    expect(ch).toMatchObject({ expense_id: p, expense_origin: 'person' })
    expect(await expenseRows()).toHaveLength(1)
  })
  it('日付がずれた候補は結ばず、明細の支出も作らない(6 行)', async () => {
    await saveExpense(day(10), 1200)
    await importCsv([{ date: day(12), amount: 1200 }])
    const [ch] = await charges()
    expect(ch.expense_id).toBeNull()
    expect(await expenseRows()).toHaveLength(1)
  })
  it('現金の支出は同じ日でも自動では結ばない(3 行)', async () => {
    await saveExpense(day(10), 1200, 'cash')
    await importCsv([{ date: day(10), amount: 1200 }])
    expect((await charges())[0].expense_id).toBeNull()
  })
})

describe('照合: 明細が先、レシートが後(表 B)', () => {
  it('B7: 同じ日・同じ額のレシートは明細の支出と自動でまとまる', async () => {
    await importCsv([{ date: day(10), amount: 1200 }])
    const [before] = await charges()
    expect(before.expense_origin).toBe('statement_purchase')
    const p = await saveExpense(day(10), 1200)
    const [after] = await charges()
    expect(after).toMatchObject({ expense_id: p, expense_origin: 'person' })
    const rows = await expenseRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].origin).toBe('person')
  })
  it('B6: 日付がずれたレシートはまとめない(明細の支出は残る)', async () => {
    await importCsv([{ date: day(10), amount: 1200 }])
    await saveExpense(day(12), 1200)
    expect((await charges())[0].expense_origin).toBe('statement_purchase')
    expect(await expenseRows()).toHaveLength(2)
  })
  it('B3: 額が違うレシートは関係しない', async () => {
    await importCsv([{ date: day(10), amount: 1200 }])
    await saveExpense(day(10), 1100)
    expect((await charges())[0].expense_origin).toBe('statement_purchase')
  })
})

describe('人の支出を消す・直す(§2.2)', () => {
  it('結ばれた支出を消すと、行は明細の支出に戻る(候補が無くなる → 7 行)', async () => {
    const p = await saveExpense(day(10), 1200)
    await importCsv([{ date: day(10), amount: 1200 }])
    const res = await request(`/api/expenses/${p}`, { method: 'DELETE', headers: auth() })
    expect(res.status).toBe(204)
    const [ch] = await charges()
    expect(ch.expense_origin).toBe('statement_purchase')
    expect((await expenseRows()).map((e) => e.origin)).toEqual(['statement_purchase'])
  })
  it('候補だった支出の日付を直して候補でなくなると、行は明細の支出になる', async () => {
    const p = await saveExpense(day(10), 1200)
    await importCsv([{ date: day(12), amount: 1200 }]) // 6 行: 何もしない
    expect((await charges())[0].expense_id).toBeNull()
    const res = await request(`/api/expenses/${p}`, {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({
        spentOn: day(10),
        storeName: 'x',
        paymentMethod: 'rakuten_card',
        items: [{ name: '品物', categoryId: 1, taxRate: null, baseAmount: 999, stockItemId: null, stockQuantity: null }], // 額を変えた
        adjustments: [],
      }),
    })
    expect(res.status).toBe(200)
    expect((await charges())[0].expense_origin).toBe('statement_purchase')
  })
  it('明細の支出は消せない', async () => {
    await importCsv([{ date: day(10), amount: 1200 }])
    const [e] = await expenseRows()
    expect((await request(`/api/expenses/${e.id}`, { method: 'DELETE', headers: auth() })).status).toBe(409)
  })
})

describe('手数料の支出の費目(表 F)', () => {
  // 楽天カードで払った人の支出を、品目ごとの [費目, 額] で作る
  async function saveItems(spentOn: string, items: [number, number][]) {
    const res = await request('/api/expenses', {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: `f-${++seq}`,
        receiptId: null,
        spentOn,
        storeName: 'レシートの店',
        paymentMethod: 'rakuten_card',
        items: items.map(([categoryId, baseAmount]) => ({ name: '品物', categoryId, taxRate: null, baseAmount })),
        adjustments: [],
      }),
    })
    expect(res.status).toBe(201)
    return (await res.json<{ id: number }>()).id
  }
  const uncategorized = async () =>
    (await db.prepare("SELECT category_id AS id FROM system_categories WHERE role = 'uncategorized'").first<{ id: number }>())!.id
  // 手数料の支出の費目を、元にした行の店の名前ごとに返す
  const feeCategories = async () =>
    Object.fromEntries(
      (
        await db
          .prepare(
            `SELECT e.store_name AS shop, i.category_id AS cat FROM expenses e JOIN items i ON i.expense_id = e.id
             WHERE e.origin = 'statement_fee'`,
          )
          .all<{ shop: string; cat: number }>()
      ).results.map((r) => [r.shop, r.cat]),
    )

  it('F1: 額のある行が結ばれていない(候補が 2 つ)なら未分類', async () => {
    await saveItems(day(5), [[1, 500]])
    await saveItems(day(5), [[3, 500]])
    await importCsv([{ date: day(5), amount: 500, fee: 30, shop: 'A' }])
    expect((await charges())[0].expense_id).toBeNull()
    expect(await feeCategories()).toEqual({ A: await uncategorized() })
  })
  it('F2: 結んだ支出の費目が 1 種類ならその費目(人の支出・明細の支出)', async () => {
    await saveItems(day(5), [[3, 500], [3, 200]])
    await importCsv([
      { date: day(5), amount: 700, fee: 30, shop: 'A' },
      { date: day(6), amount: 900, fee: 40, shop: 'B' },
    ])
    expect(await feeCategories()).toEqual({ A: 3, B: await uncategorized() })
  })
  it('F3: 費目が 2 種類以上なら額の合計が最も大きい費目。同じ額なら並び順が先(J8)', async () => {
    // 並び順と ID が逆になるように、日用品(3)を食費(1)より前に並べる
    await db.prepare('UPDATE categories SET sort_order = CASE id WHEN 1 THEN 3 WHEN 3 THEN 1 END WHERE id IN (1, 3)').run()
    try {
      await saveItems(day(5), [[1, 200], [3, 250], [1, 100]]) // 食費 300 > 日用品 250: 並び順が後でも額で食費
      await saveItems(day(6), [[1, 250], [3, 250]]) // 同じ額: 並び順が先の日用品
      await importCsv([
        { date: day(5), amount: 550, fee: 30, shop: 'A' },
        { date: day(6), amount: 500, fee: 40, shop: 'B' },
      ])
      expect(await feeCategories()).toEqual({ A: 1, B: 3 })
    } finally {
      await db.prepare('UPDATE categories SET sort_order = id WHERE id IN (1, 3)').run()
    }
  })
  it('F3: 同じ額で並び順も同じなら、費目の ID が小さい方(J8)', async () => {
    await db.prepare('UPDATE categories SET sort_order = 1 WHERE id = 3').run()
    try {
      await saveItems(day(6), [[3, 250], [1, 250]])
      await importCsv([{ date: day(6), amount: 500, fee: 40, shop: 'B' }])
      expect(await feeCategories()).toEqual({ B: 1 })
    } finally {
      await db.prepare('UPDATE categories SET sort_order = 3 WHERE id = 3').run()
    }
  })
  it('F9: 選んだ費目がやめた費目なら未分類', async () => {
    await saveItems(day(5), [[12, 700]])
    await importCsv([{ date: day(5), amount: 700, shop: 'A' }, { date: day(20), amount: 100, shop: 'Z' }])
    await db.prepare("UPDATE categories SET retired_at = '2026-11-16T00:00:00Z' WHERE id = 12").run()
    try {
      await importCsv([{ date: day(5), amount: '-', fee: 30, shop: 'A' }, { date: day(21), amount: 100, shop: 'Y' }])
      expect(await feeCategories()).toEqual({ A: await uncategorized() })
    } finally {
      await db.prepare('UPDATE categories SET retired_at = NULL WHERE id = 12').run()
    }
  })
  it('F4・F5: 額が - で、同じ利用日・店・利用者の額のある行が 0 か 2 以上なら未分類', async () => {
    await importCsv([
      { date: day(3), amount: '-', fee: 10, shop: 'ない' },
      { date: day(4), amount: 300, shop: 'ふたつ' },
      { date: day(4), amount: 400, shop: 'ふたつ' },
      { date: day(4), amount: '-', fee: 20, shop: 'ふたつ' },
    ])
    const u = await uncategorized()
    expect(await feeCategories()).toEqual({ ない: u, ふたつ: u })
  })
  it('F6・F7・F8: 額が - で、元の行がちょうど 1 つなら、その結びに従う', async () => {
    await saveItems(day(5), [[1, 500], [3, 100]]) // B の元(F8: 食費 500 > 日用品 100)
    await saveItems(day(7), [[5, 800]]) // C の元(F7)
    await saveItems(day(9), [[1, 600]]) // A の元を結ばせない候補(F6: 2 つ)
    await saveItems(day(9), [[3, 600]])
    // 1 か月目の行を先の取り込みで入れ、2 か月目の行(-)は後の取り込みで入れる(請求月を決めるため、後の取り込みにも額のある行 Z を 1 つ入れる。C7)
    await importCsv([
      { date: day(9), amount: 600, shop: 'A' },
      { date: day(5), amount: 600, shop: 'B' },
      { date: day(7), amount: 800, shop: 'C' },
    ])
    const second = await importCsv([
      { date: day(9), amount: '-', fee: 10, shop: 'A' },
      { date: day(5), amount: '-', fee: 20, shop: 'B' },
      { date: day(7), amount: '-', fee: 30, shop: 'C' },
      { date: day(20), amount: 100, shop: 'Z' },
    ])
    expect(second).toMatchObject({ status: 201 })
    expect(await feeCategories()).toEqual({ A: await uncategorized(), B: 1, C: 5 })
  })
  it('後で元の支出の費目を直しても、手数料の支出の費目はついていかない(J7)', async () => {
    await saveItems(day(5), [[3, 700]])
    await importCsv([{ date: day(5), amount: 700, fee: 30, shop: 'A' }])
    const p = (await charges())[0].expense_id!
    expect((await request(`/api/expenses/${p}/items/1`, {
      method: 'PATCH',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ categoryId: 1 }),
    })).status).toBe(200)
    expect(await feeCategories()).toEqual({ A: 3 })
  })
})

describe('整合の問い合わせ(§3.0。どれも 0 件)', () => {
  it('取り込み・保存・削除の後に食い違いが残らない', async () => {
    const a = await saveExpense(day(5), 100)
    await saveExpense(day(6), 200, 'cash')
    await importCsv([
      { date: day(5), amount: 100, shop: 'A' },
      { date: day(6), amount: 200, shop: 'B' },
      { date: day(7), amount: 300, shop: 'C' },
      { date: day(8), amount: '-', fee: 10, shop: 'D' },
    ])
    await request(`/api/expenses/${a}`, { method: 'DELETE', headers: auth() })
    const orphan = await db
      .prepare("SELECT count(*) AS n FROM expenses e WHERE e.origin = 'statement_purchase' AND NOT EXISTS (SELECT 1 FROM card_charges c WHERE c.expense_id = e.id)")
      .first<{ n: number }>()
    expect(orphan!.n).toBe(0)
    const noItems = await db.prepare('SELECT count(*) AS n FROM expenses e WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.expense_id = e.id)').first<{ n: number }>()
    expect(noItems!.n).toBe(0)
  })
})

describe('取り込みの画面の結果と取り込み済みの一覧(データと照合 §4.10)', () => {
  it('新しい行の行き先(人の支出に結んだ・明細の支出にした)と、取り込んだ後の確かめることの数を返す', async () => {
    await saveExpense(day(10), 1200)
    await saveExpense(day(20), 999) // 明細に無い → L3
    const r = await importCsv([
      { date: day(10), amount: 1200 },
      { date: day(11), amount: 500 },
    ])
    expect(r.body).toMatchObject({ rowsNew: 2, linkedToPerson: 1, statementExpenses: 1, reviewCount: 1 })
  })
  it('請求月ごとに、行の数と最後に取り込んだ時刻を新しい月から返す', async () => {
    await importCsv([{ date: day(10), amount: 1200 }])
    await importCsv([
      { date: day(10), amount: 1200 },
      { date: day(12), amount: 300 },
    ])
    const body = await (await request('/api/statements', { headers: { 'cf-access-jwt-assertion': token } })).json<{ imports: { billingMonth: string; rows: number; lastImportedAt: string }[] }>()
    expect(body.imports).toHaveLength(1)
    expect(body.imports[0]).toMatchObject({ billingMonth: thisMonth, rows: 2 })
  })
})
