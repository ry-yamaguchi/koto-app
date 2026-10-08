// koto-data.js — Koto が用意した「データの保存」。
//
// koto-data-template: 2026-09-25.0
// ↑ Koto が置いた版の印です。**この行を消さないでください。**
//   Koto は、この印が付いていて版が古いものだけを新しい版へ差し替えます。
//   印が無いもの・中身を作り替えたもの（データベース版に差し替えた等）には触れません。
//
// このファイルは Koto が置いたものです。**中身を書き換える必要はありません。**
// アプリからは下の4つだけを使ってください。
//
//   import { list, get, save, remove } from './koto-data.js'
//
//   await save('entries', { name: '山田', message: 'こんにちは' })  // 保存する
//   await list('entries')                                          // 全部読む
//   await get('entries', id)                                       // 1件読む
//   await remove('entries', id)                                    // 消す
//
//   Koto が使う項目名（3つあり、扱いはそれぞれ違います）
//
//     _kotoVersion … 何回目の変更かを数える版。Koto が必ず付け替えます。
//                    アプリのデータに、この名前を使わないでください。
//                    入れた値は、保存のたびに Koto の数に置き換わります。
//     id           … 1件ごとの番号。渡さなければ Koto が付けます。
//                    渡したときは、渡した値がそのまま残ります（同じ id で保存し直すと更新）。
//     createdAt    … 保存した日時。渡さなければ Koto が入れます。
//                    渡したときは、渡した値がそのまま残ります。
//
//   つまり、Koto が必ず書き換えるのは _kotoVersion だけです。
//   id と createdAt は、アプリから渡して構いません。
//   version は Koto が使いません（2026-09-25 に _kotoVersion へ移しました）。
//   仕様書の版、見積書の版など、アプリのものとして自由に使えます。
//   2026-09-24 以前に保存した1件だけは Koto が付けた版が version に残っている
//   ことがあり、そのときは版を読むときに参照します（書き換えはしません）。
//
//   一覧は、件数・開始位置・絞り込み・並びを指定できます。
//   **何も指定しなければ、今までどおり「全部・新しい順」です。**
//
//   await list('entries', { limit: 20 })                     // 新しい20件だけ
//   await list('entries', { limit: 20, skip: 20 })           // その次の20件
//   await list('entries', { where: r => r.name === '山田' })  // 絞り込む
//   await list('entries', { sort: 'name', order: 'asc' })     // 並べ替える
//
//   **skip は「読み飛ばす分も読みに行く」ので、後ろのページほど遅くなります**
//   （すぐ下の「件数の目安」に、回数まで書いてあります）。
//
// ── なぜこれを通すのか ────────────────────────────────────────────────
// ① **試すときと公開したときで、置き場所が変わる。**
//    手元で試すときは `.koto-data/` フォルダに、公開したあとはさくらの
//    オブジェクトストレージに保存します。この切り替えをここで吸収するので、
//    アプリのコードは何も変わりません。
//
// ② **1件を1ファイルとして保存する。**
//    全件を1つのファイルにまとめると、2人が同時に送信したときに片方が消えます。
//    **全部をまとめて1件に詰めないでください**（実際にそれで事故が起きました）。
//    保存した1件には版（_kotoVersion）が付き、**同じ1件を同時に書き換えたとき、
//    よくある取りこぼしを見つけて断ります**。ただし **完全に防げるわけではありません**
//    （読んでから書くまでのわずかな間に他の人が書けば、すり抜けます）。
//    詳しくは save() の説明を読んでください。
//
// ③ **あとでデータベースに移せる。**
//    置き場所を替えるときは、**このファイルの中身だけ**を差し替えれば済みます。
//    アプリ側は1行も変わりません。
//    ただし **list() の絞り込み（where）と並べ替え（sort）は、いまは「全部読んでから」
//    行っています。** 置き場所を替えても、それだけでは通信の回数は減りません。
//
// ── 向いていること・向いていないこと ──────────────────────────────────
// 問い合わせフォームの回答、投稿の一覧、簡単な記録には十分です。
//
// **件数の目安（2026-09-24 に原本で数え直した）**
//   〜200件   … 安心して使えます
//   〜500件   … 一覧を開くのが遅くなります
//   1,000件〜 … 向いていません（list() に limit を付けられるなら、まだ持ちます）
//
// list() は何も指定しなければ「一覧を1回＋**1件につき1回**」取りに行くので、
// 1,000件なら1回の一覧で 1,001回の通信が起きます。さくらの上限は1バケットあたり
// 毎秒100アクセスなので、最短でも10秒かかります。
// **その上限に当たらないよう、20件ずつ・間を少し置いて**読みに行きます
// （200件で待ち時間が約2秒、1,000件で約10秒。混んで断られて画面が真っ白になるより、
// 待つほうを選んでいます）。
//
// **通信の回数が減るのは、limit（と skip）を指定したときだけです。**
//   list('entries', { limit: 20 })            … 1,000件あっても 21回（一覧1回＋20件）
//   list('entries')                           … 1,001回
//
// **skip を付けると、読み飛ばす分も実際に読みに行きます。** 一覧に名前が出ていても、
// 消された直後の件・中身が壊れた件は読めないので、**読んでみるまで「読み飛ばせた」と
// 数えられない**（数えないと、同じ件が2ページに重なって出ます）。
// そのため読みに行く回数は **skip ＋ limit** 件になります。
//   list('entries', { limit: 20, skip: 20 })  … 41回（一覧1回＋40件）
//   list('entries', { limit: 20, skip: 980 }) … 1,001回。**全部読むのと変わりません。**
// **ページを送るほど遅くなります**（毎秒100アクセスの上限にも近づきます）。
// 後ろのページまで送る一覧が要るなら、Koto に相談してください。
//
// **検索・絞り込み（where）と並べ替え（sort）は、通信を減らしません。**
// 先に全部読んでから、このファイルの中で絞る・並べるだけです。
// where や sort を指定すると、limit を付けていても全件を読みます
// （読んでみるまで、どれが当てはまるか分からないため）。
//
// また、**自分で id を決めて保存した件が混ざっていると、limit を付けても全件を
// 読みます。** Koto が付ける id は保存した順に並ぶ形なので「新しい20件」を読む前に
// 選べますが、自分で決めた id はその順に並ばないので、選ぶと間違った20件になります。
// **速さより正しさを優先して、全件を読みます。**
//
// もうひとつ正直に書いておきます。limit で選ぶ「新しい20件」は**保存した順**の20件です。
// 自分で `createdAt` を入れて保存していて、それが保存した順と食い違うときは、
// **limit を付けたときだけ、期待と違う20件になります。**
// 食い違いがあるなら `{ sort: 'createdAt', order: 'desc' }` を使ってください
// （そのときは全件を読みます）。
//
// **同じミリ秒に保存された件の順番**は、**そのアプリが1つで動いているうちは保存順**です
// （id に「同じミリ秒の中での連番」を入れてあります）。ただし **公開してインスタンスが
// 2つ以上に増えると、同じミリ秒に別々のインスタンスが保存した分の前後は保証できません**
// （連番はそれぞれのインスタンスが別々に数えるため）。順番が業務上重要なら、
// 自分で並べ替えの項目を持たせて `{ sort: '…' }` を使ってください。
//
// **保存したら、`save()` が返したレコードを使い続けてください。**
// 版（_kotoVersion）は保存のたびに増えます。読んだときの写しを持ち回して2回保存すると、
// 2回目は「別のところで書き換えられました」で断られます。
// `const saved = await save('entries', rec)` のように**返り値を受け取る**か、
// 渡したオブジェクトをそのまま使い回してください（渡したオブジェクトにも新しい版を書き戻します）。
//
// 件数が増えて困ったら、Koto に相談してください。
//
// ⚠️ ここを書き換える人へ: **守れない約束を書かないこと。**
//    ・絞り込み（where）と並べ替え（sort）は「読んだあと」に効きます。通信は減りません。
//    ・版（version）による同時更新の検知は、**よくある取りこぼしの検知であって、
//      防止ではありません。**「壊れません」と書かないこと。
//    ・上の目安は、公式マニュアルの上限と料金の枠から数えた値です
//    （tests/kotoDataTemplate.test.ts が固定しています）。

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const BUCKET = process.env.KOTO_STORAGE_BUCKET || ''
const ENDPOINT = (process.env.KOTO_STORAGE_ENDPOINT || '').replace(/^https?:\/\//, '').replace(/\/+$/, '')
const REGION = process.env.KOTO_STORAGE_REGION || ''
const PREFIX = process.env.KOTO_STORAGE_PREFIX || ''
const ACCESS_KEY = process.env.KOTO_STORAGE_ACCESS_KEY || ''
const SECRET_KEY = process.env.KOTO_STORAGE_SECRET_KEY || ''

/** クラウドに保存できる状態か。足りなければ手元のフォルダを使う。 */
const useCloud = Boolean(BUCKET && ENDPOINT && REGION && ACCESS_KEY && SECRET_KEY)

/** 手元で試すときの保存先。 */
const LOCAL_DIR = path.join(process.cwd(), '.koto-data')

/** いまどちらに保存しているか（画面に出したいとき用）。 */
export function storageMode() {
  return useCloud ? 'cloud' : 'local'
}

// ── 使う側の4つ ───────────────────────────────────────────────────────

/**
 * 1件保存する。`id` を渡さなかったときは自動で付ける。
 * 同じ `id` で呼ぶと上書き（更新）になる。
 *
 * **「渡さなかった」は `undefined` ・ `null` ・ 空文字のこと。`0` は含まない。**
 * 曜日を 0〜6、時刻を 0〜23 で id にするのはごく普通の書き方で、`0` を「無い」と
 * みなすと**日曜の1件だけが毎回新しい id で増え続け、読み直しても出てこない**
 * （エラーは一度も出ない。2026-09-25 に直した）。
 * **この見分け方は `createdAt` にも同じように効きます**（`isGiven` の1か所で決めている）。
 * `0` や空文字を「無い」とみなしていたころは、渡した `createdAt` が黙って現在時刻へ
 * 差し替わっていた（`Number(form.createdAt)` は空欄で `0` になる）。
 *
 * **渡した `id` は、保存する前に確かめます。** `id: NaN`（`Number(params.id)` が数として
 * 読めなかったとき）や `id: false` は、そのままだと `NaN.json` ・ `false.json` という
 * 1つのファイルに**全員が上書きし合う**ので、その場で断ります（2026-09-25）。
 *
 * ── 同じ1件を、同時に書き換えたとき ────────────────────────────────────
 * 保存した1件には版（`_kotoVersion`）が付きます。`get()` や `list()` で読んだものを
 * そのまま書き戻したとき、**読んだときの版と、いま保存されている版が違えば断ります**
 * （その間に、別の人・別のインスタンスが書き換えた、ということです）。
 * 断られたら `get()` で読み直し、変更をやり直してから保存してください。
 *
 * **これは「よくある取りこぼしの検知」であって、防止ではありません。**
 * 確かめてから書くまでのわずかな間に他が書けば、すり抜けます。
 *
 * ・版を持たないデータ（`_kotoVersion` が入っていないもの）を渡したときは、
 *   今までどおり黙って上書きします（既に動いているアプリを止めないため）。
 * ・`save('entries', data, { overwrite: true })` を付けると、版を見ずに上書きします。
 * ・版を確かめるときだけ、保存の前に1回読みに行きます（通信が1回増えます）。
 *   **新しく作る1件（`id` を渡さなかったとき）は読みに行きません**（まだ何も無いため）。
 *
 * ── 同じレコードを、続けて何度も保存するとき ──────────────────────────
 * **保存に成功したら、渡されたオブジェクトにも新しい版を書き戻します。**
 * 「一覧を読む → 変更のたびに保存し直す」書き方（下）が、そのまま通るようにするためです。
 *
 *   const rows = await list('entries')
 *   for (const row of rows) await save('entries', row)   // 何度でも通る
 *
 * 書き戻さないと、2回目の保存で**必ず**「別のところで書き換えられました」になります
 * （手元の写しは古い版のままなので）。**別のインスタンスが割り込んだときの検知は
 * そのまま残ります**——割り込まれた側の版は、こちらの手元の版とは別に進むためです。
 */
export async function save(collection, data, options = {}) {
  safeName(collection) // 入口で確かめる（下の try で握りつぶされないように）
  const record = { ...data }
  // **偽値ではなく「渡されていない」で見分ける**（判定は isGiven の1か所・掟10）。
  // `!record.id` だと `0` も「無い」になり、日曜＝0・0時＝0 のような id が毎回別の id へ
  // 差し替えられる。`createdAt` も同じで、`Number(form.createdAt)` が空欄で 0 になると
  // 渡した日時が現在時刻に差し替わっていた（どちらも 2026-09-25 に直した）
  const isNew = !isGiven(record.id)
  if (isNew) record.id = newId()
  else checkId(record.id) // 渡された id は、保存する前に確かめる（NaN.json を作らせない）
  if (!isGiven(record.createdAt)) record.createdAt = new Date().toISOString()
  record[VERSION_KEY] = await nextVersion(collection, record, options ?? {}, isNew)
  const body = JSON.stringify(record)
  if (useCloud) await s3Put(keyOf(collection, record.id), body)
  else await localPut(collection, record.id, body)
  // **呼び出し側の写しにも、新しい版を書き戻す**（同じオブジェクトを続けて保存できるように）。
  // 書き戻すのは版だけ。id まで書き戻すと、同じ入れ物を使い回して**新しい1件を作る**
  // 書き方が、黙って「同じ1件の更新」に変わってしまう。
  if (data !== null && typeof data === 'object') {
    try { data[VERSION_KEY] = record[VERSION_KEY] } catch { /* 凍結されていても保存はできている */ }
  }
  return record
}

/** 1件読む。無ければ null。 */
export async function get(collection, id) {
  safeName(collection); safeName(id)
  const text = useCloud ? await s3Get(keyOf(collection, id)) : await localGet(collection, id)
  if (text == null) return null
  try { return JSON.parse(text) } catch { return null }
}

/**
 * 読み出す。**何も指定しなければ、今までどおり全部を新しい順に返します。**
 *
 * 指定できるもの（すべて任意）
 *   limit … 返す件数の上限     list('entries', { limit: 20 })
 *   skip  … 読み飛ばす件数     list('entries', { limit: 20, skip: 20 })
 *   where … 残すものだけ true を返す関数  list('entries', { where: r => r.name === '山田' })
 *   sort  … 並べ替えに使う項目名          list('entries', { sort: 'name' })
 *   order … 'asc'（小さい順）か 'desc'（大きい順）
 *
 * **limit と skip は、文字列で渡しても数として読みます。** URL のクエリ
 * （`?limit=20&skip=20`）も入力フォームも、数値は**必ず文字列で届く**ためです。
 * 数として読めないものを渡したときは、**黙って無かったことにせず、その場で断ります**
 * （黙って無視すると「次の20件」が1ページ目のまま動かず、しかもエラーが出ません）。
 * ただし **`Number(req.query.limit)` が作る `NaN` だけは「渡していない」と同じ扱い**に
 * します（クエリが無ければ必ず NaN になる形なので、ここで断ると、版の差し替えが届いた
 * 瞬間に、いま動いている一覧が例外で落ちます）。
 * **where は関数です。** `{ name: '山田' }` のようなオブジェクトを渡すと断ります
 * （黙って無視すると、絞り込みが効かないまま**全件が見えてしまう**）。
 * **order は 'asc' か 'desc' だけ、sort は項目名（文字列）だけを受けます。**
 * `?order=ASC` や `<select>` の値は**大文字で届くのが普通**で、黙って捨てていたころは
 * `{ order: 'ASC' }` が**頼んだのと逆の並び**で返っていました（エラーも出ません）。
 * limit / skip / where と同じく、受けられないものは断ります。
 *
 * **order は sort が無くても効きます。** sort を指定しないときは「保存した順」
 * （createdAt と id）で並べ、`order: 'desc'`（既定・**新しい順**）か
 * `order: 'asc'`（**古い順**）になります。sort を指定したときの既定は 'asc' です。
 * `{ order: 'asc' }` のように**古い順を頼んだときは全件を読みます**
 * （読む前に選べるのは新しい側からだけなので、正しさを優先します）。
 *
 * **通信の回数が減るのは limit（と skip）を指定したときだけです。**
 * where と sort は**全部読んだあと**に効くので、**通信は1回も減りません**。
 * where か sort を指定すると、limit を付けていても全件を読みます。
 *
 * **skip は、読み飛ばす分も実際に読みに行きます。** 読みに行く回数は **skip ＋ limit** 件で、
 * `{ limit: 20, skip: 980 }` は 1,001回——**全部読むのと変わりません**（後ろのページほど遅い）。
 * 読み飛ばす分を読むのは、**読めるかが読んでみるまで分からない**ためです。id の並びだけで
 * 数えると、消された直後の件まで「読み飛ばした1件」に数えて**同じ件が2ページに出ます**。
 *
 * さらに limit で減らせるのは、**Koto が付けた id だけで揃っているとき**です。
 * 自分で決めた id が1件でも混ざっていると、読む前に選ぶと間違った件を返すため、
 * **正しさを優先して全件を読みます**（判定は canNarrowByKey にまとめてあります）。
 *
 * 読みに行く前に選んだ件が、その間に消えていた（あるいは中身が壊れていた）ときは、
 * **その先から読み足して件数を揃えます**（頼んだ件数より少なく返さないため）。
 *
 * 何も指定しないときは「1件につき1回」読みに行くので、件数にそのまま比例して
 * 遅くなります（1,000件なら1回の一覧で1,001回の通信）。
 */
export async function list(collection, options = {}) {
  safeName(collection)
  const given = options ?? {}
  // **受け取った指定は、ここで全部確かめて、確かめたあとの形に揃える**（掟10）。
  // limit / skip / where だけを断って order / sort を黙って捨てていたので、
  // `{ order: 'ASC' }` が**頼んだのと逆の並び**で返っていた（2026-09-25 に揃えた）。
  // 以降はこの `opts` だけを使う——**数に直したあとの limit / skip を渡さないと、
  // '20' のままでは速い道に入れない**。
  const opts = {
    ...given,
    limit: toCount('limit', given.limit, null),
    skip: toCount('skip', given.skip, 0),
    where: checkWhere(given.where),
    sort: checkSort(given.sort),
    order: checkOrder(given.order),
  }
  const limit = opts.limit
  const skip = opts.skip
  const ids = useCloud ? await s3ListIds(collection) : await localListIds(collection)

  // 読みに行く前に選べるのは、限られたときだけ（判定は1か所にまとめてある）。
  if (canNarrowByKey(opts, ids)) {
    // id は「時刻＋連番＋乱数」なので、並べ替えて逆さにすれば新しい順になる
    const ordered = [...ids].sort().reverse()
    const out = []
    let cursor = 0
    // **読み飛ばす分も「読めた件」で数える。** id の並びで数えると、消された直後の件・
    // 中身が壊れた件まで「読み飛ばした1件」に数えてしまい、**同じ件が2ページに重なって
    // 出る**（遅い道は読めた件だけを数えるので、道によって答えが違っていた。2026-09-25）。
    // そのぶん読みに行く回数は増えるが、**読んでみるまで読めるかは分からない**。
    let left = skip
    // 消えていた件・壊れていた件があったら、**その先から読み足して件数を揃える**
    while (out.length < limit && cursor < ordered.length) {
      const want = Math.min(left + limit - out.length, READ_CHUNK)
      const chunk = ordered.slice(cursor, cursor + want)
      cursor += chunk.length
      for (const r of await readMany(collection, chunk)) {
        if (!r) continue                       // 読めなかった件は、どちらにも数えない
        if (left > 0) { left -= 1; continue }  // 読み飛ばす分
        out.push(r)
      }
      // 間隔は**公開先の毎秒の上限**のためなので、手元のフォルダでは置かない（2026-09-24）
      if (useCloud && out.length < limit && cursor < ordered.length) await sleep(CHUNK_PAUSE_MS)
    }
    out.sort(compareRecords(opts))
    return out
  }

  const out = []
  // 一度に全部投げるとサーバに負荷がかかるので、少しずつ読む
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    // 毎秒の上限に当たりにくくする。**手元のフォルダには上限が無いので待たない**（2026-09-24。
    // 待つと「② 試す」が件数に比例して遅くなるだけで、何も守っていない）
    if (i > 0 && useCloud) await sleep(CHUNK_PAUSE_MS)
    for (const r of await readMany(collection, ids.slice(i, i + READ_CHUNK))) if (r) out.push(r)
  }

  const kept = typeof opts.where === 'function' ? out.filter(r => opts.where(r)) : out
  kept.sort(compareRecords(opts))
  return limit === null ? kept.slice(skip) : kept.slice(skip, skip + limit)
}

