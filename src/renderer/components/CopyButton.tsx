import React, { useState } from 'react'

// クリップボードへ1クリックでコピーする共通の小ボタン（所見25）。
// 元々 AppRunPanel の PrereqChecklist（診断メッセージのコピー用）にローカル定義されていたものを
// 切り出し、公開URL・リポジトリURLのコピー導線として AppRunPanel / HanamiiPanel / GithubSaveModal で共用する。
export default function CopyButton({ text, title = 'このメッセージをコピー', className }: {
  text: string
  title?: string
  /** 置き場所に合わせて見た目を差し替える（省略時は従来どおり）。
   *  例: 🗂 まとめの中では、隣のボタン（ink-secondary）と濃さを揃える。 */
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ }
      }}
      className={className ?? 'flex-none text-[11px] text-ink-muted hover:text-sakura'}
      title={title}
    >{copied ? '✓ コピーしました' : '📋 コピー'}</button>
  )
}
