import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 認証情報の窓: 接続テストが通っても、入力した値はまだ保存されていないことがある（2026-11-11 作者の指摘）──────────────
// 通ったときだけ、テストにかけた値が保存済みと違えば、結果の隣に一言を出す。保存すると消える。自動では保存しない。
// 一言を出す部品は UnsavedTestNote の1つ。5つのボタン（AI Engine・GitHub・Claude・HANAMII・Vercel）がそれを置く。
// ここは偽の React の上でボタンを実際に押し、画面に出る文字で固定する（偽の main は electronAPI の5つの口だけ）。

vi.mock('react', async () => (await import('./ops-hanamiiVercel-harness')).reactModule)
vi.mock('react/jsx-runtime', async () => (await import('./ops-hanamiiVercel-harness')).jsxRuntimeModule)
vi.mock('react/jsx-dev-runtime', async () => (await import('./ops-hanamiiVercel-harness')).jsxDevRuntimeModule)

import { mount, settle, jsxRuntimeModule, type Mounted } from './ops-hanamiiVercel-harness'
import {
  KeyTestButton, GithubTestButton, AnthropicTestButton, HanamiiTestButton, VercelTestButton, UNSAVED_TEST_NOTE,
} from '../src/renderer/components/CredentialsTestButtons'
import { snapshotValues, savedKeyFor, testedKey } from '../src/renderer/credentialsSaved'

const NOTE = 'まだ保存していません。下の「保存」を押すと使えます。'

type Reply = 'ok' | 'ng'
let reply: Reply = 'ok'
const pick = <T,>(ok: T, ng: T): T => (reply === 'ok' ? ok : ng)

beforeEach(() => {
  reply = 'ok'
  ;(globalThis as any).window = {
    electronAPI: {
      sakura: { models: async () => { if (reply === 'ng') throw new Error('x'); return ['m1', 'm2'] } },
      github: { test: async () => pick({ ok: true, login: 'octo' }, { ok: false, message: '失敗' }) },
      claude: { test: async () => pick({ ok: true, modelCount: 3 }, { ok: false, message: '失敗' }) },
      hanamii: { testConnection: async () => pick({ ok: true }, { ok: false, message: '失敗' }) },
      vercel: { testConnection: async () => pick({ ok: true, message: '接続OK' }, { ok: false, message: '失敗' }) },
    },
  }
})
afterEach(() => { delete (globalThis as any).window })

const CASES: Array<[string, (p: any) => unknown, Record<string, unknown>]> = [
  ['さくらのAI Engine', KeyTestButton, { apiKey: 'fake-key' }],
  ['GitHub', GithubTestButton, { apiKey: 'fake-key' }],
  ['Claude', AnthropicTestButton, { apiKey: 'fake-key' }],
  ['HANAMII', HanamiiTestButton, { token: 'fake-token' }],
  ['Vercel', VercelTestButton, { token: 'fake-token', teamId: '' }],
]

async function press(m: Mounted): Promise<void> {
  m.button('接続テスト')!.click()
  await settle()
}

// saved: 保存されている値（テストにかけた値と同じ形）。null=一度も保存していない項目
const savedOf = (base: Record<string, unknown>): string =>
  testedKey(...Object.values(base).map(v => String(v)))

describe.each(CASES)('%s の接続テスト', (_name, Comp, base) => {
  const make = (saved: string | null): Mounted => mount(Comp, { ...base, saved })
  it('★★★ 通って、テストにかけた値が保存済みと違うなら、結果の隣に一言が1回出る', async () => {
    const m = make('fake-old')
    expect(m.has(NOTE), '押す前に出ている').toBe(false)
    await press(m)
    expect(m.has('✅')).toBe(true)
    expect(m.count(NOTE)).toBe(1)
    m.unmount()
  })

  it('★★★ 一度も保存していない項目（saved=null）は、通れば一言が出る', async () => {
    const m = make(null)
    await press(m)
    expect(m.count(NOTE)).toBe(1)
    m.unmount()
  })

  it('★★★ 通っても、テストにかけた値が保存済みと同じなら一言は出ない', async () => {
    const m = make(savedOf(base))
    await press(m)
    expect(m.has('✅')).toBe(true)
    expect(m.has(NOTE)).toBe(false)
    m.unmount()
  })

  it('★★★ 通ったあとに保存して、保存済みの値が更新されると、一言は消える（押し直さなくても）', async () => {
    const m = make('fake-old')
    await press(m)
    expect(m.has(NOTE)).toBe(true)
    m.rerender({ ...base, saved: savedOf(base) })
    expect(m.has('✅'), '結果は残る').toBe(true)
    expect(m.has(NOTE)).toBe(false)
    m.unmount()
  })

  it('★★★ 失敗したときは出さない（通っていない）', async () => {
    reply = 'ng'
    const m = make('fake-old')
    await press(m)
    expect(m.has('❌')).toBe(true)
    expect(m.has(NOTE)).toBe(false)
    m.unmount()
  })
})

