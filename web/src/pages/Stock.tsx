// 消耗品の在庫(見本はモック 14 版・15 版の stock)。正本: データと照合 §1.14・§1.15・§2.5・表 S・表 U、基盤 §7
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { Screen, TopBar } from '../components/Shell'
import { ApiError } from '../lib/api'
import { pushState, turnOffPush, turnOnPush, type PushState } from '../lib/push'
import { api, refetchAfterSave, useApiQuery } from '../lib/query'
import { forecastText, stockSections, type StockItem } from '../lib/stock'

const PATH = '/api/stock'
type StockResponse = { items: StockItem[] }

/** 保存の後に読み直す。予測(表 S)は口が数え、ホームの「そろそろ買う」も古くなる */
const refetchStock = () => refetchAfterSave({ predicate: (x) => x.queryKey[0] === PATH || String(x.queryKey[0]).startsWith('/api/home') })

/** 口の誤り(表 U)を人に伝える文。どれでもなければ通信の失敗の文 */
function errorText(e: unknown): string {
  if (!(e instanceof ApiError) || e.status === null) return '通信できませんでした。通信のある所でもう一度押してください。'
  switch (e.code) {
    case 'no_stock':
      return '買い置きが 0 です。数がずれていたら、品物を押して今の数を入れ直してください。'
    case 'undo_expired':
      return '10 分を過ぎたので取り消せません。数がずれていたら、品物を押して今の数を入れ直してください。'
    case 'not_latest':
      return '後に別の記録があるので取り消せません。数がずれていたら、品物を押して今の数を入れ直してください。'
    case 'duplicate_name':
      return '同じ名前の品物があります。'
    case 'move_not_found':
      return 'もう取り消されています(ほかの端末で取り消したなど)。'
    case 'not_found':
    case 'retired':
      return 'この品物は一覧から外れています。'
    default:
      return '保存できませんでした。もう一度押してください。'
  }
}

