// 明細の取り込みの口。正本: docs/設計/データと照合.md 表 C・§1.8・§1.9・§2.3
import { Hono } from 'hono'
import { z } from 'zod'
import { reconcileStatements, type Ref } from '../domain/reconcile'
import { parseStatementCsv, type ParsedRow } from '../domain/statement-csv'
import { reviewItems } from './review'
import { jstDate, nowIso } from '../time'
import type { AppEnv } from '../types'

const MAX_FILE_BYTES = 1024 * 1024

const keyOf = (billingMonth: string, r: Pick<ParsedRow, 'usedOn' | 'merchant' | 'cardUser' | 'amountCell' | 'ordinal'>) =>
  JSON.stringify([billingMonth, r.usedOn, r.merchant, r.cardUser, r.amountCell, r.ordinal])

function rowRef(billingMonth: string, r: ParsedRow): Ref {
  return {
    sql: `(SELECT id FROM card_charges WHERE billing_month = ? AND used_on = ? AND merchant = ? AND card_user = ? AND amount_cell = ? AND ordinal = ?)`,
    binds: [billingMonth, r.usedOn, r.merchant, r.cardUser, r.amountCell, r.ordinal],
  }
}

/** 期待の行数・合計額(表 C の C17)。MCP の道具も同じ型を使う(基盤 §5)。 */
export const expectedFields = {
  expectedRows: z.number().int().min(0).describe('見出しの 1 行を除いたデータの行の数(空の行は数えない。利用金額が - の行も数える)'),
  expectedTotal: z.number().int().describe('利用金額の列(5 列目)の和。- の行は数えない。支払総額・当月請求額の列ではない'),
}
const expectedSchema = z.object(expectedFields)

/** フォームの期待値。両方とも無ければ null、片方だけ・整数でない・型に外れるなら 'invalid'(表 C の前の要求の形の検査)。 */
function expectedOf(form: FormData): z.infer<typeof expectedSchema> | null | 'invalid' {
  const rows = form.get('expectedRows')
  const total = form.get('expectedTotal')
  if (rows === null && total === null) return null
  if (typeof rows !== 'string' || typeof total !== 'string' || !/^-?\d+$/.test(rows) || !/^-?\d+$/.test(total)) return 'invalid'
  const parsed = expectedSchema.safeParse({ expectedRows: Number(rows), expectedTotal: Number(total) })
  return parsed.success ? parsed.data : 'invalid'
}

export const statements = new Hono<AppEnv>()

