import { describe, expect, it } from 'vitest'
import { forecastText, stockSections, type StockItem } from './stock'

const item = (id: number, over: Partial<StockItem>): StockItem => ({
  id,
  name: `品物${id}`,
  notifyDays: 7,
  retired: false,
  quantity: 1,
  state: 'ok',
  forecast: null,
  undoableMoveId: null,
  ...over,
})
const f = (daysLeft: number) => ({ paceDays: 10, runOutOn: '2026-11-20', daysLeft })

describe('在庫の並べ方', () => {
  it('そろそろ買うは予測なし(残り 0)を先に、続けてあと何日の少ない順', () => {
    const s = stockSections([item(1, { state: 'soon', forecast: f(5) }), item(2, { state: 'soon', quantity: 0 }), item(3, { state: 'soon', forecast: f(2) })])
    expect(s.soon.map((i) => i.id)).toEqual([2, 3, 1])
  })
  it('まだあるはなくなるのが早い順、予測なしは最後。やめた品物は出さない', () => {
    const s = stockSections([item(1, {}), item(2, { forecast: f(60) }), item(3, { forecast: f(30) }), item(4, { retired: true, state: null })])
    expect(s.ok.map((i) => i.id)).toEqual([3, 2, 1])
    expect(s.soon).toEqual([])
  })
})

describe('予測の文言', () => {
  it('予測があれば「あと N 日 · M/D ごろ」と「N 日に 1 つ」(ペースは丸めて 1 以上)', () => {
    expect(forecastText(item(1, { forecast: { paceDays: 12.4, runOutOn: '2026-11-20', daysLeft: 5 } }))).toEqual({ main: 'あと5日 · 11/20ごろ', meta: '12日に1つ' })
    expect(forecastText(item(1, { forecast: { paceDays: 0.4, runOutOn: '2026-11-20', daysLeft: 0 } })).meta).toBe('1日に1つ')
  })
  it('あと何日が負なら「なくなる日を過ぎた」', () => {
    expect(forecastText(item(1, { forecast: f(-3) })).main).toBe('なくなる日を過ぎた · 11/20ごろ')
  })
  it('予測が無ければ、残り 0 は「買い置きがありません」、ほかは「ペースを覚えている途中」', () => {
    expect(forecastText(item(1, { quantity: 0 })).main).toBe('買い置きがありません')
    expect(forecastText(item(1, { quantity: 2 }))).toEqual({ main: 'ペースを覚えている途中', meta: '使った記録 2 回で予測' })
  })
})
