// 確かめて保存の画面の計算(DOM を使わない)。正本: データと照合 §4.7・表 V・表 T・§5
import { jstToday, yen } from './format'

export type Rate = 0 | 8 | 10 | null
export type Category = { id: number; name: string; kind: string; retired: boolean; systemRole: string | null }
export type PaymentMethod = { code: string; label: string; cardCompatible: boolean }
export type StockChoice = { id: number; name: string; retired: boolean }

export type AiRead = {
  storeName: string
  purchasedOn: string | null
  paymentMethod: string
  /** stockItemId・stockQuantity は在庫の当て方を足す前に読んだ下書きには無い */
  items: { name: string; baseAmount: number; taxRate: Rate; categoryId: number; stockItemId?: number | null; stockQuantity?: number | null }[]
  adjustments: { kind: 'discount' | 'tax'; amount: number; taxRate: Rate }[]
  printedTotal: number | null
}
export type ReceiptDetail = {
  id: number
  uploadedAt: string
  read: 'reading' | 'timed_out' | 'read' | 'failed'
  result: AiRead | null
  expenseId: number | null
  images: { position: number; stored: boolean }[]
}
export type ExpenseDetail = {
  id: number
  origin: 'person' | 'statement_purchase' | 'statement_fee'
  receiptId: number | null
  spentOn: string
  storeName: string
  paymentMethod: string
  items: {
    position: number
    name: string | null
    categoryId: number
    taxRate: Rate
    baseAmount: number
    amount: number
    stockItemId: number | null
    stockQuantity: number | null
  }[]
  adjustments: { kind: 'discount' | 'tax'; amount: number; taxRate: Rate }[]
  amount: number
  /** 端末に残した入力が、この版の支出から始めたものかを見分ける(表 V の V6) */
  updatedAt: string
}
export type FormResponse = {
  categories: Category[]
  paymentMethods: PaymentMethod[]
  stockItems: StockChoice[]
  receipt: ReceiptDetail | null
  expense: ExpenseDetail | null
}

/** 入力中の値。額は打ちかけ(「-」だけ等)を持てるよう文字で持つ */
export type ItemDraft = { key: string; name: string; categoryId: number | null; taxRate: Rate; baseAmount: string; stockItemId: number | null; stockQuantity: string }
export type AdjustmentDraft = { key: string; kind: 'discount' | 'tax'; taxRate: Rate; amount: string }
export type ExpenseDraft = {
  clientRequestId: string
  storeName: string
  spentOn: string
  paymentMethod: string
  items: ItemDraft[]
  adjustments: AdjustmentDraft[]
  /** 支出を直す(V6)とき、始めた支出の updated_at。端末に残した入力を戻すかの判定に使う */
  baseUpdatedAt?: string
}

export type Mode = { kind: 'receipt'; receiptId: number } | { kind: 'new' } | { kind: 'expense'; expenseId: number }

/** 表 V の結果(V8 = 404 は口の結果なので画面が先に見る) */
export type Start =
  | { row: 'V1' | 'V3' | 'V5' | 'V6'; draft: ExpenseDraft }
  | { row: 'V2' }
  | { row: 'V4'; to: string }
  | { row: 'V7' }

const newKey = () => crypto.randomUUID()

export const blankItem = (uncategorized: number | null): ItemDraft => ({
  key: newKey(),
  name: '',
  categoryId: uncategorized,
  taxRate: null,
  baseAmount: '',
  stockItemId: null,
  stockQuantity: '',
})

export const uncategorizedId = (cats: Category[]) => cats.find((c) => c.systemRole === 'uncategorized')?.id ?? null

function blank(spentOn: string, cats: Category[]): ExpenseDraft {
  return { clientRequestId: newKey(), storeName: '', spentOn, paymentMethod: '', items: [blankItem(uncategorizedId(cats))], adjustments: [] }
}

/**
 * 端末に残した入力を初めの値に使えるか(表 V の脚注)。支出を直す(V6)では、残した後に支出が直されていたら使わない
 * (家族やほかの端末の直しを、古い入力で上書きしないため)
 */
