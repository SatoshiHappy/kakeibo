// 開発用のログイン(基盤 §3.2): 開発サーバー(vite dev)だけが、自前の鍵で署名した Cf-Access-Jwt-Assertion を /api/* に付ける。
// Worker は本番と同じ検証を通す(検証を外す切り替えは Worker に作らない)。公開鍵は「チームのドメイン + /cdn-cgi/access/certs」の形で
// この開発サーバーが返す。本番のビルド(vite build)には入らない(vite.config.ts が serve のときだけ使う)。
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { Plugin } from 'vite'

/** 開発サーバーの待ち受け(DEV_PORT で変えられる。E2E を別のポートで走らせるとき) */
export const DEV_PORT = Number(process.env.DEV_PORT ?? 5173)
export const DEV_ORIGIN = `http://127.0.0.1:${DEV_PORT}`
export const DEV_TEAM_DOMAIN = `${DEV_ORIGIN}/dev-access`
export const DEV_AUD = 'kakeibo-local'
/** ログインする開発の利用者。D1(ローカル)の users に要る(npm run dev:setup が入れる) */
export const DEV_EMAIL = process.env.DEV_USER_EMAIL ?? 'dev@example.com'

const KID = 'dev-key'

export function devAccess(): Plugin {
  const keys = generateKeyPair('RS256')
  return {
    name: 'kakeibo-dev-access',
    apply: 'serve',
    configureServer(server) {
      // ほかの middleware(Cloudflare のプラグイン)より前に入る
      server.middlewares.use(async (req, res, next) => {
        try {
          const url = req.url ?? ''
          if (url === '/dev-access/cdn-cgi/access/certs') {
            const jwk = { ...(await exportJWK((await keys).publicKey)), kid: KID, alg: 'RS256', use: 'sig' }
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ keys: [jwk] }))
            return
          }
          if (url.startsWith('/api/')) {
            req.headers['cf-access-jwt-assertion'] = await new SignJWT({ email: DEV_EMAIL })
              .setProtectedHeader({ alg: 'RS256', kid: KID })
              .setIssuer(DEV_TEAM_DOMAIN)
              .setAudience(DEV_AUD)
              .setIssuedAt()
              .setExpirationTime('1h')
              .sign((await keys).privateKey)
          }
          next()
        } catch (e) {
          next(e)
        }
      })
    },
  }
}
