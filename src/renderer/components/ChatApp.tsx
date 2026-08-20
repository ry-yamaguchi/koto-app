import React, { useState, useRef, useEffect, useCallback } from 'react'
import SakuraLogo from './SakuraLogo'
import AiMessage from './AiMessage'
import CompactNote from './CompactNote'
import { canCompactNow } from '../historyCompact'
import ThinkingBlock from './ThinkingBlock'
import { MODELS, getDefaultModel, setDefaultModel, isVisionModel, getDefaultVisionModel, modelLabel, pickBestModel } from '../usage'
import { useModels } from '../hooks/useModels'
import { useAiChat, type ChatMessage } from '../hooks/useAiChat'
import { CHAT_CONTEXT } from '../aiContext'
import { fileToDataUrl, countNonImageFiles } from '../imageInput'
import ModelSelect from './ModelSelect'
import { loadAppSessions, saveAppSessions } from '../chatStorage'
import { getAnthropicToken } from './CredentialsModal'
import { isClaudeModeEnabled, CHAT_NO_KEY_MESSAGE, CHAT_NO_KEY_HINT, isChatUsable } from '../claudeMode'
import BrainToggle from './BrainToggle'
import { useFileDrag } from '../hooks/useFileDrag'
import { CHAT_TEXT_WRAP } from '../textWrap'

/** 幾何学的なスクエアの装飾モチーフ（背景の飾り） */
function GeoSquares({ className = '' }: { className?: string }) {
  const palette = ['var(--sakura)', 'var(--orange)', 'var(--yellow)', 'var(--cyan)']
  return (
    <div className={`geo-squares ${className}`}>
      {Array.from({ length: 16 }).map((_, i) => {
        const row = Math.floor(i / 4)
        const c = palette[(row + (i % 4)) % palette.length]
        const opacity = 0.12 + ((row * 4 + (i % 4)) % 5) * 0.06
        return <i key={i} style={{ background: c, opacity }} />
      })}
    </div>
  )
}

type Message = ChatMessage

interface Session {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  model: string
}

interface Props {
  apiKey: string
  onSetApiKey: (key: string) => void
  onOpenCredentials: () => void
  onApplyFile?: (relPath: string, content: string) => Promise<void>
}


function newSession(model: string = getDefaultModel('chat')): Session {
  return { id: Date.now().toString(), title: '新しい会話', messages: [], createdAt: Date.now(), model }
}

function titleFromMessage(content: string): string {
  return content.slice(0, 40) + (content.length > 40 ? '…' : '')
}

function SakuraAvatar() {
  return (
    <div className="flex-none w-8 h-8 rounded-xl bg-white border border-line flex items-center justify-center shadow-sm">
      <SakuraLogo size={18} />
    </div>
  )
}

// メッセージのコピーボタン。押すと1.5秒だけ ✓ を出して、コピーできたことを伝える
function MessageCopyButton({ text, side }: { text: string; side: 'left' | 'right' }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      title={copied ? 'コピーしました' : 'このメッセージをコピー'}
      className={`absolute -top-2 ${side === 'left' ? '-left-2' : '-right-2'} opacity-0 group-hover:opacity-100 transition-opacity bg-elevated border border-line rounded-full w-6 h-6 flex items-center justify-center text-[11px] shadow-sm ${copied ? 'text-brand-green' : 'text-ink-muted hover:text-sakura'}`}
    >{copied ? '✓' : '📋'}</button>
  )
}

