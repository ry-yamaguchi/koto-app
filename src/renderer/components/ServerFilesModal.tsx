import React, { useState, useEffect, useCallback } from 'react'
import { ProjectMeta } from './WorkflowBar'

// 「🗄 サーバ」モーダル：さくらのレンタルサーバを SSH 経由で手動操作する（フェーズA＝MVP）。
// - 接続テスト（remote:test）
// - リモート一覧（remote:list、読み取り専用。ディレクトリ移動・パンくず・親へ）
// - 「取得して編集」：remote:download で プロジェクト内 .server-edit/<相対パス> に保存して開く
// - 「サーバへアップロード」：.server-edit/ 配下の取得済みファイルを選び remote:upload（上書き前に自動バックアップ）
// 認証情報は保管しない（ユーザーのSSH鍵/ssh-agent に委ねる）。読み取りは確認不要、書き込みは常に確認。

interface Props {
  open: boolean
  onClose: () => void
  projectDir: string
  meta: ProjectMeta | null
}

interface RemoteEntry {
  name: string
  isDir: boolean
}

// 取得済みファイル（.server-edit/ 配下）と、その元のリモートパス
interface EditedFile {
  rel: string        // .server-edit/ からの相対パス（= リモートからの相対パス）
  localPath: string  // プロジェクト内の絶対パス
}

const SERVER_EDIT_DIR = '.server-edit'

// 末尾スラッシュを正規化してパスを連結する（リモートパス用）
function joinRemote(base: string, name: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base
  return `${b}/${name}`
}

// リモートの絶対パスを、www（公開ディレクトリ）基準の相対パスに変換する。
// 例: /home/acc/www/foo/bar.html → foo/bar.html。www の外なら home 基準にフォールバック。
function remoteRelForLocal(remotePath: string, account: string): string {
  const wwwRoot = `/home/${account}/www/`
  const homeRoot = `/home/${account}/`
  let rel = remotePath
  if (remotePath.startsWith(wwwRoot)) rel = remotePath.slice(wwwRoot.length)
  else if (remotePath.startsWith(homeRoot)) rel = remotePath.slice(homeRoot.length)
  else if (remotePath.startsWith('~/')) rel = remotePath.slice(2)
  else rel = remotePath.replace(/^\/+/, '')
  return rel.replace(/^\/+/, '')
}

