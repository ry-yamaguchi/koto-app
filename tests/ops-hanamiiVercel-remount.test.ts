import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── なぜこのテストが要るか（2026-09-29・作者の決定 ②）────────────────────────────
// 公開・破棄の本体は main の1回の IPC で最後まで進み、記録も main が書く。だから**公開のダイアログを閉じても
// 処理は止まらない**。失われていたのは**画面の表示だけ**——進み具合・結果・警告（「まだ動いていない」
// 「もう一度『公開する』を押す」など）は窓が持つ React の状態にしか無く、閉じて開き直すと消えた。
// そこで画面は main の処理の記録（window.electronAPI.projectOps）を読んで、**開き直したら続きと結果を出す**。
//
// ここで固定するのは、HANAMII と Vercel の2枚の画面に**共通する**振る舞い:
//   ・走っていれば、開き直した画面に進み具合が続きから出る（押せない・別の操作は押せない）
//   ・終わっていれば、結果と警告が出る。**出したら「見た」と伝える**ので、次に開いたときは出ない
//   ・前の結果を次の結果で上書きして見逃さない／見せていないものを見たことにしない
//   ・別のプロジェクト・別の公開先の知らせを、この画面に出さない（掟11）。**別の公開先の警告を消さない**
//   ・古い応答が、新しい知らせを戻さない
//
// **ソースの文字列は読まない**（掟10）。画面の関数を実際に動かし（偽の react・ tests/ops-hanamiiVercel-harness.ts）、
// **本物の main の記録**（src/main/projectOps.ts・projectLock.ts）の上に偽の electronAPI を置いて、
// 画面に出た文字を読む。「コンポーネントを外して付け直す」で開き直しを再現する。
// 固有の部分は tests/ops-hanamiiVercel-hanamii.test.ts・ops-hanamiiVercel-vercel.test.ts。

vi.mock('react', async () => (await import('./ops-hanamiiVercel-harness')).reactModule)
vi.mock('react/jsx-runtime', async () => (await import('./ops-hanamiiVercel-harness')).jsxRuntimeModule)
vi.mock('react/jsx-dev-runtime', async () => (await import('./ops-hanamiiVercel-harness')).jsxDevRuntimeModule)
vi.mock('../src/renderer/components/SecurityCheckSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/UnusedFilesSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AccessKeySection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/CredentialsModal', () => ({
  getHanamiiToken: async () => 'test-only-placeholder-token',
  getHanamiiTokenById: async () => 'test-only-placeholder-token',
  listHanamiiTokenEntries: async () => ({ tokens: [{ id: 't1', label: 'テスト用' }], activeId: 't1' }),
  getVercelToken: async () => 'test-only-placeholder-token',
  getVercelTokenById: async () => 'test-only-placeholder-token',
  getVercelTeamId: async () => null,
  getVercelTeamIdById: async () => null,
  listVercelTokenEntries: async () => ({ tokens: [{ id: 't1', label: 'テスト用' }], activeId: 't1' }),
}))

import HanamiiPanel from '../src/renderer/components/HanamiiPanel'
import VercelPanel from '../src/renderer/components/VercelPanel'
import {
  makeWorld, installWindow, resetMain, mount, settle, deferred, getOps, reportProgress,
  type World, type Mounted,
} from './ops-hanamiiVercel-harness'

// 動かす場所が画面ではないので、拾われなかった Promise は無視する
const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

const DIR = '/tmp/koto-ops-test/projA'
const OTHER_DIR = '/tmp/koto-ops-test/projB'

type Spec = {
  name: string
  Panel: (p: any) => unknown
  target: 'hanamii' | 'vercel'
  /** 別の公開先（この画面にとっての「他所」）。 */
  foreignTarget: string
  handler: string
  /** 走り始めに main が記録する進み具合の文。 */
  firstLabel: string
  /** 画面が頼むのではなく、main の本体を直接走らせる（＝「前に開いていた画面が頼んだ操作」）。 */
  start: (w: World, dir?: string) => Promise<any>
  setOk: (w: World) => void
  /** 結果として画面に出る、うまくいった印の文。 */
  okText: string
  /** 見逃してはいけない知らせを1件つけて終わる。 */
  setWarn: (w: World, text: string) => void
  /** 知らせの頭に付く印（HANAMII は警告の枠・Vercel は成功のお知らせの枠）。 */
  warnMark: string
  setFail: (w: World, text: string) => void
}

