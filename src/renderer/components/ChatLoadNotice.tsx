// 会話の記録を読めなかったことの知らせ（0.6.26）。
//
// 読めなかった記録は、画面では空の会話に見える。何も言わないと、利用者は会話が消えた理由も、
// 元の記録が残っていることも分からない。ここは、読めなかった事実と、写しの場所・名前（または
// 書き込まない旨）を言うだけの帯。文は shared/chatUnreadable.ts が作る
// （会話の記録は chatUnreadableText、チャットモードの会話の一覧は sessionsIndexUnreadableText）。
// IDE のチャット（ChatPanel）とチャットモード（ChatApp）が、写しを置いた場所の言い方だけ変えて使う。
import {
  chatUnreadableText, sessionsIndexUnreadableText, sessionBackupPlace, sessionsIndexBackupPlace, type UnreadableChat,
} from '../../shared/chatUnreadable'
import { CHAT_TEXT_WRAP } from '../textWrap'

export default function ChatLoadNotice({ unreadable, place, subject = 'conversation' }: {
  /** 読めなかった記録の知らせ。null（読めた）なら何も出さない。 */
  unreadable: UnreadableChat | null
  /** 写しを置いた場所（利用者が開ける場所の言い方）。写しを作れなかった回は使わない。 */
  place: string
  /** 何を読めなかったか。会話の記録（既定）か、チャットモードの会話の一覧か。 */
  subject?: 'conversation' | 'index'
}) {
  if (!unreadable) return null
  const text = subject === 'index'
    ? sessionsIndexUnreadableText(unreadable, place)
    : chatUnreadableText(unreadable, place)
  return (
    <div className="flex justify-center" role="status">
      <div className="w-full max-w-[90%] rounded-xl border border-sakura/60 bg-surface px-3 py-2 select-text">
        <p className={`text-[12px] text-ink ${CHAT_TEXT_WRAP}`}>{text}</p>
      </div>
    </div>
  )
}

/**
 * チャットモードの知らせ。会話の一覧（索引）の分と、表示中の会話の記録の分を、1つの帯の中に出す。
 * どちらも読めた起動（null）・保存先がまだ定まっていない間は何も描かない（空の帯の余白も出さない）。
 * 片方だけ読めなかった回は、その1つだけを描く。
 */
export function ChatAppLoadNotices({ workspaceDir, sessionId, indexUnreadable, activeUnreadable }: {
  /** 会話の置き場。読み込み完了までは null。 */
  workspaceDir: string | null
  /** 表示中の会話の id。 */
  sessionId: string
  /** 会話の一覧（索引）を読めなかった知らせ。 */
  indexUnreadable: UnreadableChat | null
  /** 表示中の会話の記録を読めなかった知らせ。 */
  activeUnreadable: UnreadableChat | null
}) {
  if (!workspaceDir || (!indexUnreadable && !activeUnreadable)) return null
  return (
    <div className="flex-none space-y-2 px-4 pt-3">
      <ChatLoadNotice subject="index" unreadable={indexUnreadable} place={sessionsIndexBackupPlace(workspaceDir)} />
      <ChatLoadNotice unreadable={activeUnreadable} place={sessionBackupPlace(workspaceDir, sessionId)} />
    </div>
  )
}
