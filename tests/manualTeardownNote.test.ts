import { describe, it, expect } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ManualTeardownNote from '../src/renderer/components/teardown/ManualTeardownNote'
import { manualTeardownGuide } from '../src/shared/teardownSupport'
import type { PublishTargetKind } from '../src/renderer/publishStatus'

// ── 手動の案内（Vercel・レンタルサーバ）の描き手が1つであること（段階3A・3A-3。設計書 10.9.6・10.9.13 の M）──────
//
// 破棄できない公開先の「どこで消せばよいか」は、📡 公開したもの一覧とプロジェクトの削除の2か所に出る。
// 描き手を ManualTeardownNote に1つにして、2か所の文・見た目が割れないようにした。
// 案内の中身（manualTeardownGuide）は tests/teardownSupport.test.ts・tests/w-fix-teardown-wording.test.ts が固定する。
// ここは「描く／描かない」の判断と、一覧がこの部品を通っていることを見る。
//
// 部品は React の機能を使わない関数なので、直接呼んで返り値を見る（M）。HTML に描いた形も1回ずつ見る。

const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
/** コメントを除く（文字列の中の `//` は直前が空白でないので消えない）。 */
const code = (rel: string) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
  .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)

const ALL: PublishTargetKind[] = ['sakura-apprun', 'sakura-apprun-dedicated', 'hanamii', 'vercel', 'sakura-rental']
const SUPPORTED: PublishTargetKind[] = ['sakura-apprun', 'sakura-apprun-dedicated', 'hanamii']
const MANUAL: PublishTargetKind[] = ['vercel', 'sakura-rental']

const note = (target: PublishTargetKind, className?: string) =>
  ManualTeardownNote({ target, className }) as ReactElement<{ className: string; children: unknown }> | null
const textOf = (el: ReactElement<{ children: unknown }>) => ([] as unknown[]).concat(el.props.children).join('')
const html = (target: PublishTargetKind, className?: string) =>
  renderToStaticMarkup(createElement(ManualTeardownNote, { target, className }))
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

describe('M: ManualTeardownNote は、破棄できない公開先にだけ案内を描く', () => {
  it('★ Koto から破棄できる3つ（共用型・専有型・HANAMII）には何も描かない（null）', () => {
    for (const t of SUPPORTED) {
      expect(note(t), t).toBeNull()
      expect(html(t), t).toBe('')
    }
  })

  it('★ Vercel・レンタルサーバは <p> で、先頭の「ℹ️ 」のあとに manualTeardownGuide の文がそのまま入る', () => {
    for (const t of MANUAL) {
      const el = note(t)
      expect(el, t).not.toBeNull()
      expect(el!.type, t).toBe('p')
      expect(textOf(el!), t).toBe(`ℹ️ ${manualTeardownGuide(t)}`)
      expect(manualTeardownGuide(t).length, `${t} の案内が空`).toBeGreaterThan(0)
    }
  })

  it('★ 描いた HTML も、案内の文がそのまま入った <p>（文が書き換わったり、足されたりしない）', () => {
    for (const t of MANUAL) {
      const h = html(t)
      expect(h.startsWith('<p '), t).toBe(true)
      expect(h.endsWith('</p>'), t).toBe(true)
      expect(h, t).toContain(`ℹ️ ${escapeHtml(manualTeardownGuide(t))}`)
      expect(h, t).not.toContain('<button')
    }
  })

  it('★ 「描く」かどうかは、公開先の全種類で teardownSupport と一致する（種類を足したら、ここで気づく）', () => {
    expect(ALL.filter(t => note(t) !== null)).toEqual(MANUAL)
  })

  it('★ 利用者がパーミッション名をコピーできるよう、文は選択できる（select-text）。文字の大きさ・色は一覧と同じ', () => {
    for (const t of MANUAL) {
      const cls = note(t)!.props.className
      expect(cls, t).toBe('text-[11px] text-ink-muted leading-relaxed select-text')
    }
  })

  it('★ 呼び手の className は後ろに足される。無いときに余計な空白や "undefined" は付かない', () => {
    expect(note('vercel', 'mb-2')!.props.className).toBe('text-[11px] text-ink-muted leading-relaxed select-text mb-2')
    expect(note('vercel', undefined)!.props.className).not.toMatch(/undefined|\s$/)
    expect(note('vercel', '')!.props.className).not.toMatch(/\s$/)
    expect(html('sakura-rental', 'mb-2')).toContain('select-text mb-2"')
  })
})

