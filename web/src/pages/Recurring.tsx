// 毎月決まった支出(家賃・ネット代など)。正本: データと照合 §1.17・表 Q・§4.12
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Screen, TopBar } from '../components/Shell'
import { ApiError } from '../lib/api'
import { yen } from '../lib/format'
import { api, refetchAfterSave, useApiQuery } from '../lib/query'

const PATH = '/api/recurring'
type Recurring = { id: number; name: string; categoryId: number; amount: number; paymentMethod: string; dayOfMonth: number; nextOn: string }
type RecurringResponse = {
  items: Recurring[]
  categories: { id: number; name: string }[]
  paymentMethods: { code: string; label: string }[]
  today: string
}
type Draft = Omit<Recurring, 'id' | 'nextOn'> & { nextOn: string | null; baseNextOn?: string }

/** 保存の後に読み直す(一覧と、作った支出が出る画面) */
const refetch = () => refetchAfterSave({ predicate: (x) => x.queryKey[0] === PATH })

function errorText(e: unknown): string {
  if (!(e instanceof ApiError) || e.status === null) return '通信できませんでした。通信のある所でもう一度押してください。'
  switch (e.code) {
    case 'invalid_category':
      return 'この費目はやめています。ほかの費目を選んでください。'
    case 'invalid_payment_method':
      return 'この支払い方法は使えません。'
    case 'past_date':
      return '次に作る日は今日以後にしてください。'
    case 'not_found':
      return 'この登録はもう止められています(ほかの端末で止めたなど)。'
    default:
      return '保存できませんでした。もう一度押してください。'
  }
}

