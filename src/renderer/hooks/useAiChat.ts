// AIチャットの送信パイプライン（ChatApp / ChatPanel 共通）。
// 予算チェック → visionモデル自動切替 → Web参照/検索の添付 → ストリーミング → エージェントループ
// （ツール実行・自己修復・モデル割り振り）までを1本のフックに集約する。
// 表示先（セッション内 / フラット配列）や承認フロー等の差分は引数のコールバックで吸収する。
//
// ── B'-3a（2026-08-28）─────────────────────────────────────────────
// AI Engine 経路の本体（利用上限チェック〜エージェントループ）は src/shared/chatTurn.ts の
// runEngineTurn / runCompact へ切り出した（React / window / electron に依存しない形にするため。
// 次段 B'-3b でこのループを main プロセスで動かす下準備）。このフックは、その入力（spec）と
// 外部への接点（ports）を組み立てて呼ぶだけになっている。Claude頭脳モード（sendViaClaude）は
// 従来どおりこのファイルに残る。

import { useState, useRef, useEffect, useCallback } from 'react'
import { checkBeforeRequest, recordUsage, estimateTokens, getDefaultVisionModel, modelLabel, pickBestModel } from '../usage'
import { shouldTryImagesDirectly, recordVisionSupport, isImageUnsupportedError } from '../visionSupport'
import { extractUrls, fetchPagesBlock, autoSearchBlock, wantsWebSearch } from '../webContext'
import { toolsFor, isToolUnsupportedError, executeTool, toolStatusLabel, getSearchConfig, formatChatError, formatClaudeError, condenseReasoning, hasTextToolMarkup, stripToolMarkup, unexecutedToolWarning, claimsFileChange, unexecutedChangeWarning, WRITING_TOOLS, isToolArgsComplete, type ToolContext } from '../aiTools'
import { shouldSendTools, isKnownToolCapable, recordToolSupport } from '../toolSupport'
import { planSend, planCompact, planManualCompact, compactPrompt, acceptSummary, compactSource, type CompactMark } from '../historyCompact'
import { searchStatusContext } from '../aiContext'
import { getAnthropicToken } from '../components/CredentialsModal'
import { isClaudeModeEnabled, hasClaudeConsent, recordClaudeConsent, recordClaudeCost, claudeToolLabel, claudeCostFooter, getClaudeModel, claudeNoProjectGuidance, claudeConsentDeclinedGuidance, isClaudeUsageBlockedError, setClaudeMode } from '../claudeMode'
import { getClaudeSessionId, setClaudeSessionId } from '../claudeSession'
import { beginActivity } from '../activity'
import { applyToMessages, type ChatEvent } from '../../shared/chatEvents'
import { runEngineTurn, runCompact, type EngineTurnSpec, type EngineTurnPorts } from '../../shared/chatTurn'

export type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  hidden?: boolean // AIへの内部指示など、画面に出さないメッセージ
  toolNote?: boolean // ツール実行状況の表示専用バブル。AIへは送らない（結果が伴わずモデルが混乱するため）
  images?: string[] // ユーザーが添付した画像（data URL）
  /** Claudeが請求・クレジット不足等で使えないとき、「さくらのAI Engineに切り替えて同じ内容を送り直す」
   *  ボタンをこのバブルに出すためのペイロード（ユーザー要望2026-07-12・確認方式のフォールバック）。 */
  offerAiEngineFallback?: { text: string; images?: string[] }
  /** ツール実行の回数上限で中断したとき、「続ける」ボタンをこのバブルに出す
   *  （従来は利用者が「続けて」と手入力する必要があった・ユーザー要望2026-07-23）。 */
  offerContinue?: boolean
  /** 推論モデル（Kimi K2.7 / gpt-oss 等）が本文を出す前に流してくる「思考」。
   *  待っている間に「いま何をしているか」を見せるための表示専用（2026-08-03 ユーザー要望）。
   *  **AIへは送り返さない**（費用が増え、モデルも混乱する）。**履歴ファイルにも保存しない**
   *  （本文の何倍にもなり chat.json が膨らむため。chatStorage.ts の保存時に落とす）。 */
  thinking?: string
  /** 🗂 これまでのやり取りのまとめ（content がまとめ本文）。
   *  会話が長くなったとき、古いぶんを**捨てずに**1件へ畳んだもの。
   *  画面には「🗂 ここまでの内容をまとめました」とだけ出し、本文は折りたたむ（CompactNote.tsx）。
   *  AIへは、この1件だけを履歴の先頭に置いて送る（historyCompact.ts）。 */
  summary?: CompactMark
  /** そのやり取りがあった時刻（ISO 8601）。**古い会話には無い**（あとから付けない）。 */
  at?: string
}

