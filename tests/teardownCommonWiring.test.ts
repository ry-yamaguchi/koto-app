import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階0（0d）: 破棄の共通の部品の「つなぎ方」の見張り（ソースを読むのはここだけ）──────────────────────────────
//
// 振る舞いは tests/teardown*Common.test.ts・tests/teardownShell.test.ts が偽の口に流して固定する。ここは、振る舞いでは見えない
// つなぎ方だけを、ソースの文字列で見張る（設計書 docs/teardown-unify-plan.md の 10.3.4 の「配線」・10.3.6・10.4.9 の F）。
//   1. 新しいファイルが各400行以下
//   2. 共通の部品が、専有型のパネルの部品・main の本体を import していない（循環させない。段階3B-7 で、手本の4ファイルを消したあとの形）
//   3. TeardownResultView が警告の書き出しを shared/teardownResult から import し、自分では定義していない
//   4. 仕様書の invoke を呼ぶのは flow.ts だけ（入口が直接呼ぶと、確認・窓を閉じる警告・キーなしの失敗を飛ばせる）
//   5. 画面の部品は公開の記録を消さない。窓を閉じる警告を付けるのは flow.ts の1か所だけ
//   6. 新しいフックが使う React の機能は useState・useRef・useCallback・useEffect だけ
//   7. （段階3B-6a）専有型のパネルの部品（手順6の節・記録の見張りのフック）は、パネル本体（循環）を import しない。
//      400行以下・公開の記録を消さない・フックの決まりは、共通の部品と同じ（下の PANEL_PART_FILES を各検査に足してある）
//   8. （段階3B-7）消した手本の4ファイルが無く、src のどこからも import されていない
// 当て先が他の行にも出ないか: 数える対象は「コメントを除いた本文」。見張りの道具そのもの（import の読み取り）も、下で単体に確かめる。

const ROOT = path.join(__dirname, '..')

/** 設計書 10.3.2 の11ファイル（段階0で作る）。 */
const NEW_FILES = [
  'src/renderer/teardown/types.ts',
  'src/renderer/teardown/facts.ts',
  'src/renderer/teardown/confirm.ts',
  'src/renderer/teardown/flow.ts',
  'src/renderer/teardown/watch.ts',
  'src/renderer/teardown/useTeardownFlow.ts',
  // 段階2（2b-1）で足した新しいファイル。写し（手本を import しない）・400行以下の見張りに入る。
  'src/renderer/teardown/targets/shared.ts',
  'src/renderer/useConfirmChoices.tsx',
  // 段階2（2c）で足した新しいファイル。【公開】(AppRunPanel) の 🗑（S1・S2）の流れと結果の部品。
  'src/renderer/components/SharedTeardownSection.tsx',
  'src/renderer/components/teardown/TeardownProgress.tsx',
  'src/renderer/components/teardown/TeardownResultView.tsx',
  'src/renderer/components/teardown/TeardownRow.tsx',
  'src/main/cloud/teardownShell.ts',
  'src/shared/teardownResult.ts',
  // 段階3A（3A-3〜3A-5a）で足した新しいファイル。プロジェクトの削除の判断・材料・ダイアログと、手動の案内の部品。
  'src/renderer/teardown/projectDeletePlan.ts',
  'src/renderer/teardown/projectDeleteFacts.ts',
  'src/renderer/components/ProjectDeleteDialog.tsx',
  'src/renderer/components/teardown/ManualTeardownNote.tsx',
  // 段階3A（3A-5b）で足した新しいファイル。プロジェクトの削除の結果の欄（描くだけ）。
  'src/renderer/components/teardown/ProjectDeleteResults.tsx',
  // 段階3B（3B-4）で足した新しいファイル。専有型の仕様書（手本の文を移した。手本・専有型のパネルの部品を import しない）。
  'src/renderer/teardown/targets/dedicated.ts',
  // 段階3B（3B-5）で足した新しいファイル。📡 一覧の棚卸しのカード（PublishedListModal.tsx から切り出した。手本・専有型のパネルの部品を import しない）。
  'src/renderer/components/PublishedInventoryCard.tsx',
]
const NEW_RENDERER_FILES = NEW_FILES.filter(f => f.startsWith('src/renderer/'))

