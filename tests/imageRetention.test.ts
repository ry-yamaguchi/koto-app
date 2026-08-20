import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUTO_TAG_PATTERN, DEFAULT_KEEP, MIN_KEEP,
  isAutoTag, normalizeKeep, planTagCleanup, digestsToDelete, retentionNotice,
} from '../src/shared/imageRetention'
import { publishTag } from '../src/shared/publishTag'
import { looksLikePermissionProblem, looksLikeUnsupported } from '../src/shared/registryTrouble'

// ── 2026-08-19 ────────────────────────────────────────────────────────────
// 公開のたびに新しいタグを打つようにした副作用で、レジストリにタグが溜まる。
// 片づけは**利用者の資産を消す**操作なので、判定はここで固定する（掟10）。

const t = (s: string) => s // 読みやすさのため

describe('片づけてよいタグの見分け', () => {
  it('★★ Koto が打ったタグ（publishTag の形）だけが対象', () => {
    expect(isAutoTag(publishTag(new Date(2026, 7, 19, 18, 23, 0)))).toBe(true)
    expect(isAutoTag('v20260819-182300')).toBe(true)
  })

  it('★★ 利用者が決めた名前には触らない', () => {
    for (const tag of ['latest', 'v1.2.3', 'stable', 'v2026', 'v20260819', 'v20260819-1823', 'release-2026']) {
      expect(isAutoTag(tag)).toBe(false)
    }
  })

  it('文字列以外は対象外', () => {
    expect(isAutoTag(null)).toBe(false)
    expect(isAutoTag(undefined)).toBe(false)
    expect(isAutoTag(123)).toBe(false)
  })

  it('形は publishTag が作るものと一致している（片方だけ直す事故を防ぐ）', () => {
    expect(AUTO_TAG_PATTERN.test(publishTag(new Date()))).toBe(true)
  })
})

describe('残す件数の丸め', () => {
  it('★★ 未指定なら null＝消さない（既定は残す）', () => {
    expect(normalizeKeep(null)).toBeNull()
    expect(normalizeKeep(undefined)).toBeNull()
    expect(normalizeKeep(Number.NaN)).toBeNull()
  })

  it('★★ 0 や負数を渡されても、最低1件は残す（全部消す事故を防ぐ）', () => {
    expect(normalizeKeep(0)).toBe(MIN_KEEP)
    expect(normalizeKeep(-5)).toBe(MIN_KEEP)
  })

  it('小数は切り下げる', () => {
    expect(normalizeKeep(5.9)).toBe(5)
  })
})

describe('片づけの計画', () => {
  const tags = [
    'v20260819-100000',
    'v20260819-110000',
    'v20260819-120000',
    'v20260819-130000',
    'v20260819-140000',
    'v20260819-150000',
    'v20260819-160000',
    'latest',
    'v1.2.3',
  ]

  it('★★ 既定（keep 未指定）では1件も消さない', () => {
    const p = planTagCleanup({ tags, currentTag: 'v20260819-160000' })
    expect(p.remove).toEqual([])
    // 何件たまっているかは見える（画面に出すため）
    expect(p.keep.length).toBe(6)
  })

  it('★★ 直近5件を残すと、古いものだけが消える', () => {
    const p = planTagCleanup({ tags, keep: 5, currentTag: 'v20260819-160000' })
    // いま使っている 160000 は untouched なので、候補は 6 件 → 5 件残して 1 件消える
    expect(p.remove).toEqual(['v20260819-100000'])
    expect(p.keep).toEqual([
      'v20260819-150000', 'v20260819-140000', 'v20260819-130000',
      'v20260819-120000', 'v20260819-110000',
    ])
  })

  it('★★ 利用者が決めた名前は、いくつ溜まっていても消さない', () => {
    const p = planTagCleanup({ tags, keep: 1, currentTag: null })
    expect(p.untouched).toContain('latest')
    expect(p.untouched).toContain('v1.2.3')
    expect(p.remove).not.toContain('latest')
    expect(p.remove).not.toContain('v1.2.3')
  })

  it('★★ いま動いているアプリのタグは、古くても必ず残す（足元を外さない）', () => {
    const p = planTagCleanup({ tags, keep: 1, currentTag: 'v20260819-100000' })
    expect(p.untouched).toContain('v20260819-100000')
    expect(p.remove).not.toContain('v20260819-100000')
  })

  it('★★ 残す件数のほうが多ければ、何も消えない', () => {
    const p = planTagCleanup({ tags, keep: 99, currentTag: 'v20260819-160000' })
    expect(p.remove).toEqual([])
  })

  it('★★ keep に 0 を渡されても、1件は残る', () => {
    const p = planTagCleanup({ tags, keep: 0, currentTag: null })
    expect(p.keep).toEqual(['v20260819-160000'])
    expect(p.remove).not.toContain('v20260819-160000')
  })

  it('消すのは古い順・残すのは新しい順（画面で読める向きにする）', () => {
    const p = planTagCleanup({ tags, keep: 2, currentTag: null })
    expect(p.remove[0]).toBe('v20260819-100000')
    expect(p.remove[p.remove.length - 1]).toBe('v20260819-140000')
    expect(p.keep).toEqual(['v20260819-160000', 'v20260819-150000'])
  })

  it('重複・空文字はレジストリの応答にあっても落とす', () => {
    const p = planTagCleanup({
      tags: ['v20260819-100000', 'v20260819-100000', '', '  ', 'v20260819-110000'],
      keep: 1,
    })
    expect(p.keep).toEqual(['v20260819-110000'])
    expect(p.remove).toEqual(['v20260819-100000'])
  })

  it('タグが無くても落ちない', () => {
    const p = planTagCleanup({ tags: [], keep: 5 })
    expect(p).toEqual({ remove: [], keep: [], untouched: [] })
  })

  it('既定の残数は5件', () => {
    expect(DEFAULT_KEEP).toBe(5)
  })
})

