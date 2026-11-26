import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TARGET_PROFILES } from '../src/renderer/targetProfiles'
import { buildProjectContext, greetingContextOf, GREETING_SYSTEM, IDE_CONTEXT } from '../src/renderer/aiContext'

// P-146: あいさつは道具を渡さない要求なのに、道具前提の文を送ると「read_file が使えない環境」と言い出す。
// あいさつの system（GREETING_SYSTEM ＋ 文脈）には、道具の名前も「ツール」の語も出さない。

afterEach(() => { delete (globalThis as any).window })

const setup = (files: string[], hasPublic: boolean, meta: Record<string, unknown> = { name: 'proj', target: 'rental' }) => {
  ;(globalThis as any).window = {
    electronAPI: {
      fs: {
        readFile: async () => JSON.stringify(meta),
        projectFiles: async () => files,
        exists: async (p: string) => hasPublic && p === '/p/public',
      },
    },
  }
}

const TOOL_WORDS = ['read_file', 'write_file', 'edit_file', 'list_files', 'run_command', 'open_preview', 'fetch_url', 'search_web', 'search_docs', 'ツール']

describe('あいさつの system に道具の名前が無い', () => {
  it.each([
    ['作業フォルダが public/', ['public/a.js', 'README.md'], true],
    ['作業フォルダがプロジェクト直下', ['a.js', 'css/s.css'], false],
  ] as const)('%s', async (_n, files, hasPublic) => {
    setup([...files], hasPublic)
    const raw = await buildProjectContext('/p')
    // 前提: 通常のチャットの文脈には道具の名前が入る（差し替えが効いていることの対照）
    expect(raw).toContain('read_file')
    const sys = GREETING_SYSTEM + '\n\n' + greetingContextOf(raw)
    for (const w of TOOL_WORDS) expect(sys, w).not.toContain(w)
    expect(sys).toContain('ファイル構成（作業フォルダの中）:')
    expect(sys).toContain('- a.js')
  })

  // Koto が持つ公開先（targetProfiles.ts の TARGET_PROFILES のキー）をここへ書き下す。
  // 公開先が増減したら件数の確かめで気づける。
  const ALL_TARGETS = [
    'local', 'sakura-rental', 'sakura-apprun', 'sakura-apprun-dedicated', 'sakura-vps',
    'sakura-cloud', 'hanamii', 'vercel', 'other',
  ]
  it('書き下した公開先は TARGET_PROFILES と過不足なく一致する（件数も確かめる）', () => {
    expect(ALL_TARGETS).toHaveLength(9)
    expect(Object.keys(TARGET_PROFILES).sort()).toEqual([...ALL_TARGETS].sort())
  })
  it.each(ALL_TARGETS)('公開先 %s の文脈にも道具の名前が無い', async (target) => {
    setup(['a.js'], false, { name: 'proj', target })
    const raw = await buildProjectContext('/p')
    expect(raw).toContain('read_file')
    const sys = GREETING_SYSTEM + '\n\n' + greetingContextOf(raw)
    for (const w of TOOL_WORDS) expect(sys, w).not.toContain(w)
  })
  it.each(['vercel', 'sakura-apprun'])('取り込んだプロジェクト（importedFrom: %s）の文脈にも道具の名前が無い', async (t) => {
    setup(['a.js'], false, {
      name: 'proj', target: 'sakura-apprun',
      importedFrom: { target: t, name: 'orig', importedAt: '2026-01-01T00:00:00Z', intent: 'update' },
    })
    const raw = await buildProjectContext('/p')
    expect(raw).toContain('# このプロジェクトはインポートしたものです')
    const sys = GREETING_SYSTEM + '\n\n' + greetingContextOf(raw)
    for (const w of TOOL_WORDS) expect(sys, w).not.toContain(w)
  })

  it('GREETING_SYSTEM 単体にも無く、通常チャットの IDE_CONTEXT は変わらず道具を案内する', () => {
    for (const w of TOOL_WORDS) expect(GREETING_SYSTEM, w).not.toContain(w)
    expect(IDE_CONTEXT).toContain('list_files（ファイル一覧）と read_file')
  })

  it('日本語の決まりと丸数字の決まりは IDE_CONTEXT と同じ文', () => {
    const rule = '- 回答は必ず日本語のみで書くこと。他言語（韓国語・中国語・英語など）の単語や文字を混ぜない（コード・技術用語・固有名詞は除く）。\n'
    expect(GREETING_SYSTEM).toContain(rule)
    expect(IDE_CONTEXT).toContain(rule)
    expect(GREETING_SYSTEM).toContain('丸数字')
  })
})

describe('Sidebar の「ファイル」の見出しは縦に折り返さない', () => {
  const side = readFileSync(join(__dirname, '..', 'src/renderer/components/Sidebar.tsx'), 'utf-8')
  it('見出しの span に whitespace-nowrap・min-w-0・truncate、右のボタン群の入れ物に shrink-0', () => {
    const m = side.match(/<div className="([^"]*)">\s*<span className="([^"]*)">ファイル<\/span>\s*<div className="([^"]*)">/)
    expect(m).not.toBeNull()
    const [, row, span, box] = m!
    expect(row).toContain('flex')
    expect(row).toContain('min-w-0')
    expect(span).toContain('whitespace-nowrap')
    expect(span).toContain('min-w-0')
    expect(span).toContain('truncate')
    expect(span).not.toContain('shrink-0')
    expect(box).toContain('shrink-0')
  })
  it('直す前の形（クラスが文字の大きさだけの span）に戻っていない', () => {
    expect(side).not.toContain('<span className="text-[11px] font-semibold text-ink-muted uppercase tracking-widest">ファイル</span>')
  })
})
