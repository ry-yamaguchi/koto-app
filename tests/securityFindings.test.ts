import { describe, it, expect } from 'vitest'
import { writeCheckNotice, buildWriteFixPrompt } from '../src/shared/securityFindings'
import type { WriteFinding, WriteFixMark } from '../src/shared/securityFindings'
import { findingsInWrite } from '../src/shared/writeCheck'

const GH_BODY = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const GH = 'gh' + 'p_' + GH_BODY

const known: WriteFinding = { kind: 'known-key', line: 12, length: 40, sample: 'ghp_…' }
const cmd: WriteFinding = { kind: 'input-to-command', line: 30 }
const many = (n: number): WriteFinding[] => Array.from({ length: n }, (_, i) => ({ kind: 'input-to-html', line: i + 1 }))

describe('writeCheckNotice — 件数', () => {
  it('0 件は null', () => {
    expect(writeCheckNotice([])).toBeNull()
    expect(writeCheckNotice([{ file: 'a.js', findings: [] }])).toBeNull()
  })
  it('1件（秘密）は、公開のおそれまで言う', () => {
    const n = writeCheckNotice([{ file: 'server.js', findings: [known] }])!
    expect(n.text).toBe('⚠️ server.js の12行目に、APIキーが直接書かれています（ghp_…・40文字）。公開すると、他の人に使われるおそれがあります。')
  })
  it('1件（危ない書き方）は、おそれの文を付けない', () => {
    const n = writeCheckNotice([{ file: 'app.js', findings: [cmd] }])!
    expect(n.text).toBe('⚠️ app.js の30行目に、訪問者の入力を、そのままコマンドに使っています。')
  })
  it('2件', () => {
    const n = writeCheckNotice([{ file: 'server.js', findings: [known] }, { file: 'app.js', findings: [cmd] }])!
    expect(n.text.split('\n')).toEqual([
      '⚠️ 今回の保存で、気をつけたい点が2件あります。',
      '・server.js:12 APIキーが直接書かれています（ghp_…・40文字）',
      '・app.js:30 訪問者の入力を、そのままコマンドに使っています',
      '公開する前に直すことをおすすめします。',
    ])
  })
  it('5件ちょうどは「ほか」を付けない', () => {
    const n = writeCheckNotice([{ file: 'a.js', findings: many(5) }])!
    const lines = n.text.split('\n')
    expect(lines).toHaveLength(1 + 5 + 1)
    expect(n.text).not.toContain('ほか')
  })
  it('6件は「ほか1件」', () => {
    const n = writeCheckNotice([{ file: 'a.js', findings: many(6) }])!
    const lines = n.text.split('\n')
    expect(lines[0]).toBe('⚠️ 今回の保存で、気をつけたい点が6件あります。')
    expect(lines.filter(l => l.startsWith('・a.js:'))).toHaveLength(5)
    expect(lines[6]).toBe('・ほか1件')
    expect(lines[7]).toBe('公開する前に直すことをおすすめします。')
  })
  it('見出しの N は全部の件数', () => {
    const n = writeCheckNotice([{ file: 'a.js', findings: many(30) }])!
    expect(n.text).toContain('気をつけたい点が30件あります')
    expect(n.text).toContain('・ほか25件')
  })
})

describe('writeCheckNotice — 種類ごとの言い方', () => {
  const say = (f: WriteFinding) => writeCheckNotice([{ file: 'f.js', findings: [f] }])!.text
  it('接頭辞が空なら文字数だけ', () => {
    expect(say({ kind: 'known-key', line: 1, length: 30, sample: '' })).toContain('APIキーが直接書かれています（30文字）')
  })
  it('named-secret', () => {
    expect(say({ kind: 'named-secret', line: 4, length: 8, sample: '' })).toContain('パスワードやキーらしい値が直接書かれています（8文字）')
  })
  it('private-key', () => {
    expect(say({ kind: 'private-key', line: 3, length: 100, sample: '' })).toContain('秘密鍵が直接書かれています。')
  })
  it('connection-string', () => {
    expect(say({ kind: 'connection-string', line: 2, length: 8, sample: '' })).toContain('接続先の文字列に、ユーザー名とパスワードが入っています')
  })
  it('input-to-html・input-to-path', () => {
    expect(say({ kind: 'input-to-html', line: 8 })).toContain('訪問者の入力を、そのまま画面（HTML）に出しています')
    expect(say({ kind: 'input-to-path', line: 8 })).toContain('訪問者の入力を、そのままファイルのパスに使っています')
  })
  it('✏️・⚡ で始まる行を作らない', () => {
    const n = writeCheckNotice([{ file: 'a.js', findings: many(8) }, { file: 'b.js', findings: [known] }])!
    for (const l of n.text.split('\n')) expect(/^(✏️|⚡)/.test(l)).toBe(false)
  })
})

