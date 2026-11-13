import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanRemoteError } from '../src/renderer/remoteError'
import { stripRemoteHead } from '../src/shared/failureText'

// ── 失敗の文を「生の書き方」で増やさない網（上限表）──────────────────────────────────────
// 例外の message をそのまま文にする書き方（`e?.message ?? String(e)` とその仲間）は、英語の原文と、
// ipcRenderer.invoke が付ける英語の頭（Error invoking remote method '…': Error: ）が、そのまま利用者の画面に届く。
// 失敗の文は shared/failureText.ts の failureText(e)（頭も落ちる）を通して作る。
// このテストは**増やさない**ことだけを守る。直した数だけ表を下げていき、画面の分が許可表だけになれば網は閉じる。
//
// 数える書き方は4つ（コメントを除いて数える。aiTextPlaces.test.ts の code() と同じ決まり）:
//   1. e?.message ?? String(e)             （同じ変数が両側に出る。first.error のような辺も）
//   2. e?.message ?? e                     （テンプレート文字列の中・String(e?.message ?? e) の中身）
//   3. e instanceof Error ? e.message : String(e)
//   4. e?.message ?? '日本語の固定文'        （message があれば生のまま出る。変数名は e・err・error・ex）
// 数えない: r.message ?? '…'（IPC の結果で、例外ではない）・e?.message ?? ''（文を作らず判定に使う）・コメント。
//
// 表は「画面（src/renderer）」と「main 側（src/main・src/shared）」の2つ。
//  ・1行増えたら落ちる（failureText(e) を通す）。減らしたら落ちる（表の数を下げさせる。0 になったら行を消す）。
//  ・表に無いファイルに新しく書いても落ちる。
//  ・許可表は、画面に出さない文（ログ・AI へ渡す文）と、後ろで日本語にされるチャットの経路。直す対象ではなく、
//    数は上限表の中に含まれる（上限表の数 ≧ 許可表の数）。画面の分が許可表だけになれば、画面の表は許可表と同じ数になる。

type Counts = Record<string, number>

const ROOT = path.resolve(__dirname, '..')

