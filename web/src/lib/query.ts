// データ取得: TanStack Query。最後の応答を端末(IndexedDB)に残し、開いたら先にそれを出して裏で取り直す(基盤 §2.3)
// 残し方は TanStack Query の公式の「Building A Persister」(idb-keyval)の形
import { QueryClient, useQuery, type QueryFilters, type UseQueryOptions } from '@tanstack/react-query'
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client'
import { del, get, set } from 'idb-keyval'
import { ApiError, createApi } from './api'
import { loginReloadUrl } from './login'

/** 端末に残した応答を使う期間。gcTime はこれ以上にする(公式の注意: gcTime < maxAge だと早く捨てられる) */
export const PERSIST_MAX_AGE = 30 * 24 * 60 * 60 * 1000

/** 応答の形を変えたら上げる(端末に残った古い形の応答を捨てる) */
export const CACHE_VERSION = '4'

export const api = createApi({
  fetch: (input, init) => fetch(input, init),
  storage: sessionStorage,
  // Service Worker を通さず網から読み、Access のログインへ(基盤 §2.3 の 1)
  reload: () => location.replace(loginReloadUrl(location.href)),
})

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: PERSIST_MAX_AGE,
      // 残した応答を先に出し、画面を開くたびに裏で取り直す
      staleTime: 0,
      // 4xx(ログイン・入力の誤り)はやり直しても変わらない。通信の失敗と 5xx は 1 回だけやり直す
      retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status !== null && error.status < 500),
    },
  },
})

export const persister = {
  persistClient: async (client: PersistedClient) => set('kakeibo-query', client),
  restoreClient: async () => get<PersistedClient>('kakeibo-query'),
  removeClient: async () => del('kakeibo-query'),
} satisfies Persister

/** GET の口を 1 つ読む。鍵は path(同じ path は同じ応答を共有する) */
export function useApiQuery<T>(path: string, options: Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'> = {}) {
  return useQuery({ ...options, queryKey: [path], queryFn: () => api.request<T>(path) })
}

/**
 * 保存の後に読み直す。進行中の読み込み(保存より前に出た物)は取り消してから読み直す。
 * TanStack Query は、まだデータの無いクエリの読み直しを進行中の読み込みにまとめる(query.js の fetch)ので、
 * 取り消さないと保存の前の内容が出たままになる
 */
export async function refetchAfterSave(filters: QueryFilters) {
  await queryClient.cancelQueries(filters)
  await queryClient.invalidateQueries(filters)
}
