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

/** 印に使う今月のホームの応答。取りに行かず、端末に残した物だけを読む(ホームを開いたときに取り直す) */
export function useBadgeCounts() {
  const path = homePath(currentMonth())
  const { data } = useQuery({ queryKey: [path], queryFn: () => api.request<HomeResponse>(path), enabled: false })
  return { draft: data?.draftCount ?? 0, review: data?.reviewCount ?? 0, stock: data?.stockSoon.length ?? 0 }
}
