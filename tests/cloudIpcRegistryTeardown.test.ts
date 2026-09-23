import { describe, it, expect } from 'vitest'
import { teardownRegistry, readContainerRegistryList } from '../src/main/ipc/cloud'

// ── B（2026-09-16 の検分）: 破棄でレジストリ一覧の取得に失敗すると、黙って「完了」になる ──
// 一覧の取得が失敗（HTTP 4xx/5xx）しても、例外（通信断・時間切れ）が起きても、直す前は
// `extraExecuted` に1行も積まれなかった。画面は緑の「✅ 完了しました」を出し、残っている
// レジストリのことは何も言わない＝月額220円が止まらない。すぐ隣の行（削除そのものの失敗）は
// `※ …削除に失敗（HTTP …）` と伝えており、一覧の失敗と例外だけが黙っているという非対称があった。
//
// 判断は `teardownRegistry`（cloud.ts）に集約した。**偽 client に流し、振る舞いで固定する**
// （掟10・ソースの文字列を grep するだけのテストにしない）。

const REGION = 'is1a'
const NAME = 'my-app-registry'

function commonServiceItems(rows: Array<{ id: string; subdomainLabel: string }>) {
  return {
    CommonServiceItems: rows.map(r => ({
      ID: r.id,
      Provider: { Class: 'containerregistry' },
      Status: { registry_name: r.subdomainLabel },
    })),
  }
}

describe('cloud.ts: readContainerRegistryList（B-2・「読めなかった」と「読めて0件」を区別する）', () => {
  it('★ 正しい形（CommonServiceItems が配列）なら、中身を取り出す', () => {
    const data = commonServiceItems([{ id: '111', subdomainLabel: NAME }])
    expect(readContainerRegistryList(data)).toEqual([{ id: '111', subdomainLabel: NAME }])
  })

  it('★★ 正しい形で0件のときは、読めた上での空配列（null にしない）', () => {
    const data = commonServiceItems([])
    expect(readContainerRegistryList(data)).toEqual([])
  })

  it('★★★ 200 でも形が読めない応答（JSON でない生テキスト・null・配列そのもの）は null（0件と区別する）', () => {
    expect(readContainerRegistryList('not json' as unknown)).toBeNull()
    expect(readContainerRegistryList(null)).toBeNull()
    expect(readContainerRegistryList([])).toBeNull()
    expect(readContainerRegistryList({})).toBeNull()
    expect(readContainerRegistryList({ CommonServiceItems: 'oops' })).toBeNull()
  })
})

describe('cloud.ts: teardownRegistry（B・偽 client で振る舞いを固定）', () => {
  it('★★★ 一覧が HTTP 500 のとき、警告の1行が返る。registryDeleted は立てない（記録に名前を残す）', async () => {
    const client = {
      listContainerRegistries: async () => ({ dryRun: false as const, ok: false, status: 500, data: null }),
      deleteContainerRegistry: async () => ({ dryRun: false as const, ok: true, status: 204, data: null }),
    }
    const r = await teardownRegistry(client, REGION, NAME)
    expect(r.registryDeleted).toBe(false)
    expect(r.note).toContain(NAME)
    expect(r.note).toContain('削除できたか確認できませんでした')
    expect(r.note).toContain('500')
  })

  it('★★★ 一覧の取得で例外が出たとき、警告の1行が返る。registryDeleted は立てない', async () => {
    const client = {
      listContainerRegistries: async () => { throw new Error('ECONNRESET') },
      deleteContainerRegistry: async () => ({ dryRun: false as const, ok: true, status: 204, data: null }),
    }
    const r = await teardownRegistry(client, REGION, NAME)
    expect(r.registryDeleted).toBe(false)
    expect(r.note).toContain(NAME)
    expect(r.note).toContain('削除できたか確認できませんでした')
  })

  it('★★★ 200 だが形が読めない応答のときは「削除済み」にしない（B-2・記録から名前を落とさない）', async () => {
    const client = {
      listContainerRegistries: async () => ({ dryRun: false as const, ok: true, status: 200, data: 'not the expected shape' }),
      deleteContainerRegistry: async () => ({ dryRun: false as const, ok: true, status: 204, data: null }),
    }
    const r = await teardownRegistry(client, REGION, NAME)
    expect(r.registryDeleted).toBe(false)
    expect(r.note).toContain(NAME)
    expect(r.note).not.toContain('を削除（ユーザー・イメージごと）') // 成功の文言と取り違えない
  })

  it('★ 一覧が読めて、対象が見つからない（既に削除済み）→ registryDeleted:true・警告は無し（壊していないことの固定）', async () => {
    const client = {
      listContainerRegistries: async () => ({ dryRun: false as const, ok: true, status: 200, data: commonServiceItems([]) }),
      deleteContainerRegistry: async () => ({ dryRun: false as const, ok: true, status: 204, data: null }),
    }
    const r = await teardownRegistry(client, REGION, NAME)
    expect(r.registryDeleted).toBe(true)
    expect(r.note).toBeNull()
  })

  it('★ 一覧が読めて、対象が見つかり、削除に成功 → registryDeleted:true（これまでどおり記録から落ちる）', async () => {
    const client = {
      listContainerRegistries: async () => ({
        dryRun: false as const, ok: true, status: 200, data: commonServiceItems([{ id: '999', subdomainLabel: NAME }]),
      }),
      deleteContainerRegistry: async (region: string, id: string) => {
        expect(region).toBe(REGION)
        expect(id).toBe('999')
        return { dryRun: false as const, ok: true, status: 204, data: null }
      },
    }
    const r = await teardownRegistry(client, REGION, NAME)
    expect(r.registryDeleted).toBe(true)
    expect(r.note).toContain('を削除（ユーザー・イメージごと）')
  })

  it('★ 対象が見つかったが削除に失敗（HTTP）→ すぐ隣の行と同じ語り口。registryDeleted は立てない', async () => {
    const client = {
      listContainerRegistries: async () => ({
        dryRun: false as const, ok: true, status: 200, data: commonServiceItems([{ id: '999', subdomainLabel: NAME }]),
      }),
      deleteContainerRegistry: async () => ({ dryRun: false as const, ok: false, status: 409, data: null }),
    }
    const r = await teardownRegistry(client, REGION, NAME)
    expect(r.registryDeleted).toBe(false)
    expect(r.note).toContain('削除に失敗（HTTP 409）')
  })

  it('★ dry-run のときは何もしない（従来どおり）', async () => {
    const client = {
      listContainerRegistries: async () => ({ dryRun: true as const, request: { method: 'GET' as const, url: '', body: null } }),
      deleteContainerRegistry: async () => ({ dryRun: true as const, request: { method: 'DELETE' as const, url: '', body: null } }),
    }
    const r = await teardownRegistry(client, REGION, NAME)
    expect(r.registryDeleted).toBe(false)
    expect(r.note).toBeNull()
  })
})
