// W-66: 手で「📦 公開しないものへ移動」「🌐 公開するものへ移動」しても、🕘 履歴には
// 身に覚えのない「未使用ファイルの整理」と出ていた問題の固定テスト。
//
// moveFilesToFs は project:moveFiles（Sidebar.tsx の右クリック＝手動移動）と
// moveToMaterialsFs 経由の project:moveToMaterials（🧹 使われていないファイルの確認からの
// 一括移動）の両方から呼ばれる、見出し（🕘 履歴の label）の唯一の決定箇所。
// 呼び出し元を区別せず dest だけで見出しを決めていたのを、reason で出し分けるよう直した。
// 実装を「reason を無視して常に一方の文言にする」ように壊すと、ここが落ちる。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { moveFilesToFs, moveToMaterialsFs } from '../src/main/ipc/unused'
import { listSnapshotSummaries } from '../src/main/backup/store'
import { MATERIALS_DIR } from '../src/shared/publishExclude'
import { PUBLISH_DIR } from '../src/shared/publishRoot'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-movelabel-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function write(rel: string, content = 'x'): void {
  const full = path.join(dir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}

function labelOf(): string {
  const { snapshots } = listSnapshotSummaries(dir)
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0].label).toBeTruthy()
  return snapshots[0].label as string
}

describe('project:moveFiles（Sidebar.tsx の右クリック＝手動移動）は「ファイルを移動」と記録する', () => {
  it('公開しないもの（素材）へ手で移したときは「未使用ファイルの整理」と出さない', () => {
    write('logo.png', 'x')
    const r = moveFilesToFs(dir, ['logo.png'], 'materials') // reason 省略＝既定 'manual'
    expect(r.ok).toBe(true)
    const label = labelOf()
    expect(label).not.toContain('未使用ファイルの整理')
    expect(label).toBe(`ファイルを移動（${MATERIALS_DIR}へ）`)
  })

  it('公開されるもの（public）へ手で移したときも「ファイルを移動」で、生の public ではなく「公開されるもの」と書く', () => {
    write(`${MATERIALS_DIR}/logo.png`, 'x')
    const r = moveFilesToFs(dir, [`${MATERIALS_DIR}/logo.png`], 'publish')
    expect(r.ok).toBe(true)
    const label = labelOf()
    expect(label).toBe(`ファイルを移動（公開されるもの（${PUBLISH_DIR}）へ）`)
    expect(label).not.toBe(`ファイルの移動（${PUBLISH_DIR}）`) // 直す前の、生の public だけの形ではない
  })
})

describe('project:moveToMaterials（🧹 使われていないファイルの確認からの一括移動）は従来どおり「未使用ファイルの整理」', () => {
  it('moveToMaterialsFs 経由では「未使用ファイルの整理」のまま', () => {
    write('old.html', 'x')
    const r = moveToMaterialsFs(dir, ['old.html'])
    expect(r.ok).toBe(true)
    const label = labelOf()
    expect(label).toBe(`未使用ファイルの整理（${MATERIALS_DIR}）`)
  })
})

describe('moveFilesToFs を reason 省略で直接呼んでも（project:moveFiles と同じ形）既定は手動扱い', () => {
  it('3引数だけの呼び出し（project:moveFiles のハンドラと同じ形）は reason 未指定でも「ファイルを移動」になる', () => {
    write('a.txt', 'x')
    // ipcMain.handle('project:moveFiles', (_, projectDir, files, dest) => moveFilesToFs(projectDir, files, dest))
    // と同じ、3引数だけの呼び出し方であることが重要（4引数目を渡し忘れても cleanup 扱いにならない）。
    const r = moveFilesToFs(dir, ['a.txt'], 'materials')
    expect(r.ok).toBe(true)
    expect(labelOf()).not.toContain('未使用ファイルの整理')
  })
})
