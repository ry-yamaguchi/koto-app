import React, { useState, useRef, useEffect, useCallback } from 'react'
import type { OpenFile } from '../App'
import SakuraLogo from './SakuraLogo'
import AiMessage from './AiMessage'
import ThinkingBlock from './ThinkingBlock'
import { checkBeforeRequest, recordUsage, estimateTokens, getDefaultModel, setDefaultModel, isVisionModel, getDefaultVisionModel, modelLabel, pickBestModel } from '../usage'
import { useModels } from '../hooks/useModels'
import { useClaudeModels } from '../hooks/useClaudeModels'
import { useAiChat, type ChatMessage } from '../hooks/useAiChat'
import { IDE_CONTEXT, buildProjectContext, ragStatusContext } from '../aiContext'
import { getTargetProfile, shouldAutoCheckTarget } from '../targetProfiles'
import { fileToDataUrl, countNonImageFiles } from '../imageInput'
import { requiresConfirmation, confirmReason, formatChatError } from '../aiTools'
import { parseRagSettings, autoRagBlock, buildRagBlockText, type RagSettings } from '../ragContext'
import { buildPublishStatusRows, parseApprunLegacy, formatPublishedAt, isStale } from '../publishStatus'
import ModelSelect from './ModelSelect'
import BrainToggle from './BrainToggle'
import { getAnthropicToken } from './CredentialsModal'
import { isClaudeModeEnabled, getClaudeModel, setClaudeModel, claudeModelShortLabel, CHAT_NO_KEY_MESSAGE, CHAT_NO_KEY_HINT, isChatUsable } from '../claudeMode'
import { loadProjectChat, saveProjectChat } from '../chatStorage'
import { takeNewProjectRequest } from '../newProjectRequest'

type Message = ChatMessage

// AIによるファイル保存の権限モード（'auto'=おまかせで自動保存 / 'confirm'=毎回確認）
const WRITE_MODE_KEY = 'sakura_write_mode'
type WriteMode = 'auto' | 'confirm'
const getWriteMode = (): WriteMode => (localStorage.getItem(WRITE_MODE_KEY) === 'confirm' ? 'confirm' : 'auto')

// メッセージのコピーボタン。押すと1.5秒だけ ✓ を出して、コピーできたことを伝える
function MessageCopyButton({ text, side }: { text: string; side: 'left' | 'right' }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      title={copied ? 'コピーしました' : 'このメッセージをコピー'}
      className={`absolute -top-2 ${side === 'left' ? '-left-2' : '-right-2'} opacity-0 group-hover:opacity-100 transition-opacity bg-elevated border border-line rounded-full w-6 h-6 flex items-center justify-center text-[11px] shadow-sm ${copied ? 'text-brand-green' : 'text-ink-muted hover:text-sakura'}`}
    >{copied ? '✓' : '📋'}</button>
  )
}

interface Props {
  apiKey: string
  onSetApiKey: (key: string) => void
  onOpenCredentials: () => void
  onApplyFile?: (relPath: string, content: string) => Promise<void>
  /** Claudeモードの書き込み後、該当タブをディスクから読み直す（App.tsx の applyRestoreResult 相当。
   *  stale tab のオートセーブ上書きによるデータ喪失防止・2026-07-11） */
  onExternalFilesChanged?: (relPaths: string[]) => void
  activeFile: OpenFile | null
  projectDir?: string | null
}