/** 何件かをまとめて読む（塊の大きさは READ_CHUNK）。 */
function readMany(collection, ids) {
  return Promise.all(ids.map(id => get(collection, id)))
}

/** 1件消す。 */
export async function remove(collection, id) {
  safeName(collection); safeName(id)
  if (useCloud) await s3Delete(keyOf(collection, id))
  else await localDelete(collection, id)
}

// ── ここから下は Koto の担当です（読まなくて構いません） ────────────────

/** 一度にまとめて読みに行く件数。**多すぎると毎秒の上限（1バケット100アクセス）に当たる。** */
const READ_CHUNK = 20
/** 塊と塊の間に置く間隔。20件 ÷ 200ミリ秒＝毎秒100件で、上限を超えにくくする。 */
const CHUNK_PAUSE_MS = 200

/** id の先頭に置く「時刻」の桁数。**桁を揃えないと、並べても順番にならない。** */
const ID_TIME_DIGITS = 10
/** 時刻のうしろに置く「同じミリ秒の中での連番」の桁数（16進）。 */
const ID_SEQ_DIGITS = 4

/** 直前に id を作ったミリ秒と、そのミリ秒の中での連番。 */
let idLastStamp = ''
let idSeq = 0

/**
 * 新しい id を作る。**「時刻＋連番＋乱数」で、並べ替えると保存した順になる形にする。**
 *
 * 以前は乱数（UUID）だけだったので、鍵を並べても保存した順にならず、
 * 「新しい20件」を出すのに**全件を読むしかなかった**。先頭に時刻を
 * **桁を揃えて**置くと、読みに行く前に新しいものを選べる。
 *
 * **時刻だけでは足りない。** 同じミリ秒に何件も保存されると（一括登録・取り込み・
 * 同時に届いた送信）、そこから先の並びを決めるのは乱数になり、**「新しい20件」が
 * 保存順にならないどころか、違う20件になる**。そこで時刻のうしろに
 * **同じミリ秒の中での連番**を置く。後ろの乱数は、**別のインスタンスが同じミリ秒・
 * 同じ連番で作っても重ならない**ようにするためのもの。
 * （連番はインスタンスごとに数えるので、**別インスタンスどうしの前後までは揃わない**。
 * 冒頭にそう書いてある。）
 * 使う文字は safeName が通すもの（英数字と `_` `-`）だけにしてある。
 */
