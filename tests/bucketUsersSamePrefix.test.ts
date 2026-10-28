import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bucketUsersFromRecords, siblingHasSamePrefix, type RecordRead } from '../src/main/cloud/bucketUsers'

// ── T-I2: 実フォルダの親に、同じバケット・同じ prefix を記録に持つ兄弟（複製）がいれば samePrefix に名前が出る（0.6.24 I-1）────────────
// フォルダを複製すると、複製は元と同じ env.json（同意済みの保存場所）・state.json（bucket 資源）を持つ。
// **公開の記録の有無は問わない**: 元が「用意しただけ」（.sakuraide.json が無い・行が無い）でも、データは複製と同じ場所にある。
// 以前は「使っている」の条件（同意済み＋公開の記録がまだある）で数えていたので、公開していない元は誰にも数えられず、
// 複製を破棄するとバケットごと消えた（H7）。ここは samePrefix の読み方を、実際のフォルダで固定する。判断（teardownPlanFor）は tests/objectStorageSamePrefix.test.ts。

const S = 'koto-rc-s1019'
const MY_PREFIX = 'projects/myapp/'
const CONSENTED_AT = '2026-10-19T00:00:00.000Z'

const workspaces: string[] = []
/** 自分だけの親フォルダの中に、自分のプロジェクト（`myapp`）を作る。 */
function newWorkspace(): { ws: string; me: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-same-prefix-'))
  workspaces.push(ws)
  const me = path.join(ws, 'myapp')
  fs.mkdirSync(me)
  return { ws, me }
}
afterAll(() => { for (const ws of workspaces) fs.rmSync(ws, { recursive: true, force: true }) })

type Sibling = { env?: unknown; state?: unknown; rawEnv?: string; rawState?: string; meta?: unknown }
function sibling(ws: string, name: string, s: Sibling = {}): string {
  const dir = path.join(ws, name)
  fs.mkdirSync(path.join(dir, '.sakura-cloud'), { recursive: true })
  if (s.rawEnv !== undefined) fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), s.rawEnv)
  else if (s.env !== undefined) fs.writeFileSync(path.join(dir, '.sakura-cloud', 'env.json'), JSON.stringify(s.env))
  if (s.rawState !== undefined) fs.writeFileSync(path.join(dir, '.sakura-cloud', 'state.json'), s.rawState)
  else if (s.state !== undefined) fs.writeFileSync(path.join(dir, '.sakura-cloud', 'state.json'), JSON.stringify(s.state))
  if (s.meta !== undefined) fs.writeFileSync(path.join(dir, '.sakuraide.json'), JSON.stringify(s.meta))
  return dir
}
const envWith = (bucket: string, prefix: string | undefined, extra: Record<string, unknown> = { consentedAt: CONSENTED_AT }) =>
  ({ persistence: { objectStorage: [{ bucket, ...(prefix !== undefined ? { prefix } : {}), shared: true, ...extra }] } })
const stateWith = (bucket: string, prefix?: string) =>
  ({ name: 'x', backend: 'apprun', resources: [{ kind: 'bucket', id: bucket, stateful: true, key: `bucket:${bucket}`, ...(prefix !== undefined ? { prefix } : {}) }] })
const publishedTo = (target: string) => ({ publish: { targets: { [target]: { publishedAt: CONSENTED_AT, url: 'https://x.example/' } } } })

