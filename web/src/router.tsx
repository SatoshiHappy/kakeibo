// 画面の行き先(React Router のデータの無い使い方。データ取得は TanStack Query だけ = web/CLAUDE.md)
import { createBrowserRouter } from 'react-router'
import { Capture } from './pages/Capture'
import { EditExpenseForm, NewExpenseForm, ReceiptForm } from './pages/ExpenseForm'
import { Home } from './pages/Home'
import { Import } from './pages/Import'
import { List } from './pages/List'
import { RecurringPage } from './pages/Recurring'
import { Placeholder } from './pages/Placeholder'
import { Prefs } from './pages/Prefs'
import { Review } from './pages/Review'
import { Settings } from './pages/Settings'
import { Stock } from './pages/Stock'
import { Totals } from './pages/Totals'
import { Trend } from './pages/Trend'

export const router = createBrowserRouter([
  // 下のタブ(ホーム・撮る・一覧・在庫・設定)
  { path: '/', element: <Home /> },
  { path: '/capture', element: <Capture /> },
  { path: '/list', element: <List /> },
  { path: '/stock', element: <Stock /> },
  // 撮る画面から
  { path: '/receipts/:id', element: <ReceiptForm /> },
  { path: '/expenses/new', element: <NewExpenseForm /> },
  // 一覧から
  { path: '/expenses/:id', element: <EditExpenseForm /> },
  { path: '/settings', element: <Settings /> },
  // 設定から
  { path: '/recurring', element: <RecurringPage /> },
  { path: '/review', element: <Review /> },
  { path: '/trend', element: <Trend /> },
  { path: '/totals', element: <Totals /> },
  { path: '/import', element: <Import /> },
  { path: '/prefs', element: <Prefs /> },
  { path: '*', element: <Placeholder title="見つかりません" tabs /> },
])
