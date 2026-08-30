// agent.ts — Claude Agent SDK の query() ラッパ。C2a（Claude頭脳モードの核心部）。
//
// ── ESM/CJS事情（重要・削除しないこと） ──────────────────────────────────────
// main プロセスは tsconfig.main.json により CommonJS へコンパイルされる。一方 Agent SDK 本体
// （node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs）は ESM 専用モジュールとして配布されている。
// 通常の `import { query } from '@anthropic-ai/claude-agent-sdk'` を CommonJS ファイルの中に書くと、
// TypeScript がこれを `require('@anthropic-ai/claude-agent-sdk')` へ変換してしまい、
// CommonJS の require() は ESM-only パッケージを読み込めず実行時に ERR_REQUIRE_ESM で失敗する。
// これを避けるため、`new Function('specifier', 'return import(specifier)')` で
// 「TypeScript のコンパイラに書き換えさせない、生の動的 import() 式」を作り、実行時にのみ
// Node の ESM ローダー経由で読み込む。
// （`import type {...}` は型情報のみでコンパイル後に完全に消え、require() を一切出力しないため
//   型の参照はこの制約と無関係に通常どおり使える。）
//
// 検証手順（実装者向け・このコメントの下に実証結果も残す）:
//   1. `npm run build` 後、コンパイル結果に静的 require が出ていないことを確認する。
//      **このコメント自体が同じ文字列を含むため、素の grep は常に2件ヒットする**（2026-07-29 に誤解しかけた）。
//      コメント行を除いて数えること:
//        grep -n "require('@anthropic-ai/claude-agent-sdk')" dist/main/claude/agent.js | grep -v '^[0-9]*: *//'
//      これが空なら正常（=静的 require に変換されていない）。
//      決定的なのは手順2（実際に読み込ませる）。静的 require が残っていればそこで ERR_REQUIRE_ESM になる。
//   2. `node -e "require('./dist/main/claude/agent.js')"` 等で dist を実際に読み込ませ、
//      動的 import 自体が実行時に解決できることを確認する（詳細は報告参照）。
const dynamicImportSdk = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<typeof import('@anthropic-ai/claude-agent-sdk')>

import * as path from 'path'
import type { Options, PermissionResult, CanUseTool, HookCallback, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { resolveClaudeBinary } from './client'
import { isDangerousCommand } from './guard'
import { mapSdkMessage, type UiEvent } from './events'
import { buildIdeToolsServer } from './tools'
import { IDE_MCP_SERVER_NAME, IDE_MCP_TOOL_NAMES, DELEGATION_GUIDANCE } from './toolText'
import { UNTRUSTED_RULE } from '../../shared/untrustedBlock'
import { nowContext } from '../../shared/chatTime'
import { snapshotBeforeWrite, snapshotBeforeChange } from '../backup/store'
import { buildUserContent } from './vision'
import { isProtectedWritePath, protectedWriteMessage } from '../../shared/protectedPaths'

/** Claude頭脳モードの既定モデル（dev-plan.md C2 で指定）。
 *  renderer の DEFAULT_CLAUDE_MODEL（claudeMode.ts）と一致させること（未指定時のみ使う保険）。 */
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-5'

/** C2a で有効化する SDK 内蔵ツール一覧。 */
const BUILTIN_TOOL_NAMES = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] as const

/** 許可するツールの全名。C2b: IDE固有MCPツール（fetch_url / search_docs / open_preview）は
 *  修飾名 `mcp__ide__<tool名>` で登録する（修飾規則の一次情報は toolText.ts 冒頭コメント参照）。 */
const ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set([...BUILTIN_TOOL_NAMES, ...IDE_MCP_TOOL_NAMES])