function newId() {
  const stamp = Date.now().toString(36).padStart(ID_TIME_DIGITS, '0')
  if (stamp === idLastStamp) idSeq = (idSeq + 1) & 0xffff
  else { idLastStamp = stamp; idSeq = 0 }
  const seq = idSeq.toString(16).padStart(ID_SEQ_DIGITS, '0')
  return `${stamp}-${seq}${crypto.randomBytes(6).toString('hex')}`
}

/**
 * その id が「Koto が付けた、並べれば保存順になる id」か（純関数）。
 * 古い形（乱数だけ）や、アプリが自分で決めた id（`dates` など）は false。
 */
function isSortableId(id) {
  return /^[0-9a-z]{10}-[0-9a-f]{16}$/.test(String(id ?? ''))
}

/**
 * 「読みに行く前に、id だけで絞ってよいか」（純関数・掟10で1か所にまとめてある）。
 *
 * true になるのは **limit があり、where も sort も無く、古い順を頼まれてもおらず、
 * 全部の id が並べれば保存順になる形**のときだけ。1件でも違う形が混ざっていたら false
 * （並び順が狂って**間違った件**を返すため。速さより正しさを優先する）。
 *
 * `order: 'asc'`（古い順）も false にする。読む前に選べるのは**新しい側から**だけで、
 * 古い側の20件を先に選ぶと、`skip` の数え方まで食い違うため。
 *
 * **渡す limit / skip / sort / order は、list() が確かめたあとのもの。** `'20'` のまま
 * 渡すとここで false になり、読む前に選べるはずの一覧が全件読みへ落ちる。
 * **受け取ってよい値かどうかを決めるのは list() の入口だけ**（toCount / checkWhere /
 * checkSort / checkOrder）。ここでは「どの道を通るか」しか決めない——判定を2か所に
 * 置くと、片方だけ直されて**道によって答えが違う**ことになる（掟10）。
 */
