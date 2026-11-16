// 送る前の写真の並びを IndexedDB(idb-keyval)に置き、画面に配る。送る処理もここ(データと照合 §2.1 の前置き)
import { useSyncExternalStore } from 'react'
import { get, set } from 'idb-keyval'
import { shrinkToJpeg } from './photo'
import { api, refetchAfterSave } from './query'
import { groupPhotos, requestIdOf, type TrayPhoto } from './tray'

const KEY = 'kakeibo-tray'

type State = { loaded: boolean; photos: TrayPhoto[] }
let state: State = { loaded: false, photos: [] }
const listeners = new Set<() => void>()
// 書き込みは出た順に 1 つずつ(後の並びが先の並びに上書きされないように)
let writing: Promise<unknown> = Promise.resolve()

// 小さい写真の表示に使う URL。写真が並びから外れたら放す
const urls = new Map<string, string>()
export function photoUrl(p: TrayPhoto): string {
  let u = urls.get(p.id)
  if (!u) urls.set(p.id, (u = URL.createObjectURL(p.blob)))
  return u
}

function update(photos: TrayPhoto[]) {
  const live = new Set(photos.map((p) => p.id))
  for (const [id, u] of urls) {
    if (live.has(id)) continue
    URL.revokeObjectURL(u)
    urls.delete(id)
  }
  state = { loaded: true, photos }
  listeners.forEach((l) => l())
  // 失敗はこの呼び出しに返し、次の書き込みは続ける
  const next = writing.then(() => persist(photos))
  writing = next.catch(() => undefined)
  return next
}

/** 端末に置く形。Blob のままだと WebKit の使い捨ての環境(プライベートの閲覧など)で IndexedDB に入らないので、バイト列にする */
type StoredPhoto = { id: string; jpeg: ArrayBuffer; cont: boolean }

async function persist(photos: TrayPhoto[]) {
  const stored: StoredPhoto[] = await Promise.all(photos.map(async (p) => ({ id: p.id, jpeg: await p.blob.arrayBuffer(), cont: p.cont })))
  await set(KEY, stored)
}

let loading: Promise<void> | null = null
function load() {
  loading ??= get<StoredPhoto[]>(KEY).then((stored) => {
    state = { loaded: true, photos: (stored ?? []).map((p) => ({ id: p.id, blob: new Blob([p.jpeg], { type: 'image/jpeg' }), cont: p.cont })) }
    listeners.forEach((l) => l())
  })
  return loading
}

function subscribe(l: () => void) {
  listeners.add(l)
  void load()
  return () => void listeners.delete(l)
}

export function useTray(): State {
  return useSyncExternalStore(subscribe, () => state)
}

/** 撮った・選んだ写真を縮めて並びの末尾に足す */
export async function addPhotos(files: File[]) {
  await load()
  const added: TrayPhoto[] = []
  for (const f of files) added.push({ id: crypto.randomUUID(), blob: await shrinkToJpeg(f), cont: false })
  await update([...state.photos, ...added])
}

export const removePhoto = (id: string) => update(state.photos.filter((p) => p.id !== id))
export const setContinued = (id: string, cont: boolean) => update(state.photos.map((p) => (p.id === id ? { ...p, cont } : p)))

const refetchDrafts = () => refetchAfterSave({ predicate: (q) => q.queryKey[0] === '/api/receipts' || String(q.queryKey[0]).startsWith('/api/home') })

/**
 * 並びの写真をレシートごとに送る。送れたレシートの写真は並びから消し、読み取りを頼む(応答は待たない)。
 * 1 枚でも送れなければそこで止めて投げる(残りは並びに残る)
 */
export async function sendTray(onProgress: (done: number, total: number) => void) {
  const groups = groupPhotos(state.photos)
  onProgress(0, groups.length)
  for (const [n, group] of groups.entries()) {
    const form = new FormData()
    form.set('clientRequestId', await requestIdOf(group))
    group.forEach((p, i) => form.append('images', new File([p.blob], `${i + 1}.jpg`, { type: 'image/jpeg' })))
    const { id } = await api.request<{ id: number }>('/api/receipts', { method: 'POST', body: form })
    const sent = new Set(group.map((p) => p.id))
    await update(state.photos.filter((p) => !sent.has(p.id)))
    onProgress(n + 1, groups.length)
    void refetchDrafts()
    // 読み取りは裏で進める。失敗は口が下書きに残し(表 R)、一覧に「読めなかった」と出る
    api
      .request(`/api/receipts/${id}/read`, { method: 'POST' })
      .catch((e: unknown) => console.error('receipt_read_failed', id, e))
      .finally(() => void refetchDrafts())
  }
}
