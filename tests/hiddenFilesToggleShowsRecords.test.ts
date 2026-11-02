import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLISH_RECORD_UNREADABLE_NOTE, PUBLISH_RECORD_UNREADABLE_FIX_NOTE } from '../src/renderer/teardown/projectDeletePlan'

// ── ファイル一覧の 👁（隠しファイルを表示）が、公開の記録（.sakuraide.json・.sakura-cloud/）を出せること ──────────────────────────────────
// 削除を止めるとき、止める文のあとに「Koto でこのプロジェクトを開き、ファイル一覧の 👁 で隠しファイルを表示すると、そのファイルを開いて直せます。…」と案内する。
// 案内が嘘にならないよう、Sidebar.tsx の「常に隠す一覧」（ALWAYS_HIDDEN）と、見せ方の規則・👁 の切り替えを読んで見張る（Sidebar.tsx は触らない。この見張りだけは、定数を読む形でよい）。
// 変異: 常に隠す一覧に `.sakura-cloud` や `.sakuraide.json` を足す（定義に書く・あとから add する・見せ方の規則へ1行足す）・切り替えの規則を外す・
// プロジェクト直下の一覧へ 👁 の状態を渡す行を外す・フォルダの中身を返す口で記録を落とす、がそれぞれ落ちる。

const SIDEBAR = readFileSync(join(__dirname, '..', 'src/renderer/components/Sidebar.tsx'), 'utf-8')
const FS_IPC = readFileSync(join(__dirname, '..', 'src/main/ipc/fs.ts'), 'utf-8')
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1

