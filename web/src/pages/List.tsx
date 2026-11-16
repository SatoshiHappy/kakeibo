// 一覧(見本はモック 14 版の list)。正本: データと照合 §4.8・表 W
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Icon, type IconName } from '../components/Icon'
import { MenuButton, Screen } from '../components/Shell'
import { byDay, dayLabel, matches, rowMark, type Filter, type ListExpense, type ListResponse } from '../lib/expenseList'
import { currentMonth, isMonth, shiftMonth, yen } from '../lib/format'
import { useApiQuery } from '../lib/query'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'fixed', label: '固定費' },
  { key: 'uncategorized', label: '未分類' },
  { key: 'waiting', label: '明細待ち' },
]

const PAY_ICON: Record<string, IconName> = { rakuten_card: 'card', credit: 'card', other_card: 'card', cash: 'cash', emoney: 'ic' }
const MARK: Record<string, { icon: IconName; cls: string } | undefined> = {
  W1: { icon: 'clock', cls: 'st-wait' },
  W3: { icon: 'ok', cls: 'st-ok' },
  W4: { icon: 'alert', cls: 'st-warn' },
  W5: { icon: 'doc', cls: 'st-wait' },
  W6: { icon: 'ok', cls: 'st-wait' },
  W7: { icon: 'ok', cls: 'st-wait' },
}

export function List() {
  const [params, setParams] = useSearchParams()
  const thisMonth = currentMonth()
  const raw = params.get('month')
  const month = isMonth(raw) && raw <= thisMonth ? raw : thisMonth
  const go = (m: string) => setParams(m === thisMonth ? {} : { month: m })
  const q = useApiQuery<ListResponse>(`/api/expenses?month=${month}`)
  const [filter, setFilter] = useState<Filter>('all')
  const total = q.data?.expenses.reduce((a, e) => a + e.amount, 0) ?? null

  const top = (
    <header className="bar-top">
      <MenuButton />
      <button className="iconbtn" type="button" aria-label="前の月" onClick={() => go(shiftMonth(month, -1))}>
        <Icon name="back" />
      </button>
      <h1>{Number(month.slice(5, 7))}月の支出</h1>
      {total !== null && (
        <span className="hsum">
          <b className="num">{yen(total)}</b>
          <span className="faint">固定費・臨時込み</span>
        </span>
      )}
      <button className="iconbtn" type="button" aria-label="次の月" disabled={month >= thisMonth} onClick={() => go(shiftMonth(month, 1))}>
        <Icon name="next" />
      </button>
    </header>
  )

  return (
    <Screen label="一覧" tabs top={top}>
      {q.data ? (
        <ListBody data={q.data} filter={filter} onFilter={setFilter} />
      ) : q.isError ? (
        <p className="note">読み込めませんでした。通信のある所で開き直してください。</p>
      ) : (
        <p className="note">読み込み中…</p>
      )}
    </Screen>
  )
}

function ListBody({ data, filter, onFilter }: { data: ListResponse; filter: Filter; onFilter: (f: Filter) => void }) {
  const shown = data.expenses.filter((e) => matches(filter, e, data))
  const names = [...new Set(data.expenses.filter((e) => e.origin === 'person').map((e) => e.registeredBy))]
  return (
    <>
      <div className="chips" role="group" aria-label="絞り込み">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => onFilter(f.key)}>
            {f.label} <span className="num">{data.expenses.filter((e) => matches(f.key, e, data)).length}</span>
          </button>
        ))}
      </div>
      <div className="iconlegend" aria-hidden="true">
        <span><Icon name="card" size={13} />カード</span>
        <span><Icon name="cash" size={13} />現金</span>
        <span><Icon name="ic" size={13} />電子マネー</span>
        {names.map((n) => (
          <span key={n}>
            <span className="who">{n.slice(0, 1)}</span>
            {n}
          </span>
        ))}
        <span className="st-wait"><Icon name="doc" size={13} />明細から</span>
        <span className="st-wait"><Icon name="clock" size={13} />明細待ち</span>
        <span className="st-ok"><Icon name="ok" size={13} />明細と一致</span>
        <span className="st-warn"><Icon name="alert" size={13} />差あり</span>
      </div>
      {shown.length === 0 ? (
        <p className="note">{data.expenses.length === 0 ? 'この月の支出はまだありません。' : '当たる支出はありません。'}</p>
      ) : (
        byDay(shown).map((d) => (
          <section key={d.date} aria-label={dayLabel(d.date)}>
            <h2 className="dayhead">
              <span>{dayLabel(d.date)}</span>
              <span className="num">{yen(d.total)}</span>
            </h2>
            <ul className="plain group">
              {d.expenses.map((e) => (
                <li key={e.id}>
                  <Row e={e} data={data} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  )
}

function Row({ e, data }: { e: ListExpense; data: ListResponse }) {
  const cat = new Map(data.categories.map((c) => [c.id, c]))
  const mark = rowMark(e, data.paymentMethods)
  const m = MARK[mark.row]
  const pay = data.paymentMethods.find((p) => p.code === e.paymentMethod)
  const warn = e.categoryIds.some((id) => cat.get(id)?.systemRole === 'uncategorized')
  const kind: IconName = e.origin !== 'person' ? 'card' : e.receiptId !== null ? 'camera' : 'pencil'
  return (
    <Link className="erow" to={`/expenses/${e.id}`}>
      <span className="ithumb" aria-hidden="true">
        <Icon name={kind} size={18} />
      </span>
      <span className="emain">
        <span className="store">{e.storeName || '店名なし'}</span>
        <span className={`meta${warn ? ' warn' : ''}`}>{e.categoryIds.map((id) => cat.get(id)?.name ?? '?').join('・')}</span>
      </span>
      <span className="eright">
        <b className="num">{yen(e.amount)}</b>
        <span className="eicons">
          {PAY_ICON[e.paymentMethod] ? (
            <span className="pay" role="img" aria-label={pay?.label ?? e.paymentMethod}>
              <Icon name={PAY_ICON[e.paymentMethod]!} size={13} />
            </span>
          ) : (
            <span className="paytext">{pay?.label ?? ''}</span>
          )}
          {e.origin === 'person' && (
            <span className="who" role="img" aria-label={e.registeredBy}>
              {e.registeredBy.slice(0, 1)}
            </span>
          )}
          {m ? (
            <span className={`sti ${m.cls}`} role="img" aria-label={mark.label!}>
              <Icon name={m.icon} size={13} />
            </span>
          ) : (
            <span className="sti" />
          )}
        </span>
      </span>
    </Link>
  )
}
