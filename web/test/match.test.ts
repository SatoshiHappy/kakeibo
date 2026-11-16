// 表 A-1 の評価(純粋な関数)と、日の差の境(0・1・29・30・31 日、前後の両方の向き)
import { describe, expect, it } from 'vitest'
import { Matcher, type FreeExpense, type FreeRow } from '../worker/domain/match'

const R = (id: number, usedOn: string, amount = 1000, statementExpenseId: number | null = null): FreeRow => ({ id, usedOn, amount, statementExpenseId })
const P = (id: number, spentOn: string, amount = 1000, cardCompatible = true): FreeExpense => ({ id, spentOn, amount, cardCompatible })
const run = (rows: FreeRow[], exps: FreeExpense[], rej: { rowId: number; expenseId: number }[] = []) =>
  new Matcher(rows, exps, rej, 30).evaluate(new Set(rows.map((r) => r.id)))

describe('表 A-1', () => {
  it('A-1 の 2 行: 同じ日・同じ額・両側 1 つ・矛盾しない → 自動で結ぶ', () => {
    expect(run([R(1, '2026-10-10')], [P(10, '2026-10-10')])).toEqual([{ kind: 'link', rowId: 1, expenseId: 10, statementExpenseId: null }])
  })
  it('A-1 の 2 行: 明細の支出のある行も結ぶ(まとめる)', () => {
    expect(run([R(1, '2026-10-10', 1000, 99)], [P(10, '2026-10-10')])).toEqual([{ kind: 'link', rowId: 1, expenseId: 10, statementExpenseId: 99 }])
  })
  it('A-1 の 3 行: 方法が矛盾する(現金)→ 何もしない', () => {
    expect(run([R(1, '2026-10-10')], [P(10, '2026-10-10', 1000, false)])).toEqual([])
  })
  it('A-1 の 4 行: D(R)=1 だが D(P)≥2 → 何もしない', () => {
    expect(run([R(1, '2026-10-10'), R(2, '2026-10-10')], [P(10, '2026-10-10')])).toEqual([])
  })
  it('A-1 の 5 行: D(R)≥2 → 何もしない', () => {
    expect(run([R(1, '2026-10-10')], [P(10, '2026-10-10'), P(11, '2026-10-10')])).toEqual([])
  })
  it('A-1 の 6 行: D(R)=0 で C(R)≥1(日付がずれた候補)→ 何もしない', () => {
    expect(run([R(1, '2026-10-10')], [P(10, '2026-10-12')])).toEqual([])
  })
  it('A-1 の 7 行: 結ばれていない・候補 0 → 明細の支出を作る', () => {
    expect(run([R(1, '2026-10-10')], [])).toEqual([{ kind: 'create_statement_expense', rowId: 1 }])
  })
  it('A-1 の 8 行: 明細の支出あり・候補 0 → 何もしない', () => {
    expect(run([R(1, '2026-10-10', 1000, 99)], [])).toEqual([])
  })
  it('額が違えば候補にならない', () => {
    expect(run([R(1, '2026-10-10', 1000)], [P(10, '2026-10-10', 999)])).toEqual([{ kind: 'create_statement_expense', rowId: 1 }])
  })
  it('拒否した組は候補にならない', () => {
    expect(run([R(1, '2026-10-10')], [P(10, '2026-10-10')], [{ rowId: 1, expenseId: 10 }])).toEqual([
      { kind: 'create_statement_expense', rowId: 1 },
    ])
  })
  it('マイナスの行も同じ規則(J4)', () => {
    expect(run([R(1, '2026-10-10', -500)], [P(10, '2026-10-10', -500)])).toEqual([{ kind: 'link', rowId: 1, expenseId: 10, statementExpenseId: null }])
  })
  it('評価は 2 段: 結んだ支出は他の行の候補から外れ、その行は明細の支出になる', () => {
    // R1 は P10 と同じ日で結ぶ。R2 は P10 が 3 日ずれの唯一の候補だったが、結ばれたので候補 0 → 7 行
    const out = run([R(1, '2026-10-10'), R(2, '2026-10-13')], [P(10, '2026-10-10')])
    expect(out).toEqual([
      { kind: 'link', rowId: 1, expenseId: 10, statementExpenseId: null },
      { kind: 'create_statement_expense', rowId: 2 },
    ])
  })
})

describe('日の差の境(照合の日の幅 30 日。境は含む)', () => {
  const base = '2026-06-15'
  const shift = (d: number) => new Date(Date.parse(base) + d * 86_400_000).toISOString().slice(0, 10)
  it.each([
    [0, 'link'],
    [1, 'none'],
    [-1, 'none'],
    [29, 'none'],
    [-29, 'none'],
    [30, 'none'],
    [-30, 'none'],
    [31, 'create_statement_expense'],
    [-31, 'create_statement_expense'],
  ])('差 %i 日 → %s', (d, expected) => {
    const out = run([R(1, base)], [P(10, shift(d as number))])
    const kind = out[0]?.kind ?? 'none'
    expect(kind).toBe(expected)
  })
  it('方法が矛盾する支出は、1 日でもずれれば候補にならない(J3)', () => {
    expect(run([R(1, base)], [P(10, shift(1), 1000, false)])).toEqual([{ kind: 'create_statement_expense', rowId: 1 }])
  })
})
