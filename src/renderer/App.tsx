import React, { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type { Layout } from 'react-resizable-panels'
import Sidebar from './components/Sidebar'
import ChatPanel from './components/ChatPanel'
import ChatApp from './components/ChatApp'
import TerminalPanel, { TermExec } from './components/TerminalPanel'
import PublishModal from './components/PublishModal'
import ServerFilesModal from './components/ServerFilesModal'
import WorkflowBar, { ProjectMeta } from './components/WorkflowBar'
import StatusBar from './components/StatusBar'
import TitleBar, { AppMode } from './components/TitleBar'
import NewProjectModal from './components/NewProjectModal'
import SettingsModal from './components/SettingsModal'
import CredentialsModal, { getAiEngineKeyInfo } from './components/CredentialsModal'
import OnboardingModal from './components/OnboardingModal'
import KnowledgeModal from './components/KnowledgeModal'
import HistoryModal from './components/HistoryModal'
import GithubSaveModal from './components/GithubSaveModal'
import PublishedListModal from './components/PublishedListModal'
import { useFileDrag } from './hooks/useFileDrag'
import { resolvePublishRoot } from './publishRootRenderer'
import { cleanAiRelPath } from '../shared/publishRoot'
import { primeLearningMirror } from './learningMirror'
import { primeUsageMirror } from './usageMirror'

const EditorPanel = lazy(() => import('./components/EditorPanel'))

export type Theme = 'dark' | 'light'

export interface OpenFile {
  path: string
  name: string
  content: string
  isDirty: boolean
  language: string
}

function loadLayout(id: string): Layout | undefined {
  try {
    const raw = localStorage.getItem(`sakura_layout_v2_${id}`)
    return raw ? JSON.parse(raw) : undefined
  } catch { return undefined }
}

function saveLayout(id: string, layout: Layout) {
  try { localStorage.setItem(`sakura_layout_v2_${id}`, JSON.stringify(layout)) } catch {}
}

const IMAGE_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
}

function imageMime(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXT[ext] ?? null
}

/** ファイルを OpenFile として読み込む（画像は data URL にしてプレビュー表示用にする） */
async function loadOpenFile(filePath: string): Promise<OpenFile> {
  const name = filePath.split('/').pop() ?? filePath
  const mime = imageMime(name)
  if (mime) {
    const b64 = await window.electronAPI.fs.readFileBase64(filePath)
    return { path: filePath, name, content: `data:${mime};base64,${b64}`, isDirty: false, language: 'image' }
  }
  const content = await window.electronAPI.fs.readFile(filePath)
  return { path: filePath, name, content, isDirty: false, language: detectLanguage(name) }
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', cs: 'csharp',
    cpp: 'cpp', c: 'c', h: 'c', rb: 'ruby', php: 'php',
    html: 'html', css: 'css', scss: 'scss', json: 'json',
    yaml: 'yaml', yml: 'yaml', md: 'markdown', sh: 'shell',
    sql: 'sql', kt: 'kotlin', swift: 'swift',
  }
  return map[ext] ?? 'plaintext'
}

