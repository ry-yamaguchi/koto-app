import React, { useCallback, useEffect, useState } from 'react'
import CopyButton from './CopyButton'
import { getWorkspaceDir } from '../workspace'
import { formatPublishedAt, PUBLISH_TARGET_CONSOLE, type PublishTargetKind } from '../publishStatus'
import { clearPublishRecord } from '../publishRecord'
import { buildPublishedIndex, groupPublishedByTarget, type PublishedEntry, type PublishedGroup } from '../publishedIndex'
import { teardownSupport } from '../../shared/teardownSupport'
// HANAMII・共用型（さくらのAppRun）・専有型の 🗑 は、どれも共通の「破棄の流れ」（teardown/・段階1の1b・段階2の2b-2・段階3B）。
// 確認の文・実行・窓を閉じる警告・進み具合・結果は共通の部品が受け持つ。公開先ごとの違いは仕様書（teardown/targets/ の hanamii.ts・shared.ts・dedicated.ts）に1つずつ。
// この一覧は押せる場所と、行・結果の置き場だけを持つ。
import TeardownRow from './teardown/TeardownRow'
import TeardownResultView from './teardown/TeardownResultView'
import ManualTeardownNote from './teardown/ManualTeardownNote'
import PublishedInventoryCard from './PublishedInventoryCard'
import { CONTROL_PANEL_URL } from './ServicePrincipalSection'
import { hanamiiTeardownSpec, HANAMII_KEY_MISSING_MESSAGE } from '../teardown/targets/hanamii'
import { sharedTeardownSpec, SHARED_KEY_MISSING_MESSAGE } from '../teardown/targets/shared'
import { dedicatedTeardownSpec, DEDICATED_LIST_KEY_MISSING_MESSAGE } from '../teardown/targets/dedicated'
import type { TeardownFlowOutcome } from '../teardown/useTeardownFlow'

// 「📡 公開したもの一覧」モーダル（表示メニューから開く・2026-07-31 ユーザー要望）。
//
// 目的: サービス側で障害が起きたときなどに「自分は HANAMII に何を公開していたか」をすぐ確認する。
// **ここに出るのは Koto がローカルに持つ公開の記録**で、各サービスの現在の状態ではない。
// その代わりAPIキーもネットワークも使わないため、サービスが落ちていても開ける（この機能の主目的）。
// 「いま公開中か」の正解はサービス側にしか無いので、その旨を画面に明示し管理画面へ誘導する。

/**
 * 専有型の削除で、アプリ・ロードバランサ・オートスケーリンググループ・クラスタは消えたが、保存場所だけが片づかなかったとき。
 * 公開の記録（＝この一覧の行）は保存場所まで片づくまで残る（D1=1・0.6.22）ので、この行の 🗑 で押し直せる。文の中のボタン名は行のボタンの名前（`words.rowButton`）と同じ。
 */
const LIST_STORAGE_RETRY_HINT = `保存場所だけが残りました。この行の「${dedicatedTeardownSpec.words.rowButton}」をもう一度押すと、残った保存場所だけを削除します。専有型タブの手順6「すべて削除する」からも削除できます。`

/**
 * 共用型（さくらのAppRun）の削除で、アプリは消えたが保存場所だけが片づかなかったとき。公開の記録（＝この一覧の行）は、`publish.targets` に行があれば
 * 失敗の回は残るので、行から押し直せる。ただし state.json にだけ記録がある旧い行（publish.targets に共用型が無い）は、アプリを消した時点で
 * 一覧が作られなくなる。そのとき押し直せる場所（共用型の節の 🗑）を教える。
 */
const LIST_SHARED_STORAGE_RETRY_HINT = '保存場所だけが残った場合、この行が一覧から消えることがあります。もう一度削除するには、下の「このプロジェクトを開く」から 📦 さくらのAppRun の「🗑 破棄する（削除）」を押してください（残った保存場所だけを削除します）。'

/** 消すものが記録に無かった（`nothingToDo`）とき、結果に添える次の操作。この破棄では行は消えないので、記録だけを片づける口を教える。 */
const LIST_NOTHING_TO_DO_HINT = 'この行は「一覧から削除」で消せます。'

