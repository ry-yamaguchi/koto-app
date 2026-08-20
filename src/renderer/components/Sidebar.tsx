import React, { useState, useEffect, useRef } from 'react'
import SakuraLogo from './SakuraLogo'
import { PUBLISH_TARGET_LABEL, type PublishTargetKind } from '../publishStatus'
import { clearPublishRecord, readHanamiiProjectId, readPublishTargets } from '../publishRecord'
import { teardownSupport, manualTeardownGuide } from '../../shared/teardownSupport'
import { REGISTRY_MONTHLY_YEN } from '../../shared/cloudCost'
import { getHanamiiToken } from './CredentialsModal'
import { useFileDrag } from '../hooks/useFileDrag'
import { isPublished } from '../../shared/publishExclude'

interface FileEntry {
  name: string
  isDir: boolean
  path: string
}

interface Props {
  currentDir: string | null
  // null = プロジェクトを閉じる（プロジェクト削除時に使用）
  onSetDir: (dir: string | null) => void
  onOpenFile: (path: string) => void
  onNewProject: () => void
  // 「🕘 履歴」（前の状態に戻す）モーダルを開く
  onOpenHistory?: () => void
  refreshKey?: number
}

// 最近開いたプロジェクト（スイッチャー用）
const RECENTS_KEY = 'sakura_recent_projects'

function loadRecents(): string[] {
  try {
    const r = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')
    return Array.isArray(r) ? r.filter(p => typeof p === 'string') : []
  } catch { return [] }
}

// 所見13: 「隠しファイルを表示」トグルの保存キー（既定=非表示）。
const SHOW_HIDDEN_KEY = 'sakura_show_hidden'
function loadShowHidden(): boolean {
  return localStorage.getItem(SHOW_HIDDEN_KEY) === '1'
}

// 所見13: 「隠しファイルを表示」をONにしても隠したままにする内部フォルダ（既存の除外方針を尊重）。
// .sakuraide=チャット履歴・秘密が混じり得る内部フォルダ、.sakuraide-backup=スナップショット、.git=リポジトリ。
const ALWAYS_HIDDEN = new Set(['.sakuraide', '.sakuraide-backup', '.git'])

function iconFor(name: string, isDir: boolean): string {
  if (isDir) return '📁'
  const ext = name.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: '🟦', tsx: '⚛️', js: '🟨', jsx: '⚛️', json: '🔧',
    py: '🐍', rs: '🦀', go: '🐹', md: '📝', css: '🎨',
    html: '🌐', sh: '🐚', yml: '⚙️', yaml: '⚙️', sql: '🗃️',
  }
  return map[ext ?? ''] ?? '📄'
}

interface MenuState { x: number; y: number; entry: FileEntry }

function ContextMenu({ menu, onClose, onRename, onDelete, onNewFile }: {
  menu: MenuState
  onClose: () => void
  onRename: (entry: FileEntry) => void
  onDelete: (entry: FileEntry) => void
  onNewFile: (entry: FileEntry) => void
}) {
  const { entry } = menu
  const isHtml = /\.html?$/i.test(entry.name)
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close) }
  }, [onClose])

  const items: { label: string; onClick: () => void; show?: boolean }[] = [
    { label: '🌐 ブラウザで開く', show: isHtml && !entry.isDir, onClick: () => window.electronAPI.shell.openPath(entry.path) },
    { label: '📁 Finder で表示', onClick: () => window.electronAPI.shell.showInFolder(entry.path) },
    { label: '📋 パスをコピー', onClick: () => navigator.clipboard.writeText(entry.path) },
    { label: '📋 名前をコピー', onClick: () => navigator.clipboard.writeText(entry.name) },
    { label: '✏️ 名前の変更', onClick: () => onRename(entry) },
    { label: '🗑 削除（ゴミ箱へ）', onClick: () => onDelete(entry) },
    { label: '＋ 新規ファイル', show: entry.isDir, onClick: () => onNewFile(entry) },
  ].filter(i => i.show !== false)

  return (
    <ul
      className="fixed z-50 min-w-[180px] bg-elevated border border-line rounded-lg shadow-lg py-1 text-[13px]"
      style={{ top: menu.y, left: menu.x }}
      onClick={e => e.stopPropagation()}
    >
      {items.map(i => (
        <li key={i.label}>
          <button
            className="w-full text-left px-3 py-1.5 text-ink hover:bg-overlay transition-colors"
            onClick={() => { i.onClick(); onClose() }}
          >{i.label}</button>
        </li>
      ))}
    </ul>
  )
}

