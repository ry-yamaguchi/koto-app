import { describe, it, expect } from 'vitest'
import {
  withPublishRecord, withPendingPublish, withoutPendingPublish, withHanamiiProjectId,
  withApprunDedicatedRecord,
} from '../src/shared/publishMeta'

// roadmap #20: `.sakuraide.json` の publish 部分をマージ書き込みする純関数の対テスト（掟10）。
// renderer（各公開パネル）と main（src/main/publishMetaFs.ts）の両方がこれを使う一元定義。
// electron/node組み込み非依存の純粋関数のみを対象にする（tests/appChatDirs.test.ts が
// src/shared 全体に「node組み込みを import しない」ことを別途固定している）。

describe('withPublishRecord: publish.targets[target] にだけ差し込み、他は保つ', () => {
  it('★★ 他ターゲットの記録・hanamii.projectId・pending・publish以外のトップレベルキーを消さない', () => {
    const meta = {
      name: 'my-app', // publish 以外のトップレベルキー
      target: 'hanamii',
      publish: {
        targets: {
          vercel: { publishedAt: '2026-01-01T00:00:00.000Z', url: 'https://v.example.com' },
        },
        hanamii: { projectId: 'proj-1', workspaceId: 'ws-1' },
        pending: { target: 'hanamii', startedAt: '2026-01-01T00:00:00.000Z' },
      },
    }
    const next = withPublishRecord(meta, 'hanamii', { publishedAt: '2026-02-02T00:00:00.000Z', url: null })

    expect(next.name).toBe('my-app')
    expect(next.target).toBe('hanamii')
    const publish = next.publish as any
    // 新しい記録が入る
    expect(publish.targets.hanamii).toEqual({ publishedAt: '2026-02-02T00:00:00.000Z', url: null })
    // 他ターゲットの記録は残る
    expect(publish.targets.vercel).toEqual({ publishedAt: '2026-01-01T00:00:00.000Z', url: 'https://v.example.com' })
    // hanamii.projectId（別のキー・publish.hanamii）は消えない
    expect(publish.hanamii).toEqual({ projectId: 'proj-1', workspaceId: 'ws-1' })
    // pending も消えない
    expect(publish.pending).toEqual({ target: 'hanamii', startedAt: '2026-01-01T00:00:00.000Z' })
  })

  it('既存の targets が無い（新規プロジェクト）meta でも記録できる', () => {
    const next = withPublishRecord({}, 'vercel', { publishedAt: '2026-03-03T00:00:00.000Z', url: 'https://x.vercel.app' })
    expect((next.publish as any).targets.vercel).toEqual({ publishedAt: '2026-03-03T00:00:00.000Z', url: 'https://x.vercel.app' })
  })

  it('同じターゲットへの2回目の記録は上書きする（古い日時が残らない）', () => {
    const first = withPublishRecord({}, 'sakura-apprun', { publishedAt: '2026-01-01T00:00:00.000Z', url: null })
    const second = withPublishRecord(first, 'sakura-apprun', { publishedAt: '2026-01-02T00:00:00.000Z', url: 'https://app.example.com' })
    expect((second.publish as any).targets['sakura-apprun']).toEqual({ publishedAt: '2026-01-02T00:00:00.000Z', url: 'https://app.example.com' })
  })
})

describe('withPendingPublish / withoutPendingPublish: 開始マーカーの書き/消し', () => {
  it('pending を書く。publish の他のキー（targets 等）は保つ', () => {
    const meta = { publish: { targets: { hanamii: { publishedAt: null, url: null } } } }
    const next = withPendingPublish(meta, 'vercel', '2026-05-05T00:00:00.000Z')
    const publish = next.publish as any
    expect(publish.pending).toEqual({ target: 'vercel', startedAt: '2026-05-05T00:00:00.000Z' })
    expect(publish.targets.hanamii).toEqual({ publishedAt: null, url: null })
  })

  it('pending を消す。publish の他のキーは保つ', () => {
    const meta = {
      publish: {
        pending: { target: 'vercel', startedAt: '2026-05-05T00:00:00.000Z' },
        targets: { hanamii: { publishedAt: null, url: null } },
      },
    }
    const next = withoutPendingPublish(meta)
    const publish = next.publish as any
    expect('pending' in publish).toBe(false)
    expect(publish.targets.hanamii).toEqual({ publishedAt: null, url: null })
  })

  it('pending が無ければ withoutPendingPublish は何も変えずそのまま返す', () => {
    const meta = { publish: { targets: { hanamii: { publishedAt: null, url: null } } } }
    const next = withoutPendingPublish(meta)
    expect(next).toEqual(meta)
  })

  it('★ pending を書いてすぐ消す往復で、書く前の状態に戻る（他キーの副作用が無い）', () => {
    const meta = { name: 'proj', publish: { targets: { hanamii: { publishedAt: null, url: null } } } }
    const round = withoutPendingPublish(withPendingPublish(meta, 'hanamii', '2026-01-01T00:00:00.000Z'))
    expect(round).toEqual(meta)
  })
})

