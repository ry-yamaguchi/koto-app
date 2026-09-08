import { useEffect, useState } from 'react'
import type { TelemetryKind, TelemetryAction } from '../../shared/appLog'

// TelemetryNotice — ⑧ ログ・メトリクス（roadmap #30・さくらの開発者の助言）。
//
// ── なぜ1つの部品でログ・メトリクス両方を出すのか ──────────────────────────
// 判断（shared/appLog.ts の decideTelemetryAction）も画面の形も、ログとメトリクスで
// 完全に同じ（違うのは `kind` と文言だけ）。StorageNotice と同じ「用意する→費用に同意」
// の作りを、ここでも複製せず`kind` パラメータで1本にまとめる（掟10）。
//
// ── 費用の金額を書かない理由（掟1） ──────────────────────────────────────
// バケット（オブジェクトストレージ）は月額495円と実測で確定しているが、
// ログ／メトリクスストレージの基本料金は原本・実測のどちらでも金額が確認できていない
// （分かっているのは「月額の基本料金・日割なし」という事実だけ）。
// 分かっていない数字を画面に書かない（推測しない）。金額はコントロールパネルで確認してもらう。

const KIND_LABEL: Record<TelemetryKind, string> = { logs: 'ログ', metrics: 'メトリクス' }
const KIND_ICON: Record<TelemetryKind, string> = { logs: '📋', metrics: '📈' }

export default function TelemetryNotice({ projectDir, kind }: { projectDir: string; kind: TelemetryKind }) {
  const [action, setAction] = useState<TelemetryAction | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    let alive = true
    setAction(null); setError(''); setDone(false); setConfirming(false)
    setLoading(true)
    void (async () => {
      try {
        const r = await window.electronAPI.cloud.telemetryStatus(projectDir, kind)
        if (alive) setAction(r.ok ? (r.action ?? null) : null)
      } catch {
        if (alive) setAction(null)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [projectDir, kind])

  // consented は**必ず呼び出し側が明示的に渡す**（#30 検分の直し・2026-09-08）。
  // 「置き場が既にある（route）」ボタンは追加費用が無いので false、
  // 「費用に同意する」ボタン（confirming カードの中）だけが true を渡す。
  // 万一ここが誤って true を渡しても、費用が発生するのは main 側の
  // `decideEnableTelemetry` が『保存場所が無い』と判断したときだけであり、
  // その最終防御は main 側（tests/monitoring.test.ts）にある。
  const enable = async (consented: boolean) => {
    setBusy(true); setError('')
    try {
      const r = await window.electronAPI.cloud.enableTelemetry(projectDir, kind, { consented })
      if (!r.ok) {
        // 同意が要ると main 側に判断された（通常はここに来ない。来たら同意カードへ戻す）
        if ('needsConsent' in r && r.needsConsent) { setConfirming(true); return }
        setError(r.message ? `${r.message}${r.detail ? `（${r.detail}）` : ''}` : '設定できませんでした')
        return
      }
      setConfirming(false)
      setDone(true)
      // 状態を取り直す。**押しっぱなしの古い表示を残さない**
      const s = await window.electronAPI.cloud.telemetryStatus(projectDir, kind)
      setAction(s.ok ? (s.action ?? null) : null)
    } finally {
      setBusy(false)
    }
  }

  // 確認できない間（読み込み中・未公開・API失敗）は黙る。**公開そのものは妨げない機能**なので、
  // ここで目立つエラーを出すと本題（公開）の邪魔になる。
  if (loading || !action) return null

  const label = KIND_LABEL[kind]
  const icon = KIND_ICON[kind]

  if (action.kind === 'none') {
    return (
      <div className="rounded-lg border border-line p-3">
        <p className="text-xs text-ink-secondary leading-relaxed">✅ {label}は残るようになっています。</p>
      </div>
    )
  }

  if (action.kind === 'route') {
    return (
      <div className="rounded-lg border border-line p-3 space-y-2">
        <p className="text-xs text-ink leading-relaxed">
          {icon} {label}の保存場所はすでにあります。このアプリの{label}をつなげます（追加費用はありません）。
        </p>
        <button
          onClick={() => enable(false)}
          disabled={busy}
          className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura hover:text-sakura disabled:opacity-40"
        >{busy ? 'つないでいます…' : `${label}をつなぐ`}</button>
        {done && <p className="text-[11px] text-ink-secondary leading-relaxed">✅ つながりました。</p>}
        {error && <p className="text-[11px] text-brand-red leading-relaxed select-text">⚠️ {error}</p>}
      </div>
    )
  }

  // action.kind === 'ask'（保存場所が無い＝新しく作ると月額の基本料金がかかる）
  return (
    <div className="rounded-lg border border-line p-3 space-y-2">
      <p className="text-xs text-ink leading-relaxed">{icon} {action.note}</p>
      {confirming ? (
        <div className="rounded-lg border border-brand-yellow/70 p-3 space-y-2">
          <p className="text-xs text-ink leading-relaxed">
            {label}の保存場所（さくらのモニタリングスイート）を新しく用意します。
            <span className="font-semibold">月額の基本料金（日割りなし）</span>がかかります。
            金額はさくらのクラウドのコントロールパネルでご確認ください。
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => enable(true)}
              disabled={busy}
              className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-40"
            >{busy ? '用意しています…' : '用意する（費用に同意）'}</button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura disabled:opacity-40"
            >やめる</button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => { setError(''); setConfirming(true) }}
          className="border border-line rounded-lg px-3 py-1.5 text-xs text-ink-secondary hover:border-sakura hover:text-sakura"
        >{label}を残せるようにする…</button>
      )}
      {error && <p className="text-[11px] text-brand-red leading-relaxed select-text">⚠️ {error}</p>}
    </div>
  )
}
