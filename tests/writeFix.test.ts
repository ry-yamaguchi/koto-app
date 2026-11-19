// 書いた中身の点検（⚠️ の吹き出し）の「🛠 AIに修正させる」ボタン。
//
//   A. 見え方（writeFixButtonState）と描画
//   B. runWriteFix: 偽の ports に流して、送信の一覧・読んだファイルの一覧を見る
//   C. 配線: ChatPanel.tsx と useWriteFix
//   D. 会話の記録に値が残らない
//   E. 読む口（プロジェクトの外を指すリンク・大きさ）
// 見本のキーは文字列の連結で組み立てる（実在しない値）。

import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const rt = vi.hoisted(() => ({ slots: [] as any[], i: 0 }))
vi.mock('react', async () => {
  const actual = await vi.importActual<any>('react')
  const useRef = (init: unknown) => { const s = (rt.slots[rt.i] ??= { current: init }); rt.i++; return s }
  const useCallback = (fn: unknown) => { rt.i++; return fn }
  return { ...actual, useRef, useCallback, default: { ...(actual.default ?? actual), useRef, useCallback } }
})

import WriteFixButton from '../src/renderer/components/WriteFixButton'
import {
  runWriteFix, writeFixButtonState, WRITE_FIX_BUTTON_LABEL, WRITE_FIX_ALREADY_FIXED_NOTE,
  type WriteFixPorts,
} from '../src/renderer/writeFix'
import { readForWriteFixFs, WRITE_FIX_READ_LIMIT_BYTES } from '../src/main/writeFixRead'
import { useWriteFix } from '../src/renderer/hooks/useWriteFix'
import { TARGET_CHECK_OTHER_BUSY_NOTE } from '../src/renderer/targetCheck'
import { writeCheckNotice, buildWriteFixPrompt, type WriteFixMark } from '../src/shared/securityFindings'
import { applyToMessages } from '../src/shared/chatEvents'
import { forStorage } from '../src/shared/chatStorage'

const ROOT = path.join(__dirname, '..')
const DIR = '/work/my-app'

const GH = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const KEY_LINE = `const t = "${GH}"`
const HTML_LINE = 'el.innerHTML = location.hash'

const mark = (file: string, kind: WriteFixMark['kind'], line: number): WriteFixMark => ({ file, kind, line })

interface Setup {
  /** ファイルの中身。undefined は無い、null は読めない */
  files?: Record<string, string | null>
  busy?: boolean
  otherBusy?: boolean
  dir?: string | null
  apiKey?: string | null
  claudeActive?: boolean
}

function makePorts(s: Setup = {}) {
  const files = s.files ?? {}
  const sent: string[] = []
  const bubbles: Array<{ content: string; toolNote: true }> = []
  const reads: string[] = []
  const checks: string[] = []
  const ports: WriteFixPorts = {
    read: async (dir, file) => {
      const p = `${dir}/${file}`
      checks.push(p)
      if (!(file in files)) return { state: 'missing' }
      if (files[file] === null) return { state: 'unreadable' }
      reads.push(p)
      return { state: 'text', content: files[file] as string }
    },
    appendBubble: (m) => { bubbles.push(m) },
    send: (text) => { sent.push(text) },
    currentDir: () => (s.dir === undefined ? DIR : s.dir),
    isBusy: () => !!s.busy,
    otherProjectBusy: () => !!s.otherBusy,
    aiRoot: () => null,
    keys: () => ({ apiKey: s.apiKey === undefined ? 'k' : s.apiKey, claudeActive: !!s.claudeActive }),
  }
  return { ports, sent, bubbles, reads, checks }
}

