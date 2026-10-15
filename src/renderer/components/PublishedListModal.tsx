import React, { useCallback, useEffect, useState } from 'react'
import CopyButton from './CopyButton'
import { getWorkspaceDir } from '../workspace'
import { formatPublishedAt, PUBLISH_TARGET_CONSOLE, type PublishTargetKind } from '../publishStatus'
import { kindLabel, costNote } from '../../shared/inventory'
import { listCloudKeys, getActiveCloudKeyId } from './CredentialsModal'
import { clearPublishRecord } from '../publishRecord'
import { buildPublishedIndex, groupPublishedByTarget, type PublishedEntry, type PublishedGroup } from '../publishedIndex'
import { teardownSupport, manualTeardownGuide, teardownScopeNote, teardownDataNoteForAll } from '../../shared/teardownSupport'
import { registryDeleteHelp, registryDeleteLabel, registryDeleteDefault, adoptedRegistryNote, registryUnknownNotice, teardownRemainingWarnings, urlChangesOnTeardownNotice } from '../../shared/cloudCost'
import { getHanamiiToken } from './CredentialsModal'
// 専有型の 🗑 破棄は、専有型タブの手順6と同じ「すべて削除」の流れ（2026-10-08・作者の決定）。流れ・確認の文・進み具合・結果は
// 手順6と同じ部品（dedicatedTeardownFlow.ts・DedicatedTeardownView.tsx）。この一覧は押せる場所と、行・結果の置き場だけを持つ。
import DedicatedTeardownRow from './DedicatedTeardownRow'
import { DedicatedTeardownResultView } from './DedicatedTeardownView'
import type { DedicatedTeardownOutcome } from '../hooks/useDedicatedTeardown'

// 「📡 公開したもの一覧」モーダル（表示メニューから開く・2026-07-31 ユーザー要望）。
//
// 目的: サービス側で障害が起きたときなどに「自分は HANAMII に何を公開していたか」をすぐ確認する。
// **ここに出るのは Koto がローカルに持つ公開の記録**で、各サービスの現在の状態ではない。
// その代わりAPIキーもネットワークも使わないため、サービスが落ちていても開ける（この機能の主目的）。
// 「いま公開中か」の正解はサービス側にしか無いので、その旨を画面に明示し管理画面へ誘導する。

/**
 * 公開先ごとの管理画面の表示名（「実際の状態はこちらで確認してください」の誘導先）。
 * URL は複製せず、唯一の定義 PUBLISH_TARGET_CONSOLE（publishStatus.ts）を使う（掟10）。
 * Record<PublishTargetKind, string> なので、種類を足したときの足し忘れは tsc が検知する。
 */
/**
 * 専有型の削除で、アプリ・ロードバランサ・オートスケーリンググループ・クラスタは消えたが、保存場所だけが片づかなかったとき。
 * アプリが消えた時点で公開の記録（＝この一覧の行）は main が外すので、行はもう無い。押し直せる場所（手順6）を教える。
 */
