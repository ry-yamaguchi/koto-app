// turnRunner.ts — chatTurn:* の IPC。AI Engine 経路のループ（src/shared/chatTurn.ts の
// runEngineTurn）を main プロセスで直接走らせる（B'-3b・土台の入れ替え その1・本体）。
//
// ── 方針 ─────────────────────────────────────────────────────────────
// ツール実行・承認・システムプロンプト組み立てなど、renderer にしか無い副作用は renderer へ
// 「問い合わせ」（ask・chat/askBridge.ts）て、今のコードをそのまま使う。main が直接持つのは
// LLM 呼び出し（sakura/engine.ts）・emit・純粋関数の束（h・src/shared 配下の本物の実装）に加え、
// 学習キャッシュ（ツール対応・画像対応・B'-3d-1a で main へ移した learningStore.ts）と、
// 予算・利用実績（B'-3d-1b で main へ移した usageStore.ts）・compactWarnOnce（同・モジュール内
// Set で main のプロセス寿命ぶん持つ）、executeTool（B'-3d-2b・下記コメント）、
// 承認 approveToolCall（B'-3d-3・さらに下のコメント）、そして getHistory（B'-3e-b・さらに下）。
// 「見かけが変わらない」を最優先し、直せる不具合があってもここでは直さない（sakura.ts から
// 移した部分は engine.ts の説明を参照）。
//
// ── B'-3d-2b（2026-08-30）: executeTool を main が直呼びで実行する ───────────────
// これまで executeTool は renderer への ask（'executeTool'）だった。今回、本体
// （shared/toolExecCore.ts の executeToolCore・B'-3d-2a で切り出し済み）を main が直接呼ぶ
// ように変える。ask だった間はウィンドウが生きていないとツールを実行できず、「窓を閉じても
// 作業が続く」（B'-3d）の最大の障害だった。io（副作用の束）は buildMainIo が組み立てる
// （renderer 側の aiTools.ts buildIo と対になる main 版・中身は各 main 実装への直呼び）。
//
// ── B'-3d-3（2026-08-30）: approveToolCall を main が直呼びで判定・駐機する ─────────
// 承認は「人が要る ask」の最後の1つだった。ask のままだと、窓を閉じる・リロードした瞬間に
// 未回答の承認ごとターンが死ぬ（chatTurn:start の onGone → bridge.rejectAll）。ここからは
// 要否判定・文面組み立てを shared/approvalPlan.ts の純関数（planApproval）で main が行い、
// 承認そのもの（保留＋答えを待つ）は専用マネージャ（chat/approvalStore.ts・メモリのみ）に
// **駐機**させる——タイムアウトしない。窓が閉じていても、renderer が approval:answer を
// 呼ぶまでずっと待つ。
//
// ── B'-3e-b（2026-09-03）: getHistory を main が直呼びで convDir から読む ─────────
// 単独チャット（ChatApp）も main が書き主になった（EngineTurnSpec.convDir・下の buildMainPorts
// の emit・compactWarnOnce 参照）。getHistory はもう「toolsProjectDir があるかどうか」では
// 分岐しない——convDir（会話の置き場。ChatPanel は projectDir、ChatApp はセッション擬似 dir）
// から convStore.loadConversation を直読みするだけになり、renderer への ask（'getHistory'）は
// 完全に無くなった。
import { ipcMain, shell } from 'electron'
import type { WebContents } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { IpcDeps } from '../ipc/types'
import { createAskBridge, type AskBridge } from './askBridge'
import { applyConversationOps, loadConversation } from './convStore'
import { requestApproval } from './approvalStore'
import { runEngineTurn, type EngineTurnPorts, type TurnHelpers } from '../../shared/chatTurn'
import { runSakuraChat, runSakuraStream } from '../sakura/engine'
import type { TurnStartPayload, TurnAnswer, TurnAsk } from '../../shared/chatTurnRpc'
import {
  formatChatError, condenseReasoning, hasTextToolMarkup, stripToolMarkup, unexecutedToolWarning,
  claimsFileChange, unexecutedChangeWarning, stripRepeatedGuidance, isToolArgsComplete, isToolUnsupportedError,
  toolStatusLabel, WRITING_TOOLS, toolsFor, searchStatusContext, requiresConfirmation,
} from '../../shared/aiToolsCore'
import { estimateTokens, isImageUnsupportedError, modelLabel, pickBestModel, isVisionModel, DEFAULT_VISION_MODEL } from '../../shared/modelInfo'
import { extractUrls, wantsWebSearch } from '../../shared/webContextCore'
import { planSend, planCompact, compactPrompt, acceptSummary, compactSource } from '../../shared/historyCompact'
import { shouldSendTools, isKnownToolCapable, shouldTryImagesDirectly } from '../../shared/modelLearning'
import { getLearning, recordLearning } from '../learningStore'
import { hashKey } from '../../shared/usageBudget'
import { checkBeforeRequest, recordUsage } from '../usageStore'
// B'-3d-2b: executeTool の main 直呼び用の追加インポート ──────────────────────
import { executeToolCore, type CoreToolContext, type ToolIo, type SearchConfig } from '../../shared/toolExecCore'
import { cleanAiRelPath } from '../../shared/publishRoot'
import { fetchUrlPage, webSearch } from '../ipc/web'
import { readFileInProjectFs, writeFileInProjectFs, projectFilesFs, searchInProjectFs } from '../ipc/fs'
import { runProjectCommand } from '../ipc/shell'
import { snapshotBeforeWrite as snapshotBeforeWriteOnDisk } from '../backup/store'
import * as ragClient from '../rag/client'
import { buildRagBlockText } from '../claude/toolText'
// B'-3d-3: approveToolCall の main 直呼び用の追加インポート ────────────────────
import { planApproval, writeDenialMessage, runCommandDenialMessage, type WriteMode } from '../../shared/approvalPlan'