describe('A. 見え方', () => {
  const marks = [mark('a.js', 'known-key', 1)]
  it('印なし・空・プロジェクトなしは出さない', () => {
    expect(writeFixButtonState({ marks: undefined, dir: DIR, isLoading: false }).show).toBe(false)
    expect(writeFixButtonState({ marks: [], dir: DIR, isLoading: false }).show).toBe(false)
    expect(writeFixButtonState({ marks, dir: null, isLoading: false }).show).toBe(false)
    expect(writeFixButtonState({ marks, dir: '', isLoading: false }).show).toBe(false)
  })
  it('応答中は出したまま押せない。それ以外は押せる', () => {
    expect(writeFixButtonState({ marks, dir: DIR, isLoading: true })).toEqual({ show: true, disabled: true })
    expect(writeFixButtonState({ marks, dir: DIR, isLoading: false })).toEqual({ show: true, disabled: false })
  })
  it('札は決めた文で、描画に出る。応答中は disabled', () => {
    expect(WRITE_FIX_BUTTON_LABEL).toBe('🛠 AIに修正させる')
    const h = renderToStaticMarkup(createElement(WriteFixButton, { marks, dir: DIR, isLoading: true, onPress: () => {} }))
    expect(h).toContain(WRITE_FIX_BUTTON_LABEL)
    expect(h).toContain('disabled=""')
    expect(renderToStaticMarkup(createElement(WriteFixButton, { marks: [], dir: DIR, isLoading: false, onPress: () => {} }))).toBe('')
  })
})

