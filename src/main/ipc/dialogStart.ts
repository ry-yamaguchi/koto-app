// 開くダイアログの「最初に出す場所」を決める（純粋な判断。electron は読まない）。
//
// ── なぜ要るか（Electron 43）──────────────────────────────────────────
// 43 から、dialog.showOpenDialog に defaultPath を渡さないと、毎回「ダウンロード」（無ければホーム）
// から始まる。42 まで効いていた「OS が覚えている前回の場所」は使われない。
// Koto は defaultPath を渡していなかったので、フォルダやファイルを選ぶたびに
// ダウンロードから探し直すことになる。選んだ場所をこの起動の間だけ覚え、次のダイアログの
// defaultPath に渡す。まだ何も選んでいなければホームから始める。

import * as path from 'path'

/** 次のダイアログを開く場所。覚えた場所が今もフォルダとして在ればそこ、無ければホーム。 */
export function dialogStartDir(last: string | null, home: string, isDir: (p: string) => boolean): string {
  if (last && isDir(last)) return last
  return home
}

/**
 * 選ばれたものから「次に開く場所」を求める。
 * - keepSelfWhenDir=true で選ばれたものがフォルダ: そのフォルダ自身（作り場所を毎回選び直させない）
 * - ファイル選び、またはフォルダ選びでも親を見せたいとき: その親フォルダ
 */
export function rememberedDirAfterPick(picked: string, pickedIsDir: boolean, keepSelfWhenDir: boolean): string {
  return pickedIsDir && keepSelfWhenDir ? picked : path.dirname(picked)
}
