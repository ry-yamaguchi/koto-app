// chatDeleteGuard.ts — チャットモード（ChatApp）で会話を削除するときの、確認の要否の判断（0.6.26）。
//
// 削除は会話のフォルダごと完全に消す。読めなかった記録（壊れた chat.json）を「空」と読んで確認なしに
// 消すと、元の記録も、読み込みの時点で作った写しも、一緒に消える。そこで、確認なしで消してよいのは
// 「読めて、空」と分かった回だけにする。読めなかった・読み込みそのものが失敗した・形が違う回は、
// 中身が分からないので確認を出す。React にも window にも触れない（偽の読み込みと偽の確認でそのまま試せる）。
// 確認を通ったときだけ消す門は confirmedActions.ts の runDeleteConversation をそのまま使う。
import { runDeleteConversation, type ActionOutcome, type ConfirmFn } from './confirmedActions'
import type { UnreadableChat } from '../shared/chatUnreadable'

/** 会話の記録を読んだ結果のうち、削除の判断に使う部分（chatConvClient の ConversationLoad の一部）。 */
export interface DeleteLoad {
  /** 読み込みに成功し、記録を読めたか。読み込みの失敗・読めなかった記録は false。 */
  readable: boolean
  /** 読めなかった記録の知らせ。読めた回は null。 */
  unreadable: UnreadableChat | null
  /** 読んだ会話。表示中の会話の「覚えておいた結果」には無い（そのときは画面の数を見る）。 */
  messages?: unknown
  /** 記録は読めたが、同じフォルダに読めなかった記録の写しが残っているときの、その名前。無ければ付かない。 */
  copies?: string[]
}

/** 保存先がまだ無い（読み込み前の）間は、ディスクに消えるものが無い。 */
export const NOTHING_ON_DISK: DeleteLoad = { readable: true, unreadable: null, messages: [] }

/** none＝確認なしで消す／messages＝中身があるので確認／unreadable＝中身が分からないので確認／copies＝読めなかった記録の写しも消えるので確認。 */
export type DeleteConfirmKind = 'none' | 'messages' | 'unreadable' | 'copies'

/**
 * 確認の要否と種類を決める。
 * `shownLength` は表示中の会話の吹き出しの数（表示していない会話は null）。`load` は記録を読んだ結果で、
 * 読み込みが失敗して結果が無い回は null。読めたと言い切れない回は、すべて 'unreadable'。
 */
export function deleteConfirmKind(input: { shownLength: number | null; load: DeleteLoad | null }): DeleteConfirmKind {
  const { shownLength, load } = input
  // 読めたと言い切れない回は、読めなかった記録と同じに扱う（読めて空、ではない）
  if (load === null || !load.readable || load.unreadable !== null) return 'unreadable'
  // 読んだ会話が配列でなければ形が違う
  if (load.messages !== undefined && !Array.isArray(load.messages)) return 'unreadable'
  // 記録は読めても、フォルダには前に読めなかった記録の写しがある（消すと写しも消える。会話が空でも確認する）
  if (load.copies !== undefined && load.copies.length > 0) return 'copies'
  const loaded = Array.isArray(load.messages) ? load.messages.length : 0
  return Math.max(shownLength ?? 0, loaded) > 0 ? 'messages' : 'none'
}

/** 確認の本文。題（「会話を削除します」）は呼び手が付ける。 */
export function deleteConfirmBody(kind: Exclude<DeleteConfirmKind, 'none'>, title: string): string {
  if (kind === 'unreadable') return `「${title}」の記録を読めませんでした。削除すると、読めなかった記録も消えます。元に戻せません。`
  if (kind === 'copies') return `「${title}」を削除します。この会話の保存フォルダにある、読めなかった記録の写しも消えます。元に戻せません。`
  return `「${title}」を削除します。よろしいですか？（元に戻せません）`
}

export interface DeleteSessionArgs {
  id: string
  /** 確認の本文に入れる会話の題。 */
  title: string
  /** 表示中の会話の、画面にある吹き出しの数。表示していない会話は null。 */
  shownLength: number | null
  /** 表示中の会話について、読み込んだときに覚えておいた結果。無ければ null（そのときは読みに行く）。 */
  known: DeleteLoad | null
  /** 記録を読みに行く（保存先が無い間は NOTHING_ON_DISK を返す）。 */
  read: () => Promise<DeleteLoad>
}

export interface DeleteSessionDeps {
  confirm: ConfirmFn
  /** 実際の削除（索引・フォルダ・画面の状態からの除去）。確認を通ったとき、または読めて空だったときだけ呼ばれる。 */
  remove: (id: string) => void | Promise<void>
}

/**
 * 会話を1件削除する。覚えておいた結果（なければ読んだ結果）で確認の要否を決め、
 * 読めて空なら確認なしで消し、それ以外は確認を出して、通ったときだけ消す。
 * 読むのに失敗しても消さずに確認へ進む。
 */
export async function runDeleteSession(args: DeleteSessionArgs, deps: DeleteSessionDeps): Promise<ActionOutcome<void>> {
  let load = args.known
  if (load === null) {
    try { load = await args.read() } catch { load = null }
  }
  const kind = deleteConfirmKind({ shownLength: args.shownLength, load })
  if (kind === 'none') {
    await deps.remove(args.id)
    return { cancelled: false, result: undefined }
  }
  return runDeleteConversation(args.id, deleteConfirmBody(kind, args.title), {
    confirm: deps.confirm,
    remove: (id) => deps.remove(id),
  })
}
