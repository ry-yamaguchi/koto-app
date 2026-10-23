import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bucketUsersFromRecords, siblingUseOfBucket, STORAGE_PUBLISH_TARGETS, type RecordRead } from '../src/main/cloud/bucketUsers'

// ── ほかのプロジェクトの記録から、あるバケットの利用者を読む（2026-10-21 実機の欠陥の守り）──────────────────
// 実機（0.6.22-rc.3）: 共用の保存場所 S を使う3つのプロジェクトのうち、片方（HANAMII の破棄）が S の中の自分の prefix を目印ごと消した。
// すると、もう片方（専有型の削除）が「S のキーを見て、ほかに使う prefix が無い」と判断し、S をバケットごと消した。
// 共用型 AppRun で公開中のプロジェクトの env.json には、S が同意済みで残っていたのに、見ていなかった。
// ここは**読み方**の固定。「わからないときは消さない」（known:false）が、実際の読み取りで出ることを見る。
//
// そのあと見つかった回帰（8f5e9d8 の直後）: 共用型・HANAMII・専有型の破棄は、ほかが使うので残したバケットを env.json・state.json に残す。
// 設定に書いてあるだけで「使っている」と数えると、同じ S を使う A・B を順に破棄したとき、B の破棄が破棄済みの A を使用者と読み、S は誰にも消せなくなる。
// だから数えるのは「S を同意済みで使い、**かつ公開の記録がまだある**」兄弟だけ。公開の記録 = `.sakuraide.json` の publish.targets の行
// （旧い記録は state.json の apprun-app 資源・publish.hanamii.projectId も）。

const S = 'koto-rc-s1019'
const CONSENTED_AT = '2026-10-19T00:00:00.000Z'

const workspaces: string[] = []
/** 自分だけの親フォルダ（ワークスペース）と、その中の自分のプロジェクト（`me`）を作る。 */
function newWorkspace(): { ws: string; me: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-bucket-users-'))
  workspaces.push(ws)
  const me = path.join(ws, 'me')
  fs.mkdirSync(me)
  return { ws, me }
}
afterAll(() => { for (const ws of workspaces) fs.rmSync(ws, { recursive: true, force: true }) })

type Sibling = { env?: unknown; state?: unknown; rawEnv?: string; rawState?: string; meta?: unknown; rawMeta?: string }
/** `ws/<name>` に兄弟のプロジェクトを置く。`env`・`state`・`meta` は JSON にして書く（`raw…` は文字列のまま書く）。`meta` は `.sakuraide.json`（公開の記録）。 */
function sibling(ws: string, name: string, s: Sibling = {}): string {
  const dir = path.join(ws, name)
  fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
  if (s.rawEnv !== undefined) fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), s.rawEnv)
  else if (s.env !== undefined) fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), JSON.stringify(s.env))
  if (s.rawState !== undefined) fs.writeFileSync(path.join(dir, '.sakura-cloud', 'state.json'), s.rawState)
  else if (s.state !== undefined) fs.writeFileSync(path.join(dir, '.sakura-cloud', 'state.json'), JSON.stringify(s.state))
  if (s.rawMeta !== undefined) fs.writeFileSync(path.join(dir, '.sakuraide.json'), s.rawMeta)
  else if (s.meta !== undefined) fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify(s.meta))
  return dir
}
const envWith = (bucket: string, extra: Record<string, unknown> = { consentedAt: CONSENTED_AT }) =>
  ({ persistence: { objectStorage: [{ bucket, prefix: 'projects/x/', shared: true, ...extra }] } })
const stateWith = (bucket: string) => ({ name: 'x', backend: 'apprun', resources: [{ kind: 'bucket', id: bucket, stateful: true, key: `bucket:${bucket}` }] })
/** 公開の記録（`.sakuraide.json`）: その公開先の行が1つある。 */
const publishedTo = (target: string) => ({ publish: { targets: { [target]: { publishedAt: '2026-10-19T00:00:00.000Z', url: 'https://x.example/' } } } })

const ok = (value: unknown): RecordRead => ({ kind: 'ok', value })
const MISSING: RecordRead = { kind: 'missing' }
const UNREADABLE: RecordRead = { kind: 'unreadable' }
const PUBLISHED = ok(publishedTo('sakura-apprun'))
/** 公開の記録はあるが、行が無い（破棄が済んだプロジェクトの `.sakuraide.json`）。 */
const NO_ROWS = ok({ publish: { targets: {} } })