export function usableStored(row: Start['row'], stored: ExpenseDraft | null, expense: ExpenseDetail | null): ExpenseDraft | null {
  if (stored === null) return null
  if (row === 'V6' && stored.baseUpdatedAt !== expense?.updatedAt) return null
  return stored
}

/** AI が当てた在庫の品物。今も使える品物(やめていない)だけ入れる */
function aiStock(i: AiRead['items'][number], stock: StockChoice[]): Pick<ItemDraft, 'stockItemId' | 'stockQuantity'> {
  const id = i.stockItemId ?? null
  if (id === null || !stock.some((s) => s.id === id && !s.retired)) return { stockItemId: null, stockQuantity: '' }
  return { stockItemId: id, stockQuantity: String(i.stockQuantity ?? 1) }
}

/** 表 V(V8 を除く)。manual = 読み取り中に「待たずに手で入力する」を押した */
export function startOf(mode: Mode, data: FormResponse, now = new Date(), manual = false): Start {
  const cats = data.categories
  if (mode.kind === 'new') return { row: 'V5', draft: blank(jstToday(now), cats) }
  if (mode.kind === 'expense') {
    const e = data.expense!
    if (e.origin !== 'person') return { row: 'V7' }
    return {
      row: 'V6',
      draft: {
        clientRequestId: newKey(),
        baseUpdatedAt: e.updatedAt,
        storeName: e.storeName,
        spentOn: e.spentOn,
        paymentMethod: e.paymentMethod,
        items: e.items.map((i) => ({
          key: newKey(),
          name: i.name ?? '',
          categoryId: i.categoryId,
          taxRate: i.taxRate,
          baseAmount: String(i.baseAmount),
          stockItemId: i.stockItemId,
          stockQuantity: i.stockQuantity === null ? '' : String(i.stockQuantity),
        })),
        adjustments: e.adjustments.map((a) => ({ key: newKey(), kind: a.kind, taxRate: a.taxRate, amount: String(a.amount) })),
      },
    }
  }
  const r = data.receipt!
  if (r.expenseId !== null) return { row: 'V4', to: `/expenses/${r.expenseId}` }
  const uploadedOn = jstToday(new Date(r.uploadedAt))
  if (r.read === 'reading' && !manual) return { row: 'V2' }
  if (r.read !== 'read' || r.result === null) return { row: 'V3', draft: blank(uploadedOn, cats) }
  const ai = r.result
  const usable = new Set(cats.filter((c) => !c.retired).map((c) => c.id))
  const fallback = uncategorizedId(cats)
  return {
    row: 'V1',
    draft: {
      clientRequestId: newKey(),
      storeName: ai.storeName,
      spentOn: ai.purchasedOn !== null && isRealDate(ai.purchasedOn) ? ai.purchasedOn : uploadedOn,
      paymentMethod: data.paymentMethods.some((p) => p.code === ai.paymentMethod) ? ai.paymentMethod : '',
      items:
        ai.items.length === 0
          ? [blankItem(fallback)]
          : ai.items.map((i) => ({
              key: newKey(),
              name: i.name,
              categoryId: usable.has(i.categoryId) ? i.categoryId : fallback,
              taxRate: i.taxRate,
              baseAmount: String(i.baseAmount),
              ...aiStock(i, data.stockItems),
            })),
      adjustments: ai.adjustments.map((a) => ({ key: newKey(), kind: a.kind, taxRate: a.taxRate, amount: String(a.amount) })),
    },
  }
}

/** 打った額を整数に。「1,280」「−20」「-20」を読む。読めなければ null */
export function parseYen(s: string): number | null {
  const t = s.replace(/[,\s]/g, '').replace(/^[−ー–]/, '-')
  return /^-?\d+$/.test(t) ? Number(t) : null
}

/** 合計 = 品目の値札の額の合計 + 値引き・外税の合計(§5 で配っても変わらない)。読めない額は 0 で数える */
export function totals(d: ExpenseDraft) {
  const itemsTotal = d.items.reduce((a, i) => a + (parseYen(i.baseAmount) ?? 0), 0)
  const adjustmentsTotal = d.adjustments.reduce((a, x) => a + (parseYen(x.amount) ?? 0), 0)
  return { itemsTotal, adjustmentsTotal, total: itemsTotal + adjustmentsTotal }
}

