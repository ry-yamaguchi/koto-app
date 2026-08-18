import React, { useState } from 'react'
import { getSearchConfig } from '../aiTools'
import { buildWebPageMarkdown, sanitizeFilename, WEB_FETCH_MAX_CHARS } from '../ragContext'
import { setBaseline } from '../knowledgeBaseline'
import { fingerprint } from '../../shared/freshness'

// 🌐 Webから資料を作る（ナレッジコレクター・R3）。
// 検索 → 選択（チェックボックス） → 取得＋Markdown整形 → プレビュー → アップロード＋ローカル控え、の一直線フロー。
// 一括クロールはしない。取得はユーザーが明示チェックしたページのみ・アップロードは必ずボタン操作。

interface Props {
  apiKey: string
  onOpenCredentials: () => void
  // アップロード完了後に呼ばれる（親側で「📚 登録済みの資料」タブへ切替＋一覧再読込）
  onUploaded: () => void
}

interface SearchHit { title: string; url: string; description: string }

interface FetchedPage {
  url: string
  title: string
  content: string
  markdown: string
  error?: string
}

const SAKURA_KNOWLEDGE_SITE = ' site:knowledge.sakura.ad.jp'
const PREVIEW_CHARS = 500

export default function KnowledgeCollectorTab({ apiKey, onOpenCredentials, onUploaded }: Props) {
  const [searchConfig, setSearchConfig] = useState<{ provider: 'tavily' | 'brave'; key: string } | null | undefined>(undefined)

  // 検索
  const [query, setQuery] = useState('')
  const [sakuraOnly, setSakuraOnly] = useState(true)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // 資料化（取得＋プレビュー）
  const [fetching, setFetching] = useState(false)
  const [pages, setPages] = useState<FetchedPage[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // アップロード
  const [tagsInput, setTagsInput] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadNotice, setUploadNotice] = useState('')

  // 検索設定（Tavily/Brave のキー）は初回描画時に一度だけ確認する
  React.useEffect(() => {
    let cancelled = false
    getSearchConfig().then(cfg => { if (!cancelled) setSearchConfig(cfg) })
    return () => { cancelled = true }
  }, [])

  const doSearch = async () => {
    const q = query.trim()
    if (!q || !searchConfig) return
    setSearching(true); setSearchError(''); setResults([]); setSelected(new Set())
    try {
      const fullQuery = sakuraOnly ? `${q}${SAKURA_KNOWLEDGE_SITE}` : q
      const r = await window.electronAPI.web.search(searchConfig.provider, searchConfig.key, fullQuery)
      setResults(r.slice(0, 10))
      if (r.length === 0) setSearchError('検索結果が見つかりませんでした。')
    } catch (e: any) {
      setSearchError(e?.message ?? '検索に失敗しました。')
    } finally {
      setSearching(false)
    }
  }

  const toggleSelected = (url: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })
  }

  const makeDocuments = async () => {
    const targets = results.filter(r => selected.has(r.url))
    if (targets.length === 0) return
    setFetching(true); setUploadNotice('')
    const fetchedAt = new Date()
    const next: FetchedPage[] = []
    for (const t of targets) {
      try {
        // 資料化はRAG書庫行きでトークン費用が発生しないため、AI文脈用の既定12000ではなく
        // 大きい上限で全文取得する（さもないと長いページが12,000字で切られてしまう）。
        const page = await window.electronAPI.web.fetchPage(t.url, { maxChars: WEB_FETCH_MAX_CHARS })
        const title = page.title || t.title
        const markdown = buildWebPageMarkdown({ title, url: page.url || t.url, content: page.content }, fetchedAt)
        next.push({ url: page.url || t.url, title, content: page.content, markdown })
      } catch (e: any) {
        next.push({ url: t.url, title: t.title, content: '', markdown: '', error: e?.message ?? '取得に失敗しました。' })
      }
    }
    setPages(next)
    setFetching(false)
  }

  const toggleExpanded = (url: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })
  }

  // 同名衝突時は -2, -3 ... と連番を振ってローカル控えのファイル名を決める
  const uniqueLocalFilename = async (dir: string, base: string): Promise<string> => {
    let candidate = `${base}.md`
    let n = 2
    while (await window.electronAPI.fs.exists(`${dir}/${candidate}`)) {
      candidate = `${base}-${n}.md`
      n += 1
    }
    return candidate
  }

  const uploadAll = async () => {
    const ok = pages.filter(p => !p.error)
    if (ok.length === 0) return
    setUploading(true); setUploadNotice('')
    const userTags = tagsInput.split(',').map(t => t.trim()).filter(Boolean)
    const dir = await window.electronAPI.rag.knowledgeDir()
    let successCount = 0
    const errors: string[] = []
    for (const page of ok) {
      const base = sanitizeFilename(page.title)
      const filename = `${base}.md`
      try {
        const r = await window.electronAPI.rag.upload(apiKey, {
          content: page.markdown,
          filename,
          tags: [...userTags, 'web'],
        })
        // **取り込んだページの指紋を控える**（更新の有無は、これと比べて判定する）
        if (r.ok && r.document?.id) setBaseline(r.document.id, fingerprint(page.content))
        if (!r.ok) {
          errors.push(`「${page.title}」: ${r.error ?? 'アップロードに失敗しました'}`)
          continue
        }
        // ローカル控え（同名衝突時は連番）
        const localName = await uniqueLocalFilename(dir, base)
        await window.electronAPI.fs.writeFile(`${dir}/${localName}`, page.markdown)
        successCount += 1
      } catch (e: any) {
        errors.push(`「${page.title}」: ${e?.message ?? String(e)}`)
      }
    }
    setUploading(false)
    if (successCount > 0) {
      setUploadNotice(
        `${successCount}件の資料を追加しました。${errors.length > 0 ? ` (失敗: ${errors.length}件)` : ''}` +
        '取り込みが完了するまでしばらくお待ちください。'
      )
      setResults([]); setSelected(new Set()); setPages([]); setTagsInput(''); setQuery('')
      onUploaded()
    } else {
      setUploadNotice(`アップロードに失敗しました。${errors.join(' / ')}`)
    }
  }

  const openKnowledgeDir = async () => {
    const dir = await window.electronAPI.rag.knowledgeDir()
    await window.electronAPI.shell.openPath(dir)
  }

  const okPages = pages.filter(p => !p.error)

  return (
    <div className="space-y-4">
      {/* ① 検索 */}
      <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <h3 className="text-sm font-semibold text-ink">① Webページを検索する</h3>

        {searchConfig === undefined ? (
          <p className="text-sm text-ink-secondary py-2">確認中…</p>
        ) : searchConfig === null ? (
          <div className="space-y-3">
            <p className="text-sm text-ink leading-relaxed">
              Web検索のAPIキーが未登録です。認証情報（⌘ ,）の「Web検索」で Tavily または Brave の無料APIキーを登録してください。
            </p>
            <button
              onClick={onOpenCredentials}
              className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90"
            >認証情報を開く</button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !searching) doSearch() }}
                placeholder="例: AppRun デプロイ 環境変数"
                className="flex-1 bg-elevated border border-line rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-muted outline-none focus:border-sakura"
              />
              <button
                onClick={doSearch}
                disabled={searching || !query.trim()}
                className="flex-none sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
              >{searching ? '検索中…' : '検索'}</button>
            </div>
            <label className="flex items-center gap-2 text-xs text-ink-secondary cursor-pointer">
              <input type="checkbox" checked={sakuraOnly} onChange={e => setSakuraOnly(e.target.checked)} />
              さくらのナレッジから探す
            </label>

            {searchError && (
              <p className="text-xs text-white bg-brand-red/90 rounded-lg px-3 py-2 leading-relaxed select-text">{searchError}</p>
            )}

            {results.length > 0 && (
              <ul className="divide-y divide-line max-h-64 overflow-y-auto">
                {results.map(r => (
                  <li key={r.url} className="py-2 flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 flex-none"
                      checked={selected.has(r.url)}
                      onChange={() => toggleSelected(r.url)}
                    />
                    <div className="min-w-0">
                      <p className="text-sm text-ink truncate" title={r.title}>{r.title || '(タイトル不明)'}</p>
                      <p className="text-[11px] text-ink-muted truncate" title={r.url}>{r.url}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {results.length > 0 && (
              <button
                onClick={makeDocuments}
                disabled={fetching || selected.size === 0}
                className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
              >{fetching ? '取得中…' : `選んだページを資料にする（${selected.size}件）`}</button>
            )}
          </>
        )}
      </div>

      {/* ② プレビュー */}
      {pages.length > 0 && (
        <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
          <h3 className="text-sm font-semibold text-ink">② 取得結果を確認する</h3>
          <ul className="divide-y divide-line">
            {pages.map(p => (
              <li key={p.url} className="py-2.5 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-sm text-ink truncate" title={p.title}>{p.title}</span>
                  {p.error ? (
                    <span className="flex-none text-[11px] font-medium text-brand-red">⚠️ 除外</span>
                  ) : (
                    <button
                      onClick={() => toggleExpanded(p.url)}
                      className="flex-none text-[11px] text-sakura hover:underline"
                    >{expanded.has(p.url) ? '閉じる' : '内容を見る'}</button>
                  )}
                </div>
                <p className="text-[11px] text-ink-muted truncate">{p.url}</p>
                {p.error ? (
                  <p className="text-[11px] text-brand-red select-text">{p.error}</p>
                ) : expanded.has(p.url) ? (
                  <p className="text-xs text-ink bg-elevated border border-line rounded-lg px-2 py-1.5 whitespace-pre-wrap select-text">
                    {p.content.slice(0, PREVIEW_CHARS)}{p.content.length > PREVIEW_CHARS ? '…' : ''}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ③ アップロード */}
      {okPages.length > 0 && (
        <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
          <h3 className="text-sm font-semibold text-ink">③ 資料として登録する</h3>
          <div>
            <label className="text-[11px] font-medium text-ink-secondary">タグ（任意・カンマ区切り）</label>
            <input
              value={tagsInput}
              onChange={e => setTagsInput(e.target.value)}
              placeholder="例: 仕様書, 契約"
              className="mt-1 w-full bg-surface border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-sakura"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={uploadAll}
              disabled={uploading}
              className="flex-none sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
            >{uploading ? 'アップロード中…' : `アップロード（${okPages.length}件）`}</button>
            <button
              onClick={openKnowledgeDir}
              className="flex-none text-xs text-ink-secondary border border-line rounded-md px-2 py-1 hover:border-sakura"
            >控えフォルダを開く</button>
          </div>
          {uploadNotice && (
            <p className="text-xs text-ink bg-elevated border border-line rounded-lg px-3 py-2 leading-relaxed select-text break-all">{uploadNotice}</p>
          )}
        </div>
      )}

      {/* 注記 */}
      <p className="text-[11px] text-ink-muted leading-relaxed">
        取得したページは私的利用の範囲でご利用ください。資料には出典URLが記録されます。アップロードした資料はさくらのクラウド（AI Engine）に保存されます。
      </p>
    </div>
  )
}
