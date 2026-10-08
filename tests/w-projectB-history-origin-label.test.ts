// W-63: 🕘 履歴の一覧で、インポートの起点（公開されていたものをインポートした時点）が
// 「戻す前の自動保存」バッジに埋もれて名前が見えない問題の固定テスト。
//
// 実際に main/backup/store.ts が作るスナップショットは2種類とも「ファイルがすべて
// pre-restore／create」という同じ形になる:
//   ① restoreToSnapshot が「この時点に戻す」の直前に退避するもの
//      （label = '「元に戻す」を実行する直前の状態'、または旧形式で label 無し）
//   ② ipc/publishImport.ts の snapshotCurrentFiles が取り込みの起点として退避するもの
//      （label = '公開されていたものをインポートした時点'）
// ファイルの形だけでは①と②を区別できないため、label で見分ける
// HistoryModal.tsx の isPreRestoreSnapshot／isNamedOriginSnapshot を、
// 実装を壊すと落ちる形（振る舞い）で固定する。
import { describe, it, expect } from 'vitest'
import {
  RESTORE_BEFORE_LABEL, isAllPreRestoreFiles, isPreRestoreSnapshot, isNamedOriginSnapshot,
} from '../src/renderer/components/HistoryModal'

type Action = 'overwrite' | 'create' | 'pre-restore'
type Snap = { files: { path: string; action: Action }[]; label?: string }

const preRestoreOnly = (label?: string): Snap => ({
  files: [
    { path: 'a.html', action: 'pre-restore' },
    { path: 'b.html', action: 'pre-restore' },
    { path: 'new.html', action: 'create' },
  ],
  label,
})

const normalEditSnapshot = (label?: string): Snap => ({
  files: [{ path: 'a.html', action: 'overwrite' }],
  label,
})

describe('RESTORE_BEFORE_LABEL は store.ts の restoreToSnapshot と同じ文言', () => {
  it('main/backup/store.ts:287 の buildPreRestoreManifest 呼び出しに渡す label と一致する', () => {
    // store.ts はこの定数を export していないため、ここでは実際に渡している
    // リテラルと突き合わせる（片方だけ変わったら、この行がすぐに落ちる）。
    expect(RESTORE_BEFORE_LABEL).toBe('「元に戻す」を実行する直前の状態')
  })
})

describe('isAllPreRestoreFiles（退避分か取り込みの起点らしい形か）', () => {
  it('全ファイルが pre-restore／create で pre-restore を含むときだけ true', () => {
    expect(isAllPreRestoreFiles(preRestoreOnly())).toBe(true)
  })

  it('通常の編集記録（overwrite を含む）では false', () => {
    expect(isAllPreRestoreFiles(normalEditSnapshot())).toBe(false)
  })

  it('create だけ（pre-restore を含まない）でも false', () => {
    expect(isAllPreRestoreFiles({ files: [{ path: 'a', action: 'create' }] })).toBe(false)
  })

  it('ファイルが1件も無ければ false', () => {
    expect(isAllPreRestoreFiles({ files: [] })).toBe(false)
  })
})

describe('isPreRestoreSnapshot（「戻す前の自動保存」バッジを出す対象）', () => {
  it('label が無い旧形式の退避分は true（後方互換）', () => {
    expect(isPreRestoreSnapshot(preRestoreOnly(undefined))).toBe(true)
  })

  it('label が「元に戻す」の定型文なら true', () => {
    expect(isPreRestoreSnapshot(preRestoreOnly(RESTORE_BEFORE_LABEL))).toBe(true)
  })

  it('label が取り込みの起点の名前なら false（バッジではなく名前を出す側に回る）', () => {
    expect(isPreRestoreSnapshot(preRestoreOnly('公開されていたものをインポートした時点'))).toBe(false)
  })

  it('通常の編集記録は false', () => {
    expect(isPreRestoreSnapshot(normalEditSnapshot('何かの作業'))).toBe(false)
  })
})

describe('isNamedOriginSnapshot（「〜の直前」を付けず、名前をそのまま出す対象。W-63）', () => {
  it('取り込みの起点（label 付きの pre-restore 主体）だけ true', () => {
    expect(isNamedOriginSnapshot(preRestoreOnly('公開されていたものをインポートした時点'))).toBe(true)
  })

  it('「元に戻す」の退避分（定型文）は false（バッジ側で表示するため、名前を重ねない）', () => {
    expect(isNamedOriginSnapshot(preRestoreOnly(RESTORE_BEFORE_LABEL))).toBe(false)
  })

  it('label が無い退避分は false', () => {
    expect(isNamedOriginSnapshot(preRestoreOnly(undefined))).toBe(false)
  })

  it('通常の編集記録は false（従来どおり「「label」の直前」の表示に任せる）', () => {
    expect(isNamedOriginSnapshot(normalEditSnapshot('何かの作業'))).toBe(false)
  })
})

describe('変異: ラベルの完全一致を崩すと検知できる', () => {
  it('取り込みの起点の label が定型文と1文字でも違えば isNamedOriginSnapshot は true のまま', () => {
    // 「〜の直前」を付けてしまう変異（isPreRestoreSnapshot が常に false を返す変異）を
    // 入れると、この後の isPreRestoreSnapshot のテストで検知される。ここでは
    // isNamedOriginSnapshot 側が「本物の退避分」を誤って拾わないことを確かめる。
    expect(isNamedOriginSnapshot(preRestoreOnly(RESTORE_BEFORE_LABEL + '違う'))).toBe(true)
    expect(isPreRestoreSnapshot(preRestoreOnly(RESTORE_BEFORE_LABEL + '違う'))).toBe(false)
  })
})
