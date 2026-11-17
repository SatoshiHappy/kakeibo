// 確かめる(見本はモック 14 版の review)。正本: データと照合 表 L・§4.9
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Confirm } from '../components/Confirm'
import { Screen, TopBar } from '../components/Shell'
import { ApiError } from '../lib/api'
import { shortDate, yen } from '../lib/format'
import { api, refetchAfterSave, useApiQuery } from '../lib/query'
import { cardOf, confirmOf, type Action, type Card, type Charge, type Expense, type ReviewResponse } from '../lib/review'

const PATH = '/api/review'
type Search = { charge: number } | { expense: number }

const refetchAll = () =>
  refetchAfterSave({
    predicate: (q) => {
      const k = String(q.queryKey[0])
      return k === PATH || k.startsWith('/api/home') || k.startsWith('/api/expenses')
    },
  })

function errorText(e: unknown) {
  if (!(e instanceof ApiError) || e.status === null) return '通信できませんでした。通信のある所でもう一度押してください。'
  if (e.code === 'charge_already_linked') return 'その明細はもう別の支出に結ばれています。先にそちらで外してください。'
  if (e.code === 'not_found' || e.code === 'not_free') return 'もう片づいた項目です。'
  if (e.code === 'changed') return 'ほかの人が支出か明細を直したので、差が変わりました。読み直した額で確かめてください。'
  return '保存できませんでした。もう一度押してください。'
}

/** 口を 1 つ以上呼ぶ(「別の買い物」は並んだ組を全部) */
async function run(a: Action) {
  switch (a.kind) {
    case 'link':
      return api.request(`${PATH}/link`, { method: 'POST', json: { chargeId: a.chargeId, expenseId: a.expenseId } })
    case 'reject':
      for (const p of a.pairs) await api.request(`${PATH}/reject`, { method: 'POST', json: p })
      return
    case 'none':
      return api.request(`${PATH}/none`, { method: 'POST', json: { chargeId: a.chargeId } })
    case 'ackNoStatement':
      return api.request(`${PATH}/ack-no-statement`, { method: 'POST', json: { expenseId: a.expenseId } })
    case 'ackDiff':
      return api.request(`${PATH}/ack-diff`, { method: 'POST', json: { expenseId: a.expenseId, diff: a.diff } })
    default:
      throw new Error(`not_an_api_action:${a.kind}`)
  }
}

