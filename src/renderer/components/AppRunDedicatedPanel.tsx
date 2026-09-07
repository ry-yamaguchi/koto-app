import { useState, useEffect, useCallback } from 'react'
import { listCloudKeys, getActiveCloudKeyId, activateCloudKey, CloudKeyInfo } from './CredentialsModal'
import CopyButton from './CopyButton'

// さくらのAppRun 専有型「下調べ画面」（roadmap #23 段階①）。
//
// **この段階ではクラスタもアプリも作らない。** POST/PUT/PATCH/DELETE は main 側
// （src/main/cloud/apprunDedicated.ts）に1つも無い（tests/apprunDedicated.test.ts が固定）。
// この画面がやるのは: ①制限・プラン・費用をAPIから引いて見せる ②費用の同意を取る
// ③サービスプリンシパルの用意（手作業）を案内する ④疎通の確認、の4つだけ。
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

function extractLimits(data: unknown): Limits {
  const d = (data ?? {}) as Record<string, unknown>
  const out: Limits = {}
  for (const f of LIMIT_FIELDS) {
    const v = d[f.key]
    out[f.key] = typeof v === 'number' ? v : null
  }
  return out
}

interface PlanRow { name: string | null; nodeCount: number | null }

// 応答のどこに配列が入っているかを決め打ちしない（scripts/probe-apprun-dedicated.mjs と
// 同じ考え方）。よくある置き場所を順に見て、無ければ空配列を返す
// （呼び出し側が「取得できませんでした」を出す）。
function unwrapList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  const d = data as any
  for (const k of ['service_classes', 'clusters', 'data', 'items', 'plans', 'worker', 'lb']) {
    if (d && Array.isArray(d[k])) return d[k]
  }
  return []
}

function extractPlanList(data: unknown): PlanRow[] {
  return unwrapList(data).map((item: any) => ({
    name: typeof item?.name === 'string' ? item.name : null,
    nodeCount: typeof item?.nodeCount === 'number' ? item.nodeCount : null,
  }))
}

function extractClusterCount(data: unknown): { count: number; hasMore: boolean } {
  const list = unwrapList(data)
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
const WORKER_PRICES: { plan: string; hourly: string; daily: string; monthly: string }[] = [
  { plan: '1コア/2GB', hourly: '55円', daily: '550円', monthly: '11,000円' },
  { plan: '2コア/2GB', hourly: '84円', daily: '847円', monthly: '16,940円' },
  { plan: '4コア/4GB', hourly: '165円', daily: '1,650円', monthly: '33,000円' },
  { plan: '8コア/8GB', hourly: '320円', daily: '3,201円', monthly: '64,020円' },
]

export default function AppRunDedicatedPanel({ projectDir, onOpenCredentials }: Props) {
  const metaPath = `${projectDir}/.sakuraide.json`

  const readMeta = useCallback(async (): Promise<any> => {
    try { return JSON.parse(await window.electronAPI.fs.readFile(metaPath)) } catch { return {} }
  }, [metaPath])

  // このプロジェクトの公開先として記録する（VpsPanel と同じ作法）。
  // ※ PublishTargetKind（公開記録の種別）には足さない——この段階では「公開」を行わないため
  //   （sakura-vps が同じ扱い。PublishModal.tsx 参照）。
  const saveMeta = useCallback(async (patch: Record<string, unknown>) => {
    const m = await readMeta()
    const next = {
      ...m,
      target: 'sakura-apprun-dedicated',
      publish: {
        ...(m.publish ?? {}),
        apprunDedicated: { ...(m.publish?.apprunDedicated ?? {}), ...patch },
      },
    }
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
  }

  // ── ② サービスプリンシパル（リソースID・手作業） ──────────────────
  const [resourceId, setResourceId] = useState('')
  const idFormat = resourceIdFormatOk(resourceId)
  const saveResourceId = async (v: string) => { await saveMeta({ servicePrincipalId: v }) }

  // ── ③ プラン・制限（API取得） ─────────────────────────────────
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
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

      if (limitsRes.ok) setLimits(extractLimits(limitsRes.data))
      else setLimitsError(limitsRes.message)

      if (plansRes.worker.ok) setWorkerPlans(extractPlanList(plansRes.worker.data))
      else setWorkerError(plansRes.worker.message)

      if (plansRes.lb.ok) setLbPlans(extractPlanList(plansRes.lb.data))
      else setLbError(plansRes.lb.message)

      if (clustersRes.ok) setClusterInfo(extractClusterCount(clustersRes.data))
      else setClusterError(clustersRes.message)
    } catch (e: any) {
      setCheckError(e?.message ?? String(e))
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

  // ── 初期化 ──────────────────────────────────────────────────
  useEffect(() => {
    refreshKey(); refreshCloudKeys()
    ;(async () => {
      const m = await readMeta()
      const v = m.publish?.apprunDedicated
      setResourceId(typeof v?.servicePrincipalId === 'string' ? v.servicePrincipalId : '')
      setConsentedAt(typeof v?.consentedAt === 'string' ? v.consentedAt : null)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir])

  useEffect(() => {
    const h = () => { refreshKey(); refreshCloudKeys() }
    window.addEventListener('sakura:credentials-changed', h)
    return () => window.removeEventListener('sakura:credentials-changed', h)
  }, [refreshKey, refreshCloudKeys])

  const selectedKeyId = activeKeyId ?? cloudKeys[0]?.id ?? null
  const selectedKeyLabel = cloudKeys.find(k => k.id === selectedKeyId)?.label ?? '（未選択）'
  const keyReady = hasKey === true

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-surface p-4 space-y-1">
        <p className="text-sm font-semibold text-ink">📦 さくらのAppRun 専有型（下調べ）</p>
        <p className="text-xs text-ink-muted leading-relaxed">
          仮想サーバレベルで専有するAppRun。独自ドメインが使えますが、常時課金・4階層の構成が必要な上級者向けサービスです。
          このバージョンでは<b className="text-ink">作成は行わず</b>、制限・プラン・費用の確認と同意までです。
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
        <p className="text-[11px] text-ink-muted leading-relaxed">疎通の確認は、下の「③ 調べる」で行います。</p>
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
                {(lbPlans ?? []).map((p, i) => (
                  <li key={i}>
                    ・{p.name ?? '（名前を取得できませんでした）'}
                    {p.nodeCount === 1 && <span className="text-ink-muted">（非冗長）</span>}
                    {p.nodeCount === 2 && <span className="text-ink-muted">（冗長）</span>}
                  </li>
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

      {/* ⑤ ここから先はまだ作れません */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-1">
        <p className="text-sm font-semibold text-ink">⑤ ここから先はまだ作れません</p>
        <p className="text-xs text-ink-secondary leading-relaxed">
          クラスタの作成・公開は次の版で対応します。このバージョンには作成ボタンはありません。
        </p>
      </section>
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
