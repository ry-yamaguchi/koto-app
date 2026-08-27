// ImportFromPublishedPanel.tsx — 「公開先からインポート」（dev-plan ④ 第3段階）。
//
// ── なぜ新規プロジェクトの中に置くのか（2026-08-22 Ryosuke 指定）──────────
// 公開の画面に置くと、**空のプロジェクトを作ってから探す**ことになり、
// そんな機能があること自体に気づけない。手元にファイルが無い人が最初に開くのは
// 「新規プロジェクト」なので、入口はそこに置く。
//
// 判断（記録の中身・見せる文言・置き場所）は importProject.ts / shared/publishImport.ts の
// 純関数に置いてある。ここは**画面の進行**だけを受け持つ。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  listVercelTokenEntries, getVercelTokenById, getVercelTeamIdById,
  listCloudKeys, getActiveCloudKeyId,
} from './CredentialsModal'
import {
  importFolderName, collectManagedTargets, markManagedCandidates, managedNote,
} from '../../shared/publishImport'
import {
  buildImportedMeta, importPlanNotes, importDoneNotes, importConsoleLink, noCandidatesHint,
  emphasize, IMPORT_INTENTS, type ImportTarget, type ImportIntent,
} from '../importProject'
import { beginActivity } from '../activity'

/** 画面に出す「公開されるもの」フォルダの呼び名（Sidebar の見出しと揃える）。 */
const PUBLISH_DIR_LABEL = '公開されるもの'

type Step = 'target' | 'list' | 'confirm' | 'running' | 'done'

type Inspect = Awaited<ReturnType<Window['electronAPI']['import']['inspect']>>
type RunResult = Extract<Awaited<ReturnType<Window['electronAPI']['import']['run']>>, { ok: true }>

interface Props {
  /** プロジェクトを作る親フォルダ（ワークスペース）。 */
  parentDir: string | null
  /** 「新しく作る」へ戻る。 */
  onBack: () => void
  /** インポートが終わってプロジェクトを開く。 */
  onCreated: (root: string) => void
  /** 認証情報の画面を開く（トークンが無いとき）。 */
  onOpenCredentials: () => void
  /** 進行中かどうかを親へ伝える（閉じるボタンを止めるため）。 */
  onBusyChange: (busy: boolean) => void
}

const TARGETS: { id: ImportTarget; label: string; hint: string }[] = [
  { id: 'vercel', label: '▲ Vercel', hint: '公開したファイル一式をインポートします' },
  { id: 'sakura-apprun', label: '📦 さくらのAppRun', hint: '公開中のイメージから中身をインポートします' },
]

/**
 * 文言の1行。`**…**` は太字で出す（`emphasize`）。
 *
 * ⚠️ 素の文字列のまま出すと `**` がそのまま見える（0.3.41〜・2026-08-25 実機で判明）。
 * 消すだけだと、いちばん読ませたい一行が平坦になるので**太字にする**。
 */
function Note({ children }: { children: string }) {
  return (
    <p className="text-ink-secondary">
      ・{emphasize(children).map((sp, i) => (
        sp.bold ? <b key={i} className="text-ink font-semibold">{sp.text}</b> : <span key={i}>{sp.text}</span>
      ))}
    </p>
  )
}

