import { describe, it, expect, afterEach } from 'vitest'
import { readPublishTargets, readPublishTargetsOrThrow, readPublishTargetsWithLegacyChecked } from '../src/renderer/publishRecord'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// D-3 残作業（2026-09-15）: 専有型 'sakura-apprun-dedicated' を PublishTargetKind に足した際、
// readPublishTargets の order 配列にも並びを足した（publishRecord.ts L49）。この並びが崩れる
// （例: 専有型が末尾に落ちる・共用型の直後から外れる）と、📡 一覧・プロジェクト削除前の
// 「何が公開済みか」表示で専有型だけ欠ける／順番が変わる形の不具合を検知できないまま残る。
// 純粋なファイル読み書きなので、window.electronAPI.fs.readFile を偽物に差し替えて確かめる。

afterEach(() => {
  delete (globalThis as any).window
})

function withMeta(meta: unknown) {
  ;(globalThis as any).window = {
    electronAPI: {
      fs: {
        readFile: async () => JSON.stringify(meta),
      },
    },
  }
}

describe('readPublishTargets: order は共用型 sakura-apprun の直後に専有型 sakura-apprun-dedicated', () => {
  it('5種類すべて記録があるとき、並びは [hanamii, vercel, sakura-apprun, sakura-apprun-dedicated, sakura-rental]', async () => {
    withMeta({
      publish: {
        targets: {
          hanamii: {},
          vercel: {},
          'sakura-apprun': {},
          'sakura-apprun-dedicated': {},
          'sakura-rental': {},
        },
      },
    })
    const targets = await readPublishTargets('/tmp/proj')
    expect(targets).toEqual(['hanamii', 'vercel', 'sakura-apprun', 'sakura-apprun-dedicated', 'sakura-rental'])
  })

  it('sakura-apprun と sakura-apprun-dedicated の両方に記録があるとき、専有型は共用型の直後（間に他の種類を挟まない）', async () => {
    withMeta({
      publish: {
        targets: {
          'sakura-rental': {},
          hanamii: {},
          'sakura-apprun-dedicated': {},
          'sakura-apprun': {},
        },
      },
    })
    const targets = await readPublishTargets('/tmp/proj')
    const appRunAt = targets.indexOf('sakura-apprun')
    const dedicatedAt = targets.indexOf('sakura-apprun-dedicated')
    expect(appRunAt).toBeGreaterThanOrEqual(0)
    expect(dedicatedAt).toBe(appRunAt + 1)
  })

  it('専有型のみ記録があるときも返る（欠けない）', async () => {
    withMeta({ publish: { targets: { 'sakura-apprun-dedicated': {} } } })
    expect(await readPublishTargets('/tmp/proj')).toEqual(['sakura-apprun-dedicated'])
  })

  it('記録がファイルに無ければ空配列', async () => {
    withMeta({})
    expect(await readPublishTargets('/tmp/proj')).toEqual([])
  })

  it('ファイルが読めない（例外）ときも空配列（例外を投げない）', async () => {
    ;(globalThis as any).window = {
      electronAPI: { fs: { readFile: async () => { throw new Error('ENOENT') } } },
    }
    expect(await readPublishTargets('/tmp/proj')).toEqual([])
  })
})

// 2026-10-08 検分 A: 破壊の確認の材料（ほかの公開先）を読む口は、「読めなかった」と「記録が無い」を言い分ける。
// readPublishTargets（上）は表示の補助用に空へ倒す。readPublishTargetsOrThrow は読めなければ投げる。
describe('readPublishTargetsOrThrow: 読めなかったら投げる。読めて無ければ空配列（空に倒さない）', () => {
  const withText = (text: string) => { ;(globalThis as any).window = { electronAPI: { fs: { readFile: async () => text } } } }

  it('並びと中身は readPublishTargets と同じ（定義順・専有型は共用型の直後）', async () => {
    const meta = { publish: { targets: { 'sakura-rental': {}, hanamii: {}, 'sakura-apprun-dedicated': {}, 'sakura-apprun': {} } } }
    withMeta(meta)
    expect(await readPublishTargetsOrThrow('/tmp/proj')).toEqual(['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated', 'sakura-rental'])
    expect(await readPublishTargets('/tmp/proj')).toEqual(await readPublishTargetsOrThrow('/tmp/proj'))
  })

  it.each([
    ['記録が無い（空のオブジェクト）', {}],
    ['publish はあるが targets が無い', { publish: {} }],
    ['targets が空', { publish: { targets: {} } }],
  ])('読めて、公開先の記録が無い（%s）→ 空配列。投げない', async (_label, meta) => {
    withMeta(meta)
    expect(await readPublishTargetsOrThrow('/tmp/proj')).toEqual([])
  })

  it('ファイルを読めない（readFile が reject）→ 投げる（readPublishTargets は空配列に倒す）', async () => {
    ;(globalThis as any).window = { electronAPI: { fs: { readFile: async () => { throw new Error('ENOENT') } } } }
    await expect(readPublishTargetsOrThrow('/tmp/proj')).rejects.toThrow('ENOENT')
    expect(await readPublishTargets('/tmp/proj')).toEqual([])
  })

  it.each([
    ['壊れた JSON', '{ 壊れた'],
    ['配列', '[]'],
    ['null', 'null'],
    ['文字列', '"x"'],
    ['publish が文字列', JSON.stringify({ publish: 'x' })],
    ['publish が配列', JSON.stringify({ publish: [] })],
    ['targets が文字列', JSON.stringify({ publish: { targets: 'x' } })],
    ['targets が配列', JSON.stringify({ publish: { targets: [] } })],
  ])('読めたが形が違う／壊れている（%s）→ 投げる（readPublishTargets は空配列に倒す）', async (_label, text) => {
    withText(text)
    await expect(readPublishTargetsOrThrow('/tmp/proj')).rejects.toThrow()
    expect(await readPublishTargets('/tmp/proj')).toEqual([])
  })
})

