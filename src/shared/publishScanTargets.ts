// publishScanTargets.ts — 公開されるファイルのうち、中身を読むもの・名前だけ見るもの・飛ばすものの分け方（純関数）。
// ロックファイル・素材・Koto のビルド設定の定義は、AI の確認と Koto の点検の両方がここを使う。

import { BUILD_CONFIG_FILES, looksSecretByName } from './publishExclude'
import type { ScanScope } from './securityFindings'

export type ScanTarget = 'scan' | 'secret-name' | 'skip'

// 依存の一覧（ロックファイル）。名前と版とハッシュが並ぶだけで、読んでも指摘は出ない。
export const LOCKFILE_RE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/i

/**
 * 表示用の素材ファイル。画像・フォント・音声・動画など、テキストとして読む対象にならないもの。
 * svg と pdf は含めない。
 */
export const ASSET_FILE_RE = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp3|wav|ogg|m4a|mp4|webm|mov|avi)$/i

/**
 * Koto が管理するビルド設定か。利用者の作成物ではないので検査しない。名簿は publishExclude.ts の一元定義。
 */
export function isKotoBuildConfig(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? relPath
  return (BUILD_CONFIG_FILES as readonly string[]).includes(base)
}

/**
 * 公開されるファイル（根からの相対パス）を、点検で読むか・名前だけ見るか・飛ばすかに分ける。
 * scope が 'github'（GitHub 保存の点検）では、ロックファイルとビルド設定も保存されるので読む（素材だけ飛ばす）。
 * 公開の点検では、これらは配信物から外れるので飛ばす。
 */
export function scanTargetOf(rel: string, scope: ScanScope = 'publish'): ScanTarget {
  if (looksSecretByName(rel)) return 'secret-name'
  if (ASSET_FILE_RE.test(rel)) return 'skip'
  if (scope === 'publish' && (LOCKFILE_RE.test(rel) || isKotoBuildConfig(rel))) return 'skip'
  return 'scan'
}
