import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// ── 「記録を読む・見たと伝える・文にする」の定義を、複製させない（掟10・2026-09-30 検分の指摘2）─────────────
// 以前は、同じ判断が5つの画面に別々に書かれていた（normDir／trimSlash／trimTrailingSlash・warningLine／withWarnMark／
// opWarningText・clockText／opClock・ack の範囲の決め方・onChanged の購読）。HanamiiPanel 自身が「複製すると片方だけ直されて
// 見逃す穴になる」と書いていたのに、複製されていた。
// 振る舞いは tests/projectOpsView.test.ts・tests/opsText.test.ts。ここは、**新しい画面が自前の写しを作り直さない**ことだけを
// ソースで固定する（振る舞いでは見えにくい・複製を足すのは「新しく書く側」なので）。
// ソースを読むテストは「当て先が他の行にも出ないか」に弱い（掟10）ので、定義の形（const／function の宣言）ごと見て、
// コメント行は除く。変異試験で「複製を1つ足すと落ちる」ことを確かめてある。

const ROOT = path.join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, name.name)
    if (name.isDirectory()) out.push(...sourceFiles(rel))
    else if (/\.(ts|tsx)$/.test(name.name) && !name.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}
/** コメント行を除いたコード。 */
const code = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8').split('\n').filter(l => {
  const t = l.trimStart()
  return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
}).join('\n')

const RENDERER = sourceFiles('src/renderer')
const ALL = [...RENDERER, ...sourceFiles('src/shared'), ...sourceFiles('src/main')]

/** name を「定義」している（const／function／let の宣言）ファイル。 */
function definersOf(name: string, files: string[]): string[] {
  const re = new RegExp(`(^|\\n)\\s*(export\\s+)?(const|let|var|function)\\s+${name}\\b`)
  return files.filter(f => re.test(code(f))).map(f => f.replace(/\\/g, '/'))
}

describe('小さな部品の定義は、1か所だけ', () => {
  const cases: Array<[string, string]> = [
    ['normDir', 'src/renderer/projectOpsView.ts'],
    ['warningLine', 'src/shared/opsText.ts'],
    ['opWarningText', 'src/shared/opsText.ts'],
    ['clockText', 'src/shared/opsText.ts'],
  ]
  for (const [name, home] of cases) {
    it(`★ ${name} を定義しているのは ${home} だけ`, () => {
      expect(definersOf(name, ALL)).toEqual([home])
    })
  }

  it('★ 名前を変えた複製（trimSlash／trimTrailingSlash／withWarnMark／opClock）も、どこにも無い', () => {
    for (const name of ['trimSlash', 'trimTrailingSlash', 'withWarnMark', 'opClock']) {
      expect(definersOf(name, ALL), name).toEqual([])
    }
  })

  it('★ 「⚠️・⚠・※ で始まる」の印の正規表現は、src の中で shared/opsText.ts にしか書かれていない', () => {
    const literal = /\(⚠️\|⚠\|※\)/
    const holders = ALL.filter(f => literal.test(code(f))).map(f => f.replace(/\\/g, '/'))
    expect(holders).toEqual(['src/shared/opsText.ts'])
  })
})

