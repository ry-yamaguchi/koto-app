import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NEW_BUCKET, defaultBucketChoice, nextChoice, canPrepare, emptyBucketList, createBucketListController,
  type BucketListState,
} from '../src/renderer/storageChoice'
import { isValidBucketName } from '../src/shared/objectStorage'

// ── なぜこのテストが要るか（2026-10-20 実機・0.6.22-rc.3）────────────────────
//
// 【公開】の「💾 データの保存」は、保存場所の一覧を開いたときに1回だけ読んでいた。
// 【公開】を開いたまま、設定の「データの保存」で保存場所 koto-rc-s1019 を作ると、
// 画面の一覧は空のまま（古い写し）で、確認に「どこに保存しますか」が出ず、既定が
// 「新しく作る」に倒れた。そのまま「用意する（費用に同意）」を押すと、すでに作った保存場所が
// あるのに、もう1つ月額495円の保存場所を作りに行く（実機では共有の名前が 409 で止まった）。
//
// 最初の直し（711f363）は、読み直しの規則を React の部品の中にばらばらに書いたため、
// 次の欠陥が残り、文字列一致のテストは全部緑のままだった（順序の守り・alive・placementRef を壊しても落ちない）:
//   1. 読み直しに失敗すると、古い写し（既定は「新しく作る」）のまま「用意する」を押せる
//   2. 読み直しのたびに、利用者がいま選んでいる保存場所を既定で上書きする
//   3. 用意に成功したあと一覧を読み直さず、新しい保存場所が「見つかりません」と出る
//   4. 破棄で保存場所が消えても、【公開】は読み直さない
//
// 直し: 読み直しの状態と規則を、React の外の1つの部品（createBucketListController）にまとめた。
//   ・規則（通し番号・失敗・利用者の選び・押せるか）は、偽の status に実際に流して**振る舞いで**固定する（掟10）。
//   ・配線（StorageNotice.tsx が、どの入口からも同じ controller を呼ぶこと）は、呼び出しの形ごと一意に当てる。
//     StorageNotice は SSR でしか描けない（tests/storageNoticeMarkerAndDataLayerLine.test.ts の流儀）ため。
//
// 配線の入口: 読み直し = 作った直後・マウント・確認を開く・用意の失敗・用意の成功・設定の知らせ・破棄の知らせ（＋失敗時の「もう一度確かめる」）、
//            選ぶ = ラジオ、押せるか = canPrepare。
//
// ミューテーション（当てて落ちることを確認した・python の完全一致置換で戻し、sha256 で復元を確認した）:
//   (a) controller の「いちばん新しい読み直しだけを当てる」判定（mine !== seq）を外す      → 「順序」が落ちる
//   (b) 読み直しの失敗のとき chosen を NEW_BUCKET にする                                    → 「失敗」が落ちる
//   (c) canPrepare から listFailed を外す                                                    → 「canPrepare の全分岐」「失敗」が落ちる
//   (d) StorageNotice の prepare の成功の枝から reload を外す                                → 「用意の成功の枝」が落ちる
//   (e) nextChoice で userPicked を見ない                                                    → 「選びを守る」「既定に追いつく」が落ちる
//
// ── 検分で見つかった7件の直し（根は F1: 「まだ一度も読めていない」状態を、押せる側に置いていた）──────────
//   F1 公開先のタブ（target）だけの変更で controller を作り直し、一覧が空に戻って押せた  → loaded を足す・作る effect を [projectDir] に分ける
//   F2 記録があるとき、一覧の失敗の表示が確認パネルごと消えた                              → 失敗の表示を確認パネルの外へ
//   F3 一覧を読めなかった理由を捨てていた                                                  → listError
//   F4 確認を開いて読み直している最中の選びを、結果が上書きしても気づけなかった            → 振る舞いのテスト
//   F5 マウントの reload 直後の守りを消しても緑だった                                      → reload と直後の行の組で当てる
//   F6 追い越された reload() が、最新の結果が当たる前に解決していた                        → 最新の完了を待つ
//   F7 応答の形の判定（ok の欠落・空の名前）が、振る舞いで固定されていなかった            → 振る舞いのテスト
// ミューテーション（F1〜F7 に1本ずつ。いずれも落ちることを確認した・python の完全一致置換で戻し、sha256 で復元を確認した）:
//   F1 canPrepare から loaded を外す                                  → 「loaded」の4件が落ちる
//   F2 失敗の表示を確認パネルの中に戻す                               → 「確認パネルの外にある」が落ちる
//   F3 listError を常に '' にする                                     → 「失敗の理由」「応答の形の判定」ほか計17件が落ちる
//   F4 nextChoice で userPicked を見ない                              → 「選びを守る」と、確認を開いている最中の選び2件ほか計6件が落ちる
//   F5 マウントの reload 直後の if (!alive) return を消す             → 「入口1: マウント」が落ちる
//   F6 追い越されたら待たずに解決する形に戻す                         → 「A が先に返っても…解決しない」ほか計3件が落ちる
//   F7 ok の欠落を成功扱いにする                                      → 「ok の欠落」ほか計3件が落ちる
// 追加の変異（controller の effect の依存に target を足す・作った直後の reload を消す・空の名前を成功扱いにする・
//   message と e.message を捨てる・結果が userPicked を落とす・判定 mine !== seq を外す・canPrepare から listFailed を外す・
//   失敗の表示から listError を外す・mount effect で dispose する・用意の成功の枝で reload を待たない）も、すべて落ちた。

const notice = readFileSync(join(__dirname, '..', 'src/renderer/components/StorageNotice.tsx'), 'utf-8')
const settings = readFileSync(join(__dirname, '..', 'src/renderer/components/StorageSettings.tsx'), 'utf-8')
const teardownFlow = readFileSync(join(__dirname, '..', 'src/renderer/teardown/flow.ts'), 'utf-8')
const choiceSource = readFileSync(join(__dirname, '..', 'src/renderer/storageChoice.ts'), 'utf-8')

/** start から end までを切り出す。**どちらかが無ければ（-1）ここで落とす**（空の切り出しで通らない）。 */
function between(body: string, start: string, end: string): string {
  const s = body.indexOf(start)
  expect(s, `切り出しの始まりが見つからない: ${start}`).toBeGreaterThan(-1)
  const e = body.indexOf(end, s + start.length)
  expect(e, `切り出しの終わりが見つからない: ${end}`).toBeGreaterThan(-1)
  return body.slice(s, e + end.length)
}

function count(body: string, needle: string): number {
  return body.split(needle).length - 1
}

// ── 偽の status: 解決の順を外から操れる ─────────────────────────────────────────

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void }

function harness(o: { recorded?: string; initial?: Partial<BucketListState> } = {}) {
  /** status が呼ばれた順の、未解決の Promise。 */
  const calls: Pending[] = []
  /** onChange に渡された状態の全部。 */
  const changes: BucketListState[] = []
  const rec = { value: o.recorded ?? '' }
  const c = createBucketListController({
    status: () => new Promise<unknown>((resolve, reject) => { calls.push({ resolve, reject }) }),
    recorded: () => rec.value,
    onChange: s => { changes.push(s) },
    initial: o.initial,
  })
  return { c, calls, changes, rec }
}

/** storage:status の成功の応答（形は src/main/ipc/cloud.ts の storage:status）。 */
const ok = (...names: string[]) => ({ ok: true, siteReady: true, buckets: names.map(name => ({ name })) })

