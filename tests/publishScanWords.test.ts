import { describe, it, expect } from 'vitest'
import {
  publishScanViewOf, publishScanViewText, PUBLISH_SCAN_TITLE, PUBLISH_SCAN_PROGRESS, PUBLISH_SCAN_BUTTON_NO_AI, PUBLISH_SCAN_NO_AI_NOTE, PUBLISH_SCAN_AI_STOPPED_NOTE, GITHUB_SCAN_NOTE,
} from '../src/renderer/publishScanWords'
import type { PublishScanDone } from '../src/shared/publishScanTypes'
import type { ScanFinding } from '../src/shared/securityFindings'

const LAST = '見ているのは、キーやパスワードの直書きと、訪問者の入力をそのまま使う書き方（JavaScript・TypeScript・HTML）です。'
const NONE: PublishScanDone['notScanned'] = {
  tooLarge: [], tooLargeCount: 0, unreadable: [], unreadableCount: 0, longLine: [], longLineCount: 0,
  binary: [], binaryCount: 0, sample: [], sampleCount: 0, overTotal: [], overTotalCount: 0, listTruncated: false,
}
const done = (o: Partial<PublishScanDone> = {}): PublishScanDone => ({
  state: 'done', scope: 'publish', mode: 'static', listed: 3, scanned: 3, findings: [], findingsTotal: 0,
  notScanned: { ...NONE },
  ...o,
})
const nowF = (i: number): ScanFinding => ({ kind: 'known-key', severity: 'now', file: `a${i}.js`, line: 1, length: 40, sample: 'ghp_…' })
const shouldF = (i: number): ScanFinding => ({ kind: 'input-to-command', severity: 'should', file: `b${i}.js`, line: 2 })
const withFindings = (fs: ScanFinding[], total = fs.length) => done({ findings: fs, findingsTotal: total })

describe('指摘あり', () => {
  it('now と should の両方', () => {
    const v = publishScanViewOf(withFindings([nowF(1), shouldF(1)]))
    expect(v.verdict).toBe('warn')
    expect(v.lines).toEqual([
      { kind: 'head', text: '⚠️ 公開されるファイルに、気をつけたい点が2件あります。' },
      { kind: 'group', text: 'すぐ直す' },
      { kind: 'finding', text: '・a1.js:1 APIキーが直接書かれています（ghp_…・40文字）' },
      { kind: 'group', text: '直したほうがよい' },
      { kind: 'finding', text: '・b1.js:2 訪問者の入力を、そのままコマンドに使っています' },
      { kind: 'note', text: LAST },
    ])
  })
  it('片方だけなら、もう片方の小見出しは出ない', () => {
    const t = (fs: ScanFinding[]) => publishScanViewOf(withFindings(fs)).lines.filter(l => l.kind === 'group').map(l => l.text)
    expect(t([nowF(1)])).toEqual(['すぐ直す'])
    expect(t([shouldF(1)])).toEqual(['直したほうがよい'])
  })
  it('21件は20件並べて「ほか1件」', () => {
    const fs = Array.from({ length: 21 }, (_, i) => nowF(i))
    const lines = publishScanViewOf(withFindings(fs)).lines
    expect(lines.filter(l => l.kind === 'finding')).toHaveLength(21)
    expect(lines.filter(l => l.kind === 'finding' && l.text.startsWith('・a')).length).toBe(20)
    expect(lines.filter(l => l.kind === 'finding').pop()!.text).toBe('・ほか1件')
    expect(lines[0].text).toBe('⚠️ 公開されるファイルに、気をつけたい点が21件あります。')
  })
  it('findingsTotal が findings より多いときは差を「ほか」に出す', () => {
    const lines = publishScanViewOf(withFindings([nowF(1)], 501)).lines
    expect(lines[0].text).toBe('⚠️ 公開されるファイルに、気をつけたい点が501件あります。')
    expect(lines.find(l => l.text.startsWith('・ほか'))!.text).toBe('・ほか500件')
  })
  it('✅ と一緒に出ない', () => {
    const text = publishScanViewText(publishScanViewOf(withFindings([nowF(1)])))
    expect(text).not.toContain('✅')
  })
})