describe('★★★ bucketUsersFromRecords: samePrefix（同じバケット・同じ prefix を記録に持つ兄弟）', () => {
  it('★★★ 公開していない複製（.sakuraide.json が無い・env.json に同意済みで同じ prefix）→ samePrefix に出る。users には出ない（使っているの条件は別）', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'myapp copy', { env: envWith(S, MY_PREFIX) })
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toEqual({ known: true, users: [], samePrefix: ['myapp copy'], samePrefixUnread: [], samePrefixChecked: true })
  })

  it('★★★ 公開の記録に行が無い（破棄が済んだ・用意しただけ）複製も数える。公開している複製は users にも samePrefix にも出る', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'a-no-rows', { env: envWith(S, MY_PREFIX), meta: { publish: { targets: {} } } })
    sibling(ws, 'b-published', { env: envWith(S, MY_PREFIX), meta: publishedTo('sakura-apprun') })
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toEqual({ known: true, users: ['b-published'], samePrefix: ['a-no-rows', 'b-published'], samePrefixUnread: [], samePrefixChecked: true })
  })

  it('state.json の bucket 資源（同じ id・同じ prefix）だけでも数える。env.json に同意済みが無くても', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'only-state', { state: stateWith(S, MY_PREFIX) })
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toEqual({ known: true, users: [], samePrefix: ['only-state'], samePrefixUnread: [], samePrefixChecked: true })
  })

  it('★★ prefix が違えば数えない（ふつうの兄弟は、プロジェクトごとに別の prefix）。同じバケットを使っていても', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'rc1-shared', { env: envWith(S, 'projects/rc1-shared/'), state: stateWith(S, 'projects/rc1-shared/'), meta: publishedTo('hanamii') })
    sibling(ws, 'other-prefix-state', { state: stateWith(S, 'projects/myapp') }) // 末尾の / が無い別の文字列は、同じとは数えない（完全一致）
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toEqual({ known: true, users: ['rc1-shared'], samePrefix: [], samePrefixUnread: [], samePrefixChecked: true })
  })

  it('★★ 別のバケットで同じ prefix は数えない', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'other-bucket', { env: envWith('koto-other', MY_PREFIX), state: stateWith('koto-other', MY_PREFIX) })
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toEqual({ known: true, users: [], samePrefix: [], samePrefixUnread: [], samePrefixChecked: true })
  })

  it('★★★ prefix が空のときは、同じと数えない（自分の prefix が空でも、兄弟の prefix が空でも・無くても）', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'empty-prefix', { env: envWith(S, ''), state: stateWith(S, '') })
    sibling(ws, 'no-prefix', { env: envWith(S, undefined), state: stateWith(S) })
    expect(bucketUsersFromRecords(me, S, '')).toEqual({ known: true, users: [], samePrefix: [], samePrefixUnread: [], samePrefixChecked: true })
    // 兄弟が prefix を持つときも、自分の prefix が空なら同じとは言わない
    sibling(ws, 'has-prefix', { env: envWith(S, MY_PREFIX) })
    expect(bucketUsersFromRecords(me, S, '').samePrefix).toEqual([])
  })

  it('★★ 同意していない（consentedAt が無い）env.json は数えない。state.json の bucket 資源が prefix を持たない旧い記録も数えない（同じとは確かめられない）', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'not-consented', { env: envWith(S, MY_PREFIX, {}) })
    sibling(ws, 'old-state', { state: stateWith(S) })
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toEqual({ known: true, users: [], samePrefix: [], samePrefixUnread: [], samePrefixChecked: true })
  })

  it('自分自身の記録は数えない。隠しフォルダ・ファイルは見ない', () => {
    const { ws, me } = newWorkspace()
    fs.mkdirSync(path.join(me, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(me, '.sakura-cloud', 'env.json'), JSON.stringify(envWith(S, MY_PREFIX)))
    sibling(ws, '.hidden-copy', { env: envWith(S, MY_PREFIX) })
    fs.writeFileSync(path.join(ws, 'note.txt'), 'x')
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toEqual({ known: true, users: [], samePrefix: [], samePrefixUnread: [], samePrefixChecked: true })
  })

  it('★★ 一部の兄弟を読めなくても、読めた兄弟で見つかった複製は返る（known:false のまま）。複製が無ければ samePrefix は空', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'broken', { rawEnv: '{ not json' })
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toEqual({ known: false, samePrefix: [], samePrefixUnread: ['broken'], samePrefixChecked: true })
    sibling(ws, 'myapp copy', { env: envWith(S, MY_PREFIX) })
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toEqual({ known: false, samePrefix: ['myapp copy'], samePrefixUnread: ['broken'], samePrefixChecked: true })
  })

  it('★★★ 確かめられない形は known:false で samePrefix は空（prefix を渡し忘れた・絶対パスでない・バケット名が空・親フォルダが読めない）', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'myapp copy', { env: envWith(S, MY_PREFIX) })
    expect(bucketUsersFromRecords(me, S, undefined as unknown as string)).toEqual({ known: false, samePrefix: [], samePrefixUnread: [], samePrefixChecked: false }) // 渡し忘れを「複製なし」に倒さない
    expect(bucketUsersFromRecords('relative/myapp', S, MY_PREFIX)).toEqual({ known: false, samePrefix: [], samePrefixUnread: [], samePrefixChecked: false })
    expect(bucketUsersFromRecords(me, '', MY_PREFIX)).toEqual({ known: false, samePrefix: [], samePrefixUnread: [], samePrefixChecked: false })
    expect(bucketUsersFromRecords(path.join(os.tmpdir(), 'koto-no-such-workspace-xyz', 'myapp'), S, MY_PREFIX)).toEqual({ known: false, samePrefix: [], samePrefixUnread: [], samePrefixChecked: false })
  })

  it('文字コード順で返す', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'zz', { env: envWith(S, MY_PREFIX) })
    sibling(ws, 'aa', { env: envWith(S, MY_PREFIX) })
    sibling(ws, 'mm', { state: stateWith(S, MY_PREFIX) })
    expect(bucketUsersFromRecords(me, S, MY_PREFIX).samePrefix).toEqual(['aa', 'mm', 'zz'])
  })
})

describe('siblingHasSamePrefix（兄弟1つの env.json・state.json から。純関数）', () => {
  const ok = (value: unknown): RecordRead => ({ kind: 'ok', value })
  const MISSING: RecordRead = { kind: 'missing' }
  const UNREADABLE: RecordRead = { kind: 'unreadable' }

  it('env.json か state.json のどちらかが同じバケット・同じ prefix を持てば true', () => {
    expect(siblingHasSamePrefix(ok(envWith(S, MY_PREFIX)), MISSING, S, MY_PREFIX)).toBe(true)
    expect(siblingHasSamePrefix(MISSING, ok(stateWith(S, MY_PREFIX)), S, MY_PREFIX)).toBe(true)
    expect(siblingHasSamePrefix(ok(envWith(S, 'projects/x/')), ok(stateWith(S, MY_PREFIX)), S, MY_PREFIX)).toBe(true)
  })

  it('読めない・壊れている・形が違うものは数えない（false）。prefix が空なら常に false', () => {
    expect(siblingHasSamePrefix(UNREADABLE, UNREADABLE, S, MY_PREFIX)).toBe(false)
    expect(siblingHasSamePrefix(MISSING, MISSING, S, MY_PREFIX)).toBe(false)
    for (const bad of [null, [], 'text', 42, { persistence: 'x' }, { persistence: { objectStorage: 'x' } }, { resources: 'x' }]) {
      expect(siblingHasSamePrefix(ok(bad), ok(bad), S, MY_PREFIX), JSON.stringify(bad)).toBe(false)
    }
    expect(siblingHasSamePrefix(ok(envWith(S, '')), ok(stateWith(S, '')), S, '')).toBe(false)
    expect(siblingHasSamePrefix(ok(envWith(S, MY_PREFIX)), ok(stateWith(S, MY_PREFIX)), S, '')).toBe(false)
  })
})
