// 画面の明暗(基盤 §2.2 の表 Y)。≡ のメニューで選ぶと端末の明暗より優先し、開き直しても残る
import { expect, test, type Page } from '@playwright/test'

const ground = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
const LIGHT = 'rgb(243, 244, 242)'
const DARK = 'rgb(18, 21, 19)'

test('ダークを選ぶと端末がライトでもダークになり、開き直しても残る。自動に戻すと端末に従う', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/menu')
  const group = page.getByRole('group', { name: '画面の明るさ(この端末)' })
  await expect(group.getByRole('button', { name: /^自動/ })).toHaveAccessibleName(/今はライト/)
  await expect(group.getByRole('button', { name: /^自動/ })).toHaveAttribute('aria-pressed', 'true')
  expect(await ground(page)).toBe(LIGHT)

  await group.getByRole('button', { name: 'ダーク' }).click()
  await expect(group.getByRole('button', { name: 'ダーク' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => ground(page)).toBe(DARK)

  await page.reload()
  await expect(page.getByRole('button', { name: 'ダーク' })).toHaveAttribute('aria-pressed', 'true')
  expect(await ground(page)).toBe(DARK)

  await page.getByRole('button', { name: /^自動/ }).click()
  await expect.poll(() => ground(page)).toBe(LIGHT)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.getByRole('button', { name: /^自動/ })).toHaveAccessibleName(/今はダーク/)
  await expect(page.getByRole('button', { name: /^自動/ })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => ground(page)).toBe(DARK)
})

test('ほかのタブで選んだ明暗が、メニュー以外の画面を開いているタブにも当たる', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  const other = await context.newPage()
  await other.goto('/menu')
  await other.getByRole('button', { name: 'ダーク' }).click()
  await expect.poll(() => ground(page)).toBe(DARK)
  await other.getByRole('button', { name: /^自動/ }).click()
  await expect.poll(() => ground(page)).toBe(LIGHT)
})

test('明暗の選びの見た目が、推移の期間の切り替え(同じ .seg)を崩さない: 3 つが横いっぱいに等分に並ぶ', async ({ page }) => {
  for (const path of ['/menu', '/trend']) {
    await page.goto(path)
    const group = page.getByRole('group', { name: path === '/menu' ? '画面の明るさ(この端末)' : '期間' })
    const boxes = await group.getByRole('button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))
    const outer = (await group.boundingBox())!.width
    expect(boxes).toHaveLength(3)
    for (const w of boxes) expect(Math.abs(w - boxes[0]!)).toBeLessThan(1)
    expect(boxes.reduce((a, b) => a + b, 0)).toBeGreaterThan(outer * 0.9)
  }
})
