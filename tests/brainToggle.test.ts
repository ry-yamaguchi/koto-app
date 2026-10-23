import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ── 使う AI の表示（BrainToggle）。チャットモードは押せない固定の表示（2026-10-15 作者決定）──────────────────────
// 経緯: チャットモード（ChatApp）の会話は、Claude のキーがあっても必ず さくらのAI Engine が答える。
// それなのに、両方のキーがあると「AI Engine（Claude は IDE で） ⇄」のボタンが出て、押すと IDEモードで使う AI だけが変わり、
// チャットの表示は変わらなかった。作者は「切り替えボタンが効かない」と受け取った。
//   → チャットモードの右下のチップは、キーの有無にかかわらず、緑の点＋「さくらのAI Engine」（button ではなく span・⇄ なし）。
//   → チャットモードの上のヘッダ（モデル選択の横）からは、BrainToggle を外した。
//   → IDE（StatusBar の右下・ChatPanel のモデル選択の横）の見た目と動きは変えない。
//
// 描くテスト: DOM 環境（jsdom 等）は入れていないので、react の useState だけを**この試験用の小さな実装**に差し替え、
// 部品の関数をそのまま呼んで、本物の react-dom/server で HTML にする（tests/aiTextPlacesRender.test.ts と同じ手）。
// BrainToggle の useState は呼ばれる順に 1. claudeActive 2. hasClaudeKey。useEffect（キーを読む）は静的な描画では動かないので、
// 「キーが登録済み」の状態はここで直接与える。

const rt = vi.hoisted(() => ({ states: null as unknown[] | null, i: 0 }))

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: (init: unknown) => (rt.states ? [rt.states[rt.i++], () => {}] : real.useState(init as never)),
  }
})

import BrainToggle, { brainToggleView, CHAT_MODE_TITLE } from '../src/renderer/components/BrainToggle'

type Props = { apiKey?: string; compact?: boolean; chatMode?: boolean; className?: string }
type State = { claudeActive: boolean; hasClaudeKey: boolean }

function render(props: Props, st: State): string {
  rt.states = [st.claudeActive, st.hasClaudeKey]
  rt.i = 0
  try {
    return renderToStaticMarkup(createElement(BrainToggle, props))
  } finally {
    rt.states = null
  }
}
const text = (html: string) => html.replace(/<[^>]*>/g, '')
const DOT = '<span class="w-1.5 h-1.5 rounded-full bg-brand-green"></span>'

const AI_KEY = 'sk-test'
// キーの組み合わせ（Claude のキーの有無・オンかオフか × AI Engine のキーの有無）
const KEY_CASES: Array<[string, Props['apiKey'], State]> = [
  ['両方のキー（Claude オン）', AI_KEY, { claudeActive: true, hasClaudeKey: true }],
  ['両方のキー（Claude オフ）', AI_KEY, { claudeActive: false, hasClaudeKey: true }],
  ['AI Engine のキーだけ', AI_KEY, { claudeActive: false, hasClaudeKey: false }],
  ['Claude のキーだけ', '', { claudeActive: true, hasClaudeKey: true }],
  ['キーなし', '', { claudeActive: false, hasClaudeKey: false }],
]

