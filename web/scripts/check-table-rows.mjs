// 表の行の検査(基盤 §6): 設計の文書のデシジョン表の各行の番号が、どれかのテストの題(it・test・describe)に出るかを確かめる。
// 行の番号: 1 列目が英字 + 数字(例: C13・L1)ならそれ。数字だけの表(表 A-1〜A-3)は「A-1 の 2 行」の形。
// 走らせ方: `node scripts/check-table-rows.mjs`(npm test の前に走る)。漏れがあれば一覧を出して 1 で終わる。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const designDir = join(root, '../docs/設計')
const testDirs = [join(root, 'test'), join(root, 'src')]

// まだテストを書く段に来ていない表。理由を出して漏れに数えない(書いたらここから消す)
const PENDING = {}

/** 設計の文書から { table, token } を集める */
function tableRows() {
  const rows = []
  for (const file of readdirSync(designDir).filter((f) => f.endsWith('.md'))) {
    let table = null
    let inBody = false
    for (const line of readFileSync(join(designDir, file), 'utf8').split('\n')) {
      const head = line.match(/^### 表 (\S+)/)
      if (head) {
        table = head[1]
        inBody = false
        continue
      }
      if (/^#{1,3} /.test(line)) {
        table = null
        continue
      }
      if (!table || !line.startsWith('|')) continue
      if (/^\|\s*-/.test(line)) {
        inBody = true // 区切りの行の後が本体
        continue
      }
      if (!inBody) continue
      const first = line.split('|')[1].trim()
      const id = first.match(/^[A-Z]\d+/)
      if (id) rows.push({ table, token: id[0], file })
      else if (/^\d+$/.test(first)) rows.push({ table, token: `${table} の ${first} 行`, file })
      else throw new Error(`${file} の表 ${table}: 行の番号が読めない「${first}」`)
    }
  }
  return rows
}

/** テストの題を全部集める */
function testTitles(dir) {
  const titles = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) titles.push(...testTitles(path))
    else if (/\.test\.tsx?$/.test(entry.name)) {
      const src = readFileSync(path, 'utf8')
      const re = /\b(?:it|test|describe)(?:\.each\([\s\S]*?\))?\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g
      for (const m of src.matchAll(re)) titles.push(m[2])
    }
  }
  return titles
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// 注意: 行の番号と同じ形の別の語(表 R の R2 と Cloudflare R2 など)をテストの題に書くと、その行を通したと誤って数える。
// 題では別の語を使う(R2 は「画像の置き場(バケット)」)

const covers = (titles, token) => {
  // C1 が C10 に当たらないよう、前後が英数字・ハイフンでないことを求める
  const re = new RegExp(`(?<![A-Za-z0-9-])${escape(token)}(?![0-9])`)
  return titles.some((t) => re.test(t))
}

const rows = tableRows()
const titles = testDirs.flatMap(testTitles)
const missing = rows.filter((r) => !(r.table in PENDING) && !covers(titles, r.token))
const pendingTables = [...new Set(rows.filter((r) => r.table in PENDING).map((r) => r.table))]

for (const t of pendingTables) console.log(`後で: 表 ${t} — ${PENDING[t]}`)
if (missing.length > 0) {
  console.error(`テストの題に出ない表の行が ${missing.length} 件:`)
  for (const r of missing) console.error(`  ${r.file} 表 ${r.table}: ${r.token}`)
  process.exit(1)
}
console.log(`表の行の検査: ${rows.length - rows.filter((r) => r.table in PENDING).length} 行すべてがテストの題に出る`)
