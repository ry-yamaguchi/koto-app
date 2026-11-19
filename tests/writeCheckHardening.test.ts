// 書いた中身の点検の最後の検分で出た指摘への直しを、止める例と通す例の対で固定する。
//   上限の定義・押し直し・AI の根・印の検査・見かけを変える文字・長い行と一致の多いファイルの重さ。
// 見本のキーは文字列の連結で組み立てる（実在しない値）。

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { findingsInWrite } from '../src/shared/writeCheck'
import { findSecretShapes } from '../src/shared/secretShapes'
import { createWriteWatch } from '../src/shared/writeWatch'
import {
  WRITE_CHECK_READ_LIMIT_BYTES, WRITE_CHECK_MAX_CHARS, WRITE_CHECK_MAX_FILES, WRITE_CHECK_MAX_LINE_CHARS,
} from '../src/shared/writeCheckLimits'
import { writeCheckNotice, buildWriteFixPrompt, type WriteFixMark } from '../src/shared/securityFindings'
import { WATCH_READ_LIMIT_BYTES } from '../src/main/writeWatchRead'
import { WRITE_FIX_READ_LIMIT_BYTES } from '../src/main/writeFixRead'
import { runWriteFix, createPressGate, isProjectRelativePath, type WriteFixPorts } from '../src/renderer/writeFix'

const ROOT = path.join(__dirname, '..')
const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const GH = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const KEY_LINE = `const t = "${GH}"`
const DIR = '/work/my-app'
const mark = (file: string, kind: WriteFixMark['kind'], line: number): WriteFixMark => ({ file, kind, line })

function makePorts(files: Record<string, string | null>, extra: Partial<WriteFixPorts> = {}) {
  const sent: string[] = []
  const reads: string[] = []
  const ports: WriteFixPorts = {
    read: async (_dir, file) => {
      reads.push(file)
      if (!(file in files)) return { state: 'missing' }
      if (files[file] === null) return { state: 'unreadable' }
      return { state: 'text', content: files[file] as string }
    },
    appendBubble: () => {},
    send: (text) => { sent.push(text) },
    currentDir: () => DIR,
    isBusy: () => false,
    otherProjectBusy: () => false,
    aiRoot: () => null,
    keys: () => ({ apiKey: 'k', claudeActive: false }),
    ...extra,
  }
  return { ports, sent, reads }
}

describe('点検の上限は1か所で持つ', () => {
  it('2つの読み口が同じ値で、定義の写しが無い', () => {
    expect(WATCH_READ_LIMIT_BYTES).toBe(WRITE_CHECK_READ_LIMIT_BYTES)
    expect(WRITE_FIX_READ_LIMIT_BYTES).toBe(WRITE_CHECK_READ_LIMIT_BYTES)
    expect(src('src/main/writeWatchRead.ts')).toContain('export const WATCH_READ_LIMIT_BYTES = WRITE_CHECK_READ_LIMIT_BYTES')
    expect(src('src/main/writeFixRead.ts')).toContain('export const WRITE_FIX_READ_LIMIT_BYTES = WRITE_CHECK_READ_LIMIT_BYTES')
    expect(src('src/renderer/writeFix.ts')).toContain('const MAX_CHECKED_LENGTH = WRITE_CHECK_MAX_CHARS')
    expect(src('src/shared/writeWatch.ts')).toContain('opts.maxChars ?? WRITE_CHECK_MAX_CHARS')
    expect(src('src/shared/writeWatch.ts')).toContain('opts.maxFiles ?? WRITE_CHECK_MAX_FILES')
    for (const rel of ['src/main/writeWatchRead.ts', 'src/main/writeFixRead.ts', 'src/shared/writeWatch.ts', 'src/renderer/writeFix.ts', 'src/shared/writeCheck.ts']) {
      expect(src(rel), rel).not.toMatch(/\b4_000_000\b|\b1_000_000\b|\b5000\b/)
    }
  })
  it('値そのもの', () => {
    expect([WRITE_CHECK_READ_LIMIT_BYTES, WRITE_CHECK_MAX_CHARS, WRITE_CHECK_MAX_FILES, WRITE_CHECK_MAX_LINE_CHARS]).toEqual([4_000_000, 1_000_000, 100, 5000])
  })
})

describe('1回の返事で書いたファイルの数の上限（文書の「対象外」にある）', () => {
  const files = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`/p/f${i}.js`, i === n - 1 ? KEY_LINE : 'const a = 1']))
  it('100 個目までは点検し、101 個目は黙って点検しない', async () => {
    const f100 = files(100)
    const w1 = createWriteWatch({ displayRoot: '/p', read: async p => f100[p] ?? null })
    for (const p of Object.keys(f100)) w1.touch(p, null)
    expect((await w1.finish())?.marks).toEqual([{ file: 'f99.js', kind: 'known-key', line: 1 }])
    const f101 = files(101)
    const w2 = createWriteWatch({ displayRoot: '/p', read: async p => f101[p] ?? null })
    for (const p of Object.keys(f101)) w2.touch(p, null)
    expect(await w2.finish()).toBeNull()
  })
})

