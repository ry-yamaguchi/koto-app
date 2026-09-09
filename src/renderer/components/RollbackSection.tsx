import { useCallback, useEffect, useState } from 'react'
import { pinnedNotice, servingVersionNames } from '../../shared/apprunTraffic'
import { runSwitch } from '../rollbackSwitch'

// RollbackSection — 公開したものを前のバージョンに戻す（roadmap #32）。stepNo は
// 呼び出し元の番号体系に乗せるための見出し番号（AppRunPanel.tsx から "⑨" を渡す。
// SecurityCheckSection / UnusedFilesSection と同じ作法）。
//
// さくらの開発者から「トラフィックの割り当てを変えることでロールバックができる」と
// 助言があった。**A/Bテストは対象外。ロールバックだけ**を入れる。
// 「公開したら壊れた → 前に戻す」は、Koto の利用者（非エンジニア）の安心に直結する。
//
// プロジェクト側の「🕘 履歴（前の状態に戻す）」（ファイルのスナップショット）とは別物。
// 見出しの絵文字も混同しないものにする（🕘 は履歴側で使用済み。2026-09-08 検分で指摘）。
//
// ── ここは「固定は解除されない」という誤った前提で作っていた（2026-09-08 検分で訂正）─────
// 実際は、Koto から公開し直せば必ず最新のバージョンに戻る（固定は解除される。
// buildPatchBody が常に all_traffic_available:true を送るため）。詳しい経緯は
// shared/apprunTraffic.ts 冒頭を参照。ここでは「固定されている間、訪問者には固定した
// 版が見えていること」を伝え続け（下の pinned 分岐）、公開せずに固定だけ解除したい
// 場面のために「↺ 最新に戻す」ボタンを常に用意する。判断（分類・PUT本文・文言）は
// shared/apprunTraffic.ts に一元化（掟10）。確認ダイアログを通ったときだけ実行する
// ガードは rollbackSwitch.ts の runSwitch に切り出し、main 側にも同じガード（掟5・
// cloud/rollback.ts の performRollback）を置いている。