describe('指摘なし', () => {
  it('✅', () => {
    const v = publishScanViewOf(done({ scanned: 7 }))
    expect(v.verdict).toBe('ok')
    expect(v.lines).toEqual([
      { kind: 'head', text: '✅ 点検した7個のファイルに、キーやパスワードの直書きなどは見つかりませんでした。' },
      { kind: 'text', text: '見つからないことは、安全の保証ではありません。' },
      { kind: 'note', text: LAST },
    ])
    expect(publishScanViewText(v)).not.toContain('⚠️')
  })
  it('点検できたものが0で、点検できなかったものがある回は ⏭（✅ にしない）', () => {
    for (const ns of [{ tooLargeCount: 1, tooLarge: ['big.js'] }, { unreadableCount: 1, unreadable: ['l.js'] }, { overTotalCount: 2, overTotal: ['a.js', 'b.js'] }, { listTruncated: true }]) {
      const d = done({ scanned: 0 })
      d.notScanned = { ...d.notScanned, ...ns }
      const v = publishScanViewOf(d)
      expect(v.verdict).toBe('skip')
      expect(v.lines[0]).toEqual({ kind: 'head', text: '⏭ 点検できるファイルを読めませんでした。' })
      expect(publishScanViewText(v)).not.toContain('✅')
    }
  })
  it('指摘0件で点検したファイルがあっても、点検できなかったものがある回は ⚠️（✅ にしない）', () => {
    for (const ns of [{ tooLargeCount: 1, tooLarge: ['big.js'] }, { unreadableCount: 1, unreadable: ['l.js'] }, { overTotalCount: 2, overTotal: ['a.js', 'b.js'] }, { listTruncated: true }]) {
      const d = done({ scanned: 4 })
      d.notScanned = { ...d.notScanned, ...ns }
      const v = publishScanViewOf(d)
      expect(v.verdict).toBe('warn')
      expect(v.lines[0]).toEqual({ kind: 'head', text: '⚠️ 点検できなかったファイルがあります。' })
      expect(v.lines[1]).toEqual({ kind: 'text', text: '点検した4個のファイルには、キーやパスワードの直書きなどは見つかりませんでした。' })
      expect(v.lines.slice(2).every(l => l.kind === 'note')).toBe(true)
      expect(publishScanViewText(v)).not.toContain('✅')
      const g = publishScanViewOf({ ...d, scope: 'github', mode: null })
      expect(g.verdict).toBe('warn')
      expect(g.lines[1]).toEqual({ kind: 'text', text: '点検した4個のファイルには、キーやパスワードの直書きは見つかりませんでした。' })
    }
  })
  it('文字として読めない・見本の名前・行が長すぎるだけなら ✅ のまま', () => {
    for (const ns of [{ binary: ['a.bin'], binaryCount: 1 }, { sample: ['c.example.js'], sampleCount: 1 }, { longLine: ['m.js'], longLineCount: 1 }]) {
      for (const scope of ['publish', 'github'] as const) {
        const d = done({ scanned: 3, scope, mode: scope === 'github' ? null : 'static' })
        d.notScanned = { ...d.notScanned, ...ns }
        const v = publishScanViewOf(d)
        expect(v.verdict).toBe('ok')
        expect(v.lines[0].text.startsWith('✅')).toBe(true)
      }
    }
  })
  it('指摘があれば、点検できなかったものがあっても今までの ⚠️ の形', () => {
    const d = withFindings([nowF(1)])
    d.notScanned = { ...d.notScanned, tooLargeCount: 1, tooLarge: ['big.js'] }
    const v = publishScanViewOf(d)
    expect(v.lines[0].text).toBe('⚠️ 公開されるファイルに、気をつけたい点が1件あります。')
    expect(v.lines.some(l => l.text === '⚠️ 点検できなかったファイルがあります。')).toBe(false)
  })
  it('点検するファイルが無い回は ℹ️', () => {
    const v = publishScanViewOf(done({ scanned: 0, listed: 0 }))
    expect(v.verdict).toBe('ok')
    expect(v.lines).toEqual([{ kind: 'head', text: 'ℹ️ 点検するファイルがありません。' }, { kind: 'note', text: LAST }])
  })
})

