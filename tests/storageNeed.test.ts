import { describe, it, expect } from 'vitest'
import { storageNeedFor, shouldOfferStorage, targetKeepsData, STORAGE_PORTABLE_NOTE, STORAGE_ENV_NAMES, type PublishTarget } from '../src/shared/storageNeed'

// 2026-08-13 Ryosuke 提案。永続データの要否は「AIと相談しながら作っている間に決まる」ので、
// 設定画面で申告させるのではなく**書かれたコードから検出し、公開先を選ぶ瞬間に提案する**。
//
// ここは「どの画面に何を出すか」を決める中核。**間違えると2方向に害がある**:
//   出さなすぎ → データが消えるのに黙っている（いま静かに壊れている形）
//   出しすぎ   → 要らないのに月495円を勧める

const STATELESS: PublishTarget[] = ['sakura-apprun', 'hanamii', 'vercel']

describe('公開先がデータを保持できるか', () => {
  it('コンテナ・サーバーレスは保持できない', () => {
    for (const t of STATELESS) expect(targetKeepsData(t)).toBe(false)
  })

  it('レンタルサーバは保持できる', () => {
    expect(targetKeepsData('sakura-rental')).toBe(true)
  })
})

describe('保存場所の要否', () => {
  it('データを扱っていなければ何も出さない', () => {
    const need = storageNeedFor({ usesDataLayer: false, writesFiles: false, target: 'sakura-apprun' })
    expect(need.kind).toBe('none')
    expect(shouldOfferStorage(need)).toBe(false)
  })

  it('koto-data を使っていれば、保存場所が要る', () => {
    for (const t of STATELESS) {
      const need = storageNeedFor({ usesDataLayer: true, writesFiles: false, target: t })
      expect(need.kind).toBe('declared')
      expect(shouldOfferStorage(need)).toBe(true)
    }
  })

  // ★ いちばん大事な判定。動作確認では正常に見えて、再起動で消える
  it('ファイルに書いていて公開先が保持できないなら、データが失われると知らせる', () => {
    for (const t of STATELESS) {
      const need = storageNeedFor({ usesDataLayer: false, writesFiles: true, target: t })
      expect(need.kind).toBe('will-lose-data')
      expect(shouldOfferStorage(need)).toBe(true)
      expect(need.kind === 'will-lose-data' && need.note).toContain('失われ')
    }
  })

  // 要らないのに月495円を勧めない
  it('レンタルサーバならファイルは残るので、保存場所を勧めない', () => {
    const need = storageNeedFor({ usesDataLayer: false, writesFiles: true, target: 'sakura-rental' })
    expect(need.kind).toBe('target-provides')
    expect(shouldOfferStorage(need)).toBe(false)
  })

  // 既に使うと宣言しているなら、公開先が保持できても用意する（公開先を変えても引き継げる）
  it('宣言済みなら、レンタルサーバでも用意する側に倒す', () => {
    const need = storageNeedFor({ usesDataLayer: true, writesFiles: true, target: 'sakura-rental' })
    expect(need.kind).toBe('declared')
    expect(shouldOfferStorage(need)).toBe(true)
  })

  it('入力が空でも壊れない', () => {
    expect(storageNeedFor({ usesDataLayer: false, writesFiles: false, target: 'vercel' }).kind).toBe('none')
    expect(storageNeedFor({ usesDataLayer: false, writesFiles: false, target: 'vercel' }).kind).toBe('none')
  })
})

describe('利用者に見せる文言', () => {
  it('公開先を変えてもデータが引き継がれることを伝える', () => {
    expect(STORAGE_PORTABLE_NOTE).toContain('公開先を変えても')
  })

  it('Markdown 記法を混ぜない', () => {
    const notes = [
      STORAGE_PORTABLE_NOTE,
      ...(['sakura-apprun', 'sakura-rental'] as PublishTarget[]).flatMap(t =>
        [storageNeedFor({ usesDataLayer: true, writesFiles: true, target: t }),
         storageNeedFor({ usesDataLayer: false, writesFiles: true, target: t })]
          .map(n => ('note' in n ? n.note : ''))),
    ].filter(Boolean)
    for (const n of notes) expect(n).not.toMatch(/\*\*|__|`/)
  })
})

describe('アプリが使う環境変数の名前', () => {
  // 変えると既存の公開済みアプリが壊れる
  it('取り決めが変わっていないこと', () => {
    expect(STORAGE_ENV_NAMES.sort()).toEqual([
      'KOTO_STORAGE_ACCESS_KEY', 'KOTO_STORAGE_BUCKET', 'KOTO_STORAGE_ENDPOINT',
      'KOTO_STORAGE_PREFIX', 'KOTO_STORAGE_REGION', 'KOTO_STORAGE_SECRET_KEY',
    ])
  })
})
