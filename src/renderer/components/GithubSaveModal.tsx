import React, { useCallback, useEffect, useMemo, useState } from 'react'
import SakuraLogo from './SakuraLogo'
import { getGithubToken } from './CredentialsModal'
import CopyButton from './CopyButton'
import { isNameConflictError, suggestAlternativeName } from '../nameConflict'

// 💾 GitHubに保存（バックアップ・共有・P3-⑬ G1）。
// git 語彙はUIに出さない（コミット→保存・リポジトリ→「GitHubの保管場所」等）。
// トークンは方式B（中央ストアから読んで main へ引数で渡す。main には保存しない）。
// .sakuraide.json には github: { repoFullName, lastSavedAt } のみを保存する（トークンは書かない）。

interface Props {
  projectDir: string
  onClose: () => void
  onOpenCredentials: () => void
}

// GitHub のリポジトリ名は英数字・ハイフン・アンダースコア・ドットのみ（実際の制約はもっと緩いが、
// 非エンジニア向けに安全側で正規化する。HanamiiPanel の safeName と同じ考え方）。
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'project'
}

// GitHub のリポジトリ名の文字数上限（100文字・GitHub公式ドキュメントの制約）。
// nameConflict.ts の suggestAlternativeName に渡す maxLen として使う（AppRunPanel/HanamiiPanel と同じ考え方）。
const GITHUB_REPO_NAME_MAX_LEN = 100

