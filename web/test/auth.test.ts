// 基盤 §3.1 の入口の判定のデシジョン表を行ごとに通す。
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../worker/app'
import { accessToken, addUser, ORIGIN, request, serveTestCerts } from './helpers'

beforeEach(async () => {
  serveTestCerts()
  await addUser('alice@example.com', 'アリス')
})

async function withToken(token: string | undefined, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (token !== undefined) headers.set('cf-access-jwt-assertion', token)
  return request('/api/me', { ...init, headers })
}

describe('行 1: JWT の検証に失敗 → 401(利用者の表・CSRF はどれでも)', () => {
  it('ヘッダーが無い', async () => {
    expect((await withToken(undefined)).status).toBe(401)
  })
  it('別の鍵で署名されている', async () => {
    expect((await withToken(await accessToken({ signWith: 'other' }))).status).toBe(401)
  })
  it('iss が違う', async () => {
    expect((await withToken(await accessToken({ iss: 'https://evil.cloudflareaccess.com' }))).status).toBe(401)
  })
  it('aud が違う', async () => {
    expect((await withToken(await accessToken({ aud: 'other-app' }))).status).toBe(401)
  })
  it('期限が切れている', async () => {
    const past = Math.floor(Date.now() / 1000) - 60
    expect((await withToken(await accessToken({ expiresIn: past }))).status).toBe(401)
  })
  it('形が壊れている', async () => {
    expect((await withToken('not-a-jwt')).status).toBe(401)
  })
  it('利用者の表に無いメールでも 401 が先(優先順)', async () => {
    const token = await accessToken({ email: 'stranger@example.com', aud: 'other-app' })
    expect((await withToken(token)).status).toBe(401)
  })
})

describe('行 2: JWT は正しいが利用者の表に無い → 403', () => {
  it('知らないメール', async () => {
    const res = await withToken(await accessToken({ email: 'stranger@example.com' }))
    expect(res.status).toBe(403)
  })
  it('CSRF の検査に外れる要求でも 403(利用者の表が先)', async () => {
    const res = await request('/api/me', {
      method: 'POST',
      headers: {
        'cf-access-jwt-assertion': await accessToken({ email: 'stranger@example.com' }),
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example.com',
      },
      body: 'a=1',
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
  })
})

describe('行 3: 利用者の表にあるが、状態を変える要求で CSRF の検査に外れる → 403', () => {
  it('よそのオリジンからのフォームの POST', async () => {
    const res = await request('/api/me', {
      method: 'POST',
      headers: {
        'cf-access-jwt-assertion': await accessToken(),
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example.com',
        'sec-fetch-site': 'cross-site',
      },
      body: 'a=1',
    })
    expect(res.status).toBe(403)
  })
})

describe('行 4: 利用者の表にあり、CSRF に合う(または読むだけ)→ 通す', () => {
  it('GET はその利用者として扱われる', async () => {
    const res = await withToken(await accessToken())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ email: 'alice@example.com', displayName: 'アリス' })
  })
  it('メールの大文字小文字をそろえて引く', async () => {
    const res = await withToken(await accessToken({ email: 'Alice@Example.com' }))
    expect(res.status).toBe(200)
  })
  it('同じオリジンからの状態を変える要求は CSRF を通る(存在しない口なので 404)', async () => {
    const res = await request('/api/me', {
      method: 'POST',
      headers: {
        'cf-access-jwt-assertion': await accessToken(),
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://kakeibo.test',
      },
      body: 'a=1',
    })
    expect(res.status).toBe(404)
  })
})

describe('応答の見出し', () => {
  it('断る応答(401)にも通る応答(200)にも nosniff・frame の禁止を付ける', async () => {
    for (const res of [await withToken(undefined), await withToken(await accessToken())]) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    }
  })
})

describe('公開鍵を取れない(基盤 §3.1)', () => {
  // 鍵の控えはチームのドメインごとなので、まだ控えの無いドメインで確かめる
  const down = 'https://down.cloudflareaccess.example'
  const call = async () => {
    const headers = new Headers({ 'cf-access-jwt-assertion': await accessToken({ iss: down }), origin: ORIGIN })
    return app.request(`${ORIGIN}/api/me`, { headers }, { ...env, ACCESS_TEAM_DOMAIN: down })
  }
  it('certs の口が 5xx なら 401 でなく 500(ログインし直しても直らないため)', async () => {
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === `${down}/cdn-cgi/access/certs`) return new Response('down', { status: 503 })
      return realFetch(input, init)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
  })
})
