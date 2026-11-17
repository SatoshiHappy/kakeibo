// 画面の外枠: 上の帯・中身・下のタブ(基盤 §2.1・§2.2)
import { useSyncExternalStore, type ReactNode } from 'react'
import { Link, NavLink, useSearchParams } from 'react-router'
import { currentMonth, isMonth, shiftMonth } from '../lib/format'
import { useBadgeCounts } from '../lib/home'
import { api } from '../lib/query'
import { Icon, type IconName } from './Icon'

// 5 つ目の「設定」に、たまに使う機能と設定をしまう(基盤 §2.2。2026-11-17 ユーザーがモックの案 10 を採用)
const TABS: { to: string; icon: IconName; label: string }[] = [
  { to: '/', icon: 'home', label: 'ホーム' },
  { to: '/capture', icon: 'camera', label: '撮る' },
  { to: '/list', icon: 'list', label: '一覧' },
  { to: '/stock', icon: 'box', label: '在庫' },
  { to: '/settings', icon: 'gear', label: '設定' },
]

/** 数の印。0 なら出さない。読み上げは label で数を言う */
function Badge({ n, label }: { n: number; label: string }) {
  if (n <= 0) return null
  return (
    <span className="badge num" aria-label={`${label} ${n} 件`}>
      {n}
    </span>
  )
}

export function TabBar() {
  const counts = useBadgeCounts()
  const badge: Record<string, { n: number; label: string }> = {
    '/capture': { n: counts.draft, label: '下書き' },
    '/stock': { n: counts.stock, label: '買い足し' },
    '/settings': { n: counts.review, label: '要確認' },
  }
  return (
    <nav className="tabbar" aria-label="画面の切り替え">
      {TABS.map((t) => (
        // NavLink は今いる画面に aria-current="page" を付ける
        <NavLink key={t.to} to={t.to} end={t.to === '/'}>
          <Icon name={t.icon} size={22} />
          <span>{t.label}</span>
          {badge[t.to] && <Badge {...badge[t.to]!} />}
        </NavLink>
      ))}
    </nav>
  )
}

/** 左上の戻る。下のタブの画面には置かない(タブで行き来する) */
export type TopBarLeft = { to: string; label: string }

export function TopBar({ title, left, right }: { title: ReactNode; left?: TopBarLeft; right?: ReactNode }) {
  return (
    <header className="bar-top">
      {left && (
        <Link className="iconbtn" to={left.to} aria-label={left.label}>
          <Icon name="back" />
        </Link>
      )}
      <h1>{title}</h1>
      {right}
    </header>
  )
}

export type MonthNav = { month: string; thisMonth: string; go: (m: string) => void; params: URLSearchParams }

/** URL の ?month の月。無い・形が違う・今月より先なら今月。月を移すときは ?month だけを書き換え(今月なら消す)、ほかの値(一覧の ?filter など)は残す */
export function useMonthParam(): MonthNav {
  const [params, setParams] = useSearchParams()
  const thisMonth = currentMonth()
  const raw = params.get('month')
  const month = isMonth(raw) && raw <= thisMonth ? raw : thisMonth
  const go = (m: string) =>
    setParams((p) => {
      const next = new URLSearchParams(p)
      if (m === thisMonth) next.delete('month')
      else next.set('month', m)
      return next
    })
  return { month, thisMonth, go, params }
}

/** 月を 1 か月ずつ送る上の帯。‹ と › は両端で、› は今月で止まる。題と aside は ‹ と › の間に並ぶ(aside は › の手前)。
 *  layout = 題の形(center = 1 行で真ん中・twoLine = 左に寄せた 2 段) */
export function MonthBar({ nav, title, layout, aside }: { nav: MonthNav; title: ReactNode; layout: 'center' | 'twoLine'; aside?: ReactNode }) {
  const { month, thisMonth, go } = nav
  return (
    <header className="bar-top">
      <button className="iconbtn" type="button" aria-label="前の月" onClick={() => go(shiftMonth(month, -1))}>
        <Icon name="back" />
      </button>
      <h1 className={layout === 'center' ? 'center' : 'mhead'}>{title}</h1>
      {aside}
      <button className="iconbtn" type="button" aria-label="次の月" disabled={month >= thisMonth} onClick={() => go(shiftMonth(month, 1))}>
        <Icon name="next" />
      </button>
    </header>
  )
}

const subscribeAuth = (cb: () => void) => {
  const off = api.onAuthState(cb)
  return () => void off()
}

/** 表 K の K3: 前の内容のまま「ログインを確かめられない」と「ログインし直す」 */
function AuthBar() {
  const state = useSyncExternalStore(subscribeAuth, api.authState)
  if (state === 'not_registered')
    return (
      <div className="authbar" role="alert">
        <span>このメールはまだ家計簿の利用者に登録されていません。登録した家族に、利用者を足してもらってください。</span>
      </div>
    )
  if (state !== 'login_failed') return null
  return (
    <div className="authbar" role="alert">
      <span>ログインを確かめられません。表示は前の内容です。</span>
      <button className="textbtn" type="button" onClick={() => void api.relogin()}>
        ログインし直す
      </button>
    </div>
  )
}

/** 1 画面の形。tabs = 下のタブを出すか(戻る画面には出さない) */
export function Screen({ label, top, tabs, children }: { label: string; top: ReactNode; tabs: boolean; children: ReactNode }) {
  return (
    <section className="screen" aria-label={label}>
      {top}
      <AuthBar />
      <main>{children}</main>
      {tabs && <TabBar />}
    </section>
  )
}
