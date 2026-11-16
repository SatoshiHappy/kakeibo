// 在庫の画面の並べ方と文言(見本はモック 14 版の stock)。状態(そろそろ買う・まだある)は API の表 S の結果をそのまま使う
import { shortDate } from './format'

export type StockItem = {
  id: number
  name: string
  notifyDays: number
  retired: boolean
  quantity: number
  state: 'soon' | 'ok' | null
  forecast: { paceDays: number; runOutOn: string; daysLeft: number } | null
  undoableMoveId: number | null
}

const daysOrLast = (i: StockItem) => (i.forecast === null ? Number.POSITIVE_INFINITY : i.forecast.daysLeft)

/** そろそろ買う(予測なし = 残り 0 を先に、続けてあと何日の少ない順)と、まだある(なくなるのが早い順。予測なしは最後)。やめた品物は出さない */
export function stockSections(items: StockItem[]) {
  const live = items.filter((i) => !i.retired)
  const soon = live
    .filter((i) => i.state === 'soon')
    .sort((a, b) => (a.forecast === null ? -Infinity : a.forecast.daysLeft) - (b.forecast === null ? -Infinity : b.forecast.daysLeft) || a.id - b.id)
  const ok = live.filter((i) => i.state === 'ok').sort((a, b) => daysOrLast(a) - daysOrLast(b) || a.id - b.id)
  return { soon, ok }
}

/** 予測の 2 行(見出しの行・小さい字の行) */
export function forecastText(i: StockItem): { main: string; meta: string } {
  if (i.forecast === null) return { main: i.quantity <= 0 ? '買い置きがありません' : 'ペースを覚えている途中', meta: '使った記録 2 回で予測' }
  const f = i.forecast
  const main = f.daysLeft < 0 ? `なくなる日を過ぎた · ${shortDate(f.runOutOn)}ごろ` : `あと${f.daysLeft}日 · ${shortDate(f.runOutOn)}ごろ`
  return { main, meta: `${Math.max(1, Math.round(f.paceDays))}日に1つ` }
}