function formatAt(at: string | null): string {
  if (!at) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function ImportFromPublishedPanel({ parentDir, onBack, onCreated, onOpenCredentials, onBusyChange }: Props) {
  const [step, setStep] = useState<Step>('target')
  const [target, setTarget] = useState<ImportTarget | null>(null)
  const [candidates, setCandidates] = useState<ImportCandidate[]>([])
  const [selected, setSelected] = useState<ImportCandidate | null>(null)
  const [inspected, setInspected] = useState<Inspect | null>(null)
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** Git 由来のときの案内（**断るが、どこから取ればよいかを必ず添える**）。 */
  const [gitNote, setGitNote] = useState('')
  const [progress, setProgress] = useState('')
  /**
   * このあと何をしたいか（**両方の公開先で聞く**）。
   *
   * **既定値を置かない。** `fork` のつもりで `update` になると生きている公開が消えるが、
   * 逆はプロジェクトが1つ余分にできるだけ。間違いの重さが左右で違うので、選ばせる。
   *
   * AppRun では、`update` を選んだときだけ**引き継ぐ**（`.sakura-cloud/` を書く）。
   * 引き継ぐと破棄が本物のアプリに効くようになるので、**中を見たいだけの人には重い**。
   */
  const [intent, setIntent] = useState<ImportIntent | null>(null)
  /**
   * どのキーで探しているか（2026-08-24 Ryosuke 指摘）。
   *
   * それまでは**使用中のキー1つ**で黙って探していた。キーを複数持っている人には
   * 「見つかりません」が「そのキーからは見えません」の意味になり、
   * **公開したものが消えたように見える**。
   */
  const [keys, setKeys] = useState<{ id: string; label: string }[]>([])
  const [keyId, setKeyId] = useState('')
  const [result, setResult] = useState<RunResult | null>(null)
  const [destRoot, setDestRoot] = useState('')

  // Vercel のトークンは一覧・下調べ・取り込みで使い回す（方式B: renderer が持って引数で渡す）。
  const creds = useRef<{ token?: string; teamId?: string }>({})

  useEffect(() => { onBusyChange(step === 'running') }, [step, onBusyChange])

  const nameOk = /^[A-Za-z0-9._-]+$/.test(name.trim())

  /**
   * まだ使われていないフォルダ名を選ぶ（2026-08-24 Ryosuke 指摘）。
   *
   * 公開先での名前をそのまま初期値にすると、**同じ名前のプロジェクトが既にある人**は
   * 押してから弾かれ、手で打ち直すことになる。新規作成の重複時と同じ流儀で、
   * 空いている名前（`-2` `-3` …）を先に入れておく。
   */
  const freeName = useCallback(async (base: string): Promise<string> => {
    if (!parentDir) return base
    let candidate = base
    for (let i = 2; i < 100; i++) {
      if (!(await window.electronAPI.fs.exists(`${parentDir}/${candidate}`))) return candidate
      candidate = `${base}-${i}`
    }
    return candidate
  }, [parentDir])

  /**
   * ワークスペースを見て、**もう手元で管理している公開先**を集める。
   * 失敗しても一覧は出す（印が付かないだけで、インポート自体はできる）。
   */
  const localTargets = useCallback(async () => {
    try {
      if (!parentDir) return { apprunAppIds: {}, vercelNames: {} }
      const r = await window.electronAPI.fs.publishedRecords(parentDir)
      return collectManagedTargets(r.ok ? r.projects : [])
    } catch {
      return { apprunAppIds: {}, vercelNames: {} }
    }
  }, [parentDir])

  // ── ① 公開先を選ぶ → 一覧 ──────────────────────────────────────────
  /** 選んだキーで探し直す。Vercel はトークンを引数で渡す（方式B・副作用なし）。 */
  const fetchList = useCallback(async (t: ImportTarget, id: string, list: { id: string; label: string }[]) => {
    setError(''); setGitNote(''); setCandidates([]); setLoading(true)
    try {
      creds.current = {}
      if (t === 'vercel') {
        const [token, teamId] = await Promise.all([getVercelTokenById(id), getVercelTeamIdById(id)])
        if (!token) {
          setError('Vercel のトークンが登録されていません。「認証情報」で登録してから、もう一度お試しください。')
          return
        }
        creds.current = { token, ...(teamId ? { teamId } : {}) }
      }
      const r = await window.electronAPI.import.list({ target: t, ...creds.current })
      if (!r.ok) { setError(r.message); return }
      // **もう手元にあるものには印をつける**（2026-08-25 Ryosuke 指摘）。
      // 同じものを2つ持つ理由は無いが、気づけないと作ってしまう。
      // 手元のフォルダを見るだけなので、キーもネットワークも要らない。
      setCandidates(markManagedCandidates(r.candidates, await localTargets()))
      // **「見つかりません」の本当の意味が「そのキーからは見えません」であることは多い。**
      if (!r.candidates.length) setError(noCandidatesHint(t, list.length))
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const startList = useCallback(async (t: ImportTarget) => {
    setTarget(t); setError(''); setGitNote(''); setCandidates([]); setLoading(true); setStep('list')
    try {
      // どのキーで探すかを決め、**画面にも出す**（黙って1つ選ばない）
      const [list, active] = t === 'vercel'
        ? await (async () => {
            const e = await listVercelTokenEntries()
            return [e.tokens, e.activeId] as const
          })()
        : await (async () => {
            const [l, a] = await Promise.all([listCloudKeys(), getActiveCloudKeyId()])
            return [l, a] as const
          })()
      setKeys(list)
      if (!list.length) {
        setError(t === 'vercel'
          ? 'Vercel のトークンが登録されていません。「認証情報」で登録してから、もう一度お試しください。'
          : 'さくらのクラウドのキーが登録されていません。「認証情報」で登録してから、もう一度お試しください。')
        setLoading(false)
        return
      }
      const chosen = (active && list.some(k => k.id === active)) ? active : list[0].id
      setKeyId(chosen)
      await fetchList(t, chosen, list)
    } catch (e: any) {
      setError(e?.message ?? String(e)); setLoading(false)
    }
  }, [fetchList])

  // ── ② 選んだものを下調べ（**取り込む前に、何が起きるかを見せる**）──────
  const choose = useCallback(async (c: ImportCandidate) => {
    if (!target || c.blocked) return
    setSelected(c); setError(''); setGitNote(''); setLoading(true)
    try {
      const r = await window.electronAPI.import.inspect({ target, id: c.id, ...creds.current })
      if (!r.ok) {
        // Git 由来は「取り込めない」ではなく「そっちから取ったほうが良い」。案内へ回す。
        if (r.gitBacked) setGitNote(r.message)
        else setError(r.message)
        setSelected(null)
        return
      }
      setInspected(r)
      setIntent(null) // 前に選んだものを引きずらない
      setName(await freeName(importFolderName(c.name)))
      setStep('confirm')
    } catch (e: any) {
      setError(e?.message ?? String(e)); setSelected(null)
    } finally {
      setLoading(false)
    }
  }, [target, freeName])

  // ── ③ 取り込む（ここで初めてディスクへ書く）────────────────────────
  const runImport = useCallback(async () => {
    if (!target || !selected || !parentDir) return
    const n = name.trim()
    if (!n || !nameOk) { setError('プロジェクト名は半角英数字・ハイフン(-)・アンダースコア(_)・ドット(.)のみ使用できます'); return }
    setError('')
    const dest = `${parentDir}/${n}`
    if (await window.electronAPI.fs.exists(dest)) {
      setError(`「${n}」は既にあります。別の名前にしてください。`)
      return
    }
    setStep('running'); setProgress('準備しています…')
    const endActivity = beginActivity('公開しているもののインポート')
    const off = window.electronAPI.import.onProgress(m => setProgress(m))
    try {
      const r = await window.electronAPI.import.run({
        target, id: selected.id, destDir: dest, ...creds.current,
        // AppRun の引き継ぎは main 側で行う（`.sakura-cloud/` を書くのは main）。
        ...(intent ? { intent } : {}),
      })
      if (!r.ok) { setError(r.message); setStep('confirm'); return }

      // インポートした事実を記録する（何を・どこから・いつ）。公開の記録を書くかは
      // 公開先ごとに違う（importProject.ts のコメント参照）。
      const insp = inspected && inspected.ok ? inspected : null
      const meta = buildImportedMeta({
        projectName: n,
        importedAt: new Date().toISOString(),
        source: {
          target,
          id: selected.id,
          name: selected.name,
          url: selected.url,
          publishedAt: selected.at,
          stripped: r.stripped ?? null,
          fileCount: r.fileCount,
          settings: r.settings ?? insp?.settings ?? null,
          intent,
          // **選んだこと（intent）ではなく、できたこと（adopted）で記録を決める。**
          adopted: r.adopted === true,
        },
      })
      await window.electronAPI.fs.createProject(parentDir, n, [
        { path: '.sakuraide.json', content: JSON.stringify(meta, null, 2) },
      ], true)

      setDestRoot(dest)
      setResult(r)
      setStep('done')
    } catch (e: any) {
      setError(e?.message ?? String(e)); setStep('confirm')
    } finally {
      off()
      endActivity()
    }
  }, [target, selected, parentDir, name, nameOk, inspected, intent])

  const insp = inspected && inspected.ok ? inspected : null

  return (
    <div className="space-y-4">
      {/* ── 公開先を選ぶ ────────────────────────────────────────── */}
      {step === 'target' && (
        <>
          <div className="text-xs text-ink-secondary bg-surface border border-line rounded-lg px-3 py-2.5 leading-relaxed">
            公開されているものをインポートし、編集できるようにします。<br />
            パソコンが変わった・引き継いだ・引っ越したときに使えます。
            <span className="text-ink-muted">公開先には何も作らず、何も消しません。</span>
          </div>
          <div>
            <label className="text-xs font-semibold text-ink-secondary">どこに公開したものですか？</label>
            <div className="mt-1.5 space-y-1.5">
              {TARGETS.map(t => (
                <button
                  key={t.id}
                  onClick={() => startList(t.id)}
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-surface border border-line hover:border-sakura transition-colors"
                >
                  <div className="text-sm font-semibold text-ink">{t.label}</div>
                  <div className="text-[11px] text-ink-muted">{t.hint}</div>
                </button>
              ))}
            </div>
          </div>
          <button onClick={onBack} className="text-[11px] text-sakura hover:underline">← 新しく作る に戻る</button>
        </>
      )}

      {/* ── 一覧から選ばせる（名前が同じだけで勝手に紐づけない）───────── */}
      {step === 'list' && (
        <>
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-ink-secondary">
              インポートするものを選んでください（{TARGETS.find(t => t.id === target)?.label}）
            </label>
            <button onClick={() => { setStep('target'); setError(''); setGitNote('') }} className="text-[11px] text-sakura hover:underline">
              公開先を選び直す
            </button>
          </div>

          {/* どのキーで探しているか。**黙って1つ選ばない**（2026-08-24 Ryosuke 指摘）。
              Vercel はトークンを引数で渡すのでその場で切り替えられる（副作用なし）。
              さくらのクラウドは「使用中のキー」がアプリ全体の設定なので、
              ここでは**見せるだけ**にして、切り替えは認証情報の画面へ渡す。 */}
          {keys.length > 0 && (
            <div className="text-[11px] text-ink-muted">
              {target === 'vercel' && keys.length > 1 ? (
                <label className="flex items-center gap-1.5">
                  <span>使うキー:</span>
                  <select
                    value={keyId}
                    onChange={e => { setKeyId(e.target.value); void fetchList('vercel', e.target.value, keys) }}
                    disabled={loading}
                    className="bg-surface border border-line rounded-lg px-2 py-1 text-[11px] text-ink outline-none focus:border-sakura disabled:opacity-50"
                  >
                    {keys.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
                  </select>
                </label>
              ) : (
                <span>
                  使っているキー: <span className="text-ink-secondary">{keys.find(k => k.id === keyId)?.label ?? '—'}</span>
                  {keys.length > 1 && (
                    <>
                      {'（ほかに '}{keys.length - 1}{' 個）'}
                      <button onClick={onOpenCredentials} className="ml-1 text-sakura hover:underline">
                        認証情報で切り替える
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-2 text-xs text-ink-secondary">
              <span className="w-3 h-3 rounded-full border-2 border-sakura border-t-transparent animate-spin" />
              調べています…
            </div>
          )}

          {!loading && candidates.length > 0 && (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {candidates.map(c => (
                <button
                  key={c.id}
                  onClick={() => choose(c)}
                  disabled={!!c.blocked}
                  className={`w-full text-left px-3 py-2.5 rounded-xl bg-surface border transition-colors ${
                    c.blocked ? 'border-line opacity-60 cursor-not-allowed' : 'border-line hover:border-sakura'
                  }`}
                >
                  <div className="text-sm font-semibold text-ink truncate">{c.name}</div>
                  {c.url && <div className="text-[11px] text-ink-muted truncate">{c.url}</div>}
                  <div className="text-[11px] text-ink-muted">
                    {[formatAt(c.at), c.note].filter(Boolean).join(' / ')}
                  </div>
                  {c.blocked && <div className="text-[11px] text-brand-red mt-0.5">{c.blocked}</div>}
                  {/* もう手元にある（2026-08-25）。**止めはしない。気づかせる。** */}
                  {c.managedBy && (
                    <div className="text-[11px] text-brand-yellow mt-0.5">⚠️ {managedNote(c.managedBy.projectName)}</div>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Git 由来: 断るが、どこから取ればよいかを必ず添える */}
          {gitNote && (
            <div className="text-xs bg-surface border border-brand-yellow/60 rounded-lg px-3 py-2.5 text-ink leading-relaxed">
              {emphasize(gitNote).map((sp, i) => (
                sp.bold ? <b key={i} className="font-semibold">{sp.text}</b> : <span key={i}>{sp.text}</span>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── 取り込む前に、何が起きるかを見せる ────────────────────── */}
      {(step === 'confirm' || step === 'running') && selected && target && (
        <>
          <div>
            <label className="text-xs font-semibold text-ink-secondary">インポートするもの</label>
            <div className="mt-1.5 px-3 py-2.5 rounded-xl bg-surface border border-line">
              <div className="text-sm font-semibold text-ink truncate">{selected.name}</div>
              {selected.url && <div className="text-[11px] text-ink-muted truncate">{selected.url}</div>}
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-ink-secondary">プロジェクト名（半角英数字。例: my-shop）</label>
            <input
              value={name}
              onChange={e => { setName(e.target.value); setError('') }}
              disabled={step === 'running'}
              className={`mt-1.5 w-full bg-surface border rounded-xl px-3 py-2.5 text-sm text-ink placeholder-ink-muted outline-none transition-colors disabled:opacity-50 ${
                name.trim() && !nameOk ? 'border-brand-red focus:border-brand-red' : 'border-line focus:border-sakura'
              }`}
            />
            {parentDir && name.trim() && nameOk && (
              <p className="mt-1 text-[11px] text-ink-muted truncate">作成先: {parentDir}/{name.trim()}</p>
            )}
          </div>

          {/* もう手元にあるものを選んだとき。**同じものを2つ持つ理由は無い**ので、
              そのプロジェクトを開ける道をここに出す（一覧の行はボタンなので、
              入れ子のボタンを避けてこちらに置いた）。 */}
          {selected.managedBy && (
            <div className="text-xs bg-surface border border-brand-yellow/60 rounded-lg px-3 py-2.5 leading-relaxed space-y-1.5">
              <p className="text-ink">⚠️ {managedNote(selected.managedBy.projectName)}</p>
              <p className="text-ink-secondary">
                取り込むと、同じものを指すプロジェクトが2つになります。編集を続けたいだけなら、
                そちらを開いてください。
              </p>
              <button
                onClick={() => selected.managedBy && onCreated(selected.managedBy.dir)}
                disabled={step === 'running'}
                className="text-[11px] text-sakura hover:underline disabled:opacity-50"
              >
                「{selected.managedBy.projectName}」を開く →
              </button>
            </div>
          )}

          {/* このあと何をしたいか（**両方の公開先で聞く**）。
              AppRun では `update` を選んだときだけ引き継ぎ、
              `.sakura-cloud/state.json` にアプリIDを書く（dev-plan ④ 第4段階）。
              引き継ぐと破棄が本物のアプリに効くので、**選んだときだけ**にする。 */}
          <div>
            <label className="text-xs font-semibold text-ink-secondary">このあと、どうしますか？</label>
            <div className="mt-1.5 space-y-1.5">
              {IMPORT_INTENTS.map(o => (
                <button
                  key={o.id}
                  onClick={() => setIntent(o.id)}
                  disabled={step === 'running'}
                  className={`w-full text-left px-3 py-2 rounded-xl border transition-colors disabled:opacity-50 ${
                    intent === o.id ? 'border-sakura bg-surface' : 'border-line bg-surface hover:border-sakura/60'
                  }`}
                >
                  <div className="text-sm font-semibold text-ink">{o.label}</div>
                  <div className="text-[11px] text-ink-muted">{o.hint}</div>
                </button>
              ))}
            </div>
            {!intent && (
              <p className="mt-1 text-[11px] text-ink-muted">選ぶと、このあと何が起きるかが下に出ます。</p>
            )}
          </div>

          <div className="text-xs bg-surface border border-line rounded-lg px-3 py-2.5 space-y-1.5 leading-relaxed">
            <div className="font-semibold text-ink">このあと起きること</div>
            {importPlanNotes({
              target,
              publishDirLabel: PUBLISH_DIR_LABEL,
              fileCount: insp?.fileCount ?? null,
              stripped: insp?.stripped ?? null,
              image: insp?.image ?? null,
              secretKeys: insp?.secretKeys ?? [],
              // **どこが置き換わるか**は公開先での名前で決まる（手元のフォルダ名ではない）
              publishName: selected.name,
              intent,
              projectName: name.trim(),
              adopt: insp?.adopt ?? null,
            }).map((n, i) => <Note key={i}>{n}</Note>)}
          </div>

          {step === 'running' ? (
            <div className="flex items-center gap-2 text-xs text-ink-secondary">
              <span className="w-3 h-3 rounded-full border-2 border-sakura border-t-transparent animate-spin" />
              <span className="truncate">{progress}</span>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => { setStep('list'); setSelected(null); setInspected(null); setError('') }}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium text-ink-secondary bg-surface border border-line hover:text-ink transition-colors"
              >
                選び直す
              </button>
              <button
                onClick={runImport}
                disabled={!name.trim() || !nameOk || !parentDir || !intent}
                title={!intent ? '「このあと、どうしますか？」を選んでください' : undefined}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold sakura-gradient text-white hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                インポート
              </button>
            </div>
          )}
        </>
      )}

      {/* ── 終わったら ──────────────────────────────────────────── */}
      {step === 'done' && result && target && (
        <>
          <div className="text-xs bg-surface border border-line rounded-lg px-3 py-2.5 space-y-1.5 leading-relaxed">
            <div className="font-semibold text-ink">✅ インポートしました</div>
            {importDoneNotes({
              fileCount: result.fileCount,
              failed: result.failed,
              historySnapshotId: result.historySnapshotId,
              historyNote: result.historyNote,
              adopted: result.adopted,
              adoptNote: result.adoptNote,
            }).map((n, i) => <Note key={i}>{n}</Note>)}
            <p className="text-ink-muted">
              元の公開は{importConsoleLink(target).label}（{importConsoleLink(target).url}）で確認できます。
            </p>
          </div>
          <button
            onClick={() => onCreated(destRoot)}
            className="w-full py-2.5 rounded-xl text-sm font-semibold sakura-gradient text-white hover:opacity-90 transition-opacity"
          >
            プロジェクトを開く
          </button>
        </>
      )}

      {error && (
        <div className="text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2 leading-relaxed">
          {error}
          {error.includes('トークンが登録されていません') && (
            <button onClick={onOpenCredentials} className="ml-2 underline">認証情報を開く</button>
          )}
        </div>
      )}
    </div>
  )
}