// h は shared から**本物の実装**を import して組み立てる（renderer は import できないモジュールなので、
// ここで初めて main 側から使われる。aiToolsCore / modelInfo / webContextCore / historyCompact /
// chatTurn の型に合っていることは `npx tsc -p tsconfig.main.json --noEmit` が担保する）。
const h: TurnHelpers = {
  formatChatError,
  condenseReasoning,
  hasTextToolMarkup,
  stripToolMarkup,
  unexecutedToolWarning,
  claimsFileChange,
  unexecutedChangeWarning,
  stripRepeatedGuidance,
  isToolArgsComplete,
  isToolUnsupportedError,
  isImageUnsupportedError,
  toolStatusLabel,
  modelLabel,
  pickBestModel,
  writingTools: WRITING_TOOLS,
  extractUrls,
  wantsWebSearch,
  toolsFor,
  planSend,
  planCompact,
  compactPrompt,
  acceptSummary,
  compactSource,
  searchStatusContext,
}

// ── vision.defaultModel（B'-3d-1a）: renderer/usage.ts の getDefaultVisionModel と
// 同じアルゴリズムを main で計算する ──────────────────────────────────────
//
// renderer 版（usage.ts）は「キャッシュ済みモデル一覧（getCachedModelIds）」から選ぶが、
// main はそのキャッシュを持たない。代わりに送信時に renderer が確定させた
// payload.spec.models（EngineTurnSpec.models）から選ぶ——中身は「そのターンで実際に使える
// モデル一覧」なので、選ぶ元が違うだけで結果は同じになる。
// isVisionModel・DEFAULT_VISION_MODEL は shared/modelInfo.ts の一元定義を使う（複製しない・掟10）。
//
// export: tests/learningWiring.test.ts が直接呼んで検証する（この関数は electron に触れない
// 純関数なので、registerChatTurnHandlers を呼ばずにモジュールを import するだけで安全にテストできる）。
export function defaultVisionModelFor(models: { id: string }[]): string {
  const ids = models.map(m => m.id)
  if (ids.includes(DEFAULT_VISION_MODEL)) return DEFAULT_VISION_MODEL
  return ids.find(isVisionModel) ?? DEFAULT_VISION_MODEL
}

