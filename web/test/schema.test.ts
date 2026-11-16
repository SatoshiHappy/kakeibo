// 設計書 §1 の制約が D1 で期待どおり働くことを確かめる(§1.1 の最後の項・§1.9・§1.13 の【未確認】)。
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { addUser } from './helpers'

const db = env.DB
const now = '2026-11-15T00:00:00Z'
let userId: number
let seq = 0

beforeAll(async () => {
  await addUser('schema@example.com')
  userId = (await db.prepare("SELECT id FROM users WHERE email = 'schema@example.com'").first<{ id: number }>())!.id
})

async function insertExpense(opts: { origin?: string; spentOn?: string; feeChargeId?: number | null } = {}) {
  seq += 1
  const res = await db
    .prepare(
      `INSERT INTO expenses (origin, client_request_id, fee_charge_id, spent_on, store_name, payment_method, registered_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 'cash', ?, ?, ?)`,
    )
    .bind(opts.origin ?? 'person', `req-${seq}`, opts.feeChargeId ?? null, opts.spentOn ?? '2026-11-01', userId, now, now)
    .run()
  return res.meta.last_row_id
}

async function insertImport() {
  seq += 1
  const res = await db
    .prepare(
      `INSERT INTO statement_imports (client_request_id, billing_month, imported_by, imported_at, rows_in_file, rows_new, rows_changed, rows_missing)
       VALUES (?, '2026-11', ?, ?, 0, 0, 0, 0)`,
    )
    .bind(`imp-${seq}`, userId, now)
    .run()
  return res.meta.last_row_id
}

async function insertCharge(importId: number, opts: { amountCell?: string; amount?: number | null; expenseId?: number | null; expenseOrigin?: string | null; ordinal?: number } = {}) {
  const res = await db
    .prepare(
      `INSERT INTO card_charges (import_id, billing_month, used_on, merchant, card_user, payment_type, amount_cell, amount, fee, ordinal, expense_id, expense_origin)
       VALUES (?, '2026-11', '2026-10-11', 'shop', '本人', '1回払い', ?, ?, 0, ?, ?, ?)`,
    )
    .bind(
      importId,
      opts.amountCell ?? '100',
      opts.amount === undefined ? 100 : opts.amount,
      opts.ordinal ?? ++seq,
      opts.expenseId ?? null,
      opts.expenseOrigin ?? null,
    )
    .run()
  return res.meta.last_row_id
}

describe('STRICT の表', () => {
  it('INTEGER の列に文字は入らない', async () => {
    await expect(
      db.prepare("INSERT INTO categories (name, sort_order, kind) VALUES ('x-strict', 'abc', 'variable')").run(),
    ).rejects.toThrow(/cannot store TEXT value in INTEGER column/)
  })
})

describe('日付・月の CHECK', () => {
  it('正しい日付は入る', async () => {
    await expect(insertExpense({ spentOn: '2026-02-28' })).resolves.toBeGreaterThan(0)
  })
  it.each(['2026-02-30', '2026-13-01', '2026/11/01', 'abc', '2026-1-1'])('読めない日付 %s は入らない', async (d) => {
    await expect(insertExpense({ spentOn: d })).rejects.toThrow(/CHECK constraint failed/)
  })
  it('読めない月は入らない', async () => {
    await expect(
      db.prepare("INSERT INTO budgets (category_id, from_month, amount) VALUES (1, '2026-13', 100)").run(),
    ).rejects.toThrow(/CHECK constraint failed/)
  })
})

describe('利用者のメール', () => {
  it('大文字を含むメールは入らない', async () => {
    await expect(addUser('Upper@example.com')).rejects.toThrow(/CHECK constraint failed/)
  })
})

