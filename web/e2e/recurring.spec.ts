// 毎月決まった支出の画面(データと照合 §4.12)。足す → 一覧に出る → 直す → 止めると消える
import { expect, test } from '@playwright/test'

test('毎月決まった支出を足して直し、止めると一覧から消える', async ({ page }, info) => {
  const name = `E2E 家賃 ${info.project.name} ${crypto.randomUUID().slice(0, 6)}`
  await page.goto('/settings')
  await page.getByRole('link', { name: /毎月決まった支出/ }).click()
  await expect(page.getByRole('heading', { name: '毎月決まった支出' })).toBeVisible()

  await page.getByRole('button', { name: '+ 足す' }).click()
  const dialog = page.getByRole('dialog', { name: '毎月決まった支出を足す' })
  await dialog.getByLabel('名前(一覧の店の欄)').fill(name)
  await dialog.getByLabel('額(円)').fill('101500')
  await dialog.getByLabel('費目').selectOption({ label: '家賃' })
  await expect(dialog.getByLabel('支払い方法')).toHaveValue('bank_transfer')
  await dialog.getByLabel('毎月の日(その月に無い日は月末)').fill('27')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  const row = page.getByRole('button', { name: new RegExp(name) })
  await expect(row).toContainText('¥101,500')
  await expect(row).toContainText('毎月 27 日')

  await row.click()
  const edit = page.getByRole('dialog', { name: '毎月決まった支出を直す' })
  await edit.getByLabel('額(円)').fill('99000')
  await edit.getByRole('button', { name: '保存' }).click()
  await expect(edit).toBeHidden({ timeout: 15_000 })
  await expect(row).toContainText('¥99,000', { timeout: 15_000 })

  await row.click()
  await page.getByRole('dialog', { name: '毎月決まった支出を直す' }).getByRole('button', { name: /止める/ }).click()
  await page.getByRole('dialog', { name: 'この毎月決まった支出を止めますか?' }).getByRole('button', { name: '止める', exact: true }).click()
  await expect(row).toHaveCount(0, { timeout: 15_000 })
})