const LIST_STORAGE_RETRY_HINT = '保存場所だけが残った場合、この行は一覧から消えます。もう一度削除するには、下の「このプロジェクトを開く」から専有型タブの手順6「すべて削除する」を押してください（残った保存場所だけを削除します）。'

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
  /** 破棄の確認中の行（null なら確認していない）。破壊操作なので必ず1枚挟む（掟5）。 */
  const [confirm, setConfirm] = useState<PublishedEntry | null>(null)
  /** 破棄の実行中の行キー。二重押しを防ぐ。 */
  const [busyKey, setBusyKey] = useState<string | null>(null)
  /** 破棄の結果（成功・失敗とも画面に残す）。 */
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  /**
   * 専有型の 🗑（＝手順6と同じ「すべて削除」）の結果。**行の外**（一覧の上）に出す——削除が成功すると main が公開の記録を消し、
   * 行が一覧から消えるため、結果を行に持たせると見えなくなる。閉じて開き直したときに記録から読み戻した結果も、ここに入る。
   */
  const [dedicatedOutcome, setDedicatedOutcome] = useState<{ entry: PublishedEntry; outcome: DedicatedTeardownOutcome } | null>(null)
  /** AppRun の破棄でコンテナレジストリも消すか（既定 true＝月額課金を止める側）。 */
  const [deleteRegistry, setDeleteRegistry] = useState(true)
  /**
   * 確認中の行の保存場所（**同意済みの全件**）。**データが消えることを言わずに押させない**ため、
   * 確認画面を出すときに読む（2026-08-14 ／ 全件にしたのは 2026-09-25 検分の指摘5）。
   *
   * ── なぜ全件なのか ────────────────────────────────────────────
   * 破棄は `teardownStorageForProject` が同意済みの保存場所を**全件**片づける
   * （tests/hanamiiStorageTeardown.test.ts の「2つあれば2つとも片づける」が固定している）。
   * ところがここは `storage:placement` の `placement`（**先頭1件**）だけで文を組み立てていたので、
   * env.json に2件あると「保存場所『A』のデータも削除します」としか出ないまま、
   * **名前が一度も出なかった『B』とその中のデータまで消えた**。
   * 元に戻せない削除を、名指ししないまま実行させてはいけない（掟10）。
   */
  const [confirmPlacements, setConfirmPlacements] = useState<Array<{ bucket: string; prefix: string; shared: boolean }>>([])

  /** 破棄の確認を出す（保存場所も調べてから）。 */
  const askConfirm = async (e: PublishedEntry) => {
    // **借り物の置き場は、最初から外しておく**（判断は shared/cloudCost.ts に一元化）。
    setDeleteRegistry(registryDeleteDefault({ registryName: e.registryName, adopted: e.registryAdopted }))
    setConfirmPlacements([])
    setConfirm(e)
    try {
      const r = await window.electronAPI.storage.placement(e.dir)
      if (!r.ok) return
      // placements（全件）が無い版の応答でも、先頭1件だけは必ず拾う（黙って空にしない）。
      const all = r.placements ?? (r.placement ? [r.placement] : [])
      setConfirmPlacements(all.map(p => ({ bucket: p.bucket, prefix: p.prefix, shared: p.shared })))
    } catch { /* 読めなくても破棄はできる（消えるものが増えるわけではない） */ }
  }

  /**
   * 一覧からそのプロジェクトを開く。**行の「プロジェクトを開く」も、結果欄の「このプロジェクトを開く」も、この1つの処理**
   * （App.tsx が currentDir を切り替え、この一覧は閉じる）。
   */
  const openProject = (dir: string) => { onOpenProject(dir); onClose() }

  /** 記録だけを片づける確認中の行（**実体は消えない**ので、必ず1枚挟む）。 */
  const [forgetting, setForgetting] = useState<string | null>(null)

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
  // **専有型はここを通らない**（2026-10-08）。専有型の行は DedicatedTeardownRow が、専有型タブの手順6と同じ流れで
  // 確認 → 削除 → 進み具合 → 結果までを行う（アプリだけを消す口は廃止した）。ここは共用型 AppRun と HANAMII。
  const runTeardown = async (e: PublishedEntry) => {
    const key = `${e.dir}-${e.target}`
    setConfirm(null); setBusyKey(key); setResult(null)
    try {
      let r: {
        ok: boolean; message?: string; keptBucketName?: string | null
        /** 共用型: 「残す」と選んだレジストリの事実（名前あり／記録に名前が無い）。警告はこの事実から作る。 */
        keptRegistryName?: string; keptRegistryUnnamed?: boolean
        /** HANAMII: プロジェクトは消えたか（保存場所だけ失敗しても true）。 */
        appDeleted?: boolean
        /** HANAMII: 保存場所について片づけたこと・片づけ切れなかったこと。 */
        executed?: string[]
      }
      if (e.target === 'sakura-apprun') {
        // AppRun はクラウドのAPIキーを main 側が持っているので projectDir だけで足りる。
        // 記録が無いレジストリは削除できないので「削除しない」を渡す（確認画面と同じ判断）。
        const effectiveDeleteRegistry = !!e.registryName && deleteRegistry
        r = await window.electronAPI.cloud.teardown(e.dir, { confirmed: true, deleteRegistry: effectiveDeleteRegistry })
        if (r.ok) {
          // レジストリを残したなら、結果でも「課金は続く」と念を押す（【公開】の破棄と同じ扱い）。
          // 保存場所は破棄しても残ることがある（3段構え）。残ったなら課金も続く
          // 警告は、選択ではなく main が返した事実から作る（【公開】の破棄の結果・処理の記録と同じ関数・2026-09-30 検分の指摘6）
          const warn = teardownRemainingWarnings(r).join('\n')
          if (warn) {
            try { await clearPublishRecord(e.dir, e.target) } catch { /* 記録の掃除の失敗は破棄の成否に影響させない */ }
            setResult({ ok: true, text: `${e.projectName}（${e.label}）を破棄しました。\n${warn}` })
            await reload()
            return
          }
        }
      } else if (e.target === 'hanamii') {
        if (!e.hanamiiProjectId) {
          setResult({ ok: false, text: 'HANAMII のプロジェクトIDが記録に無いため、ここからは削除できません。HANAMII の管理画面から削除してください。' })
          return
        }
        const token = await getHanamiiToken()
        if (!token) {
          setResult({ ok: false, text: 'HANAMII のトークンが未登録です。「認証情報」で登録してから、もう一度お試しください。' })
          return
        }
        // ── 保存場所まで片づける（2026-09-25 検分）──────────────────────────
        // すぐ上の確認オーバーレイは HANAMII でも「保存場所『X』にある、このプロジェクトの
        // データも削除します…保存場所そのものも削除して月額を止めます」と言い切る
        // （teardownDataNoteFor）。**e.dir を渡さないと、main は保存場所へ1件も要求を出せない**
        // ＝画面の約束が嘘になる（月額495円が止まらず、消したはずのアプリの鍵が生き残る）。
        r = await window.electronAPI.hanamii.teardown(e.hanamiiProjectId, token, e.dir)
        // ── HANAMII のプロジェクトは消えたが、保存場所だけ片づかなかったとき ────────
        // **記録は残す**（2026-09-25 検分の指摘3）。main は「『認証情報』でAPIキーを登録してから、
        // もう一度 🗑 を押してください」と案内するのに、ここで記録を片づけて reload すると
        // **一覧から行ごと消えて、押し直す 🗑 がどこにも無くなっていた**（🗑 は公開の記録からしか
        // 作られない）。専有型の「まだ削除中」の枝（すぐ上）と同じ作法に揃える——
        // **消えたのを確かめるまで記録は残す。** main 側も、2度目の破棄で HANAMII が 404
        //（もう無い）を返したら保存場所の片づけだけを続けるようにしてある。
        // 片づけを諦めたときは、この行の「一覧から削除」で一覧から消せる。
        if (!r.ok && r.appDeleted) {
          setResult({
            ok: false,
            text: `${e.projectName}（${e.label}）の HANAMII のプロジェクトは削除しました。\n`
              + `ただし、保存場所の削除は完了しませんでした（消すまで月額が続きます）: ${r.message ?? '原因不明'}`
              + ((r.executed ?? []).length > 0 ? `\n${(r.executed ?? []).join('\n')}` : '')
              + '\n削除できなかったものがあるため、この一覧には記録を残しています（🗑 を押し直すと、保存場所の削除だけをやり直します）。',
          })
          await reload()
          return
        }
        // 片づけた内容（バケットを消したか、ほかのプロジェクトが使っていて残したか）を必ず出す。
        // 「破棄しました。」だけだと、残ったバケットの月額に気づけない。
        if (r.ok) {
          try { await clearPublishRecord(e.dir, e.target) } catch { /* 同上 */ }
          const notes = r.executed ?? []
          setResult({
            ok: true,
            text: `${e.projectName}（${e.label}）を破棄しました。` + (notes.length > 0 ? `\n${notes.join('\n')}` : ''),
          })
          await reload()
          return
        }
      } else {
        setResult({ ok: false, text: manualTeardownGuide(e.target) })
        return
      }

      if (!r.ok) {
        setResult({ ok: false, text: `破棄できませんでした: ${r.message ?? '原因不明'}` })
        return
      }
      // 破棄できたら公開記録も消す（残すと存在しない公開が一覧に出続ける。v0.2.97 と同じ扱い）。
      try { await clearPublishRecord(e.dir, e.target) } catch { /* 記録の掃除の失敗は破棄の成否に影響させない */ }
      setResult({ ok: true, text: `${e.projectName}（${e.label}）を破棄しました。` })
      await reload()
    } catch (err: any) {
      setResult({ ok: false, text: `破棄できませんでした: ${err?.message ?? String(err)}` })
    } finally {
      setBusyKey(null)
    }
  }

  const total = groups?.reduce((n, g) => n + g.entries.length, 0) ?? 0

  /**
   * 一覧の1行。**行の見た目はここだけが持つ**（共用型・HANAMII・専有型で同じ）。違うのは 🗑 のボタンと、行の下に出すもの
   * （専有型の削除中の進み具合）だけ——それは呼び出し側が渡す。
   * `rowBusy` はこの行の削除が走っているか（専有型だけ）。走っている間は「一覧から削除」も押せない——削除の最中に公開の記録だけを
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
                title="この一覧から消すだけです。公開したもの自体は消えません"
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
              title="記録だけを消します。公開したもの自体は消えません（先に「破棄」してください）"
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
            この一覧を開くだけなら、APIキーも通信も使いません。サービスに障害が出ているときでも開けます。
            <div className="mt-1 text-ink-muted">対象: {workspace || '（プロジェクトを置くフォルダを取得中）'}</div>
          </div>

          {/* ── さくら側にあるもの（改善案 1-3 / 1-4）──────────────────────
              上の一覧は「Koto の記録」。**記録に無いものは出ない**ので、
              放置されたまま課金が続く（2026-08-14 に実際に起きた）。
              押したときだけ問い合わせる（勝手に通信しない）。 */}
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
                この一覧（上）は Koto の記録です。<b className="text-ink">記録に無いものは出ません。</b>
                別のパソコンで作ったものや、コントロールパネルから手動で作ったものが残っていると、気づかないまま費用がかかり続けます。
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
                  ここに出ているのは<b className="text-ink">いま実際にある</b>ものです。
                  Koto から消せるものは上の一覧の「🗑 破棄」から、そうでないものは
                  <a href="https://secure.sakura.ad.jp/cloud/" className="text-sakura hover:underline"> さくらのクラウド コントロールパネル ↗</a> から削除してください。
                </p>
              </>
            )}
          </div>

          {result && (
            <div className={`rounded-xl border p-4 text-xs leading-relaxed select-text ${result.ok ? 'border-line bg-surface text-ink' : 'border-brand-red/60 bg-surface text-ink'}`}>
              <span className="whitespace-pre-wrap">{result.ok ? '✅ ' : '⚠️ '}{result.text}</span>
            </div>
          )}

          {/* 専有型の 🗑（＝手順6と同じ「すべて削除」）の結果。手順6の結果欄と同じ部品（2026-10-08）。行が消えても残る。 */}
          {dedicatedOutcome && (
            <div className="rounded-xl border border-line bg-surface p-4 space-y-1.5 text-xs leading-relaxed" data-dedicated-outcome>
              <p className="font-semibold text-ink">{dedicatedOutcome.entry.projectName}（{dedicatedOutcome.entry.label}）</p>
              <DedicatedTeardownResultView
                result={dedicatedOutcome.outcome.result} notes={dedicatedOutcome.outcome.notes} retryHint="この一覧の 🗑 破棄"
                storageRetryHint={LIST_STORAGE_RETRY_HINT}
                storageRetryAction={{ label: 'このプロジェクトを開く', onClick: () => openProject(dedicatedOutcome.entry.dir) }}
              />
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
                ※ 別のパソコンや各サービスの管理画面から公開したものは、Koto には記録が残らないため表示されません。
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
              {teardownSupport(g.target) === 'manual' && (
                <p className="text-[11px] text-ink-muted leading-relaxed mb-2">ℹ️ {manualTeardownGuide(g.target)}</p>
              )}
              <div className="space-y-1.5">
                {g.entries.map((e, i) => {
                  const rowKey = `${e.dir}-${e.target}`
                  // 専有型の行は状態を持つ部品（フック状態・開いている確認ダイアログ）なので、**添字を含めない**キーにする。
                  // 添字入りだと、上の行が消えた（別の削除の成功後の再読み込み・「一覧から削除」）とき下の行の添字が変わって
                  // 作り直され、確認ダイアログが消え、記録の結果を二度出して直前の結果欄を上書きする（2026-10-08 検分）。
                  // 同じ dir・target の行は一覧に1つしか出ない。ほかの行は状態を持たないので従来のまま。
                  const key = e.target === 'sakura-apprun-dedicated' ? rowKey : `${rowKey}-${i}`
                  // 破棄の口が無い公開先には出さず、下の案内に回す。押しても何も起きないボタンを並べない
                  // （判定は shared/teardownSupport.ts に一元化）。
                  const supported = teardownSupport(e.target) === 'supported'
                  // 専有型は DedicatedTeardownRow（専有型タブの手順6と同じ「すべて削除」）。ほかは従来どおり確認 → runTeardown。
                  if (e.target === 'sakura-apprun-dedicated' && supported) {
                    return (
                      <DedicatedTeardownRow
                        key={key}
                        entry={e}
                        blocked={busyKey !== null && busyKey !== rowKey}
                        onBusyChange={busy => {
                          setBusyKey(prev => (busy ? rowKey : (prev === rowKey ? null : prev)))
                          // 新しい削除が始まった（あるいは走っているのを見つけた）ら、前の結果は片づける。
                          if (busy) { setResult(null); setDedicatedOutcome(null) }
                        }}
                        onOutcome={(entry, outcome) => { setResult(null); setDedicatedOutcome({ entry, outcome }) }}
                        onFinished={() => reload()}
                        render={({ button, below, busy }) => renderRow(e, button, below, busy)}
                      />
                    )
                  }
                  const genericButton = supported ? (
                    <button
                      onClick={() => { void askConfirm(e) }}
                      disabled={busyKey !== null}
                      className="text-[11px] border border-brand-red/60 rounded-md px-1.5 py-0.5 text-brand-red hover:bg-brand-red/10 disabled:opacity-40 whitespace-nowrap"
                      title="公開を止めて、作られたものを削除します"
                    >{busyKey === rowKey ? '破棄中…' : '🗑 破棄'}</button>
                  ) : null
                  // Fragment（行の div を一覧の直下に置く。first: の枠線の効き方が、行ごとに変わらないように）
                  return <React.Fragment key={key}>{renderRow(e, genericButton, null)}</React.Fragment>
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-line flex-none flex justify-end">
          <button onClick={onClose} className="text-xs border border-line rounded-lg px-3 py-1.5 text-ink-secondary hover:text-ink hover:border-sakura">閉じる</button>
        </div>

        {/* 破棄の確認（破壊操作は必ず1枚挟む・掟5）。【公開】の破棄画面と同じことを伝える。 */}
        {confirm && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 rounded-2xl" onClick={() => setConfirm(null)}>
            <div className="bg-base border border-brand-red/70 rounded-xl shadow-xl w-[26rem] max-w-[88vw] p-4 space-y-2" onClick={ev => ev.stopPropagation()}>
              <p className="text-sm font-semibold text-ink">⚠️ 公開を破棄します</p>
              <p className="text-xs text-ink-secondary leading-relaxed">
                <b className="text-ink">{confirm.projectName}</b>（{confirm.label}）<br />
                {teardownScopeNote(confirm.target)}この操作は元に戻せません。
              </p>
              {/* 2026-09-24 検分の指摘7: 確認が言う「保存場所のデータも削除します」と、実物がすることを揃える。
                  出し分けの判断は shared/teardownSupport.ts の純関数に置く。
                  この確認は共用型 AppRun と HANAMII の 🗑 の確認。**専有型の 🗑 は、この確認を通らず**、
                  専有型タブの手順6と同じ確認（ConfirmModal・buildDedicatedTeardownConfirm）を出す（2026-10-08）。 */}
              {/* 2026-09-25 検分の指摘5: **全件（placements）で組み立てる。** 先頭1件だけで
                  組み立てると、名前が一度も出なかった保存場所とデータまで消える。 */}
              {teardownDataNoteForAll({ target: confirm.target, scope: 'list', placements: confirmPlacements }) && (
                <p className="text-xs text-brand-red leading-relaxed select-text">
                  💾 {teardownDataNoteForAll({ target: confirm.target, scope: 'list', placements: confirmPlacements })}
                </p>
              )}
              <p className="text-xs text-brand-red leading-relaxed">
                🔗 {urlChangesOnTeardownNotice()}
              </p>

              {/* AppRun はコンテナレジストリの月額課金が絡むので、【公開】の破棄画面と同じ情報を出す。
                  **名前を見せることが安全装置**（v0.2.94: 心当たりのない名前ならやめられる）なので、
                  置き場所が変わっても同じ判断ができるようにする。記録が無ければ削除できない。
                  専有型（'sakura-apprun-dedicated'）はこの確認を通らない（上の説明。専有型の削除の確認は
                  手順6と同じ1つの関数が作る）ので、ここに専有型の分岐は要らない。 */}
              {confirm.target === 'sakura-apprun' && (
                confirm.registryName ? (
                  <div className="rounded-lg border border-line bg-surface p-2.5 space-y-1">
                    <label className="flex items-start gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={deleteRegistry}
                        onChange={ev => setDeleteRegistry(ev.target.checked)}
                        className="mt-0.5 accent-[rgb(var(--sakura-rgb))]"
                      />
                      <span className="text-xs text-ink font-medium">{registryDeleteLabel(confirm.registryName)}</span>
                    </label>
                    {/* 借り物のときは、既定を外した理由をその場で言う（【公開】の破棄画面と同じ） */}
                    {confirm.registryAdopted && (
                      <p className="text-[11px] text-brand-red leading-relaxed pl-5 select-text">⚠️ {adoptedRegistryNote(confirm.registryName)}</p>
                    )}
                    <p className={`text-[11px] leading-relaxed pl-5 ${deleteRegistry ? 'text-ink-secondary' : 'text-brand-red'}`}>
                      {registryDeleteHelp(deleteRegistry)}
                    </p>
                  </div>
                ) : (
                  <p className="text-[11px] text-brand-red leading-relaxed select-text">⚠️ {registryUnknownNotice()}</p>
                )
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setConfirm(null)}
                  className="px-3 py-1.5 rounded-md text-[12px] text-ink-secondary hover:bg-overlay"
                >やめる</button>
                <button
                  onClick={() => runTeardown(confirm)}
                  className="px-3 py-1.5 rounded-md text-[12px] font-semibold text-white bg-brand-red-fill hover:opacity-90"
                >🗑 理解した上で破棄する</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
