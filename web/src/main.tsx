import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router/dom'
import { withoutLoginParam } from './lib/login'
import { CACHE_VERSION, PERSIST_MAX_AGE, persister, queryClient } from './lib/query'
import { router } from './router'
import './lib/theme' // 表 Y: 残した明暗を当て直し、ほかのタブの変更を受ける
import './styles.css'

// ログインのための読み込みの印を URL から消す(基盤 §2.3 の 1)
const cleaned = withoutLoginParam(location.href)
if (cleaned !== null) history.replaceState(history.state, '', cleaned)

// 画面のファイルを端末に置き、在庫の通知を受け取る(public/sw.js)。開発サーバーでは登録しない(Vite の作り直しとぶつかるため)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e: unknown) => console.error('sw_register_failed', e instanceof Error ? e.name : 'unknown'))
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: PERSIST_MAX_AGE, buster: CACHE_VERSION }}>
      <RouterProvider router={router} />
    </PersistQueryClientProvider>
  </StrictMode>,
)
