// client.ts — Claude（Anthropic API）疎通確認 ＋ Agent SDK ネイティブバイナリ解決。C系 C1（土台）。
//
// src/main/hanamii/client.ts / src/main/github/client.ts と同じ構成を踏襲する。
// Electron メインプロセス（Node）専用: グローバルの fetch / AbortSignal.timeout を用いる純粋ロジックのみで、
// electron や renderer 側のコードは一切 import しない（esbuild/vitest で単体テスト可能な状態を保つ）。
//
// 認証（接続テスト）: `GET /v1/models` を `x-api-key: <key>` ＋ `anthropic-version: 2023-06-01` ヘッダで呼ぶ
// （公式リファレンスで確認済み・Bearer 形式ではない点に注意）。
// キーは方式B（renderer が引数で渡す。main には保存しない）。
//
// バイナリ解決: @anthropic-ai/claude-agent-sdk はネイティブCLIバイナリを
// プラットフォーム別 optional dependency（例: @anthropic-ai/claude-agent-sdk-darwin-arm64）として同梱する。
// SDK 本体（sdk.mjs）は内部で `${パッケージ名}/claude(.exe)` を require.resolve して解決しており、
// 本ファイルの resolveClaudeBinary() は同じ規約を踏襲する（2026-07-10 実インストールして確認済み。
// darwin-arm64 環境では node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude に240MB超の実行ファイルが入る）。

import * as fs from 'fs'
import { spawn } from 'child_process'

/** Anthropic API のベースURL。 */
export const ANTHROPIC_API_BASE = 'https://api.anthropic.com'
export const ANTHROPIC_MODELS_PATH = '/v1/models'
/** APIバージョンヘッダ（2026-07時点で公式リファレンス確認済みの安定版）。 */
export const ANTHROPIC_API_VERSION = '2023-06-01'

/** Agent SDK のネイティブバイナリ用 optional dependency のパッケージ名プレフィックス。 */
const CLAUDE_SDK_PACKAGE_PREFIX = '@anthropic-ai/claude-agent-sdk'

// ── 純粋関数（Vitest でテスト） ─────────────────────────────────────

/** モデル一覧APIの応答から件数を取り出す（純粋）。data が配列でなければ null。 */
export function parseModelsCount(json: unknown): number | null {
  const data = (json as any)?.data
  return Array.isArray(data) ? data.length : null
}

/** ライブ取得したClaudeモデル1件分（renderer側 claudeMode.ts の CLAUDE_MODELS とマージするための最小情報）。 */
export interface AnthropicModelInfo { id: string; displayName: string; createdAt: string }

/** モデル一覧APIの応答から AnthropicModelInfo[] を取り出す（純粋）。
 *  id が文字列の要素のみ採用し、応答の順序（新しいモデルが先頭）をそのまま維持する。
 *  display_name / created_at が無い・非文字列のときは id / 空文字にフォールバックする。 */
export function parseAnthropicModels(json: unknown): AnthropicModelInfo[] {
  const data = (json as any)?.data
  if (!Array.isArray(data)) return []
  const out: AnthropicModelInfo[] = []
  for (const item of data) {
    if (item && typeof item.id === 'string') {
      out.push({
        id: item.id,
        displayName: typeof item.display_name === 'string' ? item.display_name : item.id,
        createdAt: typeof item.created_at === 'string' ? item.created_at : '',
      })
    }
  }
  return out
}

/** HTTPステータスから日本語のエラーメッセージを組み立てる（純粋）。
 *  401はキー再発行への誘導（既存 aiTools.ts の formatChatError のトーンを踏襲）。 */
export function describeClaudeError(status: number): string {
  if (status === 401) {
    return (
      'APIキーが認証されませんでした（401）。キーが無効・失効した可能性があります。\n\n' +
      '🔑 platform.claude.com（Claude Console）でキーを確認し、うまくいかない場合は新しいキーを発行して入れ直してください。\n' +
      '（「🔌 接続テスト」で有効かどうか再確認できます）'
    )
  }
  if (status === 403) {
    return 'アクセスが拒否されました（403）。APIキーの権限・組織の設定を確認してください。'
  }
  if (status === 429) {
    return 'リクエストが多すぎます（429）。しばらく待ってから、もう一度お試しください。'
  }
  if (status >= 500) {
    return `Anthropic 側で問題が発生しています（HTTP ${status}）。しばらく待ってから、もう一度お試しください。`
  }
  return `接続に失敗しました（HTTP ${status}）`
}

/** パス文字列中の `app.asar` を `app.asar.unpacked` に置換する（純粋）。
 *  パッケージ版（electron-builder asar化）で、asar内の仮想パスを spawn 可能な実体パスへ変換するため
 *  （node-pty と同様の事情。asar はネイティブ実行ファイルを直接 spawn できない）。
 *  既に `app.asar.unpacked` を含む場合や `app.asar` を含まない場合は変更しない（冪等）。 */
export function toUnpackedPath(p: string): string {
  return p.replace(/app\.asar(?!\.unpacked)/g, 'app.asar.unpacked')
}

/** 現在の platform/arch から、ネイティブバイナリ optional dependency の候補パッケージ名を列挙する（純粋）。
 *  @anthropic-ai/claude-agent-sdk の内部実装（sdk.mjs）と同じ規約:
 *  linux は glibc 版を優先しつつ musl 版も候補に含める（musl検出はせず両方試す簡略版）。 */
