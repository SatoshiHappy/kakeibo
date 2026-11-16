import { describe, expect, it } from 'vitest'
import { budgetTotal, moveId, parseBudget, type PrefCategory } from './prefs'

const c = (id: number, kind: string, budget: number | null, retired = false): PrefCategory => ({ id, name: `c${id}`, kind, retired, systemRole: null, budget })

describe('予算の計', () => {
  it('やめていない毎月変わる費目の予算だけを足す(固定費・臨時・やめた費目に残った予算は数えない)', () => {
    expect(budgetTotal([c(1, 'variable', 65000), c(2, 'variable', null), c(4, 'fixed', 101500), c(14, 'extra', 3000), c(9, 'variable', 999, true)])).toBe(65000)
  })
})

describe('予算の入力欄', () => {
  it('空は予算なし(null)、「65,000」は額、負や数でないものは読めない', () => {
    expect(parseBudget('')).toBeNull()
    expect(parseBudget(' ')).toBeNull()
    expect(parseBudget('65,000')).toBe(65000)
    expect(parseBudget('0')).toBe(0)
    expect(parseBudget('-1')).toBeUndefined()
    expect(parseBudget('abc')).toBeUndefined()
  })
})

describe('費目の並びを動かす', () => {
  it('前へ・後ろへ入れ替え、端を越えるときは変えない', () => {
    expect(moveId([1, 2, 3], 2, -1)).toEqual([2, 1, 3])
    expect(moveId([1, 2, 3], 2, 1)).toEqual([1, 3, 2])
    expect(moveId([1, 2, 3], 1, -1)).toEqual([1, 2, 3])
    expect(moveId([1, 2, 3], 3, 1)).toEqual([1, 2, 3])
    expect(moveId([1, 2, 3], 9, 1)).toEqual([1, 2, 3])
  })
})