describe('参照の表の外部キー', () => {
  it('知らない支払い方法は入らない', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO expenses (origin, client_request_id, spent_on, store_name, payment_method, registered_by, created_at, updated_at)
           VALUES ('person', 'fk-test', '2026-11-01', '', 'bitcoin', ?, ?, ?)`,
        )
        .bind(userId, now, now)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })
})

describe('手数料の支出と元の行', () => {
  it('statement_fee なのに元の行が無い支出は入らない', async () => {
    await expect(insertExpense({ origin: 'statement_fee' })).rejects.toThrow(/CHECK constraint failed/)
  })
  it('person なのに元の行がある支出は入らない', async () => {
    const charge = await insertCharge(await insertImport())
    await expect(insertExpense({ origin: 'person', feeChargeId: charge })).rejects.toThrow(/CHECK constraint failed/)
  })
})

describe('明細の行(card_charges)', () => {
  it('利用金額 - の行は額が NULL で入る', async () => {
    await expect(insertCharge(await insertImport(), { amountCell: '-', amount: null })).resolves.toBeGreaterThan(0)
  })
  it('利用金額 - の行は結べない', async () => {
    const expense = await insertExpense()
    await expect(
      insertCharge(await insertImport(), { amountCell: '-', amount: null, expenseId: expense, expenseOrigin: 'person' }),
    ).rejects.toThrow(/CHECK constraint failed/)
  })
  it('額の文字と数が合わない行は入らない', async () => {
    await expect(insertCharge(await insertImport(), { amountCell: '100', amount: 200 })).rejects.toThrow(/CHECK constraint failed/)
  })
  it('同じ行の鍵は 2 度入らない', async () => {
    const imp = await insertImport()
    await insertCharge(imp, { ordinal: 1, amountCell: '777', amount: 777 })
    await expect(insertCharge(imp, { ordinal: 1, amountCell: '777', amount: 777 })).rejects.toThrow(/UNIQUE constraint failed/)
  })
  it('出所の写しが支出と食い違うと入らない(複合の外部キー)', async () => {
    const expense = await insertExpense({ origin: 'person' })
    await expect(
      insertCharge(await insertImport(), { expenseId: expense, expenseOrigin: 'statement_purchase' }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })
  it('人の支出には複数の行を結べる', async () => {
    const expense = await insertExpense({ origin: 'person' })
    const imp = await insertImport()
    await insertCharge(imp, { expenseId: expense, expenseOrigin: 'person' })
    await expect(insertCharge(imp, { expenseId: expense, expenseOrigin: 'person' })).resolves.toBeGreaterThan(0)
  })
  it('明細の支出を指す行は 1 つまで(部分の一意の索引)', async () => {
    const expense = await insertExpense({ origin: 'statement_purchase' })
    const imp = await insertImport()
    await insertCharge(imp, { expenseId: expense, expenseOrigin: 'statement_purchase' })
    await expect(
      insertCharge(imp, { expenseId: expense, expenseOrigin: 'statement_purchase' }),
    ).rejects.toThrow(/UNIQUE constraint failed/)
  })
  it('支出を消すと行は結ばれていない状態に戻る(ON DELETE SET NULL)', async () => {
    const expense = await insertExpense({ origin: 'person' })
    const charge = await insertCharge(await insertImport(), { expenseId: expense, expenseOrigin: 'person' })
    await db.prepare('DELETE FROM expenses WHERE id = ?').bind(expense).run()
    const row = await db.prepare('SELECT expense_id, expense_origin FROM card_charges WHERE id = ?').bind(charge).first()
    expect(row).toEqual({ expense_id: null, expense_origin: null })
  })
})

describe('規則が指す費目(トリガー)', () => {
  it('未分類はやめられない', async () => {
    await expect(
      db.prepare(`UPDATE categories SET retired_at = ? WHERE id = (SELECT category_id FROM system_categories WHERE role = 'uncategorized')`).bind(now).run(),
    ).rejects.toThrow(/system category cannot be retired/)
  })
  it('ふつうの費目はやめられる', async () => {
    await expect(db.prepare('UPDATE categories SET retired_at = ? WHERE id = 1').bind(now).run()).resolves.toBeTruthy()
    await db.prepare('UPDATE categories SET retired_at = NULL WHERE id = 1').run()
  })
  it('system_categories は書き換えられない・消せない', async () => {
    await expect(db.prepare("UPDATE system_categories SET category_id = 1 WHERE role = 'uncategorized'").run()).rejects.toThrow(/system_categories is fixed/)
    await expect(db.prepare("DELETE FROM system_categories WHERE role = 'uncategorized'").run()).rejects.toThrow(/system_categories is fixed/)
  })
  it('規則が指す費目は未分類だけ(手数料は置かない)', async () => {
    await expect(db.prepare("INSERT INTO system_categories (role, category_id) VALUES ('fee', 1)").run()).rejects.toThrow(/CHECK constraint failed/)
  })
})

describe('初期の費目(要求「費目」)', () => {
  it('19 個。種類は 毎月変わる・固定費(家賃・通信)・臨時(旅行〜臨時その他)。手数料・臨時支出は無い', async () => {
    const { results } = await db.prepare('SELECT name, kind FROM categories ORDER BY sort_order').all<{ name: string; kind: string }>()
    expect(results).toHaveLength(19)
    const by = (k: string) => results.filter((r) => r.kind === k).map((r) => r.name)
    expect(by('fixed')).toEqual(['家賃', '通信'])
    expect(by('extra')).toEqual(['旅行', '引っ越し', '結婚', '家電', '臨時その他'])
    expect(by('variable')).toHaveLength(12)
    expect(results.map((r) => r.name)).not.toContain('手数料')
    expect(results.map((r) => r.name)).not.toContain('臨時支出')
  })
  it('種類は参照の表の値だけ(外部キー)', async () => {
    await expect(db.prepare("UPDATE categories SET kind = 'monthly' WHERE id = 1").run()).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })
})

// §1.14〜§1.16 在庫と通知の宛先
async function insertStockItem(name: string, notifyDays = 7) {
  const res = await db
    .prepare('INSERT INTO stock_items (name, notify_days, created_by, created_at) VALUES (?, ?, ?, ?)')
    .bind(name, notifyDays, userId, now)
    .run()
  return res.meta.last_row_id
}

describe('在庫の品物(stock_items)', () => {
  it('知らせる日数は 0〜365(境の両側)', async () => {
    await expect(insertStockItem('notify-0', 0)).resolves.toBeGreaterThan(0)
    await expect(insertStockItem('notify-365', 365)).resolves.toBeGreaterThan(0)
    await expect(insertStockItem('notify-neg', -1)).rejects.toThrow(/CHECK constraint failed/)
    await expect(insertStockItem('notify-366', 366)).rejects.toThrow(/CHECK constraint failed/)
  })
  it('名前は空にできず、重ならない', async () => {
    await expect(insertStockItem('  ')).rejects.toThrow(/CHECK constraint failed/)
    await insertStockItem('dup-item')
    await expect(insertStockItem('dup-item')).rejects.toThrow(/UNIQUE constraint failed/)
  })
})

describe('品目の品物と個数', () => {
  const insertItem = async (stockItemId: number | null, quantity: number | null) => {
    const expenseId = await insertExpense()
    return db
      .prepare(
        `INSERT INTO items (expense_id, position, name, category_id, base_amount, amount, stock_item_id, stock_quantity)
         VALUES (?, 1, 'x', 1, 100, 100, ?, ?)`,
      )
      .bind(expenseId, stockItemId, quantity)
      .run()
  }
  it('品物と個数(1 以上)の組は入る。どちらも無しも入る', async () => {
    const s = await insertStockItem('item-ok')
    await expect(insertItem(s, 1)).resolves.toBeTruthy()
    await expect(insertItem(null, null)).resolves.toBeTruthy()
  })
  it('片方だけは入らない', async () => {
    const s = await insertStockItem('item-half')
    await expect(insertItem(s, null)).rejects.toThrow(/CHECK constraint failed/)
    await expect(insertItem(null, 1)).rejects.toThrow(/CHECK constraint failed/)
  })
  it('個数 0 は入らない(返品は減らさない)', async () => {
    const s = await insertStockItem('item-zero')
    await expect(insertItem(s, 0)).rejects.toThrow(/CHECK constraint failed/)
  })
  it('無い品物は指せない', async () => {
    await expect(insertItem(999999, 1)).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })
  it('支出を消すと品目ごと消え、数に入らなくなる(CASCADE)', async () => {
    const s = await insertStockItem('item-cascade')
    const expenseId = await insertExpense()
    await db
      .prepare(`INSERT INTO items (expense_id, position, name, category_id, base_amount, amount, stock_item_id, stock_quantity) VALUES (?, 1, 'x', 1, 100, 100, ?, 2)`)
      .bind(expenseId, s)
      .run()
    await db.prepare('DELETE FROM expenses WHERE id = ?').bind(expenseId).run()
    const left = await db.prepare('SELECT count(*) AS n FROM items WHERE stock_item_id = ?').bind(s).first<{ n: number }>()
    expect(left!.n).toBe(0)
  })
})

describe('在庫の動き(stock_moves)', () => {
  const insertMove = async (kind: string, delta: number, counted: number | null) => {
    const s = await insertStockItem(`move-${++seq}`)
    return db
      .prepare('INSERT INTO stock_moves (stock_item_id, kind, delta, counted, moved_by, moved_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(s, kind, delta, counted, userId, now)
      .run()
  }
  it('使った = delta −1・counted なし', async () => {
    await expect(insertMove('use', -1, null)).resolves.toBeTruthy()
    await expect(insertMove('use', -2, null)).rejects.toThrow(/CHECK constraint failed/)
    await expect(insertMove('use', -1, 3)).rejects.toThrow(/CHECK constraint failed/)
  })
  it('入れ直し = counted が 0 以上(delta は差なのでどの値も可)', async () => {
    await expect(insertMove('count', -5, 0)).resolves.toBeTruthy()
    await expect(insertMove('count', 3, 3)).resolves.toBeTruthy()
    await expect(insertMove('count', 0, null)).rejects.toThrow(/CHECK constraint failed/)
    await expect(insertMove('count', -1, -1)).rejects.toThrow(/CHECK constraint failed/)
  })
  it('種類は使った・入れ直しだけ(買った分は品目が持つ)', async () => {
    await expect(insertMove('buy', 1, null)).rejects.toThrow(/CHECK constraint failed/)
  })
})

describe('通知の宛先(push_subscriptions)', () => {
  const insertSub = (endpoint: string) =>
    db
      .prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(userId, endpoint, 'p', 'a', now, now)
      .run()
  it('https の送り先だけ・同じ送り先は 1 行', async () => {
    await expect(insertSub('https://web.push.apple.com/abc')).resolves.toBeTruthy()
    await expect(insertSub('https://web.push.apple.com/abc')).rejects.toThrow(/UNIQUE constraint failed/)
    await expect(insertSub('http://example.com/x')).rejects.toThrow(/CHECK constraint failed/)
  })
})