function canNarrowByKey(options, ids) {
  const o = options ?? {}
  if (!Number.isFinite(o.limit)) return false
  if (typeof o.where === 'function') return false
  if (typeof o.sort === 'string' && o.sort !== '') return false
  if (o.order === 'asc') return false
  return (ids ?? []).every(id => isSortableId(id))
}

/**
 * 並べ替えのしかたを決める（既定は今までどおり「新しい順」）。
 *
 * sort が無いときは createdAt で並べ、**同じ createdAt のときは id で決着を付ける**。
 * 決着を付けないと、同じ時刻の件が「読んだ順」（保存場所が返した順）のまま残り、
 * **limit を付けたときと付けないときで逆の順番**になる（実際にそうなっていた）。
 * order は sort が無くても効く: 'asc' なら古い順。
 *
 * **ここへ来る sort / order は、list() の入口で確かめたあとのもの**（`'ASC'` のような
 * 受け取れない値は、そこで断られている）。**受け取ってよいかを、ここでもう一度
 * 決めない**——2か所で決めると、片方だけ直されて黙って食い違う（掟10）。
 */
function compareRecords(options) {
  const o = options ?? {}
  const field = typeof o.sort === 'string' && o.sort !== '' ? o.sort : null
  if (field === null) {
    const sign = o.order === 'asc' ? -1 : 1 // 既定は新しい順（desc）
    return (a, b) => sign * (compareValues(b?.createdAt, a?.createdAt) || compareValues(b?.id, a?.id))
  }
  const sign = o.order === 'desc' ? -1 : 1 // sort を指定したときの既定は asc
  return (a, b) => sign * compareValues(a?.[field], b?.[field])
}