/** 「一覧から削除」のツールチップが言う、先に消す操作＝その行の 🗑 のボタン名（専有型は「🗑 削除」・HANAMII と共用型は「🗑 破棄」）。ボタンの無い公開先（レンタルサーバ・Vercel）は上の案内に従う。 */
const ROW_BUTTON: Partial<Record<PublishTargetKind, string>> = {
  'sakura-apprun-dedicated': dedicatedTeardownSpec.words.rowButton, 'sakura-apprun': sharedTeardownSpec.words.rowButton, hanamii: hanamiiTeardownSpec.words.rowButton,
}
const forgetTitle = (t: PublishTargetKind): string => `記録だけを消します。公開したもの自体は消えません（先に${ROW_BUTTON[t] ? `「${ROW_BUTTON[t]}」を押してください` : '上の案内のとおり、サービス側で消してください'}）`

/**
 * 公開先ごとの管理画面の表示名（「実際の状態はこちらで確認してください」の誘導先）。
 * URL は複製せず、唯一の定義 PUBLISH_TARGET_CONSOLE（publishStatus.ts）を使う（掟10）。
 * Record<PublishTargetKind, string> なので、種類を足したときの足し忘れは tsc が検知する。
 */
const CONSOLE_LABEL: Record<PublishTargetKind, string> = {
  hanamii: 'HANAMII の管理画面',
  'sakura-apprun': 'さくらのクラウド コントロールパネル',
  // 専有型は共用型と同じ入口（D-3・2026-09-11 Ryosuke 決定。専用 URL は未確認なので推測しない）
  'sakura-apprun-dedicated': 'さくらのクラウド コントロールパネル',
  'sakura-rental': 'さくらのレンタルサーバ コントロールパネル',
  vercel: 'Vercel のダッシュボード',
}