describe('B. runWriteFix', () => {
  it('直っていれば、送信 0 件で ℹ️ の吹き出し1つ', async () => {
    const t = makePorts({ files: { 'a.js': 'const t = process.env.T' } })
    const r = await runWriteFix(t.ports, [mark('a.js', 'known-key', 1)])
    expect(r).toEqual({ sent: false, reason: 'already-fixed' })
    expect(t.sent).toHaveLength(0)
    expect(t.bubbles).toEqual([{ role: 'assistant', content: WRITE_FIX_ALREADY_FIXED_NOTE, toolNote: true }])
  })

  it('残っていれば送信 1 件。依頼文に値・文字数・見本が無く、行はいまの行', async () => {
    const t = makePorts({ files: { 'a.js': `// 先頭\n// 2\n${KEY_LINE}` } })
    const r = await runWriteFix(t.ports, [mark('a.js', 'known-key', 1)])
    expect(r.sent).toBe(true)
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).toContain('a.js:3 ')
    expect(t.sent[0]).not.toContain('a.js:1 ')
    expect(t.sent[0]).not.toContain(GH)
    expect(t.sent[0]).not.toContain('ghp_')
    expect(t.sent[0]).not.toMatch(/文字/)
    expect(t.bubbles).toHaveLength(0)
  })

  it('一部だけ直っていれば、残りだけを頼む', async () => {
    const t = makePorts({ files: { 'a.js': KEY_LINE, 'b.js': 'const x = 1' } })
    await runWriteFix(t.ports, [mark('a.js', 'known-key', 1), mark('b.js', 'known-key', 4)])
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).toContain('a.js:1 ')
    expect(t.sent[0]).not.toContain('b.js')
  })

  it('印と別の種類の指摘は頼まない（印の種類だけ）', async () => {
    const t = makePorts({ files: { 'a.js': `${KEY_LINE}\n${HTML_LINE}` } })
    await runWriteFix(t.ports, [mark('a.js', 'input-to-html', 9)])
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).toContain('a.js:2 ')
    expect(t.sent[0]).not.toContain('a.js:1 ')
  })

  it('無くなったファイルは直った扱い', async () => {
    const t = makePorts({ files: {} })
    const r = await runWriteFix(t.ports, [mark('gone.js', 'known-key', 1)])
    expect(r).toEqual({ sent: false, reason: 'already-fixed' })
    expect(t.sent).toHaveLength(0)
    expect(t.reads).toHaveLength(0)
  })

  it('読めないファイル・長すぎるファイルは、元の印を残して送る', async () => {
    const t = makePorts({ files: { 'u.js': null, 'big.js': 'x'.repeat(1_000_001) } })
    await runWriteFix(t.ports, [mark('u.js', 'known-key', 7), mark('big.js', 'private-key', 3)])
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).toContain('u.js:7 ')
    expect(t.sent[0]).toContain('big.js:3 ')
  })

  it('プロジェクトの外を指す印は、読まず・送らない', async () => {
    const t = makePorts({ files: { 'a.js': KEY_LINE } })
    const bad = ['../x.js', 'a/../../x.js', '/etc/passwd', 'C:\\x.js', '', 'a\u0000.js', 'a\nb.js', '..\\x.js', '~/x']
    const r = await runWriteFix(t.ports, bad.map(f => mark(f, 'known-key', 1)))
    expect(r).toEqual({ sent: false, reason: 'no-marks' })
    expect(t.sent).toHaveLength(0)
    expect(t.reads).toHaveLength(0)
    expect(t.checks).toHaveLength(0)
  })

  it('外を指す印が混じっても、正しい印だけを読む', async () => {
    const t = makePorts({ files: { 'a.js': KEY_LINE } })
    await runWriteFix(t.ports, [mark('../x.js', 'known-key', 1), mark('a.js', 'known-key', 1)])
    expect(t.checks).toEqual([`${DIR}/a.js`])
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).not.toContain('x.js')
  })

  it('応答中・プロジェクトなし・AI を使えないときは、送信 0 件で読みもしない', async () => {
    const marks = [mark('a.js', 'known-key', 1)]
    for (const s of [{ busy: true }, { dir: null }, { apiKey: null, claudeActive: false }] as Setup[]) {
      const t = makePorts({ files: { 'a.js': KEY_LINE }, ...s })
      const r = await runWriteFix(t.ports, marks)
      expect(r.sent).toBe(false)
      expect(t.sent).toHaveLength(0)
      expect(t.checks).toHaveLength(0)
      expect(t.reads).toHaveLength(0)
      expect(t.bubbles).toHaveLength(0)
    }
  })

  it('別のプロジェクトが作業中は、送らず・読まず、一言だけ出す', async () => {
    const t = makePorts({ files: { 'a.js': KEY_LINE }, otherBusy: true })
    const r = await runWriteFix(t.ports, [mark('a.js', 'known-key', 1)])
    expect(r).toEqual({ sent: false, reason: 'other-busy' })
    expect(t.sent).toHaveLength(0)
    expect(t.checks).toHaveLength(0)
    expect(t.bubbles.map(b => b.content)).toEqual([TARGET_CHECK_OTHER_BUSY_NOTE])
  })

  it('2回続けて押すと、送信は押した回数ぶん（読み直すので、直っていれば2回目は送らない）', async () => {
    const t = makePorts({ files: { 'a.js': KEY_LINE } })
    await runWriteFix(t.ports, [mark('a.js', 'known-key', 1)])
    await runWriteFix(t.ports, [mark('a.js', 'known-key', 1)])
    expect(t.sent).toHaveLength(2)
    const t2 = makePorts({ files: { 'a.js': KEY_LINE } })
    const [a, b] = await Promise.all([
      runWriteFix(t2.ports, [mark('a.js', 'known-key', 1)]),
      runWriteFix(t2.ports, [mark('a.js', 'known-key', 1)]),
    ])
    expect(t2.sent).toHaveLength(1)
    expect([a.sent, b.sent].sort()).toEqual([false, true])
  })

  it('読んでいる間に応答が始まったら送らない', async () => {
    const t = makePorts({ files: { 'a.js': KEY_LINE } })
    let busy = false
    t.ports.isBusy = () => busy
    const orig = t.ports.read
    t.ports.read = async (d, f) => { busy = true; return orig(d, f) }
    const r = await runWriteFix(t.ports, [mark('a.js', 'known-key', 1)])
    expect(r).toEqual({ sent: false, reason: 'busy' })
    expect(t.sent).toHaveLength(0)
  })

  it('読んでいる間にプロジェクトが切り替わったら、送らず・吹き出しも置かない', async () => {
    const t = makePorts({ files: { 'a.js': 'ok' } })
    let dir: string = DIR
    t.ports.currentDir = () => dir
    const orig = t.ports.read
    t.ports.read = async (d, f) => { dir = '/work/other'; return orig(d, f) }
    const r = await runWriteFix(t.ports, [mark('a.js', 'known-key', 1)])
    expect(r).toEqual({ sent: false, reason: 'project-changed' })
    expect(t.sent).toHaveLength(0)
    expect(t.bubbles).toHaveLength(0)
  })
})