export function Stock() {
  const q = useApiQuery<StockResponse>(PATH)
  const [editing, setEditing] = useState<StockItem | 'new' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const actions = useStockActions(setError)

  const right = (
    <button className="textbtn" type="button" onClick={() => setEditing('new')}>
      + 品物
    </button>
  )
  return (
    <Screen label="在庫" tabs top={<TopBar title="消耗品の在庫" right={right} />}>
      <PushBox />
      {error && (
        <div className="errline" role="alert">
          <span>{error}</span>
          <button className="textbtn" type="button" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}
      {q.data ? (
        <StockBody items={q.data.items} onEdit={setEditing} actions={actions} />
      ) : q.isError ? (
        <p className="note">読み込めませんでした。通信のある所で開き直してください。</p>
      ) : (
        <p className="note">読み込み中…</p>
      )}
      <p className="note">新しい包みを使い始めたら「1つ使った」。増えるのはレシートから自動。数がずれたら品物を押して直す。</p>
      <StockDialog target={editing} onClose={() => setEditing(null)} onRetire={(i) => actions.retire(i, true)} />
    </Screen>
  )
}

type Actions = ReturnType<typeof useStockActions>

/** 「1つ使った」と取り消し。押した時点で画面の数を変え、失敗したら戻して知らせる(基盤 §2.3) */
function useStockActions(setError: (m: string | null) => void) {
  const qc = useQueryClient()
  const patch = (id: number, f: (i: StockItem) => StockItem) =>
    qc.setQueryData<StockResponse>([PATH], (d) => d && { items: d.items.map((i) => (i.id === id ? f(i) : i)) })
  const optimistic = async (id: number, f: (i: StockItem) => StockItem) => {
    setError(null)
    await qc.cancelQueries({ queryKey: [PATH] })
    const before = qc.getQueryData<StockResponse>([PATH])
    patch(id, f)
    return { before }
  }
  const settle = {
    onError: (e: unknown, _v: unknown, ctx: { before: StockResponse | undefined } | undefined) => {
      if (ctx?.before) qc.setQueryData([PATH], ctx.before)
      setError(errorText(e))
    },
    onSettled: refetchStock,
  }
  const use = useMutation({
    mutationFn: (item: StockItem) => api.request<{ moveId: number }>(`${PATH}/${item.id}/use`, { method: 'POST' }),
    onMutate: (item) => optimistic(item.id, (i) => ({ ...i, quantity: i.quantity - 1, undoableMoveId: null })),
    onSuccess: (r, item) => patch(item.id, (i) => ({ ...i, undoableMoveId: r.moveId })),
    ...settle,
  })
  const undo = useMutation({
    mutationFn: (item: StockItem) => api.request<void>(`${PATH}/${item.id}/moves/${item.undoableMoveId}`, { method: 'DELETE' }),
    onMutate: (item) => optimistic(item.id, (i) => ({ ...i, quantity: i.quantity + 1, undoableMoveId: null })),
    ...settle,
  })
  // 一覧から外す・戻す(データと照合 §1.14。記録は残り、戻せる)
  const retire = useMutation({
    mutationFn: ({ item, retired }: { item: StockItem; retired: boolean }) => api.request(`${PATH}/${item.id}`, { method: 'PATCH', json: { retired } }),
    onMutate: ({ item, retired }) => optimistic(item.id, (i) => ({ ...i, retired, undoableMoveId: null })),
    ...settle,
  })
  return {
    use: (i: StockItem) => use.mutate(i),
    undo: (i: StockItem) => undo.mutate(i),
    retire: (i: StockItem, retired: boolean) => retire.mutate({ item: i, retired }),
  }
}

function StockBody({ items, onEdit, actions }: { items: StockItem[]; onEdit: (i: StockItem) => void; actions: Actions }) {
  const { soon, ok } = stockSections(items)
  const retired = items.filter((i) => i.retired)
  return (
    <>
      {soon.length + ok.length === 0 && <p className="note">品物はまだありません。右上の「+ 品物」から足してください。</p>}
      {soon.length > 0 && (
        <section aria-labelledby="stock-soon">
          <h2 className="sect" id="stock-soon">
            <span className="soon">在庫アラート({soon.length})</span>
            <span className="faint">なくなる日が近い順</span>
          </h2>
          <ul className="plain kgrid">
            {soon.map((i) => (
              <StockCard key={i.id} item={i} onEdit={onEdit} actions={actions} />
            ))}
          </ul>
        </section>
      )}
      {ok.length > 0 && (
        <section aria-labelledby="stock-ok">
          <h2 className="sect" id="stock-ok">
            <span>まだある({ok.length})</span>
            <span className="faint">なくなるのが早い順</span>
          </h2>
          <ul className="plain kgrid">
            {ok.map((i) => (
              <StockCard key={i.id} item={i} onEdit={onEdit} actions={actions} />
            ))}
          </ul>
        </section>
      )}
      {retired.length > 0 && (
        <details className="panel retired">
          <summary>一覧から外した品物({retired.length})</summary>
          <ul className="plain">
            {retired.map((i) => (
              <li key={i.id} className="lrow">
                <span>{i.name}</span>
                <button className="textbtn" type="button" aria-label={`${i.name}を一覧に戻す`} onClick={() => actions.retire(i, false)}>
                  戻す
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

function StockCard({ item, onEdit, actions }: { item: StockItem; onEdit: (i: StockItem) => void; actions: Actions }) {
  const t = forecastText(item)
  return (
    <li className="kcard">
      <button className="kmain" type="button" onClick={() => onEdit(item)}>
        <span className="kname">
          {item.name}
          <span className="visually-hidden">(押して数を直す)</span>
        </span>
        <span className={`kpred${item.state === 'soon' ? ' soon' : ''}`}>{t.main}</span>
        <span className="meta">{t.meta}</span>
      </button>
      <div className="kuse">
        <span className="kleft">
          <span className="faint">買い置き</span>
          <b className="num">{item.quantity}</b>
        </span>
        {item.quantity > 0 ? (
          <button type="button" aria-label={`${item.name}を1つ使った`} onClick={() => actions.use(item)}>
            1つ使った
          </button>
        ) : (
          <button type="button" disabled>
            買い置きなし
          </button>
        )}
      </div>
      {item.undoableMoveId !== null && (
        <button className="kundo" type="button" aria-label={`${item.name}の「1つ使った」を取り消す`} onClick={() => actions.undo(item)}>
          取り消す
        </button>
      )}
    </li>
  )
}

/** 通知の許可(基盤 §7)。iOS は、ホーム画面に追加したアプリの中で押したときだけ許可を求められる */
function PushBox() {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    void pushState().then((s) => live && setState(s))
    return () => {
      live = false
    }
  }, [])
  if (state === null) return null
  const run = async (f: () => Promise<PushState>) => {
    setBusy(true)
    setFailed(false)
    try {
      setState(await f())
    } catch (e) {
      console.error(e)
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  const text: Record<PushState, string> = {
    unsupported: '通知は、ホーム画面に追加したアプリで使えます。',
    denied: '通知が止められています。iPhone の設定アプリの「通知」で許可してください。',
    off: '在庫アラートの品物を、朝 9 時にこの iPhone に知らせる。',
    on: '在庫アラートの品物を、朝 9 時にこの iPhone に知らせます。',
  }
  return (
    <div className="pushbox">
      <Icon name="bell" />
      <span className="ptext" role={failed ? 'alert' : undefined}>
        {failed ? (state === 'on' ? '通知を止められませんでした。通信のある所でもう一度押してください。' : '通知を許可できませんでした。通信のある所でもう一度押してください。') : text[state]}
      </span>
      {state === 'off' && (
        <button className="mini" type="button" disabled={busy} onClick={() => run(turnOnPush)}>
          通知を許可
        </button>
      )}
      {state === 'on' && (
        <button className="textbtn" type="button" disabled={busy} onClick={() => run(turnOffPush)}>
          止める
        </button>
      )}
    </div>
  )
}

/** 品物を足す・直す小窓。名前が重なると口が断るので、応答を待ってから閉じる(誤りをその場で直せるように) */
function StockDialog({ target, onClose, onRetire }: { target: StockItem | 'new' | null; onClose: () => void; onRetire: (i: StockItem) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const first = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const [error, setError] = useState<string | null>(null)
  const isNew = target === 'new'
  const item = target !== 'new' ? target : null

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (target !== null && !d.open) {
      setError(null)
      d.showModal()
      first.current?.focus()
    }
    if (target === null && d.open) d.close()
  }, [target])

  const save = useMutation({
    mutationFn: async (v: { name: string; count: number; notifyDays: number }) => {
      if (item === null) return api.request(PATH, { method: 'POST', json: v })
      if (v.name !== item.name || v.notifyDays !== item.notifyDays)
        await api.request(`${PATH}/${item.id}`, { method: 'PATCH', json: { name: v.name, notifyDays: v.notifyDays } })
      if (v.count !== item.quantity) await api.request(`${PATH}/${item.id}/count`, { method: 'POST', json: { count: v.count } })
    },
    onSuccess: () => onClose(),
    onError: (e) => setError(errorText(e)),
    onSettled: refetchStock,
  })

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setError(null)
    save.mutate({ name: String(f.get('name')).trim(), count: Number(f.get('count')), notifyDays: Number(f.get('notifyDays')) })
  }

  return (
    <dialog ref={ref} className="sheet" aria-labelledby={titleId} onClose={onClose}>
      {target !== null && (
        // key: 開くたびに入力欄を品物の今の値から作り直す
        <form key={item?.id ?? 'new'} onSubmit={submit}>
          <h2 id={titleId}>{isNew ? '品物を足す' : '品物を直す'}</h2>
          <label className="fld">
            <span>名前</span>
            <input ref={isNew ? first : undefined} name="name" required maxLength={50} defaultValue={item?.name ?? ''} />
          </label>
          <label className="fld">
            <span>今の数(買い置き)</span>
            <input ref={isNew ? undefined : first} name="count" type="number" inputMode="numeric" required min={0} step={1} defaultValue={item?.quantity ?? 0} />
          </label>
          <label className="fld">
            <span>なくなる何日前から「在庫アラート」</span>
            <input name="notifyDays" type="number" inputMode="numeric" required min={0} max={365} step={1} defaultValue={item?.notifyDays ?? 7} />
          </label>
          {error && (
            <p className="ferr" role="alert">
              {error}
            </p>
          )}
          {item && (
            <button
              className="sbtn"
              type="button"
              onClick={() => {
                onRetire(item)
                onClose()
              }}
            >
              この品物を一覧から外す(記録は残り、戻せる)
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
