// 在庫の通知の購読の状態と、口への登録の直し(基盤 §7)。ブラウザの部品は差し替える
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.fn()
vi.mock('./query', () => ({ api: { request: (...a: unknown[]) => request(...a) } }))
const { pushState, turnOffPush } = await import('./push')

const sub = { endpoint: 'https://push.example/1', toJSON: () => ({ endpoint: 'https://push.example/1', keys: {} }), unsubscribe: vi.fn(async () => true) }
let current: typeof sub | null

beforeEach(() => {
  current = sub
  request.mockReset()
  sub.unsubscribe.mockClear()
  vi.stubGlobal('Notification', { permission: 'granted' })
  vi.stubGlobal('window', { PushManager: class {}, Notification: {} })
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription: async () => current } }) } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.unstubAllGlobals())

describe('通知の状態', () => {
  it('端末に購読があれば、開くたびに口へ登録し直す(前の登録が失敗していても宛先ができる)', async () => {
    request.mockResolvedValue(undefined)
    expect(await pushState()).toBe('on')
    expect(request).toHaveBeenCalledWith('/api/push/subscriptions', { method: 'PUT', json: sub.toJSON() })
  })
  it('登録し直しが失敗しても状態は on のまま(次に開いたときにやり直す)', async () => {
    request.mockRejectedValue(new Error('offline'))
    expect(await pushState()).toBe('on')
  })
  it('購読が無ければ off で、口を呼ばない', async () => {
    current = null
    expect(await pushState()).toBe('off')
    expect(request).not.toHaveBeenCalled()
  })
  it('止める: 端末の購読を先に外し、口から消せなくても off', async () => {
    request.mockRejectedValue(new Error('offline'))
    expect(await turnOffPush()).toBe('off')
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('/api/push/subscriptions', { method: 'DELETE', json: { endpoint: sub.endpoint } })
  })
})
