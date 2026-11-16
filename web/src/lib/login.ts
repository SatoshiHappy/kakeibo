// ログインのための読み込み(基盤 §2.3 の 1・表 K の K2・K3)。`_login=1` の付いた読み込みは Service Worker を通らない(public/sw.js)
export const LOGIN_PARAM = '_login'

/** 今の URL に `_login=1` を付けた URL(Access のログインの後にこの URL へ戻る) */
export function loginReloadUrl(href: string): string {
  const url = new URL(href)
  url.searchParams.set(LOGIN_PARAM, '1')
  return url.href
}

/** 読み込んだ後に URL から `_login` を消す。消す必要が無ければ null */
export function withoutLoginParam(href: string): string | null {
  const url = new URL(href)
  if (!url.searchParams.has(LOGIN_PARAM)) return null
  url.searchParams.delete(LOGIN_PARAM)
  return url.pathname + url.search + url.hash
}
