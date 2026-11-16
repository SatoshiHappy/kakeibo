// レシート(下書き)の口。正本: docs/設計/データと照合.md §1.7・§2.1・表 R
import { Hono } from 'hono'
import { readReceipt } from '../ai/reader'
import { nowIso } from '../time'
import type { AppEnv } from '../types'

export const READ_TIMEOUT_SECONDS = 5 * 60
const MAX_IMAGES = 10
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // Claude API の 1 枚の上限(基盤 §4)

type ReceiptRow = {
  id: number
  uploaded_by: number
  uploaded_at: string
  first_saved_at: string | null
  ai_status: 'waiting' | 'read' | 'failed'
  ai_attempt: number
  ai_requested_at: string
  ai_result: string | null
  ai_error_kind: string | null
  ai_model: string | null
  expense_id: number | null
}

export type ReadDisplay = 'reading' | 'timed_out' | 'read' | 'failed'

/** 表 R: 読み取りの状態の表示。5 分以下は読み取り中、5 分を超えると時間切れ。 */
export function readDisplay(status: ReceiptRow['ai_status'], requestedAt: string, now: Date): ReadDisplay {
  if (status === 'read') return 'read'
  if (status === 'failed') return 'failed'
  const elapsed = (now.getTime() - Date.parse(requestedAt)) / 1000
  return elapsed > READ_TIMEOUT_SECONDS ? 'timed_out' : 'reading'
}

const RECEIPT_SELECT = `SELECT r.*, e.id AS expense_id FROM receipts r LEFT JOIN expenses e ON e.receipt_id = r.id`

async function loadReceipt(db: D1Database, id: number) {
  return db.prepare(`${RECEIPT_SELECT} WHERE r.id = ?`).bind(id).first<ReceiptRow>()
}

async function loadImages(db: D1Database, receiptId: number) {
  const { results } = await db
    .prepare('SELECT position, r2_key, stored_at FROM receipt_images WHERE receipt_id = ? ORDER BY position')
    .bind(receiptId)
    .all<{ position: number; r2_key: string; stored_at: string | null }>()
  return results
}

function present(row: ReceiptRow, images: { position: number; stored_at: string | null }[], now: Date) {
  return {
    id: row.id,
    uploadedAt: row.uploaded_at,
    read: readDisplay(row.ai_status, row.ai_requested_at, now),
    errorKind: row.ai_error_kind,
    result: row.ai_result ? JSON.parse(row.ai_result) : null,
    model: row.ai_model,
    expenseId: row.expense_id,
    images: images.map((i) => ({ position: i.position, stored: i.stored_at !== null })),
  }
}

export const receipts = new Hono<AppEnv>()

// 画像を送る: 先に D1 に行を入れ、次に R2 に置き、置けた画像ごとに stored_at を入れる(§1.7 の置く順)
receipts.post('/', async (c) => {
  const form = await c.req.formData()
  const clientRequestId = form.get('clientRequestId')
  const files = form.getAll('images').filter((f): f is File => f instanceof File)
  if (typeof clientRequestId !== 'string' || clientRequestId.length === 0 || clientRequestId.length > 100)
    return c.json({ error: 'invalid_request_id' }, 400)
  if (files.length === 0 || files.length > MAX_IMAGES) return c.json({ error: 'invalid_image_count' }, 400)
  if (files.some((f) => f.type !== 'image/jpeg')) return c.json({ error: 'jpeg_only' }, 400)
  if (files.some((f) => f.size === 0 || f.size > MAX_IMAGE_BYTES)) return c.json({ error: 'invalid_image_size' }, 400)

  const db = c.env.DB
  const user = c.get('user')
  const now = nowIso()
  const existing = await db
    .prepare('SELECT id FROM receipts WHERE client_request_id = ?')
    .bind(clientRequestId)
    .first<{ id: number }>()

  if (!existing) {
    const receiptRef = '(SELECT id FROM receipts WHERE client_request_id = ?)'
    await db.batch([
      db
        .prepare(
          `INSERT INTO receipts (client_request_id, uploaded_by, uploaded_at, ai_status, ai_attempt, ai_requested_at)
           VALUES (?, ?, ?, 'waiting', 1, ?)`,
        )
        .bind(clientRequestId, user.id, now, now),
      ...files.map((f, i) =>
        db
          .prepare(
            `INSERT INTO receipt_images (receipt_id, position, r2_key, byte_size, created_at)
             VALUES (${receiptRef}, ?, ?, ?, ?)`,
          )
          .bind(clientRequestId, i + 1, `receipts/${crypto.randomUUID()}.jpg`, f.size, now),
      ),
    ])
  }

  const receipt = await db
    .prepare('SELECT id FROM receipts WHERE client_request_id = ?')
    .bind(clientRequestId)
    .first<{ id: number }>()
  const images = await loadImages(db, receipt!.id)
  if (images.length !== files.length) return c.json({ error: 'image_count_mismatch' }, 409)

  // 送り直しのときは、まだ置けていない画像だけを置く
  for (const img of images) {
    if (img.stored_at !== null) continue
    const file = files[img.position - 1]
    await c.env.RECEIPTS.put(img.r2_key, await file.arrayBuffer(), { httpMetadata: { contentType: 'image/jpeg' } })
    await db
      .prepare('UPDATE receipt_images SET stored_at = ? WHERE receipt_id = ? AND position = ?')
      .bind(nowIso(), receipt!.id, img.position)
      .run()
  }
  return c.json({ id: receipt!.id }, existing ? 200 : 201)
})

