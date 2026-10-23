import React, { useState, useEffect, useRef, useSyncExternalStore } from 'react'
import SakuraLogo from './SakuraLogo'
import ProjectDeleteDialog from './ProjectDeleteDialog'
import { useFileDrag } from '../hooks/useFileDrag'
import { isPublished, isPublishedTop, MATERIALS_DIR } from '../../shared/publishExclude'
import { PUBLISH_DIR, PUBLISH_DIR_LABEL } from '../../shared/publishRoot'
import { isSubmitEnter } from '../keyInput'
import { subscribe, getSnapshot, loadingKeys, getTurn } from '../chatTurnRegistry'
import { getWorkspaceDir } from '../workspace'
import { useConfirm } from '../useConfirm'

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
  /**
   * 「📡 公開したものと費用を見る」（判断3・2026-09-11）。
   * OSメニュー「表示 → 公開したもの一覧…」・PublishModal の奥のリンクと**同じ関数**
   * （App.tsx の setShowPublishedList(true)）を渡す。ここで複製しない（掟10）。
   */
  onOpenPublishedList?: () => void
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

interface MenuState { x: number; y: number; entry: FileEntry; published: boolean }

/**
 * そのエントリが「実際に `<PUBLISH_DIR>/` の中に置かれているか」（path ベース）。
 *
 * roadmap #9②: 右クリックメニューの移動項目を出し分けるための判定の土台。
 * `entry.path` はプロジェクト直下からの絶対パスなので、`currentDir` を引いた先頭の段が
 * `PUBLISH_DIR` かどうかで見る。public/ が無い・いちばん上の階層のときの特例は
 * `isMoveTargetPublished`（W-23）が上乗せする。ここ自体は変えていない。
 */
function isInPublishDir(currentDir: string | null, entryPath: string): boolean {
  if (!currentDir) return false
  const prefix = currentDir.endsWith('/') ? currentDir : `${currentDir}/`
  if (!entryPath.startsWith(prefix)) return false
  const rel = entryPath.slice(prefix.length)
  return rel === PUBLISH_DIR || rel.startsWith(`${PUBLISH_DIR}/`)
}

/**
 * 右クリックメニュー・ファイル移動が「いま公開される側にいるか」をどう見るか（W-23・2026-09-27）。
 *
 * ── なぜ isInPublishDir だけでは足りないか ────────────────────────────
 * `isInPublishDir` は「実際に `<project>/public/` の中に置かれているか」しか見ない。
 * ところが `public/` がまだ無いプロジェクトでは、プロジェクト直下（いちばん上の階層）の
 * ファイルは、ファイル一覧の見出し「公開されるもの」に**すでに**並んでいる（isPublishedTop）。
 * それなのに `isInPublishDir` は「public/ という実在フォルダの中か」しか見ないため常に false を
 * 返し、もう公開される側にあるファイルにまで「🌐 公開するものへ移動」が出ていた
 * （押しても意味がなく、しかも初めて押すと public/ ができて**ほかの直下ファイルが
 * 一斉に「公開されないもの」へ移る**という副作用に誰も気づけない）。
 *
 * 「public/ が無い」ときは、直下のファイルだけでなく**入れ子のファイルも**同じ扱いにする
 * （W-23・直し漏れの修正・2026-09-27再検分）。public/ が無いプロジェクトでは、直下フォルダ
 * （例: `css/`）の中身（`css/style.css`）も、ファイル一覧の見出し「公開されるもの」に
 * すでに並ぶ（`isPublishedTop` が深さを見ないため）。それなのに旧実装は depth>0 で
 * `isInPublishDir` に戻っており、これは実フォルダ `public/` の中かしか見ないので常に false
 * ＝「🌐 公開するものへ移動」が出たままだった。押すと `public/style.css` へ階層を潰して移り、
 * 初めて `public/` ができて**ほかの直下フォルダのファイルも一斉に「公開されないもの」へ移る**。
 *
 * 「public/ が無い」ときは、常にいちばん上の階層（先頭の段＝直下のファイル名、または
 * 入れ子ならそのトップのフォルダ名）について `isPublishedTop(…, false)` で判定する
 * （＝除外されていない限り「もう公開されている」）。「public/ がある」ときだけ、
 * これまでどおり `isInPublishDir`（実際に public/ の中に置かれているか）に従う。
 */
