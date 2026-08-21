import { useState, useEffect, useCallback } from 'react'
import SecurityCheckSection from './SecurityCheckSection'
import { getVercelToken, getVercelTokenById, getVercelTeamId, getVercelTeamIdById, listVercelTokenEntries } from './CredentialsModal'
import { getTargetProfile } from '../targetProfiles'
import { beginActivity } from '../activity'
import { markPublishPending, clearPublishPending } from '../publishPending'
import CopyButton from './CopyButton'
import { askAiAboutCheck } from '../../shared/preflight'

// Vercel（海外PaaS）への公開パネル。HanamiiPanel と同じ流儀を踏襲する:
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
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<{ url: string | null; readyState: string | null } | null>(null)
  const [msg, setMsg] = useState('')
  const [msgDetail, setMsgDetail] = useState('')
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
    const m = await readMeta()
    const next = {
      ...m,
      target: 'vercel',
      publish: {
        ...(m.publish ?? {}),
        vercel: { ...(m.publish?.vercel ?? {}), ...v },
        ...(publishRecord ? { targets: { ...(m.publish?.targets ?? {}), vercel: publishRecord } } : {}),
      },
    }
    await window.electronAPI.fs.writeFile(metaPath, JSON.stringify(next, null, 2))
    window.dispatchEvent(new Event('sakura-meta-changed'))
  }, [metaPath, readMeta])

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

  const runPreflight = useCallback(async () => {
    setChecking(true); setConfirmBroken(false)
    try { setPreflight(await window.electronAPI.vercel.preflight(projectDir)) }
    catch (e: any) { setPreflight({ ok: false, canPublish: true, summary: '確認できませんでした', checks: [], message: e?.message ?? String(e) }) }
    finally { setChecking(false) }
  }, [projectDir])

  // **押さなくても出す。** Vercel の失敗は静かなので、開いた時点で知らせる
  // （何も作らず何も送らない、手元のファイルを読むだけの確認）。
  useEffect(() => { void runPreflight() }, [runPreflight])

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
    setPublishing(true); setResult(null); setProgress('公開を開始しています…')
    // 進捗を購読（アップロード n/N・ビルド中…）。finally で必ず購読解除＆publishing解除する
    // ＝どんな失敗経路でもボタンが「公開中…」で固まらないようにする。
    const unsubscribe = window.electronAPI.vercel.onProgress((m) => setProgress(m))
    // 実行中フラグ（終了確認ダイアログ用）。中断・失敗でも必ず解除されるよう最外の finally で呼ぶ。
    const endActivity = beginActivity('公開処理')
    try {
      // 公開開始マーカー（途中で中断・失敗しても後から検知できるようにする）。
      // API呼び出しが成功/失敗いずれで終わっても finally で必ず消す。
      await markPublishPending(projectDir, 'vercel')
      try {
        const r = await window.electronAPI.vercel.publish(projectDir, { token, teamId: teamId ?? undefined, name })
        if (!r.ok) { setMsg(r.message ?? '公開に失敗しました'); setMsgDetail(r.detail ?? ''); return }
        setResult({ url: r.url ?? null, readyState: r.readyState ?? null })
        await saveVercelMeta(
          { tokenId, name },
          { publishedAt: new Date().toISOString(), url: r.url ?? null },
        )
      } finally {
        await clearPublishPending(projectDir)
      }
    } catch (e: any) {
      setMsg(`公開処理でエラーが発生しました: ${e?.message ?? String(e)}`)
    } finally {
      unsubscribe()
      setPublishing(false)
      setProgress('')
      endActivity()
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-surface p-4 space-y-1">
        <p className="text-sm font-semibold text-ink">▲ Vercel（海外PaaS）で公開</p>
        <p className="text-xs text-ink-secondary leading-relaxed">
          静的サイト／フロントエンド向けの海外PaaS。IDEがプロジェクトのファイルをアップロードし、Vercel側でビルド・公開します。
        </p>
        {getTargetProfile('vercel').serviceUrl && (
          <p className="text-[11px] text-ink-muted">
            <a href={getTargetProfile('vercel').serviceUrl} className="hover:underline">🌐 公式サイトを見る ↗</a>
          </p>
        )}
      </div>

      {/* ① 認証情報（トークンは「認証情報」で一元管理） */}
      <section className="rounded-xl border border-line bg-surface p-4 space-y-2">
        <p className="text-sm font-semibold text-ink">① トークン</p>
        {!tokenLoaded ? (
          <p className="text-xs text-ink-muted">確認中…</p>
        ) : token ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-brand-green font-semibold">✓ 認証情報に Vercel トークンが登録済み</span>
              <button onClick={onOpenCredentials} className="text-xs text-ink-muted hover:text-ink">認証情報を開く</button>
            </div>
            {tokens && tokens.length > 1 && (
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
            {teamId && (
              <p className="text-[11px] text-ink-muted">チームID: <span className="font-mono">{teamId}</span></p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-ink-secondary leading-relaxed">
              Vercel のトークンを「認証情報」で登録してください（他のキーと同じ場所で一元管理します）。
            </p>
            <button
              onClick={onOpenCredentials}
              className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90"
            >🔑 認証情報を開いて登録</button>
          </div>
        )}
      </section>

      {/* 🔰 初めて公開する方へ */}
      {token && <VercelFirstTimeGuide />}

      {/* 🛡 セキュリティチェック（公開の前に・2026-08-21 Ryosuke 指定） */}
      <SecurityCheckSection projectDir={projectDir} apiKey={apiKey} />

      {/* ② 公開 */}
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
          <p className="text-sm font-semibold text-ink">② 公開</p>
          <div>
            <label className="text-[11px] font-medium text-ink-secondary">公開名（半角英数字とハイフン・任意）</label>
            <input
              value={publishName}
              onChange={e => setPublishName(e.target.value)}
              placeholder={safeName(projName)}
              disabled={publishing}
              className="mt-1 w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink placeholder-ink-muted outline-none focus:border-sakura disabled:opacity-50"
            />
            <p className="mt-1 text-[11px] text-ink-muted leading-relaxed">
              同じ名前で公開し直すと、Vercel側で同じプロジェクトの本番デプロイとして更新されます。
            </p>
          </div>
          <button
            onClick={publish}
            disabled={publishing}
            className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold hover:opacity-90 disabled:opacity-40 ${
              preflight && preflight.canPublish === false
                ? 'bg-overlay text-brand-red border border-brand-red/60'
                : 'sakura-gradient text-white'
            }`}
          >{publishing
            ? (progress || '公開中…（アップロード→ビルド。数十秒〜数分かかることがあります）')
            : confirmBroken ? '⚠️ それでも公開する' : '🚀 公開する'}</button>

          {result && (
            <div className="rounded-lg border border-line bg-overlay p-3 space-y-1">
              <p className="text-xs text-ink-secondary">
                状態: {result.readyState === 'READY' ? '✅ 公開済み' : result.readyState ?? '—'}
              </p>
              {result.url && (
                <div className="flex items-center gap-2 flex-wrap">
                  <a href={result.url} className="inline-block text-sm text-sakura hover:underline break-all font-semibold">🌐 {result.url}</a>
                  <CopyButton text={result.url} title="公開URLをコピー" />
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {msg && <ErrorMessageBlock msg={msg} detail={msgDetail} />}
    </div>
  )
}

// 失敗メッセージの表示ブロック（掟5: select-text＋コピーボタン）。
// HanamiiPanel/AppRunPanel の同種ブロックと同じパターン（各パネルにローカル定義する流儀）。
function ErrorMessageBlock({ msg, detail }: { msg: string; detail: string }) {
  const copyText = detail ? `${msg}\n${detail}` : msg
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
    </div>
  )
}

// 🔰 初めて公開する方へ（折りたたみ）。トークン発行手順・国外データ・常駐サーバ不可の注意。
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
            </a> でトークンを発行する（Vercelへのログインが必要です）
          </li>
          <li>発行したトークンを「認証情報」で登録する</li>
          <li>チームアカウントで使う場合は、チームIDも合わせて登録する（個人アカウントなら空欄でよい）</li>
        </ol>
        <div className="bg-elevated border border-line rounded-lg px-2.5 py-2 space-y-1">
          <p>⚠️ <b className="text-ink-secondary">データは国外（Vercelの海外サーバ）に置かれます。</b>国内保管が必要な場合は HANAMII やさくらのAppRun を選んでください。</p>
          <p>⚠️ <b className="text-ink-secondary">常駐サーバは動きません。</b>Vercelは静的サイト・サーバーレス関数向けです（Node.jsのlisten等は不可）。</p>
        </div>
      </div>
    </details>
  )
}
