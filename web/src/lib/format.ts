// 表示の書き方(金額・月)。業務の日付は日本時間(設計 §1.1)

/** ¥48,800 / −¥300(モック 14 版の書き方) */
export function yen(n: number): string {
  return `${n < 0 ? '−' : ''}¥${Math.abs(n).toLocaleString('en-US')}`
}

/** 今日(日本時間)の YYYY-MM-DD */
export function jstToday(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export const currentMonth = (now = new Date()) => jstToday(now).slice(0, 7)

/** YYYY-MM を n か月ずらす */
export function shiftMonth(month: string, n: number): string {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1))
  return d.toISOString().slice(0, 7)
}

/** 2026年11月 */
export const monthLabel = (month: string) => `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`

/** 11/15 */
export const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`

export const isMonth = (s: string | null): s is string => s !== null && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)

/** 時刻の HH:MM(日本時間) */
const jstTime = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(11, 16)

/** 撮った時刻の書き方: 今日 18:42 / 昨日 12:10 / 11/12 18:42(モック 14 版の下書き) */
export function whenLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const day = jstToday(d)
  const today = jstToday(now)
  const yesterday = jstToday(new Date(now.getTime() - 24 * 60 * 60 * 1000))
  const prefix = day === today ? '今日' : day === yesterday ? '昨日' : shortDate(day)
  return `${prefix} ${jstTime(d)}`
}
