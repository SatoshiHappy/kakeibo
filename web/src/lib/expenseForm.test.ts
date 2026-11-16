import { describe, expect, it } from 'vitest'
import {
  adjustmentSummary,
  parseYen,
  startOf,
  toBody,
  totalLine,
  totals,
  type AiRead,
  type ExpenseDraft,
  type FormResponse,
  type ReceiptDetail,
} from './expenseForm'

const NOW = new Date('2026-11-16T10:00:00Z')
const base: FormResponse = {
  categories: [
    { id: 1, name: '食費', kind: 'variable', retired: false, systemRole: null },
    { id: 2, name: '外食', kind: 'variable', retired: true, systemRole: null },
    { id: 19, name: '未分類', kind: 'variable', retired: false, systemRole: 'uncategorized' },
  ],
  paymentMethods: [
    { code: 'rakuten_card', label: '楽天カード', cardCompatible: true },
    { code: 'cash', label: '現金', cardCompatible: false },
  ],
  stockItems: [],
  receipt: null,
  expense: null,
}
const ai: AiRead = {
  storeName: 'まるや',
  purchasedOn: '2026-11-15',
  paymentMethod: 'rakuten_card',
  items: [
    { name: '牛乳', baseAmount: 238, taxRate: 8, categoryId: 1 },
    { name: 'ランチ', baseAmount: 900, taxRate: 10, categoryId: 2 },
    { name: '謎', baseAmount: 100, taxRate: null, categoryId: 999 },
  ],
  adjustments: [{ kind: 'tax', amount: 19, taxRate: 8 }],
  printedTotal: 1257,
}
// 日本時間 11/16 00:30 に撮った(UTC では 11/15)
const receipt = (over: Partial<ReceiptDetail>): ReceiptDetail => ({
  id: 5,
  uploadedAt: '2026-11-15T15:30:00Z',
  read: 'read',
  result: ai,
  expenseId: null,
  images: [{ position: 1, stored: true }],
  ...over,
})
const withReceipt = (r: ReceiptDetail): FormResponse => ({ ...base, receipt: r })
const mode = { kind: 'receipt', receiptId: 5 } as const

describe('表 V 確かめて保存の画面の始まり', () => {
  it('V1: 読めた下書きは AI の結果。使えない費目(やめた・無い)は未分類', () => {
    const s = startOf(mode, withReceipt(receipt({})), NOW)
    if (s.row !== 'V1') throw new Error(s.row)
    expect(s.draft).toMatchObject({ storeName: 'まるや', spentOn: '2026-11-15', paymentMethod: 'rakuten_card' })
    expect(s.draft.items.map((i) => [i.name, i.categoryId, i.baseAmount, i.taxRate])).toEqual([
      ['牛乳', 1, '238', 8],
      ['ランチ', 19, '900', 10],
      ['謎', 19, '100', null],
    ])
    expect(s.draft.adjustments.map((a) => [a.kind, a.amount, a.taxRate])).toEqual([['tax', '19', 8]])
  })
  it('V1: 日付が読めなければ撮った日(日本時間)。知らない支払いのコードは選ばない', () => {
    const s = startOf(mode, withReceipt(receipt({ result: { ...ai, purchasedOn: null, paymentMethod: 'emoney' } })), NOW)
    if (s.row !== 'V1') throw new Error(s.row)
    expect(s.draft.spentOn).toBe('2026-11-16')
    expect(s.draft.paymentMethod).toBe('')
  })
  it('V2: 読み取り中は入力を出さない。「待たずに手で入力する」なら V3 の初めの値', () => {
    expect(startOf(mode, withReceipt(receipt({ read: 'reading', result: null })), NOW).row).toBe('V2')
    expect(startOf(mode, withReceipt(receipt({ read: 'reading', result: null })), NOW, true).row).toBe('V3')
  })
  it('V3: 読めなかった・時間切れは空の入力(日付は撮った日・品目 1 行は未分類・支払いは選ばない)', () => {
    for (const read of ['failed', 'timed_out'] as const) {
      const s = startOf(mode, withReceipt(receipt({ read, result: null })), NOW)
      if (s.row !== 'V3') throw new Error(s.row)
      expect(s.draft).toMatchObject({ storeName: '', spentOn: '2026-11-16', paymentMethod: '', adjustments: [] })
      expect(s.draft.items.map((i) => i.categoryId)).toEqual([19])
    }
  })
  it('V4: もう支出に保存した下書きは、その支出を直す画面へ(読み取りの状態によらない)', () => {
    expect(startOf(mode, withReceipt(receipt({ expenseId: 42, read: 'reading' })), NOW)).toEqual({ row: 'V4', to: '/expenses/42' })
  })
  it('V5: 手入力は空の入力で、日付は今日(日本時間)', () => {
    const s = startOf({ kind: 'new' }, base, NOW)
    if (s.row !== 'V5') throw new Error(s.row)
    expect(s.draft).toMatchObject({ storeName: '', spentOn: '2026-11-16', paymentMethod: '' })
  })
  it('V6: 人の支出を直すときは支出の値', () => {
    const expense = {
      id: 9,
      origin: 'person' as const,
      receiptId: null,
      spentOn: '2026-11-02',
      storeName: '薬局',
      paymentMethod: 'cash',
      items: [{ position: 1, name: null, categoryId: 2, taxRate: 10 as const, baseAmount: -50, amount: -50, stockItemId: 3, stockQuantity: 2 }],
      amount: -60,
      adjustments: [{ kind: 'discount' as const, amount: -10, taxRate: null }],
    }
    const s = startOf({ kind: 'expense', expenseId: 9 }, { ...base, expense }, NOW)
    if (s.row !== 'V6') throw new Error(s.row)
    expect(s.draft).toMatchObject({ storeName: '薬局', spentOn: '2026-11-02', paymentMethod: 'cash' })
    expect(s.draft.items[0]).toMatchObject({ name: '', categoryId: 2, baseAmount: '-50', stockItemId: 3, stockQuantity: '2' })
    expect(s.draft.adjustments[0]).toMatchObject({ kind: 'discount', amount: '-10' })
  })
  it('V7: 明細の支出は入力を出さない(費目だけ直す画面)', () => {
    const expense = { id: 9, origin: 'statement_purchase' as const, receiptId: null, spentOn: '2026-11-02', storeName: 'x', paymentMethod: 'rakuten_card', items: [], adjustments: [], amount: 0 }
    expect(startOf({ kind: 'expense', expenseId: 9 }, { ...base, expense }, NOW).row).toBe('V7')
  })
})

