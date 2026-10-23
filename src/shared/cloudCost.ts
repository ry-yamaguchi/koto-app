// cloudCost.ts — さくらのクラウドの「消し忘れると課金が続く資源」の説明（純粋ロジック）。
//
// ── 背景（2026-08-06 ユーザー指摘・公式情報で裏取り済み） ──────────────────
// AppRun で公開すると、Koto は裏で**コンテナレジストリ**を1つ用意する（イメージの置き場）。
//   ・AppRun共用型 … 時間額のみ。**アプリを削除すれば課金は止まる**
//     （課金対象は「インスタンスの作成が開始されたタイミングから削除が完了したタイミングまで」）
//   ・コンテナレジストリ … **月額220円（税込）の固定料金**・ストレージ5GiB込み・**無料枠なし**
//
// つまり **AppRunアプリを消してもレジストリが残れば月220円がかかり続ける**。
// Koto はこの費用をどこにも表示しておらず、「破棄」を押さずにプロジェクトを消した人は
// 気づかないまま課金され続ける状態だった。
//
// 一次情報:
//   https://cloud.sakura.ad.jp/products/container-registry/   （220円 ストレージ5GiB/1レジストリ）
//   https://cloud.sakura.ad.jp/products/apprun-shared/        （時間額のみ。月額設定なし）
//   https://manual.sakura.ad.jp/cloud/payment/server-charge.html（課金対象期間）
//
// 金額はサービス側の改定で変わり得るため、**1箇所だけに書く**（画面の文言はここを参照する）。
import { bucketNamesText } from './teardownSupport'

/** コンテナレジストリの月額（税込・円）。2026-08-06 時点の公表値。 */
export const REGISTRY_MONTHLY_YEN = 220

/**
 * オブジェクトストレージの基本料金（税込・**バケット1つあたり**・月額）。
 *
 * 公式マニュアルの原文: 「『バケット』ごとに料金が発生します」。
 * **サイト単位ではなくバケット単位**なので、プロジェクトごとにバケットを作ると
 * 積み上がる（3プロジェクトで月1,485円）。だから既定は1つを共有し、
 * プレフィックスで分ける（src/shared/objectStorage.ts）。
 *
 * 100GiB・10万リクエスト・転送10GiB を含む。**日割なし・無料枠なし**なので、
 * 1日だけ使っても満額かかる。レジストリと同じく**消し忘れると課金が続く**。
 *   https://cloud.sakura.ad.jp/products/object-storage/
 */
export const BUCKET_MONTHLY_YEN = 495

/** レジストリ料金に含まれるストレージ（GiB）。 */
export const REGISTRY_INCLUDED_STORAGE_GIB = 5

/**
 * レジストリのストレージ超過料金（税込・円・**1GiB ごと**・月額）。
 *
 * 公式サイトの原文: 「ストレージ容量超過分／超過単位: ストレージ追加1GiBごと／22円」。
 * **上限で止まるのではなく、超えた分だけ課金が増える**（2026-08-19 に一次情報で確認）。
 *   https://cloud.sakura.ad.jp/products/container-registry/
 *
 * ── なぜ気にするようになったか（2026-08-19 Ryosuke 指摘）────────────────
 * 同日、公開のたびに新しいイメージのタグを打つようにした（publishTag.ts）。
 * 以前は `latest` を上書きしていたので溜まらなかったが、これからは1公開につき
 * 1タグ増える。1公開で増える容量の実測は shared/imageRetention.ts の冒頭に置いた。
 */
export const REGISTRY_EXTRA_GIB_YEN = 22

/**
 * 「💰 想定される費用」節（③の手前・番号は付けない）に出す3行（判断4・利用者目線レビュー・2026-09-11）。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────────
 * 共用型は「月220円（レジストリ）」が3か所、「月495円（保存場所）」が別の1か所、
 * 「すぐ返すの料金」は金額なしと、費用の説明が7〜8か所に散っていた。**1か所にまとめ、
 * 個別の確認・注記からは「この操作で増える／止まる金額」だけに絞る**（重複した一般説明
 * だけを削り、破棄・作成の直前の警告＝掟5は削らない）。
 *
 * 金額は必ず `REGISTRY_MONTHLY_YEN` / `BUCKET_MONTHLY_YEN` から取る（呼び出し側で
 * 上書きできるのはテスト用——「定数を見ずに220/495を書き戻す」変異を検知するため）。
 */
