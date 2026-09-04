// tools.ts — Claude頭脳モードへのIDE固有ツール注入（C2b/C3）。
// `createSdkMcpServer()` によるインプロセスMCPサーバとして fetch_url / search_docs / open_preview /
// delegate_implementation を定義する。fetch_url/search_docs/open_preview の名前・説明・引数の文言は
// renderer の aiTools.ts TOOLS 配列を踏襲（変更時は両側を追随させる）。
//
// ── ESM/CJS事情（agent.ts の同名コメント参照・削除しないこと） ──
// SDK 本体（sdk.mjs）は ESM 専用のため、CommonJS へコンパイルされる本ファイルでは
// `createSdkMcpServer` / `tool` を静的 import できない（require() に変換され ERR_REQUIRE_ESM になる）。
// そこで呼び出し側（agent.ts）が動的 import したSDKモジュールを引数 `sdk` で受け取る設計にする。
// `import type` は型情報のみでコンパイル後に消えるため、型の参照は通常どおり書ける。
//
// ツール実行の実体は main 内の既存ロジックを共用する（挙動は従来のAI Engine経路と同一）:
// - fetch_url  → src/main/ipc/web.ts の fetchUrlPage（web:fetch ハンドラの実体・SSRFガード込み）
// - search_docs → src/main/rag/client.ts の queryDocuments（rag:query ハンドラと同じAPI）
// - open_preview → 副作用のみ（onOpenPreview コールバック経由で renderer に通知し、renderer が
//   従来の open_preview ツールと同じ処理＝aiTools.ts executeTool の open_preview 分岐で開く）
// - delegate_implementation（C3・モードA限定） → src/main/ipc/sakura.ts の sakuraClient を再利用して
//   さくらのAI Engine（コード系モデル・Kimi K2.7 Code）へ実装を依頼し、応答をこのツールが直接ファイルへ書き込む。
//   Claudeへは summarizeDelegateResult の「要約のみ」を返す（設計方針: Claudeの文脈へ生成物本体を
//   持ち込まない＝Opusトークンの二重消費を防ぐ）。

import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { fetchUrlPage } from '../ipc/web'
import { queryDocuments } from '../rag/client'
import { sakuraClient, isContextLimitError, safeMaxTokens } from '../ipc/sakura'
import { snapshotBeforeWrite } from '../backup/store'
import {
  IDE_MCP_SERVER_NAME,
  SEARCH_DOCS_NO_KEY_MESSAGE,
  formatFetchedPage,
  formatSearchDocsResult,
  normalizePreviewPath,
  parseRagTags,
  DELEGATE_MODELS,
  DELEGATE_DEFAULT_MODEL,
  DELEGATE_NO_KEY_MESSAGE,
  buildDelegatePrompt,
  parseDelegateOutput,
  validateDelegatePath,
  summarizeDelegateResult,
  type DelegateContextFile,
} from './toolText'

/** agent.ts が動的 import したSDKモジュールのうち、本ファイルが使う関数（型はコンパイル後に消える）。 */
type SdkModule = Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'tool' | 'createSdkMcpServer'>

export type IdeToolsParams = {
  /** プロジェクトルート（絶対パス）。search_docs のタグフィルタ（.sakuraide.json）の読み出しに使う。 */
  /** 🕘 履歴の退避先・`.sakuraide.json` の場所（プロジェクトの絶対パス）。 */
  projectDir: string
  /** 書き込みと読み取りの基準（`public/`。無ければ projectDir と同じ）。 */
  writeRoot: string
  /** さくらのAI Engine のAPIキー（方式B: renderer が使う瞬間に読んで渡す。null なら資料検索/委譲は案内文言を返す）。 */
  aiEngineKey: string | null
  /** open_preview の副作用（renderer への通知）。相対パスを受け取る。 */
  onOpenPreview: (relPath: string) => void
  /** このAIターンのスナップショットID（C3: delegate_implementation の書き込み前退避に使う。backup/plan.ts と共通の機構）。 */
  snapshotId: string
  /** 🕘 履歴の見出し（このターンのユーザーの指示文。agent.ts が prompt から作る）。 */
  snapshotLabel: string
  /** delegate_implementation 実行後に呼ばれる（C3: renderer への通知・AI Engine側usage記録用）。 */
  onDelegated: (info: { model: string; promptTokens: number; completionTokens: number }) => void
  /** ファイル書き込み成功後に相対パスを通知（renderer がエディタの開きタブをディスクから読み直す。
   *  stale tab のオートセーブ上書きによるデータ喪失防止・2026-07-11。agent.ts の PostToolUse フックと同役割）。 */
  onFileWritten: (relPath: string) => void
}

