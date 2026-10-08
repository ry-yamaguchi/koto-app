import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── Vercel の画面に固有の振る舞い（2026-09-29）────────────────────────────────
// 共通の「閉じて開き直したとき」は tests/ops-hanamiiVercel-remount.test.ts。ここは:
//
//   ① 結果の notice（「保存場所を用意していないため、データは残りません…」「もう一度『公開する』を押すと…」
//      のような**次にすべきこと**）を、閉じて開き直しても見逃さない。従来は返り値の notice を画面の状態にだけ
//      持っていたので、公開の最中にダイアログを閉じると消えた。main が記録の warnings に集めたものを出す。
//   ② **成功のお知らせを失敗の枠に入れない**（2026-09-24 検分の指摘3）。🤖 が「公開で次の失敗が出ました」と
//      AI へ送り、起きていない失敗の原因探しが始まるため。成功の記録はお知らせの枠、失敗の記録だけが失敗の枠。
//   ③ 進み具合は記録に一本化した（vercel.onProgress は開いている間しか届かないので、もう聞かない）。
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
  getVercelToken: async () => 'test-only-placeholder-token',
  getVercelTokenById: async () => 'test-only-placeholder-token',
  getVercelTeamId: async () => null,
  getVercelTeamIdById: async () => null,
  listVercelTokenEntries: async () => ({ tokens: [{ id: 't1', label: 'テスト用' }], activeId: 't1' }),
}))

import VercelPanel from '../src/renderer/components/VercelPanel'
import {
  makeWorld, installWindow, resetMain, mount, settle, deferred,
  type World, type Mounted,
} from './ops-hanamiiVercel-harness'

const onUnhandled = () => {}
process.on('unhandledRejection', onUnhandled)
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

const DIR = '/tmp/koto-ops-test/projV'
const TOKEN = 'test-only-placeholder-token'

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

const open = (): Mounted => {
  const m = mount(VercelPanel as any, { apiKey: 'k', projectDir: DIR, onOpenCredentials: () => {} })
  live.push(m)
  return m
}
const publishInMain = () => world.api.vercel.publish(DIR, { token: TOKEN, name: 'app' })

const FIRST_TIME_NOTICE = '公開できました。データの保存に使う設定を Vercel へ渡しました（今回の公開にはまだ反映されていません）。'
  + 'もう一度「公開する」を押すと、データの保存が使えるようになります。'
const NO_STORAGE_NOTICE = '保存場所をまだ用意していないため、このアプリのデータは残りません'
  + '（公開のたびに、アプリに入力されたデータが消えます）。「保存場所を用意する」から用意してから、もう一度「公開する」を押してください。'

/** 押された「AI に聞く」が AI へ送る文を1つ受け取る。 */
function captureAskAi(): { texts: string[]; stop: () => void } {
  const texts: string[] = []
  const on = (e: Event) => { texts.push(String((e as CustomEvent).detail?.text ?? '')) }
  window.addEventListener('sakura:ask-ai', on)
  return { texts, stop: () => window.removeEventListener('sakura:ask-ai', on) }
}

