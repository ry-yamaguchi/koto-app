import React, { useState, useRef, useEffect, useCallback } from 'react'
import type { OpenFile } from '../App'
import SakuraLogo from './SakuraLogo'
import AiMessage from './AiMessage'
import CompactNote from './CompactNote'
import MigrateNotice from './MigrateNotice'
import type { MigratePlan } from '../../shared/migratePlan'
import { commandScopeNote } from '../../shared/commandGuard'
import { saveRagSettings } from '../ragContext'
import { COMPACT_NOTE, canCompactNow } from '../historyCompact'
import ThinkingBlock from './ThinkingBlock'
import { checkBeforeRequest, recordUsage, estimateTokens, getDefaultModel, setDefaultModel, isVisionModel, getDefaultVisionModel, modelLabel, pickBestModel } from '../usage'
import { shouldTryImagesDirectly } from '../visionSupport'
import { useModels } from '../hooks/useModels'
import { useClaudeModels } from '../hooks/useClaudeModels'
import { useAiChat, type ChatMessage } from '../hooks/useAiChat'
import { IDE_CONTEXT, buildProjectContext, ragStatusContext } from '../aiContext'
import { getTargetProfile, shouldAutoCheckTarget } from '../targetProfiles'
import { fileToDataUrl, countNonImageFiles } from '../imageInput'
import { requiresConfirmation, confirmReason, formatChatError } from '../aiTools'
import { parseRagSettings, autoRagBlock, type RagSettings } from '../ragContext'
import { buildPublishStatusRows, parseApprunLegacy, formatPublishedAt, isStale } from '../publishStatus'
import ModelSelect from './ModelSelect'
import BrainToggle from './BrainToggle'
import { getAnthropicToken } from './CredentialsModal'
import { isClaudeModeEnabled, getClaudeModel, setClaudeModel, claudeModelShortLabel, CHAT_NO_KEY_MESSAGE, CHAT_NO_KEY_HINT, isChatUsable } from '../claudeMode'
import { loadConversationView, makeConvClient, type Op } from '../chatConvClient'
import { applyToMessages, viewSyncDecision } from '../../shared/chatEvents'
import { takeNewProjectRequest } from '../newProjectRequest'
import { defaultImageName, tellAiAboutAsset, assetSavedNote, useImageHint, mediaTypeOf, type AssetPurpose } from '../../shared/assetImport'
import { AssetUseButton, AssetUseCheckbox } from './AssetUseButton'
import { CHAT_TEXT_WRAP } from '../textWrap'
import { resolvePublishRoot } from '../publishRootRenderer'
import { timelineMarks, bubbleTime, nowContext } from '../../shared/chatTime'
import { turnKey, updateTurn } from '../chatTurnRegistry'

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
  onApplyFile?: (relPath: string, content: string, root?: string | null) => Promise<void>
  /**
   * B'-3d-2b: main（AI Engine 経路の write_file/edit_file）がAIのファイル保存を main 側で
   * 終えた直後の通知（full はディスク上の絶対パス）を受けて、エディタへ反映する
   * （App.tsx の showAiFileInEditor）。
   */
  onAiFileWritten?: (full: string) => void
  /** Claudeモードの書き込み後、該当タブをディスクから読み直す（App.tsx の applyRestoreResult 相当。
   *  stale tab のオートセーブ上書きによるデータ喪失防止・2026-07-11） */
  onExternalFilesChanged?: (relPaths: string[]) => void
  /** フォルダの整理でファイルの場所が変わったとき。**開いているタブは古い場所を指すので閉じる。** */
  onProjectFilesMoved?: () => void
  activeFile: OpenFile | null
  projectDir?: string | null
}


