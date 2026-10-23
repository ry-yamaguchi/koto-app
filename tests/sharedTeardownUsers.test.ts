import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 作った側の破棄: 同じコンテナレジストリをほかのプロジェクトが借りていれば、既定でレジストリを消さない（2026-10-19）──────────
// コンテナレジストリの接続情報は Koto 全体で1つ。記録の無いプロジェクトが公開すると、ほかのプロジェクトが作ったレジストリを借りる。
// 借りる側の破棄は既定オフにしてある（tests/registryOriginWrite.test.ts）。だが**借りられた側（作った側。印は owned）の破棄は、
// 借り手を数えないと既定オンのまま**で、消すと借りている全プロジェクトのイメージが消え、それらのアプリが動かなくなりうる（入口が逆なだけの同じ害）。
//
// 作者の手元の実例（読んだだけ）: ScheduleAPP が作った scheduleapp（registryAdopted: false・アプリ0件）を、reminder・landingTEST・
// landingtest-2・Tsukaisute が借りている（どれも registryName: 'scheduleapp' とアプリ1件）。
//
// 固定のしかた: 偽の兄弟フォルダ（実フォルダ）を置き、本物の main（cloud:teardownRecord）→ 画面の仕様書（readRecord → choices）へ流して、
// 利用者が見る選択の欄（既定・注意の文）を見る。ソースの文字列は読まない（掟10）。
import { A, APP, h, resetHarness, newProjectDir, workspaceOf, setup } from './sharedTeardownHarness'

vi.mock('electron', async () => (await import('./sharedTeardownHarness')).electronMock())
vi.mock('../src/main/cloud/auth', async (orig) => (await import('./sharedTeardownHarness')).authMock(await orig()))
vi.mock('../src/main/cloud/storageAdapter', async (orig) => (await import('./sharedTeardownHarness')).storageAdapterMock(await orig()))
vi.mock('../src/main/cloud/client', async (orig) => (await import('./sharedTeardownHarness')).clientMock(await orig()))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { sharedTeardownSpec } from '../src/renderer/teardown/targets/shared'
import { registryDeleteHelp } from '../src/shared/cloudCost'
import { resetProjectOpsForTests } from '../src/main/projectOps'

registerCloudHandlers({} as any)
const mainRecord = h.handlers.get('cloud:teardownRecord')!
const EVENT = {}

let dir = ''
beforeEach(() => {
  resetProjectOpsForTests(); resetHarness(); dir = newProjectDir()
  ;(globalThis as any).window = { electronAPI: { cloud: { teardownRecord: (d: string) => mainRecord(EVENT, d) } } }
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); delete (globalThis as any).window })

const REG = 'scheduleapp'
const ws = (): string => workspaceOf(dir)
const APP_OF = (name: string) => ({ kind: 'apprun-app', id: `app-${name}`, stateful: false, key: `apprun-app:${name}` })

