import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { failureText } from '../src/shared/failureText'
import { splitFailureDetail } from '../src/shared/failureDetail'
import { teardownFailureText, TEARDOWN_CHECK_AT } from '../src/renderer/teardown/failureNote'
import { trashFailureText } from '../src/renderer/teardown/projectDelete'
import { loadZones, clearZonesCache } from '../src/renderer/zonesCache'

// 残りの画面（破棄の流れ・読み込み・保存・取り込み）の失敗の文を failureText(e) で作ることを固める。
// 読み取りは readOnly: true、書き込みは既定の慎重な文。破棄の流れは確かめる場所を「📡 公開したもの一覧」にする。
// 呼び出しの形ごと書き、直す前の形は not.toContain で禁じる。

const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, '..', 'src/renderer', rel), 'utf-8')
const RO = '{ readOnly: true }'
const TEARDOWN = 'teardownFailureText(e)'

const SHAPES: Array<[string, string[]]> = [
  ['zonesCache.ts', [`message: failureText(e, ${RO}) }`]],
  ['teardown/flow.ts', ['${spec.words.factsUnreadable}: ${failureText(e, { readOnly: true })}']],
  ['teardown/useTeardownFlow.ts', [`spec.failure(${TEARDOWN})`]],
  ['teardown/projectDelete.ts', ['wrapFailureText(teardownFailureText(e), msg => {', '`${nameOf(t)}: ${msg}`', 'プロジェクトを削除できませんでした: ${trashFailureText(e)}']],
  ['components/ProjectDeleteDialog.tsx', ['プロジェクトの削除の途中でエラーが発生しました: ${teardownFailureText(e)}']],
  ['components/SharedTeardownSection.tsx', ['破棄処理でエラーが発生しました: ${teardownFailureText(e)}']],
  ['components/HanamiiTeardownSection.tsx', ['破棄処理でエラーが発生しました: ${teardownFailureText(e)}']],
  ['components/DedicatedTeardownSection.tsx', [`dedicatedTeardownSpec.failure(${TEARDOWN})`]],
  ['components/NewProjectModal.tsx', ['setError(failureText(e))']],
  ['components/KnowledgeModal.tsx', ['setListError(failureText(e))']],
  ['components/KnowledgeCollectorTab.tsx', [`setSearchError(failureText(e, ${RO}))`, `error: failureText(e, ${RO}) }`, '「${page.title}」: ${failureText(e)}']],
  ['components/KnowledgePacksTab.tsx', ['const message = failureText(e)']],
  ['components/PublishedListModal.tsx', [`setError(failureText(e, ${RO}))`]],
  ['components/PublishedInventoryCard.tsx', [`message: failureText(e, ${RO}), rows: []`]],
  ['components/StorageNotice.tsx', [`message: failureText(e, ${RO}) })`]],
  ['components/CompactNote.tsx', ['setSaveErr(savedFailureNote(e))', 'wrapFailureText(failureText(e), t => `残せませんでした（${t}）`)']],
  ['components/ChatPanel.tsx', ['failed.push(failureText(e))']],
  ['components/AiMessage.tsx', ['setErr(failureText(e))']],
  ['components/AppRunPanel.tsx', [`setConnMsg(failureText(e, ${RO}))`]],
]

