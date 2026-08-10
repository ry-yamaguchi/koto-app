import React from 'react'
import SakuraLogo from './SakuraLogo'
import type { Theme } from '../App'

export type AppMode = 'ide' | 'chat'

interface Props {
  mode: AppMode
  onSwitchMode: (m: AppMode) => void
  theme: Theme
  onSwitchTheme: (t: Theme) => void
  showChat: boolean
  showTerminal: boolean
  onToggleChat: () => void
  onToggleTerminal: () => void
  onOpenSettings: () => void
  onPublish: () => void
  onOpenKnowledge: () => void
  onOpenGithubSave: () => void
  onOpenHistory: () => void
  version: string
}

export default function TitleBar({
  mode, onSwitchMode, theme, onSwitchTheme, showChat, showTerminal, onToggleChat, onToggleTerminal, onOpenSettings, onPublish, onOpenKnowledge, onOpenGithubSave, onOpenHistory, version,
}: Props) {
  return (
    <div
      className="h-10 flex items-center px-4 bg-surface border-b border-line flex-none relative"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Brand */}
      <div className="flex items-center gap-2 ml-16 select-none">
        <SakuraLogo size={18} />
        <span className="text-sm font-semibold text-ink tracking-tight">Koto</span>
        {version && <span className="text-[10px] text-ink-muted">v{version}</span>}
      </div>

      {/* Mode switcher — centered */}
      <div
        className="absolute left-1/2 -translate-x-1/2 flex items-center bg-elevated rounded-xl p-1 gap-1 border border-line-soft"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <ModeButton active={mode === 'ide'} onClick={() => onSwitchMode('ide')} label="IDE">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z" />
          </svg>
        </ModeButton>
        <ModeButton active={mode === 'chat'} onClick={() => onSwitchMode('chat')} label="チャット">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
          </svg>
        </ModeButton>
      </div>

      {/* Right controls */}
      <div
        className="ml-auto flex items-center gap-1.5"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {mode === 'ide' && (
          <>
            <button
              onClick={onPublish}
              title="プロジェクトを公開（レンタルサーバ / AppRun / HANAMII）"
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold sakura-gradient text-white hover:opacity-90 transition-opacity shadow-sm"
            >
              🚀 公開
            </button>
            <button
              onClick={onOpenGithubSave}
              title="GitHubに保存（バックアップ・共有）"
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-ink-secondary hover:text-ink hover:bg-overlay transition-colors"
            >
              💾 保存
            </button>
            {/* 「前の方が良かった」ときの戻し先。サイドバーの🕘だけでは見つけてもらえなかったため
                （2026-08-05 利用者フィードバック）、上部にも文字付きで置く。 */}
            <button
              onClick={onOpenHistory}
              title="前の状態に戻す（作業の履歴から選んで、その時点の状態に戻せます）"
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-ink-secondary hover:text-ink hover:bg-overlay transition-colors"
            >
              🕘 元に戻す
            </button>
            <span className="w-px h-4 bg-line mx-0.5" />
            <ToggleChip active={showChat} onClick={onToggleChat} label="AI" title="AIチャットパネルの表示/非表示" />
            <ToggleChip active={showTerminal} onClick={onToggleTerminal} label="ターミナル" title="ターミナルの表示/非表示" />
            <span className="w-px h-4 bg-line mx-0.5" />
          </>
        )}
        <button
          onClick={onOpenKnowledge}
          title="📚 資料（AIに読ませる資料の管理）"
          className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-secondary hover:text-ink hover:bg-overlay transition-colors text-[15px]"
        >
          📚
        </button>
        <ThemeToggle theme={theme} onSwitch={onSwitchTheme} />
        <button
          onClick={onOpenSettings}
          title="設定（AIの利用設定・使用量）"
          className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-secondary hover:text-ink hover:bg-overlay transition-colors"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
          </svg>
        </button>
      </div>
    </div>
  )
}

function ThemeToggle({ theme, onSwitch }: { theme: Theme; onSwitch: (t: Theme) => void }) {
  const isDark = theme === 'dark'
  return (
    <button
      onClick={() => onSwitch(isDark ? 'light' : 'dark')}
      title={isDark ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
      className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-secondary hover:text-ink hover:bg-overlay transition-colors"
    >
      {isDark ? (
        // moon
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 3a9 9 0 109 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 01-4.4 2.26 5.4 5.4 0 01-5.4-5.4c0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z" />
        </svg>
      ) : (
        // sun
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 7a5 5 0 100 10 5 5 0 000-10zM12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8l1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      )}
    </button>
  )
}

function ModeButton({ active, onClick, label, children }: {
  active: boolean; onClick: () => void; label: string; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3.5 py-1 rounded-lg text-xs font-medium transition-all duration-150 ${
        active
          ? 'sakura-gradient text-white shadow-sm'
          : 'text-ink-secondary hover:text-ink hover:bg-overlay'
      }`}
    >
      {children}
      {label}
    </button>
  )
}

function ToggleChip({ active, onClick, label, title }: {
  active: boolean; onClick: () => void; label: string; title?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`text-xs px-2.5 py-1 rounded-lg font-medium transition-colors ${
        active
          ? 'bg-overlay text-ink border border-line'
          : 'text-ink-muted hover:text-ink-secondary border border-transparent'
      }`}
    >
      {label}
    </button>
  )
}
