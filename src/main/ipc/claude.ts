// Claude（Anthropic API）連携の IPC（claude:*）。C系 C1（資格情報＋接続テストの土台）＋
// C2a（Claude頭脳モードの核心部・claude:chatStart/chatCancel＋claude:streamイベント転送）。
// トークンは方式B（renderer が引数で渡す。main には保存しない）。
import { ipcMain } from 'electron'
import { testAnthropicKey, checkClaudeBinary, listAnthropicModels } from '../claude/client'
import { startClaudeChat, type ClaudeChatHandle } from '../claude/agent'
import type { IpcDeps } from './types'
import { resolvePublishRoot } from '../publishRootFs'
import type { WriteMode } from '../../shared/approvalPlan'
// W-18: ⏹（claude:chatCancel）・新しいセッションの開始時に、前のセッションの承認待ちが
// あれば「拒否」として解いておく（さくらのAI Engine 経路の chatTurn:abort と同じ理由・
// 2026-09-23 の教訓: requestApproval はタイムアウトしないため、ここで解かないと固まる）。
import { cancelApprovalsForTurn } from '../chat/approvalStore'
// W-85: search_docs（📚 資料の検索）を月間上限で止める確認（ipc/rag.ts・chat/turnRunner.ts と同じ作り方の1か所）。
import { budgetCheckForKey } from '../usageStore'

// 同時実行は1セッションのみ（C2の設計どおり）。新しい claude:chatStart が来たら、
// 進行中のセッションがあれば中断してから開始する。
let activeChat: ClaudeChatHandle | null = null

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
    (event, projectDir: string, apiKey: string, prompt: string, images: string[], snapshotId: string, resumeSessionId: string | null, aiEngineKey: string | null, model: string, writeMode: string) => {
      // 前のセッションが残っていれば、応答だけでなく承認待ちも一緒に閉じる（W-18）。
      if (activeChat) { activeChat.abort(); cancelApprovalsForTurn(activeChat.turnId) }
      const handle = startClaudeChat({
        projectDir,
        // Claude の作業フォルダは`public/`（無ければプロジェクト直下）。
        // 退避先（projectDir）とは別物。取り違えると 🕘 履歴が公開フォルダの中に入る。
        writeRoot: resolvePublishRoot(projectDir),
        apiKey,
        aiEngineKey: aiEngineKey ?? null,
        // W-85: 資料検索の上限の確認。キーが無ければ search_docs はそもそも「キーが要る」と返して通信しないので、確認は通す側でよい。
        ragBudgetCheck: aiEngineKey ? budgetCheckForKey(aiEngineKey) : () => ({ allowed: true }),
        prompt,
        images: images ?? [],
        snapshotId,
        resumeSessionId: resumeSessionId ?? null,
        model,
        // W-18: 「✋ 毎回確認」（ChatPanel.tsx の writeMode）を Claude 経路にも渡す。
        writeMode: (writeMode as WriteMode) === 'confirm' ? 'confirm' : 'auto',
        onEvent: uiEvent => {
          try { event.sender.send('claude:stream', uiEvent) } catch { /* ウィンドウ破棄時は無視 */ }
          // result/error はそのターンの終端。次のセッションが不要に前回分を中断しないよう解放する。
          if (uiEvent.kind === 'result' || uiEvent.kind === 'error') {
            if (activeChat === handle) activeChat = null
          }
        },
        // open_preview の副作用（C2b）: openPreview イベントとして renderer へ通知し、renderer 側で
        // 従来経路の open_preview ツールと同じ処理（存在確認→既定ブラウザで開く）を行う。
        onOpenPreview: relPath => {
          try { event.sender.send('claude:stream', { kind: 'openPreview', path: relPath }) } catch { /* ウィンドウ破棄時は無視 */ }
        },
        // delegate_implementation の実行後（C3）: renderer へ通知し、AI Engine 側の使用量として記録させる。
        onDelegated: info => {
          try { event.sender.send('claude:stream', { kind: 'delegated', ...info }) } catch { /* ウィンドウ破棄時は無視 */ }
        },
        // Edit/Write・委譲書き込みの成功後: renderer が開きタブをディスクから読み直す
        // （stale tab のオートセーブ上書きによるデータ喪失防止・2026-07-11）。
        onFileWritten: relPath => {
          try { event.sender.send('claude:stream', { kind: 'fileWritten', path: relPath }) } catch { /* ウィンドウ破棄時は無視 */ }
        },
      })
      activeChat = handle
      return { ok: true }
    }
  )

  // 進行中の Claude セッションを中断する。承認待ちで止まっていても、ここで拒否として解ける
  // （2026-09-23 の教訓と同じ形・W-18でClaude経路にも承認待ちが生まれたため必須）。
  ipcMain.handle('claude:chatCancel', () => {
    if (activeChat) { activeChat.abort(); cancelApprovalsForTurn(activeChat.turnId) }
    activeChat = null
    return { ok: true }
  })
}
