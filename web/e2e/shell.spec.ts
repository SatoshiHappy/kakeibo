// 画面の外枠: 下のタブ(5 つ目が設定)・開発用のログインで API が通ること・横にスクロールしないこと(基盤 §2.1・§2.2)
import { expect, test } from '@playwright/test'

test('下のタブは 5 つ(5 つ目が設定)で、今いる画面に印が付く', async ({ page }) => {
  await page.goto('/')
  const tabs = page.getByRole('navigation', { name: '画面の切り替え' }).getByRole('link')
  await expect(tabs).toHaveText([/ホーム/, /撮る/, /一覧/, /在庫/, /設定/])
  await expect(tabs.first()).toHaveAttribute('aria-current', 'page')
  await tabs.nth(3).click()
  await expect(page).toHaveURL(/\/stock$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('消耗品の在庫')
  await expect(tabs.nth(3)).toHaveAttribute('aria-current', 'page')
})

test('設定のタブを開くと、ログイン中の利用者が出る(開発用のログインで API が通る)。設定から開いた画面は「設定に戻る」で戻る', async ({ page }) => {
  await page.goto('/')
  const tabs = page.getByRole('navigation', { name: '画面の切り替え' })
  await tabs.getByRole('link', { name: /設定/ }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('設定')
  await expect(tabs.getByRole('link', { name: /設定/ })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('開発', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: /費目と月の予算/ }).click()
  await page.getByRole('link', { name: '設定に戻る' }).click()
  await expect(page).toHaveURL(/\/settings$/)
})

test('確かめることの件数の印は設定のタブに付く', async ({ page }) => {
  await page.route('**/api/home**', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    await route.fulfill({ response: res, json: { ...body, reviewCount: 3 } })
  })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: '画面の切り替え' }).getByRole('link', { name: /設定/ })).toContainText('3')
  await expect(page.getByLabel('確かめること 3 件')).toBeVisible()
})

test('横にスクロールしない・押す所は 44px 以上', async ({ page }) => {
  await page.goto('/settings')
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
  await page.goto('/prefs')
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

test('アプリの題の行は出さず、上の帯がいちばん上に来る(2026-11-17 ユーザー指示)', async ({ page }) => {
  for (const p of ['/', '/capture', '/list', '/stock', '/settings']) {
    await page.goto(p)
    await expect(page.locator('.bar-top')).toBeVisible()
    expect((await page.locator('.bar-top').boundingBox())!.y).toBeLessThanOrEqual(1)
    await expect(page.getByText('家計簿', { exact: true })).toHaveCount(0)
  }
})

test('設定の画面は機能の種類の見出しで分かれ、よく使う順に並ぶ', async ({ page }) => {
  await page.goto('/settings')
  await expect(page.locator('.panel > h2')).toHaveText(['月ごとの作業', '振り返る', '家計簿の設定(家族で共通)', 'この iPhone'])
  await expect(page.getByRole('region', { name: '月ごとの作業' }).getByRole('link')).toHaveText([/確かめる/, /明細を取り込む/])
  await expect(page.getByRole('region', { name: 'この iPhone' }).getByRole('group', { name: '画面の明るさ' })).toBeVisible()
})

