// 本番のビルド(CSP 付き): 明暗の小さな script(基盤 §2.2 の表 Y)が CSP に止められず、最初の描画の前に当たる。
// ホーム画面のアプリの manifest も読める
import { expect, test } from '@playwright/test'

test('Y4: 残したダークが最初の描画から当たり、CSP の違反が出ない', async ({ page }) => {
  const violations: string[] = []
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to execute/i.test(m.text())) violations.push(m.text())
  })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('color-scheme', 'dark'))
  await page.goto('/?_login=1') // Service Worker を通さず網から読む
  expect(await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')!.content)).toBe('dark')
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(18, 21, 19)')
  expect(violations).toEqual([])

  const manifest = await page.request.get('/manifest.webmanifest')
  expect(manifest.status()).toBe(200)
  expect((await manifest.json()).display).toBe('standalone')
})
