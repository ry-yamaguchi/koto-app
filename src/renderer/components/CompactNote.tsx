// 🗂 会話が長くなったときの「ここまでの内容をまとめました」。
//
// ── なぜ、ただの一言では足りないか ──────────────────────────────────
// まとめは **AIが読む内容そのもの**なので、何がまとめられたのかを利用者が
// 確かめられないと「勝手に忘れられた」と同じことになる。
// 普段は一言だけ・押せば中身が読める、という形にする（掟5: 消す前に一覧を見せる）。
//
// 元の会話は消えていない。**画面には全部残っていて、送るときだけまとめを使う。**

import { useState } from 'react'
import { COMPACT_NOTE, summaryFilePath, summaryFileBody } from '../historyCompact'
import { CHAT_TEXT_WRAP } from '../textWrap'
import CopyButton from './CopyButton'

export default function CompactNote({ text, projectDir }: {
  text: string
  /** IDEモードで開いているプロジェクト。あるときだけ「資料として残す」を出す。 */
  projectDir?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [savedTo, setSavedTo] = useState('')
  const [saveErr, setSaveErr] = useState('')

  /**
   * まとめを「資料」としてプロジェクトへ残す（2026-08-20 Ryosuke 提案）。
   * 置き場所は「素材（公開しません）」＝ publishExclude.ts の一元定義で、
   * **公開・配布のどの経路からも除かれる**（アプリの一部にはならない）。
   */
  const saveToProject = async () => {
    if (!projectDir) return
    setSaveErr('')
    const now = new Date()
    const rel = summaryFilePath(now)
    try {
      await window.electronAPI.fs.writeFileInProject(projectDir, rel, summaryFileBody(text, now))
      setSavedTo(rel)
    } catch (e: any) {
      setSaveErr(e?.message ?? String(e))
    }
  }

  return (
    <div className="my-2 flex justify-center">
      <div className="w-full max-w-[90%] rounded-xl border border-line bg-surface px-3 py-2 select-text">
        <div className="flex items-center gap-2">
          {/* 印そのものは読めないと意味が無いので ink（ダークで ink-muted は 3:1 しか出ない）。
              補足とボタンは控えめのままにして、区切りとしてうるさくしない。 */}
          <span className="text-[12px] text-ink flex-1">{COMPACT_NOTE}</span>
          {/* 中身をそのまま持ち出せるようにする（2026-08-20 Ryosuke 要望）。
              開かなくても押せる。何のまとめかが分かるよう、見出しの行も一緒に写す
              （ChatPanel の「会話全体をコピー」と同じ形）。 */}
          <CopyButton
            text={`${COMPACT_NOTE}\n${text}`}
            title="このまとめをコピー"
            className="flex-none text-[11px] text-ink-secondary hover:text-sakura"
          />
          <button
            onClick={() => setOpen(o => !o)}
            className="text-[11px] text-ink-secondary hover:text-sakura flex-none"
          >{open ? '閉じる' : 'まとめを見る'}</button>
        </div>
        {open && (
          <>
            {/* ほかの吹き出しと同じく、文字を選んでコピーできるようにする
                （アプリ全体は user-select: none なので、明示的に許可する必要がある）。 */}
            <p className={`mt-2 text-[12px] text-ink select-text ${CHAT_TEXT_WRAP}`}>{text}</p>
            <p className="mt-2 text-[11px] text-ink-secondary">
              これより前のやり取りは、AIへはこのまとめとして渡します。
              <b className="text-ink">これより後のやり取りは、そのまま渡します。</b>
              会話そのものは、どちらも消えていません。
            </p>
            {projectDir && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => void saveToProject()}
                  className="text-[11px] text-ink-secondary hover:text-sakura border border-line rounded-md px-1.5 py-0.5 whitespace-nowrap"
                  title="まとめをプロジェクトの「素材（公開しません）」に文書として残します（アプリには使われません）"
                >📄 資料として残す</button>
                {/* 色で伝えない（brand-green はライトモードで 1.67:1 しか出ず、白地では読めない。
                    掟5「ライトモードでも読めるか必ず確認する」）。印と太字で伝える。 */}
                {savedTo && <span className="text-[11px] text-ink font-semibold select-text">✓ {savedTo} に残しました</span>}
                {saveErr && <span className="text-[11px] text-ink font-semibold select-text">⚠️ 残せませんでした（{saveErr}）</span>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
