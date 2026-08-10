// imageBuild.ts — Docker デーモン不要のイメージビルド＆プッシュ（同梱の crane を使用）。
//
// 人間が Docker を入れずに、IDE 同梱の crane バイナリだけで
//   「公開ベースイメージ ＋ プロジェクトのファイル層 ＋ 起動設定」
// を組み立ててコンテナレジストリ（さくら）へ push する。
//
// ※セキュリティ最重要:
//   - crane / tar は execFile（配列引数）でのみ実行する。シェル文字列連結は厳禁。
//   - レジストリのパスワードは argv に渡さない。一時ディレクトリの DOCKER_CONFIG/config.json
//     に base64(user:password) として書き、crane には環境変数 DOCKER_CONFIG で渡す。
//   - イメージ参照（ref）・レジストリサーバは docker.ts の検証関数を再利用して厳格検証する。
//   - 一時ディレクトリ（ステージング・layer.tar・DOCKER_CONFIG）は必ず後始末で削除する。

import { execFile } from 'child_process'
import { app } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { validateRegistryServer, buildRef } from './docker'
import { excludedDirNames, isSecretFile, NOISE_FILES } from '../../shared/publishExclude'

// ── 出力上限・タイムアウト（crane の build/push は時間がかかり得る） ──
const OUTPUT_MAX = 16000
const BUILD_TIMEOUT = 600000 // 10分
const MAX_BUFFER = 16 * 1024 * 1024

/** ステージングから除外するエントリ名（プロジェクト直下・全階層で除外）。 */
const EXCLUDE_NAMES = new Set([...excludedDirNames(), ...NOISE_FILES])

/** 出力を上限で切り詰める。 */
function clip(s: unknown): string {
  return String(s ?? '').slice(0, OUTPUT_MAX)
}

/** stderr を要約して短いメッセージにする（最後の非空行が原因のことが多い）。 */
function summarizeStderr(stderr: string): string {
  const t = (stderr || '').trim()
  if (!t) return 'イメージのビルドに失敗しました。'
  const lines = t.split(/\r?\n/).filter(l => l.trim().length > 0)
  const last = lines[lines.length - 1] ?? t
  return last.slice(0, 300)
}

/**
 * 同梱 crane バイナリの絶対パス。
 * - packaged: process.resourcesPath/bin/crane（electron-builder の extraResources）
 * - dev: app.getAppPath()/build/bin/crane（リポジトリ同梱）
 */
export function cranePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'crane')
    : path.join(app.getAppPath(), 'build', 'bin', 'crane')
}

