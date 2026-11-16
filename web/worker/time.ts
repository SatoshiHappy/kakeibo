// 日時は UTC の ISO 8601(秒まで)。業務の日付は日本時間で決める(設計 §1.1)
export function nowIso(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function jstDate(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}
