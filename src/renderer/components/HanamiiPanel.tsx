import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { getHanamiiToken, getHanamiiTokenById, listHanamiiTokenEntries } from './CredentialsModal'
import { getTargetProfile } from '../targetProfiles'
import { isNameConflictError, suggestAlternativeName } from '../nameConflict'
import { beginActivity } from '../activity'
import { markPublishPending, clearPublishPending } from '../publishPending'
import CopyButton from './CopyButton'
import { clearPublishRecord } from '../publishRecord'

// HANAMII の公開名の文字数上限。HANAMII 側の公開APIリファレンス（hanamii.jp/docs/api）には
// 名前の上限が明記されていないが、HANAMII は AppRun 基盤上で動く（コンテナをビルドし EXPOSE から
// ポートを判定する、と同ファイル内の staticServerFiles コメントに既述）ため、AppRun の
// NAME_PATTERN（src/main/cloud/spec.ts・3〜40文字）と同じ上限を安全側の既定として採用する。
// ※実際の上限は未確認。もし異なることが判明したら要修正。
// 2026-07-13 実測: 45字の公開名で公開成功（公式上限は未公表・これを超える長さは未検証）。
const HANAMII_NAME_MAX_LEN = 45

// main/hanamii/client.ts の describeErrorCode と同じ内容（renderer は main の Node専用コードを import しない流儀のため複製）。
// 既知コードのみ日本語化し、未知のコードはそのまま見せる（推測で網羅しない）。
function describeErrorCode(code: string | null | undefined): string {
  if (!code) return ''
  const table: Record<string, string> = {
    BUILD_FAILED: 'ビルドに失敗しました。直前に追加したライブラリ名の誤りや、package.json の記述ミスが典型的な原因です。',
  }
  return table[code] ?? `エラーコード: ${code}`
}

// フォームの envs / ヘルスチェック設定を、API送信用（sendEnvs）とメタ保存用（persistEnvs。
// シークレットは値を保存しない）に変換する（純粋関数・テスト対象）。パスは `/` 始まりでなければ自動補正する。
// 「公開する（redeploy）」と「🔄 再起動して反映（restart）」の両方の導線で同じ変換ロジックを使うため、
// ここに一本化した（食い違いを防ぐ）。emptySecretKey は値未入力のシークレットがあればそのキー名を返す
// （呼び出し側が「入力してから実行してください」と案内するため）。
export function buildEnvsAndHealthCheck(
  envs: Array<{ key: string; value: string; secret: boolean }>,
  hcEnabled: boolean,
  hcPath: string,
): {
  sendEnvs: Array<{ key: string; value: string; type: 'plain' | 'secret' }>
  persistEnvs: Array<{ key: string; value?: string; secret: boolean }>
  healthCheck: { enabled: boolean; path: string; port: null }
  emptySecretKey: string | null
} {
  const rows = envs.filter(e => e.key.trim())
  const emptySecret = rows.find(e => e.secret && !e.value.trim())
  const sendEnvs = rows.map(e => ({ key: e.key.trim(), value: e.value, type: (e.secret ? 'secret' : 'plain') as 'secret' | 'plain' }))
  const persistEnvs = rows.map(e => e.secret ? { key: e.key.trim(), secret: true } : { key: e.key.trim(), value: e.value, secret: false })
  const normalizedPath = hcPath.trim() ? (hcPath.trim().startsWith('/') ? hcPath.trim() : `/${hcPath.trim()}`) : '/'
  return {
    sendEnvs,
    persistEnvs,
    healthCheck: { enabled: hcEnabled, path: normalizedPath, port: null },
    emptySecretKey: emptySecret ? emptySecret.key.trim() : null,
  }
}

// runtimeStatus.syncedAt（ISO8601想定）を「たった今」「N分前」「HH:mm」に整形する（純粋関数・テスト対象）。
// パース不能な場合は null を返し、呼び出し側で時刻表記を省略する。
export function formatSyncedAt(syncedAt: string | null | undefined, now: Date = new Date()): string | null {
  if (!syncedAt) return null
  const d = new Date(syncedAt)
  if (isNaN(d.getTime())) return null
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'たった今'
  if (diffMin < 60) return `${diffMin}分前`
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false })
}

// HANAMII（国産PaaS）への公開パネル。トークンは「認証情報」に一元登録し（方式B）、
// このパネルは使う瞬間に読んで main へ引数で渡す（main には保存しない・AI Engineキーと同じ扱い）。
// 流れ: 認証情報でトークン登録 → ワークスペース選択 → 公開（IDEがZIP化）→ 状態/公開URL → 破棄。

interface Props {
  projectDir: string
  onOpenCredentials: () => void
}

// HANAMII のプロジェクト名は英数字とハイフンのみ。プロジェクト名を安全な形に整える。
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'app'
}

