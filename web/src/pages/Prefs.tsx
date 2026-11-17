// 費目と月の予算(見本はモック 14 版の prefs)。正本: データと照合 §1.3・§1.4・§4.11
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Screen, TopBar } from '../components/Shell'
import { ApiError } from '../lib/api'
import { currentMonth, yen } from '../lib/format'
import { api, refetchAfterSave, useApiQuery } from '../lib/query'
import { budgetTotal, KINDS, kindLabel, moveId, parseBudget, type PrefCategory, type PrefsResponse } from '../lib/prefs'

/** 予算・費目が変わると古くなる画面(ホーム・推移・総計・一覧・確かめて保存) */
const refetchAll = () =>
  refetchAfterSave({
    predicate: (q) => {
      const k = String(q.queryKey[0])
      return k.startsWith('/api/prefs') || k.startsWith('/api/home') || k.startsWith('/api/summary') || k.startsWith('/api/expenses') || k.startsWith('/api/expense-form')
    },
  })

function errorText(e: unknown) {
  if (!(e instanceof ApiError) || e.status === null) return '通信できませんでした。通信のある所でもう一度入れてください。'
  if (e.code === 'duplicate_name') return '同じ名前の費目があります。'
  if (e.code === 'system_category') return 'この費目はやめられません(未分類か、自動の規則が使っています)。'
  if (e.code === 'budget_not_variable') return 'この費目は固定費か臨時になったので、予算を入れられません。読み直してください。'
  if (e.code === 'used_by_recurring') return '毎月決まった支出がこの費目を使っています。先に設定の「毎月決まった支出」で止めるか、費目を変えてください。'
  return '保存できませんでした。もう一度入れてください。'
}

