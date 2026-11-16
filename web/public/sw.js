// Service Worker。正本: docs/設計/基盤.md §2.3 の 1(画面のファイルを端末に置く)・§7(在庫の通知を受け取る)
// 本番のビルドだけで登録する(src/main.tsx)。版を変えたら CACHE の名前を上げる(古い置き場は activate で消す)
const CACHE = 'kakeibo-shell-v1'
const SHELL = '/' // 画面(SPA の HTML)は 1 つなので、この鍵に置く

// 入れた時点で画面を 1 回取りに行って置く(初めて開いた直後から、網が無くても開けるように)。
// 置けなくても(Access のログインへの転送・通信の失敗)入れることは止めない。次に開いたときに置く
self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(refreshShell(new Request(SHELL)).catch(() => undefined))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

/** 端末に置いてよい応答: 成功・転送なし・同じオリジン(Access のログイン画面を置かない) */
const storable = (res) => res.ok && !res.redirected && res.type === 'basic'

/** 画面の HTML を取り直して置き、それが指す /assets/* もそろえる(使わなくなった古い版は消す) */
async function refreshShell(request) {
  const res = await fetch(request)
  if (!storable(res)) return res
  const html = await res.clone().text()
  const assets = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => new URL(m[1], self.location.origin).href))
  const cache = await caches.open(CACHE)
  const held = new Set((await cache.keys()).map((r) => r.url))
  await cache.addAll([...assets].filter((a) => !held.has(a)))
  // HTML は assets がそろってから置く(半端な版を出さない)
  await cache.put(SHELL, res.clone())
  for (const url of held) if (new URL(url).pathname.startsWith('/assets/') && !assets.has(url)) await cache.delete(url)
  return res
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  // API は TanStack Query が端末に残す。Access の口は通さない
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cdn-cgi/')) return

  if (req.mode === 'navigate') {
    // ログインのための読み込み(表 K)は網から(古い画面を出し続けてログインし直せなくなるのを防ぐ)
    if (url.searchParams.has('_login')) return
    // 端末に置いた画面を先に出し、裏で取り直す
    event.respondWith(
      caches.match(SHELL).then((cached) => {
        const fresh = refreshShell(req)
        if (cached) {
          event.waitUntil(fresh.catch(() => undefined)) // 通信の失敗は次に開いたときにまた取り直す
          return cached
        }
        return fresh
      }),
    )
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    // 名前に版の印が付くので、置いた物をそのまま使う
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ??
          fetch(req).then(async (res) => {
            if (storable(res)) await (await caches.open(CACHE)).put(req, res.clone())
            return res
          }),
      ),
    )
  }
})

// 在庫の通知(データと照合 表 N の後の送り方。中身は worker/notify.ts の data)
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? '家計簿', {
      body: data.body ?? '',
      data: { url: data.url ?? '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url ?? '/', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientList) => {
      // 開いているアプリがあれば前に出して移る(移れなければ新しく開く)。無ければ開く(MDN の notificationclick の形)
      for (const client of clientList) {
        if ('focus' in client) {
          return client
            .focus()
            .then((c) => c.navigate(target))
            .catch(() => self.clients.openWindow(target))
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