/** ほかのプロジェクトのフォルダを、同じ親フォルダに置く。`state` が null なら記録なし、文字列ならその中身のまま書く。 */
function sibling(name: string, state: unknown | null): string {
  const d = path.join(ws(), name)
  fs.mkdirSync(d, { recursive: true })
  if (state !== null) {
    fs.mkdirSync(path.join(d, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(d, '.sakura-cloud', 'state.json'), typeof state === 'string' ? state : JSON.stringify(state), 'utf-8')
  }
  return d
}
/** 公開したアプリ1件と、このレジストリの名前を記録しているプロジェクト（借りている側。印は無い）。 */
const borrower = (name: string, registry = REG) => sibling(name, { name, backend: 'apprun', resources: [APP_OF(name)], meta: { registryName: registry } })

/** 作った側（Koto がこのプロジェクトのために作ったと記録にある）の破棄の確認が見せる、レジストリの選択の欄と、main が返した借り手。 */
async function ownerChoice(meta: Record<string, unknown> = { registryName: REG, registryAdopted: false }, resources: Parameters<typeof setup>[1]['resources'] = []) {
  setup(dir, { env: [], resources, meta: meta as any })
  const rec = await sharedTeardownSpec.readRecord(dir)
  return { rec, choice: sharedTeardownSpec.choices!(rec)[0] }
}

const NOTE_OF = (who: string) => `ほかのプロジェクト（${who}）も、このコンテナレジストリ『${REG}』を使っています。`
  + '消すと、それらのアプリが動かなくなります。'
  + '消してよいと分かっているときだけ、チェックを入れてください（月額220円・税込が止まります）。'

describe('作った側（owned）の破棄: ほかのプロジェクトが借りていれば、既定でレジストリを消さない', () => {
  it('★★★ 借りているプロジェクトが2つ → 既定オフ。名前を出して、消すとそれらのアプリが動かなくなると言う（全文）', async () => {
    borrower('reminder'); borrower('landingTEST')
    const { rec, choice } = await ownerChoice()
    expect(rec.registryOrigin).toBe('owned') // 作った側であることは変わらない（印は owned のまま。借り手がいるので既定だけ外れる）
    expect(rec.registryUsers).toEqual(['landingTEST', 'reminder'])
    expect(choice.defaultChecked).toBe(false)
    expect(choice.note).toBe(NOTE_OF('landingTEST・reminder'))
    // 借り手がいる（このプロジェクトだけのものではない）ので、外した説明は月額も「後で消す場合は」も言わない
    expect(choice.help).toEqual({ checked: registryDeleteHelp(true, false), unchecked: registryDeleteHelp(false, false) })
    expect(choice.help!.unchecked).toBe('') // 空（出さない）。チェックの名前の言い直しになる説明は言わず、残す理由と月額は note が言う
    // 選択の欄そのものは出す（消してよいと分かっている人が、自分でチェックを入れて消せる）
    expect(choice.id).toBe('deleteRegistry')
  })

  it('★★★ 作者の手元の形（借り手が4つ）→ 「先頭の名前 ほか3件」。件数が名前の代わりにならない', async () => {
    for (const n of ['reminder', 'landingTEST', 'landingtest-2', 'Tsukaisute']) borrower(n)
    const { rec, choice } = await ownerChoice()
    expect(rec.registryUsers).toEqual(['Tsukaisute', 'landingTEST', 'landingtest-2', 'reminder'])
    expect(choice.defaultChecked).toBe(false)
    expect(choice.note).toBe(NOTE_OF('Tsukaisute ほか3件'))
  })

  it('★★★ 借りているプロジェクトが1つだけでも既定オフ（1人でも、そのアプリは動かなくなる）', async () => {
    borrower('reminder')
    const { rec, choice } = await ownerChoice()
    expect(rec.registryUsers).toEqual(['reminder'])
    expect(choice.defaultChecked).toBe(false)
    expect(choice.note).toBe(NOTE_OF('reminder'))
  })

  it('★★★ 借りているプロジェクトが無ければ、これまでどおり既定オン・注意なし（作った側を倒しすぎない）', async () => {
    const { rec, choice } = await ownerChoice()
    expect(rec.registryUsers).toEqual([])
    expect(choice.defaultChecked).toBe(true)
    expect(choice.note).toBeUndefined()
  })

  // 自分のフォルダにも、このレジストリの名前とアプリがある（公開済みのプロジェクトを破棄する、ふつうの形）。自分を数えると、いつも既定オフになる
  it('★★★ 自分のフォルダは数えない（自分もこのレジストリを記録し、アプリがある）。ひとりだけのワークスペースは借り手なし・既定オン', async () => {
    const { rec, choice } = await ownerChoice({ registryName: REG, registryAdopted: false }, [APP])
    expect(fs.readdirSync(ws())).toEqual([path.basename(dir)])
    expect(rec.appNames).toEqual(['myapp'])
    expect(rec.registryUsers).toEqual([])
    expect(choice.defaultChecked).toBe(true)
  })

  it('★★★ 借り手と数えないもの: 別のレジストリを使う・同じ名前でもアプリが無い（破棄済みで名前だけ残っている）・記録なし・壊れた記録・名前が近いだけ・隠しフォルダ・ファイル', async () => {
    borrower('other-registry', 'someone-elses')
    sibling('name-only', { name: 'name-only', backend: 'apprun', resources: [], meta: { registryName: REG } })
    sibling('bucket-only', { name: 'bucket-only', backend: 'apprun', resources: [{ kind: 'bucket', id: 'b', stateful: true, key: 'bucket:b' }], meta: { registryName: REG } })
    sibling('no-state', null)
    sibling('broken', '{ これはJSONではありません')
    sibling('array-state', '[]')
    borrower('similar-name', 'scheduleapp-2')
    borrower('upper-case', 'ScheduleApp')
    borrower('.hidden') // 隠しフォルダ（📡 公開したもの一覧の歩き方と同じく見ない）
    fs.writeFileSync(path.join(ws(), 'notes.txt'), REG, 'utf-8')
    const { rec, choice } = await ownerChoice()
    expect(rec.registryUsers).toEqual([])
    expect(choice.defaultChecked).toBe(true)
    expect(choice.note).toBeUndefined()
  })

  it('★★ 借り手を数えるのは、アプリが1件でもあるとき（ほかの資源が混ざっていても、アプリがあれば借り手）', async () => {
    sibling('mixed', { name: 'mixed', backend: 'apprun', resources: [{ kind: 'bucket', id: 'b', stateful: true, key: 'bucket:b' }, APP_OF('mixed')], meta: { registryName: REG } })
    const { rec, choice } = await ownerChoice()
    expect(rec.registryUsers).toEqual(['mixed'])
    expect(choice.defaultChecked).toBe(false)
  })

  it('★★ 借り手の印は問わない（借りた印がある・無い・作った印がある、どれでも借り手）。印は自分の記録でだけ読む', async () => {
    sibling('marked-true', { name: 'a', backend: 'apprun', resources: [APP_OF('a')], meta: { registryName: REG, registryAdopted: true } })
    sibling('marked-false', { name: 'b', backend: 'apprun', resources: [APP_OF('b')], meta: { registryName: REG, registryAdopted: false } })
    sibling('unmarked', { name: 'c', backend: 'apprun', resources: [APP_OF('c')], meta: { registryName: REG } })
    const { rec } = await ownerChoice()
    expect(rec.registryUsers).toEqual(['marked-false', 'marked-true', 'unmarked'])
  })
})

describe('借りた側・作ったか分からない側: 借り手が分かっていれば、そのことを言う（既定はもともとオフ）', () => {
  it('★★ 借りた側（adopted）の破棄に、ほかの借り手がいる → 既定オフのまま、ほかのプロジェクトが使っていることを言う', async () => {
    borrower('landingTEST')
    const { rec, choice } = await ownerChoice({ registryName: REG, registryAdopted: true })
    expect(rec.registryOrigin).toBe('adopted')
    expect(rec.registryUsers).toEqual(['landingTEST'])
    expect(choice.defaultChecked).toBe(false)
    expect(choice.note).toBe(NOTE_OF('landingTEST'))
  })

  it('★★ 印が無い（unknown）で、ほかの借り手がいる → 同じ。いなければ「作ったか分かりません」（借り手が分からないときの断り）', async () => {
    borrower('landingTEST')
    const withUsers = await ownerChoice({ registryName: REG })
    expect(withUsers.choice.defaultChecked).toBe(false)
    expect(withUsers.choice.note).toBe(NOTE_OF('landingTEST'))
    fs.rmSync(path.join(ws(), 'landingTEST'), { recursive: true, force: true })
    const alone = await ownerChoice({ registryName: REG })
    expect(alone.choice.defaultChecked).toBe(false)
    expect(alone.choice.note).toContain('このプロジェクトのために作ったか分かりません')
  })

  it('★ 借りた側で、ほかに借り手がいなければ、借り物の断り（このプロジェクトのために作ったものではありません）のまま', async () => {
    const { choice } = await ownerChoice({ registryName: REG, registryAdopted: true })
    expect(choice.defaultChecked).toBe(false)
    expect(choice.note).toContain('このプロジェクトのために作ったものではありません')
  })
})

describe('読むだけ・読めなければ確認を出さない', () => {
  it('★★★ 兄弟の記録を読んでも、さくらのクラウドへも保存場所へも要求を出さない（読むだけ）。書きもしない', async () => {
    borrower('reminder')
    const stateOf = (d: string) => fs.readFileSync(path.join(d, '.sakura-cloud', 'state.json'), 'utf-8')
    const before = stateOf(path.join(ws(), 'reminder'))
    await ownerChoice()
    expect(h.calls).toEqual([])
    expect(stateOf(path.join(ws(), 'reminder'))).toBe(before)
  })

  // 親フォルダの一覧を読めないと、借り手がいるか分からない。空に倒すと「借り手なし」と読んで既定オンの確認を出してしまう。
  // 実行する人が root だと権限で止められない（この試験は飛ばす）。
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('★★★ 親フォルダの一覧を読めない → 確認の材料を読めなかったと言う（既定オンの確認を出さない）', async () => {
    setup(dir, { env: [A], resources: [APP], meta: { registryName: REG, registryAdopted: false } })
    fs.chmodSync(ws(), 0o300) // 入れる（x）が、一覧は読めない（r なし）。自分のフォルダへは辿り着けるので、記録そのものは読める
    try {
      const r = await mainRecord(EVENT, dir)
      expect(r.ok).toBe(false)
      expect(r.message).toContain('ほかのプロジェクトが同じコンテナレジストリを使っていないか、確かめられませんでした')
      await expect(sharedTeardownSpec.readRecord(dir)).rejects.toThrow('確かめられませんでした')
    } finally {
      fs.chmodSync(ws(), 0o700)
    }
  })

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('★ レジストリの記録が無いプロジェクトは、親フォルダを読まない（借り手を数える相手のレジストリが無い）', async () => {
    setup(dir, { env: [A], resources: [APP] })
    fs.chmodSync(ws(), 0o300)
    try {
      const r = await mainRecord(EVENT, dir)
      expect(r).toMatchObject({ ok: true, record: { registryName: null, registryUsers: [] } })
    } finally {
      fs.chmodSync(ws(), 0o700)
    }
  })
})

describe('形の守り（画面が受け取る記録）', () => {
  it.each([
    ['registryUsers が欠けた', undefined],
    ['registryUsers が配列でない', 'reminder'],
    ['registryUsers に文字列以外が混ざる', ['reminder', 1]],
    ['registryUsers が数（件数だけを渡した）', 2],
  ])('★★★ %s → 読めなかったと言う（空の借り手に倒して既定オンにしない）', async (_n, bad) => {
    ;(globalThis as any).window = {
      electronAPI: { cloud: { teardownRecord: async () => ({ ok: true, record: { appNames: ['myapp'], registryName: REG, registryOrigin: 'owned', registryUsers: bad, placements: [], stateOnlyBuckets: [] } }) } },
    }
    await expect(sharedTeardownSpec.readRecord(dir)).rejects.toThrow('破棄するものの記録の形を読めませんでした')
  })
})
