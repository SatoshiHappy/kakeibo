// 明細の取り込み(データと照合 表 C・§4.10)。壊れたファイルは理由を出して止まり、同じファイルは何度入れても二重にならない(C10)
import { expect, test } from '@playwright/test'

/** 3 か月前の 10 日に 1 行だけの明細(請求月は 2 か月前。e-NAVI の「明細コピー用 Excel(CSV)」の形)。
 * 390px と 402px が並んで走るので、額を端末の幅ごとに変えて行の鍵をぶつけない */
function csv(amount: number) {
  const d = new Date()
  const used = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, 10))
  const m = ((used.getUTCMonth() + 1) % 12) + 1 // 請求月の月の番号
  const date = used.toISOString().slice(0, 10).replaceAll('-', '/')
  return [
    `利用日,利用店名・商品名,利用者,支払方法,利用金額,手数料/利息,支払総額,${m}月支払金額,当月請求額,${(m % 12) + 1}月繰越残高,新規サイン`,
    `${date},E2E 取り込み,本人,1回払い,${amount},0,${amount},${amount},0,0,`,
  ].join('\n')
}

test('壊れたファイルは理由を出して止まり、明細は何度取り込んでも二重にならない', async ({ page }, info) => {
  await page.goto('/import')
  const input = page.locator('input[type=file]')
  await input.setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b,c\n1,2,3\n') })
  await expect(page.getByRole('alert')).toContainText('ファイルの形が違います(見出しの行)')

  const file = { name: 'enavi.csv', mimeType: 'text/csv', buffer: Buffer.from(csv(info.project.name.endsWith('390') ? 1 : 2)) }
  await input.setInputFiles(file) // 1 回目(手元の D1 に無ければ新しい行になる)
  await expect(page.getByRole('status', { name: '取り込みの結果' })).toContainText('請求分を取り込みました')
  await input.setInputFiles(file)
  const result = page.getByRole('status', { name: '取り込みの結果' })
  await expect(result.locator('div').filter({ hasText: /^新しい行/ })).toContainText('0 行')
  await expect(result.locator('div').filter({ hasText: /^取り込み済みで飛ばした行/ })).toContainText('1')
})
