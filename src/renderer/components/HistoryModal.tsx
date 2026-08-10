import React, { useCallback, useEffect, useState } from 'react'
import SakuraLogo from './SakuraLogo'

// 「🕘 履歴」モーダル（P2-⑧「前の状態に戻す」）：ファイルを保存する直前に自動で取られた
// スナップショット（.sakuraide-backup/<ISO日時>/）の一覧と「この時点に戻す」導線。
// KnowledgeModal 等と同じモーダル様式。破壊的操作（復元）は確認ダイアログ必須・復元前の現状退避必須。
//
// 2026-08-05: 「その時点の状態にまるごと戻る」意味に変更した（対象以降を畳み込む。main 側
// backup/plan.ts の computeRestorePlanTo）。以前は「そのとき変わったファイルだけ」を戻していたため、
// 3つ前に戻したつもりが新旧の混ざった状態になり得た。見出し（label）は当時の指示文。

interface Props {
  projectDir: string
  onClose: () => void
  // 復元完了後の反映（App.tsx: 開いているタブの読み直し・削除されたタブのクローズ・ツリー更新）
  onRestored: (restored: string[], deleted: string[]) => void | Promise<void>
}

// ISO日時を「7/6 21:15」形式に整形する（StatusBar の shortDate と同じ流儀のローカルヘルパー）
function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ファイルごとの記録種別を非エンジニア向けの言葉にする
const ACTION_LABEL: Record<BackupFileAction, string> = {
  overwrite: '変更',
  create: '新規作成',
  'pre-restore': '復元前の内容',
}

