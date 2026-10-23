import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 段階3A（3A-4a）: プロジェクトの削除が使う、公開先の読み口。設計書 docs/teardown-unify-plan.md の 10.9.4 の(1)・10.9.13 の「読み口」─────
//
//   readPublishTargetsWithLegacyChecked … 投げない。旧い記録だけの公開先（HANAMII の projectId だけ・共用型の state.json だけ・専有型の ID だけ）も数える。
//                                          読めなかったことは unreadable で返し、**読めた分は落とさない**
//   readPublishTargetsWithLegacyOrThrow … 確認の材料の読み口。同じ内部関数を通る（同じ判断を2つ書かない）
// 親の判断 G=1（2026-10-12）: .sakuraide.json が「無い」のは、記録が無いだけ（読めなかったことにしない）。
// 偽の window は、パスごとにファイルを返す（tests/teardownFactsLegacy.test.ts の installWindow の作り）。

import {
  readPublishTargetsWithLegacyChecked, readPublishTargetsWithLegacyOrThrow, readPublishTargetsOrThrow,
} from '../src/renderer/publishRecord'

afterEach(() => { delete (globalThis as any).window })

type Files = Record<string, string | Error>
/** 偽の window。`files` に無いパスは ENOENT で投げる。`exists` は既定でファイルの有無。読んだパスと exists を聞かれたパスを記録する。 */
function installWindow(files: Files, over: { exists?: (p: string) => Promise<unknown> } = {}) {
  const read: string[] = []
  const asked: string[] = []
  ;(globalThis as any).window = {
    electronAPI: {
      fs: {
        readFile: async (p: string) => {
          read.push(p)
          const v = files[p]
          if (v === undefined) throw new Error(`ENOENT: ${p}`)
          if (v instanceof Error) throw v
          return v
        },
        exists: async (p: string) => { asked.push(p); return over.exists ? over.exists(p) : p in files },
      },
    },
  }
  return { read, asked }
}

const META = '/proj/.sakuraide.json'
const STATE = '/proj/.sakura-cloud/state.json'
const meta = (publish: unknown) => JSON.stringify({ name: 'myapp', publish })
const state = (s: unknown) => JSON.stringify(s)
const t = (...kinds: string[]) => Object.fromEntries(kinds.map(k => [k, { publishedAt: '2026-10-01T00:00:00.000Z' }]))
const STATE_WITH_APP = { resources: [{ kind: 'apprun-app', id: 'app-1' }] }
const STATE_WITHOUT_APP = { resources: [{ kind: 'bucket', id: 'koto-a' }] }
const check = () => readPublishTargetsWithLegacyChecked('/proj')

describe('readPublishTargetsWithLegacyChecked: 記録が読めた回', () => {
  it('★★★ .sakuraide.json が無い＋state.json に apprun-app → 共用型・unreadable は立てない（G=1）。readFile は state.json だけ', async () => {
    const w = installWindow({ [STATE]: state(STATE_WITH_APP) })
    expect(await check()).toEqual({ targets: ['sakura-apprun'], unreadable: false })
    expect(w.read).toEqual([STATE])
  })

  it('★★★ どちらも無い → 空・unreadable は立てない（まだ何も公開していないプロジェクトに偽の注意を出さない）。readFile は1回も呼ばない', async () => {
    const w = installWindow({})
    expect(await check()).toEqual({ targets: [], unreadable: false })
    expect(w.read).toEqual([])
  })

  it('.sakuraide.json が無く、state.json に apprun-app が無い → 空・false', async () => {
    installWindow({ [STATE]: state(STATE_WITHOUT_APP) })
    expect(await check()).toEqual({ targets: [], unreadable: false })
  })

  it('★★★ publish.targets の公開先を定義順で返す。state.json が無ければ旧い共用型は数えない', async () => {
    const w = installWindow({ [META]: meta({ targets: t('vercel', 'hanamii') }) })
    expect(await check()).toEqual({ targets: ['hanamii', 'vercel'], unreadable: false })
    expect(w.read).toEqual([META])
  })

  it('★★★ 旧い記録だけの公開先を数える（D9=2）: targets に行が無い HANAMII（projectId）・専有型（ID）・共用型（state.json の apprun-app）', async () => {
    installWindow({ [META]: meta({ hanamii: { projectId: 'prj-1' } }) })
    expect(await check()).toEqual({ targets: ['hanamii'], unreadable: false })
    installWindow({ [META]: meta({ apprunDedicated: { clusterID: 'c-1' } }) })
    expect(await check()).toEqual({ targets: ['sakura-apprun-dedicated'], unreadable: false })
    installWindow({
      [META]: meta({ targets: t('sakura-rental'), hanamii: { projectId: 'prj-1' }, apprunDedicated: { applicationID: 'a-1' } }),
      [STATE]: state(STATE_WITH_APP),
    })
    expect(await check()).toEqual({ targets: ['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated', 'sakura-rental'], unreadable: false })
  })

  it('記録が空（公開先が無い）→ 空・unreadable ではない', async () => {
    installWindow({ [META]: meta({ targets: {} }) })
    expect(await check()).toEqual({ targets: [], unreadable: false })
  })
})