export default function PublishedListModal({ onClose, onOpenProject }: {
  onClose: () => void
  /** 一覧から「開く」を押したときにそのプロジェクトを開く（App.tsx が currentDir を切り替える）。 */
  onOpenProject: (dir: string) => void
}) {
  const [groups, setGroups] = useState<PublishedGroup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState('')
  /** 破棄の実行中の行キー。二重押しを防ぐ。 */
  const [busyKey, setBusyKey] = useState<string | null>(null)
  /** 破棄の結果（成功・失敗とも画面に残す）。 */
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  /**
   * 専有型の 🗑（＝手順6と同じ「すべて削除」）の結果。**行の外**（一覧の上）に出す——削除が全部片づくと main が公開の記録を消し、
   * 行が一覧から消えるため、結果を行に持たせると見えなくなる。閉じて開き直したときに記録から読み戻した結果も、ここに入る。
   */
  const [dedicatedOutcome, setDedicatedOutcome] = useState<{ entry: PublishedEntry; outcome: TeardownFlowOutcome } | null>(null)
  /**
   * HANAMII の 🗑 の結果。専有型と同じく**行の外**（一覧の上）に出す——全部片づくと main が公開の記録を消し、行が一覧から消えるため。
   * 閉じて開き直したときに記録から読み戻した結果も、ここに入る。別の行の破棄が始まったら、その行の onBusyChange が片づける。
   */
  const [hanamiiOutcome, setHanamiiOutcome] = useState<{ entry: PublishedEntry; outcome: TeardownFlowOutcome } | null>(null)
  /**
   * 共用型（さくらのAppRun）の 🗑 の結果。HANAMII と同じく**行の外**（一覧の上）に出す——全部片づくと main が公開の記録を消し、行が一覧から消えるため。
   * 閉じて開き直したときに記録から読み戻した結果も、ここに入る。別の行の破棄が始まったら、その行の onBusyChange が片づける。
   */
  const [sharedOutcome, setSharedOutcome] = useState<{ entry: PublishedEntry; outcome: TeardownFlowOutcome } | null>(null)

  /**
   * 一覧からそのプロジェクトを開く。**行の「プロジェクトを開く」も、結果欄の「このプロジェクトを開く」も、この1つの処理**
   * （App.tsx が currentDir を切り替え、この一覧は閉じる）。
   */
  const openProject = (dir: string) => { onOpenProject(dir); onClose() }

  /** 記録だけを片づける確認中の行（**実体は消えない**ので、必ず1枚挟む）。 */
  const [forgetting, setForgetting] = useState<string | null>(null)

  const reload = useCallback(async (ws?: string) => {
    const dir = ws ?? workspace ?? await getWorkspaceDir()
    const r = await window.electronAPI.fs.publishedRecords(dir)
    if (!r.ok) { setError(r.message ?? '公開記録を読み込めませんでした'); setGroups([]); return }
    setError(null)
    setGroups(groupPublishedByTarget(buildPublishedIndex(r.projects)))
  }, [workspace])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const ws = await getWorkspaceDir()
        if (cancelled) return
        setWorkspace(ws)
        await reload(ws)
      } catch (e: any) {
        if (!cancelled) { setError(e?.message ?? String(e)); setGroups([]) }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 一覧から破棄する（2026-08-09 Ryosuke の要望）──────────────────────
  // これまでは「プロジェクトを開く → 【公開】 → 該当パネル → 破棄」と辿る必要があり、
  // プロジェクトを消したあとは辿りようが無かった。ここから直接止められるようにする。
  // **この一覧は破棄そのものを持たない。** 🗑 のある行は、どれも TeardownRow が、共通の流れ（teardown/flow.ts）で確認 → 実行 → 進み具合 → 結果までを行う。
  // 専有型（2026-10-08）の行は、専有型タブの手順6と同じ「すべて削除」の流れ（アプリだけを消す口は廃止した。段階3B で共通の部品に載せ替えた）。
  // 公開の記録（📡 の行）を消すのも、画面ではなく main の1か所。ここは押せる場所と、行・結果の置き場だけを持つ。

  const total = groups?.reduce((n, g) => n + g.entries.length, 0) ?? 0

  /**
   * 一覧の1行。**行の見た目はここだけが持つ**（共用型・HANAMII・専有型で同じ）。違うのは 🗑 のボタンと、行の下に出すもの
   * （削除中の進み具合）だけ——それは呼び出し側が渡す。
   * `rowBusy` はこの行の削除が走っているか。走っている間は「一覧から削除」も押せない——削除の最中に公開の記録だけを
   * 消すと、途中で止まったとき 🗑 で押し直せなくなり、行が消えたあとは一覧の実行中の印も戻らない。
   */
  const renderRow = (e: PublishedEntry, teardownButton: React.ReactNode, below: React.ReactNode, rowBusy = false) => (
    <div className="border-t border-line pt-1.5 first:border-t-0 first:pt-0 space-y-1.5">
      <div className="flex items-center gap-2 text-xs">
        <div className="min-w-0 flex-1">
          <div className="text-ink truncate" title={e.dir}>{e.projectName}</div>
          <div className="text-ink-muted truncate">
            {e.dateUnknown ? '公開済み（日時不明）' : `${formatPublishedAt(e.publishedAt) ?? ''} 公開`}
            {e.url ? <span className="ml-1.5 select-text">{e.url}</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-none">
          {e.url && (
            <>
              <a
                href={e.url}
                className="text-[11px] border border-line rounded-md px-1.5 py-0.5 text-ink-muted hover:text-ink hover:border-sakura whitespace-nowrap"
                title={e.url}
              >サイトを開く ↗</a>
              <CopyButton text={e.url} title="公開URLをコピー" />
            </>
          )}
          <button
            onClick={() => openProject(e.dir)}
            className="text-[11px] border border-line rounded-md px-1.5 py-0.5 text-ink-muted hover:text-ink hover:border-sakura whitespace-nowrap"
            title={e.dir}
          >プロジェクトを開く</button>
          {/* ここから直接止められるようにする（2026-08-09 Ryosuke の要望）。 */}
          {teardownButton}
          {/* ── 記録だけを片づける（2026-08-15 Ryosuke 指摘）──────────────
              キーを失くした・向こうで消した等で**破棄できない**ことがある。
              そのとき記録だけが残り続け、この一覧に幽霊が並ぶ。
              **実体は消えない**ので、押す前にそう伝える。 */}
          {forgetting === `${e.dir}-${e.target}` ? (
            <>
              <button
                onClick={async () => {
                  try { await clearPublishRecord(e.dir, e.target) } finally { setForgetting(null); await reload() }
                }}
                disabled={rowBusy}
                className="text-[11px] border border-brand-red/60 rounded-md px-1.5 py-0.5 text-brand-red hover:bg-brand-red/10 disabled:opacity-40 whitespace-nowrap"
              >一覧から削除（公開したものは残ります）</button>
              <button
                onClick={() => setForgetting(null)}
                className="text-[11px] text-ink-muted hover:text-ink whitespace-nowrap"
              >やめる</button>
            </>
          ) : (
            <button
              onClick={() => setForgetting(`${e.dir}-${e.target}`)}
              disabled={rowBusy}
              className="text-[11px] border border-line rounded-md px-1.5 py-0.5 text-ink-muted hover:text-ink hover:border-sakura disabled:opacity-40 whitespace-nowrap"
              title={forgetTitle(e.target)}
            >一覧から削除</button>
          )}
        </div>
      </div>
      {below}
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative bg-base border border-line rounded-2xl shadow-xl w-[42rem] max-w-[92vw] max-h-[86vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-line flex-none">
          <h2 className="text-sm font-semibold text-ink">📡 公開したもの一覧</h2>
          <button onClick={onClose} className="text-ink-muted hover:text-ink text-sm" title="閉じる">✕</button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {/* この一覧が何であって何でないかを最初に明示する（誤解すると危険なため） */}
          <div className="rounded-xl border border-line bg-surface p-4 text-xs text-ink-secondary leading-relaxed">
            Koto から公開したときの<b className="text-ink">記録</b>です。サービス側で削除したものも記録には残るため、
            <b className="text-ink">いま実際に公開中かどうかは各サービスの管理画面でご確認ください</b>。
            サービスに障害が出ているときでも開けます。
            <div className="mt-1 text-ink-muted">対象: {workspace || '（プロジェクトを置くフォルダを取得中）'}</div>
          </div>

          {/* さくら側にあるものと、かかっている費用（棚卸し）。押したときだけ問い合わせる（勝手に通信しない）。 */}
          <PublishedInventoryCard workspace={workspace} />

          {result && (
            <div className={`rounded-xl border p-4 text-xs leading-relaxed select-text ${result.ok ? 'border-line bg-surface text-ink' : 'border-brand-red/60 bg-surface text-ink'}`}>
              <span className="whitespace-pre-wrap">{result.ok ? '✅ ' : '⚠️ '}{result.text}</span>
            </div>
          )}

          {/* 専有型の 🗑（＝手順6と同じ「すべて削除」）の結果。HANAMII・共用型と同じ共通の結果の部品（TeardownResultView）。行が消えても残る。
              保存場所だけが残った失敗には、押し直せる行のボタンの案内と、このプロジェクトを開くボタンを添える。 */}
          {dedicatedOutcome && (
            <div className="rounded-xl border border-line bg-surface p-4 space-y-1.5 text-xs leading-relaxed" data-dedicated-outcome>
              <p className="font-semibold text-ink">{dedicatedOutcome.entry.projectName}（{dedicatedOutcome.entry.label}）</p>
              <TeardownResultView
                view={dedicatedOutcome.outcome.view} notes={dedicatedOutcome.outcome.notes} words={dedicatedTeardownSpec.words}
                retryHint="この一覧の 🗑 削除"
                serviceConsoleUrl={PUBLISH_TARGET_CONSOLE['sakura-apprun-dedicated']} storageConsoleUrl={CONTROL_PANEL_URL}
                storageRetryHint={LIST_STORAGE_RETRY_HINT}
                storageRetryAction={{ label: 'このプロジェクトを開く', onClick: () => openProject(dedicatedOutcome.entry.dir) }}
              />
            </div>
          )}

          {/* HANAMII の 🗑 の結果。共通の結果の部品（TeardownResultView）。行が消えても残る。 */}
          {hanamiiOutcome && (
            <div className="rounded-xl border border-line bg-surface p-4 space-y-1.5 text-xs leading-relaxed" data-hanamii-outcome>
              <p className="font-semibold text-ink">{hanamiiOutcome.entry.projectName}（{hanamiiOutcome.entry.label}）</p>
              <TeardownResultView
                view={hanamiiOutcome.outcome.view} notes={hanamiiOutcome.outcome.notes} words={hanamiiTeardownSpec.words}
                retryHint="この一覧の 🗑 破棄"
                serviceConsoleUrl={PUBLISH_TARGET_CONSOLE.hanamii} storageConsoleUrl={CONTROL_PANEL_URL}
              />
            </div>
          )}

          {/* 共用型（さくらのAppRun）の 🗑 の結果。HANAMII と同じ共通の結果の部品。行が消えても残る。
              保存場所だけが残った失敗には、押し直せる場所（このプロジェクトを開く）を添える（専有型と同じ形）。
              消すものが記録に無かった回（nothingToDo）は失敗ではないので、中立の知らせにして、この行を片づける口を教える。 */}
          {sharedOutcome && (
            <div className="rounded-xl border border-line bg-surface p-4 space-y-1.5 text-xs leading-relaxed" data-shared-outcome>
              <p className="font-semibold text-ink">{sharedOutcome.entry.projectName}（{sharedOutcome.entry.label}）</p>
              {sharedOutcome.outcome.nothingToDo === true ? (
                <p className="text-ink-secondary select-text" data-shared-nothing-to-do>
                  {sharedOutcome.outcome.view.message} {LIST_NOTHING_TO_DO_HINT}
                </p>
              ) : (
                <TeardownResultView
                  view={sharedOutcome.outcome.view} notes={sharedOutcome.outcome.notes} words={sharedTeardownSpec.words}
                  retryHint="この一覧の 🗑 破棄"
                  serviceConsoleUrl={PUBLISH_TARGET_CONSOLE['sakura-apprun']} storageConsoleUrl={CONTROL_PANEL_URL}
                  storageRetryHint={LIST_SHARED_STORAGE_RETRY_HINT}
                  storageRetryAction={{ label: 'このプロジェクトを開く', onClick: () => openProject(sharedOutcome.entry.dir) }}
                />
              )}
            </div>
          )}

          {groups === null && <div className="text-xs text-ink-muted">読み込んでいます…</div>}

          {error && (
            <div className="rounded-xl border border-line bg-surface p-4 text-xs text-ink select-text">
              読み込みに失敗しました: {error}
            </div>
          )}

          {groups !== null && total === 0 && !error && (
            <div className="rounded-xl border border-line bg-surface p-4 text-xs text-ink-secondary leading-relaxed">
              公開の記録がまだありません。【公開】から公開すると、ここに記録が残ります。
              <div className="mt-1 text-ink-muted">
                ※ 別のパソコンや各サービスの管理画面から公開したものは、ここには表示されません。
              </div>
            </div>
          )}

          {groups?.map(g => (
            <div key={g.target} className="rounded-xl border border-line bg-surface p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-ink">{g.label}<span className="ml-1.5 text-ink-muted font-normal">{g.entries.length}件</span></div>
                {CONSOLE_LABEL[g.target] && (
                  // 外部リンクは <a href>（main の will-navigate が既定ブラウザへ流す。AppRunPanel と同じ作法）
                  <a
                    href={PUBLISH_TARGET_CONSOLE[g.target]}
                    className="text-[11px] text-ink-muted hover:text-sakura underline"
                    title={PUBLISH_TARGET_CONSOLE[g.target]}
                  >{CONSOLE_LABEL[g.target]}を開く ↗</a>
                )}
              </div>
              {/* この公開先は Koto から止められない、と先に伝える（消す場所も添える）。
                  「できません」だけで終わらせると、課金が続くものを放置させることになる。 */}
              <ManualTeardownNote target={g.target} className="mb-2" />
              <div className="space-y-1.5">
                {g.entries.map((e, i) => {
                  const rowKey = `${e.dir}-${e.target}`
                  // 🗑 のある行（TeardownRow）は状態を持つ部品（フック状態・開いている確認ダイアログ）なので、key に**添字を含めない**（rowKey を直接使う）。
                  // 添字入りだと、上の行が消えた（別の削除の成功後の再読み込み・「一覧から削除」）とき下の行の添字が変わって
                  // 作り直され、確認ダイアログが消え、記録の結果を二度出して直前の結果欄を上書きする（2026-10-08 検分）。
                  // 同じ dir・target の行は一覧に1つしか出ない。状態を持たない行（破棄の口が無い公開先）だけ、従来どおり添字を含める。
                  // 破棄の口が無い公開先には 🗑 を出さず、下の案内に回す。押しても何も起きないボタンを並べない
                  // （判定は shared/teardownSupport.ts に一元化）。
                  const supported = teardownSupport(e.target) === 'supported'
                  // 専有型も TeardownRow（共通の流れ・段階3B）。専有型タブの手順6と同じ「すべて削除」。確認・窓を閉じる警告・進み具合・結果までを行い、公開の記録は main が消す。
                  // 保存場所だけが残った回は行が残る（D1=1）ので、この行の 🗑 で押し直せる。
                  if (e.target === 'sakura-apprun-dedicated' && supported) {
                    return (
                      <TeardownRow
                        key={rowKey}
                        spec={dedicatedTeardownSpec}
                        entry={e}
                        keyMissingMessage={DEDICATED_LIST_KEY_MISSING_MESSAGE}
                        blocked={busyKey !== null && busyKey !== rowKey}
                        onBusyChange={busy => {
                          setBusyKey(prev => (busy ? rowKey : (prev === rowKey ? null : prev)))
                          // 新しい削除が始まった（あるいは走っているのを見つけた）ら、前の結果は片づける。
                          if (busy) { setResult(null); setDedicatedOutcome(null); setHanamiiOutcome(null); setSharedOutcome(null) }
                        }}
                        onOutcome={(entry, outcome) => { setResult(null); setDedicatedOutcome({ entry, outcome }) }}
                        onFinished={() => reload()}
                        render={({ button, below, busy }) => renderRow(e, button, below, busy)}
                      />
                    )
                  }
                  // HANAMII は TeardownRow（共通の流れ）。確認・窓を閉じる警告・進み具合・結果までを行い、公開の記録は main が消す。
                  if (e.target === 'hanamii' && supported) {
                    return (
                      <TeardownRow
                        key={rowKey}
                        spec={hanamiiTeardownSpec}
                        entry={e}
                        keyMissingMessage={HANAMII_KEY_MISSING_MESSAGE}
                        blocked={busyKey !== null && busyKey !== rowKey}
                        onBusyChange={busy => {
                          setBusyKey(prev => (busy ? rowKey : (prev === rowKey ? null : prev)))
                          // 新しい破棄が始まった（あるいは走っているのを見つけた）ら、前の結果は片づける。
                          if (busy) { setResult(null); setDedicatedOutcome(null); setHanamiiOutcome(null); setSharedOutcome(null) }
                        }}
                        onOutcome={(entry, outcome) => { setResult(null); setHanamiiOutcome({ entry, outcome }) }}
                        onFinished={() => reload()}
                        render={({ button, below, busy }) => renderRow(e, button, below, busy)}
                      />
                    )
                  }
                  // 共用型（さくらのAppRun）も TeardownRow（共通の流れ・段階2の2b-2）。確認（レジストリを消すかの選択つき）・窓を閉じる警告・進み具合・結果までを行い、
                  // 公開の記録は main が消す。確認の材料は押した時点の main の記録（cloud:teardownRecord）。行の key は HANAMII と同じく添字を含めない。
                  if (e.target === 'sakura-apprun' && supported) {
                    return (
                      <TeardownRow
                        key={rowKey}
                        spec={sharedTeardownSpec}
                        entry={e}
                        keyMissingMessage={SHARED_KEY_MISSING_MESSAGE}
                        blocked={busyKey !== null && busyKey !== rowKey}
                        onBusyChange={busy => {
                          setBusyKey(prev => (busy ? rowKey : (prev === rowKey ? null : prev)))
                          // 新しい破棄が始まった（あるいは走っているのを見つけた）ら、前の結果は片づける。
                          if (busy) { setResult(null); setDedicatedOutcome(null); setHanamiiOutcome(null); setSharedOutcome(null) }
                        }}
                        onOutcome={(entry, outcome) => { setResult(null); setSharedOutcome({ entry, outcome }) }}
                        onFinished={() => reload()}
                        render={({ button, below, busy }) => renderRow(e, button, below, busy)}
                      />
                    )
                  }
                  // 破棄の口が無い公開先（レンタルサーバ・Vercel）の行。🗑 は出さず、上の案内に回す。
                  // Fragment（行の div を一覧の直下に置く。first: の枠線の効き方が、行ごとに変わらないように）
                  return <React.Fragment key={`${rowKey}-${i}`}>{renderRow(e, null, null)}</React.Fragment>
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-line flex-none flex justify-end">
          <button onClick={onClose} className="text-xs border border-line rounded-lg px-3 py-1.5 text-ink-secondary hover:text-ink hover:border-sakura">閉じる</button>
        </div>
      </div>
    </div>
  )
}