/** 読み直しを始めて、すぐ解決して、終わるまで待つ。 */
async function reloadWith(h: ReturnType<typeof harness>, reply: unknown): Promise<void> {
  const p = h.c.reload()
  h.calls[h.calls.length - 1].resolve(reply)
  await p
}

describe('既定の選び方（defaultBucketChoice）', () => {
  it('★★★ 記録の保存場所が一覧にあれば、それを選ぶ（先頭でなくても）', () => {
    expect(defaultBucketChoice(['a-bucket', 'b-bucket', 'c-bucket'], 'b-bucket')).toBe('b-bucket')
    expect(defaultBucketChoice(['only-one'], 'only-one')).toBe('only-one')
  })

  it('★★★ 記録が一覧に無い・記録が無いときは、一覧の先頭（すでにある保存場所＝費用は増えない）', () => {
    expect(defaultBucketChoice(['a-bucket', 'b-bucket'], 'gone-bucket')).toBe('a-bucket')
    expect(defaultBucketChoice(['a-bucket', 'b-bucket'], '')).toBe('a-bucket')
    expect(defaultBucketChoice(['koto-rc-s1019'], '')).toBe('koto-rc-s1019')
  })

  it('★★★ 一覧が空のときだけ「新しく作る」（記録があっても、実在しなければ作るしかない）', () => {
    expect(defaultBucketChoice([], '')).toBe(NEW_BUCKET)
    expect(defaultBucketChoice([], 'gone-bucket')).toBe(NEW_BUCKET)
  })

  it('★★ 「新しく作る」の印は、本物の保存場所の名前と重ならない', () => {
    expect(isValidBucketName(NEW_BUCKET)).toBe(false)
  })
})

describe('読み直したあとの選び方（nextChoice）', () => {
  it('★★★ 利用者が選んでいて、その選びが一覧にあれば、そのまま（先頭や記録に戻さない）', () => {
    expect(nextChoice({ names: ['a', 'b'], recorded: 'a', previous: 'b', userPicked: true })).toBe('b')
    expect(nextChoice({ names: ['a', 'b'], recorded: '', previous: 'b', userPicked: true })).toBe('b')
  })

  it('★★★ 利用者が「新しく作る」を選んでいれば、一覧に保存場所があっても、そのまま', () => {
    expect(nextChoice({ names: ['a', 'b'], recorded: 'a', previous: NEW_BUCKET, userPicked: true })).toBe(NEW_BUCKET)
    expect(nextChoice({ names: [], recorded: '', previous: NEW_BUCKET, userPicked: true })).toBe(NEW_BUCKET)
  })

  it('★★★ 利用者の選びが一覧から消えていたら、既定へ（記録 → 先頭 → 空なら新しく作る）', () => {
    expect(nextChoice({ names: ['a', 'c'], recorded: 'c', previous: 'b', userPicked: true })).toBe('c')
    expect(nextChoice({ names: ['a', 'c'], recorded: '', previous: 'b', userPicked: true })).toBe('a')
    expect(nextChoice({ names: [], recorded: '', previous: 'b', userPicked: true })).toBe(NEW_BUCKET)
  })

  it('★★★ 利用者がまだ選んでいなければ、前の選びが一覧にあっても、既定に追いつく', () => {
    expect(nextChoice({ names: ['a', 'b'], recorded: 'b', previous: 'a', userPicked: false })).toBe('b')
    expect(nextChoice({ names: ['a', 'b'], recorded: '', previous: 'b', userPicked: false })).toBe('a')
    expect(nextChoice({ names: ['koto-rc-s1019'], recorded: '', previous: NEW_BUCKET, userPicked: false })).toBe('koto-rc-s1019')
  })
})

describe('押せるか（canPrepare）: 全分岐', () => {
  const base: BucketListState = { buckets: ['a'], chosen: 'a', userPicked: false, loading: false, loaded: true, siteReady: true, listFailed: false, listError: '' }

  it('★★★ 忙しくなく・一度は読め・読み直し中でなく・一覧の失敗でもないときだけ押せる', () => {
    expect(canPrepare(base, false)).toBe(true)
  })

  it('★★★ まだ一度も読めていない（loaded=false）なら押せない。初期の状態（何も読んでいない）も押せない', () => {
    expect(canPrepare({ ...base, loaded: false }, false)).toBe(false)
    expect(canPrepare(emptyBucketList(), false)).toBe(false)
    // 初期の状態は、一覧が空・chosen が「新しく作る」＝押すと月額の保存場所を作りに行く形
    expect(emptyBucketList().chosen).toBe(NEW_BUCKET)
    expect(emptyBucketList().loaded).toBe(false)
    expect(emptyBucketList().loading).toBe(false)
    expect(emptyBucketList().listFailed).toBe(false)
    expect(emptyBucketList().listError).toBe('')
  })

  it('★★★ 用意の途中（busy）は押せない', () => {
    expect(canPrepare(base, true)).toBe(false)
  })

  it('★★★ 読み直している間は押せない', () => {
    expect(canPrepare({ ...base, loading: true }, false)).toBe(false)
  })

  it('★★★ いちばん新しい読み直しが失敗したままなら押せない（古い写しのまま費用の増える側へ進ませない）', () => {
    expect(canPrepare({ ...base, listFailed: true }, false)).toBe(false)
  })

  it('★★ 条件が重なっても押せない（16通りのうち、押せるのは1つだけ）', () => {
    let pressable = 0
    for (const busy of [false, true]) {
      for (const loaded of [false, true]) {
        for (const loading of [false, true]) {
          for (const listFailed of [false, true]) {
            if (canPrepare({ ...base, loaded, loading, listFailed }, busy)) pressable++
          }
        }
      }
    }
    expect(pressable).toBe(1)
  })
})

describe('controller: 一覧の読み直し', () => {
  it('★★★ 実機の流れ: 最初の一覧が [] → koto-rc-s1019 が増えた一覧で reload → chosen は koto-rc-s1019（NEW_BUCKET にならない）', async () => {
    const h = harness()
    await reloadWith(h, ok()) // 【公開】を開いたとき: 保存場所は0個
    expect(h.c.get().buckets).toEqual([])
    expect(h.c.get().chosen).toBe(NEW_BUCKET)
    await reloadWith(h, ok('koto-rc-s1019')) // 設定で作ったあと
    expect(h.c.get().buckets).toEqual(['koto-rc-s1019'])
    expect(h.c.get().chosen).toBe('koto-rc-s1019')
    expect(h.c.get().chosen).not.toBe(NEW_BUCKET)
    expect(h.c.get().loading).toBe(false)
    expect(h.c.get().listFailed).toBe(false)
  })

  it('★★ 読み直しを始めると loading が立ち、結果が当たると下りる。onChange は get() と同じ状態を渡す', async () => {
    const h = harness()
    const p = h.c.reload()
    expect(h.c.get().loading).toBe(true)
    expect(h.changes[h.changes.length - 1].loading).toBe(true)
    h.calls[0].resolve(ok('a'))
    await p
    expect(h.c.get().loading).toBe(false)
    expect(h.changes[h.changes.length - 1]).toEqual(h.c.get())
  })

  it('★★ 記録の保存場所は、結果を当てる時点で読む（読み直しの間に記録が変わっても、新しいほうで選ぶ）', async () => {
    const h = harness({ recorded: '' })
    const p = h.c.reload()
    h.rec.value = 'mine' // 読み直しの間に、用意が済んで記録が変わった
    h.calls[0].resolve(ok('a', 'mine'))
    await p
    expect(h.c.get().chosen).toBe('mine')
  })

  it('★★ 記録の保存場所が新しい一覧にあれば、先頭より記録を選ぶ', async () => {
    const h = harness({ recorded: 'mine-bucket' })
    await reloadWith(h, ok('a-bucket', 'mine-bucket'))
    expect(h.c.get().chosen).toBe('mine-bucket')
  })

  it('★★ 一覧から保存場所が消えていたら、空になった一覧で決め直す（読めたのだから反映する）', async () => {
    const h = harness({ initial: { buckets: ['gone-bucket'], chosen: 'gone-bucket' }, recorded: 'gone-bucket' })
    await reloadWith(h, ok())
    expect(h.c.get().buckets).toEqual([])
    expect(h.c.get().chosen).toBe(NEW_BUCKET)
  })

  it('★★ initial で始めの状態を渡せる', () => {
    const h = harness({ initial: { buckets: ['x'], chosen: 'x' } })
    expect(h.c.get()).toEqual({ ...emptyBucketList(), buckets: ['x'], chosen: 'x' })
  })

  it('★★ 同じ状態の読み直しを重ねても、状態は壊れない（読み直しの口が6つあるため）', async () => {
    const h = harness()
    await reloadWith(h, ok('a'))
    await reloadWith(h, ok('a'))
    await reloadWith(h, ok('a'))
    expect(h.c.get()).toEqual({ buckets: ['a'], chosen: 'a', userPicked: false, loading: false, loaded: true, siteReady: true, listFailed: false, listError: '' })
  })
})

