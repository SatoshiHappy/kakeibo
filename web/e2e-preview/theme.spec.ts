// 本番のビルド(CSP 付き): 明暗の小さな script(index.html。基盤 §2.2 の表 Y)が CSP に止められず、
// 画面の JS を読む前(最初の描画)に表 Y の各行どおりに当たる。ホーム画面のアプリの manifest も読める
import { expect, test } from '@playwright/test'

const LIGHT = 'rgb(243, 244, 242)'
const DARK = 'rgb(18, 21, 19)'
const ROWS = [
  { row: 'Y1', stored: null, system: 'light', ground: LIGHT, meta: 'light dark' },
  { row: 'Y2', stored: null, system: 'dark', ground: DARK, meta: 'light dark' },
  { row: 'Y3', stored: 'light', system: 'dark', ground: LIGHT, meta: 'light' },
  { row: 'Y4', stored: 'dark', system: 'light', ground: DARK, meta: 'dark' },
  { row: 'Y5', stored: 'Dark', system: 'dark', ground: DARK, meta: 'light dark' },
] as const

for (const r of ROWS) {
  test(`${r.row}: 画面の JS を読む前に index.html の script が当て、CSP の違反が出ない`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: r.system })
    await page.goto('/manifest.webmanifest') // 同じオリジンで localStorage を書くため
    await page.evaluate((v) => (v === null ? localStorage.removeItem('color-scheme') : localStorage.setItem('color-scheme', v)), r.stored)
    const violations: string[] = [] // 画面を読み込む間の CSP の違反だけを数える
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to execute/i.test(m.text())) violations.push(m.text())
    })
    await page.route('**/assets/*.js', (route) => route.abort()) // theme.ts を動かさず、index.html の script だけを見る
    await page.goto('/?_login=1') // Service Worker を通さず網から読む
    expect(await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')!.content)).toBe(r.meta)
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(r.ground)
    expect(violations).toEqual([])
  })
}

test('manifest はホーム画面のアプリ(standalone)で開く形', async ({ page }) => {
  const res = await page.request.get('/manifest.webmanifest')
  expect(res.status()).toBe(200)
  expect((await res.json()).display).toBe('standalone')
})
