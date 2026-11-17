import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router/dom'
import { isStandalone, launchTarget, readAndMarkLaunched } from './lib/launch'
import { withoutLoginParam } from './lib/login'
import { CACHE_VERSION, PERSIST_MAX_AGE, persister, queryClient } from './lib/query'
import { createRouter } from './router'
import './lib/theme' // 表 Y: 残した明暗を当て直し、ほかのタブの変更を受ける
// 字体は同梱する(別のオリジンの字体の CSS を待って最初の描画が止まらないように。基盤 §2.3 の 1)。数字の Inter はラテン文字だけ
import '@fontsource/noto-sans-jp/400.css'
import '@fontsource/noto-sans-jp/500.css'
import '@fontsource/noto-sans-jp/700.css'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-700.css'
import './styles.css'

// ログインのための読み込みの印を URL から消す(基盤 §2.3 の 1)
const cleaned = withoutLoginParam(location.href)
if (cleaned !== null) history.replaceState(history.state, '', cleaned)

// アプリを開いた最初の画面はホーム(基盤 表 O)
const launch = launchTarget({ standalone: isStandalone(), launched: readAndMarkLaunched(() => sessionStorage), href: location.href })
if (launch !== null) history.replaceState(history.state, '', launch)

// 画面の行き先は、上の URL の書き換えが済んでから作る(作った時の URL を読むため)
const router = createRouter()

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
