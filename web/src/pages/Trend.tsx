// 月ごとの推移(見本はモック 14 版の trend)。正本: データと照合 §4.1・表 G
import { useState, type CSSProperties } from 'react'
import { useSearchParams } from 'react-router'
import { Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps, type TooltipValueType } from 'recharts'
import { Screen, TopBar } from '../components/Shell'
import { trend, type CategoryAmount, type TrendPoint } from '../lib/categories'
import { currentMonth, monthLabel, yen } from '../lib/format'
import { useApiQuery } from '../lib/query'
import { axisTicks, extraLabel, extraRows, manYen, monthBreakdown, monthRows, periodMonths, type NamedCategory } from '../lib/trend'

const PERIODS = [6, 12, 24] as const
type TrendResponse = { points: TrendPoint[]; lastMonth: CategoryAmount[]; categories: NamedCategory[] }
const short = (m: string) => `${Number(m.slice(5, 7))}月`

export function Trend() {
  const [n, setN] = useState<(typeof PERIODS)[number]>(6)
  const to = currentMonth()
  const months = periodMonths(to, n)
  const q = useApiQuery<TrendResponse>(`/api/summary/trend?from=${months[0]}&to=${to}`)
  const [picked, setPicked] = useState(to)
  // 設定から開いたら設定へ、ホームのグラフから開いたらホームへ戻る
  const [search] = useSearchParams()
  const back = search.get('from') === 'settings' ? ({ kind: 'back', to: '/settings', label: '設定に戻る' } as const) : ({ kind: 'back', to: '/', label: 'ホームに戻る' } as const)

  return (
    <Screen label="推移" tabs={false} top={<TopBar title="月ごとの推移" left={back} />}>
      <div className="seg" role="group" aria-label="期間">
        {PERIODS.map((p) => (
          <button key={p} type="button" aria-pressed={n === p} onClick={() => setN(p)}>
            {p}か月
          </button>
        ))}
      </div>
      {q.data ? (
        <TrendBody data={q.data} months={months} picked={months.includes(picked) ? picked : to} onPick={setPicked} />
      ) : (
        <p className="note">{q.isError ? '読み込めませんでした。通信のある所で開き直してください。' : '読み込み中…'}</p>
      )}
    </Screen>
  )
}

