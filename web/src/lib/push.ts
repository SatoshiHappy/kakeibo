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
  return sub ? 'on' : 'off'
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
    await api.request('/api/push/subscriptions', { method: 'DELETE', json: { endpoint: sub.endpoint } })
    await sub.unsubscribe()
  }
  return 'off'
}