describe('C. 配線', () => {
  const code = (rel: string): string =>
    fs.readFileSync(path.join(ROOT, rel), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
      .filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') }).join('\n')
  const panel = code('src/renderer/components/ChatPanel.tsx')

  it('ChatPanel: 吹き出しの writeFix を WriteFixButton へ渡し、押すと useWriteFix の press を呼ぶ', () => {
    expect(panel.split('<WriteFixButton')).toHaveLength(2)
    const tag = panel.match(/<WriteFixButton[\s\S]*?\/>/)?.[0] ?? ''
    expect(tag).toBe('<WriteFixButton marks={msg.writeFix} dir={projectDir} isLoading={chat.isLoading} onPress={() => void writeFix.press(msg.writeFix)} />')
    expect(panel).toContain("import WriteFixButton from './WriteFixButton'")
    expect(panel.split('useWriteFix({')).toHaveLength(2)
    expect(panel).toContain('const writeFix = useWriteFix({ projectDir, apiKey, claudeActive, aiRoot: currentAiRoot, isBusy: isLoading, applyOp, send: chat.send })')
  })

  it('ChatApp（プロジェクトを持たないチャット）には足さない', () => {
    expect(code('src/renderer/components/ChatApp.tsx')).not.toMatch(/WriteFix|useWriteFix/)
  })

  it('送る口は send の1つだけ。runWriteFix を呼ぶのは useWriteFix だけ', () => {
    const hook = code('src/renderer/hooks/useWriteFix.ts')
    expect(hook.match(/\.send\(/g)).toHaveLength(1)
    expect(hook).toContain('send: (text, images) => live().send(text, images)')
    expect(hook).toContain('currentDir: () => live().projectDir,')
    expect(hook).toContain('isBusy: () => live().isBusy,')
    expect(hook).toContain('otherProjectBusy: () => live().claudeActive && isOtherProjectLoading(live().projectDir),')
  })

  it('ChatPanel.tsx は足したあとも 1,318 行から 8 行以内の増え', () => {
    const n = fs.readFileSync(path.join(ROOT, 'src/renderer/components/ChatPanel.tsx'), 'utf-8').split('\n').length
    expect(n).toBeLessThanOrEqual(1318 + 8)
  })

  it('新しい3ファイルは400行以下で、開発環境のパスを書いていない', () => {
    for (const f of ['src/renderer/writeFix.ts', 'src/renderer/components/WriteFixButton.tsx', 'src/renderer/hooks/useWriteFix.ts']) {
      const s = fs.readFileSync(path.join(ROOT, f), 'utf-8')
      expect(s.split('\n').length, f).toBeLessThanOrEqual(400)
      expect(s, f).not.toMatch(/\/Users\/|\/home\//)
    }
  })

  it('useWriteFix: press は本物の send・応答中・プロジェクトのフォルダに繋がる', async () => {
    const sent: string[] = []
    const files = new Map<string, string>([[`${DIR}/a.js`, KEY_LINE]])
    const io = {
      read: async (d: string, f: string) => (files.has(`${d}/${f}`)
        ? { state: 'text' as const, content: files.get(`${d}/${f}`)! }
        : { state: 'missing' as const }),
    }
    const bubbles: unknown[] = []
    const mk = (over: Record<string, unknown>) => {
      rt.slots = []; rt.i = 0
      return useWriteFix({
        projectDir: DIR, apiKey: 'k', claudeActive: false, isBusy: false,
        applyOp: (op) => { bubbles.push(op) }, send: (t: string) => { sent.push(t) }, ...over,
      } as any, io)
    }
    await mk({}).press([mark('a.js', 'known-key', 1)])
    expect(sent).toHaveLength(1)
    await mk({ isBusy: true }).press([mark('a.js', 'known-key', 1)])
    expect(sent).toHaveLength(1)
    await mk({ projectDir: null }).press([mark('a.js', 'known-key', 1)])
    expect(sent).toHaveLength(1)
    files.set(`${DIR}/a.js`, 'ok')
    await mk({}).press([mark('a.js', 'known-key', 1)])
    expect(sent).toHaveLength(1)
    expect(bubbles).toEqual([{ kind: 'append', msg: { role: 'assistant', content: WRITE_FIX_ALREADY_FIXED_NOTE, toolNote: true } }])
  })
})

describe('D. 会話の記録に値が残らない', () => {
  it('writeFix つきの吹き出しを保存の形に通しても、キーは file・kind・line だけ', () => {
    const notice = writeCheckNotice([{ file: 'a.js', findings: [{ kind: 'known-key', line: 3, length: 40, sample: 'ghp_…' }] }])!
    const msgs = applyToMessages([], { kind: 'append', msg: { role: 'assistant', content: notice.text, toolNote: true, writeFix: notice.marks } })
    const [saved] = forStorage(msgs.map(m => ({ ...m, thinking: '考え中' })))
    const json = JSON.stringify(saved)
    expect(saved.writeFix).toEqual([{ file: 'a.js', kind: 'known-key', line: 3 }])
    for (const m of saved.writeFix!) expect(Object.keys(m).sort()).toEqual(['file', 'kind', 'line'])
    expect(json).not.toContain('"length"')
    expect(json).not.toContain('"sample"')
    expect(json).not.toContain(GH)
  })

  it('依頼文は印だけから組まれる', () => {
    expect(buildWriteFixPrompt([mark('a.js', 'known-key', 3)])).not.toMatch(/\d+文字/)
  })
})

describe('E. 読む口（リンクと大きさ）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfix-'))
  const proj = path.join(tmp, 'proj')
  const outside = path.join(tmp, 'outside.txt')
  fs.mkdirSync(proj)
  fs.writeFileSync(outside, 'outside')
  fs.writeFileSync(path.join(proj, 'a.js'), 'inside')
  fs.symlinkSync(outside, path.join(proj, 'link.js'))
  fs.mkdirSync(path.join(proj, 'sub'))

  it('プロジェクトの中は読める・無いものは missing', () => {
    expect(readForWriteFixFs(proj, 'a.js')).toEqual({ state: 'text', content: 'inside' })
    expect(readForWriteFixFs(proj, 'none.js')).toEqual({ state: 'missing' })
  })
  it('外を指すリンク・外へ出る・絶対パス・フォルダは読まない', () => {
    expect(readForWriteFixFs(proj, 'link.js')).toEqual({ state: 'unreadable' })
    expect(readForWriteFixFs(proj, '../outside.txt')).toEqual({ state: 'unreadable' })
    expect(readForWriteFixFs(proj, outside)).toEqual({ state: 'unreadable' })
    expect(readForWriteFixFs(proj, 'sub')).toEqual({ state: 'unreadable' })
  })
  it('大きすぎるファイルは読まない', () => {
    fs.writeFileSync(path.join(proj, 'big.js'), 'x'.repeat(WRITE_FIX_READ_LIMIT_BYTES + 1))
    expect(readForWriteFixFs(proj, 'big.js')).toEqual({ state: 'unreadable' })
  })
})
