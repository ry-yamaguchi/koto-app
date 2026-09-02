// convStore.ts — プロジェクト別チャット（IDEモード）の会話データの唯一の持ち主（B'-3c）。
//
// ── なぜ（土台の入れ替え その3c）─────────────────────────────────────
// これまで会話の持ち主は renderer の React state（ChatPanel.tsx の messages）で、
// 保存は renderer の1.5秒デバウンス＋アンマウント時フラッシュだった。ここからは main が
// メモリ（Map）で持ち、保存のデバウンスも main が行う。renderer は「見るだけ」＋
// 「書き換えの依頼（ops）を送るだけ」になる。
//
// - AI のターン（main で走っている・src/main/chat/turnRunner.ts）の出来事は、main が
//   直接ここへ当てる（renderer を経由しない＝ウィンドウの状態に依存しない書き込みの第一歩）。
// - renderer 発の書き換え（あいさつ・お知らせ・Claude経路・まとめ・全削除など）は
//   ops として main（ipc/chatStore.ts の chat:ops）へ送られ、ここで当てる。
//
// electron を import しない（node の Vitest から直接テストできるようにするため。
// fs は chatStore/file.ts 経由で、実ファイルの読み書きも本物のまま検証できる）。
// 単独チャット（ChatApp）は今回対象外・一切変えない。
import * as fs from 'fs'
import { projectChatPath } from '../chatStore/paths'
import { loadProjectChatFile, saveProjectChatFile } from '../chatStore/file'
import { applyToMessages, type ChatEvent } from '../../shared/chatEvents'
import { forStorage } from '../../shared/chatStorage'
import type { TurnMessage } from '../../shared/chatTurn'

/** 会話への書き換え1件。message系の出来事（append/replaceLast/removeLast）に加え、
 *  renderer 側の「丸ごと差し替え」（あいさつ・kickoff・全削除・移行など）を replaceAll で表す。 */
export type Op = ChatEvent<TurnMessage> | { kind: 'replaceAll'; messages: TurnMessage[] }

type Entry = {
  messages: TurnMessage[]
  /** 保存待ちのデバウンスタイマー。無ければ「直前の内容が既に保存済み」。 */
  timer: ReturnType<typeof setTimeout> | null
}

/** 保存のデバウンス（renderer が行っていたものと同じ間隔。利用者から見える振る舞いを変えない）。 */
const DEBOUNCE_MS = 1500

/** 実体：projectDir → 会話（メモリ）。 */
const store = new Map<string, Entry>()

// ── B-1a: 画面の更新を「main が当てた結果の押し出し」1本にする ─────────────────────
//
// これまで画面の更新経路は2本あった: ①renderer 発の書き換え（renderer が「画面へ即時反映」と
// 「ops 送信」の両方をやる）②main のターンの出来事（chatTurn.start の onEvent が「見ているものが
// 何か」を確かめずに当てる）。②はターン中にプロジェクトを切り替えると、走っているターンの吹き出しが
// 切り替え先の画面へ誤配される（保存は projectDir 別に正しく行われるので、壊れるのは見た目だけ）。
//
// 会話への書き換えは renderer 発（chat:ops）も main のターンの出来事（turnRunner.ts）も
// 🕘 復元の記録（backup.ts）も、**必ずこの applyConversationOps を通る**。ここが「当てた結果」を
// 通知すれば、画面へ反映する経路も1本になり、通知の projectDir を画面側が確かめることで
// 誤配は構造的に消える（違うプロジェクト宛てなら画面が受けない。ストアは正しいので、
// そのプロジェクトを次に開けば全部見える）。
/** apply のたびに呼ばれる通知先（ipc/chatStore.ts が chat:applied として画面へ配線する）。
 *  テストでは差し替える（setApplyListener(null) で外す）。 */
let applyListener: ((projectDir: string, op: Op, length: number) => void) | null = null
export function setApplyListener(cb: ((projectDir: string, op: Op, length: number) => void) | null): void {
  applyListener = cb
}

/**
 * 通知する op を「実際に当たった内容」に差し替える。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────
 * append/replaceLast は applyToMessages が stamp() で `at` を付けるが、stamp() は
 * **新しい要素を作るだけで、呼び出し元がくれた msg 自体は書き換えない**（chatTime.ts）。
 * そのため、呼び出し元の op をそのまま通知すると、画面側がこの op をもう一度
 * applyToMessages に通したときにもう一度 stamp() が走り、保存された `at` と画面の `at` が
 * （わずかだが）ずれてしまう。当てた直後の末尾要素（＝実際に保存された stamp 済みの内容）に
 * 差し替えて渡すことで、画面側の再適用が「既に at がある」を見て上書きしなくなり、一致する。
 * （replaceLast が空配列に対して何もしなかった場合は末尾要素が無いので、元の op のまま渡す＝
 *  画面側も同じく何もしない。）
 */
function appliedOpFor(op: Op, messagesAfter: TurnMessage[]): Op {
  if (op.kind === 'append') {
    const last = messagesAfter[messagesAfter.length - 1]
    return last ? { kind: 'append', msg: last } : op
  }
  if (op.kind === 'replaceLast') {
    const last = messagesAfter[messagesAfter.length - 1]
    return last ? { kind: 'replaceLast', msg: last } : op
  }
  return op
}

