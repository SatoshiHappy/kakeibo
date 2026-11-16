// Claude Code からの入力の口(MCP)。正本: docs/設計/基盤.md §5
// 道具は画面の API を Worker の中から呼ぶ薄い口にする。規則(検査・照合・按分)は API の 1 か所に置いたまま、ここに書き写さない。
// ログインの判定は /api/* の入口(auth.ts)がこの要求にも掛かり、中から呼ぶ API にも同じ JWT を渡して同じ判定を通す。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { createBody, expenseBody, itemCategoryBody } from './routes/expenses'
import { expectedFields } from './routes/statements'
import { month } from './schemas'
import type { AppEnv } from './types'

const expenseFields = expenseBody.shape

type Api = Hono<AppEnv>

/** 中の API の応答は JSON のはずだが、ミドルウェアが文字で返すこと(CSRF の 403 など)もある。読めなければ文字のまま返す。 */
export function jsonOrText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** 画面の API を、受けた要求と同じログインの証明で呼ぶ。 */
function caller(api: Api, c: Context<AppEnv>) {
  const origin = new URL(c.req.url).origin
  const jwt = c.req.header('cf-access-jwt-assertion') ?? ''
  return async (path: string, init: { method?: string; json?: unknown; form?: FormData } = {}): Promise<CallToolResult> => {
    const headers = new Headers({ 'cf-access-jwt-assertion': jwt, origin })
    let body: BodyInit | undefined
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(init.json)
    } else if (init.form) {
      body = init.form
    }
    const res = await api.request(`${origin}/api${path}`, { method: init.method ?? 'GET', headers, body }, c.env)
    const text = await res.text()
    const payload = { status: res.status, body: text === '' ? null : jsonOrText(text) }
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: res.status >= 400 }
  }
}

function buildServer(call: ReturnType<typeof caller>) {
  const server = new McpServer({ name: 'kakeibo', version: '1.0.0' })
  const read = { readOnlyHint: true }

  server.registerTool(
    'list_categories',
    { description: '費目の一覧(id・名前・やめたか)。支出の品目に付ける費目を選ぶときに読む。', annotations: read },
    () => call('/categories'),
  )
  server.registerTool(
    'list_payment_methods',
    { description: '支払い方法の一覧(code・名前)。', annotations: read },
    () => call('/payment-methods'),
  )
  server.registerTool(
    'list_expenses',
    { description: 'その月の支出の一覧。二重に入れないよう、追加の前に同じ日・同じ店・同じ額が無いかを確かめる。', inputSchema: { month }, annotations: read },
    ({ month }) => call(`/expenses?month=${month}`),
  )
  server.registerTool(
    'get_expense',
    { description: '支出 1 件(品目・値引き・結んだ明細の行)。', inputSchema: { id: z.number().int() }, annotations: read },
    ({ id }) => call(`/expenses/${id}`),
  )
  server.registerTool(
    'get_summary',
    { description: 'その月の費目ごとの額・予算・種類(kind: variable 毎月変わる・fixed 固定費・extra 臨時)。合計は返さない。ホームの合計は kind が variable の額の和。', inputSchema: { month }, annotations: read },
    ({ month }) => call(`/summary?month=${month}`),
  )
  server.registerTool(
    'add_expense',
    {
      description:
        '支出を 1 件足す(レシート画像は付かない)。品目ごとに費目を付ける。照合の規則は画面と同じに掛かる。clientRequestId が同じ要求は 1 件にしかならないので、送り直すときは同じ値を使う。',
      inputSchema: createBody.omit({ receiptId: true }).shape,
    },
    (args) => call('/expenses', { method: 'POST', json: { ...args, receiptId: null } }),
  )
  server.registerTool(
    'update_expense',
    {
      description: '人が入れた支出を直す(日付・店・支払い方法・品目・値引きを全部置き換える)。明細から作った支出は set_item_category で費目だけ直せる。',
      inputSchema: { id: z.number().int(), ...expenseFields },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ id, ...body }) => call(`/expenses/${id}`, { method: 'PUT', json: body }),
  )
  server.registerTool(
    'set_item_category',
    {
      description: '品目 1 つの費目を直す。どの支出(明細から作った未分類の支出を含む)にも使える。',
      inputSchema: { id: z.number().int().describe('支出の id'), position: z.number().int().describe('品目の位置(1 から)'), ...itemCategoryBody.shape },
      annotations: { idempotentHint: true },
    },
    ({ id, position, categoryId }) => call(`/expenses/${id}/items/${position}`, { method: 'PATCH', json: { categoryId } }),
  )
  server.registerTool(
    'delete_expense',
    { description: '人が入れた支出を取り消す。結んでいた明細の行は結ばれていない状態に戻る。', inputSchema: { id: z.number().int() }, annotations: { destructiveHint: true } },
    ({ id }) => call(`/expenses/${id}`, { method: 'DELETE' }),
  )
  server.registerTool(
    'import_statement_csv',
    {
      description:
        '楽天カードの明細 CSV(e-NAVI の「明細コピー用 Excel(CSV)」)を取り込む。ファイルの中身を一字も変えずに csv に入れる。' +
        '写し間違いを書く前に止めるため、expectedRows と expectedTotal を、csv を読んで暗算せずに、ファイルからコマンドで数えて渡す。' +
        'ファイルは各欄が二重引用符で囲まれ、店名や額("1,200")にカンマを含むので、カンマで単純に割らず CSV を読める道具(Python の csv など)で読み、額のカンマを除いて足す。' +
        '合わなければ何も書かずに 422(mismatch)になる。同じ月を何度取り込んでも二重にならない。',
      inputSchema: {
        csv: z.string().min(1).describe('CSV ファイルの中身(そのままの文字列)'),
        ...expectedFields,
      },
    },
    async ({ csv, expectedRows, expectedTotal }) => {
      const form = new FormData()
      form.set('file', new File([csv], 'statement.csv', { type: 'text/csv' }))
      form.set('expectedRows', String(expectedRows))
      form.set('expectedTotal', String(expectedTotal))
      return call('/statements', { method: 'POST', form })
    },
  )
  return server
}

/** POST /api/mcp。状態を持たない形(要求ごとにサーバーを作る)・JSON で応答する。 */
export function mcpHandler(api: Api) {
  return async (c: Context<AppEnv>) => {
    const server = buildServer(caller(api, c))
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(c.req.raw)
  }
}
