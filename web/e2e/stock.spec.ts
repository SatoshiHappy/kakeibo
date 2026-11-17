// 在庫(基盤 §6 の主な流れ「在庫の 1つ使った」)。開発の D1 に名前の重ならない品物を足し、終わったら一覧から外す
import { expect, test, type Page } from '@playwright/test'

// 後始末: 試しの品物を一覧から外す(落ちたときも走る)
test.afterEach(async ({ page }, info) => {
  const list = (await (await page.request.get('/api/stock')).json()) as { items: { id: number; name: string; retired: boolean }[] }
  for (const i of list.items.filter((x) => !x.retired && x.name.startsWith(`E2E品物 ${info.project.name} `)))
    expect((await page.request.patch(`/api/stock/${i.id}`, { data: { retired: true } })).status()).toBe(200)
})

const card = (page: Page, name: string) => page.locator('.kcard').filter({ has: page.getByRole('button', { name: new RegExp(`^${name}`) }) })

test('品物を足す → 1つ使った → 取り消す → 数を直す → 外す・戻す。名前が重なると小窓の中で断られる', async ({ page }, info) => {
  // 390px と 402px が並んで走るので、名前に端末の名と乱数を入れて重ならないようにする
  const name = `E2E品物 ${info.project.name} ${crypto.randomUUID().slice(0, 8)}`
  await page.goto('/stock')

  await page.getByRole('button', { name: '+ 品物' }).click()
  const dialog = page.getByRole('dialog', { name: '品物を足す' })
  await expect(dialog.getByLabel('名前')).toBeFocused()
  await dialog.getByLabel('名前').fill(name)
  await dialog.getByLabel('今の数(買い置き)').fill('2')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog).toBeHidden()

  const c = card(page, name)
  await expect(c.locator('.kleft b')).toHaveText('2')
  await expect(c.locator('.kpred')).toHaveText('ペースを覚えている途中')

  await c.getByRole('button', { name: `${name}を1つ使った` }).click()
  await expect(c.locator('.kleft b')).toHaveText('1')
  const undo = c.getByRole('button', { name: `${name}の「1つ使った」を取り消す` })
  await expect(undo).toBeVisible()
  await undo.click()
  await expect(c.locator('.kleft b')).toHaveText('2')
  await expect(undo).toBeHidden()

  await c.locator('.kmain').click()
  const edit = page.getByRole('dialog', { name: '品物を直す' })
  await expect(edit.getByLabel('今の数(買い置き)')).toBeFocused()
  await edit.getByLabel('今の数(買い置き)').fill('0')
  await edit.getByRole('button', { name: '保存' }).click()
  await expect(edit).toBeHidden()
  await expect(c.getByRole('button', { name: '買い置きなし' })).toBeDisabled()
  await expect(c.locator('.kpred')).toHaveText('買い置きがありません')
  await expect(page.getByRole('region', { name: /買い足し/ }).getByText(name)).toBeVisible()

  await page.getByRole('button', { name: '+ 品物' }).click()
  await dialog.getByLabel('名前').fill(name)
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('同じ名前の品物があります。')
  await dialog.getByRole('button', { name: 'やめる' }).click()
  await expect(dialog).toBeHidden()

  // 一覧から外すと「外した品物」に移り、戻すとカードに戻る
  await c.locator('.kmain').click()
  await edit.getByRole('button', { name: /^この品物を一覧から外す/ }).click()
  await expect(c).toHaveCount(0)
  await page.getByText(/^一覧から外した品物/).click()
  await page.getByRole('button', { name: `${name}を一覧に戻す` }).click()
  await expect(c).toBeVisible()

})
