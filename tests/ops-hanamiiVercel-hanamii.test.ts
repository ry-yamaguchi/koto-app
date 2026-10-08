import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── HANAMII の画面に固有の振る舞い（2026-09-29）────────────────────────────────
// 共通の「閉じて開き直したとき」は tests/ops-hanamiiVercel-remount.test.ts。ここは:
//
//   ① **ポーリングの撤去**: 公開のあと READY になるまで 3 秒ごとに状態を聞き、READY を見たら公開記録の url を書き、
//      古い保存場所の鍵を片づける setInterval（startPolling）が画面にあった。ダイアログを閉じると止まり、
//      url は記録されず古い鍵が残った。いまは main の hanamii:publish が新しい版の READY を確かめるまで返らず、
//      url の記録も鍵の片づけも main が行う。**画面がやると二重に片づけることになる**——やっていないことを固定する。
//   ② 公開の結果の言い分け: 動いたと確かめた／確かめられていない／起動に失敗した。
//      **確かめていないことを「動いた」と言わない**（ok は「依頼が受け付けられた」の意味）。
//   ③ 破棄: 進み具合・結果・残ったもの（月額が続く）が、閉じて開き直しても出る。消えたあとの画面側の後始末。
//
// 偽の main は**本物の記録・鍵**（src/main/projectOps.ts・projectLock.ts）の上に作ってある（tests/ops-hanamiiVercel-harness.ts）。

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
}))

import HanamiiPanel from '../src/renderer/components/HanamiiPanel'
import {
  makeWorld, installWindow, resetMain, mount, settle, deferred, getOps,
  type World, type Mounted,
} from './ops-hanamiiVercel-harness'

const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

const DIR = '/tmp/koto-ops-test/projH'
const PROJECT_ID = 'prj_test1'

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