describe('BrainToggle: chatMode は、Claude のキーにかかわらず押せない固定の表示', () => {
  for (const [name, apiKey, st] of KEY_CASES.filter(([, k]) => !!k)) for (const compact of [false, true]) {
    it(`${name}${compact ? '（compact）' : ''}: button が無く、⇄ も無く、緑の点＋「さくらのAI Engine」の span`, () => {
      const html = render({ apiKey, chatMode: true, compact }, st)
      expect(html, 'button が出ている（押せる表示に戻っている）').not.toContain('<button')
      expect(html, '⇄ が出ている').not.toContain('⇄')
      if (!compact) {
        expect(html.startsWith('<span class="flex items-center gap-1.5 text-ink-muted ')).toBe(true)
        expect(html).toContain(`${DOT}さくらのAI Engine</span>`)
      }
      expect(text(html)).toBe('さくらのAI Engine')
      // 押せない表示の title は、Claude の居場所（IDEモード）を教える
      expect(html).toContain(`title="${CHAT_MODE_TITLE}"`)
    })
  }

  // さくらのAI Engine のキーが無いチャットは誰も答えず、中央が IDEモードを案内する。そこへ「さくらのAI Engine」と出すと食い違う（2026-10-15 検分）
  for (const [name, apiKey, st] of KEY_CASES.filter(([, k]) => !k)) for (const compact of [false, true]) {
    it(`${name}${compact ? '（compact）' : ''}: さくらのAI Engine のキーが無ければ何も出さない`, () => {
      expect(render({ apiKey, chatMode: true, compact }, st)).toBe('')
      expect(render({ apiKey: '   ', chatMode: true, compact }, st)).toBe('')
    })
  }

  it('★ ツールチップの文: Claude は、プロジェクトを開いた画面（IDEモード）で使えます', () => {
    expect(CHAT_MODE_TITLE).toBe('Claude は、プロジェクトを開いた画面（IDEモード）で使えます')
  })

  it('★ 直す前の文（「AI Engine（Claude は IDE で）」「ここで切り替えると…変わります」「クリックで…切り替え」）が戻っていない', () => {
    for (const [, apiKey, st] of KEY_CASES.filter(([, k]) => !!k)) {
      const html = render({ apiKey, chatMode: true }, st)
      expect(html).not.toContain('Claude は IDE で')
      expect(html).not.toContain('ここで切り替える')
      expect(html).not.toContain('クリックで')
      expect(html).not.toContain('使う AI:')
    }
  })

  it('chatMode は Claude がオンでも「Claude」と出さない（チャットモードで答えるのはいつも さくらのAI Engine）', () => {
    const html = render({ apiKey: AI_KEY, chatMode: true }, { claudeActive: true, hasClaudeKey: true })
    expect(text(html)).toBe('さくらのAI Engine')
  })
})

describe('BrainToggle: chatMode でないとき（IDE の右下・AIチャット欄の横）は従来どおり', () => {
  const BOTH_ON: State = { claudeActive: true, hasClaudeKey: true }
  const BOTH_OFF: State = { claudeActive: false, hasClaudeKey: true }

  it('右下（非 compact）・両方のキー: button で ⇄ 付き。Claude オンは「Claude」・オフは「さくらのAI Engine」', () => {
    const on = render({ apiKey: AI_KEY, className: 'ml-auto' }, BOTH_ON)
    expect(on.startsWith('<button')).toBe(true)
    expect(on).toContain('hover:text-ink')
    expect(on).toContain('ml-auto')
    expect(text(on)).toBe('Claude⇄')
    expect(on).toContain('title="使う AI: Claude（クリックで さくらのAI Engine に切り替え）"')
    const off = render({ apiKey: AI_KEY, className: 'ml-auto' }, BOTH_OFF)
    expect(off.startsWith('<button')).toBe(true)
    expect(text(off)).toBe('さくらのAI Engine⇄')
    expect(off).toContain('title="使う AI: さくらのAI Engine（クリックで Claude に切り替え）"')
  })

  it('モデル選択の横（compact）・両方のキー: button で ⇄ 付き。「🧠 Claude」「🧠 AI Engine」', () => {
    const on = render({ apiKey: AI_KEY, compact: true }, BOTH_ON)
    expect(on.startsWith('<button')).toBe(true)
    expect(text(on)).toBe('🧠 Claude ⇄')
    const off = render({ apiKey: AI_KEY, compact: true }, BOTH_OFF)
    expect(off.startsWith('<button')).toBe(true)
    expect(text(off)).toBe('🧠 AI Engine ⇄')
  })

  it('片方のキーだけ: 表示のみ（span・⇄ なし）。右下も compact も', () => {
    // AI Engine のキーだけ
    const aiOnly: State = { claudeActive: false, hasClaudeKey: false }
    for (const compact of [false, true]) {
      const html = render({ apiKey: AI_KEY, compact }, aiOnly)
      expect(html).not.toContain('<button')
      expect(html).not.toContain('⇄')
      expect(html).toContain('title="使う AI: さくらのAI Engine"')
    }
    // Claude のキーだけ（AI Engine のキーなし）
    const claudeOnly: State = { claudeActive: true, hasClaudeKey: true }
    for (const compact of [false, true]) {
      const html = render({ apiKey: '', compact }, claudeOnly)
      expect(html).not.toContain('<button')
      expect(html).not.toContain('⇄')
      expect(html).toContain('title="使う AI: Claude"')
    }
  })

  it('★ 純関数 brainToggleView: chatMode は 組み合わせ（切替可否・Claude の有無・compact）によらず同じ。chatMode でなければ canToggle に従う', () => {
    for (const canToggle of [false, true]) for (const claudeActive of [false, true]) for (const compact of [false, true]) {
      expect(brainToggleView({ canToggle, claudeActive, compact, chatMode: true, hasEngineKey: true })).toEqual({
        clickable: false, label: 'さくらのAI Engine', title: CHAT_MODE_TITLE,
      })
      expect(brainToggleView({ canToggle, claudeActive, compact, chatMode: true, hasEngineKey: false })).toBeNull()
      // chatMode でなければ、押せるかは canToggle そのもの（hasEngineKey は見ない）
      for (const hasEngineKey of [false, true]) {
        expect(brainToggleView({ canToggle, claudeActive, compact, chatMode: false, hasEngineKey })!.clickable).toBe(canToggle)
      }
    }
  })
})

