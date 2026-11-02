// greetSetting.ts — 設定「プロジェクトを開いたとき AI があいさつする」の保存と読み出し。
//
// 値は localStorage に置く。'off' のときだけオフで、未設定・ほかの値・読み出しの失敗はオン（既定）。
// 読み出しに失敗したときに黙ってオフへ倒すと、利用者が付けた覚えのない設定になるので、既定の側へ倒す。
// 書き込みは setGreetOnOpen の1つだけ（同じキーへの setItem をほかへ置かない）。

/** 保存先のキー。値は 'on' または 'off'。 */
export const GREET_ON_OPEN_KEY = 'sakura_greet_on_open'

/** 設定の表示名。設定画面・README・使い方ガイドは、すべてこの文字列を指す。 */
export const GREET_ON_OPEN_LABEL = 'プロジェクトを開いたとき AI があいさつする'

/** あいさつが有効か。'off' が保存されているときだけ false。 */
export function isGreetOnOpenEnabled(): boolean {
  try {
    return localStorage.getItem(GREET_ON_OPEN_KEY) !== 'off'
  } catch {
    return true
  }
}

/** あいさつのオン／オフを保存する（唯一の書き込み口）。保存できたら true、できなければ false。 */
export function setGreetOnOpen(on: boolean): boolean {
  try {
    localStorage.setItem(GREET_ON_OPEN_KEY, on ? 'on' : 'off')
    return true
  } catch {
    return false
  }
}
