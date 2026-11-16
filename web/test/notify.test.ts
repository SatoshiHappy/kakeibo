// 在庫の通知。設計書 表 N の各行・書いてから送る・送った応答の扱い(§1.16)と、購読の口(基盤 §7)
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { alertLine, runStockAlerts } from '../worker/notify'
import type { Bindings } from '../worker/types'
import { accessToken, addUser, request, serveTestCerts } from './helpers'

const db = env.DB
const NOW = new Date('2026-11-16T00:00:00Z') // 日本時間 11-16 9:00
const AT = '2026-11-15T00:00:00Z'
let userId: number
let seq = 0

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// テストのたびに作る鍵(リポジトリに鍵を置かない)
const vapidPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
const vapidEnv: Bindings = {
  ...(env as Bindings),
  VAPID_PUBLIC_KEY: b64url((await crypto.subtle.exportKey('raw', vapidPair.publicKey)) as ArrayBuffer),
  VAPID_PRIVATE_KEY: ((await crypto.subtle.exportKey('jwk', vapidPair.privateKey)) as JsonWebKey).d!,
  VAPID_SUBJECT: 'mailto:test@example.com',
}

async function clientKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  return {
    p256dh: b64url((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
  }
}

async function subscribe(endpoint: string) {
  const k = await clientKeys()
  await db
    .prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(userId, endpoint, k.p256dh, k.auth, AT, AT)
    .run()
}

/** 品物を作る。soon = 表 S でそろそろ買う(数 0・ペースなし = S1)、ok = まだある(数 1・ペースなし = S2) */
async function item(state: 'soon' | 'ok', opts: { alerted?: boolean; retired?: boolean } = {}) {
  const res = await db
    .prepare('INSERT INTO stock_items (name, notify_days, retired_at, alerted_at, created_by, created_at) VALUES (?, 7, ?, ?, ?, ?)')
    .bind(`通知${++seq}`, opts.retired ? AT : null, opts.alerted ? AT : null, userId, AT)
    .run()
  const id = res.meta.last_row_id
  const n = state === 'soon' ? 0 : 1
  await db.prepare("INSERT INTO stock_moves (stock_item_id, kind, delta, counted, moved_by, moved_at) VALUES (?, 'count', ?, ?, ?, ?)").bind(id, n, n, userId, AT).run()
  return id
}

const alertedAt = async (id: number) => (await db.prepare('SELECT alerted_at FROM stock_items WHERE id = ?').bind(id).first<{ alerted_at: string | null }>())!.alerted_at

/** 通知の口を差し替える。送り先ごとに返す状態コード(関数なら投げる) */
function pushService(statuses: Record<string, number | (() => never)>) {
  const calls: { url: string; init: RequestInit }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, init: init! })
    const s = statuses[url]
    if (typeof s === 'function') return s()
    return new Response(null, { status: s ?? 201 })
  })
  return calls
}

beforeEach(async () => {
  await addUser('alice@example.com')
  userId = (await db.prepare("SELECT id FROM users WHERE email = 'alice@example.com'").first<{ id: number }>())!.id
  await db.batch([db.prepare('DELETE FROM stock_moves'), db.prepare('DELETE FROM stock_items'), db.prepare('DELETE FROM push_subscriptions')])
})

describe('表 N', () => {
  it('N1: そろそろ買う・未送信 → alerted_at を書き、全部の購読に 1 通で送る', async () => {
    const a = await item('soon')
    const b = await item('soon')
    await subscribe('https://push.example/a')
    await subscribe('https://push.example/b')
    const calls = pushService({})
    const run = await runStockAlerts(vapidEnv, NOW)
    expect(run).toMatchObject({ alerted: [a, b], sent: 2 })
    expect(await alertedAt(a)).toBe('2026-11-16T00:00:00Z')
    expect(calls.map((c) => c.url)).toEqual(['https://push.example/a', 'https://push.example/b'])
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['content-encoding']).toBe('aes128gcm')
    expect(headers.authorization).toMatch(/^vapid t=.+, k=/)
    expect(headers.ttl).toBe('86400')
  })
  it('N2: そろそろ買う・送信済み → 何もしない(送らない)', async () => {
    const a = await item('soon', { alerted: true })
    await subscribe('https://push.example/a')
    const calls = pushService({})
    expect(await runStockAlerts(vapidEnv, NOW)).toMatchObject({ alerted: [], cleared: [], sent: 0 })
    expect(await alertedAt(a)).toBe(AT)
    expect(calls).toHaveLength(0)
  })
  it('N3: まだある・送信済み → alerted_at を NULL に戻す(送らない)', async () => {
    const a = await item('ok', { alerted: true })
    await subscribe('https://push.example/a')
    const calls = pushService({})
    expect(await runStockAlerts(vapidEnv, NOW)).toMatchObject({ alerted: [], cleared: [a] })
    expect(await alertedAt(a)).toBeNull()
    expect(calls).toHaveLength(0)
  })
  it('N4: まだある・未送信 → 何もしない', async () => {
    const a = await item('ok')
    const calls = pushService({})
    expect(await runStockAlerts(vapidEnv, NOW)).toMatchObject({ alerted: [], cleared: [] })
    expect(await alertedAt(a)).toBeNull()
    expect(calls).toHaveLength(0)
  })
  it('やめた品物は掛けない(alerted_at もそのまま)', async () => {
    const a = await item('soon', { retired: true })
    const b = await item('ok', { retired: true, alerted: true })
    pushService({})
    expect(await runStockAlerts(vapidEnv, NOW)).toMatchObject({ alerted: [], cleared: [] })
    expect(await alertedAt(a)).toBeNull()
    expect(await alertedAt(b)).toBe(AT)
  })
  it('判定が 2 回走っても 2 通にならない(書いてから送る)', async () => {
    await item('soon')
    await subscribe('https://push.example/a')
    const calls = pushService({})
    await runStockAlerts(vapidEnv, NOW)
    await runStockAlerts(vapidEnv, NOW)
    expect(calls).toHaveLength(1)
  })
  it('購読が 0 でも N1 は書く', async () => {
    const a = await item('soon')
    pushService({})
    expect(await runStockAlerts(vapidEnv, NOW)).toMatchObject({ alerted: [a], sent: 0 })
    expect(await alertedAt(a)).not.toBeNull()
  })
})

