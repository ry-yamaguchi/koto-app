// tests/w-publishA-wording.test.ts
//
// 画面の言葉の言い換え（docs/wording-decisions.md の「作者の決定」）のうち、
// 担当キー publishA（共用型 AppRun とクラウドの中身）で「振る舞い」を変えたものを固定する。
//
// 掟10 の考え方に沿い、文字列の grep ではなく**実際に純関数を呼んで**出力を確かめる
// （呼べない画面のJSX条件だけは、ソースの当て先を一意に絞ったうえで確認する）。
//
// 対象:
//   W-3・W-15: computePlan（バケット→保存場所、削除文言）
//   W-37     : prereqNextStepFor（黄色い行の「次の一手」を理由ごとに出し分ける）
//   W-61     : storageCostNote（専用の保存場所の説明）
//   W-13・W-15: projectDeleteRegistryNote・teardownTargets（コンテナレジストリ併記・保存場所）
//   W-98     : buildSwitchConfirmMessage（「配分」を使わない）
//   W-64・W-78・W-13: importPlanNotes・importDoneNotes（インポートの案内文）
//   W-77     : ImportFromPublishedPanel.tsx の「認証情報を開く」表示条件（状態で判定）

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computePlan } from '../src/main/cloud/planner'
import { emptyState, type EnvState, type ResourceRef } from '../src/main/cloud/state'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { prereqNextStepFor } from '../src/renderer/components/AppRunPanel'
import { storageCostNote } from '../src/shared/objectStorage'
import { projectDeleteRegistryNote, teardownTargets } from '../src/shared/cloudCost'
import { buildSwitchConfirmMessage } from '../src/renderer/rollbackSwitch'
import { importPlanNotes, importDoneNotes } from '../src/renderer/importProject'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

