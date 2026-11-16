// 画面の外枠: 下のタブ・≡ のメニュー・開発用のログインで API が通ること・横にスクロールしないこと(基盤 §2.1・§2.2)
import { expect, test } from '@playwright/test'

test('下のタブは 4 つで、今いる画面に印が付く', async ({ page }) => {
  await page.goto('/')
  const tabs = page.getByRole('navigation', { name: '画面の切り替え' }).getByRole('link')
  await expect(tabs).toHaveText(['ホーム', '撮る', '一覧', '在庫'])
  await expect(tabs.first()).toHaveAttribute('aria-current', 'page')
  await tabs.nth(3).click()
  await expect(page).toHaveURL(/\/stock$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('消耗品の在庫')
  await expect(tabs.nth(3)).toHaveAttribute('aria-current', 'page')
})

test('≡ のメニューを開くと、ログイン中の利用者が出る(開発用のログインで API が通る)', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'メニュー' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('メニュー')
  await expect(page.getByText('開発', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: '閉じる' }).click()
  await expect(page).toHaveURL(/\/$/)
})

test('横にスクロールしない・押す所は 44px 以上', async ({ page }) => {
  await page.goto('/menu')
  await expect(page.getByText('開発', { exact: true })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  for (const link of await page.getByRole('link').all()) {
    const box = (await link.boundingBox())!
    expect(box.height).toBeGreaterThanOrEqual(44)
  }
})