function FileTree({ dir, onOpenFile, depth = 0, refreshKey = 0, showHidden = false, onContextMenu }: { dir: string; onOpenFile: (p: string) => void; depth?: number; refreshKey?: number; showHidden?: boolean; onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void }) {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    window.electronAPI.fs.readDir(dir).then(setEntries).catch(() => setEntries([]))
  }, [dir, refreshKey])

  const toggle = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }

  // 所見13: 内部フォルダ（ALWAYS_HIDDEN）は常に隠す。それ以外の '.' 始まりはトグルONのときだけ表示する。
  const visible = entries.filter(e => {
    if (ALWAYS_HIDDEN.has(e.name)) return false
    if (e.name.startsWith('.')) return showHidden
    return true
  }).sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const row = (entry: FileEntry) => {
    const published = isPublished(entry.name, entry.isDir)
    return (
      <li key={entry.path}>
        <div
          className="flex items-center gap-1.5 px-2 py-1 mx-1 hover:bg-overlay cursor-pointer text-[13px] rounded-md transition-colors group"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          onClick={() => entry.isDir ? toggle(entry.path) : onOpenFile(entry.path)}
          onContextMenu={e => onContextMenu(e, entry)}
        >
          <span className="text-ink-muted w-3 text-[10px] flex-none">
            {entry.isDir ? (expanded.has(entry.path) ? '▾' : '▸') : ''}
          </span>
          <span className="text-xs flex-none">{iconFor(entry.name, entry.isDir)}</span>
          {/* 所見29: truncate で省略された名前をホバーで全体確認できるよう title を付ける。
              公開されないものは、その理由もここで伝える（2026-08-20 Ryosuke 要望）。 */}
          <span
            className={`truncate ${entry.isDir ? 'text-ink-secondary' : 'text-ink'} group-hover:text-ink`}
            title={published ? entry.name : `${entry.name}（公開されません。手元にだけ残ります）`}
          >
            {entry.name}
          </span>
        </div>
        {entry.isDir && expanded.has(entry.path) && (
          <FileTree dir={entry.path} onOpenFile={onOpenFile} depth={depth + 1} refreshKey={refreshKey} showHidden={showHidden} onContextMenu={onContextMenu} />
        )}
      </li>
    )
  }

  // ── 公開されるもの／されないものを分けて見せる（2026-08-20 Ryosuke 要望「①」）──────
  // 実体は動かさない。**判定は publishExclude.ts の isPublished ひとつ**なので、
  // ここに出るものと、実際に公開先へ置かれるものは必ず一致する。
  // 分けるのはいちばん上の階層だけ（下の階層のものは、親の扱いに従う）。
  //
  // **片方が空でも、両方の見出しを出す**（2026-08-20 Ryosuke 指摘で改めた）。
  // 最初は「公開されないものが無ければ見出しを出さない」にしていたが、
  // それだと**分け方そのものが見えず、実機では「効いていない」ように見えた**。
  // 「気になる点だけ出す」は警告の話であって、**仕組みを示す見出しには当てはまらない**。
  if (depth === 0 && visible.length > 0) {
    const shown = visible.filter(e => isPublished(e.name, e.isDir))
    const kept = visible.filter(e => !isPublished(e.name, e.isDir))
    return (
      <>
        <GroupLabel text="公開されるもの" hint="このまま公開先に置かれます" />
        {shown.length > 0 ? <ul>{shown.map(row)}</ul> : <EmptyGroup />}
        <GroupLabel text="公開されないもの" hint="手元にだけ残ります（公開先へは送られません）" />
        {kept.length > 0 ? <ul>{kept.map(row)}</ul> : <EmptyGroup />}
      </>
    )
  }

  return <ul>{visible.map(row)}</ul>
}

/** 片方の組が空のときに出す一言（見出しだけ並ぶと壊れて見えるため）。 */
function EmptyGroup() {
  return <p className="px-3 py-1 text-[11px] text-ink-secondary">（いまはありません）</p>
}

/** ファイル一覧の見出し（公開されるもの／されないもの）。 */
function GroupLabel({ text, hint }: { text: string; hint: string }) {
  return (
    <div className="px-3 pt-2 pb-0.5 flex items-center gap-1.5" title={hint}>
      <span className="text-[11px] text-ink-secondary font-semibold tracking-wide">{text}</span>
      <span className="flex-1 h-px bg-line" />
    </div>
  )
}

