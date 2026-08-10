import React, { useState } from 'react'
import { RAG_PACKS, packTotalChars, formatApproxChars, packTags, estimatePackCostPerTurnYen, type RagPack } from '../ragPacks'
import { buildWebPageMarkdown, sanitizeFilename, WEB_FETCH_MAX_CHARS, CHUNK_MAX_CHARS, RAG_TOP_K } from '../ragContext'
import { getDefaultModel, modelLabel } from '../usage'

// 📚 さくらの資料パック（roadmap.md N-2）。
// さくら公式ドキュメントの既定URLセット（ragPacks.ts）を「取り込む」ボタン一つで📚資料に一括登録する。
// R3ナレッジコレクター（KnowledgeCollectorTab.tsx）と同じ土台（web:fetch → buildWebPageMarkdown → rag.upload）を
// 使うが、URL選択のUIは無く定義済みのパック単位で動く。アップロードは必ずこのタブのボタン起点（AIから呼べる経路は作らない）。

interface Props {
  apiKey: string
  // パックが失敗0件で完了した直後に呼ばれる（親側で「📚 登録済みの資料」タブへ切替＋一覧再読込）。
  // 一部失敗時は呼ばない＝タブに留まって再試行ボタンを見せ続ける。
  onUploaded: () => void
}

interface PageResult { url: string; title: string; status: 'pending' | 'ok' | 'error'; error?: string }

interface PackState {
  checking: boolean
  running: boolean
  results: PageResult[]
  notice: string
  confirmReplace: { count: number; ids: string[] } | null
}

function emptyState(): PackState {
  return { checking: false, running: false, results: [], notice: '', confirmReplace: null }
}