export type StartClaudeChatParams = {
  /**
   * **🕘 履歴の退避先**（プロジェクトの絶対パス）。
   *
   * ⚠️ **作業フォルダ（cwd）とは別物**（2026-08-20 で分けた）。
   * 退避は `<projectDir>/.sakuraide-backup` へ行う。ここを作業フォルダにすると
   * **履歴が`public/` の中に入ってしまう**（公開物からは除外されるが、
   * 置き場所として誤り。IDE の 🕘 もプロジェクト直下を見る）。
   */
  projectDir: string
  /**
   * **Claude の作業フォルダ（cwd）と、書き込みを許す範囲**（絶対パス）。
   * `public/`があればその中、無ければプロジェクト直下（＝移行前）。
   * さくらのAI Engine 経路の基準（ChatPanel の aiRoot）と揃えること。
   */
  writeRoot: string
  /** Anthropic APIキー（方式B・呼び出しの子プロセスenvにのみ注入。保存しない）。 */
  apiKey: string
  /** さくらのAI Engine のAPIキー（方式B・search_docs ツール用。未登録なら null。保存しない）。 */
  aiEngineKey: string | null
  /** このターンのユーザー入力（新規メッセージ本文のみ。履歴は resume が担う）。 */
  prompt: string
  /** このターンでユーザーが添付した画像（data URL配列。C2d）。空配列なら画像無し＝従来どおり
   *  `prompt` を文字列のまま query() へ渡す。1枚以上あれば、単一メッセージを yield する
   *  async generator（AsyncIterable<SDKUserMessage>＝ストリーミング入力モード）に切り替え、
   *  Claude自身に画像を直接読ませる（AI Engineの2段階visionへフォールバックしない）。 */
  images: string[]
  /** このAIターンのスナップショットID（.sakuraide-backup 配下、P2-⑧の機構と共通）。delegate_implementation の書き込みもここへ退避する（C3）。 */
  snapshotId: string
  /** 継続する既存セッションID（新規会話なら null）。 */
  resumeSessionId: string | null
  /** 使用するモデルID（C2c・renderer の claudeMode.ts getClaudeModel()）。空文字なら既定モデルを使う。 */
  model: string
  /** SDK のストリームを変換した UI イベントを都度渡すコールバック。 */
  onEvent: (event: UiEvent) => void
  /** open_preview ツールの副作用（renderer への通知）。プロジェクト相対パスを受け取る。 */
  onOpenPreview: (relPath: string) => void
  /** delegate_implementation 実行後の副作用（renderer への通知・usage記録用。C3）。 */
  onDelegated: (info: { model: string; promptTokens: number; completionTokens: number }) => void
  /** Edit/Write・委譲書き込みの成功後にファイルの相対パスを通知（renderer がエディタの開きタブを
   *  ディスクから読み直す。stale tab のオートセーブ上書きによるデータ喪失防止・2026-07-11）。 */
  onFileWritten: (relPath: string) => void
}

export type ClaudeChatHandle = {
  /** 進行中のクエリを中断する。 */
  abort: () => void
}

