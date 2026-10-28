import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bucketUsersFromRecords } from '../src/main/cloud/bucketUsers'

// ── T-R1b-2: 実フォルダの親に、複製かどうか確かめられない兄弟がいれば samePrefixUnread に名前が出る（0.6.24 R1-b・作者の決定 K3）────────────
// 「確かめられなかった兄弟」= たどれないリンク／env.json か state.json が ENOENT 以外で読めない・壊れている・形が違う。
// **`.sakuraide.json` だけが読めない兄弟は数えない**（env と state が読めれば、複製かどうかは確かめられている）。
// `samePrefixChecked` は、確かめ自体ができたか（親フォルダの一覧を読めた回だけ true）。prefix が空の回は確かめる対象が無い（複製を言えない）。
// 判断（twinRiskOf・teardownPlanFor）は tests/twinRiskOf.test.ts、4つの道の要求の一覧は tests/unreadSiblingTeardown.test.ts。

const S = 'koto-rc-s1019'
const MY_PREFIX = 'projects/myapp/'
const CONSENTED_AT = '2026-10-19T00:00:00.000Z'
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

const workspaces: string[] = []
function newWorkspace(): { ws: string; me: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-unread-'))
  workspaces.push(ws)
  const me = path.join(ws, 'myapp')
  fs.mkdirSync(me)
  return { ws, me }
}
afterAll(() => { for (const ws of workspaces) fs.rmSync(ws, { recursive: true, force: true }) })

type Sibling = { env?: unknown; state?: unknown; rawEnv?: string; rawState?: string; meta?: unknown; rawMeta?: string }
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
const envWith = (bucket: string, prefix: string) => ({ persistence: { objectStorage: [{ bucket, prefix, shared: true, consentedAt: CONSENTED_AT }] } })
const stateWith = (bucket: string, prefix: string) => ({ name: 'x', backend: 'apprun', resources: [{ kind: 'bucket', id: bucket, stateful: true, key: `bucket:${bucket}`, prefix }] })