export function isMoveTargetPublished(args: {
  currentDir: string | null
  entryPath: string
  entryName: string
  entryIsDir: boolean
  hasPublishDir: boolean
}): boolean {
  const { currentDir, entryPath, entryName, entryIsDir, hasPublishDir } = args
  if (currentDir && !hasPublishDir) {
    const prefix = currentDir.endsWith('/') ? currentDir : `${currentDir}/`
    if (entryPath.startsWith(prefix)) {
      const rel = entryPath.slice(prefix.length)
      const isTopLevel = rel === entryName
      // 直下のファイル／フォルダそのものはその名前・isDir のまま、入れ子のファイルは
      // 先頭の段（トップのフォルダ名）をフォルダとして判定する（isPublishedTop(…, true, false)）。
      const topSegment = rel.split('/')[0]
      return isTopLevel
        ? isPublishedTop(entryName, entryIsDir, false)
        : isPublishedTop(topSegment, true, false)
    }
  }
  return isInPublishDir(currentDir, entryPath)
}

/**
 * ファイル移動の確認文（W-23・2026-09-27）。
 *
 * `willCreatePublishDir`（この移動で初めて `public/` ができる＝これまで「公開されるもの」に
 * 並んでいたほかの直下ファイルが一斉に「公開されないもの」へ移る）ときだけ、その影響を
 * 事前に伝える一文を足す。画面の文は素のテキスト（掟5・Markdown記法は使わない）。
 */
export function moveConfirmBody(entryName: string, destLabel: string, willCreatePublishDir: boolean): string {
  const warn = willCreatePublishDir
    ? `「${destLabel}」フォルダができるため、いま「公開されるもの」に並んでいるほかのファイルは公開されなくなります。`
    : ''
  return `「${entryName}」を「${destLabel}」へ移動します。${warn}よろしいですか？\n\n🕘 元に戻すで戻せます。`
}

