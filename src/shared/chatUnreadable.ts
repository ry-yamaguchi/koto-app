// 読めなかった会話の記録の知らせ（0.6.26）。main が会話を読んだ結果（chat:load の返り値）で運ぶ形と、
// 画面に出す知らせの文。electron にも window にも触れない（node からそのままテストできる）。
//
// 読めなかった記録は「会話が無い」とは違う。main は読んだ時点で元のファイルを
// `<元の名前>.broken-<日時>` へ写し、その名前を backupName で渡す。写しを作れなかった回は
// backupName が null で、その会話には書き込まない。
// チャットモードの会話の一覧（索引）が読めなかった回も同じ形で運ぶ（appSessions:list の返り値）。
import { APP_CHAT_DIRNAME, sessionDir } from './appChatDirs'

/** 読めなかった記録の知らせ。写しの名前（作れなかった回は null）を運ぶ。 */
export type UnreadableChat = { backupName: string | null }

/**
 * IPC で受け取った値から知らせを取り出す。
 * 無い（null・undefined）以外はすべて「読めなかった」と読む。写しの名前が文字列でなければ null
 * （＝写しが無い側の文）に倒すので、形の分からない値が来ても「写しがある」とは言わない。
 */
export function unreadableFrom(raw: unknown): UnreadableChat | null {
  if (raw === undefined || raw === null) return null
  const name = typeof raw === 'object' ? (raw as { backupName?: unknown }).backupName : undefined
  return { backupName: typeof name === 'string' && name !== '' ? name : null }
}

/**
 * IPC で受け取った値から、同じフォルダに残っている写しの名前の一覧を取り出す。
 * 配列でなければ空、文字列でない要素と空の名前は捨てる（形の分からない値が来ても「写しがある」とは言わない）。
 */
export function copiesFrom(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((n): n is string => typeof n === 'string' && n !== '')
}

/** IDE の会話の写しを置く場所（プロジェクトの `.sakuraide` フォルダ）。 */
export const IDE_CHAT_BACKUP_PLACE = 'プロジェクトの .sakuraide フォルダ'

/** 会話の記録を読めなかったときの知らせの文。`place` は写しを置いた場所（利用者が開ける場所）。 */
export function chatUnreadableText(unreadable: UnreadableChat, place: string): string {
  const lead = '前の会話の記録を読めませんでした。'
  if (unreadable.backupName === null) return `${lead}この会話には書き込みません。`
  return `${lead}元の記録は ${place} に ${unreadable.backupName} として残してあります。`
}

/** チャットモードの会話の写しを置く場所（その会話の保存フォルダ。利用者が開ける場所）。 */
export function sessionBackupPlace(workspaceDir: string, sessionId: string): string {
  return `${sessionDir(workspaceDir, sessionId)}/.sakuraide`
}

/** チャットモードの会話の一覧（索引）の写しを置く場所。 */
export function sessionsIndexBackupPlace(workspaceDir: string): string {
  return `${workspaceDir}/${APP_CHAT_DIRNAME}`
}

/**
 * チャットモードの会話の一覧を読めなかったときの知らせの文。`place` は写しを置いた場所。
 * 「読めるようになるまで」は、Koto を開き直して一覧を読み込み直した時点までの意味（動いている間は読み直さない）。
 */
export function sessionsIndexUnreadableText(unreadable: UnreadableChat, place: string): string {
  if (unreadable.backupName === null) {
    return '会話の一覧を読めませんでした。一覧には書き込まないので、この間に作った会話は一覧に残りません。'
  }
  return `会話の一覧を読めませんでした。元の一覧は ${place} に ${unreadable.backupName} として残してあります。読めるようになるまで一覧には書き込まないので、この間に作った会話は一覧に残りません。`
}
