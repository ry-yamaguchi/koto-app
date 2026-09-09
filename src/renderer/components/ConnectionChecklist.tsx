// ConnectionChecklist.tsx — 接続テストの結果を「チェックリスト」として表示する共通部品（roadmap #35）。
//
// 共用型（AppRunPanel）と専有型（AppRunDedicatedPanel）は、確認する項目数こそ違うが
// 「✓/✗ と項目名・失敗理由を並べ、下に注記を添える」という表示の形は同じにする。
// 判断や表示を複製しない（掟10）——この見た目はここ1箇所だけに置く。

export type ConnectionCheckItem = {
  key: string
  label: string
  ok: boolean
  message?: string
}

export default function ConnectionChecklist({ items, note }: { items: ConnectionCheckItem[]; note?: string }) {
  return (
    <div className="rounded-lg border border-line bg-overlay px-3 py-2 space-y-1.5">
      {items.map(c => (
        <div key={c.key} className="text-xs leading-relaxed">
          <span className={c.ok ? 'text-brand-green font-semibold' : 'text-brand-red font-semibold'}>
            {c.ok ? '✓' : '✗'}
          </span>
          <span className="ml-1.5 text-ink">{c.label}</span>
          {!c.ok && c.message && (
            <span className="ml-2 text-[11px] text-ink-muted">{c.message}</span>
          )}
        </div>
      ))}
      {note && (
        <p className="text-[11px] text-ink-muted leading-relaxed pt-1">{note}</p>
      )}
    </div>
  )
}