export type UseAiChatArgs = {
  apiKey: string
  /** 現在選択中のモデル（画面側のセレクタ値） */
  model: string
  /** ライブモデル一覧（ルーティング用） */
  models: { id: string }[]
  /** エージェントループの最大周回数（1周 = AIへの1回の問い合わせ）: ChatApp=12, ChatPanel=25。
   *  2026-07-23 に 3/5 から引き上げた。ファイルを数個読んで直して確認する、という普通の作業でも
   *  5周では即座に使い切っていたため（ユーザー報告「すぐに上限が出る」）。
   *  暴走への歯止めは (1) 同一ツール呼び出しの連続検出（下記 REPEAT_LIMIT）(2) 停止ボタン
   *  (3) 月間予算上限 の3つで担保する。周回数はあくまで最後の保険。 */
  maxRounds: number
  /** システムプロンプトを組み立てる（ChatApp=CHAT_CONTEXT固定 / ChatPanel=IDE_CONTEXT+projectCtx+openFileBlock） */
  buildSystemPrompt: () => string
  /** toolsFor() の第1引数（ChatApp=null / ChatPanel=projectDir） */
  toolsProjectDir: string | null
  /** executeTool に渡す追加オプションを作る（search は hook が持つので除く）: ChatApp=()=>({}) / ChatPanel=()=>({ projectDir, applyFile: onApplyFile }) */
  buildExecuteOpts: () => Record<string, unknown>
  /** ツール実行前の承認フック。undefined なら常に許可（ChatApp）。ChatPanel は write_file/run_command の確認UIをここに実装。戻り値: 許可なら null、拒否なら tool 結果として返す文字列 */
  /**
   * 実行の許可を取る。`scope` は**このターンが縛られている行き先**（送信時に固定したもの）。
   * 画面が別のプロジェクトへ切り替わっていても、**確認は始めたプロジェクトの話**として出す。
   */
  approveToolCall?: (
    name: string, args: string,
    scope?: { projectDir?: string | null; writeRoot?: string | null },
  ) => Promise<string | null>
  /** APIへ送る過去履歴を返す（**加工前の生配列**。表示専用の除外・まとめの適用は hook 内の planSend が行う） */
  getHistory: () => ChatMessage[]
  /** 画面のメッセージ列を関数型更新する（ChatApp はアクティブセッション内、ChatPanel はフラット配列に適用） */
  updateShown: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void
  /** 送信直後にユーザー吹き出しを載せた後の追加処理（ChatApp のセッションタイトル生成など）。省略可 */
  onUserMessage?: (text: string, isFirst: boolean) => void
  /** catch 時のエラー文言の接頭辞（ChatApp='⚠️ ' / ChatPanel=''）。省略時は '' */
  errorPrefix?: string
  /** 画像ターンを「視覚モデルで読み取り→本来のモデルで実行」の2段階にする（IDE=true, チャット=false） */
  twoStageVision?: boolean
  /** 📚 資料の自動注入ブロックを作る（ragContext.ts の autoRagBlock 相当）。省略時は資料注入なし（従来と同一動作） */
  buildRagBlock?: (text: string) => Promise<string>
  /** Claudeモード（C2/C3）が main プロセス側でファイルを書き込んだ直後に、該当タブをディスクから
   *  読み直させる（App.tsx の applyRestoreResult 相当。**stale tab のオートセーブ上書きによる
   *  データ喪失防止**・2026-07-11 の致命バグ修正）。ChatApp（プロジェクト無し）は省略可 */
  onExternalFilesChanged?: (relPaths: string[]) => void
}

