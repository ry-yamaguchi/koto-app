// 🗂 プロジェクトの形を新しくする案内（2026-08-20 Ryosuke 指示）。
//
// **確認は出すが、拒否はできない。** 押すまで進まない案内にする。
// 「よろしいですか？」と聞いて選ばせる形にはしない——選択肢が無いのに聞くのは不誠実だから。
// 代わりに**何が起きるか**と、**元に戻せること**を書く。
//
// 移す前に 🕘 履歴のスナップショットを取るので、押したあとでも「元に戻す」で戻せる。

import { useState } from 'react'
import { migrateNotice, migrateDone, migrateFailed, type MigratePlan } from '../../shared/migratePlan'
import { CHAT_TEXT_WRAP } from '../textWrap'

export default function MigrateNotice({ plan, onRun }: {
  plan: MigratePlan
  /** 実行する。戻り値をそのまま画面に出す。 */
  onRun: () => Promise<{ ok: boolean; moved: string[]; restored: boolean; message?: string }>
}) {
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle')
  const [result, setResult] = useState('')

  const run = async () => {
    setState('running')
    const r = await onRun()
    setResult(r.ok ? migrateDone({ move: r.moved, keep: plan.keep }) : migrateFailed(r.message ?? '原因不明', r.restored))
    setState('done')
  }

  return (
    <div className="my-2 flex justify-center">
      <div className="w-full max-w-[90%] rounded-xl border border-sakura/60 bg-surface px-3 py-2.5 select-text">
        <p className={`text-[12px] text-ink ${CHAT_TEXT_WRAP}`}>
          {state === 'done' ? result : migrateNotice(plan)}
        </p>
        {state !== 'done' && (
          <button
            onClick={() => void run()}
            disabled={state === 'running'}
            className="mt-2 sakura-gradient text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
          >{state === 'running' ? '整理しています…' : '🗂 フォルダを整理する'}</button>
        )}
      </div>
    </div>
  )
}
