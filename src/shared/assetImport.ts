// assetImport.ts — 落とした画像を、プロジェクトのどこへ入れるかを決める（純ロジック）。
//
// ── なぜ要るか（2026-08-19 Ryosuke 提案）──────────────────────────────
// 画像は「AIに見せる」ためだけに読み込まれ、**プロジェクトには残らなかった**。
// だが実際に作るときは、アプリの部品として使いたい（ロゴ・写真など）。
// 一方で「置いておきたいが公開はしたくない」ものもある。
//
// ── 決めたこと ──────────────────────────────────────────────────────
// ・アプリで使う   … `public/` があれば `public/images/`、無ければ `images/`
//   （公開先によって配られる場所が違う。**既にある構造に合わせる**）
// ・素材（公開しない）… `素材（公開しません）/`（publishExclude.ts が公開物から外す）
// ・同じ名前があれば連番を付ける（**黙って上書きしない**）

import { MATERIALS_DIR } from './publishExclude'

/** 入れ方。 */
export type AssetPurpose =
  /** アプリで使う（公開される）。 */
  | 'app'
  /** 素材として置いておく（公開しない）。 */
  | 'material'

/** 画像として受け付ける拡張子。 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'])

export function isImageFileName(name: string): boolean {
  const m = /\.[^.]+$/.exec(String(name ?? '').toLowerCase())
  return m ? IMAGE_EXTS.has(m[0]) : false
}

/**
 * ファイル名として安全な形に直す（純関数）。
 *
 * **日本語は残す**（利用者が付けた名前を勝手に消さない）。困るのは
 * パス区切りと、先頭のドット（隠しファイルになる）だけ。
 */
export function safeAssetName(name: string): string {
  const base = String(name ?? '').replace(/[/\\]/g, '-').replace(/^\.+/, '').trim()
  return base || 'image.png'
}

/**
 * 入れ先のフォルダを決める（純関数）。
 *
 * @param topLevelNames プロジェクト直下にあるものの名前
 */
export function destinationDir(purpose: AssetPurpose, topLevelNames: readonly string[]): string {
  if (purpose === 'material') return MATERIALS_DIR
  return (topLevelNames ?? []).includes('public') ? 'public/images' : 'images'
}

/**
 * 同じ名前があれば連番を付ける（純関数）。**黙って上書きしない。**
 *
 * `logo.png` → `logo-2.png` → `logo-3.png`
 */
export function uniqueName(name: string, existing: readonly string[]): string {
  const taken = new Set(existing ?? [])
  const safe = safeAssetName(name)
  if (!taken.has(safe)) return safe
  const m = /^(.*?)(\.[^.]*)?$/.exec(safe)!
  const stem = m[1]
  const ext = m[2] ?? ''
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!taken.has(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

/**
 * 画面に出す言葉（純関数のとなりに置く）。
 *
 * ── なぜ定数にするか（2026-08-19 Ryosuke 指摘）────────────────────────
 * AI は「【画像を使う】にチェックを入れてください」と案内する。
 * **画面の文字と案内の文字がずれたら、利用者は探せない。** 両方が同じ
 * ここを見るようにして、ずれようがなくする（掟9）。
 *
 * ボタンは絵文字だけにしない。「📁」だけでは**何ができるのか分からない**
 * （実機で「機能していないように見える」と言われた原因のひとつ）。
 */
export const ASSET_USE_LABEL = '画像を使う'
/**
 * 入れたあとに**会話へ残す一言**（純関数）。
 *
 * ── なぜ入力欄に文を入れるのをやめたか（2026-08-19 実機・Ryosuke 指摘）──
 * 入れるたびに入力欄へ長い説明文が入り、さらに小さな字の知らせも出ていた。
 * 「チャット欄がごちゃっとして、利用者が混乱する」。
 *
 * 送信前の添付は**送信のときにAIへ添える**（画面には出さない）。
 * 送信済みの画像から入れたときだけ、この一言を会話に残す
 * （利用者にも読め、次の指示のときAIも履歴から読める）。
 */
export function assetSavedNote(relPath: string, purpose: AssetPurpose): string {
  // **利用者に要らない話は書かない**（2026-08-19 Ryosuke 指摘）。
  // ・相対パスでの参照のしかたは AI に伝えることであって、画面に出す話ではない
  // ・「この場所は公開されます」も要らない。**アプリで使うなら公開されるのは自明**で、
  //   わざわざ書くと「まずいことをしたのか」と誤解させる。
  //   断りが要るのは逆の場合（素材＝公開されない）だけ。
  return purpose === 'material'
    ? `📁 画像を「${relPath}」に置きました（公開されません）。`
    : `📁 画像を「${relPath}」に入れました。`
}

/**
 * まだ保存していない画像について、**Koto が**画面に出す案内（純関数）。
 *
 * ── AI に案内させない（2026-08-19 実機・Ryosuke 指摘）────────────────────
 * AI に1行だけ案内させていたが、**古い会話を真似て長い手順を書いた**
 * （「【アプリで使う（公開されます）】を選び…入力欄に自動で入ります」）。
 * 案内は毎回同じ文でよい。**Koto が出せば、間違いようがない。**
 */
export function useImageHint(count: number): string {
  const what = count > 1 ? 'これらの画像' : 'この画像'
  return `💡 ${what}をアプリで使うなら、画像の下の【📁 ${ASSET_USE_LABEL}】を押してください。押すと、続きは自動で進みます。`
}

/**
 * 入れたあとにチャットへ入れる文面（純関数）。**送信はしない。**
 *
 * 入れただけでは AI は知らない。**知らせるところまでが「入れる」**である。
 */
export function tellAiAboutAsset(relPath: string, purpose: AssetPurpose): string {
  return purpose === 'material'
    ? `画像を「${relPath}」に置きました。これは素材の置き場で、公開はされません。`
      + '使いたくなったら、アプリで使う場所へ移してください。'
    // ── 書き方の講義をさせない（2026-08-19 実機・Ryosuke 指摘）──────────────
    // 以前はここで「ページから参照するときの正しい書き方も教えてください」と
    // 頼んでいた。その結果、毎回「## ページから画像を参照する正しい書き方」の
    // 表が返ってきた。**利用者はコードを書かない。** 不要な情報である。
    : `画像を「${relPath}」に入れました。この画像をページで使ってください`
      + '（この場所は公開されます）。'
}

/**
 * 貼り付けた画像など、元の名前が無いときのファイル名（純関数）。
 *
 * **日付を入れる**（同じ名前が並ぶと、あとから見分けられない）。
 */
export function defaultImageName(mediaType: string | null | undefined, now: Date = new Date()): string {
  const ext = /png/i.test(String(mediaType ?? '')) ? 'png'
    : /jpe?g/i.test(String(mediaType ?? '')) ? 'jpg'
    : /webp/i.test(String(mediaType ?? '')) ? 'webp'
    : /gif/i.test(String(mediaType ?? '')) ? 'gif'
    : 'png'
  const p = (n: number) => String(n).padStart(2, '0')
  return `画像-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`
}

/** data URL から画像の種類を取り出す（純関数・分からなければ null）。 */
export function mediaTypeOf(dataUrl: string | null | undefined): string | null {
  const m = /^data:([^;,]+)[;,]/.exec(String(dataUrl ?? ''))
  return m ? m[1] : null
}
