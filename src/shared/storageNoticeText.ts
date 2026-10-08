// storageNoticeText.ts — ③公開の「データの保存」の枠に出る文と、AI への依頼文（純ロジック）。
//
// ── なぜ切り出すのか（2026-09-23 実機で起きたこと）────────────────────
// ③公開に「⚠️ データが消えてしまいます」と出た。アプリの server.js が
// ファイルへ直接書いていたためで、**この判定は正しかった**。
// 利用者が「AIに書き直してもらう」を押して頼むと、AI は2回とも
// **「書き直しは既に完了しています」と答えたのに、実際には1文字も変わっていなかった**。
// AI はファイルを読まずに答えていた。
//
// 利用者から見ると、こうなる:
//   1. Koto が「データが消えます。AI に書き直してもらってください」と言う
//   2. AI が「完了しました」と答える
//   3. Koto は「まだです」と言い続ける
//   4. どちらを信じればよいか、利用者には確かめる手段がない
//
// **この行き止まりを作っているのは Koto である。** Koto はファイルを実際に読んで
// 判定しているのに、その結果を AI へ渡していなかった。だから AI は自分の記憶で答える。
// ここでは次の3つを直す:
//   1. 依頼文に「どのファイルの何行目か」を入れる（Koto が知っていることを渡す）
//   2. 書き直せたかを、その場でもう一度調べられるようにする（板挟みを断つ）
//   3. 「用意済み」と「まだ危ない」が同じ枠に同居しないようにする
//
// **画面には素のテキストとして出る。Markdown 記法は使わない**（v0.2.98 の教訓）。
// **内部の言い回しを書かない**（利用者が読む文である）。

import type { FileWriteSite, ModuleKind } from './objectStorage'
import { DATA_LAYER_FILE, DATA_LAYER_FILE_CJS } from './objectStorage'

/** 依頼文と確認の行に並べる場所の上限。多すぎると読めなくなる。 */
const MAX_SITES = 5

/**
 * 書き直し先の1行（純関数）。**アプリのコードがこれを書く**ので、形を変えない。
 *
 * ── なぜ2通りあるのか（2026-09-23 実機でアプリが起動しなくなった）─────────
 * 依頼文はずっと import の形だけを渡していた。require で動いているアプリに
 * その形を頼むと、AI は読み込めるようにしようとして package.json に
 * `"type": "module"` を足す。するとアプリ全体が require を使えなくなり、
 * **起動しなくなる**（`ReferenceError: require is not defined in ES module scope`）。
 *
 * **依頼文は、実際に置いたファイルに合わせる。** アプリの形は変えさせない。
 */
export function dataLayerUsageLine(kind: ModuleKind): string {
  return kind === 'esm'
    ? `import { list, get, save, remove } from './${DATA_LAYER_FILE}'`
    : `const { list, get, save, remove } = require('./${DATA_LAYER_FILE_CJS}')`
}

/**
 * 「保存場所を用意する」が終わったときの完了文（純関数）。
 *
 * ── なぜ純関数にするのか（2026-09-23 検分）────────────────────────────
 * ここは長らく `koto-data.js もプロジェクトに置きました。` という**決め打ち**だった。
 * require のアプリに置かれるのは `koto-data.cjs` なので、**画面だけが違う名前を言う**。
 * それを読んだ利用者が AI に「koto-data.js を使って」と頼めば、存在しないファイルからの
 * 読み込みが生まれる——**今回の事故の出発点とまったく同じ形**である。
 *
 * だから名前は**置いた側（main の `ensureDataLayer`）が返したものだけ**を使う。
 * 名前が運ばれてこなかったときは、**名前を言わない**（嘘を書かないため）。
 *
 * @param bucket 用意した保存場所の名前
 * @param placed 今回データ層を置いたか
 * @param file   実際に置いたファイル名（運ばれてこなければ null）
 */
