// 設定(下のタブの 5 つ目。基盤 §2.2: たまに使う機能と設定をしまう。2026-11-17 ユーザーが上の帯の案 10 を採用)
import { useId } from 'react'
import { Link } from 'react-router'
import { Icon } from '../components/Icon'
import { Screen, TopBar } from '../components/Shell'
import { useBadgeCounts } from '../lib/home'
import { useApiQuery } from '../lib/query'
import { saveSetting, useColorSetting, type ColorSetting } from '../lib/theme'

const SCHEME_NAME = { light: 'ライト', dark: 'ダーク' } as const

export function Settings() {
  const me = useApiQuery<{ displayName: string }>('/api/me')
  const { review } = useBadgeCounts()
  return (
    <Screen label="設定" tabs top={<TopBar title="設定" />}>
      {/* 分け方: 機能の種類で分け、よく使う順に並べる(見出しで「なぜここにあるか」が分かるように。2026-11-17 ユーザー指示・似た製品と HIG の Menus) */}
      <div className="setlist">
        <section className="panel" aria-labelledby="set-month">
          <h2 id="set-month">毎月</h2>
          <Link className="lrow" to="/review">
            <span className="mi"><Icon name="check" />要確認</span>
            {/* 設定のタブの印と同じ数(どの行の印かが分かるように) */}
            <span className="sub">{review > 0 && <b className="cnt num">{review}<span className="visually-hidden"> 件</span> </b>}›</span>
          </Link>
          <Link className="lrow" to="/import">
            <span className="mi"><Icon name="upload" />明細の取り込み</span>
            <span className="sub">PC ›</span>
          </Link>
        </section>
        <section className="panel" aria-labelledby="set-view">
          <h2 id="set-view">振り返り</h2>
          <Link className="lrow" to="/trend?from=settings">
            <span className="mi"><Icon name="chart" />推移</span>
            <span className="sub">›</span>
          </Link>
          <Link className="lrow" to="/totals">
            <span className="mi"><Icon name="sum" />費目ごとの合計</span>
            <span className="sub">›</span>
          </Link>
        </section>
        <section className="panel" aria-labelledby="set-settings">
          <h2 id="set-settings">家族で共通</h2>
          <Link className="lrow" to="/prefs">
            <span className="mi"><Icon name="gear" />予算</span>
            <span className="sub">›</span>
          </Link>
          <Link className="lrow" to="/recurring">
            <span className="mi"><Icon name="repeat" />定期の支出</span>
            <span className="sub">›</span>
          </Link>
        </section>
        <section className="panel" aria-labelledby="set-device">
          <h2 id="set-device">この iPhone</h2>
          <Link className="lrow" to="/stock">
            <span className="mi"><Icon name="bell" />在庫の通知</span>
            <span className="sub">›</span>
          </Link>
          <ColorChoice />
          <div className="lrow">
            <span className="mi">ログイン中</span>
            <span className="sub">{me.data?.displayName ?? ''}</span>
          </div>
        </section>
      </div>
    </Screen>
  )
}

/** 画面の明るさ(表 Y)。この端末だけに残す。自動の選びには今の端末の明暗を添える */
function ColorChoice() {
  const { setting, system } = useColorSetting()
  const titleId = useId()
  const options: { value: ColorSetting; label: string; hint?: string }[] = [
    { value: 'system', label: '自動', hint: `(今は${SCHEME_NAME[system]})` },
    { value: 'light', label: 'ライト' },
    { value: 'dark', label: 'ダーク' },
  ]
  return (
    <div className="lrow scheme">
      <span className="mi">
        <Icon name="moon" />
        <span id={titleId}>画面の明るさ</span>
      </span>
      <div className="seg" role="group" aria-labelledby={titleId}>
        {options.map((o) => (
          <button key={o.value} type="button" aria-pressed={setting === o.value} onClick={() => saveSetting(o.value)}>
            {o.label}
            {o.hint && <span className="visually-hidden">{o.hint}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
