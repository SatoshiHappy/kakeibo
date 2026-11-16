// 楽天カードの明細 CSV を読む。正本: docs/設計/データと照合.md 表 C の C1〜C9 と脚注
import Papa from 'papaparse'

export type ParsedRow = {
  usedOn: string // YYYY-MM-DD
  merchant: string
  cardUser: string
  paymentType: string
  amountCell: string // そろえた文字。整数の 10 進か '-'
  amount: number | null
  fee: number
  ordinal: number
}

export type ParseOutcome =
  | { ok: true; billingMonth: string; rows: ParsedRow[] }
  | { ok: false; reason: 'bad_format' | 'billing_month_unknown' | 'future_usage'; check: string }

const FIXED_HEADER = ['利用日', '利用店名・商品名', '利用者', '支払方法', '利用金額', '手数料/利息', '支払総額']
const INTEGER = /^-?\d{1,3}(,\d{3})*$|^-?\d+$/

function toInteger(cell: string): number | null {
  if (!INTEGER.test(cell)) return null
  const n = Number(cell.replace(/,/g, ''))
  return Number.isSafeInteger(n) ? n : null
}

function toDate(cell: string): string | null {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(cell)
  if (!m) return null
  const iso = `${m[1]}-${m[2]}-${m[3]}`
  const d = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null
}

/** C2: 見出しの「{M}月支払金額」の M を返す(形が違えば null) */
function headerMonth(header: string[]): number | null {
  if (header.length !== 11) return null
  if (FIXED_HEADER.some((h, i) => header[i] !== h)) return null
  const pay = /^(\d{1,2})月支払金額$/.exec(header[7])
  const carry = /^(\d{1,2})月繰越残高$/.exec(header[9])
  if (!pay || !carry || header[8] !== '当月請求額' || header[10] !== '新規サイン') return null
  const m = Number(pay[1])
  const n = Number(carry[1])
  if (m < 1 || m > 12 || n !== (m % 12) + 1) return null
  return m
}

const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1
const fromIndex = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`

/** 請求月: 月の番号が M で、利用金額が '-' でない行の最も新しい利用月 U より後の月のうち最も早い月 */
function billingMonthOf(m: number, latestUsedOn: string) {
  const u = monthIndex(latestUsedOn.slice(0, 7))
  for (let i = u + 1; i <= u + 12; i++) if ((i % 12) + 1 === m) return fromIndex(i)
  throw new Error('unreachable')
}

export function parseStatementCsv(bytes: ArrayBuffer, todayJst: string): ParseOutcome {
  // C1: UTF-8 として読めない
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return { ok: false, reason: 'bad_format', check: 'C1' }
  }
  if (text.startsWith('﻿')) text = text.slice(1)
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true })
  if (parsed.errors.some((e) => e.type === 'Quotes')) return { ok: false, reason: 'bad_format', check: 'C1' }
  const [header, ...data] = parsed.data
  if (!header) return { ok: false, reason: 'bad_format', check: 'C2' }
  const m = headerMonth(header)
  if (m === null) return { ok: false, reason: 'bad_format', check: 'C2' }
  if (data.some((r) => r.length !== 11)) return { ok: false, reason: 'bad_format', check: 'C3' }

  // C4・C5・C6 は表の順に、それぞれ全部の行に掛けてから次へ進む(違う行に違う理由が当たっても、表の上の理由を返す)
  if (data.some((r) => toDate(r[0]) === null)) return { ok: false, reason: 'bad_format', check: 'C4' }
  if (data.some((r) => r[4] !== '-' && toInteger(r[4]) === null)) return { ok: false, reason: 'bad_format', check: 'C5' }
  if (data.some((r) => toInteger(r[5]) === null)) return { ok: false, reason: 'bad_format', check: 'C6' }
  const rows: Omit<ParsedRow, 'ordinal'>[] = data.map((r) => {
    const amount = r[4] === '-' ? null : toInteger(r[4])
    return {
      usedOn: toDate(r[0])!,
      merchant: r[1],
      cardUser: r[2],
      paymentType: r[3],
      amountCell: amount === null ? '-' : String(amount),
      amount,
      fee: toInteger(r[5])!,
    }
  })

  const priced = rows.filter((r) => r.amount !== null).map((r) => r.usedOn).sort()
  if (priced.length === 0) return { ok: false, reason: 'billing_month_unknown', check: 'C7' }
  const billingMonth = billingMonthOf(m, priced[priced.length - 1])
  const thisMonth = monthIndex(todayJst.slice(0, 7))
  if (monthIndex(billingMonth) > thisMonth) return { ok: false, reason: 'future_usage', check: 'C8' }
  if (monthIndex(billingMonth) < thisMonth - 15) return { ok: false, reason: 'billing_month_unknown', check: 'C9' }

  // 行の鍵の ordinal: 同じ中身の行を上から 1, 2, … と数える
  const seen = new Map<string, number>()
  return {
    ok: true,
    billingMonth,
    rows: rows.map((r) => {
      const k = JSON.stringify([r.usedOn, r.merchant, r.cardUser, r.amountCell])
      const ordinal = (seen.get(k) ?? 0) + 1
      seen.set(k, ordinal)
      return { ...r, ordinal }
    }),
  }
}