/** 表 T: 合計の行 */
export function totalLine(total: number, printedTotal: number | null): { row: 'T1' | 'T2' | 'T3'; text: string | null; ok: boolean } {
  if (printedTotal === null) return { row: 'T1', text: null, ok: true }
  if (total === printedTotal) return { row: 'T2', text: '✓ レシートの合計と一致', ok: true }
  return { row: 'T3', text: `レシートの合計 ${yen(printedTotal)} と ${yen(Math.abs(total - printedTotal))} 違う`, ok: false }
}

const rateLabel = (r: Rate) => (r === null ? '' : `${r}% `)

/** 値引き・外税の 1 行の説明: 「外税(8% ¥33 · 10% ¥157)· 値引き −¥100」 */
export function adjustmentSummary(adjs: AdjustmentDraft[]): string {
  const part = (kind: 'tax' | 'discount', label: string) => {
    const xs = adjs.filter((a) => a.kind === kind)
    if (xs.length === 0) return null
    return `${label}(${xs.map((a) => `${rateLabel(a.taxRate)}${yen(parseYen(a.amount) ?? 0)}`).join(' · ')})`
  }
  return [part('tax', '外税'), part('discount', '値引き')].filter((x) => x !== null).join(' · ')
}

export type Body = {
  spentOn: string
  storeName: string
  paymentMethod: string
  items: { name: string | null; categoryId: number; taxRate: Rate; baseAmount: number; stockItemId: number | null; stockQuantity: number | null }[]
  adjustments: { kind: 'discount' | 'tax'; amount: number; taxRate: Rate }[]
}

/** 保存の体を作る。入力の誤りがあれば、人に見せる文の並びを返す(口の検査 §2.2 と同じ条件を先に見る) */
/** 本当にある日か(口の検査と同じ。2026-02-30 などは無い) */
export const isRealDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v

export function toBody(d: ExpenseDraft, today = jstToday(new Date())): { ok: true; body: Body } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isRealDate(d.spentOn)) errors.push('日付を入れてください。')
  else if (d.spentOn > today) errors.push('日付が今日より後です。買った日を入れてください。')
  if (d.paymentMethod === '') errors.push('支払いを選んでください。')
  if (d.items.length === 0) errors.push('品目を 1 つ以上入れてください。')
  const items = d.items.map((i, n) => {
    const no = `品目 ${n + 1}`
    const amount = parseYen(i.baseAmount)
    if (amount === null) errors.push(`${no}: 額を数字で入れてください。`)
    if (i.categoryId === null) errors.push(`${no}: 費目を選んでください。`)
    const qty = i.stockItemId === null ? null : parseYen(i.stockQuantity)
    if (i.stockItemId !== null && (qty === null || qty < 1)) errors.push(`${no}: 在庫に足す個数を 1 以上で入れてください。`)
    if (i.stockItemId !== null && amount !== null && amount <= 0) errors.push(`${no}: 返品・0 円の品目は在庫に足せません。品物を「なし」にしてください。`)
    return {
      name: i.name.trim() === '' ? null : i.name.trim(),
      categoryId: i.categoryId ?? 0,
      taxRate: i.taxRate,
      baseAmount: amount ?? 0,
      stockItemId: i.stockItemId,
      stockQuantity: i.stockItemId === null ? null : (qty ?? 0),
    }
  })
  const adjustments = d.adjustments.map((a, n) => {
    const amount = parseYen(a.amount)
    if (amount === null || amount === 0) errors.push(`値引き・外税 ${n + 1}: 0 でない額を数字で入れてください。`)
    return { kind: a.kind, amount: amount ?? 0, taxRate: a.taxRate }
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, body: { spentOn: d.spentOn, storeName: d.storeName.trim(), paymentMethod: d.paymentMethod, items, adjustments } }
}
