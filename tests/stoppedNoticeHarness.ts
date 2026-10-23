// 「Koto の終了で止まりました」の知らせの記録を、**本物の projectOps** から取り出す道具（設計書 10.13.9・10.13.12 の N1〜N6）。
//
// 知らせを作るのは main の起動の読み戻し（adoptStoppedOps → stoppedOps.adoptStopped）だけ。画面の試験が知らせの記録の形を別に書くと、
// main が作る形と食い違っても気づけない。ここは止まった回を渡して、projectOps が実際に置いた記録を返す。
// ファイルにも userData にも触れない（メモリの中だけ）。使う側が `resetProjectOpsForTests()` で前後を空にする。
import { adoptStoppedOps, getOps } from '../src/main/projectOps'
import type { InFlightRun, StoppedEntry } from '../src/shared/inFlightOps'

export type NoticeTarget = 'sakura-apprun-dedicated' | 'sakura-apprun' | 'hanamii'

export const NOTICE_HANDLER: Record<NoticeTarget, string> = {
  'sakura-apprun-dedicated': 'apprunDedicated:teardown',
  'sakura-apprun': 'cloud:teardown',
  hanamii: 'hanamii:teardown',
}

/**
 * `dir` の削除が Koto の終了で止まった回（最後に分かった時刻 `lastSeenAt`）を渡し、projectOps が置いた知らせの記録を返す。
 * 起動時刻は最後に分かった時刻の1分後。記録は写し（あとから projectOps が変わっても動かない）。
 */
export function stoppedNotice(dir: string, target: NoticeTarget, lastSeenAt: number): ProjectOpRecordShape {
  const startedAt = lastSeenAt - 5 * 60_000
  const handler = NOTICE_HANDLER[target]
  const run: InFlightRun & { endedBy: 'quit' } = {
    op: '削除', target, handler, version: '0.6.22', startedAt, lastSeenAt,
    segments: [{ stage: 'teardown.lb', startedAt }], endedBy: 'quit',
  }
  const entry: StoppedEntry = { op: '削除', target, handler, runs: [run], noticeSeen: false }
  adoptStoppedOps({ [dir]: entry }, lastSeenAt + 60_000)
  const last = getOps(dir).last
  if (!last) throw new Error('知らせの記録が置かれなかった')
  return JSON.parse(JSON.stringify(last)) as ProjectOpRecordShape
}
