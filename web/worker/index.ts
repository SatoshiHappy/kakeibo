import { app } from './app'
import { runStockAlerts } from './notify'
import type { Bindings } from './types'

export default {
  fetch: app.fetch,
  // 在庫の通知の判定(Cron Trigger。基盤 §7)。Access と §3.1 の判定を通らない入口は、HTTP の口を持たないここだけ
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runStockAlerts(env, new Date(controller.scheduledTime)).then(() => undefined))
  },
} satisfies ExportedHandler<Bindings>
