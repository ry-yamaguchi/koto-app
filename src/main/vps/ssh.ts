// ssh.ts — さくらのVPS 公開機能: システムの ssh / ssh-keygen / ssh-keyscan を child_process で薄くラップする。
// 新規の native 依存は追加しない（remote.ts と同じ方式: execFile/spawn＋配列引数のみ）。
// docs/vps-plan.md §2.1・§4・「決定事項（2026-07-18）」準拠。
//
// 秘密の扱い（方式B・不変条件）:
// - 秘密鍵はここでも main のディスクに永続化しない。使う瞬間だけ os.tmpdir() へ 0600 で書き出し、
//   finally で必ず削除する（withPrivateKeyFile）。
// - パスワード（runSshWithPassword）はファイルへは一切書かない。ssh の子プロセスへ環境変数
//   （このプロセス限りのメモリ）として渡し、askpass ヘルパー経由で読ませる（後述）。
//
// ホスト鍵検証（MITM対策・TOFU）:
// - scanHostKey() で都度ホスト鍵を取得し、呼び出し元が持つ「既知の指紋」と一致するかをまず比較する。
// - 一致した場合のみ、今スキャンしたその鍵を専用の一時 known_hosts ファイルへ書き、
//   `UserKnownHostsFile=<一時ファイル> -o StrictHostKeyChecking=yes` で実際の ssh 接続にも
//   同じ鍵を強制検証させる（多重防御: 万一スキャンと接続の間に鍵が変わっても ssh 自身が弾く）。
// - 指紋が不一致なら**接続を試みずに**エラーを返す（自動で信頼しない）。

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { isValidHost, isValidPort, isValidUsername } from './validate'

const CONNECT_TIMEOUT_SEC = 10
const OVERALL_TIMEOUT_MS = 30000
const OUTPUT_MAX = 8000

interface ProcResult { ok: boolean; code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** 一意な一時ファイル名を作る（同時実行・再入でも衝突しない）。 */
function tmpName(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

/**
 * spawn を Promise 化する薄いヘルパー。
 * - input を渡すと子プロセスの stdin へ書き込んでから閉じる（リモートで `bash -s` として実行させる用途）。
 * - timeoutMs で全体をタイムアウトさせ、超過したら SIGKILL する（出力上限つき・ハングしない）。
 * - detached:true は POSIX の setsid 相当（制御端末を切り離す）。runSshWithPassword が
 *   askpass を確実に使わせるために使う（tty 経由のパスワード入力に迂回されないようにする）。
 */
function runProcess(file: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; detached?: boolean } = {}): Promise<ProcResult> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        env: opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !!opts.detached,
      })
    } catch (e: any) {
      resolve({ ok: false, code: null, stdout: '', stderr: e?.message ?? String(e), timedOut: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; try { child.kill('SIGKILL') } catch { /* ignore */ } }, opts.timeoutMs)
      : null
    const finish = (result: ProcResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    child.stdout?.on('data', d => { if (stdout.length < OUTPUT_MAX) stdout += d.toString() })
    child.stderr?.on('data', d => { if (stderr.length < OUTPUT_MAX) stderr += d.toString() })
    child.on('error', (e: any) => {
      finish({ ok: false, code: null, stdout: stdout.slice(0, OUTPUT_MAX), stderr: stderr.slice(0, OUTPUT_MAX) || String(e?.message ?? e), timedOut })
    })
    child.on('close', (code) => {
      finish({ ok: code === 0 && !timedOut, code, stdout: stdout.slice(0, OUTPUT_MAX), stderr: stderr.slice(0, OUTPUT_MAX), timedOut })
    })
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input)
    }
    child.stdin?.end()
  })
}

/** ssh/ssh-keyscan の stderr を初心者向けの日本語メッセージへ要約する（remote.ts の friendlySshError と同系統）。 */
function friendlyMessage(stderr: string): string {
  const s = (stderr || '').toLowerCase()
  if (s.includes('permission denied')) {
    return '認証に失敗しました（ユーザー名・パスワード、または鍵の設置状況を確認してください）'
  }
  if (s.includes('host key verification failed')) {
    return 'ホスト鍵の検証に失敗しました（サーバが再構築された、または通信が乗っ取られている可能性があります）'
  }
  if (s.includes('connection refused')) {
    return '接続を拒否されました（ポート番号やさくらのパケットフィルタ・ファイアウォール設定を確認してください）'
  }
  if (s.includes('could not resolve') || s.includes('name or service not known') || s.includes('nodename nor servname')) {
    return 'ホスト名を解決できませんでした（ホスト名/IPを確認してください）'
  }
  if (s.includes('connection timed out') || s.includes('operation timed out')) {
    return '接続がタイムアウトしました（ホスト名・ポート番号やサーバの起動状況を確認してください）'
  }
  if (s.includes('no route to host')) {
    return 'サーバに到達できませんでした（ネットワークやホスト名/IPを確認してください）'
  }
  return (stderr || '').trim().slice(0, 300) || '接続に失敗しました'
}

