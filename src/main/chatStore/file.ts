// chat.json（IDEのプロジェクト別チャット履歴、v2追記式）の実ファイル読み書きを担う層。
// electron に依存しない（ipcMain を import しない）。理由: 本物の一時フォルダで直接テストできる
// ようにするため（2026-08-27 指摘）。以前は ipc/chatStore.ts に置いたままだったので、テストは
// readCode でソース文字列を見るだけの弱い手段しか使えず、実際に shouldRewrite の呼び出し引数を
// 入れ替えるミューテーションを検知できなかった（実測で確認済み）。呼び出し側（ipc/chatStore.ts）は
// projectChatPath() を組み立て、fs.existsSync(projectDir) のガードを掛けて、ここの2関数を呼ぶだけの
// 薄い層にする。
//
// ここが持つ状態は cache（前回このプロセスが自分で書いた内容の写し）だけ。cache が指す実体は
// ファイルなので、fs の読み書きだけで完結し、electron が無くても（Vitest からでも）動く。
import * as fs from 'fs'
import * as path from 'path'
import {
  foldChatLogDetailed,
  rewriteChatLog,
  appendChatLog,
  shouldRewrite,
  serializeMessages,
  isV1ChatLog,
  isBlankChatLog,
  touchCache,
} from './log'
import { readFileState, copyBrokenOnce, resetBrokenCopyMemory, type BrokenCopy } from './brokenCopy'

/**
 * cache に同時に保持するファイルの上限。プロジェクトを切り替えるたびに前の会話が cache に
 * 残り続け、main のメモリが増え続けるのを防ぐ（2026-08-27 指摘。実測 landingTEST 5.5MB /
 * newproject 1.6MB が main プロセスに残っていた）。超えた分は touchCache が最も古く使った
 * ものから捨てる。捨てられても、次にそのファイルを保存するときは「cache 無し→書き直し」に
 * 自然に落ちるだけなので、動作は壊れない。
 */
const CACHE_LIMIT = 4

/** 読めなかった記録の知らせ。写しの名前（作れなかった回は null）を運ぶ。 */
export type UnreadableChat = BrokenCopy

// 前回このプロセスが書いた chat.json の内容。key はファイルパス。無ければ「まだ読んでいない/
// 書いていない」ので、次の保存は必ず書き直しになる（cache 経由でしか追記しない＝v1 ファイルへ
// 誤って追記することが無い）。
const cache = new Map<string, { lines: string[]; bytes: number }>()

/** テスト用に cache を空にする（モジュール内の状態はテスト間で残り続けるため）。 */
export function resetChatLogCache(): void {
  cache.clear()
  resetBrokenCopyMemory() // 壊れた記録の写しの記憶も、アプリを起動し直した状態に戻す
}

