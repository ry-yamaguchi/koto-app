// auth.ts — さくらのクラウド/AppRun API の認証情報（アクセストークン＋トークンシークレット）の
//            暗号化保存・読込。既存の secure:encrypt/decrypt と同じく safeStorage を用いる。
//
// さくらのクラウドのAPIは Basic 認証で「アクセストークン:トークンシークレット」を用いる。
// 2つの値を1つのJSONにまとめ、safeStorage で暗号化して base64 文字列としてファイルに保存する。
// ※平文保存は禁止。暗号化が使えない環境では保存を拒否する。

import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/** 認証情報（API資格情報）。token=アクセストークン, secret=トークンシークレット。 */
export type CloudCredentials = { token: string; secret: string }

/** 暗号化済み資格情報の保存先（userData 配下）。 */
function credentialsPath(): string {
  return path.join(app.getPath('userData'), 'cloud-credentials.enc')
}

/**
 * 認証情報が既に保存されているか。
 * ファイルが存在し、かつ復号した token / secret の両方が非空のときだけ true を返す。
 * （空文字の token/secret は「未登録」と扱う。）
 */
export function hasCredentials(): boolean {
  try {
    const creds = loadCredentials()
    return !!creds && !!creds.token && !!creds.secret
  } catch {
    return false
  }
}

/**
 * 保存済みの認証情報を削除する（cloud-credentials.enc を削除）。
 * ファイルが無ければ何もしない。
 */
export function clearCredentials(): void {
  try {
    const file = credentialsPath()
    if (fs.existsSync(file)) fs.rmSync(file)
  } catch {
    /* 削除失敗は無視（未登録扱い） */
  }
}

/**
 * 認証情報を暗号化して保存する。
 * - token/secret を JSON 化 → safeStorage で暗号化 → base64 にしてファイルへ書き込む。
 * - 暗号化が利用できない環境ではエラー（平文保存はしない）。
 */
export function saveCredentials(creds: CloudCredentials): void {
  if (!creds || typeof creds.token !== 'string' || typeof creds.secret !== 'string') {
    throw new Error('認証情報（token / secret）が不正です')
  }
  if (!creds.token || !creds.secret) {
    throw new Error('アクセストークンとトークンシークレットの両方を入力してください')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('この環境では安全な暗号化（OSキーチェーン）が使えないため、認証情報を保存できません')
  }
  const plain = JSON.stringify({ token: creds.token, secret: creds.secret })
  const enc = safeStorage.encryptString(plain).toString('base64')
  const file = credentialsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 暗号文（base64）のみを書き込む。平文は一切ファイルに残さない。
  fs.writeFileSync(file, enc, 'utf-8')
}

/**
 * 認証情報を復号して読み込む。未保存・復号失敗時は null を返す。
 */
export function loadCredentials(): CloudCredentials | null {
  try {
    const file = credentialsPath()
    if (!fs.existsSync(file)) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    const b64 = fs.readFileSync(file, 'utf-8')
    const plain = safeStorage.decryptString(Buffer.from(b64, 'base64'))
    const obj = JSON.parse(plain)
    if (typeof obj?.token === 'string' && typeof obj?.secret === 'string') {
      return { token: obj.token, secret: obj.secret }
    }
    return null
  } catch {
    return null
  }
}
