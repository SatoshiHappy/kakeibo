// 確かめて保存(見本はモック 14 版の confirm)。下書きから・手入力・保存済みの支出を直す。正本: データと照合 §4.7・表 V・表 T・§5
import { useMutation } from '@tanstack/react-query'
import { del, get, set } from 'idb-keyval'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Icon } from '../components/Icon'
import { Screen, TopBar } from '../components/Shell'
import { ApiError } from '../lib/api'
import {
  adjustmentSummary,
  blankItem,
  parseYen,
  startOf,
  toBody,
  totalLine,
  totals,
  uncategorizedId,
  type AdjustmentDraft,
  type ExpenseDraft,
  type FormResponse,
  type ItemDraft,
  type Mode,
  type Rate,
} from '../lib/expenseForm'
import { yen } from '../lib/format'
import { api, refetchAfterSave, useApiQuery } from '../lib/query'

const POLL_MS = 5000
const MAX_ITEMS = 200
const MAX_ADJUSTMENTS = 20

export function ReceiptForm() {
  const { id } = useParams()
  return <ExpenseFormPage key={`r${id}`} mode={{ kind: 'receipt', receiptId: Number(id) }} />
}
export function NewExpenseForm() {
  return <ExpenseFormPage key="new" mode={{ kind: 'new' }} />
}
export function EditExpenseForm() {
  const { id } = useParams()
  return <ExpenseFormPage key={`e${id}`} mode={{ kind: 'expense', expenseId: Number(id) }} />
}

const pathOf = (m: Mode) =>
  m.kind === 'receipt' ? `/api/expense-form?receipt=${m.receiptId}` : m.kind === 'expense' ? `/api/expense-form?expense=${m.expenseId}` : '/api/expense-form'
const storeKey = (m: Mode) => `kakeibo-form:${m.kind === 'receipt' ? `receipt-${m.receiptId}` : m.kind === 'expense' ? `expense-${m.expenseId}` : 'new'}`
const backOf = (m: Mode) => (m.kind === 'expense' ? '/list' : '/capture')

/** 保存の後に古くなる一覧(撮る・ホーム・一覧・在庫) */
const refetchLists = () =>
  refetchAfterSave({
    predicate: (q) => {
      const k = String(q.queryKey[0])
      return k === '/api/receipts' || k.startsWith('/api/home') || k.startsWith('/api/expenses') || k === '/api/stock'
    },
  })

/** 端末に残した入力(401 の再読み込みの前に残したもの。基盤 §3.2)。読み終わるまで undefined */
function useStoredDraft(key: string) {
  const [stored, setStored] = useState<ExpenseDraft | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    get<ExpenseDraft>(key).then(
      (d) => live && setStored(d ?? null),
      (e: unknown) => {
        console.error('stored_draft_unreadable', e)
        if (live) setStored(null)
      },
    )
    return () => {
      live = false
    }
  }, [key])
  return stored
}

function ExpenseFormPage({ mode }: { mode: Mode }) {
  const navigate = useNavigate()
  const [manual, setManual] = useState(false)
  const q = useApiQuery<FormResponse>(pathOf(mode), {
    refetchInterval: (query) => (query.state.data?.receipt?.read === 'reading' && !manual ? POLL_MS : false),
  })
  const stored = useStoredDraft(storeKey(mode))
  const start = q.data ? startOf(mode, q.data, undefined, manual) : null

  const redirect = start?.row === 'V4' ? start.to : null
  useEffect(() => {
    if (redirect) navigate(redirect, { replace: true })
  }, [redirect, navigate])

  const back = { kind: 'back', to: backOf(mode), label: mode.kind === 'expense' ? '一覧に戻る' : '撮るに戻る' } as const
  const title = mode.kind === 'expense' ? '支出を直す' : mode.kind === 'new' ? '手で入力' : '確かめて保存'
  const shell = (children: ReactNode, right?: ReactNode) => (
    <Screen label={title} tabs={false} top={<TopBar title={title} left={back} right={right} />}>
      {children}
    </Screen>
  )

  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404
    return shell(<p className="note">{notFound ? '見つかりません。もう保存したか、捨てた下書きです。' : '読み込めませんでした。通信のある所で開き直してください。'}</p>)
  }
  if (!q.data || !start || stored === undefined) return shell(<p className="note">読み込み中…</p>)
  const data = q.data
  if (start.row === 'V4') return shell(<p className="note">保存済みの支出を開いています…</p>)
  if (start.row === 'V7') return shell(<StatementEditor mode={mode} data={data} />)
  if (start.row === 'V2')
    return shell(
      <>
        <Photos receiptId={data.receipt!.id} count={data.receipt!.images.length} text="読み取り中…(終わると自動で入ります)" />
        <button className="sbtn" type="button" onClick={() => setManual(true)}>
          待たずに手で入力する
        </button>
      </>,
    )
  return (
    <Editor
      key={`${storeKey(mode)}:${start.row}`}
      mode={mode}
      data={data}
      row={start.row}
      initial={stored ?? start.draft}
      restored={stored !== null}
      title={title}
      back={back}
    />
  )
}

