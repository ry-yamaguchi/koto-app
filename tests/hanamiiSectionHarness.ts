// 【公開】(HanamiiPanel) の 🗑（H1）を、偽の React の上で動かすテストの共通の道具。
// 使うテスト: tests/hanamiiTeardownSection.test.ts・tests/hanamiiTeardownSectionResult.test.ts（段階1の1c）。
//
// vi.mock（react・CredentialsModal ほか）は、テストのファイルの先頭に置く（そのファイルの中でしか巻き上げられないため）。
// 認証情報の偽物は ops-hanamiiVercel-harness.ts の hanamiiCredentialsModalMock。ここは、パネルの取り付け・記録の置き方・押し方を組み立てる。
import HanamiiPanel from '../src/renderer/components/HanamiiPanel'
import {
  makeWorld, installWindow, resetMain, mount, settle, hanamiiTokens,
  type World, type Mounted,
} from './ops-hanamiiVercel-harness'

export const DIR = '/tmp/koto-ops-test/projSection'
export const DIR_B = '/tmp/koto-ops-test/projSection-B'
export const PROJECT_ID = 'prj_test1'
/** 入口のボタン。 */
export const ENTRY = '🗑 この公開を破棄する'
export const A = { bucket: 'koto-data-aaa', prefix: 'projects/app/', shared: true }
export const B = { bucket: 'koto-data-bbb', prefix: 'projects/app/', shared: true }

/** 確認（ConfirmModal）の「破棄する」。入口の「🗑 この公開を破棄する」にも「破棄する」が含まれるので、文字がちょうど一致するほうを取る。 */
export const confirmButton = (m: Mounted) => m.buttons().find(b => b.text.trim() === '破棄する')
export const cancelButton = (m: Mounted) => m.buttons().find(b => b.text.trim() === 'やめる')

export function createSectionHarness() {
  let world!: World
  let live: Mounted[] = []

  /** beforeEach: 偽の main・偽の窓・認証情報（記録のトークンと使用中のトークン）を立てる。世界を返す。 */
  function setup(): World {
    resetMain()
    world = makeWorld(DIR)
    installWindow(world)
    live = []
    hanamiiTokens.byId = new Map([['t1', 'tok-panel'], ['tk-recorded', 'tok-recorded']])
    hanamiiTokens.active = 'tok-active'
    return world
  }
  /** afterEach */
  function cleanup(): void {
    for (const m of live) m.unmount()
    live = []
    resetMain()
  }
  const open = (dir: string = DIR): Mounted => {
    const m = mount(HanamiiPanel as any, { apiKey: 'k', projectDir: dir, onOpenCredentials: () => {} })
    live.push(m)
    return m
  }
  /** HANAMII に公開済み（公開したときのトークンの登録つき）の記録にする。 */
  const published = (extra: Record<string, unknown> = {}) => {
    world.meta.publish.hanamii = { workspaceId: 'ws1', name: 'app', projectId: PROJECT_ID, tokenId: 'tk-recorded', ...extra }
    world.meta.publish.targets = { hanamii: { publishedAt: '2026-09-29T00:00:00.000Z', url: 'https://old.example.test' } }
  }
  /** 入口の 🗑 を押して、確認が出るまで進める。 */
  const press = async (m: Mounted): Promise<void> => {
    m.button(ENTRY)!.click()
    await settle()
  }
  const teardownCalls = () => world.calls.hanamiiTeardown
  /** 窓を閉じる警告の最後の登録（activity.ts が win.setBusy へ出した引数）。 */
  const lastBusy = () => world.calls.setBusy[world.calls.setBusy.length - 1]
  return { setup, cleanup, open, published, press, teardownCalls, lastBusy }
}
