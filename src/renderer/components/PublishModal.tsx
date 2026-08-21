import React, { useState, useEffect, useMemo } from 'react'
import { runSecurityCheck, SecurityCheckResult } from '../securityCheck'
import { getTargetProfile, isAutoPublishTarget } from '../targetProfiles'
import StorageNotice from './StorageNotice'
import { withoutPublishTarget, canForgetRow, PUBLISH_TARGET_CONSOLE, buildPublishStatusRows, isStale, formatPublishedAt, parseApprunLegacy, detectInterruptedPublish, latestPublishedTarget, type PendingPublish } from '../publishStatus'
import { clearPublishPending } from '../publishPending'
import { rsyncExcludeArgs } from '../../shared/publishExclude'
import AppRunPanel from './AppRunPanel'
import HanamiiPanel from './HanamiiPanel'
import VercelPanel from './VercelPanel'
import VpsPanel from './VpsPanel'
import { resolvePublishRoot } from '../publishRootRenderer'

// 公開先ごとの表示名（中断検知バナー用。TARGET_LABELS と同じ内容だが publishStatus.ts 側に
// 定義があるためここでは PublishTargetKind → 表示名の最小限のみを持つ）。
const PENDING_TARGET_LABELS: Record<PendingPublish['target'], string> = {
  hanamii: '🌸 HANAMII',
  'sakura-apprun': '📦 さくらのAppRun',
  'sakura-rental': '🌐 さくらのレンタルサーバ',
  vercel: '▲ Vercel',
}

// 「🚀 公開」モーダル：
// - .sakuraide.json の公開先・設定を読み、フォーム入力（次回から再入力不要）
// - 前提チェック（rsync / docker）を行い、足りなければ日本語で案内
// - 公開コマンドをIDE内ターミナルへ流して実行（進行が見える・パスワードも入力できる）

// sakura-vps は targetProfiles.COMING_SOON_TARGETS に残したまま（②初期セットアップ・③公開が
// できるまで、通常の公開先一覧には出さない）。ただし①接続（VpsPanel）は開発中の動作確認のため、
// この画面からだけ「開発中」表示で到達できるようにする（下の target 選択画面を参照）。
type Target = 'sakura-rental' | 'sakura-apprun' | 'hanamii' | 'vercel' | 'sakura-vps'

// 統一公開記録（publish.targets）: 複数の公開先へ公開した履歴を一元管理する。
// 書き込みは各公開フローの成功時（HanamiiPanel/AppRunPanel/VercelPanel/このファイルの publishRental）。
// 既存の publish.* フィールド（account/host/lastPublishedAt 等）はそのまま残す（StatusBar 互換）。
type PublishTargetKind = 'hanamii' | 'sakura-apprun' | 'sakura-rental' | 'vercel'
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
    // 公開開始マーカー（中断・失敗の検知用。src/renderer/publishPending.ts が読み書きする）。
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

