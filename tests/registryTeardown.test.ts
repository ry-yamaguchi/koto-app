import { describe, it, expect } from 'vitest'
import { registryDeletionTarget, registryLookupNames, resolvePushRegistry, stateAfterTeardown, withCreationMeta, type EnvState } from '../src/main/cloud/state'

// 2026-08-06 に実際に起きた事故の回帰テスト。
// NewProject-2 を破棄したら、**別プロジェクト yamada のコンテナレジストリが削除された**。
// 原因は、削除対象を「アプリ共通に1つだけ保存される push 用資格情報
// （registry-credentials.enc＝最後に公開したプロジェクトのもの）」から決めていたこと。
// 対象は必ず「そのプロジェクトの state.json が記録している名前」から決める。

describe('破棄で削除するレジストリの決め方', () => {
  it('このプロジェクトが記録している名前を対象にする', () => {
    const state = { meta: { registryName: 'newproject-2' } }
    expect(registryDeletionTarget(state, true)).toEqual({ name: 'newproject-2' })
  })

  // 事故の再発防止。他プロジェクトの名前がどこにあっても、ここには入ってこない
  it('記録が無ければ何も削除しない（別プロジェクトのものを消さない）', () => {
    expect(registryDeletionTarget({}, true)).toEqual({ skipped: 'unknown' })
    expect(registryDeletionTarget({ meta: {} }, true)).toEqual({ skipped: 'unknown' })
    expect(registryDeletionTarget({ meta: { createdAt: 'x' } }, true)).toEqual({ skipped: 'unknown' })
  })

  it('空文字や文字列でない記録も「不明」として扱う', () => {
    expect(registryDeletionTarget({ meta: { registryName: '' } }, true)).toEqual({ skipped: 'unknown' })
    expect(registryDeletionTarget({ meta: { registryName: null as any } }, true)).toEqual({ skipped: 'unknown' })
    expect(registryDeletionTarget({ meta: { registryName: 123 as any } }, true)).toEqual({ skipped: 'unknown' })
  })

  it('ユーザーが「削除しない」を選んだら、記録があっても消さない', () => {
    const state = { meta: { registryName: 'newproject-2' } }
    expect(registryDeletionTarget(state, false)).toEqual({ skipped: 'not-requested' })
  })

  it('「削除しない」の判定が「記録なし」より優先される（理由を取り違えない）', () => {
    expect(registryDeletionTarget({}, false)).toEqual({ skipped: 'not-requested' })
  })
})

// ── 増殖の防止（2026-08-06）───────────────────────────────────────────
// レジストリを削除すると、さくら側でその名前がしばらく予約され同名で作り直せない。
// 実装はサフィックス付き（yamada-c198）で作るが、次に探すときも基本ラベル（yamada）で
// 探していたため見つけられず、**公開や「ユーザー再設定」のたびに新しいレジストリを作って
// いた**（1つにつき月220円）。記録済みの名前を先に試すことで止める。
// ── 公開の push 先（2026-08-09、実機検証の手順4c で発覚）───────────────────
// v0.2.95 が直したのは「破棄」側だけで、「公開」側は接続情報（アプリ共通に1つだけ・
// 最後に「↻ ユーザー再設定」を押したプロジェクトのもの）をそのまま push 先にしていた。
// 実機では yamada のイメージが sample-2-1b9c.sakuracr.jp/yamada:latest として
// B のレジストリに入った。この状態で B を破棄すると A が動かなくなる。
describe('公開の push 先を決める', () => {
  it('記録と接続情報が一致すれば、そのまま使う', () => {
    expect(resolvePushRegistry('yamada-2fdb', 'yamada-2fdb')).toEqual({ use: 'yamada-2fdb', adopt: false })
  })

  // 実害の再現。ここが通ると別プロジェクトのレジストリへ push される
  it('食い違ったら公開させない（別プロジェクトのレジストリへ入れない）', () => {
    expect(resolvePushRegistry('yamada-2fdb', 'sample-2-1b9c'))
      .toEqual({ error: 'mismatch', recorded: 'yamada-2fdb', credential: 'sample-2-1b9c' })
  })

  // 記録が無いのは v0.2.99 以前に失われた環境。ここで止めると「↻ ユーザー再設定」を
  // 押させることになり、記録が無い状態では新しいレジストリを作ってしまう（月220円が増える）
  it('記録が無ければ、いま使っているものを採用する（止めない・増やさない）', () => {
    expect(resolvePushRegistry(null, 'yamada-2fdb')).toEqual({ use: 'yamada-2fdb', adopt: true })
    expect(resolvePushRegistry(undefined, 'yamada-2fdb')).toEqual({ use: 'yamada-2fdb', adopt: true })
    expect(resolvePushRegistry('', 'yamada-2fdb')).toEqual({ use: 'yamada-2fdb', adopt: true })
  })

  it('接続情報が無ければ公開できない', () => {
    expect(resolvePushRegistry('yamada-2fdb', null)).toEqual({ error: 'no-credentials' })
    expect(resolvePushRegistry(null, '')).toEqual({ error: 'no-credentials' })
  })

  // 採用した名前は記録される。次からは食い違いを検出できる
  it('採用したあとは、同じ組み合わせで食い違い判定に切り替わる', () => {
    const first = resolvePushRegistry(null, 'yamada-2fdb')
    expect(first).toEqual({ use: 'yamada-2fdb', adopt: true })
    expect(resolvePushRegistry('yamada-2fdb', 'sample-2-1b9c')).toHaveProperty('error', 'mismatch')
  })
})

