// retiredNotice.ts — チャットモードで「開いた会話のモデルが提供終了」の案内を、同じ会話へ1度だけ出すための判断。
// 案内を出した印は `${会話の id}\n${元のモデル}`。モジュールの Set に持つので、描き直し（effect の再実行）や
// チャット画面の作り直しでも2回目は出さない（IDE 側 useProjectAiChoice の noticed と同じ考え方）。

export function retiredNoticeKey(activeId: string, model: string): string {
  return `${activeId}\n${model}`
}

/**
 * 案内を出すか判断する。出すときは印を付けて true、印がすでにあれば false。
 * 判断と印付けを一度にやる（判断のあとで印を付け忘れて、2回出ることを防ぐ）。
 */
export function shouldNoticeRetired(noticed: Set<string>, activeId: string, model: string): boolean {
  const k = retiredNoticeKey(activeId, model)
  if (noticed.has(k)) return false
  noticed.add(k)
  return true
}