export default function App() {
  const [mode, setMode] = useState<AppMode>(() =>
    (localStorage.getItem('sakura_mode') as AppMode) ?? 'ide'
  )
  const [theme, setTheme] = useState<Theme>(() =>
    // 既定はライト（2026-07-17 ユーザー要望）。一度でも切り替えれば localStorage の選択が優先。
    (localStorage.getItem('sakura_theme') as Theme) ?? 'light'
  )
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [showChat, setShowChat] = useState(true)
  /** 画面全体にファイルを重ねているか（落とせることを見せる）。 */
  const windowDrag = useFileDrag()
  // いまファイル一覧の上に居るか（案内の文面を切り替えるだけ）
  const [overTree, setOverTree] = useState(false)
  const [showTerminal, setShowTerminal] = useState(true)
  const [currentDir, setCurrentDir] = useState<string | null>(null)
  // プロジェクトの形が変わった合図（ファイル一覧の更新と、各画面の「根」の取り直しに使う）。
  const [treeRefresh, setTreeRefresh] = useState(0)
  // ターミナルを開く場所も`public/` に揃える（2026-08-20）。
  // ここがずれると、アプリ型で `npm install` が別の場所に入ってしまう。
  const [termDir, setTermDir] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!currentDir) { setTermDir(null); return }
    void resolvePublishRoot(currentDir).then(r => { if (!cancelled) setTermDir(r || currentDir) })
    return () => { cancelled = true }
  }, [currentDir, treeRefresh])
  const [showNewProject, setShowNewProject] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showCredentials, setShowCredentials] = useState(false)
  const [showPublish, setShowPublish] = useState(false)
  // 「表示 → 公開したもの一覧…」（メニューから開く。プロジェクト未オープンでも見られる）
  const [showPublishedList, setShowPublishedList] = useState(false)
  const [showServer, setShowServer] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [showKnowledge, setShowKnowledge] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showGithubSave, setShowGithubSave] = useState(false)
  const [termExec, setTermExec] = useState<TermExec | null>(null)

  // 公開コマンドをターミナルで実行（ターミナルが隠れていれば表示する）
  const runInTerminal = useCallback((cmd: string) => {
    setShowTerminal(true)
    setTermExec(prev => ({ cmd, seq: (prev?.seq ?? 0) + 1 }))
  }, [])

  // 実行中プロセスへ Ctrl+C を送る（②試すで起動したサーバーの停止用）
  const stopInTerminal = useCallback(() => {
    setShowTerminal(true)
    setTermExec(prev => ({ cmd: '\x03', seq: (prev?.seq ?? 0) + 1 }))
  }, [])

  // プロジェクトのメタ情報（.sakuraide.json）。ワークフローバー・ステータスバーで使う
  const [projectMeta, setProjectMeta] = useState<ProjectMeta | null>(null)
  const reloadMeta = useCallback(async (dir: string | null) => {
    if (!dir) { setProjectMeta(null); return }
    try {
      const raw = await window.electronAPI.fs.readFile(`${dir}/.sakuraide.json`)
      setProjectMeta(JSON.parse(raw))
    } catch { setProjectMeta(null) } // メタ無し（既存フォルダ等）
  }, [])
  useEffect(() => { reloadMeta(currentDir) }, [currentDir, reloadMeta])
  useEffect(() => {
    const h = () => reloadMeta(currentDir)
    window.addEventListener('sakura-meta-changed', h)
    return () => window.removeEventListener('sakura-meta-changed', h)
  }, [currentDir, reloadMeta])

  // 公開先（target）を後から変更する。.sakuraide.json の target だけ上書きし、
  // 既存フィールド（name/description/publish 等）はマージで保持する。
  const changeTarget = useCallback(async (newTarget: string) => {
    if (!currentDir) return
    const path = `${currentDir}/.sakuraide.json`
    let meta: any = {}
    try {
      const raw = await window.electronAPI.fs.readFile(path)
      meta = JSON.parse(raw)
    } catch { /* メタ無し（既存フォルダ等）→ 新規に作る */ }
    meta.target = newTarget
    await window.electronAPI.fs.writeFile(path, JSON.stringify(meta, null, 2))
    // メタ再読込 → 公開先変更をAIへ促す通知
    window.dispatchEvent(new Event('sakura-meta-changed'))
    window.dispatchEvent(new CustomEvent('sakura-target-changed', { detail: { target: newTarget } }))
  }, [currentDir])

  // ワークフローバー「① 作る」→ AIチャットへフォーカス
  const focusChat = useCallback(() => {
    setShowChat(true)
    // ChatPanel 側がこのイベントで入力欄にフォーカスする
    setTimeout(() => window.dispatchEvent(new Event('sakura:focus-chat')), 50)
  }, [])

  // ── 「AIに修正させる」を押したら、AIが働く様子が見える場所へ移す（2026-08-19）──
  // 実機（Ryosuke）: 公開の画面を開いたまま裏でAIが動き、**何が起きているのか
  // 分からなかった**。押した人の目的は「直してもらうこと」なので、
  // 公開の画面を閉じてチャットを前に出す（送信は ChatPanel 側が行う）。
  useEffect(() => {
    const h = () => {
      setShowPublish(false)
      setShowChat(true)
      setMode('ide') // チャットモードにはプロジェクトのファイルを直す道具が無い
    }
    window.addEventListener('sakura:fix-with-ai', h)
    return () => window.removeEventListener('sakura:fix-with-ai', h)
  }, [])

  // 起動時に1度だけ、モデルの学習キャッシュ（ツール対応・画像対応）の写しを作る（B'-3d-1a）。
  // 読みが要るのは送信時・モデル選択時・ChatPanel の表示ヒントだけで、初回描画の同期読みには
  // 使われないため、非同期プライムで足りる（learningMirror.ts のコメント参照）。
  // 予算設定・利用実績の写し（B'-3d-1b）も同じ理由で並べて作る（usageMirror.ts のコメント参照）。
  useEffect(() => { primeLearningMirror(); primeUsageMirror() }, [])

  // メニューバー「認証情報（APIキー）…」から開く
  useEffect(() => {
    return window.electronAPI.app.onOpenCredentials(() => setShowCredentials(true))
  }, [])

  // メニューバー「表示 → 公開したもの一覧…」から開く
  useEffect(() => {
    return window.electronAPI.app.onOpenPublished(() => setShowPublishedList(true))
  }, [])

  // メニューバー「Koto → 設定…」（⌘,）から開く。
  // 設定（⚙️）が画面の中にしか無く、メニューから探した利用者が辿り着けなかった（2026-08-11 Ryosuke 指摘）
  useEffect(() => {
    return window.electronAPI.app.onOpenSettings(() => setShowSettings(true))
  }, [])
  const [sakuraApiKey, setSakuraApiKey] = useState('')
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.electronAPI.app.getVersion().then(setVersion).catch(() => {})
  }, [])

  // 文書（ウィンドウ全体）のスクロールを常に (0,0) に固定するガード。
  // このアプリは html/body overflow:hidden で各領域が内側スクロールする設計だが、
  // scrollIntoView 等のブラウザ挙動は overflow:hidden でも祖先＝文書のスクロール位置を動かせる。
  // コンテンツが窓幅を超えているときに文書が横スクロールすると、アプリ全体がずれて
  // 「左端に前の画面のアイコンの切れ端が残って見える」原因になった（2026-07-14 ユーザー報告）。
  // 個別の scrollIntoView は内側スクロールに置換済みだが、将来の混入（Monaco/xterm/フォーカス移動等）に
  // 備えて文書スクロールを検知したら即座に戻す。window の scroll イベントは文書スクロールのみで発火する
  // （内側要素のスクロールはバブルしない）ため、通常操作への影響は無い。
  useEffect(() => {
    const reset = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0)
      const de = document.documentElement
      if (de.scrollLeft !== 0 || de.scrollTop !== 0) { de.scrollLeft = 0; de.scrollTop = 0 }
    }
    reset()
    window.addEventListener('scroll', reset, { passive: true })
    return () => window.removeEventListener('scroll', reset)
  }, [])

  // APIキーの起動時読み込み。
  // C-1修正（2026-07-13 ユーザー報告「削除したキーが復活する」）: 認証情報の中央ストア
  // （sakura_credentials_enc・CredentialsModal が管理）を「正」とする。ストアが存在する場合、
  // アプリ側の旧位置（sakura_api_key / sakura_api_key_enc）は複製＝復活の種になるため常に掃除する。
  // ストアがまだ無い場合（初回・旧バージョンから）だけ旧位置から読む（後で認証情報を開くと移行される）。
  useEffect(() => {
    ;(async () => {
      let found = false
      try {
        const info = await getAiEngineKeyInfo()
        if (info.storeExists) {
          localStorage.removeItem('sakura_api_key')
          localStorage.removeItem('sakura_api_key_enc')
          if (info.key) { setSakuraApiKey(info.key); found = true }
          return
        }
        const plain = localStorage.getItem('sakura_api_key')
        if (plain) {
          const enc = await window.electronAPI.secure.encrypt(plain)
          if (enc) {
            localStorage.setItem('sakura_api_key_enc', enc)
            localStorage.removeItem('sakura_api_key')
          }
          setSakuraApiKey(plain)
          found = true
          return
        }
        const enc = localStorage.getItem('sakura_api_key_enc')
        if (enc) {
          const dec = await window.electronAPI.secure.decrypt(enc)
          if (dec) { setSakuraApiKey(dec); found = true }
        }
      } catch { /* 読み込み失敗時はキー未設定として扱う */ }
      finally {
        // キー未設定かつ未オンボーディングなら初回案内を表示
        if (!found && !localStorage.getItem('sakura_onboarded')) {
          setShowOnboarding(true)
        }
      }
    })()
  }, [])

  const switchMode = (m: AppMode) => {
    setMode(m)
    localStorage.setItem('sakura_mode', m)
  }

  const switchTheme = (t: Theme) => {
    setTheme(t)
    localStorage.setItem('sakura_theme', t)
  }

  const setApiKey = useCallback(async (key: string) => {
    setSakuraApiKey(key)
    try {
      // C-1修正: キーが空（＝ユーザーが削除して保存）のときは旧位置の複製も必ず消す。
      // 残すと次回起動時に「削除したはずのキーが復活する」原因になる。
      if (!key.trim()) {
        localStorage.removeItem('sakura_api_key')
        localStorage.removeItem('sakura_api_key_enc')
        return
      }
      const enc = await window.electronAPI.secure.encrypt(key)
      if (enc) {
        localStorage.setItem('sakura_api_key_enc', enc)
        localStorage.removeItem('sakura_api_key')
      } else {
        // 暗号化が使えない環境ではフォールバック（従来通り）
        localStorage.setItem('sakura_api_key', key)
      }
    } catch {
      localStorage.setItem('sakura_api_key', key)
    }
  }, [])

  const openFile = useCallback(async (filePath: string) => {
    const existing = openFiles.find(f => f.path === filePath)
    if (existing) { setActiveFile(filePath); return }
    const file = await loadOpenFile(filePath)
    setOpenFiles(prev => [...prev, file])
    setActiveFile(filePath)
  }, [openFiles])

  // ── 自分で編集したときの履歴（🕘）────────────────────────────────────────────
  // AIの変更だけでなく、エディタで自分が書き換えた内容も「前の状態に戻す」の対象にする
  // （2026-08-05 の利用者要望。これが無いと、時点復元のときに自分の編集だけが退避されず消える）。
  // オートセーブが1.5秒ごとに走るため1回ずつ履歴に積むと一覧が埋まる。一定時間内の手動保存は
  // 同じスナップショットにまとめる（同一ファイルの2回目以降は退避しない＝「編集を始める前」が残る）。
  const MANUAL_SNAPSHOT_GROUP_MS = 5 * 60 * 1000
  const manualSnapshotRef = useRef<{ dir: string; id: string; at: number } | null>(null)
  const snapshotBeforeManualSave = useCallback(async (filePath: string, content: string) => {
    if (!currentDir || !filePath.startsWith(currentDir + '/')) return // プロジェクト外のファイルは対象外
    const rel = filePath.slice(currentDir.length + 1)
    const now = Date.now()
    const g = manualSnapshotRef.current
    const id = g && g.dir === currentDir && now - g.at < MANUAL_SNAPSHOT_GROUP_MS
      ? g.id
      : new Date().toISOString().replace(/[:.]/g, '-')
    manualSnapshotRef.current = { dir: currentDir, id, at: now }
    try {
      await window.electronAPI.backup.snapshotBeforeWrite(currentDir, id, rel, content, '自分で編集して保存')
    } catch { /* 履歴の失敗で保存を止めない */ }
  }, [currentDir])

  const saveFile = useCallback(async (filePath: string, content: string) => {
    await snapshotBeforeManualSave(filePath, content)
    await window.electronAPI.fs.writeFile(filePath, content)
    setOpenFiles(prev => prev.map(f => f.path === filePath ? { ...f, content, isDirty: false } : f))
  }, [snapshotBeforeManualSave])

  const updateFileContent = useCallback((filePath: string, content: string) => {
    setOpenFiles(prev => prev.map(f => f.path === filePath ? { ...f, content, isDirty: true } : f))
  }, [])

  const closeFile = useCallback((filePath: string) => {
    setOpenFiles(prev => {
      const next = prev.filter(f => f.path !== filePath)
      if (activeFile === filePath) setActiveFile(next[next.length - 1]?.path ?? null)
      return next
    })
  }, [activeFile])

  // AIが生成したファイルをプロジェクトに適用（保存→エディタで開く→ツリー更新）
  //
  // root: 書き込む根（省略時は currentDir にフォールバック）。
  // ── なぜ root を受け取るか（2026-08-27 発見の不具合）─────────────────────
  // ChatPanel は AI の読み書きの根として writeRoot（public/ があればその中）を
  // 別に持っている。ここが currentDir 決め打ちだと、public/ を持つプロジェクトで
  // 「AIが書いたファイルが public/ の外（プロジェクト直下）へ出る」——退避（🕘）の
  // 記録は public/ 前提で作られるので「元に戻す」も効かなくなる。
  const applyAiFile = useCallback(async (relPath: string, content: string, root?: string | null) => {
    let base = root ?? currentDir
    if (!base) {
      base = await window.electronAPI.fs.pickDirectory()
      if (!base) throw new Error('保存先のフォルダが選択されていません')
      setCurrentDir(base)
    }
    const clean = cleanAiRelPath(relPath) // 一元定義（shared/publishRoot.ts・掟10）
    const full = `${base}/${clean}`
    // AIが書き換えた後の手動編集は、別の履歴として積む（同じグループに入れると
    // 「AIの成果物」が退避されないまま自分の編集で上書きされ、戻せなくなる）
    manualSnapshotRef.current = null
    await window.electronAPI.fs.writeFile(full, content)
    setTreeRefresh(n => n + 1)
    // エディタで開く / 既に開いていれば内容を更新
    const name = full.split('/').pop() ?? full
    setOpenFiles(prev => {
      const ex = prev.find(f => f.path === full)
      if (ex) return prev.map(f => f.path === full ? { ...f, content, isDirty: false } : f)
      return [...prev, { path: full, name, content, isDirty: false, language: detectLanguage(name) }]
    })
    setActiveFile(full)
  }, [currentDir])

  // AIがmainプロセス側（B'-3d-2b・チャットの main 直実行）で書いたファイルを、エディタへ反映する。
  //
  // ── applyAiFile と何が違うか ─────────────────────────────────────────
  // applyAiFile は「保存も表示も renderer が行う」経路（手元にある content をそのまま使う）。
  // こちらは main の io.applyFile が既にディスクへ保存し終えたあとの通知（ChatEvent
  // 'aiFileWritten'）を受けて、**表示だけ**を行う。手元に content が無いため、必ずディスクから
  // 読み直す（loadOpenFile。applyRestoreResult と同じ作法）。
  //
  // 掟11（環境の独立）: このイベントは「いま見ているプロジェクトの分だけ」開く。呼び出し側
  // （ChatPanel）が projectDir の一致を確認してから呼ぶので、ここでは常に「いま見ている分」として扱う。
  const showAiFileInEditor = useCallback(async (full: string) => {
    // AIが書き換えた後の手動編集は、別の履歴として積む（applyAiFile と同じ理由）
    manualSnapshotRef.current = null
    setTreeRefresh(n => n + 1)
    try {
      const file = await loadOpenFile(full)
      setOpenFiles(prev => {
        const ex = prev.find(f => f.path === full)
        if (ex) return prev.map(f => f.path === full ? file : f)
        return [...prev, file]
      })
      setActiveFile(full)
    } catch { /* 直後に消える等で読めなくても、開いていなければ実害は無い */ }
  }, [])

  // 「🕘 履歴」からの復元結果をエディタ・ツリーへ反映する。
  // 復元されたタブはディスクから読み直し（isDirty:false ＝ オートセーブが古い内容で上書きしないように）、
  // 削除されたファイルのタブは閉じる。ツリーは fs watcher でも更新されるが、即時反映のため明示更新する。
  const applyRestoreResult = useCallback(async (restoredRel: string[], deletedRel: string[]) => {
    if (!currentDir) return
    // 復元後・Claudeの書き込み後の手動編集は別の履歴として積む（applyAiFile と同じ理由）
    manualSnapshotRef.current = null
    const restoredAbs = new Set(restoredRel.map(r => `${currentDir}/${r}`))
    const deletedAbs = new Set(deletedRel.map(r => `${currentDir}/${r}`))
    const reloaded = new Map<string, OpenFile>()
    for (const f of openFiles) {
      if (restoredAbs.has(f.path)) {
        try { reloaded.set(f.path, await loadOpenFile(f.path)) } catch { /* 読めなければ据え置き */ }
      }
    }
    setOpenFiles(prev => prev
      .filter(f => !deletedAbs.has(f.path))
      .map(f => reloaded.get(f.path) ?? f))
    setActiveFile(prev => (prev && deletedAbs.has(prev)) ? null : prev)
    setTreeRefresh(n => n + 1)
  }, [currentDir, openFiles])

  const activeFileObj = openFiles.find(f => f.path === activeFile) ?? null
  const anyDirty = openFiles.some(f => f.isDirty)

  // ── ③ 前回の状態を復元（マウント時に1回）。タブはプロジェクト（フォルダ）ごとに保存する ──
  const [restored, setRestored] = useState(false)
  // いま openFiles がどのプロジェクトのものか。切替中の誤保存を避けるために保持する。
  const loadedDirRef = useRef<string | null>(null)
  const tabsKey = (dir: string) => `sakura_tabs:${dir}`

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const dir = localStorage.getItem('sakura_current_dir')
        if (dir && !cancelled) setCurrentDir(dir)
        // プロジェクト別キーを優先。無ければ旧・共通キー（sakura_open_tabs）を移行用に読む。
        const raw = (dir ? localStorage.getItem(tabsKey(dir)) : null) ?? localStorage.getItem('sakura_open_tabs')
        if (raw) {
          const { paths, active } = JSON.parse(raw) as { paths: string[]; active: string | null }
          const files: OpenFile[] = []
          for (const p of paths ?? []) {
            try {
              files.push(await loadOpenFile(p))
            } catch { /* 移動・削除されたファイルはスキップ */ }
          }
          if (!cancelled && files.length) {
            setOpenFiles(files)
            setActiveFile(files.some(f => f.path === active) ? active : files[files.length - 1].path)
          }
        }
        loadedDirRef.current = dir // 現在のタブはこの dir のもの
      } catch { /* 復元失敗は無視 */ }
      finally { if (!cancelled) setRestored(true) }
    })()
    return () => { cancelled = true }
  }, [])

  // 現在のフォルダを保存
  useEffect(() => {
    if (!restored) return
    if (currentDir) localStorage.setItem('sakura_current_dir', currentDir)
    else localStorage.removeItem('sakura_current_dir')
  }, [currentDir, restored])

  // プロジェクトを切り替えたら、そのプロジェクトのタブに入れ替える（他プロジェクトのタブは閉じる）。
  // 次に戻ってきたときは、そのプロジェクトで開いていたタブが復元される。
  useEffect(() => {
    if (!restored) return
    if (loadedDirRef.current === currentDir) return // 既に読込済み（初期復元・保存の再実行など）
    let cancelled = false
    ;(async () => {
      const raw = currentDir ? localStorage.getItem(tabsKey(currentDir)) : null
      const files: OpenFile[] = []
      let active: string | null = null
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { paths: string[]; active: string | null }
          active = parsed.active
          for (const p of parsed.paths ?? []) {
            try { files.push(await loadOpenFile(p)) } catch { /* 消えたファイルはスキップ */ }
          }
        } catch { /* 壊れていたら空で開始 */ }
      }
      if (cancelled) return
      setOpenFiles(files)
      setActiveFile(files.some(f => f.path === active) ? active : (files.length ? files[files.length - 1].path : null))
      loadedDirRef.current = currentDir
    })()
    return () => { cancelled = true }
  }, [currentDir, restored])

  // 開いているタブをプロジェクト別に保存（切替の途中＝新タブ読込前は保存しない）。
  useEffect(() => {
    if (!restored) return
    if (!currentDir || loadedDirRef.current !== currentDir) return
    localStorage.setItem(tabsKey(currentDir), JSON.stringify({
      paths: openFiles.map(f => f.path),
      active: activeFile,
    }))
  }, [openFiles, activeFile, currentDir, restored])

  // ── ② オートセーブ（編集停止から1.5秒後に未保存を保存） ──
  const autosaveTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    const dirty = openFiles.filter(f => f.isDirty)
    if (dirty.length === 0) return
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    autosaveTimer.current = window.setTimeout(() => {
      dirty.forEach(f => saveFile(f.path, f.content))
    }, 1500)
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current) }
  }, [openFiles, saveFile])

  // ツリーでの削除・リネームをエディタのタブに反映（消えたファイルの自動再保存を防ぐ）
  useEffect(() => {
    const onDeleted = (e: Event) => {
      const p = (e as CustomEvent).detail as string
      setOpenFiles(prev => prev.filter(f => f.path !== p && !f.path.startsWith(p + '/')))
      setActiveFile(prev => (prev === p || prev?.startsWith(p + '/')) ? null : prev)
    }
    const onRenamed = (e: Event) => {
      const { from, to } = (e as CustomEvent).detail as { from: string; to: string }
      setOpenFiles(prev => prev.map(f => {
        if (f.path === from) return { ...f, path: to, name: to.split('/').pop() ?? to }
        if (f.path.startsWith(from + '/')) return { ...f, path: to + f.path.slice(from.length) }
        return f
      }))
      setActiveFile(prev => prev === from ? to : (prev?.startsWith(from + '/') ? to + prev.slice(from.length) : prev))
    }
    window.addEventListener('sakura:file-deleted', onDeleted)
    window.addEventListener('sakura:file-renamed', onRenamed)
    return () => {
      window.removeEventListener('sakura:file-deleted', onDeleted)
      window.removeEventListener('sakura:file-renamed', onRenamed)
    }
  }, [])

  // 絶対パスのファイルをエディタで開くイベント（サーバ操作モーダル等から利用）
  useEffect(() => {
    const onOpen = (e: Event) => {
      const p = (e as CustomEvent).detail as string
      if (typeof p === 'string' && p) openFile(p)
    }
    window.addEventListener('sakura:open-file', onOpen)
    return () => window.removeEventListener('sakura:open-file', onOpen)
  }, [openFile])

  // ── ① 未保存状態をメインへ通知（終了時の警告に使う） ──
  useEffect(() => {
    window.electronAPI.win.setDirty(anyDirty)
  }, [anyDirty])

  // ── ①「保存して終了」選択時：全保存してから終了 ──
  useEffect(() => {
    return window.electronAPI.win.onSaveAll(async () => {
      const dirty = openFiles.filter(f => f.isDirty)
      // 終了時の一括保存も履歴に残す（saveFile と同じ扱い。ここだけ抜けると戻せない編集ができる）
      await Promise.all(dirty.map(f => snapshotBeforeManualSave(f.path, f.content)))
      await Promise.all(dirty.map(f => window.electronAPI.fs.writeFile(f.path, f.content)))
      await window.electronAPI.win.quitAfterSave()
    })
  }, [openFiles, snapshotBeforeManualSave])

  return (
    <div className={`${theme === 'light' ? 'theme-light' : ''} flex flex-col h-screen bg-base text-ink overflow-hidden`}>
      <TitleBar
        mode={mode}
        onSwitchMode={switchMode}
        theme={theme}
        onSwitchTheme={switchTheme}
        showChat={showChat}
        showTerminal={showTerminal}
        onToggleChat={() => setShowChat(v => !v)}
        onToggleTerminal={() => setShowTerminal(v => !v)}
        onOpenSettings={() => setShowSettings(true)}
        onPublish={() => {
          if (!currentDir) { window.alert('先にプロジェクトを開いてください（公開対象のプロジェクトが必要です）') ; return }
          setShowPublish(true)
        }}
        onOpenKnowledge={() => setShowKnowledge(true)}
        onOpenGithubSave={() => {
          if (!currentDir) { window.alert('先にプロジェクトを開いてください') ; return }
          setShowGithubSave(true)
        }}
        onOpenHistory={() => {
          if (!currentDir) { window.alert('先にプロジェクトを開いてください（履歴はプロジェクトごとに記録されます）') ; return }
          setShowHistory(true)
        }}
        version={version}
      />

      {/* 作る → 試す → 公開 のワークフローバー（IDEモードでプロジェクトを開いている時） */}
      {mode === 'ide' && currentDir && (
        <WorkflowBar
          projectDir={currentDir}
          refreshKey={treeRefresh}
          meta={projectMeta}
          onFocusChat={focusChat}
          onRunCmd={runInTerminal}
          onStopCmd={stopInTerminal}
          onOpenPublish={() => setShowPublish(true)}
          onChangeTarget={changeTarget}
          onOpenServer={() => setShowServer(true)}
        />
      )}

      <div className="flex-1 overflow-hidden">
        {/* ⚠️ ChatApp は**アンマウントせず隠す**（2026-08-29 実機で発覚）。
            単独チャットの会話はまだこの ChatApp の React state が持ち主（B'-3c はプロジェクト
            会話だけを main に移した）。IDE モードへの切替でアンマウントすると、走っている
            ターンの返事の行き先とセッション保存の effect が消え、**返事が失われる**。
            本修理（セッションの持ち主を main へ移す）は B'-3e。 */}
        <div className={mode === 'chat' ? 'h-full fade-in bg-base' : 'hidden'}>
          <ChatApp apiKey={sakuraApiKey} onSetApiKey={setApiKey} onOpenCredentials={() => setShowCredentials(true)} onApplyFile={applyAiFile} />
        </div>
        {mode === 'ide' && (
          <Group
            orientation="horizontal"
            id="sakura-ide-h"
            defaultLayout={loadLayout('sakura-ide-h')}
            onLayoutChanged={l => saveLayout('sakura-ide-h', l)}
            className="h-full fade-in flex relative"
            /* ── どこに落としても受け取る（2026-08-19 Ryosuke 指摘）──────────────
               これまで受け取れたのは「ファイル一覧」と「チャットの履歴」だけで、
               **エディタの上に落としても無反応**だった。落とせる場所が見た目で
               分からないので、画面全体で受ける。
               ファイル一覧の上に落としたときは、そちらの動き（プロジェクトへ取り込む）
               が優先される（Sidebar 側で止めている）。 */
            /* 表示の出し入れは useFileDrag が持つ（2026-08-19 実機）。
               ここで自前に持っていたときは、**窓の外へ出したときに消えず**、
               受け入れたままの見た目で操作できなくなった。 */
            onDragOver={e => {
              // 落とす先で結果が変わるのは**ファイル一覧だけ**。どこに居るかを見て文面を変える
              setOverTree(!!(e.target as HTMLElement | null)?.closest?.('[data-drop="tree"]'))
              windowDrag.onDragOver(e)
            }}
            onDragLeave={windowDrag.onDragLeave}
            onDrop={e => {
              if (!e.dataTransfer.files?.length) return
              e.preventDefault(); windowDrag.end()
              // ChatPanel が受け取って添付にする（同じ道を2つ持たない）
              window.dispatchEvent(new CustomEvent('sakura:attach-images', { detail: { files: e.dataTransfer.files } }))
            }}
          >
            {/* ── 案内はひとつだけ（2026-08-19 実機・Ryosuke 指摘）────────────────
                以前は「ファイル一覧」と「チャット」だけが受け口で、その2か所を
                桜色の枠で光らせていた。**いまは画面全体で受ける**ので、枠と
                全体の案内が二重に出て「以前の名残」に見えていた。
                出すのはこの1つにし、**ファイル一覧の上だけ文面を変える**
                （そこだけ結果が違う＝プロジェクトへ取り込む）。 */}
            {windowDrag.over && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-base/60 pointer-events-none">
                <span className="text-sm font-semibold text-sakura bg-surface border border-sakura rounded-xl px-4 py-2">
                  {overTree
                    ? '📥 ここに落とすと、プロジェクトに取り込みます'
                    : '🖼 ここに落とすと、AIに見せます（そのあと「📁 画像を使う」でプロジェクトにも入れられます）'}
                </span>
              </div>
            )}
            {/* Sidebar */}
            <Panel id="sidebar" defaultSize="18%" minSize="12%" maxSize="32%">
              <div className="h-full bg-surface">
                <Sidebar
                  currentDir={currentDir}
                  onSetDir={setCurrentDir}
                  onOpenFile={openFile}
                  onNewProject={() => setShowNewProject(true)}
                  onOpenHistory={() => setShowHistory(true)}
                  refreshKey={treeRefresh}
                />
              </div>
            </Panel>

            <Separator className="sep sep-v" />

            {/* Editor + Terminal */}
            <Panel id="center" minSize="30%">
              <Group
                orientation="vertical"
                id="sakura-ide-v"
                defaultLayout={loadLayout('sakura-ide-v')}
                onLayoutChanged={l => saveLayout('sakura-ide-v', l)}
                className="h-full flex flex-col"
              >
                <Panel id="editor" minSize="20%">
                  <Suspense fallback={<div className="h-full w-full flex items-center justify-center bg-surface text-ink-muted text-sm">エディタを読み込み中…</div>}>
                    <EditorPanel
                      openFiles={openFiles}
                      activeFile={activeFile}
                      onSetActive={setActiveFile}
                      onClose={closeFile}
                      onSave={saveFile}
                      onContentChange={updateFileContent}
                      apiKey={sakuraApiKey}
                      theme={theme}
                    />
                  </Suspense>
                </Panel>
                {showTerminal && (
                  <>
                    <Separator className="sep sep-h" />
                    <Panel id="terminal" defaultSize="28%" minSize="8%" maxSize="70%">
                      <TerminalPanel theme={theme} cwd={termDir ?? currentDir} exec={termExec} />
                    </Panel>
                  </>
                )}
              </Group>
            </Panel>

            {/* Chat panel */}
            {showChat && (
              <>
                <Separator className="sep sep-v" />
                <Panel id="chat" defaultSize="24%" minSize="16%" maxSize="45%">
                  <div className="h-full bg-surface">
                    <ChatPanel apiKey={sakuraApiKey} onSetApiKey={setApiKey} activeFile={activeFileObj} projectDir={currentDir} onOpenCredentials={() => setShowCredentials(true)} onApplyFile={applyAiFile} onAiFileWritten={showAiFileInEditor} onExternalFilesChanged={rels => { void applyRestoreResult(rels, []) }}
                      onProjectFilesMoved={() => {
                        // フォルダの整理でファイルが動いた。開いているタブは古い場所を
                        // 指したままなので、**保存で元の場所に復活させないよう全部閉じる**
                        // （2026-07-11 の stale tab 事故と同じ形を避ける）。
                        setOpenFiles([])
                        setActiveFile(null)
                        // **プロジェクトの形が変わった。** ファイル一覧だけでなく、
                        // 各画面が持っている「根」も取り直させる（treeRefresh を合図に使う）。
                        // これを忘れると、移行後も古い場所を見たままになる
                        //（2026-08-20 実機: 「② 試す」が実行方法を見つけられなくなった）。
                        setTreeRefresh(n => n + 1)
                      }} />
                  </div>
                </Panel>
              </>
            )}
          </Group>
        )}
      </div>

      {mode === 'ide' && <StatusBar activeFile={activeFileObj} meta={projectMeta} apiKey={sakuraApiKey} />}

      {showSettings && <SettingsModal apiKey={sakuraApiKey} onClose={() => setShowSettings(false)} />}

      {showPublish && currentDir && (
        <PublishModal projectDir={currentDir} apiKey={sakuraApiKey} onClose={() => setShowPublish(false)} onRun={runInTerminal} onOpenCredentials={() => setShowCredentials(true)} onOpenPublishedList={() => setShowPublishedList(true)} />
      )}

      {/* 公開したもの一覧（プロジェクト未オープンでも開ける＝currentDir を条件にしない） */}
      {showPublishedList && (
        <PublishedListModal
          onClose={() => setShowPublishedList(false)}
          onOpenProject={dir => setCurrentDir(dir)}
        />
      )}

      {currentDir && (
        <ServerFilesModal
          open={showServer}
          onClose={() => setShowServer(false)}
          projectDir={currentDir}
          meta={projectMeta}
        />
      )}

      {showCredentials && (
        <CredentialsModal
          apiKey={sakuraApiKey}
          onSetApiKey={setApiKey}
          onClose={() => setShowCredentials(false)}
        />
      )}

      {showKnowledge && (
        <KnowledgeModal
          apiKey={sakuraApiKey}
          projectDir={currentDir}
          onClose={() => setShowKnowledge(false)}
          onOpenCredentials={() => { setShowKnowledge(false); setShowCredentials(true) }}
        />
      )}

      {showHistory && currentDir && (
        <HistoryModal
          projectDir={currentDir}
          onClose={() => setShowHistory(false)}
          onRestored={applyRestoreResult}
        />
      )}

      {showGithubSave && currentDir && (
        <GithubSaveModal
          projectDir={currentDir}
          onClose={() => setShowGithubSave(false)}
          onOpenCredentials={() => { setShowGithubSave(false); setShowCredentials(true) }}
        />
      )}

      {showOnboarding && (
        <OnboardingModal
          onSetApiKey={setApiKey}
          onClose={() => { localStorage.setItem('sakura_onboarded', '1'); setShowOnboarding(false) }}
          onCreateProject={() => { localStorage.setItem('sakura_onboarded', '1'); setShowOnboarding(false); setShowNewProject(true) }}
          onOpenCredentials={() => { localStorage.setItem('sakura_onboarded', '1'); setShowOnboarding(false); setShowCredentials(true) }}
        />
      )}

      {showNewProject && (
        <NewProjectModal
          apiKey={sakuraApiKey}
          onClose={() => setShowNewProject(false)}
          onOpenCredentials={() => { setShowNewProject(false); setShowCredentials(true) }}
          onCreated={(root, openRelPath) => {
            setShowNewProject(false)
            setMode('ide')
            localStorage.setItem('sakura_mode', 'ide')
            setCurrentDir(root)
            if (openRelPath) openFile(`${root}/${openRelPath}`)
          }}
        />
      )}
    </div>
  )
}
