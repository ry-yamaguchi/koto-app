import { useState, useEffect, useCallback } from 'react'
import { listCloudKeys, getActiveCloudKeyId, activateCloudKey, CloudKeyInfo } from './CredentialsModal'
import CopyButton from './CopyButton'
import { withApprunDedicatedRecord } from '../../shared/publishMeta'
import { readLimits, readWorkerClasses, readLbClasses, readClusters, type ApprunDedicatedPlanRow } from '../../shared/apprunDedicatedShapes'

// さくらのAppRun 専有型パネル（roadmap #23）。
//
// **クラスタの作成（⑤）・破棄（⑥）は行える**（段階②④・v0.6.9 で実装済み）。
// まだ無いのは「アプリケーション/バージョン」（roadmap #23 の⑤独自ドメイン相当）の作成——
// つまり Koto からアプリを独自ドメインで公開するところまでは実装していない。
// この画面がやるのは: ①認証情報の確認（疎通結果も表示） ②サービスプリンシパルの用意（手作業）の案内
// ③制限・プラン・費用をAPIから引いて見せる ④費用の同意を取る ⑤クラスタを作る ⑥作ったものを壊す、の6つ。
//
// docs/apprun-dedicated-plan.md（調査結果と実装設計の集約）を前提にしている。数値・料金は
// そこが正。API仕様が変われば同ファイルを読み直すこと（掟1）。

interface Props {
  projectDir: string
  onOpenCredentials: () => void
}

// ── ③で表示する制限値の項目（docs/apprun-dedicated-plan.md 3. の実測値と同じキー名）。
// 応答に無い項目は null のまま「取得できませんでした」を出す（推測で埋めない）。
const LIMIT_FIELDS: { key: string; label: string }[] = [
  { key: 'clusterCount', label: 'クラスタ数' },
  { key: 'autoScalingGroupCount', label: 'オートスケーリンググループ数' },
  { key: 'workerNodeCount', label: 'ワーカノード数' },
  { key: 'loadBalancerNodeCount', label: 'ロードバランサノード数' },
  { key: 'applicationCount', label: 'アプリケーション数' },
  { key: 'applicationVersionCountPerApplication', label: 'アプリ1つあたりのバージョン数' },
]

type Limits = Record<string, number | null>

// path は ⑤ の作成本文（workerServiceClassPath / lbServiceClassPath）にそのまま使う値。
// 名前だけでなくここも取得しておかないと、選んだプランをAPIへ渡せない（段階②で追加）。
type PlanRow = ApprunDedicatedPlanRow

// 応答の形は src/shared/apprunDedicatedShapes.ts に集約してある（掟10・5-8の事故を受けて）。
// ここでは件数の把握（hasMore の判定）だけを行う。
function extractClusterCount(data: unknown): { count: number; hasMore: boolean } {
  const list = readClusters(data)
  const d = data as any
  const hasMore = !!(d?.nextCursor || d?.cursor || d?.next)
  return { count: list.length, hasMore }
}

// リソースID（サービスプリンシパルID）の形式チェック。**長さ（12文字）だけ**を見る。
// 実在するかどうかはここでは確認できない（IAM APIが通常のAPIキーでは使えないため・実測403）。
function resourceIdFormatOk(raw: string): boolean | null {
  const v = raw.trim()
  if (!v) return null
  return v.length === 12
}

const ROLE_TEXT = 'さくらのクラウド > 作成・削除'
const CONTROL_PANEL_URL = 'https://secure.sakura.ad.jp/cloud/'
const OFFICIAL_PRICE_URL = 'https://cloud.sakura.ad.jp/products/apprun-dedicated/index.html'

// docs/apprun-dedicated-plan.md 2.「料金（公式製品ページ・税込）」の値（2026-09時点）。
// monthlyYen は⑤の見積り計算に使う数値版（表に無いプランは推測で埋めない＝下の関数群が担保する）。
const WORKER_PRICES: { plan: string; hourly: string; daily: string; monthly: string; monthlyYen: number }[] = [
  { plan: '1コア/2GB', hourly: '55円', daily: '550円', monthly: '11,000円', monthlyYen: 11000 },
  { plan: '2コア/2GB', hourly: '84円', daily: '847円', monthly: '16,940円', monthlyYen: 16940 },
  { plan: '4コア/4GB', hourly: '165円', daily: '1,650円', monthly: '33,000円', monthlyYen: 33000 },
  { plan: '8コア/8GB', hourly: '320円', daily: '3,201円', monthly: '64,020円', monthlyYen: 64020 },
]

// ── ⑤ クラスタ作成: 入力チェック・見積りの純関数（テスト対象） ─────────────────────

// クラスタ・ASG・LB 名の形式（5-2/5-5/5-6: 1〜20文字・英数字と `_` `-`）。
export function isValidResourceName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,20}$/.test(name)
}

// 予約ポート（5-5）。main側 src/main/cloud/apprunDedicatedApply.ts の RESERVED_PORT_RANGE と
// 同じ範囲（renderer からは main のモジュールを import できないため、この小さな範囲チェックだけ
// 複製している。掟10が禁じる「同じ形のマージ処理の複製」ではなく、ドキュメント由来の定数）。
export const RESERVED_PORT_RANGE: readonly [number, number] = [5950, 5959]
export function isReservedPort(port: number): boolean {
  return port >= RESERVED_PORT_RANGE[0] && port <= RESERVED_PORT_RANGE[1]
}

/**
 * プランの `path`（例 `cloud/apprun/dedicated/worker/1vcpu_2gb` / `…/lb/1vcpu_2gb_1`）から
 * 料金表のキー（例 `1コア/2GB`）を作る。形が合わなければ null（＝料金表と突き合わせられない）。
 */
export function planKeyFromPath(path: string | null | undefined): string | null {
  if (!path) return null
  const seg = path.split('/').pop() ?? ''
  const m = seg.match(/^(\d+)vcpu_(\d+)gb(?:_\d+)?$/i)
  return m ? `${m[1]}コア/${m[2]}GB` : null
}