describe('★★★ bucketUsersFromRecords: samePrefixUnread（複製かどうか確かめられなかった兄弟）', () => {
  it('★★★ 壊れた env.json（state なし）→ 名前が出る。確かめ自体はできた（checked:true）', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'broken-env', { rawEnv: '{ not json' })
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toMatchObject({ samePrefix: [], samePrefixUnread: ['broken-env'], samePrefixChecked: true })
  })

  it('★★★ 壊れた state.json → 名前が出る。空の state.json（JSON として読めない）も', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'broken-state', { env: envWith('koto-other', 'projects/x/'), rawState: '{ not json' })
    sibling(ws, 'empty-state', { rawState: '' })
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toMatchObject({ samePrefixUnread: ['broken-state', 'empty-state'], samePrefixChecked: true })
  })

  it('★★★ env.json が chmod 000（ENOENT 以外で開けない）→ 名前が出る。state.json が開けない回も', () => {
    if (isRoot) return // root は権限を無視して読めるので、この形を作れない
    const { ws, me } = newWorkspace()
    const a = path.join(sibling(ws, 'locked-env', { env: envWith(S, 'projects/x/') }), '.sakura-cloud', 'env.json')
    const b = path.join(sibling(ws, 'locked-state', { state: stateWith(S, 'projects/y/') }), '.sakura-cloud', 'state.json')
    fs.chmodSync(a, 0o000)
    fs.chmodSync(b, 0o000)
    try {
      expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toMatchObject({ samePrefixUnread: ['locked-env', 'locked-state'], samePrefixChecked: true })
    } finally {
      fs.chmodSync(a, 0o600)
      fs.chmodSync(b, 0o600)
    }
  })

  it('★★★ たどれないシンボリックリンク（先が無い）→ 名前が出る。先へ入る権限が無いリンクも', () => {
    const { ws, me } = newWorkspace()
    fs.symlinkSync(path.join(ws, 'no-such-place'), path.join(ws, 'dangling-link'))
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toMatchObject({ samePrefixUnread: ['dangling-link'], samePrefixChecked: true })
    if (isRoot) return
    const w2 = newWorkspace()
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-unread-else-'))
    workspaces.push(elsewhere)
    const locked = path.join(elsewhere, 'locked')
    fs.mkdirSync(path.join(locked, 'proj'), { recursive: true })
    fs.symlinkSync(path.join(locked, 'proj'), path.join(w2.ws, 'link-to-locked'))
    fs.chmodSync(locked, 0o000)
    try {
      expect(bucketUsersFromRecords(w2.me, S, MY_PREFIX)).toMatchObject({ samePrefixUnread: ['link-to-locked'], samePrefixChecked: true })
    } finally {
      fs.chmodSync(locked, 0o700)
    }
  })

  it('★★ JSON としては読めるが、形が想定と違う記録（persistence・resources が配列・オブジェクトでない）も確かめられない', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'shape-env-array', { env: [] })
    sibling(ws, 'shape-env-persistence', { env: { persistence: 'x' } })
    sibling(ws, 'shape-env-list', { env: { persistence: { objectStorage: 'x' } } })
    sibling(ws, 'shape-state-resources', { state: { resources: 'x' } })
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toMatchObject({
      samePrefixUnread: ['shape-env-array', 'shape-env-list', 'shape-env-persistence', 'shape-state-resources'], samePrefixChecked: true,
    })
  })

  it('★★★ 対照: .sakuraide.json だけが読めない兄弟は数えない（env と state が読めれば、複製かどうかは確かめられている）。known:false のまま', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'broken-meta', { env: envWith(S, 'projects/other/'), rawMeta: '{ not json' })
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toEqual({ known: false, samePrefix: [], samePrefixUnread: [], samePrefixChecked: true })
    if (isRoot) return
    // .sakuraide.json が開けない（chmod 000）も同じ
    const w2 = newWorkspace()
    const meta = path.join(sibling(w2.ws, 'locked-meta', { env: envWith(S, 'projects/other/'), meta: {} }), '.sakuraide.json')
    fs.chmodSync(meta, 0o000)
    try {
      expect(bucketUsersFromRecords(w2.me, S, MY_PREFIX)).toEqual({ known: false, samePrefix: [], samePrefixUnread: [], samePrefixChecked: true })
    } finally {
      fs.chmodSync(meta, 0o600)
    }
  })

  it('★★ 対照: 読める記録・無いだけ（ENOENT）の兄弟・ファイル・隠しフォルダ・自分自身は数えない', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'readable', { env: envWith('koto-other', 'projects/x/'), state: stateWith('koto-other', 'projects/x/') })
    fs.mkdirSync(path.join(ws, 'empty-folder')) // 記録が1つも無い（env.json・state.json すべて ENOENT）
    fs.writeFileSync(path.join(ws, 'note.txt'), 'x')
    sibling(ws, '.hidden', { rawEnv: '{ not json' })
    fs.mkdirSync(path.join(me, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(me, '.sakura-cloud', 'env.json'), '{ not json') // 自分自身の記録は数えない
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toEqual({ known: true, users: [], samePrefix: [], samePrefixUnread: [], samePrefixChecked: true })
  })

  it('★★ 複製が見つかっていて、ほかに読めない兄弟もいれば、両方を返す。名前は文字コード順', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'zz-broken', { rawEnv: '{ not json' })
    sibling(ws, 'aa-broken', { rawState: '{ not json' })
    sibling(ws, 'myapp copy', { env: envWith(S, MY_PREFIX) })
    expect(bucketUsersFromRecords(me, S, MY_PREFIX)).toEqual({ known: false, samePrefix: ['myapp copy'], samePrefixUnread: ['aa-broken', 'zz-broken'], samePrefixChecked: true })
  })

  it('★★ prefix が空の回は確かめる対象が無い: samePrefixUnread は空・checked は親フォルダの一覧を読めたか（known:false は今までどおり読めない兄弟から出る）', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'broken-env', { rawEnv: '{ not json' })
    fs.symlinkSync(path.join(ws, 'no-such-place'), path.join(ws, 'dangling-link'))
    expect(bucketUsersFromRecords(me, S, '')).toEqual({ known: false, samePrefix: [], samePrefixUnread: [], samePrefixChecked: true })
    const w2 = newWorkspace()
    sibling(w2.ws, 'fine', { env: envWith('koto-other', 'projects/x/') })
    expect(bucketUsersFromRecords(w2.me, S, '')).toEqual({ known: true, users: [], samePrefix: [], samePrefixUnread: [], samePrefixChecked: true })
  })

  it('★★★ 確かめ自体ができなかった（checked:false）: 絶対パスでない・バケット名が空・prefix が文字列でない・親フォルダの一覧を読めない', () => {
    const { ws, me } = newWorkspace()
    sibling(ws, 'broken-env', { rawEnv: '{ not json' })
    const CHECK_FAILED = { known: false, samePrefix: [], samePrefixUnread: [], samePrefixChecked: false }
    expect(bucketUsersFromRecords('relative/myapp', S, MY_PREFIX)).toEqual(CHECK_FAILED)
    expect(bucketUsersFromRecords('', S, MY_PREFIX)).toEqual(CHECK_FAILED)
    expect(bucketUsersFromRecords(me, '', MY_PREFIX)).toEqual(CHECK_FAILED)
    expect(bucketUsersFromRecords(me, S, undefined as unknown as string)).toEqual(CHECK_FAILED)
    expect(bucketUsersFromRecords(me, S, null as unknown as string)).toEqual(CHECK_FAILED)
    expect(bucketUsersFromRecords(path.join(os.tmpdir(), 'koto-no-such-workspace-xyz', 'myapp'), S, MY_PREFIX)).toEqual(CHECK_FAILED)
  })
})
