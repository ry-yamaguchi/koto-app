// storageNeed.ts — 「このアプリに保存場所が要るか」を、公開先ごとに判断する（純ロジック）。
//
// ── なぜ公開先ごとなのか（2026-08-13 Ryosuke 提案）────────────────────
// 永続データが要るかどうかは、**AIと相談しながら作っている間に決まる**。
// 利用者が設定画面で申告するものではない。だから「書かれたコードから検出」し、
// **公開先を選ぶ瞬間に提案する**。そこで初めて「データが残るかどうか」が決まるため。
//
//   AppRun（共用型・専有型）/ HANAMII / Vercel … 残らない → オブジェクトストレージが要る
//   さくらのレンタルサーバ    … 残る     → サーバ自身のファイルでよい（追加費用なし）
//
// ── いま静かに壊れていること ──────────────────────────────────────────
// AI に「回答を保存して」と頼むと `fs.writeFile` で JSON を書くコードを生成しうる。
// **AppRun のコンテナでは書けてしまう**ので動作確認では正常に見え、再起動や
// 再公開で消える。利用者から見ると「昨日入れたデータが今日消えている」という、
// 原因の分からない失敗になる。ここはそれを検出して知らせる役目も持つ。

import { STORAGE_ENV, type FileWriteSite } from './objectStorage'

// 種類は src/renderer/publishStatus.ts の PublishTargetKind と同じ並び（専有型は D-3 で追加）。
export type PublishTarget = 'hanamii' | 'sakura-apprun' | 'sakura-apprun-dedicated' | 'sakura-rental' | 'vercel'

/** 公開先がデータを保持できるか。 */
export function targetKeepsData(target: PublishTarget): boolean {
  // レンタルサーバは共用ホスティングでファイルが残る。ほかはコンテナ/サーバーレス
  //（AppRun 専有型もコンテナなので共用型と同じく残らない）
  return target === 'sakura-rental'
}

export type StorageNeed =
  /** 保存場所は要らない（データを扱っていない）。 */
  | { kind: 'none' }
  /** アプリが保存場所を使うと宣言している（KOTO_STORAGE_* を参照）。 */
  | { kind: 'declared'; note: string }
  /**
   * データを書いていそうだが、公開先では消える。**静かに壊れる形。**
   *
   * `memoryOnly`: 理由が「メモリだけに持っていそう」という**推定だけ**で、ファイルへの書き込みは
   * 見つかっていない（2026-10-01）。見出しも「消えてしまいます」と断定せず「かもしれません」と言う
   * （回数制限・キャッシュなどを当ててしまうことがあるため・storageNoticeHeadline）。
   */
  | { kind: 'will-lose-data'; note: string; memoryOnly?: true }
  /** 公開先自身がデータを保持できるので、追加の保存場所は要らない。 */
  | { kind: 'target-provides'; note: string }

/**
 * 検出した環境変数とファイル書き込みの痕跡から、保存場所の要否を判断する（純関数）。
 *
 * @param usesDataLayer アプリが koto-data を使っているか。**いちばん強い信号**
 *   （環境変数はデータ層の中にしか出てこないので、アプリのコードからは分からない）
 * @param writesFiles ソースに自前のファイル書き込みがあるか
 * @param keepsInMemory 入力されたデータを、メモリ（変数・配列）だけに持っていそうか
 *   （2026-10-01 rc.5 の実機）。**推定**なので、文は「ようです」と断定を避ける。
 *   **任意（`?`）にしない**——渡し忘れても型検査が素通りすると、この判定が黙って外れる（掟10）
 * @param target   選ばれている公開先
 */
export function storageNeedFor(opts: {
  usesDataLayer: boolean
  writesFiles: boolean
  keepsInMemory: boolean
  target: PublishTarget
}): StorageNeed {
  const declared = opts.usesDataLayer === true
  const memory = opts.keepsInMemory === true && memoryIsAProblem(opts)

  if (declared) {
    // **メモリだけに持つ形は、ここでは理由にしない**（キャッシュの誤検知を避けるため・
    // `memoryIsAProblem` の①）。`memory` は declared のとき必ず偽になる。
    //
    // **宣言していても、書き込みが残っていれば危ない**（2026-09-23 検分）。
    // koto-data を使い始めたファイルが1つでもあれば usesDataLayer は真になるが、
    // 別のファイル（あるいは同じファイルの直し残し）に fs.writeFileSync が
    // 残っていれば、そのデータは公開のたびに消える。ここで declared を優先すると
    // 画面の警告も「書き直せたか確かめる」も丸ごと消え、**Koto は知っているのに
    // 何も言わない**状態になる。書き直しが残っている側へ倒す
    if (opts.writesFiles && !targetKeepsData(opts.target)) {
      return {
        kind: 'will-lose-data',
        note: 'データの保存を使い始めていますが、ファイルに直接書いている箇所が残っています。'
          + 'この公開先では、そこに書いたデータは残りません（何もしなくても消えることがあります）。残りも書き直してください。',
      }
    }
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
    if (memory) {
      // ファイルへの書き込みと、メモリだけに持つ形の**両方**がある。片方だけを言うと、
      // 直したつもりで残りが消える（書き直しの依頼も両方の場所を渡す・storageNoticeText.ts）
      return {
        kind: 'will-lose-data',
        note: 'このアプリは、ファイルにデータを書いている箇所と、入力されたデータをプログラムの中（メモリ）だけに持っている箇所があるようです。'
          + 'この公開先では、どちらも再起動や公開し直しのたびに消えます（何もしなくても消えることがあります）。'
          + '残したいときは、AI に「データの保存」を使う形へ書き直してもらってください。',
      }
    }
    return {
      kind: 'will-lose-data',
      note: 'このアプリはファイルにデータを書いています。この公開先では、ファイルに書いたデータは残りません'
        + '（何もしなくても消えることがあります）。保存場所を用意しないと、入力されたデータは失われます。'
        + '用意すれば、データが残るようになります。',
    }
  }

  if (memory) {
    // ファイルにも koto-data にも書かないので、これまでは何も言わなかった（2026-10-01 rc.5 の実機）。
    // 「ようです」＝**推定**であることを言う（コードを読んで当てているだけで、実行して確かめてはいない）
    return {
      kind: 'will-lose-data',
      memoryOnly: true,
      note: 'このアプリは、入力されたデータをプログラムの中（メモリ）だけに持っているようです。'
        + 'この公開先では、再起動や公開し直しのたびに消えます。'
        + '残したいときは、AI に「データの保存」を使う形へ書き直してもらってください。',
    }
  }

  return { kind: 'none' }
}

