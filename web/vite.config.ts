import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { DEV_AUD, DEV_PORT, DEV_TEAM_DOMAIN, devAccess } from './dev/access-plugin.ts'

export default defineConfig(({ command }) => ({
  // 開発サーバーは開発用のログインの公開鍵の置き場と同じ所で待つ(dev/access-plugin.ts)
  server: { host: '127.0.0.1', port: DEV_PORT, strictPort: true },
  plugins: [
    devAccess(),
    react(),
    cloudflare(
      command === 'serve'
        ? // 開発だけ: チームのドメインを開発サーバーに向ける(ビルドでは wrangler.jsonc のまま)
          { config: (c) => ({ vars: { ...c.vars, ACCESS_TEAM_DOMAIN: DEV_TEAM_DOMAIN, ACCESS_AUD: DEV_AUD } }) }
        : {},
    ),
  ],
}))
