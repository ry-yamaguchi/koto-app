import React from 'react'
import { buildCrashReport } from '../../shared/crashReport'

// 画面の例外で全体が白くならないための受け皿（クラス部品。フック版は無い）。
// 全体（scope="app"）は main.tsx の1か所、領域（scope="region"）は App.tsx の5か所（サイドバー・エディタ・ターミナル・
// チャット・単独チャット）。領域のほうは、その部分だけを読み直せる（key の付け替え）。

/** 全体の表示に出す文（保存していない編集を失うことを、ここで言う）。 */
export const APP_CRASH_TEXT = '問題が起きました。もう一度読み込むと、保存していない編集は失われます。'
export const REGION_CRASH_TEXT = 'この部分で問題が起きました。'

/** テーマのクラスの外（main.tsx）に出るので、保存してあるテーマを自分で読む。読めなければライト（App.tsx の既定と同じ）。 */
export function readThemeClass(): string {
  try {
    return localStorage.getItem('sakura_theme') === 'dark' ? '' : 'theme-light'
  } catch {
    return 'theme-light'
  }
}

/** 診断情報をクリップボードへ（版は main に聞く。聞けなくても組み立てる）。 */
async function copyReport(error: unknown): Promise<boolean> {
  let version: string | undefined
  try { version = await window.electronAPI?.app?.getVersion() } catch { /* 版が分からなくても診断情報は作る */ }
  let platform: string | undefined
  try { platform = navigator.platform } catch { /* 同上 */ }
  const text = buildCrashReport({ version, platform, error })
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}

function CopyReportButton({ error }: { error: unknown }) {
  const [copied, setCopied] = React.useState<boolean | null>(null)
  return (
    <button
      onClick={async () => setCopied(await copyReport(error))}
      className="px-3 py-1.5 rounded-md border border-border text-sm text-ink-secondary hover:text-sakura"
    >{copied === true ? '✓ コピーしました' : copied === false ? 'コピーできませんでした' : '診断情報をコピー'}</button>
  )
}

/** 全体の表示（描画だけ。テーマ・ボタンの動きは呼び出し側）。 */
export function AppCrashView({ error, themeClass, onReload }: { error: unknown; themeClass: string; onReload: () => void }) {
  return (
    <div className={`${themeClass} h-screen w-screen flex items-center justify-center bg-base text-ink`} role="alert">
      <div className="max-w-md px-6 text-center space-y-4">
        <p className="text-sm leading-relaxed">{APP_CRASH_TEXT}</p>
        <div className="flex items-center justify-center gap-2">
          <button onClick={onReload} className="px-3 py-1.5 rounded-md bg-sakura text-white text-sm font-semibold hover:bg-sakura-hover">もう一度読み込む</button>
          <CopyReportButton error={error} />
        </div>
      </div>
    </div>
  )
}

/** 領域の表示（その部分だけ読み直す）。 */
export function RegionCrashView({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="h-full w-full flex items-center justify-center bg-surface text-ink p-4" role="alert">
      <div className="text-center space-y-3">
        <p className="text-sm text-ink-secondary">{REGION_CRASH_TEXT}</p>
        <div className="flex items-center justify-center gap-2">
          <button onClick={onRetry} className="px-3 py-1.5 rounded-md bg-sakura text-white text-sm font-semibold hover:bg-sakura-hover">この部分を読み込み直す</button>
          <CopyReportButton error={error} />
        </div>
      </div>
    </div>
  )
}

interface Props { scope: 'app' | 'region'; children?: React.ReactNode }
interface State { error: unknown; hasError: boolean; resetKey: number }

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, hasError: false, resetKey: 0 }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error, hasError: true }
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // 開発者向けの記録だけ（画面には出さない。診断情報は利用者がボタンで取る）
    console.error('[ErrorBoundary]', error, info?.componentStack)
  }

  /** 領域を読み直す。key を付け替えて、中の部品を作り直す。 */
  retry = () => {
    this.setState(s => ({ error: null, hasError: false, resetKey: s.resetKey + 1 }))
  }

  render() {
    if (this.state.hasError) {
      return this.props.scope === 'app'
        ? <AppCrashView error={this.state.error} themeClass={readThemeClass()} onReload={() => location.reload()} />
        : <RegionCrashView error={this.state.error} onRetry={this.retry} />
    }
    return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>
  }
}
