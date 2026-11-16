// 表 C の C1〜C9 と読み方の脚注(BOM・改行・桁区切り・ordinal・請求月の決め方)
import { describe, expect, it } from 'vitest'
import { parseStatementCsv } from '../worker/domain/statement-csv'

const HEADER = '"利用日","利用店名・商品名","利用者","支払方法","利用金額","手数料/利息","支払総額","11月支払金額","当月請求額","12月繰越残高","新規サイン"'
const row = (date: string, shop: string, amount: string, fee = '0') =>
  `"${date}","${shop}","本人","1回払い","${amount}","${fee}","${amount}","${amount}","${amount}","0","*"`
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer
const TODAY = '2026-11-15'

describe('読めるファイル', () => {
  it('サンプルと同じ形(BOM・LF・末尾の空行)', () => {
    const r = parseStatementCsv(enc(`﻿${HEADER}\n${row('2026/10/20', 'A', '1')}\n${row('2026/10/20', 'B', '2580')}\n`), TODAY)
    expect(r).toMatchObject({ ok: true, billingMonth: '2026-11' })
    if (r.ok) expect(r.rows.map((x) => x.amount)).toEqual([1, 2580])
  })
  it('BOM なし・CRLF も受ける', () => {
    const r = parseStatementCsv(enc(`${HEADER}\r\n${row('2026/10/11', 'A', '100')}\r\n`), TODAY)
    expect(r.ok).toBe(true)
  })
  it('3 桁ごとの , と負の額を整数に読み、そろえた文字にする', () => {
    const r = parseStatementCsv(enc(`${HEADER}\n${row('2026/10/11', 'A', '1,234')}\n${row('2026/10/12', 'B', '-500')}\n`), TODAY)
    expect(r.ok && r.rows.map((x) => [x.amountCell, x.amount])).toEqual([
      ['1234', 1234],
      ['-500', -500],
    ])
  })
  it('同じ中身の行は ordinal を 1, 2 と数える', () => {
    const r = parseStatementCsv(enc(`${HEADER}\n${row('2026/10/11', 'A', '100')}\n${row('2026/10/11', 'A', '100')}\n`), TODAY)
    expect(r.ok && r.rows.map((x) => x.ordinal)).toEqual([1, 2])
  })
  it('分割払いの 2 か月目以降(利用金額 -)は額 NULL で、請求月の決め方に使わない', () => {
    const r = parseStatementCsv(enc(`${HEADER}\n${row('2026/03/01', '分割', '-', '120')}\n${row('2026/10/11', 'A', '100')}\n`), TODAY)
    expect(r).toMatchObject({ ok: true, billingMonth: '2026-11' })
    if (r.ok) expect(r.rows[0]).toMatchObject({ amountCell: '-', amount: null, fee: 120 })
  })
  it('12 月の請求の翌月繰越は 1 月', () => {
    const h = HEADER.replace('11月支払金額', '12月支払金額').replace('12月繰越残高', '1月繰越残高')
    const r = parseStatementCsv(enc(`${h}\n${row('2025/11/20', 'A', '100')}\n`), TODAY)
    expect(r).toMatchObject({ ok: true, billingMonth: '2025-12' })
  })
})

