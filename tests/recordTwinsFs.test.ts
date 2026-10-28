import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recordTwinsFs, twinIdentitiesOf, DEDICATED_IDENTITY_FIELDS } from '../src/main/cloud/recordTwins'

// ── T-I4・T-I5（読み方）: 同じ公開の記録を持つ複製を、実フォルダの記録から見つける（0.6.24 I-2・作者の決定 K1）──────────────────────
// 複製は元と同じ公開の記録（HANAMII の projectId・共用型の apprun-app の id・専有型のリソース ID）を持つ。1件でも見つかれば、破棄の骨は何も破棄しない
// （骨の側は tests/teardownShellTwins.test.ts、3つの IPC を通した振る舞いは tests/twinsRefusal.test.ts）。ここは**兄弟の読み方**だけを、本物のフォルダで固定する。
//   ・識別子は公開先ごとに書き下す。空でない文字列だけ。**保存場所もレジストリ名も数えない**（複製が借りるのは正しい使い方・保存場所は I-1 の samePrefix が扱う）
//   ・**読めない兄弟は数えない**（壊れたリンク・読めない記録・壊れた JSON）。壊れたリンク1つで、すべての破棄が止まらないようにする（T-I5）
//   ・自分・隠しフォルダ・ファイルは数えない。リンクされたプロジェクトは兄弟（bucketUsers.ts と同じ歩き方）

let ws = ''
let self = ''
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-record-twins-'))
  self = path.join(ws, 'myapp')
  fs.mkdirSync(self)
})
afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }) })

type Files = { meta?: unknown; state?: unknown }
/** フォルダを作り、`.sakuraide.json`（meta）と `.sakura-cloud/state.json`（state）を置く。文字列はそのまま書く（壊れた JSON を作るため）。 */
function make(dir: string, files: Files): string {
  fs.mkdirSync(dir, { recursive: true })
  const put = (file: string, v: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v))
  }
  if (files.meta !== undefined) put(path.join(dir, '.sakuraide.json'), files.meta)
  if (files.state !== undefined) put(path.join(dir, '.sakura-cloud', 'state.json'), files.state)
  return dir
}
const sibling = (name: string, files: Files): string => make(path.join(ws, name), files)

const hanamiiMeta = (projectId: unknown) => ({ publish: { hanamii: { projectId }, targets: { hanamii: { publishedAt: '2026-10-19T00:00:00.000Z' } } } })
const appState = (...ids: unknown[]) => ({ name: 'myapp', backend: 'apprun', resources: ids.map(id => ({ kind: 'apprun-app', id, key: 'apprun-app:myapp', stateful: false })) })
const dedicatedMeta = (rec: Record<string, unknown>) => ({ publish: { apprunDedicated: rec } })

