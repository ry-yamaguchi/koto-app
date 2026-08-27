// チャット履歴のファイル保存（chat:*）。IDEのプロジェクト別チャットは `<project>/.sakuraide/chat.json`、
// 単独チャット（ChatApp）は `<workspace>/.sakuraide/chats/chat-app.json` に保存する。
// 保存内容の意味（messages配列 / sessions配列）は関知せず、JSON文字列をそのまま読み書きするだけの薄い層にする
// （チャットの送信ロジックは掟どおり useAiChat.ts のみを触る。永続化はここと renderer/chatStorage.ts）。
//
// IDEのプロジェクト別チャット（chat:loadProject/chat:saveProject）は v2（追記式JSONL）で読み書きする。
// 実体（fs・cache・書き直し/追記の判断）は chatStore/file.ts に切り出してある。electron に依存しない
// ので本物の一時フォルダで直接テストできる（2026-08-27 指摘。以前ここに実装を置いたままだったときは
// readCode でソース文字列を見るだけの弱いテストしか書けず、shouldRewrite の呼び出し引数を入れ替える
// ミューテーションを検知できなかった＝実測で確認済み）。ここは projectChatPath() の組み立てと
// isValidJson / fs.existsSync(projectDir) のガードを掛けて file.ts の2関数を呼ぶだけの薄い層にする。
// 呼び出し側（renderer）には常に配列まるごとの JSON 文字列を渡す／受け取るので、ここより外から見た
// 挙動は変わらない。単独チャット（chat:loadApp/chat:saveApp）は今回の対象外で、これまで通り v1（配列
// まるごと）を毎回 tmp+rename で書き直す。
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { IpcDeps } from './types'
import { projectChatPath, appChatPath, isValidJson } from '../chatStore/paths'
import { loadProjectChatFile, saveProjectChatFile } from '../chatStore/file'

function readFileOrNull(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/** mkdir -p してから .tmp に書き、rename する（クラッシュ時の破損防止）。単独チャット（chat:saveApp）専用。 */
function atomicWriteFileSync(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function registerChatStoreHandlers(_deps: IpcDeps) {
  // IDEのプロジェクト別チャット履歴（実体は chatStore/file.ts）
  ipcMain.handle('chat:loadProject', (_, projectDir: string) => {
    try {
      const result = loadProjectChatFile(projectChatPath(projectDir))
      if (result.ok) return result
      return { ok: false, json: null, message: result.message }
    } catch (e: any) {
      return { ok: false, json: null, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle('chat:saveProject', (_, projectDir: string, json: string) => {
    try {
      if (!isValidJson(json)) return { ok: false, message: '不正なJSON形式です' }
      // プロジェクトフォルダ自体が存在しない場合は保存をスキップする（mkdirで蘇生させない）。
      // 削除（ゴミ箱移動）直後にチャット履歴のフラッシュ保存が走ると、.sakuraide/chat.json だけの
      // 空フォルダが再作成され「削除したプロジェクトが一覧に復活する」原因になっていた
      // （2026-07-14 ユーザー報告・CDP再現で機序を実証）。
      if (!fs.existsSync(projectDir)) return { ok: true, skipped: 'project-missing' }
      return saveProjectChatFile(projectChatPath(projectDir), json)
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // 単独チャット（ChatApp）のセッション一覧
  ipcMain.handle('chat:loadApp', (_, workspaceDir: string) => {
    try {
      return { ok: true, json: readFileOrNull(appChatPath(workspaceDir)) }
    } catch (e: any) {
      return { ok: false, json: null, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle('chat:saveApp', (_, workspaceDir: string, json: string) => {
    try {
      if (!isValidJson(json)) return { ok: false, message: '不正なJSON形式です' }
      // ワークスペース自体が存在しない場合も同様に保存をスキップ（mkdirで蘇生させない）。
      if (!fs.existsSync(workspaceDir)) return { ok: true, skipped: 'workspace-missing' }
      atomicWriteFileSync(appChatPath(workspaceDir), json)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })
}
