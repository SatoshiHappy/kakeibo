import { describe, expect, it } from 'vitest'
import { byDay, dayLabel, matches, rowMark, type ListExpense, type ListResponse } from './expenseList'

const methods = [
  { code: 'rakuten_card', label: '楽天カード', statementExpected: true },
  { code: 'unknown', label: '不明', statementExpected: false },
  { code: 'cash', label: '現金', statementExpected: false },
]
const e = (over: Partial<ListExpense>): ListExpense => ({
  id: 1,
  origin: 'person',
  receiptId: null,
  spentOn: '2026-11-15',
  storeName: 's',
  paymentMethod: 'cash',
  registeredBy: 'アリス',
  amount: 100,
  chargeCount: 0,
  diff: null,
  categoryIds: [1],
  ...over,
})

describe('表 W 一覧の行の印', () => {
  it('W1: 人の支出で明細が無く、明細に載るはずの支払いなら明細待ち', () => {
    expect(rowMark(e({ paymentMethod: 'rakuten_card' }), methods)).toEqual({ row: 'W1', label: '明細待ち' })
  })
  it('W2: 人の支出で明細が無く、明細に載らない支払いなら印なし', () => {
    expect(rowMark(e({ paymentMethod: 'cash' }), methods)).toEqual({ row: 'W2', label: null })
    expect(rowMark(e({ paymentMethod: 'unknown' }), methods).row).toBe('W2')
  })
  it('W3: 明細と結ばれ差が 0 なら明細と一致(支払いによらない)', () => {
    expect(rowMark(e({ chargeCount: 1, diff: 0, paymentMethod: 'rakuten_card' }), methods)).toEqual({ row: 'W3', label: '明細と一致' })
    expect(rowMark(e({ chargeCount: 2, diff: 0, paymentMethod: 'unknown' }), methods).row).toBe('W3')
  })
  it('W4: 明細と結ばれ差があれば差あり(支払いによらない)', () => {
    expect(rowMark(e({ chargeCount: 1, diff: -20, paymentMethod: 'rakuten_card' }), methods)).toEqual({ row: 'W4', label: '差あり' })
    expect(rowMark(e({ chargeCount: 1, diff: 5, paymentMethod: 'unknown' }), methods).row).toBe('W4')
  })
  it('W5: 明細の支出(購入・手数料)は明細から', () => {
    expect(rowMark(e({ origin: 'statement_purchase', chargeCount: 1, diff: 0, paymentMethod: 'rakuten_card' }), methods)).toEqual({ row: 'W5', label: '明細から' })
    expect(rowMark(e({ origin: 'statement_fee', chargeCount: 1, diff: 0 }), methods).row).toBe('W5')
  })
})

describe('絞り込み', () => {
  const data: ListResponse = {
    expenses: [],
    categories: [
      { id: 1, name: '食費', kind: 'variable', retired: false, systemRole: null },
      { id: 4, name: '家賃', kind: 'fixed', retired: false, systemRole: null },
      { id: 19, name: '未分類', kind: 'variable', retired: false, systemRole: 'uncategorized' },
    ],
    paymentMethods: methods,
  }
  it('固定費・未分類は品目の費目のどれかが当たれば。明細待ちは W1', () => {
    expect(matches('fixed', e({ categoryIds: [1, 4] }), data)).toBe(true)
    expect(matches('fixed', e({ categoryIds: [1] }), data)).toBe(false)
    expect(matches('uncategorized', e({ categoryIds: [19] }), data)).toBe(true)
    expect(matches('waiting', e({ paymentMethod: 'rakuten_card' }), data)).toBe(true)
    expect(matches('waiting', e({ paymentMethod: 'cash' }), data)).toBe(false)
    expect(matches('all', e({}), data)).toBe(true)
  })
})

describe('日ごとのまとめ', () => {
  it('同じ日をまとめて合計を出す。曜日は日付から', () => {
    const days = byDay([e({ id: 1, spentOn: '2026-11-15', amount: 100 }), e({ id: 2, spentOn: '2026-11-15', amount: 50 }), e({ id: 3, spentOn: '2026-11-14', amount: 7 })])
    expect(days.map((d) => [d.date, d.total, d.expenses.length])).toEqual([
      ['2026-11-15', 150, 2],
      ['2026-11-14', 7, 1],
    ])
    expect(dayLabel('2026-11-15')).toBe('11月15日(日)')
  })
})
