// 確かめるの L1・L2・L4 のカードの操作(データと照合 表 L・§4.9)。口の規則は test/review.test.ts が守るので、
// ここは画面が押したボタンどおりの要求を送り、カードを消すかだけを見る。明細の行は消せない(手元の D1 に残る)ので、
// GET /api/review を差し替え、操作の要求は受け取って記録するだけにする
import { expect, test, type Page } from '@playwright/test'

const methods = [{ code: 'rakuten_card', label: '楽天カード' }]
const charge = (id: number, usedOn: string, amount: number) => ({ id, usedOn, merchant: `明細店${id}`, cardUser: '本人', amount })
const expense = (id: number, spentOn: string, amount: number) => ({ id, spentOn, storeName: `支出店${id}`, paymentMethod: 'rakuten_card', amount })

async function stub(page: Page) {
  let items: unknown[] = [
    { type: 'row_candidates', charge: charge(1, '2025-09-10', 1200), candidates: [expense(11, '2025-09-09', 1200), expense(12, '2025-09-12', 1200)] },
    { type: 'merge_candidates', expense: expense(21, '2025-09-15', 3300), charges: [charge(2, '2025-09-15', 3300)] },
    { type: 'diff', expense: expense(31, '2025-09-20', 5000), diff: -100, charges: [charge(3, '2025-09-20', 4900)] },
    { type: 'diff', expense: expense(41, '2025-09-21', 800), diff: 20, charges: [charge(4, '2025-09-21', 820)] },
  ]
  const sent: { path: string; body: unknown }[] = []
  await page.route('**/api/review', (route) => route.fulfill({ json: { items, paymentMethods: methods } }))
  await page.route('**/api/review/*', async (route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.fallback()
    const path = new URL(req.url()).pathname
    const body = req.postDataJSON() as { chargeId?: number; expenseId?: number }
    sent.push({ path, body })
    // 操作を受けたカードを、次の読み込みから外す
    items = items.filter((it) => {
      const i = it as { charge?: { id: number }; expense?: { id: number } }
      const hit = (body.chargeId !== undefined && i.charge?.id === body.chargeId) || (body.expenseId !== undefined && i.expense?.id === body.expenseId)
      return !hit
    })
    await route.fulfill({ json: {} })
  })
  return sent
}

test('L1・L2・L4 のカード: 押したボタンどおりの要求を送り、カードが消える', async ({ page }) => {
  const sent = await stub(page)
  await page.goto('/review')

  const l1 = page.getByRole('region', { name: 'この明細は、どの支出の分?' })
  await expect(l1.getByText('同じ額で日付の近い支出が 2 件あります。')).toBeVisible()
  await l1.getByRole('button', { name: 'B と結ぶ' }).click()
  await expect(l1).toHaveCount(0)

  const l2 = page.getByRole('region', { name: '明細から作った支出に、レシートが来ました' })
  await l2.getByRole('button', { name: '別の買い物' }).click()
  await expect(l2).toHaveCount(0)

  const l4a = page.getByRole('region', { name: '金額が ¥100 違います' })
  await l4a.getByRole('button', { name: '¥5,000 のまま確認済み' }).click()
  await expect(l4a).toHaveCount(0)

  // 「レシートを直す」は確かめて保存へ移るだけ(要求は送らない)
  const l4b = page.getByRole('region', { name: '金額が ¥20 違います' })
  await l4b.getByRole('button', { name: 'レシートを直す' }).click()
  await expect(page).toHaveURL(/\/expenses\/41\?from=review$/)

  expect(sent).toEqual([
    { path: '/api/review/link', body: { chargeId: 1, expenseId: 12 } },
    { path: '/api/review/reject', body: { chargeId: 2, expenseId: 21 } },
    { path: '/api/review/ack-diff', body: { expenseId: 31, diff: -100 } },
  ])
})

test('L1 の「どれでもない」は明細の行だけを送る', async ({ page }) => {
  const sent = await stub(page)
  await page.goto('/review')
  const l1 = page.getByRole('region', { name: 'この明細は、どの支出の分?' })
  await l1.getByRole('button', { name: 'どれでもない' }).click()
  await expect(l1).toHaveCount(0)
  expect(sent).toEqual([{ path: '/api/review/none', body: { chargeId: 1 } }])
})