const SPECS: Spec[] = [
  {
    name: 'HanamiiPanel', Panel: HanamiiPanel as any, target: 'hanamii', foreignTarget: 'vercel', handler: 'hanamii:publish',
    firstLabel: '📦 公開するファイルをまとめています…',
    start: (w, dir = DIR) => w.api.hanamii.publish(dir, { token: 'test-only-placeholder-token', workspaceId: 'ws1', name: 'app' }),
    setOk: w => { w.publishReply = { ok: true, projectId: 'prj_test1', deploymentId: 'dpl_test1', deployState: 'ready', readyState: 'READY', url: 'https://app-test.example.test' } },
    okText: '公開できました。新しい版が動いたことを確かめました。',
    warnMark: '⚠️ ',
    setWarn: (w, text) => { w.publishReply = { ok: true, projectId: 'prj_test1', deploymentId: 'dpl_test1', deployState: 'pending', readyState: 'BUILDING', warnings: [text] } },
    setFail: (w, text) => { w.publishReply = { ok: false, message: text } },
  },
  {
    name: 'VercelPanel', Panel: VercelPanel as any, target: 'vercel', foreignTarget: 'hanamii', handler: 'vercel:publish',
    firstLabel: 'ファイルを収集しています…',
    start: (w, dir = DIR) => w.api.vercel.publish(dir, { token: 'test-only-placeholder-token', name: 'app' }),
    setOk: w => { w.vercelReply = { ok: true, deploymentId: 'dpl_v1', url: 'https://app-test.vercel.test', readyState: 'READY' } },
    okText: '✅ 公開済み',
    warnMark: 'ℹ️ ',
    setWarn: (w, text) => { w.vercelReply = { ok: true, deploymentId: 'dpl_v1', url: 'https://app-test.vercel.test', readyState: 'READY', notice: text } },
    setFail: (w, text) => { w.vercelReply = { ok: false, message: text } },
  },
]

let world: World
let live: Mounted[] = []
beforeEach(() => {
  resetMain()
  world = makeWorld(DIR)
  installWindow(world)
  live = []
})
afterEach(() => {
  for (const m of live) m.unmount()
  live = []
  resetMain()
})

/** 自分の公開先の操作が走っているときの枠の見出し（別の操作の1行にも「が進んでいます」が入るので、見出しまで見る）。 */
const OWN_CARD = '⏳ 公開が進んでいます'
const WARN_ONE = '見逃してはいけない知らせ・その1です。'
const WARN_TWO = '見逃してはいけない知らせ・その2です。'

