import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { getTargetProfile, isAutoPublishTarget } from '../targetProfiles'
import StorageNotice from './StorageNotice'
import { canForgetRow, PUBLISH_TARGET_CONSOLE, PUBLISH_TARGET_LABEL, buildPublishStatusRows, isStale, formatPublishedAt, parseApprunLegacy, judgePendingPublish, pendingPublishMessage, latestPublishedTarget, isKnownPublishTarget, type PendingPublish, type PublishTargetKind } from '../publishStatus'
import { mergeProjectMetaThenLoad, forgetPublishTargetThenLoad, dismissInterruptedPublish, loadPublishSnapshot, rentalPublishPatch, type PublishSnapshot } from '../projectMeta'
import { rsyncExcludeArgs } from '../../shared/publishExclude'
import SecurityCheckSection from './SecurityCheckSection'
import UnusedFilesSection from './UnusedFilesSection'
import AppRunPanel from './AppRunPanel'
import HanamiiPanel from './HanamiiPanel'
import VercelPanel from './VercelPanel'
import VpsPanel from './VpsPanel'
import AppRunDedicatedPanel from './AppRunDedicatedPanel'
import { resolvePublishRoot } from '../publishRootRenderer'
// 記録を読む・「見た」と伝える・誰の持ち場か決める・警告と時刻の文にする、は共通の1か所（掟10・2026-09-30 検分の指摘2）。
import { watchProjectOps, sendAck, unseenOf, visiblePanelShows, holdsWarning, type OpsWatch } from '../projectOpsView'
import { warningLine } from '../../shared/opsText'

// 「🚀 公開」モーダル：
// - .sakuraide.json の公開先・設定を読み、フォーム入力（次回から再入力不要）
// - 前提チェック（rsync / docker）を行い、足りなければ日本語で案内
// - 公開コマンドをIDE内ターミナルへ流して実行（進行が見える・パスワードも入力できる）

// sakura-vps は targetProfiles.COMING_SOON_TARGETS に残したまま（新規プロジェクトの公開先
// 選択やワークフローバーの切替では出さない。①接続（VpsPanel）まではこの画面から到達できる）。
// sakura-apprun-dedicated も COMING_SOON_TARGETS に残したまま（同上）だが、この画面では
// 「📦 さくらのAppRun」の1行から選んだ後、共用型/専有型のタブで切り替えて到達する（roadmap #24）。
// クラスタの作成・破棄はできるが、アプリケーションの公開（独自ドメイン）はまだ実装していない。
type Target = 'sakura-rental' | 'sakura-apprun' | 'hanamii' | 'vercel' | 'sakura-vps' | 'sakura-apprun-dedicated'

// 統一公開記録（publish.targets）: 複数の公開先へ公開した履歴を一元管理する。
// 書き込みは各公開フローの成功時（HanamiiPanel/AppRunPanel/VercelPanel/このファイルの publishRental）。
// 既存の publish.* フィールド（account/host/lastPublishedAt 等）はそのまま残す（StatusBar 互換）。
// 公開先の種類（PublishTargetKind）の唯一の定義は src/renderer/publishStatus.ts。ここに複製しない
// （掟10。D-3・2026-09-11 で専有型を足した際、ここにあった複製を消して import に切り替えた）。
interface PublishTargetRecord {
  publishedAt: string | null
  url: string | null
}

interface Meta {
  name?: string
  description?: string
  base?: string
  target?: string
  publish?: {
    account?: string  // レンサバ: アカウント名
    host?: string     // レンサバ: ホスト名（例 account.sakura.ne.jp）
    registry?: string // AppRun: コンテナレジストリ名
    appName?: string  // AppRun: イメージ名
    url?: string             // 公開URL（レンサバ）／イメージURI（AppRun）
    lastPublishedAt?: string // 最後に公開操作を実行した日時（ISO）
    targets?: Partial<Record<PublishTargetKind, PublishTargetRecord>>
    hanamii?: { projectId?: string | null }
    // 公開開始マーカー（中断・失敗の検知用。main が書く・消す＝src/main/publishMetaFs.ts の markPendingFs / clearPendingFs）。
    pending?: PendingPublish | null
  }
}

interface Props {
  projectDir: string
  apiKey: string // 公開前セキュリティチェック（AIレビュー）に使用
  onClose: () => void
  onRun: (cmd: string) => void
  onOpenCredentials: () => void
  /** 「📡 公開したもの一覧」（全プロジェクト横断）を開く。メニュー「表示」からも開ける同じ画面。 */
  onOpenPublishedList?: () => void
}

const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9.-]*$/

// ── 処理の記録（main のメモリ上・window.electronAPI.projectOps）を画面に出すための小さな道具 ──────
// （2026-09-29・作者の決定 ①②。記録の本体は src/main/projectOps.ts。ここに型や意味を複製しない。）

/** 「聞き直す」間隔。既存の3秒のポーリングと共用する（走っているかを、開いている間も聞き直す）。 */
const OPS_POLL_MS = 3000

/** 画面に出す「経過」の文（純関数）。 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}秒`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s === 0 ? `${m}分` : `${m}分${s}秒`
}

/** どの公開先の操作か（記録の target が公開先の種類でない＝'unknown' のときは、公開先を名指ししない）。 */
function opTargetName(rec: ProjectOpRecordShape): string {
  return isKnownPublishTarget(rec.target) ? PUBLISH_TARGET_LABEL[rec.target] : 'このプロジェクト'
}

/**
 * 終わった記録を、画面が持っている分へ足す（純関数）。**startedAt が記録の識別子**（同じプロジェクトで必ず増える）。
 * すでに持っているものは足さない。古い順に並べる。
 */
function mergeFinished(held: ProjectOpRecordShape[], incoming: ProjectOpRecordShape[]): ProjectOpRecordShape[] {
  const fresh = incoming.filter(r => r && !held.some(h => h.startedAt === r.startedAt))
  if (fresh.length === 0) return held
  return [...held, ...fresh].sort((a, b) => a.startedAt - b.startedAt)
}

