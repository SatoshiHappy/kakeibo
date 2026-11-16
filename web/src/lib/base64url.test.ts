import { describe, expect, it } from 'vitest'
import { base64UrlToBytes } from './base64url'

describe('VAPID の公開鍵', () => {
  it('base64url(パディングなし・- と _)をバイト列に戻す', () => {
    expect([...base64UrlToBytes('-_8')]).toEqual([0xfb, 0xff])
    expect([...base64UrlToBytes('AQID')]).toEqual([1, 2, 3])
    expect(base64UrlToBytes('B' + 'A'.repeat(86)).length).toBe(65) // 非圧縮の P-256 の点
  })
})
