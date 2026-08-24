// AIチャットの送信パイプライン（ChatApp / ChatPanel 共通）。
// 予算チェック → visionモデル自動切替 → Web参照/検索の添付 → ストリーミング → エージェントループ
// （ツール実行・自己修復・モデル割り振り）までを1本のフックに集約する。
// 表示先（セッション内 / フラット配列）や承認フロー等の差分は引数のコールバックで吸収する。

import { useState, useRef, useEffect, useCallback } from 'react'
import { checkBeforeRequest, recordUsage, estimateTokens, isVisionModel, getDefaultVisionModel, modelLabel, pickBestModel } from '../usage'
import { shouldTryImagesDirectly, recordVisionSupport, isImageUnsupportedError } from '../visionSupport'
import { extractUrls, fetchPagesBlock, autoSearchBlock, wantsWebSearch } from '../webContext'
import { toolsFor, isToolUnsupportedError, executeTool, toolStatusLabel, getSearchConfig, formatChatError, formatClaudeError, condenseReasoning, hasTextToolMarkup, stripToolMarkup, unexecutedToolWarning, claimsFileChange, unexecutedChangeWarning, WRITING_TOOLS, isToolArgsComplete } from '../aiTools'
import { shouldSendTools, isKnownToolCapable, recordToolSupport } from '../toolSupport'
import { planSend, planCompact, planManualCompact, compactPrompt, acceptSummary, compactSource, type CompactMark, type CompactPlan } from '../historyCompact'
import { searchStatusContext } from '../aiContext'
import { getAnthropicToken } from '../components/CredentialsModal'
import { isClaudeModeEnabled, hasClaudeConsent, recordClaudeConsent, recordClaudeCost, claudeToolLabel, claudeCostFooter, getClaudeModel, claudeNoProjectGuidance, claudeConsentDeclinedGuidance, isClaudeUsageBlockedError, setClaudeMode } from '../claudeMode'
import { getClaudeSessionId, setClaudeSessionId } from '../claudeSession'
import { beginActivity } from '../activity'

/** まったく同じツール呼び出し（名前＋引数）がこの回数だけ連続したら暴走とみなして中断する。
 *  周回数の上限（maxRounds）を 5→25 に引き上げた代わりの歯止め（2026-07-23）。
 *  2 = 「同じ呼び出しが3回目に入ったら止める」（1回の再試行は正常な挙動として許容する）。 */
const REPEAT_LIMIT = 2

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

