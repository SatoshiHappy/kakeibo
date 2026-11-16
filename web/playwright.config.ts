// E2E: WebKit を iPhone の幅(390px = iPhone 17e・402px = iPhone 17)で動かす(基盤 §2.1・§6)。
// 手元の Worker・D1 と開発用のログイン(dev/access-plugin.ts)で動く。初回は npm run dev:setup が要る
import { defineConfig } from '@playwright/test'

// 開発サーバーのポート(DEV_PORT。dev/access-plugin.ts と同じ既定)
const port = Number(process.env.DEV_PORT ?? 5173)
const phone = { browserName: 'webkit' as const, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'ja-JP' }

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  reporter: 'list',
  // GitHub Actions では 1 回だけやり直す(やり直して通ったものは結果に flaky と出る)。手元ではやり直さない
  retries: process.env.CI ? 1 : 0,
  // 手元の D1 は書き込み 1 回に約 0.6 秒かかり、2 つの端末の幅が同時に書くと順に待つ(2026-11-16 に測定)。既定の 5 秒では足りない
  expect: { timeout: 15_000 },
  // 同じ理由で、いくつもの画面を通る流れは既定の 30 秒を超えることがある
  timeout: 90_000,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: { command: 'npm run dev', url: `http://127.0.0.1:${port}`, reuseExistingServer: true, timeout: 120_000 },
  projects: [
    { name: 'iphone-17e-390', use: { ...phone, viewport: { width: 390, height: 844 } } },
    { name: 'iphone-17-402', use: { ...phone, viewport: { width: 402, height: 874 } } },
  ],
})