/**
 * 専有型のパネルの部品（段階3B-6a で AppRunDedicatedPanel.tsx から切り出した。巨大ファイルの決まり）。共通の部品ではないので、下の 2（専有型のパネルの部品を import しない）の対象にはしない。
 * 手順6の節は apprunDedicatedActions.ts の純関数（shouldShowTeardownList・storageLeftoverNote）を使い、見張りのフックは watchDedicatedOps などを使う。
 * 向きの決まりは下の 7: パネル本体を import しない（パネル → 部品 → パネルの循環になる）。
 * 400行以下・公開の記録を消さない・窓を閉じる警告を自分では付けない・フックの決まりは、共通の部品と同じ。
 */
const PANEL_PART_FILES = [
  'src/renderer/components/DedicatedTeardownSection.tsx',
  'src/renderer/hooks/useDedicatedOpsWatch.ts',
]
const CHECKED_RENDERER_FILES = [...NEW_RENDERER_FILES, ...PANEL_PART_FILES]

/**
 * 消した手本の4ファイル（0.6.21 の専有型の手順6・📡 の行の旧い部品。設計書 10.3.1・10.11.11。段階3B-7 で消した）。
 * どこにも無く、src のどこからも import されない（下の 8）。
 */
const DELETED_MODEL_FILES = [
  'src/renderer/dedicatedTeardownFlow.ts',
  'src/renderer/hooks/useDedicatedTeardown.ts',
  'src/renderer/components/DedicatedTeardownRow.tsx',
  'src/renderer/components/DedicatedTeardownView.tsx',
]

/** main の専有型の本体（接続・作成・公開・削除の IPC）。`ipc/apprunDedicated*.ts` を全部（新しい兄弟のファイルも落とさない）。 */
const MAIN_DEDICATED_IPC = fs.readdirSync(path.join(__dirname, '../src/main/ipc'))
  .filter(f => /^apprunDedicated.*\.ts$/.test(f)).map(f => `src/main/ipc/${f}`).sort()

/** 共通の部品が import してはいけない、専有型のパネルの部品と main の本体（設計書 10.11.13 (A) の (ii)。向きは 部品 → 共通、逆は循環）。 */
const DEDICATED_ONLY_FILES = [
  'src/renderer/components/DedicatedOpsParts.tsx',
  'src/renderer/apprunDedicatedActions.ts',
  ...MAIN_DEDICATED_IPC,
  'src/main/cloud/apprunDedicatedApply.ts',
  'src/renderer/components/AppRunDedicatedPanel.tsx',
]

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

