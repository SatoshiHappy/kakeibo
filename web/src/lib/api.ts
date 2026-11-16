// 画面の API 呼び出しは全部ここを通す。正本: docs/設計/基盤.md §3.2・表 K
// 依存(fetch・sessionStorage・再読み込み)は差し替えられる形にして、表 K の各行を単体テストで通す

/** 表 K の「印」(この理由で再読み込みした印)。タブごとの sessionStorage に置く */
export const RELOAD_FLAG = 'kakeibo:reloaded-for-login'

export class ApiError extends Error {
  /** 通信の失敗(K6)なら null */
  readonly status: number | null
  /** 応答の `error`、無ければ `http_<status>` */
  readonly code: string
  /** 応答の体(`check` など理由の細目。読めなければ null) */
  readonly body: Record<string, unknown> | null
  constructor(status: number | null, code: string, body: Record<string, unknown> | null = null) {
    super(code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.body = body
  }
}

/** login_failed = K3(ログインを確かめられない)・not_registered = K4(利用者の表に無い) */
export type AuthState = 'ok' | 'login_failed' | 'not_registered'

export type ApiDeps = {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  reload: () => void
}

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** JSON の体。FormData を送るときは body を使う */
  json?: unknown
  body?: FormData
}

export function createApi(deps: ApiDeps) {
  const draftSavers = new Set<() => Promise<void>>()
  const listeners = new Set<(s: AuthState) => void>()
  let state: AuthState = 'ok'
  let reloading = false

  const setState = (s: AuthState) => {
    if (s === state) return
    state = s
    for (const l of listeners) l(s)
  }

  /** 登録された下書きの保存を全部終えてから再読み込みする(K2 と K3 の「ログインし直す」の共通の道) */
  async function saveDraftsAndReload(flag: boolean) {
    if (reloading) return // 同時に複数の 401 が来ても、再読み込みは 1 回だけ
    reloading = true
    const results = await Promise.allSettled([...draftSavers].map((save) => save()))
    for (const r of results) {
      // 下書きを残せなくてもログインには進む(残せなかったことは記録する)
      if (r.status === 'rejected') console.error('draft_save_failed', r.reason instanceof Error ? r.reason.name : 'unknown')
    }
    if (flag) deps.storage.setItem(RELOAD_FLAG, '1')
    else deps.storage.removeItem(RELOAD_FLAG)
    deps.reload()
  }
  const goToLogin = () => saveDraftsAndReload(true)

  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' }
    if (opts.json !== undefined) headers['Content-Type'] = 'application/json'
    let res: Response
    try {
      res = await deps.fetch(path, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
        credentials: 'same-origin',
      })
    } catch {
      throw new ApiError(null, 'offline') // K6
    }
    if (res.ok) {
      // K1
      deps.storage.removeItem(RELOAD_FLAG)
      setState('ok')
      return (res.status === 204 ? undefined : await res.json()) as T
    }
    if (res.status === 401) {
      if (deps.storage.getItem(RELOAD_FLAG) !== null) setState('login_failed') // K3
      else await goToLogin() // K2
      throw new ApiError(401, 'unauthenticated')
    }
    if (res.status === 403) {
      // K4: 利用者の表に無い人。画面の上に知らせる(どの画面でも同じ文。再読み込みしても変わらない)
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (body?.error === 'forbidden') setState('not_registered')
      throw new ApiError(403, 'forbidden')
    }
    // K5
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    throw new ApiError(res.status, typeof body?.error === 'string' ? body.error : `http_${res.status}`, body)
  }

  return {
    request,
    /** 入力中の画面が、401 で再読み込みする前に下書きを IndexedDB に残す関数を登録する。戻り値で外す */
    registerDraftSaver(save: () => Promise<void>) {
      draftSavers.add(save)
      return () => draftSavers.delete(save)
    },
    onAuthState(listener: (s: AuthState) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    authState: () => state,
    /** K3 の「ログインし直す」: 印を消し、K2 と同じく下書きを残してから再読み込みする */
    relogin: () => saveDraftsAndReload(false),
  }
}

export type Api = ReturnType<typeof createApi>
