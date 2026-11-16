import { describe, expect, it } from 'vitest'
import { cardOf, type Charge, type Expense } from './review'

const methods = [{ code: 'rakuten_card', label: '楽天カード' }]
const ch = (id: number, usedOn = '2026-10-10', amount = 2640): Charge => ({ id, usedOn, merchant: '楽天ブックス', cardUser: '本人', amount })
const ex = (id: number, spentOn = '2026-10-10', amount = 2640): Expense => ({ id, spentOn, storeName: '本屋', paymentMethod: 'rakuten_card', amount })

describe('確かめるカード(表 L の項目ごと)', () => {
  it('L1: 候補ごとに「A と結ぶ」、探す、「どれでもない」。日付の違う候補は日付に印', () => {
    const c = cardOf({ type: 'row_candidates', charge: ch(1), candidates: [ex(7, '2026-10-08'), ex(8)] }, methods)
    expect(c).toMatchObject({ key: 'row:1', row: 'L1', question: 'この明細は、どの支出の分?' })
    expect(c.records.map((r) => [r.label, r.diffDate ?? false])).toEqual([
      ['明細', false],
      ['候補 A', true],
      ['候補 B', false],
    ])
    expect(c.why).toBe('同じ額で日付の近い支出が 2 件あります。通販は発送の日に載ることがあります。')
    expect(c.actions).toEqual([
      { kind: 'link', chargeId: 1, expenseId: 7, label: 'A と結ぶ' },
      { kind: 'link', chargeId: 1, expenseId: 8, label: 'B と結ぶ' },
      { kind: 'search', by: { charge: 1 }, label: 'ほかの支出を探す' },
      { kind: 'none', chargeId: 1, label: 'どれでもない' },
    ])
  })
  it('L2: 行が 1 つなら「1 つにまとめる」。「別の買い物」は並んだ組を全部拒否', () => {
    const c = cardOf({ type: 'merge_candidates', expense: ex(5), charges: [ch(2)] }, methods)
    expect(c.row).toBe('L2')
    expect(c.actions).toEqual([
      { kind: 'link', chargeId: 2, expenseId: 5, label: '1 つにまとめる' },
      { kind: 'reject', pairs: [{ chargeId: 2, expenseId: 5 }], label: '別の買い物' },
    ])
    const two = cardOf({ type: 'merge_candidates', expense: ex(5), charges: [ch(2), ch(3, '2026-10-11')] }, methods)
    expect(two.actions.map((a) => a.label)).toEqual(['10/10 の明細とまとめる', '10/11 の明細とまとめる', '別の買い物'])
    // 日付の違う明細の行と支出の行に印
    expect(two.records.map((r) => r.diffDate ?? false)).toEqual([false, true, true])
  })
  it('L3: 支払い方法の名前を出し、確認済み・探す・直す。重複の疑いがあれば行ごとに「別の買い物」', () => {
    const c = cardOf({ type: 'no_statement', expense: ex(5), duplicateSuspects: [ch(9)] }, methods)
    expect(c.row).toBe('L3')
    expect(c.why).toBe('支払いは楽天カードですが、取り込んだ明細にありません。同じ額の明細が別の支出に結ばれています(二重に入れたかもしれません)。')
    expect(c.actions.map((a) => a.kind)).toEqual(['ackNoStatement', 'search', 'edit', 'reject'])
  })
  it('L4: 差の大きさを問いにし、「¥X のまま確認済み」・直す・行ごとに外す', () => {
    const c = cardOf({ type: 'diff', expense: ex(5, '2026-10-14', 5000), diff: -150, charges: [ch(4, '2026-10-14', 4850)] }, methods)
    expect(c).toMatchObject({ key: 'diff:5', row: 'L4', question: '金額が ¥150 違います' })
    expect(c.actions.map((a) => a.label)).toEqual(['¥5,000 のまま確認済み', 'レシートを直す', '別の買い物'])
  })
})