/** mkdir -p してから .tmp に書き、rename する（クラッシュ時の破損防止）。 */
function atomicWriteFileSync(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

/** 行の配列の合計バイト数（UTF-8）。 */
function totalBytes(lines: string[]): number {
  return lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf-8'), 0)
}

/** 実際のファイルサイズ（バイト）。無い/読めなければ null。 */
function actualFileBytes(filePath: string): number | null {
  try {
    return fs.statSync(filePath).size
  } catch {
    return null
  }
}

/** 読んだ記録の見立て。loadProjectChatFile と、書き直しの前の歯止め（saveProjectChatFile）が同じ見立てを使う。 */
type Inspection =
  | { kind: 'missing' }
  | { kind: 'blank' }
  /** 読めない・畳めない。unreadable は写しの結果（読み出せないファイルは写しも作れず backupName が null）。 */
  | { kind: 'unreadable'; unreadable: UnreadableChat }
  /** 畳めた。途中の壊れた行で記録の一部を捨てた回は、元の記録を写してあり unreadable に入る。 */
  | { kind: 'folded'; text: string; folded: NonNullable<ReturnType<typeof foldChatLogDetailed>>; unreadable: UnreadableChat | null }

/**
 * ファイルを読んで、読めない記録なら元のファイルを写す（写すだけ。元は消さず名前も変えない）。
 * 畳めても、途中の壊れた行を捨てた回（その後ろの「穴を開ける」行も捨てる）は記録の一部を失っているので、
 * 読めない側に数える。書きかけで切れた最後の1行だけを捨てた回は、クラッシュで起きる普通の形なので読めた側。
 */
function inspectChatFile(filePath: string): Inspection {
  const state = readFileState(filePath)
  if (state.kind === 'missing') return { kind: 'missing' }
  // 読めないファイルは写しも作れない。「無い」と同じに返すと、次の保存で置き換えてしまう
  if (state.kind === 'unreadable') return { kind: 'unreadable', unreadable: { backupName: null } }
  const text = state.bytes.toString('utf-8')
  const folded = foldChatLogDetailed(text)
  const lossy = folded !== null && folded.dropped - (folded.tornTail ? 1 : 0) > 0
  if (folded !== null && !lossy) return { kind: 'folded', text, folded, unreadable: null }
  if (folded === null && isBlankChatLog(text)) return { kind: 'blank' }
  // ここへ来るのは、読めない回と、畳めたが記録の一部を捨てた回。どちらも元の記録を1か所で写す
  const copy = copyBrokenOnce(filePath, state.bytes)
  return folded === null ? { kind: 'unreadable', unreadable: copy } : { kind: 'folded', text, folded, unreadable: copy }
}

/**
 * IDEのプロジェクト別チャット履歴を読む。
 * - ファイルが無い（ENOENT）・空 → { ok: true, json: null }（今までどおり。守る中身が無い）
 * - 読めない・畳めない → { ok: true, json: null, unreadable }（0.6.26）。json が null のままなので
 *   旧 localStorage の移行の判定は変わらず、`unreadable` で「無い」と区別する。読み込んだ時点で元のファイルを
 *   `chat.json.broken-<日時>` へ写し（写すだけ。元は消さず名前も変えない）、その名前を `backupName` で運ぶ。
 *   写しを作れなかった回は `backupName: null`（呼び出し側はその会話へ書き込まない）。
 * - 畳めたが、途中の壊れた行で記録の一部を捨てた → 読めた分の json と `unreadable`（上と同じ写し）を一緒に返す。
 */
export function loadProjectChatFile(
  filePath: string
): { ok: true; json: string | null; unreadable?: UnreadableChat } | { ok: false; message: string } {
  try {
    const found = inspectChatFile(filePath)
    if (found.kind === 'missing' || found.kind === 'blank') return { ok: true, json: null }
    if (found.kind === 'unreadable') return { ok: true, json: null, unreadable: found.unreadable }
    const { text, folded } = found
    // ⚠️ cache するのは実物のファイルが v2 のときだけにする。v1 のまま cache すると、次の
    // 保存が「cache あり＝追記」の経路に入り、v1 ファイル（配列まるごと）へ v2 のJSONL行を
    // そのまま fs.appendFileSync してしまう。書式が混在した chat.json は foldChatLog で
    // 丸ごと読めなくなる（先頭が '[' なので v1 として JSON.parse され、末尾の余分な行で
    // 失敗して null になる＝会話が消えて見える）。v1 は cache しないことで、次の保存は
    // 必ず「cache無し→書き直し」を通り、そこで安全に v2 へ移行する。
    //
    // ⚠️ 行を捨てた回と、本文が改行で終わっていない回（書きかけで切れた末尾）も cache しない。
    // cache すると次の保存が切れた行のすぐ後ろへ追記し、その行が壊れた1行になって、それより後の記録は
    // 次の起動で穴として全部捨てられる。cache しなければ次の保存は書き直しになり、切れた行は消える。
    if (!isV1ChatLog(text) && folded.dropped === 0 && text.endsWith('\n')) {
      touchCache(
        cache,
        filePath,
        { lines: folded.lines, bytes: Buffer.byteLength(text, 'utf-8') },
        CACHE_LIMIT
      )
    }
    // 呼び出し側（renderer）には今まで通り配列の JSON を渡す（画面から見て何も変わらない）
    const json = '[' + folded.lines.join(',') + ']'
    return found.unreadable ? { ok: true, json, unreadable: found.unreadable } : { ok: true, json }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
}

/** 読めなかった記録の写しを作れない回に、置き換えを断るときの文。 */
const UNREADABLE_NOT_REPLACED = '読めなかった記録の写しを作れなかったので、書き込みません'

/** IDEのプロジェクト別チャット履歴を保存する（json は「配列のJSON文字列」であることを呼び出し側が保証する）。 */
export function saveProjectChatFile(
  filePath: string,
  json: string
): { ok: true } | { ok: false; message: string } {
  try {
    const arr = JSON.parse(json)
    if (!Array.isArray(arr)) return { ok: false, message: '不正なJSON形式です' }

    const nextLines = serializeMessages(arr)
    const contentBytes = totalBytes(nextLines)
    const cached = cache.get(filePath)

    // cache が無い、または実ファイルのサイズが cache の記録と食い違っている（外から消された・
    // 置き換えられた等）ときは、追記の土台が信用できないので書き直す。書き直しは丸ごと置き換え
    // なので、どちらの原因でも安全に復帰できる。
    //
    // ⚠️ 2026-08-27 指摘: 丸ごと書き直していた頃は、ファイルが外から消されても次の保存で
    // 自然に治っていた。追記化でその「治る性質」を失わないよう、追記の直前に実サイズを確認する。
    const cacheValid = !!cached && actualFileBytes(filePath) === cached.bytes
    if (!cacheValid) {
      // 書き直しは今のファイルを置き換える。読めない記録（壊れた・捨てた行がある）の上へ置き換えるなら、
      // 先に写しを残す。写しを作れなければ書かない（読み込みを挟まずに呼ばれても、元の記録を失わない）
      const current = inspectChatFile(filePath)
      if ('unreadable' in current && current.unreadable?.backupName === null) return { ok: false, message: UNREADABLE_NOT_REPLACED }
      const content = rewriteChatLog(nextLines)
      atomicWriteFileSync(filePath, content)
      touchCache(cache, filePath, { lines: nextLines, bytes: Buffer.byteLength(content, 'utf-8') }, CACHE_LIMIT)
      return { ok: true }
    }

    const appended = appendChatLog(cached!.lines, nextLines)
    if (appended === '') return { ok: true } // 変化なし。何も書かない

    const appendedBytes = Buffer.byteLength(appended, 'utf-8')
    if (shouldRewrite(cached!.bytes + appendedBytes, contentBytes)) {
      const content = rewriteChatLog(nextLines)
      atomicWriteFileSync(filePath, content)
      touchCache(cache, filePath, { lines: nextLines, bytes: Buffer.byteLength(content, 'utf-8') }, CACHE_LIMIT)
    } else {
      // 追記は appendFileSync（tmp+renameではない）。途中で落ちて行が切れても、読む側
      // （foldChatLog）が壊れた行を捨てるので会話全体は失われない。切れた行が末尾に残った回は、
      // 次に読むとき cache せず（loadProjectChatFile）、次の保存で書き直して切れた行を消す
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.appendFileSync(filePath, appended, 'utf-8')
      touchCache(cache, filePath, { lines: nextLines, bytes: cached!.bytes + appendedBytes }, CACHE_LIMIT)
    }
    return { ok: true }
  } catch (e: any) {
    // 書き込みが例外を投げたら cache からその項目を消す（次の保存でファイルを読み直して立て直せるように）
    cache.delete(filePath)
    return { ok: false, message: e?.message ?? String(e) }
  }
}