// 名前衝突時の代替名を作る（純粋関数・テスト対象）。base を safeName で GitHub の許可文字に正規化してから
// nameConflict.ts の共通ロジック（suggestAlternativeName）に渡す。random はテスト用の注入引数（省略時は暗号学的乱数）。
export function suggestAlternativeRepoName(base: string, random?: () => number): string {
  const safeBase = safeName(base)
  return random ? suggestAlternativeName(safeBase, GITHUB_REPO_NAME_MAX_LEN, random) : suggestAlternativeName(safeBase, GITHUB_REPO_NAME_MAX_LEN)
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function GithubSaveModal({ projectDir, onClose, onOpenCredentials }: Props) {
  const projName = projectDir.split('/').pop() ?? 'project'
  const metaPath = `${projectDir}/.sakuraide.json`

  const [tokenLoaded, setTokenLoaded] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [repoFullName, setRepoFullName] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const [metaLoaded, setMetaLoaded] = useState(false)

  const [newRepoName, setNewRepoName] = useState(safeName(projName))
  const [creating, setCreating] = useState(false)
  // 直近に作成を試みた名前（衝突時の代替名提案のベースにする。HanamiiPanel の lastAttemptedName と同じ考え方）。
  const [lastAttemptedName, setLastAttemptedName] = useState('')

  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [excluded, setExcluded] = useState<Array<{ path: string; reason: 'env' | 'size' }>>([])

  const readMeta = useCallback(async (): Promise<any> => {
    try { return JSON.parse(await window.electronAPI.fs.readFile(metaPath)) } catch { return {} }
  }, [metaPath])

  const saveMeta = useCallback(async (gh: { repoFullName: string; lastSavedAt: string | null }) => {
    const m = await readMeta()
    const next = { ...m, github: { ...(m.github ?? {}), ...gh } }
    await window.electronAPI.fs.writeFile(metaPath, JSON.stringify(next, null, 2))
    window.dispatchEvent(new Event('sakura-meta-changed'))
  }, [metaPath, readMeta])

  // 初回読み込み: トークン・メタ（保存先リポジトリ・前回保存日時）
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const tk = await getGithubToken()
      if (!cancelled) { setToken(tk); setTokenLoaded(true) }
      const m = await readMeta()
      if (!cancelled) {
        setRepoFullName(m?.github?.repoFullName ?? null)
        setLastSavedAt(m?.github?.lastSavedAt ?? null)
        setMetaLoaded(true)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 認証情報の変更（他モーダルでトークンを登録した直後など）を反映
  useEffect(() => {
    const h = async () => setToken(await getGithubToken())
    window.addEventListener('sakura:credentials-changed', h)
    return () => window.removeEventListener('sakura:credentials-changed', h)
  }, [])

  // nameOverride: 衝突時の「代替名で作成し直す」ボタンから、state 更新の反映待ちをせず即座に使う名前を渡すため
  // （HanamiiPanel の publish(nameOverride) と同じ考え方）。
  const createAndSave = async (nameOverride?: string) => {
    if (!token) return
    const name = safeName(nameOverride ?? newRepoName)
    if (!name) return
    setLastAttemptedName(name)
    setCreating(true)
    setResult(null)
    const r = await window.electronAPI.github.createRepo(token, name)
    if (!r.ok || !r.repoFullName) {
      setCreating(false)
      setResult({ ok: false, text: r.message ?? '保管場所の作成に失敗しました' })
      return
    }
    setRepoFullName(r.repoFullName)
    await saveMeta({ repoFullName: r.repoFullName, lastSavedAt: null })
    setCreating(false)
    await doSave(r.repoFullName)
  }

  // 名前衝突カード（NameConflictRetry）の表示判定。createRepo は成否と日本語メッセージのみを返し
  // HTTPステータスは渡ってこないため（github:createRepo ハンドラが describeCreateRepoError で文字列化する）、
  // 判定根拠は message の文言のみ（describeCreateRepoError の名前衝突メッセージは「既に」を含み
  // isNameConflictError の CONFLICT_PATTERN にマッチする）。作成前（!repoFullName）のみ対象。
  const conflictCardShown = !repoFullName && !creating && !!result && !result.ok && isNameConflictError(result.text)

  const doSave = async (targetRepo?: string) => {
    const repo = targetRepo ?? repoFullName
    if (!token || !repo) return
    setSaving(true)
    setResult(null)
    setExcluded([])
    const r = await window.electronAPI.github.save(projectDir, token, repo, message.trim() || undefined)
    setSaving(false)
    if (r.ok) {
      const now = new Date().toISOString()
      setLastSavedAt(now)
      await saveMeta({ repoFullName: repo, lastSavedAt: now })
      setResult({ ok: true, text: `保存しました（${r.savedCount ?? 0}件のファイル）` })
      setExcluded(r.excluded ?? [])
    } else {
      setResult({ ok: false, text: r.message ?? '保存に失敗しました' })
      setExcluded(r.excluded ?? [])
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[480px] max-h-[88vh] overflow-y-auto bg-elevated rounded-2xl border border-line shadow-2xl fade-in" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-6 pt-6 pb-4 sticky top-0 bg-elevated z-10">
          <SakuraLogo size={24} />
          <div>
            <h2 className="text-lg font-bold text-ink">💾 GitHubに保存</h2>
            <p className="text-xs text-ink-secondary">バックアップ・エンジニアへの共有に使えます</p>
          </div>
          <button onClick={onClose} className="ml-auto text-ink-muted hover:text-ink w-7 h-7 rounded-lg hover:bg-overlay">✕</button>
        </div>

        <div className="px-6 pb-6 space-y-4">
          {!tokenLoaded || !metaLoaded ? (
            <p className="text-sm text-ink-secondary py-4">読み込み中…</p>
          ) : !token ? (
            <div className="rounded-xl border border-brand-yellow/70 bg-surface p-4 space-y-3">
              <p className="text-sm text-ink leading-relaxed">
                GitHubのトークンが未登録です。認証情報でトークン（PAT）を登録してください。
              </p>
              <button
                onClick={onOpenCredentials}
                className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90"
              >認証情報を開く</button>
            </div>
          ) : !repoFullName ? (
            <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
              <h3 className="text-sm font-semibold text-ink">① 保存先を作成</h3>
              <p className="text-xs text-ink-secondary leading-relaxed">
                このプロジェクト専用のGitHubの保管場所（プライベート・非公開）を作成します。
              </p>
              <div>
                <label className="text-[11px] font-medium text-ink-secondary">保管場所の名前</label>
                <input
                  value={newRepoName}
                  onChange={e => setNewRepoName(e.target.value)}
                  className="mt-1 w-full bg-elevated border border-line rounded-lg px-3 py-2 text-sm text-ink outline-none focus:border-sakura"
                />
              </div>
              <button
                onClick={() => createAndSave()}
                disabled={creating || saving || !newRepoName.trim()}
                className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
              >{creating ? '作成中…' : saving ? '保存中…' : 'プライベートで作成して保存'}</button>

              {/* 保管場所名の衝突（重複）時: ワンクリックで代替名に変えて作成し直す（AppRunPanel/HanamiiPanel と同じ導線）。 */}
              {conflictCardShown && (
                <NameConflictRetry
                  currentName={lastAttemptedName || safeName(newRepoName)}
                  onRetry={suggested => { setNewRepoName(suggested); createAndSave(suggested) }}
                />
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
              <h3 className="text-sm font-semibold text-ink">GitHubに保存</h3>
              <div className="flex items-center gap-2 text-xs text-ink-secondary">
                <span className="text-ink-muted">前回の保存</span>
                <span className="text-ink">{formatDate(lastSavedAt)}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <a
                  href={`https://github.com/${repoFullName}`}
                  className="text-xs text-sakura hover:underline inline-flex items-center gap-1"
                >GitHubで開く ↗</a>
                <CopyButton text={`https://github.com/${repoFullName}`} title="リポジトリURLをコピー" />
              </div>
              <div>
                <label className="text-[11px] font-medium text-ink-secondary">保存メッセージ（任意）</label>
                <input
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  placeholder="Koto から保存"
                  className="mt-1 w-full bg-elevated border border-line rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-muted outline-none focus:border-sakura"
                />
              </div>
              <button
                onClick={() => doSave()}
                disabled={saving}
                className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
              >{saving ? '保存中…' : '💾 GitHubに保存'}</button>
            </div>
          )}

          {result && (
            <p className={`text-xs rounded-lg px-3 py-2 leading-relaxed select-text break-all ${result.ok ? 'text-white bg-brand-green/90' : 'text-white bg-brand-red-fill'}`}>
              {result.ok ? '✅ ' : '❌ '}{result.text}
            </p>
          )}

          {excluded.length > 0 && (
            <div className="rounded-xl border border-brand-yellow/70 bg-surface p-3 space-y-1.5">
              <p className="text-[11px] font-semibold text-ink">⚠️ 除外したファイル（{excluded.length}件）</p>
              <ul className="text-[11px] text-ink-muted space-y-0.5 max-h-24 overflow-y-auto">
                {excluded.map((f, i) => (
                  <li key={i} className="font-mono break-all">{f.path}（{f.reason === 'env' ? '秘密ファイル' : '5MB超過'}）</li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[11px] text-ink-muted leading-relaxed bg-surface border border-line rounded-lg px-3 py-2">
            保存した内容は GitHub（プライベートリポジトリ）に送信されます。.env などの秘密ファイルは自動で除外されます。
          </p>

          <div className="flex justify-end pt-1">
            <button onClick={onClose} className="bg-overlay text-ink border border-line rounded-xl px-4 py-2 text-sm font-medium hover:border-sakura">閉じる</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// 保管場所名の衝突（重複）時に表示する、ワンクリックで代替名に変えて作成し直すブロック。
// AppRunPanel / HanamiiPanel の同名コンポーネント（NameConflictRetry）と同じ考え方（所見28）。
// suggested は currentName（≒直近に失敗した名前）が変わるたびに新しく算出する。
function NameConflictRetry({ currentName, onRetry }: { currentName: string; onRetry: (suggested: string) => void }) {
  const suggested = useMemo(() => suggestAlternativeRepoName(currentName), [currentName])
  return (
    <div className="rounded-lg border border-brand-yellow/70 bg-overlay p-3 space-y-2">
      <p className="text-xs text-ink font-semibold">⚠️ この名前（{currentName}）は既に使われています。</p>
      <button
        onClick={() => onRetry(suggested)}
        className="text-xs text-sakura border border-sakura/50 rounded-md px-2.5 py-1.5 hover:bg-overlay"
      >『{suggested}』に変えて作成し直す</button>
    </div>
  )
}
