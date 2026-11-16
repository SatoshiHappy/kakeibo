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
  /** 「明細に無い」を確認済みにした(表 A-2 の 5 行) */
  noStatementAcked: boolean
  /** 「このまま」にした差(表 A-3 の 2 行)。無ければ null */
  acceptedDiff: number | null
  /** 毎月決まった支出から自動で作った(データと照合 §1.17) */
  recurring: boolean
  categoryIds: number[]
}
export type ListResponse = { expenses: ListExpense[]; categories: ListCategory[]; paymentMethods: ListPaymentMethod[] }

export type Mark = { row: 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6' | 'W7'; label: string | null }

/** 表 W: 行の印 */
export function rowMark(e: ListExpense, methods: ListPaymentMethod[]): Mark {
  if (e.origin !== 'person') return { row: 'W5', label: '明細から' }
  if (e.chargeCount > 0) {
    if (e.diff === 0) return { row: 'W3', label: '明細と一致' }
    return e.acceptedDiff === e.diff ? { row: 'W7', label: '差を確認済み' } : { row: 'W4', label: '差あり' }
  }
  const expected = methods.find((m) => m.code === e.paymentMethod)?.statementExpected ?? false
  if (!expected) return { row: 'W2', label: null }
  return e.noStatementAcked ? { row: 'W6', label: '確認済み(明細なし)' } : { row: 'W1', label: '明細待ち' }
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