describe('controller: まだ一度も読めていない間は押せない（loaded）', () => {
  it('★★★ 作った直後・読み直しの途中・最初の読み直しが成功したあと、の3点で押せるかを見る（成功して初めて押せる）', async () => {
    const h = harness()
    // 作った直後（まだ読み直しも始めていない）。一覧は空・chosen は「新しく作る」のまま
    expect(h.c.get().loaded).toBe(false)
    expect(h.c.get().buckets).toEqual([])
    expect(h.c.get().chosen).toBe(NEW_BUCKET)
    expect(canPrepare(h.c.get(), false)).toBe(false)
    // 読み直しの途中（status が未解決）
    const p = h.c.reload()
    expect(h.c.get().loading).toBe(true)
    expect(h.c.get().loaded).toBe(false)
    expect(canPrepare(h.c.get(), false)).toBe(false)
    // 最初の読み直しが成功して初めて押せる
    h.calls[0].resolve(ok('exists-bucket'))
    await p
    expect(h.c.get().loaded).toBe(true)
    expect(canPrepare(h.c.get(), false)).toBe(true)
    expect(h.c.get().chosen).toBe('exists-bucket') // 既にある保存場所（費用は増えない）
  })

  it('★★★ 公開先のタブを切り替える形: controller を作り直さず、読み直しが重なっても、押せるのは読めた一覧があるときだけ', async () => {
    const h = harness()
    await reloadWith(h, ok('exists-bucket'))
    // タブの切り替えで mount effect が読み直す（controller は同じ）。一覧は空に戻らない
    const p = h.c.reload()
    expect(h.c.get().buckets).toEqual(['exists-bucket'])
    expect(h.c.get().chosen).toBe('exists-bucket')
    expect(h.c.get().loaded).toBe(true) // 読み直しの途中でも「読めたことがある」は下りない
    expect(canPrepare(h.c.get(), false)).toBe(false) // 読み直しの間は押せない
    h.calls[1].resolve(ok('exists-bucket'))
    await p
    expect(canPrepare(h.c.get(), false)).toBe(true)
  })

  it('★★★ 一覧が空だと確かめられて初めて、「新しく作る」で押せる（空の初期値とは違う）', async () => {
    const h = harness()
    expect(canPrepare(h.c.get(), false)).toBe(false)
    await reloadWith(h, ok())
    expect(h.c.get().buckets).toEqual([])
    expect(h.c.get().chosen).toBe(NEW_BUCKET)
    expect(h.c.get().loaded).toBe(true)
    expect(canPrepare(h.c.get(), false)).toBe(true)
  })

  it('★★★ 最初の読み直しが失敗したら、loaded は false のまま・押せない（失敗を重ねても）', async () => {
    const h = harness()
    for (let i = 0; i < 2; i++) {
      const p = h.c.reload()
      h.calls[i].reject(new Error('通信できません'))
      await p
      expect(h.c.get().loaded).toBe(false)
      expect(h.c.get().listFailed).toBe(true)
      expect(canPrepare(h.c.get(), false)).toBe(false)
    }
  })

  it('★★ 一度読めたあとの失敗では、loaded は true のまま。押せないのは listFailed のため', async () => {
    const h = harness({ recorded: 'mine' })
    await reloadWith(h, ok('mine'))
    await reloadWith(h, { ok: false, message: 'x' })
    expect(h.c.get().loaded).toBe(true)
    expect(h.c.get().listFailed).toBe(true)
    expect(h.c.get().buckets).toEqual(['mine'])
    expect(canPrepare(h.c.get(), false)).toBe(false)
  })
})

describe('controller: 失敗の理由（listError）', () => {
  const KEY_MISSING = 'さくらのクラウドのAPIキーが未登録です'
  const SHAPE = '保存場所の一覧の形が想定と違います。'
  const UNREADABLE = '保存場所の一覧を読めませんでした。'

  it('★★★ { ok:false, message } → listError がその文（APIキー未登録の実際の応答）', async () => {
    const h = harness()
    // 形は src/main/ipc/cloud.ts の storage:status のキー未登録の戻り
    await reloadWith(h, { ok: false, message: KEY_MISSING, siteReady: false, buckets: [] })
    expect(h.c.get().listFailed).toBe(true)
    expect(h.c.get().listError).toBe(KEY_MISSING)
  })

  it('★★★ 例外 → listError は e.message', async () => {
    const h = harness()
    const p = h.c.reload()
    h.calls[0].reject(new Error('HTTP 403 Forbidden'))
    await p
    expect(h.c.get().listFailed).toBe(true)
    expect(h.c.get().listError).toBe('HTTP 403 Forbidden')
  })

  it('★★★ status が同期的に例外を投げても、その message が listError', async () => {
    const c = createBucketListController({
      status: () => { throw new Error('呼べません') },
      recorded: () => '',
      onChange: () => {},
    })
    await c.reload()
    expect(c.get().listError).toBe('呼べません')
  })

  it('★★★ 形が違う → 「保存場所の一覧の形が想定と違います。」', async () => {
    const h = harness()
    await reloadWith(h, { ok: true })
    expect(h.c.get().listError).toBe(SHAPE)
    await reloadWith(h, null)
    expect(h.c.get().listError).toBe(SHAPE)
    await reloadWith(h, { ok: true, buckets: 'x' })
    expect(h.c.get().listError).toBe(SHAPE)
  })

  it('★★ message が無い・空・文字列でない { ok:false } と、message の無い例外 → 「保存場所の一覧を読めませんでした。」', async () => {
    const h = harness()
    for (const reply of [{ ok: false }, { ok: false, message: '' }, { ok: false, message: '  ' }, { ok: false, message: 404 }]) {
      await reloadWith(h, reply)
      expect(h.c.get().listFailed).toBe(true)
      expect(h.c.get().listError).toBe(UNREADABLE)
    }
    const p = h.c.reload()
    h.calls[h.calls.length - 1].reject(undefined)
    await p
    expect(h.c.get().listError).toBe(UNREADABLE)
  })

  it('★★★ 成功すると、listError は空・listFailed は false に戻る', async () => {
    const h = harness()
    await reloadWith(h, { ok: false, message: KEY_MISSING })
    expect(h.c.get().listError).toBe(KEY_MISSING)
    await reloadWith(h, ok('a'))
    expect(h.c.get().listError).toBe('')
    expect(h.c.get().listFailed).toBe(false)
  })

  it('★★ 失敗のたびに、理由は新しいものになる（古い理由が残らない）', async () => {
    const h = harness()
    await reloadWith(h, { ok: false, message: KEY_MISSING })
    await reloadWith(h, { ok: false, message: 'HTTP 500' })
    expect(h.c.get().listError).toBe('HTTP 500')
  })

  it('★★ 失敗は listError を除いて、一覧・選び・loaded を変えない（理由だけが増える）', async () => {
    const h = harness({ recorded: 'mine' })
    await reloadWith(h, ok('a', 'mine'))
    h.c.pick('a')
    const before = h.c.get()
    await reloadWith(h, { ok: false, message: KEY_MISSING })
    expect(h.c.get()).toEqual({ ...before, listFailed: true, listError: KEY_MISSING })
  })
})