export function storagePreparedText(
  bucket: string,
  placed: boolean,
  file?: string | null,
): string {
  const name = typeof file === 'string' && file.length > 0 ? file : null
  const layer = !placed ? ''
    : name ? `${name} もプロジェクトに置きました。`
    : 'データの保存の部品もプロジェクトに置きました。'
  return `保存場所『${bucket}』を用意しました。${layer}次に公開すると、アプリから読み書きできるようになります。`
}

/** 依頼文で必ず添える「アプリの形を変えない」お願い。**ここを削らないこと。**
 *  移行の依頼文（shared/leftoverData.ts の askAiMoveDataText）も**同じものを使う**
 *  ——文字列を2か所に書かない（掟10）。 */
export const KEEP_SHAPE =
  'package.json の "type" は変更しないでください（変更するとアプリが起動しなくなります）。'

/** 使える場所だけを残す（壊れた入力でも落ちない）。 */
function validSites(writes: readonly FileWriteSite[] | null | undefined): FileWriteSite[] {
  return (writes ?? [])
    .filter((w): w is FileWriteSite => !!w && typeof w.file === 'string' && w.file.length > 0)
    .map(w => ({
      file: w.file,
      lines: (Array.isArray(w.lines) ? w.lines : []).filter(n => Number.isFinite(n) && n > 0),
    }))
}

/** 1件の場所を「server.js の 66行目」の形にする（純関数）。 */
export function describeWriteSite(site: FileWriteSite): string {
  const [s] = validSites([site])
  if (!s) return ''
  if (s.lines.length === 0) return s.file
  return `${s.file} の ${s.lines.map(n => `${n}行目`).join('、')}`
}

/** 複数の場所を並べる（上限を超えたぶんは「ほかN件」）。 */
function describeWriteSites(sites: readonly FileWriteSite[]): string {
  const shown = sites.slice(0, MAX_SITES).map(describeWriteSite).filter(s => s.length > 0)
  const rest = sites.length - shown.length
  return shown.join('、') + (rest > 0 ? `、ほか${rest}件` : '')
}

/**
 * AI に渡す依頼文（純関数）。**Koto が見つけた場所をそのまま入れる。**
 *
 * - どのファイルの何行目か（見つかっていないときは**書かない**。嘘を書かないため）
 * - 書き直し先（koto-data の import）
 * - **書き直したあとに読み直して確かめてから完了と答えること**。
 *   2026-09-23 の事故は、これが無かったために起きた
 */
export function askAiRewriteText(
  writes: readonly FileWriteSite[],
  kind: ModuleKind = 'esm',
  /**
   * 入力されたデータを**メモリ（変数・配列）だけに持っている**場所（2026-10-01 rc.5 の実機）。
   * 無ければ（空・省略）、依頼文はこれまでとまったく同じ。**Koto が見つけた場所をそのまま入れる**
   * ——渡さないと AI は自分の記憶で「完了しました」と答える（このファイル冒頭の事故と同じ形）。
   */
  memory: readonly FileWriteSite[] = [],
): string {
  const sites = validSites(writes)
  const inMemory = validSites(memory)
  const usage = dataLayerUsageLine(kind)
  // ここから先（置いてあるファイル・アプリの形を変えさせない・読み直して確かめる）は
  // ファイルへの書き込みでもメモリでも変わらない
  const keepShape =
    // **アプリの形を変えさせない**（2026-09-23 実機。ここを言わなかったために
    // package.json に "type": "module" が足され、アプリが起動しなくなった）
    `このファイルはもう置いてあります。読み込み方は上の1行のとおりにして、${KEEP_SHAPE}`
  if (inMemory.length === 0) {
    const where = sites.length > 0
      ? `ファイルに直接書き込んでいるのは ${describeWriteSites(sites)} です。そこを `
      : 'いまファイルに直接書き込んでいる箇所を、'
    return 'データの保存を koto-data に切り替えてください。'
      + where
      + `${usage} を使う形に書き直してください。`
      + keepShape
      + '書き直したあと、実際にファイルを読み直して、ファイルへの書き込みが残っていないことを確かめてから、完了と答えてください。'
  }
  // メモリだけに持っている形。書き直し先は koto-data の list / get / save / remove
  const memoryWhere = `入力されたデータをプログラムの中（変数や配列）だけに持っているのは ${describeWriteSites(inMemory)} です。`
  const fileWhere = sites.length > 0
    ? `ファイルに直接書き込んでいるのは ${describeWriteSites(sites)} です。`
    : ''
  return 'データの保存を koto-data に切り替えてください。'
    + fileWhere
    + memoryWhere
    + `そこで持っているデータを、${usage} の list / get / save / remove で保存する形に書き直してください。`
    + 'サーバーが再起動したり公開し直したりすると、変数や配列の中のデータは消えてしまうためです。'
    + keepShape
    + '書き直したあと、実際にファイルを読み直して、'
    + (sites.length > 0 ? 'ファイルへの書き込みと、' : '')
    + '変数や配列だけにデータを持っている箇所が残っていないことを確かめてから、完了と答えてください。'
}

