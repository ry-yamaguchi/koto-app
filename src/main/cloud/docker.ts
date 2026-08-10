// docker.ts — Docker イメージのビルド/プッシュ＋レジストリログインのメカニクス。
//
// ※セキュリティ最重要:
//   - docker コマンドは execFile / spawn（配列引数）でのみ実行する。シェル文字列連結は厳禁。
//   - docker login のパスワードは argv に渡さず stdin（--password-stdin）で渡す
//     （ps 等のプロセス一覧にパスワードを出さないため）。
//   - イメージ名・タグ・レジストリサーバ・コンテキストパスは引数へ渡す前に厳格検証する。
//
// ※この段階（3a）では main の IPC からは呼ばない。export だけしておき、段階3bで
//   cloud:apply の build→login→push に統合する。
//
// 検証関数（validateImageName / validateTag / validateRegistryServer / buildRef）は
// electron 非依存の純関数として export する（esbuild 単体テストで `;`/`$()`/空白/`..` 等の
// 混入を弾けることを確認できるようにするため）。

import { execFile, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

// ── 検証規則（純関数・IO無し・electron 非依存） ───────────────────────────────

/** イメージ名: 小文字英数字とハイフン、先頭末尾は英数字、3〜40文字（spec の NAME_PATTERN と同一）。 */
const IMAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/
/** タグ: 英数字・ドット・アンダースコア・ハイフンのみ、1〜128文字。 */
const TAG_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
/** レジストリサーバ: 英数字・ドット・ハイフンのみ（例: myreg.sakuracr.jp）。 */
const REGISTRY_SERVER_PATTERN = /^[A-Za-z0-9.-]+$/

/**
 * イメージ名を検証する純関数。違反時は throw。
 * `;` `$()` 空白 `..` `/` `:` 等の混入はパターンにより弾かれる。
 */
export function validateImageName(s: string): string {
  if (typeof s !== 'string' || !IMAGE_NAME_PATTERN.test(s)) {
    throw new Error('イメージ名が不正です（小文字英数字とハイフンのみ・先頭末尾は英数字・3〜40文字）')
  }
  return s
}

/** タグを検証する純関数。違反時は throw。 */
export function validateTag(s: string): string {
  if (typeof s !== 'string' || !TAG_PATTERN.test(s)) {
    throw new Error('タグが不正です（英数字・ドット・アンダースコア・ハイフンのみ・1〜128文字）')
  }
  return s
}

/** レジストリサーバを検証する純関数。違反時は throw。 */
export function validateRegistryServer(s: string): string {
  if (typeof s !== 'string' || !REGISTRY_SERVER_PATTERN.test(s)) {
    throw new Error('レジストリサーバが不正です（英数字・ドット・ハイフンのみ）')
  }
  return s
}

/**
 * 完全なイメージ参照 `${server}/${image}:${tag}` を組み立てる純関数。
 * server/image/tag をそれぞれ検証してから連結するため、不正な文字の混入は throw で弾かれる。
 */
export function buildRef(server: string, image: string, tag: string): string {
  const s = validateRegistryServer(server)
  const i = validateImageName(image)
  const t = validateTag(tag)
  return `${s}/${i}:${t}`
}

// ── 実行関数（child_process。execFile / spawn のみ・配列引数） ───────────────

/** docker 実行時の出力上限・タイムアウト。 */
const DOCKER_OUTPUT_MAX = 16000
const DOCKER_TIMEOUT = 600000 // 10分（build / push は時間がかかり得る）
const DOCKER_MAX_BUFFER = 16 * 1024 * 1024

/** 出力を上限で切り詰める。 */
function clip(s: unknown): string {
  return String(s ?? '').slice(0, DOCKER_OUTPUT_MAX)
}

/** stderr を要約して短いメッセージにする。 */
function summarizeStderr(stderr: string): string {
  const t = (stderr || '').trim()
  if (!t) return 'docker コマンドの実行に失敗しました。'
  // 最後の非空行が原因であることが多い。
  const lines = t.split(/\r?\n/).filter(l => l.trim().length > 0)
  const last = lines[lines.length - 1] ?? t
  return last.slice(0, 300)
}

/**
 * docker コマンドが利用可能か確認する（`docker --version` が成功すれば true）。
 */
export function dockerAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('docker', ['--version'], { timeout: 15000 }, err => {
      resolve(!err)
    })
  })
}

