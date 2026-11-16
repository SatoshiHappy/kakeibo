// 画面の外枠: 上の帯・中身・下のタブ(基盤 §2.1・§2.2)
import { useSyncExternalStore, type ReactNode } from 'react'
import { Link, NavLink } from 'react-router'
import { useBadgeCounts } from '../lib/home'
import { api } from '../lib/query'
import { Icon, type IconName } from './Icon'

const TABS: { to: string; icon: IconName; label: string }[] = [
  { to: '/', icon: 'home', label: 'ホーム' },
  { to: '/capture', icon: 'camera', label: '撮る' },
  { to: '/list', icon: 'list', label: '一覧' },
  { to: '/stock', icon: 'box', label: '在庫' },
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
    '/stock': { n: counts.stock, label: 'そろそろ買う' },
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

/** ≡ のメニュー(確かめる件数の印つき。基盤 §2.2) */
export function MenuButton() {
  const { review } = useBadgeCounts()
  return (
    <Link className="iconbtn" to="/menu" aria-label="メニュー">
      <Icon name="menu" />
      <Badge n={review} label="確かめること" />
    </Link>
  )
}

/** 左上: タブの画面は ≡ のメニュー、ほかは戻る */
export type TopBarLeft = { kind: 'menu' } | { kind: 'back'; to: string; label: string }

export function TopBar({ title, left, right }: { title: ReactNode; left: TopBarLeft; right?: ReactNode }) {
  return (
    <header className="bar-top">
      {left.kind === 'menu' ? (
        <MenuButton />
      ) : (
        <Link className="iconbtn" to={left.to} aria-label={left.label}>
          <Icon name="back" />
        </Link>
      )}
      <h1>{title}</h1>
      {right}
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