/**
 * メモリだけに持つ形を、警告・書き直しの対象にしてよいか（**判定の正はここ1か所**・掟10）。
 *
 * ── 数えない2つの場合 ──────────────────────────────────────────────
 * ① **koto-data を使っている（declared）とき**: すでに保存の入口があるので、メモリの配列・Map は
 *    キャッシュや作業用である可能性が高い。ここで警告すると、**ちゃんと作れているアプリに
 *    「データが消えます」と言う誤検知**になる。書き直しの途中でファイルへ直接書く箇所が
 *    残っているときの警告（上の declared の分岐）とは別の話で、メモリは理由にしない。
 * ② **公開先がデータを保てるとき（レンタルサーバ）**: Node の常駐アプリを置く公開先ではない
 *    （HTML/PHP のサイト向け）ので、この判定の対象外。
 */
export function memoryIsAProblem(opts: { usesDataLayer: boolean; target: PublishTarget }): boolean {
  return opts.usesDataLayer !== true && !targetKeepsData(opts.target)
}

/** 走査の結果のうち、保存場所の判断に使う部分（main の `storage:scan` が返す形）。 */
export type StorageScanFacts = {
  usesDataLayer: boolean
  writesFiles: readonly FileWriteSite[]
  keepsInMemory: readonly FileWriteSite[]
}

/**
 * 走査の結果から保存場所の要否を決める（純関数）。**画面はこの1本だけを通す。**
 *
 * ③公開の画面は「開いたとき」と「書き直せたか確かめる」の2か所で同じ判断をする。
 * 条件を2か所に書き写すと片方だけ直されるので、ここに寄せる（掟10）。
 * `keepsInMemory` が来なかったとき（古い形の応答）は「無い」として扱う。
 */
export function storageNeedForScan(scan: StorageScanFacts, target: PublishTarget): StorageNeed {
  return storageNeedFor({
    usesDataLayer: scan.usesDataLayer,
    writesFiles: scan.writesFiles.length > 0,
    keepsInMemory: Array.isArray(scan.keepsInMemory) && scan.keepsInMemory.length > 0,
    target,
  })
}

/**
 * 走査の結果のうち、**警告・書き直しの理由に数えるメモリの場所**（純関数）。
 *
 * 画面が場所を見せる・AI へ渡すときは、`keepsInMemory` をそのまま使わず必ずこれを通す。
 * 警告の理由にならない場合（`memoryIsAProblem` が偽）に場所だけ出ると、
 * 「何も言っていないのに、場所だけ書いてある」という食い違いになる。
 */
export function memorySitesFor(scan: StorageScanFacts, target: PublishTarget): FileWriteSite[] {
  if (!memoryIsAProblem({ usesDataLayer: scan.usesDataLayer, target })) return []
  return Array.isArray(scan.keepsInMemory) ? [...scan.keepsInMemory] : []
}

/**
 * **警告の理由にはしない**が、まだ残っているメモリの場所（純関数）。
 *
 * koto-data を使っているとき（`memoryIsAProblem` の①）、メモリは警告の理由にしない。ただし
 * 「書き直せたか確かめる」で ✅ と言うときは、**メモリへの書き込みが残っていることを黙らない**
 * （2026-10-01 検分）。AI が koto-data の読み込みを1行足しただけで `names.push` を残していても、
 * 「koto-data を使っている」ので ✅ になり、メモリのデータが消える形が見過ごされる。
 * 警告にはしない（キャッシュのこともある）ので、場所を名指しして、利用者に確かめてもらう。
 */
export function memorySitesNotWarned(scan: StorageScanFacts, target: PublishTarget): FileWriteSite[] {
  if (scan.usesDataLayer !== true || targetKeepsData(target)) return []
  return Array.isArray(scan.keepsInMemory) ? [...scan.keepsInMemory] : []
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
