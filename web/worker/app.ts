import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import { authenticate } from './auth'
import { mcpHandler } from './mcp'
import { expenses } from './routes/expenses'
import { expenseForm } from './routes/expenseForm'
import { home } from './routes/home'
import { master } from './routes/master'
import { receipts } from './routes/receipts'
import { review } from './routes/review'
import { statements } from './routes/statements'
import { push } from './routes/push'
import { stock } from './routes/stock'
import type { AppEnv } from './types'

export const app = new Hono<AppEnv>().basePath('/api')

// 応答の見出し(nosniff・frame の禁止・HSTS など。Hono の既定)。認証より前に掛け、断る応答にも付ける。画面のファイルの見出しは public/_headers
app.use('*', secureHeaders())
// すべての /api/* に掛ける。例外の経路を作らない(基盤 §3.1)
app.use('*', authenticate)

app.get('/me', (c) => {
  const user = c.get('user')
  return c.json({ id: user.id, email: user.email, displayName: user.display_name })
})

app.route('/receipts', receipts)
app.route('/expenses', expenses)
app.route('/statements', statements)
app.route('/review', review)
app.route('/stock', stock)
app.route('/push', push)
app.route('/home', home)
app.route('/expense-form', expenseForm)
app.route('/', master)
// Claude Code からの入力の口(基盤 §5)。中から上の API を呼ぶ
app.post('/mcp', mcpHandler(app))
// 状態を持たない形なので、POST のほか(待ち受けの GET・終わりの DELETE など)は受けない(MCP の Streamable HTTP の規定どおり 405)
app.all('/mcp', (c) => c.body(null, 405, { Allow: 'POST' }))

app.notFound((c) => c.json({ error: 'not_found' }, 404))

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  // 中身(要求の値)は出さず、種類だけを記録する(基盤 §4)
  console.error('unhandled', err.name)
  return c.json({ error: 'internal' }, 500)
})