type Back = { kind: 'back'; to: string; label: string }

function errorText(e: unknown): string {
  if (!(e instanceof ApiError) || e.status === null) return '通信できませんでした。通信のある所でもう一度押してください。'
  switch (e.code) {
    case 'no_distribution_target':
      return '値引き・外税を配る品目がありません(例: 8% の外税があるのに 8% の品目が無い)。率か品目を直してください。'
    case 'invalid_category':
      return '使えない費目があります。費目を選び直してください。'
    case 'invalid_stock_item':
      return '使えない在庫の品物があります。選び直してください。'
    case 'invalid_payment_method':
      return '支払いを選び直してください。'
    case 'receipt_already_saved':
      return 'このレシートはもう支出に保存されています。'
    case 'not_found':
    case 'receipt_not_found':
      return '見つかりません。もう消された支出か下書きです。'
    default:
      return '保存できませんでした。もう一度押してください。'
  }
}

function Editor(props: { mode: Mode; data: FormResponse; row: 'V1' | 'V3' | 'V5' | 'V6'; initial: ExpenseDraft; restored: boolean; title: string; back: Back }) {
  const { mode, data, row, title, back } = props
  const navigate = useNavigate()
  const [draft, setDraft] = useState(props.initial)
  const [open, setOpen] = useState<string | null>(row === 'V3' || row === 'V5' ? (props.initial.items[0]?.key ?? null) : null)
  const [adjOpen, setAdjOpen] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [confirm, setConfirm] = useState<'discard' | 'delete' | null>(null)
  const key = storeKey(mode)

  // 401 で再読み込みする前に、今の入力を端末に残す(基盤 §3.2・表 K の K2)
  const latest = useRef(draft)
  useEffect(() => {
    latest.current = draft
  }, [draft])
  useEffect(() => {
    const off = api.registerDraftSaver(() => set(key, latest.current))
    return () => void off()
  }, [key])

  const leave = async () => {
    await del(key)
    void refetchLists()
    navigate(back.to, { replace: true })
  }

  const save = useMutation({
    mutationFn: async () => {
      const b = toBody(draft)
      if (!b.ok) throw new FormErrors(b.errors)
      if (mode.kind === 'expense') return api.request(`/api/expenses/${mode.expenseId}`, { method: 'PUT', json: b.body })
      const receiptId = mode.kind === 'receipt' ? mode.receiptId : null
      return api.request('/api/expenses', { method: 'POST', json: { ...b.body, clientRequestId: draft.clientRequestId, receiptId } })
    },
    onMutate: () => setErrors([]),
    onSuccess: leave,
    onError: (e) => setErrors(e instanceof FormErrors ? e.errors : [errorText(e)]),
  })
  const remove = useMutation({
    mutationFn: () =>
      mode.kind === 'expense'
        ? api.request(`/api/expenses/${mode.expenseId}`, { method: 'DELETE' })
        : api.request(`/api/receipts/${(mode as { receiptId: number }).receiptId}`, { method: 'DELETE' }),
    onSuccess: leave,
    onError: (e) => {
      setConfirm(null)
      setErrors([errorText(e)])
    },
  })
  const reread = useMutation({
    mutationFn: () => api.request(`/api/receipts/${(mode as { receiptId: number }).receiptId}/read`, { method: 'POST' }),
    onSettled: () => refetchAfterSave({ queryKey: [pathOf(mode)] }),
    onError: (e) => setErrors([errorText(e)]),
  })

  const setItem = (k: string, patch: Partial<ItemDraft>) => setDraft((d) => ({ ...d, items: d.items.map((i) => (i.key === k ? { ...i, ...patch } : i)) }))
  const setAdj = (k: string, patch: Partial<AdjustmentDraft>) =>
    setDraft((d) => ({ ...d, adjustments: d.adjustments.map((a) => (a.key === k ? { ...a, ...patch } : a)) }))
  const addItem = () => {
    const item = blankItem(uncategorizedId(data.categories))
    setDraft((d) => ({ ...d, items: [...d.items, item] }))
    setOpen(item.key)
  }

  const t = totals(draft)
  const printed = data.receipt?.read === 'read' ? (data.receipt.result?.printedTotal ?? null) : null
  const line = totalLine(t.total, printed)
  const catName = new Map(data.categories.map((c) => [c.id, c.name]))
  const stockName = new Map(data.stockItems.map((s) => [s.id, s.name]))
  const busy = save.isPending || remove.isPending || reread.isPending

  const right =
    mode.kind === 'receipt' ? (
      <button className="textbtn danger" type="button" disabled={busy} onClick={() => setConfirm('discard')}>
        捨てる
      </button>
    ) : undefined

  return (
    <Screen label={title} tabs={false} top={<TopBar title={title} left={back} right={right} />}>
      {data.receipt && (
        <Photos
          receiptId={data.receipt.id}
          count={data.receipt.images.length}
          text={
            row === 'V1'
              ? 'AI が読んだ内容です。違う所を押して直してください。写真を押すと大きく見られます。'
              : row === 'V3'
                ? '読めませんでした。手で入力するか、読み直してください。'
                : '写真を押すと大きく見られます。'
          }
        >
          {row === 'V3' && (
            <button className="sbtn" type="button" disabled={busy} onClick={() => reread.mutate()}>
              {reread.isPending ? '読み直しています…' : '読み直す'}
            </button>
          )}
        </Photos>
      )}
      {props.restored && <p className="note">前に入れていた内容を戻しました。</p>}

      <div className="panel">
        <label className="frow">
          <span>店</span>
          <input value={draft.storeName} maxLength={200} onChange={(e) => setDraft({ ...draft, storeName: e.currentTarget.value })} />
        </label>
        <div className="frow2">
          <label className="frow">
            <span>日付</span>
            <input type="date" required value={draft.spentOn} onChange={(e) => setDraft({ ...draft, spentOn: e.currentTarget.value })} />
          </label>
          <label className="frow">
            <span>支払い</span>
            <select required value={draft.paymentMethod} onChange={(e) => setDraft({ ...draft, paymentMethod: e.currentTarget.value })}>
              <option value="">選ぶ</option>
              {data.paymentMethods.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <section className="panel" aria-labelledby="items-title">
        <h2 id="items-title">
          <span>品目({draft.items.length})</span>
          <button className="textbtn" type="button" disabled={draft.items.length >= MAX_ITEMS} onClick={addItem}>
            + 品目を足す
          </button>
        </h2>
        {draft.items.map((it, n) =>
          open === it.key ? (
            <ItemEditor
              key={it.key}
              no={n + 1}
              item={it}
              data={data}
              onChange={(p) => setItem(it.key, p)}
              onRemove={() => {
                setDraft((d) => ({ ...d, items: d.items.filter((x) => x.key !== it.key) }))
                setOpen(null)
              }}
              onClose={() => setOpen(null)}
            />
          ) : (
            <button key={it.key} className="irow" type="button" onClick={() => setOpen(it.key)}>
              <span className="iname">{it.name || `品目 ${n + 1}`}</span>
              <span className="chip">{it.categoryId === null ? '費目なし' : (catName.get(it.categoryId) ?? '?')}</span>
              <span className="irate">
                {it.taxRate === null ? '税率不明' : `${it.taxRate}%`}
                {it.stockItemId !== null && ` · 在庫 ${stockName.get(it.stockItemId) ?? ''} +${it.stockQuantity || '?'}`}
              </span>
              <b className="num">{parseYen(it.baseAmount) === null ? '—' : yen(parseYen(it.baseAmount)!)}</b>
            </button>
          ),
        )}
        <div className="adj">
          <span>
            品目 {yen(t.itemsTotal)}
            {draft.adjustments.length > 0 && ` + ${adjustmentSummary(draft.adjustments)}`}
          </span>
          <span className="num">{draft.adjustments.length > 0 ? `${t.adjustmentsTotal >= 0 ? '+' : ''}${yen(t.adjustmentsTotal)}` : ''}</span>
        </div>
        {adjOpen ? (
          <Adjustments
            items={draft.adjustments}
            onChange={setAdj}
            onAdd={() =>
              setDraft((d) => ({ ...d, adjustments: [...d.adjustments, { key: crypto.randomUUID(), kind: 'tax', taxRate: null, amount: '' }] }))
            }
            canAdd={draft.adjustments.length < MAX_ADJUSTMENTS}
            onRemove={(k) => setDraft((d) => ({ ...d, adjustments: d.adjustments.filter((a) => a.key !== k) }))}
            onClose={() => setAdjOpen(false)}
          />
        ) : (
          <button className="textbtn adjbtn" type="button" onClick={() => setAdjOpen(true)}>
            レシート全体の値引き・外税を直す
          </button>
        )}
      </section>

      {errors.length > 0 && (
        <ul className="ferrs" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {mode.kind === 'expense' && (
        <button className="sbtn dangerbtn" type="button" disabled={busy} onClick={() => setConfirm('delete')}>
          この支出を消す
        </button>
      )}

      <div className="savebar">
        <div className="lines">
          {line.text && <span className={`sub ${line.ok ? 'good' : 'bad'}`}>{line.text}</span>}
          <span className="big num">{yen(t.total)}</span>
        </div>
        <button className="pbtn" type="button" disabled={busy} onClick={() => save.mutate()}>
          {save.isPending ? '保存しています…' : mode.kind === 'expense' ? '変更を保存' : '保存する'}
        </button>
      </div>

      <Confirm
        open={confirm !== null}
        title={confirm === 'delete' ? 'この支出を消しますか?' : 'この下書きを捨てますか?'}
        body={
          confirm === 'delete'
            ? data.receipt
              ? 'レシートの写真は下書きに戻ります。'
              : '消した支出は戻せません。'
            : '写真も消え、戻せません。'
        }
        action={confirm === 'delete' ? '消す' : '捨てる'}
        busy={remove.isPending}
        onAction={() => remove.mutate()}
        onClose={() => setConfirm(null)}
      />
    </Screen>
  )
}

/** 表 V の V7: 明細の支出は費目だけ。選んだ時点で画面を変えて保存し、失敗したら戻して知らせる(基盤 §2.3) */
function StatementEditor({ mode, data }: { mode: Mode; data: FormResponse }) {
  const e = data.expense!
  const [cats, setCats] = useState(() => e.items.map((i) => i.categoryId))
  const [error, setError] = useState<string | null>(null)
  const change = async (index: number, categoryId: number) => {
    const before = cats
    setCats((c) => c.map((x, i) => (i === index ? categoryId : x)))
    setError(null)
    try {
      await api.request(`/api/expenses/${e.id}/items/${e.items[index]!.position}`, { method: 'PATCH', json: { categoryId } })
    } catch (err) {
      setCats(before)
      setError(errorText(err))
    } finally {
      void refetchLists()
      void refetchAfterSave({ queryKey: [pathOf(mode)] })
    }
  }
  return (
    <>
      <p className="note">カード明細から作った支出です。費目だけ直せます(選んだ時点で保存します)。</p>
      <div className="panel">
        <div className="frow">
          <span>店</span>
          <span className="fval">{e.storeName}</span>
        </div>
        <div className="frow2">
          <div className="frow">
            <span>日付</span>
            <span className="fval num">{e.spentOn.replaceAll('-', '/')}</span>
          </div>
          <div className="frow">
            <span>額</span>
            <span className="fval num">{yen(e.amount)}</span>
          </div>
        </div>
      </div>
      {error && (
        <p className="ferrs" role="alert">
          {error}
        </p>
      )}
      <section className="panel" aria-labelledby="sitems-title">
        <h2 id="sitems-title">
          <span>品目({e.items.length})</span>
        </h2>
        {e.items.map((it, i) => (
          <label key={it.position} className="frow">
            <span>
              {it.name ?? `品目 ${i + 1}`} <span className="num">{yen(it.amount)}</span>
            </span>
            <select value={cats[i]} onChange={(ev) => void change(i, Number(ev.currentTarget.value))}>
              {data.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.retired ? '(やめた費目)' : ''}
                </option>
              ))}
            </select>
          </label>
        ))}
      </section>
    </>
  )
}

