// 画面の側の単体テスト(計算と規則だけ。DOM を使わない)。Worker の結合テストは vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
