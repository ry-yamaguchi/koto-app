// さくらの資料パック（KnowledgePacksTab の裏付けデータ）。
// さくら公式ドキュメントの既定URLセットを「取り込む」ボタン一つで📚資料に一括登録する機能（roadmap.md N-2）の定義。
//
// URLは scripts/check-links.mjs が正規表現で本ファイルから直接抽出して疎通確認する
// （targetProfiles.ts の serviceUrl と同じ「URLを複製しない」方式）。抽出パターンを変えたらスクリプト側も直すこと。
//
// approxChars は取り込み対象ページの実測文字数（fetchUrlPage の content.length を目視確認したもの）。
// 費用の目安表示（合計文字数）にのみ使う概算値であり、実際の取り込み時は改めて取得した本文の長さが使われる。

import { CHUNK_MAX_CHARS, RAG_TOP_K } from './ragContext'
import { estimateTokens, priceFor } from './usage'

export type RagPackPage = { url: string; title: string; approxChars: number }
export type RagPack = { id: string; label: string; description: string; pages: RagPackPage[] }

/**
 * IDE経由でアップロードした資料に必ず付くタグ（由来識別用）。
 * 値は src/main/rag/client.ts の RAG_IDE_TAG と同じ（renderer は main モジュールを直接importしない構成のため
 * 値を複製している。実際にはアップロード時に main 側 uploadDocument が自動付与するので省略しても付くが、
 * ここで明示することでタグ規約が定義から読み取れるようにする）。変更時は両方直すこと。
 */
export const RAG_IDE_TAG = 'sakura-ide'

/** パック取り込みで生成する資料に必ず付くタグ一覧（由来識別 sakura-ide ＋ パック識別 pack:<id> ＋ 種別 web）。 */
export function packTags(id: string): string[] {
  return [RAG_IDE_TAG, `pack:${id}`, 'web']
}

export const RAG_PACKS: RagPack[] = [
  {
    id: 'rental',
    label: '🌐 レンタルサーバ',
    description: 'さくらのレンタルサーバの基本仕様・PHP・データベース・CRON・SSH・.htaccess・リソース制限など、よく使う設定のヘルプ記事です。',
    pages: [
      { url: 'https://help.sakura.ad.jp/rs/2251/', title: '基本仕様を知りたい（さくらのレンタルサーバ）', approxChars: 36783 },
      { url: 'https://help.sakura.ad.jp/rs/2241/', title: 'PHPのバージョンを変更したい', approxChars: 12094 },
      { url: 'https://help.sakura.ad.jp/rs/2187/', title: 'データベースと管理ツールを知りたい', approxChars: 8218 },
      { url: 'https://help.sakura.ad.jp/rs/2192/', title: 'データベースの制限事項を知りたい', approxChars: 12022 },
      { url: 'https://help.sakura.ad.jp/rs/2242/', title: 'CRONを設定したい', approxChars: 20258 },
      { url: 'https://help.sakura.ad.jp/rs/2247/', title: 'SSH を利用したい', approxChars: 26681 },
      { url: 'https://help.sakura.ad.jp/rs/2214/', title: '.htaccessによるアクセス制御をしたい', approxChars: 38887 },
      { url: 'https://help.sakura.ad.jp/rs/2704/', title: 'リソース情報に記載されている「制限」について知りたい', approxChars: 5923 },
    ],
  },
  {
    id: 'apprun',
    label: '⚙️ AppRun',
    description: 'さくらのAppRun（コンテナ実行サービス）のはじめに・技術概要・クイックスタート・FAQ・料金ページです。',
    pages: [
      { url: 'https://manual.sakura.ad.jp/cloud/apprun/about.html', title: 'はじめに', approxChars: 1573 },
      { url: 'https://manual.sakura.ad.jp/cloud/apprun/glossary.html', title: '技術概要', approxChars: 2538 },
      { url: 'https://manual.sakura.ad.jp/cloud/apprun/getting_started.html', title: 'クイックスタート', approxChars: 3321 },
      { url: 'https://manual.sakura.ad.jp/cloud/apprun/faq.html', title: 'サポート/FAQ', approxChars: 2176 },
      { url: 'https://cloud.sakura.ad.jp/products/apprun-shared/', title: 'AppRun共用型 製品ページ（料金）', approxChars: 1540 },
    ],
  },
  {
    id: 'ai-engine',
    label: '🤖 AI Engine',
    description: 'さくらのAI Engineのサービス基本情報・利用手順・操作ガイド・Tips・料金/モデル情報です。',
    pages: [
      { url: 'https://manual.sakura.ad.jp/cloud/ai-engine/01-basics.html', title: 'サービス基本情報', approxChars: 1014 },
      { url: 'https://manual.sakura.ad.jp/cloud/ai-engine/02-howto.html', title: '利用手順', approxChars: 3109 },
      { url: 'https://manual.sakura.ad.jp/cloud/ai-engine/03-operation-guide.html', title: '操作ガイド', approxChars: 6754 },
      { url: 'https://manual.sakura.ad.jp/cloud/ai-engine/tips.html', title: 'Tips', approxChars: 529 },
      { url: 'https://www.sakura.ad.jp/aipf/ai-engine/', title: '公式製品ページ（料金・モデル）', approxChars: 6079 },
    ],
  },
  {
    id: 'hanamii',
    label: '🌸 HANAMII',
    description: 'HANAMII のAPIドキュメントです。',
    pages: [
      { url: 'https://hanamii.jp/docs/api', title: 'APIドキュメント', approxChars: 29512 },
    ],
  },
]

/** パック内ページの approxChars 合計（費用の目安表示用）。 */
export function packTotalChars(pack: RagPack): number {
  return pack.pages.reduce((sum, p) => sum + p.approxChars, 0)
}

/**
 * 文字数を「約◯万字」表記にする（純粋関数）。
 * 1万字未満は「約◯千字」（100字未満は切り上げで最低1千字）。
 * 1万字以上10万字未満は小数点第1位まで、10万字以上は整数に丸める。
 */
export function formatApproxChars(chars: number): string {
  if (chars <= 0) return '0字'
  if (chars < 10000) return `約${Math.max(1, Math.round(chars / 1000))}千字`
  const man = chars / 10000
  const rounded = man < 10 ? Math.round(man * 10) / 10 : Math.round(man)
  return `約${rounded}万字`
}

/**
 * 資料パックを取り込んだ後、会話1回あたりに増える最大費用（円）を概算する（純粋関数）。
 * 「最大」なのは autoRagBlock が threshold 未満のヒットが無ければ何も注入しない（0件なら0円）ため。
 * ここでは「関連していてtopK件すべてヒットした」最悪ケースの上限を示す。
 *
 * 文字→トークンの換算: 独自の比率を新設せず、usage.ts の estimateTokens（既存の目安ロジック）をそのまま
 * 再利用する。estimateTokens は非ASCII文字を1文字=1トークンとして数える比率になっており、資料パックは
 * 日本語中心のため、この比率で埋めた文字列を通すことで「既存ロジック準拠・保守的な上限」の見積りになる。
 */
export function estimatePackCostPerTurnYen(model: string): number {
  const maxChars = RAG_TOP_K * CHUNK_MAX_CHARS
  const maxTokens = estimateTokens('あ'.repeat(maxChars))
  return (maxTokens / 1_000_000) * priceFor(model).in
}
