// registry-auth.ts — コンテナレジストリ（さくらのAppRun / *.sakucr.jp）の認証情報
//                    （レジストリ名・ユーザー名・パスワード）の暗号化保存・読込。
//
// cloud 認証（auth.ts）と完全に同じ方式: 3つの値を1つのJSONにまとめ、safeStorage で
// 暗号化して base64 文字列としてファイルに保存する。
// ※平文保存は禁止。暗号化が使えない環境では保存を拒否する。
//
// レジストリサーバ（docker login 先）は `${name}.sakuracr.jp` で算出する。
// （仕様準拠。docker.ts 側の validateRegistryServer で最終検証してから引数に渡す。）

import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/** レジストリ認証情報。name=レジストリ名, user=ユーザー名, password=パスワード。 */
export type RegistryCredentials = { name: string; user: string; password: string }

/** 暗号化済み資格情報の保存先（userData 配下）。 */
function credentialsPath(): string {
  return path.join(app.getPath('userData'), 'registry-credentials.enc')
}

/** レジストリ名から docker login 先のサーバFQDNを算出する。 */
export function registryServer(name: string): string {
  return `${name}.sakuracr.jp`
}

/**
 * レジストリ認証情報が既に保存されているか。
 * ファイルが存在し、かつ復号した name / user / password の全てが非空のときだけ true を返す。
 * （いずれかが空文字なら「未登録」と扱う。）
 */
export function hasRegistryCredentials(): boolean {
  try {
    const creds = loadRegistryCredentials()
    return !!creds && !!creds.name && !!creds.user && !!creds.password
  } catch {
    return false
  }
}

/**
 * 保存済みのレジストリ認証情報を削除する（registry-credentials.enc を削除）。
 * ファイルが無ければ何もしない。
 */
export function clearRegistryCredentials(): void {
  try {
    const file = credentialsPath()
    if (fs.existsSync(file)) fs.rmSync(file)
  } catch {
    /* 削除失敗は無視（未登録扱い） */
  }
}

/**
 * レジストリ認証情報を暗号化して保存する。
 * - name/user/password を JSON 化 → safeStorage で暗号化 → base64 にしてファイルへ書き込む。
 * - 暗号化が利用できない環境ではエラー（平文保存はしない）。
 */
export function saveRegistryCredentials(creds: RegistryCredentials): void {
  if (
    !creds ||
    typeof creds.name !== 'string' ||
    typeof creds.user !== 'string' ||
    typeof creds.password !== 'string'
  ) {
    throw new Error('レジストリ認証情報（name / user / password）が不正です')
  }
  if (!creds.name || !creds.user || !creds.password) {
    throw new Error('レジストリ名・ユーザー名・パスワードをすべて入力してください')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('この環境では安全な暗号化（OSキーチェーン）が使えないため、認証情報を保存できません')
  }
  const plain = JSON.stringify({ name: creds.name, user: creds.user, password: creds.password })
  const enc = safeStorage.encryptString(plain).toString('base64')
  const file = credentialsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 暗号文（base64）のみを書き込む。平文は一切ファイルに残さない。
  fs.writeFileSync(file, enc, 'utf-8')
}

/**
 * レジストリ認証情報を復号して読み込む。未保存・復号失敗時は null を返す。
 */
export function loadRegistryCredentials(): RegistryCredentials | null {
  try {
    const file = credentialsPath()
    if (!fs.existsSync(file)) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    const b64 = fs.readFileSync(file, 'utf-8')
    const plain = safeStorage.decryptString(Buffer.from(b64, 'base64'))
    const obj = JSON.parse(plain)
    if (
      typeof obj?.name === 'string' &&
      typeof obj?.user === 'string' &&
      typeof obj?.password === 'string'
    ) {
      return { name: obj.name, user: obj.user, password: obj.password }
    }
    return null
  } catch {
    return null
  }
}