describe('withHanamiiProjectId: HANAMII の projectId を保つ/更新する', () => {
  it('projectId を新規に設定する。publish.hanamii の他のキーは保つ', () => {
    const meta = { publish: { hanamii: { workspaceId: 'ws-1', envs: [{ key: 'A', value: '1', secret: false }] } } }
    const next = withHanamiiProjectId(meta, 'proj-123')
    const hanamii = (next.publish as any).hanamii
    expect(hanamii.projectId).toBe('proj-123')
    expect(hanamii.workspaceId).toBe('ws-1')
    expect(hanamii.envs).toEqual([{ key: 'A', value: '1', secret: false }])
  })

  it('既存の projectId を新しいものへ更新する（再公開）', () => {
    const meta = { publish: { hanamii: { projectId: 'old-id' } } }
    const next = withHanamiiProjectId(meta, 'new-id')
    expect((next.publish as any).hanamii.projectId).toBe('new-id')
  })

  it('null で projectId を消せる', () => {
    const meta = { publish: { hanamii: { projectId: 'old-id', workspaceId: 'ws-1' } } }
    const next = withHanamiiProjectId(meta, null)
    const hanamii = (next.publish as any).hanamii
    expect(hanamii.projectId).toBeNull()
    expect(hanamii.workspaceId).toBe('ws-1')
  })
})

describe('withApprunDedicatedRecord: publish.apprunDedicated にだけ差し込み、他は保つ（roadmap #23 段階②）', () => {
  it('★★ 既存の servicePrincipalId・consentedAt・他の publish.* キーを消さない', () => {
    const meta = {
      target: 'sakura-apprun-dedicated',
      publish: {
        targets: { vercel: { publishedAt: '2026-01-01T00:00:00.000Z', url: 'https://v.example.com' } },
        apprunDedicated: { servicePrincipalId: '113800956789', consentedAt: '2026-08-01T00:00:00.000Z' },
      },
    }
    const next = withApprunDedicatedRecord(meta, { clusterID: 'cluster-x' })
    const rec = (next.publish as any).apprunDedicated
    expect(rec.clusterID).toBe('cluster-x')
    expect(rec.servicePrincipalId).toBe('113800956789')
    expect(rec.consentedAt).toBe('2026-08-01T00:00:00.000Z')
    expect((next.publish as any).targets.vercel).toEqual({ publishedAt: '2026-01-01T00:00:00.000Z', url: 'https://v.example.com' })
  })

  it('既存の apprunDedicated が無い（新規プロジェクト）meta でも記録できる', () => {
    const next = withApprunDedicatedRecord({}, { consentedAt: '2026-09-01T00:00:00.000Z' })
    expect((next.publish as any).apprunDedicated).toEqual({ consentedAt: '2026-09-01T00:00:00.000Z' })
  })

  it('段階的に呼ぶと積み上がる（クラスタ→ASG→LBの順に記録する使い方）', () => {
    let meta: unknown = withApprunDedicatedRecord({}, { consentedAt: '2026-09-01T00:00:00.000Z' })
    meta = withApprunDedicatedRecord(meta, { clusterID: 'c1', name: 'myapp' })
    meta = withApprunDedicatedRecord(meta, { asgID: 'a1' })
    meta = withApprunDedicatedRecord(meta, { loadBalancerID: 'l1' })
    const rec = (meta as any).publish.apprunDedicated
    expect(rec).toEqual({ consentedAt: '2026-09-01T00:00:00.000Z', clusterID: 'c1', name: 'myapp', asgID: 'a1', loadBalancerID: 'l1' })
  })

  it('null を渡すと該当フィールドを消せる（破棄で消せたIDをクリアする使い方）', () => {
    const meta = { publish: { apprunDedicated: { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1' } } }
    const next = withApprunDedicatedRecord(meta, { loadBalancerID: null })
    const rec = (next.publish as any).apprunDedicated
    expect(rec.loadBalancerID).toBeNull()
    expect(rec.asgID).toBe('a1')
    expect(rec.clusterID).toBe('c1')
  })
})

describe('壊れた/nullな入力でも落ちない（空オブジェクト扱い）', () => {
  const target = 'hanamii' as const
  const rec = { publishedAt: '2026-01-01T00:00:00.000Z', url: null }

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['文字列（壊れたJSONをparseできず catch した先で渡るような値ではないが、念のため）', 'not-an-object'],
    ['数値', 42],
    ['配列', [1, 2, 3]],
    ['publish が配列', { publish: [1, 2, 3] }],
    ['publish が文字列', { publish: 'oops' }],
    ['publish.targets が壊れている', { publish: { targets: 'oops' } }],
    ['publish.hanamii が壊れている', { publish: { hanamii: 'oops' } }],
    ['publish.apprunDedicated が壊れている', { publish: { apprunDedicated: 'oops' } }],
  ])('meta = %s でも例外を投げない', (_label, meta) => {
    expect(() => withPublishRecord(meta, target, rec)).not.toThrow()
    expect(() => withPendingPublish(meta, target, '2026-01-01T00:00:00.000Z')).not.toThrow()
    expect(() => withoutPendingPublish(meta)).not.toThrow()
    expect(() => withHanamiiProjectId(meta, 'proj-1')).not.toThrow()
    expect(() => withApprunDedicatedRecord(meta, { clusterID: 'c1' })).not.toThrow()
  })

  it('null を渡すと、空オブジェクトから組み立てた結果が返る', () => {
    const next = withPublishRecord(null, target, rec)
    expect(next).toEqual({ publish: { targets: { hanamii: rec } } })
  })

  it('undefined を渡しても同様', () => {
    const next = withPendingPublish(undefined, 'vercel', '2026-01-01T00:00:00.000Z')
    expect(next).toEqual({ publish: { pending: { target: 'vercel', startedAt: '2026-01-01T00:00:00.000Z' } } })
  })

  it('publish が配列など想定外の形でも、壊れた部分だけ空扱いにして組み立てる', () => {
    const next = withHanamiiProjectId({ name: 'x', publish: [1, 2, 3] }, 'proj-1')
    expect(next).toEqual({ name: 'x', publish: { hanamii: { projectId: 'proj-1' } } })
  })
})
