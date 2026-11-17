// 一覧(データと照合 §4.8・表 W)。ほかの E2E とぶつからない昔の月(2020-01)に支出を作って確かめ、終わったら消す
import { expect, test, type APIRequestContext } from '@playwright/test'

const MONTH = '2020-01'

async function create(request: APIRequestContext, origin: string, body: { spentOn: string; storeName: string; paymentMethod: string; categoryId: number; amount: number }) {
  const res = await request.post('/api/expenses', {
    headers: { origin },
    data: {
      clientRequestId: `e2e-list-${crypto.randomUUID()}`,
      receiptId: null,
      spentOn: body.spentOn,
      storeName: body.storeName,
      paymentMethod: body.paymentMethod,
      items: [{ name: 'x', categoryId: body.categoryId, taxRate: null, baseAmount: body.amount }],
      adjustments: [],
    },
  })
  expect(res.status()).toBe(201)
  return ((await res.json()) as { id: number }).id
}

test('月の支出を日ごとに並べ、絞り込みと印(表 W)が出て、行から支出を直す画面へ移る', async ({ page }, info) => {
  await page.goto('/list')
  const origin = new URL(page.url()).origin
  const tag = `${info.project.name}-${crypto.randomUUID().slice(0, 6)}`
  const ids = [
    await create(page.request, origin, { spentOn: '2020-01-15', storeName: `カード店 ${tag}`, paymentMethod: 'rakuten_card', categoryId: 1, amount: 1200 }),
    await create(page.request, origin, { spentOn: '2020-01-15', storeName: `現金店 ${tag}`, paymentMethod: 'cash', categoryId: 19, amount: 300 }),
  ]
  try {
    await page.goto(`/list?month=${MONTH}`)
    await expect(page.getByRole('heading', { name: '1月の支出' })).toBeVisible()
    const day = page.getByRole('region', { name: '1月15日(水)' })
    const card = day.getByRole('link', { name: new RegExp(`カード店 ${tag}`) })
    const cash = day.getByRole('link', { name: new RegExp(`現金店 ${tag}`) })
    await expect(card.getByRole('img', { name: '明細待ち' })).toBeVisible() // W1
    await expect(cash.getByRole('img', { name: '明細待ち' })).toHaveCount(0) // W2
    await expect(cash.locator('.meta')).toHaveClass(/warn/) // 未分類

    await page.getByRole('button', { name: /^明細待ち/ }).click()
    await expect(card).toBeVisible()
    await expect(cash).toHaveCount(0)
    await page.getByRole('button', { name: /^未分類/ }).click()
    await expect(cash).toBeVisible()
    await expect(card).toHaveCount(0)

    // ホームの「固定費」の行から来たとき(?filter=fixed)は固定費で絞って始める
    await page.goto(`/list?month=${MONTH}&filter=fixed`)
    await expect(page.getByRole('button', { name: /^固定費/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(cash).toHaveCount(0)
    await page.goto(`/list?month=${MONTH}`)

    await cash.click()
    await expect(page).toHaveURL(new RegExp(`/expenses/${ids[1]}$`))
    await expect(page.getByRole('heading', { name: '支出を直す' })).toBeVisible()
  } finally {
    for (const id of ids) await page.request.delete(`/api/expenses/${id}`, { headers: { origin } })
  }
})

test('一覧の月の帯: 前の月へ移ると月が URL に入り、次の月で今月に戻る。今月より先へは進めず、月の合計は › の手前に出る', async ({ page }) => {
  await page.goto('/list')
  const bar = page.locator('.bar-top')
  const next = bar.getByRole('button', { name: '次の月' })
  await expect(next).toBeDisabled()
  await bar.getByRole('button', { name: '前の月' }).click()
  await expect(page).toHaveURL(/\/list\?month=\d{4}-\d{2}$/)
  await next.click()
  await expect(page).toHaveURL(/\/list$/)
  const [sum, nextBox] = await Promise.all([bar.locator('.hsum').boundingBox(), next.boundingBox()])
  expect(sum!.x + sum!.width).toBeLessThanOrEqual(nextBox!.x + 1)
})