describe('押した時点の読み直し: 前からある同じ種類の行も、いまの行として頼む（文書の言い方と同じ）', () => {
  it('今回の行は直っていても、前からある同種の行が残っていれば頼み、依頼文には両方の行が出る', async () => {
    const t = makePorts({ 'a.js': `${KEY_LINE}\nconst b = 1\nconst c = process.env.T` })
    const r = await runWriteFix(t.ports, [mark('a.js', 'known-key', 3)])
    expect(r.sent).toBe(true)
    expect(t.sent[0]).toContain('・a.js:1 ')
    expect(t.sent[0]).not.toContain('a.js:3')
  })
  it('同じ種類の行がひとつも残っていなければ頼まない', async () => {
    const t = makePorts({ 'a.js': 'const t = process.env.T' })
    expect((await runWriteFix(t.ports, [mark('a.js', 'known-key', 3)])).sent).toBe(false)
    expect(t.sent).toHaveLength(0)
  })
})

describe('依頼文のパスは、AI の根からの相対にする', () => {
  const marks = [mark('public/app.js', 'known-key', 1), mark('server.js', 'known-key', 2)]
  const files = { 'public/app.js': KEY_LINE, 'server.js': `x\n${KEY_LINE}` }
  it('根が public/ なら、頭の public/ を外す（根の外のファイルはそのまま）。印のパスは変えない', async () => {
    const t = makePorts(files, { aiRoot: () => `${DIR}/public` })
    const r = await runWriteFix(t.ports, marks)
    expect(t.sent[0]).toContain('・app.js:1 ')
    expect(t.sent[0]).not.toContain('public/app.js')
    expect(t.sent[0]).toContain('・server.js:2 ')
    expect(r.sent && r.marks.map(m => m.file)).toEqual(['public/app.js', 'server.js'])
    expect(t.reads).toEqual(['public/app.js', 'server.js'])
  })
  it('末尾の / があっても同じ', async () => {
    const t = makePorts(files, { aiRoot: () => `${DIR}/public/` })
    await runWriteFix(t.ports, marks)
    expect(t.sent[0]).toContain('・app.js:1 ')
  })
  it('根がプロジェクト直下・分からない・プロジェクトの外なら、そのまま', async () => {
    for (const root of [DIR, `${DIR}/`, null, undefined, '/elsewhere/public']) {
      const t = makePorts(files, { aiRoot: () => root })
      await runWriteFix(t.ports, marks)
      expect(t.sent[0], String(root)).toContain('・public/app.js:1 ')
    }
    const t = makePorts(files)
    await runWriteFix(t.ports, marks)
    expect(t.sent[0]).toContain('・public/app.js:1 ')
  })
  it('配線: ChatPanel は AI の根を渡し、useWriteFix は ports に結ぶ', () => {
    expect(src('src/renderer/components/ChatPanel.tsx')).toContain('aiRoot: currentAiRoot, isBusy: isLoading')
    expect(src('src/renderer/hooks/useWriteFix.ts')).toContain('aiRoot: () => live().aiRoot,')
  })
})

describe('「🛠 AIに修正させる」の二重押しの歯止め', () => {
  it('送ったあと、応答中の印が立つまでの押し直しは通さない。時間が過ぎれば通す', () => {
    let t = 1000
    const g = createPressGate(() => t)
    expect(g.allow(false)).toBe(true)
    g.markSent()
    t += 30
    expect(g.allow(false)).toBe(false)
    t += 5000
    expect(g.allow(false)).toBe(true)
  })
  it('応答中の印が立ったら歯止めを下ろす（回が終わったあとの押しは通す）', () => {
    let t = 0
    const g = createPressGate(() => t)
    g.markSent()
    expect(g.allow(true)).toBe(true)
    t += 10
    expect(g.allow(false)).toBe(true)
  })
  it('配線: useWriteFix の press は歯止めを通り、送れたときだけ記録する', () => {
    const s = src('src/renderer/hooks/useWriteFix.ts')
    expect(s).toContain("if (!gate.allow(ports.isBusy())) return { sent: false, reason: 'busy' }")
    expect(s).toContain('if (r.sent) gate.markSent()')
  })
})