/** projectDir 配下に閉じ込めた相対パスを返す（プロジェクト外を指す絶対パスは null）。 */
function relPathInProject(projectDir: string, absPath: string): string | null {
  if (!absPath) return null
  const rel = path.relative(projectDir, absPath)
  if (!rel || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
}

/**
 * Bash の危険コマンドを拒否する canUseTool。
 * 有効化するツール（ALLOWED_TOOL_NAMES = SDK内蔵6種＋IDE固有MCP3種の修飾名）以外は、
 * `tools`/`allowedTools` を絞らずともここで一律拒否する（スコープ最小化という設計を安全網としても徹底するため）。
 * 戻り値は必ず `{behavior:'allow'|'deny', ...}` の具体的な PermissionResult を返す
 * （SDKの型定義注記どおり、`null` を返すのは呼び出し元が control_response を別経路で
 *   送った場合専用のため、ここでは絶対に使わない）。
 */
function makeCanUseTool(projectDir: string): CanUseTool {
  return async (toolName, input) => {
    if (!ALLOWED_TOOL_NAMES.has(toolName)) {
      const result: PermissionResult = {
        behavior: 'deny',
        message: `このモードでは "${toolName}" は利用できません（対応ツール: Read/Glob/Grep/Edit/Write/Bash とIDEツール）。`,
      }
      return result
    }
    // Koto の管理領域（🕘履歴・チャット履歴・設定・.git・.env）への書き込みを拒否する。
    // 特に .sakuraide-backup を書き換えられると「AIの失敗を取り消す仕組み」自体が壊れ、
    // .git/hooks へ書けると commandGuard を迂回して任意のコードが実行されてしまう。
    // 判定は shared/protectedPaths.ts に一本化（write_file / delegate と共通・2026-08-05）。
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = typeof (input as any)?.file_path === 'string' ? (input as any).file_path as string : ''
      const rel = filePath ? relPathInProject(projectDir, filePath) : null
      if (rel && isProtectedWritePath(rel)) {
        const result: PermissionResult = { behavior: 'deny', message: protectedWriteMessage(rel) }
        return result
      }
    }
    if (toolName === 'Bash') {
      const command = typeof (input as any)?.command === 'string' ? (input as any).command as string : ''
      if (isDangerousCommand(command)) {
        const result: PermissionResult = {
          behavior: 'deny',
          message: `危険と判定されたコマンドのため実行を拒否しました: ${command}`,
        }
        return result
      }
    }
    const result: PermissionResult = { behavior: 'allow' }
    return result
  }
}

/**
 * Edit/Write の実行前に、P2-⑧のスナップショット機構（backup/store.ts の snapshotBeforeWrite /
 * snapshotBeforeChange。内部は src/main/backup/plan.ts の純関数を利用）へ旧内容を退避させる。
 * Write は tool_input.content に最終内容が入っているため「変化なしなら省略」の最適化が効く
 * snapshotBeforeWrite を使い、Edit は最終内容が事前に分からないため snapshotBeforeChange
 * （既存内容があれば常に退避）を使う。
 * パスは projectDir 配下に限定し（relPathInProject）、外を指す場合は何もしない。
 */
function makePreToolUseHook(projectDir: string, snapshotId: string, snapshotLabel: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true }
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
    const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : ''
    const rel = filePath ? relPathInProject(projectDir, filePath) : null
    if (rel) {
      try {
        if (input.tool_name === 'Write' && typeof toolInput.content === 'string') {
          snapshotBeforeWrite(projectDir, snapshotId, rel, toolInput.content, snapshotLabel)
        } else if (input.tool_name === 'Edit') {
          snapshotBeforeChange(projectDir, snapshotId, rel, snapshotLabel)
        }
      } catch {
        // スナップショット失敗でチャット自体は止めない（履歴機能の欠落よりチャット継続を優先）
      }
    }
    return { continue: true }
  }
}

/**
 * Edit/Write の実行「後」に、書き込まれたファイルの相対パスを renderer へ通知する（データ喪失バグの修正・2026-07-11）。
 * Claude モードの書き込みは main プロセス（SDK子プロセス）で行われ、renderer のエディタは何も知らない。
 * 通知しないと開きタブが古い内容のまま残り、ユーザーがそのタブに入力した瞬間にオートセーブ
 * （App.tsx の1.5秒デバウンス・終了時保存）が古いバッファでディスクを上書きし、Claude の変更が消える。
 * renderer 側は fileWritten イベントを受けて該当タブをディスクから読み直す（applyRestoreResult と同じ機構）。
 */
function makePostToolUseHook(projectDir: string, onFileWritten: (relPath: string) => void): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return { continue: true }
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
    const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : ''
    const rel = filePath ? relPathInProject(projectDir, filePath) : null
    if (rel) {
      try { onFileWritten(rel) } catch { /* 通知失敗でチャットは止めない */ }
    }
    return { continue: true }
  }
}

