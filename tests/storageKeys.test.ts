import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { permissionsToCleanUp, permissionNameFor, parsePermissions } from '../src/shared/storageKeys'

// 2026-08-14 実機。公開のたびに新しい鍵を発行し、**デプロイAPIが 200 を返したその場で
// 古い鍵を消して**いた。AppRun のデプロイは非同期で、新しいコンテナが立ち上がるまで
// 古いコンテナが動き続ける。その古いコンテナは、たったいま消された鍵を使う。
//   公開 → 200 → 古い鍵を消す → 古いコンテナが 403 → 落ちる
// 新しい版の起動に失敗すれば、そのまま壊れ続けた。実際そうなった。
//
// もう一つ: 片づけるのが「記録している1件」だけなので、記録がずれると孤児が残る。
// 実機では5件たまり、消えたバケット向けや権限が空のものまであった。

const P = (id: string, name: string) => ({ id, displayName: name })

describe('片づけてよい鍵を選ぶ', () => {
  const all = [
    P('12391', 'koto-data-test'),
    P('12372', 'koto-data-test'),
    P('12373', 'koto-data-test'),
    P('12375', 'koto-data-test'),
    P('12380', 'koto-data-test'),
    P('99999', 'koto-other-app'),   // ほかのプロジェクト
  ]

  it('★ いま使っている1件を残し、このプロジェクトの残りを片づける', () => {
    const del = permissionsToCleanUp({ all, projectName: 'data-test', keepId: '12391' })
    expect(del.sort()).toEqual(['12372', '12373', '12375', '12380'])
  })

  // ★ ここを間違えると、動いているアプリを自分の手で壊す
  it('ほかのプロジェクトの鍵には絶対に触れない', () => {
    const del = permissionsToCleanUp({ all, projectName: 'data-test', keepId: '12391' })
    expect(del).not.toContain('99999')
  })

  it('いま使っている鍵は必ず残す', () => {
    for (const keep of ['12391', '12380', '12372']) {
      expect(permissionsToCleanUp({ all, projectName: 'data-test', keepId: keep })).not.toContain(keep)
    }
  })

  // ★ どれが現役か分からない状態で消すのが、いちばん危ない
  it('現役が分からなければ、何も消さない', () => {
    expect(permissionsToCleanUp({ all, projectName: 'data-test', keepId: null })).toEqual([])
  })

  it('名前が違えば対象外（前の版が別の名前で作っていた場合も巻き込まない）', () => {
    const old = [P('1', 'koto-data-test-old'), P('2', 'data-test')]
    expect(permissionsToCleanUp({ all: old, projectName: 'data-test', keepId: '12391' })).toEqual([])
  })

  it('空でも落ちない', () => {
    expect(permissionsToCleanUp({ all: [], projectName: 'x', keepId: '1' })).toEqual([])
    expect(permissionsToCleanUp({ all: undefined as any, projectName: 'x', keepId: '1' })).toEqual([])
  })

  it('名前の付け方は一定（目印が変わると孤児になる）', () => {
    expect(permissionNameFor('data-test')).toBe('koto-data-test')
  })
})

describe('鍵の一覧を読む', () => {
  it('実測した形を読める', () => {
    const data = { data: [{ id: 12391, display_name: 'koto-data-test' }, { id: 12380, display_name: 'koto-data-test' }] }
    expect(parsePermissions(data)).toEqual([
      { id: '12391', displayName: 'koto-data-test' },
      { id: '12380', displayName: 'koto-data-test' },
    ])
  })

  it('壊れた応答でも落ちない', () => {
    expect(parsePermissions(null)).toEqual([])
    expect(parsePermissions({})).toEqual([])
    expect(parsePermissions({ data: [{ display_name: 'x' }] })).toEqual([])
  })
})

// 判断を一元化しても、呼ぶ側が通っていなければ意味がない（掟10。今日これで何度も刺された）
describe('公開の経路が、正しい順序で片づけている', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'ipc', 'cloud.ts'), 'utf-8')
  const apply = readFileSync(join(__dirname, '..', 'src', 'main', 'cloud', 'apply.ts'), 'utf-8')

  // ★ ここが戻ると、公開のたびに動いているアプリが 403 で落ちる
  it('applyPlan は古い鍵を消さない', () => {
    expect(apply).not.toMatch(/deletePermission\(previous\)/)
  })

  it('鍵の名前は一元定義から作る（手で組むと孤児になる）', () => {
    expect(apply).toContain('permissionNameFor(spec.name)')
    expect(apply).not.toMatch(/`koto-\$\{spec\.name\}`/)
  })

  it('片づけは「動いた」と確かめてから行う', () => {
    expect(src).toContain('cleanUpOldKeys')
    // health.ok の中で呼ばれていること
    expect(src).toMatch(/if \(health\.ok && storage\)[\s\S]{0,200}cleanUpOldKeys/)
  })

  it('起動に失敗したときは片づけない（古い版が動き続けられるように）', () => {
    const at = src.indexOf('cleanUpOldKeys(storage')
    const before = src.slice(Math.max(0, at - 300), at)
    expect(before).toContain('health.ok')
  })
})

// ── 公開先をまたいで鍵を消さない（2026-08-15）────────────────────────────
// 同じプロジェクトを AppRun と HANAMII の両方へ公開すると、鍵は公開先ごとに要る。
// 名前を分けずに片づけると、**AppRun へ公開した瞬間に HANAMII の鍵が消え、
// 動いているアプリが 403 で落ちる**（昨日の「古い鍵を先に消した」と同じ形）。
describe('公開先ごとに鍵を分ける', () => {
  it('AppRun の名前は変えない（発行済みの鍵を孤児にしない）', () => {
    expect(permissionNameFor('data-test')).toBe('koto-data-test')
    expect(permissionNameFor('data-test', 'apprun')).toBe('koto-data-test')
  })

  it('HANAMII は別の名前になる', () => {
    expect(permissionNameFor('data-test', 'hanamii')).toBe('koto-data-test-hanamii')
  })

  it('★ AppRun の片づけが HANAMII の鍵に触れない', () => {
    const all = [
      { id: '1', displayName: 'koto-data-test' },          // AppRun の古い鍵
      { id: '2', displayName: 'koto-data-test' },          // AppRun の現役
      { id: '3', displayName: 'koto-data-test-hanamii' },  // **HANAMII の現役**
    ]
    expect(permissionsToCleanUp({ all, projectName: 'data-test', keepId: '2' })).toEqual(['1'])
  })

  it('★ HANAMII の片づけが AppRun の鍵に触れない', () => {
    const all = [
      { id: '1', displayName: 'koto-data-test' },
      { id: '3', displayName: 'koto-data-test-hanamii' },
      { id: '4', displayName: 'koto-data-test-hanamii' },
    ]
    expect(permissionsToCleanUp({ all, projectName: 'data-test', keepId: '4', target: 'hanamii' })).toEqual(['3'])
  })
})
