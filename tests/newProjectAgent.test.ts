import { describe, it, expect } from 'vitest'
import { defaultCreationBrain, pickSavedModel } from '../src/renderer/newProjectAgent'

describe('defaultCreationBrain — 新規プロジェクト作成の「担当AI」既定選択', () => {
  it('両方のキーあり・Claude頭脳モードon・保存無し → claude', () => {
    expect(defaultCreationBrain({ hasSakuraKey: true, hasClaudeKey: true, claudeModeOn: true, saved: null })).toBe('claude')
  })

  it('両方のキーあり・Claude頭脳モードoff・保存無し → sakura', () => {
    expect(defaultCreationBrain({ hasSakuraKey: true, hasClaudeKey: true, claudeModeOn: false, saved: null })).toBe('sakura')
  })

  it('さくらのキーのみ → sakura（claudeModeOn/保存値に関わらず）', () => {
    expect(defaultCreationBrain({ hasSakuraKey: true, hasClaudeKey: false, claudeModeOn: true, saved: null })).toBe('sakura')
    expect(defaultCreationBrain({ hasSakuraKey: true, hasClaudeKey: false, claudeModeOn: false, saved: 'claude' })).toBe('sakura')
  })

  it('Claudeのキーのみ → claude（claudeModeOff でも）', () => {
    expect(defaultCreationBrain({ hasSakuraKey: false, hasClaudeKey: true, claudeModeOn: false, saved: null })).toBe('claude')
  })

  it('どちらのキーも無い → null（選択欄を出さない）', () => {
    expect(defaultCreationBrain({ hasSakuraKey: false, hasClaudeKey: false, claudeModeOn: true, saved: 'claude' })).toBeNull()
  })

  it('保存値が使えるときはそれを優先する（claudeModeOn と逆でも）', () => {
    expect(defaultCreationBrain({ hasSakuraKey: true, hasClaudeKey: true, claudeModeOn: true, saved: 'sakura' })).toBe('sakura')
    expect(defaultCreationBrain({ hasSakuraKey: true, hasClaudeKey: true, claudeModeOn: false, saved: 'claude' })).toBe('claude')
  })

  it('保存値が使えない（対応するキーが無い）場合は既定へフォールバックする', () => {
    // saved='claude' だが Claude キーが無い → claudeの優先は無効化され、さくらのみ判定にフォールバック
    expect(defaultCreationBrain({ hasSakuraKey: true, hasClaudeKey: false, claudeModeOn: false, saved: 'claude' })).toBe('sakura')
    // saved='sakura' だがさくらのキーが無い → claudeのみ判定にフォールバック
    expect(defaultCreationBrain({ hasSakuraKey: false, hasClaudeKey: true, claudeModeOn: false, saved: 'sakura' })).toBe('claude')
  })

  it('保存値が不正な文字列（破損データ）でも無視して通常判定になる', () => {
    expect(defaultCreationBrain({ hasSakuraKey: true, hasClaudeKey: true, claudeModeOn: true, saved: 'unknown' })).toBe('claude')
  })
})

describe('pickSavedModel — モデル選択の保存値とフォールバック', () => {
  it('保存値が一覧にあればそれを使う', () => {
    expect(pickSavedModel('b', ['a', 'b', 'c'], 'a')).toBe('b')
  })

  it('保存値が無い（null）ときは既定（fallback）を使う', () => {
    expect(pickSavedModel(null, ['a', 'b', 'c'], 'a')).toBe('a')
  })

  it('保存値が一覧に無い（提供終了）ときは既定へフォールバックする', () => {
    expect(pickSavedModel('deprecated-model', ['a', 'b', 'c'], 'a')).toBe('a')
  })

  it('既定（fallback）も一覧に無いときは一覧の先頭を使う', () => {
    expect(pickSavedModel('deprecated-model', ['a', 'b', 'c'], 'also-gone')).toBe('a')
  })

  it('一覧が空のときは既定（fallback）をそのまま返す', () => {
    expect(pickSavedModel('b', [], 'a')).toBe('a')
    expect(pickSavedModel(null, [], 'a')).toBe('a')
  })
})