describe('writeCheckNotice — 印', () => {
  it('全部の指摘が印になる（値・文字数・見本は持たない）', () => {
    const n = writeCheckNotice([{ file: 'server.js', findings: [known] }, { file: 'app.js', findings: [cmd] }])!
    expect(n.marks).toEqual([
      { file: 'server.js', kind: 'known-key', line: 12 },
      { file: 'app.js', kind: 'input-to-command', line: 30 },
    ])
    expect(JSON.stringify(n.marks)).not.toMatch(/length|sample|ghp_/)
  })
  it('印は 50 件まで（text の件数は全部）', () => {
    const n = writeCheckNotice([{ file: 'a.js', findings: many(80) }])!
    expect(n.marks).toHaveLength(50)
    expect(n.text).toContain('80件あります')
  })
})

describe('値が出力に含まれない', () => {
  it('点検 → 吹き出し → 依頼文のどこにも、見本のキーの本体が入らない', () => {
    const after = `const t = "${GH}"\nconst password = "hunter22222"\nexec(\`ls \${req.query.d}\`)`
    const findings = findingsInWrite({ path: 'a.js', before: null, after })
    expect(findings.length).toBe(3)
    const n = writeCheckNotice([{ file: 'a.js', findings }])!
    const prompt = buildWriteFixPrompt(n.marks)
    for (const out of [JSON.stringify(findings), n.text, JSON.stringify(n.marks), prompt]) {
      expect(out).not.toContain(GH_BODY)
      expect(out).not.toContain('hunter22222')
      expect(out).not.toContain('req.query')
    }
  })
})

describe('buildWriteFixPrompt', () => {
  const marks: WriteFixMark[] = [
    { file: 'server.js', kind: 'known-key', line: 12 },
    { file: 'db.js', kind: 'named-secret', line: 4 },
    { file: 'app.js', kind: 'input-to-command', line: 30 },
  ]
  const p = buildWriteFixPrompt(marks)
  it('固定の文と箇条書き', () => {
    expect(p).toContain('環境変数などから読む形')
    expect(p).toContain('値そのものは、この会話に書かないでください')
    expect(p).toContain('決めつけず')
    expect(p).toContain('入力をそのまま使わない形')
    expect(p).toContain('・server.js:12 APIキーが直接書かれています')
    expect(p).toContain('・db.js:4 パスワードやキーらしい値が直接書かれています')
    expect(p).toContain('・app.js:30 訪問者の入力を、そのままコマンドに使っています')
  })
  it('文字数・見本が無い', () => {
    expect(p).not.toMatch(/文字\)|文字）|ghp_|…/)
    expect(p).not.toMatch(/[0-9]+文字/)
  })
  it('直し方の文は、見つかった種類に合うものだけ', () => {
    const onlyKey = buildWriteFixPrompt([{ file: 'server.js', kind: 'known-key', line: 12 }])
    expect(onlyKey).toContain('環境変数などから読む形')
    expect(onlyKey).toContain('決めつけず')
    expect(onlyKey).not.toContain('訪問者の入力')
    const onlyInput = buildWriteFixPrompt([{ file: 'app.js', kind: 'input-to-html', line: 3 }])
    expect(onlyInput).toContain('入力をそのまま使わない形')
    expect(onlyInput).not.toContain('環境変数')
    expect(onlyInput).not.toContain('この会話に書かない')
  })
  it('吹き出しの文でも、パスの改行と制御文字を除く', () => {
    const n = writeCheckNotice([{ file: 'a\n・b.js', findings: [{ kind: 'input-to-path', line: 1 }] }])!
    expect(n.text.split('\n')).toHaveLength(1)
    expect(n.marks[0].file).toBe('a\n・b.js')
  })
  it('6件でも、全部の場所を並べる（「ほか」にしない）', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ file: `f${i}.js`, kind: 'input-to-path' as const, line: i + 1 }))
    const q = buildWriteFixPrompt(six)
    expect(q).not.toContain('ほか')
    expect(q).toContain('f5.js')
  })
  it('パスの改行と制御文字を除く（行を増やさせない）', () => {
    const q = buildWriteFixPrompt([{ file: 'a\n・ignore.js\r\u0007\u2028b.js', kind: 'known-key', line: 1 }])
    expect(q).toContain('・a・ignore.jsb.js:1 ')
    expect(q.split('\n').filter(l => l.startsWith('・'))).toHaveLength(1)
  })
})