describe('残りの画面の失敗の文', () => {
  it('失敗の文は failureText を通し、直す前の形は残さない', () => {
    for (const [file, shapes] of SHAPES) {
      const src = read(file)
      for (const shape of shapes) expect(src, `${file}: ${shape}`).toContain(shape)
      expect(src, file).not.toContain('e?.message ?? String(e)')
      expect(src, file).not.toContain('e?.message ?? e}')
    }
    expect(read('components/KnowledgeCollectorTab.tsx')).not.toContain("e?.message ?? '")
    expect(read('components/AppRunPanel.tsx')).not.toContain("e?.message ?? 'APIキー")
  })

  it('破棄の流れの失敗は、確かめる場所が「📡 公開したもの一覧」の慎重な文になる', () => {
    expect(TEARDOWN_CHECK_AT).toBe('📡 公開したもの一覧')
    const cut = Object.assign(new Error("Error invoking remote method 'cloud:teardown': Error: socket hang up"), { code: 'ECONNRESET' })
    const text = teardownFailureText(cut)
    expect(text).toBe(failureText(cut, { checkAt: '📡 公開したもの一覧' }))
    // 日本語の文は今までどおり。そのすぐ下に原文（詳細）が付く
    expect(splitFailureDetail(text).text).toBe('通信が途中で切れました。操作が済んだかは確かめられていません。少し待ってから、📡 公開したもの一覧で状態を確かめてください。')
    expect(splitFailureDetail(text).detail).toContain('socket hang up')
    expect(text).not.toContain('もう一度')
    expect(text).not.toContain('Error invoking remote method')
  })

  it('破棄の流れの文を使う側は、素の failureText ではなく teardownFailureText を呼ぶ（呼ぶ形ごと）', () => {
    const CALLS: Array<[string, string[]]> = [
      ['teardown/useTeardownFlow.ts', [`spec.failure(${TEARDOWN})`]],
      ['teardown/projectDelete.ts', ['wrapFailureText(teardownFailureText(e), msg => {']],
      ['components/ProjectDeleteDialog.tsx', ['プロジェクトの削除の途中でエラーが発生しました: ${teardownFailureText(e)}']],
      ['components/SharedTeardownSection.tsx', ['破棄処理でエラーが発生しました: ${teardownFailureText(e)}']],
      ['components/HanamiiTeardownSection.tsx', ['破棄処理でエラーが発生しました: ${teardownFailureText(e)}']],
      ['components/DedicatedTeardownSection.tsx', [`dedicatedTeardownSpec.failure(${TEARDOWN})`]],
    ]
    for (const [file, shapes] of CALLS) {
      const src = read(file)
      for (const shape of shapes) expect(src, `${file}: ${shape}`).toContain(shape)
      // 破棄の流れの文を作る場所で、素の failureText(e) に戻していない
      expect(src, file).not.toMatch(/(?<![A-Za-z])failureText\(e\)/)
    }
  })

  it('ゴミ箱へ移す失敗: 権限は選び直しを促さず、切れたときは Finder のゴミ箱で確かめる', () => {
    const denied = Object.assign(new Error("EACCES: permission denied, rename '/x/app'"), { code: 'EACCES' })
    const t1 = trashFailureText(denied)
    // 自前の固定文に置き換えて捨てていた原文が、詳細として残る
    expect(splitFailureDetail(t1).text).toBe('フォルダをゴミ箱へ移せません。Finder で権限を確かめてください。')
    expect(splitFailureDetail(t1).detail).toContain('EACCES: permission denied')
    expect(t1).not.toContain('別の場所を選ぶ')
    const cut = Object.assign(new Error("Error invoking remote method 'fs:trashProject': Error: socket hang up"), { code: 'ECONNRESET' })
    const t2 = trashFailureText(cut)
    expect(t2).toBe(failureText(cut, { checkAt: 'Finder のゴミ箱' }))
    expect(splitFailureDetail(t2).detail).toContain('socket hang up')
    expect(t2).toContain('Finder のゴミ箱で状態を確かめてください')
    expect(t2).not.toContain('この画面を開き直して')
    expect(read('teardown/projectDelete.ts')).toContain('プロジェクトを削除できませんでした: ${trashFailureText(e)}')
  })

  it('NewProjectModal: フォルダを作れない失敗は、英語の頭が落ちて日本語の文になる', () => {
    const e = new Error("Error invoking remote method 'fs:createProject': Error: EACCES: permission denied, mkdir '/Volumes/x/app'")
    const text = failureText(e)
    expect(text).not.toContain('Error invoking remote method')
    expect(text).toContain('このフォルダには書き込めません')
  })

  it('読み取り（公開先の一覧）の回線断は readOnly の文になる（「もう一度」と言ってよい）', async () => {
    const g = globalThis as any
    const before = g.window
    const boom = (): Error => Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    g.window = { electronAPI: {
      cloud: { loadKey: async () => ({ token: 't', secret: 's' }) },
      apprunDedicated: { zones: async () => { throw boom() } },
    } }
    try {
      clearZonesCache()
      const r = await loadZones(true)
      expect(r.ok).toBe(false)
      expect(r.rows).toEqual([])
      expect(r.message).toBe(failureText(boom(), { readOnly: true }))
      expect(r.message).toContain('インターネットに接続できませんでした')
      // 原文は画面の文には出ず、詳細の行にだけ残る
      expect(splitFailureDetail(r.message!).text).not.toContain('fetch failed')
      expect(splitFailureDetail(r.message!).detail).toContain('fetch failed')
    } finally { g.window = before; clearZonesCache() }
  })
})
