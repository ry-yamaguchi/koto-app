import React, { useRef, useEffect, useState } from 'react'
import Editor, { OnMount } from '@monaco-editor/react'
import '../monacoSetup'
import type { OpenFile, Theme } from '../App'
import SakuraLogo from './SakuraLogo'

interface Props {
  openFiles: OpenFile[]
  activeFile: string | null
  onSetActive: (path: string) => void
  onClose: (path: string) => void
  onSave: (path: string, content: string) => void
  onContentChange: (path: string, content: string) => void
  apiKey: string
  theme: Theme
}

const DARK_THEME = {
  base: 'vs-dark' as const,
  inherit: true,
  rules: [
    { token: 'comment', foreground: '5f5f72', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'ff5577' },
    { token: 'string', foreground: '3ddc97' },
    { token: 'number', foreground: 'fbae40' },
    { token: 'type', foreground: '00c8c8' },
    { token: 'function', foreground: '7799dd' },
    { token: 'variable', foreground: 'f2f2f7' },
  ],
  colors: {
    'editor.background': '#0c0c11',
    'editor.foreground': '#f2f2f7',
    'editor.lineHighlightBackground': '#16161e',
    'editorLineNumber.foreground': '#3a3a47',
    'editorLineNumber.activeForeground': '#9a9aae',
    'editor.selectionBackground': '#ff557744',
    'editor.inactiveSelectionBackground': '#ff557722',
    'editorCursor.foreground': '#ff5577',
    'editorIndentGuide.background1': '#20202b',
    'editorIndentGuide.activeBackground1': '#33333f',
    'editorBracketMatch.background': '#ff557733',
    'editorBracketMatch.border': '#ff5577',
    'editorWidget.background': '#14141b',
    'editorWidget.border': '#2a2a37',
    'editorSuggestWidget.selectedBackground': '#ff557733',
    'scrollbarSlider.background': '#33333f88',
    'minimap.background': '#0c0c11',
  },
}

