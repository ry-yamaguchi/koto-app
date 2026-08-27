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
  foldChatLog,
  rewriteChatLog,
  appendChatLog,
  shouldRewrite,
  serializeMessages,
  isV1ChatLog,
  touchCache,
} from './log'

/**
 * cache に同時に保持するファイルの上限。プロジェクトを切り替えるたびに前の会話が cache に
 * 残り続け、main のメモリが増え続けるのを防ぐ（2026-08-27 指摘。実測 landingTEST 5.5MB /
 * newproject 1.6MB が main プロセスに残っていた）。超えた分は touchCache が最も古く使った
 * ものから捨てる。捨てられても、次にそのファイルを保存するときは「cache 無し→書き直し」に
 * 自然に落ちるだけなので、動作は壊れない。
 */
const CACHE_LIMIT = 4

// 前回このプロセスが書いた chat.json の内容。key はファイルパス。無ければ「まだ読んでいない/
// 書いていない」ので、次の保存は必ず書き直しになる（cache 経由でしか追記しない＝v1 ファイルへ
// 誤って追記することが無い）。
const cache = new Map<string, { lines: string[]; bytes: number }>()

/** テスト用に cache を空にする（モジュール内の状態はテスト間で残り続けるため）。 */
export function resetChatLogCache(): void {
  cache.clear()
}

function readFileOrNull(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
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

/** IDEのプロジェクト別チャット履歴を読む。ファイルが無い/読めない/畳めない → { ok: true, json: null }。 */
export function loadProjectChatFile(
  filePath: string
): { ok: true; json: string | null } | { ok: false; message: string } {
  try {
    const text = readFileOrNull(filePath)
    const folded = foldChatLog(text)
    if (!folded) return { ok: true, json: null }
    // folded が非nullの時点で text は null ではない（foldChatLog(null) は必ず null を返すため）
    //
    // ⚠️ cache するのは実物のファイルが v2 のときだけにする。v1 のまま cache すると、次の
    // 保存が「cache あり＝追記」の経路に入り、v1 ファイル（配列まるごと）へ v2 のJSONL行を
    // そのまま fs.appendFileSync してしまう。書式が混在した chat.json は foldChatLog で
    // 丸ごと読めなくなる（先頭が '[' なので v1 として JSON.parse され、末尾の余分な行で
    // 失敗して null になる＝会話が消えて見える）。v1 は cache しないことで、次の保存は
    // 必ず「cache無し→書き直し」を通り、そこで安全に v2 へ移行する。
    if (!isV1ChatLog(text!)) {
      touchCache(
        cache,
        filePath,
        { lines: folded.lines, bytes: Buffer.byteLength(text!, 'utf-8') },
        CACHE_LIMIT
      )
    }
    // 呼び出し側（renderer）には今まで通り配列の JSON を渡す（画面から見て何も変わらない）
    return { ok: true, json: '[' + folded.lines.join(',') + ']' }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
}

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
      // （foldChatLog）が壊れた行を捨てるので会話全体は失われない。失うのは最後の1.5秒ぶんだけ
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