// ── compactWarnOnce（B'-3d-1b）: 「まとめ失敗の警告は1度だけ」の印を main が直接持つ ─────────
//
// 以前（renderer 側の compactWarnedRef）は「1度だけ」の寿命が **ChatPanel のマウント・
// モード切替でリセット**されていた（コンポーネントの useRef なので画面が作り直されると消える）。
// main へ移したことで、寿命は **main プロセスの寿命**（アプリ起動ごと）× **会話キー別**へ変わる。
// キーは payload.spec.toolsProjectDir（無ければ単独チャット扱いで '@chat-app' に束ねる）。
// 会話ごとに1つの印を持つようになるぶん、「会話ごとに1度」という本来の意味に近づき、
// **窓を閉じてもターンが止まらない**（B'-3d の目的そのもの）——renderer 側の印はウィンドウが
// 生きていないと読み書きできなかったが、main のメモリはウィンドウの有無に関係なく生きている。
// 永続化はしない（アプリを再起動すれば全会話の印はリセットされる。学習キャッシュ・利用実績と
// 違い、ファイルに残す価値が無い一過性の状態のため）。
const compactWarned = new Set<string>()

/** テスト用: モジュール内の Set をリセットする。本番コードはこれを呼ばない。 */
export function resetCompactWarnedForTest(): void {
  compactWarned.clear()
}

/** ターンごとの管理表の1件。 */
type TurnEntry = {
  bridge: AskBridge
  /** 進行中の応答を止める関数（ports.setAbort が差し込む）。未設定・停止済みは null。 */
  abort: (() => void) | null
}

// ── B'-3d-2b: executeTool の main 直呼び ────────────────────────────────
//
// chatTurn.ts（runEngineTurn）は `ports.executeTool(toolName, toolArgs,
// { ...turnOpts, search, snapshotId, snapshotLabel })` の形で呼ぶ（turnOpts は
// renderer が送った spec.turnOpts＝ChatPanel の buildExecuteOpts() から関数を落とした
// 直列化可能な値。B'-3d-2b 以降は元から関数を含まない＝writeRoot/projectRoot/rag のみ）。
// この opts から CoreToolContext（coreCtx）と ToolIo（buildMainIo）を組み立てる。

/** opts（executeTool 呼び出しの第3引数）から CoreToolContext を取り出す。 */
function coreCtx(opts: Record<string, unknown>): CoreToolContext {
  return {
    writeRoot: opts.writeRoot as string | null | undefined,
    projectRoot: opts.projectRoot as string | null | undefined,
    search: opts.search as SearchConfig | null | undefined,
    snapshotId: opts.snapshotId as string | undefined,
    snapshotLabel: opts.snapshotLabel as string | undefined,
  }
}

/**
 * main の io（副作用の束）を直呼びの実装で組み立てる。renderer の皮（aiTools.ts の buildIo）と
 * 対になる main 版——中身は window.electronAPI.* の代わりに、各 main 実装（ipc/fs.ts・
 * ipc/shell.ts・ipc/web.ts・backup/store.ts）を直接呼ぶだけ。
 *
 * @param opts   executeTool 呼び出しの第3引数（coreCtx と同じ出どころ）。rag: { tags } | null を含む。
 * @param payload このターンの開始要求（apiKey を ragSearch が使う）。
 * @param emit   buildMainPorts の emit と同じもの（applyFile 完了後に aiFileWritten を通知する）。
 *
 * export: tests/toolExecMainIo.test.ts が実ファイルシステムで直接検証する。
 */
