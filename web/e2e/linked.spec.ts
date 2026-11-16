// 自動で結ばれた明細を、支出を直す画面で外す(要求「照合」の「人は外せる」・データと照合 §4.7。2026-11-17 ユーザー回答)
import { expect, test } from '@playwright/test'

test('同じ日・同じ額で自動で結ばれた明細を、直す画面の「この明細とは別の買い物」で外せる(確かめの小窓つき)', async ({ page }) => {
  await page.goto('/list')
  const origin = new URL(page.url()).origin
  // 5 か月前の 7 日の 1 行の明細。額は走るたびに変える(明細の行は消せず手元の D1 に残るので、前の走りの行と結ばないように)
  const d = new Date()
  const used = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 5, 7))
  const m = ((used.getUTCMonth() + 1) % 12) + 1
  const amount = 600_000 + Math.floor(Math.random() * 300_000)
  const csv = [
    `利用日,利用店名・商品名,利用者,支払方法,利用金額,手数料/利息,支払総額,${m}月支払金額,当月請求額,${(m % 12) + 1}月繰越残高,新規サイン`,
    `${used.toISOString().slice(0, 10).replaceAll('-', '/')},結び外し E2E,本人,1回払い,${amount},0,${amount},${amount},0,0,`,
  ].join('\n')
  expect((await page.request.post('/api/statements', { headers: { origin }, multipart: { file: { name: 'enavi.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } } })).status()).toBeLessThan(300)
  // 同じ日・同じ額の楽天カードの支出は自動で結ばれる(表 A-1)
  const res = await page.request.post('/api/expenses', {
    headers: { origin },
    data: {
      clientRequestId: `e2e-linked-${crypto.randomUUID()}`,
      receiptId: null,
      spentOn: used.toISOString().slice(0, 10),
      storeName: 'E2E 結び外し',
      paymentMethod: 'rakuten_card',
      items: [{ name: 'x', categoryId: 1, taxRate: null, baseAmount: amount, stockItemId: null, stockQuantity: null }],
      adjustments: [],
    },
  })
  const { id } = (await res.json()) as { id: number }
  try {
    await page.goto(`/expenses/${id}`)
    const linked = page.getByRole('region', { name: '結んだカード明細' })
    await expect(linked).toContainText('結び外し E2E')
    await linked.getByRole('button', { name: 'この明細とは別の買い物' }).click()
    const confirm = page.getByRole('dialog', { name: 'この明細とは別の買い物にしますか?' })
    await confirm.getByRole('button', { name: '別の買い物' }).click()
    await expect(linked).toHaveCount(0)
    // 外した後も、直している入力はそのまま保存できる(版は進まない)
    await page.getByLabel('店').fill('E2E 結び外し 直した')
    await page.getByRole('button', { name: '変更を保存' }).click()
    await expect(page).toHaveURL(/\/list$/)
  } finally {
    await page.request.delete(`/api/expenses/${id}`, { headers: { origin } })
  }
})
