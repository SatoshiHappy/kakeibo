// テスト用のログインの証明。Worker の検証は本番と同じ道を通す(検証を外す切り替えは作らない。基盤 §3.2)。
// 公開鍵は「チームのドメイン + /cdn-cgi/access/certs」への fetch を差し替えて返す。
import { env } from 'cloudflare:workers'
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose'
import { vi } from 'vitest'
import { app } from '../worker/app'

export const KID = 'test-key'
const keys = await generateKeyPair('RS256')
const otherKeys = await generateKeyPair('RS256')
const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }

export function serveTestCerts() {
  const certsUrl = `${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === certsUrl) return Response.json({ keys: [publicJwk] })
    return realFetch(input, init)
  })
}

type TokenOptions = {
  email?: string
  iss?: string
  aud?: string
  expiresIn?: string | number
  signWith?: 'test' | 'other'
}

export async function accessToken(opts: TokenOptions = {}) {
  const key: CryptoKey = opts.signWith === 'other' ? otherKeys.privateKey : keys.privateKey
  return new SignJWT({ email: opts.email ?? 'alice@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(opts.iss ?? env.ACCESS_TEAM_DOMAIN)
    .setAudience(opts.aud ?? env.ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(key)
}

export async function addUser(email: string, displayName = email) {
  await env.DB.prepare(
    "INSERT INTO users (email, display_name, created_at) VALUES (?, ?, '2026-11-15T00:00:00Z') ON CONFLICT (email) DO NOTHING",
  )
    .bind(email, displayName)
    .run()
}

export const ORIGIN = 'http://kakeibo.test'

/** ブラウザと同じく、状態を変える要求には同じオリジンの Origin を付ける(テストで上書きできる)。 */
export function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (!headers.has('origin')) headers.set('origin', ORIGIN)
  return app.request(`${ORIGIN}${path}`, { ...init, headers }, env)
}
