// レシートの口: 置く順・送り直し・表 R・読み取りの回(§1.7・§2.1・表 R)
import { env } from 'cloudflare:workers'
import { APICallError } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { models } from '../worker/ai/model'
import { readDisplay } from '../worker/routes/receipts'
import { accessToken, addUser, request, serveTestCerts } from './helpers'

type Gen = ConstructorParameters<typeof MockLanguageModelV4>[0] extends infer O
  ? O extends { doGenerate?: infer G }
    ? G
    : never
  : never
const ai = { doGenerate: undefined as unknown }

const goodRead = {
  storeName: 'テストストア',
  purchasedOn: '2026-11-10',
  paymentMethod: 'rakuten_card',
  items: [{ name: '牛乳', baseAmount: 200, taxRate: 8, categoryId: 1 }],
  adjustments: [{ kind: 'tax', amount: 16, taxRate: 8 }],
  printedTotal: 216,
}

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    },
    warnings: [],
  }
}

const jpeg = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'r.jpg', { type: 'image/jpeg' })
let token: string
let seq = 0

beforeEach(async () => {
  serveTestCerts()
  await addUser('alice@example.com', 'アリス')
  token = await accessToken()
  ai.doGenerate = textResult(JSON.stringify(goodRead))
  vi.spyOn(models, 'languageModel').mockImplementation(() => new MockLanguageModelV4({ doGenerate: ai.doGenerate as Gen }))
})
afterEach(() => vi.useRealTimers())

async function upload(files: File[] = [jpeg()], clientRequestId = `r-${++seq}`) {
  const form = new FormData()
  form.set('clientRequestId', clientRequestId)
  for (const f of files) form.append('images', f)
  return request('/api/receipts', { method: 'POST', headers: { 'cf-access-jwt-assertion': token }, body: form })
}
const auth = () => ({ 'cf-access-jwt-assertion': token })
const get = (path: string) => request(path, { headers: auth() })
const post = (path: string) => request(path, { method: 'POST', headers: auth() })

describe('画像を送る', () => {
  it('D1 に行が入り R2 に置かれ、stored_at が入る(読み取り待ち)', async () => {
    const res = await upload([jpeg(), jpeg()])
    expect(res.status).toBe(201)
    const { id } = await res.json<{ id: number }>()
    const body = await (await get(`/api/receipts/${id}`)).json<{ read: string; images: { stored: boolean }[] }>()
    expect(body.read).toBe('reading')
    expect(body.images).toEqual([
      { position: 1, stored: true },
      { position: 2, stored: true },
    ])
    const img = await get(`/api/receipts/${id}/images/1`)
    expect(img.status).toBe(200)
    expect(img.headers.get('cache-control')).toContain('private')
  })
  it('同じ送信の ID の送り直しは下書きを増やさない', async () => {
    const a = await (await upload([jpeg()], 'same')).json<{ id: number }>()
    const res = await upload([jpeg()], 'same')
    expect(res.status).toBe(200)
    expect((await res.json<{ id: number }>()).id).toBe(a.id)
    const { count } = (await env.DB.prepare("SELECT count(*) AS count FROM receipts WHERE client_request_id = 'same'").first<{ count: number }>())!
    expect(count).toBe(1)
  })
  it('JPEG 以外は受けない', async () => {
    const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    expect((await upload([png])).status).toBe(400)
  })
  it('画像が無い送信は受けない', async () => {
    expect((await upload([])).status).toBe(400)
  })
})

describe('表 R: 読み取りの状態の表示', () => {
  const at = '2026-11-15T00:00:00Z'
  const plus = (s: number) => new Date(Date.parse(at) + s * 1000)
  it('R1 waiting・ちょうど 5 分 → 読み取り中', () => expect(readDisplay('waiting', at, plus(300))).toBe('reading'))
  it('R2 waiting・5 分 1 秒 → 時間切れ', () => expect(readDisplay('waiting', at, plus(301))).toBe('timed_out'))
  it('R3 read → 読めた', () => expect(readDisplay('read', at, plus(9999))).toBe('read'))
  it('R4 failed → 読めなかった', () => expect(readDisplay('failed', at, plus(0))).toBe('failed'))
})

