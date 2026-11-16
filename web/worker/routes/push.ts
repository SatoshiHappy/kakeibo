// 通知の宛先(購読)の口。正本: docs/設計/データと照合.md §1.16、基盤 §7
// §3.1 の入口の判定をそのまま通る(例外の経路を作らない)
import { Hono } from 'hono'
import { z } from 'zod'
import { nowIso } from '../time'
import type { AppEnv } from '../types'

const endpoint = z.url({ protocol: /^https$/ }).max(2000)
const subscription = z.object({
  endpoint,
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
})

export const push = new Hono<AppEnv>()

// 画面が pushManager.subscribe の applicationServerKey に渡す公開鍵
push.get('/key', (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY }))

// 購読を登録する。同じ送り先なら鍵と利用者を書き換える(端末の登録し直し)
push.put('/subscriptions', async (c) => {
  const parsed = subscription.safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const s = parsed.data
  const now = nowIso()
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at`,
  )
    .bind(c.get('user').id, s.endpoint, s.keys.p256dh, s.keys.auth, now, now)
    .run()
  return c.json({ ok: true })
})

// 端末で通知を切ったら消す。無くても 204(端末の状態に合わせるだけ)
push.delete('/subscriptions', async (c) => {
  const parsed = z.object({ endpoint }).safeParse(await c.req.json().catch(() => undefined))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(parsed.data.endpoint).run()
  return c.body(null, 204)
})
