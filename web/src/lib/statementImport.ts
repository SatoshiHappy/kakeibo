// 明細の取り込みの画面の文(データと照合 §4.10・表 C)
export type ImportResult = {
  billingMonth: string
  rowsInFile: number
  totalAmount: number
  rowsNew: number
  rowsChanged: number
  rowsMissing: number
  linkedToPerson: number
  statementExpenses: number
  reviewCount: number
}

const BAD_FORMAT: Record<string, string> = {
  C1: 'CSV として読めません',
  C2: '見出しの行',
  C3: '列の数',
  C4: '利用日',
  C5: '利用金額',
  C6: '手数料/利息',
}

/** 止めた理由の文(表 C。何も書き込まずに止まっている) */
export function importErrorText(code: string, check: string | undefined): string {
  if (code === 'bad_format') return `ファイルの形が違います(${(check && BAD_FORMAT[check]) ?? '形'})。楽天 e-NAVI の「明細コピー用 Excel(CSV)」を選んでください。`
  if (code === 'billing_month_unknown')
    return check === 'C9' ? '15 か月より前の明細なので取り込めません。' : '請求月を決められません(利用金額のある行がありません)。'
  if (code === 'future_usage') return '請求月より後の利用日の行があります。ファイルを確かめてください。'
  if (code === 'invalid_file') return 'ファイルが空か、1MB を超えています。'
  if (code === 'conflict') return '同じ月をほかの人が同時に取り込みました。もう一度選んでください(二重にはなりません)。'
  return '取り込めませんでした。もう一度選んでください。'
}

/** 結果の行。0 の行は出さない(新しい行と飛ばした行は 0 でも出す) */
export function resultLines(r: ImportResult): { label: string; value: string; indent?: boolean; warn?: boolean }[] {
  const skipped = r.rowsInFile - r.rowsNew
  const lines: { label: string; value: string; indent?: boolean; warn?: boolean }[] = [{ label: '新しい行', value: `${r.rowsNew} 行` }]
  if (r.linkedToPerson > 0) lines.push({ label: 'レシートと自動で結んだ', value: String(r.linkedToPerson), indent: true })
  if (r.statementExpenses > 0) lines.push({ label: '明細のまま支出にした', value: String(r.statementExpenses), indent: true })
  lines.push({ label: '取り込み済みで飛ばした行', value: String(skipped) })
  if (r.rowsChanged > 0) lines.push({ label: '支払方法・手数料が変わった行(飛ばした)', value: String(r.rowsChanged), warn: true })
  if (r.rowsMissing > 0) lines.push({ label: '前に取り込んだのに今回のファイルに無い行', value: String(r.rowsMissing), warn: true })
  return lines
}

/** 2026年11月請求分 */
export const billingLabel = (m: string) => `${Number(m.slice(0, 4))}年${Number(m.slice(5, 7))}月請求分`
