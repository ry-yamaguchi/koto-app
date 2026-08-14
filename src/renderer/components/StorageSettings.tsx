import { useEffect, useState } from 'react'
import { BUCKET_MONTHLY_YEN } from '../../shared/cloudCost'
import { storageCostNote, type BucketMode } from '../../shared/objectStorage'

// StorageSettings — 設定（⌘,）の「データの保存」。
//
// ── ここに置くもの・置かないもの（2026-08-13 Ryosuke と合意）──────────
// **既定では何も選ばなくてよい。** 保存場所が無ければ公開のときに作られ、
// あれば使われる。ここは「詳しく決めたい人」のための画面。
//
//   ・共有／専用の既定（プロジェクトごとの費用が変わる）
//   ・保存場所の一覧（**うっかり2つ目を作って倍払うのを防ぐ**）
//   ・新しく作る（**バケット単位で月額が発生する**ので同意を取る）
//
// 逆に「保存場所を用意する」の入口はここに置かない。永続データが要るかは
// 作っている間に決まるので、**③公開で公開先を選ぶときに提案する**（StorageNotice）。

const MODE_KEY = 'koto_storage_mode'

export function getStorageMode(): BucketMode {
  return localStorage.getItem(MODE_KEY) === 'dedicated' ? 'dedicated' : 'shared'
}

type Status = Awaited<ReturnType<Window['electronAPI']['storage']['status']>>

export default function StorageSettings() {
  const [status, setStatus] = useState<Status | null>(null)
  const [mode, setMode] = useState<BucketMode>(getStorageMode())
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')

  const load = async () => {
    setStatus(await window.electronAPI.storage.status())
  }
  useEffect(() => { void load() }, [])

  const changeMode = (m: BucketMode) => {
    setMode(m)
    localStorage.setItem(MODE_KEY, m)
  }

  const create = async () => {
    setError('')
    setCreating(true)
    try {
      const r = await window.electronAPI.storage.createBucket(newName.trim())
      if (!r.ok) { setError(r.message ?? '作れませんでした'); return }
      setNewName('')
      await load()
    } finally { setCreating(false) }
  }

  return (
    <div className="bg-surface border border-line rounded-xl p-4 space-y-3">
      <div className="text-xs font-semibold text-ink-secondary">データの保存</div>

      {!status ? (
        <p className="text-xs text-ink-muted">確認しています…</p>
      ) : !status.ok ? (
        <p className="text-xs text-ink-secondary leading-relaxed select-text">{status.message}</p>
      ) : !status.siteReady ? (
        <p className="text-xs text-ink-secondary leading-relaxed">
          まだ保存場所を使っていません。データを保存するアプリを公開するときに、費用の確認をしてから用意します。
        </p>
      ) : (
        <>
          <div className="space-y-1">
            <p className="text-xs text-ink-secondary">
              保存場所（{status.siteName}）: <span className="font-semibold text-ink">{status.buckets.length}個</span>
              <span className="text-ink-muted">　1つにつき月額{BUCKET_MONTHLY_YEN}円（税込）</span>
            </p>
            {status.buckets.length > 0 && (
              <ul className="text-[11px] text-ink-muted leading-relaxed select-text">
                {status.buckets.map(b => <li key={b.name}>・{b.name}</li>)}
              </ul>
            )}
          </div>
        </>
      )}

      {/* 共有／専用の既定 */}
      <div className="space-y-1 pt-1">
        <div className="text-[11px] font-semibold text-ink-secondary">新しいプロジェクトの既定</div>
        <div className="flex gap-1">
          {(['shared', 'dedicated'] as const).map(m => (
            <button
              key={m}
              onClick={() => changeMode(m)}
              className={`text-[11px] rounded-lg px-3 py-1.5 border ${mode === m ? 'bg-sakura text-white border-sakura' : 'border-line text-ink-secondary hover:border-sakura'}`}
            >{m === 'shared' ? 'まとめて保存（推奨）' : 'プロジェクトごとに分ける'}</button>
          ))}
        </div>
        <p className="text-[11px] text-ink-muted leading-relaxed">{storageCostNote(mode, BUCKET_MONTHLY_YEN)}</p>
      </div>

      {/* 新しく作る。**費用が増えるので、押す前に金額を見せる** */}
      {status?.ok && (
        <details className="pt-1">
          <summary className="text-[11px] text-ink-muted cursor-pointer hover:text-ink">保存場所を新しく作る…</summary>
          <div className="mt-2 space-y-2">
            <p className="text-[11px] text-brand-yellow leading-relaxed">
              作ると月額{BUCKET_MONTHLY_YEN}円（税込）が新たにかかります。日割はありません。
              すでにある保存場所を使えば、費用は増えません。
            </p>
            <div className="flex gap-2">
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder={status.suggested ?? 'koto-data-xxxx'}
                className="flex-1 bg-base border border-line rounded-lg px-2 py-1 text-xs text-ink"
              />
              <button
                onClick={create}
                disabled={creating || !newName.trim()}
                className="text-[11px] border border-line rounded-lg px-3 py-1 text-ink-secondary hover:border-sakura hover:text-sakura disabled:opacity-40"
              >{creating ? '作成中…' : '作る'}</button>
            </div>
            <p className="text-[11px] text-ink-muted">英字で始まる小文字の英数字とハイフン（3〜63文字）</p>
            {error && <p className="text-[11px] text-brand-red leading-relaxed select-text">⚠️ {error}</p>}
          </div>
        </details>
      )}
    </div>
  )
}