const open = (dir: string = DIR): Mounted => {
  const m = mount(HanamiiPanel as any, { apiKey: 'k', projectDir: dir, onOpenCredentials: () => {} })
  live.push(m)
  return m
}
/** すでに公開済み（HANAMII のプロジェクトがある）プロジェクトにする。 */
const published = () => {
  world.meta.publish.hanamii.projectId = PROJECT_ID
  world.meta.publish.targets = { hanamii: { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://old.example.test' } }
}
const READY = { ok: true, projectId: PROJECT_ID, deploymentId: 'dpl_test1', deployState: 'ready', readyState: 'READY', url: 'https://app-test.example.test' }

describe('HanamiiPanel: 画面はもう READY を待たない・鍵を片づけない（main がやる）', () => {
  it('★★★ 公開が終わっても、setInterval を使わず、古い鍵の片づけ（cleanUpKeys）を呼ばない', async () => {
    published()
    // main が古い鍵を片づけ切れなかったときだけ、互換の項目が返り値に残る。**それでも画面は片づけない**。
    world.publishReply = {
      ...READY, storagePermissionId: 'perm_test_1', storageProjectName: 'koto-app-hanamii',
      warnings: ['保存場所の古い鍵を片づけられませんでした（新しい版が動いていることは確かめられています）。'],
    }
    const screen = open()
    await settle()
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(world.calls.hanamiiPublish).toHaveLength(1)

    expect(world.calls.setInterval, '画面が READY を待つ setInterval を持っている（main と二重に片づけることになる）').toBe(0)
    expect(world.calls.cleanUpKeys, '画面が古い鍵を片づけている（main の片づけと二重）').toBe(0)
    // main が片づけ切れなかったことは、警告として見える
    expect(screen.has('保存場所の古い鍵を片づけられませんでした')).toBe(true)
  })

  it('★★ 動いたと確かめた公開: 見出しと URL が出る。状態を取り直して、公開済みの表示になる', async () => {
    published()
    world.publishReply = { ...READY }
    const screen = open()
    await settle()
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(screen.has('✅ 公開できました。新しい版が動いたことを確かめました。')).toBe(true)
    expect(screen.has('https://app-test.example.test')).toBe(true)
    expect(screen.has('状態: ✅ 公開済み')).toBe(true)
    expect(world.calls.setInterval).toBe(0)
  })

  it('★★★ 閉じている間に公開が終わっても、開き直した画面に公開の projectId と状態が反映される', async () => {
    // 初回の公開の最中に閉じた（画面の写しには projectId が無い）。main が projectId を記録して終わる。
    world.opGate = deferred()
    const done = world.api.hanamii.publish(DIR, { token: 'test-only-placeholder-token', workspaceId: 'ws1', name: 'app' })
    await settle()
    const screen = open()
    await settle()
    expect(screen.button('🗑 この公開を破棄する'), '前提: 公開前は破棄の入口が無い').toBeUndefined()
    screen.unmount()

    world.meta.publish.hanamii.projectId = PROJECT_ID      // main が公開の記録に書いた
    world.publishReply = { ...READY }
    world.opGate.resolve()
    await done

    const again = open()
    await settle()
    expect(again.has('✅ 公開できました。新しい版が動いたことを確かめました。')).toBe(true)
    expect(again.button('🗑 この公開を破棄する'), '公開できたのに、開き直した画面が破棄の入口を出していない').toBeDefined()
  })
})

describe('HanamiiPanel: 公開の結果の言い分け（確かめていないことを「動いた」と言わない）', () => {
  it('★★★ 待つ時間のうちに動かなかった（pending）: 「動いたとは確かめられていません」と警告。成功の見出しを出さない', async () => {
    published()
    world.publishReply = {
      ok: true, projectId: PROJECT_ID, deploymentId: 'dpl_test1', deployState: 'pending', readyState: 'BUILDING',
      warnings: ['HANAMII の新しい版が、待った時間（約5分）のうちには動きませんでした（状態: BUILDING）。まだ動いていません。'],
    }
    const screen = open()
    await settle()
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(screen.has('公開の依頼は受け付けられましたが、新しい版が動いたとは確かめられていません')).toBe(true)
    expect(screen.has('まだ動いていません')).toBe(true)
    expect(screen.has('公開できました。新しい版が動いたことを確かめました'), '確かめていないのに「動いた」と言っている').toBe(false)
  })

  it('★★★ 確かめられなかった（unknown）も、「動いた」と言わない', async () => {
    published()
    world.publishReply = {
      ok: true, projectId: PROJECT_ID, deploymentId: 'dpl_test1', deployState: 'unknown',
      warnings: ['新しい版が動いたかを確かめられませんでした（通信に失敗しました）。'],
    }
    const screen = open()
    await settle()
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(screen.has('新しい版が動いたとは確かめられていません')).toBe(true)
    expect(screen.has('新しい版が動いたかを確かめられませんでした')).toBe(true)
    expect(screen.has('公開できました。新しい版が動いたことを確かめました')).toBe(false)
  })

  it('★★★ 新しい版が起動に失敗した（deployState: error・IPC の ok は true のまま）: 失敗として出る。AI に相談できる', async () => {
    published()
    world.publishReply = {
      ok: true, projectId: PROJECT_ID, deploymentId: 'dpl_test1', deployState: 'error', readyState: 'ERROR', errorCode: 'BUILD_FAILED',
      message: 'HANAMII が新しい版を起動できませんでした（エラーコード: BUILD_FAILED）。HANAMII の管理画面でログを確かめてください。',
    }
    const screen = open()
    await settle()
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(screen.count('HANAMII が新しい版を起動できませんでした'), '失敗の理由が出ていない／二重に出ている').toBe(1)
    expect(screen.has('AIに相談する')).toBe(true)
    expect(screen.has('公開できました'), '起動に失敗したのに成功と言っている').toBe(false)
    expect(screen.has('公開の依頼が受け付けられました'), '起動に失敗したのに「受け付けられた」だけを見出しにしている').toBe(false)
  })

  it('★★ 待つ時間のうちに動かなかった回は、状態が公開処理中のまま。「↻ 状態を更新」で取り直せば、公開済みになる', async () => {
    published()
    world.publishReply = { ok: true, projectId: PROJECT_ID, deploymentId: 'dpl_test1', deployState: 'pending', readyState: 'BUILDING', warnings: ['まだ動いていません。'] }
    const screen = open()
    await settle()
    screen.button('🚀 公開する')!.click()
    world.statusReply = { ok: true, url: null, readyState: 'BUILDING', errorCode: null, runtime: null }
    await settle()
    expect(screen.has('HANAMII が公開処理中です')).toBe(true)
    expect(screen.button('公開中…')?.disabled, '公開処理中の間は押せない').toBe(true)

    // HANAMII 側で動き出した
    world.statusReply = { ok: true, url: 'https://app-test.example.test', readyState: 'READY', errorCode: null, runtime: { status: 'healthy', detail: null, syncedAt: null } }
    const refresh = screen.button('↻ 状態を更新')
    expect(refresh, '取り直す口が無い（BUILDING のまま固まる）').toBeDefined()
    refresh!.click()
    await settle()
    expect(screen.has('状態: ✅ 公開済み')).toBe(true)
    expect(screen.button('🚀 公開する（更新）')?.disabled, '動いたのに、公開が押せないまま').toBe(false)
  })

  it('★★ 状態を取り直せなかったときは、そう伝える（古い表示のまま黙らない）', async () => {
    published()
    const screen = open()
    await settle()
    world.statusReply = { ok: false, message: '通信できません' }
    screen.button('↻ 状態を更新')!.click()
    await settle()
    expect(screen.has('HANAMII の状態を取得できませんでした')).toBe(true)
  })

  it('★★ koto-data を差し替えた知らせ（executed）は、成功の知らせとして出す。🤖 AIに相談する は付けない', async () => {
    published()
    world.publishReply = { ...READY, executed: ['koto-data.js を新しい版へ差し替えました'] }
    const screen = open()
    await settle()
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(screen.count('koto-data.js を新しい版へ差し替えました'), '差し替えの知らせが出ていない／二重に出ている').toBe(1)
    expect(screen.has('AIに相談する'), '成功の知らせに、失敗の相談ボタンが出ている').toBe(false)
  })

  it('★ 「⚠️」で始まる知らせに、印を二重に付けない', async () => {
    published()
    world.publishReply = { ...READY, executed: ['⚠️ 保存場所の記録は残しています'] }
    const screen = open()
    await settle()
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(screen.has('⚠️ 保存場所の記録は残しています')).toBe(true)
    expect(screen.has('⚠️ ⚠️')).toBe(false)
  })

  it('★★ 公開名の衝突は、閉じて開き直しても、名前を変えて公開し直すカードが出る', async () => {
    world.publishReply = { ok: false, message: '公開に失敗しました（HTTP 409）: name already exists' }
    await world.api.hanamii.publish(DIR, { token: 'test-only-placeholder-token', workspaceId: 'ws1', name: 'app' })

    const screen = open()
    await settle()
    expect(screen.has('この公開名（app）は既に使われています'), '衝突のカードが、開き直した画面に出ていない').toBe(true)
    const retry = screen.buttons().find(b => b.text.includes('に変えて公開し直す'))
    expect(retry).toBeDefined()
    retry!.click()
    await settle()
    const last = world.calls.hanamiiPublish[world.calls.hanamiiPublish.length - 1] as { name: string }
    expect(last.name, '代替名で公開し直していない').not.toBe('app')
  })
})

describe('HanamiiPanel: 破棄の進み具合と結果（閉じて開き直しても出る）', () => {
  const CONFIRM = '🗑 この公開を破棄する'

  const startTeardownFromPanel = async (): Promise<Mounted> => {
    published()
    const screen = open()
    await settle()
    screen.button(CONFIRM)!.click()
    await settle()
    screen.button('破棄する')!.click()
    return screen
  }

  it('★★★ 破棄が終わると「破棄しました」と、片づけた内容・残った知らせが出る。設定の projectId と公開記録を片づける', async () => {
    world.teardownReply = {
      ok: true, appDeleted: true,
      executed: ['保存場所『koto-data-test』を片づけました — 中のデータごと削除', '⚠️ 鍵を1件だけ無効にできませんでした'],
    }
    const screen = await startTeardownFromPanel()
    await settle()

    expect(screen.count('✅ 破棄しました。')).toBe(1)
    expect(screen.has('保存場所『koto-data-test』を片づけました')).toBe(true)
    expect(screen.count('⚠️ 鍵を1件だけ無効にできませんでした'), '残った知らせが出ていない／二重に出ている').toBe(1)
    expect(world.calls.hanamiiTeardown).toEqual([[PROJECT_ID, DIR]])
    // 設定の projectId・公開記録の片づけは **main が済ませる**（hanamii:teardown）。画面は書かない
    // （画面が書くと、記録の再生で、そのあとに公開し直した新しい公開の記録まで消える・下の ★★★ の再生のテスト）
    expect(world.calls.merge.some(p => (p as any).publish?.hanamii?.projectId === null), '画面が projectId を書いている（記録の再生で新しい公開の記録を消す）').toBe(false)
    expect(world.calls.forgetTarget, '画面が公開記録を消している（記録の再生で新しい公開の記録を消す）').toEqual([])
    expect(world.meta.publish.hanamii.projectId, '前提: 偽の main が記録を片づけている').toBeNull()
    expect(screen.button(CONFIRM), '破棄したのに、破棄の入口が残っている').toBeUndefined()
  })

  it('★★★ 破棄が走っている間に開き直すと、進み具合が出て、公開も破棄も押せない', async () => {
    published()
    world.opGate = deferred()
    const done = world.api.hanamii.teardown(PROJECT_ID, 'test-only-placeholder-token', DIR)
    await settle()

    const screen = open()
    await settle()
    expect(screen.has('⏳ 破棄が進んでいます')).toBe(true)
    expect(screen.has('🗑 HANAMII のプロジェクトを削除しています…')).toBe(true)
    expect(screen.has('この画面を閉じても、処理は最後まで進みます')).toBe(true)
    expect(screen.button('破棄中…')?.disabled, '破棄が走っているのに、公開が押せる').toBe(true)
    expect(screen.button(CONFIRM)?.disabled, '破棄が走っているのに、もう一度破棄が押せる').toBe(true)

    world.opGate.resolve()
    await done
  })

  it('★★ 記録が読めなくても（押し出しが届かず、聞き直しも返らない）、破棄が成功した返り値だけで、消えた表示になる（入口を残さない）', async () => {
    published()
    const screen = open()
    await settle()
    // 破棄を頼んだあと、処理の記録の押し出しは届かず、聞き直し（get）も返らない状況
    world.mutePush = true
    const stuck = deferred()
    world.getGate = stuck
    world.teardownReply = { ok: true, appDeleted: true, executed: [] }
    screen.button(CONFIRM)!.click()
    await settle()
    screen.button('破棄する')!.click()
    await settle()
    expect(world.calls.hanamiiTeardown).toEqual([[PROJECT_ID, DIR]])
    expect(screen.button(CONFIRM), '破棄が成功したのに、記録が読めないだけで 🗑 の入口が残っている').toBeUndefined()
    stuck.resolve()
    await settle()
  })

  it('★★★ 破棄を頼んだ画面が無いまま（頼んだ画面の続きが届かないまま）終わっても、開き直した画面が結果を出し、消えた表示にする。記録は画面が書かない', async () => {
    // 窓の再読み込みなどで、破棄を頼んだ画面が失われた状況: main の本体を直接走らせる。
    // 設定の片づけは main が済ませている（偽の main も本物と同じく、鍵の中で記録を片づける）。
    published()
    world.teardownReply = { ok: true, appDeleted: true, executed: ['保存場所『koto-data-test』を片づけました'] }
    await world.api.hanamii.teardown(PROJECT_ID, 'test-only-placeholder-token', DIR)
    expect(world.meta.publish.hanamii.projectId, '前提: main が記録を片づけている').toBeNull()
    expect(world.meta.publish.targets.hanamii, '前提: main が公開記録を片づけている').toBeUndefined()

    const screen = open()
    await settle()
    expect(screen.has('✅ 破棄しました。')).toBe(true)
    expect(screen.has('保存場所『koto-data-test』を片づけました')).toBe(true)
    expect(screen.button(CONFIRM), '破棄が終わったのに、破棄の入口が残っている').toBeUndefined()
    // 開き直した画面は、記録を書かない（再生された古い破棄の結果で、いまの記録を消さないため）
    expect(world.calls.forgetTarget, '開き直した画面が公開記録を消している').toEqual([])
    expect(world.calls.merge.some(p => (p as any).publish?.hanamii?.projectId === null), '開き直した画面が projectId を書いている').toBe(false)
  })

  it('★★★ 開いたときの記録ファイルの読み込みが遅れて届いても、破棄で空にした projectId を古い値で戻さない', async () => {
    published()
    const late = deferred()
    world.readGate = late                     // 開いたときの記録ファイルの読み込み（破棄の前の projectId を持つ）の応答が遅れる
    const screen = open()
    await settle()
    world.readGate = null                     // これ以降の読み込みは遅れない（遅れるのは、開いたときの1回だけ）
    // 読み込みの応答を待っている間に、破棄が最後まで終わる（画面は記録から破棄の結果を出し、消えた表示にする）
    world.teardownReply = { ok: true, appDeleted: true, executed: [] }
    await world.api.hanamii.teardown(PROJECT_ID, 'test-only-placeholder-token', DIR)
    await settle()
    expect(screen.has('✅ 破棄しました。'), '前提: 記録から破棄の結果が出ている').toBe(true)
    expect(screen.button(CONFIRM), '前提: 消えた表示になっている').toBeUndefined()
    late.resolve()                            // 古い projectId がいまごろ届く
    await settle()
    expect(screen.button(CONFIRM), '破棄が終わったのに、遅れて届いた古い projectId で 🗑 が出直している').toBeUndefined()
  })

  it('★★★ 保存場所だけ残った（HANAMII のプロジェクトは消えた・ok は false）: 月額が続くことを出し、破棄の入口と記録は残す', async () => {
    published()
    world.teardownReply = {
      ok: false, appDeleted: true, executed: [], remainingBucket: 'koto-data-test', remainingBuckets: ['koto-data-test'],
      message: '保存場所を片づけられませんでした（消すまで月額が続きます）: 通信に失敗しました\n保存場所『koto-data-test』が残っています（消すまで月額が続きます）。',
    }
    await world.api.hanamii.teardown(PROJECT_ID, 'test-only-placeholder-token', DIR)

    const screen = open()
    await settle()
    expect(screen.has('HANAMII のプロジェクトは削除しました。ただし、保存場所は片づけられませんでした')).toBe(true)
    expect(screen.has('消すまで月額が続きます'), '残ったものの月額が続くことを見逃している').toBe(true)
    expect(screen.has('AIに相談する')).toBe(true)
    expect(screen.has('✅ 破棄しました。')).toBe(false)
    // もう一度 🗑 を押して保存場所の片づけをやり直せるよう、入口と記録は残す
    expect(screen.button(CONFIRM), '案内した「もう一度」の入口が消えている').toBeDefined()
    expect(world.calls.forgetTarget, '保存場所が残っているのに、公開記録を消している').toEqual([])
  })

  it('★★ 破棄が断られた（同じプロジェクトで別の操作が走っている）: 返り値の理由が出る', async () => {
    published()
    const screen = open()
    await settle()
    // 画面が知らないうちに main が走り始めた（押し出しを止めて作る）
    world.mutePush = true
    world.opGate = deferred()
    const busy = world.guard(DIR, '公開', { target: 'sakura-apprun', handler: 'cloud:apply' }, '別の操作', async () => ({ ok: true }))
    await settle()
    screen.button(CONFIRM)!.click()
    await settle()
    screen.button('破棄する')!.click()
    await settle()
    expect(screen.count('いま別の操作（公開）を実行中です'), '断られた理由が出ていない／二重に出ている').toBe(1)
    expect(world.calls.forgetTarget, '断られたのに、公開記録を消している').toEqual([])
    world.opGate.resolve()
    await busy
  })

  // ── 重大（2026-09-30 検分の指摘1）: 古い破棄の再生が、新しい公開の記録を消していた ──────────────
  // 画面は記録を再生する（閉じて開き直すと、まだ見られていない古い結果をもう一度「初めて見た」と扱う）。
  // 別の公開先の結果 F が見られていないと、その後ろの記録は「見た」にされず（ack は F を巻き込めない）残る。
  //   ①F（Vercel の公開）が見られていない ②HANAMII の破棄 R1 が終わる ③同じ画面で HANAMII に公開し直す（R2）
  //   ④閉じて開き直す → R1 が再生され、（以前は）画面が「破棄後の後始末」をもう一度行って R2 の記録を消した。
  // 結果: 次の公開で HANAMII のプロジェクトが二重に作られ、動いているほうは Koto から辿れなくなる。
  it('★★★ 別の公開先の結果が見られていないまま、破棄→公開し直し→閉じて開き直しても、新しい公開の記録を消さない（古い破棄の再生）', async () => {
    published()
    // F: 別の公開先（Vercel）の結果。まだ誰も見ていない
    await world.api.vercel.publish(DIR, { token: 'test-only-placeholder-token', name: 'app' })
    // R1: HANAMII の破棄。画面が開いている間に終わる
    const screen = open()
    await settle()
    world.teardownReply = { ok: true, appDeleted: true, executed: [] }
    screen.button(CONFIRM)!.click()
    await settle()
    screen.button('破棄する')!.click()
    await settle()
    expect(screen.has('✅ 破棄しました。'), '前提: 破棄が終わっている').toBe(true)
    // R2: 同じ画面で HANAMII に公開し直す（新しい projectId。main が公開の記録へ書く）
    world.meta.publish.hanamii.projectId = 'prj_new'
    world.meta.publish.targets = { hanamii: { publishedAt: '2026-09-30T00:00:00.000Z', url: 'https://new.example.test' } }
    world.publishReply = { ...READY, projectId: 'prj_new' }
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(screen.has('✅ 公開できました。新しい版が動いたことを確かめました。'), '前提: 公開し直せている').toBe(true)
    // 前提: F がまだ見られていないので、R1・R2 は「見た」にされていない（＝開き直すと再生される）
    expect(getOps(DIR).earlier.length + (getOps(DIR).last ? 1 : 0), '前提: 見られていない記録が残っている（再生される）').toBeGreaterThanOrEqual(3)

    // ④ 閉じて開き直す
    screen.unmount()
    world.calls.merge.length = 0
    world.calls.forgetTarget.length = 0
    const again = open()
    await settle()

    expect(world.calls.forgetTarget, '古い破棄の再生が、新しい公開の記録（📡 一覧の行）を消している').toEqual([])
    expect(world.calls.merge.some(p => (p as any).publish?.hanamii?.projectId === null), '古い破棄の再生が、新しい公開の projectId を空にしている').toBe(false)
    expect(world.meta.publish.hanamii.projectId, '新しい公開の記録が消えている').toBe('prj_new')
    expect(again.button('🚀 公開する（更新）'), '公開済みのはずが、「公開する」に戻っている（次の公開でプロジェクトが二重に作られる）').toBeDefined()
    expect(again.button(CONFIRM), '動いているプロジェクトの破棄の入口が消えている（Koto から辿れなくなる）').toBeDefined()
  })

  it('★ 破棄を終えて開き直したあと、同じ結果は出ない（見たことにしてある）', async () => {
    published()
    world.teardownReply = { ok: true, appDeleted: true, executed: [] }
    await world.api.hanamii.teardown(PROJECT_ID, 'test-only-placeholder-token', DIR)
    const first = open()
    await settle()
    expect(first.has('✅ 破棄しました。')).toBe(true)
    first.unmount()
    expect(getOps(DIR).last).toBeNull()
    const second = open()
    await settle()
    expect(second.has('✅ 破棄しました。')).toBe(false)
  })
})

// ── 開いたまま別のプロジェクトへ切り替わったとき（2026-09-30 検分・掟11）────────────────────────────
// 公開のダイアログは開いたまま projectDir だけが変わることがある（📡 公開したもの一覧の「プロジェクトを開く」は
// 一覧だけを閉じる）。公開は最長およそ5分かかるようになり、その間に切り替えられる窓が分単位に広がった。
// 前は、①公開の返り値の projectId を、返ってきた時点の画面（別のプロジェクト）へ入れ ②切り替え先の記録に projectId が
// 無いと前の値が残り ③破棄が終わった印（teardownSettled）も残った。そのまま「公開する（更新）」「🗑 破棄」を押すと
// **前のプロジェクトの projectId × いまの projectDir** で呼ばれ、別のプロジェクトのコードで前のアプリを上書きしたり、
// 前のアプリを消していまのプロジェクトの保存場所まで片づけたりした。
// ここは画面の関数を動かし、**main へ実際に渡った引数**で固定する（偽の main は本物の記録・鍵の上）。
describe('★★★ HanamiiPanel: 開いたまま別のプロジェクトへ切り替わっても、前のプロジェクトの projectId を持ち越さない（掟11）', () => {
  const DIR_B = '/tmp/koto-ops-test/projH-B'
  const CONFIRM = '🗑 この公開を破棄する'
  const TOKEN = 'test-only-placeholder-token'
  const recordOf = (projectId: string | null) => ({
    publish: { hanamii: { workspaceId: 'ws1', name: 'app', ...(projectId ? { projectId } : {}) }, targets: {} as Record<string, unknown> },
  })
  const switchTo = async (screen: Mounted, dir: string) => {
    screen.rerender({ apiKey: 'k', projectDir: dir, onOpenCredentials: () => {} })
    await settle()
  }
  const teardownFromScreen = async (screen: Mounted) => {
    screen.button(CONFIRM)!.click()
    await settle()
    screen.button('破棄する')!.click()
    await settle()
  }
  const lastPublishOpts = () => world.calls.hanamiiPublish[world.calls.hanamiiPublish.length - 1] as any

  it('★★★ 公開の途中で切り替わり、切り替え先の記録に別の projectId がある: 前の公開の返り値は入らず、🗑・再公開は切り替え先の projectId で呼ばれる', async () => {
    world.metaByDir[DIR] = recordOf('prj_A')
    world.metaByDir[DIR_B] = recordOf('prj_B')
    world.publishReply = { ...READY, projectId: 'prj_A' }
    world.opGate = deferred()                          // A の公開が「走っている最中」（HANAMII が起動するのを待っている）
    const screen = open(DIR)
    await settle()
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(world.calls.hanamiiPublish).toHaveLength(1)

    await switchTo(screen, DIR_B)                      // 待っている間に、📡 一覧から B を開く
    world.opGate.resolve()                             // A の公開が終わる。返り値の projectId は prj_A
    await settle()

    // B の画面で 🗑 破棄: 消すのは B の HANAMII プロジェクト（prj_B）。A の稼働中のアプリではない
    await teardownFromScreen(screen)
    expect(world.calls.hanamiiTeardown, 'A の稼働中のアプリを、B の画面から破棄しようとしている').toEqual([['prj_B', DIR_B]])
  })

  it('★★★ 同じ切り替えのあと「公開する（更新）」を押すと、B のコードは B の projectId へ再公開される（A の projectId を渡さない）', async () => {
    world.metaByDir[DIR] = recordOf('prj_A')
    world.metaByDir[DIR_B] = recordOf('prj_B')
    world.publishReply = { ...READY, projectId: 'prj_A' }
    world.opGate = deferred()
    const screen = open(DIR)
    await settle()
    screen.button('🚀 公開する')!.click()
    await settle()
    await switchTo(screen, DIR_B)
    world.opGate.resolve()
    await settle()

    world.publishReply = { ...READY, projectId: 'prj_B' }
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(world.calls.hanamiiPublish).toHaveLength(2)
    expect(lastPublishOpts().projectId, 'B のコードを、A の HANAMII プロジェクトへ再デプロイしようとしている').toBe('prj_B')
  })

  it('★★★ 切り替え先の記録に HANAMII のプロジェクトが無い: 🗑 が出ない。公開は projectId 無し（新しく作る）で呼ばれる', async () => {
    world.metaByDir[DIR] = recordOf('prj_A')
    world.metaByDir[DIR_B] = recordOf(null)
    const screen = open(DIR)
    await settle()
    expect(screen.button(CONFIRM), '前提: A には破棄の入口がある').toBeDefined()

    await switchTo(screen, DIR_B)
    expect(screen.button(CONFIRM), 'HANAMII に公開していない B の画面に、A の破棄の入口が残っている').toBeUndefined()
    expect(screen.button('🚀 公開する（更新）'), 'B が「更新」になっている（A の projectId を持ち越している）').toBeUndefined()

    world.publishReply = { ...READY, projectId: 'prj_B_new' }
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(lastPublishOpts().projectId, 'A の projectId を B の公開へ渡している').toBeUndefined()
  })

  it('★★★ 公開の途中で切り替わり、切り替え先の記録に HANAMII のプロジェクトが無い: 前の公開の返り値で、切り替え先に 🗑 が出ない', async () => {
    world.metaByDir[DIR] = recordOf(null)
    world.metaByDir[DIR_B] = recordOf(null)
    world.publishReply = { ...READY, projectId: 'prj_A' }
    world.opGate = deferred()
    const screen = open(DIR)
    await settle()
    screen.button('🚀 公開する')!.click()
    await settle()
    await switchTo(screen, DIR_B)
    world.opGate.resolve()
    await settle()

    expect(screen.button(CONFIRM), 'A の公開が終わっただけで、別のプロジェクト B の画面に A の 🗑 が出ている').toBeUndefined()
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(lastPublishOpts().projectId).toBeUndefined()
  })

  it('★★★ A で破棄した直後に、HANAMII に公開中の B へ切り替わる: B は「公開する（更新）」と 🗑 が出る（破棄が終わった印を持ち越さない）', async () => {
    published()                                        // A（DIR）の記録は偽の main の記録（破棄が終わると、main が片づける）
    world.metaByDir[DIR_B] = recordOf('prj_B')
    world.teardownReply = { ok: true, appDeleted: true, executed: [] }
    const screen = open(DIR)
    await settle()
    await teardownFromScreen(screen)
    expect(screen.button(CONFIRM), '前提: A は破棄されて、入口が消えている').toBeUndefined()

    await switchTo(screen, DIR_B)
    expect(screen.button('🚀 公開する（更新）'), 'B に公開中のアプリがあるのに「公開する」と出ている（破棄が終わった印が残っている）').toBeDefined()
    expect(screen.button(CONFIRM), 'B の破棄の入口が出ていない').toBeDefined()
    expect(screen.has('状態: ✅ 公開済み'), 'B の状態が出ていない').toBe(true)
  })

  it('★★ 破棄の途中で切り替わっても、前の破棄の結果は、いまの画面（別のプロジェクト）の表示を消さない', async () => {
    published()
    world.metaByDir[DIR_B] = recordOf('prj_B')
    world.teardownReply = { ok: true, appDeleted: true, executed: [] }
    world.opGate = deferred()
    const screen = open(DIR)
    await settle()
    await teardownFromScreen(screen)                   // A の破棄が走っている最中
    await switchTo(screen, DIR_B)
    world.opGate.resolve()                             // A の破棄が終わる
    await settle()

    expect(screen.button(CONFIRM), 'A の破棄の結果が、B の画面の「公開中」を消している').toBeDefined()
    expect(screen.button('🚀 公開する（更新）')).toBeDefined()
  })

  it('★★ 切り替える前の遅れた記録の読み込みは、切り替え先の画面へ入らない', async () => {
    world.metaByDir[DIR] = recordOf('prj_A')
    world.metaByDir[DIR_B] = recordOf(null)
    const late = deferred()
    world.readGate = late                              // A の記録ファイルの読み込みの応答が遅れる（中身は呼んだ時点の A のもの）
    const screen = open(DIR)
    await settle()
    world.readGate = null
    await switchTo(screen, DIR_B)                      // B へ切り替わる（B の読み込みは遅れない）
    late.resolve()                                     // A の古い projectId がいまごろ届く
    await settle()
    expect(screen.button(CONFIRM), '遅れて届いた A の projectId が、B の画面に入っている').toBeUndefined()
  })
})

describe('★★ HanamiiPanel: 破棄の入口は main の鍵だけで止める（HANAMII 側の状態が BUILDING のままでも押せる）', () => {
  const CONFIRM = '🗑 この公開を破棄する'
  const BUILDING = {
    ok: true, url: null, readyState: 'BUILDING', errorCode: null,
    runtime: { status: 'unknown', detail: null, syncedAt: null },
  }

  it('★★★ 公開が「待つ時間のうちに動かなかった」で終わり、状態が BUILDING のまま: 🗑 も「破棄する」も押せて、破棄が main へ渡る', async () => {
    published()
    world.statusReply = { ...BUILDING }
    const screen = open()
    await settle()
    expect(screen.has('⏳ HANAMII が公開処理中です…'), '前提: 状態が BUILDING').toBe(true)
    // 公開は BUILDING のあいだ押せない（従来どおり）。破棄は押せる（以前は破棄のボタンに disabled は無かった）
    expect(screen.button('公開中…')?.disabled, '前提: 公開は押せない').toBe(true)
    expect(screen.button(CONFIRM)?.disabled, '止まったままの版を、この画面から破棄できない').toBe(false)

    screen.button(CONFIRM)!.click()
    await settle()
    expect(screen.button('破棄する')?.disabled, '確認の「破棄する」が押せない').toBe(false)
    world.teardownReply = { ok: true, appDeleted: true, executed: [] }
    screen.button('破棄する')!.click()
    await settle()
    expect(world.calls.hanamiiTeardown).toEqual([[PROJECT_ID, DIR]])
  })

  it('★★ main の鍵が掛かっている間（別の操作が走っている）は、従来どおり押せない', async () => {
    published()
    world.opGate = deferred()
    const done = world.api.vercel.publish(DIR, { token: 'test-only-placeholder-token', name: 'app' })
    await settle()
    const screen = open()
    await settle()
    expect(screen.button(CONFIRM)?.disabled, '別の操作が走っているのに、破棄が押せる（main が断る）').toBe(true)
    world.opGate.resolve()
    await done
  })
})