describe.each(SPECS)('$name: 閉じて開き直したとき（外して付け直す）', (spec) => {
  const open = (dir = DIR): Mounted => {
    const m = mount(spec.Panel, { apiKey: 'k', projectDir: dir, onOpenCredentials: () => {} })
    live.push(m)
    return m
  }

  // ── 走っていれば、進み具合が出る ─────────────────────────────────────────
  describe('走っていれば、進み具合が続きから出る', () => {
    it('★★★ 開いた画面に、いまの段が出る。公開は押せない（閉じても処理は進む旨も添える）', async () => {
      world.opGate = deferred()
      const done = spec.start(world)
      await settle()

      const screen = open()
      await settle()

      expect(screen.has(OWN_CARD), '走っているのに、進み具合が出ていない').toBe(true)
      expect(screen.has(spec.firstLabel), 'いまの段（main の記録の label）が出ていない').toBe(true)
      expect(screen.has('この画面を閉じても、処理は最後まで進みます')).toBe(true)
      const publishBtn = screen.button('公開中…')
      expect(publishBtn, '走っている間の公開ボタンの表示が無い').toBeDefined()
      expect(publishBtn!.disabled, '走っているのに、もう一度押せてしまう').toBe(true)

      world.opGate.resolve()
      await done
    })

    it('★★ 開いている間の進み具合の更新（onChanged）が出る。閉じて付け直しても、そのときの段から出る', async () => {
      world.opGate = deferred()
      const done = spec.start(world)
      await settle()
      const screen = open()
      await settle()

      reportProgress(DIR, '⏳ 起動を待っています…', { detail: '状態: BUILDING（12秒経過）' })
      await settle()
      expect(screen.has('⏳ 起動を待っています…')).toBe(true)
      expect(screen.has('状態: BUILDING（12秒経過）')).toBe(true)
      expect(screen.has(spec.firstLabel), '古い段が残っている').toBe(false)

      screen.unmount()
      const again = open()
      await settle()
      expect(again.has('⏳ 起動を待っています…'), '付け直したら、いまの段から出ていない').toBe(true)
      expect(again.has('状態: BUILDING（12秒経過）')).toBe(true)

      world.opGate.resolve()
      await done
    })

    it('★★ 「N個中のM個目」が分かるとき、進みの棒が出る', async () => {
      world.opGate = deferred()
      const done = spec.start(world)
      await settle()
      reportProgress(DIR, 'アップロード中… (3/10)', { step: 3, total: 10 })
      const screen = open()
      await settle()
      expect(screen.has('アップロード中… (3/10)')).toBe(true)
      world.opGate.resolve()
      await done
    })

    it('★ 終わったら、進み具合は消えて公開が押せるようになる', async () => {
      world.opGate = deferred()
      const done = spec.start(world)
      await settle()
      const screen = open()
      await settle()
      expect(screen.has(OWN_CARD)).toBe(true)

      spec.setOk(world)
      world.opGate.resolve()
      await done
      await settle()
      expect(screen.has(OWN_CARD), '終わったのに進み具合が残っている').toBe(false)
      expect(screen.button('公開中…'), '終わったのに「公開中…」のまま').toBeUndefined()
    })
  })

  // ── 終わっていれば、結果と警告が出る／ack のあとは出ない ─────────────────────
  describe('終わっていれば、結果と警告が出る。見せたら見たことにし、次は出ない', () => {
    it('★★★ 閉じている間に終わった公開の結果と警告が、開き直した画面に出る', async () => {
      spec.setWarn(world, WARN_ONE)
      await spec.start(world)
      expect(getOps(DIR).last, '前提: 記録が残っている').not.toBeNull()

      const screen = open()
      await settle()

      expect(screen.has(WARN_ONE), '警告が出ていない（見逃す）').toBe(true)
      expect(screen.has(spec.warnMark + WARN_ONE), '知らせに印が付いていない').toBe(true)
    })

    it('★★★ 見せた結果は「見た」と伝える（ack の第2引数に、見せた記録の startedAt）。main の記録から消える', async () => {
      spec.setOk(world)
      await spec.start(world)
      const startedAt = getOps(DIR).last!.startedAt

      const screen = open()
      await settle()
      expect(screen.has(spec.okText)).toBe(true)

      expect(world.calls.ack, '見せたのに ack していない').toEqual([[DIR, startedAt]])
      expect(getOps(DIR).last, 'ack したのに main の記録が残っている').toBeNull()
    })

    it('★★★ ack のあとに開き直すと、同じ結果は出ない（警告なしの結果）', async () => {
      spec.setOk(world)
      await spec.start(world)

      const first = open()
      await settle()
      expect(first.has(spec.okText)).toBe(true)
      first.unmount()

      const second = open()
      await settle()
      expect(second.has(spec.okText), '見せたのに、開き直すたびに同じ結果が出る').toBe(false)
    })

    // ── 警告つきの結果は、パネルは「見た」と伝えない（2026-09-30 検分）──────────────────────────
    // 結果は公開ボタンのずっと下（①〜④の下）に出るので、利用者がスクロールせずに閉じると、見せたことにならないのに
    // 「見た」と伝えて、月額が続く警告・まだ動いていない警告が、閉じて開き直すと二度と出なくなった。
    // 警告つきの記録は、上部の「結果を確認しました」（PublishModal・tests/ops-modal-behavior.test.ts）を押したときにだけ見たことになる。
    it('★★★ 警告つきの結果は、画面に出しても「見た」と伝えない。main の記録に残り、開き直すたびに出る（上部の確認まで）', async () => {
      spec.setWarn(world, WARN_ONE)
      await spec.start(world)
      const startedAt = getOps(DIR).last!.startedAt

      const first = open()
      await settle()
      expect(first.has(WARN_ONE), '前提: 警告が出ている').toBe(true)
      expect(world.calls.ack, '警告つきの結果を、画面が出しただけで「見た」と伝えた（スクロールせずに閉じると、二度と出ない）').toEqual([])
      expect(getOps(DIR).last?.startedAt, '警告つきの記録が main から消えた').toBe(startedAt)
      first.unmount()

      const second = open()
      await settle()
      expect(second.has(WARN_ONE), '確認しないまま閉じて開き直したら、警告が消えている').toBe(true)
      expect(world.calls.ack).toEqual([])
    })

    it('★★★ 警告つきの結果は、上部の「確認しました」（main への ack）で初めて見たことになる。そのあとは出ない', async () => {
      spec.setWarn(world, WARN_ONE)
      await spec.start(world)
      const startedAt = getOps(DIR).last!.startedAt

      const first = open()
      await settle()
      expect(first.has(WARN_ONE)).toBe(true)
      first.unmount()
      // 上部の「結果を確認しました」が伝える ack（PublishModal の acknowledgeResults と同じ形）
      await world.api.projectOps.ack(DIR, startedAt)

      const second = open()
      await settle()
      expect(second.has(WARN_ONE), '確認したのに、また出る').toBe(false)
    })

    it('★★ 開いている間に終わった結果（警告なし）も、その場で出して見たことにする（開き直しで再び出ない）', async () => {
      const screen = open()
      await settle()
      world.opGate = deferred()
      const done = spec.start(world)
      await settle()
      expect(screen.has(OWN_CARD)).toBe(true)

      spec.setOk(world)
      world.opGate.resolve()
      await done
      await settle()
      expect(screen.has(spec.okText)).toBe(true)
      expect(getOps(DIR).last, '出したのに ack していない').toBeNull()

      screen.unmount()
      const again = open()
      await settle()
      expect(again.has(spec.okText)).toBe(false)
    })

    it('★★ 開いている間に終わった警告つきの結果は、その場で出すが、「見た」とは伝えない', async () => {
      const screen = open()
      await settle()
      world.opGate = deferred()
      const done = spec.start(world)
      await settle()

      spec.setWarn(world, WARN_ONE)
      world.opGate.resolve()
      await done
      await settle()
      expect(screen.has(WARN_ONE)).toBe(true)
      expect(getOps(DIR).last, '警告つきの結果を、画面が出しただけで見たことにした').not.toBeNull()
      expect(world.calls.ack).toEqual([])
    })

    it('★★★ 前の結果を見ないうちに次の操作が終わっても、前の警告を上書きして見逃さない（earlier）。警告つきの2件は、どちらも main に残る', async () => {
      spec.setWarn(world, WARN_ONE)
      await spec.start(world)
      spec.setWarn(world, WARN_TWO)
      await spec.start(world)
      const snap = getOps(DIR)
      expect(snap.earlier.length + (snap.last ? 1 : 0), '前提: 見られていない記録が2件').toBe(2)

      const screen = open()
      await settle()
      expect(screen.has(WARN_ONE), '前の警告が消えている').toBe(true)
      expect(screen.has(WARN_TWO)).toBe(true)
      // 古い順に並ぶ
      expect(screen.text().indexOf(WARN_ONE)).toBeLessThan(screen.text().indexOf(WARN_TWO))
      // 警告つきなので、画面は見たことにしない（上部の「確認しました」まで残す）
      expect(getOps(DIR).earlier).toHaveLength(1)
      expect(getOps(DIR).last).not.toBeNull()
      expect(world.calls.ack).toEqual([])
    })

    it('★★ 警告の無い2件の失敗は、どちらも出して、新しいほうの startedAt まで見たことにする', async () => {
      spec.setFail(world, '失敗の理由: その1です')
      await spec.start(world)
      spec.setFail(world, '失敗の理由: その2です')
      await spec.start(world)

      const screen = open()
      await settle()
      expect(screen.has('失敗の理由: その1です')).toBe(true)
      expect(screen.has('失敗の理由: その2です')).toBe(true)
      expect(getOps(DIR).earlier).toEqual([])
      expect(getOps(DIR).last).toBeNull()
    })

    it('★★ 失敗の結果は失敗として出る（成功の見出しを出さない）。AI に相談する導線も付く', async () => {
      spec.setFail(world, '失敗の理由: テスト用のエラーです')
      await spec.start(world)

      const screen = open()
      await settle()
      expect(screen.count('失敗の理由: テスト用のエラーです'), '失敗の理由が出ていない／二重に出ている').toBe(1)
      expect(screen.has(spec.okText)).toBe(false)
      expect(screen.has('AIに相談する')).toBe(true)
    })

    it('★ 何も無ければ、何も出ない（進み具合も結果も）', async () => {
      const screen = open()
      await settle()
      expect(screen.has(OWN_CARD)).toBe(false)
      expect(screen.has('の結果')).toBe(false)
      expect(world.calls.ack).toEqual([])
    })
  })

  // ── 頼んだ画面が開いたままのとき（直接の返り値と記録が両方届く）──────────────────
  describe('この画面が頼んだ公開（開いたまま）', () => {
    it('★★ 押すと進み具合が出て、終わると結果が1回だけ出る（返り値と記録で二重に出ない）', async () => {
      spec.setOk(world)
      const screen = open()
      await settle()
      world.opGate = deferred()
      const btn = screen.button('🚀 公開する')
      expect(btn, '公開ボタンが見つからない').toBeDefined()
      expect(btn!.disabled).toBe(false)
      btn!.click()
      await settle()
      expect(screen.has(OWN_CARD)).toBe(true)

      world.opGate.resolve()
      await settle()
      expect(screen.count(spec.okText), '結果が二重に出ている／出ていない').toBe(1)
      expect(screen.has(OWN_CARD)).toBe(false)
    })

    it('★★ 次の公開を始めたら、前の結果は片づく（古い警告が、走っている間ずっと残らない）', async () => {
      spec.setWarn(world, WARN_ONE)
      const screen = open()
      await settle()
      screen.button('🚀 公開する')!.click()
      await settle()
      expect(screen.has(WARN_ONE), '前提: 1回目の結果が出ている').toBe(true)

      world.opGate = deferred()
      screen.button('公開する')!.click()
      await settle()
      expect(screen.has(OWN_CARD), '前提: 2回目が走っている').toBe(true)
      expect(screen.has(WARN_ONE), '前の結果が、次の公開の間も残っている').toBe(false)

      spec.setWarn(world, WARN_TWO)
      world.opGate.resolve()
      await settle()
      expect(screen.has(WARN_TWO)).toBe(true)
      expect(screen.has(WARN_ONE)).toBe(false)
    })

    it('★★ 失敗の理由は1回だけ出る（返り値の文と記録の文が重ならない）', async () => {
      spec.setFail(world, '失敗の理由: 二重に出さない')
      const screen = open()
      await settle()
      screen.button('🚀 公開する')!.click()
      await settle()
      expect(screen.count('失敗の理由: 二重に出さない')).toBe(1)
    })

    it('★★ 記録が作られない断り方（同じプロジェクトで別の操作が走っている）は、返り値の文を出す', async () => {
      const screen = open()
      await settle()
      // 画面が知らないうちに main が走り始めた（押し出しを止めて作る）
      world.mutePush = true
      world.opGate = deferred()
      const busy = world.guard(DIR, '削除', { target: 'sakura-apprun', handler: 'cloud:teardown' }, '別の操作の進み具合', async () => ({ ok: true }))
      await settle()
      expect(screen.button('🚀 公開する')!.disabled, '前提: 画面はまだ知らない').toBe(false)

      screen.button('🚀 公開する')!.click()
      await settle()
      expect(screen.count('いま別の操作（削除）を実行中です'), '断られた理由が出ていない／二重に出ている').toBe(1)

      world.opGate.resolve()
      await busy
    })
  })

  // ── 別のプロジェクト（掟11）─────────────────────────────────────────────
  describe('別のプロジェクトの知らせは、この画面に出さない・触らない（掟11）', () => {
    it('★★★ 別のプロジェクトの進み具合・結果は出ない。ack もしない', async () => {
      const screen = open()
      await settle()

      spec.setWarn(world, WARN_ONE)
      world.opGate = deferred()
      const done = spec.start(world, OTHER_DIR)
      await settle()
      expect(screen.has(OWN_CARD), '別のプロジェクトの進み具合が出ている').toBe(false)
      expect(screen.has(spec.firstLabel)).toBe(false)

      world.opGate.resolve()
      await done
      await settle()
      expect(screen.has(WARN_ONE), '別のプロジェクトの警告が出ている').toBe(false)
      expect(world.calls.ack.filter(([p]) => p === OTHER_DIR), '別のプロジェクトの結果を見たことにしている').toEqual([])
      expect(getOps(OTHER_DIR).last, '別のプロジェクトの記録が消えている').not.toBeNull()
    })

    it('★★★ 開いたままプロジェクトが切り替わったら、前のプロジェクトの結果・進み具合を持ち越さない', async () => {
      spec.setWarn(world, WARN_ONE)
      await spec.start(world)
      const screen = open()
      await settle()
      expect(screen.has(WARN_ONE), '前提: 前のプロジェクトの結果が出ている').toBe(true)

      screen.rerender({ apiKey: 'k', projectDir: OTHER_DIR, onOpenCredentials: () => {} })
      await settle()
      expect(screen.has(WARN_ONE), '別のプロジェクトの画面に、前のプロジェクトの結果が残っている').toBe(false)
      expect(screen.has(OWN_CARD)).toBe(false)

      // 切り替わったあとは、新しいプロジェクトの記録を出す
      world.opGate = deferred()
      const done = spec.start(world, OTHER_DIR)
      await settle()
      expect(screen.has(OWN_CARD), '切り替えたあとのプロジェクトの進み具合が出ていない').toBe(true)
      world.opGate.resolve()
      await done
    })

    it('★★ 開いた画面の projectDir が / で終わっていても、main が正規化した知らせを受ける', async () => {
      world.opGate = deferred()
      const done = spec.start(world)          // main は末尾の / なしで記録する
      await settle()
      const screen = open(DIR + '/')
      await settle()
      reportProgress(DIR, '⏳ 末尾スラッシュのテスト', {})
      await settle()
      expect(screen.has('⏳ 末尾スラッシュのテスト'), '末尾の / で比べそこなって、知らせを取りこぼしている').toBe(true)
      world.opGate.resolve()
      await done
    })
  })

  // ── 別の公開先（同じプロジェクトの鍵は公開先をまたぐ）──────────────────────────
  describe('同じプロジェクトの別の公開先の操作は、詳細を出さず1行で知らせる', () => {
    it('★★★ 別の公開先が走っている間: 進み具合の詳細は出さず、1行だけ。公開は押せない', async () => {
      world.opGate = deferred()
      const busy = world.guard(DIR, '公開', { target: spec.foreignTarget, handler: 'foreign:publish' }, '別の公開先のひみつの進み具合', async () => ({ ok: true }))
      await settle()

      const screen = open()
      await settle()
      expect(screen.has('このプロジェクトでは別の操作（公開・')).toBe(true)
      expect(screen.has('別の公開先のひみつの進み具合'), '別の公開先の進み具合の詳細まで出している').toBe(false)
      expect(screen.has(OWN_CARD), '自分の進み具合の枠を出している').toBe(false)
      const btn = screen.button('🚀 公開する')
      expect(btn, '公開ボタンが見つからない').toBeDefined()
      expect(btn!.disabled, '別の操作が走っているのに押せる（main が断る）').toBe(true)

      world.opGate.resolve()
      await busy
    })

    it('★★★ 別の公開先の終わった結果（警告つき）は、この画面に出さず、見たことにもしない（その公開先の画面が出す）', async () => {
      await world.guard(DIR, '公開', { target: spec.foreignTarget, handler: 'foreign:publish' }, '別の公開先', async () => ({
        ok: true, warnings: ['別の公開先の警告: 月額が続きます'],
      }))
      const before = getOps(DIR)
      expect(before.last?.result?.warnings).toEqual(['別の公開先の警告: 月額が続きます'])

      const screen = open()
      await settle()
      expect(screen.has('別の公開先の警告'), '別の公開先の警告を出している').toBe(false)
      expect(world.calls.ack, '別の公開先の結果を見たことにしている').toEqual([])
      expect(getOps(DIR).last, '別の公開先の警告が main から消えている（その画面が見られなくなる）').not.toBeNull()
    })

    it('★★★ 別の公開先の見られていない結果より「新しい」自分の結果は、見たことにしない（別の公開先の警告を巻き添えで消さない）', async () => {
      // 古い: 別の公開先（警告つき・まだ誰も見ていない）／新しい: 自分の公開先（警告なし。警告つきは、そもそも画面は見たことにしない）
      await world.guard(DIR, '公開', { target: spec.foreignTarget, handler: 'foreign:publish' }, '別の公開先', async () => ({
        ok: true, warnings: ['別の公開先の警告: 月額が続きます'],
      }))
      spec.setOk(world)
      await spec.start(world)

      const screen = open()
      await settle()
      expect(screen.has(spec.okText)).toBe(true)
      expect(screen.has('別の公開先の警告')).toBe(false)
      // ack は「その記録まで全部」を見たことにする。自分の結果は別の公開先の警告より新しいので、伝えない。
      const snap = getOps(DIR)
      const unseen = [...snap.earlier, ...(snap.last ? [snap.last] : [])]
      expect(unseen.map(r => r.handler), '別の公開先の警告が、巻き添えで見たことにされた').toContain('foreign:publish')
    })

    it('★★ 別の公開先の結果より「古い」自分の結果（警告なし）は、見たことにする（別の公開先の分は残す）', async () => {
      spec.setOk(world)
      await spec.start(world)
      await world.guard(DIR, '公開', { target: spec.foreignTarget, handler: 'foreign:publish' }, '別の公開先', async () => ({
        ok: true, warnings: ['別の公開先の警告: 月額が続きます'],
      }))
      const ownStartedAt = getOps(DIR).earlier[0].startedAt

      const screen = open()
      await settle()
      expect(screen.has(spec.okText)).toBe(true)
      expect(world.calls.ack).toEqual([[DIR, ownStartedAt]])
      const snap = getOps(DIR)
      expect(snap.earlier, '自分の結果は見たことになっている').toEqual([])
      expect(snap.last?.handler, '別の公開先の警告は残っている').toBe('foreign:publish')
    })
  })

  // ── 古い応答・閉じたあとの応答 ──────────────────────────────────────────────
  describe('応答の順序', () => {
    it('★★★ get の応答が届く前に、より新しい押し出しが届いていたら、古い応答で走っている状態に戻さない', async () => {
      world.opGate = deferred()
      const done = spec.start(world)
      await settle()                       // main: 走っている

      world.getGate = deferred()
      const screen = open()                // get を投げる（写しは「走っている」・応答は遅れる）
      await settle()

      spec.setOk(world)
      world.opGate.resolve()
      await done
      await settle()                       // 押し出し: 終わった
      expect(screen.has(spec.okText), '前提: 終わった結果が出ている').toBe(true)
      expect(screen.has(OWN_CARD)).toBe(false)

      world.getGate.resolve()              // 古い応答がやっと届く
      await settle()
      expect(screen.has(OWN_CARD), '古い応答で、終わったものを「走っている」に戻している').toBe(false)
      expect(screen.button('公開中…'), '古い応答で、公開ボタンが押せなくなっている').toBeUndefined()
    })

    it('★★★ 閉じたあとに届いた応答では、表示も ack もしない（見せていないものを見たことにしない）', async () => {
      spec.setWarn(world, WARN_ONE)
      await spec.start(world)

      world.getGate = deferred()
      const screen = open()
      await settle(2)
      screen.unmount()                     // 応答が届く前に閉じた
      world.getGate.resolve()
      await settle()
      expect(world.calls.ack, '見せていない結果を、見たことにしている（次に開いても出なくなる）').toEqual([])

      world.getGate = null
      const again = open()
      await settle()
      expect(again.has(WARN_ONE), '見せていない結果が、次に開いたときにも出ない').toBe(true)
    })

    it('★ 閉じたあとの押し出しでは、何もしない（購読を外している）', async () => {
      const screen = open()
      await settle()
      screen.unmount()
      spec.setWarn(world, WARN_ONE)
      await spec.start(world)
      await settle()
      expect(world.calls.ack, '閉じたあとに届いた結果を見たことにしている').toEqual([])
      expect(getOps(DIR).last, '閉じている間に終わった結果が、開き直したときのために残っている').not.toBeNull()
    })
  })

  // ── 記録が読めなくても画面は動く ──────────────────────────────────────────
  describe('記録が読めなくても、画面は壊れない', () => {
    it('★ projectOps が使えない（読み込みが失敗する）環境でも、画面が出て、公開ボタンが押せる', async () => {
      world.api.projectOps.get = async () => { throw new Error('読めません') }
      const screen = open()
      await settle()
      expect(screen.button('🚀 公開する'), '公開ボタンが出ていない').toBeDefined()
      expect(screen.button('🚀 公開する')!.disabled).toBe(false)
    })
  })
})
