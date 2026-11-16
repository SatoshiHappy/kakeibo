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

export async function readReceipt(env: AiEnv, images: Uint8Array[], categories: Category[]): Promise<ReadOutcome> {
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
              ].join('\n'),
            },
            ...images.map((data) => ({ type: 'file' as const, data, mediaType: 'image/jpeg' })),
          ],
        },
      ],
    })
    const known = new Set(categories.map((c) => c.id))
    if (output.items.some((i) => !known.has(i.categoryId))) return { ok: false, kind: 'invalid_output', model }
    return { ok: true, result: output, model }
  } catch (err) {
    const kind = classify(err)
    // 中身(画像・応答)は記録しない。種類と名前だけ(基盤 §4)
    console.error('receipt read failed', kind, err instanceof Error ? err.name : typeof err)
    return { ok: false, kind, model }
  }
}
