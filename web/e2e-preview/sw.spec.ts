// 本番のビルド: 表 K の K2 → K3 と、Service Worker が画面と /assets/* を端末に置くこと(基盤 §2.3 の 1)
import { expect, test } from '@playwright/test'

test('K2 → K3: 401 で _login=1 を付けて Service Worker を通さず読み直し、また 401 なら帯を出して止まる', async ({ page }) => {
  // 読み込みの要求を数える(framenavigated は WebKit で 1 回の読み込みに 2 回出るので使わない)
  const navigations: string[] = []
  page.on('request', (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigations.push(new URL(r.url()).pathname + new URL(r.url()).search)
  })
  await page.goto('/menu')
  // 本番のビルドの初回は Service Worker を入れながら読み直すので、帯が出るまで長めに待つ
  await expect(page.getByText('ログインを確かめられません')).toBeVisible({ timeout: 20_000 })
  expect(navigations).toContain('/menu?_login=1')
  await expect(page).toHaveURL(/\/menu$/) // 読み込んだ後に _login を消す
  // 再読み込みは 1 回だけ(続けて読み直さない)
  await page.waitForTimeout(1500)
  expect(navigations.filter((n) => n === '/menu?_login=1').length).toBe(1)
})

test('Service Worker が画面の HTML と、それが指す /assets/* を端末に置く', async ({ page }) => {
  await page.goto('/')
  // 画面は API が 401 なので K2 で読み直す。落ち着く(K3 の帯が出る)まで待ってから調べる
  await expect(page.getByText('ログインを確かめられません')).toBeVisible({ timeout: 20_000 })
  await page.evaluate(() => navigator.serviceWorker.ready)
  await expect
    .poll(async () => page.evaluate(async () => (await (await caches.open('kakeibo-shell-v1')).keys()).map((r) => new URL(r.url).pathname).sort()))
    .toEqual(expect.arrayContaining(['/', expect.stringMatching(/^\/assets\/index-.*\.js$/), expect.stringMatching(/^\/assets\/index-.*\.css$/)]))
})
