import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'

// ── 0.6.25: 手順6の節（components/DedicatedTeardownSection.tsx）は、保存場所の一覧を読んだあとに cloud:twinFacts を1回読み、
// 読めた回だけ `keep` を付ける。付いた保存場所の 💾 の行は、確認と同じ作り手（teardownDataNoteFor）が「残ります」と言う ──────────────────
// 固定すること:
//   ・複製がいる（keep:twin）→ 行が「残ります」。読む口は1回・公開先は専有型・渡す保存場所は一覧と同じ組
//   ・読めない（投げた・ok:false・形の違う答え）／口が無い（cloud が無い・twinFacts が無い・null）→ 今までどおり「データも削除します」
//   ・答えが遅れて別のプロジェクトへ切り替わった → 付けない（掟11）。用意した直後の読み直しの最中に届いた古い答えも付けない
//   ・保存場所の一覧の読み自体が遅れ、読み直しの一覧が先に届いたあとで届いても、古い一覧は新しい一覧を上書きしない
// 偽の React と偽の window は dedicatedTeardownSectionKeep.test.ts・dedicatedTeardownSectionPlacements.test.ts と同じ。

vi.mock('react', async () => (await import('./appRunPanelRt')).reactModule())
vi.mock('react/jsx-runtime', async () => (await import('./appRunPanelRt')).jsxRuntimeModule())
vi.mock('react/jsx-dev-runtime', async () => (await import('./appRunPanelRt')).jsxDevRuntimeModule())

import { RT } from './appRunPanelRt'
import DedicatedTeardownSection from '../src/renderer/components/DedicatedTeardownSection'
import { teardownDataNoteFor } from '../src/shared/teardownSupport'

const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise<void>(r => setTimeout(r, 0)); await Promise.resolve() } }
const until = async (cond: () => boolean, what: string) => {
  for (let k = 0; k < 200 && !cond(); k++) await settle()
  expect(cond(), what).toBe(true)
}

type Keep = { risk: 'twin' | 'unread'; folders: string[] } | null
type TwinCall = { dir: string; args: { target: string; placements: Array<{ bucket: string; prefix: string }> } }

let placementImpl: (dir: string) => Promise<unknown>
/** 'absent' = window.electronAPI.cloud が無い／'noMethod' = cloud はあるが twinFacts が無い／'fn' = twinFacts がある */
let mouth: 'absent' | 'noMethod' | 'fn'
let twinImpl: (dir: string, args: TwinCall['args'], n: number) => Promise<unknown>
let twinCalls: TwinCall[]
let opened: Array<{ close: () => void }> = []
let fakeWindow: any

/** 渡された保存場所と同じ並び・同じ名前で、`keeps`（bucket → keep）を付けて返す正しい答え。 */
const answerWith = (args: TwinCall['args'], keeps: Record<string, Keep>) => ({
  ok: true,
  refusal: null,
  placements: args.placements.map(p => ({ bucket: p.bucket, prefix: p.prefix, keep: keeps[p.bucket] ?? null })),
})

beforeEach(() => {
  placementImpl = async () => ({ ok: true, placements: [] })
  mouth = 'fn'
  twinCalls = []
  twinImpl = async (_dir, args) => answerWith(args, {})
  const w: any = new EventTarget()
  w.electronAPI = {
    apprunDedicated: { onTeardownProgress: () => () => {} },
    storage: { placement: (dir: string) => placementImpl(dir) },
  }
  Object.defineProperty(w.electronAPI, 'cloud', {
    enumerable: true,
    get: () => mouth === 'absent' ? undefined : mouth === 'noMethod' ? {} : {
      twinFacts: (dir: string, args: TwinCall['args']) => { twinCalls.push({ dir, args }); return twinImpl(dir, args, twinCalls.length) },
    },
  })
  w.addEventListener = EventTarget.prototype.addEventListener.bind(w)
  w.removeEventListener = EventTarget.prototype.removeEventListener.bind(w)
  w.dispatchEvent = EventTarget.prototype.dispatchEvent.bind(w)
  fakeWindow = w
  ;(globalThis as any).window = w
})
afterEach(() => { for (const m of opened) m.close(); opened = []; delete (globalThis as any).window })