export default function ChatPanel({ apiKey, onSetApiKey, onOpenCredentials, onApplyFile, onAiFileWritten, onExternalFilesChanged, onProjectFilesMoved, activeFile, projectDir }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  // ── B'-3c: 会話の持ち主は main（src/main/chat/convStore.ts）───────────────
  // ここは「画面へ即時反映」しつつ「main へ書き換え（ops）を送る」薄い client（chatConvClient.ts）
  // を持つだけ。client は projectDir ごとに作り直す（下の読み込み effect）。projectDir が
  // 定まっていない間（プロジェクト未選択・読み込み中）は client が無いので、画面だけを更新する
  // （送り先が無いので ops は送らない＝壊れない。読み込み完了までは保存させないガードを兼ねる）。
  const clientRef = useRef<ReturnType<typeof makeConvClient> | null>(null)
  const applyOpLocally = useCallback((op: Op) => {
    setMessages(prev => (op.kind === 'replaceAll' ? op.messages : applyToMessages(prev, op)))
  }, [])
  const applyOp = useCallback((op: Op) => {
    if (clientRef.current) clientRef.current.apply(op)
    else applyOpLocally(op)
  }, [applyOpLocally])
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
  /**
   * 添付中の画像。**名前も持つ**（プロジェクトへ入れるときのファイル名に使う。
   * 貼り付けた画像には元の名前が無いので、その場で付ける・2026-08-19）。
   */
  const [pendingImages, setPendingImages] = useState<Array<{ url: string; name: string }>>([])
  const [assetChoice, setAssetChoice] = useState<AssetPurpose | null>(null)
  /**
   * もうプロジェクトへ入れた画像（2026-08-19 実機・Ryosuke 指摘）。
   *
   * 入れたあとも会話の中の画像にボタンが残っていた。押すと**同じ画像がもう1枚**
   * 増える（`uniqueName` が `-2` を付ける）。入れ終わったものからは導線を消す。
   */
  const [savedImages, setSavedImages] = useState<Set<string>>(new Set())
  // 添付が無くなったら印も外す（次に付けた画像に、前の印が残らないように）
  useEffect(() => { if (pendingImages.length === 0) setAssetChoice(null) }, [pendingImages.length])
  const [writeMode, setWriteMode] = useState<WriteMode>(getWriteMode())
  // 「毎回確認」モードで保存待ちのファイル。resolve(true)=許可 / resolve(false)=拒否
  // 承認待ちの列。B-1b（並列送信の解禁）で複数プロジェクトのターンが同時に承認を求め得る
  // ようになったため、単一スロットから列に変えた。単一のままだと、2件目の setPendingApproval が
  // 1件目を握りつぶし、**1件目の resolve が永遠に呼ばれずターンがハングする**。
  // ── ダイアログは持ち場に留める（2026-08-29 v0.4.0 実機確認・Ryosuke 指摘）────────────
  // 以前は列の先頭を**どのプロジェクトを見ていても**出していた（その場で答えられる利点）が、
  // 「どのプロジェクトの許可か分からない」混乱のほうが大きかった。⚠️（B-2）ができたので、
  // 各エントリに dir を持ち、**いま見ているプロジェクトの分だけ**表示する。他所には ⚠️ が
  // 付き、開くとダイアログが待っている。答えたら**そのエントリ**を外す（先頭とは限らない）。
  const [pendingApprovals, setPendingApprovals] = useState<Array<{ dir: string | null; path: string; resolve: (ok: boolean) => void }>>([])
  const pendingApproval = pendingApprovals.find(a => a.dir === projectDir) ?? null
  const models = useModels(apiKey)

  // C2c: チャットの頭脳が Claude か（StatusBar.tsx と同じ判定方式）。Claudeのときは
  // ModelSelect の選択肢を AI Engine のモデル一覧から Claudeモデル一覧（ライブ取得。useClaudeModels）へ切り替える。
  const [claudeActive, setClaudeActive] = useState(false)

  // ── AI が読み書きする基準（2026-08-20）───────────────────────────────
  // `public/` がある＝そこが作業の場。無ければプロジェクト直下（移行前）。
  // `resolveInProject` は `..` と絶対パスを拒むので、基準をここにすると
  // **AI は書き込みで外へ出られない**（間違えにくい、ではなく構造上できない）。
  // 🗂 プロジェクトの形を新しくする案内（2026-08-20）。**拒否はできないが、黙ってもやらない。**
  const [migratePlan, setMigratePlan] = useState<MigratePlan | null>(null)
  useEffect(() => {
    let cancelled = false
    setMigratePlan(null)
    if (!projectDir) return
    void window.electronAPI.fs.migrateCheck(projectDir)
      .then(r => { if (!cancelled && r.needed) setMigratePlan(r.plan) })
      .catch(() => { /* 調べられなければ案内を出さない（邪魔をしない） */ })
    return () => { cancelled = true }
  }, [projectDir])

  const runMigrate = useCallback(async () => {
    const snapshotId = new Date().toISOString().replace(/[:.]/g, '-')
    const r = await window.electronAPI.fs.migrate(projectDir!, snapshotId)
    if (r.ok) {
      // 根が変わったので取り直す（AI・ターミナル・公開の起点が一斉に切り替わる）
      const next = await resolvePublishRoot(projectDir!)
      setAiRoot({ dir: projectDir!, root: next || projectDir! })
      // **開いているタブは古い場所を指したままになる。** そのまま保存すると、
      // 移したはずのファイルが元の場所に復活する（2026-07-11 の stale tab 事故と同じ形）。
      onProjectFilesMoved?.()
    }
    return r
  }, [projectDir])

  /**
   * AI の作業フォルダ（`public/`。無ければプロジェクト直下）。
   *
   * ── ⚠️ どのプロジェクトのものかを必ず持つ（2026-08-24 の実害）───────────
   * 以前は根だけを持っていた。解決はディスクを見る**非同期**なので、
   * プロジェクトを切り替えた直後は**前のプロジェクトの根が残る**。
   * 新規作成では、まさにその瞬間に AI への依頼が飛ぶ。実機では
   * **新規の Unreal ゲームで、AI が前のプロジェクト（landingtest）の
   * ファイル一覧を見て `rm -rf` しようとした**（承認前で止まった）。
   *
   * 文脈（`projectCtx`）は前から `{ dir, ctx }` の対で持ち、
   * `dir !== projectDir` なら使わない作法だった。**根も同じ作法に揃える。**
   */
  const [aiRoot, setAiRoot] = useState<{ dir: string; root: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    setAiRoot(null) // **前のプロジェクトの根を引きずらない**
    if (!projectDir) return
    void resolvePublishRoot(projectDir).then(r => {
      if (!cancelled) setAiRoot({ dir: projectDir, root: r || projectDir })
    })
    return () => { cancelled = true }
  }, [projectDir])
  /** いま開いているプロジェクトの根（追いついていなければプロジェクト直下）。 */
  const currentAiRoot = aiRoot && aiRoot.dir === projectDir ? aiRoot.root : projectDir
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
      applyOp({ kind: 'append', msg: { role: 'assistant', content: `ℹ️ モデル「${claudeModelId}」は提供終了したため、「${claudeModelShortLabel(next, claudeModels)}」に自動で切り替えました。` } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeModels])

  // 選択中のモデルが提供終了していたら、提供中の最適なモデルへ自動で切り替える
  useEffect(() => {
    if (!models.length) return
    if (!models.some(m => m.id === model)) {
      const next = pickBestModel(models.map(m => m.id))
      setModel(next)
      applyOp({ kind: 'append', msg: { role: 'assistant', content: `ℹ️ モデル「${model}」は提供終了したため、「${modelLabel(next)}」に自動で切り替えました。` } })
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
  /**
   * 添付した画像をプロジェクトへ入れる（2026-08-19）。
   *
   * 入れたら**チャット欄に文面を入れる**（送信はしない）。入れただけでは
   * AI は知らないので、知らせるところまでが「入れる」である。
   */
  /**
   * 画像をプロジェクトへ入れる。**画面には何も出さない**（入れた場所を返すだけ）。
   *
   * 入れたことをどう伝えるかは呼ぶ側が決める:
   *   ・添付から入れたとき … 送信のときにAIへ添える（画面には出さない）
   *   ・送信済みから入れたとき … 会話に一言だけ残す
   */
  const putIntoProject = useCallback(async (images: Array<{ url: string; name: string }>, purpose: AssetPurpose) => {
    const done: string[] = []
    const failed: string[] = []
    const saved: string[] = [] // 入れられた画像そのもの（導線を消すため）
    if (!projectDir) return { done, failed }
    for (const img of images) {
      try {
        // 'app'（アプリで使う）は公開されるので根の中へ。'material'（素材）は
        // 公開されない置き場なので、これまでどおりプロジェクト直下へ入れる。
        // ここは projectDir が確定している文脈。**根が追いついていなければ直下**
        // （前のプロジェクトの根を絶対に使わない）。
        const dest = purpose === 'material' || !(aiRoot && aiRoot.dir === projectDir)
          ? projectDir : aiRoot.root
        const r = await window.electronAPI.fs.importImageData(dest, img.name, img.url, purpose)
        if (r.ok && r.rel) { done.push(r.rel); saved.push(img.url) }
        else failed.push(r.message ?? '原因不明')
      } catch (e: any) {
        failed.push(e?.message ?? String(e))
      }
    }
    // ファイル一覧に反映させる（入れたのに見えないと、入ったか分からない）
    if (done.length) onExternalFilesChanged?.(done)
    if (saved.length) setSavedImages(prev => new Set([...prev, ...saved]))
    return { done, failed }
  }, [projectDir, onExternalFilesChanged])

  const addImages = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files)
    // 所見19: 画像以外のファイルが混じっていたら、黙って捨てずに toolNote バブルで案内する
    //（fileToDataUrl は非画像を null で捨てるため、この案内が無いとドロップしても無反応に見えた）。
    if (countNonImageFiles(list) > 0) {
      applyOp({
        kind: 'append',
        msg: {
          role: 'assistant',
          content: '📎 画像ファイル（PNG/JPEGなど）のみ添付できます。それ以外のファイルは取り込みませんでした。',
          toolNote: true,
        },
      })
    }
    for (const f of list) {
      const url = await fileToDataUrl(f)
      if (url) setPendingImages(prev => [...prev, { url, name: f.name || defaultImageName(f.type) }])
    }
  }, [applyOp])

  // 画面のどこに落とされても、ここで受け取って添付にする（2026-08-19）。
  // **受け口を2つ持たない**ため、実際の取り込みは addImages に一本化する。
  useEffect(() => {
    const onAttach = (e: Event) => {
      const files = (e as CustomEvent).detail?.files as FileList | undefined
      if (files?.length) void addImages(files)
    }
    window.addEventListener('sakura:attach-images', onAttach)
    return () => window.removeEventListener('sakura:attach-images', onAttach)
  }, [addImages])


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
  const [ragBusy, setRagBusy] = useState(false)
  /**
   * 📚 の切替。**資料が1件も無いときは、切り替えずに知らせる**
   * （押しても何も起きないボタンにしない・2026-08-09 の戒め）。
   */
  const toggleRag = useCallback(async () => {
    if (!projectDir || ragBusy) return
    const next = !ragSettings?.enabled
    setRagBusy(true)
    try {
      if (next && apiKey) {
        const r = await window.electronAPI.rag.list(apiKey, { pageSize: 1 })
        if (r.ok && (r.documents?.length ?? 0) === 0) {
          applyOp({
            kind: 'append',
            msg: {
              role: 'assistant',
              content: 'まだ資料が登録されていません。画面右上の 📚 から資料を登録すると、'
                + 'このプロジェクトのチャットで使えるようになります。',
            },
          })
          return
        }
      }
      await saveRagSettings(projectDir, { enabled: next, tags: ragSettings?.tags ?? [] })
      await reloadRagSettings(projectDir)
    } finally {
      setRagBusy(false)
    }
  }, [projectDir, ragBusy, ragSettings, apiKey, reloadRagSettings, applyOp])

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
      // 現在日時（この端末のローカル時刻）を毎回の送信で先頭に添える（AIに今日を推測させない・chatTime.ts）
      return nowContext() + '\n\n' + IDE_CONTEXT + (ctx ? '\n\n' + ctx : '') + openFileBlock + ragStatusContext(ragEnabled)
    },
    toolsProjectDir: projectDir ?? null,
    onExternalFilesChanged,
    // B'-3d-2b: main が io.applyFile を直呼びで実行するようになったので、AI Engine 経路の
    // 保存＋エディタ反映（旧 applyFile 関数）はここから外れた——main は「保存」だけを行い、
    // エディタへの反映は ChatEvent 'aiFileWritten' を経由して onAiFileWritten（下）が担う。
    // 掟11: 「いま見ているプロジェクトの分だけ」開く。他所はスキップしても、開けばディスクから
    // 読むので失われない（roadmap 設計に明記済み）。
    onAiFileWritten: onAiFileWritten
      ? (full: string) => {
          if (projectDir && (full === projectDir || full.startsWith(`${projectDir}/`))) onAiFileWritten(full)
        }
      : undefined,
    buildExecuteOpts: () => ({
      // AI のファイル操作・コマンド・プレビューは、すべてこの根を基準にする。
      writeRoot: currentAiRoot,
      // ⚠️ **退避（🕘 履歴）の根は別。** ここを writeRoot と兼ねていたため、
      // 退避が `public/.sakuraide-backup` へ行き、履歴の一覧に一切出なかった
      // （＝「元に戻す」が効かない）。2026-08-24 に実害を確認して分けた。
      projectRoot: projectDir,
      // 📚 資料検索（search_docs）は main の io.ragSearch が queryDocuments + buildRagBlockText
      // で直接組む（main/chat/turnRunner.ts の buildMainIo）。ここは main が使うタグだけを渡す
      // （関数ではなくデータ・B'-3d-2b の turnOpts 宣言化）。
      rag: ragEnabled ? { tags: ragSettings!.tags } : null,
    }),
    // 📚 資料の自動注入（IDE主導）。無効時は未指定にし、useAiChat の従来動作（注入なし）を維持する。
    buildRagBlock: ragEnabled ? (text: string) => autoRagBlock(text, apiKey, ragSettings) : undefined,
    approveToolCall: async (toolName, toolArgs, scope) => {
      // **確認は「このターンが縛られている行き先」の話として出す**（2026-08-24）。
      // 画面が別のプロジェクトへ切り替わっていても、聞いている中身は変わらない。
      const scopeDir = scope?.projectDir ?? projectDir
      const scopeRoot = scope?.writeRoot ?? currentAiRoot
      // 「毎回確認」モードでは、ファイル保存（全文上書き／部分編集）の前にユーザーの許可を取る
      // （localStorageから都度読む＝会話の途中でモードを切り替えても即反映）。
      // edit_file も write_file と同じくファイルを書き換える破壊的操作のため、同じ扱いにする。
      if ((toolName === 'write_file' || toolName === 'edit_file') && getWriteMode() === 'confirm') {
        let relPath = ''
        try { relPath = JSON.parse(toolArgs || '{}').path ?? '' } catch { /* パス不明でも確認は出す */ }
        const isEdit = toolName === 'edit_file'
        const label = `${relPath || '(不明なファイル)'}${isEdit ? '（部分編集）' : ''}`
        // ダイアログの持ち主として「答えを待っている」印を registry へ付ける（B-2）。見ている会話では UI が出さない。
        updateTurn(turnKey(scopeDir), { attention: 'approval' })
        // dir 付きで列へ（表示は「いま見ているプロジェクトの分だけ」。上の pendingApprovals コメント参照）
        let entry!: { dir: string | null; path: string; resolve: (ok: boolean) => void }
        const approved = await new Promise<boolean>(resolve => {
          entry = { dir: scopeDir ?? null, path: label, resolve }
          setPendingApprovals(prev => [...prev, entry])
        })
        updateTurn(turnKey(scopeDir), { attention: null })
        setPendingApprovals(prev => prev.filter(a => a !== entry))
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
          // 名前の書かれていない `npm install` は、package.json を見ないと
          // **何が入るのか分からない**（2026-08-18 Ryosuke 指摘）
          let deps: string[] = []
          try {
            if (scopeDir && /\b(install|i|add)\b/.test(cmd)) {
              const raw = await window.electronAPI.fs.readFile(`${scopeDir}/package.json`)
              const d = JSON.parse(raw)?.dependencies
              deps = d && typeof d === 'object' ? Object.keys(d) : []
            }
          } catch { /* 読めなければ名前なしで確認する */ }
          const reason = requiresConfirmation(cmd) ? `\n理由: ${confirmReason(cmd, { dependencies: deps })}` : ''
          // **いつもと違う場所なら、そのことだけを名前で伝える**（2026-08-24 の実害）。
          // パスを読み比べさせない——利用者に難しい判断を押しつけることになる。
          const scopeNote = commandScopeNote(scopeDir, scopeRoot)
          // ダイアログの持ち主として「答えを待っている」印を registry へ付ける（B-2）。見ている会話では UI が出さない。
          updateTurn(turnKey(scopeDir), { attention: 'approval' })
          // dir 付きで列へ（表示は「いま見ているプロジェクトの分だけ」。上の pendingApprovals コメント参照）
          let entry!: { dir: string | null; path: string; resolve: (ok: boolean) => void }
          const approved = await new Promise<boolean>(resolve => {
            entry = { dir: scopeDir ?? null, path: `コマンド実行: ${cmd || '(不明)'}${scopeNote}${reason}`, resolve }
            setPendingApprovals(prev => [...prev, entry])
          })
          updateTurn(turnKey(scopeDir), { attention: null })
          setPendingApprovals(prev => prev.filter(a => a !== entry))
          if (!approved) {
            return `ユーザーがコマンド「${cmd}」の実行を許可しませんでした。実行せずに、どう進めるべきかユーザーに確認してください。`
          }
        }
      }
      return null // 許可（または確認不要）
    },
    getHistory: () => messages,
    // updateShown は「main が既に書き主のターン」（chatTurn.start の onEvent → viewOnlyEmit）専用の
    // 画面反映口として今も使われる。renderer 発の書き換え（message系）は onMessageEvent（下）が
    // 先に取るので、こちらは呼ばれない（useAiChat.ts の emit/viewOnlyEmit のコメント参照）。
    updateShown: (updater) => setMessages(prev => updater(prev)),
    // B'-3c: renderer 発の message系の出来事は client 経由で main（convStore.ts）へ ops として送る
    // （画面反映も applyOp が行う。updateShown は使われない）。
    onMessageEvent: (ev) => applyOp(ev),
    twoStageVision: true,
  })
  const { statusNote, stalled, elapsedSec, setRoutedModel } = chat
  // 表示上のローディングは、あいさつ生成中と送信中の両方を含める
  const isLoading = chat.isLoading || greetLoading

  /**
   * 送信済みの画像から入れて、**そのまま続きをやらせる**。
   *
   * ── 押したら終わりにする（2026-08-19 実機・Ryosuke 指摘）────────────────
   * 「手順の説明が長く、結局自分で何か入力しないと動かないのは面倒」
   * 押した人がやりたいことは、**さっき頼んだこと**である。保存できたら
   * こちらから続きを送る（利用者は何も打たない）。
   *
   * ── 知らせ方を2つに分ける（同日・別の報告）────────────────────────────
   * 会話に出す一言は `toolNote`（表示専用）で、**AIには送られない**決まり
   * （結果の伴わない実況でモデルが混乱するため）。AI へは送信に添えて渡す。
   */
  const importFromMessage = useCallback(async (image: { url: string; name: string }) => {
    const purpose: AssetPurpose = 'app'
    const { done, failed } = await putIntoProject([image], purpose)
    const shown = [
      ...done.map(rel => assetSavedNote(rel, purpose)),
      ...(failed.length ? [`⚠️ 画像を入れられませんでした: ${failed[0]}`] : []),
    ]
    if (!shown.length) return
    applyOp({ kind: 'append', msg: { role: 'assistant', content: shown.join('\n'), toolNote: true } })
    if (!done.length) return
    const forAi = done.map(rel => tellAiAboutAsset(rel, purpose)).join('\n')
    // 応答中に割り込まない（そのときは次の発言で伝わるよう履歴に残すだけ）
    if (chat.isLoading) {
      applyOp({ kind: 'append', msg: { role: 'user', content: forAi, hidden: true } })
      return
    }
    void chat.send('画像を使えるようにしました。さきほどの依頼を続けてください。', [], forAi)
  }, [putIntoProject, applyOp, chat])


  // プロジェクトごとに会話を読み込む（remount/再起動でも継続）。
  // 保存先は main の会話ストア（src/main/chat/convStore.ts。実ファイルは `<project>/.sakuraide/chat.json`。
  // 旧 localStorage 形式が残っていれば loadConversationView が読み込み時に main へ移行する）。
  //
  // ── B'-3c: 保存は main の仕事になった ─────────────────────────────────
  // 以前ここにあった「デバウンス保存」「アンマウント時フラッシュ」の2つの effect は丸ごと消した
  // （main の convStore.ts が同じ1.5秒デバウンスで保存する）。「読み込み完了までは保存しない」
  // ガードの意図は、client を projectDir ごとに作り直すことで引き継ぐ（読み込み前・読み込み中は
  // clientRef が null のため、applyOp は画面だけを更新し ops を送らない）。
  useEffect(() => {
    let cancelled = false
    // ── B-1b: 切替時の setRoutedModel(null) は消した ─────────────────────────
    // 以前は routedModel が画面全体で1つの状態だったため、プロジェクトを切り替えるたびに
    // リセットしないと**前のプロジェクトの割り振りが新しいプロジェクトへ漏れて**しまっていた。
    // いまは routedModel もプロジェクト別（chatTurnRegistry.ts）に持つので、ここでリセットすると
    // 逆に**戻ってきたときにそのプロジェクト自身の割り振りが消えてしまう**（「この会話では
    // ツール作業のため切り替えた割り振り先を、会話中は維持する」という routedModel 本来の
    // 意味に反する）。切替先の routedModel は、切替先の登録鍵からそのまま正しく読み出される。
    clientRef.current = null // 切替では前の client の完了を待たず、ここで捨てる（main 側は projectDir ごとに独立）
    if (!projectDir) { setMessages([]); return }
    loadConversationView(projectDir).then(msgs => {
      if (cancelled) return
      setMessages(msgs) // ストアから来たものを映すだけ（ops は送らない）
      clientRef.current = makeConvClient(projectDir)
    })
    return () => { cancelled = true }
  }, [projectDir, applyOpLocally])

  // ── B-1a: 画面の更新を「main が当てた結果の押し出し」1本にする ─────────────────────
  //
  // 以前は2経路あった: ①renderer発の書き換え（client.apply が「画面へ即時反映」と「ops送信」の
  // 両方をやる）②main のターンの出来事（chatTurn.start の onEvent が「見ているものが何か」を
  // 確かめずに当てる）。②はターン中にプロジェクトを切り替えると、走っているターンの吹き出しが
  // 切り替え先の画面に誤配されていた（保存自体は convStore が projectDir 別に正しく持つので、
  // 壊れるのは見た目だけ）。
  //
  // 会話への書き換えは renderer発（ops）・main のターンの出来事・🕘 復元の記録のすべてが必ず
  // main の convStore.ts を通るので、convStore が「当てた結果」を chat:applied で押し出し、
  // 画面は「いま見ているプロジェクトの分だけ」受ける形に一本化する。
  // **projectDir が違う通知はここで捨てる**（誤配の根絶。保存は正しく進んでいるので、
  // そのプロジェクトを次に開けば全部見える）。
  useEffect(() => {
    let cancelled = false // このeffect（＝このprojectDir）が生きている間だけ setMessages してよい
    let reloading = false // 読み直しの連打防止（進行中なら重ねて読み直さない）
    const off = window.electronAPI.chat.onApplied(({ projectDir: dir, op, length }) => {
      if (dir !== projectDir) return // いま見ているプロジェクト宛てだけ受ける（誤配の根絶）
      let needsReload = false
      setMessages(prev => {
        const decision = viewSyncDecision(op as Op, prev.length, length)
        if (decision === 'reload') { needsReload = true; return prev }
        // ⚠️ stamp を二重に掛けない: convStore.ts（appliedOpFor）が、当てた直後の
        // stamp 済みメッセージに差し替えてから通知しているので、この op の msg には
        // 既に at が入っている。applyToMessages の stamp() は at が既にあれば上書きしない
        // （chatTime.ts の既存の性質）ので、そのまま当てて問題ない。
        return op.kind === 'replaceAll' ? op.messages : applyToMessages(prev, op as any)
      })
      if (needsReload && !reloading) {
        // 一致しない＝取りこぼした可能性がある（切替直後の読み込みと押し出しのすれ違い等）。
        // ストアから読み直して自己修復する。
        reloading = true
        loadConversationView(dir).then(msgs => {
          reloading = false
          if (!cancelled) setMessages(msgs)
        })
      }
    })
    return () => { cancelled = true; off() }
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
      // ⚠️ 作業フォルダ（public/ か直下か）の解決を**待ってから**送る（2026-08-29 実機で発覚）。
      // 解決は非同期（resolvePublishRoot）で、追いつくまでの currentAiRoot はプロジェクト直下へ
      // 倒れる。kickoff は自動送信のためほぼ確実に解決より先に走り、**ターン全体の writeRoot が
      // 直下**になって、AI の成果物が全部「公開されないもの」側へ入った。依頼の保留は
      // pendingNewProjectRef／モジュール退避が持っているので、aiRoot が解決した再評価
      // （deps の aiRoot 変化）でここへ戻ってくる。退避の消費より前に返ること（消費すると失われる）。
      if (aiRoot?.dir !== projectDir) return
      // データの出どころは2つ: ①イベントで直接受け取り済みのもの（pendingNewProjectRef）
      // ②イベントを取りこぼした場合の救済（newProjectRequest.ts のモジュール退避。「初めてのプロジェクト
      //   作成」では ChatPanel がまだマウントされておらずイベントの受け手が無いため、これが唯一の頼り）。
      // ⚠️ モジュール退避（②）は**必ず消費する**（2026-08-28 実機で発覚）。①（イベント経由の ref）で
      // 送れたときに②の写しが残っていると、ChatPanel の再マウント（モード切替）で二重送信ガードの
      // ref が消えたあと、②を拾って**同じ依頼をもう一度送ってしまう**（実機: 新規作成の23分後、
      // チャットモードから戻った瞬間に kickoff が再送され、AI が初期生成をやり直した）。
      const fromStash = takeNewProjectRequest(projectDir)
      const prompt = pendingNewProjectRef.current?.dir === projectDir
        ? pendingNewProjectRef.current.prompt
        : fromStash
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
  }, [apiKey, claudeActive, projectDir, chat, aiRoot])

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

  // 画面のどこかから「AIに頼む」を押されたとき（例: ③公開の「データが消えてしまいます」）。
  // **文面を入れてフォーカスするところまで**にし、送信は押さない。
  // 何を頼むのかを読んでから送れるようにする（勝手に送るとAIが動き出して費用も発生する）。
  useEffect(() => {
    const h = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text
      if (!text) return
      setInput(text)
      setTimeout(() => {
        const ta = textareaRef.current
        if (!ta) return
        ta.focus()
        ta.setSelectionRange(text.length, text.length)
      }, 50)
    }
    window.addEventListener('sakura:ask-ai', h)
    return () => window.removeEventListener('sakura:ask-ai', h)
  }, [])

  // ── 「AIに修正させる」（2026-08-19 Ryosuke 指定）────────────────────────
  // 公開前チェックの「見た目」に出るボタン。**相談ではなく、直しにいく。**
  // 上の `ask-ai`（文を入れるだけ）と違い、そのまま送る。押した人の意図が
  // 「直して」なので、もう一度送信を押させない。何を頼んだかは吹き出しに残る。
  useEffect(() => {
    const h = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text
      if (!text) return
      if (chat.isLoading) { setInput(text); return } // 応答中は割り込まず、入力欄に置く
      void chat.send(text, [])
    }
    window.addEventListener('sakura:fix-with-ai', h)
    return () => window.removeEventListener('sakura:fix-with-ai', h)
  }, [chat])

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
        applyOp({
          kind: 'append',
          msg: {
            role: 'assistant',
            content: `ℹ️ システムからのお知らせ：公開先を「${label}」に変更しました。今のコードがこの環境で動くか、次のメッセージでAIに確認してもらえます。環境によっては作り直しが必要な場合があります。`,
          },
        })
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
          applyOp({
            kind: 'append',
            msg: {
              role: 'assistant',
              content: `✅ 公開先を「${label}」に変更しました。この公開先には公開済みの実績があります${when ? `（${when} 公開）` : ''}。今のコードのままで再公開できます（③公開から）。${staleNote}`,
            },
          })
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
  }, [apiKey, projectDir, isLoading, chat, applyOp])

  // AIからの最初のあいさつ
  const greet = async () => {
    // AI Engineキーが無い（モードB＝Claudeのみ）場合は、greetのためだけにAPIを呼ばず固定文を出す。
    // Claude自身へのあいさつ生成委譲はしない（greetはAI Engineクライアント専用の従来経路のため）。
    if (!apiKey) {
      applyOp({ kind: 'replaceAll', messages: [{ role: 'assistant', content: 'こんにちは！つくりたいものを日本語で教えてください。' }] })
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
      // ⚠️ ここは kind:'replaceLast' ではなく 'replaceAll' を使う。replaceLast は
      // applyToMessages が stamp() を通す（at が無ければ現在時刻を付ける）ため、この吹き出しに
      // 今まで無かった時刻表示（吹き出し下のホバー時刻・日付区切り）が新しく出てしまう
      // （元の実装は素の setMessages で at を一切付けていなかった。「振る舞いを変えない」を
      //  優先し、stamp を経由しない replaceAll で同じ中身をそのまま送る＝仕様書で迷った点）。
      applyOp({ kind: 'replaceAll', messages: [{ role: 'user', content: kickoff, hidden: true }, { role: 'assistant', content: '' }] })
      const { usage } = await window.electronAPI.sakura.chatStream(
        {
          apiKey,
          model,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: kickoff }],
          maxTokens: 700,
        },
        (delta) => {
          text += delta
          applyOp({ kind: 'replaceAll', messages: [{ role: 'user', content: kickoff, hidden: true }, { role: 'assistant', content: text }] })
        },
        (abort) => { greetAbortRef.current = abort },
      )
      recordUsage(apiKey, model, usage?.prompt_tokens ?? estimateTokens(sys + kickoff), usage?.completion_tokens ?? estimateTokens(text))
    } catch (e: any) {
      // 所見22: あいさつ失敗は致命的でないため、生エラーは出さず穏当な固定文言にフォールバックする。
      // 原因把握のためログにだけ整形済みエラー（formatChatError）を残す。
      console.warn('greet failed:', formatChatError(e?.message ?? String(e)))
      applyOp({ kind: 'replaceAll', messages: [{ role: 'assistant', content: '（あいさつを準備できませんでした。つくりたいものを教えてください。）' }] })
    } finally {
      greetAbortRef.current = null
      setGreetLoading(false)
    }
  }

  /**
   * 送信。**印が付いていれば、ここで画像をプロジェクトへ入れる**（2026-08-19）。
   *
   * 入れたことは AI にだけ添える（画面には出さない）。以前は入力欄に説明文を
   * 差し込んでいたが、利用者が打った文と混ざって読みにくかった。
   */
  const send = useCallback(async () => {
    const text = input
    const attached = pendingImages
    const images = attached.map(p => p.url)
    if ((!text.trim() && images.length === 0) || isLoading) return
    const choice = assetChoice
    setInput('')
    setPendingImages([])
    setAssetChoice(null)

    let forAi = ''
    if (choice && projectDir && attached.length) {
      const { done, failed } = await putIntoProject(attached, choice)
      forAi = done.map(rel => tellAiAboutAsset(rel, choice)).join('\n')
      // このターンは forAi で届く。**次のターン以降も覚えておく**ため履歴にも残す
      // （画面には出さない。getHistory は hidden を AI へ送る・toolNote は送らない）
      if (forAi) applyOp({ kind: 'append', msg: { role: 'user', content: forAi, hidden: true } })
      // 入れられなかったときだけ画面に出す（黙って落とさない）
      if (failed.length) {
        applyOp({
          kind: 'append',
          msg: {
            role: 'assistant', toolNote: true,
            content: `⚠️ ${failed.length}枚をプロジェクトに入れられませんでした: ${failed[0]}`,
          },
        })
      }
    }
    // ── 保存していない画像の案内は、Koto が出す（2026-08-19 実機・Ryosuke 指摘）──
    // AI に案内させると、**古い会話を真似て長い手順**を書いた。文面は毎回同じで
    // よいので Koto が出す。AI には「保存のしかたを説明するな」とだけ伝える。
    const needHint = !choice && projectDir && attached.length > 0
    if (needHint) {
      forAi = [forAi, '（Koto より）この画像はまだプロジェクトに保存されていません。'
        + '保存のしかた・ボタン名・手順は説明しないでください（Koto が画面で案内します）。'
        + '保存が要る作業は行わず、「この画像を使うには保存が必要です」と1文だけ伝えてください。'].filter(Boolean).join('\n')
    }
    const turn = chat.send(text, images, forAi || undefined)
    // 案内は**AIの返事のあと**に置く（先に出すと、返事に埋もれて読まれない）
    if (needHint) void turn.then(() => applyOp({
      kind: 'append',
      msg: { role: 'assistant', toolNote: true, content: useImageHint(attached.length) },
    }))
  }, [input, pendingImages, isLoading, chat, assetChoice, projectDir, putIntoProject, applyOp])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void send()
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
          <a href="https://ai.sakura.ad.jp/" className="text-sakura-soft hover:underline">さくらのAI Engine</a> で取得 ・ ⇧⌘, でも開けます
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
          {/* 🗂 手動で区切る（2026-08-20 Ryosuke 要望）。自動は約47往復を超えないと働かないので、
              ほとんどの人は一度も見ない。押しても意味が無いうちは出さない（掟5）。
              Claude頭脳モードでは Koto から履歴を送らないので、まとめても使い道が無い＝出さない。 */}
          {!claudeActive && canCompactNow(messages) && (
            <button
              onClick={() => void chat.compactNow()}
              disabled={isLoading}
              className="text-[11px] text-ink-secondary hover:text-ink border border-line rounded-md px-1.5 py-0.5 whitespace-nowrap disabled:opacity-50"
              title="これまでのやり取りをひとつにまとめて、AIに渡す量を減らします（直近3往復はそのまま残ります。会話は消えません）"
            >🗂 まとめる</button>
          )}
          <button
            onClick={() => {
              // 🗂 まとめは「AIの発言」ではないので、そう見えないように書き出す。
              const text = messages.filter(m => !m.hidden)
                .map(m => m.summary
                  ? `${COMPACT_NOTE}\n${m.content}`
                  : `${m.role === 'user' ? '🧑 あなた' : 'AI'}:\n${m.content}`).join('\n\n')
              navigator.clipboard.writeText(text)
            }}
            className="text-xs text-ink-muted hover:text-ink"
            title="会話全体をコピー"
          >📋</button>
          <button
            onClick={() => {
              if (messages.filter(m => !m.hidden).length === 0) return
              if (window.confirm('この会話をすべて削除します。よろしいですか？（元に戻せません）')) applyOp({ kind: 'replaceAll', messages: [] })
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


      {/* Messages */}
      <div
        className="flex-1 overflow-y-auto p-3 space-y-3 relative"
        // ── 二重に受け取らない（2026-08-19 実機）──────────────────────────
        // 画面全体でも受けるようにしたため、ここで止めないと**同じ画像が2枚**添付される
        // （ここで addImages → 画面全体の受け口へ伝わって、もう一度 addImages）。
        // **止めるのは落としたときだけ。** 重なっている合図は上へ流す
        //（結果は同じ「AIに見せる」なので、案内は画面全体のものひとつでよい）。
        onDrop={e => {
          e.preventDefault(); e.stopPropagation()
          if (e.dataTransfer.files?.length) addImages(e.dataTransfer.files)
        }}
      >
        {messages.filter(m => !m.hidden).length === 0 && !isLoading && (
          <div className="text-center text-ink-muted text-xs py-6">
            <div className="flex justify-center mb-2"><SakuraLogo size={32} /></div>
            <p>{claudeActive ? 'Claudeに質問してください' : 'さくらのAI Engineに質問してください'}</p>
            <p className="mt-1">⌘+Enter で送信</p>
          </div>
        )}
        {(() => {
          const shown = messages.filter(m => !m.hidden)
          // 会話がいつのものか分かるように、日付が変わったところ／記録が無い古い会話の先頭に区切りを出す（利用者要望）。
          const marks = timelineMarks(shown, new Date())
          return shown.map((msg, i) => {
            const mark = marks[i]
            const line = (text: string, key: string) => (
              <div className="flex items-center gap-2 py-1" aria-hidden key={key}>
                <div className="flex-1 h-px bg-line" />
                <span className="text-[11px] text-ink-muted">{text}</span>
                <div className="flex-1 h-px bg-line" />
              </div>
            )
            // 境目では**2本**出す。1本にまとめて日付を潰すと、記録がある最初の会話が
            // 「いつのものか分からない」ままになる（2026-08-26 画面で気づいた）。
            const separator = mark.kind === 'none' ? null : mark.kind === 'unknown'
              ? <React.Fragment key={`mark-${i}`}>{line('日時の記録がありません', `u-${i}`)}{line(mark.label, `d-${i}`)}</React.Fragment>
              : line(mark.label, `mark-${i}`)
            // 🗂 会話のまとめ。吹き出しではなく、区切りとして中央に出す（本文は折りたたみ）。
            if (msg.summary) return <React.Fragment key={i}>{separator}<CompactNote text={msg.content} projectDir={projectDir} /></React.Fragment>
            // 応答待ち/思考中の空のアシスタント吹き出しは描画しない（「…」インジケータで代替し、空箱が出ないようにする）。
            if (msg.role === 'assistant' && !msg.content.trim() && !msg.images?.length) return <React.Fragment key={i}>{separator}</React.Fragment>
            return (
              <React.Fragment key={i}>
                {separator}
                <div className={`group flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[90%] flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                  <div className={`relative w-full rounded-2xl px-3 py-2 text-sm select-text ${
                    msg.role === 'user'
                      ? 'sakura-gradient text-white rounded-tr-md'
                      : 'bg-elevated border border-line text-ink rounded-tl-md'
                  }`}>
                    <MessageCopyButton text={msg.content} side={msg.role === 'user' ? 'left' : 'right'} />
                    {msg.images && msg.images.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-1.5">
                        {/* ── 送信したあとも入れられる（2026-08-19 実機）────────────────
                            送信すると添付欄は空になるので、ここが唯一の拠り所になる。
                            こちらは押した時点で入れる（送信を待つ理由が無いため）。 */}
                        {msg.images.map((src, k) => {
                          const name = defaultImageName(mediaTypeOf(src))
                          return (
                          <React.Fragment key={k}>
                            <span className="inline-flex flex-col items-stretch">
                              <img src={src} alt="" className="max-h-32 rounded-lg border border-white/30 object-cover" />
                              {/* 入れ終わった画像には出さない（押すと同じ画像がもう1枚増える） */}
                              {projectDir && !savedImages.has(src) && (
                                <AssetUseButton onClick={() => void importFromMessage({ url: src, name })} />
                              )}
                            </span>
                          </React.Fragment>
                          )
                        })}
                      </div>
                    )}
                    {/* 推論モデルの思考（表示専用）。生成中はライブ表示、終わったら自動で畳む。
                        live 判定: 最後の吹き出しかつ応答中＝いま流れているもの。 */}
                    {msg.role === 'assistant' && msg.thinking && (
                      <ThinkingBlock text={msg.thinking} live={isLoading && i === messages.length - 1} />
                    )}
                    {msg.role === 'assistant' ? (
                      // コードカードの「💾 プロジェクトに保存」も write_file と同じ穴を持っていた
                      // （2026-08-27 発見）。ここで公開の根（currentAiRoot）を結んで渡す。
                      <AiMessage content={msg.content} onApplyFile={onApplyFile ? (rel, content) => onApplyFile(rel, content, currentAiRoot) : undefined} />
                    ) : (
                      msg.content && <p className={CHAT_TEXT_WRAP}>{msg.content}</p>
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
                  {/* 触れたら吹き出しの下に時刻。OS のツールチップ（title）は
                      出るまでに間があり、少し動かすと消えるのでやめた（2026-08-26 実機）。 */}
                  {bubbleTime(msg.at) && (
                    <span className="mt-0.5 px-1 text-[11px] text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity">
                      {bubbleTime(msg.at)}
                    </span>
                  )}
                  </div>
                </div>
              </React.Fragment>
            )
          })
        })()}
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
      {/* 🗂 フォルダの整理（2026-08-20）。**会話の中に置かない。**
          最初は会話のいちばん上に出していたが、やり取りが多いプロジェクトでは
          スクロールの外に行き、実機で「実装されていないように見える」状態になった。
          常に見える場所（入力欄の直上）へ置く。 */}
      {migratePlan && (
        <div className="border-t border-line px-3 pt-3 flex-none">
          <MigrateNotice plan={migratePlan} onRun={runMigrate} />
        </div>
      )}
      {/* ── 送るときの扱い（2026-08-25 Ryosuke 提案）────────────────────────
          最初はヘッダーに並べたが、**横に長くなりすぎて窓を狭めると隠れた**。
          この2つは「誰が答えるか」（モデル・頭脳）ではなく
          **「送るとどう扱われるか」**なので、**送る場所の隣**に置く。
          🗂 フォルダの整理を入力欄の直上へ移したときと同じ理由——
          **常に見える場所に置く**（会話が流れても隠れない）。 */}
      <div className="border-t border-line px-3 pt-2 flex-none flex items-center gap-2 flex-wrap">
        <button
          onClick={toggleWriteMode}
          className="text-[11px] text-ink-muted hover:text-ink border border-line rounded-md px-1.5 py-0.5 whitespace-nowrap"
          title={writeMode === 'auto'
            ? 'AIのファイル保存：おまかせ（自動保存）。クリックで「毎回確認」に切替'
            : 'AIのファイル保存：毎回確認（保存前に許可を求める）。クリックで「おまかせ」に切替'}
        >{writeMode === 'auto' ? '🪄 おまかせ' : '✋ 毎回確認'}</button>
        {/* 📚 資料を使うか（2026-08-25 Ryosuke と設計）。
            **設定はプロジェクトごとなのに、使う場所に一度も出ていなかった。**
            資料の画面（アプリ全体の管理）から、ここへ移した。
            **資料が0件でも出す**——「これはなんだろう？」と触って気づく道を残す
            （Ryosuke 判断）。ただし押しても何も起きないボタンにはしない。 */}
        {projectDir && (
          <button
            onClick={toggleRag}
            disabled={ragBusy}
            className={`text-[11px] border rounded-md px-1.5 py-0.5 whitespace-nowrap disabled:opacity-50 ${
              ragEnabled ? 'text-ink border-sakura' : 'text-ink-muted hover:text-ink border-line'
            }`}
            title={ragEnabled
              ? '📚 資料：このプロジェクトのチャットで資料を使っています。クリックで使わないに切替'
              : '📚 資料：このプロジェクトのチャットで資料を使いません。クリックで使うに切替'}
          >{ragEnabled ? '📚 資料を使う' : '📚 資料を使わない'}</button>
        )}
      </div>
      <div className="px-3 pt-2 pb-3 flex-none">
        <div className="flex flex-col gap-2 bg-elevated rounded-xl border border-line focus-within:border-sakura transition-colors p-2">
          {/* 添付画像のプレビュー */}
          {pendingImages.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1">
              {/* ── プロジェクトに入れる（2026-08-19 Ryosuke 提案）────────────────
                  これまで画像は**AIに見せるだけ**で、プロジェクトには残らなかった。
                  アプリの部品として使いたいことがある。**毎回選ばせない**ため、
                  押した人にだけ「どちらに入れるか」を聞く。 */}
              {pendingImages.map((img, i) => (
                <div key={i} className="relative">
                  <img src={img.url} alt="" className="h-16 w-16 object-cover rounded-lg border border-line" />
                  <button
                    onClick={() => setPendingImages(prev => prev.filter((_, k) => k !== i))}
                    className="absolute -top-1.5 -right-1.5 bg-base border border-line text-ink-muted hover:text-sakura rounded-full w-5 h-5 flex items-center justify-center text-[11px]"
                    title="削除"
                  >×</button>
                </div>
              ))}
              {/* Claudeが実際にこのターンの画像を直接処理する場合（プロジェクトを開いていてClaude頭脳が有効）は、
                  AI Engineの視覚モデルへの委譲は発生しないため、この案内は出さない（C2d）。 */}
              {/* ── 実際の動きを書く（2026-08-19 Ryosuke 指摘）──────────────────
                  IDEモードは**二段構え**（視覚モデルが画像を読み取り、続きは
                  いまのモデルが行う。ツールを使えるようにするため）。
                  「画像対応モデルで処理します」だと、モデルが丸ごと入れ替わるように
                  読める。**実装と文面がずれていた。** */}
              {!(claudeActive && projectDir) && !shouldTryImagesDirectly(model) && (
                <span className="self-center text-[11px] text-ink-muted">
                  「{modelLabel(model)}」は画像を扱えないため、送信すると
                  「{modelLabel(getDefaultVisionModel())}」が読み取り、
                  続きは「{modelLabel(model)}」が行います
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
            // ── 注意書きを入れない（2026-08-19 Ryosuke 指摘）────────────────
            //「メッセージを入力と、欄の左下のクリップマークだけで良い」
            // 使い方は 📎 のツールチップと、落としたときの案内で伝わる。
            // 入力欄は**打つ場所**であって、説明の置き場ではない。
            placeholder="メッセージを入力…"
            rows={3}
            className="flex-1 bg-transparent px-1 py-0.5 text-sm text-ink placeholder-ink-muted outline-none resize-none"
          />
          {/* ── 押す場所は「送信」のとなり（2026-08-19 Ryosuke 指摘）──────────────
              サムネイルの上に置いていたが、**画像の上にボタンがあるのは分かりにくい**。
              添付したときだけ、📎 と 送信 の間に出す。選ぶ画面はそのすぐ上に開く。 */}
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
            {projectDir && pendingImages.length > 0 && (
              <AssetUseCheckbox
                checked={assetChoice === 'app'}
                count={pendingImages.length}
                // 入れるのは【送信】のとき（ここでは印を付けるだけ）
                onChange={next => setAssetChoice(next ? 'app' : null)}
              />
            )}
            <div className="flex-1" />
            {isLoading ? (
              <button
                onClick={() => { chat.abort(); greetAbortRef.current?.() }}
                className="bg-elevated border border-brand-red text-brand-red rounded-lg px-3 py-1.5 text-sm font-semibold hover:bg-brand-red-fill hover:text-white transition-colors"
                title="応答を停止"
              >
                ⏹ 停止
              </button>
            ) : (
              <button
                onClick={() => void send()}
                title="送信（⌘+Enter）"
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
