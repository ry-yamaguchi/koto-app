// teardown/readTwins.ts — 覆う複製（同じ親フォルダの別のフォルダで、自分の公開の記録をすべて持つもの。R2-d）の名前を、main の cloud:recordTwins から読む（読むだけ・投げない）。
//
// 0.6.24 I-3（作者の決定 K1）。プロジェクトの削除の材料（projectDeleteFacts.ts の `twins`）が使う。覆うかどうかの判断は main の `recordCoverFs` の1つ
// （破棄の骨の `twinsOf` は、より広い「重なる」の `recordTwinsFs`）。ここは答えを受け取って形を確かめるだけで、複製かどうかを自分では決めない。
//
// **読めなかった回は null を返す**（外さない側）。null のとき plan は何も外さず、main が破棄の前に改めて確かめて断る（step が failed になりフォルダは移らない）。
// 次はすべて null: window・口が無い／投げた／`ok:true` でない／`twins` が無い・3つの公開先のどれかが配列でない・名前に文字列でない値や空文字がある。
// 形の違う答えを「複製なし」と読んで空の配列に直さない（読めなかったことを隠すと、画面が複製を知らないまま専有型の止めを出し続ける）。
import { TWIN_TARGETS, type RecordTwinsFacts } from './projectDeleteTwins'

export async function readRecordTwins(dir: string): Promise<RecordTwinsFacts | null> {
  try {
    const r: unknown = await window.electronAPI.cloud.recordTwins(dir)
    if (typeof r !== 'object' || r === null || (r as { ok?: unknown }).ok !== true) return null
    const twins = (r as { twins?: unknown }).twins
    if (typeof twins !== 'object' || twins === null || Array.isArray(twins)) return null
    const out = {} as Record<(typeof TWIN_TARGETS)[number], string[]>
    for (const t of TWIN_TARGETS) {
      const names = (twins as Record<string, unknown>)[t]
      if (!Array.isArray(names) || !names.every(n => typeof n === 'string' && n !== '')) return null
      out[t] = [...names]
    }
    return out
  } catch {
    return null // 読めなかった。複製の有無は分からない（外さない）
  }
}
