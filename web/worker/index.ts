import { app } from './app'
import { runStockAlerts } from './notify'
import { runRecurring } from './recurring'
import type { Bindings } from './types'

export default {
  fetch: app.fetch,
  // 毎日の判定(Cron Trigger)。毎月決まった支出を作り(データと照合の表 Q)、その後に在庫の通知を判定する(基盤 §7)。
  // Access と §3.1 の判定を通らない入口は、HTTP の口を持たないここだけ
  async scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime)
    ctx.waitUntil(runRecurring(env, now).then(() => runStockAlerts(env, now)).then(() => undefined))
  },
} satisfies ExportedHandler<Bindings>
