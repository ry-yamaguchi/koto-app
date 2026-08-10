// クラウド/レジストリの認証情報（キー系）の IPC（cloud:saveKey/hasKey/loadKey/clearKey ・ registry:*）。deps は使わない。
import { ipcMain } from 'electron'
import { hasCredentials, saveCredentials, loadCredentials, clearCredentials } from '../cloud/auth'
import {
  hasRegistryCredentials,
  saveRegistryCredentials,
  loadRegistryCredentials,
  clearRegistryCredentials,
} from '../cloud/registry-auth'
import type { IpcDeps } from './types'

export function registerCloudKeysHandlers(_deps: IpcDeps) {
  // 認証情報（アクセストークン＋トークンシークレット）を暗号化保存／状態取得／疎通テスト
  ipcMain.handle('cloud:saveKey', (_, token: string, secret: string) => {
    try {
      saveCredentials({ token, secret })
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle('cloud:hasKey', () => hasCredentials())

  // 保存済みの認証情報（トークン/シークレット）を復号してレンダラへ返す（未保存・取得不可なら null）。
  // セキュリティ注記: クラウドのトークン/シークレットをレンダラへ返す。
  // AI EngineのAPIキーが既にレンダラで扱われているのと同じトラストレベル
  // （自社・サンドボックス済みレンダラ）であり許容する。
  ipcMain.handle('cloud:loadKey', () => loadCredentials())

  // 認証情報を削除（使用中エントリが空になった時に認証情報モーダルから呼ぶ）
  ipcMain.handle('cloud:clearKey', () => {
    try {
      clearCredentials()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  // ── コンテナレジストリ認証情報（name / user / password）の暗号化保存／状態／読戻し ──
  // cloud:* と同じ方式（registry-auth.ts は auth.ts を踏襲）。レジストリは認証情報画面で入力する。
  ipcMain.handle('registry:saveKey', (_, name: string, user: string, password: string) => {
    try {
      saveRegistryCredentials({ name, user, password })
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })

  ipcMain.handle('registry:hasKey', () => hasRegistryCredentials())

  // 保存済みのレジストリ認証情報を復号してレンダラへ返す（未保存・取得不可なら null）。
  // セキュリティ注記: レジストリの name/user/password をレンダラへ返す。
  // AI EngineのAPIキーやクラウドのトークン/シークレットが既にレンダラで扱われているのと
  // 同じトラストレベル（自社・サンドボックス済みレンダラ）であり許容する。
  ipcMain.handle('registry:loadKey', () => loadRegistryCredentials())

  // レジストリ認証情報を削除（使用中エントリが空 or 不完全になった時に認証情報モーダルから呼ぶ）
  ipcMain.handle('registry:clearKey', () => {
    try {
      clearRegistryCredentials()
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) }
    }
  })
}
