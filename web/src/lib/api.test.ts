// 表 K の各行(基盤 §3.2)
import { describe, expect, it, vi } from 'vitest'
import { ApiError, createApi, RELOAD_FLAG, type ApiDeps } from './api'

function setup(responses: (Response | Error)[], flag = false) {
  const store = new Map<string, string>(flag ? [[RELOAD_FLAG, '1']] : [])
  const calls: { path: string; init: RequestInit }[] = []
  const deps: ApiDeps = {
    fetch: vi.fn(async (path: string, init: RequestInit) => {
      calls.push({ path, init })
      const r = responses.shift()!
      if (r instanceof Error) throw r
      return r
    }),
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
    reload: vi.fn(),
  }
  return { api: createApi(deps), deps, store, calls }
}
const json = (status: number, body: unknown) => Response.json(body, { status })

describe('表 K', () => {
  it('K1: 2xx は応答を返し、印を消す。X-Requested-With を付ける', async () => {
    const { api, store, calls } = setup([json(200, { a: 1 })], true)
    expect(await api.request('/api/x')).toEqual({ a: 1 })
    expect(store.has(RELOAD_FLAG)).toBe(false)
    expect((calls[0]!.init.headers as Record<string, string>)['X-Requested-With']).toBe('XMLHttpRequest')
  })
  it('K1: 204 は undefined。JSON の体には Content-Type を付ける', async () => {
    const { api, calls } = setup([new Response(null, { status: 204 })])
    expect(await api.request('/api/x', { method: 'DELETE', json: { a: 1 } })).toBeUndefined()
    expect(calls[0]!.init).toMatchObject({ method: 'DELETE', body: '{"a":1}' })
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })
  it('K2: 印が無い 401 は、下書きを残し終えてから印を付けて再読み込み', async () => {
    const { api, deps, store } = setup([json(401, { error: 'unauthenticated' })])
    const order: string[] = []
    api.registerDraftSaver(async () => void order.push('saved'))
    vi.mocked(deps.reload).mockImplementation(() => void order.push('reload'))
    await expect(api.request('/api/x')).rejects.toMatchObject({ status: 401 })
    expect(order).toEqual(['saved', 'reload'])
    expect(store.get(RELOAD_FLAG)).toBe('1')
  })
  it('K2: 同時に 2 つの 401 でも再読み込みは 1 回。下書きを残せなくても再読み込みする', async () => {
    const { api, deps } = setup([json(401, {}), json(401, {})])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    api.registerDraftSaver(async () => {
      throw new Error('idb')
    })
    await Promise.allSettled([api.request('/a'), api.request('/b')])
    expect(deps.reload).toHaveBeenCalledTimes(1)
  })
  it('K3: 印がある 401 は再読み込みせず login_failed。ログインし直すで印を消し、下書きを残し終えてから再読み込み', async () => {
    const { api, deps, store } = setup([json(401, {})], true)
    const seen: string[] = []
    api.onAuthState((s) => seen.push(s))
    await expect(api.request('/api/x')).rejects.toBeInstanceOf(ApiError)
    expect(deps.reload).not.toHaveBeenCalled()
    expect(seen).toEqual(['login_failed'])
    const order: string[] = []
    api.registerDraftSaver(async () => void order.push('saved'))
    vi.mocked(deps.reload).mockImplementation(() => void order.push('reload'))
    await api.relogin()
    expect(store.has(RELOAD_FLAG)).toBe(false)
    expect(order).toEqual(['saved', 'reload'])
  })
  it('K4: 403 は再読み込みせず forbidden(印があってもなくても)', async () => {
    for (const flag of [false, true]) {
      const { api, deps } = setup([json(403, { error: 'forbidden' })], flag)
      await expect(api.request('/api/x')).rejects.toMatchObject({ status: 403, code: 'forbidden' })
      expect(deps.reload).not.toHaveBeenCalled()
      expect(api.authState()).toBe('not_registered')
    }
  })
  it('K4: 利用者の表に無い印は、次に通った応答(K1)で消える。体が forbidden でない 403(CSRF の文字)では立てない', async () => {
    const { api } = setup([json(403, { error: 'forbidden' }), json(200, {})])
    await expect(api.request('/a')).rejects.toMatchObject({ status: 403 })
    expect(api.authState()).toBe('not_registered')
    await api.request('/b')
    expect(api.authState()).toBe('ok')
    const other = setup([new Response('Forbidden', { status: 403 })])
    await expect(other.api.request('/a')).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    expect(other.api.authState()).toBe('ok')
  })
  it('K5: ほかの 4xx・5xx は応答の error、無ければ http_<status>', async () => {
    const { api } = setup([json(422, { error: 'bad_format', check: 'C2' }), new Response('x', { status: 500 })])
    // 理由の細目(check)も体として持つ
    await expect(api.request('/a')).rejects.toMatchObject({ status: 422, code: 'bad_format', body: { error: 'bad_format', check: 'C2' } })
    await expect(api.request('/b')).rejects.toMatchObject({ status: 500, code: 'http_500', body: null })
  })
  it('K6: 通信の失敗は offline(status なし)', async () => {
    const { api } = setup([new TypeError('Failed to fetch')])
    await expect(api.request('/a')).rejects.toMatchObject({ status: null, code: 'offline' })
  })
})
