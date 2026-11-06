// 🧹 プロジェクトの形を新しくする案内（2026-08-20 Ryosuke 指示）。
//
// **確認は出すが、拒否はできない。** 押すまで進まない案内にする。
// 「よろしいですか？」と聞いて選ばせる形にはしない——選択肢が無いのに聞くのは不誠実だから。
// 代わりに**何が起きるか**と、**元に戻せること**を書く。
//
// 移す前に 🕘 履歴のスナップショットを取るので、押したあとでも「元に戻す」で戻せる。

import { useState } from 'react'
import { migrateNotice, migrateDone, migrateFailed, type MigratePlan } from '../../shared/migratePlan'
import { CHAT_TEXT_WRAP } from '../textWrap'
import { splitFailureDetail, FAILURE_DETAIL_LABEL } from '../../shared/failureDetail'
import { FAILURE_DETAIL_CLASS } from './FailureLines'
// W-67（2026-09-27）: migrateNotice/migrateDone/migrateFailed は `**…**` を含む素の文字列を返す。
// そのまま <p> へ入れると `**` がそのまま見えるので、ImportFromPublishedPanel と同じ
// emphasize() で太字の区間に分けてから描く（決定は案1）。
import { emphasize } from '../importProject'

export default function MigrateNotice({ plan, onRun }: {
  plan: MigratePlan
  /** 実行する。戻り値をそのまま画面に出す。 */
  onRun: () => Promise<{ ok: boolean; moved: string[]; restored: boolean; message?: string } | { cancelled: true }>
}) {
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle')
  const [result, setResult] = useState('')

  const run = async () => {
    setState('running')
    const r = await onRun()
    // 保存できなかった編集を捨てることを断られた。何も動かしていないので、押す前の画面に戻す
    if ('cancelled' in r) { setState('idle'); return }
    setResult(r.ok ? migrateDone({ move: r.moved, keep: plan.keep }) : migrateFailed(r.message ?? '原因不明', r.restored))
    setState('done')
  }

  // 失敗の文の最後の行は「詳細: 原文」。太字の記法は文の部分だけに当て、詳細は小さな別の行として描く
  const shown = splitFailureDetail(state === 'done' ? result : migrateNotice(plan))
  return (
    <div className="my-2 flex justify-center">
      <div className="w-full max-w-[90%] rounded-xl border border-sakura/60 bg-surface px-3 py-2.5 select-text">
        <p className={`text-[12px] text-ink ${CHAT_TEXT_WRAP}`}>
          {emphasize(shown.text).map((sp, i) => (
            sp.bold ? <b key={i} className="font-semibold">{sp.text}</b> : <span key={i}>{sp.text}</span>
          ))}
          {shown.detail && <span className={FAILURE_DETAIL_CLASS}>{FAILURE_DETAIL_LABEL}{shown.detail}</span>}
        </p>
        {state !== 'done' && (
          <button
            onClick={() => void run()}
            disabled={state === 'running'}
            className="mt-2 sakura-gradient text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
          >{state === 'running' ? '整理しています…' : '🧹 フォルダを整理する'}</button>
        )}
      </div>
    </div>
  )
}
