import React, { useCallback, useEffect, useState } from 'react'
import CopyButton from './CopyButton'
import { getWorkspaceDir } from '../workspace'
import { formatPublishedAt } from '../publishStatus'
import { kindLabel } from '../../shared/inventory'
import { listCloudKeys, getActiveCloudKeyId } from './CredentialsModal'
import { clearPublishRecord } from '../publishRecord'
import { buildPublishedIndex, groupPublishedByTarget, type PublishedEntry, type PublishedGroup } from '../publishedIndex'
import { teardownSupport, manualTeardownGuide, teardownScopeNote, teardownDataNote } from '../../shared/teardownSupport'
import { registryDeleteHelp, registryDeleteLabel, registryUnknownNotice, remainingCostWarning, urlChangesOnTeardownNotice } from '../../shared/cloudCost'
import { getHanamiiToken } from './CredentialsModal'

// 「📡 公開したもの一覧」モーダル（表示メニューから開く・2026-07-31 ユーザー要望）。
//
// 目的: サービス側で障害が起きたときなどに「自分は HANAMII に何を公開していたか」をすぐ確認する。
// **ここに出るのは Koto がローカルに持つ公開の記録**で、各サービスの現在の状態ではない。
// その代わりAPIキーもネットワークも使わないため、サービスが落ちていても開ける（この機能の主目的）。
// 「いま公開中か」の正解はサービス側にしか無いので、その旨を画面に明示し管理画面へ誘導する。