// コメントの中に書き方を残しただけでは数えない。文字列の中の /* は始まりにしない
const BLOCK_COMMENT = /(?<![^\s({[,;])\/\*[\s\S]*?\*\//g
const stripComments = (s: string): string => s
  .replace(BLOCK_COMMENT, m => m.replace(/[^\n]/g, ''))
  .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)

const IDENT = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`
const RAW_SHAPES: readonly RegExp[] = [
  new RegExp(String.raw`(${IDENT})\?\.message \?\? String\(\1\)`, 'g'),
  new RegExp(String.raw`(${IDENT})\?\.message \?\? \1(?![\w$.?(])`, 'g'),
  new RegExp(String.raw`(${IDENT}) instanceof Error \? \1\.message : String\(\1\)`, 'g'),
  new RegExp(String.raw`\b(?:e|err|error|ex)\?\.message \?\? ['"\x60][^'"\x60]`, 'g'),
]

/** コメントを除いたソースに、生の書き方が何か所あるか。 */
function countRaw(source: string): number {
  const body = stripComments(source)
  return RAW_SHAPES.reduce((n, re) => n + (body.match(re)?.length ?? 0), 0)
}

/** root の src 以下の .ts / .tsx（root からの相対パス・区切りは /）。 */
function srcFiles(root: string): string[] {
  const walk = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap(e => e.isDirectory()
      ? walk(path.posix.join(dir, e.name))
      : /\.(?:ts|tsx)$/.test(e.name) ? [path.posix.join(dir, e.name)] : [])
  return walk('src').sort()
}

/** 画面（src/renderer）と main 側（それ以外の src）に分けて、ファイルごとの数を数える。0 のファイルは載せない。 */
function scanTree(root: string): { renderer: Counts; main: Counts } {
  const out = { renderer: {} as Counts, main: {} as Counts }
  for (const rel of srcFiles(root)) {
    const n = countRaw(fs.readFileSync(path.join(root, rel), 'utf-8'))
    if (n > 0) out[rel.startsWith('src/renderer/') ? 'renderer' : 'main'][rel] = n
  }
  return out
}

/** 実物の数と表を突き合わせ、食い違いごとに1文を返す（空なら合っている）。 */
function judge(actual: Counts, limits: Counts): string[] {
  const out: string[] = []
  for (const file of [...new Set([...Object.keys(actual), ...Object.keys(limits)])].sort()) {
    const a = actual[file] ?? 0
    const l = limits[file] ?? 0
    if (a === l) continue
    if (l === 0) out.push(`${file}: 表に無いファイルに生の書き方が ${a} か所あります。failureText(e) を通してください`)
    else if (a === 0) out.push(`${file}: 表に ${l} とありますが、実物にはもうありません。表からこの行を消してください`)
    else if (a > l) out.push(`${file}: 生の書き方が表（${l}）より増えて ${a} か所になりました。failureText(e) を通してください`)
    else out.push(`${file}: 生の書き方が表（${l}）より減って ${a} か所になりました。表の数を ${a} に下げてください`)
  }
  return out
}

// ── 上限表（いまの数）。直したら、その行の数を下げる。0 になったら行ごと消す ───────────────────
const RENDERER_LIMITS: Counts = {
  'src/renderer/hooks/useAiChat.ts': 1,
  'src/renderer/webContext.ts': 2,
}

const MAIN_LIMITS: Counts = {
  'src/main/appSessionsStore.ts': 1,
  'src/main/backup/store.ts': 1,
  'src/main/browserCacheLimit.ts': 3,
  'src/main/chatStore/file.ts': 2,
  'src/main/claude/agent.ts': 3,
  'src/main/claude/client.ts': 2,
  'src/main/claude/toolText.ts': 1,
  'src/main/claude/tools.ts': 3,
  'src/main/cloud/docker.ts': 4,
  'src/main/cloud/imageBuild.ts': 3,
  'src/main/cloud/imageCleanup.ts': 2,
  'src/main/cloud/imagePublish.ts': 2,
  'src/main/cloud/teardownShell.ts': 1,
  'src/main/hanamii/aftercare.ts': 1,
  'src/main/ipc/chatStore.ts': 6,
  'src/main/ipc/cloudKeys.ts': 4,
  'src/main/ipc/cloudTeardown.ts': 1,
  'src/main/ipc/fs.ts': 2,
  'src/main/loginPath.ts': 1,
  'src/main/main.ts': 3,
  'src/main/preload.ts': 1,
  'src/main/vps/ssh.ts': 2,
  'src/shared/chatTurn.ts': 1,
  'src/shared/saveIfChanged.ts': 1,
  'src/shared/toolExecCore.ts': 11,
}

// ── 許可表（直す対象ではない書き方。上限表の中に含まれる）────────────────────────────────
const ALLOWED: Counts = {
  // AI へ渡す文（モデルが原因を読めるよう、原文のまま渡す。日本語にするとかえって手がかりが減る）
  'src/shared/toolExecCore.ts': 11,
  'src/main/claude/tools.ts': 3,
  'src/main/claude/toolText.ts': 1,
  'src/main/preload.ts': 1,
  'src/renderer/webContext.ts': 2,
  // ログ・診断欄（利用者の画面の文ではない）
  'src/main/main.ts': 3,
  'src/main/browserCacheLimit.ts': 3,
  'src/main/cloud/docker.ts': 2,
  // チャットの経路（受けた先の formatChatError・Claude の失敗の文が日本語にする）
  'src/shared/chatTurn.ts': 1,
  'src/main/claude/agent.ts': 3,
  'src/renderer/hooks/useAiChat.ts': 1,
}

const sum = (c: Counts): number => Object.values(c).reduce((a, b) => a + b, 0)
const isRenderer = (file: string): boolean => file.startsWith('src/renderer/')

describe('生の失敗の文の上限表（実物の木）', () => {
  const actual = scanTree(ROOT)

  it('★ 画面（src/renderer）: ファイルごとの数が表と一致する（増えても減っても落ちる）', () => {
    expect(judge(actual.renderer, RENDERER_LIMITS)).toEqual([])
  })

  it('★ main 側（src/main・src/shared）: ファイルごとの数が表と一致する（増えても減っても落ちる）', () => {
    expect(judge(actual.main, MAIN_LIMITS)).toEqual([])
  })

  it('表の行は、置き場所の合う表にある（画面の表に main のファイルを、main の表に画面のファイルを置かない）', () => {
    expect(Object.keys(RENDERER_LIMITS).filter(f => !isRenderer(f))).toEqual([])
    expect(Object.keys(MAIN_LIMITS).filter(f => isRenderer(f) || !f.startsWith('src/'))).toEqual([])
    for (const f of [...Object.keys(RENDERER_LIMITS), ...Object.keys(MAIN_LIMITS)]) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
    }
  })

  it('許可表の行は、置き場所の合う上限表に載っていて、数が上限表の数を超えない', () => {
    for (const [file, n] of Object.entries(ALLOWED)) {
      const limits = isRenderer(file) ? RENDERER_LIMITS : MAIN_LIMITS
      expect(limits[file], `${file} が上限表に無い`).toBeGreaterThanOrEqual(n)
    }
  })

  it('★ 画面（src/renderer）は、許可表の分だけが残っている（直す対象は 0）', () => {
    const allowedRenderer: Counts = Object.fromEntries(Object.entries(ALLOWED).filter(([f]) => isRenderer(f)))
    expect(RENDERER_LIMITS).toEqual(allowedRenderer)
    expect(actual.renderer).toEqual(allowedRenderer)
  })

  it('直す対象の残り（上限表 − 許可表）は、画面も main 側も 0 以上で、0 のときは表が許可表と同じ', () => {
    for (const limits of [RENDERER_LIMITS, MAIN_LIMITS]) {
      const allowed: Counts = Object.fromEntries(Object.entries(ALLOWED).filter(([f]) => f in limits))
      const rest = sum(limits) - sum(allowed)
      expect(rest).toBeGreaterThanOrEqual(0)
      if (rest === 0) expect(limits).toEqual(allowed)
    }
  })
})

describe('数え方と判定の確かめ（偽の木で）', () => {
  it('★ 4つの書き方を1つずつ数える（同じ変数が両側に出る形だけ）', () => {
    for (const line of [
      'return { ok: false, message: e?.message ?? String(e) }',
      '} catch (err: any) { x = err?.message ?? String(err) }',
      'onEvent({ kind: "error", message: first.error?.message ?? String(first.error) })',
      'publish(e2?.message ?? String(e2))',
      'return `失敗: ${e?.message ?? e}`',
      'error: String(e?.message ?? e)',
      'return e instanceof Error ? e.message : String(e)',
      'const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))',
      "setSearchError(e?.message ?? '検索に失敗しました。')",
      'next.push({ error: error?.message ?? "取得に失敗しました。" })',
    ]) {
      expect(countRaw(line), line).toBe(1)
    }
    // 1行に2つあれば2つ
    expect(countRaw('a(e?.message ?? String(e)); b(`${e?.message ?? e}`)')).toBe(2)
  })

  it('★ 数えないもの: IPC の結果・判定に使う読み方・別の変数・失敗の文を作る層を通した書き方', () => {
    for (const line of [
      "setError(r.message ?? '原因不明')",
      "throw new Error(r?.message ?? '原因不明')",
      "const m = r?.message ?? ''",
      'isContextLimitError(e?.message ?? "")',
      "errors.map((e: any) => e?.message ?? e?.type ?? '')",
      'x(e?.message ?? String(other))',
      'x(e?.message ?? err)',
      'const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))',
      'setDetail(cleanRemoteError(e))',
      'return { ok: false, message: failureText(e, { readOnly: true }) }',
    ]) {
      expect(countRaw(line), line).toBe(0)
    }
  })

  it('★ コメントの中に書き方を残しただけでは数えない（行コメント・行末コメント・ブロックコメント）', () => {
    const src = [
      '// 昔は e?.message ?? String(e) と書いていた',
      'const a = failureText(e) // e?.message ?? String(e) をやめた',
      '/* e?.message ?? String(e)',
      '   `${e?.message ?? e}` */',
      '/** e instanceof Error ? e.message : String(e) */',
      'const b = 1',
    ].join('\n')
    expect(countRaw(src)).toBe(0)
    // コメントを除いた実物に書けば数える
    expect(countRaw(`${src}\nconst c = e?.message ?? String(e)`)).toBe(1)
  })

  it('judge: 合っていれば空・増えた／減った／表に無い／実物に無い、をそれぞれ1文で言う', () => {
    expect(judge({ 'a.ts': 2, 'b.ts': 1 }, { 'a.ts': 2, 'b.ts': 1 })).toEqual([])
    const more = judge({ 'a.ts': 3 }, { 'a.ts': 2 })
    expect(more).toHaveLength(1)
    expect(more[0]).toContain('a.ts')
    expect(more[0]).toContain('増えて 3')
    const fewer = judge({ 'a.ts': 1 }, { 'a.ts': 2 })
    expect(fewer).toHaveLength(1)
    expect(fewer[0]).toContain('減って 1')
    expect(fewer[0]).toContain('表の数を 1 に下げて')
    const unlisted = judge({ 'new.ts': 1 }, {})
    expect(unlisted).toHaveLength(1)
    expect(unlisted[0]).toContain('表に無いファイル')
    const gone = judge({}, { 'old.ts': 2 })
    expect(gone).toHaveLength(1)
    expect(gone[0]).toContain('実物にはもうありません')
  })

  describe('本物の一時フォルダの木を数える', () => {
    const made: string[] = []
    afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

    const RAW = 'return { ok: false, message: e?.message ?? String(e) }\n'
    const write = (root: string, rel: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), body)
    }
    const tree = (): string => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-rawfailure-'))
      made.push(root)
      write(root, 'src/renderer/components/A.tsx', `catch (e: any) { ${RAW} }\n${RAW}`)
      write(root, 'src/renderer/b.ts', "// e?.message ?? String(e)\nexport const b = failureText(e)\n")
      write(root, 'src/main/ipc/c.ts', RAW)
      write(root, 'src/shared/d.ts', `${RAW}${RAW}${RAW}`)
      write(root, 'src/shared/readme.css', RAW) // .ts / .tsx 以外は数えない
      return root
    }

    it('★ 画面と main 側（src/main・src/shared）に分けて、ファイルごとに数える。コメントだけのファイルは載らない', () => {
      expect(scanTree(tree())).toEqual({
        renderer: { 'src/renderer/components/A.tsx': 2 },
        main: { 'src/main/ipc/c.ts': 1, 'src/shared/d.ts': 3 },
      })
    })

    it('★ 上限を超える生の書き方を1行足すと、そのファイルが名指しで落ちる（表どおりなら空）', () => {
      const root = tree()
      const limits = { renderer: { 'src/renderer/components/A.tsx': 2 }, main: { 'src/main/ipc/c.ts': 1, 'src/shared/d.ts': 3 } }
      expect(judge(scanTree(root).renderer, limits.renderer)).toEqual([])
      expect(judge(scanTree(root).main, limits.main)).toEqual([])

      fs.appendFileSync(path.join(root, 'src/main/ipc/c.ts'), RAW)
      const after = scanTree(root)
      expect(judge(after.main, limits.main)).toEqual([expect.stringContaining('src/main/ipc/c.ts')])
      expect(judge(after.renderer, limits.renderer)).toEqual([])
    })

    it('★ 表に無い新しいファイルに書いても、1つ減らしても落ちる', () => {
      const root = tree()
      const limits = { renderer: { 'src/renderer/components/A.tsx': 2 }, main: { 'src/main/ipc/c.ts': 1, 'src/shared/d.ts': 3 } }
      write(root, 'src/renderer/components/New.tsx', RAW)
      expect(judge(scanTree(root).renderer, limits.renderer)).toEqual([expect.stringContaining('New.tsx')])
      fs.rmSync(path.join(root, 'src/renderer/components/New.tsx'))

      write(root, 'src/shared/d.ts', `${RAW}${RAW}`)
      expect(judge(scanTree(root).main, limits.main)).toEqual([expect.stringContaining('表の数を 2 に下げて')])
    })
  })
})