describe('readPublishTargetsWithLegacyChecked: 読めなかった回', () => {
  it('★★★ ある＋hanamii.projectId だけ＋state.json が壊れている → HANAMII は数える・unreadable は立つ（読めた分は破棄する）', async () => {
    installWindow({ [META]: meta({ hanamii: { projectId: 'prj-1' } }), [STATE]: '{ 壊れた' })
    expect(await check()).toEqual({ targets: ['hanamii'], unreadable: true })
  })

  it('★★★ ある＋publish.targets に hanamii・vercel＋state.json が読めない → その2つ・unreadable。専有型の ID だけの行も落とさない', async () => {
    installWindow({ [META]: meta({ targets: t('hanamii', 'vercel') }), [STATE]: new Error('EACCES') })
    expect(await check()).toEqual({ targets: ['hanamii', 'vercel'], unreadable: true })
    installWindow({ [META]: meta({ apprunDedicated: { loadBalancerID: 'lb-1' } }), [STATE]: '[' })
    expect(await check()).toEqual({ targets: ['sakura-apprun-dedicated'], unreadable: true })
  })

  it('★★★ .sakuraide.json が無い＋state.json が壊れている → 空・unreadable（旧い共用型を数えられなかった）', async () => {
    installWindow({ [STATE]: '{ 壊れた' })
    expect(await check()).toEqual({ targets: [], unreadable: true })
  })

  it.each([
    ['読めない（readFile が reject）', new Error('EACCES') as string | Error],
    ['壊れた JSON', '{ 壊れた'],
    ['配列', '[]'],
    ['文字列', '"x"'],
    ['publish が文字列', JSON.stringify({ publish: 'x' })],
    ['targets が配列', JSON.stringify({ publish: { targets: [] } })],
  ])('★★★ .sakuraide.json が %s → 空・unreadable。state.json には進まない', async (_label, content) => {
    const w = installWindow({ [META]: content, [STATE]: state(STATE_WITH_APP) })
    expect(await check()).toEqual({ targets: [], unreadable: true })
    expect(w.read.includes(STATE)).toBe(false)
    expect(w.asked.includes(STATE)).toBe(false)
  })

  it('★★ exists が投げたら、あるとみなして読みにいく（読めれば返し、読めなければ unreadable）', async () => {
    const boom = { exists: async () => { throw new Error('IPC 失敗') } }
    installWindow({ [META]: meta({ targets: t('vercel') }), [STATE]: state(STATE_WITH_APP) }, boom)
    expect(await check()).toEqual({ targets: ['vercel', 'sakura-apprun'], unreadable: false })
    installWindow({ [STATE]: state(STATE_WITH_APP) }, boom)
    expect(await check()).toEqual({ targets: [], unreadable: true })
    installWindow({ [META]: new Error('EACCES') }, boom)
    expect(await check()).toEqual({ targets: [], unreadable: true })
  })

  it('exists が true／false 以外（undefined）を返したら、.sakuraide.json は読みにいき、state.json は無いとみなす（exists を持たない偽物でも落ちない）', async () => {
    const w = installWindow({ [META]: meta({ targets: t('hanamii') }), [STATE]: state(STATE_WITH_APP) }, { exists: async () => undefined })
    expect(await check()).toEqual({ targets: ['hanamii'], unreadable: false })
    expect(w.read).toEqual([META])
  })

  it('★★ 投げない: window も fs も無くても { 空・unreadable } を返す', async () => {
    delete (globalThis as any).window
    expect(await check()).toEqual({ targets: [], unreadable: true })
    ;(globalThis as any).window = { electronAPI: {} }
    expect(await check()).toEqual({ targets: [], unreadable: true })
    // exists を持たない偽物: 聞けないので、どちらのファイルもあるとみなして読みにいく。state.json が読めなければ unreadable（読めた分は残す）
    ;(globalThis as any).window = { electronAPI: { fs: { readFile: async (p: string) => { if (p === META) return meta({ targets: t('vercel') }); throw new Error('ENOENT') } } } }
    expect(await check()).toEqual({ targets: ['vercel'], unreadable: true })
  })
})

