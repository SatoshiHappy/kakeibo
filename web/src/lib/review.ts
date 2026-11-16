// 確かめる画面のカード(表 L の項目 → 問い・並べる記録・理由・操作)。正本: データと照合 表 L・§4.9
import { shortDate, yen } from './format'

export type Charge = { id: number; usedOn: string; merchant: string; cardUser: string; amount: number }
export type Expense = { id: number; spentOn: string; storeName: string; paymentMethod: string; amount: number }
export type ReviewItem =
  | { type: 'row_candidates'; charge: Charge; candidates: Expense[] }
  | { type: 'merge_candidates'; expense: Expense; charges: Charge[] }
  | { type: 'no_statement'; expense: Expense; duplicateSuspects: Charge[] }
  | { type: 'diff'; expense: Expense; diff: number; charges: Charge[] }
export type ReviewResponse = { items: ReviewItem[]; paymentMethods: { code: string; label: string }[] }

export type Action =
  | { kind: 'link'; chargeId: number; expenseId: number; label: string }
  | { kind: 'reject'; pairs: { chargeId: number; expenseId: number }[]; label: string }
  | { kind: 'none'; chargeId: number; label: string }
  | { kind: 'ackNoStatement'; expenseId: number; label: string }
  | { kind: 'ackDiff'; expenseId: number; label: string }
  | { kind: 'edit'; expenseId: number; label: string }
  | { kind: 'search'; by: { charge: number } | { expense: number }; label: string }

export type Record = { label: string; date: string; name: string; amount: string; diffDate?: boolean; diffAmount?: boolean; faint?: boolean }
export type Card = { key: string; row: 'L1' | 'L2' | 'L3' | 'L4'; question: string; records: Record[]; why: string; actions: Action[] }

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const chargeRecord = (label: string, c: Charge, over: Partial<Record> = {}): Record => ({ label, date: shortDate(c.usedOn), name: c.merchant, amount: yen(c.amount), ...over })
const expenseRecord = (label: string, e: Expense, over: Partial<Record> = {}): Record => ({
  label,
  date: shortDate(e.spentOn),
  name: e.storeName || '店名なし',
  amount: yen(e.amount),
  ...over,
})

export function cardOf(item: ReviewItem, methods: { code: string; label: string }[]): Card {
  switch (item.type) {
    case 'row_candidates': {
      const { charge, candidates } = item
      const n = candidates.length
      return {
        key: `row:${charge.id}`,
        row: 'L1',
        question: 'この明細は、どの支出の分?',
        records: [
          chargeRecord('明細', charge),
          ...candidates.map((p, i) => expenseRecord(`候補 ${LETTERS[i] ?? i + 1}`, p, { diffDate: p.spentOn !== charge.usedOn })),
        ],
        why: `同じ額で日付の近い支出${n > 1 ? `が ${n} 件あります` : 'です'}。通販は発送の日に載ることがあります。`,
        actions: [
          ...candidates.map((p, i): Action => ({ kind: 'link', chargeId: charge.id, expenseId: p.id, label: `${LETTERS[i] ?? i + 1} と結ぶ` })),
          { kind: 'search', by: { charge: charge.id }, label: 'ほかの支出を探す' },
          { kind: 'none', chargeId: charge.id, label: 'どれでもない' },
        ],
      }
    }
    case 'merge_candidates': {
      const { expense, charges } = item
      return {
        key: `merge:${expense.id}`,
        row: 'L2',
        question: '明細から作った支出に、レシートが来ました',
        records: [
          ...charges.map((c) => chargeRecord('明細から', c, { diffDate: c.usedOn !== expense.spentOn })),
          expenseRecord('支出', expense, { diffDate: charges.some((c) => c.usedOn !== expense.spentOn) }),
        ],
        why: '同じ額の明細から作った支出があります。1 つにまとめると、品目と費目が付きます。',
        actions: [
          ...charges.map(
            (c): Action => ({ kind: 'link', chargeId: c.id, expenseId: expense.id, label: charges.length > 1 ? `${shortDate(c.usedOn)} の明細とまとめる` : '1 つにまとめる' }),
          ),
          { kind: 'reject', pairs: charges.map((c) => ({ chargeId: c.id, expenseId: expense.id })), label: '別の買い物' },
        ],
      }
    }
    case 'no_statement': {
      const { expense, duplicateSuspects } = item
      const method = methods.find((m) => m.code === expense.paymentMethod)?.label ?? expense.paymentMethod
      return {
        key: `none:${expense.id}`,
        row: 'L3',
        question: 'カードで払いましたか?',
        records: [
          { label: '明細', date: '—', name: '見つからない', amount: '—', faint: true },
          expenseRecord('支出', expense),
          ...duplicateSuspects.map((c) => chargeRecord('似た明細', c)),
        ],
        why:
          `支払いは${method}ですが、取り込んだ明細にありません。` +
          (duplicateSuspects.length > 0 ? '同じ額の明細が別の支出に結ばれています(二重に入れたかもしれません)。' : ''),
        actions: [
          { kind: 'ackNoStatement', expenseId: expense.id, label: 'カードで合っている(確認済み)' },
          { kind: 'search', by: { expense: expense.id }, label: '明細の行を探して足す' },
          { kind: 'edit', expenseId: expense.id, label: '支払い方法を直す' },
          ...duplicateSuspects.map((c): Action => ({ kind: 'reject', pairs: [{ chargeId: c.id, expenseId: expense.id }], label: `${shortDate(c.usedOn)} の似た明細とは別の買い物` })),
        ],
      }
    }
    case 'diff': {
      const { expense, charges, diff } = item
      return {
        key: `diff:${expense.id}`,
        row: 'L4',
        question: `金額が ${yen(Math.abs(diff))} 違います`,
        records: [...charges.map((c) => chargeRecord('明細', c, { diffAmount: true })), expenseRecord('支出', expense, { diffAmount: true })],
        why: 'ポイントで一部を払ったときは、レシートの額のままで大丈夫です。',
        actions: [
          { kind: 'ackDiff', expenseId: expense.id, label: `${yen(expense.amount)} のまま確認済み` },
          { kind: 'edit', expenseId: expense.id, label: 'レシートを直す' },
          ...charges.map(
            (c): Action => ({ kind: 'reject', pairs: [{ chargeId: c.id, expenseId: expense.id }], label: charges.length > 1 ? `${shortDate(c.usedOn)} の明細は別の買い物` : '別の買い物' }),
          ),
        ],
      }
    }
  }
}
