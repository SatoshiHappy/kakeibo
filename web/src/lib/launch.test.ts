import { describe, expect, it } from 'vitest'
import { launchTarget, readAndMarkLaunched } from './launch'

const at = (path: string) => `https://kakeibo.example${path}`

describe('表 O アプリを開いた最初の画面', () => {
  it('O1 ホーム画面のアプリを開いた最初の読み込みは、どの URL でもホームにする(ホームならそのまま)', () => {
    expect(launchTarget({ standalone: true, launched: false, href: at('/list?month=2026-10') })).toBe('/')
    expect(launchTarget({ standalone: true, launched: false, href: at('/settings') })).toBe('/')
    expect(launchTarget({ standalone: true, launched: false, href: at('/') })).toBeNull()
    expect(launchTarget({ standalone: true, launched: false, href: at('/?launch=other') })).toBe('/')
  })
  it('O2 通知から開いた最初の読み込みは通知の行き先のまま。印は消す', () => {
    expect(launchTarget({ standalone: true, launched: false, href: at('/stock?launch=notify') })).toBe('/stock')
  })
  it('O3 2 回目以降の読み込み(再読み込み・ログインの往復)は URL のまま。印があれば消す', () => {
    expect(launchTarget({ standalone: true, launched: true, href: at('/list') })).toBeNull()
    expect(launchTarget({ standalone: true, launched: true, href: at('/stock?launch=notify') })).toBe('/stock')
  })
  it('O4 ブラウザのタブは URL のまま', () => {
    expect(launchTarget({ standalone: false, launched: false, href: at('/list') })).toBeNull()
    expect(launchTarget({ standalone: false, launched: true, href: at('/stock?launch=notify&x=1#a') })).toBe('/stock?x=1#a')
  })
  it('O5 起動の印が読めないときは URL のまま(読み込むたびにホームへ戻さない)', () => {
    expect(launchTarget({ standalone: true, launched: null, href: at('/list') })).toBeNull()
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => undefined }
    expect(readAndMarkLaunched(() => broken)).toBeNull()
    expect(readAndMarkLaunched(() => { throw new Error('SecurityError') })).toBeNull()
  })
  it('起動の印は最初の読み込みで付き、次からは付いている', () => {
    const m = new Map<string, string>()
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
    expect(readAndMarkLaunched(() => s)).toBe(false)
    expect(readAndMarkLaunched(() => s)).toBe(true)
  })
})