export function buildMainIo(
  opts: Record<string, unknown>,
  payload: TurnStartPayload,
  emit: EngineTurnPorts['emit'],
): ToolIo {
  const rag = opts.rag as { tags: string[] } | null | undefined
  return {
    fetchPage: (url) => fetchUrlPage(url),
    webSearch: (provider, key, query) => webSearch(provider, key, query),
    projectFiles: async (root) => projectFilesFs(root),
    readFileInProject: async (root, rel) => readFileInProjectFs(root, rel),
    writeFileInProject: async (root, rel, content) => { writeFileInProjectFs(root, rel, content) },
    // 保存＋エディタ・ツリー反映（renderer 版 io.applyFile と同じ役割）。main は「保存」だけを
    // ここで直接行い（fs:writeFile ハンドラと同じ書き方）、エディタへの反映は renderer 側
    // （App.tsx の showAiFileInEditor）に任せる（掟11: いま見ているプロジェクトの分だけ開く
    // 判定は renderer 側でしかできない）。そのための通知が ChatEvent 'aiFileWritten'。
    applyFile: async (rel, content) => {
      const full = path.join(String(opts.writeRoot ?? ''), cleanAiRelPath(rel))
      fs.mkdirSync(path.dirname(full), { recursive: true }) // 親フォルダが無ければ作成
      fs.writeFileSync(full, content, 'utf-8')
      emit({ kind: 'aiFileWritten', rel, full })
    },
    snapshotBeforeWrite: async (root, snapshotId, rel, newContent, label) =>
      snapshotBeforeWriteOnDisk(root, snapshotId, rel, newContent, label),
    runCommand: runProjectCommand,
    // 📚 資料の検索（search_docs）。renderer ChatPanel の buildExecuteOpts().ragSearch
    // （2026-08-30 時点）と一字一句同じパラメータ（query.slice(0,1000)・tags・topK 3）で組む。
    // rag（opts.rag）が無ければ undefined＝core が「資料検索は現在利用できません」を返す
    // （renderer 側で ctx.ragSearch が無いときと同じ振る舞い）。失敗は ''（renderer 版と同じ）。
    ragSearch: rag ? async (query: string) => {
      try {
        const hits = await ragClient.queryDocuments(payload.spec.apiKey, query.slice(0, 1000), {
          tags: rag.tags.length ? rag.tags : undefined,
          topK: 3,
        })
        return buildRagBlockText(hits)
      } catch {
        return ''
      }
    } : undefined,
    searchInProject: async (root, query, pathPattern) => searchInProjectFs(root, query, pathPattern),
    exists: async (p) => fs.existsSync(p),
    openPath: async (p) => { await shell.openPath(p) },
  }
}

// ── B'-3d-3: 承認の判定〜駐機〜拒否文面までの一連の流れ ─────────────────────────
//
// scope は chatTurn.ts が turnOpts（ChatPanel の buildExecuteOpts() の返り値。
// writeRoot/projectRoot/rag/writeMode を持つ）をそのまま渡してくる（型は
// projectDir/writeRoot だけを謳っているが、turnOpts に projectDir というキーは無い——
// 旧 renderer 版の `scope?.projectDir ?? projectDir` が常に後者に落ちていたのと同じ理由で、
// ここでも scopeDir は「このターンが縛られているプロジェクト」＝payload.spec.toolsProjectDir
// を使う。scopeRoot は scope.writeRoot（turnOpts に実在するキー）をそのまま使う。
//
// export: tests/approvalWiring.test.ts が**実駆動**で検証する（初回のミューテーション試験で、
// ソース読みだけの固定は「plan を無視して素通りする」変異を捕まえられないと実測したため。
// approvalStore のリスナーを差し替えれば、electron 非依存のまま request→answer の往復を試せる）。
export async function decideApproval(
  name: string,
  argsJson: string,
  scope: { writeRoot?: string | null } | undefined,
  payload: TurnStartPayload,
  turnId: string,
): Promise<string | null> {
  const scopeDir = payload.spec.toolsProjectDir
  const scopeRoot = (scope?.writeRoot ?? null) as string | null
  const writeMode: WriteMode = (payload.spec.turnOpts as { writeMode?: string })?.writeMode === 'confirm' ? 'confirm' : 'auto'

  // install 系コマンドの依存名（package.json 読み取り）は、確認が要るときだけ読む
  // （旧 renderer 版と同じ節約。読めなければ名前なしで確認する）。
  let deps: string[] = []
  if (name === 'run_command') {
    let cmd = ''
    try { cmd = JSON.parse(argsJson || '{}')?.command ?? '' } catch { /* 不明でも確認は出す */ }
    if (writeMode === 'confirm' || requiresConfirmation(cmd)) {
      try {
        if (scopeDir && /\b(install|i|add)\b/.test(cmd)) {
          const raw = fs.readFileSync(`${scopeDir}/package.json`, 'utf-8')
          const d = JSON.parse(raw)?.dependencies
          deps = d && typeof d === 'object' ? Object.keys(d) : []
        }
      } catch { /* 読めなければ名前なしで確認する */ }
    }
  }

  const plan = planApproval(name, argsJson, { writeMode, scopeDir, scopeRoot, deps })
  if (!plan) return null // 承認不要（現行と同じ）

  const approved = await requestApproval({ turnId, dir: scopeDir, label: plan.label })
  if (approved) return null
  return name === 'run_command' ? runCommandDenialMessage(argsJson) : writeDenialMessage(name, argsJson)
}