export default function HistoryModal({ projectDir, onClose, onRestored }: Props) {
  const [snapshots, setSnapshots] = useState<BackupSnapshotSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // 復元の確認待ち（破壊的操作なので必ずこの確認を挟む）
  const [pendingRestore, setPendingRestore] = useState<BackupSnapshotSummary | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setListError('')
    const r = await window.electronAPI.backup.list(projectDir)
    setLoading(false)
    if (r.ok) {
      setSnapshots(r.snapshots)
    } else {
      setListError(r.message ?? '履歴の一覧を取得できませんでした。')
    }
  }, [projectDir])

  useEffect(() => { load() }, [load])

  const doRestore = async () => {
    if (!pendingRestore) return
    const target = pendingRestore
    setRestoring(true)
    setNotice('')
    const r = await window.electronAPI.backup.restore(projectDir, target.id)
    setRestoring(false)
    setPendingRestore(null)
    if (r.ok) {
      const failed = r.failed ?? []
      setNotice(
        `✅ ${formatDate(target.createdAt)} の状態に戻しました。戻す直前の状態も履歴に保存したので、この操作も取り消せます。`
        + (failed.length ? `\n⚠️ ただし次のファイルは戻せませんでした（記録が見つかりません）: ${failed.join('、')}` : '')
      )
      try { await onRestored(r.restored ?? [], r.deleted ?? []) } catch { /* 反映失敗でも一覧は更新する */ }
      load()
    } else {
      setNotice(`⚠️ 復元できませんでした: ${r.message ?? ''}`)
      load() // 対象が消えていた場合などに備えて読み直す
    }
  }

  // 「復元前の自動保存」だけのスナップショットか（復元操作の退避分。バッジで区別する）
  const isPreRestoreSnapshot = (s: BackupSnapshotSummary) => s.files.length > 0 && s.files.every(f => f.action === 'pre-restore' || f.action === 'create')
    && s.files.some(f => f.action === 'pre-restore')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[560px] max-h-[85vh] overflow-y-auto bg-elevated rounded-2xl border border-line shadow-2xl fade-in" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-6 pt-6 pb-4 sticky top-0 bg-elevated z-10">
          <SakuraLogo size={24} />
          <div>
            <h2 className="text-lg font-bold text-ink">🕘 履歴（前の状態に戻す）</h2>
            <p className="text-xs text-ink-secondary">AIの変更・自分の編集の直前を自動で記録しています（直近50件）。選んだ時点の状態にまるごと戻せます</p>
          </div>
          <button onClick={onClose} className="ml-auto text-ink-muted hover:text-ink w-7 h-7 rounded-lg hover:bg-overlay">✕</button>
        </div>

        <div className="px-6 pb-6 space-y-4">
          {notice && (
            <p className="text-xs text-ink bg-surface border border-line rounded-lg px-3 py-2 leading-relaxed select-text whitespace-pre-line">{notice}</p>
          )}

          {/* 復元の確認（破壊的操作なので必ず挟む） */}
          {pendingRestore && (
            <div className="rounded-xl border border-brand-yellow/70 bg-surface p-4 space-y-3">
              <p className="text-sm font-semibold text-ink">
                ⚠️ {formatDate(pendingRestore.createdAt)} の時点に戻します
                {pendingRestore.label && !isPreRestoreSnapshot(pendingRestore) ? `（「${pendingRestore.label}」の直前）` : ''}
              </p>
              <p className="text-sm text-ink-secondary leading-relaxed">
                この時点より後の変更をすべて取り消し、{pendingRestore.restoreCount}個のファイルが当時の内容に戻ります
                {pendingRestore.deleteCount > 0 ? `（うち${pendingRestore.deleteCount}個は、この時点より後に作られたファイルなので削除されます）` : ''}。
                <br />
                <b className="text-ink">いまの状態も履歴に保存されるので、戻しすぎてもやり直せます。</b>
              </p>
              <div className="flex justify-between items-center">
                <button
                  onClick={() => setPendingRestore(null)}
                  disabled={restoring}
                  className="bg-overlay text-ink border border-line rounded-lg px-4 py-2 text-sm font-medium hover:border-sakura disabled:opacity-40"
                >やめる</button>
                <button
                  onClick={doRestore}
                  disabled={restoring}
                  className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
                >{restoring ? '復元中…' : 'この時点に戻す'}</button>
              </div>
            </div>
          )}

          {/* 一覧（新しい順） */}
          <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink">保存された履歴</h3>
              <button
                onClick={load}
                disabled={loading}
                className="flex-none text-xs text-ink-secondary border border-line rounded-md px-2 py-1 hover:border-sakura disabled:opacity-40"
              >↻ 再読み込み</button>
            </div>

            {listError && (
              <p className="text-xs text-white bg-brand-red/90 rounded-lg px-3 py-2 leading-relaxed select-text">{listError}</p>
            )}

            {loading && snapshots.length === 0 ? (
              <p className="text-sm text-ink-secondary py-3">読み込み中…</p>
            ) : snapshots.length === 0 ? (
              <p className="text-sm text-ink-muted py-3 leading-relaxed">
                まだ履歴がありません。AIがファイルを変更したとき、または自分で編集して保存したときに、
                その直前の状態がここに自動で記録されます。
              </p>
            ) : (
              <ul className="divide-y divide-line max-h-96 overflow-y-auto">
                {snapshots.map(s => (
                  <li key={s.id} className="py-2.5 space-y-1.5">
                    <div className="flex items-start gap-2">
                      <button
                        onClick={() => setExpandedId(expandedId === s.id ? null : s.id)}
                        className="text-ink-muted hover:text-ink w-4 flex-none text-[10px] mt-1"
                        title={expandedId === s.id ? 'ファイル一覧を閉じる' : 'ファイル一覧を見る'}
                      >{expandedId === s.id ? '▾' : '▸'}</button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-ink font-medium">{formatDate(s.createdAt)}</span>
                          <span className="text-xs text-ink-secondary">・{s.fileCount}ファイル変更</span>
                          {isPreRestoreSnapshot(s) && (
                            <span className="text-[10px] bg-overlay text-ink-secondary rounded-full px-2 py-0.5">戻す前の自動保存</span>
                          )}
                        </div>
                        {/* 当時の指示文。これがあると「3つ前のデザイン」を日時ではなく内容で選べる。
                            「戻す前の自動保存」はバッジで説明済みなので、見出しは出さない（二重になる）。 */}
                        {s.label && !isPreRestoreSnapshot(s) && (
                          <p className="text-[11px] text-ink-secondary leading-snug mt-0.5 truncate" title={s.label}>
                            「{s.label}」の直前
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => { setNotice(''); setPendingRestore(s) }}
                        disabled={restoring}
                        className="flex-none text-[11px] font-medium text-sakura border border-line rounded-md px-2 py-1 hover:border-sakura disabled:opacity-40"
                      >この時点に戻す</button>
                    </div>
                    {expandedId === s.id && (
                      <ul className="ml-6 space-y-0.5">
                        {s.files.map(f => (
                          <li key={f.path} className="text-[11px] text-ink-secondary flex items-center gap-2">
                            <span className="truncate" title={f.path}>{f.path}</span>
                            <span className="flex-none text-ink-muted">（{ACTION_LABEL[f.action] ?? f.action}）</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <p className="text-[11px] text-ink-muted leading-relaxed">
              「この時点に戻す」を押すと、それより後の変更をすべて取り消して、その時点の状態に戻ります
              （3つ前のデザインに戻したいときは、3つ前の行を選んでください）。
              戻す直前の状態も新しい履歴として保存されるため、間違えてもやり直せます。
              なお、履歴は直近50件まで。それより古いものは自動で消えます。
            </p>
          </div>

          <div className="flex justify-end pt-1">
            <button onClick={onClose} className="bg-overlay text-ink border border-line rounded-xl px-4 py-2 text-sm font-medium hover:border-sakura">閉じる</button>
          </div>
        </div>
      </div>
    </div>
  )
}
