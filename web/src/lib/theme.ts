// 画面の明暗(基盤 §2.2 の表 Y)。この端末だけの設定で、localStorage に残す。
// 最初の描画の前に当てるのは index.html の小さな script(同じ規則。中身を変えたら public/_headers の CSP の印も変える)
import { useSyncExternalStore } from 'react'

export type ColorSetting = 'system' | 'light' | 'dark'
export type Scheme = 'light' | 'dark'

export const STORAGE_KEY = 'color-scheme'
const DARK = '(prefers-color-scheme: dark)'
/** 地の色(styles.css の --ground)。iOS の上の帯の色に使う */
const GROUND: Record<Scheme, string> = { light: '#F3F4F2', dark: '#121513' }

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

/** meta の color-scheme(CSS が :has で読む)と theme-color を設定に合わせる */
export function applySetting(setting: ColorSetting) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
  if (meta) meta.content = setting === 'system' ? 'light dark' : setting
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own: Scheme = m.media.includes('dark') ? 'dark' : 'light'
    m.content = GROUND[setting === 'system' ? own : setting]
  }
}

/** 設定を変えて残す。自動は残した値を消す(端末の設定にまた従う) */
export function saveSetting(setting: ColorSetting) {
  try {
    if (setting === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, setting)
  } catch {
    // 残せなくても、今開いている間は当てる
  }
  applySetting(setting)
  current = setting
  for (const l of listeners) l()
}

let current: ColorSetting = typeof window === 'undefined' ? 'system' : settingOf(readStored())
const listeners = new Set<() => void>()

function subscribeSetting(l: () => void) {
  listeners.add(l)
  // ほかのタブで変えたとき
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return
    current = settingOf(readStored())
    applySetting(current)
    l()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(l)
    window.removeEventListener('storage', onStorage)
  }
}

function subscribeSystem(l: () => void) {
  const mq = matchMedia(DARK)
  mq.addEventListener('change', l)
  return () => mq.removeEventListener('change', l)
}

/** 今の設定と端末の明暗(端末の明暗は変わるたびに読み直す) */
export function useColorSetting(): { setting: ColorSetting; system: Scheme } {
  const setting = useSyncExternalStore(subscribeSetting, () => current)
  const system = useSyncExternalStore(subscribeSystem, () => (matchMedia(DARK).matches ? 'dark' : 'light'))
  return { setting, system }
}