describe('止める(C1〜C9)', () => {
  it('C1 UTF-8 として読めない', () => {
    const bad = new Uint8Array([0xff, 0xfe, 0xfd]).buffer as ArrayBuffer
    expect(parseStatementCsv(bad, TODAY)).toMatchObject({ ok: false, check: 'C1' })
  })
  it('C1 引用符の閉じ忘れ', () => {
    expect(parseStatementCsv(enc(`${HEADER}\n"2026/10/11,"A`), TODAY)).toMatchObject({ ok: false, check: 'C1' })
  })
  it('C2 見出しが違う', () => {
    expect(parseStatementCsv(enc(`"日付","店"\n`), TODAY)).toMatchObject({ ok: false, check: 'C2' })
  })
  it('C2 繰越の月が支払の月の次でない', () => {
    const h = HEADER.replace('12月繰越残高', '1月繰越残高')
    expect(parseStatementCsv(enc(`${h}\n${row('2026/10/11', 'A', '1')}\n`), TODAY)).toMatchObject({ ok: false, check: 'C2' })
  })
  it('C3 列の数が 11 でない行', () => {
    expect(parseStatementCsv(enc(`${HEADER}\n"2026/10/11","A"\n`), TODAY)).toMatchObject({ ok: false, check: 'C3' })
  })
  it('C4 利用日が正しい日付でない', () => {
    expect(parseStatementCsv(enc(`${HEADER}\n${row('2026/02/30', 'A', '1')}\n`), TODAY)).toMatchObject({ ok: false, check: 'C4' })
  })
  it('C5 利用金額が整数でも - でもない', () => {
    expect(parseStatementCsv(enc(`${HEADER}\n${row('2026/10/11', 'A', '12.5')}\n`), TODAY)).toMatchObject({ ok: false, check: 'C5' })
  })
  it('C6 手数料が整数でない', () => {
    expect(parseStatementCsv(enc(`${HEADER}\n${row('2026/10/11', 'A', '1', 'x')}\n`), TODAY)).toMatchObject({ ok: false, check: 'C6' })
  })
  it('C4〜C6 は表の順に全部の行へ掛ける: 1 行目が C6・2 行目が C4 なら C4', () => {
    const csv = `${HEADER}\n${row('2026/10/11', 'A', '1', 'x')}\n${row('2026/13/01', 'B', '1')}\n`
    expect(parseStatementCsv(enc(csv), TODAY)).toMatchObject({ ok: false, check: 'C4' })
    const c5 = `${HEADER}\n${row('2026/10/11', 'A', '1', 'x')}\n${row('2026/10/11', 'B', '1.5')}\n`
    expect(parseStatementCsv(enc(c5), TODAY)).toMatchObject({ ok: false, check: 'C5' })
  })
  it('C7 利用金額が - でない行が無い(データの行が無いときも)', () => {
    expect(parseStatementCsv(enc(`${HEADER}\n`), TODAY)).toMatchObject({ ok: false, check: 'C7' })
    expect(parseStatementCsv(enc(`${HEADER}\n${row('2026/10/11', 'A', '-', '10')}\n`), TODAY)).toMatchObject({ ok: false, check: 'C7' })
  })
  it('C8 請求月が今月より後(境: 今月は受け、来月は止める)', () => {
    // 今月 11 月の請求(10 月の利用)は受ける
    expect(parseStatementCsv(enc(`${HEADER}\n${row('2026/10/31', 'A', '1')}\n`), TODAY).ok).toBe(true)
    // 11 月の利用が入ると請求月は翌年 11 月 → 来月より後なので止める
    expect(parseStatementCsv(enc(`${HEADER}\n${row('2026/11/01', 'A', '1')}\n`), TODAY)).toMatchObject({ ok: false, check: 'C8' })
    const dec = HEADER.replace('11月支払金額', '12月支払金額').replace('12月繰越残高', '1月繰越残高')
    expect(parseStatementCsv(enc(`${dec}\n${row('2026/11/10', 'A', '1')}\n`), TODAY)).toMatchObject({ ok: false, check: 'C8' })
  })
  it('C9 請求月が 15 か月前より前(境: 15 か月前は受け、16 か月前は止める)', () => {
    const aug = HEADER.replace('11月支払金額', '8月支払金額').replace('12月繰越残高', '9月繰越残高')
    expect(parseStatementCsv(enc(`${aug}\n${row('2025/07/10', 'A', '1')}\n`), TODAY).ok).toBe(true) // 2025-08 = 15 か月前
    const jul = HEADER.replace('11月支払金額', '7月支払金額').replace('12月繰越残高', '8月繰越残高')
    expect(parseStatementCsv(enc(`${jul}\n${row('2025/06/10', 'A', '1')}\n`), TODAY)).toMatchObject({ ok: false, check: 'C9' }) // 16 か月前
  })
})