export default function PublishModal({ projectDir, apiKey, onClose, onRun, onOpenCredentials, onOpenPublishedList }: Props) {
  const [meta, setMeta] = useState<Meta>({})
  const [target, setTarget] = useState<Target | null>(null)
  const [loaded, setLoaded] = useState(false)
  // 共用型／専有型のタブは、以前は三項演算子で出し分けていたため、行き来するたびに
  // パネルが丸ごと作り直され、⑦ログ・メトリクス（GET 6本）と⑧を取り直したうえ、
  // ③「🔍 調べる」の結果（limits/plans/clusters/conn）が state ごと消えていた
  // （2026-09-23 検分の指摘5）。一度開いたパネルは**外さずに CSS で隠す**ことで、
  // 戻ってきたときに取り直さない。まだ一度も開いていないパネルは描かない——専有型は
  // 上級者向けなので、使わない利用者に⑦の GET 6本を払わせないため。
  const [mountedApprunTabs, setMountedApprunTabs] = useState<Partial<Record<'sakura-apprun' | 'sakura-apprun-dedicated', true>>>({})
  useEffect(() => {
    if (target === 'sakura-apprun' || target === 'sakura-apprun-dedicated') {
      setMountedApprunTabs(prev => (prev[target] ? prev : { ...prev, [target]: true }))
    }
  }, [target])
  // レンサバ用
  const [account, setAccount] = useState('')
  const [host, setHost] = useState('')
  const [hostEdited, setHostEdited] = useState(false)
  // 状態
  const [error, setError] = useState('')
  // 前提ツールが見つからない場合の初心者向け案内（rsync）
  const [missingTool, setMissingTool] = useState<'rsync' | null>(null)
  const [copied, setCopied] = useState(false)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  // 公開状況一覧（③公開 冒頭の「このプロジェクトの公開状況」ボックス用）。プロジェクトの最終変更時刻は1回だけ取得する。
  const [latestChangeAt, setLatestChangeAt] = useState<string | null>(null)
  const [apprunLegacy, setApprunLegacy] = useState<{ createdAt: string | null } | null>(null)

  // 公開の実行。🛡 簡易セキュリティチェックは**自動では走らせない**
  // （2026-08-21 Ryosuke 指定: 毎回は不要。確認したい時に各公開先の 🛡 節から手動で実行する）
  const startPublish = async (cmd: string) => {
    // **送る直前に koto-data を置く**（2026-09-23 検分）。AI への指示は
    // 「Koto が用意します」と約束しているので、公開の直前にも約束を果たす。
    // **既にあれば触らないので、何度押しても安全。**
    try { await window.electronAPI.storage.ensureLayer(projectDir) } catch { /* 置けなくても公開は続ける */ }
    onRun(cmd)
    setRunning(true)
  }

  const projName = projectDir.split('/').pop() ?? 'app'
  const rentalServiceUrl = getTargetProfile('sakura-rental').serviceUrl

  // 公開開始マーカー（publish.pending）の見せ方（Part2 ＋ 2026-09-29）。
  // 公開の本体は main の1回の IPC で最後まで進む（この画面を閉じて開き直しても走り続ける）ので、
  // 「pending が古い」だけで「中断」と決めない。**いま main が公開を走らせているか**（main の鍵・
  // `publishMeta:runningOp`）と合わせて、進行中／中断の可能性／なし、の3通りに出し分ける
  // （src/renderer/publishStatus.ts の judgePendingPublish）。
  const [runningOp, setRunningOp] = useState<'作成' | '削除' | '公開' | null>(null)
  const pendingView = useMemo(
    () => judgePendingPublish(meta.publish ?? {}, runningOp, Date.now()),
    [meta.publish, runningOp],
  )

  // 画面が持つ「いま走っているか」と「記録」を**必ず対で**入れる唯一の口（2026-09-29 検分）。
  // 記録だけを取り込むと、ディスクの pending と、前に聞いた「走っていない」が食い違い、走っている公開自身の印を
  // 「中断の可能性」と誤る。この画面では setMeta をここでしか呼ばない（tests/publishPendingView.test.ts が固定）。
  const applySnapshot = useCallback((snap: PublishSnapshot) => {
    setRunningOp(snap.runningOp)
    setMeta(snap.meta as Meta)
  }, [])

  // 「いま走っているか」と記録を読み直す。**走っているかを先に聞く**（順序は loadPublishSnapshot が守る）。
  const refreshPublishState = useCallback(async () => {
    const snap = await loadPublishSnapshot(projectDir)
    applySnapshot(snap)
    return snap.meta as Meta
  }, [projectDir, applySnapshot])

  // 「確認しました」: 中断の可能性の印（publish.pending）を消す。**いま公開が走っているあいだは main が断る**
  // ので、断られたときは消さずに、いまの状態を読み直す（→「進んでいます」の表示になる）。
  const dismissInterruptedNotice = async () => {
    await dismissInterruptedPublish(projectDir)
    await refreshPublishState()
  }

  // ── 処理の記録（projectOps）: 走っている操作・終わってまだ見られていない結果 ──────────────────────
  // 公開・破棄・作成の本体は main の1回の IPC で最後まで進む。この画面を閉じても止まらない。
  // 失われていたのは**画面の表示だけ**（進み具合・結果・「月額が続きます」のような警告）なので、
  // 開いたときに main の記録を読んで続きを出す（作者の決定 ①②・2026-09-29）。
  // 記録は projectDir ごと（掟11）。走っているのが別の公開先の操作でも、このプロジェクトの鍵は1つなので
  // 見せる（どの公開先の何かは文に書く）。
  const [opsRunning, setOpsRunning] = useState<ProjectOpRecordShape | null>(null)
  // main の記録を、少なくとも1回は受け取ったか（それまでは「走っていない」とも言えない）。
  const [opsKnown, setOpsKnown] = useState(false)
  // 終わった結果。**利用者が「確認しました」を押すまで手元に持つ**——各パネルが先に「見た」と伝えても
  // （ack）、この画面の表示は消さない（隠れたタブのパネルが先に伝えて、利用者は何も見ていない、を防ぐ）。
  // ただし**上部に出すのは、目の前の公開先の画面が出していないものだけ**（下の topResults）。
  const [heldResults, setHeldResults] = useState<ProjectOpRecordShape[]>([])
  // 目の前の公開先の画面が出した（＝利用者が見た）結果。あとで別の画面へ移っても、上部に出し直さない
  // （利用者が画面の前で見ていた結果を、「確認しました」を押すまで残さない・二重表示の解消）。
  const seenInPanel = useRef<Set<number>>(new Set())
  const opsWatch = useRef<OpsWatch | null>(null)

  const applyOps = useCallback((s: ProjectOpsSnapshotShape) => {
    setOpsKnown(true)
    setOpsRunning(s.running ?? null)
    const finished = unseenOf(s)
    if (finished.length > 0) setHeldResults(prev => mergeFinished(prev, finished))
  }, [])

  // 開いたとき1回聞き、開いている間は押し出しを受ける（共通の watchProjectOps。別のプロジェクトの知らせは無視し、
  // 押し出しより古い応答は捨てる・掟11）。開いている間の聞き直しは下の3秒ごとの effect。
  useEffect(() => {
    setOpsRunning(null)
    setOpsKnown(false)
    setHeldResults(prev => (prev.length === 0 ? prev : []))
    seenInPanel.current = new Set()
    let watch: OpsWatch | null = null
    try {
      watch = watchProjectOps(window.electronAPI.projectOps, projectDir, applyOps)
    } catch { /* preload 未注入。何も出ないだけで、公開そのものは動く */ }
    opsWatch.current = watch
    return () => { watch?.stop(); if (opsWatch.current === watch) opsWatch.current = null }
  }, [projectDir, applyOps])

  // ── 上部に出すもの（二重表示の解消・2026-09-30 検分の指摘3）──────────────────────────────
  // 進み具合・結果は、**目の前の公開先の画面が自分の画面に出すもの**は、ここでは重ねて出さない
  // （HANAMII・Vercel・共用型・専有型の各画面が、自分の記録の進み具合と結果を出している。
  //  以前は上部にも同じ段が出て、利用者が画面の前で見ていた結果まで「確認しました」を押すまで残った）。
  // ここが出すのは、**どの画面も出さない**もの: 別の公開先の操作・目の前に無い（隠れたタブの・閉じた）画面の分・
  // 公開先を選ぶ前・レンタルサーバ。**別の公開先の警告（月額が続くなど）を見逃さないための最後の受け皿**。
  // 誰の持ち場かは共通の visiblePanelShows（projectOpsView.ts の1か所）。読み込み前（公開先が決まる前）は出さない。
  //
  // ⚠️ ただし**警告つきの結果は、目の前の画面が出していても、ここにも出す**（2026-09-30 検分の指摘）。各パネルは結果を
  // 公開ボタンのずっと下（①〜④の下・⑥⑧の節の中）に出すので、スクロールせずに閉じると、見せたことにならないのに
  // 「見た」と伝えて、月額が続く警告が二度と出なくなった。警告つきの記録は、パネルは「見た」と伝えず
  // （ackUpToFor が止める）、**ここで「結果を確認しました」を押されたときにだけ**見たことにする
  // （作者の決定 ②「閉じて開き直しても、『確認しました』を押すまで出る」）。
  const topRunning = loaded && opsRunning && !visiblePanelShows(target, opsRunning) ? opsRunning : null
  const topResults = loaded
    ? heldResults.filter(r => holdsWarning(r) || (!visiblePanelShows(target, r) && !seenInPanel.current.has(r.startedAt)))
    : []
  useEffect(() => {
    if (!loaded) return
    for (const r of heldResults) if (visiblePanelShows(target, r)) seenInPanel.current.add(r.startedAt)
  }, [loaded, target, heldResults])

  // 「確認しました」: 上部に見せた結果を、見たことにする。**見せた記録の startedAt まで**を伝える
  // （見せている間に次の操作が終わっても、その結果まで消さない）。
  const acknowledgeResults = () => {
    if (topResults.length === 0) return
    const newest = Math.max(...topResults.map(r => r.startedAt))
    setHeldResults(prev => prev.filter(r => r.startedAt > newest))
    try { sendAck(window.electronAPI.projectOps, projectDir, newest) } catch { /* 伝えられなくても、次に開いたとき見える（見逃すより安全） */ }
  }

  // 何かが走っているか。main の記録（projectOps）か、既存の runningOp のどちらかが「走っている」と言えば走っている。
  const opRunning = opsRunning !== null || runningOp !== null
  // 走っている間は、**画面の外のクリックでは閉じない**（作者の決定 ①・2026-09-29）。✗ は押せば閉じる。
  // レンタルサーバの公開（ターミナルで進む）は main の記録に載らない（withProjectLock を通らない）ので対象外:
  // 進みはこの画面の外のターミナルにあり、閉じても隠れるものがない。むしろ画面の外をクリックして
  // ターミナルを見る、が自然な動きなので、閉じられないようにしない。
  const handleBackdropClick = () => { if (!opRunning) onClose() }

  // main の記録（projectOps）が「走っていない」と言うのに、既存の runningOp（開いたときに聞いた古い答え）が
  // 「走っている」のままなら、読み直す。main は終わりに記録（publish.targets・専有型の資源ID）を書くので、
  // 公開状況の一覧も更新される。読み直さないと、終わったのに外側をクリックしても閉じない（次の3秒の聞き直しまで）。
  useEffect(() => {
    if (opsKnown && opsRunning === null && runningOp !== null) void refreshPublishState()
  }, [opsKnown, opsRunning, runningOp, refreshPublishState])

  // 走っているか・記録は、開いている間も数秒ごとに聞き直す（押し出しが届かなかったときの保険）。
  // 既存の「公開が走っているあいだ、終わるのを待って表示を更新する」ポーリングと共用する。
  // 終わったら（走っている操作の名前が変わったら）ディスクの記録を読み直す——main は終わりに記録
  // （publish.targets・専有型の資源ID）を書いているので、公開状況の一覧も更新する。
  useEffect(() => {
    const id = window.setInterval(async () => {
      void opsWatch.current?.refresh()
      if (runningOp === null) return
      const snap = await loadPublishSnapshot(projectDir)
      if (snap.runningOp !== runningOp) applySnapshot(snap)
    }, OPS_POLL_MS)
    return () => window.clearInterval(id)
  }, [runningOp, projectDir, applySnapshot])

  // 既存の設定を読み込む
  useEffect(() => {
    ;(async () => {
      // 走っているかを先に聞いてから、記録を読む（loadPublishSnapshot）。
      const snap = await loadPublishSnapshot(projectDir)
      const m = snap.meta as Meta
      applySnapshot(snap)
      // 最初に開く画面は「最後に公開した公開先」（2026-07-31 ユーザー要望）。
      // 公開実績が無ければ、従来どおりプロジェクトに設定された公開先（meta.target）を使う。
      const last = latestPublishedTarget(m.publish)
      if (last) setTarget(last)
      else if (m.target === 'sakura-rental' || m.target === 'sakura-apprun' || m.target === 'hanamii' || m.target === 'vercel' || m.target === 'sakura-vps' || m.target === 'sakura-apprun-dedicated') setTarget(m.target)
      setAccount(m.publish?.account ?? '')
      setHost(m.publish?.host ?? '')
      setHostEdited(!!m.publish?.host)
      setLoaded(true)
      // 公開状況ボックス用: プロジェクトの最終変更時刻をモーダルを開いた時に1回だけ取得する。
      try {
        const r = await window.electronAPI.fs.latestChangeAt(projectDir)
        setLatestChangeAt(r.ok ? r.latest : null)
      } catch { setLatestChangeAt(null) }
      // AppRun のレガシー実績（publish.targets 導入前の構築）を .sakura-cloud/state.json から救済
      try {
        const raw = await window.electronAPI.fs.readFile(`${projectDir}/.sakura-cloud/state.json`)
        setApprunLegacy(parseApprunLegacy(JSON.parse(raw)))
      } catch { setApprunLegacy(null) }
    })()
  }, [projectDir])

  // アカウント名からホスト名を自動補完（手で編集したら追従しない）
  useEffect(() => {
    if (!hostEdited && account) setHost(`${account}.sakura.ne.jp`)
  }, [account, hostEdited])

  // **差分だけ**を main へ渡す。main が書く直前にディスクから読み直して当てて書く
  // （src/renderer/projectMeta.ts）。以前は、この画面を開いたときに読んだ `meta`（古い写し）で
  // .sakuraide.json 全体を書き戻していた。開いている間に main が書いた記録
  // （専有型の資源ID publish.apprunDedicated・publish.targets・HANAMII の projectId）が**消え**、
  // 専有型のクラスタの記録が消えると⑥で破棄できず、月額の課金が止められなくなる（掟10）。
  // 書いたあとは、ディスクの実際の内容と「いま走っているか」をまとめて取り直して、この画面の表示用の写しを更新する。
  const saveMeta = async (patch: Partial<Meta>) => {
    const snap = await mergeProjectMetaThenLoad(projectDir, patch as Record<string, unknown>)
    applySnapshot(snap)
    return snap.meta
  }

  // ── 公開実行 ─────────────────────────────
  const publishRental = async () => {
    if (!NAME_OK.test(account)) { setError('アカウント名は半角英数字で入力してください（例: example）'); return }
    if (!NAME_OK.test(host)) { setError('ホスト名を確認してください（例: example.sakura.ne.jp）'); return }
    setBusy(true); setError('')
    try {
      if (!(await window.electronAPI.shell.which('rsync'))) {
        setMissingTool('rsync')
        return
      }
      const publishedAt = new Date().toISOString()
      await saveMeta(rentalPublishPatch({ account, host, publishedAt }))
      window.dispatchEvent(new Event('sakura-meta-changed'))
      const hasPublic = await window.electronAPI.fs.exists(`${projectDir}/public`)
      const hasApp = await window.electronAPI.fs.exists(`${projectDir}/app`)
      const dest = `${account}@${host}`
      // 公開の起点は`public/`（無ければプロジェクト直下＝移行前）。
      const root = await resolvePublishRoot(projectDir)
      let cmd = `cd "${root}"`
      // **公開の根（root）の中身が、そのまま公開Webルート（~/www）へ行く。**
      //
      // ⚠️ 2026-09-23 検分で見つけた2つの穴を、ここで同時に塞いでいる。
      //   ① `public/` がある構成は `--exclude='.DS_Store'` しか付けておらず、
      //      一元定義（shared/publishExclude.ts）を通っていなかった。今回の実機の
      //      `public/.koto-data/`（利用者が入力した予定・連絡先）が ~/www へ丸ごと上がり、
      //      `https://<アカウント>.sakura.ne.jp/.koto-data/…` として誰でも読める状態になる。
      //   ② その行の同期元が `public/` のままだった。root は `public/` があればその中を指すので、
      //      `cd <project>/public && rsync public/` ＝ 存在しない `public/public/` を指していた
      //      （根を public/ へ寄せた 2026-08-20 の変更の取りこぼし）。
      // 根そのものを送るのだから、**どちらの構成でも `./` でよい**。
      // 除外は手で並べ直さないこと（経路ごとに書き写して4回穴が空いている・掟10）。
      cmd += ` && rsync -avz${rsyncExcludeArgs(['deploy.sh'])} ./ "${dest}:/home/${account}/www/"`
      // app/ は**公開Webルートの外**（~/app）。config.php など「秘密だが動くのに要るもの」を
      // 置く場所なので、公開用の除外（.env や Dockerfile まで外す）はあえて掛けない。
      // 根の外（プロジェクト直下）にあるので、根からの相対ではなく絶対パスで指す。
      if (hasPublic && hasApp) {
        cmd += ` && rsync -avz --exclude='config.sample.php' --exclude='.DS_Store' "${projectDir}/app/" "${dest}:/home/${account}/app/"`
      }
      cmd += ` && echo '==> 公開完了: https://${host}/'`
      await startPublish(cmd)
    } finally { setBusy(false) }
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* クリップボード不可は無視 */ }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={handleBackdropClick}>
      <div
        className="w-[640px] max-h-[85vh] overflow-y-auto bg-elevated rounded-2xl border border-line shadow-xl p-6 fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 mb-1">
          <h2 className="text-lg font-bold text-ink">🚀 公開</h2>
          {/* ✗ の近くに、見える形で出す（title だけにしない）。走っている間、✗ は押せば閉じるが、
              閉じても処理は止まらないことを、押す前に伝える（作者の決定 ①）。 */}
          <div className="flex items-center gap-2 min-w-0">
            {opRunning && (
              <span className="text-[11px] text-ink-secondary text-right leading-snug">閉じても処理は最後まで進みます</span>
            )}
            <button onClick={onClose} aria-label="閉じる" className="text-ink-muted hover:text-ink text-lg leading-none flex-none">×</button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 mb-4">
          <p className="text-xs text-ink-muted truncate" title={projectDir}>{projName}</p>
          {/* 他のプロジェクトも含めた横断一覧（メニュー「表示 → 公開したもの一覧…」と同じ画面）。
              **どの画面からでも押せるようヘッダに置く**: v0.2.81 以降このモーダルは「最後に公開した公開先」の
              画面で直接開くため、公開先の選択画面に置くと通らない導線になってしまう（2026-07-31 実機で確認）。 */}
          {onOpenPublishedList && (
            <button
              onClick={onOpenPublishedList}
              className="text-[11px] text-ink-muted hover:text-sakura underline whitespace-nowrap flex-none"
            >📡 公開したもの一覧</button>
          )}
        </div>

        {/* 終わった結果（まだ見られていないもの）。**閉じて開き直しても、「確認しました」を押すまで出る**
            （作者の決定 ②）。警告（「保存場所が残ったので月額が続きます」など）は黄色の枠で出し、見逃させない。
            画面（公開先未選択／各パネル）によらず、このモーダルを開いている間は常に見せる。 */}
        {topResults.length > 0 && (
          <OpFinishedCards records={topResults} onAcknowledge={acknowledgeResults} />
        )}

        {/* いま走っている操作の進み具合（別の公開先の操作でも、このプロジェクトの鍵は1つなので出す）。
            **目の前の公開先の画面が出しているものは、ここでは出さない**（二重表示の解消・上の topRunning の説明）。
            公開の開始マーカー（下の pending の枠）が同じ公開のことを言っているときは、その枠の中に出して二重にしない。 */}
        {topRunning && !(pendingView.kind === 'running' && topRunning.op === '公開') && (
          <OpRunningCard rec={topRunning} />
        )}

        {/* 前回の公開が完了前に中断された可能性の警告（Part2: 公開開始マーカー）。
            画面（公開先未選択／各パネル）によらず、このモーダルを開いている間は常に見せる。
            ただし「進んでいます」（running）は、**目の前の公開先の画面が同じ公開の進み具合を出している間は出さない**
            （二重に出る・2026-09-30 検分。HANAMII の起動待ちは最長およそ5分続き、その間ずっと2つ並んでいた）。
            進んでいるのが別の公開先・隠れたタブ・公開先の選択前なら、目の前に進み具合を出す画面が無いので、ここが出す。 */}
        {pendingView.kind !== 'none' && !(pendingView.kind === 'running' && opsRunning !== null && visiblePanelShows(target, opsRunning)) && (
          <div className={`rounded-xl border ${pendingView.kind === 'running' ? 'border-line' : 'border-brand-yellow/70'} bg-surface p-4 mb-4 space-y-2`}>
            <p className="text-sm text-ink leading-relaxed">{pendingPublishMessage(pendingView)}</p>
            {pendingView.kind === 'running' && topRunning && topRunning.op === '公開' && (
              <OpProgressLines rec={topRunning} />
            )}
            {/* 進んでいる最中は消せない（消すのは「中断の可能性」のときだけ）。 */}
            {pendingView.kind === 'interrupted' && (
              <div className="flex justify-end">
                <button
                  onClick={dismissInterruptedNotice}
                  className="text-xs text-ink-secondary border border-line rounded-lg px-3 py-1.5 hover:border-sakura hover:text-ink"
                >確認しました（この通知を消す）</button>
              </div>
            )}
          </div>
        )}

        {/* 公開先を選んだら「データの保存」について知らせる（2026-08-13）。
            **公開先ごとに答えが変わる**ので、ここに置く。レンタルサーバならファイルが
            残るので費用は要らない。コンテナ系では消えるので保存場所が要る。
            sakura-vps は①接続のみで、アプリケーションの公開（データを伴う公開）の実装が無いため対象外。
            sakura-apprun-dedicated は共用型と同じコンテナ系として出す（storageNeed.ts の PublishTarget に
            含まれ、targetKeepsData=false。D-3・2026-09-11 Ryosuke 決定）。
            target の型は公開先の一覧をここに書き写さず、上の条件で絞った結果（Target から 'sakura-vps' を
            除いたもの）をそのまま渡す。StorageNotice 側の PublishTarget と食い違えば型検査で分かる。 */}
        {loaded && target && target !== 'sakura-vps' && (
          <div className="mb-3">
            <StorageNotice projectDir={projectDir} target={target} onAskAi={onClose} />
          </div>
        )}

        {!loaded ? (
          <p className="text-sm text-ink-secondary">読み込み中…</p>
        ) : missingTool === 'rsync' ? (
          // ── rsync が見つからない（初心者向け案内） ──
          <div className="space-y-3">
            <div className="rounded-xl border border-brand-yellow/70 bg-surface p-4 space-y-3">
              <p className="text-sm text-ink leading-relaxed">
                ファイル転送ツール（rsync）が見つかりません。下のコマンドをコピーしてターミナルに貼り付け、実行してから再度お試しください。
              </p>
              <div className="flex items-center gap-2 rounded-lg bg-overlay border border-line px-3 py-2">
                <code className="flex-1 text-xs text-ink font-mono break-all">xcode-select --install</code>
                <button
                  onClick={() => copyText('xcode-select --install')}
                  className="flex-none text-xs font-medium text-sakura hover:underline"
                >{copied ? '✓ コピーしました' : 'コピー'}</button>
              </div>
            </div>
            <div className="flex justify-end">
              <button onClick={() => setMissingTool(null)} className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90">戻る</button>
            </div>
          </div>
        ) : running ? (
          // ── 実行中／完了案内 ──
          <div className="space-y-3">
            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="text-sm text-ink font-semibold mb-1">⏳ 公開はターミナルで進行します</p>
              <p className="text-xs text-ink-secondary">
                下のターミナルパネルで進行を確認してください。完了したら、下のボタンでサイトを確認してください。
                {target === 'sakura-rental' && ' 初回はSSHパスワード（またはパスフレーズ）の入力を求められます。'}
              </p>
            </div>
            {target === 'sakura-rental' && (() => {
              const siteUrl = meta?.publish?.url
              return (
                <div className="rounded-xl border border-sakura/40 bg-surface p-4 space-y-2">
                  <p className="text-sm text-ink font-semibold">✅ 完了したら</p>
                  <p className="text-xs text-ink-secondary">
                    「公開完了」と表示されたら、下のボタンでサイトを確認できます。
                  </p>
                  {siteUrl?.startsWith('http') && (
                    <a
                      href={siteUrl}
                      className="inline-block sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90"
                    >🌐 公開したサイトを開く</a>
                  )}
                </div>
              )
            })()}
            <div className="flex justify-end">
              <button onClick={onClose} className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90">閉じる</button>
            </div>
          </div>
        ) : !target ? (
          // ── 公開先の選択（ローカルのみ／未設定のプロジェクト） ──
          (() => {
            const cur = meta.target
            // さくらの非自動公開（VPS/クラウド）や「さくら以外」が設定されている場合は、
            // 自動公開に未対応である旨を明示する（local／未設定は従来の案内のまま）。
            const showMismatch = !!cur && cur !== 'local' && !isAutoPublishTarget(cur)
            return (
          <div className="space-y-3">
            <PublishStatusBox
              publish={meta.publish}
              latestChangeAt={latestChangeAt}
              apprunLegacy={apprunLegacy}
              // 消すのは**その公開先の記録だけ**。main が書く直前にディスクから読み直して消すので、
              // 開いてから main が書いた専有型の資源ID・ほかの公開先の記録は残る（projectMeta.ts）。
              onForget={async t => {
                // 片づけたあとは、走っているかも聞き直す（公開のパネルで公開を始めたあと、
                // 一覧へ戻って片づけると、走っている公開の印を「中断」と誤るため）。
                applySnapshot(await forgetPublishTargetThenLoad(projectDir, t))
                window.dispatchEvent(new Event('sakura-meta-changed'))
              }}
            />
            {showMismatch ? (
              <div className="rounded-xl border border-brand-yellow/70 bg-surface p-4">
                {cur === 'sakura-apprun-dedicated' ? (
                  <p className="text-sm text-ink leading-relaxed">
                    現在の公開先「{getTargetProfile(cur).label}」は、この画面からの自動公開にはまだ対応していません。📦 さくらのAppRun の専有型タブから公開できます。
                  </p>
                ) : (
                  <p className="text-sm text-ink leading-relaxed">
                    現在の公開先「{getTargetProfile(cur).label}」は、この画面からはまだ自動公開できません。自動公開できるのは 🌐 さくらのレンタルサーバ・📦 さくらのAppRun・🌸 HANAMII・▲ Vercel です（選ぶと公開先もそれに変わります）。
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-ink-secondary">このプロジェクトの公開先を選んでください（あとから変更できます）。</p>
            )}
            <p className="text-[11px] font-semibold text-ink-muted">さくらインターネットのサービス</p>
            <button
              onClick={() => setTarget('sakura-rental')}
              className="w-full text-left rounded-xl border border-line hover:border-sakura bg-surface p-4 transition-colors"
            >
              <p className="text-sm font-semibold text-ink">🌐 さくらのレンタルサーバ</p>
              <p className="text-xs text-ink-muted mt-0.5">HTML や PHP のサイト向け。契約済みのサーバへファイルを送ります。</p>
            </button>
            <button
              onClick={() => setTarget('sakura-apprun')}
              className="w-full text-left rounded-xl border border-line hover:border-sakura bg-surface p-4 transition-colors"
            >
              <p className="text-sm font-semibold text-ink">📦 さくらのAppRun</p>
              <p className="text-xs text-ink-muted mt-0.5">
                アプリを動かせる公開先です。むずかしい準備は要りません（Koto がまとめて行います）。
                使った分だけ課金の「共用型」と、独自ドメインが使える「専有型（上級者向け・常時課金）」を選べます。
                {/* 金額はプランを取得しないと分からないため、ここではハードコードしない
                    （専有型パネルの冒頭に実額が出ます・判断4・2026-09-11）。 */}
              </p>
            </button>

            <div className="pt-2 mt-1 border-t border-line-soft space-y-3">
              {/* この見出しの下は「さくら以外」ではない（🖥 さくらのVPS はさくら自身のサービス）。
                  中身（HANAMII・Vercel・VPS）に合う中立な見出しにする（roadmap #26 レビュー6）。 */}
              <p className="text-[11px] font-semibold text-ink-muted pt-1">その他の公開先</p>
              <button
                onClick={() => setTarget('hanamii')}
                className="w-full text-left rounded-xl border border-line hover:border-sakura bg-surface p-4 transition-colors"
              >
                <p className="text-sm font-semibold text-ink">🌸 HANAMII（国産のクラウドサービス）</p>
                <p className="text-xs text-ink-muted mt-0.5">国産のクラウドサービス。サーバーで動き続けるアプリ（Node.js など）も公開できます。データは100%国内です。</p>
              </button>
              <button
                onClick={() => setTarget('vercel')}
                className="w-full text-left rounded-xl border border-line hover:border-sakura bg-surface p-4 transition-colors"
              >
                <p className="text-sm font-semibold text-ink">▲ Vercel（海外のクラウドサービス）</p>
                {/* 2026-09-24 検分の指摘2と同じ一文。国外なのはアプリが動く場所だけ（データは国内）。 */}
                <p className="text-xs text-ink-muted mt-0.5">海外のクラウドサービスです。ページを見せるだけのサイト向けで、サーバーで動き続けるアプリは扱えません。アプリが動くのは国外です。データの保存を使う場合、そのデータはさくらのオブジェクトストレージ（日本国内）に置かれます。</p>
              </button>
              <button
                onClick={() => setTarget('sakura-vps')}
                className="w-full text-left rounded-xl border border-line hover:border-sakura bg-surface p-4 transition-colors"
              >
                <p className="text-sm font-semibold text-ink">🖥 さくらのVPS <span className="text-[11px] font-normal text-brand-yellow">（開発中・現在は接続確認のみ）</span></p>
                <p className="text-xs text-ink-muted mt-0.5">自由度の高い仮想サーバ。②初期セットアップ・③公開はまだ実装中で、このバージョンでは①接続（鍵認証で安全に繋がる）までです。</p>
              </button>
            </div>
          </div>
            )
          })()
        ) : target === 'sakura-rental' ? (
          // ── レンタルサーバ ──
          <div className="space-y-4">
            <div className="rounded-xl border border-line bg-surface p-4 space-y-1">
              <p className="text-sm font-semibold text-ink">🌐 さくらのレンタルサーバで公開</p>
              <p className="text-xs text-ink-muted leading-relaxed">
                HTML や PHP のサイト向け（データベース（MySQL）も使えます）。契約済みのサーバへファイルを送ります。
              </p>
              {rentalServiceUrl && (
                <p className="text-[11px] text-ink-muted">
                  <a href={rentalServiceUrl} className="hover:underline">🌐 公式サイトを見る ↗</a>
                </p>
              )}
            </div>
            <FirstTimeGuide title="🔰 初めて公開する方へ（準備すること）">
              <ol className="list-decimal pl-4 space-y-1.5">
                <li>
                  さくらのレンタルサーバの契約が必要です。
                  <a href="https://secure.sakura.ad.jp/rs/cp/" className="text-sakura hover:underline">コントロールパネル</a> から契約状況を確認できます。
                </li>
                <li>
                  SSHを有効にします。コントロールパネルの「サーバ情報」などでSSHアカウントを確認してください（初期パスワードは契約時に届いたメールに記載されています）。
                </li>
                <li>
                  下の「アカウント名」には、初期ドメイン（例: <span className="font-mono text-ink">example.sakura.ne.jp</span>）の <b className="text-ink">example</b> の部分を入力します。
                </li>
              </ol>
              <GuideFaq items={[
                ['パスワードを聞かれて失敗する', 'SSHのパスワードは、レンタルサーバの初期パスワードです（契約時のメールを確認してください）。'],
                ['permission denied と表示される', 'コントロールパネルでSSH接続が有効になっているかを確認してください。'],
                ['ホスト名がわからない', '通常は「アカウント名.sakura.ne.jp」です。コントロールパネルのサーバ情報でも確認できます。'],
              ]} />
            </FirstTimeGuide>
            <Field label="アカウント名" hint="サーバ契約のアカウント名（例: example）">
              <input value={account} onChange={e => { setAccount(e.target.value.trim()); setError('') }}
                placeholder="example" className="w-full bg-surface border border-line focus:border-sakura rounded-xl px-3 py-2.5 text-sm text-ink placeholder-ink-muted outline-none transition-colors" autoFocus />
            </Field>
            <Field label="ホスト名" hint="通常は アカウント名.sakura.ne.jp">
              <input value={host} onChange={e => { setHost(e.target.value.trim()); setHostEdited(true); setError('') }}
                placeholder="example.sakura.ne.jp" className="w-full bg-surface border border-line focus:border-sakura rounded-xl px-3 py-2.5 text-sm text-ink placeholder-ink-muted outline-none transition-colors" />
            </Field>
            <p className="text-[11px] text-ink-muted leading-relaxed">
              💡 SSH接続が初めての場合は、コントロールパネルでSSH接続を有効にしておいてください。実行時にパスワードを聞かれたらターミナルに入力します。
            </p>
            {/* 🛡 セキュリティチェック（公開の前に・2026-08-21 Ryosuke 指定） */}
            <SecurityCheckSection projectDir={projectDir} apiKey={apiKey} />
            {/* 🧹 未使用ファイルの検出＋片づけ（roadmap #18） */}
            <UnusedFilesSection projectDir={projectDir} />
            {error && <p className="text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2">{error}</p>}
            <div className="flex justify-between items-center">
              <button onClick={() => setTarget(null)} className="text-xs text-ink-muted hover:text-ink">← 公開先を変更</button>
              <button onClick={publishRental} disabled={busy || !account || !host}
                className="sakura-gradient text-white rounded-lg px-5 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40">
                {busy ? '確認中…' : '🚀 公開する'}
              </button>
            </div>
          </div>
        ) : target === 'hanamii' ? (
          // ── HANAMII（自己完結フロー） ──
          <div className="space-y-3">
            <button onClick={() => setTarget(null)} className="text-xs text-ink-muted hover:text-ink">← 公開先を変更</button>
            <HanamiiPanel projectDir={projectDir} apiKey={apiKey} onOpenCredentials={onOpenCredentials} />
          </div>
        ) : target === 'vercel' ? (
          // ── Vercel（自己完結フロー） ──
          <div className="space-y-3">
            <button onClick={() => setTarget(null)} className="text-xs text-ink-muted hover:text-ink">← 公開先を変更</button>
            <VercelPanel projectDir={projectDir} apiKey={apiKey} onOpenCredentials={onOpenCredentials} />
          </div>
        ) : target === 'sakura-vps' ? (
          // ── さくらのVPS（V1a・①接続のみ。自己完結フロー） ──
          <div className="space-y-3">
            <button onClick={() => setTarget(null)} className="text-xs text-ink-muted hover:text-ink">← 公開先を変更</button>
            <VpsPanel projectDir={projectDir} onOpenCredentials={onOpenCredentials} />
          </div>
        ) : (target === 'sakura-apprun' || target === 'sakura-apprun-dedicated') ? (
          // ── さくらのAppRun（roadmap #24: 共用型／専有型をタブで切り替え） ──
          // 一覧では1行にまとめ、選んだ後にここでタブ切替する。内部の識別子（Target・meta.target の
          // 'sakura-apprun' / 'sakura-apprun-dedicated'）は変えていない（保存済みの記録が読めなくなるため）。
          <div className="space-y-3">
            <button onClick={() => setTarget(null)} className="text-xs text-ink-muted hover:text-ink">← 公開先を変更</button>
            <div className="flex items-center gap-1 border-b border-line-soft" role="tablist" aria-label="AppRunの形態">
              <button
                role="tab"
                aria-selected={target === 'sakura-apprun'}
                onClick={() => setTarget('sakura-apprun')}
                className={`px-3 py-2 -mb-px text-sm font-semibold border-b-2 transition-colors ${target === 'sakura-apprun' ? 'border-sakura text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}
              >共用型</button>
              <button
                role="tab"
                aria-selected={target === 'sakura-apprun-dedicated'}
                onClick={() => setTarget('sakura-apprun-dedicated')}
                className={`px-3 py-2 -mb-px text-sm font-semibold border-b-2 transition-colors ${target === 'sakura-apprun-dedicated' ? 'border-sakura text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}
              >専有型（上級者向け）</button>
            </div>
            {/* タブ直下にあった専有型の費用・提供範囲の注意は、AppRunDedicatedPanel.tsx の
                パネル冒頭に一本化した（判断4・利用者目線レビュー・2026-09-11。以前はここ・
                パネル冒頭・④冒頭の3か所にほぼ同文で出ていた）。 */}
            {/* 出し分けは hidden（表示）だけで行い、パネルは外さない（指摘5）。
                三項演算子に戻すと、タブを行き来するたびに③の調査結果が消えて⑦を取り直す。 */}
            {mountedApprunTabs['sakura-apprun'] && (
              <div className={target === 'sakura-apprun' ? undefined : 'hidden'}>
                <AppRunPanel projectDir={projectDir} apiKey={apiKey} onOpenCredentials={onOpenCredentials} visible={target === 'sakura-apprun'} />
              </div>
            )}
            {mountedApprunTabs['sakura-apprun-dedicated'] && (
              <div className={target === 'sakura-apprun-dedicated' ? undefined : 'hidden'}>
                <AppRunDedicatedPanel projectDir={projectDir} onOpenCredentials={onOpenCredentials} visible={target === 'sakura-apprun-dedicated'} />
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

// 進み具合の行（いまやっていること・補足・経過）。記録の progress をそのまま出す（main が秘密を伏せてある）。
function OpProgressLines({ rec }: { rec: ProjectOpRecordShape }) {
  const p = rec.progress
  const stepText = typeof p?.step === 'number' && typeof p?.total === 'number' ? `（${p.step} / ${p.total}）` : ''
  return (
    <div className="space-y-1">
      <p className="text-xs text-ink-secondary leading-relaxed select-text">{`${p?.label ?? ''}${stepText}`}</p>
      {p?.detail ? <p className="text-[11px] text-ink-muted leading-relaxed select-text">{p.detail}</p> : null}
      <p className="text-[11px] text-ink-muted">{`経過 ${formatElapsed(Date.now() - rec.startedAt)}`}</p>
    </div>
  )
}

// いま走っている操作の枠。
function OpRunningCard({ rec }: { rec: ProjectOpRecordShape }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 mb-4 space-y-2" role="status">
      <p className="text-sm text-ink leading-relaxed">{`⏳ ${opTargetName(rec)}の${rec.op}が進んでいます`}</p>
      <OpProgressLines rec={rec} />
      <p className="text-[11px] text-ink-muted leading-relaxed">この画面を閉じても処理は進みますが、Koto を終了すると途中で止まります。</p>
    </div>
  )
}

function CopyTextButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* クリップボード不可は無視 */ }
  }
  return <button onClick={copy} className="text-[11px] font-medium text-sakura hover:underline">{copied ? '✓ コピーしました' : 'コピー'}</button>
}

// 終わった操作の結果と警告。うまくいかなかった・警告があるときは黄色の枠にして、見逃させない。
function OpFinishedCard({ rec }: { rec: ProjectOpRecordShape }) {
  const r = rec.result
  const what = `${opTargetName(rec)}の${rec.op}`
  const warnings = r?.warnings ?? []
  const lines = r?.lines ?? []
  const ok = r?.ok === true
  const title = !r
    ? `⚠️ ${what}は終わりましたが、結果を読み取れませんでした`
    : !r.ok
      ? `⚠️ ${what}は、うまくいきませんでした`
      : warnings.length > 0
        ? `⚠️ ${what}は終わりましたが、確認が必要なことがあります`
        : `✅ ${what}が終わりました`
  const when = rec.finishedAt ? formatPublishedAt(new Date(rec.finishedAt).toISOString()) : null
  const needsAttention = !ok || warnings.length > 0
  return (
    <div className={`rounded-xl border ${needsAttention ? 'border-brand-yellow/70' : 'border-line'} bg-surface p-4 space-y-2`}>
      <p className="text-sm font-semibold text-ink leading-relaxed">{title}</p>
      {when && <p className="text-[11px] text-ink-muted">{`${when} に終わりました`}</p>}
      {r?.message && <p className="text-xs text-ink-secondary leading-relaxed whitespace-pre-wrap select-text">{r.message}</p>}
      {warnings.map((w, i) => (
        <p key={i} className="text-xs text-ink leading-relaxed whitespace-pre-wrap select-text">{warningLine(w)}</p>
      ))}
      {r?.url?.startsWith('http') && (
        <a href={r.url} className="text-xs text-sakura hover:underline break-all">{r.url}</a>
      )}
      {lines.length > 0 && (
        <details className="text-[11px] text-ink-muted">
          <summary className="cursor-pointer">実行した内容</summary>
          <ul className="mt-1 space-y-0.5 select-text">
            {lines.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </details>
      )}
      {r?.detail && (
        <details className="text-[11px] text-ink-muted">
          <summary className="cursor-pointer">詳しい情報（診断用）</summary>
          <pre className="mt-1 whitespace-pre-wrap break-all select-text">{r.detail}</pre>
        </details>
      )}
      {needsAttention && (
        <div className="flex justify-end">
          <CopyTextButton text={[title, r?.message ?? '', ...warnings].filter(Boolean).join('\n')} />
        </div>
      )}
    </div>
  )
}

// 終わった結果の一覧＋「確認しました」。押すまで消えない（押すと、見たことにして main へ伝える）。
function OpFinishedCards({ records, onAcknowledge }: { records: ProjectOpRecordShape[]; onAcknowledge: () => void }) {
  return (
    <div className="mb-4 space-y-3">
      {records.map(rec => <OpFinishedCard key={rec.startedAt} rec={rec} />)}
      <div className="flex justify-end">
        <button
          onClick={onAcknowledge}
          className="text-xs text-ink-secondary border border-line rounded-lg px-3 py-1.5 hover:border-sakura hover:text-ink"
        >結果を確認しました（この表示を消す）</button>
      </div>
    </div>
  )
}

// 「📡 このプロジェクトの公開状況」ボックス。publish.targets（＋レガシー救済）に1件以上あるときだけ表示する
// （呼び出し側で行が無ければ何も描画しない＝return null）。
function PublishStatusBox({ publish, latestChangeAt, apprunLegacy, onForget }: {
  publish: Meta['publish']
  latestChangeAt: string | null
  apprunLegacy: { createdAt: string | null } | null
  onForget: (t: PublishTargetKind) => Promise<void>
}) {
  const rows = buildPublishStatusRows(publish, { apprunLegacy })
  // **一度では消さない**（記録とはいえ、消すと戻せない）
  const [confirming, setConfirming] = useState<PublishTargetKind | null>(null)
  if (rows.length === 0) return null
  return (
    <div className="rounded-xl border border-line bg-surface p-4 space-y-2">
      <p className="text-sm font-semibold text-ink">📡 このプロジェクトの公開状況</p>
      <p className="text-[11px] text-ink-muted leading-relaxed">
        🔗 キーを失くしたり作り直したりして Koto から操作できなくなっても、各行の
        <span className="text-ink-secondary">管理画面</span>から辿れます。
      </p>
      <p className="text-[11px] text-ink-muted leading-relaxed">
        <span className="text-ink-secondary">記録を片づける</span>のは、この一覧から消すだけです
        （<b className="text-ink">公開したもの自体は消えません</b>）。公開をやめるときは、先に各公開先で止めてください
        （さくらのAppRun 共用型・HANAMII は「🗑 破棄」、専有型は専有型タブの⑥「すべて削除する」。レンタルサーバ・Vercel は管理画面で消します）。
      </p>
      <ul className="space-y-1.5">
        {rows.map(row => {
          const stale = !row.dateUnknown && isStale(row.publishedAt, latestChangeAt)
          const dateText = row.dateUnknown ? '日時不明' : (formatPublishedAt(row.publishedAt) ?? '日時不明')
          return (
            <li key={row.target} className="text-xs text-ink-secondary leading-relaxed">
              <span className="text-brand-green font-semibold">✓</span>{' '}
              <span className="text-ink">{row.label}</span>
              {' — '}
              {row.dateUnknown ? '公開済み（日時不明）' : `${dateText} 公開`}
              {row.url && (
                <>
                  {' '}
                  <a href={row.url} className="text-sakura hover:underline break-all">{row.url}</a>
                </>
              )}
              {stale && (
                <span className="block text-brand-yellow">⚠️ その後に変更あり（公開内容が古い可能性）</span>
              )}
              {/* ── 外に生きているものへ辿り着けるようにする（2026-08-15 Ryosuke 指摘）──
                  キーを失くす／作り直す／別のマシンへ移ると、Koto からは操作できなくなる。
                  そのとき「公開済み」とだけ出して行き先を示さないと、**放置され課金が続く**。 */}
              <span className="block mt-0.5">
                <a href={PUBLISH_TARGET_CONSOLE[row.target]} className="text-ink-muted hover:text-sakura hover:underline">
                  管理画面を開く ↗
                </a>
                {canForgetRow(row) && (
                  confirming === row.target ? (
                    <>
                      {'　'}
                      <button
                        onClick={async () => { await onForget(row.target); setConfirming(null) }}
                        className="text-brand-red hover:underline font-semibold"
                      >記録を片づける（公開したものは残ります）</button>
                      {'　'}
                      <button onClick={() => setConfirming(null)} className="text-ink-muted hover:underline">やめる</button>
                    </>
                  ) : (
                    <>
                      {'　'}
                      <button
                        onClick={() => setConfirming(row.target)}
                        title="記録だけを消します。公開したもの自体は消えません"
                        className="text-ink-muted hover:text-brand-red hover:underline"
                      >記録を片づける</button>
                    </>
                  )
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// 折りたたみ式の「初めての準備」ガイド。初期状態は閉じている。
function FirstTimeGuide({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="rounded-xl border border-brand-yellow/70 bg-surface p-3">
      <summary className="text-sm font-semibold text-ink cursor-pointer list-none flex items-center gap-1">
        {title}
      </summary>
      <div className="text-xs text-ink-secondary leading-relaxed mt-2 space-y-2">
        {children}
      </div>
    </details>
  )
}

// 「つまずいたら」FAQ。各項目は [質問, 回答] のタプル。
function GuideFaq({ items }: { items: [string, string][] }) {
  return (
    <div className="pt-1">
      <p className="text-[11px] font-semibold text-ink-secondary mb-1">つまずいたら</p>
      <ul className="space-y-1.5">
        {items.map(([q, a], i) => (
          <li key={i} className="text-[11px] text-ink-muted leading-relaxed">
            <span className="text-ink-secondary font-medium">Q. {q}</span><br />
            A. {a}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-ink-secondary mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-ink-muted mt-1">{hint}</span>}
    </label>
  )
}