function mount(projectDir = '/tmp/proj-a') {
  const props = {
    projectDir, locked: false, showButton: true, tearingDown: false, running: false, runningRecord: null, nowMs: 0,
    apprunState: { clusterID: 'c-1' }, appRecord: null, summaryLines: [], view: null, notes: [], onStart: () => {}, onDone: async () => {},
  }
  const inst = RT.mount(DedicatedTeardownSection as any, props)
  const view = {
    text: () => RT.textOf(RT.expand(inst.tree)),
    setProjectDir: (dir: string) => { RT.setProps(inst, { ...inst.props, projectDir: dir }) },
    close: () => { RT.unmount(inst) },
  }
  opened.push(view)
  return view
}

const REMOVE_A = '保存場所『koto-a』にある、このプロジェクトのデータも削除します。'
const KEPT_A_TWIN = '保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。フォルダ『clone』も同じデータを使っています。'

describe('手順6の 💾 の行: 複製がいれば「残ります」（cloud:twinFacts を1回読む）', () => {
  it('★★★ 複製がいる（keep:twin）→ 行が「残ります」と確認と同じ作り手の文を言う。「データも削除します」と言わない。読む口は1回で、専有型・一覧と同じ組を渡す', async () => {
    placementImpl = async () => ({ ok: true, placements: [{ bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }] })
    twinImpl = async (_dir, args) => answerWith(args, { 'koto-a': { risk: 'twin', folders: ['clone'] } })
    const v = mount()
    await until(() => v.text().includes(KEPT_A_TWIN), '複製がいる保存場所の行が「残ります」にならない')
    expect(v.text()).toContain(`💾 ${teardownDataNoteFor({ target: 'sakura-apprun-dedicated', placement: { bucket: 'koto-a', prefix: 'projects/myapp/', keep: { risk: 'twin', folders: ['clone'] } } })}`)
    expect(v.text()).not.toContain(REMOVE_A)
    expect(twinCalls).toEqual([{
      dir: '/tmp/proj-a',
      args: { target: 'sakura-apprun-dedicated', placements: [{ bucket: 'koto-a', prefix: 'projects/myapp/' }] },
    }])
  })

  it('★★ 複製か確かめられない（keep:unread）も「残ります」。一部だけ keep: keep のあるものだけ「残ります」・無いものは今までどおり。prefix の無い保存場所は prefix を空にして問い合わせる', async () => {
    placementImpl = async () => ({ ok: true, placements: [
      { bucket: 'koto-a', prefix: 'projects/myapp/', shared: true },
      { bucket: 'koto-b', shared: false },
    ] })
    twinImpl = async (_dir, args) => answerWith(args, { 'koto-a': { risk: 'unread', folders: [] } })
    const v = mount()
    await until(() => v.text().includes('は残ります'), 'keep:unread の行が「残ります」にならない')
    const t = v.text()
    expect(t).toContain('💾 保存場所『koto-a』とその中のデータは残ります（消すまで月額が続きます）。ほかのフォルダの記録を読めないため、同じデータを使っているか確かめられませんでした。')
    expect(t).toContain('💾 保存場所『koto-b』にある、このプロジェクトのデータも削除します。')
    expect(t).not.toContain(REMOVE_A)
    expect(twinCalls).toHaveLength(1)
    expect(twinCalls[0].args.placements).toEqual([{ bucket: 'koto-a', prefix: 'projects/myapp/' }, { bucket: 'koto-b', prefix: '' }])
  })

  it('★ 対照: 読めて、複製がいない（keep:null）→ 今までどおり「データも削除します」', async () => {
    placementImpl = async () => ({ ok: true, placements: [{ bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }] })
    const v = mount()
    await until(() => twinCalls.length === 1, 'cloud:twinFacts を読まない')
    await settle()
    expect(v.text()).toContain(`💾 ${REMOVE_A}`)
    expect(v.text()).not.toContain('は残ります（消すまで月額が続きます）')
  })

  it('★ 保存場所が0件なら cloud:twinFacts を呼ばない（行も出ない）', async () => {
    const v = mount()
    await settle(); await settle()
    expect(twinCalls).toHaveLength(0)
    expect(v.text()).not.toContain('💾')
    expect(v.text()).toContain('すべて削除する')
  })
})