export default function Sidebar({ currentDir, onSetDir, onOpenFile, onNewProject, onOpenHistory, refreshKey = 0 }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(0)
  // 所見13: 隠しファイル（'.' 始まり）を表示するか。既定=非表示。localStorage に保存する。
  const [showHidden, setShowHidden] = useState(loadShowHidden)
  const [projMenu, setProjMenu] = useState(false)
  const [workspaceProjects, setWorkspaceProjects] = useState<string[]>([])
  const [recents, setRecents] = useState<string[]>(loadRecents)
  const [dropHint, setDropHint] = useState<string | null>(null)
  const treeDrag = useFileDrag()
  const [nameDialog, setNameDialog] = useState<{ mode: 'new' | 'rename'; targetPath: string; initial: string } | null>(null)
  const [nameInput, setNameInput] = useState('')
  // プロジェクト削除の確認ダイアログ（削除対象のパス。null=非表示）
  // ※プロジェクト名の変更（リネーム）は提供しない方針（2026-07-12 ユーザー決定）:
  //   開いているプロジェクトのリネームはタブ・履歴等の絶対パス参照の付け替えが必要で事故リスクが
  //   高い割に、公開名は各公開パネルで独立に変更できるため必要性が低い。
  //   代わりに NewProjectModal で「名前は後から変更できない」旨を作成時に明示する。
  const [confirmProjDelete, setConfirmProjDelete] = useState<string | null>(null)
  /** 削除しようとしているプロジェクトに残っている公開記録（確認ダイアログを開くときに読む）。 */
  const [pendingPublish, setPendingPublish] = useState<PublishTargetKind[]>([])
  /** 「公開も一緒に破棄する」（既定オン＝消し忘れによる課金を止める側を既定にする）。 */
  const [teardownOnDelete, setTeardownOnDelete] = useState(true)
  /** 破棄の実行中（ボタンを止めて二重実行を防ぐ）。 */
  const [deletingBusy, setDeletingBusy] = useState(false)

  // 開いたプロジェクトを「最近」に記録
  useEffect(() => {
    if (!currentDir) return
    setRecents(prev => {
      const next = [currentDir, ...prev.filter(p => p !== currentDir)].slice(0, 10)
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
      return next
    })
  }, [currentDir])

  // ワークスペース(~/SAKURAIDE)のプロジェクト一覧を読み直す（スイッチャー表示時・未オープン時）。
  // 世代カウンタ: 並行して複数回呼ばれたとき、古い呼び出しのディスク読み取り結果が最新の状態
  // （例: 削除直後にフィルタ済みの一覧）を上書きして「削除したプロジェクトが復活して見える」のを防ぐ
  // （2026-07-13 ユーザー報告）。最新の呼び出しの結果だけを反映する。
  const wsLoadSeq = useRef(0)
  const loadWorkspaceProjects = async () => {
    const seq = ++wsLoadSeq.current
    try {
      const home = await window.electronAPI.fs.homeDir()
      const ws = `${home}/SAKURAIDE`
      if (await window.electronAPI.fs.exists(ws)) {
        const entries = await window.electronAPI.fs.readDir(ws)
        if (seq !== wsLoadSeq.current) return
        setWorkspaceProjects(entries.filter(e => e.isDir && !e.name.startsWith('.')).map(e => e.path))
      } else {
        if (seq !== wsLoadSeq.current) return
        setWorkspaceProjects([])
      }
    } catch {
      // 読み込みの一時失敗では一覧を空にしない（プロジェクトが存在するのに「まったくない」表示に
      // 見えてしまうため・2026-07-14 ユーザー報告）。直前の一覧を維持し、次回の読み直しに任せる。
    }
  }

  // スイッチャーを開く：ワークスペースのプロジェクト一覧も取得
  const toggleProjMenu = async () => {
    if (projMenu) { setProjMenu(false); return }
    await loadWorkspaceProjects()
    setProjMenu(true)
  }

  // プロジェクト未オープン時（ようこそ画面）は常に一覧を表示する。
  // ※開いていたプロジェクトを削除すると未オープン状態に戻るが、以前はこの画面に一覧が無く
  //   「すべて消えた」ように見えた（2026-07-12 ユーザー報告）。
  useEffect(() => {
    if (!currentDir) loadWorkspaceProjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDir])

  // プロジェクトを切り替える（消えたフォルダは一覧から除外）
  const switchProject = async (path: string) => {
    setProjMenu(false)
    if (path === currentDir) return
    if (!(await window.electronAPI.fs.exists(path))) {
      setRecents(prev => {
        const next = prev.filter(p => p !== path)
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
        return next
      })
      return
    }
    onSetDir(path)
  }

  // スイッチャーの外側クリックで閉じる
  useEffect(() => {
    if (!projMenu) return
    const close = () => setProjMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [projMenu])

  // フォルダを監視し、ターミナルやFinderでの変更もツリーへ自動反映する
  useEffect(() => {
    if (!currentDir) return
    return window.electronAPI.fs.watchDir(currentDir, () => setAutoRefresh(n => n + 1))
  }, [currentDir])
  const onContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, entry })
  }

  const openFolder = async () => {
    const dir = await window.electronAPI.fs.openDialog()
    if (dir) onSetDir(dir)
  }

  // Finderからのファイル取り込み（画像は images/ へ）
  const importDropped = async (files: FileList) => {
    if (!currentDir) return
    const imported: string[] = []
    for (const f of Array.from(files)) {
      try {
        const src = window.electronAPI.fs.pathForFile(f)
        if (!src) continue
        const rel = await window.electronAPI.fs.importFile(src, currentDir)
        imported.push(rel)
      } catch { /* 1件の失敗で全体を止めない */ }
    }
    if (imported.length) {
      setDropHint(`${imported.join(', ')} を取り込みました。チャットで「${imported[0]} を使って」と伝えるとAIがページに組み込めます`)
      setTimeout(() => setDropHint(null), 12000)
    }
  }

  const deleteEntry = async (entry: FileEntry) => {
    if (!window.confirm(`「${entry.name}」をゴミ箱に移動します。よろしいですか？`)) return
    try {
      await window.electronAPI.fs.trash(entry.path)
      window.dispatchEvent(new CustomEvent('sakura:file-deleted', { detail: entry.path }))
    } catch (e: any) { window.alert(`削除できませんでした: ${e?.message ?? e}`) }
  }

  // 削除の確認ダイアログを開くたびに、そのプロジェクトの公開記録を読む。
  // 「何が公開されたままか」を見せないと、ユーザーは破棄の判断ができない。
  useEffect(() => {
    if (!confirmProjDelete) { setPendingPublish([]); return }
    let cancelled = false
    setTeardownOnDelete(true) // 開くたびに既定（破棄する）へ戻す
    readPublishTargets(confirmProjDelete).then(ts => { if (!cancelled) setPendingPublish(ts) })
    return () => { cancelled = true }
  }, [confirmProjDelete])

  /**
   * このプロジェクトの公開を破棄する。**失敗したものの説明を配列で返す**（空なら全部成功）。
   * 破棄の口が無い公開先（Vercel・レンタルサーバ）は対象外。消せないものを消せたことにしない。
   */
  const teardownPublished = async (dir: string, targets: PublishTargetKind[]): Promise<string[]> => {
    const failed: string[] = []
    for (const t of targets) {
      if (teardownSupport(t) !== 'supported') continue
      try {
        let r: { ok: boolean; message?: string }
        if (t === 'sakura-apprun') {
          // レジストリも消す。残すと月220円が続くうえ、フォルダを消すと記録も消えて
          // Koto からは二度と消せなくなる。
          r = await window.electronAPI.cloud.teardown(dir, { confirmed: true, deleteRegistry: true })
        } else {
          const id = await readHanamiiProjectId(dir)
          if (!id) { failed.push(`${PUBLISH_TARGET_LABEL[t]}: プロジェクトIDの記録がありません`); continue }
          const token = await getHanamiiToken()
          if (!token) { failed.push(`${PUBLISH_TARGET_LABEL[t]}: トークンが未登録です`); continue }
          r = await window.electronAPI.hanamii.teardown(id, token)
        }
        if (!r.ok) failed.push(`${PUBLISH_TARGET_LABEL[t]}: ${r.message ?? '原因不明'}`)
        else { try { await clearPublishRecord(dir, t) } catch { /* 記録の掃除の失敗は破棄の成否に影響させない */ } }
      } catch (e: any) {
        failed.push(`${PUBLISH_TARGET_LABEL[t]}: ${e?.message ?? String(e)}`)
      }
    }
    return failed
  }

  // プロジェクトの削除（フォルダごとゴミ箱へ移動・Finderのゴミ箱から復元可能）。
  // 公開済みのサイト/アプリ・GitHubのリポジトリは対象外（ローカルのフォルダのみ）。
  // 破壊操作のため専用の確認ダイアログを挟む（掟5）。confirmProjDelete = 削除確認中のパス。
  const deleteProject = async (path: string) => {
    // ── 先に公開を破棄する（2026-08-09 Ryosuke の指摘）─────────────────────
    // フォルダをゴミ箱へ移すと .sakura-cloud/state.json も一緒に消える。これは
    // 「どのコンテナレジストリを使っているか」の**唯一の記録**なので、消えた後は
    // Koto から後片付けできなくなり、月220円が黙って続く。だから削除より先に破棄する。
    // **破棄に失敗したらフォルダを消さない。** 記録を失わせる方が害が大きい。
    if (teardownOnDelete && pendingPublish.some(t => teardownSupport(t) === 'supported')) {
      setDeletingBusy(true)
      const failed = await teardownPublished(path, pendingPublish)
      setDeletingBusy(false)
      if (failed.length > 0) {
        window.alert(
          `公開の破棄に失敗したため、プロジェクトの削除を中止しました。\n\n${failed.join('\n')}\n\n`
          + `このままフォルダを削除すると、どこに何を公開したかの記録も消えて後片付けできなくなります。`
          + `「③公開」の画面から破棄するか、各サービスの管理画面で削除してください。`
        )
        return
      }
    }
    setConfirmProjDelete(null)
    try {
      // 既にディスクから消えている（=一覧表示が古かった）場合は成功扱いにして、
      // 記録の掃除と一覧の再取得だけ行う（2026-07-13 ユーザー報告: 表示に残った項目を
      // もう一度削除しようとしてエラーで行き止まりにならないように）。
      if (await window.electronAPI.fs.exists(path)) {
        await window.electronAPI.fs.trash(path)
      }
    } catch (e: any) {
      window.alert(`プロジェクトを削除できませんでした: ${e?.message ?? e}`)
      return
    }
    // このプロジェクトに紐づくアプリ内の記録を掃除する（タブ・旧チャット履歴・最近一覧）。
    // 新チャット履歴（.sakuraide/chat.json）はフォルダごとゴミ箱に入るため個別対応不要。
    try {
      localStorage.removeItem(`sakura_tabs:${path}`)
      localStorage.removeItem(`sakura_chat:${path}`) // 移行前の旧形式が残っていた場合
    } catch { /* 掃除失敗は無視 */ }
    setRecents(prev => {
      const next = prev.filter(p => p !== path)
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
      return next
    })
    setWorkspaceProjects(prev => prev.filter(p => p !== path))
    if (path === currentDir) onSetDir(null) // 開いていたプロジェクトを消したら未オープン状態へ
    // ゴミ箱移動完了後のディスク実態で一覧を確定させる（古い読み取り結果による
    // 「削除したプロジェクトの復活表示」防止・2026-07-13 ユーザー報告）。
    await loadWorkspaceProjects()
  }

  // 名前変更／新規ファイルのインライン入力ダイアログを開く（promptはElectron非対応のため）
  const openNameDialog = (mode: 'new' | 'rename', entry: FileEntry) => {
    setMenu(null)
    if (mode === 'rename') {
      setNameDialog({ mode, targetPath: entry.path, initial: entry.name })
      setNameInput(entry.name)
    } else {
      setNameDialog({ mode, targetPath: entry.path, initial: '' })
      setNameInput('')
    }
  }

  const submitNameDialog = async () => {
    if (!nameDialog) return
    const name = nameInput.trim()
    if (!name || name.includes('/') || name.includes('..')) {
      window.alert('不正なファイル名です')
      return
    }
    try {
      if (nameDialog.mode === 'rename') {
        const newPath = await window.electronAPI.fs.rename(nameDialog.targetPath, name)
        window.dispatchEvent(new CustomEvent('sakura:file-renamed', { detail: { from: nameDialog.targetPath, to: newPath } }))
      } else {
        const full = `${nameDialog.targetPath}/${name}`
        await window.electronAPI.fs.writeFile(full, '')
        onOpenFile(full)
      }
      setNameDialog(null)
    } catch (e: any) {
      window.alert(e?.message ?? String(e))
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-line-soft">
        <span className="text-[11px] font-semibold text-ink-muted uppercase tracking-widest">ファイル</span>
        <div className="flex items-center gap-0.5">
          {currentDir && onOpenHistory && (
            <button
              onClick={onOpenHistory}
              className="text-ink-muted hover:text-sakura w-6 h-6 flex items-center justify-center rounded-md hover:bg-overlay transition-colors text-[12px]"
              title="🕘 履歴（前の状態に戻す）— 選んだ時点の状態にまるごと戻せます"
            >🕘</button>
          )}
          {/* 所見13: 隠しファイル（.htaccess・.gitignore 等）の表示トグル。既定=非表示。プロジェクトを開いているときのみ表示。 */}
          {currentDir && (
            <button
              onClick={() => setShowHidden(v => {
                const next = !v
                localStorage.setItem(SHOW_HIDDEN_KEY, next ? '1' : '0')
                return next
              })}
              className={`w-6 h-6 flex items-center justify-center rounded-md hover:bg-overlay transition-colors text-[12px] ${showHidden ? 'text-sakura' : 'text-ink-muted hover:text-sakura'}`}
              title={showHidden ? '隠しファイルを表示中（クリックで隠す）' : '隠しファイルを表示（.htaccess・.gitignore など）'}
            >👁</button>
          )}
          <button
            onClick={() => setAutoRefresh(n => n + 1)}
            className="text-ink-muted hover:text-sakura w-6 h-6 flex items-center justify-center rounded-md hover:bg-overlay transition-colors"
            title="ツリーを更新"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
            </svg>
          </button>
          <button
            onClick={onNewProject}
            className="text-ink-muted hover:text-sakura w-6 h-6 flex items-center justify-center rounded-md hover:bg-overlay transition-colors"
            title="新規プロジェクト（AIで作成）"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
            </svg>
          </button>
          <button
            onClick={openFolder}
            className="text-ink-muted hover:text-sakura w-6 h-6 flex items-center justify-center rounded-md hover:bg-overlay transition-colors"
            title="フォルダを開く"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
            </svg>
          </button>
        </div>
      </div>

      {dropHint && (
        <div className="mx-2 mb-1 px-2.5 py-1.5 rounded-lg bg-elevated border border-sakura/50 text-[11px] text-ink-secondary leading-relaxed">📥 {dropHint}</div>
      )}

      <div
        data-drop="tree"
        className={`flex-1 overflow-y-auto py-1.5${treeDrag.over ? ' ring-2 ring-sakura ring-inset' : ''}`}
        // ここに落としたときは**プロジェクトに取り込む**。落とす処理だけはここで止める
        //（画面全体の受け口＝AIに見せる、へ流さないため）。
        // 重なっている合図は止めない: 全体の案内が「取り込みます」に変わるのを、
        // 上（App）が知る必要がある（2026-08-19 実機で二重の枠を整理）
        onDragOver={treeDrag.onDragOver}
        onDragLeave={treeDrag.onDragLeave}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); treeDrag.end(); if (e.dataTransfer.files?.length) importDropped(e.dataTransfer.files) }}
      >
        {currentDir ? (
          <>
            {/* プロジェクトスイッチャー */}
            <div className="relative px-2 mb-1">
              <button
                onClick={e => { e.stopPropagation(); toggleProjMenu() }}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-overlay transition-colors group"
                title={`${currentDir}\nクリックでプロジェクトを切替`}
              >
                <span className="text-[11px] font-semibold text-ink-secondary group-hover:text-ink uppercase tracking-wide truncate flex-1 text-left">
                  {currentDir.split('/').pop()}
                </span>
                <span className="text-[9px] text-ink-muted group-hover:text-sakura flex-none">▾</span>
              </button>
              {projMenu && (
                <div
                  className="absolute left-2 right-2 top-full z-50 mt-0.5 bg-elevated border border-line rounded-lg shadow-lg py-1 max-h-80 overflow-y-auto"
                  onClick={e => e.stopPropagation()}
                >
                  {workspaceProjects.length > 0 && (
                    <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold text-ink-muted uppercase tracking-widest">プロジェクトの場所</div>
                  )}
                  {workspaceProjects.map(p => (
                    <div key={p} className="flex items-center hover:bg-overlay transition-colors">
                      <button
                        onClick={() => switchProject(p)}
                        className="flex-1 min-w-0 flex items-center gap-1.5 text-left px-3 py-1.5 text-[13px] text-ink"
                      >
                        <span className="w-3 flex-none text-sakura">{p === currentDir ? '✓' : ''}</span>
                        <span className="truncate">{p.split('/').pop()}</span>
                      </button>
                      {/* プロジェクト削除（ワークスペース配下のみ表示。「最近開いた場所」は任意のフォルダを
                          指し得るため対象外＝Finderで操作してもらう）。
                          ホバー時のみ表示だと気づけない（2026-07-12 ユーザー報告）ため常時表示にする */}
                      <button
                        onClick={e => { e.stopPropagation(); setProjMenu(false); setConfirmProjDelete(p) }}
                        title="このプロジェクトを削除（ゴミ箱へ）"
                        className="flex-none px-2 py-1.5 text-[12px] text-ink-muted hover:text-brand-red transition-colors"
                      >🗑</button>
                    </div>
                  ))}
                  {recents.filter(p => !workspaceProjects.includes(p)).length > 0 && (
                    <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold text-ink-muted uppercase tracking-widest border-t border-line-soft mt-1">最近開いた場所</div>
                  )}
                  {recents.filter(p => !workspaceProjects.includes(p)).map(p => (
                    <button
                      key={p}
                      onClick={() => switchProject(p)}
                      className="w-full flex items-center gap-1.5 text-left px-3 py-1.5 text-[13px] text-ink hover:bg-overlay transition-colors"
                      title={p}
                    >
                      <span className="w-3 flex-none text-sakura">{p === currentDir ? '✓' : ''}</span>
                      <span className="truncate">{p.split('/').pop()}</span>
                    </button>
                  ))}
                  <div className="border-t border-line-soft mt-1 pt-1">
                    <button
                      onClick={() => { setProjMenu(false); onNewProject() }}
                      className="w-full text-left px-3 py-1.5 text-[13px] text-ink hover:bg-overlay transition-colors"
                    >＋ 新規プロジェクト…</button>
                    <button
                      onClick={() => { setProjMenu(false); openFolder() }}
                      className="w-full text-left px-3 py-1.5 text-[13px] text-ink hover:bg-overlay transition-colors"
                    >📂 フォルダを開く…</button>
                    {/* 開いているプロジェクトの削除（ワークスペース配下のときのみ。見つけやすい明示導線） */}
                    {currentDir && workspaceProjects.includes(currentDir) && (
                      <button
                        onClick={() => { setProjMenu(false); setConfirmProjDelete(currentDir) }}
                        className="w-full text-left px-3 py-1.5 text-[13px] text-brand-red hover:bg-overlay transition-colors"
                      >🗑 このプロジェクトを削除…</button>
                    )}
                  </div>
                </div>
              )}
            </div>
            <FileTree dir={currentDir} onOpenFile={onOpenFile} refreshKey={refreshKey + autoRefresh} showHidden={showHidden} onContextMenu={onContextMenu} />
          </>
        ) : (
          <div className="px-4 py-6">
            {/* 仕様変更（2026-07-14 ユーザー要望）: プロジェクトが既に有るときは「初期セットアップ風の
                大きなブロック」を出さず、一覧を主役にする。新規作成・フォルダを開くは一覧の下に小さく置く。
                ヒーローブロック（ロゴ＋大ボタン）はプロジェクトが1つも無いときだけ表示する。 */}
            {(workspaceProjects.length > 0 || recents.filter(p => !workspaceProjects.includes(p)).length > 0) ? (
              <>
                {workspaceProjects.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold text-ink-muted uppercase tracking-widest mb-1 px-1">プロジェクトの場所</div>
                    <div className="rounded-lg border border-line-soft overflow-hidden">
                      {workspaceProjects.map(p => (
                        <div key={p} className="flex items-center hover:bg-overlay transition-colors">
                          <button
                            onClick={() => switchProject(p)}
                            className="flex-1 min-w-0 text-left px-3 py-2 text-[13px] text-ink truncate"
                            title={p}
                          >📁 {p.split('/').pop()}</button>
                          <button
                            onClick={e => { e.stopPropagation(); setConfirmProjDelete(p) }}
                            title="このプロジェクトを削除（ゴミ箱へ）"
                            className="flex-none px-2 py-2 text-[12px] text-ink-muted hover:text-brand-red transition-colors"
                          >🗑</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {recents.filter(p => !workspaceProjects.includes(p)).length > 0 && (
                  <div className="mt-4">
                    <div className="text-[10px] font-semibold text-ink-muted uppercase tracking-widest mb-1 px-1">最近開いた場所</div>
                    <div className="rounded-lg border border-line-soft overflow-hidden">
                      {recents.filter(p => !workspaceProjects.includes(p)).map(p => (
                        <button
                          key={p}
                          onClick={() => switchProject(p)}
                          className="w-full text-left px-3 py-2 text-[13px] text-ink truncate hover:bg-overlay transition-colors"
                          title={p}
                        >📂 {p.split('/').pop()}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-5 space-y-1.5">
                  <button
                    onClick={onNewProject}
                    className="w-full text-left px-3 py-2 rounded-lg text-[12px] text-ink-secondary hover:text-ink hover:bg-overlay border border-line-soft transition-colors"
                  >＋ 新規プロジェクト（AI）</button>
                  <button
                    onClick={openFolder}
                    className="w-full text-left px-3 py-2 rounded-lg text-[12px] text-ink-secondary hover:text-ink hover:bg-overlay border border-line-soft transition-colors"
                  >📂 既存のフォルダを開く</button>
                </div>
              </>
            ) : (
              <div className="text-center pt-2">
                <div className="flex justify-center mb-3"><SakuraLogo size={36} /></div>
                <p className="text-xs text-ink-muted mb-4">プロジェクトを始めましょう</p>
                <button
                  onClick={onNewProject}
                  className="w-full sakura-gradient text-white rounded-lg px-4 py-2 text-xs font-semibold hover:opacity-90 transition-opacity shadow-sm mb-2"
                >
                  ＋ 新規プロジェクト（AI）
                </button>
                <button
                  onClick={openFolder}
                  className="w-full bg-overlay text-ink-secondary hover:text-ink rounded-lg px-4 py-2 text-xs font-medium transition-colors border border-line"
                >
                  既存のフォルダを開く
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onRename={entry => openNameDialog('rename', entry)}
          onDelete={entry => deleteEntry(entry)}
          onNewFile={entry => openNameDialog('new', entry)}
        />
      )}

      {/* プロジェクト削除の確認ダイアログ（掟5: 破壊操作は必ず確認）。ゴミ箱移動なので復元可能な旨と、
          公開済みのもの・GitHubのバックアップはローカル削除の対象外である旨を明記する。 */}
      {confirmProjDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setConfirmProjDelete(null)}
        >
          <div
            className="bg-elevated border border-line rounded-xl p-4 w-[24rem] max-w-[92vw]"
            onClick={e => e.stopPropagation()}
          >
            <div className="text-[13px] font-semibold text-ink mb-2">
              プロジェクト「{confirmProjDelete.split('/').pop()}」を削除しますか？
            </div>
            <div className="text-[11px] text-ink-secondary leading-relaxed space-y-1.5">
              <p>フォルダごと<b>ゴミ箱へ移動</b>します（Finderのゴミ箱から復元できます）。チャット履歴・🕘履歴もフォルダと一緒に移動します。</p>

              {/* ── 公開したものの後始末（2026-08-09 Ryosuke の指摘）──────────────
                  フォルダを消すと .sakura-cloud/state.json（どのレジストリを使っているかの
                  唯一の記録）も一緒に消える。消えた後は Koto から後片付けできず、
                  月220円が黙って続く。だから削除の前にここで止められるようにする。 */}
              {pendingPublish.length > 0 && (
                <div className="rounded-lg border border-brand-red/50 bg-surface p-2.5 space-y-1.5">
                  <p className="text-ink font-medium">このプロジェクトは公開されています</p>
                  <ul className="list-disc pl-4 text-ink-secondary">
                    {pendingPublish.map(t => (
                      <li key={t}>
                        {PUBLISH_TARGET_LABEL[t]}
                        {teardownSupport(t) === 'manual' && (
                          <span className="text-ink-muted"><br />{manualTeardownGuide(t)}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {pendingPublish.some(t => teardownSupport(t) === 'supported') && (
                    <>
                      <label className="flex items-start gap-1.5 cursor-pointer pt-0.5">
                        <input
                          type="checkbox"
                          checked={teardownOnDelete}
                          onChange={e => setTeardownOnDelete(e.target.checked)}
                          disabled={deletingBusy}
                          className="mt-0.5 accent-[rgb(var(--sakura-rgb))]"
                        />
                        <span className="text-ink font-medium">公開も一緒に破棄する</span>
                      </label>
                      <p className={`pl-5 ${teardownOnDelete ? 'text-ink-muted' : 'text-brand-red'}`}>
                        {teardownOnDelete
                          ? '先に公開を破棄してから、フォルダをゴミ箱へ移します。破棄に失敗したときは削除しません。'
                          : '公開はそのまま残ります。フォルダを消すと「どこに何を公開したか」の記録も消えるため、'
                            + `あとから Koto では破棄できなくなります（AppRun はコンテナレジストリの月額${REGISTRY_MONTHLY_YEN}円が続きます）。`}
                      </p>
                    </>
                  )}
                </div>
              )}

              <p className="text-ink-muted">💾GitHubに保存したリポジトリは<b>そのまま残ります</b>。</p>
              <p className="font-mono text-[10px] text-ink-muted break-all">{confirmProjDelete}</p>
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setConfirmProjDelete(null)}
                disabled={deletingBusy}
                className="px-3 py-1.5 rounded-md text-[12px] text-ink-secondary hover:bg-overlay transition-colors disabled:opacity-40"
              >キャンセル</button>
              <button
                onClick={() => deleteProject(confirmProjDelete)}
                disabled={deletingBusy}
                className="px-3 py-1.5 rounded-md text-[12px] font-semibold text-white bg-brand-red-fill hover:opacity-90 transition-opacity disabled:opacity-40"
              >{deletingBusy ? '公開を破棄しています…' : '🗑 ゴミ箱に移動'}</button>
            </div>
          </div>
        </div>
      )}

      {nameDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setNameDialog(null)}
        >
          <div
            className="bg-elevated border border-line rounded-xl p-4 w-72"
            onClick={e => e.stopPropagation()}
          >
            <div className="text-[13px] font-semibold text-ink mb-2">
              {nameDialog.mode === 'rename' ? '名前の変更' : '新規ファイル'}
            </div>
            <input
              autoFocus
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); submitNameDialog() }
                else if (e.key === 'Escape') { e.preventDefault(); setNameDialog(null) }
              }}
              className="w-full px-2.5 py-1.5 rounded-md bg-surface border border-line text-[13px] text-ink focus:outline-none focus:border-sakura"
              placeholder={nameDialog.mode === 'new' ? '例: index.html' : ''}
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setNameDialog(null)}
                className="px-3 py-1.5 rounded-md text-[12px] text-ink-secondary hover:bg-overlay transition-colors"
              >キャンセル</button>
              <button
                onClick={submitNameDialog}
                className="px-3 py-1.5 rounded-md text-[12px] sakura-gradient text-white hover:opacity-90 transition-opacity"
              >OK</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
