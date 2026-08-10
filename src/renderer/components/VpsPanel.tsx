import { useState, useEffect, useCallback } from 'react'
import { getVpsCredentials, getVpsCredentialsById, listVpsEntries, saveVpsKeypair } from './CredentialsModal'
import { beginActivity } from '../activity'
import CopyButton from './CopyButton'

// さくらのVPS 公開機能 V1a: 「① 接続」のみ（②初期セットアップ・③公開は次フェーズ。ここでは作らない）。
// docs/vps-plan.md の「決定事項（2026-07-18）」に基づき、接続は2ルート:
//   ルートA（推奨・新規/作り直してよいVPS）: IDEが鍵を生成し、公開鍵だけを埋め込んだ初期設定スクリプトを
//     さくらのVPS コントロールパネルの「マイスクリプト」へ登録してもらう（Kotoはパスワードを一切扱わない）。
//   ルートB（既存VPSを残したい場合）: 初回のみパスワードで接続して鍵を設置し、鍵認証の疎通確認が取れてから
//     初めてパスワード認証を無効化する（締め出し防止・順序保証）。
// AIチャットのツール（aiTools.ts）にはこのパネルのIPC（vps:*）を一切公開しない。

interface Props {
  projectDir: string
  onOpenCredentials: () => void
}

interface HostInfo { host: string; port: number; user: string }
interface KeyPair { publicKey: string; privateKey: string }