describe('siblingUseOfBucket（兄弟1つの3つの記録から、いま使っているかを決める純関数）', () => {
  it('S を同意済みで使い、公開の記録がまだあれば使っている。env.json でも、state.json の bucket 資源だけでも', () => {
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, PUBLISHED, S)).toBe('uses')
    expect(siblingUseOfBucket(MISSING, ok(stateWith(S)), PUBLISHED, S)).toBe('uses')
    expect(siblingUseOfBucket(ok(envWith(S)), ok(stateWith(S)), PUBLISHED, S)).toBe('uses')
  })

  it('★★★ 回帰: 設定に S が残っていても、公開の記録が無ければ使っているに数えない（破棄が済んだ・一度も公開していない）', () => {
    // 共用型・HANAMII・専有型の破棄は、ほかが使うので残したバケットを env.json・state.json に残す。公開の記録（行）は消える
    expect(siblingUseOfBucket(ok(envWith(S)), ok(stateWith(S)), NO_ROWS, S)).toBe('not')
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, MISSING, S)).toBe('not')      // .sakuraide.json が無い（一度も公開していない「用意しただけ」）
    expect(siblingUseOfBucket(MISSING, ok(stateWith(S)), MISSING, S)).toBe('not')
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok({}), S)).toBe('not')       // publish が無い
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok({ publish: {} }), S)).toBe('not')
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok({ publish: { pending: { target: 'hanamii', startedAt: 't' } } }), S)).toBe('not') // 公開開始の印だけは行ではない
    // 行の値が null・false は行ではない（hasPublishRecordFs と同じ見方）
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok({ publish: { targets: { 'sakura-apprun': null, hanamii: false } } }), S)).toBe('not')
  })

  it('★★ 保存場所を使う公開先（共用型・HANAMII・専有型・Vercel）の行なら、どれでも公開ありと数える。レンタルサーバの行は数えない', () => {
    expect([...STORAGE_PUBLISH_TARGETS]).toEqual(['sakura-apprun', 'hanamii', 'sakura-apprun-dedicated', 'vercel'])
    for (const t of ['sakura-apprun', 'hanamii', 'sakura-apprun-dedicated', 'vercel']) {
      expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok(publishedTo(t)), S), t).toBe('uses')
    }
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok(publishedTo('sakura-rental')), S)).toBe('not') // 保存場所を使わない公開先
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok({ publish: { targets: { 'sakura-apprun-dedicated': {} } } }), S)).toBe('uses') // 日時の無い行も行
  })

  it('★★ 旧い記録: state.json に apprun-app 資源があれば公開あり（.sakuraide.json が無くても）。publish.hanamii.projectId も', () => {
    const stateWithApp = { resources: [{ kind: 'bucket', id: S }, { kind: 'apprun-app', id: 'app-1' }] }
    expect(siblingUseOfBucket(MISSING, ok(stateWithApp), MISSING, S)).toBe('uses')
    expect(siblingUseOfBucket(ok(envWith(S)), ok({ resources: [{ kind: 'apprun-app', id: 'app-1' }] }), MISSING, S)).toBe('uses') // env に S・state にはアプリだけ
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok({ publish: { hanamii: { projectId: 'hnm-1' } } }), S)).toBe('uses')
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok({ publish: { hanamii: { projectId: '' } } }), S)).toBe('not')   // 破棄で空にした印
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok({ publish: { hanamii: { projectId: null, storageLeftoverBuckets: null } } }), S)).toBe('not')
    // アプリの資源が無い（破棄でアプリを消した）state は公開ありと数えない
    expect(siblingUseOfBucket(MISSING, ok(stateWith(S)), MISSING, S)).toBe('not')
  })

  it('同意していない（consentedAt が無い・空）は使っているに数えない。別のバケットだけも数えない', () => {
    expect(siblingUseOfBucket(ok(envWith(S, {})), MISSING, PUBLISHED, S)).toBe('not')
    expect(siblingUseOfBucket(ok(envWith(S, { consentedAt: '  ' })), MISSING, PUBLISHED, S)).toBe('not')
    expect(siblingUseOfBucket(ok(envWith('koto-other')), ok(stateWith('koto-other')), PUBLISHED, S)).toBe('not')
    // state の資源が bucket 以外の種類なら数えない（アプリだけで、S を使う設定は無い）
    expect(siblingUseOfBucket(MISSING, ok({ resources: [{ kind: 'apprun-app', id: S }] }), PUBLISHED, S)).toBe('not')
  })

  it('記録のファイルが無いだけ（保存場所を使っていないプロジェクト）は、読めなかったことにしない', () => {
    expect(siblingUseOfBucket(MISSING, MISSING, MISSING, S)).toBe('not')
    expect(siblingUseOfBucket(ok({}), ok({}), ok({}), S)).toBe('not') // persistence も resources も無い
    expect(siblingUseOfBucket(ok({ persistence: {} }), ok({ resources: [] }), PUBLISHED, S)).toBe('not')
  })

  it('★★★ 読めない・壊れている・形が想定と違うものは「わからない」（使っていないとは言わない）', () => {
    expect(siblingUseOfBucket(UNREADABLE, MISSING, PUBLISHED, S)).toBe('unknown')
    expect(siblingUseOfBucket(MISSING, UNREADABLE, PUBLISHED, S)).toBe('unknown')
    for (const bad of [null, [], 'text', 42]) {
      expect(siblingUseOfBucket(ok(bad), MISSING, PUBLISHED, S), JSON.stringify(bad)).toBe('unknown')
      expect(siblingUseOfBucket(MISSING, ok(bad), PUBLISHED, S), JSON.stringify(bad)).toBe('unknown')
    }
    expect(siblingUseOfBucket(ok({ persistence: 'x' }), MISSING, PUBLISHED, S)).toBe('unknown')
    expect(siblingUseOfBucket(ok({ persistence: { objectStorage: 'x' } }), MISSING, PUBLISHED, S)).toBe('unknown')
    expect(siblingUseOfBucket(MISSING, ok({ resources: 'x' }), PUBLISHED, S)).toBe('unknown')
  })

  it('★★★ 公開の記録（.sakuraide.json）を読めない・壊れている・形が想定と違う → 「わからない」（公開していないとは言わない。バケットは残る）', () => {
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, UNREADABLE, S)).toBe('unknown')
    for (const bad of [null, [], 'text', 42]) {
      expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok(bad), S), JSON.stringify(bad)).toBe('unknown')
    }
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok({ publish: 'x' }), S)).toBe('unknown')
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok({ publish: null }), S)).toBe('unknown')
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok({ publish: { targets: 'x' } }), S)).toBe('unknown')
    expect(siblingUseOfBucket(ok(envWith(S)), MISSING, ok({ publish: { targets: null } }), S)).toBe('unknown')
    // state.json が読めなければ、旧い記録の apprun-app を見られない（.sakuraide.json に行が無いだけでは、公開していないと言えない）
    expect(siblingUseOfBucket(ok(envWith(S)), UNREADABLE, NO_ROWS, S)).toBe('unknown')
    // 公開の記録は「S を使う設定がある」ときだけ見る。S を使う設定が無ければ、公開の記録が読めなくても関係ない
    expect(siblingUseOfBucket(ok(envWith('koto-other')), MISSING, UNREADABLE, S)).toBe('not')
  })

  it('片方が使っていると確かめられれば、もう一方が読めなくても「使っている」。公開あり（旧い記録の apprun-app）が確かめられれば、.sakuraide.json が読めなくても「使っている」', () => {
    expect(siblingUseOfBucket(UNREADABLE, ok(stateWith(S)), PUBLISHED, S)).toBe('uses')
    expect(siblingUseOfBucket(ok(envWith(S)), UNREADABLE, PUBLISHED, S)).toBe('uses')
    expect(siblingUseOfBucket(ok(envWith(S)), ok({ resources: [{ kind: 'apprun-app', id: 'app-1' }] }), UNREADABLE, S)).toBe('uses')
  })
})