// 2つの読み口が同じ内部関数を通る（同じ判断を2つ書かない）: OrThrow が答えを返す回は Checked も同じ答えで unreadable でなく、OrThrow が投げる回は Checked が unreadable。
describe('readPublishTargetsWithLegacyOrThrow と同じ判断（同じ内部関数）', () => {
  const CASES: Array<[string, Files, Parameters<typeof installWindow>[1]?]> = [
    ['どちらも無い', {}],
    ['.sakuraide.json だけ', { [META]: meta({ targets: t('vercel', 'hanamii') }) }],
    ['.sakuraide.json が無く state.json に apprun-app', { [STATE]: state(STATE_WITH_APP) }],
    ['両方・全部', { [META]: meta({ targets: t('sakura-rental'), hanamii: { projectId: 'p' }, apprunDedicated: { asgID: 'a' } }), [STATE]: state(STATE_WITH_APP) }],
    ['state.json が壊れている', { [META]: meta({ hanamii: { projectId: 'p' } }), [STATE]: '{ 壊れた' }],
    ['state.json が読めない', { [META]: meta({}), [STATE]: new Error('EACCES') }],
    ['.sakuraide.json が壊れている', { [META]: '{ 壊れた', [STATE]: state(STATE_WITH_APP) }],
    ['.sakuraide.json が読めない', { [META]: new Error('EACCES') }],
    ['.sakuraide.json の形が違う', { [META]: meta('x'), [STATE]: state(STATE_WITH_APP) }],
    ['exists が投げる＋両方ある', { [META]: meta({ targets: t('vercel') }), [STATE]: state(STATE_WITH_APP) }, { exists: async () => { throw new Error('x') } }],
  ]
  it.each(CASES)('%s', async (_label, files, over) => {
    installWindow(files, over)
    let thrown = false
    let targets: unknown = null
    try { targets = await readPublishTargetsWithLegacyOrThrow('/proj') } catch { thrown = true }
    installWindow(files, over)
    const checked = await check()
    if (thrown) expect(checked.unreadable).toBe(true)
    else expect(checked).toEqual({ targets, unreadable: false })
  })

  it('★★★ state.json が壊れた回、OrThrow は投げ、Checked は読めた分を返す（落ちるのは旧い共用型だけ）', async () => {
    installWindow({ [META]: meta({ hanamii: { projectId: 'p' } }), [STATE]: '{ 壊れた' })
    await expect(readPublishTargetsWithLegacyOrThrow('/proj')).rejects.toThrow()
    expect((await check()).targets).toEqual(['hanamii'])
  })

  it('★★ G=1 は OrThrow にも効く（.sakuraide.json が無くても投げない）。readPublishTargetsOrThrow（readPublishTargets が使う）は今までどおり投げる', async () => {
    installWindow({ [STATE]: state(STATE_WITH_APP) })
    expect(await readPublishTargetsWithLegacyOrThrow('/proj')).toEqual(['sakura-apprun'])
    await expect(readPublishTargetsOrThrow('/proj')).rejects.toThrow()
  })
})

// 旧い読み口（publish.targets だけを読んでいた readPublishTargetsChecked）は 3A-5b で消えた。「新しい読み口の答えは旧い読み口の答えを減らさない」は、
// 旧い読み口の場合分け（公開先がある・記録が空・.sakuraide.json が無い・壊れている・読めない・存在確認が投げる）を同じ期待で新しい読み口へ移した
// tests/publishRecord.test.ts の describe（readPublishTargetsWithLegacyChecked）が持つ。
describe('旧い読み口は無い', () => {
  it('★ readPublishTargetsChecked は publishRecord.ts から消えた。読み口は readPublishTargetsWithLegacyChecked の 1 つ', async () => {
    const mod = await import('../src/renderer/publishRecord')
    expect('readPublishTargetsChecked' in mod).toBe(false)
  })
})

describe('配線: publishRecord.ts', () => {
  const src = readFileSync(join(__dirname, '..', 'src/renderer/publishRecord.ts'), 'utf-8')
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n')

  it('★★★ 2つの読み口は、どちらも内部関数 readPublishRecordParts を通る。自分で readFile を呼ばない', () => {
    const body = (name: string) => code.slice(code.indexOf(`export async function ${name}`)).split(/\n}\n/)[0]
    for (const name of ['readPublishTargetsWithLegacyOrThrow', 'readPublishTargetsWithLegacyChecked']) {
      const b = body(name)
      expect(b, name).toContain('await readPublishRecordParts(projectDir)')
      expect(b, name).not.toContain('readFile')
    }
  })

  it('readPublishTargetsOrThrow（readPublishTargets が使う）の本文は、exists を聞かず、readFile → parse → 形の確認', () => {
    const b = code.slice(code.indexOf('export async function readPublishTargetsOrThrow')).split(/\n}\n/)[0]
    expect(b).toContain('const meta = JSON.parse(await window.electronAPI.fs.readFile(metaPath(projectDir)))')
    expect(b).toContain('const targets = parsePublishTargets(meta)')
    expect(b).toContain("if (targets === null) throw new Error('公開の記録の形を読めませんでした')")
    expect(b).not.toContain('exists')
  })
})
