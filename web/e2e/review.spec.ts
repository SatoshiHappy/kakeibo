// 確かめる(データと照合 表 L・§4.9)。手元の D1 に取り込んだ試しの明細(請求月 2025-10。2025-09 の利用分)の期間に、
// 楽天カードの支出を 1 つ作ると L3(明細に無い)に出る。元に戻せる操作(探す小窓・確認済み)だけを通し、終わったら支出を消す
import { expect, test } from '@playwright/test'

test('L3 のカード: 探す小窓で明細の行が並び、「確認済み」でカードが消える', async ({ page }, info) => {
  await page.goto('/review')
  const origin = new URL(page.url()).origin
  const store = `E2E 確かめる ${info.project.name} ${crypto.randomUUID().slice(0, 6)}`
  const res = await page.request.post('/api/expenses', {
    headers: { origin },
    data: {
      clientRequestId: `e2e-review-${crypto.randomUUID()}`,
      receiptId: null,
      spentOn: '2025-09-20',
      storeName: store,
      paymentMethod: 'rakuten_card',
      items: [{ name: 'x', categoryId: 1, taxRate: null, baseAmount: 777_001 + Math.floor(Math.random() * 1000) }],
      adjustments: [],
    },
  })
  expect(res.status()).toBe(201)
  const { id } = (await res.json()) as { id: number }
  try {
    await page.reload()
    const card = page.getByRole('region', { name: 'カードで払いましたか?' }).filter({ hasText: store })
    await expect(card).toBeVisible()
    await expect(card.getByText('支払いは楽天カードですが、取り込んだ明細にありません。')).toBeVisible()

    await card.getByRole('button', { name: '明細の行を探して足す' }).click()
    const dialog = page.getByRole('dialog', { name: 'この支出に足す明細の行を選ぶ' })
    await expect(dialog.getByRole('button', { name: /テスト明細店/ })).toBeVisible()
    await dialog.getByRole('button', { name: 'やめる' }).click()
    await expect(dialog).toBeHidden()

    await card.getByRole('button', { name: 'カードで合っている(確認済み)' }).click()
    await expect(card).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('region', { name: 'カードで払いましたか?' }).filter({ hasText: store })).toHaveCount(0)
  } finally {
    expect((await page.request.delete(`/api/expenses/${id}`, { headers: { origin } })).status()).toBe(204)
  }
})