export default function ServerFilesModal({ open, onClose, projectDir, meta }: Props) {
  const host = meta?.publish?.host ?? ''
  const account = meta?.publish?.account ?? ''
  const configured = !!host && !!account
  const wwwRoot = account ? `/home/${account}/www` : ''

  // 接続状態: 未テスト / 確認中 / OK / NG
  const [conn, setConn] = useState<'idle' | 'testing' | 'ok' | 'ng'>('idle')
  const [connMsg, setConnMsg] = useState('')

  // リモート一覧
  const [cwd, setCwd] = useState('') // 現在表示中のリモートパス
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [listing, setListing] = useState(false)
  const [listError, setListError] = useState('')

  // 取得済みファイル一覧（アップロード対象）
  const [edited, setEdited] = useState<EditedFile[]>([])

  // アップロード確認ダイアログの対象
  const [pendingUpload, setPendingUpload] = useState<EditedFile | null>(null)
  const [uploading, setUploading] = useState(false)
  // 操作結果メッセージ（成功/失敗）
  const [notice, setNotice] = useState('')

  // モーダルを開いたら状態を初期化し、www を一覧する
  useEffect(() => {
    if (!open) return
    setConn('idle'); setConnMsg('')
    setNotice('')
    setPendingUpload(null)
    setCwd(wwwRoot)
    if (configured) {
      loadList(wwwRoot)
      refreshEdited()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 取得済みファイル（.server-edit/ 配下）を走査して一覧化する
  const refreshEdited = useCallback(async () => {
    if (!projectDir) { setEdited([]); return }
    const root = `${projectDir}/${SERVER_EDIT_DIR}`
    try {
      if (!(await window.electronAPI.fs.exists(root))) { setEdited([]); return }
      const out: EditedFile[] = []
      const walk = async (dir: string, rel: string) => {
        const items = await window.electronAPI.fs.readDir(dir)
        for (const it of items) {
          const childRel = rel ? `${rel}/${it.name}` : it.name
          if (it.isDir) await walk(it.path, childRel)
          else out.push({ rel: childRel, localPath: it.path })
        }
      }
      await walk(root, '')
      out.sort((a, b) => a.rel.localeCompare(b.rel))
      setEdited(out)
    } catch { setEdited([]) }
  }, [projectDir])

  // 接続テスト
  const testConn = useCallback(async () => {
    if (!configured) return
    setConn('testing'); setConnMsg('')
    const r = await window.electronAPI.remote.test(host, account)
    if (r.ok) { setConn('ok'); setConnMsg('') }
    else { setConn('ng'); setConnMsg(r.message ?? 'SSHで接続できませんでした。') }
  }, [configured, host, account])

  // リモート一覧の取得
  const loadList = useCallback(async (path: string) => {
    if (!configured) return
    setListing(true); setListError('')
    const r = await window.electronAPI.remote.list(host, account, path)
    setListing(false)
    if (r.ok && r.entries) {
      setEntries(r.entries)
      if (r.path) setCwd(r.path)
    } else {
      setEntries([])
      setListError(r.message ?? '一覧を取得できませんでした。')
    }
  }, [configured, host, account])

  // ディレクトリへ移動
  const enterDir = (name: string) => { loadList(joinRemote(cwd, name)) }

  // 親ディレクトリへ（www より上には行かせない＝ホーム配下にとどめる）
  const goParent = () => {
    const trimmed = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
    const idx = trimmed.lastIndexOf('/')
    if (idx <= 0) return
    const parent = trimmed.slice(0, idx)
    // /home/<account> より上には移動しない
    if (parent.length < `/home/${account}`.length) return
    loadList(parent)
  }

  // 取得して編集：remote:download → .server-edit/<相対> に保存 → エディタで開く
  const fetchAndEdit = async (name: string) => {
    setNotice('')
    const remotePath = joinRemote(cwd, name)
    const rel = remoteRelForLocal(remotePath, account)
    const localPath = `${projectDir}/${SERVER_EDIT_DIR}/${rel}`
    const r = await window.electronAPI.remote.download(host, account, remotePath, localPath)
    if (r.ok && r.localPath) {
      await refreshEdited()
      // 既存のファイルオープン導線（App側のリスナ）で開く
      window.dispatchEvent(new CustomEvent('sakura:open-file', { detail: r.localPath }))
      setNotice(`「${name}」を取得して開きました（${SERVER_EDIT_DIR}/${rel}）。`)
    } else {
      setNotice(`取得に失敗しました: ${r.message ?? ''}`)
    }
  }

  // アップロード確認 → 実行。リモートパスは取得時の相対パスから www 基準で復元する。
  const remotePathForEdited = (f: EditedFile) => joinRemote(wwwRoot, f.rel)

  const confirmUpload = (f: EditedFile) => { setNotice(''); setPendingUpload(f) }

  const doUpload = async () => {
    if (!pendingUpload) return
    const f = pendingUpload
    setUploading(true)
    const remotePath = remotePathForEdited(f)
    const r = await window.electronAPI.remote.upload(host, account, remotePath, f.localPath)
    setUploading(false)
    setPendingUpload(null)
    if (r.ok) {
      setNotice(r.backedUp
        ? `アップロードしました（バックアップ済み）: ${remotePath}`
        : `アップロードしました（既存ファイルが無かったためバックアップは作成していません）: ${remotePath}`)
    } else {
      setNotice(`アップロードに失敗しました: ${r.message ?? ''}`)
    }
  }

  if (!open) return null

  // パンくず用のセグメント（/home/<account> 以降を表示）
  const crumbBase = `/home/${account}`
  const crumbTail = cwd.startsWith(crumbBase) ? cwd.slice(crumbBase.length).replace(/^\//, '') : cwd

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[620px] max-h-[82vh] overflow-y-auto bg-elevated rounded-2xl border border-line shadow-xl p-6 fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-ink">🗄 サーバのファイル</h2>
          <button onClick={onClose} className="text-ink-muted hover:text-ink text-lg leading-none">×</button>
        </div>
        <p className="text-xs text-ink-muted mb-4 truncate">{configured ? `${account}@${host}` : 'さくらのレンタルサーバ'}</p>

        {!configured ? (
          // ── 公開先が未設定 ──
          <div className="rounded-xl border border-brand-yellow/70 bg-surface p-4">
            <p className="text-sm text-ink leading-relaxed">
              まず公開先（さくらのレンタルサーバ）を設定してください。「③ 公開」からアカウント名・ホスト名を登録すると、ここからサーバのファイルを操作できます。
            </p>
          </div>
        ) : pendingUpload ? (
          // ── アップロード確認ダイアログ（書き込みは常に確認） ──
          <div className="space-y-3">
            <div className="rounded-xl border border-brand-yellow/70 bg-surface p-4 space-y-2">
              <p className="text-sm font-semibold text-ink">⚠️ サーバへアップロードします</p>
              <p className="text-sm text-ink-secondary leading-relaxed">
                サーバ <span className="font-mono text-ink">{host}</span> の{' '}
                <span className="font-mono text-ink break-all">{remotePathForEdited(pendingUpload)}</span>{' '}
                を上書きします。上書き前に自動バックアップ（
                <span className="font-mono text-ink break-all">{remotePathForEdited(pendingUpload)}.bak-…</span>
                ）を作成します。
              </p>
            </div>
            <div className="flex justify-between items-center">
              <button
                onClick={() => setPendingUpload(null)}
                disabled={uploading}
                className="bg-overlay text-ink border border-line rounded-lg px-4 py-2 text-sm font-medium hover:border-sakura disabled:opacity-40"
              >やめる</button>
              <button
                onClick={doUpload}
                disabled={uploading}
                className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
              >{uploading ? 'アップロード中…' : 'アップロードする'}</button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* 接続状態＋接続テスト */}
            <div className="rounded-xl border border-line bg-surface p-3 flex items-center gap-3">
              <span className="flex-1 text-sm">
                {conn === 'ok' && <span className="text-brand-green font-semibold">✅ 接続できました</span>}
                {conn === 'ng' && <span className="text-brand-red font-semibold">⚠️ 接続できませんでした</span>}
                {conn === 'testing' && <span className="text-ink-secondary">接続を確認中…</span>}
                {conn === 'idle' && <span className="text-ink-muted">接続状態は未確認です</span>}
              </span>
              <button
                onClick={testConn}
                disabled={conn === 'testing'}
                className="flex-none bg-overlay text-ink border border-line rounded-lg px-3 py-1.5 text-xs font-medium hover:border-sakura disabled:opacity-40"
              >🔌 接続テスト</button>
            </div>
            {conn === 'ng' && connMsg && (
              <p className="text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2 leading-relaxed">{connMsg}</p>
            )}

            {/* 操作結果メッセージ */}
            {notice && (
              <p className="text-xs text-ink bg-surface border border-line rounded-lg px-3 py-2 leading-relaxed break-all">{notice}</p>
            )}

            {/* リモート一覧（読み取り専用） */}
            <div className="rounded-xl border border-line bg-surface p-3 space-y-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={goParent}
                  className="flex-none text-xs text-ink-secondary border border-line rounded-md px-2 py-1 hover:border-sakura"
                  title="親フォルダへ"
                >↑ 親へ</button>
                <span className="flex-1 text-[11px] text-ink-muted font-mono truncate" title={cwd}>
                  ~/{crumbTail}
                </span>
                <button
                  onClick={() => loadList(cwd)}
                  className="flex-none text-xs text-ink-secondary border border-line rounded-md px-2 py-1 hover:border-sakura"
                >↻ 更新</button>
              </div>
              <p className="text-[11px] text-ink-muted">公開ディレクトリ（~/www）のファイルを表示しています。一覧は読み取り専用です。</p>
              {listing ? (
                <p className="text-sm text-ink-secondary py-3">読み込み中…</p>
              ) : listError ? (
                <p className="text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2 leading-relaxed">{listError}</p>
              ) : entries.length === 0 ? (
                <p className="text-sm text-ink-muted py-3">ファイルがありません。</p>
              ) : (
                <ul className="divide-y divide-line max-h-60 overflow-y-auto">
                  {entries.map(e => (
                    <li key={e.name} className="flex items-center gap-2 py-1.5">
                      <span className="flex-none">{e.isDir ? '📁' : '📄'}</span>
                      {e.isDir ? (
                        <button
                          onClick={() => enterDir(e.name)}
                          className="flex-1 text-left text-sm text-ink hover:text-sakura truncate"
                        >{e.name}</button>
                      ) : (
                        <span className="flex-1 text-sm text-ink truncate">{e.name}</span>
                      )}
                      {!e.isDir && (
                        <button
                          onClick={() => fetchAndEdit(e.name)}
                          className="flex-none text-xs font-medium text-sakura hover:underline"
                        >取得して編集</button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* サーバへアップロード（取得済みファイル一覧） */}
            <div className="rounded-xl border border-line bg-surface p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-ink">サーバへアップロード</p>
                <button
                  onClick={refreshEdited}
                  className="flex-none text-xs text-ink-secondary border border-line rounded-md px-2 py-1 hover:border-sakura"
                >↻ 更新</button>
              </div>
              <p className="text-[11px] text-ink-muted leading-relaxed">
                「取得して編集」で取得したファイル（{SERVER_EDIT_DIR}/ 配下）を選んでサーバへ戻します。上書き前に自動バックアップを作成します。
              </p>
              {edited.length === 0 ? (
                <p className="text-sm text-ink-muted py-2">取得済みのファイルはありません。上の一覧から「取得して編集」してください。</p>
              ) : (
                <ul className="divide-y divide-line max-h-44 overflow-y-auto">
                  {edited.map(f => (
                    <li key={f.rel} className="flex items-center gap-2 py-1.5">
                      <span className="flex-none">📝</span>
                      <span className="flex-1 text-sm text-ink truncate font-mono" title={f.rel}>{f.rel}</span>
                      <button
                        onClick={() => confirmUpload(f)}
                        className="flex-none text-xs font-medium text-sakura hover:underline"
                      >アップロード</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex justify-end">
              <button onClick={onClose} className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90">閉じる</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
