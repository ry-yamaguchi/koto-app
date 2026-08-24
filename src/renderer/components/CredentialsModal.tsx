import React, { useEffect, useState } from 'react'
import CopyButton from './CopyButton'
import SakuraLogo from './SakuraLogo'
import { getKeyLimit, setKeyLimit, getSettings } from '../usage'

interface Props {
  apiKey: string                       // さくらのAI Engine の現在キー（チャットで使用）
  onSetApiKey: (key: string) => void
  onClose: () => void
}

interface FieldDef { key: string; label: string; secret?: boolean; placeholder?: string }
interface ServiceDef { id: string; title: string; hint: string; fields: FieldDef[]; active?: boolean; budget?: boolean; custom?: boolean }

const SERVICES: ServiceDef[] = [
  {
    id: 'aiEngine', title: 'さくらのAI Engine', hint: 'チャット・生成で使うAPIキー（「使用中」がチャットに使われます）',
    active: true, budget: true,
    // placeholder は さくらのAI Engine コントロールパネル上の呼称「アカウントトークン」に合わせる
    // （ユーザー指摘 2026-07-13。HTTPヘッダ上は Bearer だが、利用者がコピーする値の名前で案内する）。
    fields: [{ key: 'apiKey', label: 'APIキー', secret: true, placeholder: 'アカウントトークン' }],
  },
  {
    id: 'cloud', title: 'さくらのクラウド', hint: 'IaaS API のアクセストークンとシークレット',
    fields: [
      { key: 'token', label: 'アクセストークン', secret: true },
      { key: 'secret', label: 'アクセストークンシークレット', secret: true },
    ],
  },
  {
    id: 'registry', title: 'コンテナレジストリ（push用・自動管理）', hint: '③公開→「さくらのAppRun」で自動作成・保存されます。通常は手入力不要です。',
    custom: true,
    fields: [
      { key: 'name', label: 'レジストリ名', placeholder: '例: myreg（→ myreg.sakuracr.jp）' },
      { key: 'user', label: 'ユーザー名' },
      { key: 'password', label: 'パスワード', secret: true },
    ],
  },
  {
    id: 'vps', title: 'さくらのVPS', hint: 'SSHデプロイ先の接続情報（秘密鍵はIDEが自動生成・管理します）',
    fields: [
      { key: 'host', label: 'ホスト名/IP', placeholder: '例: xxx.vs.sakura.ne.jp または IPアドレス' },
      { key: 'port', label: 'ポート番号（既定22）', placeholder: '22' },
      { key: 'user', label: 'ユーザー名（既定 sakura-admin）', placeholder: 'sakura-admin' },
    ],
  },
  {
    id: 'hanamii', title: 'HANAMII（国産PaaS）', hint: '③公開→「HANAMII」で使うAPIトークン（hnm_…）。HANAMII の管理画面で発行します。',
    active: true,
    fields: [{ key: 'apiKey', label: 'APIトークン', secret: true, placeholder: 'hnm_…' }],
  },
  {
    id: 'vercel', title: 'Vercel（海外PaaS）', hint: '③公開→Vercel で使うトークン。https://vercel.com/account/tokens で発行します。',
    active: true,
    fields: [
      { key: 'apiKey', label: 'トークン', secret: true, placeholder: '発行したトークンを貼り付け' },
      { key: 'teamId', label: 'チームID（個人アカウントなら空欄）', placeholder: '例: team_xxxxxxxx' },
    ],
  },
  {
    id: 'github', title: '💾 GitHubに保存（バックアップ・共有）', hint: 'Fine-grained PAT・Contents Read/Write＋リポジトリ作成権限が必要です。',
    active: true,
    fields: [{ key: 'apiKey', label: '個人アクセストークン（PAT）', secret: true, placeholder: 'github_pat_…' }],
  },
  {
    id: 'anthropic', title: 'Claude（Anthropic API）', hint: '登録すると、プロジェクトを開いたチャットの頭脳が Claude に切り替わります。キーは Claude Console（platform.claude.com）で発行します。',
    active: true,
    fields: [{ key: 'apiKey', label: 'APIキー', secret: true, placeholder: 'sk-ant-…' }],
  },
  // Web検索の2サービスは専用の統合カードで表示する（custom: true は一覧に出さない）
  {
    id: 'tavily', title: 'Web検索: Tavily', hint: '',
    active: true, custom: true,
    fields: [{ key: 'apiKey', label: 'APIキー', secret: true, placeholder: 'tvly-…' }],
  },
  {
    id: 'braveSearch', title: 'Web検索: Brave Search API', hint: '',
    active: true, custom: true,
    fields: [{ key: 'apiKey', label: 'APIキー', secret: true, placeholder: 'X-Subscription-Token' }],
  },
]

// Web検索の優先プロバイダ（秘密情報ではないため平文のlocalStorageに保存）
export type SearchProvider = 'tavily' | 'brave'
export const SEARCH_PREF_KEY = 'sakura_search_provider'
export function getSearchPref(): SearchProvider {
  return localStorage.getItem(SEARCH_PREF_KEY) === 'brave' ? 'brave' : 'tavily'
}

interface Entry { id: string; label: string; values: Record<string, string> }
interface ServiceState { entries: Entry[]; activeId: string | null }
type Store = Record<string, ServiceState>

const STORE_KEY = 'sakura_credentials_enc'
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

// ── クラウドキーのヘルパー（AppRunPanel から利用） ─────────────────────────
// AppRun に専用APIキーは無く、さくらのクラウド IaaS のキー（token+secret）で操作する。
// ここでは store.cloud（CredentialsModal と同じ暗号化済み localStorage）の登録キーを読み書きする。

export interface CloudKeyInfo { id: string; label: string }