describe('表 T 合計の行', () => {
  it('T1: 印字の合計が無ければ合計だけ', () => {
    expect(totalLine(1000, null)).toEqual({ row: 'T1', text: null, ok: true })
  })
  it('T2: 印字の合計と等しければ「一致」', () => {
    expect(totalLine(1257, 1257)).toMatchObject({ row: 'T2', text: '✓ レシートの合計と一致', ok: true })
  })
  it('T3: 違えば違う額を出す(多くても少なくても差の大きさ)', () => {
    expect(totalLine(1250, 1257)).toMatchObject({ row: 'T3', text: 'レシートの合計 ¥1,257 と ¥7 違う', ok: false })
    expect(totalLine(1260, 1257).text).toBe('レシートの合計 ¥1,257 と ¥3 違う')
  })
})

const draft = (over: Partial<ExpenseDraft> = {}): ExpenseDraft => ({
  clientRequestId: 'c',
  storeName: ' まるや ',
  spentOn: '2026-11-15',
  paymentMethod: 'cash',
  items: [{ key: 'a', name: '牛乳', categoryId: 1, taxRate: 8, baseAmount: '1,238', stockItemId: null, stockQuantity: '' }],
  adjustments: [{ key: 'b', kind: 'tax', taxRate: 8, amount: '19' }],
  ...over,
})

describe('額と合計', () => {
  it('額は「1,280」「−20」「-20」を読み、ほかは読まない', () => {
    expect(parseYen('1,280')).toBe(1280)
    expect(parseYen('−20')).toBe(-20)
    expect(parseYen('-20')).toBe(-20)
    expect(parseYen('')).toBeNull()
    expect(parseYen('-')).toBeNull()
    expect(parseYen('1.5')).toBeNull()
  })
  it('合計 = 品目の額の合計 + 値引き・外税(読めない額は 0)', () => {
    expect(totals(draft())).toEqual({ itemsTotal: 1238, adjustmentsTotal: 19, total: 1257 })
    expect(totals(draft({ adjustments: [{ key: 'b', kind: 'discount', taxRate: null, amount: '-' }] })).total).toBe(1238)
  })
  it('値引き・外税の説明は種類ごとに率と額を並べる', () => {
    expect(
      adjustmentSummary([
        { key: '1', kind: 'tax', taxRate: 8, amount: '33' },
        { key: '2', kind: 'tax', taxRate: 10, amount: '157' },
        { key: '3', kind: 'discount', taxRate: null, amount: '-100' },
      ]),
    ).toBe('外税(8% ¥33 · 10% ¥157) · 値引き(−¥100)')
    expect(adjustmentSummary([])).toBe('')
  })
})

describe('保存の体', () => {
  it('読めれば体を作る(店名と品名の前後の空白を外し、空の品名は null)', () => {
    const r = toBody(draft({ items: [{ key: 'a', name: '  ', categoryId: 1, taxRate: null, baseAmount: '100', stockItemId: 4, stockQuantity: '2' }] }))
    expect(r).toEqual({
      ok: true,
      body: {
        spentOn: '2026-11-15',
        storeName: 'まるや',
        paymentMethod: 'cash',
        items: [{ name: null, categoryId: 1, taxRate: null, baseAmount: 100, stockItemId: 4, stockQuantity: 2 }],
        adjustments: [{ kind: 'tax', amount: 19, taxRate: 8 }],
      },
    })
  })
  it('誤りは全部並べる(日付・支払い・額・費目・在庫の個数・調整の 0)', () => {
    const r = toBody(
      draft({
        spentOn: '',
        paymentMethod: '',
        items: [{ key: 'a', name: 'x', categoryId: null, taxRate: null, baseAmount: 'a', stockItemId: 3, stockQuantity: '0' }],
        adjustments: [{ key: 'b', kind: 'discount', taxRate: null, amount: '0' }],
      }),
    )
    expect(r).toEqual({
      ok: false,
      errors: [
        '日付を入れてください。',
        '支払いを選んでください。',
        '品目 1: 額を数字で入れてください。',
        '品目 1: 費目を選んでください。',
        '品目 1: 在庫に足す個数を 1 以上で入れてください。',
        '値引き・外税 1: 0 でない額を数字で入れてください。',
      ],
    })
  })
  it('品目が無ければ保存しない', () => {
    expect(toBody(draft({ items: [] }))).toEqual({ ok: false, errors: ['品目を 1 つ以上入れてください。'] })
  })
})