/** renderer にしか無い副作用を ask で組み立てる。optional な ports は caps が false なら undefined にする
 *  （無いのに ask すると挙動が変わるため・仕様書の注記）。 */
function buildMainPorts(turnId: string, wc: WebContents, payload: TurnStartPayload, entry: TurnEntry): EngineTurnPorts {
  const { bridge } = entry
  const { caps } = payload
  // B'-3c: message系（append/replaceLast/removeLast）は、まず main の会話ストア
  // （convStore.ts）へ直接当ててから画面へ送る。renderer を経由しない書き込みの第一歩
  // （ウィンドウが閉じていても・出来事を取りこぼしても、会話は必ず保存される）。
  // loading/status/routed はストアに関係しないので、これまでどおり send のみ。
  //
  // ── B'-3e-b（2026-09-03）: 単独チャット（ChatApp）も main が書き主に ─────────────
  // 判定は toolsProjectDir ではなく spec.convDir で行う（会話の置き場と、ツールの根は別物。
  // ChatApp は toolsProjectDir が常に null でも convDir はセッション擬似 dir を持つ）。
  // convDir が無い（読み込み中などの異常系）ときだけストアに触らない。
  //
  // ── B-1a（2026-08-28）: 画面反映は chat:applied へ一本化・ここでの2重送信はそのまま残す ──
  // applyConversationOps がここで当たると、convStore.ts の通知口（setApplyListener）経由で
  // chat:applied が自動的に画面へ飛ぶ。convDir があるとき（ChatPanel・ChatApp とも）は、下の
  // wc.send（chatTurn:event）で運ばれる message系の ev は renderer 側でもう使われない
  // （useAiChat.ts の viewOnlyEmit は convDir がある間 message系を捨てる）。
  // それでも send 自体はここでは変えない（convDir が無いとき＝読み込み中などの異常系は
  // convStore に一切触れない＝chat:applied も届かないため、この send が唯一の反映経路のまま。
  // scalar/activity も引き続きこの経路が必要。仕様外の削減をしない）。
  //
  // B'-3d-2b: buildMainIo（aiFileWritten の emit）からも同じ emit を使うため、ここで局所変数に
  // 取り出しておく（下の executeTool の組み立てで参照する）。
  const emit: EngineTurnPorts['emit'] = (ev) => {
    if ((ev.kind === 'append' || ev.kind === 'replaceLast' || ev.kind === 'removeLast') && payload.spec.convDir) {
      applyConversationOps(payload.spec.convDir, [ev])
    }
    if (!wc.isDestroyed()) wc.send(`chatTurn:event:${turnId}`, { type: 'emit', ev })
  }
  return {
    emit,
    chatStream: (req, onDelta, onAbortReady, onThinking) =>
      runSakuraStream(req, { onDelta, onReasoning: onThinking, onAbortReady }),
    // 🗂 まとめ作り中の ⏹ 停止（0.3.50）: runSakuraChat の onAbortReady で受け取った中断関数を
    // entry.abort へ差し込む（chatTurn:abort → turns.get(turnId)?.abort?.() から呼べるように）。
    // ports.setAbort は経由しない（EngineTurnPorts.chatOnce の型に abort registration は無く、
    // まとめ作りは main だけで完結する処理のため、この配線も main 内で完結させる）。
    // まとめが終わったあとも entry.abort にはこの中断関数が残り続けるが、完了済みリクエストへの
    // abort は無害（呼んでも何も起きない）。次にストリーミングが始まれば ports.setAbort が
    // 新しい中断関数で上書きするので、古いものが誤って呼ばれる実害は無い。
    chatOnce: (req) => runSakuraChat(req, { onAbortReady: (abort) => { entry.abort = abort } }),
    // B'-3e-b: 会話の保存先（convDir）を convStore から直読みする（ask ではない）。
    // 単独チャット（ChatApp）も main が書き主になったため、もう renderer の記憶を頼らない
    // （ASK_PATHS から 'getHistory' を外した。コメントは chatTurnRpc.ts 参照）。
    // convDir が無い（会話の置き場が無い）異常系は空履歴で開始する。
    getHistory: () => {
      const dir = payload.spec.convDir
      return dir ? (loadConversation(dir) ?? []) : []
    },
    buildSystemPrompt: () => bridge.ask('buildSystemPrompt', []) as any,
    onUserMessage: caps.onUserMessage
      ? (text, isFirst) => bridge.ask('onUserMessage', [text, isFirst]) as any
      : undefined,
    // B'-3d-3: ask('approveToolCall', ...) から main 直判定＋駐機へ（実体は decideApproval・下記）。
    approveToolCall: (name, argsJson, scope) => decideApproval(name, argsJson, scope, payload, turnId),
    // B'-3d-2b: ask('executeTool', ...) から直呼びへ。本体（判定順序・結果文言）は
    // shared/toolExecCore.ts の executeToolCore（renderer と共有・複製ゼロ）。
    executeTool: (name, argsJson, opts) => executeToolCore(name, argsJson, coreCtx(opts), buildMainIo(opts, payload, emit)),
    buildRagBlock: caps.buildRagBlock
      ? (text) => bridge.ask('buildRagBlock', [text]) as any
      : undefined,
    getSearchConfig: () => bridge.ask('getSearchConfig', []) as any,
    fetchPagesBlock: (urls) => bridge.ask('fetchPagesBlock', [urls]) as any,
    autoSearchBlock: (text, search) => bridge.ask('autoSearchBlock', [text, search]) as any,
    notifyActivity: () => { if (!wc.isDestroyed()) wc.send(`chatTurn:event:${turnId}`, { type: 'activity' }) },
    setAbort: (fn) => { entry.abort = fn },
    // B'-3d-1b: 予算・利用実績の持ち主が main の usageStore.ts へ移った。renderer へ ask せず、
    // ここで直接読み書きする（ask が2本減った）。APIキーは main へ渡らない・保存しない（掟4）
    // ため、usageStore の API はすべて指紋（fp = hashKey(apiKey)）ベース。
    usage: {
      check: () => checkBeforeRequest(hashKey(payload.spec.apiKey)),
      record: (model, promptTokens, completionTokens) => recordUsage(hashKey(payload.spec.apiKey), model, promptTokens, completionTokens),
      estimate: (text) => estimateTokens(text), // 純粋関数。main が直接持つ（往復しない・仕様書の注記）
    },
    // B'-3d-1a: 学習キャッシュ（ツール対応・画像対応）の持ち主が main の learningStore.ts へ
    // 移った。renderer へ ask せず、ここで直接読み書きする（ask が6本減った）。
    toolSupport: {
      shouldSendTools: (model) => shouldSendTools(getLearning().toolSupport, model),
      isKnownToolCapable: (model) => isKnownToolCapable(getLearning().toolSupport, model),
      record: (model, supported) => recordLearning('tool', model, supported),
    },
    vision: {
      shouldTryDirect: (model) => shouldTryImagesDirectly(getLearning().visionSupport, model),
      record: (model, supported) => recordLearning('vision', model, supported),
      defaultModel: () => defaultVisionModelFor(payload.spec.models),
    },
    // B'-3d-1b: 上のコメント（compactWarned）参照。会話キー（convDir。B'-3e-b: 単独チャットも
    // セッション擬似 dir を convDir に持つため、常に会話ごとに固有の鍵になる。convDir が無い
    // 異常系だけ '@chat-app' に束ねる）ごとに初回だけ true を返す。
    compactWarnOnce: () => {
      const key = payload.spec.convDir ?? '@chat-app'
      if (compactWarned.has(key)) return false
      compactWarned.add(key)
      return true
    },
    h,
  }
}