export function costSummaryLines(opts: {
  /** このプロジェクトが保存場所を使っているか（現在の状態を1行に添えるだけで、行の有無は変えない）。 */
  hasBucket: boolean
  /** いまの「最小スケール」（`service.scale.min`）。1以上なら「常時起動」。 */
  scaleMin: number
  /** テスト用（既定は `REGISTRY_MONTHLY_YEN`）。数字をハードコードに戻すと変わってしまう変異を検知する。 */
  registryYen?: number
  /** テスト用（既定は `BUCKET_MONTHLY_YEN`）。 */
  bucketYen?: number
}): string[] {
  const registryYen = opts.registryYen ?? REGISTRY_MONTHLY_YEN
  const bucketYen = opts.bucketYen ?? BUCKET_MONTHLY_YEN
  const usingScaleLabel = opts.scaleMin >= 1
    ? '（いまの設定は「常時起動」です）'
    : '（いまの設定は「最初のアクセスが遅くてもよい」です）'
  return [
    `コンテナレジストリ 月額${registryYen}円（公開したアプリを消しても残る）`,
    `データの保存場所 月額${bucketYen}円（使う場合${opts.hasBucket ? '・このプロジェクトは使っています' : ''}）`,
    `アプリ本体: 使った分だけ。『常時起動』にすると待機中も料金${usingScaleLabel}`,
  ]
}

// ── 文言に Markdown 記法を書かないこと（2026-08-09 ユーザー指摘）───────────
// ここが返す文字列は、画面では素のテキストとして描画され、破棄の結果メッセージには
// そのまま連結される。**強調** と書いても太字にはならず、`**` が画面にそのまま出る。
// 強調が要る箇所は呼び出し側の CSS（色・太さ）で行い、文言では語順で優先度を示す。
// この決まりは tests/cloudCost.test.ts の「画面文言に Markdown 記法を混ぜない」で固定している。

/**
 * 公開の直後に出す、**止まらない費用**（2026-08-14 Ryosuke と設計を合意）。
 *
 * ── なぜ「合計」で言い切らないのか ────────────────────────────────────
 * 最初は保存場所の495円を足した合計を出そうとしたが、Ryosuke の指摘で改めた:
 *
 *   ① **共有の保存場所は、プロジェクト単位に割れない。** 3つのプロジェクトが
 *      1つの保存場所を共有していると、それぞれの画面で「＋495円」と出すことになり、
 *      合わせて1,485円に見える。実際は495円。**足すと嘘になる。**
 *   ② **月額は固定ではない。** 495円に含まれるのは 100GiB・10万リクエスト・
 *      転送10GiB まで。超えれば増える（レジストリの5GiBも同じ）。
 *
 * そこで「**このプロジェクトだけのものは合計に入れ、共有のものは別に書き、
 * 実額はコントロールパネルで確かめてもらう**」形にした。
 * 金額を文頭に置くのはこれまでどおり（小さな文字なので読み飛ばされる）。
 */
export function ongoingCostNotice(opts: {
  registryName: string | null
  /** このプロジェクトの保存場所（用意していなければ null）。 */
  bucket: { name: string; shared: boolean } | null
}): string {
  // 合計に入れるのは**このプロジェクトだけのもの**。共有のものは割れないので入れない
  const dedicated = opts.bucket && !opts.bucket.shared ? opts.bucket : null
  const total = REGISTRY_MONTHLY_YEN + (dedicated ? BUCKET_MONTHLY_YEN : 0)

  const items = [`コンテナレジストリ${opts.registryName ? `『${opts.registryName}』` : ''}`]
  if (dedicated) items.push(`データの保存場所『${dedicated.name}』`)

  let out = `月額${total}円（税込）がかかり続けます。内訳: ${items.join('と')}。`

  if (opts.bucket && opts.bucket.shared) {
    out += `データの保存場所『${opts.bucket.name}』はほかのプロジェクトと共有のため、`
      + `このプロジェクト分としては出せません（保存場所1つにつき月額${BUCKET_MONTHLY_YEN}円・税込）。`
  }

  out += `保存した量や通信量によって変わるため、実際の請求額はさくらのクラウドのコントロールパネルでご確認ください。`
  out += opts.bucket
    ? `使い終わったら「🗑 破棄する」で削除してください（AppRunアプリを消すだけでは、どちらも止まりません）。`
    : `使い終わったら「🗑 破棄する」で削除してください（AppRunアプリを消すだけでは止まりません）。`
  return out
}

