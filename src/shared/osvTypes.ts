// OSV.dev への照会の結果と、画面へ返す答えの型（型だけ）。
import type { LockSkipped, ManifestMatch } from './lockfileDeps'

export type OsvStopReason = 'offline' | 'timeout' | 'http' | 'shape' | 'too-large'
export interface OsvStop { reason: OsvStopReason; detail: string }
export interface OsvVuln { id: string; link: string | null; fixed: string | null; severityLabel: string | null; detail: 'ok' | 'not-fetched' | 'unreadable' }
export interface OsvFinding { name: string; version: string; vulns: OsvVuln[]; fixedAll: string | null }
export interface OsvDone { kind: 'done'; total: number; sent: number; checked: number; findings: OsvFinding[]; withdrawn: number; stop: OsvStop | null }
export type OsvRunResult = { kind: 'not-consented' } | OsvDone
/** 調べられない理由（通信はしていない）。 */
export type OsvUnavailable = 'bad-dir' | 'no-manifest' | 'no-deps' | 'no-lockfile' | 'unsupported' | 'unreadable'
/** 通信しない口の答え。 */
export type OsvPreview =
  | { state: 'ok'; sendCount: number; total: number; examples: string[]; skipped: LockSkipped; manifest: ManifestMatch }
  | { state: OsvUnavailable }
/** 通信する口の答え。 */
export type OsvCheckReply =
  | { state: 'not-consented' }
  | { state: OsvUnavailable }
  | { state: 'nothing-to-send'; skipped: LockSkipped; manifest: ManifestMatch }
  | { state: 'done'; result: OsvDone; skipped: LockSkipped; manifest: ManifestMatch }
  | { state: 'failed'; message: string }