describe('★★★ HANAMII: 同じ projectId を持つ兄弟（複製）の名前を返す', () => {
  it('★★★ 同じ projectId の兄弟 → その名前。別の projectId・projectId が無い・.sakuraide.json が無い兄弟は数えない', () => {
    make(self, { meta: hanamiiMeta('prj-1') })
    sibling('myapp copy', { meta: hanamiiMeta('prj-1') })
    sibling('other', { meta: hanamiiMeta('prj-2') })
    sibling('no-id', { meta: { publish: { targets: { hanamii: {} } } } })
    sibling('no-meta', { state: appState('app-1') })
    expect(recordTwinsFs(self, 'hanamii')).toEqual(['myapp copy'])
  })

  it('複製が複数 → 文字コード順の名前の並び', () => {
    make(self, { meta: hanamiiMeta('prj-1') })
    sibling('b copy', { meta: hanamiiMeta('prj-1') })
    sibling('a copy', { meta: hanamiiMeta('prj-1') })
    expect(recordTwinsFs(self, 'hanamii')).toEqual(['a copy', 'b copy'])
  })

  it('★★ 空の projectId・文字列でない projectId は識別子に数えない（空どうしが「同じ」にならない）', () => {
    make(self, { meta: hanamiiMeta('') })
    sibling('empty', { meta: hanamiiMeta('') })
    expect(recordTwinsFs(self, 'hanamii')).toEqual([])
    make(self, { meta: hanamiiMeta(123) })
    sibling('number', { meta: hanamiiMeta(123) })
    expect(recordTwinsFs(self, 'hanamii')).toEqual([])
    make(self, { meta: hanamiiMeta(null) })
    sibling('null', { meta: hanamiiMeta(null) })
    expect(recordTwinsFs(self, 'hanamii')).toEqual([])
  })

  it('自分の記録に projectId が無い（まだ何も作っていない・破棄が済んだ）→ 比べる相手が無いので空', () => {
    make(self, { meta: { publish: {} } })
    sibling('myapp copy', { meta: hanamiiMeta('prj-1') })
    expect(recordTwinsFs(self, 'hanamii')).toEqual([])
  })

  it('自分自身・隠しフォルダ・ファイルは数えない。リンクされたプロジェクトは兄弟として数える', () => {
    make(self, { meta: hanamiiMeta('prj-1') })
    sibling('.hidden-copy', { meta: hanamiiMeta('prj-1') })
    fs.writeFileSync(path.join(ws, 'note.txt'), 'prj-1')
    const real = path.join(os.tmpdir(), `koto-record-twins-linked-${process.pid}-${Date.now()}`)
    make(real, { meta: hanamiiMeta('prj-1') })
    try {
      fs.symlinkSync(real, path.join(ws, 'linked'))
      expect(recordTwinsFs(self, 'hanamii')).toEqual(['linked'])
    } finally {
      fs.rmSync(real, { recursive: true, force: true })
    }
  })

  it('★★ 保存場所もレジストリ名も数えない: 同じバケット・同じ prefix・同じレジストリ名だけを持つ兄弟は複製ではない（T-I5。保存場所は I-1 が扱う）', () => {
    make(self, { meta: hanamiiMeta('prj-1') })
    sibling('uses-same-storage', {
      meta: hanamiiMeta('prj-2'),
      state: { name: 'x', backend: 'apprun', resources: [{ kind: 'bucket', id: 'koto-data-a', key: 'bucket:koto-data-a', stateful: true, prefix: 'projects/myapp/' }], meta: { registryName: 'myreg' } },
    })
    expect(recordTwinsFs(self, 'hanamii')).toEqual([])
  })
})

describe('★★★ 共用型: 同じ apprun-app の id を持つ兄弟（複製）の名前を返す', () => {
  it('★★★ state.json の apprun-app の id が同じ兄弟 → その名前。別の id・bucket 資源だけの兄弟は数えない', () => {
    make(self, { state: appState('app-1') })
    sibling('myapp copy', { state: appState('app-1') })
    sibling('other', { state: appState('app-2') })
    sibling('storage-only', { state: { name: 'x', backend: 'apprun', resources: [{ kind: 'bucket', id: 'app-1', key: 'bucket:app-1', stateful: true }] } })
    expect(recordTwinsFs(self, 'sakura-apprun')).toEqual(['myapp copy'])
  })

  it('アプリが複数あれば、どれか1つの id が同じなら複製（空の id・文字列でない id は数えない）', () => {
    make(self, { state: appState('app-1', 'app-9') })
    sibling('shares-second', { state: appState('app-x', 'app-9') })
    sibling('empty-id', { state: appState('') })
    sibling('numeric-id', { state: appState(1) })
    expect(recordTwinsFs(self, 'sakura-apprun')).toEqual(['shares-second'])
  })

  it('自分にアプリが無い（保存場所だけの記録・幽霊の行）→ 比べる相手が無いので空', () => {
    make(self, { state: { name: 'myapp', backend: 'apprun', resources: [] } })
    sibling('myapp copy', { state: appState('app-1') })
    expect(recordTwinsFs(self, 'sakura-apprun')).toEqual([])
  })

  it('公開先ごとに見る記録が違う: HANAMII の projectId が同じでも、共用型の複製には数えない（逆も）', () => {
    make(self, { meta: hanamiiMeta('prj-1'), state: appState('app-1') })
    sibling('hanamii-twin', { meta: hanamiiMeta('prj-1') })
    sibling('shared-twin', { state: appState('app-1') })
    expect(recordTwinsFs(self, 'hanamii')).toEqual(['hanamii-twin'])
    expect(recordTwinsFs(self, 'sakura-apprun')).toEqual(['shared-twin'])
  })
})