export default function PublishModal({ projectDir, apiKey, onClose, onRun, onOpenCredentials, onOpenPublishedList }: Props) {
  const [meta, setMeta] = useState<Meta>({})
  const [target, setTarget] = useState<Target | null>(null)
  const [loaded, setLoaded] = useState(false)
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
  // 公開前セキュリティチェック
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<SecurityCheckResult | null>(null)
  const [pendingCmd, setPendingCmd] = useState<string | null>(null) // 「要確認」時にユーザー判断待ちの公開コマンド
  // 公開状況一覧（③公開 冒頭の「このプロジェクトの公開状況」ボックス用）。プロジェクトの最終変更時刻は1回だけ取得する。
  const [latestChangeAt, setLatestChangeAt] = useState<string | null>(null)
  const [apprunLegacy, setApprunLegacy] = useState<{ createdAt: string | null } | null>(null)

  // 公開の実行：先にセキュリティチェックを行い、「要確認」ならユーザーの判断を待つ
  const startPublish = async (cmd: string) => {
    setChecking(true)
    setCheck(null)
    const result = await runSecurityCheck(projectDir, apiKey)
    setChecking(false)
    setCheck(result)
    if (result.verdict === 'warn') {
      setPendingCmd(cmd) // 指摘を見せて判断を仰ぐ
      return
    }
    onRun(cmd) // 問題なし／チェック省略 → そのまま公開
    setRunning(true)
  }

  const proceedAnyway = () => {
    if (!pendingCmd) return
    onRun(pendingCmd)
    setPendingCmd(null)
    setRunning(true)
  }

  const projName = projectDir.split('/').pop() ?? 'app'
  const rentalServiceUrl = getTargetProfile('sakura-rental').serviceUrl

  // 前回の公開が完了前に中断された可能性の検知（Part2: 公開開始マーカー・publish.pending）。
  // meta は projectDir を開いた/変えたときに読み込まれる値なので、meta.publish が変わったときだけ再計算する。
  const interruptedPublish = useMemo(() => detectInterruptedPublish(meta.publish ?? {}, Date.now()), [meta.publish])

  // 「確認しました」: .sakuraide.json の publish.pending を削除し、画面上のバナーも消す。
  const dismissInterruptedPublish = async () => {
    await clearPublishPending(projectDir)
    setMeta(prev => ({ ...prev, publish: { ...prev.publish, pending: null } }))
  }

  // 既存の設定を読み込む
  useEffect(() => {
    ;(async () => {
      let m: Meta = {}
      try {
        const raw = await window.electronAPI.fs.readFile(`${projectDir}/.sakuraide.json`)
        m = JSON.parse(raw)
      } catch { /* メタ無し（既存フォルダ等） */ }
      setMeta(m)
      // 最初に開く画面は「最後に公開した公開先」（2026-07-31 ユーザー要望）。
      // 公開実績が無ければ、従来どおりプロジェクトに設定された公開先（meta.target）を使う。
      const last = latestPublishedTarget(m.publish)
      if (last) setTarget(last)
      else if (m.target === 'sakura-rental' || m.target === 'sakura-apprun' || m.target === 'hanamii' || m.target === 'vercel' || m.target === 'sakura-vps') setTarget(m.target)
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

  const saveMeta = async (patch: Partial<Meta>) => {
    const next = { ...meta, ...patch, publish: { ...meta.publish, ...patch.publish } }
    setMeta(next)
    await window.electronAPI.fs.writeFile(`${projectDir}/.sakuraide.json`, JSON.stringify(next, null, 2))
    return next
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
      const url = `https://${host}/`
      await saveMeta({
        target: 'sakura-rental',
        publish: {
          account, host, url, lastPublishedAt: publishedAt,
          targets: { ...meta.publish?.targets, 'sakura-rental': { publishedAt, url } },
        },
      })
      window.dispatchEvent(new Event('sakura-meta-changed'))
      const hasPublic = await window.electronAPI.fs.exists(`${projectDir}/public`)
      const hasApp = await window.electronAPI.fs.exists(`${projectDir}/app`)
      const dest = `${account}@${host}`
      // 公開の起点は`public/`（無ければプロジェクト直下＝移行前）。
      const root = await resolvePublishRoot(projectDir)
      let cmd = `cd "${root}"`
      if (hasPublic) {
        cmd += ` && rsync -avz --exclude='.DS_Store' public/ "${dest}:/home/${account}/www/"`
        if (hasApp) cmd += ` && rsync -avz --exclude='config.sample.php' --exclude='.DS_Store' app/ "${dest}:/home/${account}/app/"`
      } else {
        // public/ が無い構成（後付け公開）はプロジェクト全体を公開ディレクトリへ。
        // ここは公開Webルートなので、除外を落とすと会話履歴や過去のソースが誰でも読める場所に置かれる。
        // 除外の定義は shared/publishExclude.ts に一本化してある（手で並べ直さないこと）。
        cmd += ` && rsync -avz${rsyncExcludeArgs(['deploy.sh'])} ./ "${dest}:/home/${account}/www/"`
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[640px] max-h-[85vh] overflow-y-auto bg-elevated rounded-2xl border border-line shadow-xl p-6 fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-ink">🚀 公開</h2>
          <button onClick={onClose} className="text-ink-muted hover:text-ink text-lg leading-none">×</button>
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

        {/* 前回の公開が完了前に中断された可能性の警告（Part2: 公開開始マーカー）。
            画面（公開先未選択／各パネル）によらず、このモーダルを開いている間は常に見せる。 */}
        {interruptedPublish && (
          <div className="rounded-xl border border-brand-yellow/70 bg-surface p-4 mb-4 space-y-2">
            <p className="text-sm text-ink leading-relaxed">
              ⚠️ 前回、{PENDING_TARGET_LABELS[interruptedPublish.target]}への公開が完了前に中断された可能性があります。実際に公開されたか、下の公開状況や公開先の管理画面でご確認ください。
            </p>
            <div className="flex justify-end">
              <button
                onClick={dismissInterruptedPublish}
                className="text-xs text-ink-secondary border border-line rounded-lg px-3 py-1.5 hover:border-sakura hover:text-ink"
              >確認しました（この通知を消す）</button>
            </div>
          </div>
        )}

        {/* 公開先を選んだら「データの保存」について知らせる（2026-08-13）。
            **公開先ごとに答えが変わる**ので、ここに置く。レンタルサーバならファイルが
            残るので費用は要らない。コンテナ系では消えるので保存場所が要る。
            sakura-vps は①接続のみで公開の実装が無いため対象外。 */}
        {loaded && target && target !== 'sakura-vps' && (
          <div className="mb-3">
            <StorageNotice projectDir={projectDir} target={target as 'hanamii' | 'sakura-apprun' | 'sakura-rental' | 'vercel'} onAskAi={onClose} />
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
        ) : checking ? (
          // ── 公開前セキュリティチェック中 ──
          <div className="rounded-xl border border-line bg-surface p-5 flex items-center gap-3">
            <span className="w-4 h-4 rounded-full border-2 border-sakura border-t-transparent animate-spin flex-none" />
            <div>
              <p className="text-sm text-ink font-semibold">🛡 公開前のセキュリティチェックを実行中…（AIがコードを確認しています。30秒ほどかかります）</p>
              <p className="text-xs text-ink-muted mt-0.5">秘密情報の直書き・XSS・公開NGファイル等をAIが確認しています（数十秒）</p>
            </div>
          </div>
        ) : pendingCmd && check ? (
          // ── チェックで「要確認」→ ユーザーの判断を仰ぐ ──
          <div className="space-y-3">
            <div className="rounded-xl border border-brand-yellow/70 bg-surface p-4">
              <p className="text-sm font-semibold text-ink mb-2">🛡 セキュリティチェック: ⚠️ 要確認</p>
              <pre className="text-xs text-ink-secondary whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">{check.report}</pre>
            </div>
            <p className="text-xs text-ink-muted leading-relaxed">
              修正してから公開する場合は「やめる」を選び、AIチャットに指摘内容を貼り付けて修正を依頼してください。
            </p>
            <div className="flex justify-between items-center">
              <button
                onClick={() => { setPendingCmd(null); setCheck(null) }}
                className="bg-overlay text-ink border border-line rounded-lg px-4 py-2 text-sm font-medium hover:border-sakura"
              >やめる（修正してから公開）</button>
              <button
                onClick={proceedAnyway}
                className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90"
              >理解した上で公開する</button>
            </div>
          </div>
        ) : running ? (
          // ── 実行中／完了案内 ──
          <div className="space-y-3">
            {check && (
              <div className={`rounded-xl border p-3 ${check.verdict === 'ok' ? 'border-brand-green/60' : 'border-line'} bg-surface`}>
                <p className="text-xs font-semibold text-ink">
                  {check.verdict === 'ok' ? '🛡 セキュリティチェック: ✅ 問題なし' : '🛡 セキュリティチェック: ⏭ 省略'}
                </p>
                <details className="mt-1">
                  <summary className="text-[11px] text-ink-muted cursor-pointer hover:text-ink-secondary">詳細を見る</summary>
                  <pre className="text-[11px] text-ink-secondary whitespace-pre-wrap leading-relaxed mt-1">{check.report}</pre>
                </details>
              </div>
            )}
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
              onForget={async t => { await saveMeta({ publish: withoutPublishTarget(meta.publish, t) as Meta['publish'] }) }}
            />
            {showMismatch ? (
              <div className="rounded-xl border border-brand-yellow/70 bg-surface p-4">
                <p className="text-sm text-ink leading-relaxed">
                  現在の公開先「{getTargetProfile(cur).label}」は、IDE からの自動公開にまだ対応していません。自動公開できるのは下の2つです（選ぶと公開先もそれに変わります）。
                </p>
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
              <p className="text-xs text-ink-muted mt-0.5">HTML/PHPサイト向け。契約済みのサーバへ rsync でアップロードします。</p>
            </button>
            <button
              onClick={() => setTarget('sakura-apprun')}
              className="w-full text-left rounded-xl border border-line hover:border-sakura bg-surface p-4 transition-colors"
            >
              <p className="text-sm font-semibold text-ink">📦 さくらのAppRun</p>
              <p className="text-xs text-ink-muted mt-0.5">アプリをコンテナで公開。Docker不要・IDEが自動でビルド／レジストリ作成／公開URL発行まで行います。</p>
            </button>

            <div className="pt-2 mt-1 border-t border-line-soft space-y-3">
              <p className="text-[11px] font-semibold text-ink-muted pt-1">さくら以外の公開先</p>
              <button
                onClick={() => setTarget('hanamii')}
                className="w-full text-left rounded-xl border border-line hover:border-sakura bg-surface p-4 transition-colors"
              >
                <p className="text-sm font-semibold text-ink">🌸 HANAMII（国産PaaS）</p>
                <p className="text-xs text-ink-muted mt-0.5">さくら基盤上の国産PaaS。ZIPアップロードで数十秒で公開・データ100%国内。Node常駐サーバも動かせます。</p>
              </button>
              <button
                onClick={() => setTarget('vercel')}
                className="w-full text-left rounded-xl border border-line hover:border-sakura bg-surface p-4 transition-colors"
              >
                <p className="text-sm font-semibold text-ink">▲ Vercel（海外PaaS）</p>
                <p className="text-xs text-ink-muted mt-0.5">静的サイト／フロントエンド向けの海外PaaS。IDEがファイルをアップロードして数十秒で公開します。データは国外に置かれます。</p>
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
                静的HTML/PHP + MySQLが動く共有ホスティング。契約済みのサーバへ rsync でアップロードします。
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
            <HanamiiPanel projectDir={projectDir} onOpenCredentials={onOpenCredentials} />
          </div>
        ) : target === 'vercel' ? (
          // ── Vercel（自己完結フロー） ──
          <div className="space-y-3">
            <button onClick={() => setTarget(null)} className="text-xs text-ink-muted hover:text-ink">← 公開先を変更</button>
            <VercelPanel projectDir={projectDir} onOpenCredentials={onOpenCredentials} />
          </div>
        ) : target === 'sakura-vps' ? (
          // ── さくらのVPS（V1a・①接続のみ。自己完結フロー） ──
          <div className="space-y-3">
            <button onClick={() => setTarget(null)} className="text-xs text-ink-muted hover:text-ink">← 公開先を変更</button>
            <VpsPanel projectDir={projectDir} onOpenCredentials={onOpenCredentials} />
          </div>
        ) : (
          // ── さくらのAppRun（自己完結フロー） ──
          <div className="space-y-3">
            <button onClick={() => setTarget(null)} className="text-xs text-ink-muted hover:text-ink">← 公開先を変更</button>
            <AppRunPanel projectDir={projectDir} onOpenCredentials={onOpenCredentials} />
          </div>
        )}
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
        キーを失くしたり作り直したりして Koto から操作できなくなっても、
        <span className="text-ink-secondary">管理画面</span>から辿れます。
        <span className="text-ink-secondary">記録を片づける</span>のは、この一覧から消すだけです
        （<b className="text-ink">公開したもの自体は消えません</b>。先に「破棄」してください）。
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
                      >この一覧から消す（公開したものは残ります）</button>
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
