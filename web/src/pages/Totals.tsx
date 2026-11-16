// 費目ごとの総計(見本はモック 14 版の totals)。正本: 要求「費目ごとの総計」・データと照合 §4.4
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
  const q = useApiQuery<{ categories: TotalCategory[] }>(picked === 'all' ? '/api/summary/totals' : `/api/summary/totals?year=${picked}`)
  const choice = choices.find((c) => c.key === picked)!

  return (
    <Screen label="費目ごとの総計" tabs={false} top={<TopBar title="費目ごとの総計" left={{ kind: 'back', to: '/menu', label: 'メニューに戻る' }} />}>
      <div className="seg" role="group" aria-label="期間">
        {choices.map((c) => (
          <button key={c.key} type="button" aria-pressed={picked === c.key} onClick={() => setPicked(c.key)}>
            {c.label}
          </button>
        ))}
      </div>
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