/**
 * ed25519 鍵ペアを新規生成して返す。一時ファイル（秘密鍵・公開鍵とも）は必ず削除する（finally）。
 * コメントは固定で 'koto-vps'（誰の鍵か分かるようにするだけで、秘密情報ではない）。
 */
export async function generateKeypair(): Promise<{ publicKey: string; privateKey: string }> {
  const base = tmpName('koto-vps-key')
  try {
    const r = await runProcess('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', base, '-C', 'koto-vps'], { timeoutMs: 10000 })
    if (!r.ok) throw new Error(`鍵の生成に失敗しました: ${r.stderr.trim() || r.stdout.trim() || '不明なエラー'}`)
    const privateKey = fs.readFileSync(base, 'utf8')
    const publicKey = fs.readFileSync(`${base}.pub`, 'utf8').trim()
    return { publicKey, privateKey }
  } finally {
    try { fs.rmSync(base, { force: true }) } catch { /* ignore */ }
    try { fs.rmSync(`${base}.pub`, { force: true }) } catch { /* ignore */ }
  }
}

/**
 * 秘密鍵を一時ファイル（0600・OSの一時ディレクトリ）に書き出して fn(keyPath) を実行し、
 * finally で必ず削除する。main のディスクへ秘密鍵を永続化しないための唯一の経路。
 */