const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`

export function RecurringPage() {
  const q = useApiQuery<RecurringResponse>(PATH)
  const [editing, setEditing] = useState<Recurring | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const right = (
    <button className="textbtn" type="button" onClick={() => setEditing('new')}>
      + 足す
    </button>
  )
  const data = q.data
  return (
    <Screen label="毎月決まった支出" tabs={false} top={<TopBar title="毎月決まった支出" left={{ kind: 'back', to: '/menu', label: 'メニュー' }} right={right} />}>
      {error && (
        <div className="errline" role="alert">
          <span>{error}</span>
          <button className="textbtn" type="button" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}
      <p className="note">登録すると、毎月その日の朝に支出を自動で作ります(一覧に「自動」の印)。額が変わった月は、作られた支出を直してください。カードで払うものは明細から入るので、登録は口座振替・現金などのものに使います。</p>
      {!data ? (
        <p className="note">読み込み中…</p>
      ) : data.items.length === 0 ? (
        <p className="note">まだありません。「+ 足す」から家賃などを登録してください。</p>
      ) : (
        <div className="panel">
          {data.items.map((r) => (
            <button key={r.id} className="lrow recur" type="button" onClick={() => setEditing(r)}>
              <span className="mi">
                <span>
                  {r.name}
                  <br />
                  <span className="sub">
                    毎月 {r.dayOfMonth} 日 · {data.categories.find((c) => c.id === r.categoryId)?.name ?? ''} · 次は {md(r.nextOn)}
                  </span>
                </span>
              </span>
              <b className="num">{yen(r.amount)}</b>
            </button>
          ))}
        </div>
      )}
      {data && <RecurringDialog target={editing} data={data} onClose={() => setEditing(null)} onStopError={setError} />}
    </Screen>
  )
}

/** 足す・直す小窓。口が断る誤り(やめた費目・過ぎた日)をその場で直せるよう、応答を待ってから閉じる */
function RecurringDialog({
  target,
  data,
  onClose,
  onStopError,
}: {
  target: Recurring | 'new' | null
  data: RecurringResponse
  onClose: () => void
  onStopError: (message: string | null) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const first = useRef<HTMLInputElement>(null)
  const requestId = useRef('')
  const titleId = useId()
  const [error, setError] = useState<string | null>(null)
  const item = target !== 'new' ? target : null

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (target !== null && !d.open) {
      setError(null)
      requestId.current = crypto.randomUUID() // 開くたびに 1 つ。押し直しても登録が 2 つにならない
      d.showModal()
      first.current?.focus()
    }
    if (target === null && d.open) d.close()
  }, [target])

  const save = useMutation({
    mutationFn: async (v: Draft) => {
      if (item === null) return api.request(PATH, { method: 'POST', json: { clientRequestId: requestId.current, ...v } })
      return api.request(`${PATH}/${item.id}`, { method: 'PUT', json: { ...v, baseNextOn: item.nextOn } })
    },
    onSuccess: () => onClose(),
    onError: (e) => setError(errorText(e)),
    onSettled: refetch,
  })
  const qc = useQueryClient()
  // 止めるは断られて直す入力が無いので、押した時点で一覧から外して閉じ、失敗したら戻して知らせる(基盤 §2.3)
  const stop = useMutation({
    mutationFn: async (id: number) => api.request(`${PATH}/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: [PATH] }) // 読み込み中の古い一覧で、外した登録が戻らないように
      onStopError(null)
      const before = qc.getQueryData<RecurringResponse>([PATH])
      qc.setQueryData<RecurringResponse>([PATH], (d) => d && { ...d, items: d.items.filter((i) => i.id !== id) })
      onClose()
      return { before }
    },
    onError: (e, _id, ctx) => {
      if (ctx?.before) qc.setQueryData([PATH], ctx.before)
      onStopError(errorText(e))
    },
    onSettled: refetch,
  })

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const nextOn = String(f.get('nextOn') ?? '') || null
    // 口と同じ規則: 日を変えたときだけ今日以後(作り残しで過ぎた日は、変えなければそのままでよい)
    if (nextOn !== null && nextOn !== item?.nextOn && nextOn < data.today) {
      setError('次に作る日は今日以後にしてください。')
      return
    }
    setError(null)
    save.mutate({
      name: String(f.get('name')).trim(),
      amount: Number(f.get('amount')),
      categoryId: Number(f.get('categoryId')),
      paymentMethod: String(f.get('paymentMethod')),
      dayOfMonth: Number(f.get('dayOfMonth')),
      nextOn,
    })
  }

  return (
    <dialog ref={ref} className="sheet" aria-labelledby={titleId} onClose={onClose}>
      {target !== null && (
        <form key={item?.id ?? 'new'} onSubmit={submit}>
          <h2 id={titleId}>{item ? '毎月決まった支出を直す' : '毎月決まった支出を足す'}</h2>
          <label className="fld">
            <span>名前(一覧の店の欄)</span>
            <input ref={first} name="name" required maxLength={100} placeholder="家賃" defaultValue={item?.name ?? ''} />
          </label>
          <label className="fld">
            <span>額(円)</span>
            <input name="amount" type="number" inputMode="numeric" required min={1} step={1} defaultValue={item?.amount ?? ''} />
          </label>
          <label className="fld">
            <span>費目</span>
            <select name="categoryId" required defaultValue={item?.categoryId ?? ''}>
              {item === null && <option value="">選ぶ</option>}
              {data.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="fld">
            <span>支払い方法</span>
            <select name="paymentMethod" required defaultValue={item?.paymentMethod ?? 'bank_transfer'}>
              {data.paymentMethods.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="fld">
            <span>毎月の日(その月に無い日は月末)</span>
            <input name="dayOfMonth" type="number" inputMode="numeric" required min={1} max={31} step={1} defaultValue={item?.dayOfMonth ?? ''} />
          </label>
          <label className="fld">
            <span>{item ? '次に作る日' : '最初に作る日(空なら今日以後で最初のその日)'}</span>
            <input name="nextOn" type="date" required={item !== null} min={item ? undefined : data.today} defaultValue={item?.nextOn ?? ''} />
          </label>
          {error && (
            <p className="ferr" role="alert">
              {error}
            </p>
          )}
          {item && (
            <button className="sbtn" type="button" disabled={stop.isPending} onClick={() => stop.mutate(item.id)}>
              止める(作った支出は残ります)
            </button>
          )}
          <div className="sheet-actions">
            <button className="sbtn" type="button" onClick={onClose}>
              やめる
            </button>
            <button className="pbtn" type="submit" disabled={save.isPending}>
              {save.isPending ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  )
}
