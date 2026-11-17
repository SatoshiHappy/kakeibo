// ホーム(見本はモック 14 版・15 版の home)。正本: データと照合 §4.5・表 G・表 H、要求の集計・在庫
import { Pie, PieChart, Sector, type PieSectorShapeProps } from 'recharts'
import { Link, useSearchParams } from 'react-router'
import { Icon } from '../components/Icon'
import { Screen } from '../components/Shell'
import { homeRows, pieSlices, type HomeRows, type Slice } from '../lib/categories'
import { currentMonth, isMonth, jstToday, monthLabel, shiftMonth, shortDate, yen } from '../lib/format'
import { homePath, type HomeResponse } from '../lib/home'
import { useApiQuery } from '../lib/query'

export function Home() {
  const [params, setParams] = useSearchParams()
  const thisMonth = currentMonth()
  const raw = params.get('month')
  const month = isMonth(raw) && raw <= thisMonth ? raw : thisMonth
  const go = (m: string) => setParams(m === thisMonth ? {} : { month: m })
  const q = useApiQuery<HomeResponse>(homePath(month))

  const top = (
    <header className="bar-top">
      <button className="iconbtn" type="button" aria-label="前の月" onClick={() => go(shiftMonth(month, -1))}>
        <Icon name="back" />
      </button>
      <h1 className="center">{monthLabel(month)}</h1>
      <button className="iconbtn" type="button" aria-label="次の月" disabled={month >= thisMonth} onClick={() => go(shiftMonth(month, 1))}>
        <Icon name="next" />
      </button>
    </header>
  )

  return (
    <Screen label="ホーム" tabs top={top}>
      {q.data ? (
        <HomeBody data={q.data} month={month} isCurrent={month === thisMonth} />
      ) : q.isError ? (
        <p className="note">読み込めませんでした。通信のある所で開き直してください。</p>
      ) : (
        <p className="note">読み込み中…</p>
      )}
    </Screen>
  )
}

function HomeBody({ data, month, isCurrent }: { data: HomeResponse; month: string; isCurrent: boolean }) {
  const rows = homeRows(data.categories)
  const rest = rows.budgetTotal - rows.variableTotal
  return (
    <>
      <section className="panel" aria-label="毎月変わる支出">
        <div className="summary">
          <div className="lines">
            {isCurrent && <span className="sub">{shortDate(jstToday())} 時点</span>}
            <span className="big num">{yen(rows.variableTotal)}</span>
            {rows.budgetTotal > 0 && (
              <span className="sub num">
                予算 {yen(rows.budgetTotal)} · {rest >= 0 ? <>残り <span className="good">{yen(rest)}</span></> : <>超過 <span className="bad">{yen(-rest)}</span></>}
              </span>
            )}
            <Link className="trendlink" to="/trend">
              <Icon name="chart" size={16} />
              月ごとの推移
            </Link>
          </div>
          <Donut slices={pieSlices(data.categories)} />
        </div>
        <CategoryRows rows={rows} month={month} />
      </section>
      <nav className="panel" aria-label="そろそろ買う・確かめること">
        <Link className="lrow" to="/stock">
          <span>そろそろ買う</span>
          <span>
            <b className="cnt num">{data.stockSoon.length}<span className="visually-hidden"> 件</span></b> <span className="faint">›</span>
          </span>
        </Link>
        {data.stockSoon.slice(0, 5).map((s) => (
          <Link key={s.id} className="lsub" to="/stock">
            <span className="lname">{s.name}</span>
            <span className="num soon">{s.forecast === null ? '残り 0' : s.forecast.daysLeft < 0 ? 'なくなる日を過ぎた' : `あと${s.forecast.daysLeft}日`}</span>
          </Link>
        ))}
        {data.stockSoon.length > 5 && (
          <Link className="lsub" to="/stock">
            <span className="faint">ほか {data.stockSoon.length - 5} 件</span>
          </Link>
        )}
        <Link className="lrow" to="/review">
          <span>確かめること</span>
          <span>
            <b className="cnt num">{data.reviewCount}<span className="visually-hidden"> 件</span></b> <span className="faint">›</span>
          </span>
        </Link>
      </nav>
    </>
  )
}

function CategoryRows({ rows, month }: { rows: HomeRows; month: string }) {
  return (
    <>
      <ul className="plain cgrid">
        {rows.budgetRows.map((c) => {
          const over = c.amount > c.budget
          const ratio = c.budget > 0 ? Math.round((c.amount / c.budget) * 100) : null
          return (
            <li key={c.categoryId} className={`ccard${over ? ' over' : ''}`}>
              <span className="ctop">
                <span className="dot" style={{ background: `var(${c.color})` }} />
                <span className="name">{c.name}</span>
                <span className="camt">
                  <b className="num">{yen(c.amount)}</b>
                  <span className="cbud num">/ {yen(c.budget)}</span>
                </span>
              </span>
              <span className="bar" aria-hidden="true">
                <i style={{ width: `${Math.min(ratio ?? (c.amount > 0 ? 100 : 0), 100)}%`, background: `var(${c.color})` }} />
              </span>
              <span className="cunder">
                <span className="num">{ratio === null ? '' : `${ratio}%`}</span>
                <span className="num">{over ? `超過 ${yen(c.amount - c.budget)}` : `残り ${yen(c.budget - c.amount)}`}</span>
              </span>
            </li>
          )
        })}
        {rows.other && (
          <li className="ccard">
            <span className="ctop">
              <span className="dot" style={{ background: 'var(--c7)' }} />
              <span className="name">ほか</span>
              <span className="camt">
                <b className="num">{yen(rows.other.amount)}</b>
              </span>
            </span>
            <span className="cunder">
              <span>{rows.other.items.map((i) => `${i.name} ${yen(i.amount)}`).join(' · ')}</span>
            </span>
          </li>
        )}
      </ul>
      {rows.fixed && (
        <Link className="fixedline" to={`/list?month=${month}&filter=fixed`}>
          <span>
            固定費 <span className="faint">{rows.fixed.names.join('・')}</span>
          </span>
          <span className="num">
            {yen(rows.fixed.amount)} <span className="faint">›</span>
          </span>
        </Link>
      )}
    </>
  )
}

/** 円グラフ(表 G)。費目の決まった順、塊の間に地の色の 2px の隙間(基盤 §2.2) */
function Donut({ slices }: { slices: Slice[] }) {
  const total = slices.reduce((a, s) => a + s.value, 0)
  const top = slices.reduce<Slice | null>((a, s) => (a === null || s.value > a.value ? s : a), null)
  const label =
    total > 0 && top ? `毎月変わる支出の費目の割合。${top.name}が ${Math.round((top.value / total) * 100)}%` : '毎月変わる支出はまだありません'
  // Recharts は shape を関数として呼び、props に key を入れて渡す。key は JSX の広げに混ぜられないので外す
  const Shape = ({ key: _key, ...props }: PieSectorShapeProps & { key?: unknown }) => (
    <Sector {...props} fill={undefined} stroke={undefined} style={{ fill: `var(${slices[props.index]!.color})`, stroke: 'var(--bg)', strokeWidth: 2 }} />
  )
  return (
    <div className="donut" role="img" aria-label={label}>
      {total > 0 && (
        <PieChart width={84} height={84}>
          <Pie data={slices} dataKey="value" nameKey="name" innerRadius={24} outerRadius={40} startAngle={90} endAngle={-270} isAnimationActive={false} shape={Shape} />
        </PieChart>
      )}
    </div>
  )
}