describe('同じ実体を指すタグ（2026-08-19 実測: 中身が同じなら digest も同じ）', () => {
  it('★★ 残すタグと同じ digest は消さない（片方消すつもりで両方消える事故を防ぐ）', () => {
    const plan = planTagCleanup({
      tags: ['v20260819-100000', 'v20260819-110000', 'v20260819-120000'],
      keep: 1,
      currentTag: null,
    })
    // 120000 を残す。100000 は 120000 と中身が同じ（＝同じ digest）。
    const r = digestsToDelete({
      plan,
      digestOf: {
        'v20260819-100000': 'sha256:same',
        'v20260819-110000': 'sha256:old',
        'v20260819-120000': 'sha256:same',
      },
    })
    expect(r.digests).toEqual(['sha256:old'])
    expect(r.sharedWithKept).toEqual([t('v20260819-100000')])
  })

  it('★★ digest を引けなかったタグは消さない（分からないものを壊さない）', () => {
    const plan = planTagCleanup({ tags: ['v20260819-100000', 'v20260819-110000'], keep: 1 })
    const r = digestsToDelete({ plan, digestOf: {} })
    expect(r.digests).toEqual([])
  })

  it('★★ 利用者のタグ（latest）と同じ実体なら消さない', () => {
    const plan = planTagCleanup({ tags: ['v20260819-100000', 'v20260819-110000', 'latest'], keep: 1 })
    const r = digestsToDelete({
      plan,
      digestOf: {
        'v20260819-100000': 'sha256:pinned',
        'v20260819-110000': 'sha256:new',
        latest: 'sha256:pinned',
      },
    })
    expect(r.digests).toEqual([])
    expect(r.sharedWithKept).toEqual([t('v20260819-100000')])
  })

  it('消す側どうしが同じ実体なら、1回だけ消す', () => {
    const plan = planTagCleanup({
      tags: ['v20260819-100000', 'v20260819-110000', 'v20260819-120000'],
      keep: 1,
    })
    const r = digestsToDelete({
      plan,
      digestOf: {
        'v20260819-100000': 'sha256:dup',
        'v20260819-110000': 'sha256:dup',
        'v20260819-120000': 'sha256:new',
      },
    })
    expect(r.digests).toEqual(['sha256:dup'])
  })
})

