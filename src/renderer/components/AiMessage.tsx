import React, { useMemo, useState } from 'react'
import { CHAT_TEXT_WRAP } from '../textWrap'
import { parseChatText, type ChatInline } from '../chatMarkdown'

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
      {state === 'error' && <div className="px-3 py-1.5 text-[11px] text-white bg-brand-red-fill">{err}</div>}
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

/**
 * 1 行ぶんの太字・コード・文字を React の要素にする。
 * **文字列は React の子として渡すだけ**（HTML の文字列を差し込む書き方はしない）ので、
 * AI の返事に <script> や <b> が入っても、タグではなく文字として出る。
 */
function Inlines({ inlines }: { inlines: ChatInline[] }) {
  return (
    <>
      {inlines.map((n, i) => {
        if (n.t === 'bold') return <strong key={i} className="font-bold">{n.s}</strong>
        if (n.t === 'code') return <code key={i} className="rounded border border-line bg-overlay px-1 font-mono text-[0.9em] text-ink">{n.s}</code>
        return <React.Fragment key={i}>{n.s}</React.Fragment>
      })}
    </>
  )
}

/**
 * 説明文（コードブロック以外）。段落・箇条書き・見出しに分けて描く。
 * plain のときは何も解釈せず、今までどおり文字のまま出す（Koto 自身の一言: ChatMessage.toolNote）。
 */
function ChatText({ text, plain }: { text: string; plain?: boolean }) {
  // 解析は text が変わったときだけ（流し込み中、別の部分だけが変わる描き直しで、全文を解析し直さない）
  const blocks = useMemo(() => (plain ? [] : parseChatText(text)), [text, plain])
  if (plain) return <p className={CHAT_TEXT_WRAP}>{text}</p>
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        if (b.kind === 'raw') {
          // 閉じていない ```（流し込み中）。コードの途中なので、記号を消さずそのまま出す
          return <p key={i} className={CHAT_TEXT_WRAP}>{b.text}</p>
        }
        if (b.kind === 'heading') {
          return <p key={i} className={`font-bold ${CHAT_TEXT_WRAP}`}><Inlines inlines={b.inlines} /></p>
        }
        if (b.kind === 'list') {
          return (
            <ul key={i} className="list-disc pl-5 space-y-1">
              {b.items.map((it, j) => <li key={j} className={CHAT_TEXT_WRAP}><Inlines inlines={it} /></li>)}
            </ul>
          )
        }
        return (
          <p key={i} className={CHAT_TEXT_WRAP}>
            {b.lines.map((ln, j) => (
              <React.Fragment key={j}>{j > 0 ? '\n' : null}<Inlines inlines={ln} /></React.Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}

/**
 * AI が書いた文を描く、アプリで唯一の部品（2026-10-09 作者決定「そっちも直しましょう」）。
 * 説明文は太字・箇条書き・見出し・インラインコードに、コードブロックはカードにする。
 *
 * 使う場所: チャットの吹き出し（AiMessage）／「資料に聞く」の回答（KnowledgeAnswer）／
 * 公開前セキュリティチェックの結果のうち AI が書いた行（SecurityReportBody。Koto が組み立てた行は plain で出す）／
 * 会話のまとめ（CompactNote）／推論モデルの思考（ThinkingBlock）。
 * 場所ごとに描き方を変えない（双子を作らない・掟10）。**違うのは外側の見た目だけ**で、className で渡す
 * （文字の大きさ・色・select-text・最大の高さ。ここでは決めない）。
 * 説明文の折り返しは、どの場所も CHAT_TEXT_WRAP（区切りの無い長い URL・ファイル名も端で折る）。
 *
 * onApplyFile を渡さなければ、ファイル提案（file=）のカードに「プロジェクトに保存」は出ない
 * （チャット以外の場所は保存先を持たない）。content が文字でなくても例外を投げない。
 * plain: 説明文の ** ・` ・- ・# を解釈しない。Koto が出す作業中の一言（toolNote）に付ける。
 * その一言には AI が渡したコマンドや glob の模様が入り、解釈すると実行する内容と違う文になる。
 */
export function AiText({ content, className, onApplyFile, applyHint, plain }: {
  content: string
  className?: string
  onApplyFile?: (relPath: string, content: string, root?: string | null) => Promise<void>
  applyHint?: string
  plain?: boolean
}) {
  // コードブロックの切り出しも content が変わったときだけ（ThinkingBlock のように長い文を何度も描き直す所のため）
  const parts = useMemo(() => parseMessage(typeof content === 'string' ? content : ''), [content])
  return (
    <div className={className}>
      {parts.map((p, i) => {
        if (p.type === 'text') return <ChatText key={i} text={p.text} plain={plain} />
        if (p.type === 'file') return <FileCard key={i} path={p.path} lang={p.lang} code={p.code} onApply={onApplyFile} applyHint={applyHint} />
        return <InlineCode key={i} lang={p.lang} code={p.code} />
      })}
    </div>
  )
}

/** チャットの吹き出し。AiText に、吹き出しの文字の大きさ（text-sm・leading-relaxed）を付けただけ。 */
export default function AiMessage({ content, onApplyFile, applyHint, plain }: {
  content: string
  onApplyFile?: (relPath: string, content: string, root?: string | null) => Promise<void>
  applyHint?: string
  plain?: boolean
}) {
  return <AiText content={content} className="text-sm leading-relaxed" onApplyFile={onApplyFile} applyHint={applyHint} plain={plain} />
}