export function candidatePackageNames(platform: string, arch: string): string[] {
  if (platform === 'android') return [`${CLAUDE_SDK_PACKAGE_PREFIX}-linux-${arch}-android`]
  if (platform === 'linux') return [`${CLAUDE_SDK_PACKAGE_PREFIX}-linux-${arch}`, `${CLAUDE_SDK_PACKAGE_PREFIX}-linux-${arch}-musl`]
  return [`${CLAUDE_SDK_PACKAGE_PREFIX}-${platform}-${arch}`]
}

// ── 副作用を伴う関数（ファイルシステム／子プロセス／ネットワーク） ────────────

/**
 * Agent SDK のネイティブCLIバイナリの実体パスを解決する（見つからなければ null）。
 * candidatePackageNames() の各候補について `<パッケージ名>/claude(.exe)` を require.resolve し、
 * 見つかった仮想パスを toUnpackedPath() で実体パスへ変換したうえで fs.existsSync で確認する。
 */
export function resolveClaudeBinary(): string | null {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const candidates = candidatePackageNames(process.platform, process.arch)
  for (const pkg of candidates) {
    try {
      const resolved = require.resolve(`${pkg}/claude${ext}`)
      const unpacked = toUnpackedPath(resolved)
      if (fs.existsSync(unpacked)) return unpacked
    } catch {
      // このプラットフォーム向けの optional dependency が未インストール → 次候補へ
    }
  }
  return null
}

/** 解決したバイナリを `--version` で起動して疎通確認する（10秒タイムアウト）。 */
export async function checkClaudeBinary(): Promise<{ ok: boolean; version?: string; path?: string; message?: string }> {
  const binPath = resolveClaudeBinary()
  if (!binPath) {
    return {
      ok: false,
      message: 'Claude Agent SDK のネイティブバイナリが見つかりませんでした（node_modules の optional dependency が未インストールの可能性があります）',
    }
  }
  return new Promise(resolve => {
    let out = ''
    let settled = false
    // timer は spawn が同期 throw した場合でも finish() から安全に参照できるよう、const ではなく先行宣言する
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: { ok: boolean; version?: string; path?: string; message?: string }) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binPath, ['--version'])
    } catch (e: any) {
      finish({ ok: false, message: e?.message ?? String(e) })
      return
    }
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 既に終了 */ }
      finish({ ok: false, message: 'バイナリの起動がタイムアウトしました（10秒）' })
    }, 10000)
    child.stdout?.on('data', d => { out += d })
    child.stderr?.on('data', d => { out += d })
    child.on('error', (e: any) => finish({ ok: false, message: e?.message ?? String(e) }))
    child.on('close', code => {
      if (code === 0) {
        const m = /^([\d.]+)/.exec(out.trim())
        finish({ ok: true, version: m ? m[1] : out.trim(), path: binPath })
      } else {
        finish({ ok: false, message: `バイナリの起動に失敗しました（終了コード ${code}）` })
      }
    })
  })
}

/** Anthropic APIキーの疎通テスト（GET /v1/models）。15秒タイムアウト。
 *  成功時はモデル件数、失敗時は describeClaudeError() による日本語メッセージを返す。 */
export async function testAnthropicKey(key: string): Promise<{ ok: boolean; modelCount?: number; message?: string }> {
  const trimmed = (key ?? '').trim()
  if (!trimmed) return { ok: false, message: 'Claude（Anthropic API）のAPIキーが未登録です' }
  try {
    const res = await fetch(ANTHROPIC_API_BASE + ANTHROPIC_MODELS_PATH, {
      method: 'GET',
      headers: {
        'x-api-key': trimmed,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    if (!res.ok) return { ok: false, message: describeClaudeError(res.status) }
    const modelCount = parseModelsCount(json)
    return { ok: true, modelCount: modelCount ?? 0 }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
}

/** Anthropic APIキーで実際に提供されているClaudeモデル一覧をライブ取得する（GET /v1/models）。15秒タイムアウト。
 *  さくらのAI Engine 側（sakura:models）と同じ考え方: renderer は起動時にこれを呼び、埋め込みの固定表
 *  （claudeMode.ts CLAUDE_MODELS）を実際のラインナップで置き換える。既定の limit=20 だと取りこぼすため
 *  limit=100 を明示する。応答は「新しいモデルが先頭」の順で返るため、その順序をそのままUIの並びに使う
 *  （このファイル内で並び替えない）。 */
export async function listAnthropicModels(key: string): Promise<{ ok: boolean; models?: AnthropicModelInfo[]; message?: string }> {
  const trimmed = (key ?? '').trim()
  if (!trimmed) return { ok: false, message: 'Claude（Anthropic API）のAPIキーが未登録です' }
  try {
    const res = await fetch(`${ANTHROPIC_API_BASE}${ANTHROPIC_MODELS_PATH}?limit=100`, {
      method: 'GET',
      headers: {
        'x-api-key': trimmed,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    if (!res.ok) return { ok: false, message: describeClaudeError(res.status) }
    return { ok: true, models: parseAnthropicModels(json) }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
}
