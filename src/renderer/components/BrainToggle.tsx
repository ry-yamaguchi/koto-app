import React, { useEffect, useState } from 'react'
import { getAnthropicToken } from './CredentialsModal'
import { isClaudeModeEnabled, setClaudeMode } from '../claudeMode'

/** チャットモードの表示（押せない）のツールチップ。 */
export const CHAT_MODE_TITLE = 'Claude は、プロジェクトを開いた画面（IDEモード）で使えます'

export type BrainToggleView = {
  /** 押して切り替えられる表示か（false なら button ではなく span で出す）。 */
  clickable: boolean
  label: string
  title: string
}

/**
 * 表示の中身（純関数）。chatMode は、Claude のキー・compact にかかわらず、押せない固定の表示。
 * ただし さくらのAI Engine のキーが無いとき（hasEngineKey=false）は何も出さない（null）。そのチャットは誰も答えず、
 * 画面の中央が「Claudeモードは、プロジェクトを開いた画面（IDEモード）でご利用ください」と案内するので、
 * 「さくらのAI Engine」と出すと食い違う（2026-10-15 検分。送信欄の下も、キーが無ければ AI Engine と書かない）。
 * chatMode でないとき（IDE の右下・AIチャット欄の横）は、両方のキーがあるときだけ押せる（canToggle）。
 */
export function brainToggleView(o: { canToggle: boolean; claudeActive: boolean; compact: boolean; chatMode: boolean; hasEngineKey: boolean }): BrainToggleView | null {
  if (o.chatMode) return o.hasEngineKey ? { clickable: false, label: 'さくらのAI Engine', title: CHAT_MODE_TITLE } : null
  // ツールチップは compact でも省略せず正式名称で出す（表示名だけを短くする）。
  const title = o.canToggle
    ? (o.claudeActive
      ? '使う AI: Claude（クリックで さくらのAI Engine に切り替え）'
      : '使う AI: さくらのAI Engine（クリックで Claude に切り替え）')
    : (o.claudeActive ? '使う AI: Claude' : '使う AI: さくらのAI Engine')
  const label = o.compact
    ? (o.claudeActive ? '🧠 Claude' : '🧠 AI Engine')
    : (o.claudeActive ? 'Claude' : 'さくらのAI Engine')
  return { clickable: o.canToggle, label, title }
}

/**
 * 使う AI（Claude / さくらのAI Engine）の表示＋クリック切替。
 * StatusBar（IDEモード右下）から抽出し、ChatApp（チャットモード右下）でも共用する（2026-07-13 ユーザー要望）。
 * チャットモードの右下は、のちに押せない表示へ変えた（下の chatMode）。
 * 両方のキーが登録済みのときだけクリックで切替できる（⇄ 付き）。片方のみは表示のみ。
 * setClaudeMode は 'sakura:credentials-changed' を dispatch するため、切替は全画面に即反映される。
 *
 * compact: モデル選択の横（IDE の AIチャット欄のヘッダ）に置くための小さな枠付き表示
 * （2026-07-29 ユーザー要望: 右下と設定だけでなく、モデル選択の横でも切り替えたい）。
 * ヘッダは幅が厳しいため表示名を短くし、正式名称はツールチップで補う。
 * 枠のスタイルは同じヘッダにある「🪄 おまかせ」ボタンに揃える（掟5: UIの文法）。
 *
 * chatMode: ChatApp（単独チャット）の右下のチップから使うときに立てる。押せない表示（緑の点＋「さくらのAI Engine」）にする。
 * さくらのAI Engine のキーが無ければ何も出さない（brainToggleView）。
 * 2026-10-15 作者決定: チャットモードでは切り替えない。チャットモードの会話は、Claude のキーがあっても
 * 必ず さくらのAI Engine が答える（toolsProjectDir が無いため。useAiChat.ts の send() 参照）。
 * 以前は両方のキーがあると押せる表示（⇄）にしていたが、押しても IDEモードで使う AI だけが変わり、
 * チャットの表示は変わらないため、効かないように見えた。Claude は IDE モードで使う
 * （切り替えの入口は IDE の右下・AIチャット欄のモデル選択の横・設定の「IDEモードで使う AI」）。
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
  const view = brainToggleView({ canToggle, claudeActive, compact, chatMode, hasEngineKey: !!apiKey?.trim() })
  if (!view) return null

  if (compact) {
    const base = 'text-[11px] border border-line rounded-md px-1.5 py-0.5 whitespace-nowrap text-ink-muted'
    if (!view.clickable) return <span className={`${base} ${className}`} title={view.title}>{view.label}</span>
    return (
      <button onClick={toggle} className={`${base} hover:text-ink hover:border-sakura transition-colors ${className}`} title={view.title}>
        {view.label} ⇄
      </button>
    )
  }

  if (view.clickable) {
    return (
      <button
        onClick={toggle}
        className={`flex items-center gap-1.5 text-ink-muted hover:text-ink transition-colors ${className}`}
        title={view.title}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-brand-green" />
        {view.label}
        <span className="text-ink-muted">⇄</span>
      </button>
    )
  }
  return (
    <span
      className={`flex items-center gap-1.5 text-ink-muted ${className}`}
      title={view.title}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-brand-green" />
      {view.label}
    </span>
  )
}
