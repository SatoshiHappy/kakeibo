# web/ の実装の規約

正本: `../docs/仕様/要求.md`・`../docs/設計/基盤.md`・`../docs/設計/データと照合.md`。画面の見本はモック 14 版(生成元 `../docs/work/2026111501_方針検討/outputs/モック_スマホ版_生成.py`)。

## 検査のコマンド(完了の前に全部走らせる)
- `npm test` = 表の行の検査 → Worker の結合テスト(`test/`)→ 画面の単体テスト(`src/**/*.test.ts`)
- `npm run typecheck`(`tsc -b`)・`npm run lint`(`oxlint`)
- `npm run e2e` = 開発サーバーを相手にする E2E(`e2e/`。WebKit の 390px・402px)→ 本番のビルドを相手にする E2E(`e2e-preview/`。Service Worker と表 K)。WebKit は WSL に OS のライブラリが要る(入れ済み。入れ直すなら `sudo env "PATH=$PATH" npx playwright install-deps webkit`)

## 選んだ部品(途中で変えない。基盤 §2)
| 役目 | 部品 |
|---|---|
| API | Hono(`worker/`)。入力の検査は zod |
| 画面 | React 19 + Vite(`src/`) |
| 画面の行き先 | React Router 7 の `createBrowserRouter`(`src/router.tsx`)。loader・action は使わない(データ取得は TanStack Query だけ) |
| データ取得 | TanStack Query 5。最後の応答を IndexedDB(idb-keyval)に残す(`@tanstack/react-query-persist-client`。`src/lib/query.ts`) |
| グラフ | Recharts |
| Web Push | `@block65/webcrypto-web-push`(`worker/notify.ts`) |
| E2E | Playwright の WebKit(390px・402px。基盤 §6) |
| Service Worker | 自前の `public/sw.js`(部品を足さない)。本番のビルドだけで登録する |

## API の呼び方
- 画面から API を呼ぶのは `src/lib/query.ts` の `api.request` と `useApiQuery` だけ。`fetch` を直接書かない(401 の扱い = 基盤の表 K を 1 か所に保つ)。
- 1 つの画面は API 1 回で出す(基盤 §2.3)。足りなければ画面用の口を Worker に足す。
- 保存は押した時点で画面に出し(`useMutation` の `onMutate` で cache を直す)、失敗したら `onError` で戻して知らせる(基盤 §2.3)。
- 保存の後の読み直しは `refetchAfterSave`(`src/lib/query.ts`)で行う。`invalidateQueries` だけだと、最初の読み込みの途中に保存したとき保存の前の内容が出たままになる。
- 口が断る誤り(名前の重なり・配る先の無い外税など)をその場で直させる入力(品物の小窓・確かめて保存)の保存は、応答を待ってから閉じる・移る(誤りは入力の中に出す。データと照合 §4.7)。
- 入力の画面は `api.registerDraftSaver` で、401 の再読み込みの前に下書きを IndexedDB に残す関数を登録する(基盤 §3.2)。
- 応答の形を変えたら `src/lib/query.ts` の `CACHE_VERSION` を上げる(端末に残った古い形を捨てる)。
- IndexedDB に Blob を入れない(WebKit の使い捨ての環境で入らない)。写真などは `ArrayBuffer` にして置く(`src/lib/trayStore.ts`)。
- `public/sw.js` を変えたら、その中の `CACHE` の名前を上げる。`/api/*`・`/cdn-cgi/*` と、`_login` の付いた読み込み(表 K)は Service Worker に通させない(基盤 §2.3 の 1)。

## 画面の書き方
- 外のもの(字体・画像・スクリプト)を読み込みに足すときは、`public/_headers` の CSP も直す(本番のビルドの E2E が CSP 付きで走る。基盤 §3.2)。
- 対象のブラウザ: iPhone の Safari 26(ホーム画面に追加したアプリ)。Baseline でない機能は、modern-web-guidance の手引きの代わりの書き方に従う。
- 画面の HTML・CSS・ブラウザ側の JS を書く前に、modern-web-guidance のスキルで手引きを引く。
- 色・字・角丸は `src/styles.css` のトークン(`--bg`・`--fg`・`--c1` など)だけを使う。色を直書きしない。ダークは端末の設定に従う(切り替えは置かない)。
- 入力欄の字は 16px、押す所は 44px 四方以上(`--target-size`)。アイコンだけの押す所には `aria-label`。
- 画面は `src/components/Shell.tsx` の `Screen`・`TopBar` で組む。下のタブはホーム・撮る・一覧・在庫の 4 つ、ほかは ≡ のメニュー(基盤 §2.2)。

## テスト
- 業務の規則は API 側に置き、`test/` の結合テストで守る(`@cloudflare/vitest-plugin`)。
- 画面が応答から作る規則(表 G・表 H など)は、計算だけの関数にして `src/**/*.test.ts` で通す(DOM を使わない)。
- デシジョン表の行は、テストの題に行の番号をそのまま書く(`C13`・`K2`。数字だけの表は `A-1 の 2 行`)。`scripts/check-table-rows.mjs` が `npm test` の前に漏れを見つける。

## 開発
- 初回: `npm run dev:setup`(ローカルの D1 に表を作り、開発の利用者 `dev@example.com` を入れる)。
- `npm run dev` → http://127.0.0.1:5173 (`DEV_PORT=5174` で変えられる。E2E も同じ変数を見る)。開発用のログイン(`dev/access-plugin.ts`)が `/api/*` に自前の鍵で署名した証明を付け、Worker は本番と同じ検証を通す。本番のビルドには入らない。
- 秘密(API キー・VAPID の秘密鍵)は `wrangler secret` と `.dev.vars` だけに置く(どちらも git に入れない)。