receipts.get('/', async (c) => {
  // 下書き(どの支出からも指されないレシート)の一覧。撮る画面のカードに出す店名・印字の合計・写真の枚数を添える(データと照合 §4.6)
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.uploaded_at, r.ai_status, r.ai_requested_at, r.ai_error_kind,
            json_extract(r.ai_result, '$.storeName') AS store_name,
            json_extract(r.ai_result, '$.printedTotal') AS printed_total,
            (SELECT COUNT(*) FROM receipt_images i WHERE i.receipt_id = r.id) AS image_count
     FROM receipts r
     WHERE NOT EXISTS (SELECT 1 FROM expenses e WHERE e.receipt_id = r.id)
     ORDER BY r.uploaded_at DESC, r.id DESC`,
  ).all<{
    id: number
    uploaded_at: string
    ai_status: ReceiptRow['ai_status']
    ai_requested_at: string
    ai_error_kind: string | null
    store_name: string | null
    printed_total: number | null
    image_count: number
  }>()
  const now = new Date()
  return c.json({
    drafts: results.map((r) => ({
      id: r.id,
      uploadedAt: r.uploaded_at,
      read: readDisplay(r.ai_status, r.ai_requested_at, now),
      errorKind: r.ai_error_kind,
      storeName: r.store_name === '' ? null : r.store_name,
      printedTotal: r.printed_total,
      imageCount: r.image_count,
    })),
  })
})

/** レシート 1 枚の詳しい形(`GET /api/receipts/:id` と確かめて保存の画面の口 §4.7)。無ければ null */
export async function receiptDetail(db: D1Database, id: number) {
  const row = await loadReceipt(db, id)
  return row ? present(row, await loadImages(db, id), new Date()) : null
}

receipts.get('/:id{[0-9]+}', async (c) => {
  const detail = await receiptDetail(c.env.DB, Number(c.req.param('id')))
  return detail ? c.json(detail) : c.json({ error: 'not_found' }, 404)
})

receipts.get('/:id{[0-9]+}/images/:position{[0-9]+}', async (c) => {
  const img = await c.env.DB.prepare(
    'SELECT r2_key FROM receipt_images WHERE receipt_id = ? AND position = ? AND stored_at IS NOT NULL',
  )
    .bind(Number(c.req.param('id')), Number(c.req.param('position')))
    .first<{ r2_key: string }>()
  if (!img) return c.json({ error: 'not_found' }, 404)
  // 下書きを捨てた後の新しいレシートは同じ id になりうる(receipts は AUTOINCREMENT でない)ので、URL だけで端末に控えさせない。
  // 毎回 R2 の ETag で聞き直させ、同じ写真なら 304 で中身を送らない
  const obj = await c.env.RECEIPTS.get(img.r2_key, { onlyIf: c.req.raw.headers })
  if (!obj) return c.json({ error: 'not_found' }, 404)
  const headers = { 'content-type': 'image/jpeg', 'cache-control': 'private, no-cache', etag: obj.httpEtag }
  if (!('body' in obj)) return new Response(null, { status: 304, headers })
  return new Response(obj.body, { headers })
})

// 読み取り: 読み取り待ちならその回を読む。読めなかった(時間切れを含む)なら回を 1 増やして読み直す(§2.1)
receipts.post('/:id{[0-9]+}/read', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const row = await loadReceipt(db, id)
  if (!row) return c.json({ error: 'not_found' }, 404)
  const images = await loadImages(db, id)
  if (images.some((i) => i.stored_at === null)) return c.json({ error: 'images_not_stored' }, 409)

  const display = readDisplay(row.ai_status, row.ai_requested_at, new Date())
  if (display === 'read') return c.json({ error: 'already_read' }, 409)

  let attempt = row.ai_attempt
  if (display === 'failed' || display === 'timed_out') {
    const res = await db
      .prepare(
        `UPDATE receipts SET ai_status = 'waiting', ai_attempt = ai_attempt + 1, ai_requested_at = ?,
           ai_result = NULL, ai_error_kind = NULL
         WHERE id = ? AND ai_attempt = ?`,
      )
      .bind(nowIso(), id, attempt)
      .run()
    if (res.meta.changes === 0) return c.json({ error: 'conflict' }, 409)
    attempt += 1
  }

  const [{ results: categories }, { results: stockItems }] = await Promise.all([
    db.prepare('SELECT id, name FROM categories WHERE retired_at IS NULL ORDER BY sort_order').all<{ id: number; name: string }>(),
    // やめた品物は渡さない(データと照合 §1.14)
    db.prepare('SELECT id, name FROM stock_items WHERE retired_at IS NULL ORDER BY id').all<{ id: number; name: string }>(),
  ])
  const bytes: Uint8Array[] = []
  for (const img of images) {
    const obj = await c.env.RECEIPTS.get(img.r2_key)
    if (!obj) return c.json({ error: 'image_missing' }, 409)
    bytes.push(new Uint8Array(await obj.arrayBuffer()))
  }

  const outcome = await readReceipt(c.env, bytes, categories, stockItems)
  // 今の回の応答だけを書く(遅れた前の回・2 回目の同時の読み取りは 0 行)
  if (outcome.ok) {
    await db
      .prepare(
        `UPDATE receipts SET ai_status = 'read', ai_result = ?, ai_model = ?
         WHERE id = ? AND ai_attempt = ? AND ai_status = 'waiting'`,
      )
      .bind(JSON.stringify(outcome.result), outcome.model, id, attempt)
      .run()
  } else {
    await db
      .prepare(
        `UPDATE receipts SET ai_status = 'failed', ai_error_kind = ?, ai_model = ?
         WHERE id = ? AND ai_attempt = ? AND ai_status = 'waiting'`,
      )
      .bind(outcome.kind, outcome.model, id, attempt)
      .run()
  }
  const after = await loadReceipt(db, id)
  return c.json(present(after!, images, new Date()))
})

// 下書きを捨てる: 保存されていないときだけ行を消し、消せたら R2 の画像を消す(§1.7)。
// 行を先に消すのは、同時に走った保存が勝ったときに、保存した支出の写真を消さないため
receipts.delete('/:id{[0-9]+}', async (c) => {
  const db = c.env.DB
  const id = Number(c.req.param('id'))
  const row = await loadReceipt(db, id)
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (row.expense_id !== null) return c.json({ error: 'saved_receipt' }, 409)
  const images = await loadImages(db, id)
  const res = await db
    .prepare('DELETE FROM receipts WHERE id = ? AND NOT EXISTS (SELECT 1 FROM expenses WHERE receipt_id = ?)')
    .bind(id, id)
    .run()
  if (res.meta.changes === 0) return c.json({ error: 'saved_receipt' }, 409)
  if (images.length > 0) await c.env.RECEIPTS.delete(images.map((i) => i.r2_key))
  return c.body(null, 204)
})
