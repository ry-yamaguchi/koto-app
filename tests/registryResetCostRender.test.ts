import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

// ── 「設定し直す」の2か所に出す費用の文を、画面を実際に描いて確かめる（0.6.26）─────────────────────
// 「↻ 設定し直す」は、探し直して見つからなかったときだけ新しいレジストリを作る（＝月額が増える）。
// その費用の文 registryNotFoundCostNote() は、押す前に見えなければ意味がない。出す場所は2つ:
//   1. 公開前の確認で「コンテナレジストリが見つからない」と出たとき（fix:'reset-registry' のチェックの行）
//   2. 公開が hint:'reset-registry' で失敗したときの案内（「↻ レジストリを設定し直す」）
// ソースの文字列を読むだけのテスト（tests/targetPriceNotes.test.ts・tests/registryCreateNote.test.ts）は、
// 文を `{false && …}` や `{regCreating && …}`（押したあとにしか出ない）で包んでも通る。
// ここは偽の React で AppRunPanel を本当に動かし、押す前の画面に出る文字を読む（掟10）。

import { RT } from './appRunPanelRt'

vi.mock('react', async () => (await import('./appRunPanelRt')).reactModule())
vi.mock('react/jsx-runtime', async () => (await import('./appRunPanelRt')).jsxRuntimeModule())
vi.mock('react/jsx-dev-runtime', async () => (await import('./appRunPanelRt')).jsxDevRuntimeModule())

let Panel: (p: any) => unknown
let mainOps: typeof import('../src/main/projectOps')
let cost: typeof import('../src/shared/cloudCost')

const DIR = '/tmp/koto-registry-reset-cost/proj'

const SPEC = {
  name: 'myapp', backend: 'apprun', region: 'is1a',
  service: { port: 8080, source: { type: 'image', ref: 'x' }, scale: { min: 0, max: 10 } },
  persistence: { objectStorage: [] }, guardrails: { ttlHours: 0 },
}

/** 公開前の確認の結果（チェックの一覧）。テストごとに差し替える。 */
let preflightValue: Record<string, unknown> = {}
/** 公開の結果。テストごとに差し替える。 */
let applyValue: Record<string, unknown> = {}
/** 画面から cloud.ensureRegistry が呼ばれた回数（押す前の画面を見るテストでは 0 のまま）。 */
let ensureCalls = 0

const OK_PREFLIGHT = { ok: true, canPublish: true, summary: '確認できました', checks: [] }
const MISSING_REGISTRY_CHECK = {
  id: 'registry', label: 'コンテナレジストリ', status: 'ng',
  note: '『myapp』が見つかりません（削除された可能性があります）。下のボタンで作り直せます。',
  fix: 'reset-registry',
}

function installWindow() {
  const ok = <T,>(v: T) => async () => v
  const cloud: any = {
    hasKey: ok(true),
    loadEnv: ok({ ok: true, spec: SPEC }),
    checkPrereqs: ok({ sourceType: 'image', builderMode: 'builtin', builder: true, registry: true }),
    checkExpiry: ok({ ok: true, expired: false, createdAt: null, ttlHours: 0 }),
    appUrl: ok({ ok: true, url: null }),
    isPublished: ok({ ok: true, published: false }),
    getAccessLimit: ok({ ok: true, deployed: false }),
    registryName: ok({ ok: true, name: 'myapp', origin: 'owned' }),
    preflight: async () => preflightValue,
    plan: ok({ ok: true, plan: { actions: [{ type: 'update', kind: 'apprun-app', name: 'myapp', description: 'アプリを更新' }], hasDestructive: false, hasStatefulDelete: false } }),
    getTraffics: ok({ ok: true, state: { kind: 'latest' } }),
    onApplyProgress: () => () => {},
    apply: async () => applyValue,
    ensureRegistry: async () => { ensureCalls++; return { ok: true, server: 'myapp.sakuracr.jp', created: false } },
  }
  const api: any = {
    cloud,
    storage: { placement: async () => ({ ok: true, placements: [] }) },
    fs: { readFile: async () => '{}', exists: async () => false, trash: async () => {} },
    stageTiming: { estimates: async () => null },
    publishMeta: { forgetTarget: async () => ({ ok: true, meta: {} }) },
    win: { setBusy: () => {} },
    secure: { decrypt: async () => '' },
    projectOps: {
      get: async (dir: string) => mainOps.getOps(dir),
      ack: async (dir: string, upTo?: number) => ({ ok: true, acked: mainOps.ackOps(dir, upTo) }),
      onChanged: () => () => {},
    },
  }
  const store = new Map<string, string>()
  const win: any = new EventTarget()
  win.electronAPI = api
  win.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  }
  ;(globalThis as any).window = win
  ;(globalThis as any).localStorage = win.localStorage
}

const onUnhandled = () => {}
beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled)
  installWindow()
  mainOps = await import('../src/main/projectOps')
  cost = await import('../src/shared/cloudCost')
  Panel = (await import('../src/renderer/components/AppRunPanel')).default as unknown as (p: any) => unknown
})

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 0)); await Promise.resolve() }
}

