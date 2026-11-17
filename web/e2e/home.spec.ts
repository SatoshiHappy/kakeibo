// ホーム(基盤 §6 の主な流れ「ホームの合計」)。開発の D1 のデータによらず、画面の表示が同じ時点の API の応答と表 H に合うことを確かめる
import { expect, test } from '@playwright/test'
import { homeRows } from '../src/lib/categories'
import { currentMonth, yen } from '../src/lib/format'
import type { HomeResponse } from '../src/lib/home'

test('合計・予算の行・ほか・固定費・そろそろ買うが、API の応答から表 H で出した値と合う', async ({ page }) => {
  // 並んで走る E2E が同じ手元の D1 に支出を書くので、読んでから画面を出すまでに変わったら読み直してやり直す
  await expect(async () => {
    const data = (await (await page.request.get(`/api/home?month=${currentMonth()}`)).json()) as HomeResponse
    const rows = homeRows(data.categories)
    await page.goto('/')
    const summary = page.getByRole('region', { name: '毎月変わる支出' })
    // 待ちは短くし、合わなければ読み直してやり直す
    const quick = { timeout: 5_000 }
    await expect(summary.locator('.big')).toHaveText(yen(rows.variableTotal), quick)
    await expect(summary.locator('.ccard .name')).toHaveText([...rows.budgetRows.map((r) => r.name), ...(rows.other ? ['ほか'] : [])], quick)
    if (rows.fixed) await expect(summary.locator('.fixedline')).toContainText(yen(rows.fixed.amount), quick)
    const soon = page.getByRole('navigation', { name: '在庫アラート・要確認レシート' })
    await expect(soon.locator('.lsub .lname')).toHaveText(data.stockSoon.slice(0, 5).map((s) => s.name), quick)
  }).toPass({ timeout: 60_000 })
})

test('前の月へ移ると月が URL に入り、次の月へ戻ると今月(URL から消える)。今月より先へは進めない', async ({ page }) => {
  await page.goto('/')
  const next = page.getByRole('button', { name: '次の月' })
  await expect(next).toBeDisabled()
  await page.getByRole('button', { name: '前の月' }).click()
  await expect(page).toHaveURL(/\?month=\d{4}-\d{2}$/)
  await next.click()
  await expect(page).toHaveURL(/\/$/)
})