// delegate_implementation の1回のリクエストで許可する最大出力トークン数。
// 根拠: renderer の通常チャット既定（sakura.ts / useAiChat.ts）は 4096 だが、delegate は複数ファイルの
// 全文をJSONで返させるため、その数倍の余裕が要る。委譲先モデルの出力上限に合わせた余裕を見つつ、
// 入力側（タスク仕様＋最大10ファイル×50KB分の文脈）に残せる余地も過小にならないよう、
// 実用上十分に大きい 16384（renderer既定の4倍）を要求値とし、コンテキスト超過エラー時は sakura.ts と
// 同じ safeMaxTokens フォールバックで縮めて再試行する（固定値を決め打ちしてハードエラーにしない）。
const DELEGATE_MAX_TOKENS = 16384
// 文脈として読み込む1ファイルあたりの上限（プロンプト肥大・トークン費用の暴走防止）。
const DELEGATE_CONTEXT_FILE_MAX_BYTES = 50 * 1024

/** MCPツールの戻り値（SDK sdk.d.ts の CallToolResult 形式: content配列の text ブロック）。 */
function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/** プロジェクトの .sakuraide.json から資料検索のタグフィルタを読む（無い/壊れている場合は []）。 */
function readProjectRagTags(projectDir: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(projectDir, '.sakuraide.json'), 'utf8')
    return parseRagTags(JSON.parse(raw))
  } catch {
    return []
  }
}

/**
 * delegate_implementation の文脈ファイルを1件読む（プロジェクト confine・50KB上限で切り詰め）。
 * validateDelegatePath はパス脱出/.env系の拒否ロジックを書き込みと共用する（読み込みでも同じ安全網が要る）。
 * 読めない/不正なパスは null（呼び出し側でスキップする）。
 */
function readDelegateContextFile(projectDir: string, rel: string): DelegateContextFile | null {
  if (!validateDelegatePath(rel)) return null
  try {
    const full = path.join(projectDir, rel)
    const buf = fs.readFileSync(full)
    const truncated = buf.length > DELEGATE_CONTEXT_FILE_MAX_BYTES
    const content = buf.subarray(0, DELEGATE_CONTEXT_FILE_MAX_BYTES).toString('utf8')
    return { path: rel, content: truncated ? `${content}\n…（上限のため以降省略）` : content }
  } catch {
    return null
  }
}

/**
 * IDE固有ツール4種（うち delegate_implementation はモードA限定）を注入するインプロセスMCPサーバ構成を作る。
 * agent.ts が options.mcpServers = { [IDE_MCP_SERVER_NAME]: buildIdeToolsServer(sdk, …) } で使う。
 * 実際のツール名は `mcp__ide__<tool名>` に修飾される（toolText.ts の IDE_MCP_TOOL_NAMES 参照）。
 */
