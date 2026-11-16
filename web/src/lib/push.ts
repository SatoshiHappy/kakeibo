// 在庫の通知の購読(基盤 §7)。購読は、ホーム画面に追加したアプリの中のボタンを押したときだけ作る(iOS の決まり)
import { base64UrlToBytes } from './base64url'
import { api } from './query'

export type PushState = 'unsupported' | 'denied' | 'off' | 'on'

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

export async function pushState(): Promise<PushState> {
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return 'off'
  // 端末に購読があっても、口への登録が前に失敗していれば宛先が無い。開くたびに登録し直す(同じ endpoint は書き換えるだけ)。
  // 失敗しても次に開いたときにまたやり直す
  await api.request('/api/push/subscriptions', { method: 'PUT', json: sub.toJSON() }).catch((e: unknown) => console.error('push_resubscribe_failed', e))
  return 'on'
}

/** ボタンを押したときに呼ぶ(許可を求める → 購読 → 口に登録) */
export async function turnOnPush(): Promise<PushState> {
  if (!supported()) return 'unsupported'
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off'
  const { publicKey } = await api.request<{ publicKey: string }>('/api/push/key')
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) })
  await api.request('/api/push/subscriptions', { method: 'PUT', json: sub.toJSON() })
  return 'on'
}

/** この端末の通知を止める(購読を外し、口から消す) */
export async function turnOffPush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    // 端末の購読を先に外す。口から消せなくても、送った通知が 404・410 で返って口が宛先を消す(基盤 §7)
    await sub.unsubscribe()
    await api.request('/api/push/subscriptions', { method: 'DELETE', json: { endpoint: sub.endpoint } }).catch((e: unknown) => console.error('push_unregister_failed', e))
  }
  return 'off'
}
