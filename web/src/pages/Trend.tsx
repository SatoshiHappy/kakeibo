// 月ごとの推移(見本はモック 14 版の trend)。正本: データと照合 §4.1・表 G
import { useState } from 'react'
import { Bar, BarChart, ReferenceDot, Rectangle, ResponsiveContainer, Tooltip, XAxis, YAxis, type BarShapeProps, type TooltipContentProps, type TooltipValueType } from 'recharts'
import { Screen, TopBar } from '../components/Shell'
import { trend, type CategoryAmount, type TrendPoint } from '../lib/categories'
import { currentMonth, monthLabel, yen } from '../lib/format'
import { useApiQuery } from '../lib/query'
import { monthBreakdown, monthRows, periodMonths, type NamedCategory } from '../lib/trend'

const PERIODS = [6, 12, 24] as const
type TrendResponse = { points: TrendPoint[]; lastMonth: CategoryAmount[]; categories: NamedCategory[] }
const short = (m: string) => `${Number(m.slice(5, 7))}月`

export function Trend() {
  const [n, setN] = useState<(typeof PERIODS)[number]>(6)
  const to = currentMonth()
  const months = periodMonths(to, n)
  const q = useApiQuery<TrendResponse>(`/api/summary/trend?from=${months[0]}&to=${to}`)
  const [picked, setPicked] = useState(to)

  return (
    <Screen label="推移" tabs={false} top={<TopBar title="月ごとの推移" left={{ kind: 'back', to: '/', label: 'ホームに戻る' }} />}>
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
  const t = trend(months, data.points, data.lastMonth)
  const rows = monthRows(months, data.points)
  const chartData = months.map((m, i) => ({ month: short(m), ...Object.fromEntries(t.bands.map((b) => [b.key, b.values[i]!])), extra: t.extra[i]! }))
  const stackTop = (i: number) => t.bands.reduce((a, b) => a + b.values[i]!, 0)
  // 月ごとに額のある最も上の帯(角を丸める)
  const topBand = months.map((_, m) => t.bands.findLastIndex((b) => b.values[m]! > 0))
  const breakdown = monthBreakdown(picked, data.points, data.categories)
  const isCurrent = picked === currentMonth()
  const top = `${short(months[0]!)}〜${monthLabel(months.at(-1)!)}`

  return (
    <>
      <section className="panel" aria-label="毎月変わる支出の推移">
        <h2>
          <span>毎月変わる支出 · {monthLabel(months[0]!)}〜{short(months.at(-1)!)}</span>
        </h2>
        <p className="note pad">固定費と臨時の費目は積まない(臨時は紫の印)</p>
        <div className="trendchart" role="img" aria-label={`${top}の毎月変わる支出の積み上げ。値は下の表`}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} margin={{ top: 12, right: 8, bottom: 0, left: 0 }} barCategoryGap="25%">
              <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fontSize: 11, style: { fill: 'var(--muted)' } }} interval="preserveStartEnd" />
              <YAxis hide domain={[0, Math.max(t.maxStack, 1)]} />
              <Tooltip cursor={{ style: { fill: 'var(--hover)' } }} content={(p) => <TrendTip p={p} bands={t.bands.map((b) => b.key)} names={new Map(t.bands.map((b) => [b.key, b.name]))} />} />
              {t.bands.map((b, i) => (
                <Bar key={b.key} dataKey={b.key} name={b.name} stackId="s" isAnimationActive={false} shape={bandShape(b.color, (m) => topBand[m] === i)} />
              ))}
              {t.extra.map((x, i) =>
                x !== 0 ? (
                  <ReferenceDot key={i} x={chartData[i]!.month} y={stackTop(i)} r={4} ifOverflow="extendDomain" shape={(d) => <circle cx={d.cx} cy={Number(d.cy) - 8} r={4} style={{ fill: 'var(--c9)', stroke: 'var(--bg)', strokeWidth: 2 }} />} />
                ) : null,
              )}
            </BarChart>
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

/** 帯の塊: 色はトークン、塊の間は地の色の 2px の隙間、いちばん上の帯は角を丸める(dataviz の印の決まり) */
function bandShape(color: string, isTop: (month: number) => boolean) {
  return ({ key: _key, ...props }: BarShapeProps & { key?: unknown }) => (
    <Rectangle {...props} fill={undefined} stroke={undefined} radius={isTop(props.index) ? [4, 4, 0, 0] : 0} style={{ fill: `var(${color})`, stroke: 'var(--bg)', strokeWidth: 2 }} />
  )
}

function TrendTip({ p, bands, names }: { p: TooltipContentProps<TooltipValueType, string | number>; bands: string[]; names: Map<string, string> }) {
  if (!p.active || !p.payload?.length) return null
  const row = p.payload[0]!.payload as Record<string, number | string>
  const sum = bands.reduce((a, k) => a + Number(row[k] ?? 0), 0)
  return (
    <div className="tip">
      <b>
        {String(row.month)} {yen(sum)}
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
