import { useEffect, useRef, useState } from 'react'
import { TARGET_PROFILES, getTargetProfile, isAvailableTarget, TargetId } from '../targetProfiles'

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

export default function WorkflowBar({ projectDir, meta, onFocusChat, onRunCmd, onStopCmd, onOpenPublish, onChangeTarget, onOpenServer }: Props) {
  // 公開先変更のドロップダウン開閉
  const [showTargetMenu, setShowTargetMenu] = useState(false)
  // ② 試す の検出中フラグ（ボタン無効化に使用）
  const [running, setRunning] = useState(false)
  // ②試すで起動したサーバーが実行中かどうか（停止ボタンの表示に使用）
  const [serverRunning, setServerRunning] = useState(false)
  // 実行方法が見つからなかった時のインラインヒント表示フラグ
  const [showHint, setShowHint] = useState(false)
  // 実行に必要なランタイムが見つからない時の導入パネル（runtime と Homebrew の有無）
  const [missingRuntime, setMissingRuntime] = useState<{ runtime: 'php' | 'node' | 'python3'; hasBrew: boolean } | null>(null)
  // ヒント自動消去用タイマー
  const hintTimer = useRef<number | null>(null)
  // バー全体の参照（外側クリック判定用）
  const containerRef = useRef<HTMLDivElement | null>(null)

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

  // ヒント・ランタイム導入パネル表示中に外側をクリックしたら閉じる
  useEffect(() => {
    if (!showHint && !missingRuntime) return
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && e.target instanceof Node && !containerRef.current.contains(e.target)) {
        closeHint()
        setMissingRuntime(null)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [showHint, missingRuntime])

  // プロジェクトが切り替わったらサーバー実行中フラグをリセット
  useEffect(() => { setServerRunning(false) }, [projectDir])

  // アンマウント時にタイマーを掃除
  useEffect(() => {
    return () => {
      if (hintTimer.current !== null) {
        window.clearTimeout(hintTimer.current)
      }
    }
  }, [])

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
      window.setTimeout(() => window.open(openUrl), 1500)
    }
  }

  // ② 試す: 優先順位順にファイルの存在を確認し、適切な実行方法を選ぶ
  async function handleRun() {
    if (running) return
    setRunning(true)
    closeHint()
    setMissingRuntime(null)
    try {
      const api = window.electronAPI
      const join = (p: string) => `${projectDir}/${p}`

      // 1. index.html → ブラウザで開く
      if (await api.fs.exists(join('index.html'))) {
        await api.shell.openPath(join('index.html'))
        return
      }
      // 2. public/index.html → ブラウザで開く
      if (await api.fs.exists(join('public/index.html'))) {
        await api.shell.openPath(join('public/index.html'))
        return
      }
      // 3. public/index.php → PHP ビルトインサーバ (public 配下)
      if (await api.fs.exists(join('public/index.php'))) {
        await ensureRuntimeThenRun('php', `cd "${projectDir}" && php -S localhost:8000 -t public`, 'http://localhost:8000')
        return
      }
      // 4. index.php → PHP ビルトインサーバ (ルート)
      if (await api.fs.exists(join('index.php'))) {
        await ensureRuntimeThenRun('php', `cd "${projectDir}" && php -S localhost:8000`, 'http://localhost:8000')
        return
      }
      // 5. server.js → node 実行
      if (await api.fs.exists(join('server.js'))) {
        await ensureRuntimeThenRun('node', `cd "${projectDir}" && node server.js`, 'http://localhost:8080')
        return
      }
      // 6. main.py / app.py → python3 実行（ポートは様々なのでブラウザは自動で開かない）
      if (await api.fs.exists(join('main.py'))) {
        await ensureRuntimeThenRun('python3', `cd "${projectDir}" && python3 main.py`)
        return
      }
      if (await api.fs.exists(join('app.py'))) {
        await ensureRuntimeThenRun('python3', `cd "${projectDir}" && python3 app.py`)
        return
      }
      // 7. package.json → npm start
      if (await api.fs.exists(join('package.json'))) {
        await ensureRuntimeThenRun('node', `cd "${projectDir}" && npm start`)
        return
      }
      // 8. 何も該当しない → インラインヒントを表示
      openHint()
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
