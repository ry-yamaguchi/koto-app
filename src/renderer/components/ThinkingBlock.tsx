import React, { useEffect, useRef, useState } from 'react'
import { CHAT_TEXT_WRAP } from '../textWrap'

// 推論モデル（Kimi K2.7 / gpt-oss 等）の「思考」を、生成中はライブで見せ、終わったら畳む折りたたみ表示。
//
// 背景（2026-08-03 ユーザー要望）: 推論モデルは本文を出すまで数十秒沈黙することがあり、
// 画面には「⏳ 時間がかかっています…」しか出ず、止まったのか進んでいるのか分からなかった。
// 実は思考は最初からストリームで届いていた（main/ipc/sakura.ts が溜め込むだけで捨てていた）ため、
// それをそのまま見せる。**本文が主役**なので、生成が終わったら自動で畳む。
//
// 表示専用: この内容はAPIへ送り返さず、チャット履歴にも保存しない（chatStorage.ts の forStorage 参照）。

/** 「AIの思考を常に開いたままにする」設定（SettingsModal で切り替え）。 */
export const SHOW_THINKING_KEY = 'sakura_show_thinking'
export const isThinkingAlwaysOpen = (): boolean => localStorage.getItem(SHOW_THINKING_KEY) === '1'

export default function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const alwaysOpen = isThinkingAlwaysOpen()
  const [open, setOpen] = useState(live || alwaysOpen)
  // ユーザーが自分で開閉したら、その意思を尊重して自動開閉しない
  const touchedRef = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // 生成が終わったら自動で畳む（設定で「常に表示」なら畳まない）
  useEffect(() => {
    if (touchedRef.current || alwaysOpen) return
    setOpen(live)
  }, [live, alwaysOpen])

  // 流れている間は最新行を追う（自分でスクロールしたい場合もあるので、live のときだけ）
  useEffect(() => {
    if (!open || !live) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text, open, live])

  if (!text.trim()) return null

  return (
    <div className="mb-1.5 rounded-lg border border-line bg-surface/60">
      <button
        onClick={() => { touchedRef.current = true; setOpen(o => !o) }}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-[11px] text-ink-muted hover:text-ink"
        title={open ? '思考を隠す' : '思考を表示する'}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>🧠 {live ? '考えています…' : '考えた内容'}</span>
        <span className="ml-auto tabular-nums">{text.length.toLocaleString()}文字</span>
      </button>
      {open && (
        <div
          ref={bodyRef}
          className={`px-2 pb-2 max-h-40 overflow-y-auto text-[11px] text-ink-secondary leading-relaxed select-text ${CHAT_TEXT_WRAP}`}
        >{text}</div>
      )}
    </div>
  )
}
