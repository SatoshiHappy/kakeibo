// 401 の再読み込み(表 K の K2)の前に、縮めている途中の写真と端末への書き込みを待つ(基盤 §3.2)
import { describe, expect, it, vi } from 'vitest'

// 縮める・端末に書くを差し替え、終わる時を手で決める
let finishShrink: (b: Blob) => void = () => {}
let finishSet: (() => void) | null = null
const order: string[] = []
vi.mock('./photo', () => ({ shrinkToJpeg: () => new Promise<Blob>((r) => (finishShrink = r)) }))
vi.mock('idb-keyval', () => ({
  get: async () => undefined,
  set: () =>
    new Promise<void>((r) => {
      finishSet = () => {
        order.push('set')
        r()
      }
    }),
}))
const savers: (() => Promise<void>)[] = []
vi.mock('./query', () => ({
  api: { registerDraftSaver: (s: () => Promise<void>) => void savers.push(s), request: vi.fn() },
  refetchAfterSave: vi.fn(),
}))

const { addPhotos } = await import('./trayStore')

describe('撮った写真の下書きの保存', () => {
  it('K2 の下書きの保存は、縮め終えて端末に書き終わるまで待つ', async () => {
    expect(savers).toHaveLength(1)
    const adding = addPhotos([new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' })])
    const saving = savers[0]!().then(() => order.push('saved'))
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual([]) // まだ縮めている
    finishShrink(new Blob([new Uint8Array([2])], { type: 'image/jpeg' }))
    await vi.waitFor(() => expect(finishSet).not.toBeNull()) // 端末への書き込みが始まった
    expect(order).toEqual([]) // まだ書き終わっていないので、下書きの保存も終わらない
    finishSet!()
    await saving
    await adding
    expect(order).toEqual(['set', 'saved'])
  })
})
