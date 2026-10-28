import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 3点セットが同じ形であること（掟6・設計書 docs/teardown-unify-plan.md 10.4.2・10.4.10 の 3。2026-10-09 段階1の1a-1）──────────
// `hanamii:teardown` は main（ipc/hanamiiTeardown.ts）・preload.ts・renderer/global.d.ts の3か所で同じ形を宣言する。型検査は
// 呼び出し側の引数は見張るが、**返り値の項目が renderer の型から落ちても**（まだ読む画面が無い間は）何も言わない。
// 振る舞いは tests/hanamiiTeardownShell.test.ts などが本物の main に流して固定するので、ここは「宣言が揃っているか」だけをソースで見る。
// ソースを読むテストは、コメントを除き、**呼び出しの形ごと**一意に指す（掟10。ファイルのどこかに書いてあるだけでは通さない）。

const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')
/** コメント行（`//`・`*`・`/*` で始まる行）を除く。 */
const code = (rel: string) => read(rel).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

/** `start` の末尾の `{` から、対応する閉じかっこまでの本文（入れ子を数える）。`start` は `{` で終わること。 */
function blockFrom(text: string, start: string): string {
  const i = text.indexOf(start)
  expect(i, `${start} が見つからない`).toBeGreaterThanOrEqual(0)
  expect(start.endsWith('{'), 'start は { で終わる').toBe(true)
  let depth = 0
  for (let k = i + start.length - 1; k < text.length; k++) {
    if (text[k] === '{') depth++
    else if (text[k] === '}' && --depth === 0) return text.slice(i, k + 1)
  }
  throw new Error(`${start} の閉じかっこが見つからない`)
}

describe('★★ hanamii:teardown の3点セット（main・preload・global.d.ts）が同じ形', () => {
  // 0.6.24 F: opts に、確認で見せた保存場所（名前と prefix の組）を必須で足した
  const PRELOAD_CALL = "teardown: (projectDir: string, auth: { token: string }, opts: { confirmed: boolean; projectId: string; shownPlacements: Array<{ bucket: string; prefix: string }> }) =>\n      ipcRenderer.invoke('hanamii:teardown', projectDir, auth, opts),"
  const DTS_HEAD = 'teardown(projectDir: string, auth: { token: string }, opts: { confirmed: boolean; projectId: string; shownPlacements: Array<{ bucket: string; prefix: string }> }): Promise<{'

  it('★★ preload: (projectDir, 認証, { confirmed, projectId }) をそのまま invoke に渡す。直す前の形（projectId・token・任意の projectDir）が無い', () => {
    const src = code('src/main/preload.ts')
    expect(src).toContain(PRELOAD_CALL)
    expect(src).not.toContain("ipcRenderer.invoke('hanamii:teardown', projectId, token, projectDir)")
    expect(src).not.toContain('teardown: (projectId: string, token: string, projectDir?: string)')
    expect(src.match(/ipcRenderer\.invoke\('hanamii:teardown'/g) ?? []).toHaveLength(1)
  })

  it('★★ global.d.ts: 引数は preload と同じ。直す前の形（任意の projectDir）が無い', () => {
    const src = code('src/renderer/global.d.ts')
    expect(src).toContain(DTS_HEAD)
    expect(src).not.toContain('teardown(projectId: string, token: string, projectDir?: string)')
  })

  it('★★★ global.d.ts の返り値の項目は、main の HanamiiTeardownResult の項目をすべて含む（remainingBuckets・skippedBuckets・deletionAccepted が落ちていない）', () => {
    const main = blockFrom(code('src/main/ipc/hanamiiTeardown.ts'), 'export type HanamiiTeardownResult = {')
    const keys = [...main.matchAll(/^ {2}(\w+)\??:/gm)].map(m => m[1])
    // 項目を書き下す（読み取りが空になって何も見ないテストにしない）
    expect(keys).toEqual(['ok', 'appDeleted', 'executed', 'remainingBucket', 'remainingBuckets', 'skippedBuckets', 'keptBucketName', 'keptBucketNames', 'keptBucketsUsedByOthers', 'keptBucketsWithOwnFiles', 'deletionAccepted', 'message'])
    const dts = blockFrom(code('src/renderer/global.d.ts'), DTS_HEAD)
    for (const k of keys) expect(dts, `renderer の型に ${k} が無い`).toMatch(new RegExp(`\\b${k}\\??: `))
  })

  it('★★ main: ハンドラの登録は hanamiiTeardown.ts の1か所だけで、共通の骨 runTeardownShell を HANAMII の定義で呼ぶ。hanamii.ts から登録を呼ぶ', () => {
    const teardown = code('src/main/ipc/hanamiiTeardown.ts')
    expect(teardown.match(/ipcMain\.handle\('hanamii:teardown'/g) ?? []).toHaveLength(1)
    expect(teardown).toContain('runTeardownShell(HANAMII_TEARDOWN_SHELL, { projectDir, auth, opts })')
    // 直す前の形（骨を通さず、確認の印も projectDir も見ない）が戻っていない
    expect(teardown).not.toContain('withProjectLock(')
    expect(teardown).not.toMatch(/projectDir\?: unknown/)
    const hanamii = code('src/main/ipc/hanamii.ts')
    expect(hanamii).not.toContain("ipcMain.handle('hanamii:teardown'")
    expect(hanamii.match(/registerHanamiiTeardownHandler\(\)/g) ?? []).toHaveLength(1)
  })

  it('★★ 結果の message の文は共通の定義（shared/teardownResult.ts）から読む。直書きしない', () => {
    const teardown = code('src/main/ipc/hanamiiTeardown.ts')
    expect(teardown).toContain("import { HANAMII_DELETION_ACCEPTED_WARNING } from '../../shared/teardownResult'")
    expect(teardown).not.toContain('HANAMII が削除を受け付けました')
  })
})
