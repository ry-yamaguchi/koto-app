import React, { useState } from 'react'
import { CHAT_TEXT_WRAP } from '../textWrap'

type Part =
  | { type: 'text'; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'file'; path: string; lang: string; code: string }

/** アシスタントの返答を「説明文」「コードブロック」「ファイル提案(file=パス付き)」に分解する */
export function parseMessage(content: string): Part[] {
  const parts: Part[] = []
  const re = /```([^\n`]*)\n([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) {
      const text = content.slice(last, m.index).trim()
      if (text) parts.push({ type: 'text', text })
    }
    const info = (m[1] || '').trim()
    const code = m[2].replace(/\n$/, '')
    // info 例: "js file=src/server.js" / "ts path=app.ts" / "python"
    const fileMatch = info.match(/(?:file|path)=([^\s]+)/)
    const lang = info.split(/\s+/)[0]?.replace(/(?:file|path)=.*/, '') || ''
    if (fileMatch) {
      parts.push({ type: 'file', path: fileMatch[1].replace(/^\.?\//, ''), lang, code })
    } else {
      parts.push({ type: 'code', lang, code })
    }
    last = re.lastIndex
  }
  const tail = content.slice(last).trim()
  if (tail) parts.push({ type: 'text', text: tail })
  return parts
}

function InlineCode({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="my-2 rounded-xl overflow-hidden border border-line">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface border-b border-line">
        <span className="text-[11px] text-ink-muted font-mono">{lang || 'code'}</span>
        <button
          onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
          className="text-[11px] text-ink-muted hover:text-sakura"
        >{copied ? '✓ コピーしました' : 'コピー'}</button>
      </div>
      <pre className="bg-base px-3 py-2 overflow-x-auto text-[12px] font-mono text-ink leading-relaxed"><code>{code}</code></pre>
    </div>
  )
}

function FileCard({ path, lang, code, onApply, applyHint }: {
  path: string; lang: string; code: string
  onApply?: (relPath: string, content: string) => Promise<void>
  applyHint?: string
}) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<'idle' | 'applying' | 'done' | 'error'>('idle')
  const [err, setErr] = useState('')

  const apply = async () => {
    if (!onApply) return
    setState('applying'); setErr('')
    try { await onApply(path, code); setState('done') }
    catch (e: any) { setState('error'); setErr(e?.message ?? String(e)) }
  }

  return (
    <div className="my-2 rounded-xl overflow-hidden border border-sakura/40 bg-surface">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <span className="text-sm">📄</span>
        <button onClick={() => setOpen(o => !o)} className="text-[12px] font-mono text-ink truncate flex-1 text-left hover:text-sakura" title={path}>
          {path}
        </button>
        <button
          onClick={() => navigator.clipboard.writeText(code)}
          className="text-[11px] text-ink-muted hover:text-ink flex-none"
        >コピー</button>
        {onApply && (
          <button
            onClick={apply}
            disabled={state === 'applying' || state === 'done'}
            className={`text-[11px] font-semibold rounded-md px-2 py-1 flex-none transition-opacity ${
              state === 'done' ? 'bg-brand-green/20 text-brand-green' : 'sakura-gradient text-white hover:opacity-90 disabled:opacity-50'
            }`}
          >
            {state === 'applying' ? '保存中…' : state === 'done' ? '✓ 保存しました' : '💾 プロジェクトに保存'}
          </button>
        )}
      </div>
      {state === 'error' && <div className="px-3 py-1.5 text-[11px] text-white bg-brand-red/90">{err}</div>}
      {applyHint && (
        <div className="px-3 py-1.5 text-[11px] text-ink-muted border-t border-line-soft">💡 {applyHint}</div>
      )}
      {open && (
        <pre className="bg-base px-3 py-2 overflow-x-auto text-[12px] font-mono text-ink leading-relaxed max-h-72">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}

/** アシスタントメッセージの表示。説明文はテキスト、コードはカードに分離。 */
export default function AiMessage({ content, onApplyFile, applyHint }: {
  content: string
  onApplyFile?: (relPath: string, content: string) => Promise<void>
  applyHint?: string
}) {
  const parts = parseMessage(content)
  return (
    <div className="text-sm leading-relaxed">
      {parts.map((p, i) => {
        if (p.type === 'text') return <p key={i} className={CHAT_TEXT_WRAP}>{p.text}</p>
        if (p.type === 'file') return <FileCard key={i} path={p.path} lang={p.lang} code={p.code} onApply={onApplyFile} applyHint={applyHint} />
        return <InlineCode key={i} lang={p.lang} code={p.code} />
      })}
    </div>
  )
}
