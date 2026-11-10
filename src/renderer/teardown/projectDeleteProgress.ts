// teardown/projectDeleteProgress.ts — プロジェクトの削除の窓が、待っている間に出す進み具合の1行を、処理の記録から読む。React に依存しない。
//
// HANAMII が削除を受け付けた（202）あと、Koto は最長で約5分待つ（main の hanamii:teardown の中）。その間、窓は閉じられない（busy）ので、
// 何を待っているかを1行で見せる。読むのは **このプロジェクトの記録の、走っている HANAMII の破棄** だけ（別の公開先・別の種類の操作は出さない。掟11）。
// 文は main が記録の progress に入れたもの（定数 HANAMII_DELETION_WAIT_PROGRESS と「N秒経過」。秘密は main が伏せてある）を、
// 進み具合の一文の読み方の1つ（projectOpsView.ts の opProgressText）で読む。ここに文を書かない。「見た」とも伝えない（ack しない）。
import { opProgressText } from '../projectOpsView'
import { isTeardownRecordOf } from './watch'

/** 走っている HANAMII の破棄の進み具合の1行。走っていない・文が空なら null。 */
export function projectDeleteProgressLine(snap: Partial<ProjectOpsSnapshotShape> | null | undefined): string | null {
  const running = snap?.running
  if (!running || running.running !== true || !isTeardownRecordOf('hanamii', running)) return null
  const text = opProgressText(running)
  return text === '' ? null : text
}