let opened: Array<ReturnType<typeof RT.mount>> = []
async function mountPanel() {
  const inst = RT.mount(Panel, { apiKey: 'k', projectDir: DIR, onOpenCredentials: () => {}, visible: true })
  opened.push(inst)
  await settle()
  const tree = () => RT.expand(inst.tree)
  return {
    tree,
    text: () => RT.textOf(tree()),
    async click(label: string) {
      const hits = RT.findAll(tree(), (n: any) => n.type === 'button' && RT.textOf(n).includes(label))
      if (hits.length !== 1) throw new Error(`ボタン「${label}」が ${hits.length} 件（1件のはず）。いまの文字: ${RT.textOf(tree()).slice(0, 600)}`)
      hits[0].props.onClick()
      await settle()
    },
    /** 文字に s を含む、その型の要素。 */
    nodes: (type: string, s: string) => RT.findAll(tree(), (n: any) => n.type === type && RT.textOf(n).includes(s)),
  }
}

beforeEach(() => {
  mainOps.resetProjectOpsForTests()
  preflightValue = OK_PREFLIGHT
  applyValue = {}
  ensureCalls = 0
})
afterEach(() => {
  for (const i of opened) RT.unmount(i)
  opened = []
})

const count = (s: string, part: string) => s.split(part).length - 1

describe('公開前の確認で「レジストリが見つからない」と出た行（fix:reset-registry）', () => {
  it('★★★ 「↻ 設定し直す」を押す前に、ボタンの直下へ費用の文（月額と、見つからないときに新しく作ること）が出ている', async () => {
    preflightValue = { ok: true, canPublish: false, summary: '公開できない項目があります', checks: [MISSING_REGISTRY_CHECK] }
    const v = await mountPanel()
    await v.click('公開前に確かめる')

    const rows = v.nodes('li', '見つかりません')
    expect(rows).toHaveLength(1)
    const row = RT.textOf(rows[0])
    const note = cost.registryNotFoundCostNote()
    expect(note).toContain(`月額${cost.REGISTRY_MONTHLY_YEN}円（税込）`)
    // ボタンの文字のすぐあとに文が続く（ボタンの下。別の場所へ離れていない）
    expect(row).toContain('↻ 設定し直す' + note)
    expect(ensureCalls, '押していない（表示だけで作りにいかない）').toBe(0)
    // 1画面に1回だけ
    expect(count(v.text(), note)).toBe(1)
  })

  it('チェックの行が「見つかった」（ng でない）ときは、費用の文もボタンも出ない', async () => {
    preflightValue = { ok: true, canPublish: true, summary: '確認できました', checks: [{ id: 'registry', label: 'コンテナレジストリ', status: 'warn', note: '確認できませんでした（公開はできます）。' }] }
    const v = await mountPanel()
    await v.click('公開前に確かめる')
    expect(v.text()).toContain('確認できませんでした（公開はできます）。')
    expect(v.text()).not.toContain(cost.registryNotFoundCostNote())
    expect(v.text()).not.toContain('↻ 設定し直す')
  })
})

describe('公開が hint:reset-registry で失敗したときの案内', () => {
  it('★★★ 「↻ レジストリを設定し直す」を押す前に、説明の段落の中へ費用の文が出ている', async () => {
    applyValue = {
      ok: false, hint: 'reset-registry',
      message: 'このプロジェクトが使うコンテナレジストリ『myapp』が見つかりません（コントロールパネルで削除された可能性があります）。',
    }
    const v = await mountPanel()
    await v.click('🚀 公開する')

    const note = cost.registryNotFoundCostNote()
    const paragraphs = v.nodes('p', note)
    expect(paragraphs).toHaveLength(1)
    expect(RT.textOf(paragraphs[0])).toContain('このプロジェクトのコンテナレジストリを探し直し')
    expect(v.text()).toContain('↻ レジストリを設定し直す')
    expect(ensureCalls, '押していない').toBe(0)
    expect(count(v.text(), note)).toBe(1)
  })

  it('hint が無い失敗（別の原因）では、費用の文もボタンも出さない', async () => {
    applyValue = { ok: false, message: 'アプリの組み立てに失敗しました' }
    const v = await mountPanel()
    await v.click('🚀 公開する')
    expect(v.text()).toContain('アプリの組み立てに失敗しました')
    expect(v.text()).not.toContain(cost.registryNotFoundCostNote())
    expect(v.text()).not.toContain('↻ レジストリを設定し直す')
  })

  it('整った（ensureRegistry が成功した）あとは、案内ごと消える＝ボタンも費用の文も残さない', async () => {
    applyValue = { ok: false, hint: 'reset-registry', message: 'このプロジェクトが使うコンテナレジストリ『myapp』が見つかりません。' }
    const v = await mountPanel()
    await v.click('🚀 公開する')
    await v.click('↻ レジストリを設定し直す')
    expect(ensureCalls).toBe(1)
    expect(v.text()).toContain('✅ レジストリが整いました')
    expect(v.text()).not.toContain(cost.registryNotFoundCostNote())
  })
})
