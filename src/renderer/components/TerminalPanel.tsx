import React, { useEffect, useRef, useState } from 'react'
import { Terminal, ITheme } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebLinksAddon } from 'xterm-addon-web-links'
import 'xterm/css/xterm.css'
import type { Theme } from '../App'

const DARK_TERM: ITheme = {
  background: '#0c0c11',
  foreground: '#f2f2f7',
  cursor: '#ff5577',
  cursorAccent: '#0c0c11',
  selectionBackground: '#ff557744',
  black: '#33333f',
  red: '#ff5c7a',
  green: '#3ddc97',
  yellow: '#ffc857',
  blue: '#7799dd',
  magenta: '#ff5577',
  cyan: '#00c8c8',
  white: '#c8c8d4',
  brightBlack: '#5f5f72',
  brightRed: '#ff7a92',
  brightGreen: '#5fe8b0',
  brightYellow: '#ffd47a',
  brightBlue: '#9ab4e8',
  brightMagenta: '#ff8da3',
  brightCyan: '#6fdce8',
  brightWhite: '#f2f2f7',
}

const LIGHT_TERM: ITheme = {
  background: '#ffffff',
  foreground: '#404044',
  cursor: '#ff5577',
  cursorAccent: '#ffffff',
  selectionBackground: '#ff557733',
  black: '#404044',
  red: '#e0245e',
  green: '#1a9c6e',
  yellow: '#c77700',
  blue: '#4068c0',
  magenta: '#e0245e',
  cyan: '#008a8a',
  white: '#7e7e86',
  brightBlack: '#7e7e86',
  brightRed: '#ff5577',
  brightGreen: '#22b37e',
  brightYellow: '#d98a00',
  brightBlue: '#5a82d6',
  brightMagenta: '#ff5577',
  brightCyan: '#00a8a8',
  brightWhite: '#404044',
}

export interface TermExec { cmd: string; seq: number }

export default function TerminalPanel({ theme, cwd, exec }: { theme: Theme; cwd?: string | null; exec?: TermExec | null }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termIdRef = useRef<number | null>(null)
  const [isReady, setIsReady] = useState(false)
  const cwdRef = useRef<string | null | undefined>(cwd) // 起動時の作業フォルダ
  const lastCwdRef = useRef<string | null | undefined>(cwd)
  cwdRef.current = cwd

  // 公開などのコマンドをIDEからシェルへ流す（進行はターミナルに表示される）
  const lastExecSeq = useRef(0)
  useEffect(() => {
    if (!exec || exec.seq === lastExecSeq.current) return
    if (!isReady || termIdRef.current === null) return
    lastExecSeq.current = exec.seq
    // '\x03' は Ctrl+C（実行中プロセスの停止）をそのまま送る
    const data = exec.cmd === '\x03' ? '\x03' : `\x15${exec.cmd}\r`
    window.electronAPI.term.write(termIdRef.current, data)
  }, [exec, isReady])

  // プロジェクトを切り替えたら、シェルにも cd を送って作業フォルダを合わせる
  useEffect(() => {
    if (!isReady || termIdRef.current === null) return
    if (!cwd || cwd === lastCwdRef.current) return
    lastCwdRef.current = cwd
    // \x15(Ctrl+U)で入力中の行をクリアしてから cd
    window.electronAPI.term.write(termIdRef.current, `\x15cd "${cwd}"\r`)
  }, [cwd, isReady])

  // Update palette live when theme changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = theme === 'light' ? LIGHT_TERM : DARK_TERM
    }
  }, [theme])

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme: theme === 'light' ? LIGHT_TERM : DARK_TERM,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      scrollback: 2000,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    termRef.current = term
    fitRef.current = fitAddon

    lastCwdRef.current = cwdRef.current
    window.electronAPI.term.create(cwdRef.current ?? undefined).then(id => {
      termIdRef.current = id

      const cleanup = window.electronAPI.term.onData(id, data => {
        term.write(data)
      })

      window.electronAPI.term.onExit(id, () => {
        term.write('\r\n\x1b[33m[プロセス終了]\x1b[0m\r\n')
      })

      term.onData(data => {
        window.electronAPI.term.write(id, data)
      })

      setIsReady(true)
    })

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      if (termIdRef.current !== null) {
        const { cols, rows } = term
        window.electronAPI.term.resize(termIdRef.current, cols, rows)
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      if (termIdRef.current !== null) {
        window.electronAPI.term.destroy(termIdRef.current)
      }
      term.dispose()
    }
  }, [])

  return (
    <div className="flex flex-col h-full bg-base">
      <div className="flex items-center px-3 py-1.5 border-b border-line bg-surface flex-none">
        <span className="w-2 h-2 rounded-full bg-brand-green mr-2" />
        <span className="text-[11px] font-semibold text-ink-secondary uppercase tracking-widest">Terminal</span>
        {!isReady && <span className="ml-2 text-xs text-ink-muted">接続中...</span>}
      </div>
      <div ref={containerRef} className="flex-1 overflow-hidden p-2" />
    </div>
  )
}
