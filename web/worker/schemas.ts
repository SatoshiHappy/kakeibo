// 2 つ以上の口(画面の API と MCP の道具)が受ける入力の型。検査の規則をここ 1 か所に置く
import { z } from 'zod'

export const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).describe('YYYY-MM')
