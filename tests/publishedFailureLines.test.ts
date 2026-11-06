import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { leftoverScanLine } from '../src/shared/leftoverData'
import { failureText } from '../src/shared/failureText'
import { splitFailureDetail, wrapFailureText } from '../src/shared/failureDetail'
import { isNameConflictError, isCreationLimitError } from '../src/renderer/nameConflict'

// 公開まわりの画面（AppRunPanel・VercelPanel・HanamiiPanel・RollbackSection・StorageNotice ほか）で、
// 日本語に置き換えた失敗の文に原文（詳細）の行が付いても、文の組み立てと判定が崩れないことを固める。

const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8')
const COMP = 'src/renderer/components/'

const offline = () => Object.assign(new Error('getaddrinfo ENOTFOUND api.sakura.example'), { code: 'ENOTFOUND' })

describe('leftoverScanLine - 括弧の中へ入れるのは日本語の文だけ', () => {
  it('詳細つきの失敗: 原因の文は括弧に入れず、前置きのあとに続ける（案内は二重にしない）・詳細は最後の1行', () => {
    const shown = failureText(offline(), { readOnly: true })
    expect(splitFailureDetail(shown).detail).toContain('ENOTFOUND')
    const line = leftoverScanLine({ ok: false, message: shown })
    const { text, detail } = splitFailureDetail(line)
    expect(detail).toContain('ENOTFOUND')
    expect(text).toBe(`ℹ️ いま入っているデータを確かめられませんでした。${splitFailureDetail(shown).text}`)
    // 詳細は文の途中に入らない
    expect(text).not.toContain('詳細')
    expect(line.endsWith(`\n詳細: ${detail}`)).toBe(true)
    expect(line.split('詳細:').length).toBe(2)
  })

  it('詳細の無い失敗・message の無い失敗は従来の文のまま', () => {
    expect(leftoverScanLine({ ok: false, message: '読めません' }))
      .toBe('ℹ️ いま入っているデータを確かめられませんでした（読めません）。少し待ってから、もう一度お試しください。')
    expect(leftoverScanLine({ ok: false }))
      .toBe('ℹ️ いま入っているデータを確かめられませんでした。少し待ってから、もう一度お試しください。')
  })
})

describe('RollbackSection の「⚠️ 」の付け方', () => {
  it('wrapFailureText で包むと、⚠️ は文の頭・詳細は最後の行', () => {
    const shown = failureText(offline())
    const w = wrapFailureText(shown, t => `⚠️ ${t}`)
    const { text, detail } = splitFailureDetail(w)
    expect(text.startsWith('⚠️ ')).toBe(true)
    expect(text).not.toContain('詳細')
    expect(detail).toContain('ENOTFOUND')
  })
})

describe('名前の衝突・上限の判定は、詳細の行が付いても変わらない', () => {
  it('回線断の文（詳細つき）は衝突でも上限でもない', () => {
    const shown = failureText(offline())
    expect(shown).toContain('\n詳細: ')
    expect(isNameConflictError(shown)).toBe(false)
    expect(isCreationLimitError(shown)).toBe(false)
  })
  it('409 の失敗は、詳細つきでも衝突のまま', () => {
    const e = new Error('公開に失敗しました（HTTP 409）: {"message":"already exists"}')
    expect(isNameConflictError(failureText(e))).toBe(true)
    expect(isNameConflictError(splitFailureDetail(failureText(e)).text)).toBe(isNameConflictError(failureText(e)))
  })
})

// 描き口: {msg} をそのまま置かず FailureLines を通す（直す前の形を禁じる）。
describe('描き口は FailureLines を通る（ソースの形）', () => {
  const app = read(COMP + 'AppRunPanel.tsx')
  const vercel = read(COMP + 'VercelPanel.tsx')
  const hanamii = read(COMP + 'HanamiiPanel.tsx')

  it('AppRunPanel', () => {
    expect(app).toContain('<FailureLines text={preflight.message} />')
    expect(app).toContain('<FailureLines text={limitMsg} />')
    expect(app).toContain('<FailureLines text={regNotice} />')
    expect(app).toContain("<FailureLines text={cost.message ?? ''} />")
    expect(app).toContain('<FailureLines text={result.message} />')
    expect(app).toContain('<FailureLines text={wrapFailureText(recheck.note, t =>')
    expect(app).toContain('getText={result.ok ? undefined : getCopyText}')
    for (const old of ['{preflight.message}</p>', '{limitMsg}</p>', '{regNotice}</p>', '{cost.message}</p>', 'select-text whitespace-pre-wrap">{result.message}</p>\n          <CopyButton', "{recheck.note}{recheck.detail"]) {
      expect(app, old).not.toContain(old)
    }
  })
  it('VercelPanel・HanamiiPanel', () => {
    expect(vercel).toContain('<FailureLines text={preflight.message} />')
    expect(vercel).toContain('<FailureLines text={msg} />')
    expect(vercel).toContain('failureCopyNow(msg)')
    expect(hanamii).toContain('<FailureLines text={msg} />')
    expect(hanamii).toContain('ok ? msg : await failureCopyNow(msg)')
    expect(vercel).not.toContain('select-text">{preflight.message}</p>')
    expect(vercel).not.toContain('break-all select-text">{msg}</p>')
    expect(hanamii).not.toContain('break-all select-text">{msg}</p>')
    expect(vercel).not.toContain('navigator.clipboard.writeText(copyText)')
    expect(hanamii).not.toContain('navigator.clipboard.writeText(copyText)')
  })
  it('PublishedInventoryCard・PublishedListModal・RollbackSection・StorageNotice', () => {
    expect(read(COMP + 'PublishedInventoryCard.tsx')).toContain('<FailureLines text={inventory.message')
    expect(read(COMP + 'PublishedListModal.tsx')).toContain('読み込みに失敗しました: <FailureLines text={error} />')
    const rb = read(COMP + 'RollbackSection.tsx')
    expect(rb).toContain('⚠️ <FailureLines text={error} />')
    expect(rb).toContain('<FailureLines text={actionMsg} />')
    expect(rb).not.toContain('select-text">{actionMsg}</p>')
    const sn = read(COMP + 'StorageNotice.tsx')
    expect(sn).toContain('<FailureLines text={leftoverNote} />')
    expect(sn).not.toContain('select-text">{leftoverNote}</p>')
  })
})