describe('読み取り', () => {
  it('型どおりの応答は読めたになり、結果が残る', async () => {
    const { id } = await (await upload()).json<{ id: number }>()
    const res = await post(`/api/receipts/${id}/read`)
    expect(res.status).toBe(200)
    const body = await res.json<{ read: string; result: typeof goodRead; model: string }>()
    expect(body.read).toBe('read')
    expect(body.result.items[0].name).toBe('牛乳')
    expect(body.model).toBe('anthropic/claude-haiku-5-5')
  })
  it('読めたものはもう一度読まない', async () => {
    const { id } = await (await upload()).json<{ id: number }>()
    await post(`/api/receipts/${id}/read`)
    expect((await post(`/api/receipts/${id}/read`)).status).toBe(409)
  })
  it('型に合わない応答は読めなかった(invalid_output)', async () => {
    ai.doGenerate = textResult('{"nope":1}')
    const { id } = await (await upload()).json<{ id: number }>()
    const body = await (await post(`/api/receipts/${id}/read`)).json<{ read: string; errorKind: string }>()
    expect(body).toMatchObject({ read: 'failed', errorKind: 'invalid_output' })
  })
  it('一覧に無い費目を選んだ応答は読めなかった(invalid_output)', async () => {
    ai.doGenerate = textResult(JSON.stringify({ ...goodRead, items: [{ ...goodRead.items[0], categoryId: 999 }] }))
    const { id } = await (await upload()).json<{ id: number }>()
    const body = await (await post(`/api/receipts/${id}/read`)).json<{ errorKind: string }>()
    expect(body.errorKind).toBe('invalid_output')
  })
  it('429 はクレジット切れ(quota)', async () => {
    ai.doGenerate = async () => {
      throw new APICallError({ message: 'rate', url: 'x', requestBodyValues: {}, statusCode: 429, isRetryable: false })
    }
    const { id } = await (await upload()).json<{ id: number }>()
    const body = await (await post(`/api/receipts/${id}/read`)).json<{ errorKind: string }>()
    expect(body.errorKind).toBe('quota')
  })
  it('読めなかったものは読み直すと回が 1 増える', async () => {
    ai.doGenerate = textResult('broken')
    const { id } = await (await upload()).json<{ id: number }>()
    await post(`/api/receipts/${id}/read`)
    ai.doGenerate = textResult(JSON.stringify(goodRead))
    const body = await (await post(`/api/receipts/${id}/read`)).json<{ read: string }>()
    expect(body.read).toBe('read')
    const row = await env.DB.prepare('SELECT ai_attempt FROM receipts WHERE id = ?').bind(id).first<{ ai_attempt: number }>()
    expect(row!.ai_attempt).toBe(2)
  })
  it('前の回の遅れた応答は書かない', async () => {
    const { id } = await (await upload()).json<{ id: number }>()
    // 回 1 の読み取り中に、別の人が時間切れの後で読み直して回 2 にした状態を作る
    await env.DB.prepare("UPDATE receipts SET ai_attempt = 2 WHERE id = ?").bind(id).run()
    await env.DB.prepare(
      "UPDATE receipts SET ai_status = 'read', ai_result = '{}' WHERE id = ? AND ai_attempt = 1 AND ai_status = 'waiting'",
    ).bind(id).run()
    const row = await env.DB.prepare('SELECT ai_status FROM receipts WHERE id = ?').bind(id).first<{ ai_status: string }>()
    expect(row!.ai_status).toBe('waiting')
  })
})

describe('下書きを捨てる', () => {
  it('R2 の画像と行が消える', async () => {
    const { id } = await (await upload()).json<{ id: number }>()
    const key = (await env.DB.prepare('SELECT r2_key FROM receipt_images WHERE receipt_id = ?').bind(id).first<{ r2_key: string }>())!.r2_key
    const res = await request(`/api/receipts/${id}`, { method: 'DELETE', headers: auth() })
    expect(res.status).toBe(204)
    expect(await env.RECEIPTS.get(key)).toBeNull()
    expect((await get(`/api/receipts/${id}`)).status).toBe(404)
  })
})

describe('下書きの一覧(撮る画面。データと照合 §4.6)', () => {
  type Draft = { id: number; read: string; storeName: string | null; printedTotal: number | null; imageCount: number }
  const drafts = async () => (await (await get('/api/receipts')).json<{ drafts: Draft[] }>()).drafts
  it('読めた下書きは店名・印字の合計・写真の枚数を添え、読み取り中は店名と合計が null', async () => {
    const a = (await (await upload([jpeg(), jpeg()])).json<{ id: number }>()).id
    const b = (await (await upload([jpeg()])).json<{ id: number }>()).id
    expect((await post(`/api/receipts/${a}/read`)).status).toBe(200)
    const list = await drafts()
    expect(list.find((d) => d.id === a)).toMatchObject({ read: 'read', storeName: 'テストストア', printedTotal: 216, imageCount: 2 })
    expect(list.find((d) => d.id === b)).toMatchObject({ read: 'reading', storeName: null, printedTotal: null, imageCount: 1 })
  })
  it('店名が空文字(読めなかった)なら null', async () => {
    ai.doGenerate = textResult(JSON.stringify({ ...goodRead, storeName: '', printedTotal: null }))
    const id = (await (await upload()).json<{ id: number }>()).id
    await post(`/api/receipts/${id}/read`)
    expect((await drafts()).find((d) => d.id === id)).toMatchObject({ read: 'read', storeName: null, printedTotal: null })
  })
})
