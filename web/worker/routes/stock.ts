// 消耗品の在庫の口。正本: docs/設計/データと照合.md §1.14・§1.15・§2.5・表 S・表 U
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { stockStatus, undoCutoff, type StockStatus } from '../domain/stock'
import { jstDate, nowIso } from '../time'
import type { AppEnv } from '../types'

/** 品物 s の数 n(s)(§2.5)。`s` は stock_items の別名 */
export const QUANTITY_SQL = `(COALESCE((SELECT SUM(i.stock_quantity) FROM items i WHERE i.stock_item_id = s.id), 0)
  + COALESCE((SELECT SUM(m.delta) FROM stock_moves m WHERE m.stock_item_id = s.id), 0))`

export type StockOverviewItem = {
  id: number
  name: string
  notifyDays: number
  retired: boolean
  alerted: boolean
  quantity: number
  /** やめた品物は null(表 S に掛けない) */
  status: StockStatus | null
}

/** すべての品物と、やめていない品物の表 S。一覧の口と通知の判定(表 N)が使う */
export async function stockOverview(db: D1Database, now: Date): Promise<StockOverviewItem[]> {
  const [items, uses] = await db.batch<Record<string, unknown>>([
    db.prepare(
      `SELECT s.id, s.name, s.notify_days, s.retired_at, s.alerted_at, ${QUANTITY_SQL} AS quantity
       FROM stock_items s ORDER BY s.id`,
    ),
    // 窓 = 品物ごとに新しい「使った」最大 4 つ(§2.5)
    db.prepare(
      `SELECT stock_item_id, moved_at FROM (
         SELECT stock_item_id, moved_at,
                ROW_NUMBER() OVER (PARTITION BY stock_item_id ORDER BY moved_at DESC, id DESC) AS rn
         FROM stock_moves WHERE kind = 'use'
       ) WHERE rn <= 4 ORDER BY stock_item_id, rn`,
    ),
  ])
  const dates = new Map<number, string[]>()
  for (const u of uses!.results) {
    const id = u.stock_item_id as number
    dates.set(id, [...(dates.get(id) ?? []), jstDate(new Date(u.moved_at as string))])
  }
  const today = jstDate(now)
  return items!.results.map((r) => {
    const retired = r.retired_at !== null
    const quantity = r.quantity as number
    return {
      id: r.id as number,
      name: r.name as string,
      notifyDays: r.notify_days as number,
      retired,
      alerted: r.alerted_at !== null,
      quantity,
      status: retired
        ? null
        : stockStatus({ quantity, useDatesNewestFirst: dates.get(r.id as number) ?? [], notifyDays: r.notify_days as number, today }),
    }
  })
}

const name = z.string().trim().min(1).max(50)
const notifyDays = z.number().int().min(0).max(365)
const count = z.number().int().min(0)

async function body<T extends z.ZodType>(c: Context<AppEnv>, schema: T) {
  return schema.safeParse(await c.req.json().catch(() => undefined))
}

/** 書けなかったときの理由(表 U の優先順 U1 → U2)。どちらでもなければ null */
async function itemRefusal(c: Context<AppEnv>, id: number) {
  const s = await c.env.DB.prepare('SELECT retired_at FROM stock_items WHERE id = ?').bind(id).first<{ retired_at: string | null }>()
  if (!s) return c.json({ error: 'not_found' }, 404)
  if (s.retired_at !== null) return c.json({ error: 'retired' }, 409)
  return null
}

export const stock = new Hono<AppEnv>()

stock.get('/', async (c) => {
  const now = new Date()
  const [items, latest] = await Promise.all([
    stockOverview(c.env.DB, now),
    // 品物ごとの最新の動き。U9 に当たる(使った・10 分以内)なら取り消せる
    c.env.DB.prepare(
      `SELECT m.stock_item_id, m.id, m.kind, m.moved_at FROM stock_moves m
       WHERE m.id = (SELECT MAX(id) FROM stock_moves WHERE stock_item_id = m.stock_item_id)`,
    ).all<{ stock_item_id: number; id: number; kind: string; moved_at: string }>(),
  ])
  const cutoff = undoCutoff(now)
  const undoable = new Map(latest.results.filter((m) => m.kind === 'use' && m.moved_at >= cutoff).map((m) => [m.stock_item_id, m.id]))
  return c.json({
    items: items.map(({ alerted: _alerted, status, ...rest }) => ({
      ...rest,
      state: status?.state ?? null,
      forecast: status?.forecast ?? null,
      undoableMoveId: rest.retired ? null : (undoable.get(rest.id) ?? null),
    })),
  })
})