/** 公開の直後に出す、費用の一言（放置しても止まらない分だけを伝える）。 */
export function registryCostNotice(registryName: string | null): string {
  const name = registryName ? `『${registryName}』` : ''
  // 金額を文頭に置く。枠の中の小さな文字なので、読み飛ばされても最初の一行で額が目に入るようにする。
  return `月額${REGISTRY_MONTHLY_YEN}円（税込・ストレージ${REGISTRY_INCLUDED_STORAGE_GIB}GiBまで）がかかり続けます。`
    + `イメージの保存先としてコンテナレジストリ${name}を使っているためです。`
    + `使い終わったら「🗑 破棄する」で削除してください（AppRunアプリを消すだけでは止まりません）。`
}

/** 破棄の確認画面に出す、レジストリ削除チェックの説明。 */
export function registryDeleteLabel(registryName: string | null): string {
  return `コンテナレジストリ${registryName ? `『${registryName}』` : ''}も削除する`
}

/**
 * 破棄の確認に出す、レジストリ削除チェックの説明（チェックの状態ごと）。
 *
 * 外したときの月額と「後で消す場合は削除して」は、**このプロジェクトだけのレジストリ**（`registryIsOnlyThisProjects`）にだけ言う
 * （2026-10-19）。借りたもの・作ったか分からないもの・ほかのプロジェクトが使っているものには、そのどちらも言わない: 言われたとおり消すと、
 * ほかのアプリが動かなくなる。**言わないときは空の文字列を返す**（「レジストリは残ります。」は、チェックの名前「…も削除する」を言い直すだけ。
 * 残す理由と月額は、その上の注意〔`registryChoiceNote`〕が言っている）。描く側（ConfirmModal）は空の説明を出さない。`onlyThisProjects` は**必ず渡す**
 * （省略できる形にすると、渡し忘れても型が通り、借り物にも「後で消す場合は」と言う）。
 */
export function registryDeleteHelp(deleteIt: boolean, onlyThisProjects: boolean): string {
  if (deleteIt) {
    return `月額${REGISTRY_MONTHLY_YEN}円（税込）の課金が止まります。中の登録済みイメージも消えます。`
      + `心当たりのない名前のときはチェックを外してください。`
  }
  return onlyThisProjects
    ? `レジストリは残ります。月額${REGISTRY_MONTHLY_YEN}円（税込）の課金は続きます。`
      + `後で消す場合は、さくらのクラウドのコントロールパネルから削除してください。`
    : ''
}

/**
 * コンテナレジストリを、このプロジェクトのために Koto が作ったか（記録 `meta.registryAdopted` の読み）。
 *
 *   owned   … Koto がこのプロジェクトのために作った（記録が `false`）
 *   adopted … もとからあったものを借りている（記録が `true`。引き継ぎ・記録の無いプロジェクトの公開）
 *   unknown … 分からない（記録に印が無い・型が違う）
 *
 * **分からないものを「Koto が作った」と読まない**（2026-10-19）。接続情報は Koto 全体で1つなので、
 * 記録の無いプロジェクトが公開すると、ほかのプロジェクトが作ったレジストリを使う。
 * 以前は「印が無い＝Koto が作った」と読んだため、そのレジストリを既定で消す確認が出ていた。
 * 記録を読む口は、どこもこの関数に通す（印の読みを複製しない）。
 */
export type RegistryOrigin = 'owned' | 'adopted' | 'unknown'

export function registryOriginOf(registryAdopted: unknown): RegistryOrigin {
  if (registryAdopted === false) return 'owned'
  if (registryAdopted === true) return 'adopted'
  return 'unknown'
}

/** 画面が受け取った値が3つのどれかか（形の違う応答を「分からない」に倒さず、読めなかったと扱うために使う）。 */
export function isRegistryOrigin(x: unknown): x is RegistryOrigin {
  return x === 'owned' || x === 'adopted' || x === 'unknown'
}

