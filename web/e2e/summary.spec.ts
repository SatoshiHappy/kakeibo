// 推移と総計(データと照合 §4.1・§4.4・表 G)
import { expect, test } from '@playwright/test'
import { currentMonth, monthLabel } from '../src/lib/format'

test('推移: 期間を選ぶと表の月の数が変わり、月を押すとその月の内訳になる', async ({ page }) => {
  await page.goto('/trend')
  const table = page.getByRole('region', { name: '月ごとの表' })
  await expect(table.getByRole('row')).toHaveCount(1 + 6)
  await page.getByRole('button', { name: '12か月' }).click()
  await expect(table.getByRole('row')).toHaveCount(1 + 12)
  await expect(page.getByRole('region', { name: `${monthLabel(currentMonth())}の内訳` })).toBeVisible()
  const prev = table.getByRole('row').nth(2).getByRole('button')
  const label = (await prev.textContent())!
  await prev.click()
  await expect(prev).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('region', { name: `${label}の内訳` })).toBeVisible()
})

test('総計: 種類ごとにまとめ、今年・去年・通算を選べる', async ({ page }) => {
  await page.goto('/totals')
  for (const name of ['臨時', '毎月変わる', '固定費']) await expect(page.getByRole('region', { name })).toBeVisible()
  await expect(page.getByText(/医療費控除の目安/)).toBeVisible()
  await page.getByRole('button', { name: '通算' }).click()
  await expect(page.getByText('記録のすべて。')).toBeVisible()
  await expect(page.getByText(/医療費控除の目安/)).toHaveCount(0)
  await expect(page.getByRole('region', { name: '固定費' }).getByText('家賃')).toBeVisible()
})