describe('controller: 順序（いちばん新しい読み直しの結果だけを当てる）', () => {
  it('★★★ reload A を始め、reload B を始め、B が先に返り、A が後で返る → B の結果が残る（A は当てない）', async () => {
    const h = harness()
    const a = h.c.reload()
    const b = h.c.reload()
    expect(h.calls).toHaveLength(2)
    h.calls[1].resolve(ok('from-b')) // B が先に返る
    await b
    expect(h.c.get().buckets).toEqual(['from-b'])
    expect(h.c.get().loading).toBe(false)
    const changesAfterB = h.changes.length
    h.calls[0].resolve(ok('from-a')) // A が後で返る
    await a
    expect(h.c.get().buckets).toEqual(['from-b'])
    expect(h.c.get().chosen).toBe('from-b')
    expect(h.c.get().loading).toBe(false)
    expect(h.changes).toHaveLength(changesAfterB) // A は onChange も呼ばない
  })

  it('★★★ A が先に返り、B が後で返る → A は当てず（loading も下ろさず）、B が当たってから下りる', async () => {
    const h = harness()
    const a = h.c.reload()
    const b = h.c.reload()
    h.calls[0].resolve(ok('from-a')) // 古い A が先に返る
    for (let i = 0; i < 20; i++) await Promise.resolve() // A の reload() は、B を待つので解決しない（待たずに結果を見る）
    expect(h.c.get().buckets).toEqual([]) // A の結果は当たらない
    expect(h.c.get().loading).toBe(true) // B がまだ途中なので、押せないまま
    h.calls[1].resolve(ok('from-b'))
    await Promise.all([a, b])
    expect(h.c.get().buckets).toEqual(['from-b'])
    expect(h.c.get().loading).toBe(false)
  })

  it('★★★ 後から始まった読み直しが失敗しても、先に始めた古い成功は当てない', async () => {
    const h = harness()
    const a = h.c.reload()
    const b = h.c.reload()
    h.calls[1].reject(new Error('通信できません')) // B が失敗
    await b
    expect(h.c.get().listFailed).toBe(true)
    h.calls[0].resolve(ok('from-a')) // 古い A が成功で返っても、失敗を覆さない
    await a
    expect(h.c.get().listFailed).toBe(true)
    expect(h.c.get().buckets).toEqual([])
  })

  /** マイクロタスクを十分に回す（Promise が解決できる状態なら、ここで必ず解決する）。 */
  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }

  it('★★★ A が先に返っても、B が未解決の間は A の reload() は解決しない。B が当たって初めて解決し、そのとき get() は B の結果', async () => {
    const h = harness()
    const a = h.c.reload()
    const b = h.c.reload()
    let aSettled = false
    void a.then(() => { aSettled = true })
    h.calls[0].resolve(ok('from-a')) // 古い A の status が先に返る
    await flush()
    expect(aSettled).toBe(false) // A は自分の結果を当てないまま解決してはいけない
    expect(h.c.get().buckets).toEqual([])
    h.calls[1].resolve(ok('from-b'))
    await a
    expect(h.c.get().buckets).toEqual(['from-b']) // A の await が戻った時点で、B の結果が当たっている
    expect(h.c.get().loading).toBe(false)
    await b
  })

  it('★★★ B が先に当たり、そのあと A が返る → A の reload() が解決した時点で get() は B の結果（A を当て直さない）', async () => {
    const h = harness()
    const a = h.c.reload()
    const b = h.c.reload()
    h.calls[1].resolve(ok('from-b'))
    await b
    h.calls[0].resolve(ok('from-a'))
    await a
    expect(h.c.get().buckets).toEqual(['from-b'])
    expect(h.c.get().chosen).toBe('from-b')
  })

  it('★★★ 3つ重ねても（A → B → C）、A と B の reload() は C が当たったあとに解決する', async () => {
    const h = harness()
    const a = h.c.reload()
    const b = h.c.reload()
    const c = h.c.reload()
    const settled: string[] = []
    void a.then(() => settled.push('a'))
    void b.then(() => settled.push('b'))
    h.calls[0].resolve(ok('from-a'))
    h.calls[1].resolve(ok('from-b'))
    await flush()
    expect(settled).toEqual([]) // 最新の C がまだ
    h.calls[2].resolve(ok('from-c'))
    await Promise.all([a, b, c])
    expect(h.c.get().buckets).toEqual(['from-c'])
    expect(settled.sort()).toEqual(['a', 'b'])
  })

  it('★★★ 追い越した最新が失敗したときも、A の reload() は失敗が当たったあとに解決する', async () => {
    const h = harness()
    const a = h.c.reload()
    const b = h.c.reload()
    h.calls[0].resolve(ok('from-a'))
    await flush()
    h.calls[1].reject(new Error('通信できません'))
    await a
    expect(h.c.get().listFailed).toBe(true)
    expect(h.c.get().listError).toBe('通信できません')
    expect(h.c.get().buckets).toEqual([])
    await b
  })

  it('★★★ 用意の成功の枝の形（reload してから、記録に載せる）: 後から別の読み直しに追い越されても、載せる時点で一覧は最新', async () => {
    const h = harness({ recorded: '' })
    await reloadWith(h, ok()) // 【公開】を開いたとき: 保存場所は0個
    const seen: string[] = []
    // 用意の成功の枝: await reload() のあとで、記録に載せる（載せる時点の一覧を控える）
    const prepared = h.c.reload().then(() => { seen.push(h.c.get().buckets.join(',')) })
    const meta = h.c.reload() // その間に、破棄の知らせなどで別の読み直しが始まり、追い越す
    h.calls[1].resolve(ok('new-bucket')) // 用意の成功の枝の読み直しが先に返る（もう追い越されている）
    await flush()
    expect(seen).toEqual([]) // 最新が当たるまで、記録には載せない
    h.calls[2].resolve(ok('new-bucket'))
    await Promise.all([prepared, meta])
    expect(seen).toEqual(['new-bucket'])
  })
})

