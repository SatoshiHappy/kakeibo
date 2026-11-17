// アプリを開いた最初の画面(基盤 表 O)。判定(launchTarget)と起動の印(readAndMarkLaunched)は依存を引数で受け、行ごとに単体テストで通す。
// 表示の形(isStandalone)は端末の値を読むだけで、E2E が iOS の navigator.standalone を立てて通す
export const LAUNCH_PARAM = 'launch'
export const LAUNCH_NOTIFY = 'notify'
const LAUNCHED_KEY = 'launched'

export type LaunchInput = {
  /** ホーム画面のアプリとして開いているか(display-mode: standalone) */
  standalone: boolean
  /** この窓の起動の印。読めなければ null */
  launched: boolean | null
  href: string
}

/** 出す画面の URL(パス・クエリ・ハッシュ)。今の URL から変えないなら null */
export function launchTarget({ standalone, launched, href }: LaunchInput): string | null {
  const url = new URL(href)
  const fromNotify = url.searchParams.get(LAUNCH_PARAM) === LAUNCH_NOTIFY
  const hadParam = url.searchParams.has(LAUNCH_PARAM)
  url.searchParams.delete(LAUNCH_PARAM)
  const here = url.pathname + url.search + url.hash
  if (standalone && launched === false && !fromNotify) return here === '/' && !hadParam ? null : '/' // O1
  return hadParam ? here : null // O2〜O5
}

/** この窓の起動の印を読んで付ける。読めない・書けないなら null(表 O の O5。sessionStorage は触れただけで投げることがあるので、取り出しも try の中) */
export function readAndMarkLaunched(getStorage: () => Pick<Storage, 'getItem' | 'setItem'>): boolean | null {
  try {
    const storage = getStorage()
    const launched = storage.getItem(LAUNCHED_KEY) === '1'
    storage.setItem(LAUNCHED_KEY, '1')
    return launched
  } catch {
    return null
  }
}

export function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
}
