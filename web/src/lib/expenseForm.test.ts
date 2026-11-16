import { describe, expect, it } from 'vitest'
import {
  adjustmentSummary,
  flipSign,
  isNegativeYen,
  parseYen,
  readFailure,
  startOf,
  toBody,
  totalLine,
  totals,
  type AiRead,
  type ExpenseDraft,
  type FormResponse,
  type ReceiptDetail,
  usableStored,
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
  errorKind: null,
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
  it('V1: AI が当てた在庫の品物は、今も使える品物なら個数と入れる(やめた・無い品物・前の形の結果は「なし」)', () => {
    const stockItems = [
      { id: 4, name: '洗剤', retired: false },
      { id: 5, name: '古い', retired: true },
    ]
    const result: AiRead = {
      ...ai,
      items: [
        { name: '洗剤', baseAmount: 300, taxRate: 10, categoryId: 1, stockItemId: 4, stockQuantity: 2 },
        { name: '古い', baseAmount: 100, taxRate: 10, categoryId: 1, stockItemId: 5, stockQuantity: 1 },
        { name: '前の形', baseAmount: 100, taxRate: 10, categoryId: 1 },
      ],
    }
    const s = startOf(mode, { ...withReceipt(receipt({ result })), stockItems }, NOW)
    if (s.row !== 'V1') throw new Error(s.row)
    expect(s.draft.items.map((i) => [i.stockItemId, i.stockQuantity])).toEqual([[4, '2'], [null, ''], [null, '']])
  })
  it('V1: 日付が読めない・本当にない日なら撮った日(日本時間)。知らない支払いのコードは選ばない', () => {
    const s = startOf(mode, withReceipt(receipt({ result: { ...ai, purchasedOn: null, paymentMethod: 'emoney' } })), NOW)
    if (s.row !== 'V1') throw new Error(s.row)
    expect(s.draft.spentOn).toBe('2026-11-16')
    expect(s.draft.paymentMethod).toBe('')
    // 本当にない日に読めたときも撮った日
    for (const purchasedOn of ['2026-02-30', '2026-11-00', '2026-13-01', '2026-12-32']) {
      const bad = startOf(mode, withReceipt(receipt({ result: { ...ai, purchasedOn } })), NOW)
      if (bad.row !== 'V1') throw new Error(bad.row)
      expect(bad.draft.spentOn).toBe('2026-11-16')
    }
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
      updatedAt: '2026-11-02T01:00:00Z',
    }
    const s = startOf({ kind: 'expense', expenseId: 9 }, { ...base, expense }, NOW)
    if (s.row !== 'V6') throw new Error(s.row)
    expect(s.draft).toMatchObject({ storeName: '薬局', spentOn: '2026-11-02', paymentMethod: 'cash' })
    expect(s.draft.items[0]).toMatchObject({ name: '', categoryId: 2, baseAmount: '-50', stockItemId: 3, stockQuantity: '2' })
    expect(s.draft.adjustments[0]).toMatchObject({ kind: 'discount', amount: '-10' })
    expect(s.draft.baseUpdatedAt).toBe('2026-11-02T01:00:00Z')
    // 端末に残した入力: 同じ版から始めたものだけ戻す。残した後に支出が直されていたら使わない
    const stored = { ...s.draft, storeName: '直しかけ' }
    expect(usableStored('V6', stored, expense)).toBe(stored)
    expect(usableStored('V6', stored, { ...expense, updatedAt: '2026-11-03T00:00:00Z' })).toBeNull()
    expect(usableStored('V6', null, expense)).toBeNull()
    expect(usableStored('V1', { ...stored, baseUpdatedAt: undefined }, null)).toMatchObject({ storeName: '直しかけ' })
  })
  it('V7: 明細の支出は入力を出さない(費目だけ直す画面)', () => {
    const expense = { id: 9, origin: 'statement_purchase' as const, receiptId: null, spentOn: '2026-11-02', storeName: 'x', paymentMethod: 'rakuten_card', items: [], adjustments: [], amount: 0, updatedAt: '2026-11-02T00:00:00Z' }
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
  it('「−」のボタンは符号を変える(空なら「-」を置く。全角の「−」「ー」もマイナスと見る)', () => {
    expect(flipSign('300')).toBe('-300')
    expect(flipSign('-300')).toBe('300')
    expect(flipSign('−300')).toBe('300')
    expect(flipSign('ー300')).toBe('300')
    expect(flipSign('')).toBe('-')
    expect(flipSign('-')).toBe('')
    expect(isNegativeYen('-300')).toBe(true)
    expect(isNegativeYen('300')).toBe(false)
    expect(isNegativeYen('')).toBe(false)
    expect(parseYen(flipSign('1,280'))).toBe(-1280)
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
  it('日付: 本当にない日は入れ直させ、今日より後は断る(今日は通る。口と同じ)', () => {
    expect(toBody(draft({ spentOn: '2026-02-30' }), '2026-11-16')).toMatchObject({ ok: false, errors: ['日付を入れてください。'] })
    expect(toBody(draft({ spentOn: '2026-11-17' }), '2026-11-16')).toMatchObject({ ok: false, errors: ['日付が今日より後です。買った日を入れてください。'] })
    expect(toBody(draft({ spentOn: '2026-11-16' }), '2026-11-16').ok).toBe(true)
  })
  it('返品・0 円の品目には在庫の品物を付けられない(口と同じ)', () => {
    const item = (baseAmount: string) => [{ key: 'a', name: 'x', categoryId: 1, taxRate: null, baseAmount, stockItemId: 4, stockQuantity: '1' }]
    expect(toBody(draft({ items: item('-300') }))).toMatchObject({ ok: false, errors: ['品目 1: 返品・0 円の品目は在庫に足せません。品物を「なし」にしてください。'] })
    expect(toBody(draft({ items: item('0') })).ok).toBe(false)
    expect(toBody(draft({ items: item('1') })).ok).toBe(true)
  })
})

describe('読めなかった理由(表 R の R4)', () => {
  it('時間切れは種類より先。上限・形が合わない・その他で文を分け、上限は読み直しを勧めない', () => {
    expect(readFailure('timed_out', null).tag).toBe('読めなかった(時間切れ)')
    expect(readFailure('failed', 'timeout').tag).toBe('読めなかった(時間切れ)')
    expect(readFailure('failed', 'quota')).toEqual({ tag: '読めなかった(AI の上限)', text: expect.stringContaining('手で入力してください') })
    expect(readFailure('failed', 'quota').text).not.toContain('読み直す')
    expect(readFailure('failed', 'invalid_output').text).toContain('読み直す')
    expect(readFailure('failed', 'other').text).toContain('AI を呼べませんでした')
    expect(readFailure('failed', null).text).toContain('AI を呼べませんでした')
  })
})