/**
 * 2つの値を比べる。**両方が数として読めるときは、数として比べる。**
 *
 * 入力フォームから保存すると数値は文字列になる（`new FormData()` も `<input>` も）。
 * 型が混ざったまま文字で比べると `"10" < "2" < 9` のような並びになり、
 * 価格順・点数順が黙って狂う。
 */
function compareValues(a, b) {
  const na = toNumber(a)
  const nb = toNumber(b)
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0
  return String(a ?? '').localeCompare(String(b ?? ''))
}

/** 数として読めれば数に直す。読めなければ null（空文字・真偽値・日付文字列は null）。 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * 「渡された」かどうか（純関数・**判定はここ1か所**・掟10）。
 *
 * **偽値で見分けない。** `!v` だと `0` と空文字も「無い」になる。id では
 * 日曜＝0・0時＝0 が毎回新しい id へ差し替えられ、createdAt では
 * `Number(form.createdAt)`（空欄なら `0`）が現在時刻へ差し替えられていた。
 * どちらもエラーは出ない。**2つ並んで同じ間違いをしていたので、1つにまとめた**（2026-09-25）。
 */
function isGiven(value) {
  return value !== undefined && value !== null && value !== ''
}

/**
 * 断るときに、渡された値を見せる。**`JSON.stringify` を直接使わない。**
 *
 * `JSON.stringify(NaN)` も `JSON.stringify(Infinity)` も `"null"` になる。ところが
 * `null` は「渡していない」として**受け入れる**値なので、『数を指定してください: null』
 * と出ると、読んだ人は何を直せばよいのか分からない（2026-09-25）。
 */
function showValue(value) {
  if (typeof value === 'number') return String(value) // NaN・Infinity をそのまま見せる
  try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
}