describe('配線: 一覧は ManualTeardownNote を通し、案内を自分で描かない', () => {
  const list = code('src/renderer/components/PublishedListModal.tsx')
  const noteSrc = code('src/renderer/components/teardown/ManualTeardownNote.tsx')

  it('★ 📡 の群れの見出しの下で、<ManualTeardownNote target={g.target} className="mb-2" /> をちょうど1回描く', () => {
    expect(list.split('<ManualTeardownNote target={g.target} className="mb-2" />').length - 1).toBe(1)
    expect(list).toContain("import ManualTeardownNote from './teardown/ManualTeardownNote'")
  })

  it('★ 一覧は manualTeardownGuide を呼ばず、「ℹ️」も自分では書かない（描き手を1つにする）', () => {
    expect(list).not.toContain('manualTeardownGuide')
    expect(list).not.toContain('ℹ️')
    expect(list).not.toContain("=== 'manual'")
  })

  it('★ 部品は破棄ボタン・押す口を持たず、読むのは公開先の種類と shared/teardownSupport だけ（手本の9ファイルを import しない）', () => {
    expect(noteSrc).not.toMatch(/<button|onClick|window\.|electronAPI/)
    const imports = [...noteSrc.matchAll(/\bimport\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g)].map(m => m[1])
    expect(imports).toEqual(['../../publishStatus', '../../../shared/teardownSupport'])
  })

  it('★ 部品は40行以下（設計書 10.9.6）', () => {
    expect(read('src/renderer/components/teardown/ManualTeardownNote.tsx').split('\n').length - 1).toBeLessThanOrEqual(40)
  })
})

describe('配線: プロジェクトの削除のダイアログも ManualTeardownNote を通し、案内を自分で描かない（段階3A・3A-5a）', () => {
  const dialog = code('src/renderer/components/ProjectDeleteDialog.tsx')
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const ent of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${ent.name}`
      if (ent.isDirectory()) walk(rel, out)
      else if (/\.(ts|tsx)$/.test(ent.name)) out.push(rel)
    }
    return out.sort()
  }

  it('★ 公開先の一覧の行ごとに <ManualTeardownNote target={t} /> をちょうど1回描く。Sidebar には案内も部品も無い', () => {
    expect(dialog.split('<ManualTeardownNote target={t} />').length - 1).toBe(1)
    expect(dialog).toContain("import ManualTeardownNote from './teardown/ManualTeardownNote'")
    const sidebar = code('src/renderer/components/Sidebar.tsx')
    expect(sidebar).not.toContain('manualTeardownGuide')
    expect(sidebar).not.toContain('ManualTeardownNote')
  })

  it('★ ダイアログは manualTeardownGuide を呼ばず、「ℹ️」も自分では書かない（描き手を1つにする）', () => {
    expect(dialog).not.toContain('manualTeardownGuide')
    expect(dialog).not.toContain('ℹ️')
    expect(dialog).not.toContain("=== 'manual'")
  })

  it('★★ src/renderer で manualTeardownGuide( を呼ぶのは ManualTeardownNote.tsx だけ（手動の案内の描き手は2か所で1つ）', () => {
    const holders = walk('src/renderer').filter(f => code(f).includes('manualTeardownGuide('))
    expect(holders).toEqual(['src/renderer/components/teardown/ManualTeardownNote.tsx'])
  })
})