/**
 * イメージをビルドする。`docker build -t <ref> <contextAbsPath>`。
 * - contextAbsPath は絶対パスで実在するディレクトリでなければならない（検証）。
 * - ref は呼び出し側で buildRef により検証済みであること（ここでも軽く形式確認はしない＝
 *   buildRef を通すことを前提とする）。
 */
export function buildImage(contextAbsPath: string, ref: string): Promise<{ ok: boolean; log: string }> {
  return new Promise(resolve => {
    try {
      if (typeof contextAbsPath !== 'string' || !path.isAbsolute(contextAbsPath)) {
        return resolve({ ok: false, log: 'ビルドコンテキストは絶対パスである必要があります' })
      }
      let st: fs.Stats
      try {
        st = fs.statSync(contextAbsPath)
      } catch {
        return resolve({ ok: false, log: 'ビルドコンテキストのパスが存在しません' })
      }
      if (!st.isDirectory()) {
        return resolve({ ok: false, log: 'ビルドコンテキストはディレクトリである必要があります' })
      }
      execFile(
        'docker',
        ['build', '-t', ref, contextAbsPath],
        { timeout: DOCKER_TIMEOUT, maxBuffer: DOCKER_MAX_BUFFER },
        (err: any, stdout, stderr) => {
          if (err) {
            resolve({ ok: false, log: clip(summarizeStderr(String(stderr)) + '\n' + clip(stdout)) })
          } else {
            resolve({ ok: true, log: clip(String(stdout) + String(stderr)) })
          }
        }
      )
    } catch (e: any) {
      resolve({ ok: false, log: e?.message ?? String(e) })
    }
  })
}

/**
 * レジストリにログインする。`docker login <server> -u <user> --password-stdin`。
 * パスワードは argv に渡さず stdin へ書き込んで閉じる（プロセス一覧に出さない）。
 * server/user は呼び出し側で検証済みであること。
 */
export function loginRegistry(
  server: string,
  user: string,
  password: string
): Promise<{ ok: boolean; message?: string }> {
  return new Promise(resolve => {
    try {
      // server は念のためここでも検証（不正なら throw → catch で失敗扱い）。
      validateRegistryServer(server)
      if (typeof user !== 'string' || user.length === 0) {
        return resolve({ ok: false, message: 'ユーザー名が空です' })
      }
      if (typeof password !== 'string' || password.length === 0) {
        return resolve({ ok: false, message: 'パスワードが空です' })
      }
      const child = spawn('docker', ['login', server, '-u', user, '--password-stdin'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let out = ''
      let errOut = ''
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          try { child.kill('SIGKILL') } catch { /* ignore */ }
          resolve({ ok: false, message: 'docker login がタイムアウトしました' })
        }
      }, 60000)
      child.stdout?.on('data', d => { out += String(d) })
      child.stderr?.on('data', d => { errOut += String(d) })
      child.on('error', e => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, message: e?.message ?? String(e) })
      })
      child.on('close', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code === 0) {
          resolve({ ok: true, message: clip(out + errOut) || 'ログインに成功しました' })
        } else {
          resolve({ ok: false, message: summarizeStderr(errOut || out) })
        }
      })
      // パスワードを stdin に書いて閉じる（argv には一切載せない）。
      child.stdin?.write(password)
      child.stdin?.end()
    } catch (e: any) {
      resolve({ ok: false, message: e?.message ?? String(e) })
    }
  })
}

/**
 * イメージをプッシュする。`docker push <ref>`。
 * ref は呼び出し側で buildRef により検証済みであること。
 */
export function pushImage(ref: string): Promise<{ ok: boolean; log: string }> {
  return new Promise(resolve => {
    try {
      execFile(
        'docker',
        ['push', ref],
        { timeout: DOCKER_TIMEOUT, maxBuffer: DOCKER_MAX_BUFFER },
        (err: any, stdout, stderr) => {
          if (err) {
            resolve({ ok: false, log: clip(summarizeStderr(String(stderr)) + '\n' + clip(stdout)) })
          } else {
            resolve({ ok: true, log: clip(String(stdout) + String(stderr)) })
          }
        }
      )
    } catch (e: any) {
      resolve({ ok: false, log: e?.message ?? String(e) })
    }
  })
}