describe('記録の購読と「見た」の伝え方は、共通の部品だけ', () => {
  it('★ window.electronAPI.projectOps の口（get／ack／onChanged）を直接呼ぶ画面は無い（共通の部品に渡す）', () => {
    for (const f of RENDERER) {
      const direct = [...code(f).matchAll(/window\.electronAPI\.projectOps\.(\w+)/g)].map(m => m[1])
      expect(direct, f).toEqual([])
    }
  })

  it('★ ack を呼ぶのは projectOpsView.ts の中だけ（範囲は ackUpToFor が決める）', () => {
    const holders = RENDERER.filter(f => /\.ack\(/.test(code(f))).map(f => f.replace(/\\/g, '/'))
    expect(holders).toEqual(['src/renderer/projectOpsView.ts'])
  })

  it('★ 処理の記録の onChanged を購読する（呼ぶ）のは projectOpsView.ts の中だけ（購読の順序の扱いを複製しない）', () => {
    // 学習・利用量・承認の onChanged は別の口。処理の記録（projectOps）の口だけを見る
    const holders = RENDERER.filter(f => /\bapi\.onChanged\(|projectOps\.onChanged\(/.test(code(f))).map(f => f.replace(/\\/g, '/'))
    expect(holders).toEqual(['src/renderer/projectOpsView.ts'])
  })

  it('★ 記録を読む5つの画面は、共通の watchProjectOps を通る', () => {
    const users = RENDERER.filter(f => /\bwatchProjectOps\(/.test(code(f))).map(f => f.replace(/\\/g, '/')).sort()
    expect(users).toEqual([
      'src/renderer/apprunDedicatedActions.ts',       // 専有型（AppRunDedicatedPanel が watchDedicatedOps 経由で使う）
      'src/renderer/components/AppRunPanel.tsx',      // 共用型
      'src/renderer/components/PublishModal.tsx',     // モーダルの上部
      'src/renderer/hooks/useProjectOpsView.ts',      // HANAMII・Vercel
      'src/renderer/projectOpsView.ts',               // 定義
    ])
  })

  it('★ ack の範囲は、共通の ackUpToFor で決める（画面が自前で「どこまで」を計算しない）', () => {
    const users = RENDERER.filter(f => /\backUpToFor\(/.test(code(f))).map(f => f.replace(/\\/g, '/')).sort()
    expect(users).toEqual([
      'src/renderer/apprunDedicatedActions.ts',
      'src/renderer/hooks/useProjectOpsView.ts',
      'src/renderer/projectOpsView.ts',
    ])
    // AppRunPanel は ackShown（内部で ackUpToFor）を通る
    expect(code('src/renderer/components/AppRunPanel.tsx')).toContain('ackShown(window.electronAPI.projectOps, projectDir, r => isSharedTypeOp(r) && shown.has(r.startedAt))')
  })
})

describe('二重表示の解消: 上部（PublishModal）と各パネルの持ち場は、1つの表（visiblePanelShows）で決まる', () => {
  it('★ PublishModal は持ち場を自分で書かず、visiblePanelShows で上部に出すものを絞る', () => {
    const s = code('src/renderer/components/PublishModal.tsx')
    expect(s).toContain('visiblePanelShows(target, opsRunning)')
    expect(s).toContain('!visiblePanelShows(target, r) && !seenInPanel.current.has(r.startedAt)')
    // 持ち場の判定（target === 'hanamii' など）を、この画面で書き写していない
    expect(s).not.toMatch(/\b(rec|opsRunning|r)\.target\s*===/)
  })

  it('★ 各パネルは、自分の持ち場の判定を共通の表から引く（自前で target を比べない）', () => {
    expect(code('src/renderer/components/HanamiiPanel.tsx')).toContain('useProjectOpsView(projectDir, isHanamiiOp, afterOpFinished)')
    expect(code('src/renderer/components/VercelPanel.tsx')).toContain('useProjectOpsView(projectDir, isVercelOp,')
    expect(code('src/renderer/components/AppRunPanel.tsx')).not.toMatch(/function isSharedTypeOp|const isSharedTypeOp/)
    expect(code('src/renderer/apprunDedicatedActions.ts')).toContain('DEDICATED_PANEL_HANDLERS[rec!.handler as string]')
  })
})

// ── 共用型の破棄の「月額が続く」警告は、返り値の事実から1つの関数で作る（2026-09-30 検分の指摘6）─────────────
// 振る舞い（その場の警告と記録の警告が同じ文になる）は tests/projectOpsHandlers.test.ts と tests/cloudCost.test.ts。
// ここは、警告を**画面が自分の選択から作り直していない**ことだけを固定する（複製すると、その場と開き直しで食い違う）。
describe('共用型の破棄の警告は、teardownRemainingWarnings だけが作る', () => {
  it('★ remainingCostWarning( を直接呼ぶのは、cloudCost.ts の中（teardownRemainingWarnings）だけ。画面・main は呼ばない', () => {
    const holders = ALL.filter(f => /\bremainingCostWarning\(/.test(code(f))).map(f => f.replace(/\\/g, '/'))
    expect(holders).toEqual(['src/shared/cloudCost.ts'])
  })

  it('★ その場の画面（③公開の破棄・📡 一覧の破棄）と処理の記録（main）は、同じ teardownRemainingWarnings を通る', () => {
    expect(code('src/renderer/components/AppRunPanel.tsx')).toContain('const warns = teardownRemainingWarnings(r)')
    expect(code('src/renderer/components/PublishedListModal.tsx')).toContain('teardownRemainingWarnings(r).join(')
    expect(code('src/main/projectOps.ts')).toContain('teardownRemainingWarnings({ keptBucketName: keptBucket, keptBucketNames: keptBuckets, keptRegistryName: keptRegistry, keptRegistryUnnamed })')
  })
})
