// publishVerify.ts — 「公開が本当に反映されたか」を確かめる（純ロジック）。
//
// ── なぜ要るか（2026-08-19 実機・Ryosuke 報告）──────────────────────────
// 「試すだと画像が表示されるが、公開すると画像が表示されていない」
//
// 公開は「✅ 完了」と出ていた。実際には**画像を入れる前の古いページ**が
// 配られ続けていた（毎回同じ `:latest` を渡していたため）。タグは直したが、
// **誰も確かめていなかったこと自体**が本当の問題である。
//
//   ・デプロイのAPIが 200 を返したこと … 反映された証拠にならない
//   ・アプリが動いていること（起動確認）… 中身が新しい証拠にならない
//
// そこで、配る中身に**版の名前を書いた目印**を1つ混ぜ、公開のあとに
// その目印を読みに行く。一致したら反映済み、しなければ**正直にそう言う**。
//
// ── 対象（2026-08-19 時点）────────────────────────────────────────────
// 静的配信（ファイルをそのまま配る）だけ。Node で動かすアプリは自分で経路を
// 決めるので、目印のファイルが読めるとは限らない（**読めないことを失敗と
// 呼ばない**ため、はじめから確認の対象にしない）。
//
// ── D-19（2026-09-16）: 専有型の⑧だけは、Node でも確かめる ─────────────
// 上の「静的配信だけ」は**共用型（cloud.ts の verifyPublished）の話**である。
// 専有型の⑧（下半分）は、2026-09-16 の事故——**アプリが動いていないのに
// 「✅ 公開しました」と出した**——の当事者であり、そのアプリは Node だった。
// ところが確認は `canVerify`（＝静的配信だけ）に縛られていて、**守りたかった
// 場面をまるごととばしていた**。そこで専有型は確認を2段階に分ける:
//   ・静的配信       … 版の目印 `.koto-build` を取りに行き、**中身が新しいか**まで見る
//   ・それ以外（Node）… 目印は使えない（アプリが何を配るかはアプリ次第）ので、
//                       **根（`/`）へ問い合わせて、応答があるか**だけを見る
// 後者は `ok` とは呼ばない（中身が新しいかは確かめていない）。`responding` という
// 別の結果にして、**確かめたことと確かめていないことを言い分ける**。

/** 配る中身に混ぜる目印のファイル名。 */
export const MARKER_FILE = '.koto-build'

/** 目印の中身（版の名前だけを書く）。 */
export function markerContent(tag: string): string {
  return `${tag}\n`
}

/** 読み取った中身が、その版のものか（純関数・前後の空白は無視）。 */
export function matchesMarker(body: string | null | undefined, tag: string): boolean {
  return String(body ?? '').trim() === String(tag ?? '').trim() && String(tag ?? '').trim() !== ''
}

