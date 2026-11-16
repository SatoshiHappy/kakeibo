// 設計書 §5 のテストの列挙を通す。
import { describe, expect, it } from 'vitest'
import { distribute, NoDistributionTarget, type Adjustment, type ItemInput } from '../worker/domain/distribute'

const item = (position: number, baseAmount: number, taxRate: ItemInput['taxRate'] = null): ItemInput => ({
  position,
  baseAmount,
  taxRate,
})
const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0)

describe('distribute', () => {
  it('調整が無ければ base_amount のまま', () => {
    expect(distribute([item(1, 100), item(2, 200)], [])).toEqual(new Map([[1, 100], [2, 200]]))
  })

  it('割り切れる値引き', () => {
    const r = distribute([item(1, 100), item(2, 300)], [{ kind: 'discount', amount: -40, taxRate: null }])
    expect(r).toEqual(new Map([[1, 90], [2, 270]]))
  })

  it('割り切れない値引き: 合計はちょうど a、各品目の差は 1 円未満', () => {
    const items = [item(1, 100), item(2, 100), item(3, 100)]
    const r = distribute(items, [{ kind: 'discount', amount: -100, taxRate: null }])
    expect(sum(r)).toBe(200)
    for (const [, v] of r) expect(Math.abs(v - (100 - 100 / 3))).toBeLessThan(1)
  })

  it('同じ余りなら position の小さい品目から 1 円', () => {
    const r = distribute([item(2, 100), item(1, 100)], [{ kind: 'discount', amount: -1, taxRate: null }])
    expect(r.get(1)).toBe(99)
    expect(r.get(2)).toBe(100)
  })

  it('余りの大きい品目から配る', () => {
    // 10 を 1:2 で割る: 3.33 と 6.66 → floor 3,6 余り 1 は 6.66 の側(余り大)
    const r = distribute([item(1, 100), item(2, 200)], [{ kind: 'tax', amount: 10, taxRate: null }])
    expect(r).toEqual(new Map([[1, 103], [2, 207]]))
  })

  it('率ごとの外税はその率の品目だけに配る', () => {
    const items = [item(1, 1000, 8), item(2, 500, 10), item(3, 500, 10)]
    const adj: Adjustment[] = [
      { kind: 'tax', amount: 80, taxRate: 8 },
      { kind: 'tax', amount: 100, taxRate: 10 },
    ]
    expect(distribute(items, adj)).toEqual(new Map([[1, 1080], [2, 550], [3, 550]]))
  })

  it('返品のレシートの外税(負)は負の品目に配る', () => {
    const r = distribute([item(1, -1000, 10)], [{ kind: 'tax', amount: -100, taxRate: 10 }])
    expect(r).toEqual(new Map([[1, -1100]]))
  })

  it('正と負の品目が混ざるレシート: 外税は同じ符号、値引きは逆の符号の品目だけ', () => {
    const items = [item(1, 1000), item(2, -200)]
    const r = distribute(items, [
      { kind: 'tax', amount: 80, taxRate: null },
      { kind: 'discount', amount: -100, taxRate: null },
    ])
    expect(r).toEqual(new Map([[1, 980], [2, -200]]))
  })

  it('複数の調整は順によらず同じ結果', () => {
    const items = [item(1, 333), item(2, 667)]
    const a: Adjustment = { kind: 'tax', amount: 77, taxRate: null }
    const b: Adjustment = { kind: 'discount', amount: -55, taxRate: null }
    expect(distribute(items, [a, b])).toEqual(distribute(items, [b, a]))
    expect(sum(distribute(items, [a, b]))).toBe(1000 + 77 - 55)
  })

  it('配る先が無い(8% の外税なのに 8% の品目が無い)と止める', () => {
    expect(() => distribute([item(1, 100, 10)], [{ kind: 'tax', amount: 8, taxRate: 8 }])).toThrow(NoDistributionTarget)
  })
})
