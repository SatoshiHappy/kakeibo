// 在庫の通知の判定と送信。正本: docs/設計/データと照合.md 表 N・§1.16、基盤 §7
// 毎日 1 回の Cron Trigger(scheduled)から呼ぶ。HTTP の口は持たない(Access と §3.1 の判定を外す経路を作らない)
import { buildPushPayload, type VapidKeys } from '@block65/webcrypto-web-push'
import { stockOverview, type StockOverviewItem } from './routes/stock'
import { nowIso } from './time'
import type { Bindings } from './types'

/** 通知の口が受け取りを待つ時間(秒)。翌日の判定より前に切れる */
const TTL_SECONDS = 24 * 60 * 60

export type AlertRun = { alerted: number[]; cleared: number[]; sent: number; removed: number; failed: number }

function vapidKeys(env: Bindings): VapidKeys {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env
  // 鍵の無いまま判定だけ進めると alerted_at が入って通知が二度と出ないので、書く前に止める
  if (!publicKey || !privateKey || !subject) throw new Error('vapid_not_configured')
  return { publicKey, privateKey, subject }
}

/** 通知の本文の 1 行(品物 1 つ) */
export function alertLine(item: Pick<StockOverviewItem, 'name' | 'status'>) {
  const f = item.status!.forecast
  if (f === null) return `${item.name}(残り 0)`
  // 画面の文言(src/lib/stock.ts)と同じ: 負は「なくなる日を過ぎた」
  return f.daysLeft < 0 ? `${item.name}(なくなる日を過ぎた)` : `${item.name}(あと${f.daysLeft}日)`
}

/** 表 N。書いてから送る(同じ判定が 2 回走っても 2 通にならない) */
export async function runStockAlerts(env: Bindings, now: Date): Promise<AlertRun> {
  const vapid = vapidKeys(env)
  const db = env.DB
  const items = (await stockOverview(db, now)).filter((i) => i.status !== null) // やめた品物は掛けない
  const n1 = items.filter((i) => i.status!.state === 'soon' && !i.alerted)
  const n3 = items.filter((i) => i.status!.state === 'ok' && i.alerted)
  const run: AlertRun = { alerted: [], cleared: n3.map((i) => i.id), sent: 0, removed: 0, failed: 0 }
  if (n1.length + n3.length === 0) return run

  const at = nowIso(now)
  const results = await db.batch([
    ...n1.map((i) => db.prepare('UPDATE stock_items SET alerted_at = ? WHERE id = ? AND alerted_at IS NULL').bind(at, i.id)),
    ...n3.map((i) => db.prepare('UPDATE stock_items SET alerted_at = NULL WHERE id = ?').bind(i.id)),
  ])
  const toSend = n1.filter((_, k) => results[k]!.meta.changes === 1)
  run.alerted = toSend.map((i) => i.id)
  if (toSend.length === 0) return run

  const data = { title: 'そろそろ買う', body: toSend.map(alertLine).join('・'), url: '/stock' }
  const { results: subs } = await db
    .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions ORDER BY id')
    .all<{ id: number; endpoint: string; p256dh: string; auth: string }>()
  for (const sub of subs) {
    let status: number
    try {
      const payload = await buildPushPayload(
        { data, options: { ttl: TTL_SECONDS } },
        { endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        vapid,
      )
      status = (await fetch(sub.endpoint, payload)).status
    } catch (e) {
      // 送り直さない(データと照合 §0 の代償)。中身は出さず種類だけを記録する
      console.error('push_failed', e instanceof Error ? e.name : 'unknown')
      run.failed += 1
      continue
    }
    if (status >= 200 && status < 300) {
      run.sent += 1
    } else if (status === 404 || status === 410) {
      // 端末が購読をやめた
      await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run()
      run.removed += 1
    } else {
      console.error('push_failed', status)
      run.failed += 1
    }
  }
  return run
}
