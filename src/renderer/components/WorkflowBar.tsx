import { useEffect, useRef, useState } from 'react'
import { planRun } from '../runPlan'
import { PUBLISH_DIR } from '../../shared/publishRoot'
import { TARGET_PROFILES, getTargetProfile, isAvailableTarget, TargetId } from '../targetProfiles'
import { resolvePublishRoot } from '../publishRootRenderer'

export interface ProjectMeta {
  name?: string
  description?: string
  target?: string
  publish?: {
    account?: string
    host?: string
    registry?: string
    appName?: string
    url?: string
    lastPublishedAt?: string // ISO string
  }
}

interface Props {
  projectDir: string
  /** プロジェクトの形が変わった合図（移行など）。上がったら根を取り直す。 */
  refreshKey?: number
  meta: ProjectMeta | null
  onFocusChat: () => void        // focus the AI chat input
  onRunCmd: (cmd: string) => void // run a shell command in the IDE's terminal panel
  onStopCmd: () => void          // send Ctrl+C to stop the running server
  onOpenPublish: () => void      // open the publish modal
  onChangeTarget: (target: string) => void // change the publish target (公開先)
  onOpenServer: () => void       // open the server files (SSH) modal
}

// ISO 文字列を `M/D HH:mm 公開` 形式に整形する。失敗時は null を返す。
function formatPublishedAt(iso?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const m = d.getMonth() + 1
  const day = d.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${m}/${day} ${hh}:${mm} 公開`
}

export default function WorkflowBar({ projectDir, refreshKey = 0, meta, onFocusChat, onRunCmd, onStopCmd, onOpenPublish, onChangeTarget, onOpenServer }: Props) {
  // 公開先変更のドロップダウン開閉
  const [showTargetMenu, setShowTargetMenu] = useState(false)
  // ② 試す の検出中フラグ（ボタン無効化に使用）
  const [running, setRunning] = useState(false)
  // ②試すで起動したサーバーが実行中かどうか（停止ボタンの表示に使用）
  const [serverRunning, setServerRunning] = useState(false)
  // 実行方法が見つからなかった時のインラインヒント表示フラグ
  const [showHint, setShowHint] = useState(false)
  // ②疎通確認がタイムアウトした時のインラインヒント表示フラグ（showHint と同じ8秒自動消去の作法・別枠）
  const [showPortHint, setShowPortHint] = useState(false)
  // 実行に必要なランタイムが見つからない時の導入パネル（runtime と Homebrew の有無）
  const [missingRuntime, setMissingRuntime] = useState<{ runtime: 'php' | 'node' | 'python3'; hasBrew: boolean } | null>(null)
  // ヒント自動消去用タイマー
  const hintTimer = useRef<number | null>(null)
  // 疎通確認タイムアウトヒント自動消去用タイマー
  const portHintTimer = useRef<number | null>(null)
  // バー全体の参照（外側クリック判定用）
  const containerRef = useRef<HTMLDivElement | null>(null)
  // ②疎通確認のポーリングを打ち切るフラグ（プロジェクト切替・アンマウントで真にする。下の effect 参照）
  const pollCancelledRef = useRef(false)

  // ヒントを表示し、8秒後に自動で消すタイマーをセット
  function openHint() {
    setShowHint(true)
    if (hintTimer.current !== null) {
      window.clearTimeout(hintTimer.current)
    }
    hintTimer.current = window.setTimeout(() => {
      setShowHint(false)
      hintTimer.current = null
    }, 8000)
  }

  function closeHint() {
    setShowHint(false)
    if (hintTimer.current !== null) {
      window.clearTimeout(hintTimer.current)
      hintTimer.current = null
    }
  }

  // ②疎通確認タイムアウト用ヒント。openHint/closeHint と同じ作法（8秒で自動消去）
  function openPortHint() {
    setShowPortHint(true)
    if (portHintTimer.current !== null) {
      window.clearTimeout(portHintTimer.current)
    }
    portHintTimer.current = window.setTimeout(() => {
      setShowPortHint(false)
      portHintTimer.current = null
    }, 8000)
  }

  function closePortHint() {
    setShowPortHint(false)
    if (portHintTimer.current !== null) {
      window.clearTimeout(portHintTimer.current)
      portHintTimer.current = null
    }
  }

  // ヒント・ランタイム導入パネル表示中に外側をクリックしたら閉じる
  useEffect(() => {
    if (!showHint && !missingRuntime && !showPortHint) return
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && e.target instanceof Node && !containerRef.current.contains(e.target)) {
        closeHint()
        closePortHint()
        setMissingRuntime(null)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [showHint, missingRuntime, showPortHint])

  // プロジェクトが切り替わったらサーバー実行中フラグをリセット
  useEffect(() => { setServerRunning(false) }, [projectDir])

  // ②疎通確認のポーリング中断フラグ。プロジェクトが切り替わる・アンマウントされる直前の
  // クリーンアップで真にし、進行中のポーリングを止める（root effect と同じ cancelled の作法）。
  useEffect(() => {
    pollCancelledRef.current = false
    return () => { pollCancelledRef.current = true }
  }, [projectDir])

  // 「② 試す」で動かすのは**実際に公開されるもの**（`public/`。無ければ直下）。
  // ここがずれると「試すと動くのに、公開すると別の中身」になる（2026-08-20）。
  const [root, setRoot] = useState<string>(projectDir)
  useEffect(() => {
    let cancelled = false
    if (!projectDir) { setRoot(''); return }
    void resolvePublishRoot(projectDir).then(r => { if (!cancelled) setRoot(r || projectDir) })
    return () => { cancelled = true }
  }, [projectDir, refreshKey])

  // アンマウント時にタイマーを掃除
  useEffect(() => {
    return () => {
      if (hintTimer.current !== null) {
        window.clearTimeout(hintTimer.current)
      }
      if (portHintTimer.current !== null) {
        window.clearTimeout(portHintTimer.current)
      }
    }
  }, [])

  // ②疎通確認: ポートが開通するまで500ms間隔・最大40回（20秒。npm install の時間を見込む）ポーリングし、
  // 開通したらブラウザを開く。開通しないまま終わればインラインで案内する
  // （2026-09-01 実機・helmet 欠けでサーバーが即クラッシュし、旧実装の固定1.5秒待ちでは
  // 「接続が拒否されました」だけが見えていた）。
  // serverRunning は戻さない——タイムアウトしても npm install 自体は進行中かもしれないため、
  // ⏹停止ボタンは出したままにする。
  async function waitForPortThenOpen(openUrl: string) {
    const port = Number(new URL(openUrl).port)
    const api = window.electronAPI
    for (let i = 0; i < 40; i++) {
      if (pollCancelledRef.current) return // プロジェクト切替・アンマウントで打ち切り
      if (await api.shell.portOpen(port)) {
        window.open(openUrl)
        return
      }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!pollCancelledRef.current) openPortHint()
  }

  // 実行に必要なランタイムが無ければ導入パネルを出し、あれば cmd を実行する。
  async function ensureRuntimeThenRun(runtime: 'php' | 'node' | 'python3', cmd: string, openUrl?: string) {
    const api = window.electronAPI
    const found = await api.shell.which(runtime)
    if (!found) {
      // ランタイムが無い → コマンドは実行せず、導入パネルを表示
      const brew = await api.shell.which('brew')
      setMissingRuntime({ runtime, hasBrew: !!brew })
      return
    }
    // 既に前回のサーバーが動いていれば先に停止（ポート使用中エラー回避）
    if (serverRunning) { onStopCmd(); await new Promise(r => setTimeout(r, 500)) }
    onRunCmd(cmd)
    setServerRunning(true)
    if (openUrl) {
      void waitForPortThenOpen(openUrl)
    }
  }

  // ② 試す: ファイルの実体から実行方法を決める。判定の本体は runPlan.ts の planRun（純粋・テスト対象）。
  //
  // ── 2026-09-01（Ryosuke の調査依頼）: 判定順を「サーバー優先」へ反転した ─────────
  // 従来はここに静的優先（index.html → … → server.js）の判定が埋め込まれており、
  // server.js＋index.html を持つ Node アプリ（AppRun 向け kickoff の標準形）で
  // サーバーを起動せず file:// で index.html を開いてしまっていた。理由と新しい順序は
  // runPlan.ts の冒頭コメントを参照。コマンドの文字列・ensureRuntimeThenRun の呼び方は
  // 従来と同一（順序と package.json の scripts.start 条件だけが変わった）。
  //
  // ── 2026-09-01（同日・実機の追加調査）: needsInstall で npm install を前置 ──────
  // 実機の ScheduleAPP（server.js・package.json に express+helmet）で試したところ、
  // node_modules に helmet が欠けており node server.js が即クラッシュしていた。
  // needsInstall のときは `npm install &&` を前置してから起動する（判定は runPlan.ts）。
  async function handleRun() {
    if (running) return
    setRunning(true)
    closeHint()
    closePortHint()
    setMissingRuntime(null)
    try {
      const api = window.electronAPI
      const join = (p: string) => `${root}/${p}`
      const plan = await planRun({
        exists: (rel) => api.fs.exists(join(rel)),
        readFile: (rel) => api.fs.readFile(join(rel)),
      })
      switch (plan.kind) {
        case 'node-server': {
          const cmd = plan.needsInstall
            ? `cd "${root}" && npm install && node server.js`
            : `cd "${root}" && node server.js`
          // 開く先は疎通確認と同じ 127.0.0.1（2026-09-01 実機: サーバーが IPv4（0.0.0.0）のみで
          // 待ち受けていると、ブラウザの localhost は ::1（IPv6）を先に試して「接続が拒否されました」に
          // なることがある。確認した先と開く先を一致させる）
          await ensureRuntimeThenRun('node', cmd, 'http://127.0.0.1:8080')
          return
        }
        case 'python':
          // ポートは様々なのでブラウザは自動で開かない
          await ensureRuntimeThenRun('python3', `cd "${root}" && python3 ${plan.entry}`)
          return
        case 'npm-start': {
          const cmd = plan.needsInstall
            ? `cd "${root}" && npm install && npm start`
            : `cd "${root}" && npm start`
          await ensureRuntimeThenRun('node', cmd)
          return
        }
        case 'php':
          await ensureRuntimeThenRun('php',
            // バインドも開く先も 127.0.0.1 に固定（localhost は解決結果依存で IPv6 とずれうる・上の node と同じ理由）
            plan.docroot === 'publish' ? `cd "${root}" && php -S 127.0.0.1:8000 -t ${PUBLISH_DIR}` : `cd "${root}" && php -S 127.0.0.1:8000`,
            'http://127.0.0.1:8000')
          return
        case 'open':
          await api.shell.openPath(join(plan.rel))
          return
        case 'none':
          openHint()
      }
    } finally {
      setRunning(false)
    }
  }

  // 公開先メニュー表示中に外側をクリックしたら閉じる
  useEffect(() => {
    if (!showTargetMenu) return
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && e.target instanceof Node && !containerRef.current.contains(e.target)) {
        setShowTargetMenu(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [showTargetMenu])

  const targetLabel = getTargetProfile(meta?.target).label

  const publishedAt = meta?.publish?.lastPublishedAt
  const publishedLabel = formatPublishedAt(publishedAt)
  const isPublished = !!publishedLabel || !!publishedAt
  const publishUrl = meta?.publish?.url
  const hasHttpUrl = typeof publishUrl === 'string' && publishUrl.startsWith('http')

  // 「🗄 サーバ」ボタンの表示条件：レンサバ公開先で、host/account が揃っているとき
  const canUseServer = meta?.target === 'sakura-rental' && !!meta?.publish?.host && !!meta?.publish?.account

  // ランタイム導入パネル用のラベル・Homebrew パッケージ名・公式サイト URL
  const runtimeLabel: Record<'php' | 'node' | 'python3', string> = { php: 'PHP', node: 'Node.js', python3: 'Python' }
  const runtimeBrewPkg: Record<'php' | 'node' | 'python3', string> = { php: 'php', node: 'node', python3: 'python' }
  const runtimeDownloadUrl: Record<'php' | 'node' | 'python3', string> = {
    node: 'https://nodejs.org/ja/download',
    python3: 'https://www.python.org/downloads/',
    php: 'https://brew.sh',
  }

  return (
    // containerRef はメニュー/ヒントを含む全体に張る（外側クリック判定のため。公開先メニューはこの直下に置く）
    <div ref={containerRef} className="relative flex-none">
      <div
        className="flex items-center gap-1 px-3 h-10 bg-surface border-b border-line flex-none overflow-x-auto"
      >
        {/* ① 作る */}
        <button
          type="button"
          onClick={onFocusChat}
          className="rounded-lg px-3 py-1 flex items-center gap-2 hover:bg-overlay transition-colors flex-none"
        >
          <span className="sakura-gradient text-white text-[10px] font-semibold rounded-md w-4 h-4 flex items-center justify-center flex-none">
            1
          </span>
          <span className="flex flex-col items-start leading-tight">
            <span className="text-xs font-semibold text-ink">① 作る</span>
            <span className="text-[10px] text-ink-muted">AIに依頼</span>
          </span>
        </button>

        <span className="text-ink-muted text-xs flex-none">→</span>

        {/* ② 試す */}
        <button
          type="button"
          onClick={handleRun}
          disabled={running}
          className="rounded-lg px-3 py-1 flex items-center gap-2 hover:bg-overlay transition-colors flex-none disabled:opacity-50"
        >
          <span className="sakura-gradient text-white text-[10px] font-semibold rounded-md w-4 h-4 flex items-center justify-center flex-none">
            2
          </span>
          <span className="flex flex-col items-start leading-tight">
            <span className="text-xs font-semibold text-ink">② 試す</span>
            <span className="text-[10px] text-ink-muted">{running ? '確認中…' : '実行して確認'}</span>
          </span>
        </button>

        {/* ②試すで起動したサーバーの停止ボタン（実行中のみ表示） */}
        {serverRunning && (
          <button
            type="button"
            onClick={() => { onStopCmd(); setServerRunning(false) }}
            className="rounded-lg px-2 py-1 flex items-center gap-1 hover:bg-overlay transition-colors flex-none text-[11px] text-ink-secondary border border-line"
            title="②試すで起動したサーバーを停止します（ターミナルに Ctrl+C を送信）"
          >⏹ サーバー停止</button>
        )}

        <span className="text-ink-muted text-xs flex-none">→</span>

        {/* ③ 公開 */}
        <button
          type="button"
          onClick={onOpenPublish}
          className="rounded-lg px-3 py-1 flex items-center gap-2 hover:bg-overlay transition-colors flex-none"
        >
          <span className="sakura-gradient text-white text-[10px] font-semibold rounded-md w-4 h-4 flex items-center justify-center flex-none">
            3
          </span>
          <span className="flex flex-col items-start leading-tight">
            <span className="text-xs font-semibold text-ink">③ 公開</span>
            <span className={`text-[10px] ${isPublished ? 'text-brand-green' : 'text-ink-muted'}`}>
              {isPublished ? '✅ 公開済み' : 'さくらで公開'}
            </span>
          </span>
        </button>

        {/* 公開済みの場合は公開日時と外部リンクを表示 */}
        {isPublished && publishedLabel && (
          <span className="text-[10px] text-ink-muted flex-none whitespace-nowrap">{publishedLabel}</span>
        )}
        {isPublished && hasHttpUrl && (
          <a
            href={publishUrl}
            className="text-[10px] text-sakura hover:text-sakura-soft flex-none whitespace-nowrap"
          >
            🌐 開く
          </a>
        )}

        {/* 🗄 サーバ：さくらのレンタルサーバを SSH 経由で操作（レンサバ＋接続情報が揃っている時のみ） */}
        {canUseServer && (
          <button
            type="button"
            onClick={onOpenServer}
            className="rounded-lg px-2 py-1 flex items-center gap-1 hover:bg-overlay transition-colors flex-none text-[11px] text-ink-secondary border border-line"
            title="さくらのレンタルサーバのファイルを取得・編集・アップロードします"
          >🗄 サーバ</button>
        )}

        {/* 公開先の変更（現在の公開先を表示し、クリックで選び直せる） */}
        <div className="relative flex-none ml-auto">
          <button
            type="button"
            onClick={() => setShowTargetMenu(v => !v)}
            className="flex flex-col items-end leading-tight px-2 py-1 rounded-lg hover:bg-overlay transition-colors"
            title="公開先（この環境向けにAIが構成を合わせます）を変更します"
          >
            <span className="text-[10px] text-ink-muted">公開先 ▾</span>
            <span className="text-[10px] text-ink-secondary whitespace-nowrap">{targetLabel}</span>
          </button>
        </div>
      </div>

      {/* 公開先メニュー本体。ツールバー（overflow-x-auto）の中に置くと縦方向のはみ出しも
          刈り取られて見えなくなるため、ヒントと同様にラッパー直下からバーの右下へ表示する */}
      {showTargetMenu && (
        <div className="absolute right-3 top-full mt-1 z-20 bg-elevated border border-line-soft rounded-lg py-1 shadow-lg min-w-[16rem]">
          {(Object.keys(TARGET_PROFILES) as TargetId[]).filter(id => isAvailableTarget(id)).map(id => {
            const selected = (meta?.target ?? 'local') === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => { setShowTargetMenu(false); onChangeTarget(id) }}
                className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-overlay transition-colors ${selected ? 'text-sakura font-semibold' : 'text-ink-secondary'}`}
              >
                {selected ? '✓ ' : ''}{TARGET_PROFILES[id].label}
                <span className="text-[10px] text-ink-muted ml-1">
                  {TARGET_PROFILES[id].autoPublish ? '（自動公開対応）' : '（AIの最適化のみ）'}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* 実行方法が見つからなかった時のインラインヒント（window.alert は使わない） */}
      {showHint && (
        <div className="absolute left-3 top-full mt-1 z-10 bg-elevated border border-line-soft rounded-lg px-3 py-2 shadow-lg max-w-md">
          <p className="text-xs text-ink-secondary leading-snug">
            実行方法が見つかりませんでした。AIチャットで『このアプリの実行方法を教えて』と聞いてみてください
          </p>
          <button
            type="button"
            onClick={() => {
              closeHint()
              onFocusChat()
            }}
            className="mt-2 rounded-md px-2 py-1 text-xs font-semibold sakura-gradient text-white hover:opacity-90 transition-colors"
          >
            AIに聞く
          </button>
        </div>
      )}

      {/* ②疎通確認がタイムアウトした時のインラインヒント（window.alert は使わない・8秒で自動消去） */}
      {showPortHint && (
        <div className="absolute left-3 top-full mt-1 z-10 bg-elevated border border-line-soft rounded-lg px-3 py-2 shadow-lg max-w-md">
          <p className="text-xs text-ink-secondary leading-snug">
            サーバーの起動を確認できませんでした。下のターミナルにエラーが出ていないか確認してください
          </p>
          <button
            type="button"
            onClick={closePortHint}
            className="mt-2 text-[10px] text-ink-muted hover:text-ink-secondary whitespace-nowrap"
          >
            閉じる
          </button>
        </div>
      )}

      {/* 実行に必要なランタイムが見つからない時の導入パネル */}
      {missingRuntime && (
        <div className="absolute left-3 top-full mt-1 z-10 bg-elevated border border-line-soft rounded-lg px-3 py-2 shadow-lg max-w-md">
          <p className="text-xs text-ink-secondary leading-snug">
            このアプリを試すには {runtimeLabel[missingRuntime.runtime]} が必要です。
          </p>
          {missingRuntime.hasBrew ? (
            <>
              <button
                type="button"
                onClick={() => {
                  // 実行前に確認を挟む（所見16。プロジェクト削除等と同様、インストール系は確認を対称にする）。
                  if (!window.confirm('必要なツールをインストールします。よろしいですか？')) return
                  onRunCmd('brew install ' + runtimeBrewPkg[missingRuntime.runtime])
                  setMissingRuntime(null)
                }}
                className="mt-2 rounded-md px-2 py-1 text-xs font-semibold sakura-gradient text-white hover:opacity-90 transition-colors"
              >
                Homebrew で {runtimeLabel[missingRuntime.runtime]} をインストール
              </button>
              <p className="mt-2 text-[10px] text-ink-muted leading-snug">
                インストールが終わったら、もう一度「② 試す」を押してください。
              </p>
            </>
          ) : (
            <>
              <p className="mt-2 text-[10px] text-ink-muted leading-snug">
                先に Homebrew（macOS のソフト導入ツール）が必要です。
              </p>
              <button
                type="button"
                onClick={() => {
                  // 取得スクリプト（curl）の実行前に確認を挟む（所見16。開発ツールをMacへ導入する旨を明示）。
                  if (!window.confirm('お使いのMacに開発ツール（Homebrew）をインストールします。よろしいですか？')) return
                  onRunCmd('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"')
                  setMissingRuntime(null)
                }}
                className="mt-2 rounded-md px-2 py-1 text-xs font-semibold sakura-gradient text-white hover:opacity-90 transition-colors"
              >
                Homebrew をインストール
              </button>
              <p className="mt-2 text-[10px] text-ink-muted leading-snug">
                ※ パスワードの入力を求められる場合があります。導入後はターミナルを開き直す（またはIDEを再起動）と確実です。その後もう一度「② 試す」を押してください。
              </p>
            </>
          )}
          <div className="mt-2 flex items-center gap-3">
            <a
              href={runtimeDownloadUrl[missingRuntime.runtime]}
              className="text-[10px] text-sakura hover:text-sakura-soft whitespace-nowrap"
            >
              または公式サイトからインストール
            </a>
            <button
              type="button"
              onClick={() => setMissingRuntime(null)}
              className="text-[10px] text-ink-muted hover:text-ink-secondary whitespace-nowrap"
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
