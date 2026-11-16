// 画面の明暗(基盤 §2.2 の表 Y)。≡ のメニューで選ぶと端末の明暗より優先し、開き直しても残る
import { expect, test, type Page } from '@playwright/test'

const ground = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
const LIGHT = 'rgb(243, 244, 242)'
const DARK = 'rgb(18, 21, 19)'

test('ダークを選ぶと端末がライトでもダークになり、開き直しても残る。自動に戻すと端末に従う', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/menu')
  const group = page.getByRole('group', { name: '画面の明るさ(この端末)' })
  await expect(group.getByRole('radio', { name: '自動(今はライト)' })).toBeChecked()
  expect(await ground(page)).toBe(LIGHT)

  await group.getByText('ダーク', { exact: true }).click()
  await expect(group.getByRole('radio', { name: 'ダーク' })).toBeChecked()
  await expect.poll(() => ground(page)).toBe(DARK)

  await page.reload()
  await expect(page.getByRole('radio', { name: 'ダーク' })).toBeChecked()
  expect(await ground(page)).toBe(DARK)

  await page.getByText('自動(今はライト)').click()
  await expect.poll(() => ground(page)).toBe(LIGHT)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.getByRole('radio', { name: '自動(今はダーク)' })).toBeChecked()
  await expect.poll(() => ground(page)).toBe(DARK)
})

test('ほかのタブで選んだ明暗が、メニュー以外の画面を開いているタブにも当たる', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  const other = await context.newPage()
  await other.goto('/menu')
  await other.getByText('ダーク', { exact: true }).click()
  await expect.poll(() => ground(page)).toBe(DARK)
  await other.getByText(/^自動/).click()
  await expect.poll(() => ground(page)).toBe(LIGHT)
})
