// protectedPaths.ts — AI に書き換えさせないプロジェクト内のパス（唯一の定義）。
//
// ── なぜ必要か（2026-08-05 の点検で判明） ──────────────────────────────────
// AIの書き込みはプロジェクト内へ閉じ込めてある（`..` や絶対パスは拒否）が、
// **プロジェクト内であればどこでも書けた**。実測で次がすべて素通りしていた:
//
//   .sakuraide-backup/<id>/_manifest.json … 🕘 履歴そのもの。**AIの失敗を取り消す仕組みを
//                                            AI自身が壊せる**（復元できなくなる）
//   .sakuraide/chat.json                  … チャット履歴
//   .sakura-cloud/env.json                … 環境変数（秘密が入り得る）
//   .sakuraide.json                       … 公開先などのプロジェクト設定
//   .git/hooks/pre-commit                 … **コミット時に実行されるスクリプト**。
//                                            ここへ書けると commandGuard の危険コマンド判定を
//                                            迂回して任意のコードを実行させられる
//   .git/config                           … リポジトリの設定（push先の書き換え等）
//
// これらは Koto 自身が管理する領域で、AIが書き換える正当な理由が無い。
// ユーザーの作業物（HTML/CSS/JS…）は従来どおり自由に書ける。
//
// このモジュールは fs/electron/DOM に依存しない純粋関数のみ（renderer からも main からも使う）。

import { KOTO_INTERNAL_DIRS, KOTO_INTERNAL_FILES } from './publishExclude'
import { DATA_LAYER_LOCAL_DIR } from './objectStorage'

/** Koto 自身の管理領域に加えて保護するもの。 */
const OTHER_PROTECTED_DIRS = ['.git'] as const

/** パス区切りを `/` に正規化し、先頭の `./` を落とす。 */
function normalize(rel: string): string {
  return String(rel ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * AI が書き換えてはいけないパスか（プロジェクトルートからの相対パスで判定）。
 * true を返したら書き込みを拒否する。読み取りは制限しない（調査のため読むのは正当）。
 */
export function isProtectedWritePath(rel: string): boolean {
  const p = normalize(rel)
  if (!p) return false

  const segments = p.split('/').filter(Boolean)
  if (!segments.length) return false

  // ① Koto と git の管理フォルダ配下（どの階層にあっても保護する）
  const protectedDirs = new Set<string>([...KOTO_INTERNAL_DIRS, ...OTHER_PROTECTED_DIRS])
  if (segments.some(seg => protectedDirs.has(seg))) return true

  // ② Koto のメタ情報ファイル（プロジェクト直下）
  if (segments.length === 1 && (KOTO_INTERNAL_FILES as readonly string[]).includes(segments[0])) return true

  // ③ 秘密情報が入るファイル（.env / .env.local / .env.production …）
  const base = segments[segments.length - 1]
  if (base.startsWith('.env')) return true

  return false
}

/** 拒否したときにAIへ返す説明（なぜ書けないのかを伝え、無駄な再試行をさせない）。 */
export function protectedWriteMessage(rel: string): string {
  // `.koto-data` だけは中身が**利用者自身のアプリのデータ**（予定・連絡先など）で、
  // 「Koto が管理する領域（履歴・設定・秘密）」という説明が当てはまらない。
  // 「テスト用のデータを入れておいて」と頼んだ利用者に理由が伝わらず、AI も
  // 別の場所へ書こうとして空回りするので、この場合の一文をここに持つ（2026-09-23 検分）。
  if (normalize(rel).split('/').filter(Boolean).includes(DATA_LAYER_LOCAL_DIR)) {
    return `${rel} はアプリが保存したデータの置き場なので、AI からは書き換えません。`
      + 'データの追加・変更・削除は、アプリの画面から行ってください。'
  }
  return `${rel} は Koto が管理する領域のため書き込めません（履歴・設定・.git・秘密情報のファイル）。`
    + 'ユーザーの作業ファイルを対象にしてください。'
}