function TrendBody({ data, months, picked, onPick }: { data: TrendResponse; months: string[]; picked: string; onPick: (m: string) => void }) {
  const [width, setWidth] = useState(360)
  const t = trend(months, data.points, data.lastMonth)
  const rows = monthRows(months, data.points)
  const stackTop = (i: number) => t.bands.reduce((a, b) => a + b.values[i]!, 0)
  // 横軸の値は年つきの YYYY-MM(24 か月では「11月」が 2 回出るので、字は tickFormatter で月だけにする)
  const chartData = months.map((m, i) => ({ month: m, ...Object.fromEntries(t.bands.map((b) => [b.key, b.values[i]!])), total: stackTop(i), extra: t.extra[i]! }))
  // 札の段: 描いた幅から隣の月の間を出す(縦軸 34px・右 8px・横軸の両端 28px を引く)
  const gap = months.length > 1 ? (width - 34 - 8 - 56) / (months.length - 1) : width
  const labelRows = extraRows(t.extra, gap)
  const twoRows = labelRows.includes(1)
  const ticks = axisTicks(t.maxStack)
  const breakdown = monthBreakdown(picked, data.points, data.categories)
  const isCurrent = picked === currentMonth()
  const top = `${short(months[0]!)}〜${monthLabel(months.at(-1)!)}`

  return (
    <>
      <section className="panel" aria-label="毎月変わる支出の推移">
        <h2>
          <span>毎月変わる支出 · {monthLabel(months[0]!)}〜{short(months.at(-1)!)}</span>
        </h2>
        <p className="note pad">固定費と臨時の費目は積まない(臨時は紫の札に額)。線は月の合計</p>
        <div className="trendchart" role="img" aria-label={`${top}の毎月変わる支出の積み上げ。値は下の表`}>
          <ResponsiveContainer width="100%" height={twoRows ? 220 : 200} onResize={(w) => setWidth(w)}>
            <ComposedChart data={chartData} margin={{ top: twoRows ? 48 : 28, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} style={{ stroke: 'var(--border)' }} />
              <XAxis dataKey="month" tickFormatter={short} tickLine={false} axisLine={false} padding={{ left: 28, right: 28 }} tick={{ fontSize: 11, style: { fill: 'var(--muted)' } }} interval="preserveStartEnd" />
              <YAxis width={34} tickLine={false} axisLine={false} ticks={ticks} domain={[0, ticks.at(-1)!]} tickFormatter={manYen} tick={{ fontSize: 11, style: { fill: 'var(--muted)' } }} />
              <Tooltip cursor={{ style: { stroke: 'var(--faint)' } }} content={(p) => <TrendTip p={p} bands={t.bands.map((b) => b.key)} names={new Map(t.bands.map((b) => [b.key, b.name]))} />} />
              {/* 費目の帯を積む(月をまたいで累計しない)。帯の間は地の色の 2px の隙間(dataviz の印の決まり) */}
              {t.bands.map((b) => (
                <Area key={b.key} dataKey={b.key} name={b.name} stackId="s" type="linear" isAnimationActive={false} activeDot={false} className="band" style={{ '--band': `var(${b.color})` } as CSSProperties} />
              ))}
              <Line dataKey="total" name="合計" type="linear" isAnimationActive={false} dot={false} activeDot={{ r: 4, style: { fill: 'var(--fg)', stroke: 'var(--bg)', strokeWidth: 2 } }} style={{ fill: 'none', stroke: 'var(--fg)', strokeWidth: 2 }} />
              {/* 臨時は積まず、その月に印と額の札を付ける(要求「集計」。縦軸は臨時を除いた最大に合わせる) */}
              {t.extra.map((x, i) =>
                x !== 0 ? <ReferenceDot key={i} x={chartData[i]!.month} y={stackTop(i)} ifOverflow="visible" shape={(d) => <ExtraMark cx={Number(d.cx)} cy={Number(d.cy)} amount={x} row={labelRows[i] ?? null} />} /> : null,
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <ul className="plain legend">
          {t.bands.map((b) => (
            <li key={b.key}>
              <span className="dot" style={{ background: `var(${b.color})` }} />
              {b.name}
            </li>
          ))}
          <li>
            <span className="line" style={{ background: 'var(--fg)' }} />
            合計
          </li>
          <li>
            <span className="dot" style={{ background: 'var(--c9)' }} />
            臨時(積まない)
          </li>
        </ul>
      </section>

      <section className="panel scrollx" aria-label="月ごとの表">
        <table className="mtable">
          <thead>
            <tr>
              <th scope="col">月(押すと内訳)</th>
              <th scope="col" className="r">変わる支出</th>
              <th scope="col" className="r">前月比</th>
              <th scope="col" className="r">臨時</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((r) => (
              <tr key={r.month} className={r.month === picked ? 'cur' : undefined}>
                <th scope="row">
                  <button className="rowbtn" type="button" aria-pressed={r.month === picked} onClick={() => onPick(r.month)}>
                    {monthLabel(r.month)}
                    {r.month === currentMonth() ? '(途中)' : ''}
                  </button>
                </th>
                <td className="r num">
                  <b>{yen(r.variable)}</b>
                </td>
                <td className={`r num${r.diff !== null && r.diff > 0 ? ' up' : ''}`}>{r.diff === null ? '' : `${r.diff > 0 ? '+' : r.diff < 0 ? '−' : ''}${Math.abs(r.diff).toLocaleString('en-US')}`}</td>
                <td className="r num">{r.extra !== 0 ? yen(r.extra) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel" aria-label={`${monthLabel(picked)}の内訳`}>
        <h2>
          <span>
            {short(picked)}の内訳{isCurrent ? '(途中)' : ''}
          </span>
        </h2>
        {breakdown.length === 0 ? (
          <p className="note pad">この月の毎月変わる支出はありません。</p>
        ) : (
          <ul className="plain bdown">
            {breakdown.map((b) => (
              <li key={b.id}>
                <span>{b.name}</span>
                <b className="num">{yen(b.amount)}</b>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

/** 臨時の印: 合計の上から点線を伸ばし、上に「臨時 ¥9.8万」の札 */
function ExtraMark({ cx, cy, amount, row }: { cx: number; cy: number; amount: number; row: 0 | 1 | null }) {
  // 札の段が無い(近い月の札で埋まっている)ときは、合計の上の点だけ(額は表とツールチップ)
  if (row === null) return <circle cx={cx} cy={cy - 8} r={4} style={{ fill: 'var(--c9)', stroke: 'var(--bg)', strokeWidth: 2 }} aria-hidden="true" />
  const top = 4 + row * 20
  return (
    <g aria-hidden="true">
      <line x1={cx} x2={cx} y1={cy - 4} y2={top + 18} style={{ stroke: 'var(--c9)', strokeWidth: 1.5, strokeDasharray: '2 2' }} />
      <rect x={cx - 36} y={top} width={72} height={18} rx={9} style={{ fill: 'var(--c9)' }} />
      <text x={cx} y={top + 13} textAnchor="middle" className="rlab">
        {`臨時 ${extraLabel(amount)}`}
      </text>
    </g>
  )
}

function TrendTip({ p, bands, names }: { p: TooltipContentProps<TooltipValueType, string | number>; bands: string[]; names: Map<string, string> }) {
  if (!p.active || !p.payload?.length) return null
  const row = p.payload[0]!.payload as Record<string, number | string>
  const sum = Number(row.total)
  return (
    <div className="tip">
      <b>
        {short(String(row.month))} {yen(sum)}
      </b>
      {[...bands].reverse().map((k) =>
        Number(row[k]) > 0 ? (
          <span key={k}>
            {names.get(k)} {yen(Number(row[k]))}
          </span>
        ) : null,
      )}
      {Number(row.extra) !== 0 && <span>臨時 {yen(Number(row.extra))}</span>}
    </div>
  )
}