describe('★★★ 専有型: 同じアプリケーション・クラスタ・LB・ASG の ID を持つ兄弟（複製）の名前を返す', () => {
  it('識別子の項目は書き下したとおり4つ（applicationID・clusterID・loadBalancerID・asgID）', () => {
    expect([...DEDICATED_IDENTITY_FIELDS]).toEqual(['applicationID', 'clusterID', 'loadBalancerID', 'asgID'])
  })

  const OWN = { applicationID: 'app-s', clusterID: 'c-s', loadBalancerID: 'lb-s', asgID: 'asg-s' }
  const OTHER = { applicationID: 'app-o', clusterID: 'c-o', loadBalancerID: 'lb-o', asgID: 'asg-o' }
  it.each(DEDICATED_IDENTITY_FIELDS)('★★★ %s が同じ兄弟 → 複製（ほかの ID が違っても）。4つとも違う兄弟は数えない', field => {
    make(self, { meta: dedicatedMeta(OWN) })
    sibling('myapp copy', { meta: dedicatedMeta({ ...OTHER, [field]: OWN[field] }) })
    sibling('different', { meta: dedicatedMeta({ applicationID: 'app-z', clusterID: 'c-z', loadBalancerID: 'lb-z', asgID: 'asg-z' }) })
    expect(recordTwinsFs(self, 'sakura-apprun-dedicated')).toEqual(['myapp copy'])
  })

  it('★★ 別の項目に同じ値があっても同じ記録ではない（自分の clusterID と、兄弟の asgID が同じ文字列でも数えない）', () => {
    make(self, { meta: dedicatedMeta({ clusterID: 'shared-string' }) })
    sibling('cross', { meta: dedicatedMeta({ asgID: 'shared-string' }) })
    expect(recordTwinsFs(self, 'sakura-apprun-dedicated')).toEqual([])
  })

  it('空・null・文字列でない ID は数えない。自分に ID が1つも無ければ空', () => {
    make(self, { meta: dedicatedMeta({ clusterID: '', asgID: null, loadBalancerID: 7 }) })
    sibling('empties', { meta: dedicatedMeta({ clusterID: '', asgID: null, loadBalancerID: 7 }) })
    expect(recordTwinsFs(self, 'sakura-apprun-dedicated')).toEqual([])
  })

  it('同意の記録（servicePrincipalId・consentedAt）や保存場所の残りの印だけが同じでも、複製ではない（資源の ID だけ）', () => {
    make(self, { meta: dedicatedMeta({ clusterID: 'c1', servicePrincipalId: 'sp-1', consentedAt: '2026-10-01T00:00:00.000Z', storagePermissionId: 'perm-1', storageLeftoverBucket: 'koto-data-a' }) })
    sibling('same-consent', { meta: dedicatedMeta({ servicePrincipalId: 'sp-1', consentedAt: '2026-10-01T00:00:00.000Z', storagePermissionId: 'perm-1', storageLeftoverBucket: 'koto-data-a' }) })
    expect(recordTwinsFs(self, 'sakura-apprun-dedicated')).toEqual([])
  })
})