function withBucket(spec: EnvSpec): EnvSpec {
  spec.persistence.objectStorage = [
    { bucket: `${spec.name}-data`, prefix: `projects/${spec.name}/`, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' },
  ]
  return spec
}

describe('W-3/W-15: computePlan の保存場所の文言（バケットではなく保存場所と呼ぶ）', () => {
  it('保存場所を新しく用意するときの説明に「保存場所」が出て「バケット」は出ない', () => {
    const spec = withBucket(defaultSpec({ name: 'myapp', hasDockerfile: false }))
    const state: EnvState = emptyState(spec.name, spec.backend)
    const plan = computePlan(spec, state)
    const create = plan.actions.find(a => a.kind === 'bucket' && a.type === 'create')
    expect(create).toBeDefined()
    expect(create!.description).toContain('保存場所')
    expect(create!.description).toContain('用意')
    expect(create!.description).not.toContain('バケット')
  })

  it('保存場所（データ）を削除するときの説明が「このプロジェクトのデータを削除」で、共有先を巻き込む言い方をしない', () => {
    // spec からバケットを外し（＝もう要求しない）、state 側にだけ残す → delete が生成される。
    const spec = defaultSpec({ name: 'myapp', hasDockerfile: false })
    const resources: ResourceRef[] = [
      { kind: 'apprun-app', id: 'app-1', stateful: false, key: `apprun-app:${spec.name}` },
      { kind: 'bucket', id: 'bucket-1', stateful: true, key: `bucket:${spec.name}-data` },
    ]
    const state: EnvState = { name: spec.name, backend: spec.backend, resources }
    const plan = computePlan(spec, state)
    const del = plan.actions.find(a => a.kind === 'bucket' && a.type === 'delete')
    expect(del).toBeDefined()
    expect(del!.description).toContain('保存場所')
    expect(del!.description).toContain('にある、このプロジェクトのデータを削除')
    // W-3 の注意: 「バケット『…』を削除」は共有のときに言い過ぎになるため使わない。
    expect(del!.description).not.toContain('バケット')
    expect(plan.hasStatefulDelete).toBe(true)
  })
})

describe('W-37: prereqNextStepFor は「足りないもの」ごとに正しい次の一手だけを出す', () => {
  it('Docker が無い（エキスパート）→ Docker の導入を案内し、レジストリの話はしない', () => {
    const next = prereqNextStepFor(true, { docker: false, dockerfile: false, builder: undefined })
    expect(next).toBe('Docker の導入が必要です。')
    expect(next).not.toContain('レジストリ')
  })

  it('Dockerfile が無い（エキスパート・Docker はある）→ Dockerfile を案内し、レジストリの話はしない', () => {
    const next = prereqNextStepFor(true, { docker: true, dockerfile: false })
    expect(next).toBe('Dockerfile を用意してください。')
    expect(next).not.toContain('レジストリ')
  })

  it('Docker・Dockerfile はあり、レジストリだけ無い（エキスパート）→ レジストリの案内', () => {
    const next = prereqNextStepFor(true, { docker: true, dockerfile: true })
    expect(next).toBe('公開にはコンテナレジストリの認証情報が必要です。')
  })

  it('内蔵ビルダーが無い（標準）→ 次の一手は出さない（内蔵ビルダーは通常必ずあるため、レジストリの話を誤って出さない）', () => {
    const next = prereqNextStepFor(false, { builder: false })
    expect(next).toBe('')
  })

  it('内蔵ビルダーはあり、レジストリだけ無い（標準）→ レジストリの案内', () => {
    const next = prereqNextStepFor(false, { builder: true })
    expect(next).toBe('公開にはコンテナレジストリの認証情報が必要です。')
  })

  it('変異ガード: Docker が無いときに、レジストリ文言へ戻すと落ちる', () => {
    // 直す前は理由に関わらず常に「公開にはコンテナレジストリの認証情報が必要です。」だった
    // （W-37: 足りないものと違うものを案内していた）。ここで固定する。
    const next = prereqNextStepFor(true, { docker: false })
    expect(next).not.toBe('公開にはコンテナレジストリの認証情報が必要です。')
  })
})

describe('W-61: storageCostNote の「専用」側は、設定画面の文脈に合う文になっている', () => {
  it('専用モード: 月額と「作る前に金額を確認」を含み、旧文の断定（いま作って課金）は含まない', () => {
    const note = storageCostNote('dedicated', 495)
    expect(note).toContain('495')
    expect(note).toContain('専用の保存場所')
    expect(note).toContain('作る前に金額を確認')
    // 旧文「このプロジェクト専用の保存場所を作ります」は、設定画面には無い「このプロジェクト」を含み誤解させていた。
    expect(note).not.toContain('このプロジェクト専用')
  })

  it('共有モードの文は変えていない', () => {
    const note = storageCostNote('shared', 495)
    expect(note).toContain('共有')
    expect(note).toContain('495')
  })

  it('Markdown 記法を含まない（掟5）', () => {
    expect(storageCostNote('dedicated', 495)).not.toMatch(/\*\*|__|`/)
    expect(storageCostNote('shared', 495)).not.toMatch(/\*\*|__|`/)
  })
})

describe('W-13/W-15: cloudCost.ts の保存場所・コンテナレジストリの呼び名', () => {
  it('projectDeleteRegistryNote は「イメージの置き場（コンテナレジストリ）」と併記する', () => {
    const note = projectDeleteRegistryNote({ registryName: 'reg1', adopted: true })
    expect(note).toContain('イメージの置き場（コンテナレジストリ）')
  })

  it('teardownTargets の保存場所の行は「バケット（データ）」ではなく実物に合う言い方になっている', () => {
    const targets = teardownTargets({ hasBucket: true, deleteRegistry: false, registryName: null })
    const bucketLine = targets.find(t => t.includes('保存場所'))
    expect(bucketLine).toBeDefined()
    expect(bucketLine).not.toBe('バケット（データ）')
    expect(targets).not.toContain('バケット（データ）')
  })
})

describe('W-98: buildSwitchConfirmMessage は「配分」という専門用語を使わない', () => {
  it('split のとき、確認文に「配分」を含まず、状態が失われることを伝える', () => {
    const msg = buildSwitchConfirmMessage({ versionName: 'v2', label: 'v2', isSplit: true })
    expect(msg).not.toContain('配分')
    expect(msg).toContain('よろしいですか？')
  })

  it('split でないとき、状態の断りは付かない', () => {
    const msg = buildSwitchConfirmMessage({ versionName: 'v2', label: 'v2', isSplit: false })
    expect(msg).not.toContain('配分')
    expect(msg).not.toContain('分けて見せている')
  })
})

describe('W-64/W-78/W-13: importProject.ts の案内文', () => {
  it('AppRun の引き継ぎ未定（intent 未指定）のとき、「控えます」ではなく読み取って残すと案内する', () => {
    const notes = importPlanNotes({ target: 'sakura-apprun', publishDirLabel: 'public' })
    const joined = notes.join('\n')
    expect(joined).toContain('読み取って、メモとして残します')
    // 「控えます」は「やめておく」とも読めるため使わない（W-78）。
    expect(joined).not.toContain('設定は控えます')
  })

  it('AppRun を引き継ぐとき、イメージの置き場にコンテナレジストリを併記する（W-13）', () => {
    const notes = importPlanNotes({
      target: 'sakura-apprun',
      publishDirLabel: 'public',
      intent: 'update',
      adopt: { blocker: null, reusesRegistry: false, specName: 'myapp', appName: 'myapp', warnings: [] } as any,
    })
    const joined = notes.join('\n')
    expect(joined).toContain('イメージの置き場（コンテナレジストリ）')
  })

  it('履歴の起点ができたとき、「何をしても、ここへ戻せます」と言い切らず、50件で消えることを添える（W-64）', () => {
    const notes = importDoneNotes({ fileCount: 3, historySnapshotId: 'snap-1' })
    const joined = notes.join('\n')
    expect(joined).toContain('50件')
    expect(joined).not.toContain('何をしても、ここへ戻せます')
  })
})

describe('W-77: ImportFromPublishedPanel.tsx の「認証情報を開く」は文言ではなく未登録の状態で出す', () => {
  const src = read('src/renderer/components/ImportFromPublishedPanel.tsx')

  it('もう文字列一致 error.includes(...) では判定しない（さくらのクラウド側でもボタンが出るように直した変更が戻っていないか）', () => {
    expect(src).not.toContain("error.includes('トークンが登録されていません')")
  })

  it('「認証情報を開く」ボタンは keys.length === 0（未登録という状態）で出す', () => {
    const idx = src.indexOf('認証情報を開く')
    expect(idx).toBeGreaterThan(-1)
    const before = src.slice(Math.max(0, idx - 200), idx)
    expect(before).toContain('keys.length === 0')
  })

  it('Vercel 未登録の案内は「トークン」ではなく「キー（トークン）」で統一されている', () => {
    const count = (src.match(/Vercel のキー（トークン）が登録されていません/g) ?? []).length
    expect(count).toBeGreaterThanOrEqual(2)
    expect(src).not.toContain('Vercel のトークンが登録されていません')
  })
})
