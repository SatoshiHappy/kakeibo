// 確かめて保存(基盤 §6 の主な流れ「レシートを確かめて保存」・データと照合 §4.7・表 V)。
// 手元の Worker は AI の鍵を持たないので、読み取りは「読めなかった」(V3)になる。そこから手で入れて保存し、直し、消す
import { expect, test, type Page } from '@playwright/test'

async function jpeg(page: Page) {
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 200
    c.height = 300
    c.getContext('2d')!.fillRect(0, 0, 200, 300)
    return c.toDataURL('image/jpeg', 0.9)
  })
  return Buffer.from(data.split(',')[1]!, 'base64')
}

test('下書き(読めなかった)を手で入れて保存 → 支出を直す → 消すと下書きに戻る', async ({ page }, info) => {
  await page.goto('/capture')
  const origin = new URL(page.url()).origin
  const up = await page.request.post('/api/receipts', {
    headers: { origin },
    multipart: { clientRequestId: `e2e-form-${info.project.name}-${crypto.randomUUID()}`, images: { name: 'r.jpg', mimeType: 'image/jpeg', buffer: await jpeg(page) } },
  })
  expect(up.status()).toBe(201)
  const { id: receiptId } = (await up.json()) as { id: number }
  await page.request.post(`/api/receipts/${receiptId}/read`, { headers: { origin } })
  const store = `E2E 店 ${info.project.name}`
  try {
    // V3: 読めなかった下書き
    await page.goto(`/receipts/${receiptId}`)
    await expect(page.getByText('読めませんでした。手で入力するか、読み直してください。')).toBeVisible()
    await expect(page.getByRole('button', { name: '読み直す' })).toBeVisible()

    // 誤りは並べて知らせる
    await page.getByRole('button', { name: '保存する' }).click()
    await expect(page.getByRole('alert')).toContainText('支払いを選んでください。')
    await expect(page.getByRole('alert')).toContainText('品目 1: 額を数字で入れてください。')

    await page.getByLabel('店').fill(store)
    // ホームの E2E(今月の合計)とぶつからないよう昔の月にする
    await page.getByLabel('日付').fill('2020-02-10')
    await page.getByLabel('支払い').selectOption('cash')
    const item = page.getByRole('group', { name: '品目 1' })
    await item.getByLabel('品名').fill('牛乳')
    await item.getByLabel('額(値引のあと)').fill('1,200')
    await item.getByLabel('費目').selectOption({ label: '食費' })
    await item.getByRole('button', { name: '閉じる' }).click()
    await expect(page.locator('.savebar .big')).toHaveText('¥1,200')
    await page.getByRole('button', { name: '保存する' }).click()
    await expect(page).toHaveURL(/\/capture$/)

    // 保存した下書きを開くと支出を直す画面へ(V4 → V6)
    await page.goto(`/receipts/${receiptId}`)
    await expect(page).toHaveURL(/\/expenses\/\d+$/)
    await expect(page.getByRole('heading', { name: '支出を直す' })).toBeVisible()
    await expect(page.getByLabel('店')).toHaveValue(store)
    await page.getByRole('button', { name: /^牛乳/ }).click()
    await page.getByRole('group', { name: '品目 1' }).getByLabel('額(値引のあと)').fill('1500')
    await page.getByRole('button', { name: '変更を保存' }).click()
    await expect(page).toHaveURL(/\/list$/)

    const r = (await (await page.request.get(`/api/receipts/${receiptId}`)).json()) as { expenseId: number }
    const e = (await (await page.request.get(`/api/expenses/${r.expenseId}`)).json()) as { amount: number; storeName: string }
    expect(e).toMatchObject({ amount: 1500, storeName: store })

    // 消すと下書きに戻る
    await page.goto(`/expenses/${r.expenseId}`)
    await page.getByRole('button', { name: 'この支出を消す' }).click()
    const dialog = page.getByRole('dialog', { name: 'この支出を消しますか?' })
    await expect(dialog.getByRole('button', { name: 'やめる' })).toBeFocused()
    await dialog.getByRole('button', { name: '消す' }).click()
    await expect(page).toHaveURL(/\/list$/)
    expect(((await (await page.request.get(`/api/receipts/${receiptId}`)).json()) as { expenseId: number | null }).expenseId).toBeNull()
  } finally {
    await page.request.delete(`/api/receipts/${receiptId}`, { headers: { origin } })
  }
})

test('手で入力して保存すると撮るに戻る', async ({ page }) => {
  await page.goto('/expenses/new')
  await expect(page.getByRole('heading', { name: '手で入力' })).toBeVisible()
  const item = page.getByRole('group', { name: '品目 1' })
  await expect(item.getByLabel('費目')).toHaveValue(/\d+/) // 未分類
  await page.getByLabel('日付').fill('2020-02-10')
  await page.getByLabel('支払い').selectOption('cash')
  await item.getByLabel('額(値引のあと)').fill('300')
  const posted = page.waitForResponse((r) => r.url().endsWith('/api/expenses') && r.request().method() === 'POST')
  await page.getByRole('button', { name: '保存する' }).click()
  const { id } = (await (await posted).json()) as { id: number }
  await expect(page).toHaveURL(/\/capture$/)
  expect((await page.request.delete(`/api/expenses/${id}`, { headers: { origin: new URL(page.url()).origin } })).status()).toBe(204)
})
