import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseLocalRecords, buildInventory, sumMonthly, unknownCount, totalNotice, monthlyYenFor, kindLabel,
} from '../src/shared/inventory'

// ── 改善案 1-3 / 1-4（2026-08-18）────────────────────────────────────
// 2026-08-14、**Koto の記録に無いアプリとレジストリ**が残り、Ryosuke が
// コントロールパネルで消した。非エンジニアにはできない。しかも**放置すると
// 毎月お金がかかる**。実測では合計 935円/月が動いていたのに、
// **Koto の画面のどこにも合計は出ていない。**

const projects = [
  {
    dir: '/w/data-test', name: 'data-test',
    apprunState: {
      resources: [
        { kind: 'apprun-app', id: 'app-1111-aaaa' },
        { kind: 'bucket', id: 'koto-data-sample' },
      ],
      meta: { registryName: 'sample-registry-65f6' },
    },
  },
  { dir: '/w/express', name: 'express', apprunState: { resources: [{ kind: 'apprun-app', id: 'app-2222-bbbb' }], meta: { registryName: 'express' } } },
]

const actual = [
  { kind: 'apprun-app' as const, id: 'app-1111-aaaa', name: 'data-test' },
  { kind: 'apprun-app' as const, id: 'zzzz-9999', name: 'old-experiment' },  // 記録に無い
  { kind: 'registry' as const, id: 'sample-registry-65f6', name: 'sample-registry-65f6' },
  { kind: 'registry' as const, id: 'express', name: 'express' },
  { kind: 'bucket' as const, id: 'koto-data-sample', name: 'koto-data-sample' },
]

describe('手元の記録を読む', () => {
  it('アプリID・レジストリ名・保存場所名を取り出す', () => {
    const r = parseLocalRecords(projects)
    expect(r[0]).toEqual({
      dir: '/w/data-test', projectName: 'data-test',
      appIds: ['app-1111-aaaa'], bucketNames: ['koto-data-sample'], registryNames: ['sample-registry-65f6'],
    })
  })

  it('壊れた記録が混ざっても落ちない', () => {
    expect(parseLocalRecords([{ dir: 1, name: null, apprunState: 'こわれている' } as any])[0])
      .toEqual({ dir: '', projectName: '', appIds: [], bucketNames: [], registryNames: [] })
    expect(parseLocalRecords([])).toEqual([])
  })
})

describe('さくら側の実物と突き合わせる', () => {
  const rows = buildInventory({ actual, records: parseLocalRecords(projects) })

  it('記録にあるものは、どのプロジェクトのものか分かる', () => {
    expect(rows.find(r => r.id === 'app-1111-aaaa')?.project).toBe('data-test')
    expect(rows.find(r => r.id === 'sample-registry-65f6')?.project).toBe('data-test')
    expect(rows.find(r => r.id === 'koto-data-sample')?.dir).toBe('/w/data-test')
  })

  it('★ 心当たりの無いものも必ず出す（出さなければ放置される）', () => {
    const orphan = rows.find(r => r.id === 'zzzz-9999')
    expect(orphan).toBeDefined()
    expect(orphan!.project).toBeNull()
    expect(orphan!.note).toContain('心当たりがありません')
  })

  it('★ 名前が似ているだけで引き取らない（利用者のものを乗っ取らない）', () => {
    const rows2 = buildInventory({
      actual: [{ kind: 'registry', id: 'data-test-old', name: 'data-test-old' }],
      records: parseLocalRecords(projects),  // sample-registry-65f6 は記録にあるが、これは別物
    })
    expect(rows2[0].project).toBeNull()
  })

  it('種類ごとに並べる（アプリ → 置き場 → 保存場所）', () => {
    expect(rows.map(r => r.kind)).toEqual(['apprun-app', 'apprun-app', 'registry', 'registry', 'bucket'])
  })
})

describe('費用', () => {
  const rows = buildInventory({ actual, records: parseLocalRecords(projects) })

  it('額は一元定義から取る', () => {
    expect(monthlyYenFor('registry')).toBe(220)
    expect(monthlyYenFor('bucket')).toBe(495)
    expect(monthlyYenFor('apprun-app')).toBe(0)  // 従量
  })

  it('★ 実測どおりの合計になる（レジストリ2つ＋保存場所1つ＝935円）', () => {
    expect(sumMonthly(rows)).toBe(935)
  })

  it('心当たりの無いものの件数を数える', () => {
    expect(unknownCount(rows)).toBe(1)
  })

  it('★ 実額はコントロールパネルで確かめてもらう（按分できないため）', () => {
    const t = totalNotice(rows)
    expect(t).toContain('935')
    expect(t).toContain('心当たりがありません')
    expect(t).toContain('コントロールパネル')
  })

  it('何も無ければ、そう言う', () => {
    expect(totalNotice([])).toContain('見つかりませんでした')
  })

  it('画面に出す名前は日本語', () => {
    expect(kindLabel('registry')).toBe('イメージの置き場')
    expect(kindLabel('bucket')).toBe('データの保存場所')
  })
})

// ── 配線（判断だけ正しくても、画面に出なければ意味がない・掟10）──────────
describe('棚卸しが画面まで届いている', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

  it('main / preload / 型 の3点が揃っている（掟6）', () => {
    expect(read('src/main/ipc/cloud.ts')).toContain("ipcMain.handle('cloud:inventory'")
    expect(read('src/main/preload.ts')).toContain("ipcRenderer.invoke('cloud:inventory'")
    expect(read('src/renderer/global.d.ts')).toContain('inventory(projects: unknown)')
  })

  it('★ 3種類すべてを引く（1つ漏らすと、その分が見えないまま課金される）', () => {
    const src = read('src/main/ipc/cloud.ts')
    const i = src.indexOf("ipcMain.handle('cloud:inventory'")
    const seg = src.slice(i, i + 3000)
    expect(seg).toContain('listApps')
    expect(seg).toContain('listContainerRegistries')
    expect(seg).toContain('listBuckets')
  })

  it('★ 引けなかったものを、黙って0件にしない', () => {
    const src = read('src/main/ipc/cloud.ts')
    const i = src.indexOf("ipcMain.handle('cloud:inventory'")
    expect(src.slice(i, i + 3000)).toContain('partial')
    expect(read('src/renderer/components/PublishedListModal.tsx')).toContain('この一覧に出ていない')
  })

  it('★ 勝手に通信しない（押したときだけ調べる）', () => {
    const modal = read('src/renderer/components/PublishedListModal.tsx')
    expect(modal).toContain('runInventory')
    // 画面を開いた時点では走らせない
    expect(modal).not.toMatch(/useEffect\([^)]*\{\s*void runInventory\(\)/)
  })

  it('★ 合計を、文章の中に埋めない（いちばん見たい数字）', () => {
    const modal = read('src/renderer/components/PublishedListModal.tsx')
    expect(modal).toMatch(/月額 \{\(inventory\.totalYen \?\? 0\)\.toLocaleString\(\)\}円/)
  })

  it('★ どのキーで調べたかを出す（別のアカウントを見ていないか分かるように）', () => {
    const modal = read('src/renderer/components/PublishedListModal.tsx')
    expect(modal).toContain('調べたキー')
    expect(modal).toContain('getActiveCloudKeyId')
  })

  it('心当たりの無いものは、行き先まで示す', () => {
    const modal = read('src/renderer/components/PublishedListModal.tsx')
    expect(modal).toContain('心当たりがありません')
    expect(modal).toContain('コントロールパネル')
  })
})
