// ≡ のメニュー(基盤 §2.2: たまに使うものをしまう。モック 14 版の menu)
import { Link } from 'react-router'
import { Icon } from '../components/Icon'
import { Screen, TopBar } from '../components/Shell'
import { useApiQuery } from '../lib/query'

export function Menu() {
  const me = useApiQuery<{ displayName: string }>('/api/me')
  return (
    <Screen label="メニュー" tabs={false} top={<TopBar title="メニュー" left={{ kind: 'back', to: '/', label: '閉じる' }} />}>
      <nav className="panel" aria-label="メニュー">
        <Link className="lrow" to="/review">
          <span className="mi"><Icon name="check" />確かめる(カード明細とレシート)</span>
          <span className="sub">›</span>
        </Link>
        <Link className="lrow" to="/trend">
          <span className="mi"><Icon name="chart" />月ごとの推移</span>
          <span className="sub">›</span>
        </Link>
        <Link className="lrow" to="/totals">
          <span className="mi"><Icon name="sum" />費目ごとの総計(臨時・医療など)</span>
          <span className="sub">›</span>
        </Link>
        <Link className="lrow" to="/import">
          <span className="mi"><Icon name="upload" />楽天カードの明細を取り込む</span>
          <span className="sub">月 1 回 · PC ›</span>
        </Link>
      </nav>
      <div className="panel">
        <Link className="lrow" to="/prefs">
          <span className="mi"><Icon name="gear" />費目と月の予算</span>
          <span className="sub">›</span>
        </Link>
        <Link className="lrow" to="/stock">
          <span className="mi"><Icon name="bell" />在庫の通知(この iPhone)</span>
          <span className="sub">›</span>
        </Link>
        <div className="lrow">
          <span className="mi">ログイン中</span>
          <span className="sub">{me.data?.displayName ?? ''}</span>
        </div>
      </div>
    </Screen>
  )
}
