// 明細の取り込み(見本はモック 14 版の import)。正本: データと照合 表 C・§4.10
import { useMutation } from '@tanstack/react-query'
import { useId, useRef, useState, type ChangeEvent } from 'react'
import { Link } from 'react-router'
import { Icon } from '../components/Icon'
import { Screen, TopBar } from '../components/Shell'
import { ApiError } from '../lib/api'
import { jstToday, shortDate } from '../lib/format'
import { api, refetchAfterSave, useApiQuery } from '../lib/query'
import { billingLabel, importErrorText, resultLines, type ImportResult } from '../lib/statementImport'

const PATH = '/api/statements'

export function Import() {
  const input = useRef<HTMLInputElement>(null)
  const helpId = useId()
  const [help, setHelp] = useState(false)
  const history = useApiQuery<{ imports: { billingMonth: string; rows: number; lastImportedAt: string }[] }>(PATH)
  const send = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.set('file', file)
      return api.request<ImportResult>(PATH, { method: 'POST', body: form })
    },
    // 取り込みで照合が変わるので、明細・支出・確かめる・ホームを読み直す
    onSettled: () =>
      refetchAfterSave({
        predicate: (q) => {
          const k = String(q.queryKey[0])
          return k === PATH || k === '/api/review' || k.startsWith('/api/home') || k.startsWith('/api/expenses')
        },
      }),
  })

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = '' // 同じファイルを続けて選んでも change が出るように
    if (file) send.mutate(file)
  }

  const right = (
    <button className="iconbtn" type="button" aria-label="CSV の出し方" aria-expanded={help} aria-controls={helpId} onClick={() => setHelp(!help)}>
      <Icon name="info" />
    </button>
  )
  const err = send.error
  return (
    <Screen label="明細の取り込み" tabs={false} top={<TopBar title="明細の取り込み" left={{ to: '/settings', label: '設定に戻る' }} right={right} />}>
      <section className="panel helpbox" id={helpId} hidden={!help} aria-label="CSV の出し方">
        <h2>
          <span>CSV の出し方(PC のブラウザ)</span>
        </h2>
        <ol className="steps">
          <li>楽天 e-NAVI の「ご利用明細」を開く</li>
          <li>請求月を選ぶ</li>
          <li>「明細コピー用 Excel(CSV)」を押す</li>
        </ol>
        <p className="note">アプリとスマホのブラウザでは PDF しか出ません。同じ月を何度取り込んでも二重になりません。過去の月(15 か月前まで)も同じ手順で 1 か月ずつ入れられます。</p>
        <p className="note">取り込めないときは理由が出て、何も書き込まずに止まります。</p>
      </section>
      <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={onPick} />
      <button className="drop" type="button" disabled={send.isPending} onClick={() => input.current?.click()}>
        <Icon name="upload" />
        {send.isPending ? '取り込んでいます…' : 'CSV ファイルを選ぶ'}
      </button>
      {err && (
        <p className="ferrs" role="alert">
          {err instanceof ApiError && err.status !== null
            ? importErrorText(err.code, typeof err.body?.check === 'string' ? err.body.check : undefined)
            : '通信できませんでした。通信のある所でもう一度選んでください。'}
        </p>
      )}
      {send.data && <Result r={send.data} />}
      <section className="panel" aria-labelledby={`${helpId}-h`}>
        <h2 id={`${helpId}-h`}>
          <span>取り込み済み</span>
        </h2>
        {history.data ? (
          history.data.imports.length === 0 ? (
            <p className="note pad">まだありません。</p>
          ) : (
            <ul className="plain">
              {history.data.imports.map((i) => (
                <li key={i.billingMonth} className="lrow">
                  <span>{billingLabel(i.billingMonth)}</span>
                  <span className="faint num">
                    {i.rows} 行 · {shortDate(jstToday(new Date(i.lastImportedAt)))}
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="note pad">{history.isError ? '読み込めませんでした。' : '読み込み中…'}</p>
        )}
      </section>
    </Screen>
  )
}

function Result({ r }: { r: ImportResult }) {
  return (
    <section className="panel" aria-label="取り込みの結果" role="status">
      <div className="okline">
        <Icon name="ok" />
        {billingLabel(r.billingMonth)}を取り込みました
      </div>
      <dl className="kv num">
        {resultLines(r).map((l) => (
          <div key={l.label} className={l.indent ? 'in' : undefined}>
            <dt>{l.label}</dt>
            <dd className={l.warn ? 'warn' : undefined}>{l.value}</dd>
          </div>
        ))}
      </dl>
      {r.reviewCount > 0 && (
        <div className="pad">
          <Link className="softbtn wide" to="/review">
            要確認({r.reviewCount})へ
          </Link>
        </div>
      )}
    </section>
  )
}