export async function withPrivateKeyFile<T>(privateKey: string, fn: (keyPath: string) => Promise<T>): Promise<T> {
  const keyPath = tmpName('koto-vps-id')
  const content = privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`
  fs.writeFileSync(keyPath, content, { mode: 0o600 })
  fs.chmodSync(keyPath, 0o600) // umask の影響を受けないよう明示的に再設定
  try {
    return await fn(keyPath)
  } finally {
    try { fs.rmSync(keyPath, { force: true }) } catch { /* ignore */ }
  }
}

/** ssh-keyscan でホスト鍵を取得し、その指紋（SHA256:...）と生の鍵行を返す（TOFU用）。 */
export async function scanHostKey(host: string, port: number): Promise<{ ok: boolean; fingerprint?: string; keyLine?: string; message?: string }> {
  if (!isValidHost(host)) return { ok: false, message: 'ホスト名/IPの形式が不正です' }
  if (!isValidPort(port)) return { ok: false, message: 'ポート番号が不正です（1〜65535）' }
  const r = await runProcess('ssh-keyscan', ['-T', '5', '-p', String(port), '-t', 'ed25519', host], { timeoutMs: 12000 })
  const line = r.stdout.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'))
  if (!line) {
    return { ok: false, message: 'ホスト鍵を取得できませんでした（サーバが起動しているか、ホスト名/ポート番号を確認してください）' }
  }
  const fp = await runProcess('ssh-keygen', ['-lf', '/dev/stdin'], { input: `${line}\n`, timeoutMs: 5000 })
  const m = /(SHA256:[A-Za-z0-9+/]+)/.exec(fp.stdout)
  if (!m) return { ok: false, message: 'ホスト鍵の指紋を計算できませんでした' }
  return { ok: true, fingerprint: m[1], keyLine: line }
}

/** ssh-keyscan の生の鍵行（`<host> ssh-ed25519 ...`）から先頭のホスト名を取り除き、known_hosts 用の1行を作る。 */
function buildKnownHostsLine(host: string, port: number, keyLine: string): string {
  const parts = keyLine.trim().split(/\s+/)
  const keyTypeAndBody = parts.slice(1).join(' ')
  const hostField = port === 22 ? host : `[${host}]:${port}`
  return `${hostField} ${keyTypeAndBody}\n`
}

export interface RunSshOpts {
  host: string
  port: number
  user: string
  privateKey: string
  /** 既知のホスト鍵指紋（TOFUで記録済みの値）。scanHostKey の結果と一致しなければ接続を中断する。 */
  knownHostFingerprint: string
  /** リモートで `bash -s` として実行するスクリプト本体（stdin 経由で渡す。シェル引用の問題を避けるため）。 */
  command: string
  timeoutMs?: number
}

/**
 * 鍵認証でコマンド（スクリプト）を実行する。
 * - BatchMode=yes でパスワードプロンプトに固まらない。
 * - ホスト鍵は毎回 scanHostKey() で取得し直し、既知の指紋と比較する。不一致なら**接続を試みずに**エラーを返す
 *   （MITM対策）。一致した場合のみ、その鍵だけを含む一時 known_hosts で StrictHostKeyChecking=yes を強制する。
 */
export async function runSsh(opts: RunSshOpts): Promise<{ ok: boolean; stdout?: string; stderr?: string; message?: string }> {
  const { host, port, user, privateKey, knownHostFingerprint, command } = opts
  if (!isValidHost(host)) return { ok: false, message: 'ホスト名/IPの形式が不正です' }
  if (!isValidPort(port)) return { ok: false, message: 'ポート番号が不正です（1〜65535）' }
  if (!isValidUsername(user)) return { ok: false, message: 'ユーザー名の形式が不正です' }
  if (!privateKey) return { ok: false, message: '秘密鍵が指定されていません' }
  if (!knownHostFingerprint) return { ok: false, message: 'ホスト鍵の指紋が指定されていません（先にホスト鍵を確認してください）' }

  const scan = await scanHostKey(host, port)
  if (!scan.ok || !scan.keyLine || !scan.fingerprint) {
    return { ok: false, message: scan.message ?? 'ホスト鍵を確認できませんでした' }
  }
  if (scan.fingerprint !== knownHostFingerprint) {
    return {
      ok: false,
      message: `⚠️ ホスト鍵の指紋が記録済みの値と一致しません（記録済み: ${knownHostFingerprint} / 今回: ${scan.fingerprint}）。サーバが再構築された可能性のほか、通信が乗っ取られている（中間者攻撃）可能性もあるため、心当たりがなければ接続を中断してください。`,
    }
  }

  const knownHostsPath = tmpName('koto-vps-known')
  fs.writeFileSync(knownHostsPath, buildKnownHostsLine(host, port, scan.keyLine), { mode: 0o600 })
  try {
    return await withPrivateKeyFile(privateKey, async keyPath => {
      const args = [
        '-F', '/dev/null', // 利用者自身の ~/.ssh/config の影響を受けない
        '-i', keyPath,
        '-p', String(port),
        '-o', 'BatchMode=yes',
        '-o', `ConnectTimeout=${CONNECT_TIMEOUT_SEC}`,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'PasswordAuthentication=no',
        '-o', `UserKnownHostsFile=${knownHostsPath}`,
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'UpdateHostKeys=no',
        `${user}@${host}`,
        'bash', '-s',
      ]
      const r = await runProcess('ssh', args, { input: command, timeoutMs: opts.timeoutMs ?? OVERALL_TIMEOUT_MS })
      if (r.timedOut) return { ok: false, message: '接続がタイムアウトしました。ホスト名・ポート番号やネットワークを確認してください。' }
      if (!r.ok) return { ok: false, stdout: r.stdout, stderr: r.stderr, message: friendlyMessage(r.stderr) }
      return { ok: true, stdout: r.stdout, stderr: r.stderr }
    })
  } finally {
    try { fs.rmSync(knownHostsPath, { force: true }) } catch { /* ignore */ }
  }
}

export interface RunSshWithPasswordOpts {
  host: string
  port: number
  /** 初回接続に使うユーザー（さくらのVPSの初期ユーザー。通常 'root'）。 */
  user: string
  /** 初回のみ使用するパスワード。ファイルへは一切書かず、ssh子プロセスの環境変数として渡すのみ。 */
  password: string
  /** リモートで `bash -s` として実行する固定コマンド列（scripts.ts の buildInstallKeyCommands 等）。 */
  commands: string[]
  timeoutMs?: number
}

/**
 * ルートBの初回のみ: パスワード認証で固定コマンド列を実行する（鍵の設置まで。sshd強化は含まない）。
 *
 * macOS には sshpass は標準で入っていないため、OpenSSH 標準の SSH_ASKPASS 機構を使う:
 * - ssh の子プロセスは tty を持たない（spawn の stdio はすべてパイプ・pty ではない）ため、
 *   ssh はパスワード入力を対話プロンプトではなく askpass 経由で要求できる状態になる。
 * - `SSH_ASKPASS_REQUIRE=force`（OpenSSH 8.4+）を指定し、tty の有無やDISPLAYの設定に関わらず
 *   askpass を使わせる。
 * - SSH_ASKPASS には「標準出力へパスワードを印字するだけ」の小さなヘルパースクリプトを指す。
 *   このヘルパー自体にはパスワードを一切書き込まない。パスワードは環境変数
 *   `KOTO_VPS_ASKPASS_SECRET`（この ssh 子プロセス限りのメモリ上の値）から読ませる。
 * - detached:true（setsid相当）で呼び出し元プロセスの制御端末から切り離し、
 *   /dev/tty 経由の対話プロンプトに迂回されないようにする。
 *
 * 注意: この方式は macOS の OpenSSH クライアント（8.4以降・現行macOSは全て対象）を前提とする、
 * 公式にドキュメント化された headless パスワード認証の手段であり sshpass 等の非公式ラッパーではない。
 * ただし実機のパスワード認証VPSに対しては未検証（このタスクの範囲外）。
 */
export async function runSshWithPassword(opts: RunSshWithPasswordOpts): Promise<{ ok: boolean; fingerprint?: string; stdout?: string; stderr?: string; message?: string }> {
  const { host, port, user, password, commands } = opts
  if (!isValidHost(host)) return { ok: false, message: 'ホスト名/IPの形式が不正です' }
  if (!isValidPort(port)) return { ok: false, message: 'ポート番号が不正です（1〜65535）' }
  if (!isValidUsername(user)) return { ok: false, message: '接続ユーザー名の形式が不正です' }
  if (!password) return { ok: false, message: 'パスワードが未入力です' }
  if (!Array.isArray(commands) || commands.length === 0) return { ok: false, message: '実行するコマンドがありません' }

  const scan = await scanHostKey(host, port)
  if (!scan.ok || !scan.keyLine || !scan.fingerprint) {
    return { ok: false, message: scan.message ?? 'ホスト鍵を確認できませんでした' }
  }

  const knownHostsPath = tmpName('koto-vps-known')
  const askpassPath = `${tmpName('koto-vps-askpass')}.sh`
  fs.writeFileSync(knownHostsPath, buildKnownHostsLine(host, port, scan.keyLine), { mode: 0o600 })
  // askpass ヘルパー自体にはパスワードを書き込まない。環境変数から読んで標準出力へ流すだけ。
  fs.writeFileSync(askpassPath, '#!/bin/sh\nprintf \'%s\' "$KOTO_VPS_ASKPASS_SECRET"\n', { mode: 0o700 })
  fs.chmodSync(askpassPath, 0o700)
  try {
    const args = [
      '-F', '/dev/null',
      '-p', String(port),
      '-o', `ConnectTimeout=${CONNECT_TIMEOUT_SEC}`,
      '-o', `UserKnownHostsFile=${knownHostsPath}`,
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'UpdateHostKeys=no',
      '-o', 'PubkeyAuthentication=no', // 意図せずデフォルト鍵で認証してしまい password 経路を検証できない事態を避ける
      '-o', 'PreferredAuthentications=keyboard-interactive,password',
      '-o', 'NumberOfPasswordPrompts=1',
      `${user}@${host}`,
      'bash', '-s',
    ]
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SSH_ASKPASS: askpassPath,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || ':0', // 古いsshクライアント向けの保険（force指定で本来は不要）
      KOTO_VPS_ASKPASS_SECRET: password,
    }
    const script = commands.join('\n')
    const r = await runProcess('ssh', args, { input: script, env, timeoutMs: opts.timeoutMs ?? OVERALL_TIMEOUT_MS, detached: true })
    if (r.timedOut) return { ok: false, message: '接続がタイムアウトしました。パスワードやネットワークを確認してください。' }
    if (!r.ok) return { ok: false, stdout: r.stdout, stderr: r.stderr, message: friendlyMessage(r.stderr) }
    return { ok: true, fingerprint: scan.fingerprint, stdout: r.stdout, stderr: r.stderr }
  } finally {
    try { fs.rmSync(knownHostsPath, { force: true }) } catch { /* ignore */ }
    try { fs.rmSync(askpassPath, { force: true }) } catch { /* ignore */ }
  }
}