// ── 呼び出しの形（ソース）。BrainToggle を使う場所を全部書き下し、chatMode と compact の付き方を固定する ──────────
// 掟10: 「どこかに書いてある」では直し忘れを捕まえられない。呼び出しの形ごと、渡し先ごと見る。
const ROOT = path.join(__dirname, '..')
const raw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
// JSX のコメント `{/* … */}` と、行頭が // の行を除く（コメントでの言及を拾わない）。
const code = (rel: string) => raw(rel).replace(/\{\/\*[\s\S]*?\*\/\}/g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const calls = (rel: string) => code(rel).match(/<BrainToggle\b[^>]*>/g) ?? []

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p)
  }
  return out
}

describe('BrainToggle の呼び出し: チャットモードのヘッダには compact を置かない', () => {
  it('★★★ ChatApp.tsx の BrainToggle は、右下のチップの 1 か所だけ（chatMode・compact なし）', () => {
    expect(calls('src/renderer/components/ChatApp.tsx')).toEqual(['<BrainToggle apiKey={apiKey} chatMode />'])
  })

  it('★★★ ChatApp.tsx のモデル選択のヘッダ（ModelSelect を含む枠）に BrainToggle が無い', () => {
    const src = code('src/renderer/components/ChatApp.tsx')
    const from = src.indexOf('<div className="flex flex-col items-center py-2.5 border-b border-line bg-surface flex-none gap-1">')
    const to = src.indexOf('flex-1 overflow-y-auto relative', from)
    expect(from, 'ヘッダの枠が見つからない（ChatApp の作りが変わった）').toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    const header = src.slice(from, to)
    expect(header, 'ヘッダの切り出しが違う').toContain('<ModelSelect')
    expect(header).not.toContain('BrainToggle')
  })

  it('★★ 右下のチップの枠（absolute bottom-2 right-3）の中に chatMode の BrainToggle がある', () => {
    const src = code('src/renderer/components/ChatApp.tsx')
    const from = src.indexOf('absolute bottom-2 right-3')
    expect(from).toBeGreaterThan(0)
    const chip = src.slice(from, src.indexOf('</div>', from))
    expect(chip).toContain('<BrainToggle apiKey={apiKey} chatMode />')
  })

  it('★★ IDE 側は変えない: StatusBar は右下（className のみ）・ChatPanel はモデル選択の横（compact のみ）。どちらにも chatMode は付かない', () => {
    expect(calls('src/renderer/components/StatusBar.tsx')).toEqual(['<BrainToggle apiKey={apiKey} className="ml-auto" />'])
    expect(calls('src/renderer/components/ChatPanel.tsx')).toEqual(['<BrainToggle apiKey={apiKey} compact />'])
  })

  it('★ src 全体で <BrainToggle を使うのは、この 3 ファイル 3 か所だけ（入口が増えたらここで気づく）', () => {
    const found: string[] = []
    for (const f of walk(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, f)
      for (const c of calls(rel)) found.push(`${rel} ${c}`)
    }
    expect(found.sort()).toEqual([
      'src/renderer/components/ChatApp.tsx <BrainToggle apiKey={apiKey} chatMode />',
      'src/renderer/components/ChatPanel.tsx <BrainToggle apiKey={apiKey} compact />',
      'src/renderer/components/StatusBar.tsx <BrainToggle apiKey={apiKey} className="ml-auto" />',
    ])
  })
})