describe('VercelPanel: 公開の結果の notice（次にすべきこと）を、閉じて開き直しても見逃さない', () => {
  it('★★★ 閉じている間に終わった初回公開の notice（もう一度「公開する」を押す）が、開き直した画面に出る', async () => {
    world.vercelReply = { ok: true, deploymentId: 'dpl_v1', url: 'https://app-test.vercel.test', readyState: 'READY', notice: FIRST_TIME_NOTICE }
    await publishInMain()

    const screen = open()
    await settle()
    expect(screen.has('もう一度「公開する」を押すと、データの保存が使えるようになります'), '次にすべきことを見逃している').toBe(true)
    expect(screen.has('ℹ️ ' + FIRST_TIME_NOTICE)).toBe(true)
    expect(screen.has('状態: ✅ 公開済み')).toBe(true)
    expect(screen.has('https://app-test.vercel.test')).toBe(true)
  })

  it('★★★ 保存場所を用意していないため、データは残らない、の警告も見逃さない', async () => {
    world.vercelReply = { ok: true, deploymentId: 'dpl_v1', url: 'https://app-test.vercel.test', readyState: 'READY', notice: NO_STORAGE_NOTICE }
    await publishInMain()

    const screen = open()
    await settle()
    expect(screen.has('このアプリのデータは残りません'), '失うものの警告を見逃している').toBe(true)
  })

  it('★★★ notice は「成功のお知らせ」の枠で出す。失敗の相談ボタン（AIに相談する）は付けず、次にすべきことを聞くボタンを付ける', async () => {
    world.vercelReply = { ok: true, deploymentId: 'dpl_v1', url: 'https://app-test.vercel.test', readyState: 'READY', notice: FIRST_TIME_NOTICE }
    await publishInMain()
    const screen = open()
    await settle()

    expect(screen.has('AIに相談する'), '成功のお知らせに、失敗の相談ボタンが付いている（AI が起きていない失敗を探し始める）').toBe(false)
    const ask = screen.button('次にすべきことをAIに聞く')
    expect(ask, 'お知らせに「次にすべきことをAIに聞く」が無い').toBeDefined()

    const cap = captureAskAi()
    ask!.click()
    cap.stop()
    expect(cap.texts).toHaveLength(1)
    expect(cap.texts[0]).toContain('Vercel への公開は成功しました。')
    expect(cap.texts[0]).toContain('動いているものを直そうとしないでください')
    expect(cap.texts[0], '成功のお知らせを「失敗」として AI へ送っている').not.toContain('次の失敗が出ました')
  })

  it('★★ 頼んだ画面が開いたままのときも、notice は1回だけ出る（返り値と記録の二重にならない）', async () => {
    world.vercelReply = { ok: true, deploymentId: 'dpl_v1', url: 'https://app-test.vercel.test', readyState: 'READY', notice: FIRST_TIME_NOTICE }
    const screen = open()
    await settle()
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(screen.count('もう一度「公開する」を押すと、データの保存が使えるようになります')).toBe(1)
    expect(screen.count('次にすべきことをAIに聞く')).toBe(1)
  })

  it('★★ notice が無い成功には、お知らせの枠は出ない', async () => {
    await publishInMain()
    const screen = open()
    await settle()
    expect(screen.has('状態: ✅ 公開済み')).toBe(true)
    expect(screen.has('次にすべきことをAIに聞く')).toBe(false)
  })

  it('★★★ 失敗は失敗の枠（AIに相談する）で出す。成功の見出し・URL は出さない', async () => {
    world.vercelReply = { ok: false, message: '公開に失敗しました（HTTP 403）: トークンの範囲が足りません', detail: '{"error":"forbidden"}' }
    await publishInMain()
    const screen = open()
    await settle()
    expect(screen.count('公開に失敗しました（HTTP 403）: トークンの範囲が足りません')).toBe(1)
    expect(screen.has('AIに相談する')).toBe(true)
    expect(screen.has('状態: ✅ 公開済み')).toBe(false)
    expect(screen.has('次にすべきことをAIに聞く')).toBe(false)
    // 生の応答は折りたたみの中（詳細を見る）
    expect(screen.has('詳細を見る')).toBe(true)
  })

  it('★★ 失敗の AI 相談は「公開の失敗」として送る', async () => {
    world.vercelReply = { ok: false, message: '公開に失敗しました（HTTP 500）' }
    await publishInMain()
    const screen = open()
    await settle()
    const cap = captureAskAi()
    screen.button('AIに相談する')!.click()
    cap.stop()
    expect(cap.texts[0]).toContain('Vercel への公開で次の失敗が出ました')
  })
})

describe('VercelPanel: 進み具合は記録から（開いている間しか届かない onProgress は聞かない）', () => {
  it('★★★ 公開を押しても vercel.onProgress を購読しない。進み具合は記録の段が出る', async () => {
    const screen = open()
    await settle()
    world.opGate = deferred()
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(world.calls.vercelOnProgress, '開き直すと届かない進捗の購読が残っている').toBe(0)
    expect(screen.has('ファイルを収集しています…'), '記録の段（進み具合）が出ていない').toBe(true)
    world.opGate.resolve()
    await settle()
  })

  it('★★ 公開ボタンの文言は、終わったら「（更新）」になる（開き直した画面が結果を見たときも）', async () => {
    const screen = open()
    await settle()
    expect(screen.button('🚀 公開する')).toBeDefined()
    expect(screen.button('（更新）')).toBeUndefined()
    // この画面は知らないうちに（別の画面が頼んだ）公開が終わった
    await publishInMain()
    await settle()
    expect(screen.button('🚀 公開する（更新）'), '公開できたのに、ボタンが「初回」のまま').toBeDefined()
  })

  it('★★ 設定（公開名・トークンの選択）の保存に失敗したら、黙らず伝える。公開の結果は記録が出す', async () => {
    world.api.publishMeta.merge = async () => ({ ok: false, message: '書き込めません' })
    const screen = open()
    await settle()
    screen.button('🚀 公開する')!.click()
    await settle()
    expect(screen.has('公開は終わりましたが、設定（トークンの選択・公開名）を保存できませんでした')).toBe(true)
    expect(screen.has('状態: ✅ 公開済み'), '公開の結果まで消えている').toBe(true)
  })
})