export default function VpsPanel({ projectDir, onOpenCredentials }: Props) {
  const metaPath = `${projectDir}/.sakuraide.json`

  const [entryId, setEntryId] = useState<string | null>(null)
  const [entries, setEntries] = useState<{ id: string; label: string; host: string }[] | null>(null)
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null)
  const [keys, setKeys] = useState<KeyPair | null>(null)
  const [credLoaded, setCredLoaded] = useState(false)
  const [route, setRoute] = useState<'A' | 'B'>('A')

  // ルートA
  const [script, setScript] = useState('')
  const [genBusy, setGenBusy] = useState(false)
  const [genMsg, setGenMsg] = useState('')

  // ルートB（初回パスワードは state のみで保持し、保存しない。処理後は即クリア）
  const [initialUser, setInitialUser] = useState('root')
  const [initialPassword, setInitialPassword] = useState('')
  const [installBusy, setInstallBusy] = useState(false)
  const [installMsg, setInstallMsg] = useState('')

  // 共有: 接続確認・ホスト鍵指紋（TOFU）
  const [testBusy, setTestBusy] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [fpAlert, setFpAlert] = useState<string | null>(null) // ホスト鍵の指紋不一致（赤で中断・バイパス不可）
  const [hardened, setHardened] = useState(false)

  const readMeta = useCallback(async (): Promise<any> => {
    try { return JSON.parse(await window.electronAPI.fs.readFile(metaPath)) } catch { return {} }
  }, [metaPath])

  // HanamiiPanel/VercelPanel と同じく、このプロジェクトの公開先を 'sakura-vps' として記録する
  // （PublishModal を再度開いたときに同じパネルへ戻れるようにするため）。
  const saveVpsMeta = useCallback(async (v: Record<string, unknown>) => {
    const m = await readMeta()
    const next = {
      ...m,
      target: 'sakura-vps',
      publish: {
        ...(m.publish ?? {}),
        vps: { ...(m.publish?.vps ?? {}), ...v },
      },
    }
    await window.electronAPI.fs.writeFile(metaPath, JSON.stringify(next, null, 2))
    window.dispatchEvent(new Event('sakura-meta-changed'))
  }, [metaPath, readMeta])

  const applyCred = (c: Awaited<ReturnType<typeof getVpsCredentials>>) => {
    setHostInfo(c && c.host ? { host: c.host, port: c.port, user: c.user } : null)
    setKeys(c && c.publicKey && c.privateKey ? { publicKey: c.publicKey, privateKey: c.privateKey } : null)
  }

  const loadEntries = useCallback(async (preferredId?: string | null) => {
    const { entries: list, activeId } = await listVpsEntries()
    setEntries(list)
    if (list.length === 0) return null
    const chosen = (preferredId && list.some(e => e.id === preferredId))
      ? preferredId
      : (activeId && list.some(e => e.id === activeId))
        ? activeId
        : list[0].id
    setEntryId(chosen)
    return chosen
  }, [])

  const switchEntry = useCallback(async (id: string) => {
    setEntryId(id)
    applyCred(await getVpsCredentialsById(id))
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const m = await readMeta()
      const v = m.publish?.vps
      if (typeof v?.hostKeyFingerprint === 'string' && v.hostKeyFingerprint) setFingerprint(v.hostKeyFingerprint)
      if (v?.sshdHardened) setHardened(true)

      const chosen = await loadEntries(v?.entryId ?? null)
      if (cancelled) return
      const c = chosen ? await getVpsCredentialsById(chosen) : await getVpsCredentials()
      if (cancelled) return
      applyCred(c)
      setCredLoaded(true)
    })()
    const onCredChange = async () => {
      const chosen = await loadEntries(entryId)
      const c = chosen ? await getVpsCredentialsById(chosen) : await getVpsCredentials()
      applyCred(c)
    }
    window.addEventListener('sakura:credentials-changed', onCredChange)
    return () => { cancelled = true; window.removeEventListener('sakura:credentials-changed', onCredChange) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir])

  // ルートA: 鍵が確定したら、その公開鍵から初期設定スクリプトを都度生成する（毎回同じ内容・冪等）。
  useEffect(() => {
    if (!keys?.publicKey) { setScript(''); return }
    let cancelled = false
    window.electronAPI.vps.buildStartupScript(keys.publicKey).then(r => {
      if (!cancelled) setScript(r.ok ? (r.script ?? '') : '')
    })
    return () => { cancelled = true }
  }, [keys?.publicKey])

  // 鍵が無ければ生成して中央ストア（認証情報）へ自動保存する。あれば何もせずそれを返す。
  const ensureKey = async (): Promise<KeyPair | null> => {
    if (keys) return keys
    setGenBusy(true); setGenMsg('')
    try {
      const g = await window.electronAPI.vps.generateKeypair()
      if (!g.ok || !g.publicKey || !g.privateKey) { setGenMsg(g.message || '鍵の生成に失敗しました'); return null }
      const saved = await saveVpsKeypair(entryId, { publicKey: g.publicKey, privateKey: g.privateKey })
      if (!saved.ok) { setGenMsg(saved.message || '鍵の保存に失敗しました'); return null }
      setEntryId(saved.id)
      const k = { publicKey: g.publicKey, privateKey: g.privateKey }
      setKeys(k)
      return k
    } finally { setGenBusy(false) }
  }

  // 鍵認証での疎通確認（ルートA・ルートB共通）。指紋が未記録なら今回のスキャン結果を初回記録（TOFU）、
  // 記録済みなら main 側（runSsh）が既知の指紋と比較し、不一致なら接続そのものを中断してエラーを返す。
  const testConnection = async () => {
    if (!hostInfo || !keys) return
    setTestBusy(true); setTestResult(null); setFpAlert(null)
    // 実行中フラグ（終了確認ダイアログ用）。中断・失敗でも必ず解除されるよう finally で呼ぶ。
    const endActivity = beginActivity('VPSの処理')
    try {
      let fp = fingerprint
      if (!fp) {
        const scan = await window.electronAPI.vps.scanHostKey(hostInfo.host, hostInfo.port)
        if (!scan.ok || !scan.fingerprint) { setTestResult({ ok: false, message: scan.message || 'ホスト鍵を取得できませんでした' }); return }
        fp = scan.fingerprint
      }
      const r = await window.electronAPI.vps.testConnection(hostInfo.host, hostInfo.port, hostInfo.user, keys.privateKey, fp)
      if (!r.ok) {
        if ((r.message ?? '').includes('指紋が記録済みの値と一致しません')) { setFpAlert(r.message ?? ''); return }
        setTestResult({ ok: false, message: r.message ?? '接続に失敗しました' })
        return
      }
      if (!fingerprint) {
        setFingerprint(fp)
        await saveVpsMeta({ entryId, host: hostInfo.host, port: hostInfo.port, hostKeyFingerprint: fp, keyVerifiedAt: new Date().toISOString() })
      } else {
        await saveVpsMeta({ keyVerifiedAt: new Date().toISOString() })
      }
      setTestResult({ ok: true })
    } finally { setTestBusy(false); endActivity() }
  }

  // ルートB: 鍵を設置 → 鍵認証で疎通確認 →（確認できてから）sshd強化、を1つの流れとして実行する。
  // どの段階で失敗しても、それ以前の段階の結果は保たれる（例: 鍵設置は成功したが疎通確認に失敗した場合、
  // パスワード認証は無効化されない＝締め出さない）。
  const installAndSecure = async () => {
    if (!hostInfo || !initialPassword) return
    setInstallBusy(true); setInstallMsg(''); setFpAlert(null); setTestResult(null)
    // 実行中フラグ（終了確認ダイアログ用）。中断・失敗でも必ず解除されるよう finally で呼ぶ。
    const endActivity = beginActivity('VPSの処理')
    try {
      setInstallMsg('鍵を準備しています…')
      const k = await ensureKey()
      if (!k) { setInstallMsg(genMsg || '鍵の準備に失敗しました'); return }

      setInstallMsg('パスワードで接続し、鍵を設置しています…')
      const r = await window.electronAPI.vps.installKeyWithPassword(hostInfo.host, hostInfo.port, initialUser.trim() || 'root', initialPassword, k.publicKey)
      if (!r.ok) { setInstallMsg(r.message || '鍵の設置に失敗しました'); return }

      let fp = fingerprint
      if (r.fingerprint && !fp) {
        fp = r.fingerprint
        setFingerprint(fp)
        await saveVpsMeta({ entryId, host: hostInfo.host, port: hostInfo.port, hostKeyFingerprint: fp })
      }
      if (!fp) { setInstallMsg('鍵は設置しましたが、ホスト鍵の指紋が確認できませんでした。「接続を確認」を押して再度お試しください。'); return }

      setInstallMsg('鍵認証で接続を確認しています…')
      const check = await window.electronAPI.vps.testConnection(hostInfo.host, hostInfo.port, hostInfo.user, k.privateKey, fp)
      if (!check.ok) {
        if ((check.message ?? '').includes('指紋が記録済みの値と一致しません')) { setFpAlert(check.message ?? ''); setInstallMsg(''); return }
        setInstallMsg(`鍵は設置しましたが、鍵認証での接続確認に失敗しました: ${check.message ?? ''}`)
        return
      }
      await saveVpsMeta({ keyVerifiedAt: new Date().toISOString() })
      setTestResult({ ok: true })

      setInstallMsg('パスワード認証を無効化しています…')
      const harden = await window.electronAPI.vps.hardenSshd(hostInfo.host, hostInfo.port, hostInfo.user, k.privateKey, fp)
      if (!harden.ok) { setInstallMsg(`鍵認証での接続は確認できましたが、パスワード認証の無効化に失敗しました: ${harden.message ?? ''}（鍵認証自体は有効です）`); return }
      setHardened(true)
      await saveVpsMeta({ sshdHardened: true, hardenedAt: new Date().toISOString() })
      setInstallMsg('✅ 鍵認証で接続できます（パスワード認証は無効化しました）')
    } finally {
      setInstallBusy(false)
      setInitialPassword('') // 成否に関わらず必ず即クリア（保存しない）
      endActivity()
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-surface p-4 space-y-1">
        <p className="text-sm font-semibold text-ink">🖥 さくらのVPSで公開（① 接続）</p>
        <p className="text-xs text-ink-muted leading-relaxed">
          自由度の高い仮想サーバ。まずは「鍵認証だけで安全に繋がる状態」を作ります。② 初期セットアップ・③ 公開は開発中のため、このバージョンでは接続確認までです。
        </p>
      </div>

      {!credLoaded ? (
        <p className="text-xs text-ink-muted">確認中…</p>
      ) : !hostInfo ? (
        <section className="rounded-xl border border-line bg-surface p-4 space-y-2">
          <p className="text-sm font-semibold text-ink">ホスト情報が未登録です</p>
          <p className="text-xs text-ink-secondary leading-relaxed">
            「認証情報」の「さくらのVPS」で、契約したVPSのホスト名またはIPアドレスを登録してください（ポート・ユーザー名は既定のままで構いません）。
          </p>
          <button onClick={onOpenCredentials} className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90">
            🔑 認証情報を開いて登録
          </button>
        </section>
      ) : (
        <>
          <section className="rounded-xl border border-line bg-surface p-4 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-ink-secondary">
                接続先: <span className="font-mono text-ink">{hostInfo.user}@{hostInfo.host}:{hostInfo.port}</span>
              </p>
              <button onClick={onOpenCredentials} className="text-xs text-ink-muted hover:text-ink flex-none">認証情報を開く</button>
            </div>
            {entries && entries.length > 1 && (
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-ink-secondary flex-none">使うVPS</label>
                <select
                  value={entryId ?? ''}
                  onChange={e => switchEntry(e.target.value)}
                  className="flex-1 bg-surface border border-line rounded-lg px-2 py-1.5 text-xs text-ink outline-none focus:border-sakura"
                >
                  {entries.map(en => <option key={en.id} value={en.id}>{en.label}（{en.host}）</option>)}
                </select>
              </div>
            )}
          </section>

          {fpAlert && (
            <div className="rounded-xl border border-brand-red/70 bg-overlay p-4 space-y-2">
              <p className="text-sm font-semibold text-brand-red">⚠️ ホスト鍵の指紋が記録済みの値と一致しません（接続を中断しました）</p>
              <p className="text-xs text-ink-secondary leading-relaxed select-text">{fpAlert}</p>
              <p className="text-[11px] text-ink-muted leading-relaxed">
                心当たりがない場合は接続を再開せず、サーバの状態をさくらのVPSコントロールパネルで確認してください。
                サーバを作り直した等の心当たりがある場合は、「認証情報」でこのVPSの鍵を消去し、この接続を最初からやり直してください。
              </p>
            </div>
          )}

          {testResult?.ok && !fpAlert && (
            <div className="rounded-xl border border-brand-green/60 bg-surface p-4">
              <p className="text-sm font-semibold text-brand-green">
                {hardened ? '✅ 鍵認証で接続できます（パスワード認証は無効化しました）' : '✅ 鍵認証で接続できます'}
              </p>
            </div>
          )}

          {/* ルート選択 */}
          <div className="flex gap-1.5">
            <button
              onClick={() => setRoute('A')}
              className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium border transition-colors ${route === 'A' ? 'sakura-gradient text-white border-transparent' : 'bg-surface text-ink-secondary border-line hover:text-ink hover:border-sakura'}`}
            >ルートA（推奨）<br />新規/作り直してよいVPS</button>
            <button
              onClick={() => setRoute('B')}
              className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium border transition-colors ${route === 'B' ? 'sakura-gradient text-white border-transparent' : 'bg-surface text-ink-secondary border-line hover:text-ink hover:border-sakura'}`}
            >ルートB<br />既存VPSを残したい場合</button>
          </div>

          {route === 'A' ? (
            <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
              <p className="text-sm font-semibold text-ink">ルートA: 初期設定スクリプトで接続</p>
              {!keys ? (
                <>
                  <p className="text-xs text-ink-secondary leading-relaxed">
                    IDEが鍵ペアを生成し、公開鍵だけを埋め込んだ初期設定スクリプトを作ります。パスワードは一切扱いません。
                  </p>
                  <button
                    onClick={ensureKey}
                    disabled={genBusy}
                    className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
                  >{genBusy ? '生成中…' : '🔑 鍵を生成する'}</button>
                  {genMsg && <ErrorMessageBlock msg={genMsg} />}
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-ink-muted">初期設定スクリプト（公開鍵のみ含む・秘密情報なし・何度実行しても安全）</span>
                    <CopyButton text={script} title="スクリプトをコピー" />
                  </div>
                  <pre className="rounded-lg border border-line bg-overlay p-3 text-[11px] font-mono text-ink whitespace-pre-wrap break-all max-h-56 overflow-y-auto select-text">{script}</pre>
                  <ol className="list-decimal pl-4 space-y-1 text-xs text-ink-secondary leading-relaxed">
                    <li>上のスクリプトをコピーし、さくらのVPSコントロールパネルの「マイスクリプト」に登録する</li>
                    <li>サーバの新規追加、または既存サーバのOS再インストール時に、そのスクリプトを選択する（Ubuntu想定）</li>
                    <li>起動を待つ（数分）</li>
                  </ol>
                  <button
                    onClick={testConnection}
                    disabled={testBusy}
                    className="w-full sakura-gradient text-white rounded-lg px-4 py-2.5 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
                  >{testBusy ? '確認中…' : '📡 接続を確認'}</button>
                  {testResult && !testResult.ok && <ErrorMessageBlock msg={testResult.message ?? '接続に失敗しました'} />}
                </>
              )}
            </section>
          ) : (
            <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
              <p className="text-sm font-semibold text-ink">ルートB: パスワードで鍵を設置</p>
              <p className="text-xs text-ink-secondary leading-relaxed">
                さくらのVPS作成時に設定した初期パスワードで一度だけ接続し、鍵を設置します。鍵認証での接続確認が取れてから、
                初めてパスワード認証を無効化します（先に無効化して締め出されることはありません）。
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] font-medium text-ink-secondary">初期ユーザー（通常 root）</label>
                  <input
                    value={initialUser}
                    onChange={e => setInitialUser(e.target.value)}
                    placeholder="root"
                    className="mt-1 w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-sakura"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-ink-secondary">初期パスワード（保存されません）</label>
                  <input
                    type="password"
                    value={initialPassword}
                    onChange={e => setInitialPassword(e.target.value)}
                    className="mt-1 w-full bg-elevated border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink outline-none focus:border-sakura"
                  />
                </div>
              </div>
              <button
                onClick={installAndSecure}
                disabled={installBusy || !initialPassword}
                className="w-full sakura-gradient text-white rounded-lg px-4 py-2.5 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
              >{installBusy ? (installMsg || '処理中…') : '🔑 鍵を設置して接続'}</button>
              {!installBusy && installMsg && (
                installMsg.startsWith('✅')
                  ? <p className="text-xs text-brand-green font-semibold">{installMsg}</p>
                  : <ErrorMessageBlock msg={installMsg} />
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}

// 失敗メッセージの表示ブロック（掟5: select-text＋コピーボタン）。HanamiiPanel/VercelPanel と同種。
function ErrorMessageBlock({ msg }: { msg: string }) {
  return (
    <div className="rounded-lg border border-line bg-overlay p-3 space-y-1">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-xs text-ink-secondary leading-relaxed whitespace-pre-wrap break-all select-text">{msg}</p>
        <button
          onClick={() => { navigator.clipboard.writeText(msg).catch(() => {}) }}
          className="flex-none text-[11px] text-sakura hover:underline"
          title="メッセージをコピー"
        >コピー</button>
      </div>
    </div>
  )
}