describe('手順6の 💾 の行: 読めなかった・口が無い回は keep を付けない（今までどおり「データも削除します」）', () => {
  const placeA = async () => ({ ok: true, placements: [{ bucket: 'koto-a', prefix: 'projects/myapp/', shared: true }] })
  const SAME_AS_BEFORE = (v: { text(): string }) => {
    expect(v.text()).toContain(`💾 ${REMOVE_A}`)
    expect(v.text()).not.toContain('は残ります（消すまで月額が続きます）')
    expect(v.text()).toContain('すべて削除する')
  }

  const unreadable: Array<[string, (dir: string, args: TwinCall['args']) => Promise<unknown>]> = [
    ['読みが投げた（IPC の失敗）', async () => { throw new Error('ipc failed') }],
    ['ok:false', async () => ({ ok: false })],
    ['答えが空', async () => undefined],
    ['保存場所の件数が違う', async () => ({ ok: true, refusal: null, placements: [] })],
    ['保存場所の名前が違う', async (_d, a) => ({ ok: true, refusal: null, placements: a.placements.map(p => ({ bucket: 'other', prefix: p.prefix, keep: { risk: 'twin', folders: ['clone'] } })) })],
    ['prefix が違う', async (_d, a) => ({ ok: true, refusal: null, placements: a.placements.map(p => ({ bucket: p.bucket, prefix: 'elsewhere/', keep: { risk: 'twin', folders: ['clone'] } })) })],
    ['keep の形が違う（risk が未知）', async (_d, a) => ({ ok: true, refusal: null, placements: a.placements.map(p => ({ bucket: p.bucket, prefix: p.prefix, keep: { risk: 'bogus', folders: ['clone'] } })) })],
    ['keep:twin なのにフォルダ名が無い', async (_d, a) => ({ ok: true, refusal: null, placements: a.placements.map(p => ({ bucket: p.bucket, prefix: p.prefix, keep: { risk: 'twin', folders: [] } })) })],
    ['断り（refusal）の形が違う', async (_d, a) => ({ ok: true, refusal: 'twin', placements: a.placements.map(p => ({ bucket: p.bucket, prefix: p.prefix, keep: { risk: 'twin', folders: ['clone'] } })) })],
  ]
  for (const [name, impl] of unreadable) {
    it(`★★★ 読めなかった（${name}）→ keep を付けない。一覧は出て、画面は動き続ける`, async () => {
      placementImpl = placeA
      twinImpl = impl
      const v = mount()
      await until(() => twinCalls.length === 1, 'cloud:twinFacts を読まない')
      await settle(); await settle()
      SAME_AS_BEFORE(v)
    })
  }

  it('★★★ 口が無い（window.electronAPI.cloud が無い）→ 今までどおり。問い合わせない', async () => {
    placementImpl = placeA
    mouth = 'absent'
    const v = mount()
    await until(() => v.text().includes('koto-a'), '保存場所の行が出ない')
    await settle(); await settle()
    SAME_AS_BEFORE(v)
    expect(twinCalls).toHaveLength(0)
  })

  it('★★★ 口が無い（cloud に twinFacts が無い）→ 今までどおり', async () => {
    placementImpl = placeA
    mouth = 'noMethod'
    const v = mount()
    await until(() => v.text().includes('koto-a'), '保存場所の行が出ない')
    await settle(); await settle()
    SAME_AS_BEFORE(v)
  })

  it('★★★ 口が null を返す → 口が無いのと同じ（今までどおり）', async () => {
    placementImpl = placeA
    twinImpl = async () => null
    const v = mount()
    await until(() => twinCalls.length === 1, 'cloud:twinFacts を読まない')
    await settle(); await settle()
    SAME_AS_BEFORE(v)
  })
})