/** プランの path から月額（円）を引く。表に無ければ null（**推測で埋めない**）。 */
export function monthlyYenForPlanPath(path: string | null | undefined): number | null {
  const key = planKeyFromPath(path)
  if (!key) return null
  return WORKER_PRICES.find(r => r.plan === key)?.monthlyYen ?? null
}

/**
 * 既定で選ぶワーカプランを決める（roadmap #26）。
 *
 * **料金表で額を引けるものの中で最安**を返す。実 API は高い順（8vCPU/8GB → 1vCPU/2GB）で
 * 返すため、「一覧の先頭」を既定にすると最も高いプランを選んでしまう（2026-09-07 実機で発覚）。
 * 額を引けないプラン（料金表に無い path）は候補にしない——分からない額を既定にしない。
 * 1つも額を引けなければ **null**（＝既定を選ばない。呼び出し側は「プランを選んでください」を出す）。
 * 並び順には依存しない（`reduce` で全件を比較する）。
 */
export function pickCheapestWorkerPlan(plans: readonly PlanRow[] | null | undefined): PlanRow | null {
  const priced = (plans ?? []).filter(p => monthlyYenForPlanPath(p.path) != null)
  if (priced.length === 0) return null
  return priced.reduce((cheapest, p) =>
    monthlyYenForPlanPath(p.path)! < monthlyYenForPlanPath(cheapest.path)! ? p : cheapest
  )
}

/** プランの実際の月額（総額）。単価 ×（ノード数。不明なら1台と仮定）。表に無ければ null。 */
function totalMonthlyYenForPlan(p: PlanRow): number | null {
  const unit = monthlyYenForPlanPath(p.path)
  if (unit == null) return null
  return unit * (p.nodeCount ?? 1)
}

/**
 * 既定で選ぶロードバランサプランを決める（roadmap #26）。
 *
 * `nodeCount === 1`（非冗長）を優先し、その中で**総額（単価 × (nodeCount ?? 1)）が最安**のものを返す。
 * `monthlyYenForPlanPath` は path 末尾の `_1`/`_2`（ノード数の違い）を無視して**1ノードあたりの単価**を
 * 返すため、単価だけで比べると「実際に払う額」を比較したことにならない
 * （非冗長=1台なら単価=総額で一致するが、フォールバックで冗長プラン同士を比べるときにズレる）。
 * 非冗長で額を引けるプランが1つも無ければ、額を引けるプラン全体からの**総額**最安にフォールバックする。
 * ワーカ側と同じく、額を引けないプランは候補にせず、1つも引けなければ null。
 * 並び順には依存しない（`reduce` で全件を比較する）。
 */
export function pickCheapestLbPlan(plans: readonly PlanRow[] | null | undefined): PlanRow | null {
  const priced = (plans ?? []).filter(p => monthlyYenForPlanPath(p.path) != null)
  if (priced.length === 0) return null
  const nonRedundant = priced.filter(p => p.nodeCount === 1)
  const pool = nonRedundant.length > 0 ? nonRedundant : priced
  return pool.reduce((cheapest, p) =>
    totalMonthlyYenForPlan(p)! < totalMonthlyYenForPlan(cheapest)! ? p : cheapest
  )
}

/**
 * 押す前の確認ダイアログに出す見積り文を組み立てる（掟5: 破壊操作は確認ダイアログに額を出す）。
 * **表に無いプランは「月額を出せません」と正直に出し、金額を推測して埋めない**
 * （2026-08-14「既定値が、勝手に課金を生むことがある」と同じ理由——分からない額を0や代表値で
 * 埋めると、静かに間違った金額を信じさせてしまう）。
 */
export function priceSummary(
  workerPlan: { path: string | null } | null,
  lbPlan: { path: string | null; nodeCount: number | null } | null,
  minNodes: number,
): { text: string; totalYen: number | null } {
  const workerYen = workerPlan ? monthlyYenForPlanPath(workerPlan.path) : null
  const lbYen = lbPlan ? monthlyYenForPlanPath(lbPlan.path) : null
  const lbNodeCount = lbPlan?.nodeCount ?? 1
  const workerPart = workerYen != null ? `ワーカ ${workerYen.toLocaleString('ja-JP')}円 × ${minNodes}台` : 'ワーカ（月額を出せません）'
  const lbPart = lbYen != null ? `ロードバランサ ${lbYen.toLocaleString('ja-JP')}円 × ${lbNodeCount}台` : 'ロードバランサ（月額を出せません）'
  if (workerYen == null || lbYen == null) {
    return { text: `${workerPart} ＋ ${lbPart} ＝ 月額を出せません（料金表に無いプランが含まれています）`, totalYen: null }
  }
  const total = workerYen * minNodes + lbYen * lbNodeCount
  return { text: `${workerPart} ＋ ${lbPart} ＝ 月額 ${total.toLocaleString('ja-JP')}円`, totalYen: total }
}