// 2026-10-08 検分 A の双子（プロジェクト削除の確認）: 公開記録を読めなかったとき、黙って「公開は残っていない」と見せない。
// ただし .sakuraide.json が無い（まだ何も公開していない）プロジェクトは「読めなかった」ではなく「記録が無い」——偽の警告を出さない。
// 段階3A の 3A-5b: 旧い読み口 readPublishTargetsChecked（publish.targets だけを読む）は消え、旧い記録の公開先も数える新しい読み口 readPublishTargetsWithLegacyChecked に
// 一本化した。ここは、旧い読み口の場合分けを**期待は変えずに**新しい読み口へ移したもの（旧い記録の分の場合分けは tests/projectDeleteTargets.test.ts）。
// 偽の window は、パスごとにファイルを返す（tests/projectDeleteTargets.test.ts・tests/teardownFactsLegacy.test.ts の installWindow の作り）。
describe('readPublishTargetsWithLegacyChecked: プロジェクト削除の確認用。「読めなかった」と「記録が無い」を言い分ける', () => {
  const META = '/tmp/proj/.sakuraide.json'
  /** `.sakuraide.json` だけを持つ偽の window。state.json（.sakura-cloud/）は無い。`exists` が Error なら存在確認が投げる。 */
  const fake = (opts: { exists: boolean | Error; read?: () => Promise<string> }) => {
    ;(globalThis as any).window = {
      electronAPI: {
        fs: {
          exists: async (p: string) => {
            if (opts.exists instanceof Error) throw opts.exists
            return p === META ? opts.exists : false
          },
          readFile: async (p: string) => {
            // 存在確認が投げる回は、state.json も「あるとみなして」読みにいく。空の記録（旧い共用型なし）を返す
            if (p === '/tmp/proj/.sakura-cloud/state.json' && opts.exists instanceof Error) return JSON.stringify({ resources: [] })
            if (p !== META) throw new Error(`ENOENT: ${p}`)
            return (opts.read ?? (async () => '{}'))()
          },
        },
      },
    }
  }
  const check = () => readPublishTargetsWithLegacyChecked('/tmp/proj')

  it('★★★ 記録が読めて公開先がある → targets を返す（unreadable は false）', async () => {
    fake({ exists: true, read: async () => JSON.stringify({ publish: { targets: { vercel: {}, hanamii: {} } } }) })
    expect(await check()).toEqual({ targets: ['hanamii', 'vercel'], unreadable: false })
  })

  it('★★ .sakuraide.json が無い（まだ何も公開していない）→ 記録が無いだけ。unreadable は立てない（readFile は呼ばない）', async () => {
    let read = 0
    fake({ exists: false, read: async () => { read++; throw new Error('ENOENT') } })
    expect(await check()).toEqual({ targets: [], unreadable: false })
    expect(read).toBe(0)
  })

  it('★★★ ファイルがあるのに読めない（readFile が reject）→ unreadable（黙って「公開は無い」にしない）', async () => {
    fake({ exists: true, read: async () => { throw new Error('EACCES') } })
    expect(await check()).toEqual({ targets: [], unreadable: true })
  })

  it.each([
    ['壊れた JSON', '{ 壊れた'],
    ['配列', '[]'],
    ['publish が文字列', JSON.stringify({ publish: 'x' })],
    ['targets が配列', JSON.stringify({ publish: { targets: [] } })],
  ])('★★★ 読めたが壊れている／形が違う（%s）→ unreadable', async (_label, text) => {
    fake({ exists: true, read: async () => text })
    expect(await check()).toEqual({ targets: [], unreadable: true })
  })

  it('★★ 存在確認そのものが失敗したときは、ファイルがあるとみなして読みにいく（読めれば返し、読めなければ unreadable）', async () => {
    fake({ exists: new Error('IPC 失敗'), read: async () => JSON.stringify({ publish: { targets: { vercel: {} } } }) })
    expect(await check()).toEqual({ targets: ['vercel'], unreadable: false })
    fake({ exists: new Error('IPC 失敗'), read: async () => { throw new Error('EACCES') } })
    expect(await check()).toEqual({ targets: [], unreadable: true })
  })

  it('読めて記録が空（公開先が無い）→ 空で unreadable ではない', async () => {
    fake({ exists: true, read: async () => JSON.stringify({ publish: { targets: {} } }) })
    expect(await check()).toEqual({ targets: [], unreadable: false })
  })
})