/** コメントを除く（行番号がずれないよう、改行は残す）。文字列の中の `//`（https://…）は直前が空白でないので消えない。 */
function stripComments(text: string): string {
  return text
    .replace(/(?<![^\s({[,;])\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
    .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)
}
const code = (rel: string) => stripComments(read(rel))

/** import／export-from／動的 import／require の相手（コメントを除いた本文から）。 */
export function importSpecifiersOf(source: string): string[] {
  const out: string[] = []
  const body = stripComments(source)
  for (const m of body.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of body.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of body.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  for (const m of body.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  return out
}

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`
    if (ent.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(rel)
  }
  return out.sort()
}

describe('見張りの道具: import の読み取り（これが効かないと、下の「手本を import していない」は素通りする）', () => {
  it('★ 通常の import・型だけの import・複数行の import・export from・副作用だけの import・動的 import・require を拾う。コメントの中は拾わない', () => {
    const src = [
      "import a from './a'",
      "import type { B } from '../b'",
      "import {",
      "  c,",
      "  d,",
      "} from '../../c'",
      "export { e } from './e'",
      "export * from './star'",
      "import './side'",
      "const x = await import('./dyn')",
      "const y = require('./req')",
      "// import z from './commented'",
      "/* import w from './block' */",
      "const url = 'https://example.com/x'",
    ].join('\n')
    expect(importSpecifiersOf(src).sort()).toEqual(['../../c', '../b', './a', './dyn', './e', './req', './side', './star'])
  })
})

/**
 * 段階3B-1 で足した main のファイル（専有型の削除を骨に載せたもの。10.11.4）。400行以下だけを見る。
 * 下の 2（手本を import していない）の対象にはしない: main の本体 `cloud/apprunDedicatedApply.ts`（手本の9ファイルの1つ）を
 * import するのがこのファイルの役目。向きの検査（循環させない）は tests/dedicatedTeardownShell.test.ts。
 */
const NEW_MAIN_FILES = [
  'src/main/ipc/apprunDedicatedTeardown.ts',
  'src/main/ipc/apprunDedicatedCommon.ts',
]

describe('1. 新しいファイルは各400行以下', () => {
  it.each([...NEW_FILES, ...PANEL_PART_FILES, ...NEW_MAIN_FILES])('%s が存在し、400行以下', (rel) => {
    expect(fs.existsSync(path.join(ROOT, rel)), `${rel} が無い`).toBe(true)
    const lines = read(rel).split('\n').length
    expect(lines, `${rel} は ${lines} 行`).toBeLessThanOrEqual(400)
  })
})

describe('2. 共通の部品は、専有型のパネルの部品・main の本体を import していない（向きは 部品 → 共通。逆は循環）', () => {
  const dedicatedAbs = new Set(DEDICATED_ONLY_FILES.map(f => path.join(ROOT, f).replace(/\.(ts|tsx)$/, '')))
  it('見張りの前提: 見張る相手のファイルが実在し、main の本体の IPC を4つ以上拾えている（名前を変えて見張りが空振りしていない）', () => {
    for (const f of DEDICATED_ONLY_FILES) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
    expect(MAIN_DEDICATED_IPC).toEqual(expect.arrayContaining([
      'src/main/ipc/apprunDedicated.ts', 'src/main/ipc/apprunDedicatedTeardown.ts', 'src/main/ipc/apprunDedicatedCommon.ts',
    ]))
  })

  it.each(NEW_FILES)('%s は専有型のパネルの部品・main の本体を import していない', (rel) => {
    const dirOfFile = path.dirname(path.join(ROOT, rel))
    for (const spec of importSpecifiersOf(read(rel))) {
      if (!spec.startsWith('.')) continue
      const resolved = path.resolve(dirOfFile, spec).replace(/\.(ts|tsx)$/, '')
      expect(dedicatedAbs.has(resolved), `${rel} が ${spec} を import している`).toBe(false)
    }
  })
})

describe('7. 専有型のパネルの部品（手順6の節・見張りのフック）の向き: パネル本体を import しない（循環させない）', () => {
  const PANEL = path.join(ROOT, 'src/renderer/components/AppRunDedicatedPanel')

  it('見張りの前提: 部品が実在する', () => {
    for (const f of PANEL_PART_FILES) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
  })

  it.each(PANEL_PART_FILES)('%s は AppRunDedicatedPanel を import しない', (rel) => {
    const dirOfFile = path.dirname(path.join(ROOT, rel))
    const specs = importSpecifiersOf(read(rel)).filter(spec => spec.startsWith('.'))
    expect(specs.length, `${rel} の import を読み取れていない`).toBeGreaterThan(0)
    for (const spec of specs) {
      const resolved = path.resolve(dirOfFile, spec).replace(/\.(ts|tsx)$/, '')
      expect(resolved, `${rel} がパネル本体を import している（パネル → 部品 → パネルの循環になる）`).not.toBe(PANEL)
    }
  })

  it('★ 手順6の節は、共通の流れ・専有型の仕様書・共通の見た目の部品を通る（仕様書の invoke を直接呼ばず、結果欄・進み具合を自分では描かない）', () => {
    const c = code('src/renderer/components/DedicatedTeardownSection.tsx')
    expect(c).toContain('runTeardownFlow(projectDir, dedicatedTeardownSpec, electronFlowDeps(projectDir, dedicatedTeardownSpec, {')
    expect(c).toContain('<TeardownResultView')
    expect(c).toContain('<TeardownProgress')
    expect(c).not.toContain('.invoke(')
    expect(c).not.toContain('apprunDedicated.teardown(')
    expect(c).not.toContain('onTeardownProgress(')
  })

  it('★ 見張りのフックは、見張りの部品 watchDedicatedOps を1か所で作り、IPC を直接呼ばない（記録の読み方・ack は部品の中の1か所）', () => {
    const c = code('src/renderer/hooks/useDedicatedOpsWatch.ts')
    expect(c.split('watchDedicatedOps({').length - 1).toBe(1)
    expect(c).not.toContain('.ack(')
    expect(c).not.toContain('apprunDedicated.')
  })
})

describe('3. TeardownResultView は警告の書き出しを shared/teardownResult から import し、自分では定義していない', () => {
  const VIEW = 'src/renderer/components/teardown/TeardownResultView.tsx'
  it('★ 2つの定数を ../../../shared/teardownResult から import している', () => {
    const importLines = [...stripComments(read(VIEW)).matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)]
    const fromShared = importLines.filter(m => m[2] === '../../../shared/teardownResult')
    expect(fromShared.length, 'shared/teardownResult からの import が無い').toBeGreaterThan(0)
    const names = fromShared.flatMap(m => m[1].split(',').map(s => s.trim().replace(/^type\s+/, '')))
    expect(names).toContain('TEARDOWN_REMAINING_WARNING_HEAD')
    expect(names).toContain('TEARDOWN_IN_PROGRESS_WARNING_HEAD')
  })

  it('★ 定数を自分の中に定義し直していない（`_WARNING_HEAD =` を含まない）。文の書き出しを直書きもしていない', () => {
    const c = code(VIEW)
    expect(c).not.toMatch(/_WARNING_HEAD\s*=/)
    expect(c).not.toMatch(/_WARNING_HEAD\s*:/)
    expect(c).not.toContain('削除できずに残っているものがあります。残っている間は課金が続きます')
    expect(c).not.toContain('削除の途中で、待ち切れずに止まりました')
  })

  it('定数は、警告の文を作る shared/teardownResult.ts の側にある（描く側と作る側が同じ定義を見る）', () => {
    const shared = code('src/shared/teardownResult.ts')
    expect(shared).toMatch(/export const TEARDOWN_REMAINING_WARNING_HEAD\s*=/)
    expect(shared).toMatch(/export const TEARDOWN_IN_PROGRESS_WARNING_HEAD\s*=/)
  })

  it('知らせ（watch.ts）も、同じ定数を shared から使い、書き出しを写していない', () => {
    const c = code('src/renderer/teardown/watch.ts')
    expect(c).toContain("from '../../shared/teardownResult'")
    expect(c).not.toMatch(/_WARNING_HEAD\s*=/)
    expect(c).not.toContain('削除できずに残っているものがあります')
  })
})

describe('4. 仕様書の invoke を呼ぶのは flow.ts だけ', () => {
  const FLOW = 'src/renderer/teardown/flow.ts'
  it('★ src/renderer 全体（コメント除く）で `.invoke(` を含むファイルは flow.ts だけ', () => {
    const hits = walk('src/renderer').filter(f => code(f).includes('.invoke('))
    expect(hits).toEqual([FLOW])
  })

  it('★ useTeardownFlow は、流れを決まった形で呼ぶ（runTeardownFlow ＋ electronFlowDeps）。spec.invoke を直接呼ばない', () => {
    const c = code('src/renderer/teardown/useTeardownFlow.ts')
    expect(c).toContain('runTeardownFlow(projectDir, spec, electronFlowDeps(projectDir, spec, {')
    expect(c).not.toContain('.invoke(')
    expect(c).not.toContain('spec.loadAuth(')
  })

  it('★ TeardownRow は useTeardownFlow を通る。流れも仕様書の invoke も直接呼ばない', () => {
    const c = code('src/renderer/components/teardown/TeardownRow.tsx')
    expect(c).toContain('useTeardownFlow(entry.dir, spec, {')
    expect(c).not.toContain('runTeardownFlow')
    expect(c).not.toContain('.invoke(')
  })
})

describe('5. 画面の部品は公開の記録を消さない。窓を閉じる警告は flow.ts の1か所だけ', () => {
  const FORBIDDEN_RECORD_WRITES = ['clearPublishRecord', 'forgetPublishTargetRecord', 'forgetPublishTargetThenLoad', 'publishMeta.forgetTarget', 'publishMeta.merge', '.forgetTarget(']
  it.each(CHECKED_RENDERER_FILES)('%s は公開の記録を消す口を持たない（消すのは main の骨の1か所）', (rel) => {
    const c = code(rel)
    for (const w of FORBIDDEN_RECORD_WRITES) expect(c, `${rel} に ${w}`).not.toContain(w)
  })

  it('★ 活動レジストリに載せる（beginActivity を呼ぶ）のも、窓を閉じる警告（closeWarning）を渡すのも flow.ts だけ', () => {
    const calls = CHECKED_RENDERER_FILES.filter(f => code(f).includes('beginActivity('))
    expect(calls).toEqual(['src/renderer/teardown/flow.ts'])
    const warns = CHECKED_RENDERER_FILES.filter(f => /closeWarning\s*:/.test(code(f)))
    expect(warns).toEqual(['src/renderer/teardown/flow.ts'])
  })

  it('flow.ts は窓を閉じる警告に、共通の PUBLISH_CLOSE_WARNING を渡す（別の文を持たない）', () => {
    expect(code('src/renderer/teardown/flow.ts')).toContain('{ closeWarning: PUBLISH_CLOSE_WARNING }')
  })
})

describe('6. 新しいフックが使う React の機能は useState・useRef・useCallback・useEffect だけ', () => {
  const ALLOWED = new Set(['useState', 'useRef', 'useCallback', 'useEffect'])
  /** この部品たちが呼んでよい、自前のフック（React の機能ではない）。 */
  const OWN = new Set(['useConfirmChoices', 'useTeardownFlow', 'useSharedTeardown', 'useDedicatedPanelTeardown', 'useDedicatedOpsWatch'])

  it.each(CHECKED_RENDERER_FILES)('%s が呼ぶ use〜 は、許した4つ＋自前のフックだけ', (rel) => {
    const used = new Set([...code(rel).matchAll(/\b(use[A-Z][A-Za-z0-9]*)\s*\(/g)].map(m => m[1]))
    for (const u of used) expect(ALLOWED.has(u) || OWN.has(u), `${rel} が ${u} を呼んでいる`).toBe(true)
  })

  it.each(CHECKED_RENDERER_FILES)('%s が react から import するのは、許した4つ（と型）だけ', (rel) => {
    for (const m of code(rel).matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'react'/g)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().replace(/^type\s+/, '')
        if (!name || !/^use/.test(name)) continue
        expect(ALLOWED.has(name), `${rel} が react から ${name} を import している`).toBe(true)
      }
    }
  })
})

describe('8. 消した手本の4ファイルが無く、src のどこからも import されていない', () => {
  const deletedAbs = new Set(DELETED_MODEL_FILES.map(f => path.join(ROOT, f).replace(/\.(ts|tsx)$/, '')))

  it.each(DELETED_MODEL_FILES)('%s は無い（戻していない）', (rel) => {
    expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(false)
  })

  it('★ src の全ファイル（renderer・main・shared・preload）が、消したファイルを import していない。見張りの道具は、本物の import を拾える', () => {
    // 見張りが空振りしていないこと: 実在する兄弟のファイルへの import は、同じ道具で拾える。
    const sample = importSpecifiersOf(read('src/renderer/components/DedicatedTeardownSection.tsx')).filter(s => s.startsWith('.'))
    expect(sample.length).toBeGreaterThan(0)
    const all = [...walk('src/renderer'), ...walk('src/main'), ...walk('src/shared')]
    expect(all.length).toBeGreaterThan(100)
    for (const rel of all) {
      const dirOfFile = path.dirname(path.join(ROOT, rel))
      for (const spec of importSpecifiersOf(read(rel))) {
        if (!spec.startsWith('.')) continue
        const resolved = path.resolve(dirOfFile, spec).replace(/\.(ts|tsx)$/, '')
        expect(deletedAbs.has(resolved), `${rel} が消したファイル ${spec} を import している`).toBe(false)
      }
    }
  })
})