// 品物を登録する。最初の数は入れ直し(count)として同じ batch で書く(§2.5)
stock.post('/', async (c) => {
  const parsed = await body(c, z.object({ name, notifyDays: notifyDays.default(7), count }))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const b = parsed.data
  const db = c.env.DB
  const user = c.get('user')
  const now = nowIso()
  try {
    await db.batch([
      db
        .prepare('INSERT INTO stock_items (name, notify_days, created_by, created_at) VALUES (?, ?, ?, ?)')
        .bind(b.name, b.notifyDays, user.id, now),
      db
        .prepare(
          `INSERT INTO stock_moves (stock_item_id, kind, delta, counted, moved_by, moved_at)
           SELECT id, 'count', ?, ?, ?, ? FROM stock_items WHERE name = ?`,
        )
        .bind(b.count, b.count, user.id, now, b.name),
    ])
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) return c.json({ error: 'duplicate_name' }, 409)
    throw e
  }
  const created = (await db.prepare('SELECT id FROM stock_items WHERE name = ?').bind(b.name).first<{ id: number }>())!
  return c.json({ id: created.id }, 201)
})

// 名前・知らせる日数を直す・やめる/戻す(§1.14。やめていてもできる。数は変わらない)
stock.patch('/:id{[0-9]+}', async (c) => {
  const parsed = await body(c, z.object({ name: name.optional(), notifyDays: notifyDays.optional(), retired: z.boolean().optional() }))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const b = parsed.data
  const id = Number(c.req.param('id'))
  try {
    const res = await c.env.DB.prepare(
      `UPDATE stock_items SET
         name = COALESCE(?, name),
         notify_days = COALESCE(?, notify_days),
         retired_at = CASE WHEN ? IS NULL THEN retired_at WHEN ? = 1 THEN COALESCE(retired_at, ?) ELSE NULL END
       WHERE id = ?`,
    )
      .bind(b.name ?? null, b.notifyDays ?? null, b.retired === undefined ? null : 1, b.retired ? 1 : 0, nowIso(), id)
      .run()
    if (res.meta.changes === 0) return c.json({ error: 'not_found' }, 404)
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) return c.json({ error: 'duplicate_name' }, 409)
    throw e
  }
  return c.json({ id })
})

// 「使った」(表 U の U1〜U4)。数が 1 以上かを同じ文で数える(§2.5)
stock.post('/:id{[0-9]+}/use', async (c) => {
  const id = Number(c.req.param('id'))
  const db = c.env.DB
  const res = await db
    .prepare(
      `INSERT INTO stock_moves (stock_item_id, kind, delta, counted, moved_by, moved_at)
       SELECT s.id, 'use', -1, NULL, ?, ? FROM stock_items s
       WHERE s.id = ? AND s.retired_at IS NULL AND ${QUANTITY_SQL} >= 1`,
    )
    .bind(c.get('user').id, nowIso(), id)
    .run()
  if (res.meta.changes === 1) return c.json({ moveId: res.meta.last_row_id }, 201)
  return (await itemRefusal(c, id)) ?? c.json({ error: 'no_stock' }, 409)
})

// 今の数を入れ直す(表 U の U1・U2・U5)。delta = c − n(s) を同じ文で数える(§2.5)
stock.post('/:id{[0-9]+}/count', async (c) => {
  const parsed = await body(c, z.object({ count }))
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
  const id = Number(c.req.param('id'))
  const c_ = parsed.data.count
  const res = await c.env.DB.prepare(
    `INSERT INTO stock_moves (stock_item_id, kind, delta, counted, moved_by, moved_at)
     SELECT s.id, 'count', ? - ${QUANTITY_SQL}, ?, ?, ? FROM stock_items s
     WHERE s.id = ? AND s.retired_at IS NULL`,
  )
    .bind(c_, c_, c.get('user').id, nowIso(), id)
    .run()
  if (res.meta.changes === 1) return c.json({ moveId: res.meta.last_row_id }, 201)
  return (await itemRefusal(c, id))!
})

// 「使った」の取り消し(表 U の U1・U2・U6〜U9)。条件を WHERE に入れた 1 つの DELETE で消し、消せなければ読み直して理由を返す
stock.delete('/:id{[0-9]+}/moves/:moveId{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'))
  const moveId = Number(c.req.param('moveId'))
  const db = c.env.DB
  const cutoff = undoCutoff(new Date())
  const res = await db
    .prepare(
      `DELETE FROM stock_moves
       WHERE id = ? AND stock_item_id = ? AND kind = 'use' AND moved_at >= ?
         AND NOT EXISTS (SELECT 1 FROM stock_moves later WHERE later.stock_item_id = ? AND later.id > ?)
         AND EXISTS (SELECT 1 FROM stock_items s WHERE s.id = ? AND s.retired_at IS NULL)`,
    )
    .bind(moveId, id, cutoff, id, moveId, id)
    .run()
  if (res.meta.changes === 1) return c.body(null, 204)
  const refused = await itemRefusal(c, id)
  if (refused) return refused
  const move = await db
    .prepare(
      `SELECT moved_at, EXISTS (SELECT 1 FROM stock_moves later WHERE later.stock_item_id = m.stock_item_id AND later.id > m.id) AS has_later
       FROM stock_moves m WHERE m.id = ? AND m.stock_item_id = ? AND m.kind = 'use'`,
    )
    .bind(moveId, id)
    .first<{ moved_at: string; has_later: number }>()
  if (!move) return c.json({ error: 'not_found' }, 404) // U6
  if (move.has_later === 1) return c.json({ error: 'not_latest' }, 409) // U7
  return c.json({ error: 'undo_expired' }, 409) // U8
})