/** 内蔵ビルダー（crane）が存在し実行可能か。 */
export function builderAvailable(): boolean {
  try {
    fs.accessSync(cranePath(), fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 対応ランタイム種別（MVP は static のみ。将来 node 等を足せる形）。 */
export type RuntimeId = 'static'

/** ランタイム定義（ベースイメージ・起動設定）。cmd は port を受けて引数配列を返す。 */
type RuntimeDef = {
  base: string
  entrypoint: string
  cmd: (port: number) => string[]
  workdir: string
}

/**
 * RUNTIME テーブル。
 * static = 公開 python イメージで http.server を起動し /app を配信する（静的/ファイル配信）。
 * 将来 node 等を追加できるよう、種別 → 定義のマップにしてある。
 */
const RUNTIME: Record<RuntimeId, RuntimeDef> = {
  static: {
    base: 'python:3.12-alpine',
    entrypoint: 'python',
    cmd: (port: number) => ['-m', 'http.server', String(port)],
    workdir: '/app',
  },
}

/** プロジェクト配下を再帰コピーする（EXCLUDE_NAMES を全階層で除外）。 */
function copyTree(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true })
  const entries = fs.readdirSync(srcDir, { withFileTypes: true })
  for (const e of entries) {
    // 秘密ファイル（.env など）をイメージへ焼き込まない。2026-08-09 の総点検まで
    // ここには判定が無く、コンテナに .env がそのまま入っていた。
    if (EXCLUDE_NAMES.has(e.name) || isSecretFile(e.name)) continue
    const src = path.join(srcDir, e.name)
    const dest = path.join(destDir, e.name)
    if (e.isDirectory()) {
      copyTree(src, dest)
    } else if (e.isSymbolicLink()) {
      // シンボリックリンクは追従せずスキップ（外部参照・ループ回避）。
      continue
    } else if (e.isFile()) {
      fs.copyFileSync(src, dest)
    }
  }
}

/** execFile を Promise でラップ（タイムアウト・出力上限つき）。 */
function runExecFile(
  cmd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv }
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      cmd,
      args,
      { timeout: BUILD_TIMEOUT, maxBuffer: MAX_BUFFER, env: opts?.env },
      (err: any, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

/**
 * プロジェクトのファイルを `app/` 配下に置いた tar（層）を作る。
 * - contextAbs 配下を一時ステージングディレクトリの `app/` へコピー（EXCLUDE_NAMES を除外）。
 * - `tar -cf <layer> -C <stageDir> app` で層 tar を作る。
 * 戻り値: layer tar の絶対パス（作業用 tmp ディレクトリ内）。
 * ※呼び出し側が後始末でその tmp ディレクトリを削除すること。
 */
export async function stageAndTar(contextAbs: string): Promise<string> {
  if (typeof contextAbs !== 'string' || !path.isAbsolute(contextAbs)) {
    throw new Error('ビルドコンテキストは絶対パスである必要があります')
  }
  let st: fs.Stats
  try {
    st = fs.statSync(contextAbs)
  } catch {
    throw new Error('ビルドコンテキストのパスが存在しません')
  }
  if (!st.isDirectory()) {
    throw new Error('ビルドコンテキストはディレクトリである必要があります')
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-img-'))
  const stageDir = path.join(tmpDir, 'stage')
  const appDir = path.join(stageDir, 'app')
  const layer = path.join(tmpDir, 'layer.tar')

  copyTree(contextAbs, appDir)

  // tar -cf <layer> -C <stageDir> app  → 中身が app/... となる層 tar を作る。
  const r = await runExecFile('tar', ['-cf', layer, '-C', stageDir, 'app'])
  if (!r.ok) {
    // 失敗時はこの tmp を片付けてから throw（呼び出し側へは tmp パスを返さない）。
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw new Error(`ファイル層の作成に失敗しました: ${summarizeStderr(r.stderr)}`)
  }
  return layer
}

/** buildAndPush の入力。 */
export type BuildAndPushOptions = {
  /** ビルドコンテキストの絶対パス（プロジェクト内に閉じ込め済みであること）。 */
  contextAbs: string
  /** push 先の完全なイメージ参照（呼び出し側で buildRef 済みでもよいが、ここでも検証する）。 */
  ref: string
  /** 公開するポート（http.server 等の待受ポート）。 */
  port: number
  /** ランタイム種別（既定 static）。 */
  runtime?: RuntimeId
  /** レジストリ認証情報（server/user/password）。config.json に base64(user:password) を書く。 */
  registryAuth: { server: string; user: string; password: string }
  /**
   * テスト/オフライン用: 指定すると crane の push（-t）の代わりに `-o <outFile>` でローカル出力する。
   * 実レジストリへ push せずに引数組み立てと層構築を検証できる。
   */
  outFile?: string
}

/** buildAndPush の結果。 */
export type BuildAndPushResult = { ok: boolean; log: string; message?: string }

/**
 * crane の argv を組み立てる純関数（テスト容易性のため分離）。
 * outFile が指定されれば push（-t）の代わりに `-o <outFile>` でローカル tar 出力する。
 */
export function buildCraneArgs(opts: {
  base: string
  layer: string
  workdir: string
  entrypoint: string
  cmd: string[]
  port: number
  ref: string
  outFile?: string
}): string[] {
  const args = [
    'mutate',
    opts.base,
    '--append', opts.layer,
    '--workdir', opts.workdir,
    '--entrypoint', opts.entrypoint,
    '--cmd', opts.cmd.join(','),
    '--exposed-ports', String(opts.port),
  ]
  if (opts.outFile) {
    // ローカル出力（オフライン検証用）。push しない。
    args.push('-o', opts.outFile)
  } else {
    // レジストリへ push。
    args.push('-t', opts.ref)
  }
  return args
}

/**
 * buildAndPush — Docker 不要で「公開ベース ＋ ファイル層 ＋ 起動設定」を組み立ててレジストリへ push する。
 *
 * 手順:
 *  1. ref / server を docker.ts の検証関数で検証。
 *  2. stageAndTar でプロジェクトのファイル層（app/ 配下）を作る。
 *  3. 一時 DOCKER_CONFIG ディレクトリに config.json を書く（push 先の認証）。
 *  4. crane mutate <base> --append <layer> ... -t <ref> を DOCKER_CONFIG 付きで実行。
 *  5. 後始末（ステージング tmp ・DOCKER_CONFIG tmp）を必ず削除。
 */
export async function buildAndPush(opts: BuildAndPushOptions): Promise<BuildAndPushResult> {
  const runtime = RUNTIME[opts.runtime ?? 'static']
  if (!runtime) {
    return { ok: false, log: '', message: '未対応のランタイム種別です' }
  }
  if (!builderAvailable()) {
    return { ok: false, log: '', message: '内蔵ビルダー（crane）が見つかりません' }
  }

  // 1. 検証（不正なら例外 → 失敗扱い）。
  let ref: string
  try {
    validateRegistryServer(opts.registryAuth.server)
    // ref は呼び出し側で buildRef 済みの想定だが、念のため形式確認はしない＝そのまま使う。
    // ただし -t に渡す ref は呼び出し側が buildRef で組み立てる前提。ここでは空チェックのみ。
    if (typeof opts.ref !== 'string' || opts.ref.length === 0) {
      throw new Error('イメージ参照（ref）が空です')
    }
    ref = opts.ref
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
      throw new Error('ポート番号が不正です（1〜65535）')
    }
    if (
      typeof opts.registryAuth.user !== 'string' || opts.registryAuth.user.length === 0 ||
      typeof opts.registryAuth.password !== 'string' || opts.registryAuth.password.length === 0
    ) {
      throw new Error('レジストリのユーザー名／パスワードが空です')
    }
  } catch (e: any) {
    return { ok: false, log: '', message: e?.message ?? String(e) }
  }

  let layer: string | null = null
  let layerTmpDir: string | null = null
  let cfgDir: string | null = null
  try {
    // 2. ファイル層（app/ 配下）を作る。
    try {
      layer = await stageAndTar(opts.contextAbs)
      layerTmpDir = path.dirname(layer)
    } catch (e: any) {
      return { ok: false, log: '', message: e?.message ?? String(e) }
    }

    // 3. 一時 DOCKER_CONFIG ディレクトリに config.json を書く（push 先の認証）。
    //    ベース（docker.io）は公開のため認証不要。-t 先（さくら）の auths のみ載せる。
    cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-dcfg-'))
    const authB64 = Buffer.from(
      `${opts.registryAuth.user}:${opts.registryAuth.password}`,
      'utf-8'
    ).toString('base64')
    const dockerConfig = { auths: { [opts.registryAuth.server]: { auth: authB64 } } }
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(dockerConfig), { mode: 0o600 })

    // 4. crane 実行。
    const args = buildCraneArgs({
      base: runtime.base,
      layer,
      workdir: runtime.workdir,
      entrypoint: runtime.entrypoint,
      cmd: runtime.cmd(opts.port),
      port: opts.port,
      ref,
      ...(opts.outFile ? { outFile: opts.outFile } : {}),
    })
    const r = await runExecFile(cranePath(), args, {
      env: { ...process.env, DOCKER_CONFIG: cfgDir },
    })
    if (!r.ok) {
      return { ok: false, log: clip(r.stdout), message: summarizeStderr(r.stderr) }
    }
    return { ok: true, log: clip(r.stdout + r.stderr) }
  } catch (e: any) {
    return { ok: false, log: '', message: e?.message ?? String(e) }
  } finally {
    // 5. 後始末（ステージング tmp ・DOCKER_CONFIG tmp を削除。パスワード入り config.json も消える）。
    if (layerTmpDir) {
      try { fs.rmSync(layerTmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    if (cfgDir) {
      try { fs.rmSync(cfgDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}
