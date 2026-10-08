import React, { useEffect, useState } from 'react'
import { getAnthropicToken } from './CredentialsModal'
import { isClaudeModeEnabled, setClaudeMode } from '../claudeMode'

/**
 * チャットの頭脳（Claude / さくらのAI Engine）の表示＋クリック切替。
 * StatusBar（IDEモード右下）から抽出し、ChatApp（チャットモード右下）でも共用する
 * （2026-07-13 ユーザー要望: チャットモードでもIDEと同様に右下クリックで切り替えたい）。
 * 両方のキーが登録済みのときだけクリックで切替できる（⇄ 付き）。片方のみは表示のみ。
 * setClaudeMode は 'sakura:credentials-changed' を dispatch するため、切替は全画面に即反映される。
 *
 * compact: モデル選択の横（チャットのヘッダ）に置くための小さな枠付き表示
 * （2026-07-29 ユーザー要望: 右下と設定だけでなく、モデル選択の横でも切り替えたい）。
 * ヘッダは幅が厳しいため表示名を短くし、正式名称はツールチップで補う。
 * 枠のスタイルは同じヘッダにある「🪄 おまかせ」ボタンに揃える（掟5: UIの文法）。
 *
 * chatMode: ChatApp（単独チャット）から使うときに立てる（W-19）。チャットモードの会話は、
 * Claude のキーがあっても必ず さくらのAI Engine が答える（toolsProjectDir が無いため。
 * useAiChat.ts の send() 参照）。切り替えられる（両方のキーがある）ときに限り、表示を
 * 実際に答える相手に揃える——片方のキーだけのときは、チップだけで「AI Engine が必ず答える」
 * と言い切ると誤りうる（Claudeキーのみだと誰も答えず、別の案内に任せている）ため、対象外のまま。
 */
export default function BrainToggle({ apiKey, className = '', compact = false, chatMode = false }: { apiKey?: string; className?: string; compact?: boolean; chatMode?: boolean }) {
  const [claudeActive, setClaudeActive] = useState(false)
  // Claudeキーが登録済みか（モードのオン/オフとは別。切替可否の判定に使う）。
  const [hasClaudeKey, setHasClaudeKey] = useState(false)
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      const key = await getAnthropicToken()
      if (!alive) return
      setHasClaudeKey(!!key)
      setClaudeActive(!!key && isClaudeModeEnabled())
    }
    refresh()
    window.addEventListener('sakura:credentials-changed', refresh)
    return () => { alive = false; window.removeEventListener('sakura:credentials-changed', refresh) }
  }, [])
  const canToggle = hasClaudeKey && !!apiKey?.trim()
  const toggle = () => { if (canToggle) setClaudeMode(!isClaudeModeEnabled()) }
  const chatModeToggleable = chatMode && canToggle

  // ツールチップは compact でも省略せず正式名称で出す（表示名だけを短くする）。
  const title = chatModeToggleable
    ? 'チャットモードでは、いつも さくらのAI Engine が答えます。ここで切り替えると IDE の AI が変わります'
    : canToggle
      ? (claudeActive
        ? 'チャットの頭脳: Claude（クリックで さくらのAI Engine に切り替え）'
        : 'チャットの頭脳: さくらのAI Engine（クリックで Claude に切り替え）')
      : (claudeActive ? 'チャットの頭脳: Claude' : 'チャットの頭脳: さくらのAI Engine')

  if (compact) {
    // W-19: チャットモードで切り替えられるときは、短いラベルは「🧠 AI Engine」に据え置く
    // （ヘッダは幅が厳しいため、長い注記は title だけに置く）。
    const label = chatModeToggleable ? '🧠 AI Engine' : (claudeActive ? '🧠 Claude' : '🧠 AI Engine')
    const base = 'text-[11px] border border-line rounded-md px-1.5 py-0.5 whitespace-nowrap text-ink-muted'
    if (!canToggle) return <span className={`${base} ${className}`} title={title}>{label}</span>
    return (
      <button onClick={toggle} className={`${base} hover:text-ink hover:border-sakura transition-colors ${className}`} title={title}>
        {label} ⇄
      </button>
    )
  }

  if (canToggle) {
    return (
      <button
        onClick={toggle}
        className={`flex items-center gap-1.5 text-ink-muted hover:text-ink transition-colors ${className}`}
        title={title}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-brand-green" />
        {/* W-19: 右下の非compact版は文字量に余裕があるため、誰が答えるかを文字でも示す。 */}
        {chatModeToggleable ? 'AI Engine（Claude は IDE で）' : (claudeActive ? 'Claude' : 'さくらのAI Engine')}
        <span className="text-ink-muted">⇄</span>
      </button>
    )
  }
  return (
    <span
      className={`flex items-center gap-1.5 text-ink-muted ${className}`}
      title={claudeActive ? 'チャットの頭脳: Claude' : 'チャットの頭脳: さくらのAI Engine'}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-brand-green" />
      {claudeActive ? 'Claude' : 'さくらのAI Engine'}
    </span>
  )
}