/**
 * C2d: 画像添付ターン用に、単一のユーザーメッセージだけを yield する async generator を作る。
 * query() の prompt に `AsyncIterable<SDKUserMessage>` を渡すと SDK は「ストリーミング入力モード」で
 * 起動する。ここでは1メッセージ送ったら generator が終端する＝実質「テキストのみ入力の代わりに
 * マルチモーダル content を1回送るだけ」の最小構成。resume・model 等の Options は文字列prompt時と
 * 同じフィールドで機能する（sdk.d.ts 上、resume 等は Options 側の宣言でありprompt の型に依存しない。
 * ストリーミング入力モード専用の追加機能は Query インターフェースの setModel 等の制御メソッド側に
 * あるだけで、こちらは使わない）。
 */
async function* singleUserMessage(text: string, images: string[]): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: buildUserContent(text, images) },
    parent_tool_use_id: null,
  }
}

/**
 * Agent SDK の query() を起動し、ストリームメッセージを mapSdkMessage() で UI イベントへ変換して
 * onEvent へ流す。呼び出しはすぐに ClaudeChatHandle を返す（ストリームは非同期に進む）。
 */
export function startClaudeChat(params: StartClaudeChatParams): ClaudeChatHandle {
  const { projectDir, writeRoot, apiKey, aiEngineKey, prompt, images, snapshotId, resumeSessionId, model, onEvent, onOpenPreview, onDelegated, onFileWritten } = params
  const abortController = new AbortController()
  // 🕘 履歴の見出し（このターンのユーザーの指示文。長さの整形は ipc/backup.ts 側で行う）。
  // 「どの指示でこうなったか」が一覧に出ることで「3つ前の状態に戻す」を選べるようにする（2026-08-05）。
  const snapshotLabel = prompt.trim() || (images.length > 0 ? '画像についての依頼' : '')
  // C2d: 画像が無ければ従来どおり文字列プロンプト。1枚以上あれば、Claude自身に画像を直接読ませる
  // ため、単一メッセージのストリーミング入力（AsyncIterable<SDKUserMessage>）に切り替える。
  // ※ ファクトリにしているのは、resume 失敗時の自己修復リトライ（下記）で再度プロンプトを渡す際、
  //   使い切った AsyncGenerator を再利用しないよう毎回作り直すため。
  const makePromptArg = (): string | AsyncGenerator<SDKUserMessage> =>
    images.length > 0 ? singleUserMessage(prompt, images) : prompt

  const options: Options = {
    cwd: writeRoot,
    // C2c: renderer で選択されたモデル（claudeMode.ts CLAUDE_MODELS）。未指定時は既定定数。
    model: model || CLAUDE_DEFAULT_MODEL,
    resume: resumeSessionId ?? undefined,
    // env は process.env を丸ごと置き換える仕様（マージされない）ため、自分で展開してから
    // ANTHROPIC_API_KEY を上書きする（方式B: このプロセス呼び出し内でのみ使用・保存しない）。
    env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
    // IDE固有MCPツールは修飾名（mcp__ide__<tool名>）で許可する（toolText.ts の修飾規則参照）。
    // delegate_implementation（C3）も常に許可リストへ含める（実際に呼べるかはツール登録の有無で決まる。
    // buildIdeToolsServer 側が aiEngineKey が無いモード（B）では tools 配列に入れないため、
    // 許可されていても登録が無ければ呼び出し自体が発生しない）。
    allowedTools: [...BUILTIN_TOOL_NAMES, ...IDE_MCP_TOOL_NAMES],
    settingSources: [], // ユーザーの ~/.claude 設定・project/local settings を読ませない
    permissionMode: 'acceptEdits',
    // 書き込みを許すのは作業フォルダの中だけ（退避先の projectDir ではない）。
    canUseTool: makeCanUseTool(writeRoot),
    hooks: {
      PreToolUse: [{ matcher: 'Edit|Write', hooks: [makePreToolUseHook(projectDir, snapshotId, snapshotLabel)] }],
      // 実行成功後にエディタへ反映を通知（stale tab のオートセーブ上書きによるデータ喪失防止）
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [makePostToolUseHook(projectDir, onFileWritten)] }],
    },
    abortController,
    pathToClaudeCodeExecutable: resolveClaudeBinary() ?? undefined,
    // 外部データの境界ガード（掟10）はモードに関わらず常に付ける（fetch_url は両モードで使えるため）。
    // C3: モードA（AI Engineキーあり）のときだけ委譲指針も追記する。
    // モードB（Claudeのみ）では delegate_implementation ツール自体が登録されないため付けない。
    // 現在日時（この端末のローカル時刻）も添える（AIに今日を推測させない・chatTime.ts の nowContext）。
    // ここは main なので new Date() はエージェント起動＝送信ごとに評価され、常に最新になる。
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: (aiEngineKey ? `${UNTRUSTED_RULE}\n\n${DELEGATION_GUIDANCE}` : UNTRUSTED_RULE) + `\n\n${nowContext()}`,
    },
  }

  void (async () => {
    let sdk: any
    try {
      sdk = await dynamicImportSdk('@anthropic-ai/claude-agent-sdk')
    } catch (e: any) {
      if (!abortController.signal.aborted) onEvent({ kind: 'error', message: e?.message ?? String(e) })
      return
    }
    // C2b/C3: IDE固有ツール（fetch_url / search_docs / open_preview / delegate_implementation）を
    // インプロセスMCPサーバとして注入する。createSdkMcpServer / tool も ESM 専用 SDK の関数のため、
    // 動的 import 済みモジュールを渡す。
    options.mcpServers = {
      [IDE_MCP_SERVER_NAME]: buildIdeToolsServer(sdk, { projectDir, writeRoot, aiEngineKey, onOpenPreview, snapshotId, snapshotLabel, onDelegated, onFileWritten }),
    }

    // query() を1回実行してストリームを onEvent へ流す。emittedAny=このストリームで何かイベントを
    // 出したか（開始直後の失敗か、途中まで進んで失敗したかを区別するために使う）。
    // renderer は result/error のどちらかで待機を解くため、終端イベントなしにストリームが尽きた場合
    // （子プロセスの異常終了等）は error で補完する。
    const runOnce = async (useResume: boolean): Promise<{ ok: boolean; emittedAny: boolean; error?: any }> => {
      let emittedAny = false
      let sawTerminal = false
      try {
        const runOptions: Options = { ...options, resume: useResume ? (resumeSessionId ?? undefined) : undefined }
        const stream = sdk.query({ prompt: makePromptArg(), options: runOptions })
        for await (const message of stream) {
          for (const event of mapSdkMessage(message)) {
            if (event.kind === 'result' || event.kind === 'error') sawTerminal = true
            emittedAny = true
            onEvent(event)
          }
        }
        if (!sawTerminal && !abortController.signal.aborted) {
          onEvent({ kind: 'error', message: '応答が予期せず終了しました。もう一度お試しください。' })
          emittedAny = true
        }
        return { ok: true, emittedAny }
      } catch (e: any) {
        return { ok: false, emittedAny, error: e }
      }
    }

    const first = await runOnce(true)
    if (abortController.signal.aborted) return // 意図した中断はエラー扱いしない
    if (first.ok) return
    // resume（過去セッションの再開）を指定していて、かつ開始直後（何もイベントを出す前）に失敗した場合は、
    // 保存済みセッションIDが失効・不在で復元に失敗した可能性が高い。resume 無し（新規セッション）で
    // 1回だけ自己修復リトライする（同ターンのプロンプトを作り直して再送。開始前失敗のため副作用は無い）。
    // 新しい session イベントが流れれば renderer 側の保存IDも更新される。
    if (resumeSessionId && !first.emittedAny) {
      const second = await runOnce(false)
      if (abortController.signal.aborted) return
      if (!second.ok) onEvent({ kind: 'error', message: second.error?.message ?? String(second.error) })
      return
    }
    onEvent({ kind: 'error', message: first.error?.message ?? String(first.error) })
  })()

  return { abort: () => abortController.abort() }
}