/** ファイルから読んで配列にする（畳めない・無ければ null）。chatStore/file.ts の
 *  loadProjectChatFile（v1/v2 fold）をそのまま使う。 */
function readFromFile(projectDir: string): TurnMessage[] | null {
  try {
    const result = loadProjectChatFile(projectChatPath(projectDir))
    if (!result.ok || result.json === null) return null
    const parsed = JSON.parse(result.json)
    return Array.isArray(parsed) ? (parsed as TurnMessage[]) : null
  } catch {
    return null
  }
}

/**
 * 読み込む（初回はファイルから畳む・以後はメモリ）。
 * ファイルが無ければ null（renderer の旧localStorage移行の判定に使うので、空配列と区別する）。
 * 返す配列はコピー（呼び出し側が誤って内部の配列を書き換えないように）。
 */
export function loadConversation(projectDir: string): TurnMessage[] | null {
  const entry = store.get(projectDir)
  if (entry) return [...entry.messages]
  const fromFile = readFromFile(projectDir)
  return fromFile ? [...fromFile] : null
}

/** 未ロードの projectDir なら、先にファイルから読んでメモリへ載せる（丸ごと失わないため）。
 *  ファイルも無ければ空配列から始める。 */
function ensureEntry(projectDir: string): Entry {
  let entry = store.get(projectDir)
  if (!entry) {
    const fromFile = readFromFile(projectDir)
    entry = { messages: fromFile ?? [], timer: null }
    store.set(projectDir, entry)
  }
  return entry
}

/** 保存直前に projectDir の実在を確かめる。無ければ捨てる（削除したプロジェクトを
 *  蘇生させない・2026-07-14 の決まり。ipc/chatStore.ts の chat:saveProject と同じガード）。 */
function saveNow(projectDir: string, entry: Entry): void {
  if (!fs.existsSync(projectDir)) return
  saveProjectChatFile(projectChatPath(projectDir), JSON.stringify(forStorage(entry.messages)))
}

function scheduleSave(projectDir: string, entry: Entry): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    saveNow(projectDir, entry)
  }, DEBOUNCE_MS)
}

/** 書き換えを当てる（メモリへ即時・保存はデバウンス）。
 *  stamp はここで付けない（append/replaceLast は applyToMessages が今までどおり付ける。
 *  replaceAll はそのまま＝renderer 側が組み立てた配列をそのまま採用する）。 */
export function applyConversationOps(projectDir: string, ops: Op[], opts?: { flushNow?: boolean }): void {
  const entry = ensureEntry(projectDir)
  for (const op of ops) {
    entry.messages = op.kind === 'replaceAll' ? op.messages : applyToMessages(entry.messages, op)
    // 1 op 当てるごとに通知する（まとめて1回にしない＝replaceLast の連打がそのまま画面にも届くように。
    // B-1a）。length は当てた直後の件数（画面側の同期照合＝shared/chatEvents.ts の viewSyncDecision に使う）。
    applyListener?.(projectDir, appliedOpFor(op, entry.messages), entry.messages.length)
  }
  if (opts?.flushNow) {
    // 旧localStorageからの移行など、「元を消す前に必ずファイルへ書き切りたい」書き換えは
    // デバウンスを待たない（2026-08-28。移行直後の強制終了で、旧データは消えたのに
    // ファイルにはまだ無い、という1.5秒の窓を作らないため）。
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    saveNow(projectDir, entry)
    return
  }
  scheduleSave(projectDir, entry)
}

/** 保存待ちを即座に書き切る（quit 時・テスト用）。保存待ちが無いプロジェクトは触らない。 */
export function flushConversations(): void {
  for (const [projectDir, entry] of store) {
    if (!entry.timer) continue
    clearTimeout(entry.timer)
    entry.timer = null
    saveNow(projectDir, entry)
  }
}

/** テスト用: メモリを空にする（タイマーも止める）。 */
export function resetConversations(): void {
  for (const entry of store.values()) {
    if (entry.timer) clearTimeout(entry.timer)
  }
  store.clear()
}

/**
 * 指定した1件だけキャッシュ（メモリ上のエントリ・保存待ちタイマー）を破棄する（B'-3e-a）。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────
 * 単独チャット（ChatApp）のセッション削除は、擬似 dir（appSessionsStore.ts）ごとフォルダを
 * 再帰削除する。そのとき convStore がこの dir のエントリをメモリに持ったままだと、
 * ①保存待ちタイマーが後から発火して（もう存在しない）フォルダへ書こうとする
 * （saveNow の existsSync ガードで実害は無いが、無駄なタイマーが残り続ける）、
 * ②同じ dir 文字列が万一再利用されたとき、消したはずの古い内容がメモリから復活する——
 * という2つの取りこぼしがある。resetConversations は全プロジェクトを巻き込むため使えず、
 * この1件だけを狙って落とす口を最小追加する（既存の関数・挙動は一切変えない）。
 */
export function dropConversation(projectDir: string): void {
  const entry = store.get(projectDir)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  store.delete(projectDir)
}
