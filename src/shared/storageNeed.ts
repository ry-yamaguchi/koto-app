// storageNeed.ts — 「このアプリに保存場所が要るか」を、公開先ごとに判断する（純ロジック）。
//
// ── なぜ公開先ごとなのか（2026-08-13 Ryosuke 提案）────────────────────
// 永続データが要るかどうかは、**AIと相談しながら作っている間に決まる**。
// 利用者が設定画面で申告するものではない。だから「書かれたコードから検出」し、
// **公開先を選ぶ瞬間に提案する**。そこで初めて「データが残るかどうか」が決まるため。
//
//   AppRun / HANAMII / Vercel … 残らない → オブジェクトストレージが要る
//   さくらのレンタルサーバ    … 残る     → サーバ自身のファイルでよい（追加費用なし）
//
// ── いま静かに壊れていること ──────────────────────────────────────────
// AI に「回答を保存して」と頼むと `fs.writeFile` で JSON を書くコードを生成しうる。
// **AppRun のコンテナでは書けてしまう**ので動作確認では正常に見え、再起動や
// 再公開で消える。利用者から見ると「昨日入れたデータが今日消えている」という、
// 原因の分からない失敗になる。ここはそれを検出して知らせる役目も持つ。

import { STORAGE_ENV } from './objectStorage'

export type PublishTarget = 'hanamii' | 'sakura-apprun' | 'sakura-rental' | 'vercel'

/** 公開先がデータを保持できるか。 */
export function targetKeepsData(target: PublishTarget): boolean {
  // レンタルサーバは共用ホスティングでファイルが残る。ほかはコンテナ/サーバーレス
  return target === 'sakura-rental'
}

export type StorageNeed =
  /** 保存場所は要らない（データを扱っていない）。 */
  | { kind: 'none' }
  /** アプリが保存場所を使うと宣言している（KOTO_STORAGE_* を参照）。 */
  | { kind: 'declared'; note: string }
  /** データを書いていそうだが、公開先では消える。**静かに壊れる形。** */
  | { kind: 'will-lose-data'; note: string }
  /** 公開先自身がデータを保持できるので、追加の保存場所は要らない。 */
  | { kind: 'target-provides'; note: string }

/**
 * 検出した環境変数とファイル書き込みの痕跡から、保存場所の要否を判断する（純関数）。
 *
 * @param usesDataLayer アプリが koto-data を使っているか。**いちばん強い信号**
 *   （環境変数はデータ層の中にしか出てこないので、アプリのコードからは分からない）
 * @param writesFiles ソースに自前のファイル書き込みがあるか
 * @param target   選ばれている公開先
 */
export function storageNeedFor(opts: {
  usesDataLayer: boolean
  writesFiles: boolean
  target: PublishTarget
}): StorageNeed {
  const declared = opts.usesDataLayer === true

  if (declared) {
    if (targetKeepsData(opts.target)) {
      // 宣言はしているが、公開先自身も保持できる。用意しておけば公開先を
      // 変えても引き継げるので、**用意する側に倒す**
      return { kind: 'declared', note: 'このアプリはデータの保存を使います。' }
    }
    return { kind: 'declared', note: 'このアプリはデータの保存を使います。公開先ではファイルが消えるため、保存場所が必要です。' }
  }

  if (opts.writesFiles) {
    if (targetKeepsData(opts.target)) {
      return { kind: 'target-provides', note: 'この公開先ではファイルがそのまま残るため、追加の保存場所は必要ありません。' }
    }
    return {
      kind: 'will-lose-data',
      note: 'このアプリはファイルにデータを書いています。この公開先ではアプリを作り直すたびにファイルが消えるため、'
        + '入力されたデータが失われます。保存場所を用意すると、データが残るようになります。',
    }
  }

  return { kind: 'none' }
}

/** 保存場所を用意すべきか（用意の導線を出すか）。 */
export function shouldOfferStorage(need: StorageNeed): boolean {
  return need.kind === 'declared' || need.kind === 'will-lose-data'
}

/**
 * 公開先を変えても、保存したデータは引き継がれる。
 *
 * **これは案内しないと伝わらない価値**（Ryosuke 2026-08-13）。
 * オブジェクトストレージは公開先から独立していて HTTPS で読み書きするだけなので、
 * AppRun で作ったデータは Vercel でも HANAMII でも読める。「公開直前に公開先を
 * 変えられる」という Koto の良さが、データを持ったアプリでも崩れない。
 */
export const STORAGE_PORTABLE_NOTE =
  '保存場所は公開先から独立しているため、公開先を変えてもデータはそのまま引き継がれます。'

/** アプリのコードが使う環境変数の名前（AIへの説明にも使う）。 */
export const STORAGE_ENV_NAMES = Object.values(STORAGE_ENV)
