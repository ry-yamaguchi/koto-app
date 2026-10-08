import { useState, useEffect, useCallback } from 'react'
import SecurityCheckSection from './SecurityCheckSection'
import UnusedFilesSection from './UnusedFilesSection'
import { getVercelToken, getVercelTokenById, getVercelTeamId, getVercelTeamIdById, listVercelTokenEntries } from './CredentialsModal'
import { getTargetProfile } from '../targetProfiles'
import { beginActivity, PUBLISH_CLOSE_WARNING } from '../activity'
import CopyButton from './CopyButton'
import { askAiAboutCheck } from '../../shared/preflight'
import { askAiAboutFailure, askAiAboutNotice } from '../../shared/askAi'
import { publishButtonLabel } from '../../shared/publishLabels'
import { readPublishTargets } from '../publishRecord'
import { mergeProjectMeta } from '../projectMeta'
import AccessKeySection from './AccessKeySection'
import { OpProgressCard, OpForeignNote, OpWarnings } from './HanamiiPanel'
import { useProjectOpsView } from '../hooks/useProjectOpsView'
import { isVercelOp } from '../projectOpsView'
import { clockText, opWarningText } from '../../shared/opsText'

// Vercel（海外のクラウドサービス）への公開パネル。HanamiiPanel と同じ流儀を踏襲する:
// トークン（＋チームID）は「認証情報」に一元登録し（方式B）、このパネルは使う瞬間に読んで
// main へ引数で渡す（main には保存しない）。
// 流れ: 認証情報でトークン登録 → 公開名入力 → 公開（IDEがファイルをアップロード→デプロイ作成→
// READYまでポーリングをmain側で一括して行う）→ 公開URL表示 → publish.targets へ記録。
// HANAMIIと異なり、公開ごとに新しい状態（プロジェクトID等）を持ち回す必要が無い
// （同じ公開名なら Vercel 側が同一プロジェクトの本番デプロイとして扱う）。

