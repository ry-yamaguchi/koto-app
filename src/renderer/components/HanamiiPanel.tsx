import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import SecurityCheckSection from './SecurityCheckSection'
import UnusedFilesSection from './UnusedFilesSection'
import { getHanamiiToken, getHanamiiTokenById, listHanamiiTokenEntries } from './CredentialsModal'
import { getTargetProfile } from '../targetProfiles'
import { isNameConflictError, suggestAlternativeName } from '../nameConflict'
import { beginActivity, PUBLISH_CLOSE_WARNING, PUBLISH_QUIT_STOPS } from '../activity'
import CopyButton from './CopyButton'
import { mergeProjectMeta } from '../projectMeta'
import { useProjectOpsView } from '../hooks/useProjectOpsView'
import { isHanamiiOp } from '../projectOpsView'
import { clockText, opWarningText } from '../../shared/opsText'
import { teardownDataNoteForAll } from '../../shared/teardownSupport'
import { askAiAboutFailure, type AskAiFailureKind } from '../../shared/askAi'
import { publishButtonLabel } from '../../shared/publishLabels'
import AccessKeySection from './AccessKeySection'

// HANAMII の公開名の文字数上限。HANAMII 側の公開APIリファレンス（hanamii.jp/docs/api）には
// 名前の上限が明記されていないが、HANAMII は AppRun 基盤上で動く（コンテナをビルドし EXPOSE から
// ポートを判定する、と同ファイル内の staticServerFiles コメントに既述）ため、AppRun の
// NAME_PATTERN（src/main/cloud/spec.ts・3〜40文字）と同じ上限を安全側の既定として採用する。
// ※実際の上限は未確認。もし異なることが判明したら要修正。
// 2026-07-13 実測: 45字の公開名で公開成功（公式上限は未公表・これを超える長さは未検証）。
const HANAMII_NAME_MAX_LEN = 45

// main/hanamii/client.ts の describeErrorCode と同じ内容（renderer は main の Node専用コードを import しない流儀のため複製）。
// 既知コードのみ日本語化し、未知のコードはそのまま見せる（推測で網羅しない）。
function describeErrorCode(code: string | null | undefined): string {
  if (!code) return ''
  const table: Record<string, string> = {
    BUILD_FAILED: 'ビルドに失敗しました。直前に追加したライブラリ名の誤りや、package.json の記述ミスが典型的な原因です。',
  }
  return table[code] ?? `エラーコード: ${code}`
}

// フォームの envs / ヘルスチェック設定を、API送信用（sendEnvs）とメタ保存用（persistEnvs。
// シークレットは値を保存しない）に変換する（純粋関数・テスト対象）。パスは `/` 始まりでなければ自動補正する。
// 「公開する（redeploy）」と「🔄 再起動して反映（restart）」の両方の導線で同じ変換ロジックを使うため、
// ここに一本化した（食い違いを防ぐ）。emptySecretKey は値未入力のシークレットがあればそのキー名を返す
// （呼び出し側が「入力してから実行してください」と案内するため）。
export function buildEnvsAndHealthCheck(
  envs: Array<{ key: string; value: string; secret: boolean }>,
  hcEnabled: boolean,
  hcPath: string,
): {
  sendEnvs: Array<{ key: string; value: string; type: 'plain' | 'secret' }>
  persistEnvs: Array<{ key: string; value?: string; secret: boolean }>
  healthCheck: { enabled: boolean; path: string; port: null }
  emptySecretKey: string | null
} {
  const rows = envs.filter(e => e.key.trim())
  const emptySecret = rows.find(e => e.secret && !e.value.trim())
  const sendEnvs = rows.map(e => ({ key: e.key.trim(), value: e.value, type: (e.secret ? 'secret' : 'plain') as 'secret' | 'plain' }))
  const persistEnvs = rows.map(e => e.secret ? { key: e.key.trim(), secret: true } : { key: e.key.trim(), value: e.value, secret: false })
  const normalizedPath = hcPath.trim() ? (hcPath.trim().startsWith('/') ? hcPath.trim() : `/${hcPath.trim()}`) : '/'
  return {
    sendEnvs,
    persistEnvs,
    healthCheck: { enabled: hcEnabled, path: normalizedPath, port: null },
    emptySecretKey: emptySecret ? emptySecret.key.trim() : null,
  }
}

// runtimeStatus.syncedAt（ISO8601想定）を「たった今」「N分前」「HH:mm」に整形する（純粋関数・テスト対象）。
// パース不能な場合は null を返し、呼び出し側で時刻表記を省略する。
export function formatSyncedAt(syncedAt: string | null | undefined, now: Date = new Date()): string | null {
  if (!syncedAt) return null
  const d = new Date(syncedAt)
  if (isNaN(d.getTime())) return null
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'たった今'
  if (diffMin < 60) return `${diffMin}分前`
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false })
}

// HANAMII（国産PaaS）への公開パネル。トークンは「認証情報」に一元登録し（方式B）、
// このパネルは使う瞬間に読んで main へ引数で渡す（main には保存しない・AI Engineキーと同じ扱い）。
// 流れ: 認証情報でトークン登録 → ワークスペース選択 → 公開（IDEがZIP化）→ 状態/公開URL → 破棄。

interface Props {
  projectDir: string
  /** さくらのAI Engine のAPIキー（🛡 セキュリティチェックに使用）。 */
  apiKey: string
  onOpenCredentials: () => void
}

// HANAMII のプロジェクト名は英数字とハイフンのみ。プロジェクト名を安全な形に整える。
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'app'
}

