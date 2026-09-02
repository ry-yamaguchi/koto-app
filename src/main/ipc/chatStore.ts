// チャット履歴のファイル保存（chat:*）。IDEのプロジェクト別チャットは `<project>/.sakuraide/chat.json`、
// 単独チャット（ChatApp）の旧形式は `<workspace>/.sakuraide/chats/chat-app.json` に保存していた。
// 保存内容の意味（messages配列 / sessions配列）は関知せず、JSON文字列をそのまま読み書きするだけの薄い層にする
// （チャットの送信ロジックは掟どおり useAiChat.ts のみを触る）。
//
// IDEのプロジェクト別チャット（chat:loadProject/chat:saveProject）は v2（追記式JSONL）で読み書きする。
// 実体（fs・cache・書き直し/追記の判断）は chatStore/file.ts に切り出してある。electron に依存しない
// ので本物の一時フォルダで直接テストできる（2026-08-27 指摘。以前ここに実装を置いたままだったときは
// readCode でソース文字列を見るだけの弱いテストしか書けず、shouldRewrite の呼び出し引数を入れ替える
// ミューテーションを検知できなかった＝実測で確認済み）。ここは projectChatPath() の組み立てと
// isValidJson / fs.existsSync(projectDir) のガードを掛けて file.ts の2関数を呼ぶだけの薄い層にする。
// 呼び出し側（renderer）には常に配列まるごとの JSON 文字列を渡す／受け取るので、ここより外から見た
// 挙動は変わらない。
//
// ── B'-3c: IDEのプロジェクト別チャットの持ち主が main（convStore.ts）へ移った ─────────
// ChatPanel はもう chat:loadProject / chat:saveProject を呼ばない（chat:load / chat:ops に移った）。
// 既存の2つは形を変えずに残す（呼ぶ者がいなくなっても、後方互換のため・仕様書の指示どおり）。
//
// ── B'-3e-a: 単独チャットの持ち主も main（appSessionsStore.ts・convStore.ts）へ移った ─────
// ChatApp はもう chat:loadApp / chat:saveApp を呼ばない（appSessions:* ＋ chat:load/chat:ops へ
// 置き換わった。renderer/chatStorage.ts は削除済み）。旧2つは chat:loadProject/saveProject と
// 同じ理由（後方互換・呼び出しが無くても実装が壊れているわけではない）で、形を変えずに残す。
// 旧ファイル自体は appSessionsStore.ts の一度きりの移行が読みに行く（appChatPath は
// chatStore/paths.ts に定義があり、そちらからも import される）。
import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { IpcDeps } from './types'
import { projectChatPath, appChatPath, isValidJson } from '../chatStore/paths'
import { loadProjectChatFile, saveProjectChatFile } from '../chatStore/file'
import { loadConversation, applyConversationOps, flushConversations, setApplyListener, type Op } from '../chat/convStore'
import { sendToWindow } from '../windowSend'

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

export function registerChatStoreHandlers(deps: IpcDeps) {
  // ── B-1a: 会話の画面更新を「main のストアからの押し出し」1本にする ─────────────────
  // convStore.applyConversationOps は renderer 発の書き換え（下の chat:ops）・main のターンの
  // 出来事（turnRunner.ts）・🕘 復元の記録（backup.ts）のすべてが必ず通る唯一の当て先。
  // ここで「当てた結果」を chat:applied として押し出せば、画面が受け取る経路も1本になり、
  // ChatPanel 側で projectDir を確かめてから当てることで、ターン中のプロジェクト切替による
  // 誤配（走っているターンの吹き出しが切り替え先の画面に混ざる）が構造的に無くなる。
  // 送信は windowSend.ts の作法（sendToWindow）に合わせる＝ウィンドウが閉じていれば黙って捨てる
  // （term.ts の deps.getMainWindow() の使い方と同じ）。
  setApplyListener((projectDir, op, length) => {
    sendToWindow(deps.getMainWindow(), 'chat:applied', { projectDir, op, length })
  })

  // ⚠️ B'-3c で ChatPanel は chat:load / chat:ops に移った（下）。この2つはもう呼ぶ者が
  // いないが、後方互換のため形を変えずに残す（実体は chatStore/file.ts）。
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

  // ── B'-3c: IDEのプロジェクト別チャットの持ち主（convStore.ts）を呼ぶ薄い層 ──────────
  // ChatPanel.tsx（src/renderer/chatConvClient.ts 経由）が使う。単独チャット（ChatApp）は対象外。
  ipcMain.handle('chat:load', (_, projectDir: string) => {
    try {
      return { ok: true, messages: loadConversation(projectDir) }
    } catch (e: any) {
      return { ok: false, messages: null, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle('chat:ops', (_, projectDir: string, ops: Op[], opts?: { flushNow?: boolean }) => {
    // 投げられた例外は { ok:false, message } に変換する（ハンドラの外へ投げ直さない。
    // chatTurn:start と同じ流儀＝invoke を reject させない）。
    try {
      applyConversationOps(projectDir, ops, opts)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // quit 時フラッシュ: デバウンス保存待ちの会話を、終了前に必ず書き切る（電源断・強制終了は
  // 別として、通常のアプリ終了で直前のやり取りを失わないため）。convStore.ts 自身には
  // electron を持ち込まない（node で直接テストするため）ので、electron 側のこの薄い層で登録する。
  app.on('before-quit', () => flushConversations())

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