/**
 * 「AIに書き直してもらう」を押したときに、**送ってよいか**を決める（純関数）。
 *
 * ── なぜ判断をここに置くのか（2026-09-23）──────────────────────────────
 * 読み込み先のファイルが無いまま依頼文を送ると、**必ず失敗する頼みごと**になる。
 * 実機ではこれが起き、AI は3回「完了しました」と答え、実物は変わらなかった。
 * 送る・送らないの判断は画面の都合ではないので、純関数として固定する（掟10）。
 */
export function askAiRewritePlan(
  writes: readonly FileWriteSite[],
  layer: { ok?: boolean; ready?: boolean; moduleKind?: ModuleKind; message?: string } | null | undefined,
  /** メモリだけに持っている場所（2026-10-01）。省略は無し。 */
  memory: readonly FileWriteSite[] = [],
): { send: true; text: string } | { send: false; error: string } {
  if (!layer || layer.ok !== true || layer.ready !== true) {
    const detail = typeof layer?.message === 'string' && layer.message.length > 0 ? `（${layer.message}）` : ''
    return {
      send: false,
      error: '保存の部品を用意できませんでした' + detail
        + '。この状態で書き直しをお願いすると、読み込み先が無いために失敗します。'
        + '少し待ってから、もう一度お試しください。',
    }
  }
  return { send: true, text: askAiRewriteText(writes, layer.moduleKind === 'esm' ? 'esm' : 'cjs', memory) }
}

/**
 * koto-data の版について、画面に出す1行（純関数）。出すものが無ければ空文字。
 *
 * ── なぜ要るのか（2026-09-24 検分）──────────────────────────────────
 * 直しの出発点は「**いま公開中のアプリ**が混雑で真っ白になる／後勝ちで消える」
 * ことだった。その対象は**すべて既に koto-data を持っている**ので、
 * 差し替えられたのか・触れなかったのかを**利用者に見える形**にしておかないと、
 * 「直したのに直っていない」が起きる。
 *
 * **触れなかったときに、勝手に上書きしない**のは決まりどおり（dataLayer.ts）。
 * ここでは「Koto は触っていない」ことと、次に何をすればよいかだけを伝える。
 */
export function dataLayerUpdateLine(
  layer: { ok?: boolean; file?: string | null; replaced?: boolean; needsUpdate?: boolean } | null | undefined,
): string {
  if (!layer || layer.ok !== true) return ''
  const name = typeof layer.file === 'string' && layer.file.length > 0 ? layer.file : 'koto-data'
  if (layer.replaced === true) return `🔄 ${name} を新しい版に差し替えました（混み合ったときのやり直し・同時更新の検知が入ります）。`
  if (layer.needsUpdate === true) {
    // 画面には素のテキストとして出る（StorageNotice.tsx の <p>{checkLine}</p>）。
    // **Markdown 記法を使わない**——アスタリスクがそのまま見える（このファイル冒頭の決まり）。
    return `ℹ️ ${name} は Koto が置いた版か分からなかったので、そのままにしました。`
      + '新しい版には、混み合ったときのやり直しと、同時更新の検知が入っています。'
      + '入れ替えてよいか分からないときは、Koto に相談してください。'
  }
  return ''
}

