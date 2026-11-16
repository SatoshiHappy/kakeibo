// API の入口の判定。正本: docs/設計/基盤.md §3.1・§3.2
// 結果の優先順: JWT の検証(401)→ 利用者の表(403)→ CSRF の検査(403)→ 通す
import type { MiddlewareHandler } from 'hono'
import { csrf } from 'hono/csrf'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { AppEnv, User } from './types'

const jwksByTeamDomain = new Map<string, JWTVerifyGetKey>()

function jwksFor(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksByTeamDomain.get(teamDomain)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`))
    jwksByTeamDomain.set(teamDomain, jwks)
  }
  return jwks
}

async function verifiedEmail(token: string | undefined, teamDomain: string, aud: string) {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, jwksFor(teamDomain), {
      issuer: teamDomain,
      audience: aud,
    })
    return typeof payload.email === 'string' ? payload.email.toLowerCase() : null
  } catch {
    // 署名・iss・aud・期限のどれかが合わない。理由は応答に出さない
    return null
  }
}

const csrfCheck = csrf()

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const email = await verifiedEmail(
    c.req.header('cf-access-jwt-assertion'),
    c.env.ACCESS_TEAM_DOMAIN,
    c.env.ACCESS_AUD,
  )
  if (!email) return c.json({ error: 'unauthenticated' }, 401)

  const user = await c.env.DB.prepare('SELECT id, email, display_name FROM users WHERE email = ?')
    .bind(email)
    .first<User>()
  if (!user) return c.json({ error: 'forbidden' }, 403)

  c.set('user', user)
  return csrfCheck(c, next)
}
