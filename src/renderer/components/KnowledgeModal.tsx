import React, { useCallback, useEffect, useRef, useState } from 'react'
import SakuraLogo from './SakuraLogo'
import { getDefaultModel } from '../usage'
import { buildWebPageMarkdown, WEB_FETCH_MAX_CHARS } from '../ragContext'
import KnowledgeCollectorTab from './KnowledgeCollectorTab'
import KnowledgePacksTab from './KnowledgePacksTab'
import { judgeFreshness, parseSourceMeta, sourcesDueForCheck, fingerprint, judgeUpdate } from '../../shared/freshness'
import { setBaseline, getBaseline, pruneBaselines } from '../knowledgeBaseline'
import { isSubmitEnter } from '../keyInput'

// 「📚 資料」モーダル：さくらのAI Engine RAG API を使った資料（ドキュメント）管理（R1）
// ＋ このプロジェクトのチャットで資料を使うかの設定（R2・セクション④）
// ＋ Webから資料を作る（ナレッジコレクター・R3）
// ＋ さくらの資料パック（既定URLセットの一括取り込み・roadmap.md N-2）。
// CredentialsModal / ServerFilesModal と同じモーダル様式。UI文言に「RAG」「ベクトル」「埋め込み」は出さない。
// タブ3つ: 「📚 登録済みの資料」（R1/R2の既存セクション）／「🌐 Webから資料を作る」（R3・KnowledgeCollectorTab）／
// 「📦 さくらの資料パック」（KnowledgePacksTab）。

interface Props {
  apiKey: string
  onClose: () => void
  onOpenCredentials: () => void
  // このプロジェクトのチャットで使う資料設定（.sakuraide.json の rag キー）を編集する対象。
  // 未選択（null/undefined）の場合はセクション④自体を表示しない。
  projectDir?: string | null
}

// 許可拡張子（rag-plan.md §1 upload 仕様より）
const ALLOWED_EXTENSIONS = ['txt', 'pdf', 'html', 'docx', 'xlsx', 'md']
// 秘密ファイルのガード（設計書の正規表現をそのまま採用）
const SECRET_NAME_RE = /^\.env|secret|credential/i

const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 120000

function isPending(status: string): boolean {
  return status === 'pending' || status === 'processing'
}

function statusBadge(doc: RagDocument): { icon: string; label: string; cls: string } {
  if (isPending(doc.status)) return { icon: '🕐', label: '取り込み中', cls: 'text-ink-secondary' }
  if (doc.status === 'available') return { icon: '✅', label: '利用可能', cls: 'text-brand-green' }
  if (doc.status === 'error') return { icon: '⚠️', label: 'エラー', cls: 'text-brand-red' }
  if (doc.status === 'deleted') return { icon: '🗑', label: '削除済み', cls: 'text-ink-muted' }
  return { icon: '❔', label: String(doc.status), cls: 'text-ink-muted' }
}

function formatDate(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

type TabId = 'library' | 'collector' | 'packs'

/** 前回いつ「元のページ」を見に行ったか（資料ID → ISO）。開くたびに全部叩かないため。 */
const CHECKED_KEY = 'koto.knowledge.lastCheckedAt'
function loadLastChecked(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(CHECKED_KEY) ?? '{}') } catch { return {} }
}
function saveLastChecked(v: Record<string, string>): void {
  try { localStorage.setItem(CHECKED_KEY, JSON.stringify(v)) } catch { /* 使えなくても機能は成立する */ }
}