describe('controller: dispose（プロジェクトの切り替え・アンマウント）', () => {
  it('★★★ dispose のあとに返った結果は当てない・onChange も呼ばれない', async () => {
    const h = harness()
    const p = h.c.reload()
    const before = h.changes.length
    h.c.dispose()
    h.calls[0].resolve(ok('late'))
    await p
    expect(h.c.get().buckets).toEqual([])
    expect(h.c.get().chosen).toBe(NEW_BUCKET)
    expect(h.changes).toHaveLength(before)
  })

  it('★★★ dispose のあとに失敗が返っても、listFailed を立てない・onChange も呼ばれない', async () => {
    const h = harness()
    const p = h.c.reload()
    const before = h.changes.length
    h.c.dispose()
    h.calls[0].reject(new Error('通信できません'))
    await p
    expect(h.c.get().listFailed).toBe(false)
    expect(h.changes).toHaveLength(before)
  })

  it('★★ dispose のあとの reload・openConfirm・pick は、何も当てない・onChange も呼ばれない', async () => {
    const h = harness()
    h.c.dispose()
    await h.c.reload()
    await h.c.openConfirm()
    h.c.pick('x')
    expect(h.changes).toHaveLength(0)
    expect(h.c.get()).toEqual(emptyBucketList())
  })
})

describe('controller: 失敗（例外・ok でない・形違い）', () => {
  const failures: Array<[string, (h: ReturnType<typeof harness>) => Promise<void>]> = [
    ['例外', async h => { const p = h.c.reload(); h.calls[h.calls.length - 1].reject(new Error('通信できません')); await p }],
    ['{ ok: false }', h => reloadWith(h, { ok: false, message: 'キーが未登録です', siteReady: false, buckets: [] })],
    ['形違い（buckets が無い）', h => reloadWith(h, { ok: true })],
    ['形違い（buckets が配列でない）', h => reloadWith(h, { ok: true, buckets: 'koto-rc-s1019' })],
    ['形違い（名前の無い要素）', h => reloadWith(h, { ok: true, buckets: [{ id: 'x' }] })],
    ['形違い（応答が null）', h => reloadWith(h, null)],
  ]

  for (const [label, fail] of failures) {
    it(`★★★ ${label}: listFailed=true・loading=false・buckets と chosen は前のまま・canPrepare は false`, async () => {
      const h = harness()
      await reloadWith(h, ok('koto-rc-s1019')) // 前の成功
      h.c.pick('koto-rc-s1019')
      const before = h.c.get()
      await fail(h)
      const s = h.c.get()
      expect(s.listFailed).toBe(true)
      expect(s.loading).toBe(false)
      expect(s.buckets).toEqual(before.buckets)
      expect(s.chosen).toBe(before.chosen)
      expect(s.userPicked).toBe(before.userPicked)
      expect(canPrepare(s, false)).toBe(false)
    })
  }

  describe('応答の形の判定（振る舞いで固定）', () => {
    const shapeFailures: Array<[string, unknown]> = [
      ['ok の欠落（buckets は正しい形）', { buckets: [{ name: 'koto-rc-s1019' }] }],
      ['ok が true ではない値（"yes"）', { ok: 'yes', buckets: [{ name: 'koto-rc-s1019' }] }],
      ['ok が true ではない値（1）', { ok: 1, buckets: [{ name: 'koto-rc-s1019' }] }],
      ['空の名前', { ok: true, buckets: [{ name: '' }] }],
      ['名前が文字列でない（数値）', { ok: true, buckets: [{ name: 1 }] }],
      ['名前が文字列でない（null）', { ok: true, buckets: [{ name: null }] }],
      ['要素が null', { ok: true, buckets: [null] }],
      ['1つでも名前が空なら、全体を失敗にする（読めた分だけ拾わない）', { ok: true, buckets: [{ name: 'a-bucket' }, { name: '' }] }],
    ]
    for (const [label, reply] of shapeFailures) {
      it(`★★★ ${label} → 失敗（前の一覧と選びは変えない・押せない・理由は形が違う）`, async () => {
        const h = harness()
        await reloadWith(h, ok('keep-bucket'))
        await reloadWith(h, reply)
        expect(h.c.get().listFailed).toBe(true)
        expect(h.c.get().listError).toBe('保存場所の一覧の形が想定と違います。')
        expect(h.c.get().buckets).toEqual(['keep-bucket'])
        expect(h.c.get().chosen).toBe('keep-bucket')
        expect(canPrepare(h.c.get(), false)).toBe(false)
      })
    }

    it('★★ 一覧が空の { ok: true, buckets: [] } は成功（空だと確かめられた）', async () => {
      const h = harness()
      await reloadWith(h, { ok: true, buckets: [] })
      expect(h.c.get().listFailed).toBe(false)
      expect(h.c.get().loaded).toBe(true)
      expect(h.c.get().buckets).toEqual([])
    })
  })

  it('★★★ 最初の読み直しが失敗しても、chosen は NEW_BUCKET のまま「新しく作る」に進める形にはならない（押せない）', async () => {
    const h = harness() // 一覧が無い最初の状態（chosen は NEW_BUCKET）
    const p = h.c.reload()
    h.calls[0].reject(new Error('通信できません'))
    await p
    expect(h.c.get().chosen).toBe(NEW_BUCKET)
    expect(canPrepare(h.c.get(), false)).toBe(false)
  })

  it('★★★ 失敗のあとに成功すれば、listFailed=false・canPrepare が true になる', async () => {
    const h = harness()
    const p = h.c.reload()
    h.calls[0].reject(new Error('通信できません'))
    await p
    expect(canPrepare(h.c.get(), false)).toBe(false)
    await reloadWith(h, ok('koto-rc-s1019'))
    expect(h.c.get().listFailed).toBe(false)
    expect(canPrepare(h.c.get(), false)).toBe(true)
    expect(h.c.get().chosen).toBe('koto-rc-s1019')
  })

  it('★★ 読み直している間は、失敗が残っていても loading で押せない・当たったら下りる', async () => {
    const h = harness()
    const p1 = h.c.reload()
    h.calls[0].reject(new Error('x'))
    await p1
    const p2 = h.c.reload()
    expect(h.c.get().loading).toBe(true)
    expect(canPrepare(h.c.get(), false)).toBe(false)
    h.calls[1].resolve(ok('a'))
    await p2
    expect(h.c.get().loading).toBe(false)
    expect(canPrepare(h.c.get(), false)).toBe(true)
  })

  it('★★ status が同期的に例外を投げても、失敗として扱う（reload は例外を外へ出さない）', async () => {
    const changes: BucketListState[] = []
    const c = createBucketListController({
      status: () => { throw new Error('呼べません') },
      recorded: () => '',
      onChange: s => changes.push(s),
    })
    await expect(c.reload()).resolves.toBeUndefined()
    expect(c.get().listFailed).toBe(true)
    expect(c.get().loading).toBe(false)
  })
})