describe('注記', () => {
  const full = (scope: 'publish' | 'github' = 'publish') => {
    const d = done({ scope, mode: scope === 'github' ? null : 'static', scanned: 2, findings: [nowF(1)], findingsTotal: 1 })
    d.notScanned = {
      tooLarge: ['a.js', 'b.js'], tooLargeCount: 4, unreadable: ['l.js'], unreadableCount: 1,
      overTotal: ['o.js'], overTotalCount: 3, binary: ['x.dat'], binaryCount: 1, sample: ['c.example.js'], sampleCount: 1,
      longLine: ['m.js'], longLineCount: 1, listTruncated: true,
    }
    return d
  }
  const notesOfView = (d: PublishScanDone) => publishScanViewOf(d).lines.filter(l => l.kind === 'note').map(l => l.text)
  it('この順で並ぶ（publish は末尾の注記つき）', () => {
    expect(notesOfView(full())).toEqual([
      '大きすぎるため点検していません: a.js、b.js ほか2件',
      '読めないため点検していません: l.js',
      '量が多いため点検していません: o.js ほか2件',
      '文字として読めないため点検していません: x.dat',
      '見本の名前のため点検していません: c.example.js',
      '行が長すぎるため、訪問者の入力の書き方を見ていません: m.js',
      'ファイルが多いため、一部のファイルは一覧に入っていません。',
      LAST,
    ])
  })
  it("'github' は末尾の注記を出さない", () => {
    const n = notesOfView(full('github'))
    expect(n).toHaveLength(7)
    expect(n.some(t => t.startsWith('見ているのは'))).toBe(false)
    expect(notesOfView(done({ scope: 'github', mode: null }))).toEqual([])
  })
  it('指摘がなくても同じ注記が出る', () => {
    const d = { ...full(), findings: [], findingsTotal: 0 }
    expect(notesOfView(d)).toHaveLength(8)
  })
  it('古い文は出ない', () => {
    expect(publishScanViewText(publishScanViewOf(full()))).not.toContain('AI は使っていません')
    expect(publishScanViewText(publishScanViewOf(full()))).not.toContain('個のファイルは点検していません。')
  })
})

describe('届かない回', () => {
  it('bad-dir', () => {
    expect(publishScanViewOf({ state: 'bad-dir' })).toEqual({ verdict: 'skip', lines: [{ kind: 'head', text: '⏭ プロジェクトのフォルダを読めないため、点検できません。' }] })
  })
  it('failed', () => {
    expect(publishScanViewOf({ state: 'failed', message: '読めませんでした' })).toEqual({ verdict: 'skip', lines: [{ kind: 'failure', text: '⏭ 読めませんでした' }] })
  })
})

