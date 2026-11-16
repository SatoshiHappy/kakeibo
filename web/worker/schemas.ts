// 2 つ以上の口(画面の API と MCP の道具)が受ける入力の型。検査の規則をここ 1 か所に置く
import { z } from 'zod'

export const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).describe('YYYY-MM')

/** 本当にある日か(2026-02-30 などを断る) */
export function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  // 月 13・日 32 などは Invalid Date(toISOString が投げる)なので先に見る
  const t = Date.parse(`${v}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v
}
export const isoDate = z.string().refine(isRealDate, { message: '本当にある日付 YYYY-MM-DD' })
