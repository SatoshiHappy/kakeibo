// 表 O の O2 の印は public/sw.js(import できない)が付ける。名前と値が launch.ts とずれないことを、sw.js の文(Vite の ?raw で読む)で確かめる
import { describe, expect, it } from 'vitest'
import sw from '../../public/sw.js?raw'
import { LAUNCH_NOTIFY, LAUNCH_PARAM } from './launch'

describe('表 O の O2 の印', () => {
  it('O2 通知を押したとき Service Worker が行き先に launch=notify を付ける(launch.ts と同じ名前と値)', () => {
    expect(sw).toContain(`url.searchParams.set('${LAUNCH_PARAM}', '${LAUNCH_NOTIFY}')`)
    expect(sw).toMatch(/notificationclick[\s\S]*url\.searchParams\.set[\s\S]*openWindow\(target\)/)
  })
})
