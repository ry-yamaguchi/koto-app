import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { listCloudKeys, getActiveCloudKeyId, activateCloudKey, CloudKeyInfo } from './CredentialsModal'
import { getTargetProfile } from '../targetProfiles'
import { clearPublishRecord } from '../publishRecord'
import { isNameConflictError, isCreationLimitError, suggestAlternativeName } from '../nameConflict'
import { beginActivity } from '../activity'
import { markPublishPending, clearPublishPending } from '../publishPending'
import CopyButton from './CopyButton'
import { teardownDataNote } from '../../shared/teardownSupport'
import { teardownTargets, registryDeleteLabel, registryDeleteHelp, ongoingCostNotice, registryUnknownNotice, remainingCostWarning, urlChangesOnTeardownNotice, REGISTRY_MONTHLY_YEN } from '../../shared/cloudCost'

// AppRun の公開名（env.json の name）の文字数上限。main/cloud/spec.ts の NAME_PATTERN
// （小文字英数字とハイフン・先頭末尾は英数字・3〜40文字）と同じ制約をここでも複製する
// （renderer は main の Node専用コードを import しない流儀のため。HanamiiPanel の describeErrorCode と同じ理由）。
const APPRUN_NAME_MAX_LEN = 40

// main/cloud/spec.ts の normalizeSpecName と同じ内容（renderer 複製）。
// 大文字→小文字・不正文字→ハイフン・連続/先頭末尾ハイフン整理・3〜40文字に収める。
function normalizeApprunName(raw: string): string {
  let s = (raw ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  if (s.length > APPRUN_NAME_MAX_LEN) s = s.slice(0, APPRUN_NAME_MAX_LEN).replace(/-+$/g, '')
  if (s.length < 3) s = s ? `${s}-app`.slice(0, APPRUN_NAME_MAX_LEN) : 'app'
  return s
}

// 「さくらのAppRun」公開パネル（段階2b＝操作UI）。
// さくらのAppRun 向けの「使い捨てテスト環境」を、APIキー登録〜プラン確認〜構築/破棄まで一画面で操作する。
// バックエンド（段階1/2a）は完成済み。ここは window.electronAPI.cloud.* を呼んで結果を日本語で見せるだけ。
// 破壊操作（apply の destructive 含み・teardown）は必ず確認ダイアログを挟む（ServerFilesModal のアップロード確認と同じ作り）。

interface Props {
  projectDir: string
  onOpenCredentials: () => void
}

// plan の各アクションを type で色分けするための Tailwind クラス
function actionTone(type: CloudPlanAction['type']): { dot: string; label: string; text: string } {
  switch (type) {
    case 'create': return { dot: 'bg-brand-green', label: '作成', text: 'text-brand-green' }
    case 'update': return { dot: 'bg-brand-blue', label: '更新', text: 'text-brand-blue' }
    case 'delete': return { dot: 'bg-brand-red', label: '削除', text: 'text-brand-red' }
    default: return { dot: 'bg-ink-muted', label: '変更なし', text: 'text-ink-muted' }
  }
}

// リソース種別の日本語ラベル
function kindLabel(kind: CloudResourceKind): string {
  switch (kind) {
    case 'registry': return 'レジストリ'
    case 'image': return 'イメージ'
    case 'apprun-app': return 'アプリ（AppRun）'
    case 'bucket': return 'バケット（オブジェクトストレージ）'
    default: return kind
  }
}

// 確認ダイアログの種類（破壊操作ごとに文言・強調を変える）
type Confirm =
  | { kind: 'apply'; plan: CloudPlan }
  | { kind: 'teardown' }
  // 公開名の変更確認。公開済み（state.json に apprun-app あり）のときのみ挟む
  // （変更すると次回公開時に新しいアプリとして作成され公開URLが変わるため）。
  // retryPublish: true のときは保存後に公開処理（事前チェック→確認→適用）を続けて呼ぶ（衝突時の再公開ボタン用）。
  | { kind: 'renameSpec'; name: string; retryPublish: boolean }
  | null

// 統一公開記録（publish.targets）を .sakuraide.json にマージ書き込みする（既存キーは残す）。
// HanamiiPanel の saveHanamiiMeta と同じ流儀（このパネル専用の小関数として持つ）。
async function saveAppRunPublishRecord(projectDir: string, rec: { publishedAt: string; url: string | null }) {
  const metaPath = `${projectDir}/.sakuraide.json`
  let m: any = {}
  try { m = JSON.parse(await window.electronAPI.fs.readFile(metaPath)) } catch { /* メタ無し（既存フォルダ等） */ }
  const next = {
    ...m,
    // 公開に成功したらプロジェクトの公開先も AppRun にする（HanamiiPanel / VercelPanel /
    // PublishModal のレンタルサーバ公開と同じ流儀。**ここだけ更新しておらず**、AppRunで公開しても
    // 次回の③公開が元の公開先の画面で開いていた・2026-07-31 ユーザー報告）。
    target: 'sakura-apprun',
    publish: {
      ...(m.publish ?? {}),
      targets: { ...(m.publish?.targets ?? {}), 'sakura-apprun': rec },
    },
  }
  await window.electronAPI.fs.writeFile(metaPath, JSON.stringify(next, null, 2))
  window.dispatchEvent(new Event('sakura-meta-changed'))
}

/** 破棄に成功したら公開記録からも取り除く（「📡 公開したもの一覧」に幽霊を残さない・2026-08-06）。 */
// 記録の掃除は publishRecord.ts に一本化した（2026-08-09）。破棄の導線が
// ③公開の各パネル・📡 公開したもの一覧・プロジェクト削除の3系統に増えたため。
const clearAppRunPublishRecord = (projectDir: string) => clearPublishRecord(projectDir, 'sakura-apprun')

export default function AppRunPanel({ projectDir, onOpenCredentials }: Props) {
  const projName = projectDir.split('/').pop() ?? 'app'

  // ── APIキー状態（入力は「認証情報」モーダルに一本化。ここは状態表示と選択のみ） ──
  const [hasKey, setHasKey] = useState<boolean | null>(null) // null=確認中
  // 接続テスト: 未実施 / 確認中 / OK / NG
  const [conn, setConn] = useState<'idle' | 'testing' | 'ok' | 'ng'>('idle')
  const [connMsg, setConnMsg] = useState('')
  // 接続テストの 3 点チェック結果（AppRun参照 / レジストリ一覧 / 請求参照）。未実施は null。
  type ConnCheck = { ok: boolean; status?: number; message?: string }
  const [connChecks, setConnChecks] = useState<{ apprun: ConnCheck; registry: ConnCheck; billing: ConnCheck } | null>(null)
  // 登録済みのクラウドキー一覧と、現在「使用中」のキー id（この公開に使うキーの選択用）。
  const [cloudKeys, setCloudKeys] = useState<CloudKeyInfo[]>([])
  const [activeKeyId, setActiveKeyId] = useState<string | null>(null)

  // ── 環境スペック（env.json） ──
  const [spec, setSpec] = useState<CloudEnvSpec | null>(null)
  const [envLoading, setEnvLoading] = useState(false)
  const [envError, setEnvError] = useState('')
  const [scaffolding, setScaffolding] = useState(false)

  // ── プラン（ドライラン） ──
  const [plan, setPlan] = useState<CloudPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState('')

  // ── 操作（apply / teardown） ──
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [busy, setBusy] = useState(false) // apply/teardown 実行中
  // 破棄時にコンテナレジストリも消すか。既定 true（残すと月額課金が続くため）。
  const [deleteRegistry, setDeleteRegistry] = useState(true)

  /**
   * このプロジェクトの保存場所（用意していなければ null）。
   * **費用の表示と、破棄で何が消えるかがこれで変わる**（2026-08-14）。
   */
  const [placement, setPlacement] = useState<{ bucket: string; prefix: string; shared: boolean } | null>(null)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await window.electronAPI.storage.placement(projectDir)
        if (alive && r.ok) setPlacement(r.placement)
      } catch { /* 読めなくても公開はできる */ }
    }
    void load()
    // **この画面を開いたあとに用意されることがある**（同じ③公開の中の案内から）。
    // 取り直さないと、費用の表示も破棄の案内も保存場所を知らないままになる（2026-08-14）
    const onPrepared = () => { void load() }
    window.addEventListener('sakura:storage-prepared', onPrepared)
    return () => { alive = false; window.removeEventListener('sakura:storage-prepared', onPrepared) }
  }, [projectDir])
  const [registryName, setRegistryName] = useState<string | null>(null)
  /**
   * レジストリを設定し直して整ったか（2026-08-14 Ryosuke 指摘）。
   * **一度直したらボタンを消す。** 出したままだと「効いていないのでは」と何度も
   * 押させることになり、押すたびに push 用パスワードを作り直す（毎回無駄な往復）。
   * 探し直しに失敗すれば新しいレジストリが作られ、**月額220円が増える**恐れもある。
   */
  const [registryFixed, setRegistryFixed] = useState(false)
  // detail は失敗時の生ログ（stderr要約等・診断用）。OpResultView が折りたたみ「詳細を見る」で表示する（所見12）。
  // hint: main 側が「この失敗はレジストリを設定し直せば直る」と判断したときに付ける印。
  // これが付いたときだけ再設定のボタンを出す（常設しない・2026-08-09）。
  const [opResult, setOpResult] = useState<{ ok: boolean; executed?: string[]; skipped?: string[]; message?: string; detail?: string; hint?: string } | null>(null)
  // 構築中の進捗メッセージ（最新行）。apply 中だけ表示する。
  const [progress, setProgress] = useState<string | null>(null)

  // ── 公開名の変更（spec.name） ──
  // 既に AppRun へ公開済みか（state.json に apprun-app リソースがあるか）。名前変更時の確認ダイアログ要否に使う。
  const [published, setPublished] = useState(false)
  const [renaming, setRenaming] = useState(false)

  // ── 前提チェック（image 以外のソースのとき・ビルド方式により内容が変わる） ──
  type Prereqs = { sourceType: 'dockerfile' | 'image' | null; builderMode: 'builtin' | 'docker'; builder?: boolean; docker?: boolean; dockerfile?: boolean; registry: boolean }
  const [prereqs, setPrereqs] = useState<Prereqs | null>(null)
  const [modeSwitching, setModeSwitching] = useState(false)
  // レジストリ自動作成の状態
  const [regCreating, setRegCreating] = useState(false)
  const [regNotice, setRegNotice] = useState('')
  // 公開URL（デプロイ済みのとき）
  const [appUrl, setAppUrl] = useState<string | null>(null)
  const [urlLoading, setUrlLoading] = useState(false)
  // コスト実額
  const [cost, setCost] = useState<{ amountYen?: number; asOf?: string; message?: string } | null>(null)
  const [costLoading, setCostLoading] = useState(false)
  // TTL（期限）の保存中フラグ
  const [savingTtl, setSavingTtl] = useState(false)

  // ── TTL / 期限 ──
  const [expiry, setExpiry] = useState<{ expired: boolean; createdAt: string | null; ttlHours: number | null } | null>(null)

  // ── 限定公開（アクセス制限＝パケットフィルタ） ──
  const [limitEnabled, setLimitEnabled] = useState(false)
  const [limitIps, setLimitIps] = useState<Array<{ ip: string; prefix: number }>>([])
  const [ipInput, setIpInput] = useState('')
  const [limitLoading, setLimitLoading] = useState(false)
  const [limitSaving, setLimitSaving] = useState(false)
  const [limitMsg, setLimitMsg] = useState('')

  // 登録状態を読む
  const refreshKey = useCallback(async () => {
    try { setHasKey(await window.electronAPI.cloud.hasKey()) }
    catch { setHasKey(false) }
  }, [])

  // 登録済みのクラウドキー一覧と「使用中」キー id を読む（この公開に使うキーの選択用）。
  const refreshCloudKeys = useCallback(async () => {
    try { setCloudKeys(await listCloudKeys()) }
    catch { setCloudKeys([]) }
    try { setActiveKeyId(await getActiveCloudKeyId()) }
    catch { setActiveKeyId(null) }
  }, [])

  // 前提チェック（image 以外の構築に必要な 内蔵ビルダー / レジストリ認証の有無）
  // ※ loadEnv が依存配列で参照するため、loadEnv より前に定義する（初期化前アクセス＝TDZ を防ぐ）。
  const refreshPrereqs = useCallback(async () => {
    try {
      const r = await window.electronAPI.cloud.checkPrereqs(projectDir)
      setPrereqs({ sourceType: r.sourceType, builderMode: r.builderMode, builder: r.builder, docker: r.docker, dockerfile: r.dockerfile, registry: r.registry })
    } catch { setPrereqs(null) }
  }, [projectDir])

  // env.json を読み込む
  const loadEnv = useCallback(async () => {
    setEnvLoading(true); setEnvError(''); setPlan(null); setPlanError('')
    try {
      const r = await window.electronAPI.cloud.loadEnv(projectDir)
      if (r.ok) setSpec(r.spec)
      else { setSpec(null); setEnvError(r.errors.join(' / ')) }
    } catch (e: any) {
      setSpec(null); setEnvError(e?.message ?? String(e))
    } finally { setEnvLoading(false) }
    // spec が変わると前提（dockerfile/image・Dockerfile の有無）も変わり得るので取り直す。
    refreshPrereqs()
  }, [projectDir, refreshPrereqs])

  // TTL 確認
  const refreshExpiry = useCallback(async () => {
    try {
      const r = await window.electronAPI.cloud.checkExpiry(projectDir)
      if (r.ok) setExpiry({ expired: !!r.expired, createdAt: r.createdAt ?? null, ttlHours: r.ttlHours ?? null })
      else setExpiry(null)
    } catch { setExpiry(null) }
  }, [projectDir])

  // 公開URLを取得する（デプロイ済みのとき。未デプロイなら null）
  const refreshUrl = useCallback(async () => {
    setUrlLoading(true)
    try {
      const r = await window.electronAPI.cloud.appUrl(projectDir)
      setAppUrl(r.ok ? (r.url ?? null) : null)
    } catch { setAppUrl(null) }
    finally { setUrlLoading(false) }
  }, [projectDir])

  // 公開済みか（state.json に apprun-app リソースがあるか）を読む。APIキー不要の軽量チェック。
  const refreshPublished = useCallback(async () => {
    try {
      const r = await window.electronAPI.cloud.isPublished(projectDir)
      setPublished(r.ok ? !!r.published : false)
    } catch { setPublished(false) }
  }, [projectDir])

  // アクセス制限（パケットフィルタ）を読む
  const refreshAccessLimit = useCallback(async () => {
    setLimitLoading(true); setLimitMsg('')
    try {
      const r = await window.electronAPI.cloud.getAccessLimit(projectDir)
      if (r.ok && r.deployed) {
        setLimitEnabled(r.isEnabled ?? false)
        setLimitIps(r.ips ?? [])
      } else if (r.ok && !r.deployed) {
        // 未デプロイ: 初期値のまま
      } else {
        setLimitMsg(r.message ?? '取得に失敗しました')
      }
    } catch (e: any) {
      setLimitMsg(e?.message ?? String(e))
    } finally { setLimitLoading(false) }
  }, [projectDir])

  // マウント時／プロジェクト切替時に状態を初期化して読み込む
  useEffect(() => {
    setConn('idle'); setConnMsg('')
    setPlan(null); setPlanError('')
    setConfirm(null); setOpResult(null)
    setProgress(null)
    setAppUrl(null)
    setLimitEnabled(false); setLimitIps([]); setIpInput(''); setLimitMsg('')
    refreshKey(); refreshCloudKeys()
    loadEnv(); refreshExpiry(); refreshPrereqs(); refreshUrl(); refreshAccessLimit(); refreshPublished()
    // 破棄画面に「どのレジストリを消すか」を名前で出すため先に取っておく（失敗しても画面は動く）
    refreshRegistryName()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir])

  // 認証情報モーダルで保存されたら登録状態を取り直す（マウント中のみ）
  // レジストリ認証情報も認証情報モーダルで登録するため、前提チェックも取り直す。
  useEffect(() => {
    const h = () => { setConn('idle'); setConnMsg(''); refreshKey(); refreshPrereqs(); refreshCloudKeys() }
    window.addEventListener('sakura:credentials-changed', h)
    return () => window.removeEventListener('sakura:credentials-changed', h)
  }, [refreshKey, refreshPrereqs, refreshCloudKeys])

  // ── 接続テスト ──
  const testConnection = async () => {
    setConn('testing'); setConnMsg(''); setConnChecks(null)
    try {
      const r = await window.electronAPI.cloud.testConnection()
      setConnChecks(r.checks ?? null)
      setConn(r.ok ? 'ok' : 'ng')
      // 認証情報未保存などの全体メッセージのみ表示。各項目の詳細は下のリストで出す。
      if (!r.ok && r.message) setConnMsg(r.message)
      else setConnMsg('')
    } catch (e: any) {
      setConn('ng'); setConnChecks(null)
      setConnMsg(e?.message ?? 'APIキー/エンドポイントを確認してください（実APIキーが必要です）。')
    }
  }

  // ── この公開に使うキーを選択する ──
  // (a) 選んだキーを「使用中」にしてバックエンドへ同期 → (b) env.json に auth をピン留め保存 →
  // (c) 登録状態とキー一覧を取り直す。
  const selectKey = async (id: string) => {
    const r = await activateCloudKey(id)
    if (!r.ok) { setConn('ng'); setConnMsg(r.message ?? 'キーの切替に失敗しました'); return }
    const label = cloudKeys.find(k => k.id === id)?.label ?? 'キー'
    if (spec) {
      try {
        const nextSpec = { ...spec, auth: { keyId: id, keyLabel: label } }
        const sr = await window.electronAPI.cloud.saveEnv(projectDir, nextSpec)
        if (sr.ok) setSpec(sr.spec)
        else setEnvError(sr.errors.join(' / '))
      } catch (e: any) {
        setEnvError(e?.message ?? String(e))
      }
    }
    setConn('idle'); setConnMsg('')
    await refreshKey()
    await refreshCloudKeys()
  }

  // ── テスト環境を作成（scaffold） ──
  const scaffold = async () => {
    setScaffolding(true); setEnvError('')
    try {
      const r = await window.electronAPI.cloud.scaffoldEnv(projectDir, projName)
      if (r.ok) { setSpec(r.spec); refreshPrereqs() }
      else setEnvError(r.errors.join(' / '))
    } catch (e: any) {
      setEnvError(e?.message ?? String(e))
    } finally { setScaffolding(false) }
  }

  // このプロジェクトが使っているレジストリ名を取り直す。
  // 破棄の確認画面と公開後の費用案内がこの名前を出すので、レジストリを作った直後・
  // 破棄した直後には必ず取り直す（古い名前のまま出すと、消す対象を誤解させる）。
  const refreshRegistryName = () => {
    window.electronAPI.cloud.registryName(projectDir)
      .then(r => setRegistryName(r?.name ?? null))
      .catch(() => setRegistryName(null))
  }

  // ── レジストリを自動作成（クラウドAPI）。push 用認証も保存される ──
  const autoCreateRegistry = async () => {
    setRegCreating(true); setRegNotice('')
    try {
      const r = await window.electronAPI.cloud.ensureRegistry(projectDir)
      if (r.ok) {
        setRegistryFixed(true)
        setRegNotice(`${r.created ? '作成しました' : '既存のレジストリを利用します'}: ${r.server}（認証情報に保存済み）`)
        window.dispatchEvent(new Event('sakura:credentials-changed')) // 認証情報側にも反映
        refreshRegistryName() // 記録が更新されたので、破棄画面と費用案内が出す名前も取り直す
        await refreshPrereqs()
      } else {
        setRegistryFixed(false)
        setRegNotice(`自動作成に失敗しました: ${r.message ?? ''}`)
      }
    } catch (e: any) {
      setRegNotice(`自動作成に失敗しました: ${e?.message ?? String(e)}`)
    } finally { setRegCreating(false) }
  }

  // 当月の利用額（コスト実額）を取得（ベストエフォート。実APIの形が未確定なら失敗メッセージ）
  const refreshCost = async () => {
    setCostLoading(true); setCost(null)
    try {
      const r = await window.electronAPI.cloud.cost()
      setCost(r.ok ? { amountYen: r.amountYen, asOf: r.asOf } : { message: r.message })
    } catch (e: any) {
      setCost({ message: e?.message ?? String(e) })
    } finally { setCostLoading(false) }
  }

  // env.json をエディタで開く（App側の既存ファイルオープン導線を利用）
  const openEnvFile = () => {
    window.dispatchEvent(new CustomEvent('sakura:open-file', { detail: `${projectDir}/.sakura-cloud/env.json` }))
  }

  // TTL（期限）を変更して env.json に保存する。0=期限なし（継続運用）。
  const setTtl = async (hours: number) => {
    if (!spec || savingTtl) return
    setSavingTtl(true)
    try {
      const next = { ...spec, guardrails: { ...spec.guardrails, ttlHours: hours } }
      const r = await window.electronAPI.cloud.saveEnv(projectDir, next)
      if (r.ok) { setSpec(r.spec); refreshExpiry() }
      else setEnvError(r.errors.join(' / '))
    } catch (e: any) {
      setEnvError(e?.message ?? String(e))
    } finally { setSavingTtl(false) }
  }

  // ── プランを確認（ドライラン） ──
  const runPlan = async () => {
    setPlanning(true); setPlanError(''); setPlan(null)
    try {
      const r = await window.electronAPI.cloud.plan(projectDir)
      if (r.ok) setPlan(r.plan)
      else setPlanError(r.errors.join(' / '))
    } catch (e: any) {
      setPlanError(e?.message ?? String(e))
    } finally { setPlanning(false) }
  }

  // ── 構築（適用）: 先にプランを出してから確認ダイアログ ──
  const startApply = async () => {
    setOpResult(null)
    setPlanning(true); setPlanError(''); setPlan(null)
    try {
      const r = await window.electronAPI.cloud.plan(projectDir)
      if (r.ok) {
        setPlan(r.plan)
        // noop だけ（変更なし）なら確認ダイアログを出さず即適用してよいが、明示確認を優先する。
        setConfirm({ kind: 'apply', plan: r.plan })
      } else {
        setPlanError(r.errors.join(' / '))
      }
    } catch (e: any) {
      setPlanError(e?.message ?? String(e))
    } finally { setPlanning(false) }
  }

  const doApply = async () => {
    setBusy(true)
    // **新しい公開のたびに、回復ボタンの状態を戻す。** 前回整えた印を残したままだと、
    // 今回また同じ失敗をしたときにボタンが出ず、直せなくなる（2026-08-14）
    setRegistryFixed(false)
    setRegNotice('')
    setProgress('🚀 公開を開始しています…')
    // 構築中の進捗メッセージを購読（最新行を表示）。完了/失敗後に解除する。
    const unsubscribe = window.electronAPI.cloud.onApplyProgress(msg => setProgress(msg))
    // 実行中フラグ（終了確認ダイアログ用）。中断・失敗でも必ず解除されるよう最外の finally で呼ぶ。
    const endActivity = beginActivity('公開処理')
    try {
      // 公開開始マーカー（途中で中断・失敗しても後から検知できるようにする）。
      // API呼び出しが成功/失敗いずれで終わっても finally で必ず消す。
      await markPublishPending(projectDir, 'sakura-apprun')
      try {
        const r = await window.electronAPI.cloud.apply(projectDir, { confirmed: true })
        setOpResult(r)
        setConfirm(null)
        // 適用後はプラン・期限・前提・公開URL・公開済みフラグを取り直す
        await refreshExpiry()
        await refreshPrereqs()
        await runPlan()
        await refreshUrl()
        await refreshPublished()
        // 統一公開記録（publish.targets）: 構築成功時に記録。公開URLがあれば url に（無ければ null で記録）。
        if (r.ok) {
          try {
            const u = await window.electronAPI.cloud.appUrl(projectDir)
            await saveAppRunPublishRecord(projectDir, { publishedAt: new Date().toISOString(), url: (u.ok ? u.url : null) ?? null })
          } catch { /* 記録の失敗は公開の成否に影響させない */ }
        }
      } catch (e: any) {
        setOpResult({ ok: false, message: e?.message ?? String(e) })
        setConfirm(null)
      } finally {
        await clearPublishPending(projectDir)
      }
    } finally {
      unsubscribe()
      setProgress(null)
      setBusy(false)
      endActivity()
    }
  }

  const doTeardown = async () => {
    setBusy(true)
    try {
      // 記録が無いレジストリは削除できない。確認画面と同じ判断をここでも通す
      // （そうしないと「残るのに課金が続く」警告が出ない）。
      const effectiveDeleteRegistry = !!registryName && deleteRegistry
      const r = await window.electronAPI.cloud.teardown(projectDir, { confirmed: true, deleteRegistry: effectiveDeleteRegistry })
      // レジストリを残した場合は、破棄の結果画面でも「課金は続く」と念を押す
      // （「破棄した＝もう費用はかからない」と受け取られるのを防ぐ）。
      // 保存場所は破棄しても残ることがある（3段構え）。**残ったなら課金も続く。**
      // 残ったかどうかは結果でしか分からないので、main から受け取る（2026-08-14）
      const warn = remainingCostWarning({ deleteRegistry: effectiveDeleteRegistry, registryName, keptBucketName: r.keptBucketName ?? null })
      setOpResult(warn ? { ...r, message: [r.message, warn].filter(Boolean).join('\n') } : r)
      // 破棄できたら公開記録も消す（残すと「公開したもの一覧」に存在しない公開が出続ける）
      if (r.ok) { try { await clearAppRunPublishRecord(projectDir) } catch { /* 記録の掃除の失敗は破棄の成否に影響させない */ } }
      setConfirm(null)
      setAppUrl(null) // 破棄後はURLを消す
      refreshRegistryName() // レジストリを消したなら記録も消えている。残したなら記録は残る
      await refreshExpiry()
      await runPlan()
      await refreshPublished()
    } catch (e: any) {
      setOpResult({ ok: false, message: e?.message ?? String(e) })
      setConfirm(null)
    } finally { setBusy(false) }
  }

  // 公開名（spec.name）を保存する。retryPublish=true のときは保存後に公開処理を続けて呼ぶ
  // （衝突時のワンクリック再公開ボタン用）。useCallback にしない理由: doApply/doTeardown/scaffold と同じく
  // useEffect の依存配列からは参照されないため（JSXのイベントハンドラからのみ呼ばれる）。
  const saveRenamedSpec = async (next: string, retryPublish: boolean) => {
    if (!spec) return
    setRenaming(true)
    try {
      const nextSpec = { ...spec, name: next }
      const r = await window.electronAPI.cloud.saveEnv(projectDir, nextSpec)
      if (r.ok) {
        setSpec(r.spec)
        setPlan(null); setPlanError('')
        await refreshPrereqs()
        if (retryPublish) await startApply()
      } else {
        setEnvError(r.errors.join(' / '))
      }
    } catch (e: any) {
      setEnvError(e?.message ?? String(e))
    } finally {
      setRenaming(false)
    }
  }

  // 公開名の変更を要求する。公開済みなら確認ダイアログ（掟5）を挟み、未公開ならそのまま保存する。
  const requestRename = (raw: string, retryPublish: boolean) => {
    if (!spec) return
    const next = normalizeApprunName(raw)
    if (!next || next === spec.name) return
    if (published) {
      setConfirm({ kind: 'renameSpec', name: next, retryPublish })
    } else {
      void saveRenamedSpec(next, retryPublish)
    }
  }

  const doRenameConfirmed = async () => {
    if (confirm?.kind !== 'renameSpec') return
    const { name, retryPublish } = confirm
    setConfirm(null)
    await saveRenamedSpec(name, retryPublish)
  }

  const keyReady = hasKey === true

  // ── 親切カード（名前衝突の代替名提案 / アプリ作成上限）の表示判定 ──
  // どちらかが表示されるケースでは、生の失敗メッセージ本体（OpResultView）を折りたたみに降格して
  // カードを主役にする（所見17）。
  const conflictCardShown = !!(opResult && !opResult.ok && spec && isNameConflictError(opResult.message ?? ''))
  const limitCardShown = !!(opResult && !opResult.ok && isCreationLimitError(opResult.message ?? ''))

  // ── この公開に使うキーの導出値 ──
  // 選択中のキー id: env.json のピン留め（spec.auth.keyId）が一覧に存在すればそれ、無ければ「使用中」。
  const pinnedKeyId = spec?.auth?.keyId
  const pinnedExists = !!pinnedKeyId && cloudKeys.some(k => k.id === pinnedKeyId)
  const selectedKeyId = pinnedExists ? pinnedKeyId! : (activeKeyId ?? cloudKeys[0]?.id ?? null)
  const selectedKeyLabel = cloudKeys.find(k => k.id === selectedKeyId)?.label ?? '（未選択）'
  const pinnedLabel = cloudKeys.find(k => k.id === pinnedKeyId)?.label ?? ''
  const activeLabel = cloudKeys.find(k => k.id === activeKeyId)?.label ?? '（不明）'
  // ピン留めが存在し、かつ現在の「使用中」と食い違っているとき（自動切替はしない）。
  const pinnedMismatch = pinnedExists && !!activeKeyId && pinnedKeyId !== activeKeyId

  // image 以外のソース（dockerfile 等）のときだけ前提チェックを課す。
  // image ソースや判定不能時は前提を満たしているものとして扱う。
  const needsPrereqs = !!prereqs && prereqs.sourceType !== 'image' && prereqs.sourceType !== null
  const isDockerMode = prereqs?.builderMode === 'docker'
  // 標準: 内蔵ビルダー＋レジストリ。エキスパート: Docker＋Dockerfile＋レジストリ。
  const prereqsOk = !needsPrereqs || (isDockerMode
    ? (!!prereqs?.docker && !!prereqs?.dockerfile && !!prereqs?.registry)
    : (!!prereqs?.builder && !!prereqs?.registry))
  // 前提不足の理由（構築ボタンの title 用）。
  const prereqReason = needsPrereqs && !prereqsOk
    ? (isDockerMode
        ? (!prereqs?.docker ? 'Docker が見つかりません' : !prereqs?.dockerfile ? 'Dockerfile が見つかりません' : 'レジストリ認証情報が未登録です')
        : (!prereqs?.builder ? '内蔵ビルダーが見つかりません' : 'レジストリ認証情報が未登録です'))
    : ''

  // ビルド方式を切り替える（env.json を更新して再読込）。
  const switchMode = async (mode: 'builtin' | 'docker') => {
    if (prereqs?.builderMode === mode) return
    setModeSwitching(true)
    try {
      await window.electronAPI.cloud.setBuilderMode(projectDir, mode)
      await loadEnv()
      await refreshPrereqs()
    } catch { /* 失敗時は env エラーで表示 */ }
    finally { setModeSwitching(false) }
  }

  if (confirm) {
    // ── 破壊操作の確認ダイアログ（ServerFilesModal のアップロード確認と同じ作り） ──
    return (
      <ConfirmDialog
        confirm={confirm}
        busy={busy || renaming}
        onCancel={() => setConfirm(null)}
        onApply={doApply}
        onTeardown={doTeardown}
        registryName={registryName}
        deleteRegistry={deleteRegistry}
        onChangeDeleteRegistry={setDeleteRegistry}
        onRename={doRenameConfirmed}
        placement={placement}
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* 📦 さくらのAppRun で公開（HanamiiPanel と同じ体裁の説明ボックス） */}
      <div className="rounded-xl border border-line bg-surface p-4 space-y-1">
        <p className="text-sm font-semibold text-ink">📦 さくらのAppRun で公開</p>
        <p className="text-xs text-ink-muted leading-relaxed">
          Dockerコンテナを動かすPaaS。IDEが自動でビルド・レジストリ作成・公開URL発行まで行います（Docker不要）。
        </p>
        {getTargetProfile('sakura-apprun').serviceUrl && (
          <p className="text-[11px] text-ink-muted">
            <a href={getTargetProfile('sakura-apprun').serviceUrl} className="hover:underline">🌐 公式サイトを見る ↗</a>
          </p>
        )}
      </div>

      {/* TTL 超過の警告バナー（開いた時 checkExpiry が expired を返したら） */}
      {expiry?.expired && (
        <div className="rounded-xl border border-brand-red/70 bg-surface p-3 flex items-center gap-3">
          <p className="flex-1 text-sm text-ink leading-relaxed">
            ⏰ この環境は予定時間（TTL）を過ぎています。使わない場合は破棄してください。
          </p>
          <button
            onClick={() => { setOpResult(null); setConfirm({ kind: 'teardown' }) }}
            disabled={busy}
            className="flex-none bg-brand-red text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-40"
          >🗑 破棄する</button>
        </div>
      )}

      {/* ① APIキー（入力は「認証情報」に一本化。ここは状態表示と接続テストのみ） */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">① APIキー</p>
          {hasKey === null
            ? <span className="text-xs text-ink-muted">確認中…</span>
            : keyReady
              ? <span className="text-xs text-brand-green font-semibold">✅ APIキー登録済み</span>
              : <span className="text-xs text-brand-yellow font-semibold">⚠️ APIキーが未登録です</span>}
        </div>
        <p className="text-[11px] text-ink-muted leading-relaxed">
          さくらのクラウドのAPIキー（アクセストークン／トークンシークレット）は「認証情報」で登録・切替します。AppRun に専用のAPIキーはなく、このキーで操作します。
        </p>

        {/* この公開に使うキーの選択（登録キーが1つ以上あるとき） */}
        {cloudKeys.length > 0 ? (
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-ink-secondary">この公開に使うキー</label>
            <select
              value={selectedKeyId ?? ''}
              onChange={e => selectKey(e.target.value)}
              className="w-full bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink outline-none focus:border-sakura"
            >
              {cloudKeys.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <p className="text-[11px] text-ink-secondary">
              この公開に使うキー: <span className="font-medium text-ink">{selectedKeyLabel}</span>
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-brand-yellow leading-relaxed">
            まだクラウドのキーが登録されていません。「認証情報」でアクセストークン／シークレットを登録してください。
          </p>
        )}

        {/* 権限についての注意（このキーに必要な権限） */}
        <p className="text-[11px] text-ink-muted leading-relaxed">
          このキーには、AppRun・コンテナレジストリの作成/操作権限と、請求（コスト）の閲覧権限が必要です。権限が不足していると公開やコスト取得に失敗します。
        </p>

        {/* ピン留めキーと「使用中」キーの不一致（自動切替はせず、明示確認のみ） */}
        {pinnedMismatch && (
          <div className="rounded-lg border border-brand-yellow/70 bg-overlay p-3 space-y-2">
            <p className="text-[11px] text-ink-secondary leading-relaxed">
              このプロジェクトは『{spec?.auth?.keyLabel || pinnedLabel}』を使う設定ですが、現在の使用中キーは『{activeLabel}』です。
            </p>
            <button
              onClick={() => spec?.auth?.keyId && selectKey(spec.auth.keyId)}
              className="text-xs text-sakura border border-sakura/50 rounded-md px-2 py-1 hover:bg-overlay"
            >このキーに切り替える</button>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={onOpenCredentials}
            className="bg-overlay text-ink border border-line rounded-lg px-3 py-2 text-sm font-medium hover:border-sakura"
          >🔑 認証情報で登録・切替</button>
          <button
            onClick={testConnection}
            disabled={conn === 'testing' || !keyReady}
            title={keyReady ? '' : '先に認証情報でAPIキーを登録してください'}
            className="bg-overlay text-ink border border-line rounded-lg px-3 py-2 text-sm font-medium hover:border-sakura disabled:opacity-40"
          >🔌 接続テスト</button>
          <span className="flex-1 text-xs text-right">
            {conn === 'ok' && <span className="text-brand-green font-semibold">✅ すべて確認できました</span>}
            {conn === 'ng' && <span className="text-brand-yellow font-semibold">⚠️ 一部の権限が確認できませんでした</span>}
            {conn === 'testing' && <span className="text-ink-secondary">確認中…</span>}
          </span>
        </div>
        {!keyReady && (
          <p className="text-[11px] text-ink-muted leading-relaxed">
            先に認証情報でAPIキーを登録してください。
          </p>
        )}
        {/* 3 点チェック結果（GET のみの非破壊プローブ）。各行に ✓/✗ と領域名・失敗理由を表示。 */}
        {connChecks && (
          <div className="rounded-lg border border-line bg-overlay px-3 py-2 space-y-1.5">
            {([
              ['apprun', 'AppRun 参照'],
              ['registry', 'コンテナレジストリ 一覧'],
              ['billing', '請求（コスト）参照'],
            ] as const).map(([key, label]) => {
              const c = connChecks[key]
              return (
                <div key={key} className="text-xs leading-relaxed">
                  <span className={c.ok ? 'text-brand-green font-semibold' : 'text-brand-red font-semibold'}>
                    {c.ok ? '✓' : '✗'}
                  </span>
                  <span className="ml-1.5 text-ink">{label}</span>
                  {!c.ok && c.message && (
                    <span className="ml-2 text-[11px] text-ink-muted">{c.message}</span>
                  )}
                </div>
              )
            })}
            <p className="text-[11px] text-ink-muted leading-relaxed pt-1">
              ※「作成」権限は実際に作成するまで確認できません（ここでは参照の可否のみ確認）。
            </p>
          </div>
        )}
        {/* 認証情報未保存など、項目別に出せない全体エラーのみ表示。 */}
        {conn === 'ng' && connMsg && (
          <p className="text-xs text-white bg-brand-red/90 rounded-lg px-3 py-2 leading-relaxed">
            {connMsg}
          </p>
        )}
      </section>

      {/* ② 公開の設定（env.json） */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">② 公開の設定</p>
          <button
            onClick={loadEnv}
            disabled={envLoading}
            className="flex-none text-xs text-ink-secondary border border-line rounded-md px-2 py-1 hover:border-sakura disabled:opacity-40"
          >↻ 再読み込み</button>
        </div>

        {envLoading ? (
          <p className="text-sm text-ink-secondary py-2">読み込み中…</p>
        ) : !spec ? (
          // エラーがあっても「作成」導線は必ず残す（以前はエラー表示だけになり操作不能に見えた）
          <div className="space-y-2">
            {envError && (
              <p className="text-xs text-white bg-brand-red/90 rounded-lg px-3 py-2 leading-relaxed break-all select-text">{envError}</p>
            )}
            <p className="text-sm text-ink-secondary leading-relaxed">
              このプロジェクトにはまだ公開の設定がありません。ひな形（env.json）を自動で作成できます。
            </p>
            <button
              onClick={scaffold}
              disabled={scaffolding}
              className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
            >{scaffolding ? '作成中…' : '☁ 公開の設定を作成'}</button>
          </div>
        ) : envError ? (
          <p className="text-xs text-white bg-brand-red/90 rounded-lg px-3 py-2 leading-relaxed break-all">{envError}</p>
        ) : (
          <SpecSummary
            spec={spec}
            onEdit={openEnvFile}
            onSetTtl={setTtl}
            savingTtl={savingTtl}
            onRename={next => requestRename(next, false)}
            renaming={renaming}
            published={published}
          />
        )}
      </section>

      {/* ③ 事前チェック（実行前の差分プレビュー＝plan/dry-run） */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">③ 事前チェック</p>
          <button
            onClick={runPlan}
            disabled={planning || !spec}
            title={spec ? '' : '先に公開の設定を作成してください'}
            className="flex-none bg-overlay text-ink border border-line rounded-md px-3 py-1 text-xs font-medium hover:border-sakura disabled:opacity-40"
          >{planning ? '確認中…' : '何が作られるか確認'}</button>
        </div>
        <p className="text-[11px] text-ink-muted leading-relaxed">
          公開する前に、さくら側で何が作成・更新・削除されるかを確認できます（この操作では何も変更しません）。
        </p>
        {planError && (
          <p className="text-xs text-white bg-brand-red/90 rounded-lg px-3 py-2 leading-relaxed break-all">{planError}</p>
        )}
        {plan && <PlanView plan={plan} />}
      </section>

      {/* ④ 公開・破棄（apply / teardown） */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <p className="text-sm font-semibold text-ink">④ 公開・破棄</p>

        {/* ビルド方式の切替（プロジェクトからビルドするとき） */}
        {needsPrereqs && (
          <div className="rounded-lg border border-line bg-overlay p-3 space-y-1.5">
            <p className="text-[11px] font-semibold text-ink-secondary">ビルド方式</p>
            <div className="flex gap-2 text-xs">
              <button onClick={() => switchMode('builtin')} disabled={modeSwitching}
                className={`px-2.5 py-1 rounded border ${!isDockerMode ? 'border-sakura text-sakura bg-sakura/10' : 'border-line text-ink-muted hover:text-ink'} disabled:opacity-50`}>
                標準（Docker不要）
              </button>
              <button onClick={() => switchMode('docker')} disabled={modeSwitching}
                className={`px-2.5 py-1 rounded border ${isDockerMode ? 'border-sakura text-sakura bg-sakura/10' : 'border-line text-ink-muted hover:text-ink'} disabled:opacity-50`}>
                エキスパート（自分のDockerfile・Docker使用）
              </button>
            </div>
            <p className="text-[11px] text-ink-muted">
              {isDockerMode
                ? 'あなたの Dockerfile を Docker でビルドします（RUN 等が使えます／Docker の導入が必要）。'
                : 'IDE 内蔵のビルダーで「土台＋あなたのファイル」を組み立てます（Docker 不要・準備ゼロ）。'}
            </p>
          </div>
        )}

        {/* dockerfile ソースのときだけ前提チェックリストを表示（いずれか✗なら構築不可） */}
        {needsPrereqs && (
          <PrereqChecklist prereqs={prereqs} onOpenCredentials={onOpenCredentials} onAutoCreateRegistry={autoCreateRegistry} regCreating={regCreating} regNotice={regNotice} keyReady={keyReady} />
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={startApply}
            disabled={busy || planning || !spec || !keyReady || !prereqsOk}
            title={
              !keyReady ? '先にAPIキーを登録してください'
                : !spec ? '先に公開の設定を作成してください'
                  : prereqReason || ''
            }
            className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
          >🚀 公開する（作成・更新）</button>
          <button
            onClick={() => { setOpResult(null); setConfirm({ kind: 'teardown' }) }}
            disabled={busy || !keyReady}
            title={!keyReady ? '先にAPIキーを登録してください' : ''}
            className="bg-overlay text-brand-red border border-brand-red/50 rounded-lg px-4 py-2 text-sm font-semibold hover:bg-brand-red/10 disabled:opacity-40"
          >🗑 破棄する（削除）</button>
        </div>
        <p className="text-[11px] text-ink-muted leading-relaxed">
          「公開する」は事前チェックを表示して確認してから実行します。「破棄する」はデータ（バケット）も含めて削除する場合があります。
        </p>
        {needsPrereqs && !prereqsOk && (
          <p className="text-[11px] text-brand-yellow leading-relaxed">
            ⚠️ {prereqReason}。公開にはコンテナレジストリの認証情報が必要です。
          </p>
        )}

        {/* 構築中の進捗（最新行＋スピナー） */}
        {busy && progress && (
          <div className="rounded-lg border border-line bg-overlay px-3 py-2 flex items-center gap-2">
            <span className="inline-block w-3.5 h-3.5 border-2 border-sakura border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-ink-secondary leading-relaxed break-all">{progress}</span>
          </div>
        )}

        {/* 公開名の衝突（重複）時: ワンクリックで代替名に変えて公開し直す。
            公開済みなら requestRename が確認ダイアログ（renameSpec）を挟んでから公開処理を続ける。 */}
        {conflictCardShown && spec && (
          <NameConflictRetry
            currentName={spec.name}
            maxLen={APPRUN_NAME_MAX_LEN}
            onRetry={suggested => requestRename(suggested, true)}
          />
        )}

        {/* アプリ作成上限（アカウント単位・"Creation limit reached"）: 名前を変えても解決しないため、
            代替名提案ではなく「不要なアプリの削除」への誘導を出す（2026-07-12 ユーザー報告の実例）。 */}
        {limitCardShown && (
          <div className="rounded-lg border border-brand-yellow/70 bg-elevated p-3 text-[11px] text-ink-secondary leading-relaxed space-y-1.5">
            <p className="font-semibold text-ink">⚠️ アカウントで作成できるAppRunアプリ数が上限に達しています</p>
            <p>
              新しいアプリを作成できない状態です（公開名を変えても解決しません）。
              さくらのクラウドのコントロールパネル（AppRun）で<b className="text-ink">使っていないアプリを削除</b>してから、もう一度公開してください。
            </p>
            <p className="text-ink-muted">
              ※ このIDEでプロジェクトを削除しても、公開済みのAppRunアプリはアカウントに残ります。
              過去のテストで公開したアプリが溜まっている可能性があります。上限の緩和はさくらのクラウドのサポートに申請できます。
            </p>
            <a href="https://secure.sakura.ad.jp/cloud/" className="text-sakura hover:underline">さくらのクラウド コントロールパネルを開く ↗</a>
          </div>
        )}

        {/* 実行結果。親切カード（名前衝突/作成上限）が主役のケースでは、生の失敗メッセージ本体を
            折りたたみに降格する（所見17: 親切カードと生エラーの二重表示の解消）。 */}
        {opResult && <OpResultView result={opResult} demoted={conflictCardShown || limitCardShown} />}
        {/* 「困ったときだけ現れる」導線。push が401、または別プロジェクトのレジストリを
            指しているときに main が hint を付けてくる。押すと ensureRegistry をやり直し、
            このプロジェクトのレジストリと push 用パスワードを整える。 */}
        {opResult && !opResult.ok && opResult.hint === 'reset-registry' && (
          <div className="rounded-xl border border-sakura/50 bg-surface p-3 space-y-1.5">
            {/* **整ったらボタンは消す。** 出したままだと「効いていないのでは」と
                何度も押させる（2026-08-14 Ryosuke 指摘）。次にやることだけを示す */}
            {registryFixed ? (
              <>
                <p className="text-xs font-semibold text-ink">✅ レジストリが整いました</p>
                <p className="text-[11px] text-ink-secondary leading-relaxed">
                  上の「🚀 公開する（作成・更新）」をもう一度押してください。
                </p>
              </>
            ) : (
              <>
                <button
                  onClick={autoCreateRegistry}
                  disabled={regCreating || !keyReady}
                  className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-40"
                >{regCreating ? '設定し直しています…' : '↻ レジストリを設定し直す'}</button>
                <p className="text-[11px] text-ink-secondary leading-relaxed">
                  このプロジェクトのコンテナレジストリを探し直し、push 用のパスワードを作り直します。
                  見つからない場合は新しく作るため、月額{REGISTRY_MONTHLY_YEN}円（税込）がかかり始めます。
                </p>
              </>
            )}
            {regNotice && <p className="text-[11px] text-ink select-text break-words">{regNotice}</p>}
          </div>
        )}
      </section>

      {/* 公開URL（デプロイ済みのとき） */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">🌐 公開URL</p>
          <button onClick={refreshUrl} disabled={urlLoading || !spec} className="text-xs text-ink-muted hover:underline disabled:opacity-50">
            {urlLoading ? '取得中…' : '↻ 更新'}
          </button>
        </div>
        {appUrl ? (
          <div className="flex items-center gap-2 flex-wrap">
            <a href={appUrl} className="text-sakura hover:underline break-all">{appUrl}</a>
            <a href={appUrl} className="px-2 py-0.5 rounded bg-sakura/10 text-sakura hover:bg-sakura/20 text-xs flex-none">🌐 開く</a>
            <CopyButton text={appUrl} title="公開URLをコピー" />
          </div>
        ) : (
          <p className="text-xs text-ink-muted">{urlLoading ? '取得中…' : 'まだ公開URLはありません（公開すると表示されます）。'}</p>
        )}
        {/* 公開したら必ず目に入る場所に、止まらない費用を書く。破棄画面まで来ない人が大半のため
            （2026-08-06 ユーザー指摘: アプリを消してもレジストリが残ると月額課金が続く）。 */}
        {appUrl && (
          <p className="text-[11px] text-ink-secondary leading-relaxed bg-overlay rounded-lg px-3 py-2">
            💰 {ongoingCostNotice({ registryName, bucket: placement ? { name: placement.bucket, shared: placement.shared } : null })}
          </p>
        )}
      </section>

      {/* ⑤ 限定公開（アクセス制限／IP制限）- デプロイ済みのときだけ表示 */}
      {appUrl && (
        <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-ink">⑤ 限定公開（アクセス制限）</p>
            <button
              onClick={refreshAccessLimit}
              disabled={limitLoading}
              className="text-xs text-ink-muted hover:underline disabled:opacity-50"
            >{limitLoading ? '取得中…' : '↻ 更新'}</button>
          </div>

          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={limitEnabled}
              onChange={e => setLimitEnabled(e.target.checked)}
              className="mt-0.5 accent-sakura"
            />
            <span className="text-sm text-ink leading-snug">
              許可したIPアドレスだけがアクセスできるようにする（限定公開）
            </span>
          </label>

          {limitEnabled && (
            <div className="space-y-3">
              {/* 許可IPリスト */}
              {limitIps.length > 0 ? (
                <ul className="rounded-lg border border-line bg-overlay divide-y divide-line">
                  {limitIps.map((entry, i) => (
                    <li key={i} className="flex items-center justify-between px-3 py-2 gap-2">
                      <span className="text-xs font-mono text-ink">{entry.ip}/{entry.prefix}</span>
                      <button
                        onClick={() => setLimitIps(prev => prev.filter((_, j) => j !== i))}
                        className="text-[11px] text-brand-red hover:underline flex-none"
                      >✕ 削除</button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-ink-muted">許可IPがまだありません。</p>
              )}

              {/* 空リスト警告 */}
              {limitIps.length === 0 && (
                <p className="text-[11px] text-brand-red leading-relaxed font-semibold">
                  ⚠️ リストが空のまま有効にすると、誰もアクセスできなくなります。
                </p>
              )}

              {/* IP入力 */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={ipInput}
                  onChange={e => setIpInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const parsed = parseIpInput(ipInput)
                      if (!parsed) { setLimitMsg('IPアドレスの形式が正しくありません（例: 203.0.113.5 または 203.0.113.0/24）'); return }
                      setLimitIps(prev => [...prev, parsed]); setIpInput(''); setLimitMsg('')
                    }
                  }}
                  placeholder="例: 203.0.113.5 または 203.0.113.0/24"
                  className="flex-1 bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink outline-none focus:border-sakura placeholder:text-ink-muted"
                />
                <button
                  onClick={() => {
                    const parsed = parseIpInput(ipInput)
                    if (!parsed) { setLimitMsg('IPアドレスの形式が正しくありません（例: 203.0.113.5 または 203.0.113.0/24）'); return }
                    setLimitIps(prev => [...prev, parsed]); setIpInput(''); setLimitMsg('')
                  }}
                  className="bg-overlay text-ink border border-line rounded-lg px-3 py-2 text-sm font-medium hover:border-sakura"
                >追加</button>
              </div>

              {/* 現在のIPを追加 */}
              <button
                onClick={async () => {
                  setLimitMsg('')
                  const r = await window.electronAPI.cloud.myIp()
                  if (!r.ok) { setLimitMsg(r.message ?? 'IPの取得に失敗しました'); return }
                  const ip = r.ip!
                  const already = limitIps.some(e => e.ip === ip && e.prefix === 32)
                  if (!already) setLimitIps(prev => [...prev, { ip, prefix: 32 }])
                  else setLimitMsg(`${ip}/32 はすでにリストにあります`)
                }}
                className="text-sm text-sakura border border-sakura/50 rounded-lg px-3 py-2 hover:bg-overlay w-full text-left"
              >📍 今アクセスしている場所のIPを追加</button>
            </div>
          )}

          {/* 保存ボタン */}
          <div className="flex items-center gap-3">
            <button
              onClick={async () => {
                setLimitSaving(true); setLimitMsg('')
                try {
                  const r = await window.electronAPI.cloud.setAccessLimit(projectDir, { isEnabled: limitEnabled, ips: limitIps })
                  setLimitMsg(r.ok ? '✅ 保存しました' : (r.message ?? '保存に失敗しました'))
                } catch (e: any) {
                  setLimitMsg(e?.message ?? String(e))
                } finally { setLimitSaving(false) }
              }}
              disabled={limitSaving}
              className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
            >{limitSaving ? '保存中…' : '保存'}</button>
            {limitMsg && <p className="text-xs text-ink-secondary leading-relaxed flex-1">{limitMsg}</p>}
          </div>

          <p className="text-[11px] text-ink-muted leading-relaxed">
            公開URLは変わりません。許可リスト外のIPからはアクセスがブロックされます。回線のIPが変わるとアクセスできなくなることがあります。
          </p>
        </section>
      )}

      {/* コスト（直近の確定請求額をベストエフォートで取得・表示のみ） */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">💰 コスト</p>
          <button onClick={refreshCost} disabled={costLoading} className="text-xs text-ink-muted hover:underline disabled:opacity-50">
            {costLoading ? '取得中…' : '実額を取得'}
          </button>
        </div>
        {cost && (
          cost.amountYen != null
            ? <p className="text-xs text-ink">直近の確定請求額{cost.asOf ? `（${cost.asOf}分）` : ''}: <span className="font-semibold">¥{cost.amountYen.toLocaleString()}</span></p>
            : <p className="text-[11px] text-ink-muted">実額を取得できませんでした: {cost.message}</p>
        )}
        {!cost && <p className="text-[11px] text-ink-muted">「実額を取得」で直近に確定したクラウドの請求額を確認できます。</p>}
      </section>
    </div>
  )
}

// IPアドレス入力のパース（CIDR記法対応）
function parseIpInput(raw: string): { ip: string; prefix: number } | null {
  const s = raw.trim()
  if (!s) return null
  let ip = s, prefix = 32
  if (s.includes('/')) {
    const [a, b] = s.split('/')
    ip = a.trim(); prefix = Number(b)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  }
  const octets = ip.split('.')
  if (octets.length !== 4) return null
  if (!octets.every(o => /^\d{1,3}$/.test(o) && Number(o) >= 0 && Number(o) <= 255)) return null
  return { ip, prefix }
}

// TTL（期限）のプリセット。0=期限なし（継続運用）。
const TTL_PRESETS: { hours: number; label: string }[] = [
  { hours: 0, label: '期限なし（継続運用）' },
  { hours: 6, label: '6時間' },
  { hours: 24, label: '24時間' },
  { hours: 72, label: '72時間（3日）' },
  { hours: 168, label: '168時間（7日）' },
]

// ── 環境スペックの要約表示 ──
function SpecSummary({ spec, onEdit, onSetTtl, savingTtl, onRename, renaming, published }: {
  spec: CloudEnvSpec
  onEdit: () => void
  onSetTtl: (hours: number) => void
  savingTtl: boolean
  onRename: (nextName: string) => void
  renaming: boolean
  published: boolean
}) {
  const src = spec.service.source
  const sourceText = src.type === 'image' ? `image: ${src.ref}` : `dockerfile: ${src.context}`
  // 現在値がプリセットに無ければ、その値も選択肢として出す。
  const ttl = spec.guardrails.ttlHours
  const presets = TTL_PRESETS.some(p => p.hours === ttl) ? TTL_PRESETS : [...TTL_PRESETS, { hours: ttl, label: `${ttl}時間` }]

  // 公開名（spec.name）のインライン編集。
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState(spec.name)
  useEffect(() => { if (!editingName) setNameInput(spec.name) }, [spec.name, editingName])
  // Enter確定→inputアンマウント→ネイティブblur、の順で commitName が2連続で呼ばれても
  // onRename を二重発火させない冪等ガード（state はクロージャが古い値を見るため ref で判定）
  const nameCommittedRef = useRef(false)
  const commitName = () => {
    if (nameCommittedRef.current) return
    nameCommittedRef.current = true
    setEditingName(false)
    if (nameInput.trim() && nameInput !== spec.name) onRename(nameInput)
  }

  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-ink-muted">name</dt>
        <dd className="text-ink font-medium break-all">
          {editingName ? (
            <div className="flex items-center gap-1.5">
              <input
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onBlur={commitName}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitName()
                  if (e.key === 'Escape') { nameCommittedRef.current = true; setNameInput(spec.name); setEditingName(false) } // キャンセル後のネイティブblurで誤確定しないようガード
                }}
                disabled={renaming}
                autoFocus
                className="flex-1 bg-surface border border-sakura rounded-md px-2 py-1 text-xs text-ink font-mono outline-none disabled:opacity-50"
              />
              {renaming && <span className="text-[11px] text-ink-muted flex-none">保存中…</span>}
            </div>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {spec.name}
              <button
                onClick={() => { setNameInput(spec.name); nameCommittedRef.current = false; setEditingName(true) }}
                title="公開名を編集"
                className="flex-none text-ink-muted hover:text-sakura"
              >✏️</button>
            </span>
          )}
          {!editingName && (
            <span className="block text-[11px] text-ink-muted mt-0.5 font-normal">
              {published ? '変更すると次回公開時に新しいアプリになり、公開URLが変わります。' : '半角英数字とハイフン・3〜40文字。'}
            </span>
          )}
        </dd>
        <dt className="text-ink-muted">backend</dt><dd className="text-ink">{spec.backend}</dd>
        <dt className="text-ink-muted">region</dt><dd className="text-ink">{spec.region}</dd>
        <dt className="text-ink-muted">service</dt>
        <dd className="text-ink break-all">
          port {spec.service.port} ／ <span className="font-mono">{sourceText}</span>
        </dd>
        <dt className="text-ink-muted">scale</dt>
        <dd className="text-ink">{spec.service.scale.min} – {spec.service.scale.max}</dd>
        <dt className="text-ink-muted">バケット</dt>
        <dd className="text-ink break-all">
          {spec.persistence.objectStorage.length === 0
            ? <span className="text-ink-muted">なし</span>
            : spec.persistence.objectStorage.map(b => b.bucket).join('、 ')}
        </dd>
        <dt className="text-ink-muted">期限(TTL)</dt>
        <dd className="text-ink">
          <select
            value={ttl}
            onChange={e => onSetTtl(Number(e.target.value))}
            disabled={savingTtl}
            className="bg-surface border border-line rounded-md px-2 py-1 text-xs text-ink outline-none focus:border-sakura disabled:opacity-50"
          >
            {presets.map(p => <option key={p.hours} value={p.hours}>{p.label}</option>)}
          </select>
          {savingTtl && <span className="ml-2 text-ink-muted">保存中…</span>}
          <span className="block text-[11px] text-ink-muted mt-1">
            {ttl > 0
              ? '作成からこの時間を過ぎると、次に開いた時に破棄を促します（自動削除はしません）。'
              : '期限なし。破棄するまで動き続けます（課金も継続）。'}
          </span>
        </dd>
      </dl>
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onEdit}
          className="text-xs font-medium text-sakura hover:underline"
        >env.json を編集</button>
      </div>
    </div>
  )
}

// ── プラン一覧表示（type で色分け・stateful バッジ・stateful delete 警告） ──
function PlanView({ plan }: { plan: CloudPlan }) {
  if (plan.actions.length === 0) {
    return <p className="text-sm text-ink-muted py-1">変更はありません（環境は最新の状態です）。</p>
  }
  return (
    <div className="space-y-2">
      {plan.hasStatefulDelete && (
        <p className="text-xs text-white bg-brand-red/90 rounded-lg px-3 py-2 leading-relaxed font-semibold">
          ⚠️ データが消える削除を含みます（バケットの削除）。
        </p>
      )}
      <ul className="divide-y divide-line">
        {plan.actions.map((a, i) => {
          const tone = actionTone(a.type)
          const destructive = a.type === 'delete'
          return (
            <li key={`${a.kind}:${a.name}:${i}`} className={`flex items-start gap-2 py-2 ${a.type === 'noop' ? 'opacity-60' : ''}`}>
              <span className={`flex-none mt-1.5 w-2 h-2 rounded-full ${tone.dot}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-semibold ${tone.text} ${destructive ? 'underline decoration-brand-red/60' : ''}`}>{tone.label}</span>
                  <span className="text-xs text-ink-secondary">{kindLabel(a.kind)}</span>
                  <span className="text-xs text-ink font-mono break-all">{a.name}</span>
                  {a.stateful && (
                    <span className="text-[10px] text-brand-blue border border-brand-blue/50 rounded px-1.5 py-0.5">データ保持</span>
                  )}
                  {destructive && a.stateful && (
                    <span className="text-[10px] text-white bg-brand-red rounded px-1.5 py-0.5">データ削除</span>
                  )}
                </div>
                <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5 break-all">{a.description}</p>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ── apply / teardown の結果表示 ──
// detail は失敗時の生ログ（stderr要約等・診断用・所見12）。文言に混ぜず <details>「詳細を見る」で折りたたむ。
// demoted=true（名前衝突/作成上限の親切カードが主役のケース・所見17）ではブロックごと折りたたみに降格する。
function OpResultView({ result, demoted = false }: { result: { ok: boolean; executed?: string[]; skipped?: string[]; message?: string; detail?: string }; demoted?: boolean }) {
  const copyText = [result.message, result.detail].filter(Boolean).join('\n')
  const body = (
    <div className={`rounded-xl border p-3 ${result.ok ? 'border-brand-green/60' : 'border-brand-red/60'} bg-overlay space-y-1.5`}>
      <p className={`text-xs font-semibold ${result.ok ? 'text-brand-green' : 'text-brand-red'}`}>
        {result.ok ? '✅ 完了しました' : '⚠️ 失敗しました'}
      </p>
      {result.message && (
        <div className="flex items-start gap-1.5">
          <p className="text-xs text-ink-secondary leading-relaxed break-all flex-1 select-text whitespace-pre-wrap">{result.message}</p>
          <CopyButton text={copyText} />
        </div>
      )}
      {result.detail && (demoted ? (
        <pre className="text-[11px] text-ink-muted font-mono leading-relaxed whitespace-pre-wrap break-all select-text">{result.detail}</pre>
      ) : (
        <details>
          <summary className="text-[11px] text-ink-muted cursor-pointer select-none hover:text-ink">詳細を見る</summary>
          <pre className="mt-1 text-[11px] text-ink-muted font-mono leading-relaxed whitespace-pre-wrap break-all select-text">{result.detail}</pre>
        </details>
      ))}
      {result.executed && result.executed.length > 0 && (
        <div>
          <p className="text-[11px] text-ink-muted">実行（executed）</p>
          <ul className="text-[11px] text-ink font-mono list-disc pl-4 break-all">
            {result.executed.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}
      {result.skipped && result.skipped.length > 0 && (
        <div>
          <p className="text-[11px] text-ink-muted">スキップ（skipped）</p>
          <ul className="text-[11px] text-ink-secondary font-mono list-disc pl-4 break-all">
            {result.skipped.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
  if (demoted) {
    return (
      <details className="rounded-lg border border-line bg-overlay p-3">
        <summary className="text-[11px] text-ink-muted cursor-pointer select-none hover:text-ink">詳細を見る（元のエラーメッセージ）</summary>
        <div className="mt-2">{body}</div>
      </details>
    )
  }
  return body
}

// 公開名の衝突（重複）時に表示する、ワンクリックで代替名に変えて公開し直すブロック。
// suggested は currentName（≒直近に失敗した名前）が変わるたびに新しく算出する（HanamiiPanel の
// NameConflictRetry と同じ考え方: 代替名でも再衝突すれば currentName が変わり、毎回新しいランダムな候補になる）。
function NameConflictRetry({ currentName, maxLen, onRetry }: { currentName: string; maxLen: number; onRetry: (suggested: string) => void }) {
  const suggested = useMemo(() => suggestAlternativeName(currentName, maxLen), [currentName, maxLen])
  return (
    <div className="rounded-lg border border-brand-yellow/70 bg-overlay p-3 space-y-2">
      <p className="text-xs text-ink font-semibold">⚠️ この公開名（{currentName}）は既に使われています。</p>
      <button
        onClick={() => onRetry(suggested)}
        className="text-xs text-sakura border border-sakura/50 rounded-md px-2.5 py-1.5 hover:bg-overlay"
      >『{suggested}』に変えて公開し直す</button>
    </div>
  )
}

// ── 前提チェックリスト（構築時：内蔵ビルダー / レジストリ登録） ──
// Docker のインストールも Dockerfile も不要。IDE 同梱のビルダーで組み立てる。
function PrereqChecklist({
  prereqs,
  onOpenCredentials,
  onAutoCreateRegistry,
  regCreating,
  regNotice,
  keyReady,
}: {
  prereqs: { builderMode: 'builtin' | 'docker'; builder?: boolean; docker?: boolean; dockerfile?: boolean; registry: boolean } | null
  onOpenCredentials: () => void
  onAutoCreateRegistry: () => void
  regCreating: boolean
  regNotice: string
  keyReady: boolean
}) {
  const isDocker = prereqs?.builderMode === 'docker'
  const registry = !!prereqs?.registry
  const mark = (ok: boolean) =>
    ok ? <span className="text-brand-green font-semibold">✓</span> : <span className="text-brand-red font-semibold">✗</span>
  return (
    <div className="rounded-lg border border-line bg-overlay p-3 space-y-2">
      <p className="text-[11px] font-semibold text-ink-secondary">{isDocker ? '公開するための前提（エキスパート＝Docker使用）' : '公開するための前提（Docker は不要です）'}</p>
      <ul className="space-y-1.5 text-xs">
        {isDocker ? (
          <>
            <li className="flex items-center gap-2 flex-wrap">
              {mark(!!prereqs?.docker)}
              <span className="text-ink">Docker 導入</span>
              {!prereqs?.docker && <a href="https://www.docker.com/products/docker-desktop/" className="text-sakura hover:underline">Docker Desktop を入手</a>}
            </li>
            <li className="flex items-center gap-2 flex-wrap">
              {mark(!!prereqs?.dockerfile)}
              <span className="text-ink">Dockerfile</span>
              <span className="text-ink-muted">プロジェクト直下に Dockerfile が必要</span>
            </li>
          </>
        ) : (
          <li className="flex items-center gap-2 flex-wrap">
            {mark(!!prereqs?.builder)}
            <span className="text-ink">内蔵ビルダー</span>
            <span className="text-ink-muted">IDE に同梱（Docker のインストールは不要）</span>
          </li>
        )}
        <li className="flex items-center gap-2 flex-wrap">
          {mark(registry)}
          <span className="text-ink">レジストリ登録</span>
          {!registry ? (
            <>
              <button
                onClick={onAutoCreateRegistry}
                disabled={regCreating || !keyReady}
                className="px-2 py-0.5 rounded bg-sakura/10 text-sakura hover:bg-sakura/20 disabled:opacity-50"
                title={!keyReady
                  ? '先に認証情報でクラウドのAPIキーを登録してください'
                  : `IDEがコンテナレジストリを自動作成します（月額${REGISTRY_MONTHLY_YEN}円・税込がかかります）`}
              >{regCreating ? '作成中…' : '🛠 レジストリを自動作成'}</button>
              <button onClick={onOpenCredentials} className="text-ink-muted hover:underline">手動で登録</button>
            </>
          ) : null
            // ── 登録済みのときはボタンを出さない（2026-08-09 Ryosuke の指摘から）──────
            // 以前はここに「↻ ユーザー再設定」を常設していたが、
            //   ・平常時に押す理由が無い（押して得することが何も無い）
            //   ・ラベルに反して、レジストリが見つからなければ**新規作成する**＝課金が始まる
            //   ・接続情報を上書きする唯一の場所で、2026-08-06 の誤 push・誤削除の起点になった
            // という三重の問題があった。必要になるのは push が 401 になったときと、
            // 別プロジェクトのレジストリを指しているときだけなので、**そのエラーの中に出す**
            // （下の ResetRegistryButton）。困ったときだけ現れるものにする。
          }
        </li>
      </ul>
      {regNotice && (
        <div className="flex items-start gap-1.5">
          <p className="text-[11px] text-ink-secondary flex-1 select-text whitespace-pre-wrap break-words">{regNotice}</p>
          <CopyButton text={regNotice} />
        </div>
      )}
    </div>
  )
}

// ── 破壊操作の確認ダイアログ（やめる／実行 の2ボタン） ──
function ConfirmDialog({
  confirm, busy, onCancel, onApply, onTeardown, onRename,
  registryName, deleteRegistry: deleteRegistryRaw, onChangeDeleteRegistry, placement,
}: {
  confirm: Exclude<Confirm, null>
  busy: boolean
  onCancel: () => void
  onApply: () => void
  onTeardown: () => void
  onRename: () => void
  /** 破棄画面に出すコンテナレジストリ名（未取得なら null）。 */
  registryName: string | null
  /** レジストリも削除するか（既定 true＝月額課金を止める）。 */
  deleteRegistry: boolean
  onChangeDeleteRegistry: (v: boolean) => void
  /** このプロジェクトの保存場所（用意していなければ null）。破棄で消えるものに関わる。 */
  placement: { bucket: string; prefix: string; shared: boolean } | null
}) {
  // 記録が無いレジストリは削除できない（registryDeletionTarget が「対象不明」を返す）。
  // チェックを出さないだけでなく、破棄の実行にも「削除しない」を渡す。そうしないと
  // 「残るのに課金が続く」という警告が出ずに終わってしまう。
  const canDeleteRegistry = !!registryName
  const deleteRegistry = canDeleteRegistry && deleteRegistryRaw

  if (confirm.kind === 'apply') {
    const plan = confirm.plan
    const deletes = plan.actions.filter(a => a.type === 'delete')
    const destructive = plan.hasDestructive
    const noChange = plan.actions.length === 0 || plan.actions.every(a => a.type === 'noop')
    return (
      <div className="space-y-3">
        <div className={`rounded-xl border ${destructive ? 'border-brand-red/70' : 'border-brand-yellow/70'} bg-surface p-4 space-y-2`}>
          <p className="text-sm font-semibold text-ink">
            {destructive ? '⚠️ 破壊的な変更を含む公開を実行します' : '🚀 公開します'}
          </p>
          <p className="text-sm text-ink-secondary leading-relaxed">
            {noChange
              ? '変更はありません。このまま実行しても影響はありません。'
              : '以下の内容で さくらのAppRun に公開します。'}
          </p>
          {!noChange && plan.actions.some(a => a.type === 'create' || a.type === 'update') && (
            <ul className="text-xs text-ink list-disc pl-4 space-y-0.5">
              {plan.actions.filter(a => a.type === 'create' || a.type === 'update').map((a, i) => (
                <li key={i} className="break-all">{a.description}</li>
              ))}
            </ul>
          )}
          {destructive && deletes.length > 0 && (
            <div className="rounded-lg border border-brand-red/50 bg-overlay p-2 space-y-1">
              <p className="text-xs font-semibold text-brand-red">削除される対象：</p>
              <ul className="text-xs text-ink list-disc pl-4 space-y-0.5">
                {deletes.map((a, i) => (
                  <li key={i} className="break-all">
                    <span className="font-mono">{a.name}</span>（{kindLabel(a.kind)}）
                    {a.stateful && <span className="text-brand-red font-semibold"> ※データが消えます</span>}
                  </li>
                ))}
              </ul>
              {plan.hasStatefulDelete && (
                // 「バケットも削除されます」と言い切っていたが、実際は中身を一覧してから
                // 決める（ほかのプロジェクトや利用者のファイルがあれば残す）。**約束と
                // 実装を合わせる**（2026-08-14・掟9）。
                <p className="text-xs text-brand-red font-semibold leading-relaxed select-text">
                  {teardownDataNote({ bucket: deletes.find(a => a.kind === 'bucket')?.name ?? '' })
                    || 'データも削除されます。元に戻せません。'}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex justify-between items-center">
          <button
            onClick={onCancel}
            disabled={busy}
            className="bg-overlay text-ink border border-line rounded-lg px-4 py-2 text-sm font-medium hover:border-sakura disabled:opacity-40"
          >やめる</button>
          <button
            onClick={onApply}
            disabled={busy}
            className={`${destructive ? 'bg-brand-red' : 'sakura-gradient'} text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40`}
          >{busy ? '実行中…' : (destructive ? '理解した上で公開する' : '公開する')}</button>
        </div>
      </div>
    )
  }

  if (confirm.kind === 'renameSpec') {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-brand-yellow/70 bg-surface p-4 space-y-2">
          <p className="text-sm font-semibold text-ink">⚠️ 公開名を変更しますか？</p>
          <p className="text-sm text-ink-secondary leading-relaxed">
            公開名を変更すると、次回公開時に新しいアプリとして作成され、公開URLが変わります。よろしいですか？
          </p>
          <p className="text-xs text-ink-muted">
            新しい公開名: <span className="font-mono text-ink">{confirm.name}</span>
          </p>
        </div>
        <div className="flex justify-between items-center">
          <button
            onClick={onCancel}
            disabled={busy}
            className="bg-overlay text-ink border border-line rounded-lg px-4 py-2 text-sm font-medium hover:border-sakura disabled:opacity-40"
          >やめる</button>
          <button
            onClick={onRename}
            disabled={busy}
            className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
          >{busy ? '保存中…' : '理解した上で変更する'}</button>
        </div>
      </div>
    )
  }

  // teardown（強い確認）
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-brand-red/70 bg-surface p-4 space-y-2">
        <p className="text-sm font-semibold text-ink">⚠️ 環境を破棄します</p>
        <p className="text-sm text-ink-secondary leading-relaxed">
          このプロジェクトの さくらのAppRun 環境（作成済みリソース）をすべて削除します。
          この操作は元に戻せません。
        </p>
        <ul className="text-xs text-ink-muted leading-relaxed list-disc pl-5">
          {teardownTargets({ hasBucket: !!placement, deleteRegistry: canDeleteRegistry && deleteRegistry, registryName }).map(t => <li key={t}>{t}</li>)}
        </ul>
        {/* 公開URLはアプリIDから作られるため、破棄して公開し直すと別のURLになる。
            人に伝えたURLが届かなくなるので、消える物の一覧と同じ強さで伝える。
            URLそのものは長くて読み取れないため出さない（2026-08-09 Ryosuke の指定）。 */}
        {placement && (
          <p className="text-xs text-brand-red leading-relaxed select-text">💾 {teardownDataNote(placement)}</p>
        )}
        <p className="text-xs text-brand-red leading-relaxed">🔗 {urlChangesOnTeardownNotice()}</p>
      </div>

      {/* コンテナレジストリは AppRun とは別に月額課金が続くため、消すかどうかをここで明示的に選ばせる。
          AppRunアプリは削除すれば課金が止まるが、レジストリは残る限り止まらない（2026-08-06 ユーザー指摘）。
          ただし**どのレジストリを使っているかの記録が無いときは削除できない**ので、選択肢を出さずに
          その旨を伝える。押しても消えないチェックは誤解しか生まない（2026-08-09 の実機検証）。 */}
      <div className="rounded-xl border border-line bg-surface p-4 space-y-2">
        {canDeleteRegistry ? (
          <>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={deleteRegistry}
                onChange={e => onChangeDeleteRegistry(e.target.checked)}
                disabled={busy}
                className="mt-0.5 accent-[rgb(var(--sakura-rgb))]"
              />
              <span className="text-sm text-ink font-medium">{registryDeleteLabel(registryName)}</span>
            </label>
            <p className={`text-xs leading-relaxed pl-6 ${deleteRegistry ? 'text-ink-secondary' : 'text-brand-red'}`}>
              {registryDeleteHelp(deleteRegistry)}
            </p>
          </>
        ) : (
          <p className="text-xs text-brand-red leading-relaxed select-text">⚠️ {registryUnknownNotice()}</p>
        )}
      </div>
      <div className="flex justify-between items-center">
        <button
          onClick={onCancel}
          disabled={busy}
          className="bg-overlay text-ink border border-line rounded-lg px-4 py-2 text-sm font-medium hover:border-sakura disabled:opacity-40"
        >やめる</button>
        <button
          onClick={onTeardown}
          disabled={busy}
          className="bg-brand-red text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
        >{busy ? '破棄中…' : '理解した上で破棄する'}</button>
      </div>
    </div>
  )
}