function ContextMenu({ menu, onClose, onRename, onDelete, onNewFile, onMove }: {
  menu: MenuState
  onClose: () => void
  onRename: (entry: FileEntry) => void
  onDelete: (entry: FileEntry) => void
  onNewFile: (entry: FileEntry) => void
  onMove: (entry: FileEntry, published: boolean) => void
}) {
  const { entry, published } = menu
  const isHtml = /\.html?$/i.test(entry.name)
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close) }
  }, [onClose])

  // roadmap #9②「ファイルの移動手段が無い」: 公開する／しないを手で切り替える項目。
  // 出し分けは isMoveTargetPublished が決めた「いま公開される側にいるか」（W-23）に従う。
  // **ディレクトリは対象外。** 中身ごとの移動は「フォルダ内の全ファイルに検証・退避・
  // 同名衝突の解決を通す」ことになり、守りの検証が一気に複雑になる（1件ずつなら
  // isProtectedWritePath・nextFreeMaterialName の単純な適用で済むが、フォルダを渡すと
  // 「配下に保護パスが混じっていたら？」「配下だけで名前が衝突したら？」まで考える必要が
  // 出る）。今回は「任意の“ファイル”を移す」までを対象にし、フォルダ移動は見送る。
  const items: { label: string; onClick: () => void; show?: boolean }[] = [
    { label: '🌐 ブラウザで開く', show: isHtml && !entry.isDir, onClick: () => window.electronAPI.shell.openPath(entry.path) },
    { label: '📁 Finder で表示', onClick: () => window.electronAPI.shell.showInFolder(entry.path) },
    { label: '📋 場所（パス）をコピー', onClick: () => navigator.clipboard.writeText(entry.path) },
    { label: '📋 名前をコピー', onClick: () => navigator.clipboard.writeText(entry.name) },
    { label: '✏️ 名前の変更', onClick: () => onRename(entry) },
    {
      label: published ? '📦 公開しないものへ移動' : '🌐 公開するものへ移動',
      show: !entry.isDir,
      onClick: () => onMove(entry, published),
    },
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

  // depth===0（プロジェクト直下）に `public/` があるか。移行後は「公開されるのは
  // public/ の中身だけ」になるので、いちばん上の階層だけ isPublished ではなく
  // isPublishedTop で分ける（下の階層は今までどおり isPublished。親の扱いに従う）。
  const hasPublishDir = depth === 0 && visible.some(e => e.isDir && e.name === PUBLISH_DIR)
  const publishedAt = (entry: FileEntry) =>
    depth === 0 ? isPublishedTop(entry.name, entry.isDir, hasPublishDir) : isPublished(entry.name, entry.isDir)

  const row = (entry: FileEntry) => {
    const published = publishedAt(entry)
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
            title={published ? entry.name : `${entry.name}（公開されません）`}
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

  // ── 公開されるもの／されないものを分けて見せる（2026-08-20 Ryosuke 要望「(1)」）──────
  // 実体は動かさない。**判定は publishExclude.ts の isPublished／isPublishedTop ひとつ**
  // なので、ここに出るものと、実際に公開先へ置かれるものは必ず一致する……はずだったが、
  // `public/` へ移行したプロジェクトでは isPublished だけでは一致しなかった
  // （直下のファイルは isPublished では「除外リストに無い＝公開される」と出るが、
  //  実際に公開先へ行くのは public/ の中身だけ。2026-08-27 発見）。
  // いちばん上の階層は isPublishedTop（`hasPublishDir` を見て分ける）を使うことで直した。
  // 分けるのはいちばん上の階層だけ（下の階層のものは、親の扱いに従う）。
  //
  // **片方が空でも、両方の見出しを出す**（2026-08-20 Ryosuke 指摘で改めた）。
  // 最初は「公開されないものが無ければ見出しを出さない」にしていたが、
  // それだと**分け方そのものが見えず、実機では「効いていない」ように見えた**。
  // 「気になる点だけ出す」は警告の話であって、**仕組みを示す見出しには当てはまらない**。
  if (depth === 0 && visible.length > 0) {
    const shown = visible.filter(e => publishedAt(e))
    const kept = visible.filter(e => !publishedAt(e))
    return (
      <>
        <GroupLabel text="公開されるもの" hint="このまま公開先に置かれます" />
        {shown.length > 0 ? <ul>{shown.map(row)}</ul> : <EmptyGroup />}
        <GroupLabel text="公開されないもの" hint="手元にだけ残ります" />
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

export default function Sidebar({ currentDir, onSetDir, onOpenFile, onNewProject, onOpenHistory, onOpenPublishedList, refreshKey = 0 }: Props) {
  // B-1b: 実行状態の置き場（chatTurnRegistry.ts）を購読し、実行中のプロジェクトに ⏳ を出す。
  // 値そのものは使わず（購読のたびに loadingKeys() を読み直す）、変わるたびに再描画させるためだけに呼ぶ。
  useSyncExternalStore(subscribe, getSnapshot)
  const loadingProjects = new Set(loadingKeys())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(0)
  /**
   * プロジェクト直下に `public/` があるか（W-23・2026-09-27）。
   * 右クリックメニュー・ファイル移動の「いま公開される側にいるか」（isMoveTargetPublished）に
   * 要る。FileTree が内部で持つのと同じ判定を、右クリックの瞬間に同期して使えるよう
   * Sidebar 側でも保つ（ファイル一覧と同じ理由で変わるたび読み直す）。
   */
  const [hasPublishDir, setHasPublishDir] = useState(false)
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
  /** ファイルの移動確認（判断9・2026-09-11）: window.confirm → ConfirmModal（Koto 様式）。 */
  const { confirm, element: confirmElement } = useConfirm()

  // 開いたプロジェクトを「最近」に記録
  useEffect(() => {
    if (!currentDir) return
    setRecents(prev => {
      const next = [currentDir, ...prev.filter(p => p !== currentDir)].slice(0, 10)
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
      return next
    })
  }, [currentDir])

  // ワークスペースのプロジェクト一覧を読み直す（スイッチャー表示時・未オープン時）。
  // 置き場は getWorkspaceDir()（選び直されていればそれ・無ければ既定。W-121・2026-09-27で
  // 既定を ~/Koto にした。すでに ~/SAKURAIDE がある人はそのまま）。
  // 以前は `~/SAKURAIDE` を直に組んでいて、ワークスペースを選び直した利用者には
  // 別の場所の一覧が出ていた（roadmap #7・2026-09-03 修正）。
  // 世代カウンタ: 並行して複数回呼ばれたとき、古い呼び出しのディスク読み取り結果が最新の状態
  // （例: 削除直後にフィルタ済みの一覧）を上書きして「削除したプロジェクトが復活して見える」のを防ぐ
  // （2026-07-13 ユーザー報告）。最新の呼び出しの結果だけを反映する。
  const wsLoadSeq = useRef(0)
  const loadWorkspaceProjects = async () => {
    const seq = ++wsLoadSeq.current
    try {
      const ws = await getWorkspaceDir()
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

  // public/ の有無を保つ（W-23）。ファイル一覧が更新されるたびに読み直す。
  useEffect(() => {
    if (!currentDir) { setHasPublishDir(false); return }
    let cancelled = false
    window.electronAPI.fs.exists(`${currentDir}/${PUBLISH_DIR}`).then(v => { if (!cancelled) setHasPublishDir(v) })
    return () => { cancelled = true }
  }, [currentDir, refreshKey, autoRefresh])

  const onContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault()
    const published = isMoveTargetPublished({
      currentDir, entryPath: entry.path, entryName: entry.name, entryIsDir: entry.isDir, hasPublishDir,
    })
    setMenu({ x: e.clientX, y: e.clientY, entry, published })
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
    const ok = await confirm({
      title: 'ファイルをゴミ箱へ移します',
      body: `「${entry.name}」をゴミ箱に移動します。よろしいですか？`,
      confirmLabel: 'ゴミ箱へ移す',
      danger: true,
    })
    if (!ok) return
    try {
      await window.electronAPI.fs.trash(entry.path)
      window.dispatchEvent(new CustomEvent('sakura:file-deleted', { detail: entry.path }))
    } catch (e: any) { window.alert(`削除できませんでした: ${e?.message ?? e}`) }
  }

  /**
   * roadmap #9②「ファイルの移動手段が無い」: 手で公開する／しない側を切り替える。
   * 移動先は、右クリックを開いた瞬間に isMoveTargetPublished が決めた向き（`published`）の逆
   * （公開される側にいれば素材置き場へ、それ以外は公開されるものへ・W-23）。
   * ディレクトリは ContextMenu 側で項目自体を出していないが、ここでも防御的に弾く（多層防御）。
   */
  const moveEntry = async (entry: FileEntry, published: boolean) => {
    if (!currentDir || entry.isDir) return
    const prefix = currentDir.endsWith('/') ? currentDir : `${currentDir}/`
    if (!entry.path.startsWith(prefix)) return // 想定外（プロジェクト外のパス）は何もしない
    const rel = entry.path.slice(prefix.length)
    const dest: 'materials' | 'publish' = published ? 'materials' : 'publish'
    const destDirName = dest === 'publish' ? PUBLISH_DIR : MATERIALS_DIR
    const destLabel = dest === 'publish' ? PUBLISH_DIR_LABEL : MATERIALS_DIR
    // public/ がまだ無いプロジェクトで初めて「公開するものへ移動」すると、public/ ができて
    // ほかの直下ファイルが一斉に「公開されないもの」へ移る（isPublishedTop の仕様）。
    // その影響を移動前に伝える（W-23 別案の確認文）。
    const willCreatePublishDir = dest === 'publish' && !hasPublishDir
    const ok = await confirm({
      title: 'ファイルを移動します',
      body: moveConfirmBody(entry.name, destLabel, willCreatePublishDir),
      confirmLabel: '移動する',
    })
    if (!ok) return
    try {
      const r = await window.electronAPI.fs.moveFiles(currentDir, [rel], dest)
      if (r.ok) {
        setAutoRefresh(n => n + 1) // ファイルツリーを更新（fs.watchDir の自動反映を待たず、その場で反映する）
        const renamedTo = r.renamed?.find(x => x.from === rel)?.to
        // 開いているタブが古いパスを指したままだと、次のオートセーブで消したはずのファイルを
        // 復活させてしまう（削除・名前変更と同じ理由でここも通知する）。
        window.dispatchEvent(new CustomEvent('sakura:file-renamed', {
          detail: { from: entry.path, to: `${currentDir}/${destDirName}/${renamedTo ?? entry.name}` },
        }))
        if (renamedTo) window.alert(`「${entry.name}」と同じ名前が移動先にあったため、「${renamedTo}」にしました。`)
      } else {
        window.alert(`移動できませんでした: ${r.message ?? '原因不明'}`)
      }
    } catch (e: any) {
      window.alert(`移動できませんでした: ${e?.message ?? e}`)
    }
  }

  // プロジェクトの削除（フォルダごとゴミ箱へ移動・Finderのゴミ箱から復元可能）の確認ダイアログは ProjectDeleteDialog（開いたときの読み込み・
  // 破棄・フォルダを移す操作はそこ）。ここに残すのは、フォルダを移したあとの後始末だけ。
  const afterProjectDeleted = async (path: string) => {
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
              title="🕘 履歴（前の状態に戻す）"
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
            title="一覧を更新"
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
                {/* B-1b: 実行状態がプロジェクト別になった副産物として、いま見ているプロジェクトが
                    実行中かどうかが分かるようにする（控えめに絵文字1つだけ）。 */}
                {loadingProjects.has(currentDir) && <span className="flex-none text-[11px]" title="AIが作業中です">⏳</span>}
                <span className="text-[9px] text-ink-muted group-hover:text-sakura flex-none">▾</span>
              </button>
              {projMenu && (
                <div
                  className="absolute left-2 right-2 top-full z-50 mt-0.5 bg-elevated border border-line rounded-lg shadow-lg py-1 max-h-80 overflow-y-auto"
                  onClick={e => e.stopPropagation()}
                >
                  {workspaceProjects.length > 0 && (
                    <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold text-ink-muted uppercase tracking-widest">プロジェクト</div>
                  )}
                  {workspaceProjects.map(p => (
                    <div key={p} className="flex items-center hover:bg-overlay transition-colors">
                      <button
                        onClick={() => switchProject(p)}
                        className="flex-1 min-w-0 flex items-center gap-1.5 text-left px-3 py-1.5 text-[13px] text-ink"
                      >
                        <span className="w-3 flex-none text-sakura">{p === currentDir ? '✓' : ''}</span>
                        <span className="truncate">{p.split('/').pop()}</span>
                        {/* ⚠️（見てほしい）は ⏳（作業中）より優先。見ているプロジェクト（currentDir）には
                            出さない＝吹き出しやダイアログ自体が見えているから（B-2）。 */}
                        {p !== currentDir && getTurn(p).attention ? (
                          <span className="flex-none text-[11px]" title={getTurn(p).attention === 'approval' ? 'AIが許可を待っています' : 'エラーで止まりました。開いて確認してください'}>⚠️</span>
                        ) : loadingProjects.has(p) && <span className="flex-none text-[11px]" title="AIが作業中です">⏳</span>}
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
                      {/* ⚠️ 優先・見ているプロジェクトには出さない（上のワークスペース一覧と同じ理由） */}
                      {p !== currentDir && getTurn(p).attention ? (
                        <span className="flex-none text-[11px]" title={getTurn(p).attention === 'approval' ? 'AIが許可を待っています' : 'エラーで止まりました。開いて確認してください'}>⚠️</span>
                      ) : loadingProjects.has(p) && <span className="flex-none text-[11px]" title="AIが作業中です">⏳</span>}
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
            {/* 判断3（2026-09-11）: プロジェクトを開いていないときの唯一の入口。
                これまでは OSメニュー「表示 → 公開したもの一覧…」と、プロジェクトを開いた
                【公開】の奥のリンクからしか開けなかった。掟11: これは「見てほしい印」ではなく
                常設してよい入口なので、プロジェクトの有無に関わらず一覧の上に常に出す。 */}
            {onOpenPublishedList && (
              <button
                onClick={onOpenPublishedList}
                className="w-full text-left text-[12px] text-sakura hover:underline mb-3"
              >📡 公開したものと費用を見る</button>
            )}
            {/* 仕様変更（2026-07-14 ユーザー要望）: プロジェクトが既に有るときは「初期セットアップ風の
                大きなブロック」を出さず、一覧を主役にする。新規作成・フォルダを開くは一覧の下に小さく置く。
                ヒーローブロック（ロゴ＋大ボタン）はプロジェクトが1つも無いときだけ表示する。 */}
            {(workspaceProjects.length > 0 || recents.filter(p => !workspaceProjects.includes(p)).length > 0) ? (
              <>
                {workspaceProjects.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold text-ink-muted uppercase tracking-widest mb-1 px-1">プロジェクト</div>
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
          onMove={(entry, published) => { void moveEntry(entry, published) }}
        />
      )}

      {/* プロジェクト削除の確認ダイアログ（掟5: 破壊操作は必ず確認）。key で、別のプロジェクトを開き直したときに前の材料・チェックを持ち越さない（掟11）。 */}
      {confirmProjDelete && (
        <ProjectDeleteDialog
          key={confirmProjDelete}
          projectDir={confirmProjDelete}
          onClose={() => setConfirmProjDelete(null)}
          onDeleted={afterProjectDeleted}
        />
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
                if (isSubmitEnter(e)) { e.preventDefault(); submitNameDialog() }
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
      {confirmElement}
    </div>
  )
}
