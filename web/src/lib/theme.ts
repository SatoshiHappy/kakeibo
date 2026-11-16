// 画面の明暗(基盤 §2.2 の表 Y)。この端末だけの設定で、localStorage に残す。
// 最初の描画の前に当てるのは index.html の小さな script(同じ規則。中身を変えたら public/_headers の CSP の印も変える)。
// このモジュールを読んだ時にも当て直す(src/main.tsx から読む)
import { useSyncExternalStore } from 'react'

export type ColorSetting = 'system' | 'light' | 'dark'
export type Scheme = 'light' | 'dark'

export const STORAGE_KEY = 'color-scheme'
const MEDIA: Record<Scheme, string> = { light: '(prefers-color-scheme: light)', dark: '(prefers-color-scheme: dark)' }

/** 残した値から設定を読む(Y5: 読めない・知らない値は自動) */
export function settingOf(stored: string | null): ColorSetting {
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

/** 画面に出す明暗(表 Y の Y1〜Y4) */
export function shownScheme(setting: ColorSetting, system: Scheme): Scheme {
  return setting === 'system' ? system : setting
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null // 保存が使えない端末(Y5)
  }
}

/** meta の color-scheme(CSS が :has で読む)と、iOS の上の帯の色(theme-color。index.html に明暗の 2 つ)を設定に合わせる。
 * theme-color は色を書き換えず、当てる側の media を切り替える(色は index.html の 1 か所に置く) */
function applySetting(setting: ColorSetting) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
  if (meta) meta.content = setting === 'system' ? 'light dark' : setting
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own: Scheme = m.dataset.scheme === 'dark' ? 'dark' : 'light'
    m.media = setting === 'system' ? MEDIA[own] : setting === own ? 'all' : 'not all'
  }
}

const listeners = new Set<() => void>()
let current: ColorSetting = 'system'
const darkQuery = typeof window === 'undefined' ? null : matchMedia(MEDIA.dark)

function update(setting: ColorSetting) {
  current = setting
  applySetting(setting)
  for (const l of listeners) l()
}

if (typeof window !== 'undefined') {
  // index.html の script が止められても(CSP など)、ここで当て直す。選びと画面を食い違わせない
  update(settingOf(readStored()))
  // ほかのタブで変えたとき(どの画面を開いていても)
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY || e.key === null) update(settingOf(readStored()))
  })
}

/** 設定を変えて残す。自動は残した値を消す(端末の設定にまた従う) */
export function saveSetting(setting: ColorSetting) {
  try {
    if (setting === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, setting)
  } catch {
    // 残せなくても、今開いている間は当てる
  }
  update(setting)
}

function subscribeSetting(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

function subscribeSystem(l: () => void) {
  darkQuery?.addEventListener('change', l)
  return () => darkQuery?.removeEventListener('change', l)
}

/** 今の設定と端末の明暗(端末の明暗は変わるたびに読み直す) */
export function useColorSetting(): { setting: ColorSetting; system: Scheme } {
  const setting = useSyncExternalStore(subscribeSetting, () => current)
  const system = useSyncExternalStore(subscribeSystem, () => (darkQuery?.matches ? 'dark' : 'light'))
  return { setting, system }
}
