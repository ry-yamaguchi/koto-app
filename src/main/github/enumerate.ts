// enumerate.ts — GitHub保存（P3-⑬ G1）用のファイル列挙の純ロジック（electron/fs 非依存）。
//
// hanamii の zipProjectToBuffer と同じ除外規則を踏襲しつつ、GitHub保存では追加で
// `.env` 系ファイルを安全側で除外する（dev-plan 記載どおり）。IO（実際のディレクトリ走査）は
// ipc/github.ts 側で行い、ここでは「除外すべきか」「サイズ上限を超えているか」の判定のみを持つ。

import { excludedDirNames, isSecretFile } from '../../shared/publishExclude'

/** zipProjectToBuffer と同じ除外セット（ディレクトリ名）。 */
export const SKIP_DIRS = excludedDirNames(['dist', 'build', '.next', 'out', '.vscode', 'vendor', '__pycache__'])

/** ディレクトリではなくファイル単体として除外する名前（zipProjectToBuffer 同様に .DS_Store を除外）。 */
export const SKIP_FILES = new Set(['.DS_Store'])

/** 1ファイルの上限（実用サイズ。blob自体の上限は100MBだが、余裕を持って5MBとする＝dev-plan記載）。 */
export const MAX_FILE_BYTES = 5 * 1024 * 1024

/**
 * 秘密ファイル名かどうか。判定は publishExclude.ts の isSecretFile に一本化した（2026-08-09）。
 * 以前はここと vercel/client.ts が**それぞれ独自に** `.env` だけを判定しており、
 * レンタルサーバ・HANAMII・AppRun の3経路には判定そのものが無かった。
 * 名前は互換のため残す（呼び出し側と既存テストが使っている）。
 */
export function isEnvFileName(name: string): boolean {
  return isSecretFile(name)
}

/** ディレクトリ名が除外対象かどうか。 */
export function isSkippedDirName(name: string): boolean {
  return SKIP_DIRS.has(name)
}

/** ファイル名が無視対象（.DS_Store 等・警告するまでもない既知ファイル）かどうか。 */
export function isSkippedFileName(name: string): boolean {
  return SKIP_FILES.has(name)
}

/**
 * ファイル1件を保存対象に含めるかどうかを判定する。
 * - `.env` 系は常に除外（'env'）
 * - サイズが上限超過なら除外（'size'）
 * 除外理由を返す。含める場合は null。
 * 注: `.DS_Store` 等（isSkippedFileName）は「警告するまでもない無視」のため、この関数の対象外。
 *     呼び出し側（ipc/github.ts の walk）で列挙前に弾く。
 */
export function excludeReason(relPath: string, sizeBytes: number): 'env' | 'size' | null {
  const base = relPath.split('/').pop() ?? relPath
  if (isEnvFileName(base)) return 'env'
  if (sizeBytes > MAX_FILE_BYTES) return 'size'
  return null
}

export type EnumerateEntry = { rel: string; sizeBytes: number }

export type EnumerateResult = {
  /** 保存対象として含めるファイル（相対パスのみ。中身はここでは持たない）。 */
  included: string[]
  /** 除外したファイル（相対パス＋理由）。UIの警告一覧に使う。 */
  excluded: Array<{ path: string; reason: 'env' | 'size' }>
}

/** 列挙済みのエントリ一覧から、含める/除外するファイルを振り分ける（純粋関数・テスト対象）。 */
export function partitionEntries(entries: EnumerateEntry[]): EnumerateResult {
  const included: string[] = []
  const excluded: Array<{ path: string; reason: 'env' | 'size' }> = []
  for (const e of entries) {
    const reason = excludeReason(e.rel, e.sizeBytes)
    if (reason) excluded.push({ path: e.rel, reason })
    else included.push(e.rel)
  }
  return { included, excluded }
}
