// レシートの画像を AI で読む。結果の形は確かめる画面の初期値になる(人が直して保存する)。
import { APICallError, generateText, NoObjectGeneratedError, Output } from 'ai'
import { z } from 'zod'
import { models, type AiEnv } from './model'

export const receiptReadSchema = z.object({
  storeName: z.string().describe('店名(支店名があれば含める)。読めなければ空文字'),
  purchasedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .describe('買った日 YYYY-MM-DD。通販は注文日。読めなければ null'),
  paymentMethod: z
    .enum(['rakuten_card', 'credit', 'unknown', 'other_card', 'cash', 'emoney', 'point', 'other'])
    .describe('支払い方法。楽天カードと読めれば rakuten_card、カード会社が分からないクレジットは credit、読めなければ unknown'),
  items: z
    .array(
      z.object({
        name: z.string().describe('品名'),
        baseAmount: z.number().int().describe('値札の額から、その品目の直下の値引き行を引いた額(円)。返品は負'),
        taxRate: z.union([z.literal(0), z.literal(8), z.literal(10)]).nullable().describe('税率。不明なら null'),
        categoryId: z.number().int().describe('費目の id(与えた一覧から選ぶ)'),
        stockItemId: z
          .number()
          .int()
          .nullable()
          .describe('在庫の品物の id(与えた在庫の品物の一覧に当たる品目だけ。当たらない・返品・値引きなら null)'),
        stockQuantity: z
          .number()
          .int()
          .nullable()
          .describe('在庫に足す個数(買った単位。12 ロール入り 1 パック = 1。数量の行があればその数)。品物が null なら null'),
      }),
    )
    .describe('品目。値引き行は単独の品目にせず、真上の品目の baseAmount から引く'),
  adjustments: z
    .array(
      z.object({
        kind: z.enum(['discount', 'tax']).describe('レシート全体にかかる値引き(discount)か外税(tax)'),
        amount: z.number().int().describe('印字の額。値引きは負、外税は正(返品のレシートの外税は負)'),
        taxRate: z.union([z.literal(0), z.literal(8), z.literal(10)]).nullable().describe('その率の品目だけにかかるなら率、全体なら null'),
      }),
    )
    .describe('内税は含めない。ポイントで払った分は含めない'),
  printedTotal: z.number().int().nullable().describe('印字の合計額(ポイント払いの分を含む支払いの総額)。読めなければ null'),
})

export type ReceiptRead = z.infer<typeof receiptReadSchema>

export type AiErrorKind = 'invalid_output' | 'quota' | 'timeout' | 'other'

export type ReadOutcome =
  | { ok: true; result: ReceiptRead; model: string }
  | { ok: false; kind: AiErrorKind; model: string }

export type Category = { id: number; name: string }
export type StockChoice = { id: number; name: string }

const READ_TIMEOUT_MS = 60_000

function classify(err: unknown): AiErrorKind {
  if (NoObjectGeneratedError.isInstance(err)) return 'invalid_output'
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return 'timeout'
  if (APICallError.isInstance(err)) {
    // クレジット切れ・上限超えの状態コード(429・402)。ベンダーごとの細かい区別はしない【実機で確かめる】
    if (err.statusCode === 429 || err.statusCode === 402) return 'quota'
    if (/credit|quota|billing/i.test(err.message)) return 'quota'
  }
  return 'other'
}

/** ベンダーが返した誤り(状態コード・型・文の先頭)。画像も読んだ内容も含まない */
function vendorError(err: unknown): string {
  if (!APICallError.isInstance(err)) return err instanceof Error ? err.message.slice(0, 200) : ''
  let type = ''
  try {
    const body = JSON.parse(err.responseBody ?? '') as { error?: { type?: string } }
    type = body.error?.type ?? ''
  } catch {
    // 本文が JSON でない(途中で切れた など)ときは型を出さない
  }
  return `status=${err.statusCode ?? 'none'} type=${type} message=${err.message.slice(0, 200)}`
}

/**
 * 在庫の品物の当て方を口の検査にそろえる(人が確かめて保存で直す初めの値なので、合わない分は読み取り全体を失敗にせず外す):
 * 一覧に無い品物・額が正でない品目(返品・0 円)は外す。品物があって個数が 1 未満・無いなら 1
 */
function withStock<T extends { baseAmount: number; stockItemId: number | null; stockQuantity: number | null }>(item: T, stockItems: StockChoice[]): T {
  const usable = item.stockItemId !== null && item.baseAmount > 0 && stockItems.some((s) => s.id === item.stockItemId)
  if (!usable) return { ...item, stockItemId: null, stockQuantity: null }
  return { ...item, stockQuantity: item.stockQuantity !== null && item.stockQuantity >= 1 ? item.stockQuantity : 1 }
}

export async function readReceipt(env: AiEnv, images: Uint8Array[], categories: Category[], stockItems: StockChoice[] = []): Promise<ReadOutcome> {
  const model = `${env.AI_VENDOR}/${env.AI_MODEL}`
  try {
    const { output } = await generateText({
      model: models.languageModel(env),
      output: Output.object({ schema: receiptReadSchema }),
      abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                '日本のレシート(または通販の注文確認の画面)の画像です。書いてある内容をそのまま読み取ってください。',
                '画像が複数あるときは 1 枚のレシートの続きです。',
                '費目は次の一覧から、品目ごとに最も近いものを選んでください(id で答える):',
                ...categories.map((c) => `- ${c.id}: ${c.name}`),
                ...(stockItems.length > 0
                  ? ['在庫を数えている品物は次の一覧です。品目がどれかに当たれば stockItemId と個数を答え、当たらなければ null にしてください(id で答える):', ...stockItems.map((s) => `- ${s.id}: ${s.name}`)]
                  : ['在庫を数えている品物はありません。stockItemId と stockQuantity は null にしてください。']),
              ].join('\n'),
            },
            ...images.map((data) => ({ type: 'file' as const, data, mediaType: 'image/jpeg' })),
          ],
        },
      ],
    })
    const known = new Set(categories.map((c) => c.id))
    if (output.items.some((i) => !known.has(i.categoryId))) return { ok: false, kind: 'invalid_output', model }
    return { ok: true, result: { ...output, items: output.items.map((i) => withStock(i, stockItems)) }, model }
  } catch (err) {
    const kind = classify(err)
    // 中身(画像・読んだ内容)は記録しない。種類と名前と、ベンダーの誤りの状態コード・型・文だけ(基盤 §4。原因を本番の記録で追えるように)
    console.error('receipt read failed', kind, err instanceof Error ? err.name : typeof err, vendorError(err))
    return { ok: false, kind, model }
  }
}
