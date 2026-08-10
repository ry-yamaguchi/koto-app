import React, { useEffect, useState } from 'react'
import type { OpenFile } from '../App'
import type { ProjectMeta } from './WorkflowBar'
import BrainToggle from './BrainToggle'

interface Props {
  activeFile: OpenFile | null
  meta?: ProjectMeta | null
  /** さくらのAI Engineのキー（Claude頭脳モードのツールチップ文言の出し分けに使う）。 */
  apiKey?: string
}

const TARGET_SHORT: Record<string, string> = {
  'sakura-rental': 'レンタルサーバ',
  'sakura-apprun': 'AppRun',
}

// Monaco の言語ID（英小文字）を、わかりやすい表示名に整形する
const LANGUAGE_LABEL: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  typescriptreact: 'TypeScript (React)',
  javascriptreact: 'JavaScript (React)',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  json: 'JSON',
  php: 'PHP',
  python: 'Python',
  markdown: 'Markdown',
  shell: 'Shell',
  yaml: 'YAML',
  sql: 'SQL',
  xml: 'XML',
}

function languageLabel(lang: string): string {
  return LANGUAGE_LABEL[lang] ?? lang
}

// ISO を `M/D` の短い日付に整形（公開済みラベル用）。失敗時は空文字。
function shortDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// ISO を `最終公開操作: YYYY/MM/DD HH:mm` の title 文言に整形。失敗時は空文字。
function publishedTitle(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `最終公開操作: ${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function StatusBar({ activeFile, meta, apiKey }: Props) {
  // チャットの頭脳表示＋クリック切替は BrainToggle（ChatApp と共用）へ抽出（2026-07-13）。
  const published = meta?.publish?.lastPublishedAt
  const url = meta?.publish?.url
  const date = shortDate(published)
  const title = publishedTitle(published)
  const targetLabel = TARGET_SHORT[meta?.target ?? ''] ?? meta?.target
  // 例:「レンタルサーバ 6/12」/ 日付が取れなければ公開先のみ
  const publishedLabel = date ? `${targetLabel} ${date}` : targetLabel
  return (
    <div className="flex items-center px-3 h-6 bg-surface border-t border-line text-[11px] gap-3 flex-none text-ink-secondary">
      <span className="flex items-center gap-1.5 font-medium">
        <span className="w-1.5 h-1.5 rounded-full sakura-gradient" />
        Koto
      </span>
      {published && (
        <>
          <span className="text-ink-muted">·</span>
          {url?.startsWith('http') ? (
            <a href={url} className="text-brand-green hover:underline font-medium" title={title || url}>
              🌐 公開済み（{publishedLabel}）
            </a>
          ) : (
            <span className="text-brand-green font-medium" title={title || undefined}>🌐 公開済み（{publishedLabel}）</span>
          )}
        </>
      )}
      {activeFile ? (
        <>
          <span className="text-ink-muted">·</span>
          <span className="text-ink-secondary">{languageLabel(activeFile.language)}</span>
          <span className="text-ink-muted">·</span>
          <span className="truncate max-w-[420px] text-ink-muted">{activeFile.path}</span>
          {activeFile.isDirty && (
            <span className="text-sakura font-medium">● 未保存</span>
          )}
        </>
      ) : (
        <>
          <span className="text-ink-muted">·</span>
          <span className="text-ink-muted">ファイルを開くと情報が表示されます</span>
        </>
      )}
      <BrainToggle apiKey={apiKey} className="ml-auto" />
    </div>
  )
}
