import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parsePublishTargets, TARGET_ORDER } from '../src/shared/publishMeta'

// ── 公開の記録の形の判断（parsePublishTargets）は shared の1つだけ ────────────────────────────────────────────────────────
// 画面（renderer/publishRecord.ts）と main（ipc/fsTrash.ts）が同じこれを通る。形が読めなければ null（空配列とは別の意味）。

describe('★★★ parsePublishTargets: 形が読めなければ null、読めて公開先が無ければ []', () => {
  it.each([
    ['配列', []],
    ['文字列', 'x'],
    ['数', 5],
    ['null', null],
    ['undefined', undefined],
    ['真偽値', true],
    ['publish が数', { publish: 5 }],
    ['publish が文字列', { publish: 'x' }],
    ['publish が配列', { publish: [] }],
    ['targets が数', { publish: { targets: 5 } }],
    ['targets が文字列', { publish: { targets: 'x' } }],
    ['targets が配列', { publish: { targets: [] } }],
  ])('★★★ 形が違う（%s）→ null', (_label, meta) => {
    expect(parsePublishTargets(meta)).toBeNull()
  })

  it.each([
    ['空のオブジェクト', {}],
    ['publish が無い', { name: 'x' }],
    ['publish が null', { publish: null }],
    ['publish が空', { publish: {} }],
    ['targets が null', { publish: { targets: null } }],
    ['targets が空', { publish: { targets: {} } }],
    ['値が偽の行だけ', { publish: { targets: { hanamii: null, vercel: false } } }],
    ['知らない公開先だけ', { publish: { targets: { unknown: { url: 'x' } } } }],
  ])('★★★ 読めて公開先が無い（%s）→ []（null とは別）', (_label, meta) => {
    expect(parsePublishTargets(meta)).toEqual([])
  })

  it('★★ 公開先は、記録の並びによらず定義順で返る。値が真の行だけ（`{}` の行も行）', () => {
    const meta = { publish: { targets: { 'sakura-rental': {}, vercel: { url: 'u' }, hanamii: { url: null }, 'sakura-apprun': null } } }
    expect(parsePublishTargets(meta)).toEqual(['hanamii', 'vercel', 'sakura-rental'])
    expect(TARGET_ORDER).toEqual(['hanamii', 'vercel', 'sakura-apprun', 'sakura-apprun-dedicated', 'sakura-rental'])
  })
})

describe('★★ 定義は1か所（画面と main が別々の判断を持たない）', () => {
  /** src 以下の .ts・.tsx を全部集める。 */
  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name)
      return e.isDirectory() ? sources(full) : /\.(ts|tsx)$/.test(e.name) ? [full] : []
    })
  }
  const root = path.join(__dirname, '..', 'src')
  const files = sources(root)
  const rel = (f: string) => path.relative(path.join(__dirname, '..'), f)

  it('★★ `parsePublishTargets` と `TARGET_ORDER` を定義しているのは src/shared/publishMeta.ts だけ', () => {
    const defining = (re: RegExp) => files.filter(f => re.test(fs.readFileSync(f, 'utf8'))).map(rel)
    expect(defining(/function parsePublishTargets\b/)).toEqual(['src/shared/publishMeta.ts'])
    expect(defining(/const TARGET_ORDER\b/)).toEqual(['src/shared/publishMeta.ts'])
  })

  it('★★ 画面（publishRecord.ts）と main（fsTrash.ts）は、shared のそれを import して呼ぶ', () => {
    const renderer = fs.readFileSync(path.join(root, 'renderer/publishRecord.ts'), 'utf8')
    const main = fs.readFileSync(path.join(root, 'main/ipc/fsTrash.ts'), 'utf8')
    expect(renderer).toContain("import { parsePublishTargets, TARGET_ORDER } from '../shared/publishMeta'")
    expect(renderer).toContain('const recorded = parsePublishTargets(meta)')
    expect(renderer).toContain('if (parsePublishTargets(meta) === null) return { ok: false')
    expect(main).toContain("import { parsePublishTargets, type PublishTargetKind } from '../../shared/publishMeta'")
    expect(main).toContain("meta.kind === 'ok' && parsePublishTargets(meta.value) === null")
  })
})
