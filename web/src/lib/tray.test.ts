import { describe, expect, it } from 'vitest'
import { fitSize } from './photo'
import { canContinue, groupPhotos, MAX_PHOTOS_PER_RECEIPT, requestIdOf, type TrayPhoto } from './tray'
import { whenLabel } from './format'

const photo = (id: string, cont = false): TrayPhoto => ({ id, blob: new Blob(), cont })
const ids = (g: TrayPhoto[][]) => g.map((x) => x.map((p) => p.id))

describe('写真をレシートに分ける', () => {
  it('1 枚ずつ別のレシート。続きの印は前のレシートの次の画像', () => {
    expect(ids(groupPhotos([photo('a'), photo('b', true), photo('c'), photo('d', true), photo('e', true)]))).toEqual([['a', 'b'], ['c', 'd', 'e']])
    expect(ids(groupPhotos([photo('a'), photo('b')]))).toEqual([['a'], ['b']])
  })
  it('先頭の写真は印があっても新しいレシート(先頭を消して印の付いた写真が先頭になったとき)', () => {
    expect(ids(groupPhotos([photo('b', true), photo('c')]))).toEqual([['b'], ['c']])
  })
  it('写真が無ければレシートも無い', () => {
    expect(groupPhotos([])).toEqual([])
  })
  it('「前の続き」は 1 枚のレシートが 10 枚(口の上限)までのときだけ付けられる', () => {
    const nine = [photo('a'), ...Array.from({ length: 8 }, (_, i) => photo(`c${i}`, true))]
    expect(canContinue([...nine, photo('j')], 'j')).toBe(true) // 10 枚目
    const ten = [...nine, photo('j', true)]
    expect(canContinue([...ten, photo('k')], 'k')).toBe(false) // 11 枚目
    expect(canContinue([...ten, photo('k'), photo('l', true)], 'l')).toBe(true) // 別のレシートの 2 枚目
    expect(MAX_PHOTOS_PER_RECEIPT).toBe(10)
  })
})

describe('送信の ID', () => {
  it('同じ並びは同じ ID、並びや組み合わせが変われば別の ID。口の上限 100 文字以内', async () => {
    const a = await requestIdOf([photo('x'), photo('y')])
    expect(await requestIdOf([photo('x'), photo('y')])).toBe(a)
    expect(await requestIdOf([photo('y'), photo('x')])).not.toBe(a)
    expect(await requestIdOf([photo('x')])).not.toBe(a)
    expect(a.length).toBeLessThanOrEqual(100)
  })
})

describe('写真の大きさ', () => {
  it('長辺を 2,000px にそろえ、縦横比を保つ。小さい写真は大きくしない', () => {
    expect(fitSize(4032, 3024)).toEqual({ width: 2000, height: 1500 })
    expect(fitSize(3024, 4032)).toEqual({ width: 1500, height: 2000 })
    expect(fitSize(2000, 500)).toEqual({ width: 2000, height: 500 })
    expect(fitSize(1200, 900)).toEqual({ width: 1200, height: 900 })
  })
})

describe('撮った時刻', () => {
  const now = new Date('2026-11-16T10:00:00Z') // 日本時間 19:00
  it('今日・昨日・それより前(日本時間で数える)', () => {
    expect(whenLabel('2026-11-16T09:42:00Z', now)).toBe('今日 18:42')
    expect(whenLabel('2026-11-15T03:10:00Z', now)).toBe('昨日 12:10')
    expect(whenLabel('2026-11-12T09:42:00Z', now)).toBe('11/12 18:42')
    expect(whenLabel('2026-11-15T15:30:00Z', now)).toBe('今日 00:30')
  })
})
