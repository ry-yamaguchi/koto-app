import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// 失敗の原文をそのまま message に入れて返す形（`message: e?.message ?? String(e)`・`message: err.message`・
// `message: String(e)` など）を、残してよい所の一覧と完全に一致させる網。
// 一覧に無い所へ新しく書くと落ちる。直して減らしても落ちる（一覧を下げさせる）。
// 画面へ出す失敗は shared/failureText.ts の failureText(e) を通して日本語の文＋詳細にする。

type Counts = Record<string, number>
const ROOT = path.resolve(__dirname, '..')

const stripComments = (s: string): string => s
  .replace(/(?<![^\s({[,;])\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
  .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)

// main: message: に、例外の message / String(例外) をそのまま入れる形（後ろに ?? 固定文 が付く形も）
const MAIN_SHAPE = /\bmessage:\s*(?:(?:e|err|error|ex)\??\.message(?:\s*\?\?\s*(?:String\((?:e|err|error|ex)\)|['"`][^'"`]*['"`]))?|String\((?:e|err|error|ex)\))(?=\s*[,}\n])/g
// renderer: set○○(e.message) と set○○(String(e))
const RENDERER_SHAPES: readonly RegExp[] = [
  /set[A-Z]\w*\((?:e|err|error)\??\.message/g,
  /set[A-Z]\w*\(String\((?:e|err)\)\)/g,
]

function files(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? files(path.posix.join(dir, d.name))
      : /\.tsx?$/.test(d.name) ? [path.posix.join(dir, d.name)] : [])
}
function scan(dir: string, shapes: readonly RegExp[]): Counts {
  const out: Counts = {}
  for (const rel of files(dir)) {
    const body = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf-8'))
    const n = shapes.reduce((a, re) => a + (body.match(re)?.length ?? 0), 0)
    if (n > 0) out[rel] = n
  }
  return out
}
const read = (rel: string): string => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf-8'))

// 残してよい所（ファイル: 数）。理由は右。
const MAIN_KEPT: Counts = {
  'src/main/appSessionsStore.ts': 1, // 置き場所の検証で自前の日本語の文が先に来る（?? 以降は予備）
  'src/main/chatStore/file.ts': 2, // 会話の記録の保存。画面には出さず console.warn だけ
  'src/main/ipc/chatStore.ts': 6, // 会話の記録の口。画面には出さず console.warn だけ
  'src/main/claude/agent.ts': 1, // チャットの経路。受けた先の formatChatError が日本語にする
  'src/main/claude/client.ts': 2, // Claude の起動確認。画面から呼ぶ所が無い（スモークテストのログにだけ出る）
  'src/main/cloud/docker.ts': 2, // docker の起動失敗。imagePublish が imageFailure を通して日本語にする
  'src/main/cloud/imageBuild.ts': 3, // 組み立て。imageFailure が後で原文を見分けるため原文のまま渡す
  'src/main/cloud/imageCleanup.ts': 2, // 掃除。後段が詳細つきの文に直すため原文のまま渡す
  'src/main/cloud/imagePublish.ts': 2, // 公開。手元のパス検証など固定文か、imageFailure が見分ける文字列
  'src/main/backup/store.ts': 1, // 変更前の自動保存。呼び出し側が結果を捨てて画面に出さない
  'src/main/ipc/cloudKeys.ts': 4, // 手元の鍵の保存・読み出し。保存・削除の結果の message を画面で読む所が無い（認証情報の画面は戻り値を見ない）
  'src/main/ipc/fs.ts': 2, // 検索は AI への道具の結果、最終更新の走査は画面に文を出さない
}
const RENDERER_KEPT: Counts = {}

// 直す前の形（今回直した口）。戻したら落ちる
const FIXED_BEFORE: ReadonlyArray<[string, string]> = [
  ['src/main/ipc/publishImport.ts', 'message: e?.message ?? String(e)'],
  ['src/main/ipc/vercel.ts', 'message: e?.message ?? String(e)'],
  ['src/main/ipc/hanamii.ts', 'message: e?.message ?? String(e)'],
  ['src/main/ipc/github.ts', 'message: e?.message ?? String(e)'],
  ['src/main/github/client.ts', 'message: e?.message ?? String(e)'],
  ['src/main/ipc/vps.ts', 'message: e?.message ?? String(e)'],
  ['src/main/ipc/remote.ts', 'message: e?.message ?? String(e)'],
  ['src/main/cloud/apprunDedicated.ts', 'message: e?.message ?? String(e)'],
  ['src/main/projectOps.ts', 'message: e?.message ?? String(e)'],
]

describe('原文をそのまま返す形の網', () => {
  it('main（src/main・src/shared）: 残してよい所の一覧と完全に一致する', () => {
    const actual = { ...scan('src/main', [MAIN_SHAPE]), ...scan('src/shared', [MAIN_SHAPE]) }
    expect(actual).toEqual(MAIN_KEPT)
  })

  it('renderer: set○○(e.message)・set○○(String(e)) は一覧と完全に一致する', () => {
    expect(scan('src/renderer', RENDERER_SHAPES)).toEqual(RENDERER_KEPT)
  })

  it('一覧のファイルは実在する', () => {
    for (const f of [...Object.keys(MAIN_KEPT), ...Object.keys(RENDERER_KEPT)]) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
    }
  })

  for (const [file, before] of FIXED_BEFORE) {
    it(`${file}: 直す前の形（${before}）に戻さない`, () => {
      expect(read(file)).not.toContain(before)
    })
  }

  it('数え方の確かめ: 形を数え、failureText を通した形は数えない', () => {
    const count = (s: string) => stripComments(s).match(MAIN_SHAPE)?.length ?? 0
    expect(count('return { ok: false, message: e?.message ?? String(e) }')).toBe(1)
    expect(count('return { ok: false, message: err.message }')).toBe(1)
    expect(count('return { ok: false, message: String(e) }')).toBe(1)
    expect(count('return { ok: false, message: failureText(e) }')).toBe(0)
    expect(count('// message: e?.message ?? String(e)\nx()')).toBe(0)
  })
})