export function Review() {
  const q = useApiQuery<ReviewResponse>(PATH)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState<{ card: Card; by: Search } | null>(null)

  // 押したらカードを先に消し、失敗したら戻して知らせる(基盤 §2.3)
  const act = useMutation({
    mutationFn: ({ action }: { card: Card; action: Action }) => run(action),
    onMutate: async ({ card }) => {
      setError(null)
      await qc.cancelQueries({ queryKey: [PATH] })
      const before = qc.getQueryData<ReviewResponse>([PATH])
      if (before) qc.setQueryData<ReviewResponse>([PATH], { ...before, items: before.items.filter((i) => cardOf(i, before.paymentMethods).key !== card.key) })
      return { before }
    },
    onError: (e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData([PATH], ctx.before)
      setError(errorText(e))
    },
    onSettled: refetchAll,
  })

  // 決まる操作は確かめの小窓を出してから送る(消す・捨てると同じ形。2026-11-17 ユーザー回答)
  const [pending, setPending] = useState<{ card: Card; action: Action } | null>(null)
  const onAction = (card: Card, a: Action) => {
    if (a.kind === 'edit') navigate(`/expenses/${a.expenseId}?from=review`)
    else if (a.kind === 'search') setSearch({ card, by: a.by })
    else setPending({ card, action: a })
  }
  const confirm = pending ? confirmOf(pending.action) : null

  const cards = q.data ? q.data.items.map((i) => cardOf(i, q.data.paymentMethods)) : []
  const right = (
    <Link className="pillbtn" to="/import">
      明細を取り込む
    </Link>
  )
  return (
    <Screen label="確かめる" tabs={false} top={<TopBar title={q.data ? `確かめる(${cards.length})` : '確かめる'} left={{ kind: 'back', to: '/settings', label: '設定に戻る' }} right={right} />}>
      {error && (
        <div className="errline" role="alert">
          <span>{error}</span>
          <button className="textbtn" type="button" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}
      {q.data ? (
        cards.length === 0 ? (
          <p className="note">確かめることはありません。</p>
        ) : (
          <>
            <p className="note">カード明細とレシートが自動で結べなかったもの。色の所が違い・見るところです。</p>
            {cards.map((c) => (
              <ReviewCard key={c.key} card={c} onAction={(a) => onAction(c, a)} />
            ))}
          </>
        )
      ) : q.isError ? (
        <p className="note">読み込めませんでした。通信のある所で開き直してください。</p>
      ) : (
        <p className="note">読み込み中…</p>
      )}
      <SearchDialog
        target={search}
        onClose={() => setSearch(null)}
        onPick={(chargeId, expenseId) => {
          const card = search!.card
          setSearch(null)
          setPending({ card, action: { kind: 'link', chargeId, expenseId, label: '結ぶ' } })
        }}
      />
      <Confirm
        open={confirm !== null}
        title={confirm?.title ?? ''}
        body={confirm?.body ?? ''}
        action={pending?.action.label ?? ''}
        busy={act.isPending}
        onClose={() => setPending(null)}
        onAction={() => {
          if (pending) act.mutate(pending)
          setPending(null)
        }}
      />
    </Screen>
  )
}

function ReviewCard({ card, onAction }: { card: Card; onAction: (a: Action) => void }) {
  const titleId = useId()
  return (
    <section className="rcard" aria-labelledby={titleId}>
      <h2 className="rq" id={titleId}>
        {card.question}
      </h2>
      <table className="ctable">
        <colgroup>
          <col style={{ width: 62 }} />
          <col style={{ width: 46 }} />
          <col />
          <col style={{ width: 70 }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">出どころ</span>
            </th>
            <th scope="col">日付</th>
            <th scope="col">店</th>
            <th scope="col" className="r">
              額
            </th>
          </tr>
        </thead>
        <tbody>
          {card.records.map((r, i) => (
            <tr key={i} className={r.faint ? 'faint' : undefined}>
              <th scope="row">{r.label}</th>
              <td className={r.diffDate ? 'diff' : undefined}>
                {r.date}
                {r.diffDate && <span className="visually-hidden">(違う)</span>}
              </td>
              <td>{r.name}</td>
              <td className={`r num${r.diffAmount ? ' diff' : ''}`}>
                {r.amount}
                {r.diffAmount && <span className="visually-hidden">(違う)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="rwhy">{card.why}</p>
      <div className="ract">
        {card.actions.map((a, i) => (
          <button key={i} className={i === 0 ? 'softbtn' : 'plainbtn'} type="button" onClick={() => onAction(a)}>
            {a.label}
          </button>
        ))}
      </div>
    </section>
  )
}

/** 探して足す(§4.9): 明細の行からは人の支出を、人の支出からは明細の行を選ぶ */
function SearchDialog({ target, onClose, onPick }: { target: { card: Card; by: Search } | null; onClose: () => void; onPick: (chargeId: number, expenseId: number) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (target && !d.open) d.showModal()
    if (!target && d.open) d.close()
  }, [target])
  return (
    <dialog ref={ref} className="sheet" aria-labelledby={titleId} onClose={onClose}>
      {target && <SearchBody by={target.by} titleId={titleId} onPick={onPick} />}
      <div className="sheet-actions one">
        <button className="sbtn" type="button" onClick={onClose}>
          やめる
        </button>
      </div>
    </dialog>
  )
}

function SearchBody({ by, titleId, onPick }: { by: Search; titleId: string; onPick: (chargeId: number, expenseId: number) => void }) {
  const isCharge = 'charge' in by
  const q = useApiQuery<{ expenses?: Expense[]; charges?: Charge[] }>(isCharge ? `${PATH}/search?charge=${by.charge}` : `${PATH}/search?expense=${by.expense}`)
  const rows = isCharge
    ? (q.data?.expenses ?? []).map((e) => ({ key: e.id, date: e.spentOn, name: e.storeName || '店名なし', amount: e.amount, pick: () => onPick(by.charge, e.id) }))
    : (q.data?.charges ?? []).map((c) => ({ key: c.id, date: c.usedOn, name: c.merchant, amount: c.amount, pick: () => onPick(c.id, (by as { expense: number }).expense) }))
  return (
    <>
      <h2 id={titleId}>{isCharge ? 'この明細に結ぶ支出を選ぶ' : 'この支出に足す明細の行を選ぶ'}</h2>
      <p className="note">前後 31 日から、額の近い順に 20 件。</p>
      {!q.data ? (
        <p className="note">{q.isError ? '読み込めませんでした。' : '読み込み中…'}</p>
      ) : rows.length === 0 ? (
        <p className="note">当たるものはありません。</p>
      ) : (
        <ul className="plain picklist">
          {rows.map((r) => (
            <li key={r.key}>
              <button className="pickrow" type="button" onClick={r.pick}>
                <span className="num">{shortDate(r.date)}</span>
                <span className="pname">{r.name}</span>
                <b className="num">{yen(r.amount)}</b>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
