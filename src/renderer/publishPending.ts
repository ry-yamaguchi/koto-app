// publishPending.ts — 公開開始マーカー（.sakuraide.json の publish.pending）まわりの、renderer 側の名残。
//
// 2026-09-29: **renderer から .sakuraide.json へ直接書く口をなくした**（書き込みは main の
// `mergeMetaPatchFs` など1か所・入口は src/renderer/projectMeta.ts）。
//   ・`markPublishPending` は**削除した**（呼び出しが1件も無かった。マーカーを書くのは main の
//     `markPendingFs` だけ＝roadmap #20）
//   ・`clearPublishPending` は、読んで書き戻す実装をやめ、projectMeta.ts の `dismissInterruptedPublish`
//     （main が書く直前にディスクから読み直して消す・**いま公開が走っていれば断る**）へ委ねる
//
// このファイルは残骸で、呼び出しは無い（公開の画面は projectMeta.ts を直接使う）。消してよい。

import { dismissInterruptedPublish } from './projectMeta'

/**
 * 公開開始マーカーを消す（main に頼む）。公開が走っている間は消されない。
 * 消えたか（または最初から無かったか）を返す。
 */
export async function clearPublishPending(projectDir: string): Promise<boolean> {
  const r = await dismissInterruptedPublish(projectDir)
  return r.ok
}
