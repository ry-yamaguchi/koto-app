// DedicatedOpsParts.tsx — 専有型の「作成・削除・公開」の結果欄が共有する、小さな表示部品。
//
// 専有型タブ（AppRunDedicatedPanel）の手順5・8の結果欄が使う（手順6の結果欄と 📡 の削除の結果欄は、0.6.22 段階3B で共通の
// TeardownResultView になった。2026-10-08・同じ結果を2つの入口で別々に描かない）。もとは AppRunDedicatedPanel.tsx の中にあった
// （巨大ファイルの外へ出した）。見た目と文は移す前のまま。
import type { DedicatedResumedNote } from '../apprunDedicatedActions'
import { teardownCallLine } from '../../shared/teardownCall'

/** 結果の一言の色（shared の teardownCallLine の tone）。 */
const NOTE_TONE_CLASS = { ok: 'text-brand-green', wait: 'text-brand-yellow', fail: 'text-brand-red', plain: 'text-ink-secondary' } as const

// 閉じて開き直したあとの結果に添える知らせ（見出し＋見逃してはいけない知らせ）。警告は黄色で出す。
// 古い記録（最新でないもの）は結果欄が出さないので、結果の一言もここで出す。
export function ResumedNotesView({ notes, withMessage = false }: { notes: DedicatedResumedNote[]; withMessage?: boolean }) {
  if (notes.length === 0) return null
  return (
    <div className="space-y-1.5">
      {notes.map((n, i) => {
        // 最新の1件の結果の一言は、ふつうは節の結果欄が出す。結果欄の無い所（手順8の節が描かれないとき）では、ここで出す。
        const isLatest = i === notes.length - 1 && !withMessage
        // 結果の一言は、記録の呼び名（済んだ／途中／失敗）から作る（`ok` だけで失敗と言わない）。呼び名の定義は shared の resultCallOf の1つ。
        const line = isLatest ? null : teardownCallLine(n.call, n.message)
        return (
          <div key={n.startedAt} className="rounded-lg border border-brand-yellow/70 bg-overlay p-3 space-y-1">
            <p className="text-xs font-semibold text-ink leading-relaxed">{n.headline}</p>
            {line && (
              <p className={`text-xs leading-relaxed select-text ${NOTE_TONE_CLASS[line.tone]}`}>{line.text}</p>
            )}
            {n.warnings.map((w, j) => (
              <p key={j} className="text-xs text-brand-yellow leading-relaxed select-text whitespace-pre-wrap">{w}</p>
            ))}
          </div>
        )
      })}
    </div>
  )
}

// 失敗メッセージの表示ブロック（掟5: select-text＋コピーボタン）。VpsPanel/AppRunPanel と同種。
export function ErrorBlock({ msg }: { msg: string }) {
  return (
    <div className="rounded-lg border border-line bg-overlay p-3 space-y-1">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-xs text-ink-secondary leading-relaxed whitespace-pre-wrap break-all select-text">{msg}</p>
        <button
          onClick={() => { navigator.clipboard.writeText(msg).catch(() => {}) }}
          className="flex-none text-[11px] text-sakura hover:underline"
          title="メッセージをコピー"
        >コピー</button>
      </div>
    </div>
  )
}