/** 確認しに行く先（純関数）。 */
export function markerUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/${MARKER_FILE}`
}

/**
 * 確認できる公開か（純関数）。**共用型（cloud.ts の verifyPublished）の入口。**
 *
 * **できない場合を「失敗」と言わない。** 確認しないだけ。
 *
 * D-19: 専有型の⑧はこれを使わない（Node でも根へ当てて応答を確かめるため）。
 * 専有型の入口は下の `dedicatedVerifyMode`。
 */
export function canVerify(runtime: string, publicUrl: string | null | undefined): boolean {
  return runtime === 'static' && /^https?:\/\//.test(String(publicUrl ?? ''))
}

/**
 * 待ち時間（ミリ秒）。合計およそ90秒まで。
 *
 * 反映には時間がかかる（新しいイメージを取りに行って、入れ替わるまで）。
 * **短く諦めない**。ただし待たせすぎない。
 */
export function verifyDelaysMs(): number[] {
  return [2000, 3000, 5000, 8000, 12000, 20000, 20000, 20000]
}

/**
 * 確認の結果。
 *
 * A（2026-09-16 の検分）で `no-backend`・`error-status` を足した。直す前は 503・502・500 の
 * ような**エラー応答**まで `unreachable`（「接続できなかった」）に倒していた。**接続は
 * 成立していて、エラーが返っている**のに「接続できなかった」と書いており、観測していない
 * ことを書いていた（掟1）。専有型（`DedicatedVerifyOutcome`）と同じ物差し（`probeStatusKind`）
 * に揃えたが、**404 だけは例外**（下の `judgeVerifyProbe` を見よ）。
 */
export type VerifyOutcome = 'ok' | 'stale' | 'no-backend' | 'error-status' | 'unreachable'

// B（D-7b・検分の指摘）: この先の画面に出す一言は、素の `<p>` にそのまま流れる
// （AppRunDedicatedPanel.tsx は文言を Markdown として解釈しない）。Markdown の `**` を混ぜると、
// 太字にならず記号がそのまま画面に出てしまう欠陥だった。強調は文字列の中で記号を組み立てず、
// **画面側が既に持っている手段**（先頭の絵文字 ⚠️/❌/✅/ℹ️・呼び出し側の Tailwind クラスによる
// 色分け）に任せる——この画面はもともと強調を `<strong>` に分けて描く作りではないため、
// 一部の文だけ `<strong>` 用に分割するより、既存の書き方（絵文字＋文の組み立て）に合わせた。

/**
 * 画面に出す一言（純関数）。**分からないときは分からないと言う。**
 *
 * ── A（2026-09-16 の検分）: 503・502・500 を「接続できなかった」に倒さない ──────────
 * 直す前は 503・502・500 も `unreachable`（「公開先に接続できなかったため…」）に倒していた。
 * **接続は成立していて、エラーが返っている**のに「接続できなかった」と書いており、
 * 観測していないことを書いていた（掟1）。`no-backend`（503）・`error-status`（400以上の
 * それ以外）を分け、**観測したことだけ**を書く。共用型のロードバランサの 503 が何を
 * 意味するかは実機で確かめていないため、専有型（Traefik）の断定はここへ流用しない——
 * 「アプリがまだ応答していない可能性があります」までに留める。
 *
 * `status` は `error-status` のときだけ使う（届いた番号を添える。番号を出すときは
 * 日本語の説明を必ず添える）。
 */
export function verifyMessage(outcome: VerifyOutcome, status?: number): string {
  switch (outcome) {
    case 'ok':
      return '✅ 新しい内容が公開されたことを確認しました'
    case 'stale':
      return '⚠️ 公開は完了しましたが、まだ古い内容が表示されています。'
        + '数分待ってから公開先を再読み込みしてください。変わらなければ、もう一度【③ 公開】をお試しください。'
    case 'no-backend':
      return '⚠️ 公開先が 503 を返しています。アプリがまだ応答していない可能性があります。'
        + 'さくらのコントロールパネルでログをご確認ください。'
    case 'error-status':
      return `⚠️ 公開先がエラーを返しました${status ? `（HTTP ${status}）` : ''}。`
        + 'ページが開けるかをご自身でも確かめてください。'
    case 'unreachable':
      return 'ℹ️ 公開先に接続できなかったため、内容が新しくなったかは確認できませんでした（公開そのものは完了しています）。'
  }
}

// ── 専有型（AppRun 専有型）の⑧ ─────────────────────────────────────────
//
// **2026-09-16 実機（0.6.19-rc.1・Ryosuke さん）**: ⑧でアプリを公開し、Koto は
// 「✅ 公開しました」と出した。だが**観測できたのは、ロードバランサが 503 `no available server`
// を返し続けたことだけ**——LB から見て健全なバックエンドが1つも登録されていなかった。
// **コンテナ自体が起動していたかは、いまも未確認**（同じ日のコンパネは「稼働コンテナ 1・アクティブ」と
// 表示していた。食い違いの理由も切り分けていない＝docs/apprun-dedicated-plan.md 5-13）。
// **同じ日の別の時刻（10:34〜10:57）のランタイムログ（D-8）で説明はつく**: コンテナは
// `/app/data` を作れず（`EACCES`）1分ごとに再起動を繰り返していた（像のフォルダが読み取り専用
// だったのが原因・imageBuild.ts の copyTree）。**ただし 503 の観測は 08:35 前後で、
// 時刻の突き合わせはしていないので断定はしない**（計画書 5-13・roadmap・publishLabels.ts と同じ基準・掟1。
// ここは検分の指摘・2026-09-16 まで、時刻の違うログで「判明した」と答える形が残っていた）。
// いずれにせよ利用者から見ればアプリは応答しておらず、「公開できた」と信じて DNS を
// 設定しに行くことになる。**確かめていないことを「大丈夫」に倒していた**（`unknown-read-as-ok`）。
//
// 共用型（`cloud:apply`）には「🩺 アプリが動いているか確かめています…」の段が
// あったのに、専有型の⑧には無かった。D-7 でその段を足し、判断はここに置く。
//
// 上の `VerifyOutcome`（共用型）と分けているのは、専有型には
// **`no-backend`（届いてはいるが、後ろに健全なコンテナがいない＝503）**という、
// 共用型には無い・利用者が次に取る行動（ランタイムログを見る）が違う結果があるため。

/**
 * 専有型の確認の結果。
 *
 * D-19 で `responding` を足した。**`ok` と `responding` の違いは「中身の新しさまで確かめたか」**:
 *   ・`ok`         … 版の目印が一致した＝**いま公開した版が配られている**（静的配信だけ）
 *   ・`responding` … 根（`/`）に問い合わせて応答があった＝**動いてはいる**。
 *                    中身が新しいかは**確かめていない**（Node アプリは目印を配るとは限らない）
 * 混ぜると「確かめていないことを大丈夫に倒す」に戻るので、**名前ごと分けてある**。
 *
 * ── D-19b（2026-09-16 の検分）で `error-status` を足した ────────────────────────
 * 直す前の根（`/`）の判定は **503 以外の失敗応答（404・502・504）まで `responding` に倒して**
 * いた。画面には「✅ アプリが応答することを確認しました」が出て、しかも `responding` は
 * 取り直しを止めてよい結果なので、**1回目の 404/502 でループを打ち切っていた**。
 * だが専有型のロードバランサ（Traefik）は、**ホスト名の振り分けが効かないと
 * `404 page not found` を返す**（2026-09-16 実機・docs/apprun-dedicated-plan.md の
 * 「IP を直接開くと 404 になる」）。利用者から見れば**ページは開けない**のに「✅」を出す——
 * 2026-09-16 の事故と同じ形である。そこで **400 以上の応答は `error-status`** とし、
 * 成功の見た目にしない・取り直しを止めない。
 */
export type DedicatedVerifyOutcome = 'ok' | 'stale' | 'responding' | 'error-status' | 'no-backend' | 'unreachable'

/** 画面に出す一言（純関数）。**分からないときは分からないと言う。** B: 上のコメントのとおり `**` は使わない。 */
export function dedicatedVerifyMessage(outcome: DedicatedVerifyOutcome): string {
  switch (outcome) {
    case 'ok':
      return '✅ アプリが応答することを確認しました'
    case 'responding':
      // D-19: 応答は確かめた。**中身が新しいかは確かめていない**ので、そこまで言い切らない。
      return '✅ アプリが応答することを確認しました（中身が新しいかまでは確かめていません）'
    case 'error-status':
      // D-19b（検分・2026-09-16）: 届いてはいるが、返ってきたのは**エラー**である。
      // 「応答することを確認しました」とは言わない。とはいえ「アプリが壊れている」とも断定できない
      // （API だけのアプリは `/` に 404 を返すのが正常）。**観測（エラーが返った）だけを書き、
      // 次に見る場所を並べる**。番号そのものは画面に渡していないので例として並べる（掟1）。
      return '⚠️ 公開先はエラーを返しました（404・502・504 など）。'
        + 'ロードバランサがホスト名をこのアプリへ振り分けられていないか、コンテナが入れ替わっている途中かもしれません。'
        + '数分待ってから公開先を開いて確かめ、変わらなければコントロールパネルの『アプリケーション → ランタイムログ』を見てください'
        + '（アプリが「/」にページを持たない作りであれば、404 でも不具合とは限りません）'
    case 'stale':
      return '⚠️ アプリは応答していますが、古い内容のままです。数分待ってから、もう一度⑧を押してください'
    case 'no-backend':
      return '❌ アプリがまだ応答していません（ロードバランサは 503 を返しています）。'
        + 'コンテナが起動できていない可能性があります。'
        + 'コントロールパネルの『アプリケーション → ランタイムログ』を見てください'
    case 'unreachable':
      return 'ℹ️ 応答を確かめられませんでした（公開の手続き自体は通っています）'
  }
}

/**
 * **いま公開した中身が配られていることまで確かめられたか**（純関数）。**`ok` だけが true。**
 *
 * ── D-19 で `responding` を足したときの判断（理由をここに残す）──────────────
 * `responding` は「応答はあった」だけで、**配られている中身が新しいかは確かめていない**。
 * この関数を将来だれかが `if (dedicatedVerifyOk(v)) 成功として扱う` と書いたとき、
 * `responding` を true にしておくと**確かめていないことを「大丈夫」に倒す**ことになる
 * （2026-09-16 の事故そのものの形＝`unknown-read-as-ok`）。false にしておけば、最悪でも
 * 「確かめられたのに控えめに扱う」側に外れるだけである。**安全側に倒すほうを採る。**
 * そのため名前と説明も「応答を確認できたか」から**「中身が新しいことまで確かめられたか」**へ
 * 言い直した（応答したかどうかは `verify` の値そのもの・`publishHeadline` が見ている）。
 */
export function dedicatedVerifyOk(outcome: DedicatedVerifyOutcome): boolean {
  return outcome === 'ok'
}

/**
 * 専有型の⑧で、**どうやって確かめるか**（純関数・D-19）。
 *
 * - `'marker'` … 版の目印 `.koto-build` を取りに行き、**中身が新しいか**まで見る。
 *                静的配信の像で、かつ**比べる版（buildTag）が分かっている**ときだけ。
 * - `'root'`   … 根（`/`）へ1回だけ問い合わせて、**応答があるか**だけを見る。
 *                Node などの像（目印を配るとは限らない）と、版が分からないときはこちら。
 *
 * **「確認をとばす」という選択肢はここには無い。** とばしてよいのは、当てに行く先が無い
 * （ホスト名が無い・IP が無い）ときだけで、それは呼び出し側（apprunDedicatedAppApply.ts）が
 * 判断する。ここで `null` を返せるようにすると、2026-09-16 の「Node だから確認しない」が
 * 別の名前で戻ってくる。
 */
export type DedicatedVerifyMode = 'marker' | 'root'

export function dedicatedVerifyMode(
  runtime: string | null | undefined, buildTag: string | null | undefined,
): DedicatedVerifyMode {
  return runtime === 'static' && String(buildTag ?? '').trim() !== '' ? 'marker' : 'root'
}

/**
 * 問い合わせ先のパス（純関数・D-19）。キャッシュに騙されないよう、毎回違う問い合わせにする
 * （`nonce` は呼び出し側が渡す `Date.now()`）。
 */
export function dedicatedProbePath(mode: DedicatedVerifyMode, nonce: number | string): string {
  return mode === 'marker' ? `/${MARKER_FILE}?t=${nonce}` : `/?t=${nonce}`
}

/**
 * 1回の問い合わせの結果（`node:https` の GET を、実装から切り離して受け取る形）。
 * `reached:false` は「接続できなかった」（名前が引けない・つながらない・時間切れ）。
 */
export type DedicatedProbe =
  | { reached: true; status: number; body: string }
  | { reached: false }

/**
 * 応答の番号だけで分かること（純関数・D-19b・2026-09-16 の検分）。
 *
 * **marker と root で同じ物差しを使うためにここに1つだけ置く。** 検分で出た欠陥は
 * 「同じ 404 を、marker 経路は警告（`stale`）に・root 経路は成功（`responding`）に倒していた」
 * ——**確かめ方が違うだけで、同じ観測の意味が変わってはいけない**（掟10）。
 *
 * - `'no-backend'` … **503**。Traefik の `no available server`＝LB から見て健全なバックエンドが
 *                    1つも登録されていない（2026-09-16 実機で観測した失敗そのもの）
 * - `'error'`      … **400 以上のそれ以外**（404・500・502・504 …）。届いてはいるが、
 *                    利用者から見て**ページは開けない**。専有型の LB は、ホスト名の振り分けが
 *                    効かないと `404 page not found` を返す（2026-09-16 実機・
 *                    docs/apprun-dedicated-plan.md の「IP を直接開くと 404 になる」）。
 *                    **502・504 を実機で見たわけではない**ので、ここでは「400 以上」とだけ決める（掟1）
 * - `'served'`     … それ以外（2xx・3xx）。**何かが配られた**
 */
export type ProbeStatusKind = 'no-backend' | 'error' | 'served'

export function probeStatusKind(status: number): ProbeStatusKind {
  if (status === 503) return 'no-backend'
  if (status >= 400) return 'error'
  return 'served'
}

/**
 * 1回の問い合わせを、**共用型**（cloud.ts の `verifyPublished`）の確認の結果に
 * 翻訳する（純関数・A・2026-09-16 の検分）。
 *
 * 直す前は 503・502・500 のような**エラー応答**まで `unreachable`（「接続できなかった」）に
 * 倒していた。`probeStatusKind` に通して `no-backend`／`error-status` を分ける——
 * **ただし 404 だけは例外**。
 *
 * - 200 かつ目印が一致 → `ok`
 * - 200 だが不一致 → `stale`（届いているが、配られているのは前の版）
 * - **404 → `stale`**（例外。静的配信では「目印のファイルが無い＝古い版」が正しい観測で、
 *   専有型のロードバランサが返す 404＝ホスト名の振り分け失敗とは意味が違う。ここを崩さない）
 * - 503 → `no-backend`（後ろに応答できるものがいない）
 * - 400 以上のそれ以外（500・502・504 …）→ `error-status`（届いたが、開ける証拠にはならない）
 * - それ以外の応答（3xx）→ `stale`（届いてはいるが、目印は読めていない）
 * - 接続できない → `unreachable`
 */
export function judgeVerifyProbe(probe: DedicatedProbe, tag: string): VerifyOutcome {
  if (!probe.reached) return 'unreachable'
  if (probe.status === 404) return 'stale'
  const kind = probeStatusKind(probe.status)
  if (kind === 'no-backend') return 'no-backend'
  if (kind === 'error') return 'error-status'
  if (probe.status === 200) return matchesMarker(probe.body, tag) ? 'ok' : 'stale'
  return 'stale'
}

/**
 * 1回の問い合わせを、確認の結果に翻訳する（純関数）。
 *
 * - 200 かつ目印が一致 → `ok`
 * - 200 だが不一致 → `stale`（届いているが、配られているのは前の版）
 * - **503 → `no-backend`**（Traefik の `no available server`。後ろに健全なコンテナがいない）
 * - **400 以上のそれ以外（404・500・502 …）→ `error-status`**（D-19b の検分。
 *   直す前はこれも `stale`＝「古い内容のまま」と言っていたが、**目印は1文字も読めていない**のだから
 *   「古い」は確かめていないことの言い切りだった。エラーが返ったという観測だけを名前にする）
 * - それ以外の応答（3xx）→ `stale`（届いてはいるが、目印は読めていない）
 * - 接続できない → `unreachable`
 *
 * **503 を `ok` に倒さない。** ここが緩むと 2026-09-16 の事故がそのまま戻る。
 */
export function judgeDedicatedProbe(probe: DedicatedProbe, tag: string): DedicatedVerifyOutcome {
  if (!probe.reached) return 'unreachable'
  const kind = probeStatusKind(probe.status)
  if (kind === 'no-backend') return 'no-backend'
  if (kind === 'error') return 'error-status'
  if (probe.status === 200) return matchesMarker(probe.body, tag) ? 'ok' : 'stale'
  return 'stale'
}

/**
 * 根（`/`）への1回の問い合わせを、確認の結果に翻訳する（純関数・D-19）。
 *
 * - **503 → `no-backend`**（2026-09-16 の失敗そのもの。後ろに健全なコンテナがいない）
 * - **400 以上のそれ以外（404・500・502・504 …）→ `error-status`**
 * - 2xx・3xx → `responding`（**応答している**）
 * - 接続できない → `unreachable`
 *
 * **`ok` は返さない。** 目印が無い像では「配られている中身が新しいか」を確かめる手が無く、
 * `ok` を返せば**確かめていないことを確かめたことにする**（掟10・`unknown-read-as-ok`）。
 *
 * ── D-19b（2026-09-16 の検分）──────────────────────────────────────────────
 * 直す前は「503 以外はすべて `responding`」だった。**404・502・504 でも
 * 「✅ アプリが応答することを確認しました」を出し**、しかも `responding` は取り直しを
 * 止めてよい結果なので、**1回目の 404 でループを打ち切って取り直しもしなかった**。
 * 専有型の LB は、ホスト名の振り分けが効かないと `404 page not found` を返す
 * （2026-09-16 実機）——**利用者から見てページは開けないのに「✅」**。これは
 * 2026-09-16 の事故（`unknown-read-as-ok`）と同じ形なので、400 以上は分けて名前を付ける。
 * 「届いた」ことだけを根拠に成功を名乗らない。
 */
export function judgeDedicatedRootProbe(probe: DedicatedProbe): DedicatedVerifyOutcome {
  if (!probe.reached) return 'unreachable'
  const kind = probeStatusKind(probe.status)
  if (kind === 'no-backend') return 'no-backend'
  if (kind === 'error') return 'error-status'
  return 'responding'
}

/**
 * 確かめ方（`mode`）に応じて、1回の問い合わせを結果に翻訳する（純関数・D-19）。
 * 呼び出し側（apprunDedicatedAppApply.ts の verify 段）はこれだけを呼ぶ——
 * **どちらの判定を使うかの分岐を、画面やフローの側に散らさない**（掟10）。
 */
export function judgeDedicatedProbeBy(
  mode: DedicatedVerifyMode, probe: DedicatedProbe, tag: string,
): DedicatedVerifyOutcome {
  return mode === 'marker' ? judgeDedicatedProbe(probe, tag) : judgeDedicatedRootProbe(probe)
}

/**
 * 確認のループを止めてよい結果か（純関数・D-19）。**確かめたいことが確かめられた**ときだけ true。
 * `marker` なら `ok`、`root` なら `responding`。`no-backend`／`error-status`／`stale`／
 * `unreachable` は、まだ入れ替わっている途中かもしれないので**短く諦めずに取り直す**（verifyDelaysMs）。
 *
 * D-19b（検分）: `error-status` をここに入れない理由は、そのまま検分で出た欠陥である——
 * 直す前は 404・502 が `responding` だったため、**1回目の失敗応答でループを打ち切り、
 * 取り直しもしなかった**。公開直後はコンテナが入れ替わっている最中でありうるので、
 * **失敗応答は諦める理由ではなく、もう一度確かめる理由**である。
 */
export function dedicatedVerifySettled(outcome: DedicatedVerifyOutcome): boolean {
  return outcome === 'ok' || outcome === 'responding'
}

/**
 * **いま利用者から見て、公開先がまともに開けない結果か**（純関数・D-19b）。
 * `no-backend`（503）と `error-status`（404・502・504 …）が true。
 *
 * 画面（AppRunDedicatedPanel.tsx）はこれを、確認の一文を**赤で出すか**と、
 * 「🔧 コントロールパネルを開く」を**出すか**の出し分けに使う。
 * **どの結果が赤かの判断を画面へ散らさない**（掟10）。`stale`／`unreachable` は false——
 * 公開先自体は開ける（古い内容）か、開けるかどうかを確かめられなかっただけである。
 */
export function dedicatedVerifyNotServing(outcome: DedicatedVerifyOutcome | null | undefined): boolean {
  return outcome === 'no-backend' || outcome === 'error-status'
}

// ── O-1（2026-09-17）: 「公開先と https を確かめる」の判定 ────────────────────────
//
// ── なぜ要るか（2026-09-16〜17 の観測）──────────────────────────────────────
// 専有型で公開したところ、**証明書が一度も発行されていなかった**。公開された証明書の
// 記録（CT ログ）に 0 件で、実際に返るのはロードバランサが持っている仮の証明書だった。
// ブラウザで開けば「この接続は安全ではありません」と出る状態である。
// **それでも Koto は「✅ 公開しました」と出していた。Koto は証明書を一度も見ていない。**
// さくらの API には証明書の状態を読む手段が無い（読めるのは「メールを設定したか」だけ・原本で確認）。
// だから Koto が自分で繋いで確かめるしかない。
//
// ── ⑧の verify（公開直後の確認）とは時間軸が違う ───────────────────────────────
// ⑧の verify は **DNS を向ける前**に走る。宛先はロードバランサの IP で、ホスト名は
// SNI に載せるだけ・証明書の検証は意図的に無効にしてある（apprunDedicatedAppApply.ts の
// probeMarkerOverHttps にその理由がある）。**その時点で正式な証明書は存在し得ない。**
// 証明書は「DNS を向けたあと」のものなので、verify に足すと必ず失敗し、意味のない警告が
// 出続ける。**だから押したときに1回だけ調べる別の口（O-1）にする。**
//
// ── 3つの軸を混ぜない ───────────────────────────────────────────────────
// 「証明書は出ている／アプリは応答していない」のように、別々に並べて出せる形にする。
// 混ぜて1つの成否にすると、どれを直せばよいか分からなくなる。

/**
 * DNS がロードバランサを向いているか。
 *
 * `'no-record'` は**比べる相手（このアプリのロードバランサの IP）が記録に無い**状態で、
 * `'unknown'`（引けなかった）とは**別物**である（検分・2026-09-17）。⑧は IP が付く前でも
 * 「IP がまだ取れていません」＋「🔄 IP を取り直す」の下にこの確認ボタンを出すので、
 * この2つを混ぜると「この端末から調べられませんでした」と**誤った原因を断定**することになる。
 */
export type DnsCheck = 'match' | 'mismatch' | 'not-found' | 'no-record' | 'unknown'

/** 証明書の状態。 */
export type CertCheck =
  | 'issued'         // このホスト名を含み、有効期間内の証明書がある
  | 'not-issued'     // ロードバランサの仮証明書（まだ出ていない）
  | 'name-mismatch'  // 証明書はあるが、このホスト名を含まない
  | 'expired'        // 有効期間を過ぎている
  | 'not-yet-valid'  // まだ有効期間に入っていない（期限切れとは別物・検分 2026-09-17）
  | 'unknown'        // 読めなかった

/** ブラウザが受け入れるか（検証を有効にして繋げたか）。 */
export type HttpsOpenCheck = 'ok' | 'rejected' | 'unknown'

/**
 * 引けた IP と、記録しているロードバランサの IP を突き合わせる（純関数）。
 *
 * - `resolved` が `null`（引けなかった）→ `'unknown'`
 * - `resolved` が空 → `'not-found'`
 * - 記録と1つでも一致 → `'match'`
 * - それ以外 → `'mismatch'`
 * - **記録が空のときは `'no-record'`**。比べる相手が無いのに `mismatch` へ倒すと、
 *   「ドメインが別の場所を指しています」という**確かめていない断定**になる（掟1）。
 *   `'unknown'`（引けなかった）とも分ける——原因が違えば**次の一手も違う**からである
 *   （記録が無いなら「🔄 IP を取り直す」。引けなかったなら時間をおいて押し直す）。
 */
export function judgeDnsMatch(resolved: readonly string[] | null | undefined, recorded: readonly string[] | null | undefined): DnsCheck {
  const rec = (recorded ?? []).map(s => String(s ?? '').trim()).filter(Boolean)
  if (rec.length === 0) return 'no-record'
  if (resolved === null || resolved === undefined) return 'unknown'
  const got = resolved.map(s => String(s ?? '').trim()).filter(Boolean)
  if (got.length === 0) return 'not-found'
  return got.some(ip => rec.includes(ip)) ? 'match' : 'mismatch'
}

/**
 * 名前を引きに行って**断られた**とき、その理由が「その名前に A レコードが無い」か（純関数）。
 *
 * ── なぜ要るか（検分・2026-09-17）────────────────────────────────────────
 * `dns.promises.resolve4` は A レコードが無いとき**空の配列を返さない**。名前そのものが無ければ
 * `ENOTFOUND`、名前はあるが A が無ければ `ENODATA` で**断る**。断りをすべて「調べられなかった」に
 * 潰すと、`judgeDnsMatch` は常に `'unknown'` を返し、**`'not-found'` の枝が一度も出ない**。
 * すると「ドメインをまだ設定していない人」＝この確認をいちばん必要とする人に、
 * 「❌ …A レコードを上に出ている IP に向けてください」という**次の一手**が一度も出ない。
 *
 * - その名前に A レコードが無いと DNS が**答えた**（`ENOTFOUND` / `ENODATA` / `NXDOMAIN` /
 *   `NOTFOUND`）→ `'not-found'`（＝引けたが0件。呼ぶ側は空配列にする）
 * - それ以外（`EAI_AGAIN` / `ESERVFAIL` / `ETIMEOUT` / `ECONNREFUSED` / 時間切れ など、
 *   **答えが得られなかった**）→ `'unknown'`（呼ぶ側は `null` にする）
 */
export function judgeDnsLookupError(code: string | null | undefined): 'not-found' | 'unknown' {
  const c = String(code ?? '').trim().toUpperCase()
  if (!c) return 'unknown'
  return c === 'ENOTFOUND' || c === 'ENODATA' || c === 'NXDOMAIN' || c === 'NOTFOUND' ? 'not-found' : 'unknown'
}

/** 証明書の「持ち主」「発行者」の欄（Node の getPeerCertificate が返す形）。 */
export type CertName = { CN?: unknown; O?: unknown; OU?: unknown; C?: unknown }

/** 読み取った証明書（必要な欄だけ・形が違えば読まない）。 */
export type PeerCertificateLike = {
  subject?: unknown
  issuer?: unknown
  subjectaltname?: unknown
  valid_from?: unknown
  valid_to?: unknown
}

/** 名前の欄を `CN=…/O=…` の1本の文字列にする（読めなければ null）。純関数。 */
function nameText(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const n = v as CertName
  const parts = (['CN', 'O', 'OU', 'C'] as const)
    .map(k => (typeof n[k] === 'string' && (n[k] as string).trim() !== '' ? `${k}=${(n[k] as string).trim()}` : null))
    .filter((s): s is string => s !== null)
  return parts.length > 0 ? parts.join('/') : null
}

/** 発行者の名前（画面に添えたいときに使う・任意）。読めなければ null。 */
export function certIssuerName(cert: PeerCertificateLike | null | undefined): string | null {
  if (!cert || typeof cert !== 'object') return null
  return nameText((cert as PeerCertificateLike).issuer)
}

/** `subjectaltname`（`DNS:a.example.com, DNS:*.example.com, IP Address:…`）から DNS 名だけを取る。 */
function altNames(v: unknown): string[] {
  if (typeof v !== 'string') return []
  return v.split(',')
    .map(s => s.trim())
    .filter(s => /^DNS:/i.test(s))
    .map(s => s.slice(4).trim().toLowerCase())
    .filter(Boolean)
}

/**
 * 証明書に書かれた1つの名前が、このホスト名を含むか（純関数）。
 * `*.example.com` は `app.example.com` を含み、`example.com` も `a.b.example.com` も含まない
 * （ワイルドカードは**1段だけ**。ブラウザと同じ扱い）。
 */
export function certNameCovers(pattern: string, host: string): boolean {
  const p = String(pattern ?? '').trim().toLowerCase().replace(/\.$/, '')
  const h = String(host ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!p || !h) return false
  if (p === h) return true
  if (!p.startsWith('*.')) return false
  const suffix = p.slice(1) // '*.example.com' → '.example.com'
  if (!h.endsWith(suffix)) return false
  const label = h.slice(0, h.length - suffix.length)
  return label !== '' && !label.includes('.')
}

/**
 * 相手の証明書を読んで、状態を決める（純関数）。**判定はこの順で行う。**
 *
 * 1. `cert` が `null`・空・期待の形でない → `'unknown'`（**`issued` に倒さない**）
 * 2. 発行者がロードバランサの既定の証明書（`TRAEFIK DEFAULT CERT`）、
 *    または**発行者と持ち主が同じ**（自分で自分に出した証明書）→ `'not-issued'`
 * 3. 有効期間が読めて、`nowMs` が**終わりより後** → `'expired'`／**始まりより前** → `'not-yet-valid'`
 * 4. 証明書に書かれた名前のどれもこのホスト名を含まない → `'name-mismatch'`
 * 5. それ以外 → `'issued'`
 *
 * **発行者が Let's Encrypt かどうかで通す／通さないを決めない。** 利用者が自分で証明書を
 * 入れている場合もある。知りたいのは「ブラウザで開けるか」であって、誰が出したかではない
 * （発行者の名前が要るときは `certIssuerName` で別に取る）。
 */
export function judgePeerCertificate(
  cert: PeerCertificateLike | null | undefined,
  host: string,
  nowMs: number,
): CertCheck {
  // 1. 形の検査。**読めないものを「出ている」に倒さない**（2026-09-16 の事故と同じ形になる）。
  if (!cert || typeof cert !== 'object' || Array.isArray(cert)) return 'unknown'
  if (Object.keys(cert).length === 0) return 'unknown'
  const issuer = nameText(cert.issuer)
  const subject = nameText(cert.subject)
  const alt = altNames(cert.subjectaltname)
  if (!issuer) return 'unknown'
  if (!subject && alt.length === 0) return 'unknown'

  // 2. まだ正式な証明書が出ていない形。ロードバランサの既定の証明書と、
  //    発行者と持ち主が同じもの（自分で自分に出した証明書）の2つ。
  if (/TRAEFIK\s+DEFAULT\s+CERT/i.test(issuer)) return 'not-issued'
  if (subject && issuer === subject) return 'not-issued'

  // 3. 有効期間。**読めないときは期限切れと言わない**（確かめていないことを断定しない・掟1）。
  //    「まだ始まっていない」を `'expired'` に混ぜない（検分・2026-09-17）——利用者は「期限が切れた」と
  //    読んで証明書を入れ直そうとするが、実際は待てば直る（または端末の時計がずれている）。
  const from = typeof cert.valid_from === 'string' ? Date.parse(cert.valid_from) : NaN
  const to = typeof cert.valid_to === 'string' ? Date.parse(cert.valid_to) : NaN
  if (Number.isFinite(from) && nowMs < from) return 'not-yet-valid'
  if (Number.isFinite(to) && nowMs > to) return 'expired'

  // 4. このホスト名を含むか（subjectaltname と、持ち主の CN の両方を見る）。
  const cn = cert.subject && typeof cert.subject === 'object' && !Array.isArray(cert.subject)
    ? (cert.subject as CertName).CN : undefined
  const names = [...alt, ...(typeof cn === 'string' ? [cn] : [])]
  if (!names.some(n => certNameCovers(n, host))) return 'name-mismatch'

  return 'issued'
}

/**
 * 検証を有効にした接続が切られたとき、その理由が**証明書のせい**か（純関数）。
 *
 * 証明書が理由なら `'rejected'`（ブラウザでも同じ警告が出る）、それ以外の失敗
 * （名前が引けない・繋がらない・時間切れ）は `'unknown'`——**繋がらなかったことを
 * 「証明書が悪い」の証拠にしない**（掟1）。
 */
export function judgeHttpsOpenError(code: string | null | undefined): HttpsOpenCheck {
  const c = String(code ?? '').toUpperCase()
  if (!c) return 'unknown'
  return /CERT|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY|TLSV1_ALERT/.test(c) ? 'rejected' : 'unknown'
}

/** 4つの軸をまとめた結果（main が調べて返す形。画面はこれを描くだけ）。 */
export type SiteCheck = {
  dns: DnsCheck
  cert: CertCheck
  httpsOpen: HttpsOpenCheck
  /** 根（`/`）へ1回問い合わせた結果。調べられなかったときは null。 */
  app: DedicatedVerifyOutcome | null
}

/** ドメインの向き先についての1行（純関数）。 */
function dnsLine(dns: DnsCheck): string {
  switch (dns) {
    case 'match':
      return '✅ ドメインは、このアプリのロードバランサに向いています'
    case 'mismatch':
      return '❌ ドメインが、このアプリとは別の場所に向いています。'
        + 'ドメインを買った会社の管理画面で、A レコードを上に出ている IP に向け直してください'
    case 'not-found':
      return '❌ ドメインの向き先が見つかりません。'
        + 'ドメインを買った会社の管理画面で、A レコードを上に出ている IP に向けてください'
        + '（設定してから世界中に行き渡るまで、数分〜数時間かかることがあります）'
    case 'no-record':
      // **原因を断定しない**（検分・2026-09-17）。引けなかったのではなく、比べる相手が無いだけ。
      return 'ℹ️ 比べる先の IP がまだ記録されていないので、ドメインの向き先を照らし合わせられません。'
        + '先に「🔄 IP を取り直す」を押してください'
    case 'unknown':
      return 'ℹ️ ドメインの向き先は確かめられませんでした（この端末から調べられませんでした）'
  }
}

/** 証明書についての1行（純関数）。**専門用語を画面に出さない。** */
function certLine(cert: CertCheck): string {
  switch (cert) {
    case 'issued':
      return '✅ https の証明書が発行されています'
    case 'not-issued':
      return '❌ https の証明書がまだ発行されていません（いまは仮のものが使われています）。'
        + 'ドメインを向けてから発行されるまで時間がかかることがあります。'
        + '少し待ってから、もう一度この確認を押してください'
    case 'name-mismatch':
      return '❌ 証明書はありますが、このドメイン用のものではありません。'
        + 'ブラウザで開くと警告が出ます。さくらのコントロールパネルの証明書情報をご確認ください'
    case 'expired':
      return '❌ 証明書の期限が切れています。'
        + 'ブラウザで開くと警告が出ます。さくらのコントロールパネルの証明書情報をご確認ください'
    case 'not-yet-valid':
      // 「期限切れ」と言わない（検分・2026-09-17）。入れ直しではなく、待つ／時計を見るのが次の一手。
      return '⚠️ 証明書は、まだ有効な期間に入っていません（期限切れではありません）。'
        + '少し待ってから、もう一度この確認を押してください。'
        + 'この端末の時計がずれていると、こう見えることもあります'
    case 'unknown':
      return 'ℹ️ 証明書の状態は確かめられませんでした'
  }
}

/** ブラウザで開けるかについての1行（純関数）。 */
function httpsOpenLine(httpsOpen: HttpsOpenCheck): string {
  switch (httpsOpen) {
    case 'ok':
      return '✅ ブラウザで、警告なしに開けます'
    case 'rejected':
      return '❌ ブラウザで開くと「この接続は安全ではありません」という警告が出ます'
    case 'unknown':
      return 'ℹ️ ブラウザで警告なしに開けるかは、確かめられませんでした'
  }
}

/**
 * 4つの軸を、画面に出す行の並びにする（純関数）。
 *
 * - **1行につき1つの軸。混ぜない。** 「証明書は出ている／アプリは応答していない」を
 *   別々に読めるようにする（混ぜて1つの成否にすると、どれを直せばよいか分からなくなる）
 * - 並びは **ドメイン → 証明書 → ブラウザで開けるか → アプリの応答**。
 *   これは**先に直すべきものが上に来る**順でもある（ドメインが向いていなければ証明書は出ない。
 *   証明書が出ていなければブラウザは警告を出す）
 * - 各行の頭は ✅／⚠️／❌／ℹ️ のどれか。次の一手が要る行には、それも書く
 * - アプリの応答の文は**⑧と同じ `dedicatedVerifyMessage` を使う**（同じ観測に2つの言い方を作らない・掟10）
 */
export function siteCheckLines(r: SiteCheck): string[] {
  // ドメインの向き先がこのアプリだと**確かめられているときだけ**、下の3行を ✅ で出す。
  const confirmedTarget = r.dns === 'match'
  return [
    dnsLine(r.dns),
    aboutCurrentTarget(certLine(r.cert), confirmedTarget),
    aboutCurrentTarget(httpsOpenLine(r.httpsOpen), confirmedTarget),
    aboutCurrentTarget(
      r.app === null ? 'ℹ️ アプリが応答しているかは、確かめられませんでした' : dedicatedVerifyMessage(r.app),
      confirmedTarget,
    ),
  ]
}

/** 下の3行に添える但し書き（ドメインの向き先がこのアプリだと確かめられていないとき）。 */
const NOT_NECESSARILY_THIS_APP =
  '（ただし、これはいまドメインが向いている先を調べた結果です。このアプリのものとは限りません）'

/**
 * 証明書・ブラウザ・アプリの3行は、いずれも**ホスト名で繋いで**調べている（純関数からは見えないが、
 * 呼ぶ側の dedicatedSiteCheck.ts がそうしている）。だからドメインが別の場所を向いていれば、
 * 見ているのは**そのとき向いている先**であって、このアプリではない。
 *
 * ── なぜ落とすか（検分・2026-09-17）────────────────────────────────────────
 * 「いま別のところで動いているサイトを、これから Koto に移す」場面では、
 * ❌ ドメインが別の場所／✅ 証明書／✅ ブラウザで開ける／✅ アプリが応答、と**4行のうち3行が緑**になる。
 * 利用者は「だいたい出来ている」と読むが、**Koto で公開したアプリには一度も届いていない**。
 * これは 2026-09-16 の「確かめていないことを ✅ で言う」の再発である。だから ✅ は ℹ️ に落とし、
 * 何について調べた結果なのかを言い切る。**判定（値）は変えない。文だけを切り替える。**
 */
function aboutCurrentTarget(line: string, confirmedTarget: boolean): string {
  if (confirmedTarget || !line.startsWith('✅')) return line
  return line.replace(/^✅/, 'ℹ️') + NOT_NECESSARILY_THIS_APP
}