/**
 * 「置き場も削除する」の**最初の状態**を決める（純関数）。**既定でオンにするのは、`owned` で、ほかに使うプロジェクトが無いものだけ。**
 *
 * ── なぜそれだけなのか（2026-08-25・AppRun の引き継ぎ／2026-10-19）────────────────
 * 既定はオン。残すと月220円が止まらないからで、**Koto がそのプロジェクトのために作った置き場なら
 * それで正しい**（専用なので、消して困る人がいない）。
 *
 * だが借りた置き場（`adopted`）や、作ったか分からない置き場（`unknown`）には、
 * **別のアプリのイメージが入っていることがある**（引き継ぎ・コントロールパネルで作った人は1つに
 * まとめがち／接続情報は Koto 全体で1つなので、記録の無いプロジェクトはほかのプロジェクトの置き場を使う）。
 * 消すと**それらのアプリが動かなくなる**。消したい人は自分で入れられるので、**外しておく。**
 *
 * **作った側（`owned`）も、ほかのプロジェクトが借りていれば外す**（`otherUsers` は、同じ置き場を記録しているほかのプロジェクトの数）。
 * 借りる側を直しても、借りられた側から消せば同じ害（借りている全アプリのイメージが消える）が起きる。入口が逆なだけ。
 * `otherUsers` は**必ず渡す**（省略できる形にしない。渡し忘れても型が通り、数えないまま既定オンになる）。
 * 0 とちょうど等しいときだけオン。数でない値（NaN など）は「分からない」なのでオフ。
 */
export function registryDeleteDefault(opts: { registryName: string | null; origin: RegistryOrigin; otherUsers: number }): boolean {
  return registryIsOnlyThisProjects(opts)
}

/**
 * このコンテナレジストリは、このプロジェクトだけのものか（Koto がこのプロジェクトのために作り〔`owned`〕、ほかのプロジェクトが使っていない）。
 * 名前が無ければ、レジストリの記録が無いので false。`otherUsers` は 0 とちょうど等しいときだけ（数でない値は「分からない」なので false）。
 *
 * **この判断を使う所は2つ**: 破棄の確認の「置き場も削除する」の既定オン（registryDeleteDefault）と、プロジェクトの削除で「公開も一緒に破棄する」を外した
 * ときの「コンテナレジストリの月額が続きます」の文（2026-10-19、0.6.22-rc.1 の実機。共用型の行があるだけで言っていた）。
 * 後者は、借りたもの・作ったか分からないもの・ほかが使っているもの・記録が無いものには言わない。その月額は、このプロジェクトを破棄しなくても
 * このプロジェクトの話ではない、または分からないため。「このプロジェクトだけのレジストリ」を2つ書かない。
 */
export function registryIsOnlyThisProjects(opts: { registryName: string | null; origin: RegistryOrigin; otherUsers: number }): boolean {
  if (!opts.registryName) return false
  return opts.origin === 'owned' && opts.otherUsers === 0
}

/** 借り物の置き場であることの断り（既定を外した理由を、その場で言う）。引き継ぎも、記録の無いプロジェクトの公開で借りたものも、この文。 */
export function adoptedRegistryNote(registryName: string | null): string {
  return `このコンテナレジストリ${registryName ? `『${registryName}』` : ''}は、このプロジェクトのために作ったものではありません。`
    + 'ほかのアプリのイメージも入っている場合、消すとそれらが動かなくなります。'
    + `消してよいと分かっているときだけ、チェックを入れてください（月額${REGISTRY_MONTHLY_YEN}円・税込が止まります）。`
}

/** 作ったか分からない置き場の断り（既定を外した理由を、その場で言う）。 */
export function unknownOriginRegistryNote(registryName: string | null): string {
  return `このコンテナレジストリ${registryName ? `『${registryName}』` : ''}を、このプロジェクトのために作ったか分かりません。`
    + 'ほかのアプリも使っている場合、消すとそれらが動かなくなります。'
    + `消してよいと分かっているときだけ、チェックを入れてください（月額${REGISTRY_MONTHLY_YEN}円・税込が止まります）。`
}

/** 既定を外した理由（作ったか借りたかだけで決まるもの）。Koto が作ったもの（`owned`）は、これだけでは既定がオンなので、言うことが無い。 */
export function registryOriginNote(origin: RegistryOrigin, registryName: string | null): string | null {
  if (origin === 'adopted') return adoptedRegistryNote(registryName)
  if (origin === 'unknown') return unknownOriginRegistryNote(registryName)
  return null
}