describe('文の決まり', () => {
  it('固定の文', () => {
    expect(PUBLISH_SCAN_TITLE).toBe('Koto の点検')
    expect(PUBLISH_SCAN_PROGRESS).toBe('公開されるファイルを点検しています…')
    expect(PUBLISH_SCAN_BUTTON_NO_AI).toBe('ファイルを点検する')
    expect(PUBLISH_SCAN_NO_AI_NOTE).toBe('AI による確認は行っていません（さくらのAI Engine のキーがありません）。')
    expect(PUBLISH_SCAN_AI_STOPPED_NOTE).toBe('AI の確認は、中止したため行っていません。')
    expect(GITHUB_SCAN_NOTE).toBe('キーやパスワードの直書きと、秘密が入っていそうな名前のファイルがないかを、Koto が点検します。AI は使いません。')
  })
  it('禁じる語を使わない', () => {
    const d = done({ scanned: 2, findings: [nowF(1), shouldF(1)], findingsTotal: 30 })
    d.notScanned = { ...d.notScanned, tooLargeCount: 1, tooLarge: ['a.js'], unreadableCount: 1, unreadable: ['b.js'], overTotalCount: 1, overTotal: ['c.js'], binaryCount: 1, binary: ['d.bin'], sampleCount: 1, sample: ['e.example.js'], listTruncated: true }
    const all = [
      publishScanViewText(publishScanViewOf(d)), publishScanViewText(publishScanViewOf(done())),
      publishScanViewText(publishScanViewOf(done({ scanned: 0 }))), publishScanViewText(publishScanViewOf({ state: 'bad-dir' })),
      PUBLISH_SCAN_TITLE, PUBLISH_SCAN_PROGRESS, PUBLISH_SCAN_BUTTON_NO_AI, PUBLISH_SCAN_NO_AI_NOTE, PUBLISH_SCAN_AI_STOPPED_NOTE,
    ].join('\n')
    for (const w of ['部品', '道具', '新しい版', 'つなぐ', '繋が', '無償', '無料', 'Claude Code', 'OWASP', '準拠', '対策済み', '①', '②', '③']) {
      expect(all).not.toContain(w)
    }
  })
})

describe('注記のファイル名', () => {
  it('制御文字・改行は除かれ、行が増えない', () => {
    const v = publishScanViewOf(done({
      notScanned: { ...NONE, tooLarge: ['a\nb\u0007.js'], tooLargeCount: 1, unreadable: ['c\r\nd.js'], unreadableCount: 1 },
    }))
    for (const l of v.lines.filter(x => x.kind === 'note')) expect(l.text).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(v.lines.filter(x => x.kind === 'note')).toHaveLength(3)
  })
})

describe('行が長すぎる注記', () => {
  const notes = (o: Partial<PublishScanDone['notScanned']>) =>
    publishScanViewOf(done({ notScanned: { ...done().notScanned, ...o } })).lines.filter(l => l.kind === 'note').map(l => l.text)
  it('名前と、残りの件数つき', () => {
    expect(notes({ longLine: ['app.min.js'], longLineCount: 3 })[0]).toBe('行が長すぎるため、訪問者の入力の書き方を見ていません: app.min.js ほか2件')
  })
  it('量が多いため…の次・末尾の注記の前', () => {
    const t = notes({ unreadable: ['u.js'], unreadableCount: 1, longLine: ['a.js'], longLineCount: 1, overTotal: ['o.js'], overTotalCount: 2 })
    expect(t.map(x => x.split(':')[0].slice(0, 6))).toEqual(['読めないため', '量が多いため', '行が長すぎる', LAST.slice(0, 6)])
  })
  it('0件なら出ない', () => {
    expect(notes({}).some(t => t.startsWith('行が長すぎる'))).toBe(false)
  })
})

describe("範囲が github の文", () => {
  const g = (o: Partial<PublishScanDone> = {}) => done({ scope: 'github', mode: null, ...o })
    it('指摘あり', () => {
    const v = publishScanViewOf(g({ findings: [{ kind: 'secret-name', severity: 'should', file: 'credentials.json' }], findingsTotal: 1 }))
    expect(v.lines).toEqual([
      { kind: 'head', text: '⚠️ 保存されるファイルに、気をつけたい点が1件あります。' },
      { kind: 'group', text: '直したほうがよい' },
      { kind: 'finding', text: '・credentials.json 秘密が入っていそうなファイルが、保存されるものに入っています' },
    ])
  })
  it('指摘なし', () => {
    expect(publishScanViewOf(g()).lines).toEqual([
      { kind: 'head', text: '✅ 点検した3個のファイルに、キーやパスワードの直書きは見つかりませんでした。' },
      { kind: 'text', text: '見つからないことは、安全の保証ではありません。' },
    ])
  })
})
