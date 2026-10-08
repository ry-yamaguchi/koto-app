import { describe, it, expect } from 'vitest'
import { WARN_MARK, hasWarnMark, warningLine, opWarningText, clockText } from '../src/shared/opsText'
import { summarizeResult } from '../src/main/projectOps'

// 処理の記録の文の部品（src/shared/opsText.ts）。**定義は1か所**（2026-09-30 検分の指摘2）。
// 以前は、同じ判断が PublishModal・AppRunPanel・apprunDedicatedActions・HanamiiPanel に別々に書かれ、
// 時刻はゼロ埋めの有無まで食い違っていた。

describe('warningLine: 警告を画面の1行にする', () => {
  it('⚠️・⚠・※ で始まっていれば、そのまま（二重に付けない）', () => {
    expect(warningLine('⚠️ 月額が続きます')).toBe('⚠️ 月額が続きます')
    expect(warningLine('⚠ 月額が続きます')).toBe('⚠ 月額が続きます')
    expect(warningLine('※ 確かめていません')).toBe('※ 確かめていません')
    expect(warningLine('  ⚠️ 前に空白')).toBe('  ⚠️ 前に空白')
  })
  it('印が無ければ「⚠️ 」を添える', () => {
    expect(warningLine('まだ動いていません')).toBe('⚠️ まだ動いていません')
    expect(warningLine('')).toBe('⚠️ ')
  })
})

describe('opWarningText: 警告から印を外す（画面が付け直す・コピー用）', () => {
  it('先頭の印（と直後の空白）だけを外す。文の途中の ⚠️ は残す', () => {
    expect(opWarningText('⚠️ 月額が続きます')).toBe('月額が続きます')
    expect(opWarningText('※ 確かめていません')).toBe('確かめていません')
    expect(opWarningText('印が無い')).toBe('印が無い')
    expect(opWarningText('前置き ⚠️ 途中')).toBe('前置き ⚠️ 途中')
  })
  it('warningLine と対で往復できる（外して付け直すと、印は1つ）', () => {
    for (const w of ['月額が続きます', '⚠️ 月額が続きます', '※ 確かめていません']) {
      expect(warningLine(opWarningText(w)).startsWith('⚠️ ')).toBe(true)
      expect((warningLine(opWarningText(w)).match(/⚠️/g) ?? []).length).toBe(1)
    }
  })
})

describe('clockText: 時刻を「HH:MM」（ゼロ埋め・端末の時計）にする', () => {
  it('1桁の時・分もゼロで埋める（画面ごとに「7:05」「07:05」と食い違わない）', () => {
    expect(clockText(new Date(2026, 8, 29, 7, 5, 0).getTime())).toBe('07:05')
    expect(clockText(new Date(2026, 8, 29, 0, 0, 0).getTime())).toBe('00:00')
    expect(clockText(new Date(2026, 8, 29, 23, 59, 59).getTime())).toBe('23:59')
  })
  it('読めなければ空文字（呼び出し側は時刻の言い回しごと省く）', () => {
    for (const bad of [NaN, Infinity, undefined, null, 'x', {}]) expect(clockText(bad as any)).toBe('')
  })
})

describe('警告の印の定義は main（記録を作る側）と画面（読む側）で同じ', () => {
  it('★ main が executed の印つきの行を警告へ移す判断は、画面の hasWarnMark と同じ印を使う', () => {
    for (const line of ['⚠️ a', '⚠ b', '※ c']) {
      expect(hasWarnMark(line)).toBe(true)
      const r = summarizeResult({ ok: true, executed: [line, '普通の行'] })
      expect(r.warnings).toEqual([line])
      expect(r.lines).toEqual(['普通の行'])
    }
    expect(WARN_MARK.test('普通の行')).toBe(false)
  })
})
