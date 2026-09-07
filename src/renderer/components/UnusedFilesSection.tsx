import { useCallback, useEffect, useState } from 'react'
import { MATERIALS_DIR } from '../../shared/publishExclude'
import type { UnusedRuntime } from '../../shared/unusedFiles'

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
// stepNo: 呼び出し元の画面の番号体系に乗せるための見出し番号（例 '⑤'）。
// 渡されなければ従来どおり番号なし（PublishModal は番号体系を持たない画面のため未指定・2026-09-04 Ryosuke 指摘）。
export default function UnusedFilesSection({ projectDir, stepNo }: { projectDir: string; stepNo?: string }) {
  const [supported, setSupported] = useState(true)
  const [unused, setUnused] = useState<string[]>([])
  const [runtime, setRuntime] = useState<UnusedRuntime>('static')
  const [moving, setMoving] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const check = useCallback(async (dir: string) => {
    try {
      const r = await window.electronAPI.fs.unusedCheck(dir)
      setSupported(r.supported)
      setUnused(r.unused)
      setRuntime(r.runtime)
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

  // 2026-09-04 Ryosuke: 節ごと消すのは常時表示の趣旨に反する（出ない＝壊れている
  // ように見える）。
  // 実機（Express アプリ）で「節が出ない＝壊れている？」と受け取られたため、
  // supported が false でも節そのものは描画し、理由を出す（移動ボタンだけ出さない）。
  // 2026-09-06（roadmap #22）: Node/PHP も検出できるようになったため、対象外の理由は
  // 「projectDir が不正（プロジェクト未選択など）」だけになった。代わりに runtime が
  // 'dynamic' のときは、動的な参照は文字列出現だけでは追い切れないという但し書きを
  // 一覧の上に出す（0件のときは出す対象が無いので不要）。

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
        // 素材置き場に同名が既にあった等で改名した分は、利用者に何が起きたか伝える
        // （2026-09-04 実機の修理: 黙って別名になると「移動したはずなのに見当たらない」になる）。
        const renamed = r.renamed ?? []
        const renamedLines = renamed.slice(0, 3).map(x => `\n（同じ名前があったため改名: ${x.from} → ${x.to}）`).join('')
        const renamedMore = renamed.length > 3 ? `\n（ほか ${renamed.length - 3} 件を改名）` : ''
        setNote(
          `✅ ${r.moved.length}件を『${MATERIALS_DIR}』へ移動しました`
          + renamedLines + renamedMore
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
      <p className="text-sm font-semibold text-ink">{stepNo ? `${stepNo} ` : ''}🧹 使われていないファイルの確認</p>
      {!supported ? (
        // 対象外（projectDir が不正）。理由まで書く（何も出さないと「壊れている」と区別が付かない）。
        <p className="text-xs text-ink-secondary leading-relaxed">
          ⚠️ いまは確認できません（プロジェクトが選ばれていない可能性があります）。
        </p>
      ) : unused.length === 0 ? (
        <p className="text-xs text-ink-secondary">✅ すべてのファイルが、どこかのページ・コードから使われています。</p>
      ) : (
        <>
          <p className="text-xs text-ink">使われていないかもしれないファイルが {unused.length} 件あります</p>
          {runtime === 'dynamic' && (
            // Node/PHP 等はプログラムが実行時にファイル名を組み立てることがあり、
            // 文字列の出現だけでは追い切れない（roadmap #22・2026-09-06）。
            <p className="text-[11px] text-ink-muted leading-relaxed">
              ⚠️ このプロジェクトはプログラムが動くタイプです。実行時にファイル名を組み立てている場合、実際は使っているファイルが「使われていない」と出ることがあります。移動する前に一覧をご確認ください（🕘 元に戻すで戻せます）。
            </p>
          )}
          <p className="text-[11px] text-ink-muted leading-relaxed">
            どのページ・コードからも名前が参照されていないファイルです。素材置き場（公開されません）へ移動できます。🕘 元に戻すで戻せます
          </p>
          <ul className="text-xs text-ink-secondary space-y-0.5 max-h-40 overflow-y-auto select-text">
            {unused.map(f => <li key={f}>・{f}</li>)}
          </ul>
        </>
      )}
      {note && <p className="text-xs text-ink whitespace-pre-wrap select-text">{note}</p>}
      {supported && unused.length > 0 && (
        <button
          onClick={() => { void move() }}
          disabled={moving}
          className="sakura-gradient text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
        >{moving ? '移動しています…' : '素材置き場へ移動'}</button>
      )}
    </section>
  )
}
