// 画面の明暗(基盤 §2.2 の表 Y)。index.html の script が CSP に通ることは e2e-preview/theme.spec.ts が確かめる
import { describe, expect, it } from 'vitest'
import { settingOf, shownScheme } from './theme'

describe('表 Y 画面の明暗', () => {
  it('Y1: 自動で端末がライトならライト', () => expect(shownScheme(settingOf(null), 'light')).toBe('light'))
  it('Y2: 自動で端末がダークならダーク', () => expect(shownScheme(settingOf(null), 'dark')).toBe('dark'))
  it('Y3: ライトを選ぶと端末がダークでもライト', () => {
    for (const system of ['light', 'dark'] as const) expect(shownScheme(settingOf('light'), system)).toBe('light')
  })
  it('Y4: ダークを選ぶと端末がライトでもダーク', () => {
    for (const system of ['light', 'dark'] as const) expect(shownScheme(settingOf('dark'), system)).toBe('dark')
  })
  it('Y5: 残した値が知らない値なら自動と同じ', () => {
    for (const stored of ['', 'light dark', 'Dark', 'blue']) {
      expect(settingOf(stored)).toBe('system')
      expect(shownScheme(settingOf(stored), 'dark')).toBe('dark')
    }
  })
})