describe('画面に出す文', () => {
  it('溜まっていなければ何も言わない', () => {
    expect(retentionNotice({ removable: 0, keep: 5 })).toBe('')
  })

  it('★★ Markdown 記法を混ぜない（素のテキストとして描画されるため）', () => {
    const s = retentionNotice({ removable: 12, keep: 5 })
    expect(s).toContain('12 件')
    expect(s).not.toMatch(/[*_`#]/)
  })
})

// ── 配線（掟6・掟10）─────────────────────────────────────────────────────
// 「型が通ることは、繋がっている証拠にならない」（2026-08-13 の S-1 の教訓）。
// **既定で消さない**ことと、**3点セット（main / preload / global.d.ts）が
// 揃っていること**をソースで固定する。
describe('配線', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')
  const cloud = read('src/main/ipc/cloud.ts')

  it('★★ 公開のあとは「数えるだけ」で、削除を呼ばない', () => {
    // 公開の経路（cloud:apply）で呼ぶのは一覧のみ。
    expect(cloud).toContain('const listed = await listTags({')
    // 削除は片づけの IPC の中だけ。apply ハンドラの中に deleteDigests があってはいけない。
    const applyStart = cloud.indexOf("ipcMain.handle('cloud:apply'")
    const applyEnd = cloud.indexOf("ipcMain.handle('cloud:cleanupImages'")
    expect(applyStart).toBeGreaterThan(-1)
    expect(applyEnd).toBeGreaterThan(applyStart)
    expect(cloud.slice(applyStart, applyEnd)).not.toContain('deleteDigests')
  })

  it('★★ confirmed が無ければ一覧を返して止まる（消す前に一覧を出す）', () => {
    expect(cloud).toContain("if (opts?.confirmed !== true) {")
    expect(cloud).toContain('return { ok: true, dryRun: true, plan, currentTag, keep }')
  })

  it('★★ 別プロジェクトのレジストリを触らない（公開と同じ突き合わせを通す）', () => {
    const start = cloud.indexOf("ipcMain.handle('cloud:cleanupImages'")
    const body = cloud.slice(start, start + 6000)
    expect(body).toContain('resolvePushRegistry(state.meta?.registryName, regCreds.name)')
  })

  // 2026-08-19: 消すあいだだけ権限を上げる形にした際、閉じた関数の中では型の
  // 絞り込みが効かないため `source.image` を `imageName` に控えてから渡している。
  // 見るべきこと（**タグではなく digest を渡す**）は変わっていない。
  it('★★ 消す対象は digest に絞り込んでから渡す（同じ実体の巻き添えを防ぐ）', () => {
    expect(cloud).toContain('digestsToDelete({ plan, digestOf })')
    expect(cloud).toContain('deleteDigests({ auth, image: imageName, digests')
  })

  it('★★ いま公開しているタグを state に控える（足元を外さないため）', () => {
    expect(cloud).toContain('...(publishedTag ? { imageTag: publishedTag } : {})')
    expect(read('src/main/cloud/state.ts')).toContain('imageTag?: string')
  })

  it('★★ IPC の3点セットが揃っている（掟6）', () => {
    expect(cloud).toContain("ipcMain.handle('cloud:cleanupImages'")
    expect(read('src/main/preload.ts')).toContain("ipcRenderer.invoke('cloud:cleanupImages'")
    expect(read('src/renderer/global.d.ts')).toContain('cleanupImages(projectDir: string')
  })

  it('★★ 画面は「消す前に一覧を出す」呼び方をしている', () => {
    const panel = read('src/renderer/components/AppRunPanel.tsx')
    // 1回目は confirmed を付けない（＝何も消えない）
    expect(panel).toContain('await window.electronAPI.cloud.cleanupImages(projectDir)')
    // 2回目は確認ダイアログを経てから
    expect(panel).toContain("confirm?.kind !== 'cleanupImages'")
    expect(panel).toContain('cleanupImages(projectDir, { confirmed: true, keep })')
  })
})

// ── 失敗の見分け（imageCleanup の純関数）──────────────────────────────────
// さくらの公式マニュアルでは、イメージの**削除**は利用者権限「All」の範囲。
// Koto が自動作成する push 用ユーザーは `readwrite`（Push & Pull）なので、
// **権限不足で断られる可能性が高い**。そのときに「よく分からない失敗」で
// 終わらせず、直し方を出せるようにする。
describe('レジストリの失敗の見分け', () => {
  it('★★ 権限不足を見分ける', () => {
    for (const t of [
      'DENIED: requested access to the resource is denied',
      'unexpected status code 401 Unauthorized',
      'HTTP 403 Forbidden',
      'insufficient_scope',
    ]) expect(looksLikePermissionProblem(t)).toBe(true)
  })

  it('★★ 権限とは関係ない失敗を、権限のせいにしない', () => {
    for (const t of [
      'dial tcp: lookup example.sakuracr.jp: no such host',
      'MANIFEST_UNKNOWN: manifest unknown',
      '',
    ]) expect(looksLikePermissionProblem(t)).toBe(false)
  })

  it('★★ 削除に対応していない応答を見分ける', () => {
    expect(looksLikeUnsupported('UNSUPPORTED: The operation is unsupported.')).toBe(true)
    expect(looksLikeUnsupported('unexpected status code 405 Method Not Allowed')).toBe(true)
    expect(looksLikeUnsupported('DENIED: access denied')).toBe(false)
  })
})