describe('プロジェクト削除の確認（ProjectDeleteDialog。段階3A・3A-5a で Sidebar から移した）: 公開記録を読めなかったら注意を出す。読めない記録を黙って [] にしない', () => {
  const code = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n')
  const dialog = code('src/renderer/components/ProjectDeleteDialog.tsx')
  const sidebar = code('src/renderer/components/Sidebar.tsx')
  const facts = code('src/renderer/teardown/projectDeleteFacts.ts')

  it('★★★ 確認ダイアログを開くたびの読みは、材料を読む関数（readProjectDeleteFacts）の 1 回。その関数は旧い記録も数える読み口 readPublishTargetsWithLegacyChecked を通る。空に倒す readPublishTargets には戻らない', () => {
    expect(dialog).toContain('readProjectDeleteFacts(projectDir)')
    expect(dialog).toContain('.then(f => { if (!cancelled) setFacts(f) })')
    expect(dialog).not.toContain('readPublishTargets(')
    expect(dialog).not.toMatch(/from '..\/publishRecord'/)
    expect(facts).toContain('const read = await readPublishTargetsWithLegacyChecked(dir)')
    expect(facts).toContain('const targets = read.targets')
    expect(facts).toContain('let unreadable = read.unreadable')
    expect(facts).not.toMatch(/\breadPublishTargets\(/)
    // 読みは Sidebar ではなくダイアログがする（Sidebar は公開の記録を読まない）
    expect(sidebar).not.toContain('readPublishTargetsWithLegacyChecked')
    expect(sidebar).not.toContain('readProjectDeleteFacts')
  })

  it('★★★ 注意は「読めなかったとき」だけ出す（facts.unreadable &&）。注意の箱も、それだけのときに出る', () => {
    expect(dialog).toContain('{facts.unreadable && (')
    expect(dialog).toContain('⚠️ {PUBLISH_RECORD_UNREADABLE_NOTE}')
    expect(dialog).toContain("(shownTargets.length > 0 || facts.unreadable || plan.block !== null || leftoverNote !== '') && (")
    // ダイアログを閉じたとき・別のプロジェクトを開いたときに、前の注意を引きずらない: Sidebar が key で作り直す（状態を持ち越さない）
    expect(sidebar).toMatch(/<ProjectDeleteDialog\s+key=\{confirmProjDelete\}/)
  })

  it('注意の文: 公開の記録の 2 つの場所（.sakuraide.json・.sakura-cloud/）を言い、公開が残っているか分からないこと・あとから Koto で破棄できなくなること・確かめる場所を言う', async () => {
    const { PUBLISH_RECORD_UNREADABLE_NOTE: note } = await import('../src/renderer/teardown/projectDeletePlan')
    expect(note).toContain('公開の記録（.sakuraide.json・.sakura-cloud/）を読めないため、公開が残っているか分かりません')
    expect(note).toContain('あとから Koto では破棄できなくなります')
    expect(note).toContain('確かめてから削除してください')
    // 記録が読めないときに答えを出せない場所（【公開】の画面）を、確かめる先に挙げない（検分2巡目）
    expect(note).toContain('『調べる』を押すか')
    expect(note).not.toContain('【公開】の画面や各サービスの管理画面で')
  })

  it('★★ 旧い読み口 readPublishTargetsChecked は src に無い（使い手が無くなったので消した）', async () => {
    const mod = await import('../src/renderer/publishRecord')
    expect('readPublishTargetsChecked' in mod).toBe(false)
    expect('readPublishTargetsWithLegacyChecked' in mod).toBe(true)
  })
})