const LIGHT_THEME = {
  base: 'vs' as const,
  inherit: true,
  rules: [
    { token: 'comment', foreground: 'a0a0a8', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'e0245e' },
    { token: 'string', foreground: '1a9c6e' },
    { token: 'number', foreground: 'c77700' },
    { token: 'type', foreground: '008a8a' },
    { token: 'function', foreground: '4068c0' },
    { token: 'variable', foreground: '404044' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#404044',
    'editor.lineHighlightBackground': '#fff6f8',
    'editorLineNumber.foreground': '#cfcfd6',
    'editorLineNumber.activeForeground': '#7e7e86',
    'editor.selectionBackground': '#ff557733',
    'editor.inactiveSelectionBackground': '#ff55771a',
    'editorCursor.foreground': '#ff5577',
    'editorIndentGuide.background1': '#f0eef2',
    'editorIndentGuide.activeBackground1': '#e0dde2',
    'editorBracketMatch.background': '#ff55772a',
    'editorBracketMatch.border': '#ff5577',
    'editorWidget.background': '#fff6f8',
    'editorWidget.border': '#f0dfe4',
    'editorSuggestWidget.selectedBackground': '#ff55772a',
    'scrollbarSlider.background': '#d8d8e088',
    'minimap.background': '#ffffff',
  },
}

/** 画像プレビュー。空ファイル・壊れたデータは原因がわかるメッセージを表示する。 */
function ImagePreview({ file }: { file: OpenFile }) {
  const [failed, setFailed] = useState(false)
  const isEmpty = /;base64,$/.test(file.content) // 0バイトのファイル
  if (isEmpty || failed) {
    return (
      <div className="h-full flex items-center justify-center bg-base p-6">
        <div className="text-center max-w-md">
          <div className="text-4xl mb-3">🖼️</div>
          <p className="text-sm font-semibold text-ink mb-2">
            {isEmpty ? 'この画像ファイルは空です（0バイト）' : 'この画像は表示できません（画像データが壊れています）'}
          </p>
          <p className="text-xs text-ink-muted leading-relaxed">
            AIはテキストのみ生成でき、画像（バイナリ）は作れません。<br />
            AIが作成した画像ファイルは中身が空になるため、実際の画像を使う場合は
            Finderからプロジェクトフォルダにコピーして置き換えてください。
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="h-full flex items-center justify-center overflow-auto bg-base p-6">
      <img
        src={file.content}
        alt={file.name}
        onError={() => setFailed(true)}
        className="max-w-full max-h-full object-contain rounded-lg border border-line shadow-sm"
      />
    </div>
  )
}

export default function EditorPanel({ openFiles, activeFile, onSetActive, onClose, onSave, onContentChange, theme }: Props) {
  const editorRef = useRef<any>(null)
  const monacoRef = useRef<any>(null)

  const applyTheme = (monaco: any, t: Theme) => {
    monaco.editor.defineTheme('sakura-dark', DARK_THEME)
    monaco.editor.defineTheme('sakura-light', LIGHT_THEME)
    monaco.editor.setTheme(t === 'light' ? 'sakura-light' : 'sakura-dark')
  }

  useEffect(() => {
    if (monacoRef.current) applyTheme(monacoRef.current, theme)
  }, [theme])

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    applyTheme(monaco, theme)

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (!activeFile) return
      onSave(activeFile, editor.getValue())
    })
  }

  const activeFileObj = openFiles.find(f => f.path === activeFile)
  const isPreviewable = !!activeFileObj && /\.html?$/i.test(activeFileObj.name)

  // 編集中のHTMLを既定ブラウザでプレビュー（未保存なら先に保存してから開く）
  const previewInBrowser = async () => {
    if (!activeFileObj) return
    if (activeFileObj.isDirty) onSave(activeFileObj.path, activeFileObj.content)
    await window.electronAPI.shell.openPath(activeFileObj.path)
  }

  if (openFiles.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-base text-ink-muted relative overflow-hidden">
        <div className="geo-squares top-12 right-16 opacity-40" style={{ position: 'absolute' }}>
          {[...Array(16)].map((_, i) => (
            <i key={i} className="block w-3.5 h-3.5 rounded-[3px]"
               style={{ background: ['var(--sakura)', 'var(--orange)', 'var(--yellow)', 'var(--cyan)'][(Math.floor(i / 4) + i) % 4], opacity: 0.2 + (i % 5) * 0.06 }} />
          ))}
        </div>
        <div className="text-center relative z-10">
          <div className="flex justify-center mb-5"><SakuraLogo size={64} /></div>
          <p className="text-xl font-semibold text-ink">Koto</p>
          <p className="text-sm mt-2 text-ink-muted leading-relaxed">
            左の「ファイル」一覧からファイルを開けます。<br />
            まだファイルがないときは、AIチャットに作りたいものを伝えてみてください。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-base">
      {/* Tab bar */}
      <div className="flex items-stretch bg-surface border-b border-line flex-none">
       <div className="flex overflow-x-auto flex-1">
        {openFiles.map(file => {
          const active = activeFile === file.path
          return (
            <div
              key={file.path}
              className={`flex items-center gap-2 pl-4 pr-2.5 py-2.5 text-[13px] cursor-pointer flex-none max-w-[200px] group relative transition-colors ${
                active ? 'bg-base text-ink' : 'text-ink-secondary hover:text-ink hover:bg-elevated'
              }`}
              onClick={() => onSetActive(file.path)}
            >
              {active && <span className="absolute top-0 left-0 right-0 h-0.5 sakura-gradient" />}
              <span className="truncate">{file.name}</span>
              {file.isDirty && (
                <span
                  title="未保存の変更があります"
                  className="text-sakura text-lg leading-none flex-none group-hover:hidden"
                >•</span>
              )}
              <button
                onClick={e => {
                  e.stopPropagation()
                  if (file.isDirty && !window.confirm(`「${file.name}」には保存していない変更があります。保存せずに閉じますか？`)) return
                  onClose(file.path)
                }}
                title={file.isDirty ? '未保存のまま閉じる' : '閉じる'}
                className={`text-ink-muted hover:text-ink flex-none w-4 h-4 items-center justify-center rounded hover:bg-overlay transition-all ${
                  file.isDirty ? 'hidden group-hover:flex' : 'opacity-0 group-hover:opacity-100 flex'
                }`}
              >×</button>
            </div>
          )
        })}
       </div>
       {isPreviewable && (
         <button
           onClick={previewInBrowser}
           className="flex items-center gap-1.5 px-3 flex-none text-[12px] font-semibold text-white sakura-gradient hover:opacity-90 transition-opacity"
           title="ブラウザでプレビュー（保存してから開きます）"
         >
           ▶ プレビュー
         </button>
       )}
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        {activeFileObj && activeFileObj.language === 'image' ? (
          // 画像はプレビュー表示（テキストエディタには出さない）
          <ImagePreview key={activeFileObj.path} file={activeFileObj} />
        ) : activeFileObj && (
          <Editor
            key={activeFileObj.path}
            value={activeFileObj.content}
            language={activeFileObj.language}
            onMount={handleMount}
            onChange={val => { if (val !== undefined) onContentChange(activeFileObj.path, val) }}
            options={{
              fontSize: 13.5,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
              fontLigatures: true,
              lineNumbers: 'on',
              minimap: { enabled: true, scale: 0.8, renderCharacters: false },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              tabSize: 2,
              insertSpaces: true,
              renderWhitespace: 'selection',
              bracketPairColorization: { enabled: true },
              guides: { bracketPairs: true, indentation: true },
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              padding: { top: 14 },
              scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
              suggest: { showMethods: true, showFunctions: true, showConstructors: true },
            }}
          />
        )}
      </div>
    </div>
  )
}
