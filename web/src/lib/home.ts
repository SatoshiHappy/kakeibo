// ホームの応答(設計 §4.5)。印(撮る・在庫・≡)はどの画面でも、端末に残したホームの応答から読む
import { useQuery } from '@tanstack/react-query'
import type { CategoryAmount } from './categories'
import { currentMonth } from './format'
import { api } from './query'

export type HomeResponse = {
  month: string
  categories: CategoryAmount[]
  draftCount: number
  reviewCount: number
  stockSoon: { id: number; name: string; quantity: number; forecast: { paceDays: number; runOutOn: string; daysLeft: number } | null }[]
}

export const homePath = (month: string) => `/api/home?month=${month}`

/** 印に使う今月のホームの応答。端末に残した物があれば開いた画面では取りに行かない(staleTime: Infinity)。
 * 保存の後に読み直す一覧(refetchAfterSave)に /api/home が入っていれば、どの画面でも取り直して印を新しくする */
export function useBadgeCounts() {
  const path = homePath(currentMonth())
  const { data } = useQuery({ queryKey: [path], queryFn: () => api.request<HomeResponse>(path), staleTime: Infinity })
  return { draft: data?.draftCount ?? 0, review: data?.reviewCount ?? 0, stock: data?.stockSoon.length ?? 0 }
}