/**
 * ほかのプロジェクトの名前を、確認の文に収まる形にする。2件まではそのまま、3件以上は先頭の1件と件数（「reminder ほか3件」）。
 * 名前を出すのは、利用者が「消して困る相手」を見分けるため。件数だけでは、心当たりのあるプロジェクトか分からない。
 */
export function otherProjectsText(names: readonly string[]): string {
  if (names.length <= 2) return names.join('・')
  return `${names[0]} ほか${names.length - 1}件`
}

/**
 * ほかのプロジェクトが同じ置き場を使っているときの断り（既定を外した理由を、その場で言う）。
 * 作った側（`owned`）にも、借りた側にも、同じ文を出す。**使っている相手が分かっている**ので、「入っている場合」と推測では言わない。
 */
export function sharedRegistryNote(registryName: string | null, users: readonly string[]): string {
  return `ほかのプロジェクト（${otherProjectsText(users)}）も、このコンテナレジストリ${registryName ? `『${registryName}』` : ''}を使っています。`
    + '消すと、それらのアプリが動かなくなります。'
    + `消してよいと分かっているときだけ、チェックを入れてください（月額${REGISTRY_MONTHLY_YEN}円・税込が止まります）。`
}

/**
 * 「置き場も削除する」の既定を外した理由。ほかのプロジェクトが使っていると分かっていれば、それを言う（作った・借りたより強い事実で、
 * 消すと何が起きるかをそのまま言える）。いなければ、作ったか借りたかの断り（`owned` は言うことが無いので null）。
 */
export function registryChoiceNote(opts: { origin: RegistryOrigin; registryName: string | null; users: readonly string[] }): string | null {
  if (opts.users.length > 0) return sharedRegistryNote(opts.registryName, opts.users)
  return registryOriginNote(opts.origin, opts.registryName)
}

/**
 * どのレジストリを使っているかの記録が無いときに、破棄の確認画面へ出す注意。
 *
 * 記録が無いと registryDeletionTarget が「対象不明」を返すので、**チェックを入れても
 * 削除されない**。「削除する」と書いてあるのに削除できないチェックは誤解しか生まないため、
 * チェック自体を出さずにこの文を出す（2026-08-09 の実機検証で発覚）。
 * v0.2.94 以前に公開した環境や、v0.2.99 以前の破棄で記録を失った環境が該当する。
 */
export function registryUnknownNotice(): string {
  return `このプロジェクトがどのコンテナレジストリを使っているかの記録がないため、`
    + `Koto からは削除できません。さくらのクラウドのコントロールパネルで確認し、`
    + `不要なら削除してください（残すと月額${REGISTRY_MONTHLY_YEN}円・税込がかかり続けます）。`
}

/**
 * 破棄すると公開URLが変わることを伝える一文。
 *
 * AppRun の公開URLはアプリIDから作られるため、破棄して公開し直すと**別のURLになる**。
 * 人に伝えたURLやブックマークは使えなくなり、元のURLには戻せない。
 * URLそのものは長くて読み取れないので出さない。「変わる」という事実だけを伝える
 * （2026-08-09 Ryosuke の指定）。
 */
export function urlChangesOnTeardownNotice(): string {
  return `公開URLは元に戻せません。破棄したあとに公開し直すと別のURLになるため、`
    + `いま公開しているURLを誰かに伝えている場合は、届かなくなります。`
}

