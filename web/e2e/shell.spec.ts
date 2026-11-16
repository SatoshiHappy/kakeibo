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

test('画面は時刻の帯(safe-area の上)の下から始まる: 上の帯が開いた直後から隠れない', async ({ page }) => {
  // WebKit の試験では safe-area を作れないので、画面の外枠の規則が safe-area の上の余白を持つことを CSSOM で確かめる
  await page.goto('/')
  const padding = await page.evaluate(() => {
    for (const sheet of [...document.styleSheets].filter((s) => !s.href || new URL(s.href).origin === location.origin)) {
      for (const rule of [...sheet.cssRules]) if (rule instanceof CSSStyleRule && rule.selectorText === '.screen') return rule.style.getPropertyValue('padding-top')
    }
    return null
  })
  expect(padding).toContain('safe-area-inset-top')
})

test('下のタブが無い画面は下の safe-area を空け、保存の帯の画面は帯が空ける(いちばん下の行がホームバーに重ならない)', async ({ page }) => {
  await page.goto('/menu')
  const rules = await page.evaluate(() => {
    const found: Record<string, string> = {}
    for (const sheet of [...document.styleSheets].filter((s) => !s.href || new URL(s.href).origin === location.origin)) {
      for (const rule of [...sheet.cssRules]) if (rule instanceof CSSStyleRule) found[rule.selectorText] = rule.style.getPropertyValue('padding-bottom')
    }
    return found
  })
  expect(rules['.screen > main:last-child']).toContain('safe-area-inset-bottom')
  expect(rules['.screen > main:has(> .savebar)']).toBe('0px')
  // タブの無い画面では main が最後(規則が当たる)
  expect(await page.locator('.screen > main').evaluate((m) => m.matches(':last-child'))).toBe(true)
  await page.goto('/expenses/new')
  await expect(page.locator('.savebar')).toBeVisible()
  expect(await page.locator('.screen > main').evaluate((m) => getComputedStyle(m).paddingBottom)).toBe('0px')
})

test('下のタブの画面はいちばん上にアプリの題「家計簿」を出し、メニューから開く画面には出さない', async ({ page }) => {
  for (const p of ['/', '/capture', '/list', '/stock']) {
    await page.goto(p)
    await expect(page.locator('.apphead')).toHaveText('家計簿')
    const [head, bar] = await Promise.all([page.locator('.apphead').boundingBox(), page.locator('.bar-top').first().boundingBox()])
    expect(head!.y + head!.height).toBeLessThanOrEqual(bar!.y + 1)
  }
  await page.goto('/menu')
  await expect(page.locator('.apphead')).toHaveCount(0)
})
