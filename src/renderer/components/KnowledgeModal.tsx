import React, { useCallback, useEffect, useRef, useState } from 'react'
import SakuraLogo from './SakuraLogo'
import { getDefaultModel } from '../usage'
import { parseRagSettings, mergeRagSettings, type RagSettings } from '../ragContext'
import KnowledgeCollectorTab from './KnowledgeCollectorTab'
import KnowledgePacksTab from './KnowledgePacksTab'

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

export default function KnowledgeModal({ apiKey, onClose, onOpenCredentials, projectDir }: Props) {
  const [tab, setTab] = useState<TabId>('library')
  const [documents, setDocuments] = useState<RagDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [ideOnly, setIdeOnly] = useState(true)
  const [expandedError, setExpandedError] = useState<string | null>(null)

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
  const [answer, setAnswer] = useState<{ text: string; sources: string[] } | null>(null)
  const [askError, setAskError] = useState('')

  // ポーリング管理（モーダルを閉じたら必ず停止）
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollDeadline = useRef<number | null>(null)
  const [pollTimedOut, setPollTimedOut] = useState(false)

  // ④ このプロジェクトで使う（.sakuraide.json の rag キー）
  const [ragEnabled, setRagEnabled] = useState(false)
  const [ragTagsInput, setRagTagsInput] = useState('')
  const [ragSaving, setRagSaving] = useState(false)
  const metaPath = projectDir ? `${projectDir}/.sakuraide.json` : ''

  // projectDir が変わるたびに現在の設定を読み直す（HanamiiPanel の readMeta と同じパターン）
  useEffect(() => {
    if (!projectDir) { setRagEnabled(false); setRagTagsInput(''); return }
    let cancelled = false
    ;(async () => {
      try {
        const raw = await window.electronAPI.fs.readFile(metaPath)
        const settings = parseRagSettings(JSON.parse(raw))
        if (cancelled) return
        setRagEnabled(settings?.enabled ?? false)
        setRagTagsInput((settings?.tags ?? []).join(', '))
      } catch {
        if (!cancelled) { setRagEnabled(false); setRagTagsInput('') }
      }
    })()
    return () => { cancelled = true }
  }, [projectDir, metaPath])

  // 変更を .sakuraide.json へ即保存する（既存キーを壊さないマージ書き込み）
  const saveRagSettings = useCallback(async (next: RagSettings) => {
    if (!projectDir) return
    setRagSaving(true)
    try {
      let meta: any = {}
      try { meta = JSON.parse(await window.electronAPI.fs.readFile(metaPath)) } catch { /* メタ無し→新規 */ }
      const merged = mergeRagSettings(meta, next)
      await window.electronAPI.fs.writeFile(metaPath, JSON.stringify(merged, null, 2))
      window.dispatchEvent(new Event('sakura-meta-changed'))
    } finally {
      setRagSaving(false)
    }
  }, [projectDir, metaPath])

  const ragTags = () => ragTagsInput.split(',').map(t => t.trim()).filter(Boolean)

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
      const sources = Array.from(new Set((r.sources ?? []).map(s => s.document?.name).filter((x): x is string => !!x)))
      setAnswer({ text: r.answer ?? '', sources })
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
              {/* ① 一覧 */}
              <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-ink">① 登録済みの資料</h3>
                  <button
                    onClick={load}
                    disabled={loading}
                    className="flex-none text-xs text-ink-secondary border border-line rounded-md px-2 py-1 hover:border-sakura disabled:opacity-40"
                  >↻ 再読み込み</button>
                </div>
                <label className="flex items-center gap-2 text-xs text-ink-secondary cursor-pointer">
                  <input type="checkbox" checked={ideOnly} onChange={e => setIdeOnly(e.target.checked)} />
                  IDEで追加した資料のみ表示
                </label>

                {pollTimedOut && (
                  <p className="text-[11px] text-white bg-brand-yellow/90 rounded-lg px-3 py-2 leading-relaxed">
                    取り込みに時間がかかっています。あとで再読み込みしてください。
                  </p>
                )}

                {listError && (
                  <p className="text-xs text-white bg-brand-red/90 rounded-lg px-3 py-2 leading-relaxed select-text">{listError}</p>
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

              {/* ② 追加 */}
              <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
                <h3 className="text-sm font-semibold text-ink">② 資料を追加</h3>
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

              {/* ③ 削除確認 */}
              {pendingDelete && (
                <div className="rounded-xl border border-brand-yellow/70 bg-surface p-4 space-y-3">
                  <p className="text-sm font-semibold text-ink">⚠️ 資料を削除します</p>
                  <p className="text-sm text-ink-secondary leading-relaxed">
                    「<span className="text-ink font-medium">{pendingDelete.name}</span>」をさくらのクラウドから削除します。元に戻せません。
                  </p>
                  <div className="flex justify-between items-center">
                    <button onClick={() => setPendingDelete(null)} disabled={deleting} className="bg-overlay text-ink border border-line rounded-lg px-4 py-2 text-sm font-medium hover:border-sakura disabled:opacity-40">やめる</button>
                    <button onClick={doDelete} disabled={deleting} className="bg-brand-red text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40">
                      {deleting ? '削除中…' : '削除する'}
                    </button>
                  </div>
                </div>
              )}

              {/* ④ 試し質問 */}
              <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
                <h3 className="text-sm font-semibold text-ink">③ 資料に質問してみる</h3>
                <div className="flex items-center gap-2">
                  <input
                    value={question}
                    onChange={e => setQuestion(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !asking) ask() }}
                    placeholder={availableCount === 0 ? '利用可能な資料がありません' : '例: この資料の要点は？'}
                    disabled={availableCount === 0}
                    className="flex-1 bg-elevated border border-line rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-muted outline-none focus:border-sakura disabled:opacity-40"
                  />
                  <button
                    onClick={ask}
                    disabled={availableCount === 0 || asking || !question.trim()}
                    className="flex-none sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
                  >{asking ? '考え中…' : '資料に質問してみる'}</button>
                </div>
                {askError && (
                  <p className="text-xs text-white bg-brand-red/90 rounded-lg px-3 py-2 leading-relaxed select-text">{askError}</p>
                )}
                {answer && (
                  <div className="bg-elevated border border-line rounded-lg p-3 space-y-2">
                    <p className="text-sm text-ink whitespace-pre-wrap select-text">{answer.text}</p>
                    {answer.sources.length > 0 && (
                      <p className="text-[11px] text-ink-muted">出典: {answer.sources.join('、')}</p>
                    )}
                  </div>
                )}
              </div>

              {/* ④ このプロジェクトで使う */}
              {projectDir && (
                <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
                  <h3 className="text-sm font-semibold text-ink">④ このプロジェクトで使う</h3>
                  <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ragEnabled}
                      onChange={e => {
                        const next = e.target.checked
                        setRagEnabled(next)
                        saveRagSettings({ enabled: next, tags: ragTags() })
                      }}
                    />
                    このプロジェクトのチャットで資料を使う
                  </label>
                  <div>
                    <label className="text-[11px] font-medium text-ink-secondary">絞り込みタグ（任意・カンマ区切り）</label>
                    <input
                      value={ragTagsInput}
                      onChange={e => setRagTagsInput(e.target.value)}
                      onBlur={() => saveRagSettings({ enabled: ragEnabled, tags: ragTags() })}
                      placeholder="例: 仕様書"
                      disabled={!ragEnabled}
                      className="mt-1 w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-sakura disabled:opacity-40"
                    />
                  </div>
                  <p className="text-[11px] text-ink-muted leading-relaxed">
                    タグを複数指定すると、すべてのタグを持つ資料だけが対象になります。{ragSaving ? '（保存中…）' : ''}
                  </p>
                </div>
              )}
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
