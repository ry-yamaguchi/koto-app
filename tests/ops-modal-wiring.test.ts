import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 振る舞いは tests/ops-modal-behavior.test.ts が固定している。ここは、振る舞いでは見えにくい2点だけを
// ソースで固定する（掟10・掟6）:
//   ① 記録の型を複製しない（定義の本体は src/main/projectOps.ts。画面は global.d.ts の ProjectOpRecordShape を使う）
//   ② renderer から main の記録へ書き込む口は無い（get／ack／onChanged だけ）。
//      ack は「見た」の印だけで処理には影響しないが、口を増やすと、画面から記録を書き換えられてしまう。

const ROOT = path.join(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
/** コメント行を除いたコード（コメントに書いた説明に当たらないように）。 */
const code = (rel: string): string => read(rel).split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')

const MODAL = 'src/renderer/components/PublishModal.tsx'

describe('PublishModal.tsx: 処理の記録の型を複製しない（掟10）', () => {
  it('★ 記録・結果の型を自前で定義していない。global.d.ts の ProjectOpRecordShape／ProjectOpsSnapshotShape を使う', () => {
    const s = code(MODAL)
    expect(s).not.toMatch(/\b(type|interface)\s+(ProjectOpRecord|ProjectOpsSnapshot|OpResult|OpProgress)\b/)
    expect(s).toContain('ProjectOpRecordShape')
    expect(s).toContain('ProjectOpsSnapshotShape')
    // 型の本体は main の定義を指している（global.d.ts）
    expect(read('src/renderer/global.d.ts')).toContain("type ProjectOpRecordShape = import('../main/projectOps').ProjectOpRecord")
  })
})

describe('PublishModal.tsx: 処理の記録は共通の部品（projectOpsView.ts）を通して読む・見たと伝える', () => {
  it('★ window.electronAPI.projectOps の口（get／ack／onChanged）を、この画面が直接呼ばない。共通の watchProjectOps／sendAck に渡す', () => {
    const s = code(MODAL)
    // 直接呼んでいない（読み方・ack の範囲・古い応答の扱いを、この画面で複製しない・掟10）
    expect([...s.matchAll(/window\.electronAPI\.projectOps\.(\w+)/g)].map(m => m[1])).toEqual([])
    // 渡し方の形ごと（渡し先が別の部品に化けていない）
    expect(s).toContain('watchProjectOps(window.electronAPI.projectOps, projectDir, applyOps)')
    expect(s).toContain('sendAck(window.electronAPI.projectOps, projectDir, newest)')
  })

  it('★ 記録を書き換える口は無い（共通の部品が使う口は get／ack／onChanged だけ）', () => {
    const s = code('src/renderer/projectOpsView.ts')
    const used = new Set([...s.matchAll(/\bapi\.(\w+)\(/g)].map(m => m[1]))
    expect([...used].sort()).toEqual(['ack', 'get', 'onChanged'])
  })
})

// ── 隠れているタブのパネルに、目の前に出ているかを渡している（2026-09-30 検分）───────────────────────
// 共用型・専有型のタブは、切り替えても**パネルを外さずに隠す**。隠れているパネルが結果を「見た」と伝えないのは
// 各パネルの振る舞い（tests/ops-shared-panel.test.ts・tests/ops-dedicated-resume.test.ts が固定）。
// ここでは、モーダルが各パネルへ visible を**呼び出しの形ごと**渡していること（渡し忘れると、隠れたまま「見た」と伝える）を確かめる。
// 文字列の一致は「そう書いてあるか」しか見ないので、変異（渡さない・逆にする）で落ちることを確かめてある。
describe('PublishModal.tsx: AppRun の2つのタブのパネルに、visible（そのタブが目の前か）を渡している', () => {
  const s = code(MODAL)
  it('★ 共用型のパネルには target === \'sakura-apprun\'、専有型のパネルには target === \'sakura-apprun-dedicated\' を渡す（取り違えない）', () => {
    expect(s).toContain("<AppRunPanel projectDir={projectDir} apiKey={apiKey} onOpenCredentials={onOpenCredentials} visible={target === 'sakura-apprun'} />")
    expect(s).toContain("<AppRunDedicatedPanel projectDir={projectDir} onOpenCredentials={onOpenCredentials} visible={target === 'sakura-apprun-dedicated'} />")
  })
})
