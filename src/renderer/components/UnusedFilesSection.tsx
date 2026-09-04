import { useCallback, useEffect, useState } from 'react'
import { MATERIALS_DIR } from '../../shared/publishExclude'

// 🧹 未使用ファイルの節（roadmap #18）。公開フローの4パネル（PublishModal / AppRunPanel /
// HanamiiPanel / VercelPanel）に、SecurityCheckSection と同じ位置へ並べて埋め込む。
//
// **AI を使わない決定論チェック**（shared/unusedFiles.ts の findUnusedFiles）なので、
// マウント時・プロジェクトが変わったときに自動で調べる（migrateCheck と同じ扱い）。
// AIチェックはコスト・時間がかかるため手動限定にした（2026-08-21 決定）が、これは
// AI を一切呼ばないので、その決定の対象外。
//
// **移動するのは AI ではなく Koto の機能。** 利用者が一覧を確認して押すと、
// 素材置き場（MATERIALS_DIR）へ移す。移す前に 🕘 履歴へ退避してから動かすので、押しても戻せる。
export default function UnusedFilesSection({ projectDir }: { projectDir: string }) {
  const [supported, setSupported] = useState(true)
  const [unused, setUnused] = useState<string[]>([])
  const [moving, setMoving] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const check = useCallback(async (dir: string) => {
    try {
      const r = await window.electronAPI.fs.unusedCheck(dir)
      setSupported(r.supported)
      setUnused(r.unused)
    } catch {
      setSupported(false)
      setUnused([])
    }
  }, [])

  useEffect(() => {
    setNote(null) // 別プロジェクトの結果を見せない
    setUnused([])
    if (projectDir) void check(projectDir)
  }, [projectDir, check])

  // 対象外（静的サイト以外）のときだけ出さない（出しても行動できない箱になるため）。
  // 0件でも節は**常時表示**する（2026-09-04 Ryosuke 要望）: 出ないと「確認した上で
  // 問題なし」なのか「機能が働いていない」のか利用者に区別が付かない。
  if (!supported) return null

  const move = async () => {
    const head = unused.slice(0, 8).map(f => `・${f}`).join('\n')
    const more = unused.length > 8 ? `\n・ほか ${unused.length - 8} 件` : ''
    if (!window.confirm(
      `使われていないかもしれないファイル ${unused.length} 件を「${MATERIALS_DIR}」へ移動します。\n\n${head}${more}\n\n`
      + '🕘 履歴から元に戻せます。よろしいですか？'
    )) return
    setMoving(true)
    setNote(null)
    try {
      const r = await window.electronAPI.fs.moveToMaterials(projectDir, unused)
      if (r.ok) {
        setNote(
          `✅ ${r.moved.length}件を『${MATERIALS_DIR}』へ移動しました`
          + (r.snapshotOk ? '' : '\n⚠️ 🕘 履歴への退避ができませんでした（移動そのものは完了しています）')
        )
        await check(projectDir) // 動かした結果をその場で見せる
      } else {
        setNote(`⚠️ 移動できませんでした: ${r.message ?? '原因不明'}`)
      }
    } finally {
      setMoving(false)
    }
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
      <p className="text-sm font-semibold text-ink">🧹 使われていないファイルの確認</p>
      {unused.length === 0 ? (
        <p className="text-xs text-ink-secondary">✅ すべてのファイルが、どこかのページ・コードから使われています。</p>
      ) : (
        <>
          <p className="text-xs text-ink">使われていないかもしれないファイルが {unused.length} 件あります</p>
          <p className="text-[11px] text-ink-muted leading-relaxed">
            どのページ・コードからも名前が参照されていないファイルです。素材置き場（公開されません）へ移動できます。🕘 元に戻すで戻せます
          </p>
          <ul className="text-xs text-ink-secondary space-y-0.5 max-h-40 overflow-y-auto select-text">
            {unused.map(f => <li key={f}>・{f}</li>)}
          </ul>
        </>
      )}
      {note && <p className="text-xs text-ink whitespace-pre-wrap select-text">{note}</p>}
      {unused.length > 0 && (
        <button
          onClick={() => { void move() }}
          disabled={moving}
          className="sakura-gradient text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
        >{moving ? '移動しています…' : '素材置き場へ移動'}</button>
      )}
    </section>
  )
}