/**
 * 件数の指定（limit・skip）を数に直す。**黙って無かったことにしない**（safeName と同じ方針）。
 *
 * URL のクエリ（`?limit=20`）も入力フォームも、**数値は必ず文字列で届く**。
 * 文字列を無視していたので、`list('entries', { limit: req.query.limit })` と書いた
 * 一覧の「次の20件」が**1ページ目のまま動かず、エラーも出なかった**（2026-09-25 に直した）。
 * 渡していないとき（`undefined` ・ `null` ・ 空文字）だけ、今までどおりの既定にする。
 *
 * **数としての `NaN` も「渡していない」に倒す。** `list('entries', { limit: Number(req.query.limit) })`
 * は、クエリが無ければ**必ず** `NaN` になる。ここで断ると、版の印を上げた自動差し替えが
 * 届いた瞬間に、**いま動いている公開済みアプリの一覧が例外で落ちる**（2026-09-25）。
 * 文字列の `'たくさん'` や `{}` ・ `true` は、これまでどおり断る。
 */
function toCount(name, value, fallback) {
  if (!isGiven(value)) return fallback
  if (typeof value === 'number' && Number.isNaN(value)) return fallback
  const n = toNumber(value)
  if (n === null) {
    throw new Error(`list の ${name} には数を指定してください: ${showValue(value)}`)
  }
  return Math.max(0, Math.floor(n))
}

/**
 * 絞り込み（where）が関数であることを確かめる。**関数でなければ断る。**
 *
 * `{ where: { name: '山田' } }` を黙って無視すると、絞り込みが効かないまま
 * **全件が返る**。「自分の投稿だけ」のつもりの一覧に、全員の投稿が出る。
 */
function checkWhere(where) {
  if (where === undefined || where === null) return undefined
  if (typeof where !== 'function') {
    throw new Error("list の where には関数を指定してください"
      + "（例: { where: r => r.name === '山田' }）。関数以外では絞り込めません。")
  }
  return where
}

/**
 * 並べ替えに使う項目名（sort）を確かめる。**文字列でなければ断る。**
 *
 * limit / skip / where と**同じ入口で、同じ方針**にする。ここだけ黙って捨てていたので、
 * `{ sort: 123 }` が無かったことになり、**並べ替えが効かないまま新しい順で返っていた**
 * （2026-09-25 に揃えた）。渡していないとき（undefined・null・空文字）は今までどおり。
 */
function checkSort(sort) {
  if (!isGiven(sort)) return undefined
  if (typeof sort !== 'string') {
    throw new Error(`list の sort には並べ替えに使う項目名（文字列）を指定してください: ${showValue(sort)}`)
  }
  return sort
}

/**
 * 並び（order）を確かめる。**'asc' か 'desc' 以外は断る。**
 *
 * URL のクエリ（`?order=ASC`）も `<select>` の値も、**大文字で届くのがごく普通**。
 * 黙って捨てていたので `{ order: 'ASC' }` は**頼んだのと逆の並び**（新しい順）で返り、
 * `{ sort: 'name', order: 'DESC' }` も逆になっていた。しかもエラーは出ない——
 * limit を黙って捨てていたとき（「次の20件」が1ページ目のまま）と**同じ形**（2026-09-25）。
 */
function checkOrder(order) {
  if (!isGiven(order)) return undefined
  if (order !== 'asc' && order !== 'desc') {
    throw new Error(`list の order には 'asc' か 'desc' を指定してください: ${showValue(order)}`
      + '（大文字の ASC / DESC は受け取れません）。')
  }
  return order
}

/**
 * 渡された id が、1件のファイルの名前にできる形かを確かめる（**保存する前に**）。
 *
 * `id: NaN` は `String(NaN)` が `'NaN'` になるので safeName を通ってしまい、
 * `id: Number(params.id)` でパラメータが数でないとき、**そのコレクションの全員が
 * NaN.json を上書きし合う**（しかも JSON にすると id は `null` になり、一覧に
 * id が null の件が混ざる）。真偽値も同じで `false.json` に入る。
 * **数か文字列以外は、その場で断る**（2026-09-25）。`0` は今までどおり通る。
 */
function checkId(id) {
  if (typeof id === 'number' && !Number.isFinite(id)) {
    throw new Error(`id には数として読める値を指定してください: ${showValue(id)}`)
  }
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new Error(`id には数か文字列を指定してください: ${showValue(id)}`)
  }
  return safeName(id)
}

/**
 * Koto が版を書き込む項目の名前。**アプリのデータとぶつからない名前にしてある。**
 *
 * 2026-09-24 までは `version` に書いていた。だが `version` は仕様書の版・見積書の版・
 * スキーマの版と、**アプリがごく普通に使う名前**である。アプリが入れた `'1.0'` は
 * 黙って `2` に潰され、読み直して版を上げて保存すると**永久に断られた**
 * （`get()` で読み直せと案内するが、アプリがまた自分の版を入れるので終わらない）。
 * **名前を分ければ、どちらも壊れない。**
 */
const VERSION_KEY = '_kotoVersion'

/** 2026-09-24 以前に保存された1件は、Koto の版がここに入っている（**読むときだけ**見る）。 */
const LEGACY_VERSION_KEY = 'version'

/**
 * いま保存されている1件の版を読む。**古いレコードを断らないために、両方を受ける。**
 *
 * 2026-09-24 以前に保存された1件は `version` に版が入っている。そこを見ないと版が
 * 1 から数え直しになり、**ずっと前に読んだ古い写しの版とたまたま一致して、断るべき
 * 上書きが黙って通る**。読むだけで、書き戻しはしない——`version` はもうアプリのもの
 * なので、Koto から触らない。
 */
function storedVersion(current) {
  const v = toNumber(current[VERSION_KEY])
  return v !== null ? v : toNumber(current[LEGACY_VERSION_KEY])
}