/** 常に隠す一覧（ALWAYS_HIDDEN）の名前。 */
function alwaysHidden(): string[] {
  const m = SIDEBAR.match(/const ALWAYS_HIDDEN = new Set\(\[([^\]]*)\]\)/)
  expect(m, 'Sidebar.tsx に ALWAYS_HIDDEN の定義が無い（形が変わったなら、この見張りも直す）').not.toBeNull()
  return m![1].split(',').map(s => s.trim()).filter(Boolean).map(s => s.replace(/^['"]|['"]$/g, ''))
}

/** ファイル一覧の見せ方の規則（FileTree の visible）を、Sidebar.tsx の書き方のまま写して動かす。 */
const RULE = [
  'if (ALWAYS_HIDDEN.has(e.name)) return false',
  "if (e.name.startsWith('.')) return showHidden",
  'return true',
]
function isShown(name: string, showHidden: boolean): boolean {
  if (alwaysHidden().includes(name)) return false
  if (name.startsWith('.')) return showHidden
  return true
}

describe('★★★ 常に隠す一覧に、公開の記録の名前が入っていない（👁 で出せる）', () => {
  it('常に隠す一覧は、この3つだけ（書き下す。足すなら、案内も直す）', () => {
    expect(alwaysHidden()).toEqual(['.sakuraide', '.sakuraide-backup', '.git'])
  })

  it('★★★ `.sakura-cloud`・`.sakuraide.json` は、常に隠す一覧に無い', () => {
    const hidden = alwaysHidden().map(n => n.toLowerCase())
    expect(hidden).not.toContain('.sakura-cloud')
    expect(hidden).not.toContain('.sakuraide.json')
    expect(hidden).not.toContain('.sakura-cloud/')
  })

  it('★★★ 止める文が挙げる記録の名前は、👁 を押す前は隠れ（案内が要る）、押すと出る（案内のとおり開いて直せる）', () => {
    const named = ['.sakuraide.json', '.sakura-cloud']
    for (const n of named) expect(PUBLISH_RECORD_UNREADABLE_NOTE, n).toContain(n)
    for (const n of named) {
      expect(isShown(n, false), `${n} は隠れている（Finder でも Koto でも、既定では見えない）`).toBe(false)
      expect(isShown(n, true), `${n} が 👁 を押しても出ない`).toBe(true)
    }
    // 記録の中の state.json・env.json は、「.」で始まらないので、記録のフォルダを開けば見える
    expect(isShown('state.json', false)).toBe(true)
    expect(isShown('env.json', false)).toBe(true)
  })

  it('★★ 対照: 常に隠す内部のフォルダは、👁 を押しても出ない', () => {
    for (const n of ['.sakuraide', '.sakuraide-backup', '.git']) expect(isShown(n, true), n).toBe(false)
  })

  it('★★ 見せ方の規則（FileTree の visible）が、常に隠す一覧 → 「.」で始まる名前は 👁 の状態 → それ以外は出す、の順で書かれている', () => {
    let at = -1
    for (const line of RULE) {
      const found = SIDEBAR.indexOf(line, at + 1)
      expect(found, `Sidebar.tsx に「${line}」が、前の行より後ろに無い`).toBeGreaterThan(at)
      at = found
    }
    expect(SIDEBAR.split(RULE[0]).length - 1, '見せ方の規則は1か所だけ').toBe(1)
  })

  it('★★ 👁 のボタンは1つで、プロジェクトを開いているときに出て、押すたびに表示を切り替える', () => {
    expect(SIDEBAR.split('>👁</button>').length - 1).toBe(1)
    const at = SIDEBAR.indexOf('>👁</button>')
    const button = SIDEBAR.slice(SIDEBAR.lastIndexOf('{currentDir && (', at), at)
    expect(button).toContain('setShowHidden(v => {')
    expect(button).toContain('const next = !v')
    // 切り替えた値を返す（`return v` だと、押しても表示が変わらず、案内が嘘になる）
    expect(button.replace(/\s+/g, ' ')).toContain("const next = !v localStorage.setItem(SHOW_HIDDEN_KEY, next ? '1' : '0') return next })")
    expect(button).toContain("title={showHidden ? '隠しファイルを表示中（クリックで隠す）' : '隠しファイルを表示（.htaccess・.gitignore など）'}")
  })

  it('★★ 案内の文は、👁 とファイル一覧を名指しする（Finder に誘導しない）', () => {
    expect(PUBLISH_RECORD_UNREADABLE_FIX_NOTE).toBe('Koto でこのプロジェクトを開き、ファイル一覧の 👁 で隠しファイルを表示すると、そのファイルを開いて直せます。直したら、この画面を開き直してください。')
    expect(PUBLISH_RECORD_UNREADABLE_FIX_NOTE).toContain('👁')
    expect(PUBLISH_RECORD_UNREADABLE_FIX_NOTE).not.toContain('Finder')
  })
})

describe('★★★ 👁 の状態が、ファイル一覧の根まで届き、記録の名前が途中で落ちない（案内が嘘にならない）', () => {
  it('★★★ プロジェクト直下の一覧（FileTree）は、👁 の状態 showHidden を受け取る（行ごと固定。固定の値を渡すと、👁 を押しても出ない）', () => {
    const root = '<FileTree dir={currentDir} onOpenFile={onOpenFile} refreshKey={refreshKey + autoRefresh} showHidden={showHidden} onContextMenu={onContextMenu} />'
    expect(occurrences(SIDEBAR, root), 'プロジェクト直下の FileTree の呼び出しは、この1行だけ').toBe(1)
    expect(occurrences(SIDEBAR, '<FileTree dir={currentDir}'), 'プロジェクト直下の FileTree の呼び出しは1か所').toBe(1)
    expect(SIDEBAR).not.toContain('showHidden={false}')
    expect(SIDEBAR).not.toContain('showHidden={true}')
  })

  it('★★★ 見せ方の規則（visible）は、常に隠す一覧 → 「.」で始まる名前は 👁 の状態 → 出す、の3行だけで、途中に別の行が入らない', () => {
    const block = [
      '  const visible = entries.filter(e => {',
      '    if (ALWAYS_HIDDEN.has(e.name)) return false',
      "    if (e.name.startsWith('.')) return showHidden",
      '    return true',
      '  }).sort(',
    ].join('\n')
    expect(occurrences(SIDEBAR, block), 'FileTree の visible の絞り込みが、この形のまま（行を足すと、記録の名前を隠せてしまう）').toBe(1)
  })

  it('★★★ 常に隠す一覧は、定義の1か所だけで決まる（あとから add・delete・作り直しをしない。使うのは visible の1か所）', () => {
    expect(occurrences(SIDEBAR, 'const ALWAYS_HIDDEN = new Set(')).toBe(1)
    expect(occurrences(SIDEBAR, 'ALWAYS_HIDDEN.has(')).toBe(1)
    expect(SIDEBAR).not.toMatch(/ALWAYS_HIDDEN\s*\.\s*(add|delete|clear)\s*\(/)
    expect((SIDEBAR.match(/ALWAYS_HIDDEN\s*=[^=]/g) ?? []).length, '代入は定義の1つだけ').toBe(1)
  })

  it('★★ フォルダの中身を返す口（fs:readDir）は、名前で絞らず全件を返す（記録を落とさない）', () => {
    const handler = [
      "  ipcMain.handle('fs:readDir', async (_, dirPath: string) => {",
      '    const entries = fs.readdirSync(dirPath, { withFileTypes: true })',
      '    return entries.map(e => ({ name: e.name, isDir: e.isDirectory(), path: path.join(dirPath, e.name) }))',
      '  })',
    ].join('\n')
    expect(occurrences(FS_IPC, handler), 'fs:readDir の本体が、この形のまま（filter などで名前を落とさない）').toBe(1)
  })
})