/**
 * 破棄後に「まだ課金が続くもの」があるかの注意文。無ければ null。
 *
 * ── 保存場所を数に入れる理由（2026-08-14）──────────────────────────────
 * 保存場所は**破棄しても残ることがある**（ほかのプロジェクトが使っている・利用者が
 * 自分で置いたファイルがある場合。src/shared/objectStorage.ts の3段構え）。
 * つまり「破棄したのに月額495円が続く」が正常な結果として起こりうる。
 * **それを黙っていると、消したつもりの費用が請求書に出続ける。**
 *
 * ── 「後で消す場合は削除して」は、消してよいものにだけ言う（2026-10-19・双子）──────────────────
 * 月額は、残したものすべてについて言う（お金は削らない）。だが「後で消す場合は削除して」と言ってよいのは、**このプロジェクトだけのもの**だけ。
 *   ・コンテナレジストリ … 呼び手（`teardownRemainingWarnings`）が `registryIsOnlyThisProjects` で決める。ここへ `deleteRegistry: false` で渡すのは
 *     このプロジェクトだけのレジストリだけ（借りたもの・ほかが使うものは、月額の合計に入れず、別の一文 `keptSharedRegistryNote` で言う）。
 *   ・保存場所 … 残した理由で言い分ける。ほかのプロジェクトも使っている保存場所を、言われたとおり消すと、そのプロジェクトのデータも消える
 *     （プロジェクトの削除の結果〔projectDeletePlan.ts の PROJECT_DELETE_REVIEW_TAIL〕も「消さないでください」と言っている）。
 *     理由が分からない保存場所は、分からない側（消す前に確かめる）に倒す。
 */
export function remainingCostWarning(opts: {
  deleteRegistry: boolean
  registryName: string | null
  /** 破棄したのに保存場所が残ったか（残った場合のみ名前を渡す）。 */
  keptBucketName?: string | null
  /**
   * 残った保存場所が**複数**あるとき、その全部の名前（HANAMII・専有型の破棄は、同意済みの保存場所を全件片づけるので
   * 複数ありうる）。`keptBucketName` と重なる名前は1つと数える。**1件だけ名指しすると、名前が出なかった保存場所の
   * 月額が黙って続く**（objectStorage の検分の指摘5と同じ形）。
   */
  keptBucketNames?: readonly string[] | null
  /** 残った保存場所のうち、**ほかのプロジェクトも使っているため残した**もの（`teardownPlanFor` の `keptReasons.usedByOthers`）。消すと、そのプロジェクトのデータも消える。 */
  keptBucketsUsedByOthers?: readonly string[] | null
  /** 残った保存場所のうち、**Koto が作ったのではないファイルがあるため残した**もの（`keptReasons.ownFiles`）。消す前に中身を確かめる。どちらの印も無い保存場所は、理由が分からない扱い。 */
  keptBucketsWithOwnFiles?: readonly string[] | null
}): string | null {
  const parts: string[] = []
  let total = 0
  const registryKept = !opts.deleteRegistry
  if (registryKept) {
    total += REGISTRY_MONTHLY_YEN
    parts.push(`コンテナレジストリ${opts.registryName ? `『${opts.registryName}』` : ''}`)
  }
  const keptBuckets = Array.from(new Set([opts.keptBucketName, ...(opts.keptBucketNames ?? [])]
    .filter((n): n is string => typeof n === 'string' && n !== '')))
  if (keptBuckets.length > 0) {
    total += BUCKET_MONTHLY_YEN * keptBuckets.length
    parts.push(`データの保存場所${bucketNamesText(keptBuckets)}`)
  }
  if (parts.length === 0) return null
  const head = `⚠️ ${parts.join('と')}は残るため、月額${total}円（税込）の課金は続きます。`

  // どう扱ってよいかは、残した理由ごとに1文。同じ理由の保存場所は1つにまとめる。
  const usedByOthers = new Set(opts.keptBucketsUsedByOthers ?? [])
  const withOwnFiles = new Set(opts.keptBucketsWithOwnFiles ?? [])
  const whyOf = (b: string): KeptBucketWhy => (usedByOthers.has(b) ? 'usedByOthers' : withOwnFiles.has(b) ? 'ownFiles' : 'unknown')
  const groups = KEPT_BUCKET_WHY_ORDER
    .map(why => ({ why, names: keptBuckets.filter(b => whyOf(b) === why) }))
    .filter(g => g.names.length > 0)
  // 保存場所の文は、保存場所が1種類の理由だけで、レジストリの文も無いときは、主語（上の文が言った保存場所）を省く。それ以外は名前を言う。
  const named = registryKept || groups.length > 1
  const tails: string[] = []
  // 「どこで消せるか」を必ず添える（2026-09-11 利用者目線レビュー）。📡 公開したもの一覧では
  // 破棄で記録の行が消えるため、この一文が片づけ先を知る唯一の手がかりになる。
  if (registryKept) {
    tails.push(`${groups.length > 0 ? 'コンテナレジストリを' : ''}後で消す場合は、さくらのクラウドのコントロールパネルから削除してください。`)
  }
  for (const g of groups) tails.push(keptBucketTail(g.why, named ? `データの保存場所${bucketNamesText(g.names)}` : null))
  return head + tails.join('')
}