export function useAiChat(args: UseAiChatArgs) {
  const {
    apiKey, model, models, maxRounds, buildSystemPrompt, toolsProjectDir,
    buildExecuteOpts, approveToolCall, getHistory, updateShown, onUserMessage,
    errorPrefix = '', twoStageVision = false, buildRagBlock, onExternalFilesChanged,
  } = args

  const [isLoading, setIsLoading] = useState(false)
  // 応答待ち中の補足表示（例: 🔍 Web検索中…）。空なら点だけ。
  const [statusNote, setStatusNote] = useState('')
  // B: この会話でツール作業のため切り替えた「割り振り先」モデル（null=未割り振り）。会話中は維持。
  const [routedModel, setRoutedModel] = useState<string | null>(null)
  // 停滞検知：ローディング中、一定時間トークンが来なければ「時間がかかっています」を表示（ハングと処理中を区別）
  const [stalled, setStalled] = useState(false)
  const lastActivityRef = useRef(Date.now())
  const abortRef = useRef<(() => void) | null>(null) // 進行中の応答を停止する関数
  // Claude頭脳モード（C2a）: 継続会話用のセッションID。プロジェクト単位で永続化し（所見10）、
  // アプリ再起動・プロジェクト再オープンをまたいで会話の続きを resume できるようにする
  // （失効時は main 側 agent.ts が新規セッションへ自動フォールバックするため行き止まりにならない）。
  const claudeSessionRef = useRef<string | null>(null)

  // 応答開始からの経過秒数（待ち時間の見える化・2026-08-03 ユーザー要望）。
  // 推論モデルは数十秒沈黙することがあり、「あと少し待つ／止める」の判断材料になる。
  const [elapsedSec, setElapsedSec] = useState(0)

  useEffect(() => {
    if (!isLoading) { setStalled(false); setElapsedSec(0); return }
    lastActivityRef.current = Date.now()
    const startedAt = Date.now()
    const t = setInterval(() => {
      setStalled(Date.now() - lastActivityRef.current > 20000)
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(t)
  }, [isLoading])

  // プロジェクトが変わったら、そのプロジェクトに保存済みのセッションIDを読み込む（所見10）。
  // 単独チャット（toolsProjectDir=null）は Claude 経路を使わないため常に null。
  useEffect(() => { claudeSessionRef.current = getClaudeSessionId(toolsProjectDir) }, [toolsProjectDir])

  const abort = useCallback(() => { abortRef.current?.() }, [])

  // 画面に出す「出来事」はすべてここを通す。B'-3 でここが「main へ送る」に変わる。
  const emit = useCallback((ev: ChatEvent<ChatMessage>) => {
    switch (ev.kind) {
      case 'append':
      case 'replaceLast':
      case 'removeLast':
        updateShown(prev => applyToMessages(prev, ev))
        break
      case 'loading': setIsLoading(ev.value); break
      case 'status': setStatusNote(ev.value); break
      case 'routed': setRoutedModel(ev.value); break
    }
  }, [updateShown])

  // 末尾の吹き出し操作ヘルパー（emit を呼ぶだけの薄い包み。呼び出し側は書き換えない）
  const appendBubble = useCallback((msg: ChatMessage) => emit({ kind: 'append', msg }), [emit])
  const replaceLast = useCallback((msg: ChatMessage) => emit({ kind: 'replaceLast', msg }), [emit])
  const removeLast = useCallback(() => emit({ kind: 'removeLast' }), [emit])

  /** 「まとめ失敗の警告は1度だけ」の印。chatTurn.ts の runEngineTurn/runCompact へ ports.compactWarnOnce
   *  として渡す（実体は chatTurn.ts へ移った compactIfNeeded が使う）。 */
  const compactWarnedRef = useRef(false)

  /**
   * AI Engine 経路（src/shared/chatTurn.ts の runEngineTurn / runCompact）へ渡す差し込み口を組み立てる。
   *
   * ── なぜここで組み立てるか（B'-3a）─────────────────────────────
   * 以前はループの中で直接これらの値・関数を呼んでいた。ここで束ねているものは
   * **呼び出し先を変えただけ**で、値の鮮度は変わらない
   * （getSearchConfig 等は関数のまま渡すので、呼ばれた瞬間に読み直される。
   * apiKey・model 等はこの関数が呼ばれた時点の値を閉じ込める＝以前と同じ）。
   */
  const buildPorts = (): EngineTurnPorts => ({
    emit,
    chatStream: (req, onDelta, onAbortReady, onThinking) =>
      window.electronAPI.sakura.chatStream(req, onDelta, onAbortReady, onThinking),
    chatOnce: (req) => window.electronAPI.sakura.chat(req),
    getHistory,
    buildSystemPrompt,
    onUserMessage,
    approveToolCall,
    executeTool: (name, argsJson, opts) => executeTool(name, argsJson, opts as ToolContext),
    buildRagBlock,
    getSearchConfig,
    fetchPagesBlock,
    autoSearchBlock: (text, search) => autoSearchBlock(text, search as any),
    notifyActivity: () => { lastActivityRef.current = Date.now() },
    setAbort: (fn) => { abortRef.current = fn },
    usage: {
      check: () => checkBeforeRequest(apiKey),
      record: (m, i, o) => recordUsage(apiKey, m, i, o),
      estimate: (t) => estimateTokens(t),
    },
    toolSupport: {
      shouldSendTools,
      isKnownToolCapable,
      record: recordToolSupport,
    },
    vision: {
      shouldTryDirect: shouldTryImagesDirectly,
      record: recordVisionSupport,
      defaultModel: getDefaultVisionModel,
    },
    compactWarnOnce: () => {
      if (compactWarnedRef.current) return false
      compactWarnedRef.current = true
      return true
    },
    h: {
      formatChatError,
      condenseReasoning,
      hasTextToolMarkup,
      stripToolMarkup,
      unexecutedToolWarning,
      claimsFileChange,
      unexecutedChangeWarning,
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
    },
  })

  /**
   * 🗂 手動で「ここまでをまとめる」（2026-08-20 Ryosuke 要望）。
   *
   * 自動は本文95件（約47往復）を超えないと働かないので、**ほとんどの人は一度も見ない**。
   * 区切りたいときに自分で押せるようにする。直近3往復はそのまま残す。
   * **押した人には失敗も伝える**（自動と違い、待っている人がいるため）。
   */
  const compactNow = useCallback(async () => {
    if (isLoading) return
    const history = getHistory()
    const plan = planManualCompact(history)
    if (!plan) return
    emit({ kind: 'loading', value: true })
    try {
      const r = await runCompact({ apiKey, model }, buildPorts(), history, plan)
      if ('msg' in r) appendBubble(r.msg)
      else appendBubble({ role: 'assistant', toolNote: true, content: `⚠️ ${r.error}` })
    } finally {
      emit({ kind: 'loading', value: false })
    }
  }, [isLoading, getHistory, apiKey, model, appendBubble, emit])

  // Claude頭脳モード（C2a/C2b/C2d）: Agent SDK 経路での1ターン送信。SDK のストリームイベント
  // （session/text/tool/result/error/openPreview）をチャットの吹き出しへ反映する。
  // aiEngineKey は search_docs ツール用（C2b・方式B: 使う瞬間に読んで main へ引数で渡す。無ければ null）。
  // images は C2d: このターンでユーザーが添付した画像（data URL配列・空配列可）。main側 agent.ts が
  // 1枚以上ならストリーミング入力モードへ切り替え、Claude自身に直接読ませる（2段階visionを経由しない）。
  const sendViaClaude = useCallback(async (text: string, images: string[], claudeKey: string, snapshotId: string, projectDir: string, aiEngineKey: string | null) => {
    emit({ kind: 'loading', value: true })
    let assistantOpen = false
    let textAcc = ''
    // C2c: このターンで使うClaudeモデル（設定で選択済みのもの）。chatStart に渡し、
    // 終端の costFooter にも同じモデルのラベルを付ける。
    const claudeModel = getClaudeModel()
    // Claude 経路のエラー表示。Claudeが「利用できない」状態（請求・クレジット不足等）で、かつ
    // さくらのAI Engineキーがある場合は、その旨を伝えて「切り替えて続ける」提案バブルを出す
    // （ユーザー要望2026-07-12・自動切替はせず確認方式）。それ以外は従来どおり案内文を出す。
    const showClaudeError = (rawMessage: string) => {
      if (isClaudeUsageBlockedError(rawMessage) && apiKey) {
        appendBubble({
          role: 'assistant',
          toolNote: true,
          content: 'Claude が今は使えないようです（料金・請求の設定に問題がある可能性があります）。\nさくらのAI Engine に切り替えて、同じ内容をもう一度送りますか？',
          offerAiEngineFallback: { text, images },
        })
      } else {
        appendBubble({ role: 'assistant', content: errorPrefix + formatClaudeError(rawMessage) })
      }
    }
    try {
      await new Promise<void>(resolve => {
        let unsubscribe: (() => void) | null = null
        const finish = () => { unsubscribe?.(); resolve() }

        unsubscribe = window.electronAPI.claude.onStream((ev: ClaudeUiEvent) => {
          lastActivityRef.current = Date.now()
          switch (ev.kind) {
            case 'session':
              // 継続会話用に保持しつつ、プロジェクト単位で永続化する（所見10・再起動後も resume できる）。
              claudeSessionRef.current = ev.sessionId
              setClaudeSessionId(projectDir, ev.sessionId)
              break
            case 'text':
              if (!assistantOpen) {
                textAcc = ev.text
                appendBubble({ role: 'assistant', content: textAcc })
                assistantOpen = true
              } else {
                textAcc += ev.text
                replaceLast({ role: 'assistant', content: textAcc })
              }
              break
            case 'tool':
              assistantOpen = false
              textAcc = ''
              appendBubble({ role: 'assistant', content: claudeToolLabel(ev.name, ev.detail), toolNote: true })
              break
            case 'result':
              assistantOpen = false
              recordClaudeCost(ev.costUsd)
              appendBubble({ role: 'assistant', content: claudeCostFooter(ev.costUsd, claudeModel), toolNote: true })
              finish()
              break
            case 'error':
              assistantOpen = false
              // Claude 経路のエラーは Claude のキー/請求への案内に出し分ける（所見9）。
              // 請求・クレジット不足でさくらのAI Engineキーがあれば切替提案を出す（#31）。
              showClaudeError(ev.message)
              finish()
              break
            case 'openPreview':
              // C2b: open_preview ツールの副作用。従来経路（AI Engineループ）の open_preview と
              // 完全に同じ処理＝aiTools.ts executeTool の open_preview 分岐（存在確認→既定ブラウザで
              // 開く）を buildExecuteOpts の文脈（projectDir 等）で実行する。結果文字列は使わない
              // （ツール実行中の吹き出しは 'tool' イベント側で表示済み）。
              void executeTool('open_preview', JSON.stringify({ path: ev.path }), { ...buildExecuteOpts() })
              break
            case 'delegated':
              // C3: delegate_implementation の実行後。AI Engine 側の使用量として usage.ts へ記録する
              // （Claude自身のusage/コストとは別枠。フックの apiKey プロップ＝AI Engineキーが無ければ記録をスキップ）。
              if (apiKey) recordUsage(apiKey, ev.model, ev.promptTokens, ev.completionTokens)
              break
            case 'fileWritten':
              // Claude/委譲が main プロセス側でファイルを書いた直後。開きタブをディスクから読み直す
              // （stale tab のオートセーブ上書きによるデータ喪失防止・2026-07-11 の致命バグ修正）。
              onExternalFilesChanged?.([ev.path])
              break
          }
        })

        abortRef.current = () => {
          window.electronAPI.claude.chatCancel()
          appendBubble({ role: 'assistant', content: '（⏹ 停止しました）', toolNote: true })
          finish()
        }

        window.electronAPI.claude.chatStart(projectDir, claudeKey, text, images, snapshotId, claudeSessionRef.current, aiEngineKey, claudeModel)
          .catch((e: any) => {
            showClaudeError(e?.message ?? String(e))
            finish()
          })
      })
    } finally {
      abortRef.current = null
      emit({ kind: 'loading', value: false })
      emit({ kind: 'status', value: '' })
    }
  }, [appendBubble, replaceLast, errorPrefix, buildExecuteOpts, apiKey, onExternalFilesChanged, emit])

  /**
   * @param aiOnlyNote 画面には出さず、AI にだけ添える一言（2026-08-19）。
   *   例: 「画像を images/hero.jpg に入れました」。**入力欄に文を入れてから送らせない**
   *   ため（利用者が打った文とKotoの説明が混ざって読みにくかった）、送信のときに添える。
   *   pagesBlock / searchBlock / ragBlock と同じ扱い（吹き出しには出さない）。
   */
  const send = useCallback(async (rawText: string, images: string[], aiOnlyNote?: string) => {
    const hasImages = images.length > 0
    if ((!rawText.trim() && !hasImages) || isLoading) return
    const endActivity = beginActivity('AIが応答中')
    try {

      // このAIターンのスナップショットID（send 1回＝1ターン）。同一ターン内の複数 write_file の
      // 上書き前バックアップが同じスナップショットdir（.sakuraide-backup/<ISO日時>/）にまとまる。
      const snapshotId = new Date().toISOString().replace(/[:.]/g, '-')
      // 履歴（🕘）の見出し。「どの指示でこうなったか」が分かると「3つ前の状態に戻す」を選べる
      // （利用者からの要望・2026-08-05）。Claude経路の見出しは main 側が prompt から作る。
      const snapshotLabel = rawText.trim() || (hasImages ? '画像についての依頼' : '')
      /**
       * このターンが**どのプロジェクトのものか**を、送信した瞬間に固定する。
       *
       * ── なぜ要るか（2026-08-24 の実害と点検・Ryosuke 指摘）─────────────
       * これまでは道具を呼ぶ**たびに** `buildExecuteOpts()` を読み直していた。
       * Koto は同時に1つしか動かないが、**同じ画面のまま projectDir が差し替わる**ので、
       * 作業中にプロジェクトを切り替えると、**書き込み先も実行先も切り替え先へ移る**。
       * つまり **A の作業が B に付いてくる**。
       *
       * 送信した時点の行き先で最後まで通す。利用者が切り替えても、
       * **始めたプロジェクトの中で終わる**。並列に走らせる形（第2段階）の土台でもある。
       */
      const turnOpts = buildExecuteOpts()
      // 画面には出さず、AI にだけ添える一言（Koto が画像をどこへ入れたか等）
      const assetBlock = aiOnlyNote ? `\n\n${aiOnlyNote}` : ''

      // 未送信のまま行き止まりにするとき（プロジェクト未選択・同意キャンセル、いずれもモードB）に、
      // ユーザーの発言を残しつつ案内を返すための小さなヘルパー。
      const abortWithGuidance = (message: string) => {
        const text = rawText.trim() || (hasImages ? 'この画像について教えてください。' : '')
        appendBubble({ role: 'user', content: text, images: hasImages ? images : undefined })
        appendBubble({ role: 'assistant', content: message, toolNote: true })
      }

      // Claude頭脳モード（C2a/C2d）: プロジェクトが開かれていて（cwdが必要）・Anthropicキーが登録済みで・
      // モードが無効化されていなければ Claude 経路へ分岐する。画像添付ターンも Claude 自身が直接読む（C2d）。
      // プロジェクト未オープン時（ChatApp、またはIDEモードでプロジェクト未選択）は従来のAI Engine経路のまま
      // （AI Engineキーが無い＝モードBの場合のみ、行き止まりを避けるため下で案内する）。
      // AI Engine の2段階vision（視覚モデルで読み取り→本来モデルで実行）はモードC（Claude未接続）専用になった。
      const claudeKey = await getAnthropicToken()
      const claudeReady = !!claudeKey && isClaudeModeEnabled()

      if (toolsProjectDir && claudeReady) {
        if (!hasClaudeConsent()) {
          // 所見7: 料金発生（Anthropicへ直接課金・AI Engineの月間上限とは別枠）と、設定での切替可否を明記する。
          const agreed = window.confirm(
            'Claudeモードでは、プロジェクトのコードと指示が Anthropic（米国）に送信され、Claudeの利用料金が別途発生します'
            + '（Anthropicへ直接課金／さくらのAI Engineの月間上限とは別枠）。'
            + '使わないときは 設定 でさくらのAI Engineに切り替えられます。'
            + 'よろしいですか？（この確認は初回のみ）'
          )
          if (agreed) recordClaudeConsent()
        }
        if (hasClaudeConsent()) {
          // 画像のみの送信は従来経路と同じ既定文言を付ける（空のユーザー吹き出し・空テキスト送信を避ける）
          const text = rawText.trim() || (hasImages ? 'この画像について教えてください。' : '')
          const historyBefore = getHistory()
          const isFirst = historyBefore.length === 0
          appendBubble({ role: 'user', content: text, images: hasImages ? images : undefined })
          onUserMessage?.(text, isFirst)
          // aiEngineKey = さくらのAI Engine のキー（delegate_implementation / search_docs ツール用）。
          // B-1（2026-07-13）: AI Engine の月間予算が上限に達している場合はキーを渡さない＝
          // このターンは委譲ツール自体が無効化され、上限超過後も委譲経由でAI Engine課金が
          // 続いてしまうのを確実に止める（AI Engine直接経路の送信前チェックと同じ判定を使う）。
          let delegateKey: string | null = apiKey || null
          if (delegateKey && !checkBeforeRequest(delegateKey).allowed) {
            delegateKey = null
            appendBubble({
              role: 'assistant', toolNote: true,
              content: 'ℹ️ 今月のさくらのAI Engine利用額が上限に達しているため、このターンは作業の委譲をせず Claude のみで進めます（上限は ⚙️ 設定で変更できます）。',
            })
          }
          await sendViaClaude(text + assetBlock, images, claudeKey as string, snapshotId, toolsProjectDir, delegateKey)
          return
        }
        // 同意ダイアログをキャンセルした場合：AI Engineキーがあれば（モードA）従来どおり黙ってAI Engine経路へ
        // フォールバックする。無ければ（モードB）フォールバック先が無く空キーのまま送信してしまうため中断を伝える。
        const declineMsg = claudeConsentDeclinedGuidance(!!apiKey)
        if (declineMsg) { abortWithGuidance(declineMsg); return }
      }

      // プロジェクト未選択のままではClaudeのツール（ファイル操作等）が使えない。AI Engineキーが無ければ
      // （モードB）送信のしようがないため、黙って何もしないのではなくIDEモードへの案内を出す。
      const noProjectMsg = claudeNoProjectGuidance(!!toolsProjectDir, !!apiKey, claudeReady)
      if (noProjectMsg) { abortWithGuidance(noProjectMsg); return }

      if (!apiKey) return

      // AI Engine 経路の本体（利用上限チェック〜エージェントループ）は chatTurn.ts へ切り出した。
      // ここでは、そのターンの入力（spec）と外部への接点（ports）を組み立てて呼ぶだけにする。
      const spec: EngineTurnSpec = {
        rawText, images, assetBlock, apiKey, model, models, maxRounds, toolsProjectDir,
        errorPrefix, twoStageVision, routedModel, hasRag: !!buildRagBlock, turnOpts, snapshotId, snapshotLabel,
      }
      await runEngineTurn(spec, buildPorts())
    } finally {
      endActivity()
    }
  }, [
    isLoading, apiKey, model, models, maxRounds, buildSystemPrompt, toolsProjectDir,
    buildExecuteOpts, approveToolCall, getHistory, updateShown, onUserMessage, errorPrefix,
    twoStageVision, routedModel, appendBubble, buildRagBlock, sendViaClaude, emit,
  ])

  // #31: 「さくらのAI Engine に切り替えて続ける」提案ボタンのハンドラ。頭脳をさくらのAI Engineへ
  // 切り替え（setClaudeMode は localStorage を同期更新するため、直後の send() は AI Engine 経路になる。
  // 設定でいつでも Claude に戻せる）、同じ内容をそのまま送り直す。
  const switchToAiEngineAndResend = useCallback((text: string, images: string[]) => {
    setClaudeMode(false)
    void send(text, images)
  }, [send])

  return { isLoading, statusNote, stalled, elapsedSec, routedModel, setRoutedModel, send, abort, switchToAiEngineAndResend, compactNow }
}