describe('controller: 利用者の選び', () => {
  it('★★★ pick(b) のあと reload（一覧 [a,b]・記録なし）→ b のまま（先頭 a に戻さない）', async () => {
    const h = harness()
    await reloadWith(h, ok('a', 'b'))
    expect(h.c.get().chosen).toBe('a') // 既定は先頭
    h.c.pick('b')
    expect(h.c.get().chosen).toBe('b')
    expect(h.c.get().userPicked).toBe(true)
    await reloadWith(h, ok('a', 'b'))
    expect(h.c.get().chosen).toBe('b')
    expect(h.c.get().userPicked).toBe(true)
  })

  it('★★★ pick(b) のあと、b が一覧から消えた → 既定へ（先頭）', async () => {
    const h = harness()
    await reloadWith(h, ok('a', 'b'))
    h.c.pick('b')
    await reloadWith(h, ok('a'))
    expect(h.c.get().chosen).toBe('a')
  })

  it('★★★ pick(b) のあと、一覧が空になった → 「新しく作る」。そのあと保存場所が増えたら、既定（その保存場所）へ追いつく', async () => {
    const h = harness()
    await reloadWith(h, ok('b'))
    h.c.pick('b')
    await reloadWith(h, ok()) // b が消えた
    expect(h.c.get().chosen).toBe(NEW_BUCKET)
    expect(h.c.get().userPicked).toBe(false) // 消えた選びは、もう利用者の選びではない
    await reloadWith(h, ok('c')) // 設定で c を作った
    expect(h.c.get().chosen).toBe('c') // 「新しく作る」に居座らない
  })

  it('★★★ pick(NEW_BUCKET) のあと reload（一覧 [a]）→ NEW_BUCKET のまま', async () => {
    const h = harness()
    await reloadWith(h, ok('a'))
    h.c.pick(NEW_BUCKET)
    await reloadWith(h, ok('a'))
    expect(h.c.get().chosen).toBe(NEW_BUCKET)
    expect(h.c.get().userPicked).toBe(true)
  })

  it('★★★ openConfirm で userPicked が false に戻り、既定（記録 → 先頭）から選び直す', async () => {
    const h = harness({ recorded: 'a' })
    await reloadWith(h, ok('a', 'b'))
    h.c.pick('b')
    const p = h.c.openConfirm()
    expect(h.c.get().userPicked).toBe(false)
    h.calls[h.calls.length - 1].resolve(ok('a', 'b'))
    await p
    expect(h.c.get().chosen).toBe('a') // 記録の保存場所
    expect(h.c.get().userPicked).toBe(false)
  })

  it('★★ openConfirm は読み直しを始める（loading が立つ）', async () => {
    const h = harness()
    const p = h.c.openConfirm()
    expect(h.calls).toHaveLength(1)
    expect(h.c.get().loading).toBe(true)
    h.calls[0].resolve(ok())
    await p
    expect(h.c.get().loading).toBe(false)
  })

  it('★★ 選んでいないあいだは、読み直しのたびに既定へ追いつく（記録が変われば記録へ）', async () => {
    const h = harness()
    await reloadWith(h, ok('a'))
    expect(h.c.get().chosen).toBe('a')
    h.rec.value = 'b'
    await reloadWith(h, ok('a', 'b'))
    expect(h.c.get().chosen).toBe('b')
  })

  it('★★★ 確認を開いて読み直している最中に pick(b) → 解決（[a,b]・記録は a）→ chosen は b のまま・userPicked は true', async () => {
    const h = harness({ recorded: 'a' }) // 既定なら a になる
    const p = h.c.openConfirm() // status は未解決
    h.c.pick('b') // 読み直し中に、利用者がラジオで選ぶ
    expect(h.c.get().loading).toBe(true)
    expect(h.c.get().chosen).toBe('b')
    h.calls[0].resolve(ok('a', 'b'))
    await p
    expect(h.c.get().chosen).toBe('b') // 既定（記録の a）で上書きしない
    expect(h.c.get().userPicked).toBe(true)
    expect(h.c.get().loading).toBe(false)
  })

  it('★★★ 前に選んだあとで確認を開き直し、読み直し中に別の保存場所を選ぶ → 新しい選びが残る', async () => {
    const h = harness({ recorded: 'a' })
    await reloadWith(h, ok('a', 'b', 'c'))
    h.c.pick('b')
    const p = h.c.openConfirm() // 開き直すと選びは手放す（userPicked=false）
    expect(h.c.get().userPicked).toBe(false)
    h.c.pick('c')
    h.calls[h.calls.length - 1].resolve(ok('a', 'b', 'c'))
    await p
    expect(h.c.get().chosen).toBe('c')
    expect(h.c.get().userPicked).toBe(true)
  })

  it('★★ 読み直しの失敗は、利用者の選びを変えない', async () => {
    const h = harness()
    await reloadWith(h, ok('a', 'b'))
    h.c.pick('b')
    const p = h.c.reload()
    h.calls[h.calls.length - 1].reject(new Error('x'))
    await p
    expect(h.c.get().chosen).toBe('b')
    expect(h.c.get().userPicked).toBe(true)
  })
})