describe('手順6の 💾 の行: 遅れて届いた古い答えを、いまの表示へ入れない（掟11）', () => {
  it('★★★ 答えが遅れて別のプロジェクトに切り替わった → A の keep を B の行に付けない。B の行は B 自身の答えのまま', async () => {
    const bucketOf: Record<string, string> = { '/tmp/proj-a': 'koto-of-a', '/tmp/proj-b': 'koto-of-b' }
    placementImpl = async (dir: string) => ({ ok: true, placements: [{ bucket: bucketOf[dir], prefix: 'projects/x/', shared: true }] })
    let releaseA!: () => void
    const heldA = new Promise<void>(r => { releaseA = r })
    twinImpl = async (dir, args) => {
      if (dir === '/tmp/proj-a') { await heldA; return answerWith(args, { 'koto-of-a': { risk: 'twin', folders: ['clone-a'] } }) }
      return answerWith(args, {}) // B は複製なし
    }
    const v = mount('/tmp/proj-a')
    await until(() => twinCalls.length === 1, 'A の cloud:twinFacts を読まない')
    v.setProjectDir('/tmp/proj-b')
    await until(() => twinCalls.length === 2 && v.text().includes('koto-of-b'), '切り替えた B の保存場所を読み直さない')
    await settle(); await settle()
    expect(twinCalls.map(c => c.dir)).toEqual(['/tmp/proj-a', '/tmp/proj-b'])
    expect(v.text()).toContain('💾 保存場所『koto-of-b』にある、このプロジェクトのデータも削除します。')
    releaseA() // A の古い答え（複製あり）が、いま届く
    await settle(); await settle(); await settle()
    expect(v.text(), 'A の保存場所が B の画面に出た（消えるものを取り違える）').not.toContain('koto-of-a')
    expect(v.text(), 'A の keep が B に付いた').not.toContain('は残ります')
    expect(v.text()).toContain('💾 保存場所『koto-of-b』にある、このプロジェクトのデータも削除します。')
  })

  it('★★ 保存場所を用意した直後の読み直しの最中に、前の読みの古い答えが届いても、新しい一覧を上書きしない', async () => {
    let n = 0
    placementImpl = async () => {
      n++
      return { ok: true, placements: n === 1
        ? [{ bucket: 'koto-a', prefix: 'projects/x/', shared: true }]
        : [{ bucket: 'koto-a', prefix: 'projects/x/', shared: true }, { bucket: 'koto-b', prefix: 'projects/x/', shared: true }] }
    }
    let releaseFirst!: () => void
    const heldFirst = new Promise<void>(r => { releaseFirst = r })
    twinImpl = async (_dir, args, call) => {
      if (call === 1) { await heldFirst; return answerWith(args, { 'koto-a': { risk: 'twin', folders: ['stale'] } }) }
      return answerWith(args, { 'koto-b': { risk: 'twin', folders: ['clone-b'] } })
    }
    const v = mount()
    await until(() => twinCalls.length === 1, '1回目の cloud:twinFacts を読まない')
    fakeWindow.dispatchEvent(new Event('sakura:storage-prepared')) // 【公開】で保存場所を用意した直後
    await until(() => v.text().includes('koto-b') && v.text().includes('フォルダ『clone-b』'), '読み直した新しい一覧が出ない')
    expect(v.text()).toContain('💾 保存場所『koto-a』にある、このプロジェクトのデータも削除します。')
    releaseFirst() // 古い読みの答え（koto-a だけの一覧・複製あり）が、いま届く
    await settle(); await settle(); await settle()
    expect(v.text(), '古い読みの答えが新しい一覧を上書きした（koto-b が消えた）').toContain('保存場所『koto-b』とその中のデータは残ります')
    expect(v.text(), '古い読みの keep が付いた').not.toContain('フォルダ『stale』')
    expect(v.text()).toContain('💾 保存場所『koto-a』にある、このプロジェクトのデータも削除します。')
  })

  it('★★★ 保存場所の一覧の読み（storage.placement）が遅れ、読み直しの一覧が先に届いたあとで届いても、新しい一覧の 💾 の行が残る', async () => {
    let n = 0
    let releaseFirst!: () => void
    const heldFirst = new Promise<void>(r => { releaseFirst = r })
    placementImpl = async () => {
      n++
      if (n === 1) { await heldFirst; return { ok: true, placements: [{ bucket: 'koto-a', prefix: 'projects/x/', shared: true }] } } // 1回目: 古い一覧（koto-a だけ）。遅れて届く
      return { ok: true, placements: [{ bucket: 'koto-a', prefix: 'projects/x/', shared: true }, { bucket: 'koto-b', prefix: 'projects/x/', shared: true }] }
    }
    const v = mount()
    await until(() => n === 1, '1回目の storage.placement を読まない')
    fakeWindow.dispatchEvent(new Event('sakura:storage-prepared')) // 【公開】で保存場所を用意した直後の読み直し
    await until(() => v.text().includes('💾 保存場所『koto-b』'), '読み直した新しい一覧が出ない')
    expect(v.text()).toContain('💾 保存場所『koto-a』にある、このプロジェクトのデータも削除します。')
    releaseFirst() // 1回目の古い一覧が、いま届く
    await settle(); await settle(); await settle()
    expect(v.text(), '古い一覧が新しい一覧を上書きした（koto-b の 💾 の行が消えた）').toContain('💾 保存場所『koto-b』にある、このプロジェクトのデータも削除します。')
    expect(v.text()).toContain('💾 保存場所『koto-a』にある、このプロジェクトのデータも削除します。')
  })
})