describe('★★★ T-I5: 読めない兄弟は数えない（壊れたリンク1つで、すべての破棄が止まらない）。ほかの複製は見つける', () => {
  it('★★★ たどれないリンク・壊れた JSON・読めない（ディレクトリだった）記録・形が違う記録の兄弟は数えない。読めた複製だけを返す', () => {
    make(self, { meta: hanamiiMeta('prj-1'), state: appState('app-1') })
    fs.symlinkSync(path.join(ws, 'nowhere'), path.join(ws, 'dead-link'))
    sibling('broken-json', { meta: '{ not json', state: '{ not json' })
    const dirAsFile = sibling('meta-is-dir', {})
    fs.mkdirSync(path.join(dirAsFile, '.sakuraide.json'))
    fs.mkdirSync(path.join(dirAsFile, '.sakura-cloud', 'state.json'), { recursive: true })
    sibling('wrong-shape', { meta: ['prj-1'], state: { resources: 'app-1' } })
    sibling('null-meta', { meta: 'null', state: 'null' })
    sibling('real copy', { meta: hanamiiMeta('prj-1'), state: appState('app-1') })

    expect(recordTwinsFs(self, 'hanamii')).toEqual(['real copy'])
    expect(recordTwinsFs(self, 'sakura-apprun')).toEqual(['real copy'])
  })

  it('★★ 読めない兄弟しかいない → 空（断らない。K1）。投げない', () => {
    make(self, { meta: dedicatedMeta({ clusterID: 'c1' }) })
    fs.symlinkSync(path.join(ws, 'nowhere'), path.join(ws, 'dead-link'))
    sibling('broken-json', { meta: '{ not json' })
    expect(() => recordTwinsFs(self, 'sakura-apprun-dedicated')).not.toThrow()
    expect(recordTwinsFs(self, 'sakura-apprun-dedicated')).toEqual([])
  })

  it('権限が無くて読めない記録（chmod 000）の兄弟も数えない', () => {
    if (process.getuid?.() === 0) return // root は権限を無視する
    make(self, { meta: hanamiiMeta('prj-1') })
    const p = sibling('locked', { meta: hanamiiMeta('prj-1') })
    fs.chmodSync(path.join(p, '.sakuraide.json'), 0o000)
    try {
      expect(recordTwinsFs(self, 'hanamii')).toEqual([])
    } finally {
      fs.chmodSync(path.join(p, '.sakuraide.json'), 0o644)
    }
  })
})

describe('投げない・公開先でないものは空（親フォルダの一覧を読めない回の \'unknown\' は tests/twinsParentUnreadable.test.ts）', () => {
  it('projectDir が文字列でない・空 → \'unknown\'（確かめられない。R2-f）。存在しない・親フォルダが無い → 空（比べる記録が無い）。投げない', () => {
    expect(recordTwinsFs(undefined as unknown as string, 'hanamii')).toBe('unknown')
    expect(recordTwinsFs(null as unknown as string, 'hanamii')).toBe('unknown')
    expect(recordTwinsFs('', 'hanamii')).toBe('unknown')
    expect(recordTwinsFs(path.join(ws, 'no-such', 'project'), 'hanamii')).toEqual([])
  })

  it('骨に載っていない公開先（Vercel・レンタルサーバ・VPS）は常に空', () => {
    make(self, { meta: { publish: { targets: { vercel: {} } } }, state: appState('app-1') })
    sibling('copy', { meta: { publish: { targets: { vercel: {} } } }, state: appState('app-1') })
    expect(recordTwinsFs(self, 'vercel')).toEqual([])
    expect(recordTwinsFs(self, 'sakura-rental')).toEqual([])
  })
})

describe('twinIdentitiesOf（純関数）: 読めない・形が違う記録は空', () => {
  const ok = (value: unknown) => ({ kind: 'ok' as const, value })
  const missing = { kind: 'missing' as const }
  const unreadable = { kind: 'unreadable' as const }

  it('missing・unreadable・形が違う値は、どの公開先でも空', () => {
    for (const target of ['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated'] as const) {
      expect(twinIdentitiesOf(target, missing, missing)).toEqual([])
      expect(twinIdentitiesOf(target, unreadable, unreadable)).toEqual([])
      expect(twinIdentitiesOf(target, ok(null), ok(null))).toEqual([])
      expect(twinIdentitiesOf(target, ok([]), ok('x'))).toEqual([])
      expect(twinIdentitiesOf(target, ok({ publish: 'x' }), ok({ resources: {} }))).toEqual([])
    }
  })

  it('読めた記録からは、「項目:値」の形で識別子を返す（別の項目の同じ値を区別するため）', () => {
    expect(twinIdentitiesOf('hanamii', ok(hanamiiMeta('prj-1')), missing)).toEqual(['hanamii:prj-1'])
    expect(twinIdentitiesOf('sakura-apprun', missing, ok(appState('a', 'b')))).toEqual(['apprun-app:a', 'apprun-app:b'])
    expect(twinIdentitiesOf('sakura-apprun-dedicated', ok(dedicatedMeta({ clusterID: 'c', asgID: 'g' })), missing)).toEqual(['clusterID:c', 'asgID:g'])
  })
})