export default function AppRunDedicatedPanel({ projectDir, onOpenCredentials }: Props) {
  const metaPath = `${projectDir}/.sakuraide.json`

  const readMeta = useCallback(async (): Promise<any> => {
    try { return JSON.parse(await window.electronAPI.fs.readFile(metaPath)) } catch { return {} }
  }, [metaPath])

  // このプロジェクトの公開先として記録する（VpsPanel と同じ作法）。
  // ※ PublishTargetKind（公開記録の種別）には足さない——クラスタ・ASG・LBを作れるようになっても
  //   「アプリを公開する」段（roadmap #23 の⑤独自ドメイン相当）はまだ無いため
  //   （sakura-vps が同じ扱い。PublishModal.tsx 参照）。
  //
  // publish.apprunDedicated へのマージ書き込みは shared/publishMeta.ts の
  // withApprunDedicatedRecord に一元化してある（掟10・main側の apprunDedicatedApply.ts も
  // 同じ関数を通す publishMetaFs.ts 経由で同じ場所へ書く。同じ形のマージを別々に書かない）。
  const saveMeta = useCallback(async (patch: Record<string, unknown>) => {
    const m = await readMeta()
    const merged = withApprunDedicatedRecord(m, patch)
    const next = { ...merged, target: 'sakura-apprun-dedicated' }
    await window.electronAPI.fs.writeFile(metaPath, JSON.stringify(next, null, 2))
    window.dispatchEvent(new Event('sakura-meta-changed'))
    return next
  }, [metaPath, readMeta])

  // ── ① 認証情報 ──────────────────────────────────────────────
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [cloudKeys, setCloudKeys] = useState<CloudKeyInfo[]>([])
  const [activeKeyId, setActiveKeyId] = useState<string | null>(null)

  const refreshKey = useCallback(async () => {
    try { setHasKey(await window.electronAPI.cloud.hasKey()) } catch { setHasKey(false) }
  }, [])
  const refreshCloudKeys = useCallback(async () => {
    try { setCloudKeys(await listCloudKeys()) } catch { setCloudKeys([]) }
    try { setActiveKeyId(await getActiveCloudKeyId()) } catch { setActiveKeyId(null) }
  }, [])
  const selectKey = async (id: string) => {
    const r = await activateCloudKey(id)
    if (!r.ok) return
    await refreshKey(); await refreshCloudKeys()
    // 使うキーを切り替えたら、前のキーで確かめた疎通結果は無効。再度③で確かめてもらう。
    setApiReachable(null)
  }

  // ── ② サービスプリンシパル（リソースID・手作業） ──────────────────
  const [resourceId, setResourceId] = useState('')
  const idFormat = resourceIdFormatOk(resourceId)
  const saveResourceId = async (v: string) => { await saveMeta({ servicePrincipalId: v }) }

  // ── ③ プラン・制限（API取得） ─────────────────────────────────
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  // ①で疎通の結果を出すための状態（roadmap #25）。null＝まだ③「調べる」を押していない。
  // ③のどれか1つでも成功すれば「このキーで通じた」とみなす（1つも通らなければ失敗）。
  const [apiReachable, setApiReachable] = useState<boolean | null>(null)
  const [limits, setLimits] = useState<Limits | null>(null)
  const [limitsError, setLimitsError] = useState<string | null>(null)
  const [workerPlans, setWorkerPlans] = useState<PlanRow[] | null>(null)
  const [workerError, setWorkerError] = useState<string | null>(null)
  const [lbPlans, setLbPlans] = useState<PlanRow[] | null>(null)
  const [lbError, setLbError] = useState<string | null>(null)
  const [clusterInfo, setClusterInfo] = useState<{ count: number; hasMore: boolean } | null>(null)
  const [clusterError, setClusterError] = useState<string | null>(null)

  const investigate = async () => {
    setChecking(true); setCheckError(null)
    try {
      // 方式B（掟4）: main には保存しない。使う瞬間に「使用中」のクラウドキーを読み、引数で渡す。
      const auth = await window.electronAPI.cloud.loadKey()
      if (!auth || !auth.token || !auth.secret) {
        setCheckError('さくらのクラウドAPIキーが未登録です。①で登録してください。')
        // ここでは何も試していない（＝キーが「悪い」わけではない）ので apiReachable は null のまま。
        // false にすると「このキーでは通じませんでした」と出て、①の「⚠️ APIキーが未登録です」と
        // 合わせて「キーが無い」のか「キーが悪い」のか分からなくなる。
        return
      }
      setLimits(null); setLimitsError(null)
      setWorkerPlans(null); setWorkerError(null)
      setLbPlans(null); setLbError(null)
      setClusterInfo(null); setClusterError(null)

      const [limitsRes, plansRes, clustersRes] = await Promise.all([
        window.electronAPI.apprunDedicated.limits(auth),
        window.electronAPI.apprunDedicated.plans(auth),
        window.electronAPI.apprunDedicated.clusters(auth),
      ])

      if (limitsRes.ok) setLimits(readLimits(limitsRes.data))
      else setLimitsError(limitsRes.message)

      if (plansRes.worker.ok) setWorkerPlans(readWorkerClasses(plansRes.worker.data))
      else setWorkerError(plansRes.worker.message)

      if (plansRes.lb.ok) setLbPlans(readLbClasses(plansRes.lb.data))
      else setLbError(plansRes.lb.message)

      if (clustersRes.ok) setClusterInfo(extractClusterCount(clustersRes.data))
      else setClusterError(clustersRes.message)

      // ①へ出す疎通結果（roadmap #25）: 4件のうちどれか1つでも成功すれば「通じた」。
      setApiReachable(limitsRes.ok || plansRes.worker.ok || plansRes.lb.ok || clustersRes.ok)
    } catch (e: any) {
      setCheckError(e?.message ?? String(e))
      setApiReachable(false)
    } finally {
      setChecking(false)
    }
  }

  // ── ④ 費用の同意 ────────────────────────────────────────────
  const [agree, setAgree] = useState(false)
  const [consentedAt, setConsentedAt] = useState<string | null>(null)
  const [consentBusy, setConsentBusy] = useState(false)

  const giveConsent = async () => {
    if (!agree || consentBusy) return
    setConsentBusy(true)
    try {
      const iso = new Date().toISOString()
      await saveMeta({ consentedAt: iso })
      setConsentedAt(iso)
    } finally { setConsentBusy(false) }
  }
  const revokeConsent = async () => {
    if (consentBusy) return
    setConsentBusy(true)
    try {
      await saveMeta({ consentedAt: null })
      setConsentedAt(null)
      setAgree(false)
    } finally { setConsentBusy(false) }
  }

  // ── 記録（何が実際に作られているか。main の .sakuraide.json 読み取り。APIは呼ばない） ──────
  type ApprunDedicatedState = Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['state']>>
  const [apprunState, setApprunState] = useState<ApprunDedicatedState | null>(null)
  const refreshApprunState = useCallback(async () => {
    try { setApprunState(await window.electronAPI.apprunDedicated.state(projectDir)) } catch { setApprunState(null) }
  }, [projectDir])

  // ── ⑤ クラスタを作る ────────────────────────────────────────
  const [clusterName, setClusterName] = useState('')
  const [ports, setPorts] = useState<{ port: number; protocol: 'http' | 'https' }[]>([
    { port: 80, protocol: 'http' },
    { port: 443, protocol: 'https' },
  ])
  const [zone, setZone] = useState('tk1b') // 原本に許容値の一覧が無いため、例の値を既定にした自由入力（5-5）
  const [minNodes, setMinNodes] = useState(1)
  const [maxNodes, setMaxNodes] = useState(1)
  const [selectedWorkerPath, setSelectedWorkerPath] = useState<string | null>(null)
  const [selectedLbPath, setSelectedLbPath] = useState<string | null>(null)
  const [letsEncryptEmail, setLetsEncryptEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [createResult, setCreateResult] = useState<Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['create']>> | null>(null)

  // プランが取得できたら（③の「調べる」の後）既定を選んでおく。一度選んだら上書きしない。
  // **既定は「料金表で引ける中の最安」**（roadmap #26）。額を引けないプランは既定にしない
  // （選べなければ null のままにし、⑤に「プランを選んでください」を出す＝黙って高いものを選ばない）。
  useEffect(() => {
    if (selectedWorkerPath) return
    const cheapest = pickCheapestWorkerPlan(workerPlans)
    if (cheapest) setSelectedWorkerPath(cheapest.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerPlans])
  useEffect(() => {
    if (selectedLbPath) return
    const cheapest = pickCheapestLbPlan(lbPlans)
    if (cheapest) setSelectedLbPath(cheapest.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lbPlans])

  const updatePort = (i: number, next: { port: number; protocol: 'http' | 'https' }) => {
    setPorts(prev => prev.map((p, idx) => (idx === i ? next : p)))
  }
  const addPort = () => setPorts(prev => [...prev, { port: 0, protocol: 'http' as const }])
  const removePort = (i: number) => setPorts(prev => prev.filter((_, idx) => idx !== i))

  const selectedWorkerPlan = (workerPlans ?? []).find(p => p.path === selectedWorkerPath) ?? null
  const selectedLbPlan = (lbPlans ?? []).find(p => p.path === selectedLbPath) ?? null
  const price = priceSummary(selectedWorkerPlan, selectedLbPlan, minNodes)

  // 押す前にまとめて確かめる（掟5: 破壊操作は確認ダイアログ。ここは「常時課金の開始」という
  // 意味で同じ強さの確認を挟む）。入力が揃っていない間はボタンを押せない。
  const formError: string | null = (() => {
    const name = clusterName.trim()
    if (!name) return 'クラスタ名を入力してください'
    if (!isValidResourceName(name)) return 'クラスタ名は1〜20文字の英数字・_・- で入力してください'
    if (!resourceId.trim()) return '②でサービスプリンシパルIDを入力してください'
    if (ports.length === 0) return '公開ポートを1つ以上指定してください'
    if (ports.some(p => !(p.port >= 1 && p.port <= 65535))) return 'ポート番号は1〜65535で指定してください'
    if (ports.some(p => isReservedPort(p.port))) return `ポート ${RESERVED_PORT_RANGE[0]}-${RESERVED_PORT_RANGE[1]} は予約されており使えません`
    if (!zone.trim()) return 'ゾーンを入力してください'
    if (!selectedWorkerPath) return 'ワーカプランを選んでください（③で「調べる」を押していない場合は先に押してください）'
    if (!selectedLbPath) return 'ロードバランサプランを選んでください（③で「調べる」を押していない場合は先に押してください）'
    if (!(Number.isInteger(minNodes) && minNodes >= 1 && minNodes <= 10)) return 'ノード数（min）は1〜10で指定してください'
    if (!(Number.isInteger(maxNodes) && maxNodes >= 1 && maxNodes <= 10)) return 'ノード数（max）は1〜10で指定してください'
    if (minNodes > maxNodes) return 'ノード数は min ≦ max にしてください'
    return null
  })()

  const doCreate = async () => {
    if (formError || creating) return
    if (!window.confirm(`${price.text}\n\nこの費用が毎月かかります。よろしいですか？`)) return
    setCreating(true); setCreateResult(null)
    try {
      const auth = await window.electronAPI.cloud.loadKey()
      if (!auth || !auth.token || !auth.secret) {
        setCreateResult({ ok: false, stage: 'consent', message: 'さくらのクラウドAPIキーが未登録です。①で登録してください。' })
        return
      }
      const spec = {
        name: clusterName.trim(),
        ports,
        servicePrincipalID: resourceId.trim(),
        ...(letsEncryptEmail.trim() ? { letsEncryptEmail: letsEncryptEmail.trim() } : {}),
        zone: zone.trim(),
        workerServiceClassPath: selectedWorkerPath as string,
        minNodes, maxNodes,
        lbServiceClassPath: selectedLbPath as string,
      }
      const r = await window.electronAPI.apprunDedicated.create(projectDir, auth, spec)
      setCreateResult(r)
      await refreshApprunState()
    } catch (e: any) {
      setCreateResult({ ok: false, stage: 'consent', message: e?.message ?? String(e) } as any)
    } finally {
      setCreating(false)
    }
  }

  // ── ⑥ 作ったものを壊す（破棄） ───────────────────────────────
  const [tearingDown, setTearingDown] = useState(false)
  const [teardownResult, setTeardownResult] = useState<Awaited<ReturnType<Window['electronAPI']['apprunDedicated']['teardown']>> | null>(null)
  const hasAnyResource = !!(apprunState?.clusterID || apprunState?.asgID || apprunState?.loadBalancerID)

  const doTeardown = async () => {
    if (tearingDown) return
    const targets = [
      apprunState?.loadBalancerID ? `ロードバランサ『${apprunState.loadBalancerID}』` : null,
      apprunState?.asgID ? `オートスケーリンググループ『${apprunState.asgID}』` : null,
      apprunState?.clusterID ? `クラスタ『${apprunState.clusterID}』` : null,
    ].filter(Boolean).join('・')
    if (!window.confirm(`次を削除します: ${targets}\n\nこの操作は元に戻せません。消さない限り課金が続きます。よろしいですか？`)) return
    setTearingDown(true); setTeardownResult(null)
    try {
      const auth = await window.electronAPI.cloud.loadKey()
      if (!auth || !auth.token || !auth.secret) {
        setTeardownResult({ ok: false, executed: [], message: 'さくらのクラウドAPIキーが未登録です。①で登録してください。', remaining: {} })
        return
      }
      const r = await window.electronAPI.apprunDedicated.teardown(projectDir, auth)
      setTeardownResult(r)
      await refreshApprunState()
    } catch (e: any) {
      setTeardownResult({ ok: false, executed: [], message: e?.message ?? String(e), remaining: {} })
    } finally {
      setTearingDown(false)
    }
  }

  // ── 初期化 ──────────────────────────────────────────────────
  useEffect(() => {
    refreshKey(); refreshCloudKeys(); refreshApprunState()
    ;(async () => {
      const m = await readMeta()
      const v = m.publish?.apprunDedicated
      setResourceId(typeof v?.servicePrincipalId === 'string' ? v.servicePrincipalId : '')
      setConsentedAt(typeof v?.consentedAt === 'string' ? v.consentedAt : null)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir])

  useEffect(() => {
    // キーが（他画面の「認証情報」経由で）切り替わったら、前のキーで確かめた疎通結果を無効にする。
    // ここで setApiReachable(null) しないと、①の表示は「使用中のキー」だけ新しくなり、
    // その真下に前のキーで得た「✅ 通じました」が残ったままになる（常時課金サービスへの嘘の緑チェック）。
    const h = () => { refreshKey(); refreshCloudKeys(); setApiReachable(null) }
    window.addEventListener('sakura:credentials-changed', h)
    return () => window.removeEventListener('sakura:credentials-changed', h)
  }, [refreshKey, refreshCloudKeys])

  const selectedKeyId = activeKeyId ?? cloudKeys[0]?.id ?? null
  const selectedKeyLabel = cloudKeys.find(k => k.id === selectedKeyId)?.label ?? '（未選択）'
  const keyReady = hasKey === true

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-surface p-4 space-y-1">
        <p className="text-sm font-semibold text-ink">📦 さくらのAppRun 専有型</p>
        <p className="text-xs text-ink-muted leading-relaxed">
          仮想サーバレベルで専有するAppRun。独自ドメインが使えますが、常時課金・4階層の構成が必要な上級者向けサービスです。
          <b className="text-ink">クラスタの作成・破棄までは行えます。</b>アプリケーションの公開（独自ドメインでの利用）はこのバージョンではまだできません。
        </p>
        <p className="text-[11px] text-ink-muted">
          <a href={OFFICIAL_PRICE_URL} className="hover:underline">🌐 公式サイトを見る ↗</a>
        </p>
      </div>

      {/* ① 認証情報 */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">① 認証情報</p>
          {hasKey === null
            ? <span className="text-xs text-ink-muted">確認中…</span>
            : keyReady
              ? <span className="text-xs text-brand-green font-semibold">✅ APIキー登録済み</span>
              : <span className="text-xs text-brand-yellow font-semibold">⚠️ APIキーが未登録です</span>}
        </div>
        <p className="text-[11px] text-ink-muted leading-relaxed">
          専有型に専用のAPIキーはなく、既存の さくらのクラウドAPIキー（アクセストークン／トークンシークレット）をそのまま使います。「認証情報」で登録・切替します。
        </p>
        {cloudKeys.length > 0 ? (
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-ink-secondary">この確認に使うキー</label>
            <select
              value={selectedKeyId ?? ''}
              onChange={e => selectKey(e.target.value)}
              className="w-full bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink outline-none focus:border-sakura"
            >
              {cloudKeys.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <p className="text-[11px] text-ink-secondary">使用中のキー: <span className="font-medium text-ink">{selectedKeyLabel}</span></p>
          </div>
        ) : (
          <p className="text-[11px] text-brand-yellow leading-relaxed">
            まだクラウドのキーが登録されていません。「認証情報」でアクセストークン／シークレットを登録してください。
          </p>
        )}
        <button
          onClick={onOpenCredentials}
          className="bg-overlay text-ink border border-line rounded-lg px-3 py-2 text-sm font-medium hover:border-sakura"
        >🔑 認証情報で登録・切替</button>
        {/* 疎通の結果（roadmap #25）: ③「🔍 調べる」を押すまでは現状の案内文のまま。
            押した後は、その結果（通じた／通じなかった）をここにも出す
            （①だけ見て「確認できない＝未実装」に見えるのを防ぐ）。 */}
        {apiReachable === null ? (
          <p className="text-[11px] text-ink-muted leading-relaxed">疎通の確認は、下の「③ 調べる」で行います。</p>
        ) : apiReachable ? (
          <p className="text-[11px] text-brand-green font-semibold leading-relaxed">✅ このキーで専有型APIに通じました</p>
        ) : (
          <p className="text-[11px] text-brand-yellow font-semibold leading-relaxed">
            ⚠️ このキーでは通じませんでした。下の「③ 調べる」の結果をご確認ください。
          </p>
        )}
      </section>

      {/* ② サービスプリンシパルの用意（手作業が必要） */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <p className="text-sm font-semibold text-ink">② サービスプリンシパルの用意（手作業が必要）</p>
        <p className="text-xs text-ink-secondary leading-relaxed">
          専有型のクラスタを作るには「サービスプリンシパル」が要りますが、<b className="text-ink">これは Koto からは作れません</b>。
          作成に使うIAM APIは通常のAPIキーでは使えないため（実測で権限エラー）、コントロールパネルでの手作業になります。
        </p>
        <a
          href={CONTROL_PANEL_URL}
          className="inline-block bg-overlay text-ink border border-line rounded-lg px-3 py-2 text-sm font-medium hover:border-sakura"
        >🔧 コントロールパネルを開く</a>
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-ink-secondary">付与するロール</p>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-overlay px-3 py-2">
            <code className="flex-1 text-xs text-ink font-mono select-text">{ROLE_TEXT}</code>
            <CopyButton text={ROLE_TEXT} title="ロール名をコピー" />
          </div>
        </div>
        <ol className="list-decimal pl-4 space-y-1 text-xs text-ink-secondary leading-relaxed">
          <li>上のボタンでコントロールパネルを開く</li>
          <li>IAM（アクセス管理）でサービスプリンシパルを作成する</li>
          <li>ロール「{ROLE_TEXT}」を付与する</li>
          <li>発行されたリソースID（12文字）を下に貼り付ける</li>
        </ol>
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-ink-secondary">リソースID</label>
          <input
            value={resourceId}
            onChange={e => setResourceId(e.target.value)}
            onBlur={() => saveResourceId(resourceId.trim())}
            placeholder="例: 113800956789"
            className="w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink font-mono outline-none focus:border-sakura"
          />
          {idFormat === true && <p className="text-[11px] text-brand-green font-semibold">✓ 形は合っています（12文字）</p>}
          {idFormat === false && <p className="text-[11px] text-brand-yellow font-semibold">⚠️ 違うようです（12文字ではありません）</p>}
          <p className="text-[11px] text-ink-muted leading-relaxed">
            ※ 確認できるのは文字数の形式だけです。実在するかどうかはここでは確認できません（IAM APIが使えないため）。実際にクラスタを作る段になって初めて分かります。
          </p>
        </div>
      </section>

      {/* ③ 使えるプランと制限（API から取得） */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">③ 使えるプランと制限</p>
          <button
            onClick={investigate}
            disabled={checking}
            className="flex-none bg-sakura text-white rounded-md px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-40"
          >{checking ? '調べています…' : '🔍 調べる'}</button>
        </div>
        <p className="text-[11px] text-ink-muted leading-relaxed">制限・プラン・既存クラスタの件数をAPIから取得します（何も作らず、何も変更しません）。</p>

        {checkError && (
          <p className="text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2 leading-relaxed break-all select-text">{checkError}</p>
        )}

        {(limits || limitsError) && (
          <div className="space-y-1">
            <p className="text-[11px] font-semibold text-ink-secondary">制限値</p>
            {limitsError ? (
              <ErrorBlock msg={`取得できませんでした: ${limitsError}`} />
            ) : (
              <div className="rounded-lg border border-line bg-overlay px-3 py-2 space-y-1">
                {LIMIT_FIELDS.map(f => (
                  <div key={f.key} className="flex items-center justify-between text-xs">
                    <span className="text-ink-secondary">{f.label}</span>
                    <span className="text-ink font-medium">{limits && limits[f.key] != null ? limits[f.key] : '取得できませんでした'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {(workerPlans || workerError) && (
          <div className="space-y-1">
            <p className="text-[11px] font-semibold text-ink-secondary">ワーカプラン</p>
            {workerError ? <ErrorBlock msg={`取得できませんでした: ${workerError}`} /> : (
              <ul className="text-xs text-ink-secondary space-y-0.5 pl-1">
                {(workerPlans ?? []).length === 0 && <li>（プランがありませんでした）</li>}
                {(workerPlans ?? []).map((p, i) => (
                  <li key={i}>・{p.name ?? '（名前を取得できませんでした）'}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {(lbPlans || lbError) && (
          <div className="space-y-1">
            <p className="text-[11px] font-semibold text-ink-secondary">ロードバランサプラン</p>
            {lbError ? <ErrorBlock msg={`取得できませんでした: ${lbError}`} /> : (
              <ul className="text-xs text-ink-secondary space-y-0.5 pl-1">
                {(lbPlans ?? []).length === 0 && <li>（プランがありませんでした）</li>}
                {/* APIの name をそのまま出す。nodeCount 由来の「（冗長）」等は付け足さない（roadmap #27） */}
                {(lbPlans ?? []).map((p, i) => (
                  <li key={i}>・{p.name ?? '（名前を取得できませんでした）'}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {(clusterInfo || clusterError) && (
          <div className="space-y-1">
            <p className="text-[11px] font-semibold text-ink-secondary">既存クラスタ</p>
            {clusterError ? <ErrorBlock msg={`取得できませんでした: ${clusterError}`} /> : (
              <p className="text-xs text-ink-secondary">
                {clusterInfo!.count}件{clusterInfo!.hasMore ? '以上（正確な数は未確認）' : ''}
              </p>
            )}
          </div>
        )}
      </section>

      {/* ④ 費用の確認と同意 */}
      <section className="rounded-xl border border-brand-yellow/70 bg-surface p-4 space-y-3">
        <p className="text-sm font-semibold text-ink">④ 費用の確認と同意</p>
        <p className="text-xs font-semibold text-brand-red leading-relaxed">
          ⚠️ 専有型は常時課金です（動いていなくても請求されます）。共用型（さくらのAppRun）は使った分だけの従量課金ですが、専有型は日額・月額の固定費です。
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-ink-secondary border-collapse">
            <thead>
              <tr className="border-b border-line text-ink-muted">
                <th className="text-left py-1 pr-2 font-medium">ワーカプラン</th>
                <th className="text-right py-1 px-2 font-medium">時間</th>
                <th className="text-right py-1 px-2 font-medium">日</th>
                <th className="text-right py-1 pl-2 font-medium">月</th>
              </tr>
            </thead>
            <tbody>
              {WORKER_PRICES.map(row => (
                <tr key={row.plan} className="border-b border-line-soft last:border-0">
                  <td className="py-1 pr-2 text-ink">{row.plan}</td>
                  <td className="py-1 px-2 text-right">{row.hourly}</td>
                  <td className="py-1 px-2 text-right">{row.daily}</td>
                  <td className="py-1 pl-2 text-right font-medium text-ink">{row.monthly}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-ink-muted leading-relaxed">
          ロードバランサも同じ料金表が使われます（1コア/2GB・2コア/2GBの2プランのみ提供）。
          税込・2026-09時点の<a href={OFFICIAL_PRICE_URL} className="text-sakura hover:underline">公式ページ</a>の値です。価格は変わることがあります。最新は公式ページでご確認ください。
        </p>
        <p className="text-xs font-semibold text-ink leading-relaxed">
          最小構成（ワーカ 1コア/2GB + ロードバランサ 1コア/2GB相当）でも、月額 11,000円 + 11,000円 = <span className="text-brand-red">22,000円</span> で、2万円を超えます。
        </p>

        {consentedAt ? (
          <div className="rounded-lg border border-brand-green/60 bg-overlay p-3 flex items-center justify-between gap-2">
            <p className="text-xs text-brand-green font-semibold">✅ 同意済み（{new Date(consentedAt).toLocaleString('ja-JP')}）</p>
            <button
              onClick={revokeConsent}
              disabled={consentBusy}
              className="flex-none text-[11px] text-ink-muted hover:text-brand-red disabled:opacity-40"
            >同意を取り消す</button>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-xs text-ink-secondary leading-relaxed">
              <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} className="mt-0.5" />
              費用が発生することを理解しました
            </label>
            <button
              onClick={giveConsent}
              disabled={!agree || consentBusy}
              className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
            >{consentBusy ? '記録しています…' : '同意して次へ進む'}</button>
          </div>
        )}
      </section>

      {/* ⑤ クラスタを作る */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <p className="text-sm font-semibold text-ink">⑤ クラスタを作る</p>

        {!consentedAt ? (
          <p className="text-xs text-ink-secondary leading-relaxed">
            ④で費用に同意すると、ここから作成できるようになります。
          </p>
        ) : (
          <>
            <p className="text-[11px] text-ink-muted leading-relaxed rounded-lg border border-line bg-overlay px-3 py-2">
              🔌 ネットワークは共有セグメントに繋ぎます（スイッチやIPプールの指定は要りません）。
            </p>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">クラスタ名（1〜20文字・英数字と _ -）</label>
              <input
                value={clusterName}
                onChange={e => setClusterName(e.target.value)}
                placeholder="例: myapp"
                className="w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink font-mono outline-none focus:border-sakura"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">公開ポート</label>
              <div className="space-y-1">
                {ports.map((p, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="number"
                      value={p.port}
                      onChange={e => updatePort(i, { ...p, port: Number(e.target.value) })}
                      className="w-24 bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                    />
                    <select
                      value={p.protocol}
                      onChange={e => updatePort(i, { ...p, protocol: e.target.value as 'http' | 'https' })}
                      className="bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                    >
                      <option value="http">http</option>
                      <option value="https">https</option>
                    </select>
                    {isReservedPort(p.port) && (
                      <span className="text-[11px] text-brand-red">⚠️ {RESERVED_PORT_RANGE[0]}-{RESERVED_PORT_RANGE[1]}は予約で使えません</span>
                    )}
                    <button onClick={() => removePort(i)} className="text-[11px] text-ink-muted hover:text-brand-red">削除</button>
                  </div>
                ))}
              </div>
              <button onClick={addPort} className="text-[11px] text-sakura hover:underline">+ ポートを追加</button>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">サービスプリンシパルID</label>
              <p className="text-xs text-ink font-mono select-text">{resourceId || '（②で入力してください）'}</p>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">ゾーン</label>
              <input
                value={zone}
                onChange={e => setZone(e.target.value)}
                className="w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink font-mono outline-none focus:border-sakura"
              />
              <p className="text-[11px] text-ink-muted leading-relaxed">
                原本に許容値の一覧が無いため自由入力です。間違っていればAPIが400を返すので、そのまま表示します。
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">ワーカプラン</label>
              {workerPlans && workerPlans.some(p => p.path) ? (
                <>
                  <select
                    value={selectedWorkerPath ?? ''}
                    onChange={e => setSelectedWorkerPath(e.target.value)}
                    className="w-full bg-elevated border border-line rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-sakura"
                  >
                    {!selectedWorkerPath && <option value="">（選んでください）</option>}
                    {workerPlans.filter(p => p.path).map(p => (
                      <option key={p.path as string} value={p.path as string}>{p.name ?? p.path}</option>
                    ))}
                  </select>
                  {!selectedWorkerPath && (
                    <p className="text-[11px] text-brand-yellow leading-relaxed">
                      ⚠️ プランを選んでください（既定は選んでいません。料金表に無いプランのため自動では選べませんでした）
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[11px] text-brand-yellow">③の「🔍 調べる」を押してプランを取得してください。</p>
              )}
              <div className="flex items-center gap-2 pt-1">
                <label className="text-[11px] text-ink-secondary">ノード数 min</label>
                <input
                  type="number" min={1} max={10} value={minNodes}
                  onChange={e => setMinNodes(Number(e.target.value))}
                  className="w-16 bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                />
                <label className="text-[11px] text-ink-secondary">max</label>
                <input
                  type="number" min={1} max={10} value={maxNodes}
                  onChange={e => setMaxNodes(Number(e.target.value))}
                  className="w-16 bg-elevated border border-line rounded-lg px-2 py-1 text-sm text-ink outline-none focus:border-sakura"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">ロードバランサプラン</label>
              {lbPlans && lbPlans.some(p => p.path) ? (
                <>
                  <select
                    value={selectedLbPath ?? ''}
                    onChange={e => setSelectedLbPath(e.target.value)}
                    className="w-full bg-elevated border border-line rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-sakura"
                  >
                    {!selectedLbPath && <option value="">（選んでください）</option>}
                    {/* APIの name をそのまま出す。nodeCount 由来の「（冗長）」等は付け足さない（roadmap #27・API側が既に含む） */}
                    {lbPlans.filter(p => p.path).map(p => (
                      <option key={p.path as string} value={p.path as string}>{p.name ?? p.path}</option>
                    ))}
                  </select>
                  {!selectedLbPath && (
                    <p className="text-[11px] text-brand-yellow leading-relaxed">
                      ⚠️ プランを選んでください（既定は選んでいません。料金表に無いプランのため自動では選べませんでした）
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[11px] text-brand-yellow">③の「🔍 調べる」を押してプランを取得してください。</p>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-[11px] font-medium text-ink-secondary">Let&apos;s Encrypt 用メール（独自ドメインを使うなら）</label>
              <input
                value={letsEncryptEmail}
                onChange={e => setLetsEncryptEmail(e.target.value)}
                placeholder="任意"
                className="w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-sakura"
              />
            </div>

            <div className="rounded-lg border border-line bg-overlay p-3">
              <p className="text-xs text-ink select-text">{price.text}</p>
            </div>

            {formError && <p className="text-xs text-brand-yellow leading-relaxed">⚠️ {formError}</p>}

            <button
              onClick={doCreate}
              disabled={!!formError || creating}
              className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
            >{creating ? 'クラスタ→ASG→LB の順で作成しています…' : 'クラスタを作成する'}</button>

            {createResult && (
              <div className="space-y-1">
                <p className={createResult.ok ? 'text-xs font-semibold text-brand-green' : 'text-xs font-semibold text-brand-red'}>
                  {createResult.ok ? '✅ 作成できました' : `⚠️ 途中で止まりました（${createResult.stage}）`}
                </p>
                <ul className="text-xs text-ink-secondary space-y-0.5 pl-1">
                  <li>{createResult.clusterID ? '✅' : '・'} クラスタ {createResult.clusterID ?? '（未作成）'}</li>
                  <li>{createResult.asgID ? '✅' : '・'} オートスケーリンググループ {createResult.asgID ?? '（未作成）'}</li>
                  <li>{createResult.loadBalancerID ? '✅' : '・'} ロードバランサ {createResult.loadBalancerID ?? '（未作成）'}</li>
                </ul>
                <ErrorBlock msg={createResult.message} />
                {!createResult.ok && (createResult.clusterID || createResult.asgID || createResult.loadBalancerID) && (
                  <p className="text-xs text-brand-red leading-relaxed">
                    ここまで作られています。課金が続くので、⑥から破棄してください。
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* ⑥ 作ったものを壊す（破棄） */}
      {hasAnyResource && (
        <section className="rounded-xl border border-brand-red/70 bg-surface p-4 space-y-3">
          <p className="text-sm font-semibold text-ink">⑥ 作ったものを壊す（破棄）</p>
          <p className="text-xs font-semibold text-brand-red leading-relaxed">
            ⚠️ 消さない限り課金が続きます。この操作は元に戻せません。
          </p>
          <ul className="text-xs text-ink-secondary leading-relaxed list-disc pl-5">
            {apprunState?.loadBalancerID && <li>ロードバランサ『{apprunState.loadBalancerID}』</li>}
            {apprunState?.asgID && <li>オートスケーリンググループ『{apprunState.asgID}』</li>}
            {apprunState?.clusterID && <li>クラスタ『{apprunState.clusterID}』</li>}
          </ul>
          <button
            onClick={doTeardown}
            disabled={tearingDown}
            className="bg-brand-red-fill text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
          >{tearingDown ? '削除しています…' : 'すべて削除する'}</button>

          {teardownResult && (
            <div className="space-y-1">
              {teardownResult.executed.map((e, i) => (
                <p key={i} className="text-xs text-brand-green leading-relaxed">✅ {e}</p>
              ))}
              <ErrorBlock msg={teardownResult.message} />
              {!teardownResult.ok && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-brand-red leading-relaxed">
                    残っています＝課金が続きます。コントロールパネルから直接削除することもできます。
                  </p>
                  <ul className="text-xs text-ink-secondary leading-relaxed list-disc pl-5">
                    {teardownResult.remaining.loadBalancerID && <li>ロードバランサ『{teardownResult.remaining.loadBalancerID}』</li>}
                    {teardownResult.remaining.asgID && <li>オートスケーリンググループ『{teardownResult.remaining.asgID}』</li>}
                    {teardownResult.remaining.clusterID && <li>クラスタ『{teardownResult.remaining.clusterID}』</li>}
                  </ul>
                  <a href={CONTROL_PANEL_URL} className="inline-block text-[11px] text-sakura hover:underline">🔧 コントロールパネルを開く</a>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

// 失敗メッセージの表示ブロック（掟5: select-text＋コピーボタン）。VpsPanel/AppRunPanel と同種。
function ErrorBlock({ msg }: { msg: string }) {
  return (
    <div className="rounded-lg border border-line bg-overlay p-3 space-y-1">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-xs text-ink-secondary leading-relaxed whitespace-pre-wrap break-all select-text">{msg}</p>
        <button
          onClick={() => { navigator.clipboard.writeText(msg).catch(() => {}) }}
          className="flex-none text-[11px] text-sakura hover:underline"
          title="メッセージをコピー"
        >コピー</button>
      </div>
    </div>
  )
}
