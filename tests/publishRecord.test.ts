import { describe, it, expect, afterEach } from 'vitest'
import { readPublishTargets } from '../src/renderer/publishRecord'

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
