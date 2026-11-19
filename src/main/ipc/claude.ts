// Claude（Anthropic API）連携の IPC（claude:*）。C系 C1（資格情報＋接続テストの土台）＋
// C2a（Claude頭脳モードの核心部・claude:chatStart/chatCancel＋claude:streamイベント転送）。
// トークンは方式B（renderer が引数で渡す。main には保存しない）。
import { ipcMain } from 'electron'
import { testAnthropicKey, checkClaudeBinary, listAnthropicModels } from '../claude/client'
import { startClaudeChat, type ClaudeChatHandle } from '../claude/agent'
import type { TurnTaggedUiEvent, UiEvent } from '../claude/events'
import { createOpenPreviewBridge, answerOpenPreview } from '../claude/openPreviewBridge'
import type { IpcDeps } from './types'
import { resolvePublishRoot } from '../publishRootFs'
import type { WriteMode } from '../../shared/approvalPlan'
// W-18: ⏹（claude:chatCancel）・新しいセッションの開始時に、前のセッションの承認待ちが
// あれば「拒否」として解いておく（さくらのAI Engine 経路の chatTurn:abort と同じ理由・
// 2026-09-23 の教訓: requestApproval はタイムアウトしないため、ここで解かないと固まる）。
import { cancelApprovalsForTurn } from '../chat/approvalStore'
// W-85: search_docs（📚 資料の検索）を月間上限で止める確認（ipc/rag.ts・chat/turnRunner.ts と同じ作り方の1か所）。
import { budgetCheckForKey } from '../usageStore'

// 同時実行は1セッションのみ（C2の設計どおり）。走っている回は、プロジェクト・回の印・送り先と一緒に
// ひとまとめで持つ（設定と解放を同じ所で行い、片方だけ古い値が残らないようにする）。
// 同じプロジェクトの新しい claude:chatStart は前の回を止めて始める。ほかのプロジェクトの回が走っているときは、
// 何も止めずに断る（画面は回の印で出来事を分けるが、Claude の作業そのものは同時に1つしか持てない）。
type ActiveRun = {
  handle: ClaudeChatHandle | null
  projectDir: string
  turn: string
  sender: { send: (channel: string, payload: unknown) => void; isDestroyed?: () => boolean }
}
let active: ActiveRun | null = null
// 進行中のターンの open_preview の橋（中断・終了のとき、待っている分を解く）。
const previewBridges = new Set<ReturnType<typeof createOpenPreviewBridge>>()

