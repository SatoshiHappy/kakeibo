// 費目と予算(データと照合 §4.11)。予算は入力欄を離れると保存し、費目の名前は小窓で直す。終わったら元に戻す
import { expect, test } from '@playwright/test'
import { currentMonth } from '../src/lib/format'

type Prefs = { categories: { id: number; name: string; budget: number | null }[] }

test('予算を入れて離れると保存し、空にすると予算なし。費目の名前を直せ、重なる名前は断られる', async ({ page }, info) => {
  // 390px と 402px が並んで走るので、端末の幅ごとに別の費目を使う
  const [id, name] = info.project.name.endsWith('390') ? [11, '教育'] : [12, '交際']
  const prefs = async () => ((await (await page.request.get(`/api/prefs?month=${currentMonth()}`)).json()) as Prefs).categories.find((c) => c.id === id)!
  await page.goto('/prefs')
  const origin = new URL(page.url()).origin
  try {
    const input = page.getByLabel(name, { exact: true })
    await input.fill('12,345')
    await input.blur()
    await expect.poll(async () => (await prefs()).budget).toBe(12345)
    await page.getByLabel(name, { exact: true }).fill('')
    await page.getByLabel(name, { exact: true }).blur()
    await expect.poll(async () => (await prefs()).budget).toBeNull()

    await page.getByRole('button', { name: '費目を直す' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: new RegExp(`^${name}(?!を[上下]へ)`) }).click()
    await dialog.getByLabel('名前').fill(`${name} E2E`)
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByLabel(`${name} E2E`, { exact: true })).toBeVisible()

    await page.getByRole('button', { name: '+ 費目を足す' }).click()
    await dialog.getByLabel('名前').fill('食費')
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('同じ名前の費目があります。')
    await dialog.getByRole('button', { name: 'やめる' }).click()
    await expect(dialog).toBeHidden()
  } finally {
    await page.request.patch(`/api/categories/${id}`, { headers: { origin }, data: { name } })
  }
})

test('費目の並びを ↑↓ で変えると、押したボタンにフォーカスが残り、口の並びも変わる', async ({ page }, info) => {
  // 並びは 1 つしかないので、片方の幅だけで走らせる
  test.skip(!info.project.name.endsWith('390'), '並びは全体で 1 つ')
  const ids = async () => ((await (await page.request.get('/api/categories')).json()) as { categories: { id: number; name: string }[] }).categories
  const before = await ids()
  await page.goto('/prefs')
  const origin = new URL(page.url()).origin
  try {
    const i = before.findIndex((c) => c.name === '趣味・娯楽')
    await page.getByRole('button', { name: '費目を直す' }).click()
    const dialog = page.getByRole('dialog')
    const up = dialog.getByRole('button', { name: '趣味・娯楽を上へ' })
    await up.click()
    await expect(up).toBeFocused()
    await expect(page.getByRole('status')).toHaveText(`趣味・娯楽を ${i} 番目にしました`)
    await expect.poll(async () => (await ids()).findIndex((c) => c.name === '趣味・娯楽')).toBe(i - 1)
    await dialog.getByRole('button', { name: '趣味・娯楽を下へ' }).click()
    await expect.poll(async () => (await ids()).map((c) => c.id)).toEqual(before.map((c) => c.id))
    // 続けて押しても、最後に押した並びが残る
    const down = dialog.getByRole('button', { name: '趣味・娯楽を下へ' })
    await down.click()
    await down.click()
    await expect.poll(async () => (await ids()).findIndex((c) => c.name === '趣味・娯楽')).toBe(i + 2)
  } finally {
    await page.request.put('/api/categories/order', { headers: { origin }, data: { ids: before.map((c) => c.id) } })
  }
})