// ── 窓の中の2枚のカード: 片方を編集しても、触っていない保存済みのカードに「まだ保存していません」は出ない ──────────
// 窓と同じ部品（snapshotValues・savedKeyFor）でカードを並べる。値は作り物。
function TwoCards({ store, snapshot }: { store: Record<string, { entries: Array<{ id: string; values: Record<string, string> }> }>; snapshot: Record<string, Record<string, string>> }) {
  const h = jsxRuntimeModule.jsx as (t: unknown, p: Record<string, unknown>, k?: unknown) => unknown
  return h('div', {
    children: store.github.entries.map(e => h('div', {
      children: [
        h('span', { children: e.id }),
        h(GithubTestButton, { apiKey: e.values.apiKey ?? '', saved: savedKeyFor(snapshot, e.id, ['apiKey']) }),
      ],
    }, e.id)),
  })
}

describe('カードごとに決める（窓全体の未保存では決めない）', () => {
  const store0 = { github: { entries: [{ id: 'A', values: { apiKey: 'fake-a' } }, { id: 'B', values: { apiKey: 'fake-b' } }] } }
  const snap0 = snapshotValues(store0)
  const pressAll = async (m: Mounted, idx: number) => { m.buttons().filter(b => b.text.includes('接続テスト'))[idx].click(); await settle() }
  const lineCount = (m: Mounted) => m.count(NOTE)

  it('★★★ A を編集して、触っていない保存済みの B をテストしても、B に一言は出ない', async () => {
    const edited = { github: { entries: [{ id: 'A', values: { apiKey: 'fake-a-edited' } }, store0.github.entries[1]] } }
    const m = mount(TwoCards, { store: edited, snapshot: snap0 })
    await pressAll(m, 1)
    expect(m.has('✅')).toBe(true)
    expect(lineCount(m)).toBe(0)
    m.unmount()
  })

  it('★★★ A を編集して A をテストすると、A に一言が出る（B は出ない）', async () => {
    const edited = { github: { entries: [{ id: 'A', values: { apiKey: 'fake-a-edited' } }, store0.github.entries[1]] } }
    const m = mount(TwoCards, { store: edited, snapshot: snap0 })
    await pressAll(m, 0)
    expect(lineCount(m)).toBe(1)
    m.unmount()
  })

  it('★★★ 保存して写しを取り直すと、A の一言は消える', async () => {
    const edited = { github: { entries: [{ id: 'A', values: { apiKey: 'fake-a-edited' } }, store0.github.entries[1]] } }
    const m = mount(TwoCards, { store: edited, snapshot: snap0 })
    await pressAll(m, 0)
    expect(lineCount(m)).toBe(1)
    m.rerender({ store: edited, snapshot: snapshotValues(edited) })
    expect(lineCount(m)).toBe(0)
    m.unmount()
  })

  it('★★★ 追加したばかりで一度も保存していない項目（写しに無い）は、通れば一言が出る', async () => {
    const added = { github: { entries: [...store0.github.entries, { id: 'C', values: { apiKey: 'fake-c' } }] } }
    const m = mount(TwoCards, { store: added, snapshot: snap0 })
    await pressAll(m, 2)
    expect(lineCount(m)).toBe(1)
    m.unmount()
  })

  it('★★ 前後の空白だけの違いは「違い」にしない', () => {
    expect(testedKey(' x ', 'y')).toBe(testedKey('x', 'y '))
    expect(savedKeyFor(snap0, 'A', ['apiKey'])).toBe(testedKey('fake-a'))
    expect(savedKeyFor(snap0, 'Z', ['apiKey'])).toBeNull()
  })
})

describe('一言の出し方は1つ', () => {
  const root = path.join(__dirname, '..', 'src')
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8')
  it('★★ 文は定義の1か所だけ。5つのボタンが UnsavedTestNote を置き、窓は項目ごとの保存済みの値を5つに渡す', () => {
    expect(UNSAVED_TEST_NOTE).toBe(NOTE)
    const buttons = read('renderer/components/CredentialsTestButtons.tsx')
    expect(buttons.split('まだ保存していません').length - 1).toBe(1)
    expect(buttons.split("{state === 'ok' && <UnsavedTestNote tested={tested} saved={saved} />}").length - 1).toBe(5)
    const modal = read('renderer/components/CredentialsModal.tsx')
    expect(modal.split("saved={savedKeyOf(").length - 1).toBe(5)
    expect(modal).not.toContain('unsaved={dirty}')
    expect(modal.split('setSavedValues(snapshotValues(').length - 1, '読み込み時と保存の完了時に写しを取り直す').toBe(2)
    expect(modal).not.toContain('まだ保存していません')
  })
  it('★★ 自動では保存しない（接続テストのボタンは保存を呼ばない）', () => {
    const buttons = read('renderer/components/CredentialsTestButtons.tsx')
    expect(buttons).not.toMatch(/secure\.encrypt|localStorage|onSave|save\(/)
  })
})