describe('StorageNotice の配線（呼び出しの形ごと一意に当てる）', () => {
  const component = notice.slice(notice.indexOf('export default function StorageNotice'))
  // controller を作る effect（依存は projectDir だけ）と、scan・記録を読む mount effect（依存は projectDir と target）
  const controllerEffect = between(notice, 'useEffect(() => {\n    // プロジェクトが変わった: 前のプロジェクトで始めた記録の読みは、あとで返っても当てない（掟11）\n    projectDirRef.current = projectDir\n    discardPlacementReads()\n    const bucketListController = createBucketListController({', '}, [projectDir])')
  const mountEffect = between(notice, 'useEffect(() => {\n    let alive = true', '}, [projectDir, target])')
  const prepare = between(notice, 'const prepare = async () => {', '} finally { setBusy(false) }')
  const failedBranch = between(prepare, 'if (!r.ok || !r.placement) {', 'return\n      }')

  it('★★★ 一覧を取るのは、controller に渡す1か所だけ（storage.status を呼ぶのは StorageNotice でここだけ）', () => {
    expect(count(notice, 'storage.status(')).toBe(1)
    expect(count(notice, 'status: () => window.electronAPI.storage.status(),')).toBe(1)
    expect(count(notice, 'createBucketListController({')).toBe(1)
    const create = between(controllerEffect, 'createBucketListController({', '})')
    expect(create).toContain('status: () => window.electronAPI.storage.status(),')
    // 記録は、controller が結果を当てる時点で読む写しから
    expect(create).toContain('recorded: () => recordedBucketRef.current,')
    expect(create).toContain('onChange: setBucketList,')
  })

  it('★★★ 入口1: マウント（記録を載せたあとに、いまの controller で読み直す。読み直しの直後の行は alive の守り）', () => {
    expect(count(mountEffect, 'await bucketListRef.current?.reload()')).toBe(1)
    const remember = mountEffect.indexOf('if (place.ok) applyPlacementRead(read, place.placement)')
    const reload = mountEffect.indexOf('await bucketListRef.current?.reload()')
    expect(remember).toBeGreaterThan(-1)
    expect(reload).toBeGreaterThan(remember) // 記録を先に載せる（controller が読む記録が新しい）
    // 読み直しが終わったとき、もう使わない画面なら何もしない。**読み直しの呼び出しと、その直後の行の組**で一意に当てる
    // （あとの lookForLeftover の直後にも同じ `if (!alive) return` があるので、「reload より後ろに含まれる」では素通りする）
    expect(count(mountEffect, 'await bucketListRef.current?.reload()\n      if (!alive) return\n      if (!scan.ok) return\n')).toBe(1)
    // 同じ行は、このあと lookForLeftover の直後にもある（別の守り）
    expect(count(mountEffect, 'if (!alive) return\n')).toBe(3)
    // controller はこの effect で作らない・捨てない（作る effect は別。入口は ref から読む）
    expect(mountEffect).not.toContain('bucketListController')
  })

  it('★★★ 入口0: controller を作った直後に読み始める（scan・記録を待たない）。依存は projectDir だけで、公開先のタブでは作り直さない', () => {
    // 作る effect は1つ。その依存配列は [projectDir] だけ
    expect(count(notice, 'createBucketListController({')).toBe(1)
    expect(count(notice, '}, [projectDir])')).toBe(1)
    expect(count(notice, '}, [projectDir, target])')).toBe(1)
    expect(controllerEffect.endsWith('}, [projectDir])')).toBe(true)
    expect(controllerEffect).not.toContain('target')
    // 作った直後に、状態をそろえて読み始める。scan・記録・await を待たない
    expect(controllerEffect).toContain('bucketListRef.current = bucketListController')
    expect(controllerEffect).toContain('setBucketList(bucketListController.get())')
    expect(count(controllerEffect, 'void bucketListController.reload()')).toBe(1)
    expect(controllerEffect.indexOf('void bucketListController.reload()')).toBeGreaterThan(controllerEffect.indexOf('setBucketList(bucketListController.get())'))
    expect(controllerEffect).not.toContain('await')
    expect(controllerEffect).not.toContain('storage.scan(')
    expect(controllerEffect).not.toContain('storage.placement(')
    // 捨てるのは、この effect の後始末で（前のプロジェクトの読み直しを当てない）
    const cleanup = between(controllerEffect, 'return () => {', '\n    }')
    expect(cleanup).toContain('bucketListController.dispose()')
    expect(cleanup).toContain('if (bucketListRef.current === bucketListController) bucketListRef.current = null')
    // 作る effect は、mount effect より前（mount effect が ref から読むため）
    expect(notice.indexOf(controllerEffect)).toBeLessThan(notice.indexOf(mountEffect))
  })

  it('★★★ 公開先のタブの切り替え（target だけの変更）で、一覧を空に戻さない: mount effect に作成・初期化・dispose が無い', () => {
    expect(mountEffect).not.toContain('createBucketListController')
    expect(mountEffect).not.toContain('emptyBucketList')
    expect(mountEffect).not.toContain('setBucketList(')
    expect(mountEffect).not.toContain('.dispose()')
    // 空の初期値を使うのは、useState の初期値だけ（画面の最初の描画）
    expect(count(component, 'useState<BucketListState>(emptyBucketList)')).toBe(1)
    expect(count(component, 'emptyBucketList')).toBe(1)
    // mount effect の戻り口は、alive を下ろすだけ（プロジェクトが無いときは何も返さない）
    expect(mountEffect).toContain('if (!projectDir) { setNeed(null); return }')
    expect(mountEffect).toContain('return () => { alive = false }')
    expect(mountEffect).not.toContain('return cleanup')
  })

  it('★★★ 入口2: 確認を開くボタンは openConfirm（読み直さずに確認を開くだけの形へ戻っていない）', () => {
    expect(count(notice, "onClick={() => { setError(''); setConfirming(true); void bucketListRef.current?.openConfirm() }}")).toBe(1)
    expect(notice).not.toContain("onClick={() => { setError(''); setConfirming(true) }}")
    expect(count(notice, '.openConfirm()')).toBe(1)
  })

  it('★★★ 入口3: 用意の失敗の枝で reload（確認は開いたまま。成功の枝には置かない）', () => {
    expect(failedBranch).toContain('setError(lines.error)')
    expect(count(failedBranch, 'void bucketListRef.current?.reload()')).toBe(1)
    // 失敗の枝の中では、記録を載せない・確認を閉じない
    expect(failedBranch).not.toContain('rememberPlacement(')
    expect(failedBranch).not.toContain('setConfirming(false)')
  })

  it('★★★ 入口4: 用意の成功の枝で reload してから、記録に載せる（新しい保存場所が一覧に無いまま「見つかりません」が出ない）', () => {
    const afterFailed = prepare.slice(prepare.indexOf(failedBranch) + failedBranch.length)
    expect(count(afterFailed, 'await bucketListRef.current?.reload()')).toBe(1)
    const reload = afterFailed.indexOf('await bucketListRef.current?.reload()')
    const remember = afterFailed.indexOf('rememberPlacement(r.placement)')
    const closed = afterFailed.indexOf('setConfirming(false)')
    expect(remember).toBeGreaterThan(reload)
    expect(closed).toBeGreaterThan(reload)
    // prepare の中の reload は、失敗の枝と成功の枝の2つだけ
    expect(count(prepare, 'bucketListRef.current?.reload()')).toBe(2)
  })

  it('★★★ 入口5・6: 設定の知らせと、破棄の知らせ（聞く・外すが、同じ関数で、2つとも）', () => {
    const listener = between(notice, 'const onBucketsMayHaveChanged = () =>', '}, [])')
    // 設定の知らせは一覧だけ。破棄の知らせは、記録を読み直してから一覧（順序と、記録を読むことは tests/storageNoticePlacementRefresh.test.ts が振る舞いで固定）
    expect(listener).toContain('const onBucketsMayHaveChanged = () => { void bucketListRef.current?.reload() }')
    expect(listener).toContain('const onMetaChanged = () => {')
    expect(count(notice, "window.addEventListener('sakura:storage-buckets-changed', onBucketsMayHaveChanged)")).toBe(1)
    expect(count(notice, "window.removeEventListener('sakura:storage-buckets-changed', onBucketsMayHaveChanged)")).toBe(1)
    expect(count(notice, "window.addEventListener('sakura-meta-changed', onMetaChanged)")).toBe(1)
    expect(count(notice, "window.removeEventListener('sakura-meta-changed', onMetaChanged)")).toBe(1)
    // 破棄の知らせを、一覧だけを読み直す口（直す前の形）へ戻していない
    expect(notice).not.toContain("window.addEventListener('sakura-meta-changed', onBucketsMayHaveChanged)")
    // 2つの知らせは、この effect の中だけ（ほかの口で聞かない）
    expect(count(notice, 'window.addEventListener(')).toBe(2)
    expect(count(notice, 'window.removeEventListener(')).toBe(2)
    // 聞くのは1回だけ（依存なし）。作り直しのたびに増えない
    expect(listener.endsWith('}, [])')).toBe(true)
  })

  it('★★★ 一覧を確かめられなかった表示は、確認パネルの外（保存場所の欄）にある。確認が開いていなくても・記録があっても出る', () => {
    const failureAt = notice.indexOf('{bucketList.listFailed && (')
    const placementAt = notice.indexOf('{placement ? (')
    const offerAt = notice.indexOf('{(!placement || missing) && shouldOfferStorage(need) && (')
    const confirmingAt = notice.indexOf('confirming ? (')
    expect(count(notice, '{bucketList.listFailed && (')).toBe(1)
    expect(placementAt).toBeGreaterThan(-1)
    expect(offerAt).toBeGreaterThan(-1)
    expect(confirmingAt).toBeGreaterThan(offerAt)
    // 記録の欄のあと・「用意する」の条件 (!placement || missing) の前。確認パネル（confirming）の中ではない
    expect(failureAt).toBeGreaterThan(placementAt)
    expect(failureAt).toBeLessThan(offerAt)
    expect(failureAt).toBeLessThan(confirmingAt)
    // 確認パネルのほうには、一覧の失敗を重ねて出さない（同じ事実は1回）
    expect(notice.slice(confirmingAt)).not.toContain('bucketList.listFailed')
    expect(notice.slice(confirmingAt)).not.toContain('bucketList.listError')
    expect(notice.slice(confirmingAt)).not.toContain('もう一度確かめる')
    // 失敗の表示を、記録があるときの条件 (!placement || missing) の中に置いていない
    expect(notice).not.toContain('(!placement || missing) && bucketList.listFailed')
  })

  it('★★★ 失敗の表示: 見出しの文・理由（listError・選択可能）・「もう一度確かめる」（reload・読み直し中は押せない）', () => {
    const failure = between(notice, '{bucketList.listFailed && (', 'もう一度確かめる</button>')
    expect(failure).toContain('⚠️ 保存場所の一覧を確かめられませんでした。')
    // 理由は捨てない（APIキー未登録なら、それが直し方になる）。選んでコピーできる
    expect(failure).toContain('{bucketList.listError && (')
    expect(failure).toContain('select-text">{bucketList.listError}</p>')
    expect(failure).toContain('onClick={() => { void bucketListRef.current?.reload() }}')
    expect(failure).toContain('disabled={bucketList.loading}')
    // 画面の文を足したのは、listError の表示と「確かめています…」だけ（掟5）。同じ文を2回出さない
    expect(count(notice, '保存場所の一覧を確かめられませんでした。')).toBe(1)
    expect(count(notice, 'もう一度確かめる')).toBe(1)
    expect(count(notice, 'bucketList.listError')).toBe(2) // 出すかの条件と、出す文
    expect(count(notice, '保存場所を確かめています…')).toBe(1)
  })

  it('★★★ 選ぶ口はラジオだけ（pick）。選びを直接書く口が無い', () => {
    expect(count(notice, 'onChange={() => bucketListRef.current?.pick(b)}')).toBe(1)
    expect(count(notice, 'onChange={() => bucketListRef.current?.pick(NEW_BUCKET)}')).toBe(1)
    expect(count(notice, '.pick(')).toBe(2)
    expect(count(notice, 'checked={bucketList.chosen === b}')).toBe(1)
    expect(count(notice, 'checked={bucketList.chosen === NEW_BUCKET}')).toBe(1)
    expect(notice).not.toContain('setChosen(')
    expect(notice).not.toContain('setBuckets(')
    // 状態を書くのは controller の onChange と、作り直したときの初期化だけ
    expect(count(notice, 'setBucketList(')).toBe(1)
    expect(count(notice, 'onChange: setBucketList,')).toBe(1)
  })

  it('★★★ 押せるかの判定は canPrepare だけ（disabled と、押した時点の確かめ）', () => {
    // 「用意する（費用に同意）」のボタンだけを切り出す（隣の「やめる」の disabled に当たらない）
    const button = between(component, 'onClick={prepare}', '用意する（費用に同意）\'}</button>')
    expect(button).toContain('disabled={!canPrepare(bucketList, busy)}')
    expect(button).toContain("{busy ? '用意しています…' : bucketList.loading ? '保存場所を確かめています…' : '用意する（費用に同意）'}")
    // 直す前の形（読み直し中・一覧の失敗を見ない）へ戻っていない
    expect(component).not.toContain('disabled={busy || reloading}')
    expect(component).not.toContain('onClick={prepare}\n                disabled={busy}\n')
    // 押した時点の確かめ（描画の写しが1拍遅れても、費用の増える側へ進まない）は、お金を使う呼び出しより前
    expect(count(notice, 'canPrepare(')).toBe(2)
    const guard = prepare.indexOf('if (!canPrepare(list, busy)) return')
    const spend = prepare.indexOf('window.electronAPI.storage.prepare(')
    expect(guard).toBeGreaterThan(-1)
    expect(spend).toBeGreaterThan(guard)
    // 選びも、押した時点の controller から読む
    expect(prepare).toContain('const list = bucketListController.get()')
    expect(count(notice, '...(list.chosen !== NEW_BUCKET ? { bucket: list.chosen } : {})')).toBe(1)
  })

  it('★★★ 「見つかりません」を立てる判定は placementMissing 1つ（画面に複製を持たない。規則は tests/storageNoticePlacementRefresh.test.ts が振る舞いで固定）', () => {
    expect(count(notice, 'const missing = placementMissing(placement?.bucket, bucketList)')).toBe(1)
    expect(count(notice, 'placementMissing(')).toBe(1)
    // 直す前の形（一覧が0件のとき言わない）・判定の複製へ戻っていない
    expect(notice).not.toContain('bucketList.buckets.includes(')
    expect(notice).not.toContain('placement.bucket)')
    expect(notice).not.toContain('!bucketList.listFailed')
  })

  it('★★★ 記録の保存場所を変える口は1つ（画面の state と、controller が読む写しが食い違わない）', () => {
    expect(count(notice, 'setPlacement(')).toBe(1)
    const helper = between(notice, 'const rememberPlacement = (p: Placement | null) => {', '\n  }')
    expect(helper).toContain("recordedBucketRef.current = p?.bucket ?? ''")
    expect(helper).toContain('setPlacement(p)')
    // 呼ぶのは、読みの結果を当てる applyPlacementRead（マウントで読んだ記録と、破棄が済んだあとの読み直しの2つがここを通る）と、用意の成功の2か所だけ
    expect(count(notice, 'rememberPlacement(')).toBe(2)
    expect(count(notice, 'recordedBucketRef.current =')).toBe(1)
  })

  it('★★ 前の直し（711f363）の、読み直しの状態と規則を画面に持っていない', () => {
    expect(notice).not.toContain('reloadBuckets')
    expect(notice).not.toContain('reloadSeq')
    expect(notice).not.toContain('placementRef')
    expect(notice).not.toContain('reloadBucketChoice')
    expect(notice).not.toContain('setReloading')
    expect(notice).not.toContain('useCallback')
    expect(choiceSource).not.toContain('reloadBucketChoice')
    // 既定の決め方の複製を持たない（storageChoice.ts の defaultBucketChoice 1つ）
    expect(notice).not.toContain('names.includes(current)')
    expect(notice).not.toContain('?? NEW_BUCKET')
    expect(notice).not.toContain("const NEW_BUCKET = '")
  })
})