/** 残した保存場所の、残した理由。 */
type KeptBucketWhy = 'usedByOthers' | 'ownFiles' | 'unknown'
const KEPT_BUCKET_WHY_ORDER: readonly KeptBucketWhy[] = ['usedByOthers', 'ownFiles', 'unknown']

/**
 * 残した保存場所について、理由ごとの1文（`subject` が null なら主語を省く）。**事実だけを言い、「ため残しました」とは言わない**
 * （上の文が「残るため、月額…」と言うので、「残」が3回重なる。緑の行も理由を言わない・2026-10-19 検分）。
 *   ・usedByOthers … ほかのプロジェクトも使っている。確かめたのは「ほかのプロジェクトのデータがある」ことだけ（アプリがあるか・動いているかは見ていない）。
 *     だから消すと起きることは「そのプロジェクトのデータも消える」と言う（「アプリが止まる」とは言い切らない）。「後で消す場合は」と言わない
 *   ・ownFiles … 利用者のファイル。消すかどうかは利用者が決める。中身を確かめてから
 *   ・unknown … 理由が返り値で分からない。消す前に、使っているプロジェクトが無いか確かめてもらう
 */
function keptBucketTail(why: KeptBucketWhy, subject: string | null): string {
  switch (why) {
    case 'usedByOthers':
      return `${subject ? `${subject}は、` : ''}ほかのプロジェクトも使っています。消すと、そのプロジェクトのデータも消えます。`
    case 'ownFiles':
      return `${subject ? `${subject}には、` : ''}Koto が作ったのではないファイルがあります。消す前に、さくらのクラウドのコントロールパネルで中身を確かめてください。`
    case 'unknown':
      return `${subject ? `${subject}は、` : ''}消す前に、さくらのクラウドのコントロールパネルで、使っているプロジェクトが無いか確かめてください。`
  }
}

/**
 * 残したコンテナレジストリが**このプロジェクトだけのものでない**ときの、結果の一文（月額の合計に入れず、「後で消す場合は」も言わない）。
 *
 * 借りたもの・作ったか分からないもの・ほかのプロジェクトが使っているものは、言われたとおり消すと、ほかのアプリが動かなくなる。
 * だから「残しました」と、確かめた事実だけを言う（2026-10-19・双子。確認の既定・削除の画面は `registryIsOnlyThisProjects` で出し分けているのに、
 * 結果の警告だけが一律に「後で消す場合は」と言っていた）。
 * **残した理由は言わない**（「…ため、残しました」としない）。残すかどうかを決めたのは Koto の判断とは限らない: 利用者がチェックを外した回も、
 * 確認のあとで記録が変わって削除を見送った回も、この文が出る。理由を言うと、実際の理由と食い違う。
 * `users` は、同じレジストリを使っているほかのプロジェクト（`null` は、調べられなかった＝分からない）。
 *
 * **月額は、このプロジェクトのものかもしれない回だけ言う**（お金は削らない）。作ったか分からない（0.3.43 より前に Koto が作ったものも、記録に印が無いのでここに入る）回と、
 * 作った（owned）が借り手を調べられなかった回。借りたもの・ほかのプロジェクトが使っていると分かっているものは、月額が続くのはこのプロジェクトの話ではないので、言わない。
 * 並びは強い順: 使っているプロジェクトが分かっている > 借りたもの > 作ったか分からない > 作ったが借り手を調べられなかった。
 */
export function keptSharedRegistryNote(opts: { registryName: string | null; origin: RegistryOrigin; users: readonly string[] | null }): string {
  const name = opts.registryName ? `『${opts.registryName}』` : ''
  const kept = `⚠️ コンテナレジストリ${name}は残しました`
  if (opts.users && opts.users.length > 0) return `${kept}。ほかのプロジェクト（${otherProjectsText(opts.users)}）も使っています。`
  if (opts.origin === 'adopted') return `${kept}。このプロジェクトのために作ったものではありません。`
  const money = `（月額${REGISTRY_MONTHLY_YEN}円・税込は続きます）`
  if (opts.origin === 'unknown') return `${kept}${money}。このプロジェクトのために作ったか分かりません。ほかのアプリも使っていることがあります。`
  return `${kept}${money}。ほかのプロジェクトが使っていないか確かめられませんでした。`
}