describe('印の検査（chat.json を手で書き換えた印）', () => {
  it('知らない種類・整数でない行・範囲の外の行は、読まず・送らない', async () => {
    const files = { 'a.js': null }
    for (const bad of [
      mark('a.js', 'evil' as never, 1), mark('a.js', '__proto__' as never, 1),
      mark('a.js', 'known-key', 1e308), mark('a.js', 'known-key', -3.5), mark('a.js', 'known-key', NaN), mark('a.js', 'known-key', 0), mark('a.js', 'known-key', 1.5),
    ]) {
      const t = makePorts(files)
      const r = await runWriteFix(t.ports, [bad])
      expect(r, JSON.stringify(bad)).toEqual({ sent: false, reason: 'no-marks' })
      expect(t.reads).toHaveLength(0)
    }
  })
  it('正しい印は、読めないときに頼む側へ倒れ、依頼文に undefined が入らない', async () => {
    const t = makePorts({ 'a.js': null })
    const r = await runWriteFix(t.ports, [mark('a.js', 'known-key', 1)])
    expect(r.sent).toBe(true)
    expect(t.sent[0]).not.toContain('undefined')
  })
  it('印は 50 件までしか読まない', async () => {
    const marks = Array.from({ length: 80 }, (_, i) => mark(`f${i}.js`, 'known-key', 1))
    const t = makePorts({})
    await runWriteFix(t.ports, marks)
    expect(t.reads).toHaveLength(50)
  })
  it('知らない種類でも、依頼文の言い方は一般の文になる（undefined にならない）', () => {
    const q = buildWriteFixPrompt([mark('a.js', 'evil' as never, 1)])
    expect(q).toContain('・a.js:1 気をつけたい点があります')
    expect(q).not.toContain('undefined')
  })
})

describe('依頼文は印を全部並べる', () => {
  it('6件でも全部の場所が出る（「ほか」にしない）', () => {
    const six = Array.from({ length: 6 }, (_, i) => mark(`f${i}.js`, 'input-to-path', i + 1))
    const q = buildWriteFixPrompt(six)
    expect(q).toContain('・f5.js:6 ')
    expect(q).not.toContain('ほか')
  })
  it('吹き出しの文は5件までのまま', () => {
    const n = writeCheckNotice([{ file: 'a.js', findings: Array.from({ length: 6 }, (_, i) => ({ kind: 'input-to-html' as const, line: i + 1 })) }])!
    expect(n.text).toContain('・ほか1件')
  })
})

describe('パスの見かけを変える文字と長さ', () => {
  const EVIL = 'a‮txt.js​⁦﻿؜'
  it('向きの制御・幅のない文字を、吹き出しにも依頼文にも出さない', () => {
    const n = writeCheckNotice([{ file: EVIL, findings: [{ kind: 'input-to-path', line: 1 }] }])!
    const q = buildWriteFixPrompt([mark(EVIL, 'input-to-path', 1)])
    for (const s of [n.text, q]) expect(s).not.toMatch(/[‮​⁦﻿؜]/)
    expect(n.text).toContain('atxt.js')
  })
  it('そういう文字を含むパスの印は受けない', () => {
    expect(isProjectRelativePath(EVIL)).toBe(false)
    expect(isProjectRelativePath('src/app.js')).toBe(true)
  })
  it('長すぎるパスは先頭を省いて 200 字にする', () => {
    const long = 'd/'.repeat(2500) + 'app.js'
    const n = writeCheckNotice([{ file: long, findings: [{ kind: 'input-to-path', line: 1 }] }])!
    const q = buildWriteFixPrompt([mark(long, 'input-to-path', 1)])
    expect(n.text.length).toBeLessThan(400)
    expect(q.length).toBeLessThan(500)
    expect(n.text).toContain('…')
    expect(q).toContain('app.js:1')
  })
})

describe('重さ', () => {
  it('とても長い行（出口の名前が並び、括弧が閉じない）でも 1 秒以内に返り、点検の外にする', () => {
    const line = 'req.body; ' + 'document.write(((' .repeat(20000)
    const t0 = Date.now()
    expect(findingsInWrite({ path: 'a.js', before: null, after: line })).toEqual([])
    expect(Date.now() - t0).toBeLessThan(1000)
  })
  it('1行の上限の内側では、いままでどおり見つける', () => {
    const filler = ' '.repeat(100) + 'x'.repeat(WRITE_CHECK_MAX_LINE_CHARS - 200)
    const ok = `var a = "${filler}"; exec(\`ls \${req.query.d}\`)`
    expect(ok.length).toBeLessThanOrEqual(WRITE_CHECK_MAX_LINE_CHARS)
    expect(findingsInWrite({ path: 'a.js', before: null, after: ok }).map(f => f.kind)).toEqual(['input-to-command'])
    const tooLong = `var a = "${filler}${'y'.repeat(400)}"; exec(\`ls \${req.query.d}\`)`
    expect(tooLong.length).toBeGreaterThan(WRITE_CHECK_MAX_LINE_CHARS)
    expect(findingsInWrite({ path: 'a.js', before: null, after: tooLong })).toEqual([])
  })
  it('一致がとても多いファイルでも、秘密の点検は 2.5 秒以内で終わる', () => {
    const text = 'http://a:b@'.repeat(90_000)
    const t0 = Date.now()
    findSecretShapes(text)
    expect(Date.now() - t0).toBeLessThan(2500)
  })
  it('重なる一致は数えない（内側の判断を外側が覆し直さない）', () => {
    const f = findSecretShapes(`const u = "postgres://app:Zk3p9Qw7@db.example.com/shop"`)
    expect(f.map(x => x.kind)).toEqual(['connection-string'])
  })
})