describe('知らせの名前（出す側と聞く側）', () => {
  it('★★★ StorageSettings: 保存場所を作れたときだけ、失敗で戻ったあとに1回、知らせを出す', () => {
    const create = between(settings, 'const create = async () => {', '} finally { setCreating(false) }')
    const notify = "window.dispatchEvent(new CustomEvent('sakura:storage-buckets-changed'))"
    expect(count(create, notify)).toBe(1)
    expect(count(settings, notify)).toBe(1)
    const failedAt = create.indexOf("if (!r.ok) { setError(r.message ?? '作れませんでした'); return }")
    const notifyAt = create.indexOf(notify)
    const loadAt = create.indexOf('await load()')
    expect(failedAt).toBeGreaterThan(-1)
    expect(notifyAt).toBeGreaterThan(failedAt)
    expect(loadAt).toBeGreaterThan(notifyAt)
  })

  it('★★ 設定の知らせ: 出す側と聞く側で、名前が同じ', () => {
    const sent = /new CustomEvent\('([^']+buckets-changed)'\)/.exec(settings)?.[1]
    const heard = /addEventListener\('([^']+buckets-changed)'/.exec(notice)?.[1]
    expect(sent).toBe('sakura:storage-buckets-changed')
    expect(heard).toBe(sent)
  })

  it('★★★ 破棄の知らせ: 破棄の完了（notifyTeardownFinished）が出す名前を、【公開】が聞いている', () => {
    const finished = between(teardownFlow, 'export function notifyTeardownFinished(): void {', '\n}')
    const sent = /new Event\('([^']+)'\)/.exec(finished)?.[1]
    expect(sent).toBe('sakura-meta-changed')
    expect(count(notice, `window.addEventListener('${sent}', onMetaChanged)`)).toBe(1)
  })
})
