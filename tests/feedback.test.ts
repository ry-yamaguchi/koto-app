import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { buildFeedbackBody, buildFeedbackUrl } from '../src/main/feedback'

// 宛先は公開リポジトリなので、投稿は誰でも読める。雛形の2段落目で、秘密を書かないよう先に伝える。
// 文は画面に出るとおりに、ここへ書き下す（作り手の定数を読むと、文が消えても通ってしまう）。
const PUBLIC_NOTICE = '※ この投稿は誰でも読めます。パスワード・APIキー・お客様の情報は書かないでください。'

describe('buildFeedbackBody', () => {
  it('starts with the guidance line and includes version/OS info after a divider', () => {
    const body = buildFeedbackBody('0.2.64', '25.5.0', 'arm64')
    expect(body.startsWith('（お気づきの点・不具合・要望をご記入ください）')).toBe(true)
    expect(body).toContain('---')
    expect(body).toContain('Koto v0.2.64 / macOS 25.5.0 (arm64)')
  })

  it('never includes secret-looking substrings by construction (only version/os/arch are interpolated)', () => {
    const body = buildFeedbackBody('1.0.0', '24.0.0', 'x64')
    expect(body).not.toMatch(/key|token|secret|password/i)
  })

  it('本文の全体: 案内文・公開される旨の注意・区切り線・環境情報の順で、段落ごとに空行で分ける', () => {
    expect(buildFeedbackBody('0.2.64', '25.5.0', 'arm64')).toBe(
      '（お気づきの点・不具合・要望をご記入ください）\n\n' +
      PUBLIC_NOTICE + '\n\n' +
      '---\n' +
      'Koto v0.2.64 / macOS 25.5.0 (arm64)\n',
    )
  })

  it('公開される旨の注意は1回だけ、案内文の次の段落（区切り線より前）に出る', () => {
    const body = buildFeedbackBody('0.2.64', '25.5.0', 'arm64')
    expect(body.split(PUBLIC_NOTICE)).toHaveLength(2)
    const paragraphs = body.split('\n\n')
    expect(paragraphs[0]).toBe('（お気づきの点・不具合・要望をご記入ください）')
    expect(paragraphs[1]).toBe(PUBLIC_NOTICE)
    expect(body.indexOf(PUBLIC_NOTICE)).toBeLessThan(body.indexOf('---'))
  })

  it('注意の文は、版・OS・arch の値に左右されない', () => {
    for (const [v, os, a] of [['0.2.64', '25.5.0', 'arm64'], ['1.0.0', '24.0.0', 'x64'], ['', '', '']]) {
      expect(buildFeedbackBody(v, os, a)).toContain('\n\n' + PUBLIC_NOTICE + '\n\n---\n')
    }
  })
})

describe('buildFeedbackUrl', () => {
  it('points at the koto repository issues/new endpoint', () => {
    const url = buildFeedbackUrl('0.2.64', '25.5.0', 'arm64')
    expect(url.startsWith('https://github.com/ry-yamaguchi/koto-app/issues/new?body=')).toBe(true)
    // ★ 宛先が**非公開**リポジトリに戻っていないこと（2026-09-16 の実機で 404 になった当の欠陥）。
    //   `koto-app` は `koto` を含むので、startsWith だけでは戻りを検知できない。
    expect(url).not.toMatch(/github\.com\/ry-yamaguchi\/koto\/issues/)
  })

  it('URL-encodes the body so it round-trips back to buildFeedbackBody output', () => {
    const url = buildFeedbackUrl('0.2.64', '25.5.0', 'arm64')
    const encoded = url.split('?body=')[1]
    expect(decodeURIComponent(encoded)).toBe(buildFeedbackBody('0.2.64', '25.5.0', 'arm64'))
  })

  it('メニューから開くURLの本文に、公開される旨の注意がそのまま入る（URLエンコードを通しても崩れない）', () => {
    const url = buildFeedbackUrl('0.2.64', '25.5.0', 'arm64')
    const params = new URL(url).searchParams
    const body = params.get('body') ?? ''
    expect(body).toContain('\n\n' + PUBLIC_NOTICE + '\n\n---\n')
    expect(body.startsWith('（お気づきの点・不具合・要望をご記入ください）')).toBe(true)
  })
})

// アプリからリポジトリへ向かう入口は、ヘルプメニューの「フィードバックを送る…」の1つだけ。
// 別の入口が Issue の新規作成URLを自前で組むと、公開される旨の注意を通らずに開く。
describe('フィードバックの入口は1つ（注意を通らない道を作らない）', () => {
  const ROOT = join(__dirname, '..')
  const SRC = join(ROOT, 'src')
  const sourceFiles = (dir: string): string[] => {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
      else if (/\.tsx?$/.test(name)) out.push(p)
    }
    return out
  }
  /** コメントの行を除いた行。 */
  const codeLines = (code: string): string[] => code.split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l))

  it('Issue の新規作成URL（issues/new）を書いているのは feedback.ts だけ', () => {
    const files = sourceFiles(SRC).filter(f => codeLines(readFileSync(f, 'utf-8')).some(l => l.includes('issues/new')))
    expect(files.map(f => relative(ROOT, f))).toEqual(['src/main/feedback.ts'])
  })

  it('メニューの項目は作り手の buildFeedbackUrl を通して開く（呼び出しの形ごと）', () => {
    const main = readFileSync(join(SRC, 'main', 'main.ts'), 'utf-8')
    expect(main).toContain("{ label: 'フィードバックを送る…', click: () => shell.openExternal(buildFeedbackUrl(app.getVersion(), process.getSystemVersion(), process.arch)) }")
    // buildFeedbackUrl を呼ぶのは、この1か所だけ
    const callers = sourceFiles(SRC)
      .filter(f => !f.endsWith(join('main', 'feedback.ts')))
      .flatMap(f => codeLines(readFileSync(f, 'utf-8')).filter(l => /buildFeedbackUrl\(/.test(l)).map(() => relative(ROOT, f)))
    expect(callers).toEqual(['src/main/main.ts'])
  })

  // 本文は「macOS ${版}」と書く。macOS では os.release() が返すのは Darwin のカーネルの版で、macOS の版ではない
  // （Electron の型定義も、process.getSystemVersion() は macOS の版を返すと注記している）。
  it('macOS の版は process.getSystemVersion() から取る。Darwin のカーネルの版 os.release() を渡す形に戻さない', () => {
    // 注釈の行は除く（注釈は os.release() との違いを説明している）
    expect(codeLines(readFileSync(join(SRC, 'main', 'main.ts'), 'utf-8')).join('\n')).not.toContain('os.release()')
    const passed = sourceFiles(SRC).filter(f => codeLines(readFileSync(f, 'utf-8')).some(l => /buildFeedbackUrl\(.*os\.release\(\)/.test(l)))
    expect(passed.map(f => relative(ROOT, f))).toEqual([])
  })

  it('メニューの項目の直前の注釈は、宛先を公開リポジトリと言う（非公開と言い違えて、注意の段落を外す理由にしない）', () => {
    const lines = readFileSync(join(SRC, 'main', 'main.ts'), 'utf-8').split('\n')
    const at = lines.findIndex(l => l.includes("{ label: 'フィードバックを送る…'"))
    expect(at).toBeGreaterThan(3)
    const comment = lines.slice(at - 3, at).filter(l => /^\s*\/\//.test(l)).join('\n')
    expect(comment).toContain('公開リポジトリ')
    expect(comment).not.toMatch(/private|非公開/)
  })
})