statements.post('/', async (c) => {
  const form = await c.req.formData()
  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_FILE_BYTES) return c.json({ error: 'invalid_file' }, 400)
  const expected = expectedOf(form)
  if (expected === 'invalid') return c.json({ error: 'invalid_expected' }, 400)

  const parsed = parseStatementCsv(await file.arrayBuffer(), jstDate())
  if (!parsed.ok) return c.json({ error: parsed.reason, check: parsed.check }, 422)

  const { billingMonth, rows } = parsed
  // totalAmount = 利用金額の和('-' の行は数えない)。C17: 呼び手が期待値を渡したら、書く前に突き合わせる
  const totalAmount = rows.reduce((sum, r) => sum + (r.amount ?? 0), 0)
  if (expected && (expected.expectedRows !== rows.length || expected.expectedTotal !== totalAmount)) {
    return c.json({ error: 'mismatch', check: 'C17', rowsInFile: rows.length, totalAmount }, 422)
  }

  const db = c.env.DB
  const user = c.get('user')
  const { results: existing } = await db
    .prepare('SELECT used_on, merchant, card_user, amount_cell, ordinal, payment_type, fee FROM card_charges WHERE billing_month = ?')
    .bind(billingMonth)
    .all<{ used_on: string; merchant: string; card_user: string; amount_cell: string; ordinal: number; payment_type: string; fee: number }>()
  const existingByKey = new Map(
    existing.map((e) => [
      keyOf(billingMonth, { usedOn: e.used_on, merchant: e.merchant, cardUser: e.card_user, amountCell: e.amount_cell, ordinal: e.ordinal }),
      e,
    ]),
  )

  const fileKeys = new Set(rows.map((r) => keyOf(billingMonth, r)))
  const newRows: ParsedRow[] = []
  let changed = 0
  for (const r of rows) {
    const e = existingByKey.get(keyOf(billingMonth, r))
    if (!e) newRows.push(r) // C12〜C15
    else if (e.payment_type !== r.paymentType || e.fee !== r.fee) changed += 1 // C11
    // C10: 同じなら飛ばす
  }
  const missing = [...existingByKey.keys()].filter((k) => !fileKeys.has(k)).length // C16

  const now = nowIso()
  const importKey = `import-${crypto.randomUUID()}`
  const importRef = '(SELECT id FROM statement_imports WHERE client_request_id = ?)'
  const writes: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO statement_imports (client_request_id, billing_month, imported_by, imported_at, rows_in_file, rows_new, rows_changed, rows_missing)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(importKey, billingMonth, user.id, now, rows.length, newRows.length, changed, missing),
  ]
  for (const r of newRows) {
    writes.push(
      db
        .prepare(
          `INSERT INTO card_charges (import_id, billing_month, used_on, merchant, card_user, payment_type, amount_cell, amount, fee, ordinal)
           VALUES (${importRef}, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(importKey, billingMonth, r.usedOn, r.merchant, r.cardUser, r.paymentType, r.amountCell, r.amount, r.fee, r.ordinal),
    )
  }

  // 額が '-' の行は表 A-1 に掛けない(C12・C13)
  const priced = newRows.filter((r) => r.amount !== null)
  const matching = await reconcileStatements(
    c.env,
    priced.map((r) => r.usedOn),
    {
      newRows: priced.map((r, i) => ({
        id: -(i + 1),
        usedOn: r.usedOn,
        amount: r.amount!,
        statementExpenseId: null,
        ref: rowRef(billingMonth, r),
      })),
    },
  )
  // 手数料の支出(C13・C15): 日付 = 請求月の 1 日、費目 = 表 F。照合(表 A-1)が行を結んだ後に費目を決めるので、照合の後に積む
  const fees: D1PreparedStatement[] = []
  for (const r of newRows.filter((x) => x.fee !== 0)) {
    const ref = rowRef(billingMonth, r)
    const feeKey = `stmt-fee-${crypto.randomUUID()}`
    // 元の行 O: 額があれば R 自身。'-' なら同じ利用日・店・利用者で額のある行がちょうど 1 つのときだけ(F4・F5 は NULL → 未分類)
    const origin =
      r.amount !== null
        ? ref
        : {
            sql: `(SELECT CASE WHEN COUNT(*) = 1 THEN MAX(id) END FROM card_charges
                   WHERE used_on = ? AND merchant = ? AND card_user = ? AND amount IS NOT NULL)`,
            binds: [r.usedOn, r.merchant, r.cardUser],
          }
    fees.push(
      db
        .prepare(
          `INSERT INTO expenses (origin, client_request_id, fee_charge_id, spent_on, store_name, payment_method, registered_by, created_at, updated_at)
           VALUES ('statement_fee', ?, ${ref.sql}, ?, ?, 'rakuten_card', ?, ?, ?)`,
        )
        .bind(feeKey, ...ref.binds, `${billingMonth}-01`, r.merchant, user.id, now, now),
      db
        .prepare(
          // 費目: O を結んだ支出の品目で、額の合計が最も大きい費目(同じ額なら並び順、次に ID。§6 の J8)。
          // O が無い・結ばれていない・選んだ費目がやめた費目なら未分類(表 F)
          `INSERT INTO items (expense_id, position, name, category_id, tax_rate, base_amount, amount)
           VALUES ((SELECT id FROM expenses WHERE client_request_id = ?), 1, NULL,
                   COALESCE(
                     (SELECT CASE WHEN c.retired_at IS NULL THEN i.category_id END FROM items i JOIN categories c ON c.id = i.category_id
                      WHERE i.expense_id = (SELECT expense_id FROM card_charges WHERE id = ${origin.sql})
                      GROUP BY i.category_id ORDER BY SUM(i.amount) DESC, MIN(c.sort_order), i.category_id LIMIT 1),
                     (SELECT category_id FROM system_categories WHERE role = 'uncategorized')),
                   NULL, ?, ?)`,
        )
        .bind(feeKey, ...origin.binds, r.fee, r.fee),
    )
  }
  try {
    await db.batch([...writes, ...matching, ...fees])
  } catch (e) {
    // 同じ請求月を 2 人が同時に取り込んだ(行の鍵がぶつかった)。何も書かれていないので、やり直せば取り込み済みとして扱われる
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) return c.json({ error: 'conflict' }, 409)
    throw e
  }
  // 画面の結果(データと照合 §4.10): 今回入れた行の行き先と、取り込んだ後の確かめることの数
  const [dest, items] = await Promise.all([
    db
      .prepare(
        `SELECT SUM(expense_origin = 'person') AS person, SUM(expense_origin = 'statement_purchase') AS statement
         FROM card_charges WHERE import_id = (SELECT id FROM statement_imports WHERE client_request_id = ?)`,
      )
      .bind(importKey)
      .first<{ person: number | null; statement: number | null }>(),
    reviewItems(db, Number(c.env.MATCH_WINDOW_DAYS)),
  ])
  return c.json(
    {
      billingMonth,
      rowsInFile: rows.length,
      totalAmount,
      rowsNew: newRows.length,
      rowsChanged: changed,
      rowsMissing: missing,
      linkedToPerson: dest?.person ?? 0,
      statementExpenses: dest?.statement ?? 0,
      reviewCount: items.length,
    },
    201,
  )
})

// 取り込み済みの請求月(データと照合 §4.10)
statements.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.billing_month, MAX(s.imported_at) AS last, (SELECT COUNT(*) FROM card_charges ch WHERE ch.billing_month = s.billing_month) AS rows
     FROM statement_imports s GROUP BY s.billing_month ORDER BY s.billing_month DESC`,
  ).all<{ billing_month: string; last: string; rows: number }>()
  return c.json({ imports: results.map((r) => ({ billingMonth: r.billing_month, rows: r.rows, lastImportedAt: r.last })) })
})
