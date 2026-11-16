// 表 K の K2・K3 の再読み込みの URL(Service Worker を通さない印)
import { describe, expect, it } from 'vitest'
import { loginReloadUrl, withoutLoginParam } from './login'

describe('ログインのための読み込みの URL', () => {
  it('K2・K3 の再読み込みは _login=1 を付ける(ほかの検索の条件と # は残す)', () => {
    expect(loginReloadUrl('https://k.example/list?month=2026-11#x')).toBe('https://k.example/list?month=2026-11&_login=1#x')
    expect(loginReloadUrl('https://k.example/?_login=1')).toBe('https://k.example/?_login=1')
  })
  it('読み込んだ後は _login だけを消す。無ければ何もしない(null)', () => {
    expect(withoutLoginParam('https://k.example/list?month=2026-11&_login=1#x')).toBe('/list?month=2026-11#x')
    expect(withoutLoginParam('https://k.example/stock?_login=1')).toBe('/stock')
    expect(withoutLoginParam('https://k.example/stock')).toBeNull()
  })
})