export function registerChatTurnHandlers(_deps: IpcDeps): void {
  const turns = new Map<string, TurnEntry>()

  ipcMain.handle('chatTurn:start', async (event, payload: TurnStartPayload) => {
    const wc = event.sender
    const { turnId } = payload
    const entry: TurnEntry = {
      bridge: createAskBridge((ask: TurnAsk) => { if (!wc.isDestroyed()) wc.send(`chatTurn:ask:${turnId}`, ask) }),
      abort: null,
    }
    turns.set(turnId, entry)

    // 画面が閉じられた・リロードされたとき、未回答の ask が永遠に残らないようにする
    // （2026-08-28 仕様書の注記: wc.once('destroyed') が使える。リロード＝did-navigate も同様に扱う）。
    // 正常終了時はここで登録した分をきちんと外す（did-navigate は 'once' ではないため、
    // 外し忘れるとターンのたびにリスナーが積み上がる）。
    const onGone = () => { entry.bridge.rejectAll('画面が閉じられました') }
    wc.once('destroyed', onGone)
    wc.on('did-navigate', onGone)

    // ターンの結末（エラーで終わったか）。出来事（chatTurn:event）は invoke の完了に追い越されて
    // 失われうるため、結末は invoke の返り値でも伝える（chatTurn.ts の runEngineTurn コメント参照・B-2）。
    let endedWithError = false
    try {
      endedWithError = (await runEngineTurn(payload.spec, buildMainPorts(turnId, wc, payload, entry))).endedWithError
    } catch (e) {
      // chatTurn.ts 自身がエラーを会話の吹き出しにするので、ここへ来るのは想定外のバグのみ。
      // ハンドラの外へ投げ直さず（invoke を reject させない）、ログにだけ残す（仕様書の注記）。
      console.error('[chatTurn:start] runEngineTurn failed', e)
      endedWithError = true // 想定外のバグで終わったターンも「見てほしい」対象
    } finally {
      // 破棄済みの WebContents はメソッド呼び出し自体が例外を投げることがある
      // （windowSend.ts の isDestroyed() と同じ注意）。触れなくても実害は無いので無視する。
      try { wc.off('destroyed', onGone); wc.off('did-navigate', onGone) } catch { /* 破棄済みで触れない場合は無視 */ }
      entry.bridge.rejectAll('ターンが終了しました')
      turns.delete(turnId)
    }
    return { ok: true, endedWithError }
  })

  // 進行中の応答を止める（sakura:chat-abort と同じ考え方）。turnId が無ければ何もしない。
  ipcMain.handle('chatTurn:abort', (_, turnId: string) => {
    turns.get(turnId)?.abort?.()
  })

  // renderer からの ask への回答。該当 turn の帳簿へ渡す（無ければ何もしない）。
  ipcMain.handle('chatTurn:answer', (_, a: TurnAnswer) => {
    turns.get(a.turnId)?.bridge.answer(a)
  })
}