export default function HanamiiPanel({ apiKey, projectDir, onOpenCredentials }: Props) {
  const projName = projectDir.split('/').pop() ?? 'app'
  const metaPath = `${projectDir}/.sakuraide.json`
  const guessSecret = (k: string) => /KEY|SECRET|TOKEN|PASS|PWD|CREDENTIAL|PRIVATE|APIKEY/i.test(k)

  const [token, setToken] = useState<string | null>(null)
  const [tokenLoaded, setTokenLoaded] = useState(false)
  const [tokens, setTokens] = useState<Array<{ id: string; label: string }> | null>(null)
  const [tokenId, setTokenId] = useState('')
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string; role: string }> | null>(null)
  const [workspaceId, setWorkspaceId] = useState('')
  const [projectId, setProjectId] = useState<string | null>(null)
  // 公開名（空ならフォルダ名を使う）。test 等のありふれた名前が HANAMII 内部で衝突（409）した際の回避手段
  const [publishName, setPublishName] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [status, setStatus] = useState<{ url: string | null; readyState: string | null; errorCode?: string | null; runtime?: { status: string | null; detail: string | null; syncedAt: string | null } | null } | null>(null)
  const [envs, setEnvs] = useState<Array<{ key: string; value: string; secret: boolean }>>([])
  const [hcEnabled, setHcEnabled] = useState(false)
  const [hcPath, setHcPath] = useState('/')
  const [detectedKeys, setDetectedKeys] = useState<string[]>([])
  const [msg, setMsg] = useState('')
  // 失敗時の生API応答（JSON短縮・診断用・所見11）。主表示（msg）とは分け、折りたたみ「詳細を見る」で見せる。
  const [msgDetail, setMsgDetail] = useState('')
  // msg が成功の知らせか（破棄の「✅ 破棄しました。＋片づけた内容」で使う）。
  // 失敗の欄と共有するので、ここが false のときだけ「🤖 AIに相談する」を出す（判断2）。
  const [msgOk, setMsgOk] = useState(false)
  // msg がどの操作の失敗か（判断2・「🤖 AIに相談する」の定型文に使う kind）。publish/teardown が
  // 同じ msg を共有するため、setMsg とあわせて各操作の先頭で立てる。
  const [msgKind, setMsgKind] = useState<AskAiFailureKind>('公開')
  // 直近に公開を試みた名前（衝突時の代替名提案のベースにする）。
  const [lastAttemptedName, setLastAttemptedName] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  // 破棄を頼んでから、main の記録（running）が届くまでの間も「破棄中」と分かるようにする局所の印。
  const [tearingDown, setTearingDown] = useState(false)
  // 「↻ 状態を更新」（HANAMII の状態を取り直す）。公開が「待つ時間のうちに動かなかった」で終わったとき、
  // 画面が BUILDING のまま固まらないための口（自動で確かめ続ける仕組みは持たない・下の説明）。
  const [statusRefreshing, setStatusRefreshing] = useState(false)
  const [statusNote, setStatusNote] = useState('')
  // この画面が最後に読んだ値（記録が終わったときの読み直しが、古い閉じ込め値を見ないため）。
  const latest = useRef<{ token: string | null; tokenId: string }>({ token: null, tokenId: '' })
  latest.current = { token, tokenId }
  // 破棄が終わって projectId を空にしたあと、開いたときの読み込み（下の useEffect）の**遅れて届いた古い値**が
  // それを戻さないための印（破棄が終わったのに 🗑 が出直す）。次に公開の projectId を知ったら下ろす。
  const teardownSettled = useRef(false)
  // いま開いているプロジェクト（最新の projectDir）。公開・破棄は最長で数分かかり、その間に別のプロジェクトへ切り替わりうる
  // （公開のダイアログは開いたまま、📡 一覧の「プロジェクトを開く」で projectDir だけが変わる）。
  // 返ってきた結果を、**呼んだときのプロジェクト**と比べてから画面へ入れるのに使う（掟11）。
  const dirRef = useRef(projectDir)
  dirRef.current = projectDir

  // 📋 ログを見る（折りたたみ）
  const [logsOpen, setLogsOpen] = useState(false)
  const [logsLoading, setLogsLoading] = useState(false)
  const [logs, setLogs] = useState<Array<{ timestamp: string; message: string }> | null>(null)
  const [logsError, setLogsError] = useState('')

  const readMeta = useCallback(async (): Promise<any> => {
    try { return JSON.parse(await window.electronAPI.fs.readFile(metaPath)) } catch { return {} }
  }, [metaPath])

  const saveHanamiiMeta = useCallback(async (h: { projectId?: string | null; workspaceId?: string; envs?: Array<{ key: string; value?: string; secret: boolean }>; tokenId?: string; healthCheck?: { enabled: boolean; path: string }; name?: string }, publishRecord?: { publishedAt: string | null; url: string | null }) => {
    // 差分だけを main へ渡す（書く直前にディスクから読み直して当てる・src/renderer/projectMeta.ts）。
    // 画面が持っている写しで全体を書き戻さない——main が書いた記録（projectId・publish.targets など）を消すため。
    await mergeProjectMeta(projectDir, {
      target: 'hanamii',
      publish: {
        hanamii: h,
        // 統一公開記録（publish.targets）。公開成功時のみ渡される（更新のみの保存では触らない）。
        ...(publishRecord ? { targets: { hanamii: publishRecord } } : {}),
      },
    })
    window.dispatchEvent(new Event('sakura-meta-changed'))
  }, [projectDir])

  const loadWorkspaces = useCallback(async (tk: string) => {
    const r = await window.electronAPI.hanamii.listWorkspaces(tk)
    if (r.ok && r.workspaces) {
      const ws = r.workspaces
      setWorkspaces(ws)
      // 現在の workspaceId が新しい一覧に含まれていればそのまま維持、無ければ先頭にリセット
      setWorkspaceId(prev => (prev && ws.some(w => w.id === prev)) ? prev : (ws[0]?.id || ''))
    } else {
      setMsg(r.message ?? 'ワークスペースの取得に失敗しました')
    }
  }, [])

  // トークン一覧を読み込み、選択中の tokenId を決める（優先順位: メタの保存値 → ストアの使用中 → 先頭）
  const loadTokenList = useCallback(async (preferredId?: string | null) => {
    const { tokens: list, activeId } = await listHanamiiTokenEntries()
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
    const tk = await getHanamiiTokenById(id)
    setToken(tk)
    if (tk) {
      setWorkspaces(null)
      loadWorkspaces(tk)
    }
  }, [loadWorkspaces])

  // ── データの保存を持っていく（2026-08-15）──────────────────────────
  // データはオブジェクトストレージにあり、**計算とは別の場所**にある。
  // 鍵を発行して環境変数で渡せば、AppRun で作ったデータをそのまま読める。
  const [placement, setPlacement] = useState<{ bucket: string; prefix: string } | null>(null)
  /**
   * 同意済みの保存場所の**全件**（破棄の確認に出すもの・2026-09-25 検分の指摘5）。
   * 公開で持っていくのは先頭の1件（`issueStorageEnvFor`）だが、**破棄は全件を片づける**。
   * 確認で1件しか名指ししないと、**名前が一度も出なかった保存場所とデータまで消える。**
   */
  const [placements, setPlacements] = useState<Array<{ bucket: string; prefix: string; shared: boolean }>>([])
  const [usesData, setUsesData] = useState(false)
  const [withStorage, setWithStorage] = useState(true)

  /** 保存場所の状況を読み直す（開いたとき・「保存場所を用意する」を押した直後）。 */
  const loadStorageInfo = useCallback(async (isStale?: () => boolean) => {
    try {
      const [pl, scan] = await Promise.all([
        window.electronAPI.storage.placement(projectDir),
        window.electronAPI.storage.scan(projectDir),
      ])
      if (isStale?.()) return
      setPlacement(pl.ok && pl.placement ? { bucket: pl.placement.bucket, prefix: pl.placement.prefix } : null)
      // placements（全件）が無い版の応答でも、先頭1件だけは必ず拾う（黙って空にしない）。
      const all = pl.ok ? (pl.placements ?? (pl.placement ? [pl.placement] : [])) : []
      setPlacements(all.map(p => ({ bucket: p.bucket, prefix: p.prefix, shared: p.shared })))
      setUsesData(!!(scan as any)?.usedBy?.length)
    } catch { /* 分からなければ出さない */ }
  }, [projectDir])

  // ── 保存場所を用意した直後に読み直す（2026-09-25 検分の指摘20）──────────────
  // 「保存場所を用意する」（StorageNotice）は同じ③公開モーダルの中にあり、押すと
  // `sakura:storage-prepared` を出す。ところがこのパネルはそれを聞いていなかったので、
  // 用意した直後に公開すると `placement` が null のまま＝下の公開の引数が
  // `withStorage: withStorage && !!placement` で **false** になり、
  // **月額を払って用意した保存場所を渡さずに公開**していた（データはコンテナの中に落ちて再起動で消える）。
  // 隣の3枚（AppRunPanel・AppRunDedicatedPanel・VercelPanel）は同じ出来事を受けて取り直している。
  useEffect(() => {
    let cancelled = false
    const isStale = () => cancelled
    void loadStorageInfo(isStale)
    const onPrepared = () => { void loadStorageInfo(isStale) }
    window.addEventListener('sakura:storage-prepared', onPrepared)
    return () => { cancelled = true; window.removeEventListener('sakura:storage-prepared', onPrepared) }
  }, [loadStorageInfo])

  // 認証情報の変更イベントで、トークン一覧・選択・ワークスペースを読み直す
  const refreshToken = useCallback(async () => {
    const chosen = await loadTokenList(tokenId)
    setTokenLoaded(true)
    if (chosen) {
      const tk = await getHanamiiTokenById(chosen)
      setToken(tk)
      if (tk) { setWorkspaces(null); loadWorkspaces(tk) }
    } else {
      setToken(null)
    }
  }, [loadTokenList, loadWorkspaces, tokenId])

  useEffect(() => {
    let cancelled = false
    // ── 別のプロジェクトへ切り替わったら、前のプロジェクトのものを持ち越さない（2026-09-30 検分・掟11）──────
    // 公開のダイアログは開いたまま projectDir だけが変わることがある（📡 公開したもの一覧の「プロジェクトを開く」）。
    // 前は、切り替え先の記録に projectId が無いと前の値が残り、そのまま「公開する（更新）」「🗑 破棄」を押すと
    // **前のプロジェクトの projectId × いまの projectDir** で呼ばれた（別のプロジェクトのコードで前のアプリを上書きする・
    // 前のアプリを消して、いまのプロジェクトの保存場所まで片づける）。破棄が終わった印（teardownSettled）も持ち越し、
    // 切り替え先で HANAMII に公開中のプロジェクトを「未公開」と出していた。
    // 記録から入れ直す前に、**このプロジェクトのものではありえない状態を全部空に戻す**（初回の呼び出しでは何も変わらない）。
    teardownSettled.current = false
    setProjectId(null); setStatus(null)
    setWorkspaceId(''); setPublishName('')
    setEnvs(p => (p.length === 0 ? p : [])); setHcEnabled(false); setHcPath('/')
    setPlacement(null); setPlacements(p => (p.length === 0 ? p : [])); setUsesData(false)
    setPublishing(false); setTearingDown(false); setRestarting(false); setConfirmDel(false); setConfirmRestart(false)
    setMsg(''); setMsgDetail(''); setMsgOk(false); setLastAttemptedName('')
    setRestartMsg(''); setRestartMsgDetail(''); setStatusNote('')
    setLogsOpen(false); setLogs(null); setLogsError('')
    ;(async () => {
      const m = await readMeta()
      // 読んでいる間に別のプロジェクトへ切り替わったら、この読み込みは捨てる（遅れて届いた前の値で、切り替え先を汚さない）。
      if (cancelled) return
      const h = m.publish?.hanamii
      if (h?.workspaceId) setWorkspaceId(h.workspaceId)
      if (h?.projectId && !teardownSettled.current) setProjectId(h.projectId)
      if (typeof h?.name === 'string' && h.name) setPublishName(h.name)
      if (Array.isArray(h?.envs)) setEnvs(h.envs.map((e: any) => ({ key: String(e.key ?? ''), value: e.secret ? '' : String(e.value ?? ''), secret: !!e.secret })))
      if (h?.healthCheck) {
        setHcEnabled(!!h.healthCheck.enabled)
        setHcPath(typeof h.healthCheck.path === 'string' && h.healthCheck.path ? h.healthCheck.path : '/')
      }

      // トークン選択の優先順位: ①メタ保存の tokenId → ②ストアの使用中 → ③先頭
      const chosen = await loadTokenList(h?.tokenId ?? null)
      if (cancelled) return
      const tk = chosen ? await getHanamiiTokenById(chosen) : await getHanamiiToken()
      if (cancelled) return
      setToken(tk); setTokenLoaded(true)
      if (tk) loadWorkspaces(tk)
      if (h?.projectId && tk && !teardownSettled.current) {
        const r = await window.electronAPI.hanamii.status(h.projectId, tk)
        if (!cancelled && r.ok) setStatus({ url: r.url ?? null, readyState: r.readyState ?? null, errorCode: r.errorCode ?? null, runtime: r.runtime ?? null })
      }
    })()
    const onCredChange = () => { refreshToken() }
    window.addEventListener('sakura:credentials-changed', onCredChange)
    return () => {
      cancelled = true
      window.removeEventListener('sakura:credentials-changed', onCredChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir])

  useEffect(() => {
    let cancelled = false
    window.electronAPI.hanamii.detectEnvKeys(projectDir).then(r => {
      if (!cancelled) setDetectedKeys(r.ok ? r.keys : [])
    }).catch(() => {})
    return () => { cancelled = true }
  }, [projectDir])

  // ── 公開・破棄の進み具合と結果は、main の記録から出す（2026-09-29）────────────────────
  // 公開・破棄の本体は main の1回の IPC で最後まで進み、記録（.sakuraide.json）も main が書く。
  // ダイアログを閉じても処理は止まらない。失われていたのは**画面の表示だけ**（進み具合・結果・警告）で、
  // 閉じて開き直すと「終わったのか」「うまくいったのか」「まだ動いていないのか」が分からなかった。
  // そこで main が持つ**処理の記録**（window.electronAPI.projectOps・src/main/projectOps.ts）を読んで出す:
  //   ・走っていれば、いまの段（進み具合）を続きから
  //   ・終わっていれば、結果と警告（まだ動いていない・古い鍵を片づけられなかった…）を、見られるまで
  // 出し終えたら main へ「見た」と伝える（ack）ので、次に開いたときは出ない。**ただし警告つきの結果は伝えない**
// （この画面は結果を公開ボタンの下に出すので、出しただけでは見たことにならない。上部の「結果を確認しました」を
//  押すまで、開き直すたびに出る・2026-09-30 検分）。
  //
  // 以前ここには、公開のあと READY になるまで 3 秒ごとに状態を聞き続ける setInterval があり、
  // READY を見たら公開記録の url を書き、古い保存場所の鍵を片づけていた。**ダイアログを閉じると
  // それが止まり**、url は記録されず古い鍵が残った。いまはそれを main が画面に依らずに行う
  // （hanamii:publish が新しい版の READY を確かめるまで返らない）ので、**画面側では行わない**
  // （二重に片づけない）。ここは表示するだけ。
  /** HANAMII の状態を取り直して画面に出す（取れなければ false。黙って古い表示のままにしない）。 */
  const refreshStatus = useCallback(async (pid: string, tk: string): Promise<boolean> => {
    const asked = dirRef.current
    try {
      const r = await window.electronAPI.hanamii.status(pid, tk)
      if (!r.ok) return false
      // 待っている間に別のプロジェクトへ切り替わったら、その状態は前のプロジェクトのもの。いまの画面へ入れない。
      if (dirRef.current !== asked) return false
      setStatus({ url: r.url ?? null, readyState: r.readyState ?? null, errorCode: r.errorCode ?? null, runtime: r.runtime ?? null })
      return true
    } catch { return false }
  }, [])

  /**
   * 破棄が終わって HANAMII のプロジェクトが消えたあとの、**画面の表示だけ**の後始末。
   *
   * 設定の projectId を空にする・公開記録を消す、は**ここでは行わない**（main の hanamii:teardown が、鍵の中で
   * 消したそのときに1回だけ行う・2026-09-30）。画面は記録を**再生する**（閉じて開き直すと、まだ見られていない
   * 古い破棄の結果をもう一度「初めて見た」と扱う）ので、画面が書くと、そのあとに公開し直した新しいプロジェクトの
   * 記録まで消して、HANAMII のプロジェクトが二重に作られた。**再生されても表示を直すだけなら無害**である。
   * 何度呼んでも同じ結果になる。
   */
  const showTornDown = async () => {
    teardownSettled.current = true
    setProjectId(null); setStatus(null); setConfirmDel(false)
    window.dispatchEvent(new Event('sakura-meta-changed'))
    await loadStorageInfo()
  }

  /**
   * 自分の公開先の操作が終わった記録を初めて見たとき（この画面が頼んだものも、閉じている間に終わったものも）。
   * **記録（ディスク）のいまの状態から表示を決める**——古い結果を再生しても、いまの状態を映すだけで、何も書かない。
   */
  const afterOpFinished = async (rec: ProjectOpRecordShape) => {
    const m = await readMeta()
    const pid = m.publish?.hanamii?.projectId
    if (typeof pid === 'string' && pid) {
      // いま記録が指しているプロジェクト（公開できた・保存場所だけ残った破棄・破棄のあとに公開し直した）
      teardownSettled.current = false
      setProjectId(pid)
      window.dispatchEvent(new Event('sakura-meta-changed'))
      const tk = latest.current.token ?? await getHanamiiToken()
      if (tk) await refreshStatus(pid, tk)
      return
    }
    // 記録に projectId が無い。破棄が「うまくいった」と言っているときだけ、消えた表示にする
    // （保存場所だけ残った回は、projectId も記録も残してある）。
    if (rec.handler === 'hanamii:teardown' && rec.result?.ok) await showTornDown()
  }
  const ops = useProjectOpsView(projectDir, isHanamiiOp, afterOpFinished)

  // 「↻ 状態を更新」。公開が「待つ時間のうちに動かなかった」で終わると、状態が BUILDING のまま残る。
  // 自動で確かめ続けはしない（そのために画面を開いておく必要は無い）ので、確かめ直す口をここに置く。
  const doRefreshStatus = async () => {
    if (!projectId || !token) return
    setStatusRefreshing(true); setStatusNote('')
    const ok = await refreshStatus(projectId, token)
    setStatusRefreshing(false)
    if (!ok) setStatusNote('HANAMII の状態を取得できませんでした。しばらくしてから、もう一度お試しください。')
  }

  // nameOverride: 衝突時の「代替名で公開し直す」ボタンから、state 更新の反映待ちをせず即座に使う名前を渡すため。
  const publish = async (nameOverride?: string) => {
    setMsgDetail(''); setMsgOk(false)
    setMsgKind('公開')
    if (!token) { setMsg('先に「認証情報」で HANAMII トークンを登録してください'); return }
    if (!workspaceId) { setMsg('ワークスペースを選択してください'); return }
    const { sendEnvs, persistEnvs, healthCheck, emptySecretKey } = buildEnvsAndHealthCheck(envs, hcEnabled, hcPath)
    if (emptySecretKey) { setMsg(`シークレット環境変数「${emptySecretKey}」の値が未入力です。値を入力してから公開してください（シークレットは保存されないため公開のたびに入力が必要です）。`); return }
    // 実行中フラグ（終了確認ダイアログ用）。中断・失敗でも必ず解除されるよう最外の finally で呼ぶ。
    const endActivity = beginActivity('公開処理', { closeWarning: PUBLISH_CLOSE_WARNING })
    // この公開を頼んだ時刻。main の記録の startedAt と同じ時計（同じパソコン）なので、
    // 「この公開の記録が残ったか」を、返り値のあとで確かめるのに使う（下の説明）。
    const askedAt = Date.now()
    // 呼んだときのプロジェクト。公開は最長およそ5分かかり、待っている間に別のプロジェクトへ切り替わりうる。
    // 返り値は**呼んだプロジェクトのもの**なので、いまの画面が別のプロジェクトになっていたら、画面へは入れない（掟11）。
    const dir = projectDir
    const stale = () => dirRef.current !== dir
    try {
      setPublishing(true); setMsg(''); ops.clearShown()
      // 公開名: 入力があればそれを、無ければフォルダ名を使う（いずれも safeName で正規化）
      const name = safeName((nameOverride ?? publishName).trim() || projName)
      setLastAttemptedName(name)
      // projectId はマウント時に読んだ写し（古いことがある）。無ければ main がディスクの記録で補う（hanamii:publish・二重作成の防止）。
      const r = await window.electronAPI.hanamii.publish(projectDir, { token, workspaceId, projectId: projectId ?? undefined, name, envs: sendEnvs, healthCheck, withStorage: withStorage && !!placement })
      if (stale()) {
        // 待っている間に別のプロジェクトへ切り替わった。この結果は前のプロジェクト（dir）のもの——いまの画面（別のプロジェクト）の
        // projectId・状態・メッセージへは入れない（入れると、別のプロジェクトの画面から前のアプリを再公開・破棄できてしまう）。
        // 設定（環境変数・ヘルスチェックなど）の保存だけは、公開したプロジェクト（saveHanamiiMeta は dir に束ねてある）の記録へ行う。
        const pid = r.ok ? (r.projectId ?? projectId) : null
        if (pid) {
          await saveHanamiiMeta(
            { projectId: pid, workspaceId, envs: persistEnvs, tokenId, healthCheck: { enabled: healthCheck.enabled, path: healthCheck.path }, name },
          ).catch(() => { /* 保存できなくても、公開の結果は記録が伝える */ })
        }
        return
      }
      setPublishing(false)
      // ── 結果（成功・失敗・警告・koto-data を差し替えた知らせ）は、main の記録から出す ─────────
      // 返り値をここで並べ直さない: 同じ結果が、閉じて開き直した画面にも同じ形で出るようにするため
      // （そして、ここと記録の両方から出して二重に見えることが無いように）。
      // ただし、**記録が作られない断り方**がある（同じプロジェクトで別の操作が走っている・トークン無し）。
      // 返り値のあとで記録を読み直し、この公開の記録が無いときだけ、返り値の文を出す。
      if (!r.ok) {
        await ops.sync()
        if (!ops.didFinishSince('hanamii:publish', askedAt)) { setMsg(r.message ?? '公開に失敗しました'); setMsgDetail(r.detail ?? '') }
        return
      }
      const pid = r.projectId ?? projectId
      if (pid) {
        teardownSettled.current = false
        setProjectId(pid)
        // 統一公開記録（publish.targets）と公開開始マーカーの後片づけは main 側（hanamii:publish）が
        // 済ませている（roadmap #20・main は1 invoke で完走するため、窓を閉じても記録が残る）。
        // ここでは設定値（projectId 等）だけを保存する。saveHanamiiMeta の readMeta→write が
        // main の書いた記録を読み直して保持し、sakura-meta-changed で画面へ反映する。
        await saveHanamiiMeta(
          { projectId: pid, workspaceId, envs: persistEnvs, tokenId, healthCheck: { enabled: healthCheck.enabled, path: healthCheck.path }, name },
        ).catch((e: any) => {
          // 設定の保存に失敗しても、公開の結果は記録が伝える。ここで黙ると、次に開いたとき設定が消えている理由が分からない。
          setMsg(`公開の依頼は受け付けられましたが、設定（環境変数・ヘルスチェックなど）を保存できませんでした: ${e?.message ?? String(e)}`)
        })
      }
      // 結果を読み直す（押し出しが先に届いていれば、何も足さない）。
      await ops.sync()
    } catch (e: any) {
      // main の本体が例外で終わったときも記録は残る（予期しない失敗として）。残っていなければ、ここで伝える。
      if (stale()) return
      await ops.sync()
      if (!ops.didFinishSince('hanamii:publish', askedAt)) setMsg(`公開処理でエラーが発生しました: ${e?.message ?? String(e)}`)
    } finally {
      // 切り替わったあとは、いまの画面（別のプロジェクト）の「公開中」の印を、前の公開の終わりで下ろさない。
      if (!stale()) setPublishing(false)
      endActivity()
    }
  }

  // A-5: env/ヘルスチェックの変更を「再公開（ビルドし直し）」なしで反映する高速経路。
  // 現在のフォーム内容（envs / hcEnabled / hcPath）を PATCH /env・PUT /health-check で保存してから
  // POST /restart する（main側の hanamii:restart がまとめて行う）。コード変更は反映されない
  // （その場合は既存の「再公開する」を使う）。
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartMsg, setRestartMsg] = useState('')
  const [restartMsgDetail, setRestartMsgDetail] = useState('')
  // restartMsg は成功（noop・反映しました）でも失敗でも使う共有欄。ErrorMessageBlock の
  // 「🤖 AIに相談する」を成功時に出さないため（判断2）、失敗かどうかをここで別に持つ。
  const [restartOk, setRestartOk] = useState(true)

  const doRestart = async () => {
    if (!projectId || !token) return
    setRestartMsg(''); setRestartMsgDetail(''); setRestartOk(true)
    const { sendEnvs, persistEnvs, healthCheck, emptySecretKey } = buildEnvsAndHealthCheck(envs, hcEnabled, hcPath)
    if (emptySecretKey) { setConfirmRestart(false); setRestartOk(false); setRestartMsg(`シークレット環境変数「${emptySecretKey}」の値が未入力です。値を入力してから再起動してください。`); return }
    setRestarting(true)
    const dir = projectDir
    const r = await window.electronAPI.hanamii.restart(projectId, { token, envs: sendEnvs, healthCheck })
    // 待っている間に別のプロジェクトへ切り替わったら、結果の文はいまの画面へ入れない（設定の保存は再起動したプロジェクト dir へ）。
    if (dirRef.current !== dir) {
      if (r.ok) await saveHanamiiMeta({ envs: persistEnvs, healthCheck: { enabled: healthCheck.enabled, path: healthCheck.path } }).catch(() => {})
      return
    }
    setRestarting(false); setConfirmRestart(false)
    if (!r.ok) { setRestartOk(false); setRestartMsg(r.message ?? '再起動に失敗しました'); setRestartMsgDetail(r.detail ?? ''); return }
    setRestartOk(true)
    setRestartMsg(r.noop ? '設定に変更がなかったため、再起動は不要でした。' : '✅ 再起動して設定を反映しました。')
    await saveHanamiiMeta({ envs: persistEnvs, healthCheck: { enabled: healthCheck.enabled, path: healthCheck.path } })
  }

  const loadLogs = useCallback(async () => {
    if (!projectId || !token) return
    setLogsLoading(true); setLogsError('')
    const asked = dirRef.current
    const r = await window.electronAPI.hanamii.logs(token, projectId, { limit: 100 })
    setLogsLoading(false)
    if (dirRef.current !== asked) return // 待っている間に別のプロジェクトへ切り替わった。前のプロジェクトのログは入れない
    if (r.ok) setLogs(r.logs ?? [])
    else setLogsError(r.message ?? 'ログの取得に失敗しました')
  }, [projectId, token])

  const toggleLogs = () => {
    const next = !logsOpen
    setLogsOpen(next)
    if (next && logs === null) loadLogs()
  }

  // タイムスタンプを HH:mm:ss に短縮する（パース不能ならそのまま返す）。
  const formatLogTime = (ts: string): string => {
    const d = new Date(ts)
    if (isNaN(d.getTime())) return ts
    return d.toLocaleTimeString('ja-JP', { hour12: false })
  }

  const teardown = async () => {
    if (!projectId || !token) return
    setMsg(''); setMsgDetail(''); setMsgOk(false)
    setMsgKind('破棄')
    // ── projectDir を必ず渡す（2026-09-25 検分の指摘1）──────────────────────
    // main は `.sakura-cloud/env.json` を読まないと、どの保存場所を片づけるのか分からない。
    // **渡さないと保存場所へ1件も要求が出ないまま ok:true が返り**、そのあと main が
    // 📡 公開したもの一覧の行（公開記録）ごと消すので、**片づけの入口が
    // どこにも無くなる**（🗑 破棄の行はこの記録からしか作られない）。
    // ＝バケットの月額495円と、バケットへ読み書きできる鍵が、辿れないまま残り続ける。
    const askedAt = Date.now()
    // 呼んだときのプロジェクト（公開と同じ・掟11）。切り替わったあとの結果は、いまの画面（別のプロジェクト）へ入れない。
    const dir = projectDir
    const stale = () => dirRef.current !== dir
    setConfirmDel(false); setTearingDown(true); ops.clearShown()
    try {
      const r = await window.electronAPI.hanamii.teardown(projectId, token, projectDir)
      // 待っている間に別のプロジェクトへ切り替わった。破棄の後始末（記録・保存場所の片づけ）は main が dir の記録に対して済ませている。
      // いまの画面は別のプロジェクトなので、「消えた」表示も、結果の文も、ここでは触らない。
      if (stale()) return
      // 消せたら、画面の表示を消えた状態にする。設定の projectId と公開記録の片づけは main が済ませている
      // （hanamii:teardown・鍵の中で1回だけ。画面が書くと、記録の再生で新しい公開の記録まで消える）。
      // 保存場所だけ残った回（appDeleted で ok が false）は、**記録も projectId も残る**——残さないと 🗑 が消えて、
      // 案内した「もう一度 🗑」がどこにも無くなる。main は 404（もう無い）なら保存場所の片づけだけをやり直す。
      if (r.ok) await showTornDown()
      // **何を片づけたか・何が残ったか**（残ったバケットの月額に気づけるように）は、main の記録の結果から出す。
      // 記録が作られない断り方（別の操作が走っている・トークン無し）のときだけ、返り値の文を出す。
      await ops.sync()
      if (!r.ok && !ops.didFinishSince('hanamii:teardown', askedAt)) setMsg(r.message ?? '削除に失敗しました')
    } catch (e: any) {
      if (stale()) return
      await ops.sync()
      if (!ops.didFinishSince('hanamii:teardown', askedAt)) setMsg(`破棄処理でエラーが発生しました: ${e?.message ?? String(e)}`)
    } finally {
      if (!stale()) setTearingDown(false)
    }
  }

  const rs = status?.readyState
  // 公開が進んでいるか（この画面が頼んだ直後・開き直した画面が main の記録で知ったもの・HANAMII 側の状態）。
  const publishRunning = publishing || ops.ownRunning?.handler === 'hanamii:publish'
  const teardownRunning = tearingDown || ops.ownRunning?.handler === 'hanamii:teardown'
  const busy = publishRunning || rs === 'BUILDING'
  // 押せない間（この画面の公開・破棄・別の公開先の操作を含め、同じプロジェクトでは1つずつしか走らせない・main の鍵）。
  // 断られてから文で知らせるのではなく、押せない形にして理由を出す。
  const locked = busy || teardownRunning || !!ops.running
  // 破棄の 2 つのボタン（🗑・破棄する）は、**main の鍵**（この画面が頼んだ公開・破棄・開き直した画面が記録で知った操作・
  // 別の公開先の操作）だけで止める。HANAMII 側の状態が BUILDING のままだからといって止めない（2026-09-30 検分）:
  // 公開が「待つ時間のうちに動かなかった（pending）」で終わると状態は BUILDING のまま残り、↻ で取り直しても変わらないことがある。
  // そのとき、止まったままの版を、この画面から破棄できなくなる（以前は破棄のボタンに disabled は無かった）。
  // main の鍵とは関係ない理由で、押せない理由も出さずに止めてはいけない。
  const teardownLocked = publishRunning || teardownRunning || !!ops.running
  // 名前衝突カード（NameConflictRetry）が表示されるケースでは、生の失敗メッセージ本体は
  // 折りたたみに降格してカードを主役にする（所見17: 親切カードと生エラーの二重表示の解消）。
  // 失敗の文は、この画面の局所のメッセージ（msg）と、main の記録が持つ公開の失敗（閉じて開き直しても出る）の両方から見る。
  const lastShown = ops.shown.length > 0 ? ops.shown[ops.shown.length - 1] : null
  const recordedPublishFailure = lastShown && lastShown.handler === 'hanamii:publish' && lastShown.result && !lastShown.result.ok
    ? (lastShown.result.message ?? '')
    : ''
  const conflictCardShown = !projectId && !busy && !!(msg || recordedPublishFailure) && isNameConflictError(msg || recordedPublishFailure)
  // 進み具合・別の操作の知らせ・結果（**公開のボタンのすぐ下**に出す。トークンが無い間も結果は見失わない）。
  const opsBlock = (
    <>
      {ops.ownRunning && <OpProgressCard rec={ops.ownRunning} />}
      {ops.foreignRunning && <OpForeignNote rec={ops.foreignRunning} />}
      {ops.shown.map(rec => <HanamiiOpResult key={rec.startedAt} rec={rec} demoted={conflictCardShown && rec === lastShown} />)}
    </>
  )

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-surface p-4 space-y-1">
        <p className="text-sm font-semibold text-ink">🌸 HANAMII（国産のクラウドサービス）で公開</p>
        <p className="text-xs text-ink-muted leading-relaxed">
          国産のクラウドサービス。サーバーで動き続けるアプリ（Node.js など）も公開できます（Koto がまとめてアップロードします。コンテナは不要です）。データは100%国内。
        </p>
        {getTargetProfile('hanamii').serviceUrl && (
          <p className="text-[11px] text-ink-muted">
            <a href={getTargetProfile('hanamii').serviceUrl} className="hover:underline">🌐 公式サイトを見る ↗</a>
          </p>
        )}
      </div>

      {/* ① APIトークン（AccessKeySection に統一・判断8） */}
      <AccessKeySection
        stepNo="①"
        serviceTitle="HANAMII"
        keyLabel="APIトークン"
        registered={!!token}
        onOpenCredentials={onOpenCredentials}
      >
        {!tokenLoaded && <p className="text-xs text-ink-muted">確認中…</p>}
        {tokenLoaded && !token && (
          <p className="text-xs text-ink-secondary leading-relaxed">
            HANAMII の管理画面で発行したAPIトークン（<span className="font-mono">hnm_…</span>）を登録してください（他のキーと同じ場所で一元管理します）。
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
      </AccessKeySection>

      {/* ② ワークスペース */}
      {token && (
        <section className="rounded-xl border border-line bg-surface p-4 space-y-2">
          <p className="text-sm font-semibold text-ink">② ワークスペース</p>
          {workspaces === null ? (
            <p className="text-xs text-ink-muted">取得中…</p>
          ) : workspaces.length === 0 ? (
            <p className="text-xs text-brand-yellow">ワークスペースがありません。HANAMII の管理画面で作成してください。</p>
          ) : workspaces.length === 1 ? (
            <p className="text-xs text-ink-secondary">{workspaces[0].name}</p>
          ) : (
            <select
              value={workspaceId}
              onChange={e => setWorkspaceId(e.target.value)}
              className="w-full bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink outline-none focus:border-sakura"
            >
              {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
        </section>
      )}

      {/* 環境変数（任意）。番号の無い補助の節（判断8・掟5「必ず通る節に番号、任意の設定・
          補助情報は無番号」2026-09-11 基準化）: 見出しの色・枠を薄くし「手順の外」と分かる
          見た目にする（番号付きの節の見た目は変えない・AppRun 共用型の「🌐 公開URL」と同じ形）。 */}
      {token && (
        <section className="rounded-xl border border-line-soft bg-surface p-4 space-y-2">
          <p className="text-sm font-semibold text-ink-secondary">環境変数（任意）</p>
          <p className="text-[11px] text-ink-muted leading-relaxed">
            アプリに渡すキーと値。APIキーなど秘密の値は「シークレット」に。シークレットは端末に保存されないため、公開のたびに入力が必要です。
          </p>
          {detectedKeys.filter(k => !envs.some(e => e.key.trim() === k)).length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] text-ink-muted">コードから検出（クリックで追加。🔒は秘密の候補）:</p>
              <div className="flex flex-wrap gap-1.5">
                {detectedKeys.filter(k => !envs.some(e => e.key.trim() === k)).map(k => (
                  <button
                    key={k}
                    onClick={() => setEnvs(prev => [...prev, { key: k, value: '', secret: guessSecret(k) }])}
                    className="text-[11px] font-mono px-2 py-1 rounded-md border border-line bg-overlay text-ink-secondary hover:border-sakura hover:text-ink"
                    title="この環境変数を追加"
                  >＋ {k}{guessSecret(k) ? ' 🔒' : ''}</button>
                ))}
              </div>
            </div>
          )}
          {envs.length > 0 && (
            <div className="space-y-2">
              {envs.map((e, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={e.key}
                    onChange={ev => setEnvs(prev => prev.map((x, j) => j === i ? { ...x, key: ev.target.value } : x))}
                    placeholder="KEY"
                    className="w-2/5 bg-surface border border-line rounded-lg px-2 py-1.5 text-xs text-ink font-mono outline-none focus:border-sakura"
                  />
                  <input
                    value={e.value}
                    onChange={ev => setEnvs(prev => prev.map((x, j) => j === i ? { ...x, value: ev.target.value } : x))}
                    type={e.secret ? 'password' : 'text'}
                    placeholder={e.secret ? '値（保存されません）' : '値'}
                    className="flex-1 bg-surface border border-line rounded-lg px-2 py-1.5 text-xs text-ink font-mono outline-none focus:border-sakura"
                  />
                  <label className="flex items-center gap-1 text-[11px] text-ink-secondary select-none whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={e.secret}
                      onChange={ev => setEnvs(prev => prev.map((x, j) => j === i ? { ...x, secret: ev.target.checked } : x))}
                    />
                    秘密
                  </label>
                  <button
                    onClick={() => setEnvs(prev => prev.filter((_, j) => j !== i))}
                    className="flex-none text-ink-muted hover:text-brand-red text-sm"
                    title="削除"
                  >✕</button>
                </div>
              ))}
            </div>
          )}
          <button
            onClick={() => setEnvs(prev => [...prev, { key: '', value: '', secret: false }])}
            className="text-xs text-sakura hover:underline"
          >＋ 変数を追加</button>
        </section>
      )}

      {/* ヘルスチェック（任意）。番号の無い補助の節（判断8・2026-09-11 基準化）。 */}
      {token && (
        <section className="rounded-xl border border-line-soft bg-surface p-4 space-y-2">
          <p className="text-sm font-semibold text-ink-secondary">ヘルスチェック（任意）</p>
          <p className="text-[11px] text-ink-muted leading-relaxed">
            アプリが正常に動いているか、公開後に自動で確認するパス（任意）。
          </p>
          <label className="flex items-center gap-2 text-xs text-ink-secondary select-none">
            <input
              type="checkbox"
              checked={hcEnabled}
              onChange={ev => setHcEnabled(ev.target.checked)}
            />
            ヘルスチェックを有効にする
          </label>
          {hcEnabled && (
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-ink-secondary flex-none">パス</label>
              <input
                value={hcPath}
                onChange={ev => setHcPath(ev.target.value)}
                placeholder="/"
                className="flex-1 bg-surface border border-line rounded-lg px-2 py-1.5 text-xs text-ink font-mono outline-none focus:border-sakura"
              />
            </div>
          )}
        </section>
      )}

      {/* ③ セキュリティチェック（公開の前に・2026-08-21 Ryosuke 指定。番号は2026-09-04 付番） */}
      <SecurityCheckSection projectDir={projectDir} apiKey={apiKey} stepNo="③" />

      {/* ④ 未使用ファイルの検出＋片づけ（roadmap #18。番号は2026-09-04 付番） */}
      <UnusedFilesSection projectDir={projectDir} stepNo="④" />

      {/* ⑤ 公開 */}
      {token && (
        <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
          <p className="text-sm font-semibold text-ink">⑤ 公開</p>
          <div>
            <label className="text-[11px] font-medium text-ink-secondary">公開名（半角英数字とハイフン・任意）</label>
            <input
              value={publishName}
              onChange={e => setPublishName(e.target.value)}
              placeholder={safeName(projName)}
              disabled={!!projectId}
              className="mt-1 w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink placeholder-ink-muted outline-none focus:border-sakura disabled:opacity-50"
            />
            <p className="mt-1 text-[11px] text-ink-muted leading-relaxed">
              {projectId
                ? '公開済みのため名前は変更できません（変更するには「破棄」してから公開し直してください）。'
                : '公開に失敗する場合、下に表示される代替名の提案からワンクリックで変更できます。'}
            </p>
          </div>
          {/* ── データの保存を持っていく（2026-08-15）──────────────────────
              データはオブジェクトストレージにあり、**計算とは別の場所**にある。
              だから公開先を変えても、同じデータをそのまま読める。
              **何が持っていかれるのかを見せる**（黙って鍵を配らない）。 */}
          {placement && (
            <div className="rounded-lg border border-line bg-overlay p-3 space-y-1.5">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={withStorage}
                  onChange={e => setWithStorage(e.target.checked)}
                  disabled={busy}
                  className="mt-0.5 accent-sakura"
                />
                <span className="text-[11px] text-ink-secondary leading-relaxed">
                  <span className="text-ink font-medium">💾 データの保存を持っていく</span>
                  <br />
                  保存場所 <span className="font-mono">{placement.bucket}</span>
                  {placement.prefix && <span className="font-mono"> / {placement.prefix}</span>}
                  {' '}を読み書きできるようにします（公開のたびに新しい鍵を発行します）。
                  <b className="text-ink">このプロジェクトのほかの公開先（AppRun など）</b>と同じデータを使うので、
                  どちらかで消したものは、もう一方からも消えます。
                </span>
              </label>
              {!usesData && (
                <p className="text-[11px] text-ink-muted leading-relaxed">
                  ※ このアプリは、いまのところデータの保存（koto-data）を使っていないようです。
                </p>
              )}
            </div>
          )}

          <button
            onClick={() => publish()}
            disabled={locked || !workspaceId}
            className="w-full sakura-gradient text-white rounded-lg px-4 py-2.5 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
          >{busy ? '公開中…' : teardownRunning ? '破棄中…' : publishButtonLabel(!!projectId)}</button>

          {opsBlock}

          {/* 公開名の衝突（重複）時: ワンクリックで代替名に変えて公開し直す（初回公開のみ。redeploy は対象外）。 */}
          {conflictCardShown && (
            <NameConflictRetry
              currentName={lastAttemptedName || safeName(publishName.trim() || projName)}
              maxLen={HANAMII_NAME_MAX_LEN}
              onRetry={suggested => { setPublishName(suggested); publish(suggested) }}
            />
          )}

          {/* A-5: env/ヘルスチェックだけを変更したときの高速経路（コード変更は反映されない。その場合は上の「再公開する」を使う）。
              公開済みプロジェクトがあるときのみ表示。 */}
          {projectId && (
            <div className="border-t border-line pt-2 space-y-2">
              {confirmRestart ? (
                <div className="rounded-lg border border-line bg-overlay p-3 space-y-2">
                  <p className="text-xs text-ink-secondary leading-relaxed select-text">
                    アプリが数十秒間停止します。再起動して設定（環境変数・ヘルスチェック）を反映しますか？
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={doRestart}
                      disabled={restarting}
                      className="bg-overlay text-ink border border-sakura/50 rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-sakura/10 disabled:opacity-40"
                    >{restarting ? '再起動中…' : '再起動する'}</button>
                    <button
                      onClick={() => setConfirmRestart(false)}
                      disabled={restarting}
                      className="bg-overlay text-ink border border-line rounded-lg px-3 py-1.5 text-xs disabled:opacity-40"
                    >やめる</button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmRestart(true)}
                  disabled={locked || restarting}
                  className="text-xs text-ink-secondary hover:text-ink disabled:opacity-40"
                  title="作ったもの（コード）の変更は反映されません。変更を反映するには、上の「🚀 公開する（更新）」を押してください。"
                >🔄 再起動して設定だけ反映（環境変数・ヘルスチェック）</button>
              )}
              {restartMsg && <ErrorMessageBlock msg={restartMsg} detail={restartMsgDetail} demoted={false} kind="再公開" target="HANAMII" ok={restartOk} />}
            </div>
          )}

          {/* 公開が進んでいる間は、上の進み具合の枠が主役（前の版の状態を並べて紛らわしくしない）。 */}
          {status && !publishRunning && (
            <div className="rounded-lg border border-line bg-overlay p-3 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-ink-secondary">
                  状態: {rs === 'READY' ? '✅ 公開済み' : rs === 'ERROR' ? '⚠️ 失敗' : rs === 'BUILDING' ? '⏳ HANAMII が公開処理中です…' : rs ?? '—'}
                </p>
                {projectId && (
                  <button
                    onClick={doRefreshStatus}
                    disabled={statusRefreshing || !token}
                    title="HANAMII の状態を取り直します（何も作りません）"
                    className="flex-none text-[11px] text-ink-muted hover:underline disabled:opacity-50"
                  >{statusRefreshing ? '確かめています…' : '↻ 状態を更新'}</button>
                )}
              </div>
              {statusNote && <p className="text-[11px] text-brand-red leading-relaxed select-text">{statusNote}</p>}
              {/* runtime（ヘルス）の表示判定（2026-07-13 ユーザー実機報告: 公開直後に赤⚠が出るのは早すぎる）:
                  - 公開処理中（busy）→ 何も出さない（「⏳ 公開処理中…」のみ）
                  - healthy → 緑で正常
                  - unknown / 値なし → まだヘルス情報が届いていないだけ（起動直後は数十秒かかる）
                    なので中立トーンの「動作確認中」（赤⚠にしない）
                  - それ以外（unhealthy 等の明示異常）→ 赤⚠＋ログへの誘導 */}
              {!busy && status.runtime?.status && (
                status.runtime.status === 'healthy' ? (
                  <p className="text-xs text-brand-green">
                    🩺 アプリの状態: 正常{(() => { const t = formatSyncedAt(status.runtime.syncedAt); return t ? `（${t}確認）` : '' })()}
                  </p>
                ) : status.runtime.status === 'unknown' ? (
                  <p className="text-[11px] text-ink-muted leading-relaxed">
                    🩺 動作確認中…（起動直後は状態の反映まで数十秒かかることがあります。「↻ 状態を更新」で再確認できます）
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    <p className="text-xs text-brand-red">
                      ⚠️ アプリが応答していません（状態: {status.runtime.status}）
                    </p>
                    {status.runtime.detail && (
                      <p className="text-[11px] text-ink-muted leading-relaxed select-text">{status.runtime.detail}</p>
                    )}
                    <p className="text-[11px] text-ink-muted">下の「📋 ログを見る」で原因を確認できます</p>
                  </div>
                )
              )}
              {status.url && rs === 'READY' && (
                <div className="flex items-center gap-2 flex-wrap">
                  <a href={status.url} className="inline-block text-sm text-sakura hover:underline break-all font-semibold">🌐 {status.url}</a>
                  <CopyButton text={status.url} title="公開URLをコピー" />
                </div>
              )}
              {rs === 'ERROR' && (
                <div className="space-y-1 pt-1">
                  <p className="text-xs text-brand-red leading-relaxed select-text">
                    {describeErrorCode(status.errorCode) || '公開に失敗しました。詳細は HANAMII の管理画面をご確認ください。'}
                  </p>
                  <a href="https://hanamii.jp" className="inline-block text-xs text-sakura hover:underline">HANAMII の管理画面で詳細を見る ↗</a>
                </div>
              )}
            </div>
          )}

          {projectId && (
            <div className="border-t border-line pt-2 space-y-2">
              <button onClick={toggleLogs} className="text-xs text-ink-secondary hover:text-ink">
                {logsOpen ? '▾' : '▸'} 📋 ログを見る
              </button>
              {logsOpen && (
                <div className="space-y-2">
                  <div className="flex items-center justify-end">
                    <button
                      onClick={loadLogs}
                      disabled={logsLoading}
                      className="text-[11px] text-sakura hover:underline disabled:opacity-40"
                    >↻ 再取得</button>
                  </div>
                  {logsLoading ? (
                    <p className="text-xs text-ink-muted">取得中…</p>
                  ) : logsError ? (
                    <div className="rounded-lg border border-brand-red/60 bg-brand-red/10 p-2">
                      <p className="text-xs text-brand-red select-text">{logsError}</p>
                    </div>
                  ) : logs && logs.length === 0 ? (
                    <p className="text-xs text-ink-muted">ログはまだありません</p>
                  ) : logs && logs.length > 0 ? (
                    // 端末風の固定ダーク背景（両テーマで白文字が読める）。以前の bg-ink/90 は
                    // CSS変数色にopacity修飾が効かず背景が透明になり、ライトモードで白文字が
                    // 見えなくなっていた（2026-07-13 ユーザー実機報告）。
                    <div className="rounded-lg border border-line bg-[#1c1c22] p-2 max-h-64 overflow-y-auto select-text">
                      {logs.map((l, i) => (
                        <p key={i} className="font-mono text-[11px] leading-relaxed text-white/90 whitespace-pre-wrap break-all">
                          <span className="text-white/50">{formatLogTime(l.timestamp)}</span> {l.message}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          )}

          {projectId && (
            confirmDel ? (
              <div className="rounded-lg border border-brand-red/60 bg-overlay p-3 space-y-2">
                <p className="text-xs text-brand-red font-semibold">この公開を破棄（削除）します。公開URLは無効になります。</p>
                {/* ── データが消えることを、言わずに押させない（2026-09-25 検分の指摘1）──────
                    この 🗑 は 📡 公開したもの一覧の 🗑 とまったく同じ口（hanamii:teardown に
                    projectDir を渡す）を通り、**保存場所のデータも消す**。同じ振る舞いなら
                    同じことを言う（掟5「同じ画面の同じボタンで振る舞いを変えない」）。
                    文の組み立ては shared/teardownSupport.ts の純関数に任せる（掟10）。
                    **全件（placements）で組み立てる**——1件だけ名指しすると、名前が出なかった
                    保存場所とデータまで消える（指摘5）。 */}
                {teardownDataNoteForAll({ target: 'hanamii', scope: 'list', placements }) && (
                  <p className="text-xs text-brand-red leading-relaxed select-text">
                    💾 {teardownDataNoteForAll({ target: 'hanamii', scope: 'list', placements })}
                  </p>
                )}
                <div className="flex gap-2">
                  <button onClick={teardown} disabled={teardownLocked} className="bg-brand-red-fill text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-40">破棄する</button>
                  <button onClick={() => setConfirmDel(false)} className="bg-overlay text-ink border border-line rounded-lg px-3 py-1.5 text-xs">やめる</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setConfirmDel(true)} disabled={teardownLocked} className="text-xs text-ink-muted hover:text-brand-red disabled:opacity-40">🗑 この公開を破棄する</button>
            )
          )}
        </section>
      )}

      {/* トークンを消した・まだ読めていない間も、進み具合と結果は見失わない（公開の節ごと隠れるため、ここに出す）。 */}
      {!token && (ops.ownRunning || ops.foreignRunning || ops.shown.length > 0) && <div className="space-y-3">{opsBlock}</div>}

      {msg && <ErrorMessageBlock msg={msg} detail={msgDetail} demoted={conflictCardShown} kind={msgKind} target="HANAMII" ok={msgOk} />}
    </div>
  )
}

// 失敗メッセージの表示ブロック。
// - detail（生API応答のJSON短縮）があれば <details>「詳細を見る」で折りたたみ表示する（所見11:
//   生JSONを文言に混ぜない。ただし過去に原因究明で役立った実績があるため、折りたたみで残す）。
// - demoted=true（名前衝突カード等の親切カードが主役のケース・所見17）ではメッセージ本体ごと折りたたみに降格する。
function ErrorMessageBlock({ msg, detail, demoted, kind, target, ok = false }: { msg: string; detail: string; demoted: boolean; kind: AskAiFailureKind; target: string; ok?: boolean }) {
  const copyText = detail ? `${msg}\n${detail}` : msg
  // 判断2: 「🤖 AIに相談する」を既存の内容の下に添える。成功時（ok=true）には出さない——
  // このブロックは主に失敗専用（msg）だが、HANAMIIの「🔄 再起動」だけは成功メッセージも
  // 同じ欄（restartMsg）に流すため、ok を明示的に受け取る（既定 false=失敗）。
  const askAiText = ok ? null : askAiAboutFailure(kind, target, msg, detail)
  const body = (
    <>
      <div className="flex items-start gap-2">
        <p className="flex-1 text-xs text-ink-secondary leading-relaxed whitespace-pre-wrap break-all select-text">{msg}</p>
        <button
          onClick={() => { navigator.clipboard.writeText(copyText).catch(() => {}) }}
          className="flex-none text-[11px] text-sakura hover:underline"
          title="メッセージをコピー"
        >コピー</button>
      </div>
      {detail && !demoted && (
        <details>
          <summary className="text-[11px] text-ink-muted cursor-pointer select-none hover:text-ink">詳細を見る</summary>
          <pre className="mt-1 text-[11px] text-ink-muted font-mono leading-relaxed whitespace-pre-wrap break-all select-text">{detail}</pre>
        </details>
      )}
      {detail && demoted && (
        <pre className="text-[11px] text-ink-muted font-mono leading-relaxed whitespace-pre-wrap break-all select-text">{detail}</pre>
      )}
      {askAiText && (
        <button
          onClick={() => {
            window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text: askAiText } }))
          }}
          className="bg-sakura text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
        >🤖 AIに相談する</button>
      )}
    </>
  )
  if (demoted) {
    return (
      <details className="rounded-lg border border-line bg-overlay p-3">
        <summary className="text-[11px] text-ink-muted cursor-pointer select-none hover:text-ink">詳細を見る（元のエラーメッセージ）</summary>
        <div className="mt-2 space-y-2">{body}</div>
      </details>
    )
  }
  return <div className="rounded-lg border border-line bg-overlay p-3 space-y-2">{body}</div>
}

// 公開名の衝突（重複）時に表示する、ワンクリックで代替名に変えて公開し直すブロック。
// suggested は currentName（≒直近に失敗した名前）が変わるたびに新しく算出する。
// 「代替名でもまた衝突」→ lastAttemptedName が新しい代替名に更新される → currentName が変わるので、
// 再衝突のたびに新しいランダムな候補が出る（同じ base に対しては再レンダーしても安定させる）。
function NameConflictRetry({ currentName, maxLen, onRetry }: { currentName: string; maxLen: number; onRetry: (suggested: string) => void }) {
  const suggested = useMemo(() => suggestAlternativeName(currentName, maxLen), [currentName, maxLen])
  return (
    <div className="rounded-lg border border-brand-yellow/70 bg-overlay p-3 space-y-2">
      <p className="text-xs text-ink font-semibold">⚠️ この公開名（{currentName}）は既に使われています。</p>
      <button
        onClick={() => onRetry(suggested)}
        className="text-xs text-sakura border border-sakura/50 rounded-md px-2.5 py-1.5 hover:bg-overlay"
      >『{suggested}』に変えて公開し直す</button>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// 公開・破棄の「進み具合と結果」（main の処理の記録を読んで出す）— 2026-09-29
//
// ここから下は **HanamiiPanel と VercelPanel が共用する**表示の部品（Vercel は './HanamiiPanel' から import する）。
// 記録を読む・「見た」と伝える部分は共通の1か所にある（掟10・2026-09-30 検分の指摘2）:
//   ・フック … src/renderer/hooks/useProjectOpsView.ts（読み方は src/renderer/projectOpsView.ts の watchProjectOps／ackUpToFor）
//   ・警告・時刻の文 … src/shared/opsText.ts（warningLine／opWarningText／clockText）
// 記録の持ち主は main（src/main/projectOps.ts・メモリ上）。画面が持つのは、開いている間の表示の状態だけ。
// ════════════════════════════════════════════════════════════════════════════

/** いま走っている、自分の公開先の操作の進み具合。閉じて開き直しても、続きから出る。 */
export function OpProgressCard({ rec }: { rec: ProjectOpRecordShape }) {
  const p = rec.progress
  const pct = p && typeof p.step === 'number' && typeof p.total === 'number' && p.total >= 1
    ? Math.min(100, Math.max(0, Math.round((p.step / p.total) * 100)))
    : null
  const what = rec.op === '削除' ? '破棄' : rec.op === '作成' ? '作成' : '公開'
  const clock = clockText(rec.startedAt)
  return (
    <div className="rounded-lg border border-line bg-overlay p-3 space-y-1.5" role="status">
      <p className="text-xs font-semibold text-ink">⏳ {what}が進んでいます</p>
      {p?.label && <p className="text-xs text-ink-secondary leading-relaxed select-text">{p.label}</p>}
      {p?.detail && <p className="text-[11px] text-ink-muted leading-relaxed select-text">{p.detail}</p>}
      {pct !== null && (
        <div className="h-1.5 rounded-full bg-line overflow-hidden">
          <div className="h-full bg-sakura" style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="text-[11px] text-ink-muted leading-relaxed">
        {clock ? `${clock} に始まりました。` : ''}この画面を閉じても、処理は最後まで進みます（開き直すと、ここに続きが出ます）。
        {rec.op === '公開' ? PUBLISH_QUIT_STOPS : ''}
      </p>
    </div>
  )
}

/** 別の公開先の操作が走っているときの1行（詳細は出さない・掟11）。 */
export function OpForeignNote({ rec }: { rec: ProjectOpRecordShape }) {
  const names: Record<string, string> = {
    'sakura-apprun': 'さくらのAppRun', 'sakura-apprun-dedicated': 'さくらのAppRun 専有型', hanamii: 'HANAMII', vercel: 'Vercel',
  }
  const where = names[rec.target] ?? ''
  return (
    <p className="text-[11px] text-ink-muted leading-relaxed">
      このプロジェクトでは別の操作（{rec.op}{where ? `・${where}` : ''}）が進んでいます。終わるまで、この画面の公開などの操作は押せません。
    </p>
  )
}

/** 見逃してはいけない知らせ（まだ動いていない・確かめられなかった・古い鍵が残った…）。黄色の枠で1件ずつ。 */
export function OpWarnings({ warnings }: { warnings: string[] }) {
  if (!warnings || warnings.length === 0) return null
  return (
    <div className="space-y-1.5">
      {warnings.map((w, i) => (
        <div key={i} className="rounded-lg border border-brand-yellow/70 bg-elevated p-2.5 flex items-start gap-2">
          <p className="flex-1 text-xs text-ink-secondary leading-relaxed whitespace-pre-wrap break-all select-text">⚠️ {opWarningText(w)}</p>
          <CopyButton text={opWarningText(w)} title="知らせをコピー" />
        </div>
      ))}
    </div>
  )
}

/** 終わった HANAMII の公開・破棄1件を、結果と警告として出す。 */
function HanamiiOpResult({ rec, demoted }: { rec: ProjectOpRecordShape; demoted: boolean }) {
  const res = rec.result
  const isDelete = rec.op === '削除'
  const head = `${isDelete ? '🗑 破棄' : '🚀 公開'}の結果（${clockText(rec.startedAt)} に始まった操作）`
  if (!res) {
    return (
      <div className="space-y-2">
        <p className="text-[11px] text-ink-muted">{head}</p>
        <p className="text-xs text-ink-secondary leading-relaxed">結果を読み取れませんでした。HANAMII の管理画面で状態を確かめてください。</p>
      </div>
    )
  }
  const deployState = res.extra?.deployState
  // 失敗の文（あれば）と、うまくいったときの見出し。**確かめていないことを「動いた」と言わない**
  // （ok は「依頼が受け付けられた」の意味。動いたかは deployState が言う）。
  let failure: string | null = null
  let title = ''
  if (isDelete) {
    if (res.ok) title = '✅ 破棄しました。'
    else if (res.extra?.appDeleted === true) failure = `HANAMII のプロジェクトは削除しました。ただし、保存場所は片づけられませんでした: ${res.message ?? '原因不明'}`
    else failure = res.message ?? '削除に失敗しました'
  } else if (!res.ok) {
    failure = res.message ?? '公開に失敗しました'
  } else if (deployState === 'ready') {
    title = '✅ 公開できました。新しい版が動いたことを確かめました。'
  } else if (deployState === 'pending' || deployState === 'unknown') {
    title = '⚠️ 公開の依頼は受け付けられましたが、新しい版が動いたとは確かめられていません。'
  } else {
    title = '✅ 公開の依頼が受け付けられました。'
  }
  const lines = res.lines ?? []
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-ink-muted">{head}</p>
      {failure !== null
        ? <ErrorMessageBlock msg={failure} detail={res.detail ?? ''} demoted={demoted} kind={isDelete ? '破棄' : '公開'} target="HANAMII" ok={false} />
        : <p className="text-xs font-semibold text-ink leading-relaxed select-text">{title}</p>}
      {failure === null && res.url && (
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
      <OpWarnings warnings={res.warnings ?? []} />
    </div>
  )
}
