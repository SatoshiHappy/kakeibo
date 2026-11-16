// 本番のビルド(vite build → vite preview)を相手にする E2E。開発用のログインが無いので API は 401 になる。
// 確かめるのは、Service Worker(基盤 §2.3 の 1)と、ログインが通らないときの表 K の K2 → K3 の流れ
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e-preview',
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4173', browserName: 'webkit', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  webServer: { command: 'npx vite build && npx vite preview --host 127.0.0.1 --port 4173 --strictPort', url: 'http://127.0.0.1:4173', reuseExistingServer: false, timeout: 180_000 },
})