describe('bucketUsersFromRecords（同じ親フォルダの兄弟のプロジェクトの記録を読む）', () => {
  it('★★★ 実機の再現: 兄弟の env.json に S が同意済みで残っていて、公開もしていれば、その名前が返る', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'rc1-shared', { env: envWith(S), state: stateWith(S), meta: publishedTo('sakura-apprun') })
    expect(bucketUsersFromRecords(me, S)).toEqual({ known: true, users: ['rc1-shared'] })
  })

  it('★ 兄弟の state.json にだけ S がある（env.json は無い・S を外している）が、公開もしていれば使っている', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'only-state', { state: stateWith(S), meta: publishedTo('hanamii') })
    expect(bucketUsersFromRecords(me, S)).toEqual({ known: true, users: ['only-state'] })
  })

  it('★★★ 回帰: 設定に S が残っていても、公開の記録が無い兄弟（破棄が済んだ・一度も公開していない）は数えない → 誰もいない（バケットを消してよい側）', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'torn-down', { env: envWith(S), state: stateWith(S), meta: { publish: { targets: {} } } }) // 破棄が済んだ（行が消えた）
    sibling(ws, 'prepared-only', { env: envWith(S) })                                                       // 一度も公開していない（.sakuraide.json が無い）
    expect(bucketUsersFromRecords(me, S)).toEqual({ known: true, users: [] })
  })

  it('★★★ 旧い記録: 兄弟の state.json に apprun-app 資源だけ（.sakuraide.json は無い）→ 公開あり＝使っている', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'legacy', { env: envWith(S), state: { resources: [{ kind: 'bucket', id: S }, { kind: 'apprun-app', id: 'app-1' }] } })
    expect(bucketUsersFromRecords(me, S)).toEqual({ known: true, users: ['legacy'] })
  })

  it('★ 兄弟が別のバケットだけを使っている・記録が無い → 誰もいない（known:true・0件。バケットを消してよい側）', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'other-bucket', { env: envWith('koto-other'), state: stateWith('koto-other'), meta: publishedTo('sakura-apprun') })
    sibling(ws, 'no-storage', { env: { persistence: {} } })
    fs.mkdirSync(path.join(ws, 'plain-folder'))             // 記録の無いただのフォルダ
    fs.mkdirSync(path.join(ws, 'has-dir-only', '.sakura-cloud'), { recursive: true }) // .sakura-cloud だけで env.json が無い
    expect(bucketUsersFromRecords(me, S)).toEqual({ known: true, users: [] })
  })

  it('★ 自分自身の記録は数えない（自分の env.json に S が同意済みで書いてあっても・公開していても）', () => {
    const { me } = newWorkspace()
    fs.mkdirSync(path.join(me, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(me, '.sakura-cloud', 'env.json'), JSON.stringify(envWith(S)))
    fs.writeFileSync(path.join(me, '.sakura-cloud', 'state.json'), JSON.stringify(stateWith(S)))
    fs.writeFileSync(path.join(me, '.sakuraide.json'), JSON.stringify(publishedTo('sakura-apprun')))
    expect(bucketUsersFromRecords(me, S)).toEqual({ known: true, users: [] })
  })

  it('兄弟が複数なら名前順（文字コード順）。隠しフォルダ・ファイルは見ない。リンクされたプロジェクトは兄弟', () => {
    const { ws, me } = newWorkspace()
    const meta = publishedTo('sakura-apprun')
    sibling(ws, 'b-app', { env: envWith(S), meta })
    sibling(ws, 'a-app', { state: stateWith(S), meta })
    sibling(ws, '.hidden', { env: envWith(S), meta })                  // 隠しフォルダは見ない
    fs.writeFileSync(path.join(ws, 'note.txt'), 'x')              // ファイルは見ない
    const real = sibling(ws, '.real-c', { env: envWith(S), meta })       // リンク先は隠しだが、リンク自体は隠しでない名前
    fs.symlinkSync(real, path.join(ws, 'c-link'))
    expect(bucketUsersFromRecords(me, S)).toEqual({ known: true, users: ['a-app', 'b-app', 'c-link'] })
  })

  it('★★★ 兄弟の記録が壊れている（JSON として読めない）→ わからない。「いない」に倒さない', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'broken-env', { rawEnv: '{ not json' })
    expect(bucketUsersFromRecords(me, S)).toEqual({ known: false })
    const w2 = newWorkspace()
    sibling(w2.ws, 'broken-state', { rawState: '' })
    expect(bucketUsersFromRecords(w2.me, S)).toEqual({ known: false })
  })

  it('★★★ 兄弟の公開の記録（.sakuraide.json）が壊れている → S を使う設定があれば、わからない（公開していないとは言わない）。S を使っていなければ関係ない', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'broken-meta', { env: envWith(S), rawMeta: '{ not json' })
    expect(bucketUsersFromRecords(me, S)).toEqual({ known: false })
    const w2 = newWorkspace()
    sibling(w2.ws, 'broken-meta-other', { env: envWith('koto-other'), rawMeta: '{ not json' })
    expect(bucketUsersFromRecords(w2.me, S)).toEqual({ known: true, users: [] })
  })

  it('★★★ 兄弟の記録を開けない（権限が無い）→ わからない。env.json でも、公開の記録でも', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // root は権限を無視して読めるので、この形を作れない
    const { ws, me } = newWorkspace()
    const dir = sibling(ws, 'locked', { env: envWith('koto-other') })
    const file = path.join(dir, '.sakura-cloud', 'env.json')
    fs.chmodSync(file, 0o000)
    try {
      expect(bucketUsersFromRecords(me, S)).toEqual({ known: false })
    } finally {
      fs.chmodSync(file, 0o600)
    }
    // 公開の記録（.sakuraide.json）が開けない。S を使う設定はある
    const w2 = newWorkspace()
    const dir2 = sibling(w2.ws, 'locked-meta', { env: envWith(S), meta: publishedTo('sakura-apprun') })
    const meta = path.join(dir2, '.sakuraide.json')
    fs.chmodSync(meta, 0o000)
    try {
      expect(bucketUsersFromRecords(w2.me, S)).toEqual({ known: false })
    } finally {
      fs.chmodSync(meta, 0o600)
    }
  })

  it('★ 使っているプロジェクトが1つでも見つかれば、ほかの兄弟が読めなくても known:true（使っているという事実は動かない）', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'broken', { rawEnv: '{ not json' })
    sibling(ws, 'user', { env: envWith(S), meta: publishedTo('sakura-apprun') })
    expect(bucketUsersFromRecords(me, S)).toEqual({ known: true, users: ['user'] })
  })

  it('★★★ 親フォルダの一覧を読めない（親が無い）→ わからない', () => {
    expect(bucketUsersFromRecords(path.join(os.tmpdir(), 'koto-no-such-workspace-xyz', 'me'), S)).toEqual({ known: false })
  })

  it('★★★ プロジェクトのフォルダが絶対パスでない・空・文字列でない、バケット名が空 → わからない（作業中のフォルダを親と読まない）', () => {
    for (const bad of ['', 'relative/dir', '.', undefined, null, 42] as unknown[]) {
      expect(bucketUsersFromRecords(bad as string, S), String(bad)).toEqual({ known: false })
    }
    const { me } = newWorkspace()
    for (const bad of ['', undefined, null] as unknown[]) {
      expect(bucketUsersFromRecords(me, bad as string), String(bad)).toEqual({ known: false })
    }
  })
})