export default function KnowledgeModal({ apiKey, onClose, onOpenCredentials, projectDir }: Props) {
  const [tab, setTab] = useState<TabId>('library')
  const [documents, setDocuments] = useState<RagDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [ideOnly, setIdeOnly] = useState(true)
  const [expandedError, setExpandedError] = useState<string | null>(null)
  // ── 鮮度（2026-08-15 Ryosuke 提案）────────────────────────────────
  // 資料は**取り込んだ時点のコピー**。3か月前のページも今日のページも同じ顔では、
  // AI は古い情報を「いまの情報」として読む。**いつのものかを必ず見せる。**
  /** 資料ID → 元のページを見た結果。 */
  const [sourceState, setSourceState] = useState<Record<string, 'same' | 'changed' | 'checking' | 'no-baseline' | 'no-url' | 'fetch-failed'>>({})
  /** 出典URLが見つからなかったときの、実際の本文の先頭（**推測で直さないため**の材料）。 */
  const [sourceHead, setSourceHead] = useState<Record<string, string>>({})
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  /** 次の一覧読み込みのあと、間隔を待たずに全部確かめるか（「更新を確認」ボタン用）。 */
  const forceCheckRef = useRef(false)
  /** 更新のあった資料（全体を更新の対象）。 */
  const changedIds = Object.entries(sourceState).filter(([, v]) => v === 'changed').map(([k]) => k)

  // 追加
  const [uploading, setUploading] = useState(false)
  const [uploadTagsInput, setUploadTagsInput] = useState('')
  const [uploadNotice, setUploadNotice] = useState('')

  // 編集
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editTags, setEditTags] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  // 削除確認
  const [pendingDelete, setPendingDelete] = useState<RagDocument | null>(null)
  const [deleting, setDeleting] = useState(false)

  // 試し質問
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  /**
   * 検索の結果。**回答だけでなく、どの資料のどこが当たったかまで持つ**
   * （2026-08-25 Ryosuke と設計）。応答は前からこれを返していたのに、
   * **画面が資料名しか使わずに捨てていた**。
   */
  const [answer, setAnswer] = useState<{
    text: string
    hits: { name: string; where: string; excerpt: string }[]
  } | null>(null)
  const [askError, setAskError] = useState('')

  // ポーリング管理（モーダルを閉じたら必ず停止）
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollDeadline = useRef<number | null>(null)
  const [pollTimedOut, setPollTimedOut] = useState(false)

  const stopPolling = useCallback(() => {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null }
    pollDeadline.current = null
  }, [])

  const load = useCallback(async () => {
    if (!apiKey) return
    setLoading(true); setListError('')
    const r = await window.electronAPI.rag.list(apiKey, ideOnly ? { tag: 'sakura-ide' } : undefined)
    setLoading(false)
    if (r.ok) {
      setDocuments(r.documents ?? [])
    } else {
      setListError(r.error ?? '一覧の取得に失敗しました。')
    }
  }, [apiKey, ideOnly])

  // ポーリングの interval は生成時の load を掴み続けるため、常に最新の load を参照させる
  // （フィルタ切替後に旧フィルタで一覧を上書きしないように）。
  const loadRef = useRef(load)
  useEffect(() => { loadRef.current = load }, [load])

  // モーダルを開いたら読み込み。IDEフィルタ切替でも読み直す。
  useEffect(() => {
    setPollTimedOut(false)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ideOnly, apiKey])

  // 取り込み中の資料がある間は3秒間隔でポーリング。最大2分で停止。モーダルアンマウント時も必ず停止。
  useEffect(() => {
    const hasPending = documents.some(d => isPending(d.status))
    if (!hasPending) { stopPolling(); return }
    if (pollTimer.current) return // 既にポーリング中
    pollDeadline.current = Date.now() + POLL_TIMEOUT_MS
    pollTimer.current = setInterval(() => {
      if (pollDeadline.current !== null && Date.now() > pollDeadline.current) {
        stopPolling()
        setPollTimedOut(true)
        return
      }
      loadRef.current()
    }, POLL_INTERVAL_MS)
    return () => { /* documents 変化時に再評価するのでここでは止めない */ }
  }, [documents, stopPolling])

  // アンマウント時のクリーンアップ（モーダルを閉じたら必ず停止）
  useEffect(() => () => stopPolling(), [stopPolling])

  const pickAndUpload = async () => {
    setUploadNotice('')
    const filePath = await window.electronAPI.fs.openDialog({
      filters: [{ name: '資料ファイル', extensions: ALLOWED_EXTENSIONS }],
    })
    if (!filePath) return
    const filename = filePath.split('/').pop() ?? filePath
    if (SECRET_NAME_RE.test(filename)) {
      setUploadNotice('⚠️ このファイルは秘密情報を含む可能性があるファイル名のため、アップロードを中止しました。')
      return
    }
    const tags = uploadTagsInput.split(',').map(t => t.trim()).filter(Boolean)
    setUploading(true)
    const r = await window.electronAPI.rag.upload(apiKey, { filePath, filename, tags })
    setUploading(false)
    if (r.ok) {
      setUploadNotice(`「${filename}」を追加しました。取り込みが完了するまでしばらくお待ちください。`)
      setUploadTagsInput('')
      setPollTimedOut(false)
      load()
    } else {
      setUploadNotice(`追加に失敗しました: ${r.error ?? ''}`)
    }
  }

  const startEdit = (doc: RagDocument) => {
    setEditingId(doc.id)
    setEditName(doc.name)
    setEditTags(doc.tags.join(', '))
  }

  /**
   * 元のページを見に行って、中身が変わっていないかを確かめる。
   *
   * **何も書き換えない。** 変わっていたら「取り直せます」と伝えるだけ。
   * 出どころは資料の本文（`- 出典URL:`）から読む。**別の記録を持たない**
   * （持つと、資料を消したときに残ってずれる。今日の「記録だけ残る」と同じ轍）。
   */
  const checkSource = useCallback(async (doc: RagDocument): Promise<void> => {
    setSourceState(prev => ({ ...prev, [doc.id]: 'checking' }))
    try {
      // 出どころ（URL）は資料の本文から読む
      const got = await window.electronAPI.rag.get(apiKey, doc.id)
      const stored = got.ok ? (got.document?.content ?? null) : null
      const meta = parseSourceMeta(stored)
      if (!meta.url) {
        setSourceHead(prev => ({ ...prev, [doc.id]: String(stored ?? '').replace(/\s+/g, ' ').slice(0, 80) }))
        setSourceState(prev => ({ ...prev, [doc.id]: 'no-url' }))
        return
      }
      const page = await window.electronAPI.web.fetchPage(meta.url, { maxChars: WEB_FETCH_MAX_CHARS })
      // ── 比べるのは Koto が取ってきたページどうし（2026-08-18）──────────
      // 保存された本文と比べていたが、**保存して読み戻すと形が変わる**ため
      // 当てにならなかった（同じ資料が「最新です」にも「更新されています」にも
      // なった）。取り込んだときの指紋と、いまの指紋を比べる。
      const verdict = judgeUpdate({ baseline: getBaseline(doc.id), nowText: page.content })
      if (verdict === 'no-baseline') {
        // **昔に取り込んだ資料は控えが無い。** 「更新されています」と言うのは
        // 根拠のない断定なので言わない。いまの内容を基準にして、次から分かるようにする
        setBaseline(doc.id, fingerprint(page.content))
      }
      setSourceState(prev => ({ ...prev, [doc.id]: verdict }))
    } catch {
      // 取りに行けないだけで「変わった」とは言わない（相手が落ちている・認証が要る等）
      setSourceState(prev => ({ ...prev, [doc.id]: 'fetch-failed' }))
    } finally {
      const next = { ...loadLastChecked(), [doc.id]: new Date().toISOString() }
      saveLastChecked(next)
    }
  }, [apiKey])

  /**
   * 取り直す（元のページを取得し直して、資料を差し替える）。
   *
   * さくらの AI Engine は**本文の差し替えができない**（書けるのは name と tags のみ）ので、
   * **新しいものを入れてから、古いものを消す**。逆にすると、失敗したときに
   * 資料が消えたまま残る（2026-08-14「古い鍵を先に消してアプリを壊した」と同じ形）。
   */
  const refreshDoc = useCallback(async (doc: RagDocument): Promise<void> => {
    setRefreshingId(doc.id)
    try {
      const got = await window.electronAPI.rag.get(apiKey, doc.id)
      const meta = parseSourceMeta(got.ok ? (got.document?.content ?? null) : null)
      if (!meta.url) { setListError('この資料には出典URLが記録されていないため、取り直せません。'); return }
      const page = await window.electronAPI.web.fetchPage(meta.url, { maxChars: WEB_FETCH_MAX_CHARS })
      const markdown = buildWebPageMarkdown(
        { title: doc.name.replace(/\.md$/, ''), url: page.url || meta.url, content: page.content },
        new Date(),
      )
      const up = await window.electronAPI.rag.upload(apiKey, {
        content: markdown,
        filename: doc.name.endsWith('.md') ? doc.name : `${doc.name}.md`,
        tags: doc.tags,
      })
      if (!up.ok) { setListError(up.error ?? '取り直しに失敗しました'); return }
      // **新しいものが入ってから、古いものを消す**
      await window.electronAPI.rag.delete(apiKey, doc.id)
      // **押した結果を見せる。** 取り直したのに何も変わらないと、効いたのか分からない
      // （2026-08-15 Ryosuke 指摘）。新しい資料には「最新の内容です」を付ける
      const newId = up.document?.id ?? null
      // **取り込んだページそのものの指紋を控える。** これが次回の比較の基準になる
      if (newId) setBaseline(newId, fingerprint(page.content))
      setSourceState(prev => {
        const n = { ...prev }
        delete n[doc.id]
        if (newId) n[newId] = 'same'
        return n
      })
      if (newId) {
        // 取り直した直後に、また確認しに行かないようにする
        saveLastChecked({ ...loadLastChecked(), [newId]: new Date().toISOString() })
      }
      await load()
    } catch (e: any) {
      setListError(e?.message ?? String(e))
    } finally {
      setRefreshingId(null)
    }
  }, [apiKey, load])

  /**
   * 更新のあった資料を、まとめて最新にする（2026-08-18 Ryosuke 提案）。
   *
   * **1件ずつ順に**行う（まとめて投げると、どこで失敗したか分からなくなる）。
   * 途中で失敗しても、そこまでに終わったものは有効なので続ける。
   */
  const refreshAll = useCallback(async () => {
    const targets = documents.filter(d => sourceState[d.id] === 'changed')
    for (const d of targets) {
      await refreshDoc(d)
    }
  }, [documents, sourceState, refreshDoc])

  // **押さなくても確かめる**（2026-08-15 Ryosuke 提案「起動時に日付などをみて更新ができるとよい」）。
  // ただし**開くたびに全部は叩かない**（相手のサイトに負担をかける）。前回から時間が経った
  // ものを数件だけ。取り直しは**必ず利用者が押してから**（勝手に差し替えない）。
  useEffect(() => {
    // 消えた資料の控えは捨てる（残すと際限なく溜まる）
    if (documents.length > 0) pruneBaselines(documents.map(d => d.id))
    const web = documents.filter(d => d.status === 'available' && d.tags.includes('web'))
    if (web.length === 0) return
    // 明示的に押されたときは、間隔を待たず**全部**確かめる（押したのに何も
    // 起きないのはおかしい・2026-08-15 Ryosuke 指摘）
    const forced = forceCheckRef.current
    forceCheckRef.current = false
    const due = forced
      ? web
      : sourcesDueForCheck({ docs: web, lastCheckedAt: loadLastChecked(), now: new Date() })
    let cancelled = false
    ;(async () => {
      for (const d of due) {
        if (cancelled) return
        await checkSource(d)
      }
    })()
    return () => { cancelled = true }
    // documents が入れ替わったときだけ走らせる（checkSource は apiKey にのみ依存）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documents])

  const saveEdit = async () => {
    if (!editingId) return
    setSavingEdit(true)
    const tags = editTags.split(',').map(t => t.trim()).filter(Boolean)
    const r = await window.electronAPI.rag.update(apiKey, editingId, { name: editName.trim(), tags })
    setSavingEdit(false)
    if (r.ok) {
      setEditingId(null)
      load()
    } else {
      window.alert(`更新に失敗しました: ${r.error ?? ''}`)
    }
  }

  const doDelete = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    const r = await window.electronAPI.rag.delete(apiKey, pendingDelete.id)
    setDeleting(false)
    setPendingDelete(null)
    if (r.ok) {
      load()
    } else {
      window.alert(`削除に失敗しました: ${r.error ?? ''}`)
    }
  }

  const availableCount = documents.filter(d => d.status === 'available').length

  const ask = async () => {
    if (!question.trim() || availableCount === 0) return
    setAsking(true); setAskError(''); setAnswer(null)
    const r = await window.electronAPI.rag.chat(apiKey, {
      query: question.trim().slice(0, 1000),
      chatModel: getDefaultModel(),
      ...(ideOnly ? { tags: ['sakura-ide'] } : {}),
    })
    setAsking(false)
    if (r.ok) {
      // **捨てずに全部使う**: 資料名・何番目の区切りか・当たった本文。
      const hits = (r.sources ?? []).map(h => ({
        name: h.document?.name ?? '（名前のない資料）',
        where: typeof h.chunkIndex === 'number' ? `${h.chunkIndex + 1} 番目の区切り` : '',
        excerpt: (h.content ?? '').trim().slice(0, 300),
      }))
      setAnswer({ text: r.answer ?? '', hits })
    } else {
      setAskError(r.error ?? '質問に失敗しました。')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      {/* タブ表示時は高さを固定（h-）にする。max-h だと中身の薄いタブ（Webから資料を作る）だけモーダルが縮み、
          中央寄せのため上端＝タブボタンの位置がタブ切替のたびに上下にずれる（2026-07-17 ユーザー報告）。
          キー未登録時（タブなし・案内のみ）は従来どおり中身に合わせて小さく表示する */}
      <div className={`w-[620px] ${apiKey ? 'h-[88vh]' : 'max-h-[88vh]'} overflow-y-auto bg-elevated rounded-2xl border border-line shadow-2xl fade-in`} onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-6 pt-6 pb-4 sticky top-0 bg-elevated z-10">
          <SakuraLogo size={24} />
          <div>
            <h2 className="text-lg font-bold text-ink">📚 資料</h2>
            <p className="text-xs text-ink-secondary">AIに読ませる資料をさくらのAI Engineに登録・管理します</p>
          </div>
          <button onClick={onClose} className="ml-auto text-ink-muted hover:text-ink w-7 h-7 rounded-lg hover:bg-overlay">✕</button>
        </div>

        {apiKey && (
          <div className="px-6 flex items-center gap-1 border-b border-line sticky top-[68px] bg-elevated z-10">
            <button
              onClick={() => setTab('library')}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'library' ? 'border-sakura text-ink' : 'border-transparent text-ink-secondary hover:text-ink'}`}
            >📚 登録済みの資料</button>
            <button
              onClick={() => setTab('collector')}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'collector' ? 'border-sakura text-ink' : 'border-transparent text-ink-secondary hover:text-ink'}`}
            >🌐 Webから資料を作る</button>
            <button
              onClick={() => setTab('packs')}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === 'packs' ? 'border-sakura text-ink' : 'border-transparent text-ink-secondary hover:text-ink'}`}
            >📦 さくらの資料パック</button>
          </div>
        )}

        <div className="px-6 pb-6 space-y-4 pt-4">
          {!apiKey ? (
            <div className="rounded-xl border border-brand-yellow/70 bg-surface p-4 space-y-3">
              <p className="text-sm text-ink leading-relaxed">
                認証情報（⌘ ,）で さくらのAI Engine のAPIキーを登録してください。
              </p>
              <button
                onClick={onOpenCredentials}
                className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90"
              >認証情報を開く</button>
            </div>
          ) : tab === 'collector' ? (
            <KnowledgeCollectorTab
              apiKey={apiKey}
              onOpenCredentials={onOpenCredentials}
              onUploaded={() => { setTab('library'); setPollTimedOut(false); load() }}
            />
          ) : tab === 'packs' ? (
            <KnowledgePacksTab
              apiKey={apiKey}
              onUploaded={() => { setTab('library'); setPollTimedOut(false); load() }}
            />
          ) : (
            <>
              {/* ① 追加。**初めて開くと一覧は空**なので、追加を先に置く（2026-08-25 Ryosuke と設計）。 */}
              <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
                <h3 className="text-sm font-semibold text-ink">① 資料を追加</h3>
                <div>
                  <label className="text-[11px] font-medium text-ink-secondary">タグ（任意・カンマ区切り）</label>
                  <input
                    value={uploadTagsInput}
                    onChange={e => setUploadTagsInput(e.target.value)}
                    placeholder="例: 仕様書, 契約"
                    className="mt-1 w-full bg-surface border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-sakura"
                  />
                </div>
                <button
                  onClick={pickAndUpload}
                  disabled={uploading}
                  className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
                >{uploading ? 'アップロード中…' : 'ファイルを追加'}</button>
                <p className="text-[11px] text-ink-muted leading-relaxed">
                  対応形式: txt / pdf / html / docx / xlsx / md。アップロードした資料は<b className="text-ink-secondary">さくらのクラウド（AI Engine）に保存</b>されます。
                </p>
                {uploadNotice && (
                  <p className="text-xs text-ink bg-elevated border border-line rounded-lg px-3 py-2 leading-relaxed select-text break-all">{uploadNotice}</p>
                )}
              </div>

              {/* ② 一覧 */}
              <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-ink">② 登録済みの資料</h3>
                  {/* ── 全体と個別で役割を分ける（2026-08-18 Ryosuke 指摘）──────────
                      同じ「更新を確認」が2箇所にあると、どちらが何をするのか分からない。
                      **全体＝確認と一括更新／個別＝その資料の更新**にする。 */}
                  {changedIds.length > 0 ? (
                    <button
                      onClick={refreshAll}
                      disabled={loading || refreshingId !== null}
                      title="更新のあった資料を、まとめて最新の内容にします"
                      className="flex-none text-xs font-semibold text-white sakura-gradient rounded-md px-2.5 py-1 hover:opacity-90 disabled:opacity-40"
                    >{refreshingId ? '更新しています…' : `⬆ 全体を更新（${changedIds.length}件）`}</button>
                  ) : (
                    <button
                      onClick={() => { forceCheckRef.current = true; setSourceState({}); void load() }}
                      disabled={loading || refreshingId !== null}
                      title="Web から作った資料について、元のページが更新されていないかをまとめて確かめます"
                      className="flex-none text-xs text-ink-secondary border border-line rounded-md px-2 py-1 hover:border-sakura disabled:opacity-40"
                    >↻ 更新を確認</button>
                  )}
                </div>
                <label className="flex items-center gap-2 text-xs text-ink-secondary cursor-pointer">
                  <input type="checkbox" checked={ideOnly} onChange={e => setIdeOnly(e.target.checked)} />
                  IDEで追加した資料のみ表示
                </label>

                {pollTimedOut && (
                  <p className="text-[11px] text-white bg-brand-yellow-fill rounded-lg px-3 py-2 leading-relaxed">
                    取り込みに時間がかかっています。あとで再読み込みしてください。
                  </p>
                )}

                {listError && (
                  <p className="text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2 leading-relaxed select-text">{listError}</p>
                )}

                {loading && documents.length === 0 ? (
                  <p className="text-sm text-ink-secondary py-3">読み込み中…</p>
                ) : documents.length === 0 ? (
                  <p className="text-sm text-ink-muted py-3">登録済みの資料はありません。</p>
                ) : (
                  <ul className="divide-y divide-line max-h-72 overflow-y-auto">
                    {documents.map(doc => {
                      const badge = statusBadge(doc)
                      const isEditing = editingId === doc.id
                      return (
                        <li key={doc.id} className="py-2.5 space-y-1.5">
                          {isEditing ? (
                            <div className="space-y-2 bg-elevated border border-line rounded-lg p-3">
                              <div>
                                <label className="text-[11px] font-medium text-ink-secondary">名前</label>
                                <input
                                  value={editName}
                                  onChange={e => setEditName(e.target.value)}
                                  className="mt-1 w-full bg-surface border border-line rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-sakura"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] font-medium text-ink-secondary">タグ（カンマ区切り）</label>
                                <input
                                  value={editTags}
                                  onChange={e => setEditTags(e.target.value)}
                                  placeholder="例: 仕様書, 契約"
                                  className="mt-1 w-full bg-surface border border-line rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-sakura"
                                />
                              </div>
                              <div className="flex items-center gap-2 justify-end">
                                <button onClick={() => setEditingId(null)} disabled={savingEdit} className="text-xs text-ink-secondary px-2 py-1 rounded-md hover:bg-overlay disabled:opacity-40">やめる</button>
                                <button onClick={saveEdit} disabled={savingEdit || !editName.trim()} className="text-xs font-semibold text-white sakura-gradient rounded-md px-3 py-1 hover:opacity-90 disabled:opacity-40">
                                  {savingEdit ? '保存中…' : '保存'}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="flex items-center gap-2">
                                <span className="flex-1 text-sm text-ink truncate" title={doc.name}>{doc.name}</span>
                                <span className={`flex-none text-[11px] font-medium ${badge.cls}`}>{badge.icon} {badge.label}</span>
                              </div>
                              <div className="flex items-center gap-2 flex-wrap">
                                {doc.tags.map(t => (
                                  <span key={t} className="text-[10px] bg-overlay text-ink-secondary rounded-full px-2 py-0.5">{t}</span>
                                ))}
                                <span className="text-[11px] text-ink-muted ml-auto">
                                  {doc.chunkCount !== null ? `分割 ${doc.chunkCount} ・ ` : ''}
                                  {doc.model ? `${doc.model} ・ ` : ''}
                                  {formatDate(doc.createdAt)}
                                </span>
                              </div>
                              {doc.status === 'error' && doc.errorMessage && (
                                <button
                                  onClick={() => setExpandedError(expandedError === doc.id ? null : doc.id)}
                                  className="text-[11px] text-brand-red hover:underline"
                                >{expandedError === doc.id ? '詳細を閉じる' : 'エラーの詳細を見る'}</button>
                              )}
                              {expandedError === doc.id && doc.errorMessage && (
                                <p className="text-[11px] text-ink bg-surface border border-line rounded-lg px-2 py-1.5 select-text break-all">{doc.errorMessage}</p>
                              )}
                              {/* ── 鮮度（2026-08-15）────────────────────────────────
                                  資料は**取り込んだ時点のコピー**。いつのものかを必ず見せる。
                                  「元が変わったか」は取りに行かないと分からないので、
                                  分かったときだけ言う（分からないものを分かったように見せない）。 */}
                              {(() => {
                                const fresh = judgeFreshness({ fetchedAt: doc.createdAt, now: new Date() })
                                const st = sourceState[doc.id]
                                const isWeb = doc.tags.includes('web')
                                // **普段は静かに、気にすべきときだけ目立たせる。**
                                // 何でも色を付けると、本当に見てほしいものが埋もれる
                                const note =
                                  st === 'checking' ? { text: '元のページを確認中…', warn: false }
                                  : st === 'changed' ? { text: '🔄 元のページが更新されています', warn: true }
                                  : st === 'same' ? { text: '✅ 元のページと同じ内容です（最新です）', warn: false }
                                  : st === 'no-baseline' ? { text: '取り込んだときの内容が控えられていないため、更新の有無は分かりません（いまの内容を基準にしました）', warn: false }
                                  : st === 'no-url' ? { text: `出典URLが記録されていないため、確認できません（本文の先頭: ${sourceHead[doc.id] ?? '—'}）`, warn: false }
                                  : st === 'fetch-failed' ? { text: '元のページに届きませんでした', warn: false }
                                  : null
                                return (
                                  <div className="flex items-baseline gap-2 flex-wrap text-[11px]">
                                    <span className={fresh.level === 'stale' ? 'text-brand-yellow' : 'text-ink-muted'}>
                                      {fresh.label}
                                      {fresh.level === 'stale' && '（内容が古いかもしれません）'}
                                    </span>
                                    {note && (
                                      <span className={note.warn ? 'text-brand-yellow font-medium' : 'text-ink-muted'}>{note.text}</span>
                                    )}
                                    {isWeb && st === 'changed' && (
                                      <button
                                        onClick={() => refreshDoc(doc)}
                                        disabled={refreshingId !== null}
                                        className="text-sakura font-medium hover:underline disabled:opacity-40"
                                        title="元のページの最新の内容で、この資料を作り直します"
                                      >{refreshingId === doc.id ? '更新しています…' : '更新'}</button>
                                    )}
                                  </div>
                                )
                              })()}
                              <div className="flex items-center gap-3 pt-0.5">
                                <button onClick={() => startEdit(doc)} className="text-[11px] font-medium text-sakura hover:underline">名前を変更 / タグを編集</button>
                                <button onClick={() => setPendingDelete(doc)} className="text-[11px] font-medium text-brand-red hover:underline">削除</button>
                              </div>
                            </>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>

              {/* ③ 削除確認 */}
              {pendingDelete && (
                <div className="rounded-xl border border-brand-yellow/70 bg-surface p-4 space-y-3">
                  <p className="text-sm font-semibold text-ink">⚠️ 資料を削除します</p>
                  <p className="text-sm text-ink-secondary leading-relaxed">
                    「<span className="text-ink font-medium">{pendingDelete.name}</span>」をさくらのクラウドから削除します。元に戻せません。
                  </p>
                  <div className="flex justify-between items-center">
                    <button onClick={() => setPendingDelete(null)} disabled={deleting} className="bg-overlay text-ink border border-line rounded-lg px-4 py-2 text-sm font-medium hover:border-sakura disabled:opacity-40">やめる</button>
                    <button onClick={doDelete} disabled={deleting} className="bg-brand-red-fill text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40">
                      {deleting ? '削除中…' : '削除する'}
                    </button>
                  </div>
                </div>
              )}

              {/* 「このプロジェクトで使う」の行き先（2026-08-25 Ryosuke と設計）。
                  **機能が消えたと思わせない。** 設定はプロジェクトごとなので、
                  使う場所（チャット）で切り替える形にした。 */}
              {projectDir && (
                <p className="text-[11px] text-ink-muted leading-relaxed px-1">
                  このプロジェクトのチャットで資料を使うかどうかは、<b className="text-ink-secondary">チャット上部の「📚」</b>で切り替えられます。
                </p>
              )}

              {/* ③ 検索。**目的は「登録した資料がちゃんと引けるか」の確認**（2026-08-25 Ryosuke と設計）。
                  回答だけでなく、**どの資料のどこが当たったか**まで見せる。
                  応答（rag.chat）は前から出典・区切り番号・当たった本文を返しており、
                  **画面が資料名しか使わずに捨てていた**。追加の呼び出しは要らない。 */}
              <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
                <h3 className="text-sm font-semibold text-ink">③ 資料を検索</h3>
                <div className="flex items-center gap-2">
                  <input
                    value={question}
                    onChange={e => setQuestion(e.target.value)}
                    onKeyDown={e => { if (isSubmitEnter(e) && !asking) ask() }}
                    placeholder={availableCount === 0 ? '利用可能な資料がありません' : '例: 料金について'}
                    disabled={availableCount === 0}
                    className="flex-1 bg-elevated border border-line rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-muted outline-none focus:border-sakura disabled:opacity-40"
                  />
                  <button
                    onClick={ask}
                    disabled={availableCount === 0 || asking || !question.trim()}
                    className="flex-none sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
                  >{asking ? '検索中…' : '検索'}</button>
                </div>
                {askError && (
                  <p className="text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2 leading-relaxed select-text">{askError}</p>
                )}
                {answer && (
                  <div className="bg-elevated border border-line rounded-lg p-3 space-y-3">
                    {answer.text && (
                      <p className="text-sm text-ink whitespace-pre-wrap select-text">{answer.text}</p>
                    )}
                    {answer.hits.length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-[11px] font-semibold text-ink-secondary">見つかったところ</p>
                        {answer.hits.map((h, i) => (
                          <div key={i} className="border-l-2 border-line pl-2.5 space-y-1">
                            <p className="text-[11px] text-ink-secondary">
                              📄 {h.name}{h.where ? ` ・ ${h.where}` : ''}
                            </p>
                            <p className="text-[11px] text-ink-muted whitespace-pre-wrap select-text leading-relaxed">{h.excerpt}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      // **見つからなかったことを、はっきり言う**（回答だけ出すと効いたように見える）
                      <p className="text-[11px] text-ink-muted">
                        当てはまる資料は見つかりませんでした。言葉を変えて試すか、資料が登録されているか確かめてください。
                      </p>
                    )}
                  </div>
                )}
              </div>

            </>
          )}

          <div className="flex justify-end pt-1">
            <button onClick={onClose} className="bg-overlay text-ink border border-line rounded-xl px-4 py-2 text-sm font-medium hover:border-sakura">閉じる</button>
          </div>
        </div>
      </div>
    </div>
  )
}