describe('送った応答の扱い', () => {
  it('404・410 は購読を消す。ほかの失敗と通信の失敗は記録だけで残す', async () => {
    await item('soon')
    for (const name of ['ok', 'gone404', 'gone410', 'err500', 'throw']) await subscribe(`https://push.example/${name}`)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    pushService({
      'https://push.example/gone404': 404,
      'https://push.example/gone410': 410,
      'https://push.example/err500': 500,
      'https://push.example/throw': () => {
        throw new TypeError('network')
      },
    })
    expect(await runStockAlerts(vapidEnv, NOW)).toMatchObject({ sent: 1, removed: 2, failed: 2 })
    const { results } = await db.prepare('SELECT endpoint FROM push_subscriptions ORDER BY id').all<{ endpoint: string }>()
    expect(results.map((r) => r.endpoint)).toEqual(['https://push.example/ok', 'https://push.example/err500', 'https://push.example/throw'])
  })
  it('VAPID の鍵が無ければ何も書かずに止める', async () => {
    const a = await item('soon')
    await expect(runStockAlerts({ ...vapidEnv, VAPID_PRIVATE_KEY: undefined }, NOW)).rejects.toThrow('vapid_not_configured')
    expect(await alertedAt(a)).toBeNull()
  })
})

describe('購読の口', () => {
  let token: string
  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  beforeEach(async () => {
    serveTestCerts()
    token = await accessToken()
  })
  it('登録し、同じ送り先は鍵を書き換えて 1 行のまま。消すと無くなる', async () => {
    const k1 = await clientKeys()
    const k2 = await clientKeys()
    const endpoint = 'https://web.push.apple.com/abc'
    expect((await request('/api/push/subscriptions', json('PUT', { endpoint, keys: k1 }))).status).toBe(200)
    expect((await request('/api/push/subscriptions', json('PUT', { endpoint, keys: k2 }))).status).toBe(200)
    const { results } = await db.prepare('SELECT p256dh FROM push_subscriptions').all<{ p256dh: string }>()
    expect(results).toEqual([{ p256dh: k2.p256dh }])
    expect((await request('/api/push/subscriptions', json('DELETE', { endpoint }))).status).toBe(204)
    expect((await db.prepare('SELECT count(*) AS n FROM push_subscriptions').first<{ n: number }>())!.n).toBe(0)
  })
  it('https でない送り先・鍵が無いは 400', async () => {
    const keys = await clientKeys()
    expect((await request('/api/push/subscriptions', json('PUT', { endpoint: 'http://x.example/a', keys }))).status).toBe(400)
    expect((await request('/api/push/subscriptions', json('PUT', { endpoint: 'https://x.example/a' }))).status).toBe(400)
  })
  it('公開鍵を返す', async () => {
    const res = await request('/api/push/key', { headers: { 'cf-access-jwt-assertion': token } })
    expect(await res.json()).toEqual({ publicKey: env.VAPID_PUBLIC_KEY })
  })
  it('ログインしていなければ 401(§3.1 の判定が掛かる)', async () => {
    expect((await request('/api/push/subscriptions', { method: 'PUT', body: '{}' })).status).toBe(401)
  })
})

describe('通知の本文の 1 行(画面の文言と同じ)', () => {
  const item = (daysLeft: number | null) =>
    ({
      name: '洗剤',
      status: { state: 'soon', forecast: daysLeft === null ? null : { paceDays: 10, runOutOn: '2026-11-20', daysLeft } },
    }) as unknown as Parameters<typeof alertLine>[0]
  it('あと 0 日・1 日はそのまま、過ぎた(-1)は「なくなる日を過ぎた」、予測なしは「残り 0」', () => {
    expect(alertLine(item(1))).toBe('洗剤(あと1日)')
    expect(alertLine(item(0))).toBe('洗剤(あと0日)')
    expect(alertLine(item(-1))).toBe('洗剤(なくなる日を過ぎた)')
    expect(alertLine(item(null))).toBe('洗剤(残り 0)')
  })
})