class FormErrors extends Error {
  readonly errors: string[]
  constructor(errors: string[]) {
    super('form_errors')
    this.errors = errors
  }
}

const RATES: { value: string; label: string; rate: Rate }[] = [
  { value: '', label: '不明', rate: null },
  { value: '8', label: '8%', rate: 8 },
  { value: '10', label: '10%', rate: 10 },
  { value: '0', label: '0%', rate: 0 },
]
const rateValue = (r: Rate) => (r === null ? '' : String(r))
const rateOf = (v: string) => RATES.find((x) => x.value === v)!.rate

function ItemEditor(props: { no: number; item: ItemDraft; data: FormResponse; onChange: (p: Partial<ItemDraft>) => void; onRemove: () => void; onClose: () => void }) {
  const { item, data, onChange } = props
  return (
    <div className="irow open" role="group" aria-label={`品目 ${props.no}`}>
      <div className="iedit">
        <label className="fld wide">
          <span>品名</span>
          <input value={item.name} maxLength={200} onChange={(e) => onChange({ name: e.currentTarget.value })} />
        </label>
        <label className="fld">
          <span>額(値引のあと)</span>
          <input inputMode="numeric" value={item.baseAmount} onChange={(e) => onChange({ baseAmount: e.currentTarget.value })} />
        </label>
        <label className="fld">
          <span>費目</span>
          <select value={item.categoryId ?? ''} onChange={(e) => onChange({ categoryId: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })}>
            <option value="">選ぶ</option>
            {data.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.retired ? '(やめた費目)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="fld">
          <span>税率</span>
          <select value={rateValue(item.taxRate)} onChange={(e) => onChange({ taxRate: rateOf(e.currentTarget.value) })}>
            {RATES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="fld">
          <span>在庫に足す品物</span>
          <select
            value={item.stockItemId ?? ''}
            onChange={(e) => {
              const v = e.currentTarget.value
              onChange(v === '' ? { stockItemId: null, stockQuantity: '' } : { stockItemId: Number(v), stockQuantity: item.stockQuantity || '1' })
            }}
          >
            <option value="">なし</option>
            {data.stockItems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.retired ? '(やめた品物)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="fld">
          <span>個数</span>
          <input inputMode="numeric" disabled={item.stockItemId === null} placeholder="—" value={item.stockQuantity} onChange={(e) => onChange({ stockQuantity: e.currentTarget.value })} />
        </label>
      </div>
      <div className="iacts">
        <button className="textbtn danger" type="button" onClick={props.onRemove}>
          この品目を消す
        </button>
        <button className="sbtn" type="button" onClick={props.onClose}>
          閉じる
        </button>
      </div>
    </div>
  )
}

function Adjustments(props: {
  items: AdjustmentDraft[]
  onChange: (k: string, p: Partial<AdjustmentDraft>) => void
  onAdd: () => void
  canAdd: boolean
  onRemove: (k: string) => void
  onClose: () => void
}) {
  return (
    <div className="adjedit" role="group" aria-label="レシート全体の値引き・外税">
      <p className="note">レシート全体にかかる値引きと外税(内税・ポイントで払った分は入れない)。値引きは「-」を付ける。</p>
      {props.items.map((a, n) => (
        <div key={a.key} className="adjrow" role="group" aria-label={`値引き・外税 ${n + 1}`}>
          <label className="fld">
            <span>種類</span>
            <select value={a.kind} onChange={(e) => props.onChange(a.key, { kind: e.currentTarget.value as 'tax' | 'discount' })}>
              <option value="tax">外税</option>
              <option value="discount">値引き</option>
            </select>
          </label>
          <label className="fld">
            <span>かかる品目</span>
            <select value={rateValue(a.taxRate)} onChange={(e) => props.onChange(a.key, { taxRate: rateOf(e.currentTarget.value) })}>
              <option value="">全部</option>
              <option value="8">8% の品目</option>
              <option value="10">10% の品目</option>
              <option value="0">0% の品目</option>
            </select>
          </label>
          <label className="fld">
            <span>額</span>
            <input inputMode="numeric" value={a.amount} onChange={(e) => props.onChange(a.key, { amount: e.currentTarget.value })} />
          </label>
          <button className="iconbtn" type="button" aria-label={`値引き・外税 ${n + 1} を消す`} onClick={() => props.onRemove(a.key)}>
            <Icon name="close" size={18} />
          </button>
        </div>
      ))}
      <div className="iacts">
        <button className="textbtn" type="button" disabled={!props.canAdd} onClick={props.onAdd}>
          + 足す
        </button>
        <button className="sbtn" type="button" onClick={props.onClose}>
          閉じる
        </button>
      </div>
    </div>
  )
}

/** レシートの写真。押すと小窓で大きく見る */
function Photos({ receiptId, count, text, children }: { receiptId: number; count: number; text: string; children?: ReactNode }) {
  const [shown, setShown] = useState<number | null>(null)
  return (
    <div className="photos">
      {Array.from({ length: count }, (_, i) => (
        <button key={i} className="thumbbtn" type="button" aria-label={`レシートの写真 ${i + 1} 枚目を大きく見る`} onClick={() => setShown(i + 1)}>
          <img className="thumb-lg" src={`/api/receipts/${receiptId}/images/${i + 1}`} alt="" />
        </button>
      ))}
      <div className="ptext">
        <p>{text}</p>
        {children}
      </div>
      <Viewer src={shown === null ? null : `/api/receipts/${receiptId}/images/${shown}`} label={`レシートの写真 ${shown ?? ''} 枚目`} onClose={() => setShown(null)} />
    </div>
  )
}

function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return ref
}

function Viewer({ src, label, onClose }: { src: string | null; label: string; onClose: () => void }) {
  const ref = useModal(src !== null)
  return (
    <dialog ref={ref} className="viewer" aria-label={label} onClose={onClose}>
      {src && <img src={src} alt={label} />}
      <button className="iconbtn" type="button" aria-label="閉じる" autoFocus onClick={onClose}>
        <Icon name="close" />
      </button>
    </dialog>
  )
}

function Confirm(props: { open: boolean; title: string; body: string; action: string; busy: boolean; onAction: () => void; onClose: () => void }) {
  const ref = useModal(props.open)
  const titleId = useId()
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (props.open) keep.current?.focus()
  }, [props.open])
  return (
    <dialog ref={ref} className="sheet" aria-labelledby={titleId} onClose={props.onClose}>
      <h2 id={titleId}>{props.title}</h2>
      <p className="note">{props.body}</p>
      <div className="sheet-actions">
        <button ref={keep} className="sbtn" type="button" onClick={props.onClose}>
          やめる
        </button>
        <button className="pbtn dangerfill" type="button" disabled={props.busy} onClick={props.onAction}>
          {props.action}
        </button>
      </div>
    </dialog>
  )
}
