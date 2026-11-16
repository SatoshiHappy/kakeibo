// 撮る(基盤 §6 の主な流れ「レシートを送る」・データと照合 §2.1 の前置き)。写真から選ぶの入力に JPEG を 2 枚入れ、2 枚目を「前の続き」にして 1 枚のレシートとして送る
import { expect, test, type Page } from '@playwright/test'

/** 画面の canvas で作った JPEG(createImageBitmap で読める本物の画像) */
async function jpeg(page: Page, color: string) {
  const data = await page.evaluate(async (c) => {
    const canvas = document.createElement('canvas')
    canvas.width = 300
    canvas.height = 400
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = c
    ctx.fillRect(0, 0, 300, 400)
    return canvas.toDataURL('image/jpeg', 0.9)
  }, color)
  return Buffer.from(data.split(',')[1]!, 'base64')
}

test('並べた写真は読み込み直しても残り、「前の続き」で 1 枚のレシートにつないで送ると下書きになる', async ({ page }) => {
  await page.goto('/capture')
  await expect(page.locator('input[type=file][capture=environment]')).toHaveCount(1)
  const files = [
    { name: 'a.jpg', mimeType: 'image/jpeg', buffer: await jpeg(page, '#c33') },
    { name: 'b.jpg', mimeType: 'image/jpeg', buffer: await jpeg(page, '#33c') },
  ]
  await page.locator('input[type=file][multiple]').setInputFiles(files)
  const tray = page.getByRole('region', { name: /送る前の写真/ })
  await expect(tray.getByRole('heading')).toContainText('送る前の写真(2)')
  await expect(tray.getByRole('heading')).toContainText('レシート 2 枚')

  await page.reload()
  await expect(tray.getByRole('heading')).toContainText('送る前の写真(2)')

  await tray.getByRole('checkbox', { name: '前の続き' }).check()
  await expect(tray.getByRole('heading')).toContainText('レシート 1 枚')
  await expect(tray.getByText('レシート 1 の続き')).toBeVisible()

  const posted = page.waitForResponse((r) => r.url().endsWith('/api/receipts') && r.request().method() === 'POST')
  await tray.getByRole('button', { name: '送る(レシート 1 枚)' }).click()
  const { id } = (await (await posted).json()) as { id: number }
  try {
    await expect(tray).toBeHidden()
    const card = page.locator(`[href="/receipts/${id}"], .draft:has(img[src="/api/receipts/${id}/images/1"])`).first()
    await expect(card).toContainText('2 枚')
    const detail = (await (await page.request.get(`/api/receipts/${id}`)).json()) as { images: { stored: boolean }[] }
    expect(detail.images).toEqual([
      { position: 1, stored: true },
      { position: 2, stored: true },
    ])
  } finally {
    // 本文の無い DELETE は CSRF の検査に掛かる(基盤 §3.1)ので、画面と同じく Origin を付ける
    expect((await page.request.delete(`/api/receipts/${id}`, { headers: { origin: new URL(page.url()).origin } })).status()).toBe(204)
  }
})