// ISO日時を「7/6 21:15」形式に整形する（HistoryModal.tsx の formatDate と同じ流儀のローカルヘルパー）
function formatDate(iso: string | null): string {
  if (!iso) return '（日時不明）'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function RollbackSection({ projectDir, refreshSignal, stepNo }: { projectDir: string; refreshSignal?: number; stepNo?: string }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [rows, setRows] = useState<CloudTrafficRow[]>([])
  const [state, setState] = useState<CloudTrafficState | null>(null)
  const [versions, setVersions] = useState<CloudVersionRow[]>([])

  const [switching, setSwitching] = useState<string | null>(null) // 実行中のバージョン名（null=最新に戻す動作中はキーを別に持つ）
  const [switchingLatest, setSwitchingLatest] = useState(false)
  const [actionMsg, setActionMsg] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    // ローカル変数で組み立てて最後に1回 setError する（setState は非同期なので、
    // 同じ呼び出しの中で state の `error` を読んでも直前の setError は反映されていない）。
    let errMsg = ''
    try {
      const [t, v] = await Promise.all([
        window.electronAPI.cloud.getTraffics(projectDir),
        window.electronAPI.cloud.listVersions(projectDir),
      ])
      if (t.ok) { setRows(t.rows ?? []); setState(t.state ?? null) }
      else { setRows([]); setState(null); errMsg = t.message ?? '配分を取得できませんでした' }
      if (v.ok) setVersions(v.versions ?? [])
      else { setVersions([]); if (!errMsg) errMsg = v.message ?? 'バージョン一覧を取得できませんでした' }
    } catch (e: any) {
      errMsg = e?.message ?? String(e)
    } finally {
      setError(errMsg)
      setLoading(false)
    }
  }, [projectDir])

  useEffect(() => { void refresh() }, [refresh, refreshSignal])

  const doSwitch = async (versionName: string | null, label: string) => {
    setActionMsg('')
    try {
      // runSwitch が window.confirm を通す（掟5）。キャンセルなら rollback には一切触れない
      // （ここが「確認していないのに実行される」を防ぐ唯一の場所。main 側にも同じガードがある）。
      const outcome = await runSwitch(
        { versionName, label, isSplit: state?.kind === 'split' },
        {
          confirm: (msg) => window.confirm(msg),
          rollback: (v, opts) => {
            if (v === null) setSwitchingLatest(true); else setSwitching(v)
            return window.electronAPI.cloud.rollback(projectDir, v, opts)
          },
        },
      )
      if (!outcome.proceeded) return
      const { result } = outcome
      setActionMsg(result.ok ? `✅ 『${label}』に切り替えました。` : `⚠️ ${result.message ?? '切り替えに失敗しました'}`)
      if (result.ok) await refresh()
    } catch (e: any) {
      setActionMsg(`⚠️ ${e?.message ?? String(e)}`)
    } finally {
      setSwitchingLatest(false); setSwitching(null)
    }
  }

  const serving = servingVersionNames(rows)

  const stateSummary =
    state?.kind === 'latest' ? '最新のバージョンに自動で追従しています。'
    : state?.kind === 'pinned' ? `『${state.versionName}』に固定されています。`
    // 4【低】: split は「A/Bテスト中」の断定ではなく、応答が読めなかった場合も含む
    // （trafficState は判断できない形をすべて split に倒す）。断定せず、その通り伝える。
    : state?.kind === 'split' ? 'いまの配分を判断できませんでした（複数のバージョンに分かれている可能性があります）。'
    : ''

  return (
    <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-ink">{stepNo ? `${stepNo} ` : ''}⏪ 公開したものを前のバージョンに戻す</p>
        <button onClick={() => void refresh()} disabled={loading} className="text-xs text-ink-muted hover:underline disabled:opacity-50">
          {loading ? '取得中…' : '↻ 更新'}
        </button>
      </div>

      {/* roadmap #37: 「ロールバックと🕘履歴はどう棲み分けるのか」という質問が実際に出た
          （同じところで他の人も迷う）。ここでしか戻らないもの・戻らないものを短く書く。 */}
      <p className="text-[11px] text-ink-muted leading-relaxed">
        ※ ここは<b className="text-ink">公開したもの</b>（訪問者に見えているもの）を戻します。
        手元のファイルは変わりません（手元を戻すのは「🕘 履歴（前の状態に戻す）」です）。
        壊れたときは、まずここで戻して被害を止めてから、直して公開し直すと安全です。
      </p>

      {/* 固定されている間は、常に警告を出し続ける（訪問者には固定した版が見えていることを伝える）。 */}
      {state?.kind === 'pinned' && (
        <div className="rounded-lg border border-brand-yellow/70 bg-overlay p-3 space-y-2">
          <p className="text-xs font-semibold text-brand-red leading-relaxed select-text">{pinnedNotice(state.versionName)}</p>
          <button
            onClick={() => void doSwitch(null, '最新のバージョン')}
            disabled={switchingLatest}
            className="border border-line rounded-lg px-3 py-1.5 text-xs font-semibold text-ink hover:border-sakura disabled:opacity-40"
          >{switchingLatest ? '切り替えています…' : '↺ 最新に戻す（公開したものを反映させる）'}</button>
        </div>
      )}

      {error && <p className="text-[11px] text-brand-red leading-relaxed select-text">⚠️ {error}</p>}

      {!loading && !error && (
        <>
          <p className="text-xs text-ink-secondary leading-relaxed">現在の配分: {stateSummary || '確認できませんでした。'}</p>

          {versions.length === 0 ? (
            <p className="text-xs text-ink-muted">まだバージョンがありません。</p>
          ) : (
            <ul className="rounded-lg border border-line bg-overlay divide-y divide-line max-h-64 overflow-y-auto">
              {versions.map(v => {
                const isServing = !!v.name && serving.includes(v.name)
                const alreadyPinnedHere = state?.kind === 'pinned' && !!v.name && state.versionName === v.name
                const busy = !!v.name && switching === v.name
                return (
                  <li key={v.id ?? v.name ?? Math.random()} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-xs font-mono text-ink break-all">
                        {v.name ?? '（名前不明）'}
                        {isServing && <span className="ml-2 text-[10px] font-semibold text-sakura">🟢 配信中</span>}
                      </p>
                      <p className="text-[11px] text-ink-muted">
                        {formatDate(v.createdAt)}{v.status ? `・${v.status}` : ''}
                      </p>
                    </div>
                    <button
                      onClick={() => v.name && void doSwitch(v.name, v.name)}
                      disabled={!v.name || busy || alreadyPinnedHere}
                      className="flex-none text-xs border border-line rounded-lg px-3 py-1.5 text-ink hover:border-sakura disabled:opacity-40"
                    >{busy ? '切り替えています…' : alreadyPinnedHere ? '固定中' : 'このバージョンに戻す'}</button>
                  </li>
                )
              })}
            </ul>
          )}

          {actionMsg && <p className="text-xs text-ink-secondary leading-relaxed select-text">{actionMsg}</p>}

          <p className="text-[11px] text-ink-muted leading-relaxed">
            公開URLは変わりません。戻すと、訪問者に見えるものがすぐに切り替わります。
          </p>
        </>
      )}
    </section>
  )
}