/**
 * 共用型の破棄の**返り値（main が返す事実）**から、月額が続く警告を作る（無ければ空の配列）。
 *
 * **その場の画面（AppRunPanel の破棄の結果）と、閉じて開き直したあとの処理の記録（main/projectOps.ts の
 * summarizeResult）は、どちらもこの1つの関数を通る**（2026-09-30 検分の指摘6）。以前は、その場の画面が
 * 自分の選択（レジストリを残すか）から警告を作り、記録は main が返した事実から作っていたので、
 * 破棄が途中で失敗した回や、記録にレジストリ名が無い回に、その場では月額が続くと言うのに、
 * 開き直すと警告が消えた。
 *   ・keptBucketName … 破棄したのに残った保存場所
 *   ・keptBucketsUsedByOthers／keptBucketsWithOwnFiles … 残した保存場所の理由（無ければ、理由が分からない扱い）
 *   ・keptRegistryName … 利用者が「残す」と選んだ、コンテナレジストリの名前
 *   ・keptRegistryOrigin／keptRegistryUsers … そのレジストリの由来（Koto が作った／借りた／分からない）と、使っているほかのプロジェクト。
 *     **どちらかが欠けていれば、このプロジェクトだけのものとは言わない**（`registryIsOnlyThisProjects`。分からない側に倒す）。
 *     このプロジェクトだけのもの（Koto が作り、ほかが使っていない）を残した回だけ、月額と「後で消す場合は」を言う（2026-10-19・双子）。
 *     それ以外は月額の合計に入れず、`keptSharedRegistryNote` の一文
 *   ・keptRegistryUnnamed … 「残す」と選んだが、記録に名前が無い。**残っているとは確かめられていない**ので、
 *     「残る」と断定せず、確認の画面と同じ文（registryUnknownNotice）で言う
 * 名前のあるもの（このプロジェクトだけのレジストリ・保存場所）は合算して1つの警告にする（月額の合計を出すため）。
 */
export function teardownRemainingWarnings(r: {
  keptBucketName?: string | null
  /** 残った保存場所が複数あるときの全部（HANAMII・専有型）。`keptBucketName` と重なる名前は1つと数える。 */
  keptBucketNames?: readonly string[] | null
  keptBucketsUsedByOthers?: readonly string[] | null
  keptBucketsWithOwnFiles?: readonly string[] | null
  keptRegistryName?: string | null
  /** 残したレジストリの由来。無い・3つのどれでもない値は「分からない」。 */
  keptRegistryOrigin?: RegistryOrigin | null
  /** 残したレジストリを使っている、ほかのプロジェクト。無い（調べられなかった・旧い返り値）ときは null＝分からない。 */
  keptRegistryUsers?: readonly string[] | null
  keptRegistryUnnamed?: boolean
}): string[] {
  const out: string[] = []
  const registryName = r.keptRegistryName || null
  const origin: RegistryOrigin = isRegistryOrigin(r.keptRegistryOrigin) ? r.keptRegistryOrigin : 'unknown'
  const users = Array.isArray(r.keptRegistryUsers) ? r.keptRegistryUsers : null
  const ownRegistry = registryName !== null
    && registryIsOnlyThisProjects({ registryName, origin, otherUsers: users ? users.length : Number.NaN })
  const named = remainingCostWarning({
    deleteRegistry: !ownRegistry,
    registryName: ownRegistry ? registryName : null,
    keptBucketName: r.keptBucketName || null,
    keptBucketNames: r.keptBucketNames ?? null,
    keptBucketsUsedByOthers: r.keptBucketsUsedByOthers ?? null,
    keptBucketsWithOwnFiles: r.keptBucketsWithOwnFiles ?? null,
  })
  if (named) out.push(named)
  if (registryName && !ownRegistry) out.push(keptSharedRegistryNote({ registryName, origin, users }))
  if (r.keptRegistryUnnamed === true && !registryName) out.push(`⚠️ ${registryUnknownNotice()}`)
  return out
}