/**
 * 「書き直せたか確かめる」を押したあと、画面に出す1行にする（純関数）。
 *
 * **確かめていないことを断定しない。** 調べられなかったときは、
 * 「済んだ」にも「まだ」にも倒さない。
 */
export type RewriteScan = {
  usesDataLayer: boolean
  writesFiles: readonly FileWriteSite[]
  /**
   * メモリだけに持っている場所（2026-10-01）。**警告の理由に数えるものだけ**を渡す
   * （koto-data を使っているとき・レンタルサーバでは空。storageNeed.ts の `memorySitesFor`）。
   * 残っていれば「まだ」（❌）で、`rewriteCheckDone` も偽——**文と判断は同じ入力で一致させる**
   * （画面は空のときしか渡さないが、呼び出し側の作法に頼らない・2026-10-01 検分）。
   */
  keepsInMemory?: readonly FileWriteSite[]
  /**
   * **警告の理由にはしない**が、まだ残っているメモリの場所（storageNeed.ts の `memorySitesNotWarned`）。
   * koto-data を使っているときのもの。✅ の文に「ただし、ここに残っています」と**名指しで添える**
   * ——AI が koto-data の読み込みを1行足しただけでも ✅ になり、メモリのデータが消える形を
   * 見過ごさないため。✅ かどうか（`rewriteCheckDone`）は変えない（キャッシュのこともある）。
   */
  memoryNotWarned?: readonly FileWriteSite[]
  /** 走査が打ち切られた（全部は見られなかった）か。 */
  truncated?: boolean
}

/**
 * 「書き直せた（✅）」と言い切れるか（純関数）。
 *
 * ── なぜ1行の文とは別に要るのか（2026-09-24）──────────────────────────
 * 「💾 いま入っているデータをどうしますか」は、**書き直せているときだけ**出す。
 * その判断を画面が `rewriteCheckLine` の文字列から拾う（先頭が ✅ か見る等）と、
 * 文言を1文字直した瞬間に問いが出なくなる。**判断は判断として持つ**（掟10）。
 *
 * rewriteCheckLine が ✅ を返す条件と**同じ**であることは
 * tests/leftoverData.test.ts で固定してある。
 */
export function rewriteCheckDone(scan: RewriteScan | null | undefined): boolean {
  if (!scan || !Array.isArray(scan.writesFiles)) return false
  if (validSites(scan.writesFiles).length > 0) return false
  // メモリだけに持つ形が残っていれば、rewriteCheckLine は ❌ を返す。判断も同じにする
  if (validSites(scan.keepsInMemory).length > 0) return false
  if (scan.truncated === true) return false
  return scan.usesDataLayer === true
}

