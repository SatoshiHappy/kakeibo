// 費目ごとの総計(見本はモック 14 版の totals)。正本: 要求「費目ごとの総計」・データと照合 §4.4
import { keepPreviousData } from '@tanstack/react-query'
import { useState } from 'react'
import { Screen, TopBar } from '../components/Shell'
import { jstToday, shortDate, yen } from '../lib/format'
import { useApiQuery } from '../lib/query'
import { totalsByKind, type TotalCategory } from '../lib/trend'

export function Totals() {
  const today = jstToday()
  const thisYear = Number(today.slice(0, 4))
  const choices = [
    { key: String(thisYear), label: `${thisYear}年`, note: `${thisYear}年 1/1〜${shortDate(today)}` },
    { key: String(thisYear - 1), label: `${thisYear - 1}年`, note: `${thisYear - 1}年 1/1〜12/31` },
    { key: 'all', label: '通算', note: '記録のすべて' },
  ]
  const [picked, setPicked] = useState(choices[0]!.key)
  // 期間を切り替える間も前の応答を出しておく(前の年の選びが消えないように)
  const q = useApiQuery<{ firstYear: number | null; categories: TotalCategory[] }>(picked === 'all' ? '/api/summary/totals' : `/api/summary/totals?year=${picked}`, {
    placeholderData: keepPreviousData,
  })
  // 去年より前の記録があれば、その年も選べる(医療費控除の目安を前の年でも見る)
  const first = q.data?.firstYear ?? null
  const olderYears = first === null || first >= thisYear - 1 ? [] : Array.from({ length: thisYear - 1 - first }, (_, i) => thisYear - 2 - i)
  const choice = choices.find((c) => c.key === picked) ?? { key: picked, label: `${picked}年`, note: `${picked}年 1/1〜12/31` }

  return (
    <Screen label="費目ごとの総計" tabs={false} top={<TopBar title="費目ごとの総計" left={{ kind: 'back', to: '/menu', label: 'メニューに戻る' }} />}>
      <div className="seg" role="group" aria-label="期間">
        {choices.map((c) => (
          <button key={c.key} type="button" aria-pressed={picked === c.key} onClick={() => setPicked(c.key)}>
            {c.label}
          </button>
        ))}
      </div>
      {olderYears.length > 0 && (
        <label className="fld">
          <span>前の年</span>
          <select value={olderYears.includes(Number(picked)) ? picked : ''} onChange={(e) => e.currentTarget.value && setPicked(e.currentTarget.value)}>
            <option value="">選ぶ</option>
            {olderYears.map((y) => (
              <option key={y} value={String(y)}>
                {y}年
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="note">
        {choice.note}。
        {picked !== 'all' && '医療費控除の目安: 医療の年の合計が 10 万円(所得が 200 万円未満なら所得の 5%)を超えるか。'}
      </p>
      {q.data ? (
        totalsByKind(q.data.categories).map((g) => (
          <section key={g.kind} className="panel" aria-label={g.label}>
            <h2>
              <span>{g.label}</span>
              <span className="num">{yen(g.total)}</span>
            </h2>
            <ul className="plain bdown">
              {g.rows.map((r) => (
                <li key={r.categoryId}>
                  <span>{r.name}</span>
                  {r.amount !== 0 ? <b className="num">{yen(r.amount)}</b> : <span className="faint">—</span>}
                </li>
              ))}
            </ul>
          </section>
        ))
      ) : (
        <p className="note">{q.isError ? '読み込めませんでした。通信のある所で開き直してください。' : '読み込み中…'}</p>
      )}
    </Screen>
  )
}
