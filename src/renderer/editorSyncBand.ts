// editorSyncBand.ts — エディタの帯（外で書き換わった・消えた・読めない）の文と、帯の操作の流れ（renderer。React には依存しない）。
//
// 保存を止めたタブ（syncMark のあるタブ）には、利用者が選ぶまで書かない旨を帯で知らせる。
// 帯は EditorPanel の1か所に出し、文はここに集める。帯のボタンを押したときの流れ（確認 → 実行）もここ1つを通る。

import type { OpenFile, SaveBlock } from './editorTabs'
import { runReloadExternal } from './confirmedActions'

/** 帯のボタン。 */
export type BandAction = 'reload' | 'keep' | 'recreate' | 'close' | 'retry'

export interface SyncBand {
  message: string
  actions: Array<{ id: BandAction; label: string }>
}

const BANDS: Record<SaveBlock, SyncBand> = {
  changed: {
    message: 'このファイルは Koto の外で書き換えられました。',
    actions: [
      { id: 'reload', label: '外の内容を読み込む' },
      { id: 'keep', label: '自分の編集を保存する' },
    ],
  },
  missing: {
    message: 'このファイルは Koto の外で削除または移動されました。',
    actions: [
      { id: 'recreate', label: '自分の内容で作り直す' },
      { id: 'close', label: '閉じる' },
    ],
  },
  unreadable: {
    message: 'このファイルを読めないため、保存していません。Finder で権限を確かめてください。',
    actions: [
      { id: 'retry', label: 'もう一度保存する' },
    ],
  },
}

/**
 * 印に合う帯。印が無ければ null（帯を出さない）。
 * 知らない印は「読めない」の帯にする（書いていないのに帯が出ない、という無言の失敗にしない）。
 */
export function syncBandOf(mark: string | undefined): SyncBand | null {
  if (!mark) return null
  return Object.prototype.hasOwnProperty.call(BANDS, mark) ? BANDS[mark as SaveBlock] : BANDS.unreadable
}

/** 「外の内容を読み込む」の確認（赤い確認）。 */
export const RELOAD_CONFIRM = {
  title: '外の内容を読み込みます',
  body: '保存していない編集は消えます。',
  confirmLabel: '読み込む',
} as const

/** 帯のボタンが呼ぶ口。 */
export interface BandDeps {
  /** 「外の内容を読み込む」の確認。true なら読み込む。 */
  confirmReload(body: string): Promise<boolean>
  reload(path: string): unknown | Promise<unknown>
  keepMine(path: string): unknown | Promise<unknown>
  recreate(path: string): unknown | Promise<unknown>
  save(path: string, content: string): unknown | Promise<unknown>
  /** 未保存の編集があれば閉じる前の確認も含めて閉じる（タブの × と同じ道）。 */
  close(file: OpenFile): unknown | Promise<unknown>
}

/** 帯のボタンを押したときの流れ。知らないボタンは何もしない。 */
export async function runBandAction(file: OpenFile, action: BandAction, deps: BandDeps): Promise<void> {
  switch (action) {
    case 'reload':
      await runReloadExternal(file.path, file.isDirty, RELOAD_CONFIRM.body, { confirm: deps.confirmReload, reload: deps.reload })
      return
    case 'keep': await deps.keepMine(file.path); return
    case 'recreate': await deps.recreate(file.path); return
    case 'retry': await deps.save(file.path, file.content); return
    case 'close': await deps.close(file); return
  }
}

/** 保存できなかったファイルの名前を並べる（5つまで。残りは件数）。 */
function unsavedNames(unsaved: Array<{ name: string }>): string {
  const SHOWN = 5
  const names = unsaved.slice(0, SHOWN).map(f => `・${f.name}`)
  if (unsaved.length > SHOWN) names.push(`ほか ${unsaved.length - SHOWN} 件`)
  return names.join('\n')
}

/**
 * 「保存して終了」で保存できなかったファイルを知らせる文（終了しなかったとき）。
 * 帯が出ているのは印のあるタブだけ（syncBandOf が返すもの）。印が無いまま残ったタブは、書き込みに失敗したか、保存の間に編集が続いている。
 * 無い案内を指さないよう、帯のあるファイルと無いファイルで確かめる先を言い分ける。
 */
export function quitBlockedNotice(unsaved: Array<{ name: string; syncMark?: string }>): { title: string; body: string; confirmLabel: string; cancelLabel: string } {
  const guided = unsaved.some(f => syncBandOf(f.syncMark) !== null)
  const plain = unsaved.some(f => syncBandOf(f.syncMark) === null)
  const checks: string[] = []
  if (guided) checks.push('ファイルの上の案内を確かめて')
  if (plain) checks.push(guided ? '案内が出ていないファイルは、保存先の権限と空き容量を確かめて' : '保存先の権限と空き容量を確かめて')
  return {
    title: '終了しませんでした',
    body: `保存できていないファイルがあります。\n${unsavedNames(unsaved)}\n${checks.join('、')}から、もう一度終了してください。`,
    confirmLabel: 'ファイルを見る',
    cancelLabel: '閉じる',
  }
}

/** タブをまるごと手放す操作。プロジェクトの切り替えと、フォルダの整理（整理のあとタブは全部閉じる）。 */
export type LeaveAction = 'switch' | 'organize'

const LEAVE_VERB: Record<LeaveAction, { when: string; label: string }> = {
  switch: { when: '切り替えると', label: '保存せずに切り替える' },
  organize: { when: '整理すると', label: '保存せずに整理する' },
}

/** タブを手放す前に保存できなかったファイルがあるときの確認（赤い確認）。断ると切り替えない・整理しない。 */
export function leaveUnsavedNotice(unsaved: Array<{ name: string }>, action: LeaveAction = 'switch'): { title: string; body: string; confirmLabel: string; danger: true } {
  const v = LEAVE_VERB[action]
  return {
    title: '未保存の変更があります',
    body: `保存できていないファイルがあります。\n${unsavedNames(unsaved)}\n${v.when}、保存していない編集は消えます。`,
    confirmLabel: v.label,
    danger: true,
  }
}