/**
 * 保存する版を決める。違っていたら**断る**（黙って消さないため）。
 * 保存されている側に版が無ければ断らない——既に動いているアプリを止めないため。
 *
 * ── 版は必ず「いま保存されている版」から作る ──────────────────────────
 * 渡された版から作ると、**版が小さいほうへ巻き戻る**。巻き戻ると、
 * ずっと前に読んだ古い写しの版とたまたま一致し、**断るべき上書きが黙って通る**
 * （この仕組みが防ぎたかった事故そのもの）。だから overwrite のときも、
 * 渡されたデータに版が無いときも、**保存されている側を1回読んでから決める**。
 *
 * 例外は「新しく作る1件」（`id` を渡さなかったとき）だけ。まだ何も保存されていない
 * ことが分かっているので、読みに行かない（**保存のたびに通信が倍にならないように**）。
 */
async function nextVersion(collection, record, options, isNew = false) {
  const given = toNumber(record[VERSION_KEY])
  if (isNew) return (given ?? 0) + 1
  const current = await get(collection, record.id)
  const stored = current ? storedVersion(current) : null
  const base = Math.max(stored ?? 0, given ?? 0)
  if (options.overwrite === true || given === null || stored === null) return base + 1
  if (stored !== given) throw new Error(conflictMessage(collection, record.id, given, stored))
  return base + 1
}

/** 断るときの言葉。**何をすればよいかまで書く。** */
function conflictMessage(collection, id, given, stored) {
  return `このデータは、読み込んだあとに別のところで書き換えられました（${collection} の ${id}。`
    + `読んだときは ${given} 回目、いま保存されているのは ${stored} 回目の変更です）。`
    + 'そのまま保存すると、あとから行われた変更が消えてしまうため、保存を中止しました。'
    + 'get() でもう一度読み直し、変更をやり直してから保存してください。'
    + '（読み直さずに上書きしてよいときは、save(コレクション名, データ, { overwrite: true }) を使います）'
}

/**
 * 名前を検査する。**黙って書き換えず、おかしければ断る。**
 *
 * `../../etc` のような名前を黙って `etc` に直すと、**別の場所へ書いてしまい**、
 * しかもアプリからは成功したように見える。呼び出し側の間違いは、その場で気づける
 * ようにする（`/` や `..` を許すと保存先の外へ出る恐れもある）。
 */
function safeName(s) {
  const v = String(s ?? '')
  if (!/^[A-Za-z0-9_-]+$/.test(v)) {
    throw new Error(`保存先の名前に使えるのは英数字と _ - だけです: ${showValue(s)}`)
  }
  return v
}

function keyOf(collection, id) {
  return `${PREFIX}${safeName(collection)}/${safeName(id)}.json`
}

// ── 手元のフォルダ（試すとき） ────────────────────────────────────────

function localPath(collection, id) {
  return path.join(LOCAL_DIR, safeName(collection), `${safeName(id)}.json`)
}

async function localPut(collection, id, body) {
  const p = localPath(collection, id)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, body, 'utf8')
}

async function localGet(collection, id) {
  // 「無い」と「名前がおかしい」を区別するため、名前の検査は入口（get）で済ませてある。
  // ここで捕まえるのは「ファイルが無い」だけ
  try { return await fs.readFile(localPath(collection, id), 'utf8') } catch { return null }
}

async function localListIds(collection) {
  try {
    const names = await fs.readdir(path.join(LOCAL_DIR, safeName(collection)))
    return names.filter(n => n.endsWith('.json')).map(n => n.slice(0, -5))
  } catch { return [] }
}

async function localDelete(collection, id) {
  try { await fs.unlink(localPath(collection, id)) } catch { /* 無ければ何もしない */ }
}

// ── さくらのオブジェクトストレージ（公開したとき） ──────────────────────

// ── 混み合っているときは、少し待ってやり直す ──────────────────────────
// さくらのオブジェクトストレージは**1バケットあたり毎秒100アクセス**までで、
// 超えると 429 が返る。list() は件数だけ読みに行くので、件数が増えるとすぐ届く。
// **1件でも失敗すると一覧が丸ごと出せなくなる**（画面が真っ白になる）ため、
// **429 と 503 のときだけ**少し待ってやり直す。
// **待ち時間にはばらつきを付ける**（base〜base×2）。付けないと、まとめて読みに行った
// 20件が**同じ時刻に一斉にやり直す**ので、混んでいる状況へそのまま突っ込むことになる。
// あわせて、塊と塊の間に CHUNK_PAUSE_MS だけ間隔を置いて、毎秒の上限を超えにくくしている。
// 404 は今までどおり（get は null・remove は何もしない）。**それ以外の失敗は
// やり直さずに、そのまま伝える**（鍵の間違いを何度も投げても直らない）。
const RETRY_STATUSES = [429, 503]
const RETRY_WAITS_MS = [200, 400, 800] // 少しずつ伸ばす。最大でこの回数だけやり直す
const RETRY_AFTER_MAX_MS = 10000 // サーバが長すぎる待ち時間を言ってきたときの上限

async function s3WithRetry(method, key, body, extraHeaders = {}, query = '') {
  let r = await s3(method, key, body, extraHeaders, query)
  for (let attempt = 0; attempt < RETRY_WAITS_MS.length; attempt++) {
    if (!RETRY_STATUSES.includes(r.status)) return r
    await sleep(retryWaitMs(r.retryAfter, attempt))
    r = await s3(method, key, body, extraHeaders, query)
  }
  return r
}

/**
 * 次に待つ時間。**サーバが Retry-After を返していれば、それに従う。**
 *
 * **待ち時間にはばらつきを足す**（base 〜 base×2 の間）。list() は20件ずつ
 * まとめて読みに行くので、ばらつきが無いと 429 を受けた20件が**また同じ時刻に
 * 一斉に突入**し、混雑がほどけない。
 */
