// 確かめる(データと照合 表 L・§4.9)。4 か月前の明細を取り込み(何度入れても二重にならない)、その期間に
// 楽天カードの支出を 1 つ作ると L3(明細に無い)に出る。元に戻せる操作(探す小窓・確認済み)だけを通し、終わったら支出を消す。
// 手元の D1 に前からある明細に頼らない(CI の空の D1 でも通る)
import { expect, test, type Page } from '@playwright/test'

/** 4 か月前の 5 日の 1 行の明細(請求月は 3 か月前)と、同じ期間の 20 日 */
function statement(amount: number) {
  const d = new Date()
  const used = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 4, 5))
  const m = ((used.getUTCMonth() + 1) % 12) + 1
  const date = used.toISOString().slice(0, 10).replaceAll('-', '/')
  const csv = [
    `利用日,利用店名・商品名,利用者,支払方法,利用金額,手数料/利息,支払総額,${m}月支払金額,当月請求額,${(m % 12) + 1}月繰越残高,新規サイン`,
    `${date},テスト明細店 E2E,本人,1回払い,${amount},0,${amount},${amount},0,0,`,
  ].join('\n')
  return { csv, spentOn: `${used.toISOString().slice(0, 8)}20` }
}

async function importStatement(page: Page, origin: string, csv: string) {
  const res = await page.request.post('/api/statements', {
    headers: { origin },
    multipart: { file: { name: 'enavi.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } },
  })
  expect(res.status()).toBeLessThan(300)
}

test('L3 のカード: 探す小窓で明細の行が並び、「確認済み」でカードが消える', async ({ page }, info) => {
  await page.goto('/review')
  const origin = new URL(page.url()).origin
  const store = `E2E 確かめる ${info.project.name} ${crypto.randomUUID().slice(0, 6)}`
  // 390px と 402px が並んで走るので、行の鍵(額)を端末の幅ごとに変える
  const amount = info.project.name.endsWith('390') ? 4321 : 4322
  const { csv, spentOn } = statement(amount)
  await importStatement(page, origin, csv)
  const res = await page.request.post('/api/expenses', {
    headers: { origin },
    data: {
      clientRequestId: `e2e-review-${crypto.randomUUID()}`,
      receiptId: null,
      spentOn,
      storeName: store,
      paymentMethod: 'rakuten_card',
      items: [{ name: 'x', categoryId: 1, taxRate: null, baseAmount: 777_001 + Math.floor(Math.random() * 1000), stockItemId: null, stockQuantity: null }],
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
    await expect(dialog.getByRole('button', { name: /テスト明細店 E2E/ }).filter({ hasText: amount.toLocaleString('ja-JP') })).toBeVisible()
    await dialog.getByRole('button', { name: 'やめる' }).click()
    await expect(dialog).toBeHidden()

    // 直す画面へ行っても、戻ると確かめるに帰る(一覧へ行かない)
    await card.getByRole('button', { name: '支払い方法を直す' }).click()
    await expect(page.getByRole('heading', { name: '支出を直す' })).toBeVisible()
    await page.getByRole('link', { name: '要確認レシートに戻る' }).click()
    await expect(page).toHaveURL(/\/review$/)
    await expect(card).toBeVisible()

    await card.getByRole('button', { name: 'カードで合っている(確認済み)' }).click()
    await page.getByRole('dialog', { name: 'カードで合っていると確認しますか?' }).getByRole('button', { name: 'カードで合っている(確認済み)' }).click()
    await expect(card).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('region', { name: 'カードで払いましたか?' }).filter({ hasText: store })).toHaveCount(0)
  } finally {
    expect((await page.request.delete(`/api/expenses/${id}`, { headers: { origin } })).status()).toBe(204)
  }
})
