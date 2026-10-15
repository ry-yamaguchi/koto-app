import { describe, it, expect, afterEach } from 'vitest'
import { readPublishTargets, readPublishTargetsOrThrow, readPublishTargetsChecked } from '../src/renderer/publishRecord'
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
describe('readPublishTargetsChecked: プロジェクト削除の確認用。「読めなかった」と「記録が無い」を言い分ける', () => {
  const fake = (opts: { exists: boolean | Error; read?: () => Promise<string> }) => {
    ;(globalThis as any).window = {
      electronAPI: {
        fs: {
          exists: async () => { if (opts.exists instanceof Error) throw opts.exists; return opts.exists },
          readFile: opts.read ?? (async () => '{}'),
        },
      },
    }
  }

  it('★★★ 記録が読めて公開先がある → targets を返す（unreadable は false）', async () => {
    fake({ exists: true, read: async () => JSON.stringify({ publish: { targets: { vercel: {}, hanamii: {} } } }) })
    expect(await readPublishTargetsChecked('/tmp/proj')).toEqual({ targets: ['hanamii', 'vercel'], unreadable: false })
  })

  it('★★ .sakuraide.json が無い（まだ何も公開していない）→ 記録が無いだけ。unreadable は立てない（readFile は呼ばない）', async () => {
    let read = 0
    fake({ exists: false, read: async () => { read++; throw new Error('ENOENT') } })
    expect(await readPublishTargetsChecked('/tmp/proj')).toEqual({ targets: [], unreadable: false })
    expect(read).toBe(0)
  })

  it('★★★ ファイルがあるのに読めない（readFile が reject）→ unreadable（黙って「公開は無い」にしない）', async () => {
    fake({ exists: true, read: async () => { throw new Error('EACCES') } })
    expect(await readPublishTargetsChecked('/tmp/proj')).toEqual({ targets: [], unreadable: true })
  })

  it.each([
    ['壊れた JSON', '{ 壊れた'],
    ['配列', '[]'],
    ['publish が文字列', JSON.stringify({ publish: 'x' })],
    ['targets が配列', JSON.stringify({ publish: { targets: [] } })],
  ])('★★★ 読めたが壊れている／形が違う（%s）→ unreadable', async (_label, text) => {
    fake({ exists: true, read: async () => text })
    expect(await readPublishTargetsChecked('/tmp/proj')).toEqual({ targets: [], unreadable: true })
  })

  it('★★ 存在確認そのものが失敗したときは、ファイルがあるとみなして読みにいく（読めれば返し、読めなければ unreadable）', async () => {
    fake({ exists: new Error('IPC 失敗'), read: async () => JSON.stringify({ publish: { targets: { vercel: {} } } }) })
    expect(await readPublishTargetsChecked('/tmp/proj')).toEqual({ targets: ['vercel'], unreadable: false })
    fake({ exists: new Error('IPC 失敗'), read: async () => { throw new Error('EACCES') } })
    expect(await readPublishTargetsChecked('/tmp/proj')).toEqual({ targets: [], unreadable: true })
  })

  it('読めて記録が空（公開先が無い）→ 空で unreadable ではない', async () => {
    fake({ exists: true, read: async () => JSON.stringify({ publish: { targets: {} } }) })
    expect(await readPublishTargetsChecked('/tmp/proj')).toEqual({ targets: [], unreadable: false })
  })
})

describe('プロジェクト削除の確認（Sidebar）: 公開記録を読めなかったら注意を出す。読めない記録を黙って [] にしない', () => {
  const code = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n')
  const sidebar = code('src/renderer/components/Sidebar.tsx')

  it('★★★ 確認ダイアログを開くたびの読みは readPublishTargetsChecked。空に倒す readPublishTargets に戻らない', () => {
    expect(sidebar).toContain('readPublishTargetsChecked(confirmProjDelete).then(r => {')
    expect(sidebar).toContain('setPendingPublish(r.targets)')
    expect(sidebar).toContain('setPublishUnreadable(r.unreadable)')
    expect(sidebar).not.toContain('readPublishTargets(confirmProjDelete)')
    expect(sidebar).not.toMatch(/import \{[^}]*\breadPublishTargets\b[^}]*\} from '..\/publishRecord'/)
  })

  it('★★★ 注意は「読めなかったとき」だけ出す（publishUnreadable &&）。注意の箱も、それだけのときに出る', () => {
    expect(sidebar).toContain('{publishUnreadable && (')
    expect(sidebar).toContain('⚠️ {PUBLISH_RECORD_UNREADABLE_NOTE}')
    expect(sidebar).toContain('(pendingPublish.length > 0 || publishUnreadable || blocksProjectDeleteFor(pendingPublish, pendingDedicated)) && (')
    // ダイアログを閉じたとき・別のプロジェクトを開いたときに、前の注意を引きずらない
    expect(sidebar).toContain('setPendingPublish([]); setPublishUnreadable(false);')
    expect(sidebar).toContain('setPublishUnreadable(false) // 同上')
  })

  it('注意の文: 公開が残っているか分からないこと・あとから Koto で破棄できなくなること・確かめる場所を言う', async () => {
    const { PUBLISH_RECORD_UNREADABLE_NOTE: note } = await import('../src/renderer/components/Sidebar')
    expect(note).toContain('公開の記録（.sakuraide.json）を読めないため、公開が残っているか分かりません')
    expect(note).toContain('あとから Koto では破棄できなくなります')
    expect(note).toContain('確かめてから削除してください')
    // 記録が読めないときに答えを出せない場所（【公開】の画面）を、確かめる先に挙げない（検分2巡目）
    expect(note).toContain('『調べる』を押すか')
    expect(note).not.toContain('【公開】の画面や各サービスの管理画面で')
  })
})
