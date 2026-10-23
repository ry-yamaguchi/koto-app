// PublishedInventoryCard.tsx — 📡 公開したもの一覧の「💰 さくら側にあるものと、かかっている費用」（棚卸し）のカード。
//
// 0.6.22 段階3B（3B-5）で PublishedListModal.tsx から切り出した（設計書 10.9.10・10.11.9 の D2-5）。中身は移しただけで、押したときだけ
// さくらへ問い合わせる（cloud:inventory）。props は workspace（プロジェクトを置くフォルダ）だけ。
// 共通の部品（teardown/・components/teardown/）と同じく、専有型のパネルの部品（apprunDedicatedActions・AppRunDedicatedPanel）を import しない。
import { useCallback, useState } from 'react'
import { getWorkspaceDir } from '../workspace'
import { kindLabel, costNote } from '../../shared/inventory'
import { listCloudKeys, getActiveCloudKeyId } from './CredentialsModal'

export default function PublishedInventoryCard({ workspace }: { workspace: string }) {
  // ── さくら側の棚卸し（改善案 1-3 / 1-4・2026-08-18）────────────────────
  // この一覧は「Koto の記録」であって、さくら側の実物ではない。**記録に無いものは
  // ここに出ない**ため、放置されたまま毎月お金がかかり続ける（2026-08-14 に実際に
  // 起きた）。**押したときだけ**さくらへ問い合わせる（勝手に通信しない）。
  type InventoryResult = Awaited<ReturnType<Window['electronAPI']['cloud']['inventory']>>
  const [inventory, setInventory] = useState<InventoryResult | null>(null)
  const [checking, setChecking] = useState(false)
  /** どのキーで調べたか（複数登録できるので、別のアカウントを見ていないか分かるように）。 */
  const [checkedKey, setCheckedKey] = useState<string | null>(null)

  const runInventory = useCallback(async () => {
    setChecking(true)
    try {
      const dir = workspace ?? await getWorkspaceDir()
      const rec = await window.electronAPI.fs.publishedRecords(dir)
      setInventory(await window.electronAPI.cloud.inventory(rec.ok ? rec.projects : []))
      try {
        const [keys, activeId] = await Promise.all([listCloudKeys(), getActiveCloudKeyId()])
        const used = keys.find(k => k.id === activeId) ?? keys[0]
        setCheckedKey(used ? used.label : null)
      } catch { setCheckedKey(null) }
    } catch (e: any) {
      setInventory({ ok: false, message: e?.message ?? String(e), rows: [] })
    } finally {
      setChecking(false)
    }
  }, [workspace])

  return (
    <div className="rounded-xl border border-line bg-surface p-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">💰 さくら側にあるものと、かかっている費用</h3>
        <button
          onClick={runInventory}
          disabled={checking}
          title="さくらへ問い合わせて、実際にあるものを一覧します（何も作らず、何も消しません）"
          className="flex-none text-xs text-ink-secondary border border-line rounded-md px-2 py-1 hover:border-sakura disabled:opacity-40"
        >{checking ? '調べています…' : '↻ 調べる'}</button>
      </div>
      {!inventory && !checking && (
        <p className="text-[11px] text-ink-muted leading-relaxed">
          別のパソコンで作ったものや、コントロールパネルから手動で作ったものなど、<b className="text-ink">Koto の記録に無いものは上の一覧に出ません。</b>
          残っていると、気づかないまま費用がかかり続けます。
        </p>
      )}
      {inventory && !inventory.ok && (
        <p className="text-[11px] text-brand-red leading-relaxed select-text">{inventory.message}</p>
      )}
      {inventory?.ok && (
        <>
          {/* **合計を、文章の中に埋めない**（2026-08-19 Ryosuke 指摘）。
              いくらかかっているかは、いちばん見たい数字である */}
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-semibold text-ink">
              月額 {(inventory.totalYen ?? 0).toLocaleString()}円
            </span>
            <span className="text-[11px] text-ink-muted">（税込・分かっているぶん）</span>
            {checkedKey && (
              <span className="text-[11px] text-ink-muted ml-auto">調べたキー: {checkedKey}</span>
            )}
          </div>
          <p className="text-[11px] text-ink-secondary leading-relaxed select-text">{inventory.notice}</p>
          {inventory.partial && inventory.partial.length > 0 && (
            <p className="text-[11px] text-brand-yellow leading-relaxed">
              ⚠️ {inventory.partial.join('・')} は確認できませんでした。<b className="text-ink">この一覧に出ていない</b>ものがあるかもしれません。
            </p>
          )}
          {(inventory.rows ?? []).length === 0 ? (
            <p className="text-[11px] text-ink-muted">さくら側に、費用のかかるものは見つかりませんでした。</p>
          ) : (
            <ul className="space-y-1">
              {(inventory.rows ?? []).map(r => (
                <li key={`${r.kind}-${r.id}`} className="text-[11px] leading-relaxed flex gap-2 border-t border-line pt-1 first:border-t-0 first:pt-0">
                  <span className="flex-none">{r.project ? '　' : '❓'}</span>
                  <span className="flex-1 min-w-0 text-ink-secondary select-text">
                    <span className="text-ink font-medium">{kindLabel(r.kind)}</span>
                    {' '}<span className="font-mono break-all">{r.name}</span>
                    <br />
                    {r.project
                      ? <>プロジェクト『{r.project}』／{costNote(r)}</>
                      : <span className="text-brand-yellow">
                          このパソコンの Koto の記録にありません（{costNote(r)}）。
                          心当たりが無ければ、コントロールパネルで削除できます
                        </span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-ink-muted leading-relaxed">
            Koto から消せるものは上の一覧の 🗑 から、そうでないものは
            <a href="https://secure.sakura.ad.jp/cloud/" className="text-sakura hover:underline"> さくらのクラウド コントロールパネル ↗</a> から削除してください。
          </p>
        </>
      )}
    </div>
  )
}
