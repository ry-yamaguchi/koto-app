// aiChoiceSignal.ts — 使う AI とモデルの「記憶」と「既定」が変わったことを知らせる、モジュール内の購読口。
// window の出来事は使わない（テストの偽の window に dispatchEvent が無くても動かすため。
// 'sakura:credentials-changed' に相乗りすると、公開の画面が読み直してしまう）。
// import を持たない（claudeMode.ts・usage.ts・projectAi.ts のどれからも読めるように）。

let version = 0
const listeners = new Set<() => void>()

/** 記憶か既定が変わったと知らせる（版を1つ進めて、購読者を呼ぶ）。 */
export function notifyAiChoiceChanged(): void {
  version++
  for (const l of [...listeners]) l()
}

/** 変わったときに呼ばれる関数を登録する。戻り値は解除の関数（useSyncExternalStore の subscribe の形）。 */
export function subscribeAiChoice(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** いまの版（useSyncExternalStore のスナップショット）。 */
export function getAiChoiceVersion(): number {
  return version
}