describe('IPC の頭の落とし方は1か所（shared/failureText.ts）', () => {
  const code = (rel: string): string => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf-8'))
  const count = (src: string, needle: string): number => src.split(needle).length - 1

  it('★ 頭の文字列を正規表現に書くのは failureText.ts だけ（preload や各画面に2つ目の落とし方を作らない）', () => {
    const holders = srcFiles(ROOT).filter(f => /Error invoking remote method/.test(code(f)))
    expect(holders).toEqual(['src/shared/failureText.ts'])
  })

  it('★ cleanRemoteError は stripRemoteHead そのもの（名前を残した別名で、2つ目の実装ではない）', () => {
    expect(cleanRemoteError).toBe(stripRemoteHead)
    const src = code('src/renderer/remoteError.ts')
    expect(src).toContain('export const cleanRemoteError = stripRemoteHead')
    expect(src).not.toMatch(/function\s+cleanRemoteError/)
    expect(src).not.toContain('Error invoking')
  })

  it('頭の3つの形（Error:・TypeError:・内側の型名なし）を、文字列でも Error 値でも落とす', () => {
    for (const inner of ['Error: ', 'TypeError: ', '']) {
      const raw = `Error invoking remote method 'fs:rename': ${inner}名前が重複しています`
      expect(cleanRemoteError(raw), raw).toBe('名前が重複しています')
      expect(cleanRemoteError(new Error(raw)), raw).toBe('名前が重複しています')
    }
  })

  it('★ cleanRemoteError を呼ぶ7か所は、呼び出しの形ごとそのまま残っている（名前を変えない）', () => {
    // ファイル操作の断り（3）は failureText(e, …) に替わった（手元のファイルの失敗を日本語の文＋詳細にするため）。cleanRemoteError は残っていない
    const ops = code('src/renderer/fileEntryOps.ts')
    expect(count(ops, 'cleanRemoteError')).toBe(0)
    // 初回案内の接続テスト（1）
    const onboard = code('src/renderer/components/OnboardingModal.tsx')
    expect(count(onboard, 'const msg = cleanRemoteError(e)')).toBe(1)
    // 認証情報: クラウドのキー保存（1）と、5つのテストボタン（5）
    const cred = code('src/renderer/components/CredentialsModal.tsx')
    expect(count(cred, 'return { ok: false, message: cleanRemoteError(e) }')).toBe(1)
    expect(count(code('src/renderer/components/CredentialsTestButtons.tsx'), "setState('ng'); setDetail(cleanRemoteError(e))")).toBe(5)
    // 木全体でも7か所（定義と import は呼び出しではない）
    const calls = srcFiles(ROOT).map(f => [f, count(code(f), 'cleanRemoteError(e)')] as const).filter(([, n]) => n > 0)
    expect(calls).toEqual([
      ['src/renderer/components/CredentialsModal.tsx', 1],
      ['src/renderer/components/CredentialsTestButtons.tsx', 5],
      ['src/renderer/components/OnboardingModal.tsx', 1],
    ])
  })

  it('★ 7か所のどこにも、例外の message をそのまま出す書き方が戻っていない', () => {
    for (const rel of ['src/renderer/fileEntryOps.ts', 'src/renderer/components/OnboardingModal.tsx']) {
      expect(countRaw(fs.readFileSync(path.join(ROOT, rel), 'utf-8')), rel).toBe(0)
    }
    const cred = code('src/renderer/components/CredentialsModal.tsx') + code('src/renderer/components/CredentialsTestButtons.tsx')
    expect(cred).not.toMatch(/setDetail\(\s*e\??\.message/)
    expect(cred).not.toMatch(/setDetail\(\s*String\(e/)
    expect(cred).not.toMatch(/message:\s*e\??\.message/)
  })
})