export default function ChatApp({ apiKey, onSetApiKey, onOpenCredentials, onApplyFile }: Props) {
  const [sessions, setSessions] = useState<Session[]>(() => [newSession()])
  const [activeId, setActiveId] = useState<string>(() => sessions[0]?.id ?? '')
  // 保存先ワークスペース（`<workspace>/.sakuraide/chats/chat-app.json`）。読み込み完了までは null＝保存しない
  // （切替直後の初期セッション1件でファイルを上書きしないためのガード）。
  const [chatWorkspace, setChatWorkspace] = useState<string | null>(null)
  const models = useModels(apiKey)
  const [input, setInput] = useState('')
  const [pendingImages, setPendingImages] = useState<string[]>([])
  const drag = useFileDrag()
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const activeSession = sessions.find(s => s.id === activeId) ?? sessions[0]

  // モードB（Claudeキーのみ）でもこの画面を表示できるようにするためのゲート判定（ChatPanel.tsx と同じ方式）。
  // ※ 単独チャットはプロジェクト文脈が無くClaudeのツール（ファイル操作等）を使えないため、実際の送信は
  //   従来どおりAI Engine経路のまま（useAiChat.ts が toolsProjectDir=null の場合に案内する）。
  const [claudeReady, setClaudeReady] = useState(false)
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      const key = await getAnthropicToken()
      if (alive) setClaudeReady(!!key && isClaudeModeEnabled())
    }
    refresh()
    window.addEventListener('sakura:credentials-changed', refresh)
    return () => { alive = false; window.removeEventListener('sakura:credentials-changed', refresh) }
  }, [])

  // 送信パイプライン（予算・切替・検索・ツールループ）は共通フックへ集約。
  // 表示はアクティブセッション内のメッセージ列へ反映する。
  const chat = useAiChat({
    apiKey,
    model: activeSession?.model ?? '',
    models,
    // 12: チャットモードは相談役でファイル操作を持たないぶん IDE より少なめだが、
    // 3 では資料検索やWeb取得を数回するだけで尽きていた（ユーザー報告 2026-07-23）。
    maxRounds: 12,
    buildSystemPrompt: () => CHAT_CONTEXT,
    toolsProjectDir: null,
    buildExecuteOpts: () => ({}),
    getHistory: () => activeSession?.messages ?? [],
    updateShown: (updater) => {
      setSessions(prev => prev.map(s => s.id === activeId ? { ...s, messages: updater(s.messages) } : s))
    },
    onUserMessage: (text, isFirst) => {
      if (isFirst) setSessions(prev => prev.map(s => s.id === activeId ? { ...s, title: titleFromMessage(text || '画像') } : s))
    },
    errorPrefix: '⚠️ ',
  })
  const { isLoading, statusNote, stalled, elapsedSec, setRoutedModel } = chat

  // 選択中のモデルが提供終了していたら、提供中の最適なモデルへ自動で切り替える
  useEffect(() => {
    if (!models.length || !activeSession) return
    if (!models.some(m => m.id === activeSession.model)) {
      const next = pickBestModel(models.map(m => m.id))
      updateSession(activeId, { model: next })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, activeId])

  // 画像を取り込む（縮小してdata URL化し、添付候補に追加）
  const addImages = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files)
    // 所見19: 画像以外のファイルが混じっていたら、黙って捨てずにアクティブな会話へ toolNote バブルで案内する
    //（fileToDataUrl は非画像を null で捨てるため、この案内が無いとドロップしても無反応に見えた）。
    if (countNonImageFiles(list) > 0) {
      setSessions(prev => prev.map(s => s.id === activeId ? {
        ...s,
        messages: [...s.messages, {
          role: 'assistant',
          content: '📎 画像ファイル（PNG/JPEGなど）のみ添付できます。それ以外のファイルは取り込みませんでした。',
          toolNote: true,
        }],
      } : s))
    }
    for (const f of list) {
      const url = await fileToDataUrl(f)
      if (url) setPendingImages(prev => [...prev, url])
    }
  }, [activeId])

  // 起動時にセッション一覧を読み込む（`<workspace>/.sakuraide/chats/chat-app.json` 優先→
  // 旧 localStorage 形式 `sakura_sessions` があれば移行→どちらも無ければ初期状態のまま）。
  useEffect(() => {
    let cancelled = false
    loadAppSessions<Session>().then(({ workspaceDir, sessions: loaded }) => {
      if (cancelled) return
      if (loaded && loaded.length > 0) {
        setSessions(loaded)
        setActiveId(loaded[0].id)
      }
      setChatWorkspace(workspaceDir) // ここから保存が有効になる
    })
    return () => { cancelled = true }
  }, [])

  // 保存（デバウンス1.5秒。ストリーミング中は messages がトークン毎に変わるため）。
  // 画像でサイズ超過等の失敗時は、**先に画像をファイルへ書き出してから**落とす。
  // 落としたことは黙らず、会話に出す（2026-08-20。以前は console.warn だけで、
  // 利用者は理由も分からないまま画像を失っていた）。
  // sessionsRef: 直近の sessions を常に保持（アンマウント時のフラッシュ用）。
  const sessionsRef = useRef<Session[]>(sessions)
  sessionsRef.current = sessions
  // 保存は間引いて遅れて走るので、そのときの「いま開いている会話」を ref で持つ。
  const activeIdRef = useRef<string>(activeId)
  activeIdRef.current = activeId

  /** 保存して、画像を落としていたらその事実を会話に出す（同じ知らせは重ねない）。 */
  const droppedNotedRef = useRef(false)
  const saveAndReport = useCallback(async (ws: string, list: Session[]) => {
    const r = await saveAppSessions(ws, list)
    if (!('droppedImages' in r) || droppedNotedRef.current) return
    droppedNotedRef.current = true
    setSessions(prev => prev.map(sess => sess.id === activeIdRef.current
      ? { ...sess, messages: [...sess.messages, { role: 'assistant', content: r.note, toolNote: true } as ChatMessage] }
      : sess))
  }, [])
  useEffect(() => {
    if (!chatWorkspace) return
    const id = window.setTimeout(() => {
      void saveAndReport(chatWorkspace, sessionsRef.current)
    }, 1500)
    return () => window.clearTimeout(id)
  }, [sessions, chatWorkspace])

  // アンマウント時に保存待ちの内容を即座にフラッシュする
  useEffect(() => {
    return () => {
      if (chatWorkspace) void saveAndReport(chatWorkspace, sessionsRef.current)
    }
  }, [chatWorkspace])
  // B: セッション（会話）を切り替えたら割り振りをリセット
  useEffect(() => { setRoutedModel(null) }, [activeId])
  // scrollIntoView は祖先（文書全体）まで横スクロールさせることがあるため、一覧コンテナの内側だけを
  // スクロールする（アプリ全体の横ずれ防止・2026-07-14 ユーザー報告。ChatPanel.tsx と同じ対処）。
  useEffect(() => {
    const sc = bottomRef.current?.parentElement
    if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' })
  }, [activeSession?.messages, isLoading])

  const updateSession = useCallback((id: string, patch: Partial<Session>) => {
    setSessions(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s))
  }, [])

  const createSession = () => {
    const s = newSession(activeSession?.model ?? MODELS[0].id)
    setSessions(prev => [s, ...prev])
    setActiveId(s.id)
    setInput('')
  }

  const deleteSession = (id: string) => {
    const target = sessions.find(s => s.id === id)
    if (target && target.messages.length > 0) {
      if (!window.confirm(`「${target.title}」を削除します。よろしいですか？（元に戻せません）`)) return
    }
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id)
      if (next.length === 0) {
        const fresh = newSession()
        setActiveId(fresh.id)
        return [fresh]
      }
      if (id === activeId) setActiveId(next[0].id)
      return next
    })
  }

  const send = useCallback(() => {
    if (!activeSession) return
    const text = input
    const images = pendingImages
    if ((!text.trim() && images.length === 0) || isLoading) return
    setInput('')
    setPendingImages([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    void chat.send(text, images)
  }, [activeSession, input, pendingImages, isLoading, chat])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() }
  }

  const autoResize = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px'
  }

  // apiKey（さくらのAI Engine）と claudeReady（Claude）のどちらも無い場合のみ案内画面を出す
  // （モードB＝Claudeキーのみの利用者がここで行き止まりにならないよう、ユーザー指摘 2026-07-12 で変更）。
  if (!isChatUsable(!!apiKey, claudeReady)) {
    return (
      <div className="flex items-center justify-center h-full bg-base relative overflow-hidden">
        <GeoSquares className="top-10 right-10 opacity-80" />
        <GeoSquares className="bottom-10 left-10 rotate-180 opacity-60" />
        <div className="w-[400px] bg-elevated rounded-2xl p-8 border border-line shadow-xl fade-in relative z-10 text-center">
          <div className="flex justify-center mb-3"><SakuraLogo size={48} /></div>
          <h2 className="text-2xl font-bold text-ink">Koto <span className="text-sakura">AI</span></h2>
          <p className="text-sm text-ink-secondary mt-1.5 mb-6">{CHAT_NO_KEY_MESSAGE}<br />{CHAT_NO_KEY_HINT}</p>
          <button
            onClick={onOpenCredentials}
            className="w-full sakura-gradient text-white rounded-xl py-3 text-sm font-semibold hover:opacity-90 transition-opacity shadow-sm"
          >
            🔑 APIキーを登録する
          </button>
          <p className="text-xs text-ink-muted text-center mt-4">
            <a href="https://ai.sakura.ad.jp/" className="text-sakura-soft hover:underline">さくらのAI Engine</a> でAPIキーを取得 ・ メニュー ⇧⌘, でも開けます
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full bg-base relative">
      {/* チャットモードでも右下で頭脳（Claude / さくらのAI Engine）を確認・切替できるチップ
          （IDEモードの StatusBar と同じ BrainToggle・2026-07-13 ユーザー要望）。 */}
      <div className="absolute bottom-2 right-3 z-20 bg-elevated/95 border border-line rounded-full px-2.5 py-1 shadow-sm text-[11px]">
        <BrainToggle apiKey={apiKey} />
      </div>
      {/* Session sidebar */}
      <div className="w-[260px] flex-none bg-surface border-r border-line flex flex-col">
        <div className="p-3">
          <button
            onClick={createSession}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl sakura-gradient text-white text-sm font-semibold hover:opacity-90 transition-opacity shadow-sm"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
            </svg>
            新しい会話
          </button>
        </div>

        <div className="px-3 pb-1 text-[11px] font-semibold text-ink-muted uppercase tracking-widest">履歴</div>
        <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {sessions.map(s => (
            <div
              key={s.id}
              onClick={() => setActiveId(s.id)}
              className={`group flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer transition-colors ${
                s.id === activeId ? 'bg-elevated text-ink' : 'text-ink-secondary hover:bg-elevated hover:text-ink'
              }`}
            >
              <span className={`flex-none w-1.5 h-1.5 rounded-full ${s.id === activeId ? 'sakura-gradient' : 'bg-line'}`} />
              <span className="flex-1 text-[13px] truncate">{s.title}</span>
              <button
                onClick={e => { e.stopPropagation(); deleteSession(s.id) }}
                className="flex-none opacity-0 group-hover:opacity-100 text-ink-muted hover:text-brand-red text-xs px-1 transition-all"
              >✕</button>
            </div>
          ))}
        </div>

        <div className="p-3 border-t border-line">
          <button
            onClick={onOpenCredentials}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-ink-secondary hover:bg-elevated hover:text-ink text-[13px] transition-colors"
          >
            <span>🔑</span>
            認証情報（APIキー）
          </button>
          <p className="text-[10px] text-ink-muted text-center mt-2">© 2026 meryo</p>
        </div>
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Model header */}
        <div className="flex flex-col items-center py-2.5 border-b border-line bg-surface flex-none gap-1">
          <div className="flex items-center gap-2">
            <ModelSelect
              models={models}
              value={activeSession?.model ?? ''}
              onChange={id => { if (!activeSession) return; updateSession(activeId, { model: id }); setDefaultModel(id, 'chat'); setRoutedModel(null) }}
              buttonClassName="flex items-center gap-1 text-[13px] bg-elevated border border-line rounded-lg px-3 py-1.5 text-ink hover:border-sakura cursor-pointer transition-colors"
            />
            {/* 頭脳の切替（2026-07-29 ユーザー要望）。右下の BrainToggle と同じもの・同じ書き込み口。 */}
            <BrainToggle apiKey={apiKey} compact />
            {/* 🗂 手動で区切る（2026-08-20 Ryosuke 要望）。押しても意味が無いうちは出さない（掟5）。 */}
            {canCompactNow(activeSession?.messages ?? []) && (
              <button
                onClick={() => void chat.compactNow()}
                disabled={isLoading}
                className="text-[12px] text-ink-secondary hover:text-ink border border-line rounded-lg px-2 py-1.5 whitespace-nowrap disabled:opacity-50"
                title="これまでのやり取りをひとつにまとめて、AIに渡す量を減らします（直近3往復はそのまま残ります。会話は消えません）"
              >🗂 まとめる</button>
            )}
          </div>
        </div>

        {/* Messages */}
        <div
          className={`flex-1 overflow-y-auto relative ${drag.over ? 'ring-2 ring-sakura ring-inset' : ''}`}
          onDragOver={drag.onDragOver}
          onDragLeave={drag.onDragLeave}
          onDrop={e => {
            e.preventDefault(); drag.end()
            if (e.dataTransfer.files?.length) addImages(e.dataTransfer.files)
          }}
        >
          {drag.over && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-base/70 pointer-events-none">
              <span className="text-base font-semibold text-sakura">🖼 画像をドロップしてAIに渡す</span>
            </div>
          )}
          {!activeSession || activeSession.messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 px-4 relative overflow-hidden">
              <GeoSquares className="top-12 right-16 opacity-70" />
              <GeoSquares className="bottom-16 left-16 rotate-180 opacity-50" />
              <SakuraLogo size={72} />
              <h2 className="text-3xl font-bold text-ink">Koto <span className="text-sakura">AI</span></h2>
              {/* 単独チャットは常にAI Engine経路（Claudeはプロジェクトのツールが前提のためIDEモード限定）。
                  apiKeyが無い＝モードBでここへ来た場合は、その旨とIDEモードへの案内を先に伝える。 */}
              <p className="text-sm text-ink-secondary">
                {apiKey ? 'さくらのAI Engineに何でも聞いてください' : 'Claudeモードは、プロジェクトを開いた画面（IDEモード）でご利用ください'}
              </p>
              <div className="grid grid-cols-2 gap-2.5 mt-4 max-w-xl w-full">
                {['コードのレビューをお願いします', 'Pythonでスクレイピングを書いて', 'このエラーの原因は何ですか？', 'TypeScriptの型定義を教えて'].map(s => (
                  <button
                    key={s}
                    onClick={() => { setInput(s); textareaRef.current?.focus() }}
                    className="text-left px-4 py-3 rounded-xl bg-surface hover:bg-elevated text-[13px] text-ink-secondary hover:text-ink transition-colors border border-line hover:border-sakura"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto py-6 px-4 space-y-6">
              {activeSession.messages.map((msg, i) => {
                // 🗂 会話のまとめ。吹き出しではなく、区切りとして中央に出す（本文は折りたたみ）。
                if (msg.summary) return <CompactNote key={i} text={msg.content} />
                // 応答待ち/思考中の空のアシスタント吹き出しは描画しない（「…」インジケータで代替し、空箱が出ないようにする）。
                if (msg.role === 'assistant' && !msg.content.trim() && !msg.images?.length) return null
                return (
                <div key={i} className={`group flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                  {msg.role === 'user' ? (
                    <div className="flex-none w-8 h-8 rounded-xl bg-elevated border border-line flex items-center justify-center text-sm">👤</div>
                  ) : <SakuraAvatar />}
                  <div className={`flex-1 max-w-[85%] ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                    <div className={`relative inline-block px-4 py-3 rounded-2xl text-sm select-text text-left ${
                      msg.role === 'user'
                        ? 'sakura-gradient text-white rounded-tr-md'
                        : 'bg-surface border border-line text-ink rounded-tl-md'
                    }`}>
                      <MessageCopyButton text={msg.content} side={msg.role === 'user' ? 'left' : 'right'} />
                      {msg.images && msg.images.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-1.5 justify-end">
                          {msg.images.map((src, k) => (
                            <img key={k} src={src} alt="" className="max-h-40 rounded-lg border border-white/30 object-cover" />
                          ))}
                        </div>
                      )}
                      {/* 推論モデルの思考（表示専用・ChatPanel と同じ扱い） */}
                      {msg.role === 'assistant' && msg.thinking && (
                        <ThinkingBlock text={msg.thinking} live={isLoading && i === activeSession.messages.length - 1} />
                      )}
                      {msg.role === 'assistant' ? <AiMessage content={msg.content} onApplyFile={onApplyFile} applyHint="保存後の編集・実行・公開は、画面上部の切替で IDE モードに移って行えます" /> : (msg.content && <p className={CHAT_TEXT_WRAP}>{msg.content}</p>)}
                      {/* #31: Claudeが使えないときの「さくらのAI Engineに切り替えて続ける」提案ボタン。 */}
                      {msg.offerAiEngineFallback && (
                        <button
                          onClick={() => chat.switchToAiEngineAndResend(msg.offerAiEngineFallback!.text, msg.offerAiEngineFallback!.images ?? [])}
                          className="mt-2 sakura-gradient text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
                        >さくらのAI Engine に切り替えて続ける</button>
                      )}
                      {/* ツール実行の回数上限で区切ったときの「続ける」ボタン（従来は「続けて」と手入力が必要だった）。 */}
                      {msg.offerContinue && (
                        <button
                          onClick={() => chat.send('続けて', [])}
                          disabled={chat.isLoading}
                          className="mt-2 sakura-gradient text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
                        >▶ 続ける</button>
                      )}
                    </div>
                  </div>
                </div>
                )
              })}
              {isLoading && (
                <div className="flex gap-3">
                  <SakuraAvatar />
                  <div className="bg-surface border border-line rounded-2xl rounded-tl-md px-4 py-3">
                    <div className="flex gap-2 items-center h-5">
                      <span className="text-xs text-ink-secondary">
                        {statusNote || (stalled ? '⏳ 時間がかかっています…（⏹ で停止できます）' : '考えています…')}
                        {elapsedSec >= 3 && <span className="ml-1 tabular-nums text-ink-muted">{elapsedSec}秒</span>}
                      </span>
                      <div className="flex gap-1.5 items-center">
                        {[0, 1, 2].map(i => (
                          <span key={i} className="w-2 h-2 rounded-full sakura-gradient" style={{ animation: `bounce-dot 1.2s ${i * 0.16}s infinite ease-in-out` }} />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-line bg-surface px-4 py-3 flex-none">
          <div className="max-w-3xl mx-auto">
            {/* 添付画像のプレビュー */}
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mb-2 px-1">
                {pendingImages.map((src, i) => (
                  <div key={i} className="relative">
                    <img src={src} alt="" className="h-16 w-16 object-cover rounded-lg border border-line" />
                    <button
                      onClick={() => setPendingImages(prev => prev.filter((_, k) => k !== i))}
                      className="absolute -top-1.5 -right-1.5 bg-base border border-line text-ink-muted hover:text-sakura rounded-full w-5 h-5 flex items-center justify-center text-[11px]"
                      title="削除"
                    >×</button>
                  </div>
                ))}
                {/* AI Engineキーが無い（モードB）場合、単独チャットの送信はIDEモードへの案内になるため
                    視覚モデルへの委譲は発生しない（案内を出さない）。 */}
                {apiKey && activeSession && !isVisionModel(activeSession.model) && (
                  <span className="text-[11px] text-ink-muted">
                    送信時に画像対応モデル（{modelLabel(getDefaultVisionModel())}）で処理します
                  </span>
                )}
              </div>
            )}
            <div className="flex items-end gap-3 bg-elevated rounded-2xl px-4 py-3 border border-line focus-within:border-sakura transition-colors">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={e => { if (e.target.files?.length) addImages(e.target.files); e.target.value = '' }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex-none text-ink-muted hover:text-sakura text-lg pb-0.5 transition-colors"
                title="画像を添付"
              >📎</button>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={autoResize}
                onKeyDown={handleKeyDown}
                onPaste={e => {
                  // 所見19: 非画像も addImages へ渡し、案内を出せるようにする（filesが空＝テキスト貼付けはそのまま）。
                  const files = Array.from(e.clipboardData.files)
                  if (files.length) { e.preventDefault(); addImages(files) }
                }}
                placeholder="Koto AIにメッセージを送る…"
                rows={1}
                className="flex-1 bg-transparent text-sm text-ink placeholder-ink-muted outline-none resize-none leading-relaxed"
                style={{ minHeight: '24px', maxHeight: '200px' }}
              />
              {isLoading ? (
                <button
                  onClick={() => chat.abort()}
                  className="flex-none w-8 h-8 bg-elevated border border-brand-red text-brand-red rounded-xl flex items-center justify-center hover:bg-brand-red-fill hover:text-white transition-colors shadow-sm"
                  title="応答を停止"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={!input.trim() && pendingImages.length === 0}
                  className="flex-none w-8 h-8 sakura-gradient text-white rounded-xl flex items-center justify-center hover:opacity-90 disabled:opacity-30 transition-opacity shadow-sm"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                </button>
              )}
            </div>
            <p className="text-[11px] text-ink-muted text-center mt-2">⌘+Enter で送信{apiKey ? ' · さくらのAI Engine' : ''}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