export function buildIdeToolsServer(sdk: SdkModule, params: IdeToolsParams): McpSdkServerConfigWithInstance {
  const { projectDir, writeRoot, aiEngineKey, onOpenPreview, snapshotId, snapshotLabel, onDelegated, onFileWritten } = params

  const fetchUrlTool = sdk.tool(
    'fetch_url',
    '指定したURLのWebページ本文を取得する。ユーザーが参照を求めたページや、回答に必要なドキュメントを読むときに使う。' +
      '検索エンジンではないため、URLが分からない情報には使えない（その場合はユーザーにURLを依頼する）。',
    { url: z.string().describe('取得するページのURL（http/httpsのみ）') },
    async ({ url }) => {
      try {
        const page = await fetchUrlPage(String(url ?? ''))
        return textResult(formatFetchedPage(page))
      } catch (e: any) {
        return textResult(`エラー: ページを取得できませんでした（${e?.message ?? e}）`)
      }
    }
  )

  const searchDocsTool = sdk.tool(
    'search_docs',
    'ユーザーが事前登録した資料（さくらのAI Engine）を検索して抜粋を得る。資料に関する質問や、資料を根拠にすべき回答の前に使う。',
    { query: z.string().describe('検索したい内容（日本語可）') },
    async ({ query }) => {
      if (!aiEngineKey) return textResult(SEARCH_DOCS_NO_KEY_MESSAGE)
      const q = String(query ?? '').trim()
      if (!q) return textResult('エラー: 検索クエリが空です')
      try {
        // renderer 版（ChatPanel の ragSearch）と同じ条件: プロジェクト設定のタグフィルタ＋上位3件。
        const tags = readProjectRagTags(projectDir)
        const hits = await queryDocuments(aiEngineKey, q, { tags: tags.length ? tags : undefined, topK: 3 })
        return textResult(formatSearchDocsResult(hits))
      } catch (e: any) {
        return textResult(`エラー: ${e?.message ?? e}`)
      }
    }
  )

  const openPreviewTool = sdk.tool(
    'open_preview',
    'プロジェクト内のHTMLファイルを既定ブラウザで開いてユーザーに見せる。作業が一段落して見た目を確認してもらうときに使う。',
    { path: z.string().optional().describe('開くHTMLファイルの相対パス（省略時は index.html）') },
    async ({ path: relPath }) => {
      const rel = normalizePreviewPath(typeof relPath === 'string' ? relPath : undefined)
      if (!rel) {
        return textResult(`エラー: 不正なパスです（${relPath}）。プロジェクトルートからの相対パスを指定してください`)
      }
      onOpenPreview(rel) // 副作用のみ（renderer が存在確認のうえ既定ブラウザで開く）
      return textResult(`プレビューを開きました: ${rel}（ユーザーに見た目の感想を聞いてください）`)
    }
  )

  // C3・モードA限定: 実装作業をさくらのAI Engine（コード系モデル・Kimi K2.7 Code）へ委譲し、直接ファイルへ書き込む。
  // このツール自体、aiEngineKey が無いモード（B）では tools 配列に含めない（下の if 分岐）。
  const delegateImplementationTool = sdk.tool(
    'delegate_implementation',
    'まとまった実装作業（新規ファイル作成・複数ファイルの機械的変更・テスト作成・類似ページ量産）を、' +
      '低コストのさくらのAI Engine（コード系モデル）に任せて直接ファイルへ書き込む。' +
      'タスクは対象ファイル・要件・受け入れ条件を含む自己完結の仕様で渡すこと。結果の検証は自分で行うこと。',
    {
      task: z.string().describe('自己完結した実装仕様（対象ファイル・要件・受け入れ条件を含む）'),
      files: z.array(z.string()).max(10).optional().describe('文脈として読ませる既存ファイルの相対パス（最大10件）'),
      model: z.enum(DELEGATE_MODELS).optional().describe('使用するさくらのAI Engineモデル（省略時は既定モデル）'),
    },
    async ({ task, files, model }) => {
      if (!aiEngineKey) return textResult(DELEGATE_NO_KEY_MESSAGE) // 通常は未登録のため到達しない防御用
      try {
        const contextFiles: DelegateContextFile[] = []
        for (const rel of (files ?? []).slice(0, 10)) {
          const f = readDelegateContextFile(writeRoot, rel)
          if (f) contextFiles.push(f)
        }
        const { system, user } = buildDelegatePrompt(String(task ?? ''), contextFiles)
        const chosenModel = (model as string | undefined) ?? DELEGATE_DEFAULT_MODEL

        const client = sakuraClient(aiEngineKey)
        const mk = (maxTokens: number) => client.chat.completions.create({
          model: chosenModel,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          max_tokens: maxTokens,
          temperature: 0.2,
        })
        let res
        try {
          res = await mk(DELEGATE_MAX_TOKENS)
        } catch (e: any) {
          // sakura.ts の chat/chat-stream と同じフォールバック: コンテキスト超過エラーなら
          // エラー文に書かれた上限から安全な max_tokens を割り出して1回だけ縮めて再試行する。
          const safe = isContextLimitError(e?.message ?? '') ? safeMaxTokens(e?.message ?? '', DELEGATE_MAX_TOKENS) : null
          if (safe == null) throw e
          res = await mk(safe)
        }

        const choice = res.choices?.[0]
        if (choice?.finish_reason === 'length') {
          return textResult('エラー: 出力が上限で切れたため委譲結果を確定できませんでした。タスクをより小さく分割して再度委譲してください。')
        }

        const parsed = parseDelegateOutput(choice?.message?.content ?? '')
        if (!parsed.ok) {
          return textResult(`エラー: 委譲結果の解析に失敗しました（${parsed.message}）。タスクの指示を見直して再度委譲してください。`)
        }

        const invalid = parsed.files.filter(f => !validateDelegatePath(f.path))
        if (invalid.length) {
          return textResult(`エラー: 不正なファイルパスが含まれていたため書き込みを中止しました: ${invalid.map(f => f.path).join(', ')}`)
        }

        const written: { path: string; bytes: number }[] = []
        for (const f of parsed.files) {
          // 退避の道は**プロジェクト直下からの相対**にする（🕘 はそこを見る）。
          // 書き込み先は作業フォルダ基準なので、two つを取り違えないこと。
          const relForBackup = path.relative(projectDir, path.join(writeRoot, f.path))
          try {
            snapshotBeforeWrite(projectDir, snapshotId, relForBackup, f.content, snapshotLabel)
          } catch {
            // スナップショット失敗で委譲自体は止めない（P2-⑧履歴の欠落よりファイル反映を優先。agent.ts の
            // makePreToolUseHook と同じ方針）
          }
          const full = path.join(writeRoot, f.path)
          fs.mkdirSync(path.dirname(full), { recursive: true })
          fs.writeFileSync(full, f.content, 'utf8')
          written.push({ path: f.path, bytes: Buffer.byteLength(f.content, 'utf8') })
          // エディタの開きタブへ反映を通知（stale tab のオートセーブ上書き防止）
          try { onFileWritten(relForBackup) } catch { /* 通知失敗で委譲は止めない */ }
        }

        const promptTokens = res.usage?.prompt_tokens ?? 0
        const completionTokens = res.usage?.completion_tokens ?? 0
        onDelegated({ model: chosenModel, promptTokens, completionTokens }) // 副作用のみ（usage記録用）
        return textResult(summarizeDelegateResult(written, parsed.notes, { promptTokens, completionTokens }))
      } catch (e: any) {
        return textResult(`エラー: 委譲に失敗しました（${e?.message ?? e}）`)
      }
    }
  )

  // 各ツールはそれぞれ異なる zod スキーマを持つため、SDK の CreateSdkMcpServerOptions.tools と
  // 同じ広い型（Array<SdkMcpToolDefinition<any>>）で受ける（配列リテラルからの狭い型推論を避ける）。
  const tools: Array<SdkMcpToolDefinition<any>> = [fetchUrlTool, searchDocsTool, openPreviewTool]
  // モードAのときだけ delegate_implementation を登録する（許可リストは常に含めてよいが、
  // ツール未登録なら SDK 側から呼ばれることは無い。toolText.ts の IDE_TOOL_BARE_NAMES 参照）。
  if (aiEngineKey) tools.push(delegateImplementationTool)

  return sdk.createSdkMcpServer({
    name: IDE_MCP_SERVER_NAME,
    version: '1.0.0',
    tools,
  })
}
