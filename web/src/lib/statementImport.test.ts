import { describe, expect, it } from 'vitest'
import { billingLabel, importErrorText, resultLines, type ImportResult } from './statementImport'

const r = (over: Partial<ImportResult>): ImportResult => ({
  billingMonth: '2026-11',
  rowsInFile: 24,
  totalAmount: 0,
  rowsNew: 24,
  rowsChanged: 0,
  rowsMissing: 0,
  linkedToPerson: 18,
  statementExpenses: 4,
  reviewCount: 5,
  ...over,
})

describe('取り込みの画面の文', () => {
  it('止めた理由は表 C の段ごとの文', () => {
    expect(importErrorText('bad_format', 'C2')).toContain('見出しの行')
    expect(importErrorText('billing_month_unknown', 'C7')).toBe('請求月を決められません(利用金額のある行がありません)。')
    expect(importErrorText('billing_month_unknown', 'C9')).toBe('15 か月より前の明細なので取り込めません。')
    expect(importErrorText('future_usage', 'C8')).toContain('請求月より後')
    expect(importErrorText('invalid_file', undefined)).toBe('ファイルが空か、1MB を超えています。')
  })
  it('結果の行: 0 の内訳は出さず、新しい行と飛ばした行は 0 でも出す。変わった行・無い行は注意の色', () => {
    expect(resultLines(r({})).map((l) => [l.label, l.value])).toEqual([
      ['新しい行', '24 行'],
      ['レシートと自動で結んだ', '18'],
      ['明細のまま支出にした', '4'],
      ['取り込み済みで飛ばした行', '0'],
    ])
    const again = resultLines(r({ rowsNew: 0, linkedToPerson: 0, statementExpenses: 0, rowsChanged: 1, rowsMissing: 2 }))
    expect(again.map((l) => [l.label, l.value, l.warn ?? false])).toEqual([
      ['新しい行', '0 行', false],
      ['取り込み済みで飛ばした行', '24', false],
      ['支払方法・手数料が変わった行(飛ばした)', '1', true],
      ['前に取り込んだのに今回のファイルに無い行', '2', true],
    ])
    expect(billingLabel('2026-01')).toBe('2026年1月請求分')
  })
})