export default function HanamiiPanel({ projectDir, onOpenCredentials }: Props) {
  const projName = projectDir.split('/').pop() ?? 'app'
  const metaPath = `${projectDir}/.sakuraide.json`
  const guessSecret = (k: string) => /KEY|SECRET|TOKEN|PASS|PWD|CREDENTIAL|PRIVATE|APIKEY/i.test(k)

  const [token, setToken] = useState<string | null>(null)
  const [tokenLoaded, setTokenLoaded] = useState(false)
  const [tokens, setTokens] = useState<Array<{ id: string; label: string }> | null>(null)
  const [tokenId, setTokenId] = useState('')
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string; role: string }> | null>(null)
  const [workspaceId, setWorkspaceId] = useState('')
  const [projectId, setProjectId] = useState<string | null>(null)
  // 公開名（空ならフォルダ名を使う）。test 等のありふれた名前が HANAMII 内部で衝突（409）した際の回避手段
  const [publishName, setPublishName] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [status, setStatus] = useState<{ url: string | null; readyState: string | null; errorCode?: string | null; runtime?: { status: string | null; detail: string | null; syncedAt: string | null } | null } | null>(null)
  const [envs, setEnvs] = useState<Array<{ key: string; value: string; secret: boolean }>>([])
  const [hcEnabled, setHcEnabled] = useState(false)
  const [hcPath, setHcPath] = useState('/')
  const [detectedKeys, setDetectedKeys] = useState<string[]>([])
  const [msg, setMsg] = useState('')
  // 失敗時の生API応答（JSON短縮・診断用・所見11）。主表示（msg）とは分け、折りたたみ「詳細を見る」で見せる。
  const [msgDetail, setMsgDetail] = useState('')
  // 直近に公開を試みた名前（衝突時の代替名提案のベースにする）。
  const [lastAttemptedName, setLastAttemptedName] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const pollRef = useRef<number | null>(null)

  // 📋 ログを見る（折りたたみ）
  const [logsOpen, setLogsOpen] = useState(false)
  const [logsLoading, setLogsLoading] = useState(false)
  const [logs, setLogs] = useState<Array<{ timestamp: string; message: string }> | null>(null)
  const [logsError, setLogsError] = useState('')

  const readMeta = useCallback(async (): Promise<any> => {
    try { return JSON.parse(await window.electronAPI.fs.readFile(metaPath)) } catch { return {} }
  }, [metaPath])

  const saveHanamiiMeta = useCallback(async (h: { projectId?: string | null; workspaceId?: string; envs?: Array<{ key: string; value?: string; secret: boolean }>; tokenId?: string; healthCheck?: { enabled: boolean; path: string }; name?: string }, publishRecord?: { publishedAt: string | null; url: string | null }) => {
    const m = await readMeta()
    const next = {
      ...m,
      target: 'hanamii',
      publish: {
        ...(m.publish ?? {}),
        hanamii: { ...(m.publish?.hanamii ?? {}), ...h },
        // 統一公開記録（publish.targets）。公開成功時のみ渡される（更新のみの保存では触らない）。
        ...(publishRecord ? { targets: { ...(m.publish?.targets ?? {}), hanamii: publishRecord } } : {}),
      },
    }
    await window.electronAPI.fs.writeFile(metaPath, JSON.stringify(next, null, 2))
    window.dispatchEvent(new Event('sakura-meta-changed'))
  }, [metaPath, readMeta])

  const loadWorkspaces = useCallback(async (tk: string) => {
    const r = await window.electronAPI.hanamii.listWorkspaces(tk)
    if (r.ok && r.workspaces) {
      const ws = r.workspaces
      setWorkspaces(ws)
      // 現在の workspaceId が新しい一覧に含まれていればそのまま維持、無ければ先頭にリセット
      setWorkspaceId(prev => (prev && ws.some(w => w.id === prev)) ? prev : (ws[0]?.id || ''))
    } else {
      setMsg(r.message ?? 'ワークスペースの取得に失敗しました')
    }
  }, [])

  // トークン一覧を読み込み、選択中の tokenId を決める（優先順位: メタの保存値 → ストアの使用中 → 先頭）
  const loadTokenList = useCallback(async (preferredId?: string | null) => {
    const { tokens: list, activeId } = await listHanamiiTokenEntries()
    setTokens(list)
    if (list.length === 0) return null
    const chosen = (preferredId && list.some(t => t.id === preferredId))
      ? preferredId
      : (activeId && list.some(t => t.id === activeId))
        ? activeId
        : list[0].id
    setTokenId(chosen)
    return chosen
  }, [])

  // トークン切り替え（セレクタ操作・認証情報変更イベント共通）
  const switchToken = useCallback(async (id: string) => {
    setTokenId(id)
    const tk = await getHanamiiTokenById(id)
    setToken(tk)
    if (tk) {
      setWorkspaces(null)
      loadWorkspaces(tk)
    }
  }, [loadWorkspaces])

  // ── データの保存を持っていく（2026-08-15）──────────────────────────
  // データはオブジェクトストレージにあり、**計算とは別の場所**にある。
  // 鍵を発行して環境変数で渡せば、AppRun で作ったデータをそのまま読める。
  const [placement, setPlacement] = useState<{ bucket: string; prefix: string } | null>(null)
  const [usesData, setUsesData] = useState(false)
  const [withStorage, setWithStorage] = useState(true)
  /** 片づけ待ちの鍵。**動いたと確かめてから**消す（先に消すと動いているアプリが落ちる）。 */
  const [pendingKeyCleanup, setPendingKeyCleanup] = useState<{ projectName: string; keepId: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [pl, scan] = await Promise.all([
          window.electronAPI.storage.placement(projectDir),
          window.electronAPI.storage.scan(projectDir),
        ])
        if (cancelled) return
        setPlacement(pl.ok && pl.placement ? { bucket: pl.placement.bucket, prefix: pl.placement.prefix } : null)
        setUsesData(!!(scan as any)?.usedBy?.length)
      } catch { /* 分からなければ出さない */ }
    })()
    return () => { cancelled = true }
  }, [projectDir])

  const startPolling = useCallback((pid: string, tk: string) => {
    if (pollRef.current) window.clearInterval(pollRef.current)
    let ticks = 0
    pollRef.current = window.setInterval(async () => {
      ticks++
      const r = await window.electronAPI.hanamii.status(pid, tk)
      if (r.ok) {
        setStatus({ url: r.url ?? null, readyState: r.readyState ?? null, errorCode: r.errorCode ?? null, runtime: r.runtime ?? null })
        if (r.readyState === 'READY' || r.readyState === 'ERROR' || ticks > 60) {
          if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null }
          // READYでURLが判明したら統一公開記録（publish.targets）のURLも更新する（尚良い程度・失敗しても致命的ではない）。
          if (r.readyState === 'READY' && r.url) {
            const m = await readMeta()
            const prevAt = m.publish?.targets?.hanamii?.publishedAt ?? new Date().toISOString()
            await saveHanamiiMeta({}, { publishedAt: prevAt, url: r.url })
          }
          // **動いたと確かめてから、古い鍵を片づける**（2026-08-14 の教訓）。
          // 起動に失敗したときは残す（前の版が動き続けられるように）。
          if (r.readyState === 'READY') {
            setPendingKeyCleanup(prev => {
              if (prev) void window.electronAPI.hanamii.cleanUpKeys(prev).catch(() => {})
              return null
            })
          }
        }
      }
    }, 3000)
  }, [readMeta, saveHanamiiMeta])

  // 認証情報の変更イベントで、トークン一覧・選択・ワークスペースを読み直す
  const refreshToken = useCallback(async () => {
    const chosen = await loadTokenList(tokenId)
    setTokenLoaded(true)
    if (chosen) {
      const tk = await getHanamiiTokenById(chosen)
      setToken(tk)
      if (tk) { setWorkspaces(null); loadWorkspaces(tk) }
    } else {
      setToken(null)
    }
  }, [loadTokenList, loadWorkspaces, tokenId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const m = await readMeta()
      const h = m.publish?.hanamii
      if (h?.workspaceId) setWorkspaceId(h.workspaceId)
      if (h?.projectId) setProjectId(h.projectId)
      if (typeof h?.name === 'string' && h.name) setPublishName(h.name)
      if (Array.isArray(h?.envs)) setEnvs(h.envs.map((e: any) => ({ key: String(e.key ?? ''), value: e.secret ? '' : String(e.value ?? ''), secret: !!e.secret })))
      if (h?.healthCheck) {
        setHcEnabled(!!h.healthCheck.enabled)
        setHcPath(typeof h.healthCheck.path === 'string' && h.healthCheck.path ? h.healthCheck.path : '/')
      }

      // トークン選択の優先順位: ①メタ保存の tokenId → ②ストアの使用中 → ③先頭
      const chosen = await loadTokenList(h?.tokenId ?? null)
      if (cancelled) return
      const tk = chosen ? await getHanamiiTokenById(chosen) : await getHanamiiToken()
      if (cancelled) return
      setToken(tk); setTokenLoaded(true)
      if (tk) loadWorkspaces(tk)
      if (h?.projectId && tk) {
        const r = await window.electronAPI.hanamii.status(h.projectId, tk)
        if (!cancelled && r.ok) setStatus({ url: r.url ?? null, readyState: r.readyState ?? null, errorCode: r.errorCode ?? null, runtime: r.runtime ?? null })
      }
    })()
    const onCredChange = () => { refreshToken() }
    window.addEventListener('sakura:credentials-changed', onCredChange)
    return () => {
      cancelled = true
      window.removeEventListener('sakura:credentials-changed', onCredChange)
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir])

  useEffect(() => {
    let cancelled = false
    window.electronAPI.hanamii.detectEnvKeys(projectDir).then(r => {
      if (!cancelled) setDetectedKeys(r.ok ? r.keys : [])
    }).catch(() => {})
    return () => { cancelled = true }
  }, [projectDir])

  // nameOverride: 衝突時の「代替名で公開し直す」ボタンから、state 更新の反映待ちをせず即座に使う名前を渡すため。
  const publish = async (nameOverride?: string) => {
    setMsgDetail('')
    if (!token) { setMsg('先に「認証情報」で HANAMII トークンを登録してください'); return }
    if (!workspaceId) { setMsg('ワークスペースを選択してください'); return }
    const { sendEnvs, persistEnvs, healthCheck, emptySecretKey } = buildEnvsAndHealthCheck(envs, hcEnabled, hcPath)
    if (emptySecretKey) { setMsg(`シークレット環境変数「${emptySecretKey}」の値が未入力です。値を入力してから公開してください（シークレットは保存されないため公開のたびに入力が必要です）。`); return }
    // 実行中フラグ（終了確認ダイアログ用）。中断・失敗でも必ず解除されるよう最外の finally で呼ぶ。
    const endActivity = beginActivity('公開処理')
    try {
      setPublishing(true); setMsg(''); setStatus({ url: null, readyState: 'BUILDING' })
      // 公開名: 入力があればそれを、無ければフォルダ名を使う（いずれも safeName で正規化）
      const name = safeName((nameOverride ?? publishName).trim() || projName)
      setLastAttemptedName(name)
      // 公開開始マーカー（途中で中断・失敗しても後から検知できるようにする）。
      // API呼び出しが成功/失敗いずれで終わっても finally で必ず消す。
      await markPublishPending(projectDir, 'hanamii')
      try {
        const r = await window.electronAPI.hanamii.publish(projectDir, { token, workspaceId, projectId: projectId ?? undefined, name, envs: sendEnvs, healthCheck, withStorage: withStorage && !!placement })
        setPublishing(false)
        if (!r.ok) { setMsg(r.message ?? '公開に失敗しました'); setMsgDetail(r.detail ?? ''); setStatus(null); return }
        // 片づけは動作確認のあと（ここではまだ消さない）
        if (r.storagePermissionId && r.storageProjectName) {
          setPendingKeyCleanup({ projectName: r.storageProjectName, keepId: r.storagePermissionId })
        }
        const pid = r.projectId ?? projectId
        if (pid) {
          setProjectId(pid)
          // 統一公開記録（publish.targets）: 公開成功時に記録。URLは判明していれば入れ、未判明ならnull
          // （ポーリングでREADYになりURLが判明した時に startPolling 側で更新する）。
          await saveHanamiiMeta(
            { projectId: pid, workspaceId, envs: persistEnvs, tokenId, healthCheck: { enabled: healthCheck.enabled, path: healthCheck.path }, name },
            { publishedAt: new Date().toISOString(), url: null },
          )
          startPolling(pid, token)
        }
      } finally {
        await clearPublishPending(projectDir)
      }
    } finally {
      setPublishing(false)
      endActivity()
    }
  }

  // A-5: env/ヘルスチェックの変更を「再公開（ビルドし直し）」なしで反映する高速経路。
  // 現在のフォーム内容（envs / hcEnabled / hcPath）を PATCH /env・PUT /health-check で保存してから
  // POST /restart する（main側の hanamii:restart がまとめて行う）。コード変更は反映されない
  // （その場合は既存の「再公開する」を使う）。
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartMsg, setRestartMsg] = useState('')
  const [restartMsgDetail, setRestartMsgDetail] = useState('')

  const doRestart = async () => {
    if (!projectId || !token) return
    setRestartMsg(''); setRestartMsgDetail('')
    const { sendEnvs, persistEnvs, healthCheck, emptySecretKey } = buildEnvsAndHealthCheck(envs, hcEnabled, hcPath)
    if (emptySecretKey) { setConfirmRestart(false); setRestartMsg(`シークレット環境変数「${emptySecretKey}」の値が未入力です。値を入力してから再起動してください。`); return }
    setRestarting(true)
    const r = await window.electronAPI.hanamii.restart(projectId, { token, envs: sendEnvs, healthCheck })
    setRestarting(false); setConfirmRestart(false)
    if (!r.ok) { setRestartMsg(r.message ?? '再起動に失敗しました'); setRestartMsgDetail(r.detail ?? ''); return }
    setRestartMsg(r.noop ? '設定に変更がなかったため、再起動は不要でした。' : '✅ 再起動して設定を反映しました。')
    await saveHanamiiMeta({ envs: persistEnvs, healthCheck: { enabled: healthCheck.enabled, path: healthCheck.path } })
  }

  const loadLogs = useCallback(async () => {
    if (!projectId || !token) return
    setLogsLoading(true); setLogsError('')
    const r = await window.electronAPI.hanamii.logs(token, projectId, { limit: 100 })
    setLogsLoading(false)
    if (r.ok) setLogs(r.logs ?? [])
    else setLogsError(r.message ?? 'ログの取得に失敗しました')
  }, [projectId, token])

  const toggleLogs = () => {
    const next = !logsOpen
    setLogsOpen(next)
    if (next && logs === null) loadLogs()
  }

  // タイムスタンプを HH:mm:ss に短縮する（パース不能ならそのまま返す）。
  const formatLogTime = (ts: string): string => {
    const d = new Date(ts)
    if (isNaN(d.getTime())) return ts
    return d.toLocaleTimeString('ja-JP', { hour12: false })
  }

  const teardown = async () => {
    if (!projectId || !token) return
    setMsg(''); setMsgDetail('')
    const r = await window.electronAPI.hanamii.teardown(projectId, token)
    if (r.ok) {
      await saveHanamiiMeta({ projectId: null })
      // 破棄できたら公開記録（publish.targets.hanamii）も消す。残すと「📡 公開したもの一覧」に
      // 存在しない公開が出続ける（2026-08-06・AppRun側と同じ扱い）。
      try { await clearPublishRecord(projectDir, 'hanamii') } catch { /* 記録の掃除の失敗は破棄の成否に影響させない */ }
      setProjectId(null); setStatus(null); setConfirmDel(false)
    }
    else setMsg(r.message ?? '削除に失敗しました')
  }

  const rs = status?.readyState
  const busy = publishing || rs === 'BUILDING'
  // 名前衝突カード（NameConflictRetry）が表示されるケースでは、生の失敗メッセージ本体は
  // 折りたたみに降格してカードを主役にする（所見17: 親切カードと生エラーの二重表示の解消）。
  const conflictCardShown = !projectId && !busy && !!msg && isNameConflictError(msg)

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-surface p-4 space-y-1">
        <p className="text-sm font-semibold text-ink">🌸 HANAMII（国産PaaS）で公開</p>
        <p className="text-xs text-ink-muted leading-relaxed">
          さくらのクラウド基盤上の国産PaaS。IDEがプロジェクトをZIP化してアップロードします（コンテナ不要）。データは100%国内。
        </p>
        {getTargetProfile('hanamii').serviceUrl && (
          <p className="text-[11px] text-ink-muted">
            <a href={getTargetProfile('hanamii').serviceUrl} className="hover:underline">🌐 公式サイトを見る ↗</a>
          </p>
        )}
      </div>

      {/* ① 認証情報（トークンは「認証情報」で一元管理） */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-2">
        <p className="text-sm font-semibold text-ink">① APIトークン</p>
        {!tokenLoaded ? (
          <p className="text-xs text-ink-muted">確認中…</p>
        ) : token ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-brand-green font-semibold">✓ 認証情報に HANAMII トークンが登録済み</span>
              <button onClick={onOpenCredentials} className="text-xs text-ink-muted hover:text-ink">認証情報を開く</button>
            </div>
            {tokens && tokens.length > 1 && (
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-ink-secondary flex-none">使うトークン</label>
                <select
                  value={tokenId}
                  onChange={e => switchToken(e.target.value)}
                  className="flex-1 bg-surface border border-line rounded-lg px-2 py-1.5 text-xs text-ink outline-none focus:border-sakura"
                >
                  {tokens.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-ink-secondary leading-relaxed">
              HANAMII の管理画面で発行したAPIトークン（<span className="font-mono">hnm_…</span>）を「認証情報」で登録してください（他のキーと同じ場所で一元管理します）。
            </p>
            <button
              onClick={onOpenCredentials}
              className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90"
            >🔑 認証情報を開いて登録</button>
          </div>
        )}
      </section>

      {/* ② ワークスペース */}
      {token && (
        <section className="rounded-xl border border-line bg-surface p-4 space-y-2">
          <p className="text-sm font-semibold text-ink">② ワークスペース</p>
          {workspaces === null ? (
            <p className="text-xs text-ink-muted">取得中…</p>
          ) : workspaces.length === 0 ? (
            <p className="text-xs text-brand-yellow">ワークスペースがありません。HANAMII の管理画面で作成してください。</p>
          ) : workspaces.length === 1 ? (
            <p className="text-xs text-ink-secondary">{workspaces[0].name}</p>
          ) : (
            <select
              value={workspaceId}
              onChange={e => setWorkspaceId(e.target.value)}
              className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink outline-none focus:border-sakura"
            >
              {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
        </section>
      )}

      {/* ②' 環境変数（任意） */}
      {token && (
        <section className="rounded-xl border border-line bg-surface p-4 space-y-2">
          <p className="text-sm font-semibold text-ink">環境変数（任意）</p>
          <p className="text-[11px] text-ink-muted leading-relaxed">
            アプリに渡すキーと値。APIキーなど秘密の値は「シークレット」に。シークレットは端末に保存されないため、公開のたびに入力が必要です。
          </p>
          {detectedKeys.filter(k => !envs.some(e => e.key.trim() === k)).length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] text-ink-muted">コードから検出（クリックで追加。🔒は秘密の候補）:</p>
              <div className="flex flex-wrap gap-1.5">
                {detectedKeys.filter(k => !envs.some(e => e.key.trim() === k)).map(k => (
                  <button
                    key={k}
                    onClick={() => setEnvs(prev => [...prev, { key: k, value: '', secret: guessSecret(k) }])}
                    className="text-[11px] font-mono px-2 py-1 rounded-md border border-line bg-overlay text-ink-secondary hover:border-sakura hover:text-ink"
                    title="この環境変数を追加"
                  >＋ {k}{guessSecret(k) ? ' 🔒' : ''}</button>
                ))}
              </div>
            </div>
          )}
          {envs.length > 0 && (
            <div className="space-y-2">
              {envs.map((e, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={e.key}
                    onChange={ev => setEnvs(prev => prev.map((x, j) => j === i ? { ...x, key: ev.target.value } : x))}
                    placeholder="KEY"
                    className="w-2/5 bg-surface border border-line rounded-lg px-2 py-1.5 text-xs text-ink font-mono outline-none focus:border-sakura"
                  />
                  <input
                    value={e.value}
                    onChange={ev => setEnvs(prev => prev.map((x, j) => j === i ? { ...x, value: ev.target.value } : x))}
                    type={e.secret ? 'password' : 'text'}
                    placeholder={e.secret ? '値（保存されません）' : '値'}
                    className="flex-1 bg-surface border border-line rounded-lg px-2 py-1.5 text-xs text-ink font-mono outline-none focus:border-sakura"
                  />
                  <label className="flex items-center gap-1 text-[11px] text-ink-secondary select-none whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={e.secret}
                      onChange={ev => setEnvs(prev => prev.map((x, j) => j === i ? { ...x, secret: ev.target.checked } : x))}
                    />
                    秘密
                  </label>
                  <button
                    onClick={() => setEnvs(prev => prev.filter((_, j) => j !== i))}
                    className="flex-none text-ink-muted hover:text-brand-red text-sm"
                    title="削除"
                  >✕</button>
                </div>
              ))}
            </div>
          )}
          <button
            onClick={() => setEnvs(prev => [...prev, { key: '', value: '', secret: false }])}
            className="text-xs text-sakura hover:underline"
          >＋ 変数を追加</button>
        </section>
      )}

      {/* ②'' ヘルスチェック（任意） */}
      {token && (
        <section className="rounded-xl border border-line bg-surface p-4 space-y-2">
          <p className="text-sm font-semibold text-ink">ヘルスチェック（任意）</p>
          <p className="text-[11px] text-ink-muted leading-relaxed">
            アプリが正常に動いているか、公開後に自動で確認するパス（任意）。
          </p>
          <label className="flex items-center gap-2 text-xs text-ink-secondary select-none">
            <input
              type="checkbox"
              checked={hcEnabled}
              onChange={ev => setHcEnabled(ev.target.checked)}
            />
            ヘルスチェックを有効にする
          </label>
          {hcEnabled && (
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-ink-secondary flex-none">パス</label>
              <input
                value={hcPath}
                onChange={ev => setHcPath(ev.target.value)}
                placeholder="/"
                className="flex-1 bg-surface border border-line rounded-lg px-2 py-1.5 text-xs text-ink font-mono outline-none focus:border-sakura"
              />
            </div>
          )}
        </section>
      )}

      {/* ③ 公開 */}
      {token && (
        <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
          <p className="text-sm font-semibold text-ink">③ 公開</p>
          <div>
            <label className="text-[11px] font-medium text-ink-secondary">公開名（半角英数字とハイフン・任意）</label>
            <input
              value={publishName}
              onChange={e => setPublishName(e.target.value)}
              placeholder={safeName(projName)}
              disabled={!!projectId}
              className="mt-1 w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink placeholder-ink-muted outline-none focus:border-sakura disabled:opacity-50"
            />
            <p className="mt-1 text-[11px] text-ink-muted leading-relaxed">
              {projectId
                ? '公開済みのため名前は変更できません（変更するには「破棄」してから公開し直してください）。'
                : '公開に失敗する場合、下に表示される代替名の提案からワンクリックで変更できます。'}
            </p>
          </div>
          {/* ── データの保存を持っていく（2026-08-15）──────────────────────
              データはオブジェクトストレージにあり、**計算とは別の場所**にある。
              だから公開先を変えても、同じデータをそのまま読める。
              **何が持っていかれるのかを見せる**（黙って鍵を配らない）。 */}
          {placement && (
            <div className="rounded-lg border border-line bg-overlay p-3 space-y-1.5">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={withStorage}
                  onChange={e => setWithStorage(e.target.checked)}
                  disabled={busy}
                  className="mt-0.5 accent-sakura"
                />
                <span className="text-[11px] text-ink-secondary leading-relaxed">
                  <span className="text-ink font-medium">💾 データの保存を持っていく</span>
                  <br />
                  保存場所 <span className="font-mono">{placement.bucket}</span>
                  {placement.prefix && <span className="font-mono"> / {placement.prefix}</span>}
                  {' '}を読み書きできるようにします（公開のたびに新しい鍵を発行します）。
                  <b className="text-ink"> AppRun と同じデータ</b>を見るので、
                  片方で消したものは、もう片方からも消えます。
                </span>
              </label>
              {!usesData && (
                <p className="text-[11px] text-ink-muted leading-relaxed">
                  ※ このアプリは、いまのところデータの保存（koto-data）を使っていないようです。
                </p>
              )}
            </div>
          )}

          <button
            onClick={() => publish()}
            disabled={busy || !workspaceId}
            className="w-full sakura-gradient text-white rounded-lg px-4 py-2.5 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
          >{busy ? '公開中…' : projectId ? '🚀 再公開する（最新の内容を反映）' : '🚀 公開する'}</button>

          {/* 公開名の衝突（重複）時: ワンクリックで代替名に変えて公開し直す（初回公開のみ。redeploy は対象外）。 */}
          {conflictCardShown && (
            <NameConflictRetry
              currentName={lastAttemptedName || safeName(publishName.trim() || projName)}
              maxLen={HANAMII_NAME_MAX_LEN}
              onRetry={suggested => { setPublishName(suggested); publish(suggested) }}
            />
          )}

          {/* A-5: env/ヘルスチェックだけを変更したときの高速経路（コード変更は反映されない。その場合は上の「再公開する」を使う）。
              公開済みプロジェクトがあるときのみ表示。 */}
          {projectId && (
            <div className="border-t border-line pt-2 space-y-2">
              {confirmRestart ? (
                <div className="rounded-lg border border-line bg-overlay p-3 space-y-2">
                  <p className="text-xs text-ink-secondary leading-relaxed select-text">
                    アプリが数十秒間停止します。再起動して設定（環境変数・ヘルスチェック）を反映しますか？
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={doRestart}
                      disabled={restarting}
                      className="bg-overlay text-ink border border-sakura/50 rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-sakura/10 disabled:opacity-40"
                    >{restarting ? '再起動中…' : '再起動する'}</button>
                    <button
                      onClick={() => setConfirmRestart(false)}
                      disabled={restarting}
                      className="bg-overlay text-ink border border-line rounded-lg px-3 py-1.5 text-xs disabled:opacity-40"
                    >やめる</button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmRestart(true)}
                  disabled={busy || restarting}
                  className="text-xs text-ink-secondary hover:text-ink disabled:opacity-40"
                  title="コード変更は反映されません。ビルドし直しが必要な場合は「再公開する」を使ってください。"
                >🔄 再起動して反映（env・ヘルスチェックのみ・ビルドし直しなし）</button>
              )}
              {restartMsg && <ErrorMessageBlock msg={restartMsg} detail={restartMsgDetail} demoted={false} />}
            </div>
          )}

          {status && (
            <div className="rounded-lg border border-line bg-overlay p-3 space-y-1">
              <p className="text-xs text-ink-secondary">
                状態: {rs === 'READY' ? '✅ 公開済み' : rs === 'ERROR' ? '⚠️ 失敗' : rs === 'BUILDING' ? '⏳ 公開処理中…（数十秒）' : rs ?? '—'}
              </p>
              {/* runtime（ヘルス）の表示判定（2026-07-13 ユーザー実機報告: 公開直後に赤⚠が出るのは早すぎる）:
                  - 公開処理中（busy）→ 何も出さない（「⏳ 公開処理中…」のみ）
                  - healthy → 緑で正常
                  - unknown / 値なし → まだヘルス情報が届いていないだけ（起動直後は数十秒かかる）
                    なので中立トーンの「動作確認中」（赤⚠にしない）
                  - それ以外（unhealthy 等の明示異常）→ 赤⚠＋ログへの誘導 */}
              {!busy && status.runtime?.status && (
                status.runtime.status === 'healthy' ? (
                  <p className="text-xs text-brand-green">
                    🩺 アプリの状態: 正常{(() => { const t = formatSyncedAt(status.runtime.syncedAt); return t ? `（${t}確認）` : '' })()}
                  </p>
                ) : status.runtime.status === 'unknown' ? (
                  <p className="text-[11px] text-ink-muted leading-relaxed">
                    🩺 動作確認中…（起動直後は状態の反映まで数十秒かかることがあります。「↻ 状態を更新」で再確認できます）
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    <p className="text-xs text-brand-red">
                      ⚠️ アプリが応答していません（状態: {status.runtime.status}）
                    </p>
                    {status.runtime.detail && (
                      <p className="text-[11px] text-ink-muted leading-relaxed select-text">{status.runtime.detail}</p>
                    )}
                    <p className="text-[11px] text-ink-muted">下の「📋 ログを見る」で原因を確認できます</p>
                  </div>
                )
              )}
              {status.url && rs === 'READY' && (
                <div className="flex items-center gap-2 flex-wrap">
                  <a href={status.url} className="inline-block text-sm text-sakura hover:underline break-all font-semibold">🌐 {status.url}</a>
                  <CopyButton text={status.url} title="公開URLをコピー" />
                </div>
              )}
              {rs === 'ERROR' && (
                <div className="space-y-1 pt-1">
                  <p className="text-xs text-brand-red leading-relaxed select-text">
                    {describeErrorCode(status.errorCode) || '公開に失敗しました。詳細は HANAMII の管理画面をご確認ください。'}
                  </p>
                  <a href="https://hanamii.jp" className="inline-block text-xs text-sakura hover:underline">HANAMII の管理画面で詳細を見る ↗</a>
                </div>
              )}
            </div>
          )}

          {projectId && (
            <div className="border-t border-line pt-2 space-y-2">
              <button onClick={toggleLogs} className="text-xs text-ink-secondary hover:text-ink">
                {logsOpen ? '▾' : '▸'} 📋 ログを見る
              </button>
              {logsOpen && (
                <div className="space-y-2">
                  <div className="flex items-center justify-end">
                    <button
                      onClick={loadLogs}
                      disabled={logsLoading}
                      className="text-[11px] text-sakura hover:underline disabled:opacity-40"
                    >↻ 再取得</button>
                  </div>
                  {logsLoading ? (
                    <p className="text-xs text-ink-muted">取得中…</p>
                  ) : logsError ? (
                    <div className="rounded-lg border border-brand-red/60 bg-brand-red/10 p-2">
                      <p className="text-xs text-brand-red select-text">{logsError}</p>
                    </div>
                  ) : logs && logs.length === 0 ? (
                    <p className="text-xs text-ink-muted">ログはまだありません</p>
                  ) : logs && logs.length > 0 ? (
                    // 端末風の固定ダーク背景（両テーマで白文字が読める）。以前の bg-ink/90 は
                    // CSS変数色にopacity修飾が効かず背景が透明になり、ライトモードで白文字が
                    // 見えなくなっていた（2026-07-13 ユーザー実機報告）。
                    <div className="rounded-lg border border-line bg-[#1c1c22] p-2 max-h-64 overflow-y-auto select-text">
                      {logs.map((l, i) => (
                        <p key={i} className="font-mono text-[11px] leading-relaxed text-white/90 whitespace-pre-wrap break-all">
                          <span className="text-white/50">{formatLogTime(l.timestamp)}</span> {l.message}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          )}

          {projectId && (
            confirmDel ? (
              <div className="rounded-lg border border-brand-red/60 bg-overlay p-3 space-y-2">
                <p className="text-xs text-brand-red font-semibold">この公開を破棄（削除）します。公開URLは無効になります。</p>
                <div className="flex gap-2">
                  <button onClick={teardown} className="bg-brand-red/90 text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90">破棄する</button>
                  <button onClick={() => setConfirmDel(false)} className="bg-overlay text-ink border border-line rounded-lg px-3 py-1.5 text-xs">やめる</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setConfirmDel(true)} className="text-xs text-ink-muted hover:text-brand-red">🗑 この公開を破棄する</button>
            )
          )}
        </section>
      )}

      {msg && <ErrorMessageBlock msg={msg} detail={msgDetail} demoted={conflictCardShown} />}
    </div>
  )
}

// 失敗メッセージの表示ブロック。
// - detail（生API応答のJSON短縮）があれば <details>「詳細を見る」で折りたたみ表示する（所見11:
//   生JSONを文言に混ぜない。ただし過去に原因究明で役立った実績があるため、折りたたみで残す）。
// - demoted=true（名前衝突カード等の親切カードが主役のケース・所見17）ではメッセージ本体ごと折りたたみに降格する。
function ErrorMessageBlock({ msg, detail, demoted }: { msg: string; detail: string; demoted: boolean }) {
  const copyText = detail ? `${msg}\n${detail}` : msg
  const body = (
    <>
      <div className="flex items-start gap-2">
        <p className="flex-1 text-xs text-ink-secondary leading-relaxed whitespace-pre-wrap break-all select-text">{msg}</p>
        <button
          onClick={() => { navigator.clipboard.writeText(copyText).catch(() => {}) }}
          className="flex-none text-[11px] text-sakura hover:underline"
          title="メッセージをコピー"
        >コピー</button>
      </div>
      {detail && !demoted && (
        <details>
          <summary className="text-[11px] text-ink-muted cursor-pointer select-none hover:text-ink">詳細を見る</summary>
          <pre className="mt-1 text-[11px] text-ink-muted font-mono leading-relaxed whitespace-pre-wrap break-all select-text">{detail}</pre>
        </details>
      )}
      {detail && demoted && (
        <pre className="text-[11px] text-ink-muted font-mono leading-relaxed whitespace-pre-wrap break-all select-text">{detail}</pre>
      )}
    </>
  )
  if (demoted) {
    return (
      <details className="rounded-lg border border-line bg-overlay p-3">
        <summary className="text-[11px] text-ink-muted cursor-pointer select-none hover:text-ink">詳細を見る（元のエラーメッセージ）</summary>
        <div className="mt-2 space-y-2">{body}</div>
      </details>
    )
  }
  return <div className="rounded-lg border border-line bg-overlay p-3 space-y-2">{body}</div>
}

// 公開名の衝突（重複）時に表示する、ワンクリックで代替名に変えて公開し直すブロック。
// suggested は currentName（≒直近に失敗した名前）が変わるたびに新しく算出する。
// 「代替名でもまた衝突」→ lastAttemptedName が新しい代替名に更新される → currentName が変わるので、
// 再衝突のたびに新しいランダムな候補が出る（同じ base に対しては再レンダーしても安定させる）。
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