function retryWaitMs(retryAfter, attempt) {
  const base = RETRY_WAITS_MS[attempt]
  const waited = base + Math.floor(Math.random() * base)
  const asked = parseRetryAfter(retryAfter)
  if (asked === null) return waited
  return Math.min(Math.max(asked, waited), RETRY_AFTER_MAX_MS)
}

/** `Retry-After`（秒数、または日時）をミリ秒に直す。付いていなければ null。 */
function parseRetryAfter(value) {
  const v = String(value ?? '').trim()
  if (v === '') return null
  if (/^\d+$/.test(v)) return Number(v) * 1000
  const at = Date.parse(v)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - Date.now())
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * うまくいかなかったときの言葉。**番号だけでは、何をすればよいか分からない。**
 * `action` には「保存」「読み込み」「削除」「一覧の取得」が入る。
 */
function failureMessage(action, status) {
  if (status === 429) {
    return `${action}ができませんでした。保存場所への読み書きが立て込んでいます（${status}）。`
      + '何度か待ってやり直しましたが、混み合ったままでした。少し時間をおいて、もう一度お試しください。'
      + 'たびたび起きるときは、一度に扱う件数を減らすか、Koto に相談してください。'
  }
  if (status === 503) {
    return `${action}ができませんでした。保存場所がいま応答していません（${status}）。`
      + '何度か待ってやり直しましたが、戻りませんでした。少し時間をおいて、もう一度お試しください。'
  }
  if (status === 401 || status === 403) {
    return `${action}が許可されませんでした（${status}）。保存場所の設定が正しくない可能性があります。`
      + 'Koto の「③ 公開」から保存場所を用意し直すか、Koto に相談してください。'
  }
  return `${action}ができませんでした（${status}）。時間をおいても直らないときは、`
    + `この番号（${status}）を添えて Koto に相談してください。`
}

async function s3Put(key, body) {
  const r = await s3WithRetry('PUT', key, body, { 'content-type': 'application/json' })
  if (!r.ok) throw new Error(failureMessage('保存', r.status))
}

async function s3Get(key) {
  const r = await s3WithRetry('GET', key)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(failureMessage('読み込み', r.status))
  return r.text
}

async function s3Delete(key) {
  const r = await s3WithRetry('DELETE', key)
  if (!r.ok && r.status !== 204 && r.status !== 404) throw new Error(failureMessage('削除', r.status))
}

async function s3ListIds(collection) {
  const prefix = `${PREFIX}${safeName(collection)}/`
  const ids = []
  let token = null
  for (let page = 0; page < 1000; page++) {
    // **SigV4 は「名前で並べた」クエリを要求する。** URLSearchParams は並べ替えないので、
    // continuation-token が付く2ページ目以降で署名が合わなくなる（403）。
    // 1ページ目はたまたま辞書順に並ぶため、少ないデータでは表に出ない（2026-08-14）。
    const params = { 'list-type': '2', 'max-keys': '1000', prefix }
    if (token) params['continuation-token'] = token
    const r = await s3WithRetry('GET', '', undefined, {}, canonicalQuery(params))
    if (!r.ok) throw new Error(failureMessage('一覧の取得', r.status))
    for (const m of r.text.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
      const key = decodeEntities(m[1])
      if (key.startsWith(prefix) && key.endsWith('.json')) ids.push(key.slice(prefix.length, -5))
    }
    if (!/<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(r.text)) break
    const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(r.text)
    if (!next) break
    token = decodeEntities(next[1])
  }
  return ids
}

/**
 * SigV4 が要求する形のクエリ文字列にする（名前で辞書順・RFC3986・空値も `=`）。
 *
 * `URLSearchParams.toString()` は**並べ替えない**ので、そのまま署名に使うと
 * 署名が合わず 403 になる。しかも 403 は「鍵が悪い」のか「署名が違う」のか
 * 区別がつかないので、原因に辿り着けない。
 */
function canonicalQuery(params) {
  const enc = v => encodeURIComponent(String(v ?? '')).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return Object.entries(params)
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

function decodeEntities(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

async function s3(method, key, body, extraHeaders = {}, query = '') {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const payload = body ?? ''
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex')
  const canonicalUri = '/' + [BUCKET, key].filter(Boolean).join('/')
  const headers = { host: ENDPOINT, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extraHeaders }
  const authorization = sign({ method, canonicalUri, query, headers, payloadHash, amzDate })
  const res = await fetch(`https://${ENDPOINT}${canonicalUri}${query ? '?' + query : ''}`, {
    method,
    headers: { ...headers, Authorization: authorization },
    ...(body !== undefined ? { body } : {}),
  })
  return { ok: res.ok, status: res.status, retryAfter: headerOf(res, 'retry-after'), text: await res.text() }
}

/** 応答のヘッダを1つ読む。**あるかどうかを決めつけない**（無ければ null）。 */
function headerOf(res, name) {
  try {
    return res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null
  } catch { return null }
}

/**
 * AWS Signature Version 4。
 * ※ Koto 本体（src/shared/sigv4.ts）と同じ計算をします。
 *   食い違うと 403 しか返らず原因が分からなくなるため、Koto 側のテストで
 *   両方が同じ署名を出すことを確かめています（tests/kotoDataTemplate.test.ts）。
 */
function sign({ method, canonicalUri, query, headers, payloadHash, amzDate }) {
  const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest()
  const dateStamp = amzDate.slice(0, 8)
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim()
  const names = Object.keys(lower).sort()
  const canonicalHeaders = names.map(k => `${k}:${lower[k]}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
  const kDate = hmac('AWS4' + SECRET_KEY, dateStamp)
  const signature = hmac(hmac(hmac(hmac(kDate, REGION), 's3'), 'aws4_request'), stringToSign).toString('hex')
  return `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}
