// 確かめて保存の守り(独立レビューの直し。データと照合 §4.7・表 V)
// - 保存の応答だけが落ちた後に直して押し直すと、直した内容で保存される(送り直しは reused → PUT)
// - 支出を直す画面は、端末に残った古い応答でなく、開いた後に取った値から始める
// - 手で入力している途中に読み取りが終わっても、入力を置き換えない
import { expect, test, type Page } from '@playwright/test'

const originOf = (page: Page) => new URL(page.url()).origin

test('保存の応答が届かなかった後に額を直して押し直すと、直した額で保存される', async ({ page }) => {
  await page.goto('/expenses/new')
  const item = page.getByRole('group', { name: '品目 1' })
  await page.getByLabel('日付').fill('2020-03-10')
  await page.getByLabel('支払い').selectOption('cash')
  await item.getByLabel('額(値引のあと)').fill('300')
  // 1 回目: 口には届いて保存されるが、応答は画面に届かない
  let savedId: number | null = null
  await page.route('**/api/expenses', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const res = await route.fetch()
    savedId = ((await res.json()) as { id: number }).id
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '保存する' }).click()
  await expect(page.getByRole('alert')).toContainText('通信できませんでした')
  await page.unroute('**/api/expenses')
  expect(savedId).not.toBeNull()
  try {
    // 直して押し直す(同じ送信の ID)
    await item.getByLabel('額(値引のあと)').fill('280')
    await page.getByRole('button', { name: '保存する' }).click()
    await expect(page).toHaveURL(/\/capture$/)
    const e = (await (await page.request.get(`/api/expenses/${savedId}`)).json()) as { amount: number }
    expect(e.amount).toBe(280)
  } finally {
    await page.request.delete(`/api/expenses/${savedId}`, { headers: { origin: originOf(page) } })
  }
})

test('支出を直す画面は、ほかの端末で直された後の保存を断り、開き直すと新しい値から始める(端末に残った古い応答を使わない)', async ({ page }) => {
  await page.goto('/list')
  const origin = originOf(page)
  const body = (baseAmount: number) => ({
    spentOn: '2020-03-11',
    storeName: 'E2E 古い応答',
    paymentMethod: 'cash',
    items: [{ name: 'x', categoryId: 1, taxRate: null, baseAmount, stockItemId: null, stockQuantity: null }],
    adjustments: [],
  })
  const created = await page.request.post('/api/expenses', { headers: { origin }, data: { ...body(100), clientRequestId: crypto.randomUUID(), receiptId: null } })
  const { id } = (await created.json()) as { id: number }
  try {
    await page.goto(`/expenses/${id}`)
    await expect(page.locator('.savebar .big')).toHaveText('¥100')
    // ほかの端末で直す(読んだ版を送る)
    const { updatedAt } = (await (await page.request.get(`/api/expenses/${id}`)).json()) as { updatedAt: string }
    expect((await page.request.put(`/api/expenses/${id}`, { headers: { origin }, data: { ...body(200), baseUpdatedAt: updatedAt } })).status()).toBe(200)
    // 開いたままの画面で保存すると、前の直しを消さずに断って知らせる(同時の直し)
    await page.getByRole('button', { name: '変更を保存' }).click()
    await expect(page.getByRole('alert')).toContainText('ほかの人(ほかの端末)がこの支出を先に直しました')
    await expect(page).toHaveURL(new RegExp(`/expenses/${id}$`))
    // 開き直す(端末には ¥100 の応答が残っている)
    await page.goto('/list')
    await page.goto(`/expenses/${id}`)
    await expect(page.locator('.savebar .big')).toHaveText('¥200')
  } finally {
    await page.request.delete(`/api/expenses/${id}`, { headers: { origin } })
  }
})

test('手で入力している途中に読み取りが終わっても入力はそのまま。押せば AI の結果に入れ替わる', async ({ page }) => {
  await page.goto('/capture')
  // 下書きの口を差し替える: はじめは読み取り中、後で読めた
  let read = false
  const receipt = (r: boolean) => ({
    id: 999001,
    uploadedAt: '2026-11-16T00:00:00Z',
    read: r ? 'read' : 'reading',
    result: r
      ? {
          storeName: 'AI の店',
          purchasedOn: '2026-11-15',
          paymentMethod: 'cash',
          items: [{ name: '牛乳', baseAmount: 238, taxRate: 8, categoryId: 1, stockItemId: null, stockQuantity: null }],
          adjustments: [],
          printedTotal: 238,
        }
      : null,
    expenseId: null,
    images: [{ position: 1, stored: true }],
  })
  await page.route('**/api/expense-form?receipt=999001', async (route) => {
    const real = (await (await route.fetch({ url: route.request().url().replace(/\?.*$/, '') })).json()) as Record<string, unknown>
    await route.fulfill({ json: { ...real, receipt: receipt(read) } })
  })
  await page.route('**/api/receipts/999001/images/*', (route) => route.fulfill({ status: 404, json: { error: 'not_found' } }))
  await page.goto('/receipts/999001')
  await page.getByRole('button', { name: '待たずに手で入力する' }).click()
  await page.getByLabel('店').fill('手で入れた店')
  // 読み取りが終わり、画面が裏で読み直す(画面に戻ったときの読み直し)
  read = true
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    window.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    window.dispatchEvent(new Event('visibilitychange'))
  })
  const swap = page.getByRole('button', { name: 'AI の結果に入れ替える' })
  await expect(swap).toBeVisible()
  await expect(page.getByLabel('店')).toHaveValue('手で入れた店')
  await swap.click()
  await expect(page.getByLabel('店')).toHaveValue('AI の店')
})