// ── 破棄したあとの記録（2026-08-09、実機検証の手順7で発覚）─────────────────
// ユーザーが「コンテナレジストリも削除する」のチェックを外すと、レジストリは残るのに
// meta を丸ごと捨てていたため registryName まで消えていた。すると:
//   1. 次に「↻ ユーザー再設定」を押すと実物を見つけられず新しいレジストリを作る（月220円）
//   2. 次に破棄しようとしても「対象不明」でスキップされ、Koto からは二度と消せない
// 「残す」という選択肢そのものが、そのレジストリを管理不能にする罠になっていた。
describe('破棄したあとの記録', () => {
  const provisioned: EnvState = {
    name: 'yamada', backend: 'apprun', resources: [],
    meta: { createdAt: '2026-08-09T00:00:00.000Z', ttlHours: 0, registryName: 'yamada-2fdb' },
  }

  it('レジストリを残したときは名前を覚えている', () => {
    const s = stateAfterTeardown(provisioned, false)
    expect(s.meta?.registryName).toBe('yamada-2fdb')
  })

  it('レジストリを消したときは名前も忘れる（存在しない名前を次の公開で使わない）', () => {
    const s = stateAfterTeardown(provisioned, true)
    expect(s.meta?.registryName).toBeUndefined()
  })

  it('作成時刻と期限はどちらの場合も落とす（次の公開が初回として扱われる）', () => {
    expect(stateAfterTeardown(provisioned, false).meta?.createdAt).toBeUndefined()
    expect(stateAfterTeardown(provisioned, false).meta?.ttlHours).toBeUndefined()
    expect(stateAfterTeardown(provisioned, true).meta).toBeUndefined()
  })

  it('資源は空のまま引き継ぐ', () => {
    expect(stateAfterTeardown(provisioned, false).resources).toEqual([])
    expect(stateAfterTeardown(provisioned, false).name).toBe('yamada')
    expect(stateAfterTeardown(provisioned, false).backend).toBe('apprun')
  })

  it('元から記録が無ければ meta を作らない', () => {
    const s = stateAfterTeardown({ name: 'x', backend: 'apprun', resources: [] }, false)
    expect(s.meta).toBeUndefined()
  })

  it('入力の state を書き換えない', () => {
    stateAfterTeardown(provisioned, true)
    expect(provisioned.meta?.registryName).toBe('yamada-2fdb')
  })

  // 実害の再現。ここが壊れると、残したレジストリを二度と消せなくなる
  it('レジストリを残したあとでも、次の破棄で削除対象を特定できる', () => {
    const s = stateAfterTeardown(provisioned, false)
    expect(registryDeletionTarget(s, true)).toEqual({ name: 'yamada-2fdb' })
  })

  // 実害の再現。ここが壊れると、次の「↻ ユーザー再設定」でレジストリが増える
  it('レジストリを残したあとでも、既存レジストリを記録名から探せる', () => {
    const s = stateAfterTeardown(provisioned, false)
    expect(registryLookupNames(s, 'yamada')[0]).toBe('yamada-2fdb')
  })

  // 破棄→再公開の一巡。作成メタを付け直しても記録が生き残ること
  it('残したあとに再公開しても記録が生き残る', () => {
    const afterTeardown = stateAfterTeardown(provisioned, false)
    const republished = withCreationMeta(afterTeardown, 24, new Date('2026-08-10T00:00:00.000Z'))
    expect(republished.meta?.registryName).toBe('yamada-2fdb')
    expect(republished.meta?.createdAt).toBe('2026-08-10T00:00:00.000Z')
  })
})

