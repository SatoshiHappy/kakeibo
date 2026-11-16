// 撮る(見本はモック 14 版の capture)。正本: データと照合 §2.1 の前置き・§4.6・表 R
import { useRef, useState, type ChangeEvent } from 'react'
import { Link } from 'react-router'
import { Icon } from '../components/Icon'
import { Screen, TopBar } from '../components/Shell'
import { ApiError } from '../lib/api'
import { whenLabel, yen } from '../lib/format'
import { useApiQuery } from '../lib/query'
import { canContinue, groupPhotos, MAX_PHOTOS_PER_RECEIPT, type TrayPhoto } from '../lib/tray'
import { addPhotos, photoUrl, removePhoto, sendTray, setContinued, TooManyPhotos, useTray } from '../lib/trayStore'

type Draft = {
  id: number
  uploadedAt: string
  read: 'reading' | 'timed_out' | 'read' | 'failed'
  storeName: string | null
  printedTotal: number | null
  imageCount: number
}

export function Capture() {
  const camera = useRef<HTMLInputElement>(null)
  const library = useRef<HTMLInputElement>(null)
  const tray = useTray()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files ?? [])
    e.currentTarget.value = '' // 同じ写真を続けて選んでも change が出るように
    if (files.length === 0) return
    setError(null)
    setBusy('写真を縮めています…')
    try {
      await addPhotos(files)
    } catch (err) {
      console.error(err)
      setError('写真を読み込めませんでした。撮り直すか、別の写真を選んでください。')
    } finally {
      setBusy(null)
    }
  }

  const onSend = async () => {
    setError(null)
    try {
      await sendTray((done, total) => setBusy(`送っています…(${done} / ${total})`))
    } catch (err) {
      console.error(err)
      setError(
        err instanceof TooManyPhotos
          ? `1 枚のレシートの写真は ${MAX_PHOTOS_PER_RECEIPT} 枚までです。「前の続き」を外して分けてください。`
          : err instanceof ApiError && err.status !== null
          ? '送れませんでした。残った写真をもう一度送ってください。'
          : '通信できませんでした。残った写真は通信のある所でもう一度送ってください。',
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <Screen label="撮る" tabs top={<TopBar title="レシートを撮る" left={{ kind: 'menu' }} />}>
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={onPick} />
      <input ref={library} type="file" accept="image/*" multiple hidden onChange={onPick} />
      <button className="cta" type="button" disabled={busy !== null} onClick={() => camera.current?.click()}>
        <Icon name="camera" size={24} />
        <span className="lines">
          <b>レシートを撮る</b>
          <span className="sub">長いレシートは続けて何枚でも</span>
        </span>
      </button>
      <div className="row2">
        <button className="sbtn" type="button" disabled={busy !== null} onClick={() => library.current?.click()}>
          <Icon name="image" />
          写真から選ぶ
        </button>
        <Link className="sbtn" to="/expenses/new">
          <Icon name="pencil" />
          手で入力
        </Link>
      </div>
      {busy && (
        <p className="note" role="status">
          {busy}
        </p>
      )}
      {error && (
        <div className="errline" role="alert">
          <span>{error}</span>
          <button className="textbtn" type="button" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}
      {tray.photos.length > 0 && <TrayPanel photos={tray.photos} disabled={busy !== null} onSend={onSend} />}
      <Drafts />
      <p className="note">写真は「送る」までこの iPhone の中だけにあります。読めなくても、手で入力して支出にできます。</p>
    </Screen>
  )
}

/** 送る前の写真。1 枚ずつ別のレシート、「前の続き」で前のレシートにつなぐ */
function TrayPanel({ photos, disabled, onSend }: { photos: TrayPhoto[]; disabled: boolean; onSend: () => void }) {
  const groups = groupPhotos(photos)
  const receiptNo = new Map(groups.flatMap((g, i) => g.map((p) => [p.id, i + 1] as const)))
  return (
    <section className="panel tray" aria-labelledby="tray-title">
      <h2 id="tray-title">
        <span>送る前の写真({photos.length})</span>
        <span className="faint">レシート {groups.length} 枚</span>
      </h2>
      <ul className="plain tgrid">
        {photos.map((p, i) => {
          const no = receiptNo.get(p.id)!
          const label = i > 0 && p.cont ? `レシート ${no} の続き` : `レシート ${no}`
          return (
            <li key={p.id} className="tphoto">
              <span className="tframe">
                <img className="thumb-lg" src={photoUrl(p)} alt={`${i + 1} 枚目の写真(${label})`} />
                <button className="tremove" type="button" disabled={disabled} aria-label={`${i + 1} 枚目の写真を消す`} onClick={() => void removePhoto(p.id)}>
                  <Icon name="close" size={16} />
                </button>
              </span>
              <span className="tlabel">{label}</span>
              {i > 0 && (
                <label className="tcont">
                  <input
                    type="checkbox"
                    checked={p.cont}
                    disabled={disabled || (!p.cont && !canContinue(photos, p.id))}
                    onChange={(e) => void setContinued(p.id, e.currentTarget.checked)}
                  />
                  前の続き
                </label>
              )}
            </li>
          )
        })}
      </ul>
      {groups.some((g) => g.length >= MAX_PHOTOS_PER_RECEIPT) && <p className="note">1 枚のレシートの写真は {MAX_PHOTOS_PER_RECEIPT} 枚までです。</p>}
      <button className="pbtn" type="button" disabled={disabled} onClick={onSend}>
        送る(レシート {groups.length} 枚)
      </button>
    </section>
  )
}

const POLL_MS = 5000

/** まだ支出にしていない下書き(§4.6)。読み取り中があれば 5 秒ごとに読み直す */
function Drafts() {
  const q = useApiQuery<{ drafts: Draft[] }>('/api/receipts', {
    refetchInterval: (query) => (query.state.data?.drafts.some((d) => d.read === 'reading') ? POLL_MS : false),
  })
  if (!q.data) return q.isError ? <p className="note">下書きを読み込めませんでした。</p> : null
  const drafts = q.data.drafts
  if (drafts.length === 0) return null
  return (
    <section aria-labelledby="drafts-title">
      <h2 className="sect" id="drafts-title">
        <span>まだ支出にしていない下書き({drafts.length})</span>
      </h2>
      <ul className="plain drafts">
        {drafts.map((d) => (
          <li key={d.id}>
            <DraftCard d={d} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function DraftCard({ d }: { d: Draft }) {
  const when = `${whenLabel(d.uploadedAt)}${d.imageCount > 1 ? ` · ${d.imageCount} 枚` : ''}`
  const img = <img className="thumb-lg" src={`/api/receipts/${d.id}/images/1`} alt="" loading="lazy" />
  if (d.read === 'reading')
    return (
      <div className="draft">
        {img}
        <span className="tag wait">読み取り中…</span>
        <span className="when">{when}</span>
      </div>
    )
  return (
    <Link className="draft" to={`/receipts/${d.id}`}>
      {img}
      {d.read === 'read' ? (
        <>
          <span className="tag ok">読めた・確かめる</span>
          <span className="dname">{d.storeName ?? '店名なし'}</span>
          {d.printedTotal !== null && <span className="num dname">{yen(d.printedTotal)}</span>}
        </>
      ) : (
        <>
          <span className="tag ng">{d.read === 'timed_out' ? '読めなかった(時間切れ)' : '読めなかった'}</span>
          <span className="dname">手で入力する</span>
        </>
      )}
      <span className="when">{when}</span>
    </Link>
  )
}