/** 公開先ごとの管理画面（「実際の状態はこちらで確認してください」の誘導先）。 */
const CONSOLE_LINKS: Record<string, { label: string; url: string }> = {
  hanamii: { label: 'HANAMII の管理画面', url: 'https://hanamii.jp/' },
  'sakura-apprun': { label: 'さくらのクラウド コントロールパネル', url: 'https://secure.sakura.ad.jp/cloud/' },
  'sakura-rental': { label: 'さくらのレンタルサーバ コントロールパネル', url: 'https://secure.sakura.ad.jp/rs/cp/' },
  vercel: { label: 'Vercel のダッシュボード', url: 'https://vercel.com/dashboard' },
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
  /** AppRun の破棄でコンテナレジストリも消すか（既定 true＝月額課金を止める側）。 */
  const [deleteRegistry, setDeleteRegistry] = useState(true)
  /**
   * 確認中の行の保存場所（あれば）。**データが消えることを言わずに押させない**ため、
   * 確認画面を出すときに読む（2026-08-14）。
   */
  const [confirmPlacement, setConfirmPlacement] = useState<{ bucket: string; prefix: string; shared: boolean } | null>(null)

  /** 破棄の確認を出す（保存場所も調べてから）。 */
  const askConfirm = async (e: PublishedEntry) => {
    setDeleteRegistry(true)
    setConfirmPlacement(null)
    setConfirm(e)
    try {
      const r = await window.electronAPI.storage.placement(e.dir)
      if (r.ok) setConfirmPlacement(r.placement)
    } catch { /* 読めなくても破棄はできる（消えるものが増えるわけではない） */ }
  }

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
  // これまでは「プロジェクトを開く → ③公開 → 該当パネル → 破棄」と辿る必要があり、
  // プロジェクトを消したあとは辿りようが無かった。ここから直接止められるようにする。
  const runTeardown = async (e: PublishedEntry) => {
    const key = `${e.dir}-${e.target}`
    setConfirm(null); setBusyKey(key); setResult(null)
    try {
      let r: { ok: boolean; message?: string; keptBucketName?: string | null }
      if (e.target === 'sakura-apprun') {
        // AppRun はクラウドのAPIキーを main 側が持っているので projectDir だけで足りる。
        // 記録が無いレジストリは削除できないので「削除しない」を渡す（確認画面と同じ判断）。
        const effectiveDeleteRegistry = !!e.registryName && deleteRegistry
        r = await window.electronAPI.cloud.teardown(e.dir, { confirmed: true, deleteRegistry: effectiveDeleteRegistry })
        if (r.ok) {
          // レジストリを残したなら、結果でも「課金は続く」と念を押す（③公開の破棄と同じ扱い）。
          // 保存場所は破棄しても残ることがある（3段構え）。残ったなら課金も続く
          const warn = remainingCostWarning({ deleteRegistry: effectiveDeleteRegistry, registryName: e.registryName, keptBucketName: r.keptBucketName ?? null })
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
        r = await window.electronAPI.hanamii.teardown(e.hanamiiProjectId, token)
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
            この画面はAPIキーもネットワークも使わないので、サービスに障害が出ているときでも開けます。
            <div className="mt-1 text-ink-muted">対象: {workspace || '（ワークスペース取得中）'}</div>
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
                別のパソコンで作ったものや、手で作ったものが残っていると、気づかないまま費用がかかり続けます。
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
                    ⚠️ {inventory.partial.join('・')} は確認できませんでした。**この一覧に出ていない**ものがあるかもしれません。
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
                            ? <>プロジェクト『{r.project}』／{r.monthlyYen > 0 ? `月額${r.monthlyYen}円` : '従量（待機中はほぼゼロ）'}</>
                            : <span className="text-brand-yellow">
                                このパソコンの Koto には心当たりがありません（{r.monthlyYen > 0 ? `月額${r.monthlyYen}円` : '従量'}）。
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

          {groups === null && <div className="text-xs text-ink-muted">読み込んでいます…</div>}

          {error && (
            <div className="rounded-xl border border-line bg-surface p-4 text-xs text-ink select-text">
              読み込みに失敗しました: {error}
            </div>
          )}

          {groups !== null && total === 0 && !error && (
            <div className="rounded-xl border border-line bg-surface p-4 text-xs text-ink-secondary leading-relaxed">
              公開の記録がまだありません。③公開から公開すると、ここに記録が残ります。
              <div className="mt-1 text-ink-muted">
                ※ 別のパソコンや各サービスの管理画面から公開したものは、Koto には記録が残らないため表示されません。
              </div>
            </div>
          )}

          {groups?.map(g => (
            <div key={g.target} className="rounded-xl border border-line bg-surface p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-ink">{g.label}<span className="ml-1.5 text-ink-muted font-normal">{g.entries.length}件</span></div>
                {CONSOLE_LINKS[g.target] && (
                  // 外部リンクは <a href>（main の will-navigate が既定ブラウザへ流す。AppRunPanel と同じ作法）
                  <a
                    href={CONSOLE_LINKS[g.target].url}
                    className="text-[11px] text-ink-muted hover:text-sakura underline"
                    title={CONSOLE_LINKS[g.target].url}
                  >{CONSOLE_LINKS[g.target].label}を開く ↗</a>
                )}
              </div>
              {/* この公開先は Koto から止められない、と先に伝える（消す場所も添える）。
                  「できません」だけで終わらせると、課金が続くものを放置させることになる。 */}
              {teardownSupport(g.target) === 'manual' && (
                <p className="text-[11px] text-ink-muted leading-relaxed mb-2">ℹ️ {manualTeardownGuide(g.target)}</p>
              )}
              <div className="space-y-1.5">
                {g.entries.map((e, i) => (
                  <div key={`${e.dir}-${e.target}-${i}`} className="flex items-center gap-2 text-xs border-t border-line pt-1.5 first:border-t-0 first:pt-0">
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
                        onClick={() => { onOpenProject(e.dir); onClose() }}
                        className="text-[11px] border border-line rounded-md px-1.5 py-0.5 text-ink-muted hover:text-ink hover:border-sakura whitespace-nowrap"
                        title={e.dir}
                      >プロジェクトを開く</button>
                      {/* ここから直接止められるようにする（2026-08-09 Ryosuke の要望）。
                          破棄の口が無い公開先には出さず、下の案内に回す。押しても何も起きない
                          ボタンを並べない（判定は shared/teardownSupport.ts に一元化）。 */}
                      {teardownSupport(e.target) === 'supported' && (
                        <button
                          onClick={() => { void askConfirm(e) }}
                          disabled={busyKey !== null}
                          className="text-[11px] border border-brand-red/60 rounded-md px-1.5 py-0.5 text-brand-red hover:bg-brand-red/10 disabled:opacity-40 whitespace-nowrap"
                          title="公開を止めて、作られたものを削除します"
                        >{busyKey === `${e.dir}-${e.target}` ? '破棄中…' : '🗑 破棄'}</button>
                      )}
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
                            className="text-[11px] border border-brand-red/60 rounded-md px-1.5 py-0.5 text-brand-red hover:bg-brand-red/10 whitespace-nowrap"
                            title="この一覧から消すだけです。公開したもの自体は消えません"
                          >記録だけ消す（実体は残ります）</button>
                          <button
                            onClick={() => setForgetting(null)}
                            className="text-[11px] text-ink-muted hover:text-ink whitespace-nowrap"
                          >やめる</button>
                        </>
                      ) : (
                        <button
                          onClick={() => setForgetting(`${e.dir}-${e.target}`)}
                          className="text-[11px] border border-line rounded-md px-1.5 py-0.5 text-ink-muted hover:text-ink hover:border-sakura whitespace-nowrap"
                          title="記録だけを消します。公開したもの自体は消えません（先に「破棄」してください）"
                        >記録を片づける</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-line flex-none flex justify-end">
          <button onClick={onClose} className="text-xs border border-line rounded-lg px-3 py-1.5 text-ink-secondary hover:text-ink hover:border-sakura">閉じる</button>
        </div>

        {/* 破棄の確認（破壊操作は必ず1枚挟む・掟5）。③公開の破棄画面と同じことを伝える。 */}
        {confirm && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 rounded-2xl" onClick={() => setConfirm(null)}>
            <div className="bg-base border border-brand-red/70 rounded-xl shadow-xl w-[26rem] max-w-[88vw] p-4 space-y-2" onClick={ev => ev.stopPropagation()}>
              <p className="text-sm font-semibold text-ink">⚠️ 公開を破棄します</p>
              <p className="text-xs text-ink-secondary leading-relaxed">
                <b className="text-ink">{confirm.projectName}</b>（{confirm.label}）<br />
                {teardownScopeNote(confirm.target)}この操作は元に戻せません。
              </p>
              {confirmPlacement && (
                <p className="text-xs text-brand-red leading-relaxed select-text">
                  💾 {teardownDataNote(confirmPlacement)}
                </p>
              )}
              <p className="text-xs text-brand-red leading-relaxed">
                🔗 {urlChangesOnTeardownNotice()}
              </p>

              {/* AppRun はコンテナレジストリの月額課金が絡むので、③公開の破棄画面と同じ情報を出す。
                  **名前を見せることが安全装置**（v0.2.94: 心当たりのない名前ならやめられる）なので、
                  置き場所が変わっても同じ判断ができるようにする。記録が無ければ削除できない。 */}
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
                  className="px-3 py-1.5 rounded-md text-[12px] font-semibold text-white bg-brand-red hover:opacity-90"
                >🗑 理解した上で破棄する</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