// ── G2: 兄弟のフォルダ・記録を調べる途中の例外は、ENOENT（そもそも無い）以外はすべて「わからない」 ─────────────────────
// 以前は、リンクの先を stat できない例外を握りつぶして「プロジェクトではない」とし、使用者0件に倒していた
// （使っているプロジェクトが、外れた外付けドライブ・権限の無い先にあると、見えないままバケットが消える向き）。
describe('★★★ 兄弟を調べる途中の例外: ENOENT 以外は「わからない」（使用者0件に倒さない）', () => {
  it('たどれないシンボリックリンク（先が存在しない）→ わからない', () => {
    const { ws, me } = newWorkspace()
    fs.symlinkSync(path.join(ws, 'no-such-place'), path.join(ws, 'dangling-link'))
    expect(bucketUsersFromRecords(me, S)).toEqual({ known: false })
  })

  it('たどれないシンボリックリンク（先へ入る権限が無い・EACCES）→ わからない', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // root は権限を無視する
    const { ws, me } = newWorkspace()
    // 兄弟の親フォルダ（ws）の外に、入れないフォルダを作る（ws の中に置くと、そのフォルダ自体の記録が読めず、リンクが原因か区別できない）
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-bucket-users-else-'))
    workspaces.push(elsewhere)
    const locked = path.join(elsewhere, 'locked')
    fs.mkdirSync(path.join(locked, 'proj'), { recursive: true })
    fs.symlinkSync(path.join(locked, 'proj'), path.join(ws, 'link-to-locked'))
    fs.chmodSync(locked, 0o000)
    try {
      expect(bucketUsersFromRecords(me, S)).toEqual({ known: false })
    } finally {
      fs.chmodSync(locked, 0o700)
    }
  })

  it('たどれないリンクがあっても、使っている兄弟が見つかれば known:true（使っているという事実は動かない）', () => {
    const { ws, me } = newWorkspace()
    fs.symlinkSync(path.join(ws, 'no-such-place'), path.join(ws, 'dangling-link'))
    sibling(ws, 'user', { env: envWith(S), meta: publishedTo('sakura-apprun') })
    expect(bucketUsersFromRecords(me, S)).toEqual({ known: true, users: ['user'] })
  })

  it('ENOENT（そもそも無い）は「無い」として扱う: 記録も .sakura-cloud も無いフォルダ・ファイルへのリンクは、プロジェクトではない', () => {
    const { ws, me } = newWorkspace()
    fs.mkdirSync(path.join(ws, 'empty-folder'))                          // 記録が1つも無い（env.json・state.json・.sakuraide.json すべて ENOENT）
    fs.writeFileSync(path.join(ws, 'a-file.txt'), 'x')
    fs.symlinkSync(path.join(ws, 'a-file.txt'), path.join(ws, 'link-to-file')) // たどれるが、ディレクトリではない
    expect(bucketUsersFromRecords(me, S)).toEqual({ known: true, users: [] })
  })
})