// ── 記録が消えない（2026-08-09、実機検証の手順1で発覚）─────────────────────
// 上の2つの修正（破棄の対象・探索の順番）は、どちらも meta.registryName が残っていて
// はじめて意味を持つ。ところが公開の最後で meta を丸ごと差し替えていたため、
// **初回の公開のたびに registryName が消えて**、実機では一度も効いていなかった。
// 「createdAt が無いとき」＝初回とは、直前の ensureRegistry が registryName を
// 書き込んだ直後そのものである。
describe('初回公開で作成メタを付けるとき', () => {
  const base: EnvState = { name: 'yamada', backend: 'sakura', resources: [] }
  const now = new Date('2026-08-09T00:00:00.000Z')

  it('直前に記録されたレジストリ名を消さない', () => {
    const s = withCreationMeta({ ...base, meta: { registryName: 'yamada-2fdb' } }, 24, now)
    expect(s.meta?.registryName).toBe('yamada-2fdb')
    expect(s.meta?.createdAt).toBe('2026-08-09T00:00:00.000Z')
    expect(s.meta?.ttlHours).toBe(24)
  })

  it('meta が無ければ作成メタだけを付ける', () => {
    const s = withCreationMeta(base, 24, now)
    expect(s.meta).toEqual({ createdAt: '2026-08-09T00:00:00.000Z', ttlHours: 24 })
  })

  it('2回目以降は何も変えない（作成時刻を上書きしない）', () => {
    const before: EnvState = {
      ...base,
      meta: { createdAt: '2026-08-01T00:00:00.000Z', ttlHours: 1, registryName: 'yamada-2fdb' },
    }
    expect(withCreationMeta(before, 24, now)).toBe(before)
  })

  it('入力の state を書き換えない', () => {
    const before: EnvState = { ...base, meta: { registryName: 'yamada-2fdb' } }
    withCreationMeta(before, 24, now)
    expect(before.meta).toEqual({ registryName: 'yamada-2fdb' })
  })

  // 実害の再現。ここが壊れると破棄でレジストリが消えず、月220円が残り続ける
  it('作成メタを付けたあとも、破棄の対象が「対象不明」にならない', () => {
    const s = withCreationMeta({ ...base, meta: { registryName: 'yamada-2fdb' } }, 24, now)
    expect(registryDeletionTarget(s, true)).toEqual({ name: 'yamada-2fdb' })
  })

  // 実害の再現。ここが壊れると公開のたびにレジストリが増える
  it('作成メタを付けたあとも、既存レジストリを記録名から探せる', () => {
    const s = withCreationMeta({ ...base, meta: { registryName: 'yamada-2fdb' } }, 24, now)
    expect(registryLookupNames(s, 'yamada')[0]).toBe('yamada-2fdb')
  })
})

describe('既存レジストリを探す順番', () => {
  it('プロジェクトが記録している名前を先に試す', () => {
    const state = { meta: { registryName: 'yamada-c198' } }
    expect(registryLookupNames(state, 'yamada')).toEqual(['yamada-c198', 'yamada'])
  })

  it('記録が無ければ基本ラベルだけ', () => {
    expect(registryLookupNames({}, 'yamada')).toEqual(['yamada'])
    expect(registryLookupNames({ meta: {} }, 'yamada')).toEqual(['yamada'])
  })

  it('記録と基本ラベルが同じなら重複させない', () => {
    expect(registryLookupNames({ meta: { registryName: 'yamada' } }, 'yamada')).toEqual(['yamada'])
  })

  it('空文字の記録は無視する', () => {
    expect(registryLookupNames({ meta: { registryName: '' } }, 'yamada')).toEqual(['yamada'])
  })

  it('記録があれば必ず先頭に来る（後から探すと増殖が止まらない）', () => {
    const names = registryLookupNames({ meta: { registryName: 'a-1234' } }, 'a')
    expect(names[0]).toBe('a-1234')
  })
})