export default function ChatPanel({ apiKey, onSetApiKey, onOpenCredentials, onApplyFile, onExternalFilesChanged, activeFile, projectDir }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  // あいさつ（greet）専用のローディング／中断。送信パイプラインの状態は useAiChat が持つ。
  const [greetLoading, setGreetLoading] = useState(false)
  const greetAbortRef = useRef<(() => void) | null>(null)
  const [model, setModel] = useState(getDefaultModel('ide'))
  // どのプロジェクトの文脈かを dir 付きで保持する。
  // （dir を持たないと、プロジェクト切替直後に「前のプロジェクトの文脈」であいさつしてしまう）
  const [projectCtx, setProjectCtx] = useState<{ dir: string; ctx: string } | null>(null)
  // 📚 資料設定（.sakuraide.json の rag キー）。プロジェクト切替や KnowledgeModal での保存後に読み直す。
  const [ragSettings, setRagSettings] = useState<RagSettings | null>(null)
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [writeMode, setWriteMode] = useState<WriteMode>(getWriteMode())
  // 「毎回確認」モードで保存待ちのファイル。resolve(true)=許可 / resolve(false)=拒否
  const [pendingApproval, setPendingApproval] = useState<{ path: string; resolve: (ok: boolean) => void } | null>(null)
  const models = useModels(apiKey)

  // C2c: チャットの頭脳が Claude か（StatusBar.tsx と同じ判定方式）。Claudeのときは
  // ModelSelect の選択肢を AI Engine のモデル一覧から Claudeモデル一覧（ライブ取得。useClaudeModels）へ切り替える。
  const [claudeActive, setClaudeActive] = useState(false)
  const [claudeKey, setClaudeKey] = useState('')
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      const key = await getAnthropicToken()
      if (!alive) return
      setClaudeActive(!!key && isClaudeModeEnabled())
      setClaudeKey(key ?? '')
    }
    refresh()
    window.addEventListener('sakura:credentials-changed', refresh)
    return () => { alive = false; window.removeEventListener('sakura:credentials-changed', refresh) }
  }, [])
  const claudeModels = useClaudeModels(claudeKey)
  const [claudeModelId, setClaudeModelId] = useState(() => getClaudeModel())

  // Claude側も同様: ライブ取得した一覧に選択中のモデルが無ければ（提供終了・ID改廃）自動で切り替える。
  // 送信時は useAiChat が getClaudeModel()（＝更新後のキャッシュを見る）で自己修復するため実害は出ないが、
  // これが無いと**画面に出ているモデル名と実際に使われるモデルが食い違う**（選択欄だけ古いまま残る）。
  useEffect(() => {
    if (!claudeModels.length) return
    if (claudeModels.some(m => m.id === claudeModelId)) return
    const next = getClaudeModel(claudeModels)
    setClaudeModel(next)
    setClaudeModelId(next)
    if (claudeActive) {
      setMessages(prev => [...prev, { role: 'assistant', content: `ℹ️ モデル「${claudeModelId}」は提供終了したため、「${claudeModelShortLabel(next, claudeModels)}」に自動で切り替えました。` }])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeModels])

  // 選択中のモデルが提供終了していたら、提供中の最適なモデルへ自動で切り替える
  useEffect(() => {
    if (!models.length) return
    if (!models.some(m => m.id === model)) {
      const next = pickBestModel(models.map(m => m.id))
      setModel(next)
      setMessages(prev => [...prev, { role: 'assistant', content: `ℹ️ モデル「${model}」は提供終了したため、「${modelLabel(next)}」に自動で切り替えました。` }])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models])

  const toggleWriteMode = () => {
    setWriteMode(prev => {
      const next: WriteMode = prev === 'auto' ? 'confirm' : 'auto'
      localStorage.setItem(WRITE_MODE_KEY, next)
      return next
    })
  }
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const greetedRef = useRef<string>('')
  // 新規プロジェクト作成の依頼（sakura-new-project-request）: イベントが projectDir の切替より
  // 先に届くことがあるため、いったんここに保留してから dir が一致した時点で送る。
  const pendingNewProjectRef = useRef<{ dir: string; prompt: string } | null>(null)
  const sentNewProjectDirRef = useRef<string | null>(null) // 同一dirでの二重送信防止

  // 画像を取り込む（縮小してdata URL化し、添付候補に追加）
  const addImages = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files)
    // 所見19: 画像以外のファイルが混じっていたら、黙って捨てずに toolNote バブルで案内する
    //（fileToDataUrl は非画像を null で捨てるため、この案内が無いとドロップしても無反応に見えた）。
    if (countNonImageFiles(list) > 0) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '📎 画像ファイル（PNG/JPEGなど）のみ添付できます。それ以外のファイルは取り込みませんでした。',
        toolNote: true,
      }])
    }
    for (const f of list) {
      const url = await fileToDataUrl(f)
      if (url) setPendingImages(prev => [...prev, url])
    }
  }, [])

  // projectCtx は state（再描画・greet発火用）と ref（送信時の即時参照用）の両方で持つ。
  // setState は非同期のため、「文脈を読み直した直後に send する」流れ（公開先切替の自動診断）では
  // ref を同期更新しておかないと旧公開先のプロファイルでシステムプロンプトが組まれてしまう。
  const projectCtxRef = useRef<{ dir: string; ctx: string } | null>(null)
  const applyProjectCtx = useCallback((v: { dir: string; ctx: string } | null) => {
    projectCtxRef.current = v
    setProjectCtx(v)
  }, [])

  // プロジェクトの文脈（名前・概要・公開先・ファイル構成）を準備
  useEffect(() => {
    let cancelled = false
    applyProjectCtx(null) // 切替中は古い文脈を使わせない
    if (!projectDir) return
    buildProjectContext(projectDir).then(ctx => {
      if (!cancelled) applyProjectCtx({ dir: projectDir, ctx })
    })
    return () => { cancelled = true }
  }, [projectDir, applyProjectCtx])

  // 公開先の変更（sakura-meta-changed）でも文脈を読み直す。
  // ※ 上のeffectは projectDir のみに依存するため、同じプロジェクト内で target だけ変わったときは
  //   これが無いと projectCtx（公開先プロファイル注入済み）が古いままになってしまう。
  useEffect(() => {
    const h = () => {
      if (!projectDir) return
      buildProjectContext(projectDir).then(ctx => applyProjectCtx({ dir: projectDir, ctx }))
    }
    window.addEventListener('sakura-meta-changed', h)
    return () => window.removeEventListener('sakura-meta-changed', h)
  }, [projectDir, applyProjectCtx])

  // 📚 資料設定（.sakuraide.json の rag キー）。プロジェクト切替時、および KnowledgeModal での保存後
  // （sakura-meta-changed イベント。changeTarget 等と同じ仕組み）に読み直す。送信のたびに読む必要はない
  // （このイベント経由で常に最新を保てるため）。
  const reloadRagSettings = useCallback(async (dir: string | null | undefined) => {
    if (!dir) { setRagSettings(null); return }
    try {
      const raw = await window.electronAPI.fs.readFile(`${dir}/.sakuraide.json`)
      setRagSettings(parseRagSettings(JSON.parse(raw)))
    } catch { setRagSettings(null) }
  }, [])
  useEffect(() => { reloadRagSettings(projectDir) }, [projectDir, reloadRagSettings])
  useEffect(() => {
    const h = () => reloadRagSettings(projectDir)
    window.addEventListener('sakura-meta-changed', h)
    return () => window.removeEventListener('sakura-meta-changed', h)
  }, [projectDir, reloadRagSettings])

  // 現在のプロジェクトに対応する文脈だけを返す（不一致＝読み込み中は空）。
  // ref から読む＝send() 直前に applyProjectCtx した内容が再描画を待たずに反映される
  const ctxFor = (dir: string | null | undefined): string => {
    const cur = projectCtxRef.current
    return cur && dir && cur.dir === dir ? cur.ctx : ''
  }

  // 📚 資料をこのプロジェクトのチャットで使うか（設定が有効 かつ APIキーあり）
  const ragEnabled = !!ragSettings?.enabled && !!apiKey

  // 送信パイプライン（予算・切替・検索・ツールループ・自己修復・モデル割り振り）は共通フックへ集約。
  // 表示はフラットな messages 配列へ反映する。
  const chat = useAiChat({
    apiKey,
    model,
    models,
    // 25: ファイルを数個読んで直して確認する、という普通の作業でも 5 では即座に使い切っていたため
    // 引き上げた（ユーザー報告 2026-07-23）。暴走は同一ツール連続検出・停止ボタン・月間予算で防ぐ。
    maxRounds: 25,
    buildSystemPrompt: () => {
      const openFileBlock = activeFile
        ? `\n\n# 開いているファイル: ${activeFile.name} (${activeFile.language})\n\`\`\`${activeFile.language}\n${activeFile.content.slice(0, 4000)}\n\`\`\``
        : ''
      const ctx = ctxFor(projectDir)
      return IDE_CONTEXT + (ctx ? '\n\n' + ctx : '') + openFileBlock + ragStatusContext(ragEnabled)
    },
    toolsProjectDir: projectDir ?? null,
    onExternalFilesChanged,
    buildExecuteOpts: () => ({
      projectDir,
      applyFile: onApplyFile,
      // 📚 資料検索ツール（search_docs）の実体。rag:query を呼び、出典付きブロックに整形して返す。
      ragSearch: ragEnabled ? async (query: string) => {
        const r = await window.electronAPI.rag.query(apiKey, {
          query: query.slice(0, 1000),
          tags: ragSettings!.tags.length ? ragSettings!.tags : undefined,
          topK: 3,
        })
        if (!r.ok) return ''
        return buildRagBlockText(r.hits ?? [])
      } : undefined,
    }),
    // 📚 資料の自動注入（IDE主導）。無効時は未指定にし、useAiChat の従来動作（注入なし）を維持する。
    buildRagBlock: ragEnabled ? (text: string) => autoRagBlock(text, apiKey, ragSettings) : undefined,
    approveToolCall: async (toolName, toolArgs) => {
      // 「毎回確認」モードでは、ファイル保存（全文上書き／部分編集）の前にユーザーの許可を取る
      // （localStorageから都度読む＝会話の途中でモードを切り替えても即反映）。
      // edit_file も write_file と同じくファイルを書き換える破壊的操作のため、同じ扱いにする。
      if ((toolName === 'write_file' || toolName === 'edit_file') && getWriteMode() === 'confirm') {
        let relPath = ''
        try { relPath = JSON.parse(toolArgs || '{}').path ?? '' } catch { /* パス不明でも確認は出す */ }
        const isEdit = toolName === 'edit_file'
        const label = `${relPath || '(不明なファイル)'}${isEdit ? '（部分編集）' : ''}`
        const approved = await new Promise<boolean>(resolve => setPendingApproval({ path: label, resolve }))
        setPendingApproval(null)
        if (!approved) {
          const action = isEdit ? '編集' : '保存'
          return `ユーザーが ${relPath || 'このファイル'} の${action}を許可しませんでした。${action}せずに、どう進めるべきかユーザーに確認してください。`
        }
      }
      // コマンド実行：危険なコマンドは常に、また「毎回確認」モードでは全コマンドで許可を取る
      if (toolName === 'run_command') {
        let cmd = ''
        try { cmd = JSON.parse(toolArgs || '{}').command ?? '' } catch { /* 不明でも確認は出す */ }
        if (getWriteMode() === 'confirm' || requiresConfirmation(cmd)) {
          const reason = requiresConfirmation(cmd) ? `\n理由: ${confirmReason(cmd)}` : ''
          const approved = await new Promise<boolean>(resolve => setPendingApproval({ path: `コマンド実行: ${cmd || '(不明)'}${reason}`, resolve }))
          setPendingApproval(null)
          if (!approved) {
            return `ユーザーがコマンド「${cmd}」の実行を許可しませんでした。実行せずに、どう進めるべきかユーザーに確認してください。`
          }
        }
      }
      return null // 許可（または確認不要）
    },
    getHistory: () => messages,
    updateShown: (updater) => setMessages(prev => updater(prev)),
    twoStageVision: true,
  })
  const { statusNote, stalled, elapsedSec, setRoutedModel } = chat
  // 表示上のローディングは、あいさつ生成中と送信中の両方を含める
  const isLoading = chat.isLoading || greetLoading

  // プロジェクトごとに会話を読み込む（remount/再起動でも継続）。
  // 保存先は `<project>/.sakuraide/chat.json`（旧 localStorage 形式が残っていれば読み込み時に移行する）。
  // loadedChatDirRef: 現在 messages に反映済みのプロジェクト（読み込み完了前の誤保存を防ぐガード）。
  const loadedChatDirRef = useRef<string | null>(null)
  // messagesRef: 直近の messages を常に最新に保つ（デバウンス/アンマウント時のフラッシュで使う）。
  const messagesRef = useRef<Message[]>(messages)
  messagesRef.current = messages

  useEffect(() => {
    let cancelled = false
    setRoutedModel(null) // 会話（プロジェクト）が変わったら割り振りをリセット
    loadedChatDirRef.current = null // 読み込み完了までは保存させない
    if (!projectDir) { setMessages([]); return }
    loadProjectChat(projectDir).then(msgs => {
      if (cancelled) return
      setMessages(msgs)
      loadedChatDirRef.current = projectDir
    })
    return () => { cancelled = true }
  }, [projectDir])

  // 会話を保存（デバウンス1.5秒。ストリーミング中は messages がトークン毎に変わるため）。
  // 読み込みが完了したプロジェクトについてのみ保存する（切替直後の空配列で上書きしないため）。
  useEffect(() => {
    if (!projectDir || loadedChatDirRef.current !== projectDir) return
    const id = window.setTimeout(() => {
      void saveProjectChat(projectDir, messagesRef.current)
    }, 1500)
    return () => window.clearTimeout(id)
  }, [messages, projectDir])

  // アンマウント・プロジェクト切替時に保存待ちの内容を即座にフラッシュする
  useEffect(() => {
    return () => {
      if (projectDir && loadedChatDirRef.current === projectDir) {
        void saveProjectChat(projectDir, messagesRef.current)
      }
    }
  }, [projectDir])

  // 新規プロジェクト作成（NewProjectModal.tsx）からの依頼をチャットへ流し込む。
  // sakura-target-changed ハンドラ（下）と同じ作法: buildProjectContext を読み直してから
  // chat.send() で送ることで、自動送信でもユーザーが打ったのと同じ扱いでチャット欄に見えるようにする
  // （透明性。設計意図はモーダルで待たない・失敗しても「やり直して」と言える・出力上限で切れない・
  // ツール非対応モデルの自動切替が効く・雛形生成の経路が1本になる、の5点。詳細は newProjectRequest.ts）。
  //
  // NewProjectModal 側は onCreated（App.tsx が setCurrentDir する）の直後にこのイベントを dispatch するため、
  // このパネルの projectDir がまだ旧プロジェクトのまま（Reactの再描画が追いついていない）状態で届くことがある。
  // そのため detail.dir を pendingNewProjectRef に保留し、projectDir が一致するまで送らない
  // （このeffect自体が projectDir の変化のたびに再評価する）。さらに「初めてのプロジェクト作成」では
  // dispatch の瞬間まだ ChatPanel 自体がマウントされておらず（IDEモード表示は mode==='ide' && currentDir
  // が条件のため）イベントの受け手が存在しない＝取りこぼす。newProjectRequest.ts のモジュール退避
  // （takeNewProjectRequest）でこのケースも拾い直す（下の consume 内）。
  //
  // greet() との衝突防止: この effect は greet を発火させる effect（すぐ下）より前で定義しているため、
  // 同一コミット内では常にこちらが先に実行される（Reactはコンポーネント内のeffectを宣言順に実行する）。
  // 依頼を送ると決めた時点で greetedRef.current を同期的に埋めるので、直後に評価される greet 側の
  // 効果は「あいさつ済み」とみなして何もしない＝あいさつと依頼が二重に走ることはない。
  useEffect(() => {
    const consume = () => {
      if (!projectDir || sentNewProjectDirRef.current === projectDir) return
      // データの出どころは2つ: ①イベントで直接受け取り済みのもの（pendingNewProjectRef）
      // ②イベントを取りこぼした場合の救済（newProjectRequest.ts のモジュール退避。「初めてのプロジェクト
      //   作成」では ChatPanel がまだマウントされておらずイベントの受け手が無いため、これが唯一の頼り）。
      const prompt = pendingNewProjectRef.current?.dir === projectDir
        ? pendingNewProjectRef.current.prompt
        : takeNewProjectRequest(projectDir)
      if (!prompt) return
      // キーが無ければ送らない（NewProjectModal 側は必ずキーがある場合にだけ依頼するが、claudeActive は
      // キー確認が非同期のため、判定が追いつくまでは ref に保留し直して次の再評価（deps変化）を待つ）。
      if (!isChatUsable(!!apiKey, claudeActive)) { pendingNewProjectRef.current = { dir: projectDir, prompt }; return }
      sentNewProjectDirRef.current = projectDir
      pendingNewProjectRef.current = null
      greetedRef.current = projectDir // greet() を抑止（この依頼だけを送る。上のコメント参照）
      void (async () => {
        const ctx = await buildProjectContext(projectDir)
        applyProjectCtx({ dir: projectDir, ctx }) // ref も同期更新→直後の send が最新の文脈で組まれる
        void chat.send(prompt, [])
      })()
    }
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent).detail as { dir?: string; prompt?: string } | undefined
      if (!detail?.dir || !detail.prompt) return
      pendingNewProjectRef.current = { dir: detail.dir, prompt: detail.prompt }
      consume()
    }
    window.addEventListener('sakura-new-project-request', onRequest)
    consume() // projectDir がこの再描画で追いついた場合、またはイベントを取りこぼしていた場合に備える
    return () => window.removeEventListener('sakura-new-project-request', onRequest)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, claudeActive, projectDir, chat])

  // プロジェクトを開いたら、AI側から最初のあいさつ（要約＋次にやることの質問）を返す
  // ※ projectCtx.dir の一致を必ず確認する（古いプロジェクトの文脈であいさつしないため）
  // apiKeyが無くても claudeActive（モードB）なら固定のあいさつ文だけ出す（greet()内で分岐、APIは呼ばない）。
  useEffect(() => {
    if (!isChatUsable(!!apiKey, claudeActive) || !projectDir || !projectCtx || projectCtx.dir !== projectDir) return
    if (messages.length > 0 || isLoading) return
    if (greetedRef.current === projectDir) return
    greetedRef.current = projectDir
    void greet()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, claudeActive, projectDir, projectCtx, messages.length])

  useEffect(() => {
    // scrollIntoView は祖先（文書全体）まで横スクロールさせることがあり、コンテンツが窓幅を超えていると
    // アプリ全体が横にずれて「左端に前の画面の切れ端が残る」原因になった（2026-07-14 ユーザー報告）。
    // メッセージ一覧コンテナの内側だけを縦スクロールする。
    const sc = bottomRef.current?.parentElement
    if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' })
  }, [messages, isLoading])

  // ワークフローバー「① 作る」から入力欄へフォーカス
  useEffect(() => {
    const h = () => textareaRef.current?.focus()
    window.addEventListener('sakura:focus-chat', h)
    return () => window.removeEventListener('sakura:focus-chat', h)
  }, [])

  // 公開先が変更された直後に自動診断した target（重複発火・多重送信の防止用）
  const lastCheckedTargetRef = useRef<string | null>(null)

  // 公開先が変更されたら、条件を満たす場合はAIへ「この公開先でそのまま動くか」の診断を自動依頼する
  // （ユーザーが打ったのと同じ扱いでチャット欄に見える＝透明性を保つ）。
  // 条件を満たさない場合（local/other・APIキー未登録・プロジェクト未選択・実行中・同一targetの重複発火）は、
  // 従来どおりの軽い案内バブルのみを出す。
  useEffect(() => {
    const h = async (e: Event) => {
      const target = (e as CustomEvent).detail?.target as string | undefined
      const label = getTargetProfile(target).label
      const autoCheck = shouldAutoCheckTarget({
        target,
        apiKey,
        projectDir,
        isLoading,
        lastCheckedTarget: lastCheckedTargetRef.current,
      })
      if (!autoCheck) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `ℹ️ システムからのお知らせ：公開先を「${label}」に変更しました。今のコードがこの環境で動くか、次のメッセージでAIに確認してもらえます。環境によっては作り直しが必要な場合があります。`,
        }])
        return
      }
      lastCheckedTargetRef.current = target as string
      // buildProjectContext（公開先プロファイル注入済み）を読み直してから送る。
      // ※ projectDir 依存の effect による projectCtx 更新を待たず、ここで直接読み直すことで
      //   診断メッセージの時点で確実に新しい公開先の前提がシステムプロンプトに入るようにする。
      if (projectDir) {
        const ctx = await buildProjectContext(projectDir)
        applyProjectCtx({ dir: projectDir, ctx }) // ref も同期更新→直後の send が新プロファイルで組まれる
      }
      // 切替先に公開実績があるなら答えは既に分かっている（現に動いている）ので、AIに聞かず決定的に案内する。
      // ここでAIに「動くか」を質問すると、事実と矛盾する ⚠️ を出す余地が残るため（LLMの保守的判断）、
      // AI診断は「実績が無い＝本当に答えが未知」の公開先に切り替えたときだけ行う。
      // AppRun は publish.targets 導入前の構築でも .sakura-cloud/state.json から実績を救済する。
      if (projectDir) {
        let meta: any = null
        try { meta = JSON.parse(await window.electronAPI.fs.readFile(`${projectDir}/.sakuraide.json`)) } catch { /* メタ無し */ }
        let apprunLegacy: { createdAt: string | null } | null = null
        try {
          apprunLegacy = parseApprunLegacy(JSON.parse(await window.electronAPI.fs.readFile(`${projectDir}/.sakura-cloud/state.json`)))
        } catch { /* state 無し＝AppRun未構築 */ }
        const row = buildPublishStatusRows(meta?.publish, { apprunLegacy }).find(r => r.target === target)
        if (row) {
          const when = row.dateUnknown ? '' : (formatPublishedAt(row.publishedAt) ?? '')
          // 公開後にコードが変わっていれば一言添える（判定は latestChangeAt との比較）
          let staleNote = ''
          try {
            const r = await window.electronAPI.fs.latestChangeAt(projectDir)
            if (r.ok && !row.dateUnknown && isStale(row.publishedAt, r.latest)) {
              staleNote = '\n※ 公開後にコードが変更されています。心配な場合は「この公開先で動くか確認して」と聞いてください。'
            }
          } catch { /* 判定不能なら注記なし */ }
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: `✅ 公開先を「${label}」に変更しました。この公開先には公開済みの実績があります${when ? `（${when} 公開）` : ''}。今のコードのままで再公開できます（③公開から）。${staleNote}`,
          }])
          return
        }
      }
      const prompt =
        `公開先を「${label}」に変更しました。いま開いているプロジェクトのコードがこの公開先でそのまま動くか確認してください。` +
        'まず list_files で構成を見て、必要なファイルだけ read_file で読み、結論を先に一言で述べてください: ' +
        '「✅ そのまま動きます」／「✅ そのまま動きます（任意の改善あり）」／「⚠️ このままでは動きません」。' +
        '⚠️ は動かない確実な根拠（必須ファイルの欠落・この環境が対応しない言語など）がある場合だけにし、' +
        '動くけれど理想形でない点は「任意の改善」として1〜2行で簡潔に添えるだけにしてください。' +
        '公開先プロファイルの「推奨」事項（ポートの受け方・ヘルスチェックの有無など）や、公開時の設定で吸収できる事柄は「動かない根拠」にしないでください。' +
        '対応が必要な場合は、既存ファイルの書き換えではなく不足ファイルの追加を優先した最小の提案をし、私の承認を待ってから実行してください。'
      void chat.send(prompt, [])
    }
    window.addEventListener('sakura-target-changed', h)
    return () => window.removeEventListener('sakura-target-changed', h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, projectDir, isLoading, chat])

  // AIからの最初のあいさつ
  const greet = async () => {
    // AI Engineキーが無い（モードB＝Claudeのみ）場合は、greetのためだけにAPIを呼ばず固定文を出す。
    // Claude自身へのあいさつ生成委譲はしない（greetはAI Engineクライアント専用の従来経路のため）。
    if (!apiKey) {
      setMessages([{ role: 'assistant', content: 'こんにちは！つくりたいものを日本語で教えてください。' }])
      return
    }
    const budget = checkBeforeRequest(apiKey)
    if (!budget.allowed) return // 上限超過時はあいさつをスキップ
    setGreetLoading(true)
    const kickoff =
      'これからこのプロジェクトの開発を始めます。まず、把握した内容（プロジェクトの目的と構成）を1〜2文で要約し、' +
      '続けて「次に何をしたいか」を私に1つ質問してください。この最初の返答ではコードは出力せず、まず会話で確認してください。'
    const ctx = ctxFor(projectDir)
    const sys = IDE_CONTEXT + (ctx ? '\n\n' + ctx : '')
    try {
      let text = ''
      setMessages([{ role: 'user', content: kickoff, hidden: true }, { role: 'assistant', content: '' }])
      const { usage } = await window.electronAPI.sakura.chatStream(
        {
          apiKey,
          model,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: kickoff }],
          maxTokens: 700,
        },
        (delta) => {
          text += delta
          setMessages(prev => {
            const n = [...prev]
            n[n.length - 1] = { role: 'assistant', content: text }
            return n
          })
        },
        (abort) => { greetAbortRef.current = abort },
      )
      recordUsage(apiKey, model, usage?.prompt_tokens ?? estimateTokens(sys + kickoff), usage?.completion_tokens ?? estimateTokens(text))
    } catch (e: any) {
      // 所見22: あいさつ失敗は致命的でないため、生エラーは出さず穏当な固定文言にフォールバックする。
      // 原因把握のためログにだけ整形済みエラー（formatChatError）を残す。
      console.warn('greet failed:', formatChatError(e?.message ?? String(e)))
      setMessages([{ role: 'assistant', content: '（あいさつを準備できませんでした。つくりたいものを教えてください。）' }])
    } finally {
      greetAbortRef.current = null
      setGreetLoading(false)
    }
  }

  const send = useCallback(() => {
    const text = input
    const images = pendingImages
    if ((!text.trim() && images.length === 0) || isLoading) return
    setInput('')
    setPendingImages([])
    void chat.send(text, images)
  }, [input, pendingImages, isLoading, chat])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
    }
  }

  // apiKey（さくらのAI Engine）と claudeActive（Claude）のどちらも無い場合のみ案内画面を出す
  // （モードB＝Claudeキーのみの利用者がここで行き止まりにならないよう、ユーザー指摘 2026-07-12 で変更）。
  if (!isChatUsable(!!apiKey, claudeActive)) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 gap-3 text-center">
        <SakuraLogo size={40} />
        <span className="text-sm font-semibold sakura-gradient-text">Koto AI</span>
        <p className="text-xs text-ink-secondary">{CHAT_NO_KEY_MESSAGE}<br />{CHAT_NO_KEY_HINT}</p>
        <button
          onClick={onOpenCredentials}
          className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          🔑 APIキーを登録する
        </button>
        <p className="text-[11px] text-ink-muted mt-1">
          <a href="https://ai.sakura.ad.jp/" className="text-sakura-soft hover:underline">さくらのAI Engine</a> で取得 ・ ⌘, でも開けます
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-line flex-none">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-xs font-semibold sakura-gradient-text"><SakuraLogo size={13} />AI Chat</span>
          {/* C2c: Claudeモードのときは AI Engine のモデル一覧の代わりに Claudeモデル一覧（ライブ取得）を選ばせる。 */}
          <ModelSelect
            models={claudeActive ? claudeModels : models}
            value={claudeActive ? claudeModelId : model}
            onChange={id => {
              if (claudeActive) { setClaudeModel(id); setClaudeModelId(id) }
              else { setModel(id); setDefaultModel(id, 'ide'); setRoutedModel(null) }
            }}
            buttonClassName="flex items-center gap-1 max-w-[12rem] text-xs bg-elevated border border-line rounded-md px-1.5 py-0.5 text-ink hover:border-sakura cursor-pointer transition-colors"
          />
          {/* 頭脳の切替（2026-07-29 ユーザー要望）。右下のステータスバー・設定と同じ BrainToggle を
              モデル選択の横にも置く（切替＝setClaudeMode の書き込み口は1つのまま）。 */}
          <BrainToggle apiKey={apiKey} compact />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleWriteMode}
            className="text-[11px] text-ink-muted hover:text-ink border border-line rounded-md px-1.5 py-0.5 whitespace-nowrap"
            title={writeMode === 'auto'
              ? 'AIのファイル保存：おまかせ（自動保存）。クリックで「毎回確認」に切替'
              : 'AIのファイル保存：毎回確認（保存前に許可を求める）。クリックで「おまかせ」に切替'}
          >{writeMode === 'auto' ? '🪄 おまかせ' : '✋ 毎回確認'}</button>
          <button
            onClick={() => {
              const text = messages.filter(m => !m.hidden)
                .map(m => `${m.role === 'user' ? '🧑 あなた' : 'AI'}:\n${m.content}`).join('\n\n')
              navigator.clipboard.writeText(text)
            }}
            className="text-xs text-ink-muted hover:text-ink"
            title="会話全体をコピー"
          >📋</button>
          <button
            onClick={() => {
              if (messages.filter(m => !m.hidden).length === 0) return
              if (window.confirm('この会話をすべて削除します。よろしいですか？（元に戻せません）')) setMessages([])
            }}
            className="text-xs text-ink-muted hover:text-ink"
            title="会話をクリア"
          >🗑</button>
          <button
            onClick={onOpenCredentials}
            className="text-xs text-ink-muted hover:text-ink"
            title="認証情報（APIキー）"
          >🔑</button>
        </div>
      </div>

      {/* Context pill */}
      {activeFile && (
        <div className="px-3 py-1.5 border-b border-line flex-none">
          <span className="text-xs bg-elevated border border-line text-sakura-soft px-2 py-0.5 rounded-full">
            📄 {activeFile.name}
          </span>
        </div>
      )}

      {/* Messages */}
      <div
        className={`flex-1 overflow-y-auto p-3 space-y-3 relative ${dragOver ? 'ring-2 ring-sakura ring-inset' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault(); setDragOver(false)
          if (e.dataTransfer.files?.length) addImages(e.dataTransfer.files)
        }}
      >
        {dragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-base/70 pointer-events-none">
            <span className="text-sm font-semibold text-sakura">🖼 画像をドロップしてAIに渡す</span>
          </div>
        )}
        {messages.filter(m => !m.hidden).length === 0 && !isLoading && (
          <div className="text-center text-ink-muted text-xs py-6">
            <div className="flex justify-center mb-2"><SakuraLogo size={32} /></div>
            <p>{claudeActive ? 'Claudeに質問してください' : 'さくらのAI Engineに質問してください'}</p>
            <p className="mt-1">⌘+Enter で送信</p>
          </div>
        )}
        {messages.filter(m => !m.hidden).map((msg, i) => {
          // 応答待ち/思考中の空のアシスタント吹き出しは描画しない（「…」インジケータで代替し、空箱が出ないようにする）。
          if (msg.role === 'assistant' && !msg.content.trim() && !msg.images?.length) return null
          return (
          <div key={i} className={`group flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`relative max-w-[90%] rounded-2xl px-3 py-2 text-sm select-text ${
              msg.role === 'user'
                ? 'sakura-gradient text-white rounded-tr-md'
                : 'bg-elevated border border-line text-ink rounded-tl-md'
            }`}>
              <MessageCopyButton text={msg.content} side={msg.role === 'user' ? 'left' : 'right'} />
              {msg.images && msg.images.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                  {msg.images.map((src, k) => (
                    <img key={k} src={src} alt="" className="max-h-32 rounded-lg border border-white/30 object-cover" />
                  ))}
                </div>
              )}
              {/* 推論モデルの思考（表示専用）。生成中はライブ表示、終わったら自動で畳む。
                  live 判定: 最後の吹き出しかつ応答中＝いま流れているもの。 */}
              {msg.role === 'assistant' && msg.thinking && (
                <ThinkingBlock text={msg.thinking} live={isLoading && i === messages.length - 1} />
              )}
              {msg.role === 'assistant' ? (
                <AiMessage content={msg.content} onApplyFile={onApplyFile} />
              ) : (
                msg.content && <p className="whitespace-pre-wrap">{msg.content}</p>
              )}
              {/* #31: Claudeが使えないときの「さくらのAI Engineに切り替えて続ける」提案ボタン。 */}
              {msg.offerAiEngineFallback && (
                <button
                  onClick={() => chat.switchToAiEngineAndResend(msg.offerAiEngineFallback!.text, msg.offerAiEngineFallback!.images ?? [])}
                  className="mt-2 sakura-gradient text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
                >さくらのAI Engine に切り替えて続ける</button>
              )}
              {/* ツール実行の回数上限で区切ったときの「続ける」ボタン（従来は「続けて」と手入力が必要だった）。 */}
              {msg.offerContinue && (
                <button
                  onClick={() => chat.send('続けて', [])}
                  disabled={chat.isLoading}
                  className="mt-2 sakura-gradient text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
                >▶ 続ける</button>
              )}
            </div>
          </div>
          )
        })}
        {pendingApproval && (
          <div className="flex justify-start">
            <div className="bg-elevated border border-sakura/60 rounded-2xl rounded-tl-md px-3 py-2.5 max-w-[90%]">
              <p className="text-sm text-ink mb-2">✋ AIが次の操作の許可を求めています: <span className="font-mono text-sakura">{pendingApproval.path}</span></p>
              <div className="flex gap-2">
                <button
                  onClick={() => pendingApproval.resolve(true)}
                  className="sakura-gradient text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
                >許可する</button>
                <button
                  onClick={() => pendingApproval.resolve(false)}
                  className="bg-overlay text-ink border border-line rounded-lg px-3 py-1.5 text-xs font-medium hover:border-sakura"
                >拒否</button>
              </div>
            </div>
          </div>
        )}
        {isLoading && !pendingApproval && (
          <div className="flex justify-start">
            <div className="bg-elevated border border-line rounded-2xl rounded-tl-md px-3 py-2">
              <div className="flex gap-2 items-center h-4">
                <span className="text-[11px] text-ink-secondary">
                  {statusNote || (stalled ? '⏳ 時間がかかっています…（⏹ で停止できます）' : '考えています…')}
                  {/* 経過秒数（待つか止めるかの判断材料。推論モデルは沈黙が長い） */}
                  {elapsedSec >= 3 && <span className="ml-1 tabular-nums text-ink-muted">{elapsedSec}秒</span>}
                </span>
                <div className="flex gap-1 items-center">
                  {[0, 1, 2].map(i => (
                    <span key={i} className="w-1.5 h-1.5 rounded-full sakura-gradient" style={{ animation: `bounce-dot 1.2s ${i * 0.16}s infinite ease-in-out` }} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-line p-3 flex-none">
        <div className="flex flex-col gap-2 bg-elevated rounded-xl border border-line focus-within:border-sakura transition-colors p-2">
          {/* 添付画像のプレビュー */}
          {pendingImages.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1">
              {pendingImages.map((src, i) => (
                <div key={i} className="relative">
                  <img src={src} alt="" className="h-16 w-16 object-cover rounded-lg border border-line" />
                  <button
                    onClick={() => setPendingImages(prev => prev.filter((_, k) => k !== i))}
                    className="absolute -top-1.5 -right-1.5 bg-base border border-line text-ink-muted hover:text-sakura rounded-full w-5 h-5 flex items-center justify-center text-[11px]"
                    title="削除"
                  >×</button>
                </div>
              ))}
              {/* Claudeが実際にこのターンの画像を直接処理する場合（プロジェクトを開いていてClaude頭脳が有効）は、
                  AI Engineの視覚モデルへの委譲は発生しないため、この案内は出さない（C2d）。 */}
              {!(claudeActive && projectDir) && !isVisionModel(model) && (
                <span className="self-center text-[11px] text-ink-muted">
                  送信時に画像対応モデル（{modelLabel(getDefaultVisionModel())}）で処理します
                </span>
              )}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={e => {
              // 所見19: 非画像も addImages へ渡し、案内を出せるようにする（filesが空＝テキスト貼付けはそのまま）。
              const files = Array.from(e.clipboardData.files)
              if (files.length) { e.preventDefault(); addImages(files) }
            }}
            placeholder="メッセージを入力... (⌘+Enter で送信。画像は貼付け/ドロップ/📎で添付)"
            rows={3}
            className="flex-1 bg-transparent px-1 py-0.5 text-sm text-ink placeholder-ink-muted outline-none resize-none"
          />
          <div className="flex items-center justify-between">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={e => { if (e.target.files?.length) addImages(e.target.files); e.target.value = '' }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="text-ink-muted hover:text-sakura text-base px-1.5 py-1 rounded-md hover:bg-overlay transition-colors"
              title="画像を添付"
            >📎</button>
            {isLoading ? (
              <button
                onClick={() => { chat.abort(); greetAbortRef.current?.() }}
                className="bg-elevated border border-brand-red text-brand-red rounded-lg px-3 py-1.5 text-sm font-semibold hover:bg-brand-red hover:text-white transition-colors"
                title="応答を停止"
              >
                ⏹ 停止
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!input.trim() && pendingImages.length === 0}
                className="sakura-gradient text-white rounded-lg px-3 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-40 transition-opacity"
              >
                送信
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