/** STORE_KEY を復号して store オブジェクトを返す（無ければ null）。 */
async function loadStore(): Promise<any | null> {
  try {
    const enc = localStorage.getItem(STORE_KEY)
    if (!enc) return null
    const json = await window.electronAPI.secure.decrypt(enc)
    if (!json) return null
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** 登録済みのクラウドキー（token/secret が両方非空のもの）の一覧を返す。 */
export async function listCloudKeys(): Promise<CloudKeyInfo[]> {
  const parsed = await loadStore()
  const entries: Entry[] = parsed?.cloud?.entries ?? []
  return entries
    .filter(e => (e.values?.token ?? '').trim() && (e.values?.secret ?? '').trim())
    .map(e => ({ id: e.id, label: e.label || 'キー' }))
}

/** 現在「使用中」のクラウドキーの id（無ければ null）。 */
export async function getActiveCloudKeyId(): Promise<string | null> {
  const parsed = await loadStore()
  return parsed?.cloud?.activeId ?? null
}

/** 登録済みの さくらのAI Engine キー（active エントリの apiKey）と、中央ストアの有無を返す。
 *  C-1修正（2026-07-13 ユーザー報告「削除したキーが復活する」）: App の起動時読み込みで
 *  「中央ストアが存在するならストアが正」と判定するために storeExists を分けて返す。
 *  storeExists=true かつ key='' は「ユーザーがキーを削除した状態」を意味する。 */
export async function getAiEngineKeyInfo(): Promise<{ storeExists: boolean; key: string }> {
  const parsed = await loadStore()
  if (!parsed || !parsed.aiEngine) return { storeExists: false, key: '' }
  const svc = parsed.aiEngine
  const entry = svc.entries?.find((e: Entry) => e.id === svc.activeId) ?? svc.entries?.[0]
  return { storeExists: true, key: (entry?.values?.apiKey ?? '').trim() }
}

/** 登録済みの HANAMII トークン（active エントリの apiKey）を返す。無ければ null。
 *  方式B（中央ストア一元・都度参照）: main には保存せず、使う瞬間に読んで引数で渡す。 */
export async function getHanamiiToken(): Promise<string | null> {
  const parsed = await loadStore()
  const svc = parsed?.hanamii
  if (!svc) return null
  const entry = (svc.entries ?? []).find((e: Entry) => e.id === svc.activeId) ?? svc.entries?.[0]
  const tok = (entry?.values?.apiKey ?? '').trim()
  return tok || null
}

/** 登録済みの HANAMII トークン（apiKey が空でないもの）の一覧と「使用中」の id を返す。 */
export async function listHanamiiTokenEntries(): Promise<{ tokens: { id: string; label: string }[]; activeId: string | null }> {
  const parsed = await loadStore()
  const entries: Entry[] = parsed?.hanamii?.entries ?? []
  const tokens = entries
    .filter(e => (e.values?.apiKey ?? '').trim())
    .map(e => ({ id: e.id, label: e.label || 'トークン' }))
  return { tokens, activeId: parsed?.hanamii?.activeId ?? null }
}

/** 指定 id の HANAMII トークン（apiKey）を返す。無ければ null。 */
export async function getHanamiiTokenById(id: string): Promise<string | null> {
  const parsed = await loadStore()
  const entries: Entry[] = parsed?.hanamii?.entries ?? []
  const entry = entries.find(e => e.id === id)
  const tok = (entry?.values?.apiKey ?? '').trim()
  return tok || null
}

/** 登録済みの Vercel トークン（active エントリの apiKey）を返す。無ければ null。
 *  方式B（中央ストア一元・都度参照）: main には保存せず、使う瞬間に読んで引数で渡す。 */
export async function getVercelToken(): Promise<string | null> {
  const parsed = await loadStore()
  const svc = parsed?.vercel
  if (!svc) return null
  const entry = (svc.entries ?? []).find((e: Entry) => e.id === svc.activeId) ?? svc.entries?.[0]
  const tok = (entry?.values?.apiKey ?? '').trim()
  return tok || null
}

/** 登録済みの Vercel チームID（active エントリの teamId）を返す。個人アカウント（空欄）なら null。 */
export async function getVercelTeamId(): Promise<string | null> {
  const parsed = await loadStore()
  const svc = parsed?.vercel
  if (!svc) return null
  const entry = (svc.entries ?? []).find((e: Entry) => e.id === svc.activeId) ?? svc.entries?.[0]
  const tid = (entry?.values?.teamId ?? '').trim()
  return tid || null
}

/** 登録済みの Vercel トークン（apiKey が空でないもの）の一覧と「使用中」の id を返す。 */
export async function listVercelTokenEntries(): Promise<{ tokens: { id: string; label: string }[]; activeId: string | null }> {
  const parsed = await loadStore()
  const entries: Entry[] = parsed?.vercel?.entries ?? []
  const tokens = entries
    .filter(e => (e.values?.apiKey ?? '').trim())
    .map(e => ({ id: e.id, label: e.label || 'トークン' }))
  return { tokens, activeId: parsed?.vercel?.activeId ?? null }
}

/** 指定 id の Vercel トークン（apiKey）を返す。無ければ null。 */
export async function getVercelTokenById(id: string): Promise<string | null> {
  const parsed = await loadStore()
  const entries: Entry[] = parsed?.vercel?.entries ?? []
  const entry = entries.find(e => e.id === id)
  const tok = (entry?.values?.apiKey ?? '').trim()
  return tok || null
}

/** 指定 id の Vercel チームIDを返す。無ければ null。 */
export async function getVercelTeamIdById(id: string): Promise<string | null> {
  const parsed = await loadStore()
  const entries: Entry[] = parsed?.vercel?.entries ?? []
  const entry = entries.find(e => e.id === id)
  const tid = (entry?.values?.teamId ?? '').trim()
  return tid || null
}

/** 登録済みの GitHub トークン（active エントリの apiKey）を返す。無ければ null。
 *  方式B（中央ストア一元・都度参照）: main には保存せず、使う瞬間に読んで引数で渡す。 */
export async function getGithubToken(): Promise<string | null> {
  const parsed = await loadStore()
  const svc = parsed?.github
  if (!svc) return null
  const entry = (svc.entries ?? []).find((e: Entry) => e.id === svc.activeId) ?? svc.entries?.[0]
  const tok = (entry?.values?.apiKey ?? '').trim()
  return tok || null
}

// ── さくらのVPS のヘルパー（VpsPanel から利用） ─────────────────────────
// 秘密鍵は他のサービスのトークンと同じ中央ストア（sakura_credentials_enc）に保存する（方式B）。
// host/port が空（未設定）のエントリは「まだ使えるVPSが登録されていない」扱いにする。

export interface VpsCredentials { host: string; port: number; user: string; publicKey: string; privateKey: string }

function entryToVpsCredentials(entry: Entry | undefined): VpsCredentials | null {
  const host = (entry?.values?.host ?? '').trim()
  if (!host) return null
  const portRaw = (entry?.values?.port ?? '').trim()
  const portNum = portRaw ? Number(portRaw) : 22
  return {
    host,
    port: Number.isInteger(portNum) && portNum > 0 && portNum <= 65535 ? portNum : 22,
    user: (entry?.values?.user ?? '').trim() || 'sakura-admin',
    publicKey: (entry?.values?.publicKey ?? '').trim(),
    privateKey: entry?.values?.privateKey ?? '',
  }
}

/** 登録済みの さくらのVPS 接続情報（active エントリ）を返す。host が空（未設定）なら null。
 *  方式B（中央ストア一元・都度参照）: 秘密鍵も含め main には保存せず、使う瞬間に読んで引数で渡す。 */
export async function getVpsCredentials(): Promise<VpsCredentials | null> {
  const parsed = await loadStore()
  const svc = parsed?.vps
  if (!svc) return null
  const entry = (svc.entries ?? []).find((e: Entry) => e.id === svc.activeId) ?? svc.entries?.[0]
  return entryToVpsCredentials(entry)
}

/** 指定 id の さくらのVPS 接続情報を返す。無ければ（host未設定含む）null。 */
export async function getVpsCredentialsById(id: string): Promise<VpsCredentials | null> {
  const parsed = await loadStore()
  const entries: Entry[] = parsed?.vps?.entries ?? []
  return entryToVpsCredentials(entries.find(e => e.id === id))
}

/** 登録済みの さくらのVPS エントリ一覧（host が空でないもの）と「使用中」の id を返す。 */
export async function listVpsEntries(): Promise<{ entries: { id: string; label: string; host: string }[]; activeId: string | null }> {
  const parsed = await loadStore()
  const entries: Entry[] = parsed?.vps?.entries ?? []
  const list = entries
    .filter(e => (e.values?.host ?? '').trim())
    .map(e => ({ id: e.id, label: e.label || 'VPS', host: (e.values?.host ?? '').trim() }))
  return { entries: list, activeId: parsed?.vps?.activeId ?? null }
}

/**
 * 生成した鍵ペアを さくらのVPS の認証情報エントリへ保存する（中央ストア一元・方式B）。
 * entryId が既存エントリなら更新、null/見つからなければ新規エントリ（host は空のまま）を作って使用中にする
 * （registry サービスの「IDEが自動管理」と同じく、CredentialsModal の「保存」ボタンを経由しない自動保存）。
 * 戻り値の id は以後の getVpsCredentialsById 等に使う（新規作成時は呼び出し側が state に控えること）。
 */
export async function saveVpsKeypair(entryId: string | null, keys: { publicKey: string; privateKey: string }): Promise<{ ok: boolean; id: string; message?: string }> {
  const parsed = (await loadStore()) ?? emptyStore()
  const svc: ServiceState = parsed.vps ?? { entries: [], activeId: null }
  let entries: Entry[] = svc.entries ?? []
  let id = entryId && entries.some(e => e.id === entryId) ? entryId : ''
  if (!id) {
    const e: Entry = { id: uid(), label: entries.length ? `VPS ${entries.length + 1}` : '既定', values: {} }
    entries = [...entries, e]
    id = e.id
  }
  entries = entries.map(e => e.id === id ? { ...e, values: { ...e.values, publicKey: keys.publicKey, privateKey: keys.privateKey } } : e)
  parsed.vps = { entries, activeId: svc.activeId ?? id }
  try {
    const enc = await window.electronAPI.secure.encrypt(JSON.stringify(parsed))
    if (enc) localStorage.setItem(STORE_KEY, enc)
  } catch {
    return { ok: false, id, message: '鍵の保存に失敗しました' }
  }
  window.dispatchEvent(new Event('sakura:credentials-changed'))
  return { ok: true, id }
}

/** さくらのVPS の鍵を消去する（再生成用・トラブル時用）。host/port/user は残す。 */
export async function clearVpsKeypair(entryId: string): Promise<{ ok: boolean }> {
  const parsed = (await loadStore()) ?? emptyStore()
  const svc: ServiceState = parsed.vps ?? { entries: [], activeId: null }
  if (!svc.entries.some(e => e.id === entryId)) return { ok: false }
  const entries = svc.entries.map(e => e.id === entryId ? { ...e, values: { ...e.values, publicKey: '', privateKey: '' } } : e)
  parsed.vps = { entries, activeId: svc.activeId }
  try {
    const enc = await window.electronAPI.secure.encrypt(JSON.stringify(parsed))
    if (enc) localStorage.setItem(STORE_KEY, enc)
  } catch {
    return { ok: false }
  }
  window.dispatchEvent(new Event('sakura:credentials-changed'))
  return { ok: true }
}

/**
 * 指定 id のキーを「使用中」にする。
 * localStorage の store.cloud.activeId を更新して再暗号化保存し、
 * そのキーの token/secret を window.electronAPI.cloud.saveKey でバックエンドへ同期し、
 * 'sakura:credentials-changed' を dispatch する。成功で {ok:true}。
 */
export async function activateCloudKey(id: string): Promise<{ ok: boolean; message?: string }> {
  const parsed = await loadStore()
  const entries: Entry[] = parsed?.cloud?.entries ?? []
  const entry = entries.find(e => e.id === id)
  if (!parsed || !parsed.cloud || !entry) {
    return { ok: false, message: '指定されたキーが見つかりません' }
  }
  const token = (entry.values?.token ?? '').trim()
  const secret = (entry.values?.secret ?? '').trim()
  if (!token || !secret) {
    return { ok: false, message: 'キーの token/secret が空です' }
  }
  parsed.cloud.activeId = id
  try {
    const enc = await window.electronAPI.secure.encrypt(JSON.stringify(parsed))
    if (enc) localStorage.setItem(STORE_KEY, enc)
  } catch {
    return { ok: false, message: 'キーの保存に失敗しました' }
  }
  try {
    await window.electronAPI.cloud.saveKey(token, secret)
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
  window.dispatchEvent(new Event('sakura:credentials-changed'))
  return { ok: true }
}

/** 登録済みの Claude（Anthropic API）キー（active エントリの apiKey）を返す。無ければ null。
 *  方式B（中央ストア一元・都度参照）: main には保存せず、使う瞬間に読んで引数で渡す。 */
export async function getAnthropicToken(): Promise<string | null> {
  const parsed = await loadStore()
  const svc = parsed?.anthropic
  if (!svc) return null
  const entry = (svc.entries ?? []).find((e: Entry) => e.id === svc.activeId) ?? svc.entries?.[0]
  const tok = (entry?.values?.apiKey ?? '').trim()
  return tok || null
}

/** 全角数字を半角へ変換し、数字以外を除去して半角数字だけにする */
function toHankakuDigits(s: string): string {
  return (s ?? '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^0-9]/g, '')
}

function emptyStore(): Store {
  const s: Store = {}
  for (const svc of SERVICES) s[svc.id] = { entries: [], activeId: null }
  return s
}

/** 旧フォーマット（単数）→ 新フォーマット（リスト）へ移行 */
function migrate(old: any, apiKey: string): Store {
  const s = emptyStore()
  if (old && typeof old === 'object' && !('aiEngine' in old)) {
    if (old.cloudToken || old.cloudSecret) {
      const e = { id: uid(), label: '既定', values: { token: old.cloudToken ?? '', secret: old.cloudSecret ?? '' } }
      s.cloud = { entries: [e], activeId: e.id }
    }
    if (old.registryName || old.registryUser || old.registryPassword) {
      const e = { id: uid(), label: '既定', values: { name: old.registryName ?? '', user: old.registryUser ?? '', password: old.registryPassword ?? '' } }
      s.registry = { entries: [e], activeId: e.id }
    }
    if (old.vpsHost || old.vpsUser) {
      const e = { id: uid(), label: '既定', values: { host: old.vpsHost ?? '', user: old.vpsUser ?? '' } }
      s.vps = { entries: [e], activeId: e.id }
    }
  }
  // AI Engine：現在のキーを最初のエントリに
  if (apiKey) {
    const e = { id: uid(), label: '既定', values: { apiKey } }
    s.aiEngine = { entries: [e], activeId: e.id }
  }
  return s
}

function Field({ def, value, onChange }: { def: FieldDef; value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false)
  return (
    <div>
      <label className="text-[11px] font-medium text-ink-secondary">{def.label}</label>
      <div className="mt-1 flex items-center gap-1.5">
        <input
          type={def.secret && !show ? 'password' : 'text'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={def.placeholder}
          className="flex-1 bg-surface border border-line rounded-lg px-3 py-2 text-sm text-ink placeholder-ink-muted outline-none focus:border-sakura transition-colors"
        />
        {def.secret && (
          <button onClick={() => setShow(s => !s)} className="text-xs text-ink-muted hover:text-ink w-8 h-8 rounded-lg hover:bg-overlay flex-none" title={show ? '隠す' : '表示'}>
            {show ? '🙈' : '👁'}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * AIキーの月間上限コントロール。
 * _limit のエンコード: ''=既定 / 'x'=無制限 / 'a:'+数字=金額（'a:' だけ＝金額モードで空欄）
 */
function LimitControl({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isAmount = typeof value === 'string' && value.startsWith('a:')
  const mode = value === 'x' ? 'unlimited' : isAmount ? 'amount' : 'default'
  const amount = isAmount ? value.slice(2) : ''
  const defaultLimit = getSettings().monthlyLimitYen
  return (
    <div>
      <label className="text-[11px] font-medium text-ink-secondary">このキーの月間上限</label>
      <div className="mt-1 flex items-center gap-1.5">
        <select
          value={mode}
          onChange={e => {
            const m = e.target.value
            onChange(m === 'default' ? '' : m === 'unlimited' ? 'x' : 'a:' + amount)
          }}
          className="bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink outline-none focus:border-sakura"
        >
          <option value="default">既定（{defaultLimit == null ? '無制限' : `¥${defaultLimit}`}）</option>
          <option value="unlimited">無制限</option>
          <option value="amount">金額を指定</option>
        </select>
        {mode === 'amount' && (
          <div className="flex items-center gap-1">
            <span className="text-ink-muted text-sm">¥</span>
            <input
              value={amount}
              // 入力中は自由に（全角・カンマ等も可）。フォーカスを外す/Enterで半角数字へ正規化
              onChange={e => onChange('a:' + e.target.value)}
              onBlur={() => onChange('a:' + toHankakuDigits(amount))}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              inputMode="numeric"
              placeholder="1000"
              className="w-24 bg-surface border border-line rounded-lg px-2 py-2 text-sm text-ink outline-none focus:border-sakura"
            />
          </div>
        )}
      </div>
    </div>
  )
}

function KeyTestButton({ apiKey }: { apiKey: string }) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'ng'>('idle')
  const [detail, setDetail] = useState('')
  const test = async () => {
    if (!apiKey.trim()) { setState('ng'); setDetail('キーが空です'); return }
    setState('testing')
    try {
      const models = await window.electronAPI.sakura.models(apiKey.trim())
      setState('ok'); setDetail(`利用可能なモデル: ${models.length}個`)
    } catch (e: any) {
      setState('ng'); setDetail(e?.message ?? String(e))
    }
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={test} disabled={state === 'testing'}
        className="text-[11px] text-sakura border border-sakura/50 rounded-md px-2 py-1 hover:bg-overlay disabled:opacity-50">
        {state === 'testing' ? '接続中…' : '🔌 接続テスト'}
      </button>
      {state === 'ok' && <span className="text-[11px] text-brand-green">✅ 接続OK（{detail}）</span>}
      {state === 'ng' && <span className="text-[11px] text-brand-red">❌ {detail}</span>}
    </div>
  )
}

// GitHub のトークン疎通テスト（GET /user）。接続OK時はログイン名を表示する。
function GithubTestButton({ apiKey }: { apiKey: string }) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'ng'>('idle')
  const [detail, setDetail] = useState('')
  const test = async () => {
    if (!apiKey.trim()) { setState('ng'); setDetail('トークンが空です'); return }
    setState('testing')
    try {
      const r = await window.electronAPI.github.test(apiKey.trim())
      if (r.ok) { setState('ok'); setDetail(r.login ? `ログイン: ${r.login}` : '接続できました') }
      else { setState('ng'); setDetail(r.message ?? '接続に失敗しました') }
    } catch (e: any) {
      setState('ng'); setDetail(e?.message ?? String(e))
    }
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={test} disabled={state === 'testing'}
        className="text-[11px] text-sakura border border-sakura/50 rounded-md px-2 py-1 hover:bg-overlay disabled:opacity-50">
        {state === 'testing' ? '接続中…' : '🔌 接続テスト'}
      </button>
      {state === 'ok' && <span className="text-[11px] text-brand-green">✅ 接続OK（{detail}）</span>}
      {state === 'ng' && <span className="text-[11px] text-brand-red">❌ {detail}</span>}
    </div>
  )
}

// Claude（Anthropic API）のキー疎通テスト（GET /v1/models）。接続OK時は利用可能なモデル件数を表示する。
function AnthropicTestButton({ apiKey }: { apiKey: string }) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'ng'>('idle')
  const [detail, setDetail] = useState('')
  const test = async () => {
    if (!apiKey.trim()) { setState('ng'); setDetail('キーが空です'); return }
    setState('testing')
    try {
      const r = await window.electronAPI.claude.test(apiKey.trim())
      if (r.ok) { setState('ok'); setDetail(`利用可能なモデル: ${r.modelCount ?? 0}個`) }
      else { setState('ng'); setDetail(r.message ?? '接続に失敗しました') }
    } catch (e: any) {
      setState('ng'); setDetail(e?.message ?? String(e))
    }
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={test} disabled={state === 'testing'}
        className="text-[11px] text-sakura border border-sakura/50 rounded-md px-2 py-1 hover:bg-overlay disabled:opacity-50">
        {state === 'testing' ? '接続中…' : '🔌 接続テスト'}
      </button>
      {state === 'ok' && <span className="text-[11px] text-brand-green">✅ 接続OK（{detail}）</span>}
      {state === 'ng' && <span className="text-[11px] text-brand-red whitespace-pre-wrap select-text">❌ {detail}</span>}
    </div>
  )
}

// HANAMII トークンの接続テスト（ワークスペース一覧の取得で有効性を確認・読み取りのみ）。
function HanamiiTestButton({ token }: { token: string }) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'ng'>('idle')
  const [detail, setDetail] = useState('')
  const test = async () => {
    if (!token.trim()) { setState('ng'); setDetail('トークンが空です'); return }
    setState('testing')
    try {
      const r = await window.electronAPI.hanamii.testConnection(token.trim())
      if (r.ok) { setState('ok'); setDetail('') }
      else { setState('ng'); setDetail(r.message ?? '接続に失敗しました') }
    } catch (e: any) {
      setState('ng'); setDetail(e?.message ?? String(e))
    }
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={test} disabled={state === 'testing'}
        className="text-[11px] text-sakura border border-sakura/50 rounded-md px-2 py-1 hover:bg-overlay disabled:opacity-50">
        {state === 'testing' ? '接続中…' : '🔌 接続テスト'}
      </button>
      {state === 'ok' && <span className="text-[11px] text-brand-green">✅ 接続OK</span>}
      {state === 'ng' && <span className="text-[11px] text-brand-red whitespace-pre-wrap select-text">❌ {detail}</span>}
    </div>
  )
}

// さくらのVPS の鍵の状態表示（registry サービスと同じ「IDEが自動管理」の流儀）。
// 秘密鍵そのものは入力欄にしない・値も表示しない。生成は「🚀 公開」→さくらのVPSの「① 接続」パネルで行う
// （host/port 未設定でも鍵だけ先に生成できる）。ここでは状態表示と、トラブル時の消去のみ。
function VpsKeyStatus({ hasKey, onClear }: { hasKey: boolean; onClear: () => void }) {
  return (
    <div className="flex items-center gap-2">
      {hasKey ? (
        <>
          <span className="text-[11px] text-brand-green font-medium">🔑 鍵は自動生成・暗号化保存されています</span>
          <button onClick={onClear} className="text-[11px] text-ink-muted hover:text-brand-red">消去</button>
        </>
      ) : (
        <span className="text-[11px] text-ink-muted">未生成（「🚀 公開」→さくらのVPSの「① 接続」で生成できます）</span>
      )}
    </div>
  )
}

// Vercel トークンの接続テスト（読み取りのみ）。teamId は任意。
// **2段階**で見る: ①トークンが有効か（/v2/user）②公開する範囲が見えているか（デプロイ一覧）。
// ②が通らないときは緑の ✅ にしない（2026-08-22 Ryosuke 指摘。範囲の無いトークンでも
// ①は 200 を返すため、「接続OK」と出したのに公開で落ちる形になっていた）。
function VercelTestButton({ token, teamId }: { token: string; teamId: string }) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'warn' | 'ng'>('idle')
  const [detail, setDetail] = useState('')
  const test = async () => {
    if (!token.trim()) { setState('ng'); setDetail('トークンが空です'); return }
    setState('testing')
    try {
      const r = await window.electronAPI.vercel.testConnection(token.trim(), teamId.trim() || undefined)
      if (r.ok) { setState(r.warn ? 'warn' : 'ok'); setDetail(r.message ?? '') }
      else { setState('ng'); setDetail(r.message ?? '接続に失敗しました') }
    } catch (e: any) {
      setState('ng'); setDetail(e?.message ?? String(e))
    }
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={test} disabled={state === 'testing'}
        className="text-[11px] text-sakura border border-sakura/50 rounded-md px-2 py-1 hover:bg-overlay disabled:opacity-50">
        {state === 'testing' ? '接続中…' : '🔌 接続テスト'}
      </button>
      {state === 'ok' && <span className="text-[11px] text-brand-green">✅ {detail || '接続OK'}</span>}
      {state === 'warn' && <span className="text-[11px] text-brand-yellow whitespace-pre-wrap select-text">⚠️ {detail}</span>}
      {state === 'ng' && <span className="text-[11px] text-brand-red whitespace-pre-wrap select-text">❌ {detail}</span>}
    </div>
  )
}

// 🔰 Claude（Anthropic API）キーの取得手順（折りたたみ）。
function AnthropicKeyGuide() {
  return (
    <details className="rounded-xl border border-brand-yellow/70 bg-surface p-3">
      <summary className="text-xs font-semibold text-ink cursor-pointer list-none flex items-center gap-1">
        🔰 APIキーの取得手順
      </summary>
      <div className="text-[11px] text-ink-secondary leading-relaxed mt-2 space-y-1.5">
        <p className="bg-elevated border border-line rounded-lg px-2.5 py-2">
          ⚠️ <b className="text-ink-secondary">claude.ai のアカウント・サブスクとは別体系です。</b>
          platform.claude.com（Claude Console）は<b className="text-ink-secondary">従量課金</b>で、事前にクレジットの購入が必要です。
        </p>
        <ol className="list-decimal pl-4 space-y-1">
          <li>
            <a href="https://platform.claude.com" className="text-sakura hover:underline">
              platform.claude.com
            </a>（Claude Console）にログイン、または新規登録する
          </li>
          <li>「API Keys」→「Create Key」で新しいキーを作成する</li>
          <li>表示された <span className="font-mono">sk-ant-…</span> をコピーして上の欄に貼り付ける（キーは一度しか表示されません）</li>
          <li>「🔌 接続テスト」でキーが有効か確認する</li>
        </ol>
        <p>キーはMacのキーチェーンで暗号化保存されます。</p>
      </div>
    </details>
  )
}

// 🔰 GitHub Fine-grained PAT の取得手順（折りたたみ）。
function GithubPatGuide() {
  return (
    <details className="rounded-xl border border-brand-yellow/70 bg-surface p-3">
      <summary className="text-xs font-semibold text-ink cursor-pointer list-none flex items-center gap-1">
        🔰 トークン（PAT）の取得手順
      </summary>
      <div className="text-[11px] text-ink-secondary leading-relaxed mt-2 space-y-1.5">
        <ol className="list-decimal pl-4 space-y-1">
          <li>
            <a href="https://github.com/settings/personal-access-tokens" className="text-sakura hover:underline">
              github.com/settings/personal-access-tokens
            </a> を開く（GitHubへのログインが必要です）
          </li>
          <li>「Generate new token」をクリック</li>
          <li>Repository access: 「All repositories」（または後で作る保管場所を指定）を選択</li>
          <li>Permissions で「Contents」を Read and write、「Administration」を Read and write に設定</li>
          <li>生成されたトークン（<span className="font-mono">github_pat_…</span>）をコピーして上の欄に貼り付け</li>
        </ol>
      </div>
    </details>
  )
}

export default function CredentialsModal({ apiKey, onSetApiKey, onClose }: Props) {
  const [store, setStore] = useState<Store>(emptyStore())
  /** 保存されているのに読み取れなかった（別の版のアプリで保存された等）。 */
  const [unreadable, setUnreadable] = useState(false)
  const [saved, setSaved] = useState(false)
  const [searchPref, setSearchPref] = useState<SearchProvider>(getSearchPref())
  // 未保存の変更があるかどうか（所見5）。各入力の変更操作（addEntry/removeEntry/setLabel/setValue/setActive/
  // setSingleKey）で true にし、保存が完了したら false に戻す。初回読み込みの setStore はここを経由しないため
  // dirty にはならない。
  const [dirty, setDirty] = useState(false)
  // コンテナレジストリ認証の登録状況（③公開→AppRun が自動作成。ここでは表示のみ）
  const [regInfo, setRegInfo] = useState<{ name: string; user: string; password: string } | null>(null)
  // パスワードを表示中か（既定は伏せる。ほかのキーと同じ 👁 の作法）
  const [showRegPw, setShowRegPw] = useState(false)

  const changeSearchPref = (p: SearchProvider) => {
    setSearchPref(p)
    localStorage.setItem(SEARCH_PREF_KEY, p) // 即時反映（保存ボタン不要）
  }

  // バックエンドからレジストリ認証の登録状況を読み直す
  const refreshRegInfo = async () => {
    const k = await window.electronAPI.registry.loadKey()
    setRegInfo(k && k.name ? { name: k.name, user: k.user, password: k.password ?? '' } : null)
    setShowRegPw(false) // 読み直したら伏せ直す
  }

  // 初回読み込み＋認証情報変更イベントで登録状況を更新
  useEffect(() => {
    refreshRegInfo()
    window.addEventListener('sakura:credentials-changed', refreshRegInfo)
    return () => window.removeEventListener('sakura:credentials-changed', refreshRegInfo)
  }, [])

  // VpsPanel（PublishModal配下・このモーダルと同時に開ける）が saveVpsKeypair/clearVpsKeypair で
  // 中央ストアを直接書き換えることがあるため、vps セクションだけは変更イベントで読み直して
  // このモーダルのローカル state に反映する（反映しないと、後で「保存」を押した際にこのモーダルが
  // 持つ古い state で上書きし、せっかく生成された鍵が消えてしまう＝過去のC-1と同種の事故になる）。
  useEffect(() => {
    const onVpsChange = async () => {
      const enc = localStorage.getItem(STORE_KEY)
      if (!enc) return
      try {
        const json = await window.electronAPI.secure.decrypt(enc)
        if (!json) return
        const parsed = JSON.parse(json)
        if (parsed?.vps) setStore(prev => ({ ...prev, vps: parsed.vps }))
      } catch { /* ignore */ }
    }
    window.addEventListener('sakura:credentials-changed', onVpsChange)
    return () => window.removeEventListener('sakura:credentials-changed', onVpsChange)
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const enc = localStorage.getItem(STORE_KEY)
        let parsed: any = null
        if (enc) {
          const json = await window.electronAPI.secure.decrypt(enc)
          // ── 「読めなかった」を「無かった」と混ぜない（2026-08-19 実機）──────
          // 復号できないのに「未登録」と見せると、利用者はそこへ入力し直し、
          // **元の設定が上書きされて消える**。実際に起きうる形:
          // 署名の違うビルド（署名版と手元の未署名ビルド）は**キーチェーンの鍵が別**で、
          // 一方で保存したものはもう一方から読めない（実測: 同名の項目が2つできていた）。
          if (json === null) setUnreadable(true)
          if (json) parsed = JSON.parse(json)
        }
        let s: Store
        if (parsed && parsed.aiEngine) {
          s = { ...emptyStore(), ...parsed }
          // C-1修正: ここで apiKey プロップからの「埋め戻し」はしない。
          // かつては旧バージョンからの移行用に空ストアへ現在キーを補完していたが、
          // ユーザーがダイアログでキーを削除→保存した後もアプリ側の複製（旧位置）から
          // 復活してしまう原因になっていた（2026-07-13 ユーザー報告）。
          // 初回移行（ストア自体が無い場合）は下の migrate() が担う。
        } else {
          s = migrate(parsed, apiKey)
        }
        // AIキーが未登録なら、すぐ入力できるよう空のエントリを1つ用意
        if (s.aiEngine.entries.length === 0) {
          const e = { id: uid(), label: '既定', values: { apiKey: '', _limit: '' } }
          s.aiEngine = { entries: [e], activeId: e.id }
        }
        // AIエントリの月間上限(_limit)を予算設定から初期化
        for (const e of s.aiEngine.entries) {
          if (e.values._limit === undefined) {
            const lim = getKeyLimit(e.values.apiKey ?? '')
            e.values._limit = lim === undefined ? '' : lim === null ? 'x' : 'a:' + String(lim)
          }
        }
        // 旧「webSearch」欄のキーを、種類に応じて Tavily / Brave へ移行
        const legacy = (s as any).webSearch as ServiceState | undefined
        if (legacy?.entries?.length) {
          for (const e of legacy.entries) {
            const target = (e.values.apiKey ?? '').startsWith('tvly-') ? 'tavily' : 'braveSearch'
            s[target] = {
              entries: [...(s[target]?.entries ?? []), e],
              activeId: s[target]?.activeId ?? e.id,
            }
          }
          delete (s as any).webSearch
        }
        // ── バックエンド取り込み（初回のみ）──
        // localStorage 側にクラウドキーが未登録（token/secret 両方非空のエントリが1つも無い）
        // 場合に限り、バックエンド（cloud-credentials.enc）に保存済みのキーを「テスト」として
        // 取り込み、認証情報画面に表示する。既存の非空エントリがあればユーザー入力を尊重し取り込まない。
        try {
          const cloudSt: ServiceState = s.cloud ?? { entries: [], activeId: null }
          const hasCloudKey = cloudSt.entries.some(
            e => (e.values.token ?? '').trim() && (e.values.secret ?? '').trim()
          )
          if (!hasCloudKey && (await window.electronAPI.cloud.hasKey())) {
            const c = await window.electronAPI.cloud.loadKey()
            if (c && c.token && c.secret) {
              const e: Entry = { id: uid(), label: 'テスト', values: { token: c.token, secret: c.secret } }
              s.cloud = { entries: [...cloudSt.entries, e], activeId: e.id }
              // STORE_KEY へ永続化（次回以降は localStorage 側に存在するので再取り込みしない）
              try {
                const enc2 = await window.electronAPI.secure.encrypt(JSON.stringify(s))
                if (enc2) localStorage.setItem(STORE_KEY, enc2)
              } catch { /* ignore */ }
            }
          }
        } catch { /* ignore（取り込み失敗時は通常表示のまま） */ }
        setStore(s)
      } catch {
        setStore(migrate(null, apiKey))
      }
    })()
  }, [])

  const svc = (id: string) => store[id] ?? { entries: [], activeId: null }

  const addEntry = (id: string) => {
    setDirty(true)
    setStore(prev => {
      const e: Entry = { id: uid(), label: `項目 ${prev[id].entries.length + 1}`, values: {} }
      const next = { ...prev, [id]: { entries: [...prev[id].entries, e], activeId: prev[id].activeId ?? e.id } }
      return next
    })
  }
  const removeEntry = (id: string, eid: string) => {
    setDirty(true)
    setStore(prev => {
      const entries = prev[id].entries.filter(e => e.id !== eid)
      const activeId = prev[id].activeId === eid ? (entries[0]?.id ?? null) : prev[id].activeId
      return { ...prev, [id]: { entries, activeId } }
    })
  }
  const setLabel = (id: string, eid: string, label: string) => {
    setDirty(true)
    setStore(prev => ({ ...prev, [id]: { ...prev[id], entries: prev[id].entries.map(e => e.id === eid ? { ...e, label } : e) } }))
  }
  const setValue = (id: string, eid: string, key: string, v: string) => {
    setDirty(true)
    setStore(prev => ({ ...prev, [id]: { ...prev[id], entries: prev[id].entries.map(e => e.id === eid ? { ...e, values: { ...e.values, [key]: v } } : e) } }))
  }
  const setActive = (id: string, eid: string) => {
    setDirty(true)
    setStore(prev => ({ ...prev, [id]: { ...prev[id], activeId: eid } }))
  }

  // ── Web検索カード用：1サービス＝キー1つとして読み書きする ──
  const singleKey = (id: string) => {
    const st = svc(id)
    const e = st.entries.find(x => x.id === st.activeId) ?? st.entries[0]
    return e?.values?.apiKey ?? ''
  }
  const setSingleKey = (id: string, v: string) => {
    setDirty(true)
    setStore(prev => {
      const st = prev[id] ?? { entries: [], activeId: null }
      if (st.entries.length === 0) {
        const e: Entry = { id: uid(), label: '既定', values: { apiKey: v } }
        return { ...prev, [id]: { entries: [e], activeId: e.id } }
      }
      const targetId = st.activeId ?? st.entries[0].id
      return {
        ...prev,
        [id]: { ...st, entries: st.entries.map(e => e.id === targetId ? { ...e, values: { ...e.values, apiKey: v } } : e) },
      }
    })
  }

  const save = async () => {
    try {
      const enc = await window.electronAPI.secure.encrypt(JSON.stringify(store))
      if (enc) localStorage.setItem(STORE_KEY, enc)
    } catch { /* ignore */ }
    // クラウドの「使用中」エントリをバックエンド（cloud-credentials.enc）へ同期する。
    // 認証情報＝唯一の入力場所。ここだけが saveKey/clearKey を呼ぶ。
    try {
      const cloud = svc('cloud')
      const activeEntry = cloud.entries.find(e => e.id === cloud.activeId) ?? null
      const token = (activeEntry?.values.token ?? '').trim()
      const secret = (activeEntry?.values.secret ?? '').trim()
      if (token && secret) {
        await window.electronAPI.cloud.saveKey(token, secret)
      } else {
        // 使用中エントリが無い、または token/secret が空 → 未登録としてバックエンドをクリア
        await window.electronAPI.cloud.clearKey()
      }
    } catch { /* ignore（同期失敗してもローカル保存は完了している） */ }
    // レジストリ認証は ③公開→さくらのAppRun（ensureRegistry）が自動作成・保存するため、ここでは同期しない。
    // AppRunPanel 等が登録状態を取り直すための通知
    window.dispatchEvent(new Event('sakura:credentials-changed'))
    // AIキーごとの月間上限を予算設定へ反映
    for (const e of svc('aiEngine').entries) {
      const key = (e.values.apiKey ?? '').trim()
      if (!key) continue
      const lim = e.values._limit
      let resolved: number | null | undefined
      if (lim === 'x') resolved = null // 無制限
      else if (typeof lim === 'string' && lim.startsWith('a:')) {
        const n = toHankakuDigits(lim.slice(2)) // 保存時に半角数字へ正規化
        resolved = n === '' ? undefined : Number(n) // 空欄は既定扱い
      } else resolved = undefined // 既定
      setKeyLimit(key, resolved)
    }
    // 「使用中」キーをチャットへ反映
    const ai = svc('aiEngine')
    const active = ai.entries.find(e => e.id === ai.activeId) ?? ai.entries[0]
    onSetApiKey((active?.values.apiKey ?? '').trim())
    setDirty(false) // 保存完了→未保存の変更は無くなった
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  // 閉じる操作（背景クリック・✕・「閉じる」ボタン）の共通ハンドラ（所見5）。
  // 未保存の変更（dirty）があるときだけ確認を挟み、破棄を選んだ場合のみ閉じる。
  // 「保存」ボタン経由の閉じる（save 後にユーザーが改めて閉じる）は dirty=false なので確認は出ない。
  const requestClose = () => {
    if (dirty && !window.confirm('保存していない変更があります。破棄して閉じますか？')) return
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={requestClose}>
      <div className="w-[560px] max-h-[88vh] overflow-y-auto bg-elevated rounded-2xl border border-line shadow-2xl fade-in" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-6 pt-6 pb-4 sticky top-0 bg-elevated z-10">
          <SakuraLogo size={24} />
          <div>
            <h2 className="text-lg font-bold text-ink">認証情報（APIキー）</h2>
            <p className="text-xs text-ink-secondary">さくらの各サービスのキーを管理（複数登録可）</p>
          </div>
          <button onClick={requestClose} className="ml-auto text-ink-muted hover:text-ink w-7 h-7 rounded-lg hover:bg-overlay">✕</button>
        </div>

        <div className="px-6 pb-6 space-y-4">
          <p className="text-[11px] text-ink-muted bg-surface border border-line rounded-lg px-3 py-2">
            🔒 入力した値は <b className="text-ink-secondary">Macの安全な保管領域（キーチェーン）で暗号化して保存</b>されます。
          </p>

          {SERVICES.filter(def => !def.custom).map(def => {
            const st = svc(def.id)
            return (
              <div key={def.id} className="bg-surface/40 border border-line rounded-xl p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h3 className="text-sm font-semibold text-ink">{def.title}</h3>
                    <p className="text-[11px] text-ink-muted mt-0.5">{def.hint}</p>
                    {/* さくらのVPS は公開機能（②初期セットアップ／③公開）としては開発中（targetProfiles で
                        非表示）。V1a時点では「① 接続」（鍵認証での疎通確認）のみ利用できる。 */}
                    {def.id === 'vps' && (
                      <p className="text-[11px] text-brand-yellow mt-0.5">※ VPSでの公開機能は開発中です（現在は「🚀 公開」→さくらのVPSの「① 接続」のみ利用できます）</p>
                    )}
                  </div>
          {/* ── 読めなかったことを、はっきり言う（2026-08-19 実機）──────────────
              復号できないのに「未登録」と見せると、利用者はそこへ入力し直し、
              **元の設定が上書きされて消える**。署名の違うビルド（署名版と手元の
              未署名ビルド）はキーチェーンの鍵が別になるため、実際に起こる。 */}
          {unreadable && (
            <div className="rounded-xl border border-brand-red/60 bg-surface p-3 text-xs text-ink leading-relaxed select-text">
              ⚠️ <b>保存されている設定を読み取れませんでした。</b>
              このアプリとは<b>別の版（署名の異なるビルド）で保存された</b>可能性があります。
              下の入力欄は「未登録」に見えていますが、<b className="text-brand-red">
              このまま保存すると、元の設定は失われます</b>。
              元の版のアプリで開くと読めることがあります。
            </div>
          )}
                  <button onClick={() => addEntry(def.id)} className="text-xs font-medium text-sakura hover:underline flex-none">＋ 追加</button>
                </div>

                {st.entries.length === 0 && (
                  <p className="text-[11px] text-ink-muted py-2">未登録（「＋ 追加」で登録）</p>
                )}

                <div className="space-y-3">
                  {st.entries.map(e => (
                    <div key={e.id} className="bg-elevated border border-line rounded-lg p-3 space-y-2.5">
                      <div className="flex items-center gap-2">
                        {def.active && (
                          <label className="flex items-center gap-1 text-[11px] text-ink-secondary cursor-pointer flex-none" title="チャットで使用するキー">
                            <input type="radio" checked={st.activeId === e.id} onChange={() => setActive(def.id, e.id)} />
                            使用中
                          </label>
                        )}
                        <input
                          value={e.label}
                          onChange={ev => setLabel(def.id, e.id, ev.target.value)}
                          placeholder="名前（例: 本番）"
                          className="flex-1 bg-surface border border-line rounded-md px-2 py-1 text-xs font-medium text-ink outline-none focus:border-sakura"
                        />
                        <button onClick={() => removeEntry(def.id, e.id)} className="text-xs text-ink-muted hover:text-brand-red flex-none px-1" title="削除">🗑</button>
                      </div>
                      {def.fields.map(f => (
                        <Field key={f.key} def={f} value={e.values[f.key] ?? ''} onChange={v => setValue(def.id, e.id, f.key, v)} />
                      ))}
                      {def.id === 'aiEngine' && <KeyTestButton apiKey={e.values.apiKey ?? ''} />}
                      {def.id === 'github' && <GithubTestButton apiKey={e.values.apiKey ?? ''} />}
                      {def.id === 'anthropic' && <AnthropicTestButton apiKey={e.values.apiKey ?? ''} />}
                      {def.id === 'hanamii' && <HanamiiTestButton token={e.values.apiKey ?? ''} />}
                      {def.id === 'vercel' && <VercelTestButton token={e.values.apiKey ?? ''} teamId={e.values.teamId ?? ''} />}
                      {def.id === 'vps' && (
                        <VpsKeyStatus
                          hasKey={!!(e.values.privateKey && e.values.publicKey)}
                          onClear={async () => {
                            if (!window.confirm('鍵を消去します（再生成が必要になります）。よろしいですか？')) return
                            await clearVpsKeypair(e.id)
                          }}
                        />
                      )}
                      {def.budget && (
                        <LimitControl value={e.values._limit ?? ''} onChange={v => setValue(def.id, e.id, '_limit', v)} />
                      )}
                    </div>
                  ))}
                </div>
                {def.id === 'github' && <div className="mt-3"><GithubPatGuide /></div>}
                {def.id === 'anthropic' && <div className="mt-3"><AnthropicKeyGuide /></div>}
              </div>
            )
          })}

          {/* コンテナレジストリ（③公開→AppRun が自動作成・保存。ここでは読み取り専用で状況表示） */}
          <div className="bg-surface/40 border border-line rounded-xl p-4 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">コンテナレジストリ（自動管理）</h3>
              <p className="text-[11px] text-ink-muted mt-0.5">
                ③公開→「さくらのAppRun」で自動作成・保存されます。通常は操作不要です。
              </p>
            </div>
            {regInfo ? (
              <div className="bg-elevated border border-line rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-brand-green font-medium">登録済み</span>
                  <button
                    onClick={async () => {
                      await window.electronAPI.registry.clearKey()
                      await refreshRegInfo()
                      window.dispatchEvent(new Event('sakura:credentials-changed'))
                    }}
                    className="text-[11px] text-ink-muted hover:text-brand-red transition-colors"
                    title="登録済みのレジストリ認証を消去します（トラブル時用。次回の③公開で再作成されます）"
                  >消去</button>
                </div>
                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-ink-muted flex-none w-16">サーバ</span>
                    <span className="text-ink font-mono break-all">{regInfo.name}.sakuracr.jp</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-ink-muted flex-none w-16">ユーザー</span>
                    <span className="text-ink font-mono break-all">{regInfo.user}</span>
                  </div>
                  {/* ── パスワードは見えるようにする（2026-08-22 Ryosuke 指摘）──────
                      ここだけ 👁 が無く、**利用者が自分の持ち物を取り出せなかった**。
                      ほかのキーは利用者が発行して手元に控えがあるが、**この値は Koto が
                      自動生成したもので Koto の中にしか存在しない**。見えないままだと、
                      docker で自分のイメージを取ることも、Koto を離れることもできない。 */}
                  <div className="flex items-center gap-2">
                    <span className="text-ink-muted flex-none w-16">パスワード</span>
                    <span className="text-ink font-mono break-all flex-1 select-text">{showRegPw ? regInfo.password : '••••••••'}</span>
                    <button
                      onClick={() => setShowRegPw(v => !v)}
                      className="flex-none text-[11px] text-ink-muted hover:text-ink"
                      title={showRegPw ? '隠す' : '表示'}
                    >{showRegPw ? '🙈 隠す' : '👁 表示'}</button>
                    <CopyButton text={regInfo.password} title="パスワードをコピー" />
                  </div>
                  <p className="text-[10px] text-ink-muted leading-relaxed">
                    この値は Koto が作って保存したもので、<b>ほかのどこにも控えがありません</b>。
                    ご自身で <code>docker login {regInfo.name}.sakuracr.jp</code> するときにも使えます。
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-ink-muted">未登録（さくらのAppRun を公開すると自動で作成されます）</p>
            )}
          </div>

          {/* Web検索（Tavily / Brave のキーと優先順位を1枠に統合） */}
          <div className="bg-surface/40 border border-line rounded-xl p-4 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">Web検索</h3>
              <p className="text-[11px] text-ink-muted mt-0.5">
                AIチャットの検索機能に使用。<b className="text-ink-secondary">どちらか一方の登録でOK</b>です（両方登録時は優先側を使用）。
              </p>
            </div>
            <Field
              def={{ key: 'apiKey', label: 'Tavily APIキー（無料 月1,000回・クレカ不要 / app.tavily.com）', secret: true, placeholder: 'tvly-…' }}
              value={singleKey('tavily')}
              onChange={v => setSingleKey('tavily', v)}
            />
            <Field
              def={{ key: 'apiKey', label: 'Brave Search APIキー（毎月$5クレジット＝約1,000回 / brave.com/search/api）', secret: true, placeholder: 'X-Subscription-Token' }}
              value={singleKey('braveSearch')}
              onChange={v => setSingleKey('braveSearch', v)}
            />
            <div>
              <label className="text-[11px] font-medium text-ink-secondary">優先して使うサービス（未登録側は自動でもう一方を使用）</label>
              <div className="flex gap-1.5 mt-1">
                {([['tavily', 'Tavily'], ['brave', 'Brave']] as [SearchProvider, string][]).map(([p, label]) => (
                  <button
                    key={p}
                    onClick={() => changeSearchPref(p)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      searchPref === p
                        ? 'sakura-gradient text-white border-transparent'
                        : 'bg-surface text-ink-secondary border-line hover:text-ink hover:border-sakura'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button onClick={requestClose} className="flex-1 py-2.5 rounded-xl text-sm font-medium text-ink-secondary bg-surface border border-line hover:text-ink transition-colors">閉じる</button>
            <button onClick={save} className="flex-1 py-2.5 rounded-xl text-sm font-semibold sakura-gradient text-white hover:opacity-90 transition-opacity">
              {saved ? '✓ 保存しました' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