export function Prefs() {
  const month = currentMonth()
  const path = `/api/prefs?month=${month}`
  const q = useApiQuery<PrefsResponse>(path)
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'add' | 'edit' | null>(null)

  // 入力欄を離れたら保存。押した時点で計を変え、失敗したら戻して知らせる(基盤 §2.3)
  const save = useMutation({
    // 続けて直しても、口へは直した順に 1 つずつ送る(前の額が後から書かれないように)
    scope: { id: 'budget' },
    mutationFn: ({ id, amount }: { id: number; amount: number | null }) =>
      api.request('/api/budgets', { method: 'PUT', json: { categoryId: id, fromMonth: month, amount } }),
    onMutate: async ({ id, amount }) => {
      setError(null)
      await qc.cancelQueries({ queryKey: [path] })
      const before = qc.getQueryData<PrefsResponse>([path])
      if (before) qc.setQueryData<PrefsResponse>([path], { ...before, categories: before.categories.map((c) => (c.id === id ? { ...c, budget: amount } : c)) })
      return { before }
    },
    onError: (e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData([path], ctx.before)
      setError(errorText(e))
    },
    onSettled: refetchAll,
  })

  // 並びを変える。押した時点で並べ替え、失敗したら戻して知らせる(基盤 §2.3)
  const order = useMutation({
    // 続けて押しても、口へは押した順に 1 つずつ送る(古い並びが後から書かれないように)。画面はすぐ並べ替える
    scope: { id: 'category-order' },
    mutationFn: (ids: number[]) => api.request('/api/categories/order', { method: 'PUT', json: { ids } }),
    onMutate: async (ids) => {
      setError(null)
      await qc.cancelQueries({ queryKey: [path] })
      const before = qc.getQueryData<PrefsResponse>([path])
      if (before) {
        const byId = new Map(before.categories.map((c) => [c.id, c]))
        qc.setQueryData<PrefsResponse>([path], { ...before, categories: ids.map((id) => byId.get(id)!) })
      }
      return { before }
    },
    onError: (e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData([path], ctx.before)
      setError(e instanceof ApiError && e.code === 'order_mismatch' ? '費目が変わっていました。読み直したので、もう一度動かしてください。' : errorText(e))
    },
    onSettled: refetchAll,
  })
  const move = (id: number, dir: -1 | 1) => {
    const ids = q.data?.categories.map((c) => c.id) ?? []
    const next = moveId(ids, id, dir)
    if (next !== ids) order.mutate(next)
  }

  const onBlur = (c: PrefCategory, value: string) => {
    const amount = parseBudget(value)
    if (amount === undefined) return setError(`${c.name}: 予算は 0 以上の数で入れてください(空なら予算なし)。`)
    if (amount !== c.budget) save.mutate({ id: c.id, amount })
  }

  const live = q.data?.categories.filter((c) => !c.retired) ?? []
  const total = budgetTotal(live)
  return (
    <Screen label="費目と月の予算" tabs={false} top={<TopBar title="費目と月の予算" left={{ kind: 'back', to: '/settings', label: '設定に戻る' }} />}>
      {error && (
        <div className="errline" role="alert">
          <span>{error}</span>
          <button className="textbtn" type="button" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}
      {q.data ? (
        <section className="panel" aria-label="月の予算">
          <p className="note pad top">入力欄を離れると保存し、今月({Number(month.slice(5, 7))}月)から効きます。前の月は当時の予算のまま。</p>
          <h2>
            <span>毎月変わる費目の計</span>
            <span className="num">{yen(total)}</span>
          </h2>
          <ul className="plain sgrid">
            {live.map((c) =>
              c.systemRole === 'uncategorized' ? (
                <li key={c.id} className="scard fixed">
                  <span className="slabel">{c.name}</span>
                  <span className="sub">消せない・予算なし</span>
                </li>
              ) : c.kind !== 'variable' ? (
                // 固定費・臨時は予算を持たない(額が決まっている・一度きりなので比べない。§4.11)
                <li key={c.id} className="scard fixed">
                  <span className="slabel">
                    {c.name}
                    <span className="fxtag">{kindLabel(c.kind)}</span>
                  </span>
                  <span className="sub">予算なし</span>
                </li>
              ) : (
                <li key={c.id} className="scard">
                  <label htmlFor={`bud-${c.id}`} className="slabel">
                    {c.name}
                  </label>
                  <span className="yen">
                    <span aria-hidden="true">¥</span>
                    {/* key: 保存の失敗で戻したとき・読み直したときに入力欄を今の額から作り直す */}
                    <input
                      key={`${c.id}:${c.budget}`}
                      id={`bud-${c.id}`}
                      inputMode="numeric"
                      defaultValue={c.budget === null ? '' : c.budget.toLocaleString('en-US')}
                      placeholder="なし"
                      onBlur={(e) => onBlur(c, e.currentTarget.value)}
                    />
                  </span>
                </li>
              ),
            )}
          </ul>
          <div className="row2 pad">
            <button className="sbtn" type="button" onClick={() => setDialog('add')}>
              + 費目を足す
            </button>
            <button className="sbtn" type="button" onClick={() => setDialog('edit')}>
              費目を直す
            </button>
          </div>
        </section>
      ) : (
        <p className="note">{q.isError ? '読み込めませんでした。通信のある所で開き直してください。' : '読み込み中…'}</p>
      )}
      <CategoryDialog mode={dialog} categories={q.data?.categories ?? []} onClose={() => setDialog(null)} onMove={move} error={dialog === 'edit' ? error : null} />
    </Screen>
  )
}

/** 費目を足す・直す小窓。口が断る誤り(名前の重なり・やめられない費目)を中に出すので、応答を待って閉じる */
function CategoryDialog({
  mode,
  categories,
  onClose,
  onMove,
  error: moveError,
}: {
  mode: 'add' | 'edit' | null
  categories: PrefCategory[]
  onClose: () => void
  onMove: (id: number, dir: -1 | 1) => void
  error: string | null
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [picked, setPicked] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [moved, setMoved] = useState<{ id: number; dir: -1 | 1 } | null>(null)
  const [status, setStatus] = useState('')
  const listRef = useRef<HTMLUListElement>(null)
  // 並べ替えで行が動いても、押したボタンにフォーカスを残す(端に着いて押せなくなったら逆向きのボタンへ)
  useEffect(() => {
    if (!moved) return
    const find = (dir: number) => listRef.current?.querySelector<HTMLButtonElement>(`button[data-move="${moved.id}:${dir}"]:not(:disabled)`)
    ;(find(moved.dir) ?? find(-moved.dir))?.focus()
  }, [moved, categories])
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (mode !== null && !d.open) d.showModal()
    if (mode === null && d.open) d.close()
  }, [mode])
  const close = () => {
    setMoved(null)
    setStatus('')
    setPicked(null)
    setError(null)
    onClose()
  }
  const send = useMutation({
    mutationFn: (b: { id: number | null; body: Record<string, unknown> }) =>
      b.id === null ? api.request('/api/categories', { method: 'POST', json: b.body }) : api.request(`/api/categories/${b.id}`, { method: 'PATCH', json: b.body }),
    onMutate: () => setError(null),
    onSuccess: close,
    onError: (e) => setError(errorText(e)),
    onSettled: refetchAll,
  })
  const target = categories.find((c) => c.id === picked) ?? null

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    send.mutate({ id: target?.id ?? null, body: { name: String(f.get('name')).trim(), kind: String(f.get('kind')) } })
  }

  return (
    <dialog ref={ref} className="sheet" aria-labelledby={titleId} onClose={close}>
      <p role="status" className="visually-hidden">
        {status}
      </p>
      {mode === 'edit' && target === null ? (
        <>
          <h2 id={titleId}>直す費目を選ぶ</h2>
          <p className="note">↑↓ で並びを変えます(ホーム・推移・総計・費目を選ぶ欄がこの順になります)。</p>
          {moveError && (
            <p className="ferr" role="alert">
              {moveError}
            </p>
          )}
          <ul className="plain picklist" ref={listRef}>
            {categories.map((c, i) => (
              <li key={c.id} className="pickline">
                <button className="pickrow cat" type="button" onClick={() => setPicked(c.id)}>
                  <span className="pname">{c.name}</span>
                  <span className="faint">
                    {kindLabel(c.kind)}
                    {c.retired ? ' · やめた' : ''}
                  </span>
                </button>
                {([-1, 1] as const).map((dir) => (
                  <button
                    key={dir}
                    className="iconbtn"
                    type="button"
                    data-move={`${c.id}:${dir}`}
                    aria-label={`${c.name}を${dir < 0 ? '上' : '下'}へ`}
                    disabled={dir < 0 ? i === 0 : i === categories.length - 1}
                    onClick={() => {
                      onMove(c.id, dir)
                      setMoved({ id: c.id, dir })
                      setStatus(`${c.name}を ${i + 1 + dir} 番目にしました`)
                    }}
                  >
                    <span aria-hidden="true">{dir < 0 ? '↑' : '↓'}</span>
                  </button>
                ))}
              </li>
            ))}
          </ul>
          <div className="sheet-actions one">
            <button className="sbtn" type="button" onClick={close}>
              やめる
            </button>
          </div>
        </>
      ) : mode !== null ? (
        <form key={target?.id ?? 'new'} onSubmit={submit}>
          <h2 id={titleId}>{target ? `「${target.name}」を直す` : '費目を足す'}</h2>
          <label className="fld">
            <span>名前</span>
            <input name="name" required maxLength={30} defaultValue={target?.name ?? ''} autoComplete="off" />
          </label>
          <label className="fld">
            <span>種類</span>
            <select name="kind" defaultValue={target?.kind ?? 'variable'}>
              {KINDS.map((k) => (
                <option key={k.code} value={k.code}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <p className="note">毎月変わる費目はホームの合計と円グラフに、固定費は合計の 1 行に、臨時は総計の画面に出ます。</p>
          {error && (
            <p className="ferr" role="alert">
              {error}
            </p>
          )}
          {target && target.systemRole === null && (
            <button
              className="sbtn"
              type="button"
              disabled={send.isPending}
              onClick={() => send.mutate({ id: target.id, body: { retired: !target.retired } })}
            >
              {target.retired ? 'この費目を戻す' : 'この費目をやめる(今までの支出の費目は残る)'}
            </button>
          )}
          <div className="sheet-actions">
            <button className="sbtn" type="button" onClick={close}>
              やめる
            </button>
            <button className="pbtn" type="submit" disabled={send.isPending}>
              {send.isPending ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      ) : null}
    </dialog>
  )
}