// Vercel の name 制約（英小文字・数字・ハイフンのみ・最大100字程度）。
// main/vercel/client.ts の sanitizeProjectName と同じ内容（renderer は main の Node専用コードを
// import しない流儀のため複製）。
const VERCEL_NAME_MAX_LEN = 100
function safeName(s: string): string {
  let v = (s ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  if (v.length > VERCEL_NAME_MAX_LEN) v = v.slice(0, VERCEL_NAME_MAX_LEN).replace(/-+$/g, '')
  return v || 'app'
}

interface Props {
  projectDir: string
  /** さくらのAI Engine のAPIキー（🛡 セキュリティチェックに使用）。 */
  apiKey: string
  onOpenCredentials: () => void
}

export default function VercelPanel({ apiKey, projectDir, onOpenCredentials }: Props) {
  const projName = projectDir.split('/').pop() ?? 'app'
  const metaPath = `${projectDir}/.sakuraide.json`

  const [token, setToken] = useState<string | null>(null)
  const [teamId, setTeamId] = useState<string | null>(null)
  const [tokenLoaded, setTokenLoaded] = useState(false)
  const [tokens, setTokens] = useState<Array<{ id: string; label: string }> | null>(null)
  const [tokenId, setTokenId] = useState('')
  const [publishName, setPublishName] = useState('')
  const [publishing, setPublishing] = useState(false)
  // 局所のメッセージ（トークン無し・確認の案内・記録が作られない断り方）。公開の結果・お知らせは main の記録から出す（下の ops）。
  const [msg, setMsg] = useState('')
  const [msgDetail, setMsgDetail] = useState('')
  // 公開ボタンの文言（判断8・publishButtonLabel）に使う「既に公開済みか」。
  // Vercel には isPublished 相当のIPCが無いため、公開記録（publish.targets）の
  // 一元判定（readPublishTargets・publishRecord.ts）を再利用する（掟10: 複製しない）。
  const [published, setPublished] = useState(false)
  // ── 公開する前の確認（2026-08-15）──────────────────────────────────
  // Vercel は**壊れていてもデプロイが成功する**（常駐サーバが起動せず、
  // ソースが丸見えのページが出る）。押す前に確かめ、駄目なものは止める。
  const [preflight, setPreflight] = useState<Awaited<ReturnType<Window['electronAPI']['vercel']['preflight']>> | null>(null)
  const [checking, setChecking] = useState(false)
  /** 駄目と分かっていて、それでも公開すると決めたか（**一度では公開しない**）。 */
  const [confirmBroken, setConfirmBroken] = useState(false)

  const readMeta = useCallback(async (): Promise<any> => {
    try { return JSON.parse(await window.electronAPI.fs.readFile(metaPath)) } catch { return {} }
  }, [metaPath])

  const saveVercelMeta = useCallback(async (v: { tokenId?: string; name?: string }, publishRecord?: { publishedAt: string | null; url: string | null }) => {
    // 差分だけを main へ渡す（書く直前にディスクから読み直して当てる・src/renderer/projectMeta.ts）。
    await mergeProjectMeta(projectDir, {
      target: 'vercel',
      publish: {
        vercel: v,
        ...(publishRecord ? { targets: { vercel: publishRecord } } : {}),
      },
    })
    window.dispatchEvent(new Event('sakura-meta-changed'))
  }, [projectDir])

  // トークン一覧を読み込み、選択中の tokenId を決める（優先順位: メタの保存値 → ストアの使用中 → 先頭）
  const loadTokenList = useCallback(async (preferredId?: string | null) => {
    const { tokens: list, activeId } = await listVercelTokenEntries()
    setTokens(list)
    if (list.length === 0) return null
    const chosen = (preferredId && list.some(t => t.id === preferredId))
      ? preferredId
      : (activeId && list.some(t => t.id === activeId))
        ? activeId
        : list[0].id
    setTokenId(chosen)
    return chosen
  }, [])

  // トークン切り替え（セレクタ操作・認証情報変更イベント共通）
  const switchToken = useCallback(async (id: string) => {
    setTokenId(id)
    const [tk, tid] = await Promise.all([getVercelTokenById(id), getVercelTeamIdById(id)])
    setToken(tk)
    setTeamId(tid)
  }, [])

  const refreshToken = useCallback(async () => {
    const chosen = await loadTokenList(tokenId)
    setTokenLoaded(true)
    if (chosen) {
      const [tk, tid] = await Promise.all([getVercelTokenById(chosen), getVercelTeamIdById(chosen)])
      setToken(tk); setTeamId(tid)
    } else {
      setToken(null); setTeamId(null)
    }
  }, [loadTokenList, tokenId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const m = await readMeta()
      const v = m.publish?.vercel
      if (typeof v?.name === 'string' && v.name) setPublishName(v.name)

      const chosen = await loadTokenList(v?.tokenId ?? null)
      if (cancelled) return
      if (chosen) {
        const [tk, tid] = await Promise.all([getVercelTokenById(chosen), getVercelTeamIdById(chosen)])
        if (cancelled) return
        setToken(tk); setTeamId(tid)
      } else {
        const [tk, tid] = await Promise.all([getVercelToken(), getVercelTeamId()])
        if (cancelled) return
        setToken(tk); setTeamId(tid)
      }
      setTokenLoaded(true)
    })()
    const onCredChange = () => { refreshToken() }
    window.addEventListener('sakura:credentials-changed', onCredChange)
    return () => { cancelled = true; window.removeEventListener('sakura:credentials-changed', onCredChange) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir])

  useEffect(() => {
    let cancelled = false
    readPublishTargets(projectDir).then(targets => { if (!cancelled) setPublished(targets.includes('vercel')) }).catch(() => {})
    return () => { cancelled = true }
  }, [projectDir])

  const runPreflight = useCallback(async () => {
    setChecking(true); setConfirmBroken(false)
    try { setPreflight(await window.electronAPI.vercel.preflight(projectDir)) }
    catch (e: any) { setPreflight({ ok: false, canPublish: true, summary: '確認できませんでした', checks: [], message: e?.message ?? String(e) }) }
    finally { setChecking(false) }
  }, [projectDir])

  // **押さなくても出す。** Vercel の失敗は静かなので、開いた時点で知らせる
  // （何も作らず何も送らない、手元のファイルを読むだけの確認）。
  //
  // ── 保存場所を用意した直後に取り直す（2026-09-24 検分）──────────────────
  // この確認は「保存場所をまだ用意していないため、いまのままではデータは残りません。
  // 上の『保存場所を用意する』から用意してください。」と、**同じ画面のボタンを名指し**する。
  // ところが言われたとおり用意しても（月額が始まっても）、ここは開いた時点の判断を
  // 出し続けていた。**払ったのに直っていない**ように見えるうえ、その行の「AIに相談する」は
  // 「保存場所をまだ用意していない」という嘘を AI へ送り、直っているものを直させにいく。
  // 隣の2枚（AppRunPanel・AppRunDedicatedPanel）は同じ出来事を受けて取り直している。
  useEffect(() => {
    void runPreflight()
    const onPrepared = () => { void runPreflight() }
    window.addEventListener('sakura:storage-prepared', onPrepared)
    return () => { window.removeEventListener('sakura:storage-prepared', onPrepared) }
  }, [runPreflight])

  // ── 公開の進み具合と結果は、main の記録から出す（2026-09-29）────────────────────────────
  // 公開の本体は main の1回の IPC で最後まで進み、記録も main が書く。ダイアログを閉じても処理は止まらない。
  // 失われていたのは**画面の表示だけ**（進み具合・結果・お知らせ）だった。main が持つ処理の記録
  // （window.electronAPI.projectOps）を読んで、開き直した画面にも続きと結果を出す。
  // 進み具合は従来 `vercel.onProgress` で受けていたが、あれは**開いている間しか届かない**ので、記録に一本化した。
  const ops = useProjectOpsView(projectDir, isVercelOp, (rec) => {
    // 公開できた記録を見たら、ボタンの文言（更新）を合わせる。main が書いた公開記録を、隣の画面にも知らせる。
    if (rec.result?.ok) setPublished(true)
    window.dispatchEvent(new Event('sakura-meta-changed'))
  })
  const publishRunning = publishing || !!ops.ownRunning
  // 同じプロジェクトでは1つずつしか走らせない（main の鍵）。別の公開先の操作が走っている間も押せない。
  const locked = publishRunning || !!ops.running

  const publish = async () => {
    setMsg(''); setMsgDetail('')
    if (!token) { setMsg('先に「認証情報」で Vercel トークンを登録してください'); return }
    // **壊れると分かっているものを、黙って公開しない。**
    // ただし判断が外れることもあるので、二度目の操作で通す（止めきらない）。
    if (preflight && preflight.canPublish === false && !confirmBroken) {
      setConfirmBroken(true)
      setMsg('このまま公開すると、正しく動かない可能性が高いです。上の確認をご覧ください。もう一度「公開する」を押すと、そのまま公開します。')
      return
    }
    const name = safeName(publishName.trim() || projName)
    // この公開を頼んだ時刻。main の記録の startedAt と同じ時計（同じパソコン）なので、
    // 「この公開の記録が残ったか」を、返り値のあとで確かめるのに使う。
    const askedAt = Date.now()
    setPublishing(true); ops.clearShown()
    // 実行中フラグ（終了確認ダイアログ用）。中断・失敗でも必ず解除されるよう最外の finally で呼ぶ。
    const endActivity = beginActivity('公開処理', { closeWarning: PUBLISH_CLOSE_WARNING })
    try {
      const r = await window.electronAPI.vercel.publish(projectDir, { token, teamId: teamId ?? undefined, name })
      // 結果（成功・失敗・お知らせ）は main の記録から出す。返り値をここで並べ直さない:
      // 同じ結果が、閉じて開き直した画面にも同じ形で出るようにするため（二重に見えることも無いように）。
      // ただし**記録が作られない断り方**がある（同じプロジェクトで別の操作が走っている・トークン無し）。
      // 返り値のあとで記録を読み直し、この公開の記録が無いときだけ、返り値の文を出す。
      if (!r.ok) {
        await ops.sync()
        if (!ops.didFinishSince('vercel:publish', askedAt)) { setMsg(r.message ?? '公開に失敗しました'); setMsgDetail(r.detail ?? '') }
        return
      }
      setPublished(true)
      // 統一公開記録（publish.targets）と公開開始マーカーの後片づけは main 側（vercel:publish）が
      // 済ませている（roadmap #20・main は1 invoke で完走するため、窓を閉じても記録が残る）。
      // ここでは設定値（tokenId/name）だけを保存する。saveVercelMeta の readMeta→write が
      // main の書いた記録を読み直して保持し、sakura-meta-changed で画面へ反映する。
      try {
        await saveVercelMeta({ tokenId, name })
      } catch (e: any) {
        // 設定の保存に失敗しても、公開の結果は記録が伝える。ここで黙ると、設定が消えている理由が分からない。
        setMsg(`公開は終わりましたが、設定（トークンの選択・公開名）を保存できませんでした: ${e?.message ?? String(e)}`)
      }
      await ops.sync()
    } catch (e: any) {
      // main の本体が例外で終わったときも記録は残る（予期しない失敗として）。残っていなければ、ここで伝える。
      await ops.sync()
      if (!ops.didFinishSince('vercel:publish', askedAt)) setMsg(`公開処理でエラーが発生しました: ${e?.message ?? String(e)}`)
    } finally {
      setPublishing(false)
      endActivity()
    }
  }

  // 進み具合・別の操作の知らせ・結果（**公開のボタンのすぐ下**に出す。トークンが無い間も結果は見失わない）。
  const opsBlock = (
    <>
      {ops.ownRunning && <OpProgressCard rec={ops.ownRunning} />}
      {ops.foreignRunning && <OpForeignNote rec={ops.foreignRunning} />}
      {ops.shown.map(rec => <VercelOpResult key={rec.startedAt} rec={rec} />)}
    </>
  )

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-surface p-4 space-y-1">
        <p className="text-sm font-semibold text-ink">▲ Vercel（海外のクラウドサービス）で公開</p>
        <p className="text-xs text-ink-secondary leading-relaxed">
          ページを見せるだけのサイト向けで、サーバーで動き続けるアプリは扱えません。Koto がプロジェクトのファイルをアップロードし、Vercel 側でビルド・公開します。
        </p>
        {getTargetProfile('vercel').serviceUrl && (
          <p className="text-[11px] text-ink-muted">
            <a href={getTargetProfile('vercel').serviceUrl} className="hover:underline">🌐 公式サイトを見る ↗</a>
          </p>
        )}
      </div>

      {/* ① トークン（AccessKeySection に統一・判断8） */}
      <AccessKeySection
        stepNo="①"
        serviceTitle="Vercel"
        keyLabel="トークン"
        registered={!!token}
        onOpenCredentials={onOpenCredentials}
      >
        {!tokenLoaded && <p className="text-xs text-ink-muted">確認中…</p>}
        {tokenLoaded && !token && (
          <p className="text-xs text-ink-secondary leading-relaxed">
            Vercel のトークンを登録してください（他のキーと同じ場所で一元管理します）。
          </p>
        )}
        {tokenLoaded && token && tokens && tokens.length > 1 && (
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-ink-secondary flex-none">使うトークン</label>
            <select
              value={tokenId}
              onChange={e => switchToken(e.target.value)}
              className="flex-1 bg-surface border border-line rounded-lg px-2 py-1.5 text-xs text-ink outline-none focus:border-sakura"
            >
              {tokens.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
        )}
        {tokenLoaded && token && teamId && (
          <p className="text-[11px] text-ink-muted">チームID: <span className="font-mono">{teamId}</span></p>
        )}
      </AccessKeySection>

      {/* 🔰 初めて公開する方へ */}
      {token && <VercelFirstTimeGuide />}

      {/* ② セキュリティチェック（公開の前に・2026-08-21 Ryosuke 指定。番号は2026-09-04 付番） */}
      <SecurityCheckSection projectDir={projectDir} apiKey={apiKey} stepNo="②" />

      {/* ③ 未使用ファイルの検出＋片づけ（roadmap #18。番号は2026-09-04 付番） */}
      <UnusedFilesSection projectDir={projectDir} stepNo="③" />

      {/* ④ 公開 */}
        {/* 公開できるかの確認。**駄目なものには「どうすればよいか」まで書く**
            （AppRun の cloud:preflight と同じ流儀・2026-08-15） */}
        {preflight && (
          <div className={`rounded-lg border p-3 space-y-2 ${preflight.canPublish ? 'border-line' : 'border-brand-red/60'}`}>
            <div className="flex items-start justify-between gap-2">
              <p className={`text-xs font-semibold ${preflight.canPublish ? 'text-ink' : 'text-brand-red'}`}>
                {preflight.canPublish ? '✅' : '⚠️'} {preflight.summary ?? '確認しました'}
              </p>
              <button
                onClick={runPreflight}
                disabled={checking}
                title="もう一度確かめます（何も作りません・何も送りません）"
                className="flex-none text-xs text-ink-muted hover:underline disabled:opacity-50"
              >{checking ? '確かめています…' : '↻ 更新'}</button>
            </div>
            <ul className="space-y-1">
              {(preflight.checks ?? []).map(c => (
                <li key={c.id} className="text-[11px] leading-relaxed flex gap-2">
                  <span className="flex-none">{c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️' : '❌'}</span>
                  <span className="text-ink-secondary select-text">
                    <span className="text-ink font-medium">{c.label}</span>　{c.note}
                    {c.fix === 'ask-ai' && (
                      <button
                        onClick={() => {
                          window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text: askAiAboutCheck(c) } }))
                        }}
                        className="ml-2 align-middle bg-sakura text-white rounded px-2 py-0.5 text-[11px] font-semibold hover:opacity-90"
                      >AIに相談する</button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {preflight.message && (
              <p className="text-[11px] text-brand-red leading-relaxed select-text">{preflight.message}</p>
            )}
            <p className="text-[11px] text-ink-muted leading-relaxed">
              手元のファイルを読んで確かめているだけです（何も作らず、何も送っていません）。
            </p>
          </div>
        )}

      {token && (
        <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
          <p className="text-sm font-semibold text-ink">④ 公開</p>
          <div>
            <label className="text-[11px] font-medium text-ink-secondary">公開名（半角英数字とハイフン・任意）</label>
            <input
              value={publishName}
              onChange={e => setPublishName(e.target.value)}
              placeholder={safeName(projName)}
              disabled={publishRunning}
              className="mt-1 w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink placeholder-ink-muted outline-none focus:border-sakura disabled:opacity-50"
            />
            <p className="mt-1 text-[11px] text-ink-muted leading-relaxed">
              同じ名前で公開し直すと、Vercel 側で同じプロジェクトの本番の公開として更新されます（Vercel ではこれを「本番デプロイ」と呼びます）。
            </p>
          </div>
          <button
            onClick={publish}
            disabled={locked}
            className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold hover:opacity-90 disabled:opacity-40 ${
              preflight && preflight.canPublish === false
                ? 'bg-overlay text-brand-red border border-brand-red/60'
                : 'sakura-gradient text-white'
            }`}
          >{publishRunning
            ? '公開中…（アップロード→ビルド。数十秒〜数分かかることがあります）'
            : confirmBroken ? '⚠️ それでも公開する' : publishButtonLabel(published)}</button>

          {opsBlock}
        </section>
      )}

      {/* トークンを消した・まだ読めていない間も、進み具合と結果は見失わない（公開の節ごと隠れるため、ここに出す）。 */}
      {!token && (ops.ownRunning || ops.foreignRunning || ops.shown.length > 0) && <div className="space-y-3">{opsBlock}</div>}

      {msg && <ErrorMessageBlock msg={msg} detail={msgDetail} />}
    </div>
  )
}

/**
 * 終わった Vercel の公開1件を、結果と（成功していれば）お知らせとして出す。
 *
 * ── 成功のお知らせを、失敗の枠に入れない（2026-09-24 検分の指摘3）──────────────────────────
 * 初回公開の案内（「もう一度『公開する』を押してください」など）は、**公開が成功したうえでの**次にすべきこと。
 * 失敗専用の枠（ErrorMessageBlock）に出すと、🤖ボタンが AI へ「公開で次の失敗が出ました」と送り、
 * 起きていない失敗の原因探しが始まって、動いているものを直そうとする。
 * だから成功の記録の知らせは **URL の近く・結果の枠の中**に PublishNoticeBlock（成功前提の文面）で出し、
 * 失敗の記録だけを ErrorMessageBlock で出す。記録の warnings（main が返り値の notice を集めたもの）が、
 * 閉じて開き直した画面でも見逃されない。
 */
function VercelOpResult({ rec }: { rec: ProjectOpRecordShape }) {
  const res = rec.result
  const head = `🚀 公開の結果（${clockText(rec.startedAt)} に始まった操作）`
  if (!res) {
    return (
      <div className="space-y-2">
        <p className="text-[11px] text-ink-muted">{head}</p>
        <p className="text-xs text-ink-secondary leading-relaxed">結果を読み取れませんでした。Vercel の管理画面で状態を確かめてください。</p>
      </div>
    )
  }
  if (!res.ok) {
    return (
      <div className="space-y-2">
        <p className="text-[11px] text-ink-muted">{head}</p>
        <ErrorMessageBlock msg={res.message ?? '公開に失敗しました'} detail={res.detail ?? ''} />
        <OpWarnings warnings={res.warnings ?? []} />
      </div>
    )
  }
  const readyState = typeof res.extra?.readyState === 'string' ? res.extra.readyState : null
  const lines = res.lines ?? []
  return (
    <div className="rounded-lg border border-line bg-overlay p-3 space-y-1">
      <p className="text-[11px] text-ink-muted">{head}</p>
      <p className="text-xs text-ink-secondary">
        状態: {readyState === 'READY' ? '✅ 公開済み' : readyState ?? '—'}
      </p>
      {res.url && (
        <div className="flex items-center gap-2 flex-wrap">
          <a href={res.url} className="inline-block text-sm text-sakura hover:underline break-all font-semibold">🌐 {res.url}</a>
          <CopyButton text={res.url} title="公開URLをコピー" />
        </div>
      )}
      {lines.length > 0 && (
        <ul className="space-y-0.5">
          {lines.map((l, i) => <li key={i} className="text-[11px] text-ink-muted leading-relaxed whitespace-pre-wrap break-all select-text">{l}</li>)}
        </ul>
      )}
      {(res.warnings ?? []).map((n, i) => <PublishNoticeBlock key={i} notice={opWarningText(n)} />)}
    </div>
  )
}

/**
 * 公開の**お知らせ**ブロック（2026-09-24 検分の指摘3）。**これは失敗ではない。**
 *
 * 初回公開でデータの保存の設定を置き直したときなど、「公開はできたが次にすべきことがある」を出す。
 * 以前はこれを `msg` に入れて `ErrorMessageBlock`（失敗専用）で出していたため、URL の下に失敗の枠が
 * 並び、🤖ボタンが AI へ「公開で次の失敗が出ました」と送っていた（起きていない失敗の原因探しが始まる）。
 * 文面は `askAiAboutNotice`（成功前提・「動いているものを直そうとしないでください」付き）を使う。
 */
function PublishNoticeBlock({ notice }: { notice: string }) {
  return (
    <div className="rounded-lg border border-brand-yellow/70 bg-elevated p-2.5 space-y-2">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-xs text-ink-secondary leading-relaxed whitespace-pre-wrap break-all select-text">ℹ️ {notice}</p>
        <CopyButton text={notice} title="お知らせをコピー" />
      </div>
      <button
        onClick={() => {
          window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text: askAiAboutNotice('Vercel', notice) } }))
        }}
        className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
      >🤖 次にすべきことをAIに聞く</button>
    </div>
  )
}

// 失敗メッセージの表示ブロック（掟5: select-text＋コピーボタン）。
// HanamiiPanel/AppRunPanel の同種ブロックと同じパターン（各パネルにローカル定義する流儀）。
function ErrorMessageBlock({ msg, detail }: { msg: string; detail: string }) {
  const copyText = detail ? `${msg}\n${detail}` : msg
  // Vercel には破棄（teardown）が無く、この表示は常に公開の失敗（判断2）。
  const askAiText = askAiAboutFailure('公開', 'Vercel', msg, detail)
  return (
    <div className="rounded-lg border border-line bg-overlay p-3 space-y-2">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-xs text-ink-secondary leading-relaxed whitespace-pre-wrap break-all select-text">{msg}</p>
        <button
          onClick={() => { navigator.clipboard.writeText(copyText).catch(() => {}) }}
          className="flex-none text-[11px] text-sakura hover:underline"
          title="メッセージをコピー"
        >コピー</button>
      </div>
      {detail && (
        <details>
          <summary className="text-[11px] text-ink-muted cursor-pointer select-none hover:text-ink">詳細を見る</summary>
          <pre className="mt-1 text-[11px] text-ink-muted font-mono leading-relaxed whitespace-pre-wrap break-all select-text">{detail}</pre>
        </details>
      )}
      <button
        onClick={() => {
          window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text: askAiText } }))
        }}
        className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
      >🤖 AIに相談する</button>
    </div>
  )
}

// 🔰 初めて公開する方へ（折りたたみ）。トークン発行手順・アプリが動く場所・常駐サーバ不可の注意。
function VercelFirstTimeGuide() {
  return (
    <details className="rounded-xl border border-brand-yellow/70 bg-surface p-3">
      <summary className="text-sm font-semibold text-ink cursor-pointer list-none flex items-center gap-1">
        🔰 初めて公開する方へ
      </summary>
      <div className="text-xs text-ink-secondary leading-relaxed mt-2 space-y-2">
        <ol className="list-decimal pl-4 space-y-1.5">
          <li>
            <a href="https://vercel.com/account/tokens" className="text-sakura hover:underline">
              vercel.com/account/tokens
            </a> でトークンを発行する（Vercelへのログインが必要です）。
            <b>範囲（Scope）</b>は3つから選べます——
            <b>Full Account</b>（個人＋全チーム）／<b>チーム</b>（そのチームの全プロジェクト）／
            <b>プロジェクト</b>（1つだけ）。
            <b>Koto では「Full Account」か「チーム」を選んでください。</b>
            Koto のプロジェクト1つにつき Vercel のプロジェクトが1つ作られるため、
            <b>1プロジェクトに絞ると、そのプロジェクトしか公開できなくなります</b>
            （2つ目を公開しようとした時点で拒否されます）。
            <b>トークンは作成時に一度しか表示されません。</b>その場でコピーしてください。
          </li>
          <li>
            <b>範囲を絞ったトークン（チーム／プロジェクト）を使うときは、チームIDを空欄のままにしてください。</b>
            Vercel がトークンから範囲を判断するため、チームIDを付けると拒否されます。
          </li>
          <li>発行したトークンを「認証情報」で登録する</li>
          <li>チームアカウントで使う場合は、チームIDも合わせて登録する（個人アカウントなら空欄でよい）</li>
        </ol>
        <div className="bg-elevated border border-line rounded-lg px-2.5 py-2 space-y-1">
          {/*
            **「データは国外」は 2026-09-24 から誤り**（検分の指摘2）。この日から Koto は
            さくらのオブジェクトストレージ（日本国内）の設定を Vercel へ渡すので、
            データ自体は国内に置かれる。国外なのは**アプリが動く場所**だけ。
            同じ画面の公開前チェックは「データが置かれるのは日本国内です」と出るため、
            直さないと利用者は正反対の2文を同時に読むことになり、条件を満たしている Vercel を
            この一文だけを理由に諦める。targetProfiles.ts の説明文と揃える。
          */}
          <p>⚠️ <b className="text-ink-secondary">アプリが動くのは国外（Vercelの海外サーバ）です。</b>データの保存を使う場合、データ自体はさくらのオブジェクトストレージ（日本国内）に置かれます。アプリの実行そのものを国内にしたい場合は HANAMII やさくらのAppRun を選んでください。</p>
          <p>⚠️ <b className="text-ink-secondary">常駐サーバは動きません。</b>Vercelは静的サイト・サーバーレス関数向けです（Node.jsのlisten等は不可）。</p>
        </div>
      </div>
    </details>
  )
}