// APIへ送る1メッセージ（tool_calls / tool 結果を含む OpenAI 互換形）
type ApiMsg = { role: string; content: any; tool_calls?: any[]; tool_call_id?: string }

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

  // 末尾の吹き出し操作ヘルパー（関数型更新で表示先に依存しない）
  const appendBubble = useCallback((msg: ChatMessage) => updateShown(prev => [...prev, msg]), [updateShown])
  const replaceLast = useCallback((msg: ChatMessage) => updateShown(prev => {
    const next = [...prev]
    next[next.length - 1] = msg
    return next
  }), [updateShown])
  const removeLast = useCallback(() => updateShown(prev => prev.slice(0, -1)), [updateShown])

  /** まとめ作りの結果。手動で押したときは**理由も見せる**ので、失敗を文言で返す。 */
  type CompactOutcome = { msg: ChatMessage } | { error: string }

  /**
   * 決めた範囲を1件の「まとめ」に畳む（**元の会話は消さない**）。
   *
   * ── なぜ（2026-08-20 Ryosuke 指摘）────────────────────────────────
   * これまでは直近ぶんだけを送り、それより前は黙って捨てていた。
   * 長い相談ほど「さっき決めたこと」を忘れ、利用者からは物覚えを失ったように見える。
   *
   * ・**まとめは「いま選んでいるモデル」で作る**（利用者の知らない経路・料金を使わない）。
   * ・**黙ってやらない。** 会話に「🗂 ここまでの内容をまとめました」を残す。
   * ・**失敗しても送信は止めない。** まとめが無いだけで、従来どおり動く。
   */
  const runCompact = useCallback(async (history: ChatMessage[], plan: CompactPlan): Promise<CompactOutcome> => {
    if (!apiKey || !model) return { error: 'さくらのAI Engine のキーが登録されていないため、まとめを作れません。' }
    // 予算の上限に達しているときは作らない（まとめのために上限を超えない）。
    if (!checkBeforeRequest(apiKey).allowed) {
      return { error: '今月のさくらのAI Engine の利用額が上限に達しているため、まとめを作れません（上限は ⚙️ 設定で変えられます）。' }
    }
    // 材料には**書き込み・実行の実況も混ぜる**（どのファイルを変えたかは本文に残らない）。
    const { system, user } = compactPrompt(plan.base, compactSource(history, plan.from, plan.to))
    setStatusNote('🗂 これまでの内容をまとめています…')
    try {
      const res = await window.electronAPI.sakura.chat({
        apiKey,
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        // 推論型モデルは考えるだけで上限に達し、本文にたどり着けないことがある
        // （2026-08-20 実機: 2048 では思考の途中で打ち切られていた）。余裕を持たせる。
        maxTokens: 4096,
      })
      recordUsage(
        apiKey,
        model,
        res.usage?.prompt_tokens ?? estimateTokens(system + user),
        res.usage?.completion_tokens ?? estimateTokens(res.content ?? ''),
      )
      const text = acceptSummary(res.content ?? '')
      if (!text) return { error: `「${modelLabel(model)}」から空の返事が返ってきました。別のモデルでお試しください。` }
      return { msg: { role: 'assistant', content: text, summary: { upTo: plan.to, mark: plan.mark } } }
    } catch (e: any) {
      return { error: formatChatError(e?.message ?? String(e)) }
    } finally {
      setStatusNote('')
    }
  }, [apiKey, model])

  /** 送るものが予算を超えていたら、送信の前に自動で畳む。**自動の失敗は黙る**（利用者は
   *  そもそも「まとめが要る状態」を知らないため）。ただし**実際に送れなくなったときは1度だけ伝える**。 */
  const compactWarnedRef = useRef(false)
  const compactIfNeeded = useCallback(async (history: ChatMessage[]): Promise<ChatMessage | null> => {
    const plan = planCompact(history)
    if (!plan) return null
    const r = await runCompact(history, plan)
    if ('msg' in r) return r.msg
    // ここへ来た時点で、送る量は予算を超えている＝**古いやり取りの一部が送れていない**。
    // 黙って忘れられるより、やり直せる手があることを1度だけ伝える。
    if (!compactWarnedRef.current) {
      compactWarnedRef.current = true
      appendBubble({
        role: 'assistant', toolNote: true,
        content: `⚠️ ${r.error}
そのため、古いやり取りの一部はAIへ送れていません。上の【🗂 まとめる】でやり直せます。`,
      })
    }
    return null
  }, [runCompact, appendBubble])

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
    setIsLoading(true)
    try {
      const r = await runCompact(history, plan)
      if ('msg' in r) appendBubble(r.msg)
      else appendBubble({ role: 'assistant', toolNote: true, content: `⚠️ ${r.error}` })
    } finally {
      setIsLoading(false)
    }
  }, [isLoading, getHistory, runCompact, appendBubble])

  // Claude頭脳モード（C2a/C2b/C2d）: Agent SDK 経路での1ターン送信。SDK のストリームイベント
  // （session/text/tool/result/error/openPreview）をチャットの吹き出しへ反映する。
  // aiEngineKey は search_docs ツール用（C2b・方式B: 使う瞬間に読んで main へ引数で渡す。無ければ null）。
  // images は C2d: このターンでユーザーが添付した画像（data URL配列・空配列可）。main側 agent.ts が
  // 1枚以上ならストリーミング入力モードへ切り替え、Claude自身に直接読ませる（2段階visionを経由しない）。
  const sendViaClaude = useCallback(async (text: string, images: string[], claudeKey: string, snapshotId: string, projectDir: string, aiEngineKey: string | null) => {
    setIsLoading(true)
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
      setIsLoading(false)
      setStatusNote('')
    }
  }, [appendBubble, replaceLast, errorPrefix, buildExecuteOpts, apiKey, onExternalFilesChanged])

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

      // 利用上限チェック
      const budget = checkBeforeRequest(apiKey)
      if (!budget.allowed) {
        const userMsg: ChatMessage = { role: 'user', content: rawText.trim() }
        updateShown(prev => [...prev, userMsg, { role: 'assistant', content: `🛑 ${budget.message}` }])
        return
      }

      // 画像があり選択中モデルが画像非対応な場合の扱い：
      // - twoStageVision 有効時は「視覚モデルで読み取り→本来のモデルで実行」の2段階にする（ツールを使えるようにするため）。
      // - 無効時（従来）は、このターンだけvisionモデルに丸ごと切り替える。
      // ── まず今のモデルで試す（2026-08-19 Ryosuke 提案）────────────────────
      // 名前の一覧（isVisionModel）で決め打ちすると、**一覧に載っていない対応モデルは
      // 永久に二段構え**になり、1回分よけいに時間と費用がかかる。
      // ツール対応と同じで、**未確認は楽観的にそのまま渡し、結果から学習する**。
      // 既知で非対応のときだけ二段構えにする。
      const needsVisionHandoff = hasImages && !shouldTryImagesDirectly(model)
      const twoStage = needsVisionHandoff && twoStageVision
      let useModel = needsVisionHandoff && !twoStage ? getDefaultVisionModel() : model
      // B: この会話で既にツール作業へ割り振り済みなら、最初からツール対応モデルで実行（再試行を省く）
      if (!hasImages && routedModel && !shouldSendTools(model)) useModel = routedModel
      const switched = useModel !== model

      const text = rawText.trim() || (hasImages ? 'この画像について教えてください。' : '')
      const historyBefore = getHistory()
      const isFirst = historyBefore.length === 0
      const userMsg: ChatMessage = { role: 'user', content: text, images: hasImages ? images : undefined }
      appendBubble(userMsg)
      onUserMessage?.(text, isFirst)
      setIsLoading(true)

      // 会話が長くなっていたら、ここで古いぶんをまとめる（送信に使う履歴もこれに差し替える）。
      // 先にユーザーの吹き出しを出してから行うので、待っている間も「送れている」ことが分かる。
      let history = historyBefore
      const summaryMsg = await compactIfNeeded(historyBefore)
      if (summaryMsg) {
        appendBubble({ role: 'assistant', content: summaryMsg.content, summary: summaryMsg.summary })
        history = [...historyBefore, summaryMsg]
      }

      const systemPrompt = buildSystemPrompt()
      // 費用の見積りは「実際に送るもの」で行う（まとめたのに元の全文で数えると合わない）。
      // 送る履歴は1度だけ組み立てて使い回す（下のエージェントループでも同じものを使う）。
      const pastMessages = planSend(history)
      const inputText = systemPrompt + pastMessages.map(m => m.content).join('\n') + text + assetBlock

      try {
        const search = await getSearchConfig() // Web検索設定（未設定なら検索ツールは出さない）
        // ユーザーのメッセージにURLがあれば、IDEがページ本文を取得してこのターンだけAIに添付する
        const pagesBlock = await fetchPagesBlock(extractUrls(text))
        // 実際にIDEが検索するときだけ「🔍 Web検索中…」を出す（autoSearchBlock の起動条件と一致させる）
        const willSearch = !!search && extractUrls(text).length === 0 && wantsWebSearch(text)
        if (willSearch) setStatusNote('🔍 Web検索中…')
        const searchBlock = await autoSearchBlock(text, search)
        setStatusNote('')
        // 📚 資料の自動注入（設定されていれば）。searchBlock と同じ「取得中はstatusNoteを出す」パターン。
        if (buildRagBlock) setStatusNote('📚 資料を確認しています…')
        const ragBlock = buildRagBlock ? await buildRagBlock(text) : ''
        setStatusNote('')

        // 現在ターンの content（画像があればOpenAI互換のマルチモーダル配列）
        const apiText = text + assetBlock + pagesBlock + searchBlock + ragBlock
        let userContent: any = hasImages
          ? [
              ...(apiText ? [{ type: 'text', text: apiText }] : []),
              ...images.map(url => ({ type: 'image_url', image_url: { url } })),
            ]
          : apiText

        /**
         * 画像を「文章」にする（視覚モデルに読み取らせる）。
         *
         * 二段構えの1段目で使うほか、**ツールを扱えないモデルに当たって
         * 差し替えるとき**にも使う（2026-08-19）。画像をそのまま渡している
         * ターンは、文章にしてからでないと差し替えられない（画像が失われる）。
         *
         * @returns 読み取れた説明文。失敗・中断なら null
         */
        const readImagesAsText = async (): Promise<string | null> => {
          const visionModel = getDefaultVisionModel()
          setStatusNote('🖼 画像を読み取っています…')
          const visionMessages: ApiMsg[] = [
            { role: 'system', content: 'あなたは画像読み取り係です。添付画像の内容を客観的に詳しく説明してください（画面の構成要素、表示されている文言やエラーメッセージ、状態、気になる点）。修正案や次の行動の提案は書かないでください。' },
            {
              role: 'user',
              content: [
                ...(text ? [{ type: 'text', text }] : []),
                ...images.map(url => ({ type: 'image_url', image_url: { url } })),
              ],
            },
          ]
          let acc = ''
          const { usage: u, aborted } = await window.electronAPI.sakura.chatStream(
            { apiKey, model: visionModel, messages: visionMessages, maxTokens: 1024, tools: undefined },
            (delta) => { lastActivityRef.current = Date.now(); acc += delta },
            (abortFn) => { abortRef.current = abortFn },
            () => { lastActivityRef.current = Date.now() },
          )
          setStatusNote('')
          recordUsage(apiKey, visionModel, u?.prompt_tokens ?? estimateTokens(text), u?.completion_tokens ?? estimateTokens(acc))
          if (aborted || !acc.trim()) return null
          return acc
        }

        if (twoStage) {
          // 2段階visionハンドオフ：まず視覚モデルに画像だけ読み取らせ（ツール無し）、
          // その説明文を本来のモデル（ツール使用可）へのプレーンテキストとして渡す。
          const visionModel = getDefaultVisionModel()
          appendBubble({ role: 'assistant', content: `🖼 画像を「${modelLabel(visionModel)}」で読み取り、「${modelLabel(useModel)}」で実行します。`, toolNote: true })
          setStatusNote('🖼 画像を読み取っています…')
          const visionMessages: ApiMsg[] = [
            { role: 'system', content: 'あなたは画像読み取り係です。添付画像の内容を客観的に詳しく説明してください（画面の構成要素、表示されている文言やエラーメッセージ、状態、気になる点）。修正案や次の行動の提案は書かないでください。' },
            {
              role: 'user',
              content: [
                ...(text ? [{ type: 'text', text }] : []),
                ...images.map(url => ({ type: 'image_url', image_url: { url } })),
              ],
            },
          ]
          let descAcc = ''
          const { usage: visionUsage, aborted: visionAborted } = await window.electronAPI.sakura.chatStream(
            { apiKey, model: visionModel, messages: visionMessages, maxTokens: 1024, tools: undefined },
            (delta) => { lastActivityRef.current = Date.now(); descAcc += delta }, // 差分は表示しない（statusNoteのみ表示のまま）
            (abortFn) => { abortRef.current = abortFn },
            // 画像読み取り（2段階処理の1段目）は statusNote だけを見せる作りなので、思考は表示しない。
            // 停滞判定のリセットだけ行う（推論モデルが読み取り役のときに「止まった」と誤表示しないため）。
            () => { lastActivityRef.current = Date.now() },
          )
          setStatusNote('')
          recordUsage(
            apiKey,
            visionModel,
            visionUsage?.prompt_tokens ?? estimateTokens(text),
            visionUsage?.completion_tokens ?? estimateTokens(descAcc),
          )
          if (visionAborted) {
            replaceLast({ role: 'assistant', content: '（⏹ 停止しました）' })
            return
          }
          if (!descAcc.trim()) {
            replaceLast({ role: 'assistant', content: '（画像の読み取りに失敗しました。もう一度お試しください）' })
            return
          }
          userContent = apiText + '\n\n# 添付画像の内容（AIによる読み取り）\n' + descAcc
        } else if (switched) {
          // 自動切替をユーザーに知らせる（画面のみ・AIには送らない）
          appendBubble(hasImages
            ? { role: 'assistant', content: `🖼 画像があるため、このメッセージは「${modelLabel(useModel)}」で処理します。` }
            : { role: 'assistant', content: `🔀 ツール作業のため「${modelLabel(useModel)}」で実行します。`, toolNote: true })
        }

        // 1回分のストリーミングを実行して本文を返す（吹き出しを1つ追加して流し込む）
        const streamOnce = async (apiMessages: ApiMsg[], noTools = false): Promise<{ content: string; aborted?: boolean; toolCalls?: any[] | null; toolFailed?: boolean; hadToolMarkup?: boolean }> => {
          let acc = ''
          let thinkingAcc = '' // 推論モデルの思考（表示専用。APIにも履歴にも渡さない）
          appendBubble({ role: 'assistant', content: '' })
          const { usage, aborted, toolCalls, reasoningText } = await window.electronAPI.sakura.chatStream(
            // maxTokens=16384: 推論型モデル（Kimi 等）は推論でトークンを消費してから write_file の引数として
            // ファイル全文を吐くため、4096 だと引数JSONが途中で切れて 400 になっていた（2026-07-14）。
            // 上限を超えるモデルは main 側（sakura.ts）が context-limit を検出して自動で縮めて再試行する。
            { apiKey, model: useModel, messages: apiMessages, maxTokens: 16384, tools: (!noTools && shouldSendTools(useModel)) ? toolsFor(toolsProjectDir, !!search, !!buildRagBlock) : undefined },
            (delta) => {
              lastActivityRef.current = Date.now()
              acc += delta
              replaceLast({ role: 'assistant', content: acc, thinking: thinkingAcc || undefined })
            },
            (abortFn) => { abortRef.current = abortFn },
            (delta) => {
              // 思考も「進行中」の証拠なので停滞判定をリセットする（従来は本文の到着だけを見ていたため、
              // 思考中の推論モデルが「⏳ 時間がかかっています」と表示され、止まったように見えていた）。
              lastActivityRef.current = Date.now()
              thinkingAcc += delta
              replaceLast({ role: 'assistant', content: acc, thinking: thinkingAcc })
            },
          )
          if (aborted) {
            acc += '\n\n（⏹ 停止しました）'
            replaceLast({ role: 'assistant', content: acc, thinking: thinkingAcc || undefined })
          }
          // 失敗の兆候：本文もツール呼び出しも無い（reasoningフォールバックがaccを書き換える前に判定する）
          const toolFailed = !acc.trim() && !toolCalls?.length
          // 推論型モデル対策：本文が空でツール呼び出しも無い場合、reasoningに出た回答を本文として使う
          if (!acc.trim() && !toolCalls?.length && reasoningText?.trim()) {
            acc = condenseReasoning(reasoningText)
            replaceLast({ role: 'assistant', content: acc, thinking: thinkingAcc || undefined })
          }
          // テキスト形式のツール呼び出し（Kimi 等が本文に吐く特殊トークン）を除去して生マークアップを見せない
          const hadToolMarkup = hasTextToolMarkup(acc)
          if (hadToolMarkup) {
            acc = stripToolMarkup(acc)
            replaceLast({ role: 'assistant', content: acc, thinking: thinkingAcc || undefined })
          }
          // 利用量を記録（usageが無ければ文字数から見積り）
          recordUsage(
            apiKey,
            useModel,
            usage?.prompt_tokens ?? estimateTokens(inputText),
            usage?.completion_tokens ?? estimateTokens(acc),
          )
          return { content: acc, aborted, toolCalls, toolFailed, hadToolMarkup }
        }

        // エージェントループ：ツール呼び出しがあれば実行して結果を返し、続きを生成
        let apiMessages: ApiMsg[] = [
          { role: 'system', content: systemPrompt + searchStatusContext(!!search) },
          // 過去ターンはテキストのみで送る（画像は再送しない）。長くなった会話は、
          // 古いぶんが「まとめ」に畳まれた形で先頭に入る（historyCompact.ts）。
          ...pastMessages,
          { role: 'user', content: userContent },
        ]

        let retriedNoTools = false
      /** 画像を受け取れず、視覚モデルへ回したか（1回だけ）。 */
      let triedVisionFallback = false
        let routed = false
        let sawToolMarkup = false
        let usedTools = false // このターンで実際にツールを実行したか
        let wroteFiles = false // **ファイルを書き換えたか**（読み取りだけでは変わっていない）
        let askedToActuallyWrite = false // 「実際に変更して」と促したのは1回だけ
        // 暴走検出: まったく同じツール呼び出し（名前＋引数）が連続したら、周回数の上限を待たずに中断する。
        // 周回数の上限を引き上げた（5→25）ぶん、無意味なループを早く止める歯止めをここで持つ。
        let lastCallSig = ''
        let repeatCount = 0
        for (let round = 0; round <= maxRounds; round++) {
          let r
          try {
            r = await streamOnce(apiMessages)
          } catch (e: any) {
            // サーバがツール非対応で 400 を返す等 → ツールを外して1回だけ再試行（通常チャットとして応答させる）。
            // 400で判明した以上は既知の事実として記録し、次回以降このモデルへは無駄な400を出さない。
            if (shouldSendTools(useModel) && !retriedNoTools && isToolUnsupportedError(e?.message)) {
              recordToolSupport(useModel, false)
              retriedNoTools = true
              removeLast()
              r = await streamOnce(apiMessages, /* noTools */ true)
            } else if (hasImages && !triedVisionFallback && isImageUnsupportedError(e?.message)) {
              // ── 画像を受け付けなかった（2026-08-19）────────────────────────
              // **その事実を記録して、次回からは最初から二段構えにする。**
              // 混雑や通信の失敗は記録しない（isImageUnsupportedError が弾く）。
              // 今回は視覚モデルへ回して、利用者の手を止めない。
              recordVisionSupport(useModel, false)
              triedVisionFallback = true
              removeLast()
              const fallback = getDefaultVisionModel()
              appendBubble({
                role: 'assistant',
                content: `🖼 「${modelLabel(useModel)}」は画像を受け取れませんでした。`
                  + `「${modelLabel(fallback)}」で読み取ります（次からは最初からそうします）。`,
                toolNote: true,
              })
              useModel = fallback
              r = await streamOnce(apiMessages)
            } else {
              throw e
            }
          }
          if (r.aborted) break
          // 成功の記録：構造化ツール呼び出しが返った＝ツール対応の決定的証拠。次回以降は迷わず送る。
          if (r.toolCalls?.length) recordToolSupport(useModel, true)
          // 画像を渡して本文が返った＝**このモデルは画像を受け取れる**という証拠。
          // 次回からは二段構えを挟まない（2026-08-19）
          if (hasImages && !twoStage && !triedVisionFallback && r.content.trim()) recordVisionSupport(useModel, true)
          // 自己修復：ツールを送ったのに本文もツール呼び出しも無い（=ツール非対応/暴走の兆候）。
          // ツール無しで1回だけ再試行し、通常のテキスト応答を得る。
          // ここでは非対応と記録しない：本文もツール呼び出しも無いのは一時的な失敗（暴走・タイムアウト等）の
          // 可能性もあり、非対応と断定できないため（記録は400のような決定的な証拠があるときだけ行う）。
          if (shouldSendTools(useModel) && r.toolFailed && !retriedNoTools) {
            retriedNoTools = true
            removeLast()
            setStatusNote('応答をやり直しています…')
            r = await streamOnce(apiMessages, /* noTools */ true)
            setStatusNote('')
            if (r.aborted) break
          }
          if (r.hadToolMarkup) sawToolMarkup = true
          // モデル割り振り：テキスト形式のツールコールを吐いた＝構造化ツールを扱えない
          // → そのターンだけツール対応モデルに切り替え、正規の構造化ツールで実際に実行する。
          // 切替は必ず明示する（黙ってすり替えない）。画像ターンは vision 優先のため除外。
          // **構造化ツール呼び出しが1件でも返っていれば切り替えない**: そのモデルは実際に動いており、
          // 本文に混じったマークアップは stripToolMarkup で除去済みの見た目の問題にすぎない。
          // ここを分けないと、動いているモデルを「非対応」と誤って記録し、勝手に別モデルへ移してしまう。
          // ── 画像ターンでも切り替える（2026-08-19 実機・Ryosuke 報告）──────────
          // 「画像ターンは vision 優先」として除外していたが、**二段構えで画像が
          // 文章になっていれば、あとはただのテキスト依頼**であり、切り替えても
          // 画像は失われない。除外したままだと、ツールを扱えないモデルが
          // 「差し替えました」と書くだけで**ファイルは変わらない**（実機で発生）。
          // 画像をそのまま渡している（配列の）ターンだけは、切り替えると画像を
          // 落としてしまうので従来どおり見送る。
          let imageIsText = typeof userContent === 'string'
          // 画像をそのまま渡しているターンでも、**先に文章にしてから**差し替える
          //（2026-08-19 実機: Kimi は画像を直接読めるので二段構えにならず、
          //  ツールを扱えないまま「差し替えました」とだけ答えていた）
          if (r.hadToolMarkup && !r.toolCalls?.length && !routed && hasImages && !imageIsText) {
            const desc = await readImagesAsText()
            if (desc) {
              userContent = apiText + '\n\n# 添付画像の内容（AIによる読み取り）\n' + desc
              apiMessages[apiMessages.length - 1] = { role: 'user', content: userContent }
              imageIsText = true
            }
          }
          if (r.hadToolMarkup && !r.toolCalls?.length && !routed && (!hasImages || imageIsText)) {
            // ツールを送っていた（=構造化ツールを扱えないという決定的な証拠）場合だけ非対応を記録する。
            if (shouldSendTools(useModel)) recordToolSupport(useModel, false)
            const ids = models.map(m => m.id)
            const best = pickBestModel(ids)
            // 切替先は「既知で対応」を優先し、無ければ「既知で非対応ではない（未確認）」モデルを試す。
            // 直前に非対応と記録した useModel 自身と、既知で非対応のモデルは避ける。
            const capable = isKnownToolCapable(best)
              ? best
              : (ids.find(id => isKnownToolCapable(id))
                ?? ids.find(id => id !== useModel && shouldSendTools(id))
                ?? best)
            if (capable !== useModel) {
              routed = true
              useModel = capable
              setRoutedModel(capable) // B: この会話では以降もこのモデルで実行（再試行を省く）
              removeLast() // 試行の吹き出しを除去
              // 切替を明示（表示のみ・APIへは送らない）
              appendBubble({ role: 'assistant', content: `🔀 この作業にはツールが必要なため、「${modelLabel(capable)}」に切り替えて実行します。`, toolNote: true })
              continue // 同じ依頼(apiMessages)を、ツール対応モデル＋構造化ツールで正規ループ実行
            }
          }
          const tcs = r.toolCalls ?? []
          if (!tcs.length) {
            // 最終応答。空ならその旨を表示（空の吹き出しを残さない）
            if (!r.content.trim()) {
              replaceLast({ role: 'assistant', content: sawToolMarkup
                ? '（このモデルはツール（ファイル参照など）が必要な操作に対応していません。モデルを「Qwen3-Coder」などに切り替えてお試しください）'
                : '（応答が空でした。もう一度送るか、モデルを変えてお試しください）' })
            } else {
              // ── 「変えた」と言っているのに、書き込みが1度も走っていない ──────────
              // 2026-08-19 実機（Ryosuke）: 会話には「📄 ファイルを読んでいます」だけが出て、
              // 「✏️ 保存しています」は無いのに「✅ 反映しました」と答えていた。
              // 読み取りは正しく実行できているので**ツール非対応ではない**。
              // 言っただけである。まず**実際にやらせる**（1回だけ促す）。
              if (claimsFileChange(r.content) && !wroteFiles && !askedToActuallyWrite
                  && toolsProjectDir && shouldSendTools(useModel)) {
                askedToActuallyWrite = true
                removeLast() // 事実と違う報告は残さない
                appendBubble({ role: 'assistant', content: '⚠️ 変更が実行されていなかったので、やり直しています…', toolNote: true })
                apiMessages.push({ role: 'assistant', content: r.content })
                apiMessages.push({
                  role: 'user',
                  content: '（Koto より）いまの返事ではファイルは実際には変更されていません。'
                    + '説明や手順を書かず、write_file または edit_file を使って、いますぐ変更を実行してください。',
                })
                continue
              }
              // 促してもやらなかった場合は、**黙って成功に見せない**
              const warn = unexecutedChangeWarning(claimsFileChange(r.content), wroteFiles)
                ?? unexecutedToolWarning(sawToolMarkup, usedTools)
              if (warn) replaceLast({ role: 'assistant', content: `${r.content}\n\n${warn}` })
            }
            break
          }
          usedTools = true
          // ツール引数のJSONが途中で切れていないか検証する。推論型モデルが write_file の引数として
          // 大きなファイル内容を吐く途中で出力上限に達すると引数が未終端になり、これをそのまま実行/送り返すと
          // サーバーが「400 Unterminated string」で失敗する（2026-07-14 Kimi K2.6 で発生）。事前に検出して中断する。
          if (tcs.some(tc => !isToolArgsComplete(tc.function?.arguments))) {
            replaceLast({
              role: 'assistant',
              content: (r.content ? r.content + '\n\n' : '') +
                '⚠️ ファイルの内容が大きすぎて、AIの一度の出力に収まりませんでした。\n' +
                '・変更を小さめに分けて依頼する（例: 「まず○○の部分だけ直して」）\n' +
                '・別のモデル（Qwen3-Coder など）に切り替えて試す\n' +
                'のいずれかをお試しください。',
            })
            break
          }
          const note = tcs.map(tc => toolStatusLabel(tc.function?.name ?? '', tc.function?.arguments ?? '')).join('\n')
          // 暴走検出: 同じツールを同じ引数で REPEAT_LIMIT 回連続で呼んだら中断する
          // （周回数の上限まで無駄に回して費用と時間を使うのを防ぐ）。
          const sig = JSON.stringify(tcs.map(tc => [tc.function?.name ?? '', tc.function?.arguments ?? '']))
          repeatCount = sig === lastCallSig ? repeatCount + 1 : 0
          lastCallSig = sig
          if (repeatCount >= REPEAT_LIMIT) {
            replaceLast({
              role: 'assistant',
              content: (r.content ? r.content + '\n\n' : '') +
                '⚠️ AIが同じ操作を繰り返しているため中断しました。\n' +
                '・依頼をもう少し具体的に伝える\n' +
                '・別のモデル（Qwen3-Coder など）に切り替える\n' +
                'のいずれかをお試しください。',
            })
            break
          }
          if (round === maxRounds) {
            // ツール実行の上限に達した。空の吹き出しを残さず理由を表示し、ワンクリックで続けられるようにする
            replaceLast({
              role: 'assistant',
              content: (r.content ? r.content + '\n\n' : '') + '（作業が長くなったのでいったん区切りました。続きから再開できます）',
              offerContinue: true,
            })
            break
          }
          // 本文が空（ツール呼び出しのみ）の吹き出しは、実行状況の表示に置き換える
          replaceLast({ role: 'assistant', content: r.content ? r.content + '\n\n' + note : note, toolNote: true })
          apiMessages = [...apiMessages, { role: 'assistant', content: r.content ?? '', tool_calls: tcs }]
          for (const tc of tcs) {
            const toolName = tc.function?.name ?? ''
            const toolArgs = tc.function?.arguments ?? ''
            // 実行前の承認フック（ChatPanel の write_file/run_command 確認UIなど）。
            // 文字列が返ったら実行せず、その文字列をツール結果としてAIへ返す。
            if (approveToolCall) {
              const denial = await approveToolCall(toolName, toolArgs, turnOpts as { projectDir?: string | null; writeRoot?: string | null })
              if (denial !== null) {
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: denial })
                continue
              }
            }
            const result = await executeTool(toolName, toolArgs, { ...turnOpts, search, snapshotId, snapshotLabel })
            if ((WRITING_TOOLS as readonly string[]).includes(toolName)) wroteFiles = true
            apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result })
          }
          if (!checkBeforeRequest(apiKey).allowed) break // 上限到達時はループを止める
        }
      } catch (err: any) {
        appendBubble({ role: 'assistant', content: errorPrefix + formatChatError(err?.message ?? String(err)) })
      } finally {
        abortRef.current = null
        setIsLoading(false)
        setStatusNote('')
      }
    } finally {
      endActivity()
    }
  }, [
    isLoading, apiKey, model, models, maxRounds, buildSystemPrompt, toolsProjectDir,
    buildExecuteOpts, approveToolCall, getHistory, updateShown, onUserMessage, errorPrefix,
    routedModel, appendBubble, replaceLast, removeLast, buildRagBlock, sendViaClaude,
    compactIfNeeded,
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
