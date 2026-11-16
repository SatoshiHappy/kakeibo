// 在庫のペース・なくなる日・状態。正本: docs/設計/データと照合.md §2.5・表 S
// 在庫の一覧の口と通知の判定(表 N)の両方がここを使う。日付はどれも日本時間の YYYY-MM-DD。

/** 窓 = 「使った」の新しい方から最大この数(§2.5) */
export const PACE_WINDOW = 4

export type StockInput = {
  /** 品物の数 n(負もありうる。§0 の代償) */
  quantity: number
  /** 「使った」の日(日本時間)。新しい順 */
  useDatesNewestFirst: string[]
  /** 知らせる日数 N(`stock_items.notify_days`) */
  notifyDays: number
  /** 今日(日本時間) */
  today: string
}

export type Forecast = {
  /** ペース p = 1 つを何日で使うか(実数。丸めは画面) */
  paceDays: number
  /** なくなる日 */
  runOutOn: string
  /** あと d 日(負もありうる) */
  daysLeft: number
}

export type StockStatus = {
  state: 'soon' | 'ok'
  forecast: Forecast | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS
const fromDayNumber = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10)

/** 表 S */
export function stockStatus(input: StockInput): StockStatus {
  const window = input.useDatesNewestFirst.slice(0, PACE_WINDOW)
  const k = window.length
  const span = k >= 2 ? dayNumber(window[0]!) - dayNumber(window[k - 1]!) : 0
  if (k < 2 || span < 1) {
    // S1・S2: ペースなし。残りが 0 以下のときだけそろそろ買う
    return { state: input.quantity <= 0 ? 'soon' : 'ok', forecast: null }
  }
  // なくなる日 = 最新の使った日 + ⌊p × (max(n, 0) + 1)⌋。p = span / (k − 1) を整数のまま割って誤差を出さない
  const packs = Math.max(input.quantity, 0) + 1
  const last = dayNumber(window[0]!)
  const runOut = last + Math.floor((span * packs) / (k - 1))
  const daysLeft = runOut - dayNumber(input.today)
  return {
    // S3・S4
    state: daysLeft <= input.notifyDays ? 'soon' : 'ok',
    forecast: { paceDays: span / (k - 1), runOutOn: fromDayNumber(runOut), daysLeft },
  }
}

/** 「使った」を取り消せる間(表 U の U8・U9)。ちょうど 10 分は取り消せる */
export const UNDO_WINDOW_SECONDS = 10 * 60

/** この時刻以降に押した「使った」なら取り消せる(`moved_at >= cutoff`。日時は秒までの UTC の ISO 8601) */
export function undoCutoff(now: Date): string {
  return new Date(now.getTime() - UNDO_WINDOW_SECONDS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** ホームの「そろそろ買う」の並び(表 S の脚注): 予測なし(S1)を先に、続けて d の小さい順、同じなら id */
export function soonOrder(a: { id: number; status: StockStatus }, b: { id: number; status: StockStatus }): number {
  const d = (x: StockStatus) => (x.forecast === null ? Number.NEGATIVE_INFINITY : x.forecast.daysLeft)
  return d(a.status) - d(b.status) || a.id - b.id
}
