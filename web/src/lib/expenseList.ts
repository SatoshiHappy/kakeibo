// 一覧の画面の計算(DOM を使わない)。正本: データと照合 §4.8・表 W
export type ListCategory = { id: number; name: string; kind: string; retired: boolean; systemRole: string | null }
export type ListPaymentMethod = { code: string; label: string; statementExpected: boolean }
export type ListExpense = {
  id: number
  origin: 'person' | 'statement_purchase' | 'statement_fee'
  receiptId: number | null
  spentOn: string
  storeName: string
  paymentMethod: string
  registeredBy: string
  amount: number
  chargeCount: number
  diff: number | null
  categoryIds: number[]
}
export type ListResponse = { expenses: ListExpense[]; categories: ListCategory[]; paymentMethods: ListPaymentMethod[] }

export type Mark = { row: 'W1' | 'W2' | 'W3' | 'W4' | 'W5'; label: string | null }

/** 表 W: 行の印 */
export function rowMark(e: ListExpense, methods: ListPaymentMethod[]): Mark {
  if (e.origin !== 'person') return { row: 'W5', label: '明細から' }
  if (e.chargeCount > 0) return e.diff === 0 ? { row: 'W3', label: '明細と一致' } : { row: 'W4', label: '差あり' }
  const expected = methods.find((m) => m.code === e.paymentMethod)?.statementExpected ?? false
  return expected ? { row: 'W1', label: '明細待ち' } : { row: 'W2', label: null }
}

export type Filter = 'all' | 'fixed' | 'uncategorized' | 'waiting'

/** 絞り込みに当たるか(§4.8) */
export function matches(f: Filter, e: ListExpense, data: ListResponse): boolean {
  const cat = new Map(data.categories.map((c) => [c.id, c]))
  switch (f) {
    case 'all':
      return true
    case 'fixed':
      return e.categoryIds.some((id) => cat.get(id)?.kind === 'fixed')
    case 'uncategorized':
      return e.categoryIds.some((id) => cat.get(id)?.systemRole === 'uncategorized')
    case 'waiting':
      return rowMark(e, data.paymentMethods).row === 'W1'
  }
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土']

/** 11月15日(日) */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日(${WEEK[d.getUTCDay()]})`
}

/** 日ごとにまとめる(口の並び = 新しい日から。日の合計つき) */
export function byDay(expenses: ListExpense[]): { date: string; total: number; expenses: ListExpense[] }[] {
  const days: { date: string; total: number; expenses: ListExpense[] }[] = []
  for (const e of expenses) {
    const last = days.at(-1)
    if (last && last.date === e.spentOn) {
      last.expenses.push(e)
      last.total += e.amount
    } else days.push({ date: e.spentOn, total: e.amount, expenses: [e] })
  }
  return days
}