export function rewriteCheckLine(scan: RewriteScan | null | undefined): string {
  if (!scan || !Array.isArray(scan.writesFiles)) {
    return 'ℹ️ 確かめられませんでした。少し待ってから、もう一度お試しください。'
  }
  const sites = validSites(scan.writesFiles)
  // メモリだけに持つ形が残っていれば、同じく「まだ」と名指しする（2026-10-01）。
  // 言わないと、AI が「完了しました」と答えたのに何も変わっていないとき、下の
  // 「書き込みは見つかりませんでしたが…」に落ちて、場所を示せない
  const inMemory = validSites(scan.keepsInMemory)
  if (sites.length > 0 && inMemory.length > 0) {
    return `❌ まだ書き直されていません（${describeWriteSites(sites)} にファイルへの書き込みが、`
      + `${describeWriteSites(inMemory)} にメモリだけにデータを持っている箇所が残っています）。AI にもう一度お願いしてください。`
  }
  if (sites.length > 0) {
    return `❌ まだ書き直されていません（${describeWriteSites(sites)} に残っています）。AI にもう一度お願いしてください。`
  }
  if (inMemory.length > 0) {
    return `❌ まだ書き直されていません（${describeWriteSites(inMemory)} に、メモリだけにデータを持っている箇所が残っています）。AI にもう一度お願いしてください。`
  }
  // **見られなかった範囲があるなら、断定しない**（2026-09-23 検分）。
  // 大きすぎるファイル・深いフォルダは走査を打ち切っている。それを
  // 「見つかりませんでした」と言い切ると、調べていないものを済んだ扱いにする
  if (scan.truncated === true) {
    return 'ℹ️ 全部は調べられませんでした（大きなファイルや深いフォルダは見ていません）。'
      + '調べられた範囲では、ファイルへの書き込みは残っていません。'
  }
  // **書き込みが消えただけでは、書き直せたことにならない。** koto-data を
  // 使っている箇所が1つも無いなら、保存そのものが無くなった可能性がある
  if (scan.usesDataLayer !== true) {
    return 'ℹ️ ファイルへの書き込みは見つかりませんでしたが、データの保存を使っている箇所も見つかりません。'
      + '保存が必要なら、AI にもう一度お願いしてください。'
  }
  // koto-data を使っていて、書き込みも消えている。ただし**メモリだけに持つ箇所が残っている**ときは、
  // それを黙らない（警告にはしない＝キャッシュのこともあるので、場所を名指しして確かめてもらう）。
  // 先頭は ✅ のまま——✅ かどうかの判断は rewriteCheckDone が持つ（掟10）
  const beside = validSites(scan.memoryNotWarned)
  if (beside.length > 0) {
    return '✅ ファイルへの書き込みは見つかりませんでした。'
      + `ただし ${describeWriteSites(beside)} に、メモリ（変数や配列）だけにデータを持っている箇所が残っています。`
      + 'キャッシュなど、消えてもよい一時的な置き場なら、そのままで問題ありません。'
      + '入力されたデータを持っているなら、まだ消える形です。'
      + `チャットで AI に「${describeWriteSites(beside)} のデータを、データの保存（koto-data）で保存する形に書き直して」と頼んでください。`
  }
  return '✅ 書き直せています。ファイルへの書き込みは見つかりませんでした。'
}

/**
 * 枠の見出し（純関数）。
 *
 * **「用意済み」と「まだ危ない」を同じ見出しに同居させない**（2026-09-23）。
 * 保存場所ができていても、コードの書き直しが残っていればデータは消える。
 */
export function storageNoticeHeadline(opts: { hasPlacement: boolean; warn: boolean; guess?: boolean }): string {
  const hasPlacement = opts?.hasPlacement === true
  const warn = opts?.warn === true
  // 警告の理由が「メモリだけに持っていそう」という**推定だけ**のとき（StorageNeed の `memoryOnly`）は、
  // 見出しも断定しない。回数制限・キャッシュ・接続の一覧を当ててしまうことがあるのに、
  // 見出しだけ「消えてしまいます」と言い切ると、本文の「ようです」と食い違う（2026-10-01 検分）
  const guess = opts?.guess === true
  if (hasPlacement && warn) {
    return guess
      ? '⚠️ 保存場所は用意済み・コードの書き直しが残っているかもしれません'
      : '⚠️ 保存場所は用意済み・コードの書き直しが残っています'
  }
  if (hasPlacement) return '💾 データの保存（用意済み）'
  if (warn) return guess ? '⚠️ データが消えるかもしれません' : '⚠️ データが消えてしまいます'
  return '💾 データの保存について'
}

/** 保存場所はあるが書き直しが残っているときに、残りの作業を1行で伝える文。 */
export const STORAGE_REWRITE_REMAINING =
  '保存場所は用意できています。あとは、コードの書き直しだけです。'

/**
 * 上の文の**推定版**（警告の理由が「メモリだけに持っていそう」だけのとき）。
 * 見出しが「〜かもしれません」と言った直後に「あとは書き直しだけ」と言い切らない（2026-10-01 検分2巡目）。
 */
export const STORAGE_REWRITE_MAYBE_REMAINING =
  '保存場所は用意できています。メモリだけにデータを持っている箇所が残っていないか、下の案内で確かめてください。'