export function registerClaudeHandlers(_deps: IpcDeps) {
  // 疎通テスト（GET /v1/models）。モデル件数を返す。
  ipcMain.handle('claude:test', async (_, token: string) => {
    return testAnthropicKey(token)
  })

  // Agent SDK のネイティブCLIバイナリがパッケージから実行できるか確認する（開発者向け・スモークテスト用）。
  ipcMain.handle('claude:binaryCheck', async () => {
    return checkClaudeBinary()
  })

  // Claudeモデル一覧のライブ取得（起動時に実際の提供ラインナップを取得し、renderer側の埋め込み表
  // claudeMode.ts CLAUDE_MODELS を置き換える。さくらのAI Engine の sakura:models と同じ考え方）。
  ipcMain.handle('claude:models', async (_, token: string) => {
    return listAnthropicModels(token)
  })

  // Claude頭脳モード（C2）: query() を起動し、ストリームイベントを 'claude:stream' で
  // このリクエスト元の webContents へ転送する。ハンドラ自体は即 {ok:true} を返す
  // （応答本体は claude:stream の連続イベントとして別便で届く）。
  // aiEngineKey は search_docs / delegate_implementation ツール用（C2b/C3・方式B: renderer が使う瞬間に
  // 読んで渡す。main は保存しない）。model は C2c（Claudeモデル選択）。
  // images は C2d（画像添付ターンをClaude自身に直接処理させる。data URL配列・空配列可）。
  ipcMain.handle(
    'claude:chatStart',
    (event, projectDir: string, apiKey: string, prompt: string, images: string[], snapshotId: string, resumeSessionId: string | null, aiEngineKey: string | null, model: string, writeMode: string, rag: { tags?: unknown } | null, turn: string) => {
      // 回の印の形を確かめる（違えば何も始めない・走っている回にも触れない）。
      if (typeof turn !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(turn)) {
        return { ok: false, message: '送信の印が不正です' }
      }
      if (active) {
        // ほかのプロジェクトの回が走っている: 何もせず断る（前の回を止めない・承認も橋も触らない）。
        // ただし、その回を始めた窓がもう無いとき（窓を閉じた）は、だれも受け取らない回なので、止めて先へ進む
        // （残すと、どの画面にも「作業中」が見えないまま、ほかのプロジェクトの送信を断り続ける）。
        const orphaned = typeof active.sender.isDestroyed === 'function' && active.sender.isDestroyed()
        if (active.projectDir !== projectDir && !orphaned) return { ok: false, busy: true }
        // 同じプロジェクトの前の回は止める。応答だけでなく承認待ちも一緒に閉じる（W-18）。
        const previous = active
        active = null
        if (previous.handle) { previous.handle.abort(); cancelApprovalsForTurn(previous.handle.turnId) }
        // 前の回の画面へ、止められたことを知らせる（送る口は「いまの回」だけ通すので、ここは直接送る）。
        try { previous.sender.send('claude:stream', { kind: 'superseded', turn: previous.turn } satisfies TurnTaggedUiEvent) } catch { /* ウィンドウ破棄時は無視 */ }
      }
      // 前のターンの、返事を待っているプレビューの橋も取り消す（待ちを「中断されました」で解く）。
      for (const b of previewBridges) b.cancelAll()
      previewBridges.clear()
      const run: ActiveRun = { handle: null, projectDir, turn, sender: event.sender }
      active = run
      // 画面へ送る口は1つ。いまの回でなくなった回（止めた・終えた）の出来事は送らない。
      const sendTurn = (uiEvent: UiEvent) => {
        if (active !== run) return
        try { event.sender.send('claude:stream', { ...uiEvent, turn } satisfies TurnTaggedUiEvent) } catch { /* ウィンドウ破棄時は無視 */ }
      }
      const previewBridge = createOpenPreviewBridge({
        projectDir,
        writeRoot: resolvePublishRoot(projectDir),
        send: notice => sendTurn(notice),
      })
      previewBridges.add(previewBridge)
      try {
        run.handle = startClaudeChat({
          projectDir,
          // Claude の作業フォルダは`public/`（無ければプロジェクト直下）。
          // 退避先（projectDir）とは別物。取り違えると 🕘 履歴が公開フォルダの中に入る。
          writeRoot: resolvePublishRoot(projectDir),
          apiKey,
          aiEngineKey: aiEngineKey ?? null,
          // W-85: 資料検索の上限の確認。キーが無ければ search_docs はそもそも「キーが要る」と返して通信しないので、確認は通す側でよい。
          ragBudgetCheck: aiEngineKey ? budgetCheckForKey(aiEngineKey) : () => ({ allowed: true }),
          // 画面の「📚 資料を使う」の送信時点の設定（使わない＝null）。形の読めない値は「使わない」に倒す。
          rag: rag && typeof rag === 'object' && Array.isArray(rag.tags) ? { tags: rag.tags.filter((t): t is string => typeof t === 'string') } : null,
          prompt,
          images: images ?? [],
          snapshotId,
          resumeSessionId: resumeSessionId ?? null,
          model,
          // W-18: 「✋ 毎回確認」（ChatPanel.tsx の writeMode）を Claude 経路にも渡す。
          writeMode: (writeMode as WriteMode) === 'confirm' ? 'confirm' : 'auto',
          onEvent: uiEvent => {
            sendTurn(uiEvent)
            // その回の終端。次のセッションが不要に前回分を中断しないよう解放する。error は常に終端。
            // 失敗の回は「result（isError）→ error」の順で届くので、result の時点では閉じず、error のあとで閉じる
            // （閉じてしまうと、続く error が送る口で落ちる）。
            if ((uiEvent.kind === 'result' && !uiEvent.isError) || uiEvent.kind === 'error') {
              previewBridge.cancelAll(); previewBridges.delete(previewBridge)
              if (active === run) active = null
            }
          },
          // open_preview（C2b）: 送信時のプロジェクトを載せた openPreview イベントを renderer へ送り、renderer 側で
          // 従来経路の open_preview と同じ処理（拡張子・存在の確認→既定ブラウザで開く）を行った結果の文を待つ。
          onOpenPreview: relPath => previewBridge.request(relPath),
          // delegate_implementation の実行後（C3）: renderer へ通知し、AI Engine 側の使用量として記録させる。
          onDelegated: info => sendTurn({ kind: 'delegated', ...info }),
          // Edit/Write・委譲書き込みの成功後: renderer が開きタブをディスクから読み直す
          // （stale tab のオートセーブ上書きによるデータ喪失防止・2026-07-11）。
          onFileWritten: relPath => sendTurn({ kind: 'fileWritten', path: relPath }),
        })
      } catch (e) {
        // 始められなかった回を残さない（残すと、ほかのプロジェクトの送信を断り続ける）。
        previewBridge.cancelAll(); previewBridges.delete(previewBridge)
        if (active === run) active = null
        throw e
      }
      return { ok: true }
    }
  )

  // 進行中の Claude セッションを中断する。承認待ちで止まっていても、ここで拒否として解ける
  // （2026-09-23 の教訓と同じ形・W-18でClaude経路にも承認待ちが生まれたため必須）。
  // turn は画面が送信時に作った回の印。いまの回の印と合うときだけ止める（古い回の ⏹ が、いまの回を止めないように）。
  ipcMain.handle('claude:chatCancel', (_, turn: string) => {
    if (!active || typeof turn !== 'string' || active.turn !== turn) return { ok: true, stopped: false }
    const run = active
    active = null
    if (run.handle) { run.handle.abort(); cancelApprovalsForTurn(run.handle.turnId) }
    for (const b of previewBridges) b.cancelAll()
    previewBridges.clear()
    return { ok: true, stopped: true }
  })

  // open_preview の知らせへの返事（renderer が開いた結果の文）。待っている道具の返事を解く。
  ipcMain.handle('claude:openPreviewResult', (_, id: string, result: string) => {
    return { ok: answerOpenPreview(id, result) }
  })
}