export default function KnowledgePacksTab({ apiKey, onUploaded }: Props) {
  const [states, setStates] = useState<Record<string, PackState>>({})

  const getState = (id: string): PackState => states[id] ?? emptyState()
  const setPackState = (id: string, updater: (prev: PackState) => PackState) => {
    setStates(prev => ({ ...prev, [id]: updater(prev[id] ?? emptyState()) }))
  }

  const runIngest = async (pack: RagPack, retryOnly: boolean) => {
    const prevResults = getState(pack.id).results
    const targets = pack.pages.filter(p => {
      if (!retryOnly) return true
      const prev = prevResults.find(r => r.url === p.url)
      return !prev || prev.status !== 'ok'
    })

    setPackState(pack.id, s => ({
      ...s,
      running: true,
      notice: '',
      results: pack.pages.map(p => {
        if (retryOnly) {
          const prev = s.results.find(r => r.url === p.url)
          if (prev && prev.status === 'ok') return prev
        }
        return { url: p.url, title: p.title, status: 'pending' as const }
      }),
    }))

    const fetchedAt = new Date()
    let successCount = 0
    const failedTitles: string[] = []

    for (const page of targets) {
      try {
        // 資料化はRAG書庫行きでトークン費用が発生しないため、AI文脈用の既定12000ではなく
        // 大きい上限で全文取得する（さもないと長いページ（例: 38,887字）が切られてしまう）。
        const fetched = await window.electronAPI.web.fetchPage(page.url, { maxChars: WEB_FETCH_MAX_CHARS })
        const title = fetched.title || page.title
        const markdown = buildWebPageMarkdown({ title, url: fetched.url || page.url, content: fetched.content }, fetchedAt)
        const r = await window.electronAPI.rag.upload(apiKey, {
          content: markdown,
          filename: `${sanitizeFilename(title)}.md`,
          tags: packTags(pack.id),
        })
        if (!r.ok) throw new Error(r.error ?? 'アップロードに失敗しました')
        successCount += 1
        setPackState(pack.id, s => ({ ...s, results: s.results.map(res => res.url === page.url ? { ...res, status: 'ok' as const } : res) }))
      } catch (e: any) {
        const message = e?.message ?? String(e)
        failedTitles.push(page.title)
        setPackState(pack.id, s => ({ ...s, results: s.results.map(res => res.url === page.url ? { ...res, status: 'error' as const, error: message } : res) }))
      }
    }

    setPackState(pack.id, s => ({
      ...s,
      running: false,
      notice: failedTitles.length === 0
        ? `${successCount}件を取り込みました。取り込みが完了するまでしばらくお待ちください。`
        : `${successCount}件を取り込みました（失敗: ${failedTitles.length}件）。失敗した分は再試行できます。`,
    }))
    if (successCount > 0 && failedTitles.length === 0) onUploaded()
  }

  const startPack = async (pack: RagPack) => {
    setPackState(pack.id, s => ({ ...s, checking: true, notice: '' }))
    let existingIds: string[] = []
    try {
      const r = await window.electronAPI.rag.list(apiKey, { tag: `pack:${pack.id}` })
      if (r.ok) existingIds = (r.documents ?? []).map(d => d.id)
    } catch {
      // 既存資料の確認に失敗しても、新規取り込みとして続行してよい（致命的ではない）
    }
    if (existingIds.length > 0) {
      setPackState(pack.id, s => ({ ...s, checking: false, confirmReplace: { count: existingIds.length, ids: existingIds } }))
      return
    }
    setPackState(pack.id, s => ({ ...s, checking: false }))
    await runIngest(pack, false)
  }

  const cancelReplace = (id: string) => setPackState(id, s => ({ ...s, confirmReplace: null }))

  const confirmReplaceAndRun = async (pack: RagPack) => {
    const ids = getState(pack.id).confirmReplace?.ids ?? []
    setPackState(pack.id, s => ({ ...s, confirmReplace: null, running: true, notice: '削除しています…' }))
    for (const id of ids) {
      try { await window.electronAPI.rag.delete(apiKey, id) } catch { /* 個別失敗は無視して続行（アップロードで上書きされる） */ }
    }
    await runIngest(pack, false)
  }

  // 費用の目安（会話1回あたり最大何字・何円が追加されうるか）。パックの内容に関わらず一定のため一箇所にまとめて表示する。
  const model = getDefaultModel()
  const maxCharsPerTurn = RAG_TOP_K * CHUNK_MAX_CHARS
  const costPerTurnYen = estimatePackCostPerTurnYen(model)

  return (
    <div className="space-y-4">
      <details className="rounded-xl border border-line bg-surface p-4" open>
        <summary className="text-sm font-semibold text-ink cursor-pointer select-none">💰 費用の目安</summary>
        <div className="mt-2 space-y-1.5 text-xs text-ink-secondary leading-relaxed">
          <p>
            この資料で増える費用: 会話1回あたり最大 約{costPerTurnYen.toFixed(1)}円
            （{modelLabel(model)}・関連する話題のときだけ、最大{maxCharsPerTurn.toLocaleString()}字が追加されます）。
          </p>
          <p>取り込みは一回だけです。索引化した資料は、会話のたびに全文が送られるわけではありません。</p>
        </div>
      </details>

      {RAG_PACKS.map(pack => {
        const state = getState(pack.id)
        const failedCount = state.results.filter(r => r.status === 'error').length
        const doneCount = state.results.filter(r => r.status !== 'pending').length
        return (
          <div key={pack.id} className="rounded-xl border border-line bg-surface p-4 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">{pack.label}</h3>
              <p className="text-xs text-ink-secondary mt-0.5 leading-relaxed">{pack.description}</p>
              <p className="text-[11px] text-ink-muted mt-1">{pack.pages.length}ページ・{formatApproxChars(packTotalChars(pack))}</p>
            </div>

            {state.confirmReplace && (
              <div className="rounded-lg border border-brand-yellow/70 bg-elevated p-3 space-y-2">
                <p className="text-xs text-ink leading-relaxed">
                  ⚠️ 既存{state.confirmReplace.count}件（このパックで登録済みの資料）を削除して取り込み直します。元に戻せません。よろしいですか？
                </p>
                <div className="flex justify-between items-center">
                  <button onClick={() => cancelReplace(pack.id)} className="text-xs text-ink-secondary px-2 py-1 rounded-md hover:bg-overlay">やめる</button>
                  <button onClick={() => confirmReplaceAndRun(pack)} className="text-xs font-semibold text-white bg-brand-red rounded-md px-3 py-1.5 hover:opacity-90">
                    削除して取り込む
                  </button>
                </div>
              </div>
            )}

            {!state.confirmReplace && (
              <button
                onClick={() => startPack(pack)}
                disabled={state.checking || state.running}
                className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
              >
                {state.checking ? '確認中…' : state.running ? `${doneCount}/${state.results.length} 取り込み中…` : '📥 取り込む'}
              </button>
            )}

            {state.results.length > 0 && (
              <ul className="divide-y divide-line max-h-48 overflow-y-auto">
                {state.results.map(r => (
                  <li key={r.url} className="py-1.5 flex items-start gap-2">
                    <span className="flex-none text-xs mt-0.5">
                      {r.status === 'pending' ? '⏳' : r.status === 'ok' ? '✅' : '❌'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-ink truncate" title={r.title}>{r.title}</p>
                      {r.status === 'error' && r.error && (
                        <p className="text-[11px] text-brand-red select-text break-all">{r.error}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {failedCount > 0 && !state.running && !state.confirmReplace && (
              <button onClick={() => runIngest(pack, true)} className="text-xs font-medium text-sakura hover:underline">
                失敗した{failedCount}件を再試行
              </button>
            )}

            {state.notice && (
              <p className="text-xs text-ink bg-elevated border border-line rounded-lg px-3 py-2 leading-relaxed select-text break-all">{state.notice}</p>
            )}
          </div>
        )
      })}

      <p className="text-[11px] text-ink-muted leading-relaxed">
        取得したページは私的利用の範囲でご利用ください。資料には出典URLが記録されます。アップロードした資料はさくらのクラウド（AI Engine）に保存されます。
      </p>
    </div>
  )
}
