import React from 'react'
import SakuraLogo from './SakuraLogo'
import { CHAT_NO_KEY_MESSAGE, CHAT_NO_KEY_HINT } from '../claudeMode'

/** さくらを使う設定のプロジェクトで、さくらのAI Engine のキーが無く、Claude のキーはあるときの案内の文。 */
export const ENGINE_KEY_MISSING_TEXT = 'このプロジェクトで使う AI は さくらのAI Engine ですが、キーが登録されていません。'
/** 押したときだけ、このプロジェクトの使う AI を Claude にするボタンの文。 */
export const USE_CLAUDE_HERE_LABEL = 'このプロジェクトでは Claude を使う'

const KEY_BUTTON = 'sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 transition-opacity'

/**
 * チャット欄で使える AI が無いときの案内（ChatPanel から切り出した）。
 * onUseClaudeHere があるとき（さくらを使う設定・さくらのキー無し・Claude のキー有り）は、黙って Claude にせず、
 * 利用者が押したときだけ Claude にするボタンを並べる。無いときは、キーの登録だけを案内する。
 */
export default function ChatKeyMissing({ onOpenCredentials, onUseClaudeHere }: { onOpenCredentials: () => void; onUseClaudeHere?: () => void }) {
  if (onUseClaudeHere) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 gap-3 text-center">
        <SakuraLogo size={40} />
        <span className="text-sm font-semibold sakura-gradient-text">Koto AI</span>
        <p className="text-xs text-ink-secondary">{ENGINE_KEY_MISSING_TEXT}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button onClick={onOpenCredentials} className={KEY_BUTTON}>
            🔑 APIキーを登録する
          </button>
          <button
            onClick={onUseClaudeHere}
            className="text-sm text-ink-secondary hover:text-ink border border-line rounded-lg px-4 py-2 hover:border-sakura transition-colors"
          >
            {USE_CLAUDE_HERE_LABEL}
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center justify-center h-full p-6 gap-3 text-center">
      <SakuraLogo size={40} />
      <span className="text-sm font-semibold sakura-gradient-text">Koto AI</span>
      <p className="text-xs text-ink-secondary">{CHAT_NO_KEY_MESSAGE}<br />{CHAT_NO_KEY_HINT}</p>
      <button onClick={onOpenCredentials} className={KEY_BUTTON}>
        🔑 APIキーを登録する
      </button>
      <p className="text-[11px] text-ink-muted mt-1">
        <a href="https://ai.sakura.ad.jp/" className="text-sakura-soft hover:underline">さくらのAI Engine</a> で取得 ・ ⇧⌘, でも開けます
      </p>
    </div>
  )
}
