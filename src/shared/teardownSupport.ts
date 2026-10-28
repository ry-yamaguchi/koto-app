// teardownSupport.ts — 公開先ごとに「Koto から破棄できるか」を判定する（純粋ロジック）。
//
// ── なぜ一元化するのか（2026-08-09 Ryosuke の指摘）──────────────────────
// 破棄の導線を「公開」の各パネル以外にも増やす（📡 公開したもの一覧・プロジェクト削除時）。
// 公開先は5つあるが**破棄の口があるのは3つだけ**（AppRun 共用型・専有型・HANAMII）なので、置き場所ごとに判定を書くと
// 「押しても何も起きないボタン」がどこかに生まれる。判定はここ1箇所に置く。
//
// 破棄できない2つは、サービス側で消してもらうしかない。**消す方法を必ず添える**こと。
// 「できません」だけでは、月額課金が続くものを放置させることになる。

import type { PublishTargetKind } from '../renderer/publishStatus'

/** Koto から破棄できるか。'manual' はサービス側で消してもらう。 */
export type TeardownSupport = 'supported' | 'manual'

/**
 * その公開先を Koto から破棄できるか。
 * - `sakura-apprun` … `cloud:teardown`（アプリ＋コンテナレジストリ）
 * - `sakura-apprun-dedicated` … `apprunDedicated:teardown`（アプリ → ロードバランサ → オートスケーリンググループ →
 *   クラスタ ＋ 保存場所の片づけ）。専有型タブの手順6「すべて削除する」と 📡 の 🗑 は**同じこの1つ**
 *   （2026-10-08 作者の決定。以前の「アプリだけ」の口は廃止した）
 * - `hanamii`       … `hanamii:teardown`（プロジェクト削除＋保存場所の片づけ。2026-09-25〜）
 * - `vercel` / `sakura-rental` … 破棄の実装が無い
 */
export function teardownSupport(target: PublishTargetKind): TeardownSupport {
  return target === 'sakura-apprun' || target === 'sakura-apprun-dedicated' || target === 'hanamii'
    ? 'supported'
    : 'manual'
}

/**
 * 専有型の「すべて削除」で、**記録に消すものがあるか**（純関数・2026-10-08 検分）。
 *
 * 資源の ID（アプリ・ロードバランサ・オートスケーリンググループ・クラスタ）が1つでもある、または前回の削除で
 * 保存場所だけが残った印（`storageLeftoverBucket`）がある、なら true。
 *
 * ── なぜ要るか（「幽霊の行」）────────────────────────────────────────────
 * 資源の記録は空なのに、公開の記録（📡 の行）だけが残っている行がありうる（記録が失われた・旧い版の名残）。
 * その行の 🗑 を「すべて削除」として通すと、`teardownFlow` は「記録がありません」で ok:true を返し、そのあとの
 * 保存場所の片づけが**走ってしまう**——消すものを名指しできないまま、プロジェクトの保存場所のデータ
 * （ほかの公開先が使っているものを含む）が消える。だから、**消すものが記録に無いなら保存場所には触れない**。
 * 判断はここの1つだけ。main の `apprunDedicated:teardown`（保存場所に触れるか）と、画面の共通の流れ（teardown/flow.ts の runTeardownFlow。
 * 破壊の確認を出すか）が同じこれを使う。手順6のボタンの出し分け（shouldShowTeardownButton）と同じ答えになることは
 * tests/dedicatedTeardownEntries.test.ts が固定する。
 */
export function dedicatedTeardownHasWork(record: {
  applicationID?: string | null
  loadBalancerID?: string | null
  asgID?: string | null
  clusterID?: string | null
  storageLeftoverBucket?: string | null
} | null | undefined): boolean {
  return !!(record?.applicationID || record?.loadBalancerID || record?.asgID || record?.clusterID || record?.storageLeftoverBucket)
}

/**
 * 保存場所の名前を、画面の文に並べる（『A』『B』。区切りは付けない）。Markdown 記法は使わない（掟5）。
 * 3つの公開先の削除の「残っています」の行（main）・確認が挙げる保存場所の名前・手順6の 🗄️ の行・プロジェクトの削除を止める文・
 * 残した保存場所の月額の警告が、同じこれを通る。**名前を『』で囲んで並べる整形は src にこの1つだけ**（tests/teardownSupport.test.ts が見張る。
 * 3B の検分まで、HANAMII・共用型の main は自分用の整形を持っていて、区切りを変えても専有型の試験しか落ちなかった）。
 */
export function bucketNamesText(names: readonly string[]): string {
  return names.map(b => `『${b}』`).join('')
}

/**
 * 専有型の記録が言う「保存場所だけが残った」名前の**全件**（0.6.22 段階3B-2・B=2）。
 *
 * `storageLeftoverBuckets`（全件）があればそれ。無ければ `storageLeftoverBucket`（先頭の1件。全件を書く前の旧い記録も、
 * 同じ回に両方を書く今の記録も、ここを通る）。同じ名前は1つ。文字列でない値・空の文字列は数えない（読めない値は「無い」に倒す）。
 *
 * 「消すものがあるか」（`dedicatedTeardownHasWork`）は `storageLeftoverBucket` の1件を見続ける——main は2つを必ず同時に書く
 * （先頭1件が `storageLeftoverBucket`）ので、判断は変わらない。名前を**言う**側（手順6の 🗄️ の行・プロジェクトの削除を止める文）だけが、
 * この関数で全件を言う。
 */
export function dedicatedStorageLeftoverNames(record: {
  storageLeftoverBucket?: string | null
  storageLeftoverBuckets?: readonly string[] | null
} | null | undefined): string[] {
  const listed: unknown = record?.storageLeftoverBuckets
  const many = Array.isArray(listed) ? listed.filter((b): b is string => typeof b === 'string' && b !== '') : []
  if (many.length > 0) return Array.from(new Set(many))
  const one: unknown = record?.storageLeftoverBucket
  return typeof one === 'string' && one !== '' ? [one] : []
}

/**
 * 破棄できない公開先について、どこで消せばよいかを伝える文。
 * 画面には素のテキストとして出るので、Markdown 記法は使わない（v0.2.98 の教訓）。
 *
 * `opts.storageTornDown`（0.6.24 A-9）: **真のときだけ**（`=== true`。渡し忘れ・形違いは偽＝今の文）、Vercel の最後の文
 * 「保存場所（バケット）自体は…残ります。」を言わない。プロジェクトの削除で、保存場所も一緒に破棄する回
 * （チェックがオンで、残りの段が保存場所を破棄する回）は、その文が事実と食い違うため。真かどうかの判断は画面側（projectDeleteWords.ts の
 * vercelStorageTornDown）が持ち、ここは文を出し分けるだけ。📡（PublishedListModal）は渡さない＝今のまま。
 */
export function manualTeardownGuide(target: PublishTargetKind, opts?: { storageTornDown?: boolean }): string {
  switch (target) {
    case 'vercel':
      // **鍵のことを落とさない**（2026-09-24 検分の指摘13）。2026-09-24 から、Vercel への公開は
      // さくらのオブジェクトストレージへ読み書きできる鍵（`koto-<名前>_vercel`）を1本発行する。
      // Vercel のプロジェクトを消しても鍵は残り、Koto 側には Vercel 向けの片づけの口が無いので、
      // **案内どおり片づけたのに、消したはずのアプリの鍵が生き続ける。**
      // Koto に鍵を無効にする画面はまだ無いので、**どこで消せるかを正直に書く**（無い導線を案内しない）。
      return 'Koto からは消せません。次の2つを自分で消してください。'
        + '(1) Vercel のダッシュボード（vercel.com）で、Vercel のプロジェクトを削除。'
        + '(2) さくらのクラウドのコントロールパネルで、オブジェクトストレージのパーミッション「koto-<プロジェクト名>_vercel」を削除'
        + '（アプリ用のアクセスキーも一緒に無効になります）。'
        + (opts?.storageTornDown === true ? '' : '保存場所（バケット）自体は、ほかの公開先と共有していることがあるため残ります。')
    case 'sakura-rental':
      return 'Koto からは削除できません。さくらのレンタルサーバのファイルマネージャか FTP で、'
        + 'アップロードしたファイルを削除してください。'
    default:
      return ''
  }
}

/**
 * 破棄したときに、保存場所のデータがどうなるかを伝える文（確認画面用）。
 *
 * ── なぜ別の文が要るのか（2026-08-14）────────────────────────────────
 * 破棄の確認画面は「アプリとレジストリを消します」としか言っていなかった。
 * だが永続データを使うプロジェクトでは、**利用者が入れたデータも消える**。
 * それを言わずに押させてはいけない。
 *
 * 実際に何が消えるかの判断は `src/shared/objectStorage.ts` の `teardownPlanFor`
 * が中身を一覧してから決める（ほかのプロジェクトや、利用者が自分で置いた
 * ファイルがあれば保存場所そのものは残す）。**ここはその約束を先に伝える**。
 *
 * 画面には素のテキストとして出るので、Markdown 記法は使わない（v0.2.98 の教訓）。
 */
export function teardownDataNote(placement: { bucket: string; prefix?: string; shared?: boolean } | null | undefined): string {
  if (!placement || typeof placement.bucket !== 'string' || placement.bucket.length === 0) return ''
  const head = `保存場所『${placement.bucket}』にある、このプロジェクトのデータも削除します。`
  const keep = 'ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。'
  return placement.shared === false
    ? `${head}${keep}残るものが無ければ、保存場所そのものも削除して月額を止めます。`
    : `${head}${keep}この保存場所を使っているプロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます。`
}

/**
 * その破棄が、**保存場所（バケット・プレフィックス・データ）まで片づけるか**
 * （2026-09-24 検分の指摘7 ／ 2026-09-25 検分で HANAMII を実物に合わせた）。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────
 * 2026-10-08 より前、📡 公開したもの一覧の「🗑 破棄」は、専有型では**アプリだけ**を消す操作で、
 * 保存場所へは1件も要求を出さなかった。にもかかわらず確認画面が「保存場所のデータも削除します…
 * 保存場所そのものも削除して月額を止めます」と出していた時期がある（9/24 検分）。
 * **消えたと思って確認もしない＝いちばん気づけない形で、月額495円が残り続ける。**
 * 確認が言うことと実物がすることは、この関数の答えで揃える。
 *
 * ここに判断を1つだけ置き、📡 の確認も専有型手順6の確認も**同じ関数を通す**（掟10）。
 *
 * 公開先だけで決まる（入口の引数は無い）。0.6.22 段階3B-3 で、入口の範囲を言う `scope`（'list'＝📡 一覧の 🗑・'full'＝専有型の手順6）を
 * やめた。専有型は 2026-10-08 から、手順6も 📡 の 🗑 も同じ流れ（保存場所まで片づける）で、`'full'` を渡す入口は消えたため。
 *
 * ── ⚠️ ここが true でも、実物がそうしている保証にはならない（2026-09-25 検分）──────
 * 2026-09-25 まで HANAMII は**ここだけ true で、実物は保存場所へ1件も要求を出していなかった**
 * （`hanamii:teardown` は HANAMII のプロジェクトを消すだけだった）。確認画面が
 * 「保存場所そのものも削除して月額を止めます」と言い切るので利用者はコントロールパネルを
 * 見に行かず、**月額495円が止まらないまま、消したはずのアプリの鍵がバケットへ
 * 読み書きできるまま生き残っていた**——専有型で直したのとまったく同じ形。
 * いまは `hanamii:teardown` が共用型・専有型と同じ `teardownStorageForProject` を通る。
 *
 * **ここで true にする公開先は、実際に削除の要求を出すことを振る舞いのテストで固定してある**
 * （掟10「お金・破壊の歯止めは、振る舞いで固定する」）:
 *
 * - `sakura-apprun` … `cloud:teardown` → `teardownStorageForProject` ／ tests/sharedTeardownMeasure.test.ts
 * - `hanamii` … `hanamii:teardown` → `teardownStorageForProject` ／ tests/hanamiiStorageTeardown.test.ts
 * - `sakura-apprun-dedicated` … 手順6 と 📡 の 🗑 は同じ `apprunDedicated:teardown`
 *   ／ tests/apprunDedicatedStorageTeardown.test.ts・tests/dedicatedTeardownEntries.test.ts
 *
 * **新しい公開先をここで true にするときは、先に振る舞いのテストを書くこと。**
 */
export function teardownRemovesStorage(target: PublishTargetKind): boolean {
  // 保存場所まで片づけるのは、共用型 AppRun（cloud:teardown が teardownStorageForProject を通る）・
  // HANAMII（hanamii:teardown が teardownStorageForProject を通る）・専有型（2026-10-08 から、手順6と 📡 の 🗑 が同じ
  // apprunDedicated:teardown ＝ teardownProjectStorage を通る）。
  // **片づける側を書き下す。** `!== 'sakura-apprun-dedicated'` のような除外で書くと、
  // 破棄の口すら無い Vercel・レンタルサーバまで「片づけます」側に入り、
  // 公開先を足したときも黙って true に落ちる（掟10「名前の一覧は書き下す」）。
  return target === 'sakura-apprun' || target === 'hanamii' || target === 'sakura-apprun-dedicated'
}

/**
 * 破棄の進み具合（保存場所のデータを削除している間）。
 *
 * 専有型（ipc/apprunDedicatedTeardown.ts）と HANAMII（ipc/hanamiiTeardown.ts）の2か所が**同じ文**を出す。
 * 前は両方に同じ文字列を別々に書いていたので、片方だけ直すと双子が食い違った（0.6.21 の検分）。
 * 「保存場所を削除」と言うと、note が「保存場所は残します」と続く回（利用者のファイルが
 * あってバケットごと消さなかったとき）と矛盾するので、**消すのは「データ」**と言う。
 */
export const STORAGE_TEARDOWN_PROGRESS = '🗄️ 保存場所のデータを削除しています…'

/**
 * 保存場所が残ったとき、コントロールパネルで削除する前の確かめ（**保存場所ごと削除するよう、無条件に勧めない**）。
 *
 * 保存場所は、ほかのプロジェクトも使っていることがある（既定は共有の保存場所）。残ったのは、中身を一覧できなかった・途中で止まったなど、
 * Koto が中身を確かめていない回が多い。そこで「削除してください」とだけ言うと、利用者は保存場所ごと消し、ほかのプロジェクトのデータを
 * 失う（元に戻せない・2026-10-19 検分）。**保存場所が残ったとき、コントロールパネルでの削除を案内する文は、すべてこの1つを通る**
 * （共用型・HANAMII の失敗の message、結果の「直接削除することもできます」の文と赤い欄、片づけない公開先の確認）。
 */
export const STORAGE_CHECK_BEFORE_DELETE = 'ほかのプロジェクトも使っていないか確かめてから削除してください。消すと、そのプロジェクトのデータも消えます。'

/** コントロールパネルでの削除を案内する文（行き先から言う版）。 */
export const STORAGE_PANEL_DELETE_GUIDE = `さくらのクラウドのコントロールパネル（オブジェクトストレージ）で、${STORAGE_CHECK_BEFORE_DELETE}`

/** 「コントロールパネルから直接削除することもできます」の隣に添える版（保存場所が残ったものの一覧があるとき）。 */
export const STORAGE_LISTED_CHECK = `保存場所は、${STORAGE_CHECK_BEFORE_DELETE}`

/**
 * 保存場所1件の削除（またはデータだけの削除）が済んだことの1行。`note` は「保存場所は残します」などの続き。
 * `keptData` が true のときは、**データにも手を付けなかった**（同じ prefix を記録に持つ複製がいる）ので、「削除しました」とは言わない。
 * 共用型・HANAMII・専有型の破棄と、公開の apply の保存場所の削除が、同じこれを通る。
 */
export function storageTeardownDoneLine(bucket: string, note: string, keptData?: boolean): string {
  return keptData === true
    ? `保存場所『${bucket}』のデータは残しました — ${note}`
    : `保存場所『${bucket}』のデータを削除しました — ${note}`
}

/**
 * 破棄の確認画面に出す「保存場所はどうなるか」の一言（`teardownDataNote` の出し分け）。
 *
 * 片づけない破棄では、**残ることと、どこから消せるかを言う**。「言わない」では足りない——
 * 利用者は手順6の確認で見た文面を覚えていて、📡 からでも同じことが起きたと受け取る。
 */
export function teardownDataNoteFor(opts: {
  target: PublishTargetKind
  placement: { bucket: string; prefix?: string; shared?: boolean } | null | undefined
}): string {
  const p = opts.placement
  if (!p || typeof p.bucket !== 'string' || p.bucket.length === 0) return ''
  if (teardownRemovesStorage(opts.target)) return teardownDataNote(p)
  return `保存場所『${p.bucket}』とその中のデータは残ります（消すまで月額が続きます）。`
    + STORAGE_LEFTOVER_GUIDE
}

/**
 * 破棄の確認画面に出す「保存場所はどうなるか」の一言を、**同意済みの保存場所の全件**で組み立てる
 * （2026-09-25 検分の指摘5）。
 *
 * ── なぜ全件なのか ────────────────────────────────────────────────
 * 破棄が消すのは、**確認で見せた（名前を挙げた）保存場所だけ**。見せていないものは消さず、残して `ok:false` で返す
 * （0.6.24 F。`teardownStorageForProject` の `shown`）。見せる側が名指しするのは、消してよい同意済みの保存場所の全件。
 * F の前は、`teardownStorageForProject` が `for (const placement of placements)` で同意済みの**全件**を
 * 片づけていた。ところが確認画面は `storage:placement` の `placement`（**先頭1件**）だけで
 * 文を組み立てていたので、env.json に保存場所が2件ある状態では
 * 「保存場所『A』…のデータも削除します」としか出ないまま、**名前が一度も出なかった『B』と
 * その中のデータまで消えた**。元に戻せない削除を、名指ししないまま実行させてはいけない
 * （掟10「お金・破壊の歯止め」）。**確認で見せるものと、実際に消すものを一致させる**（いまは main も、見せたものだけを消す）。
 *
 * 1件のときは `teardownDataNoteFor` とまったく同じ文を返す（文言を二重管理しない）。
 * 画面には素のテキストとして出るので、Markdown 記法は使わない（v0.2.98 の教訓）。
 */
export function teardownDataNoteForAll(opts: {
  target: PublishTargetKind
  placements: Array<{ bucket: string; prefix?: string; shared?: boolean }> | null | undefined
}): string {
  const list = (opts.placements ?? []).filter(p => p && typeof p.bucket === 'string' && p.bucket.length > 0)
  if (list.length === 0) return ''
  if (list.length === 1) return teardownDataNoteFor({ target: opts.target, placement: list[0] })
  const names = bucketNamesText(list.map(p => p.bucket))
  if (teardownRemovesStorage(opts.target)) {
    return `保存場所${names}にある、このプロジェクトのデータも削除します。`
      + 'ほかのプロジェクトのデータや、あなたが自分で置いたファイルは残します。'
      + 'それぞれの保存場所を使っているプロジェクトがほかに無ければ、保存場所そのものも削除して月額を止めます。'
  }
  return `保存場所${names}とその中のデータは残ります（消すまで月額が続きます）。`
    + STORAGE_LEFTOVER_GUIDE
}

/**
 * 片づけない破棄で「どこから消せるか」を添える。
 *
 * 前は公開先を見て、専有型にだけ「専有型タブの手順6から」と案内していた。専有型の破棄は
 * 2026-10-08 から（どの入口でも）保存場所まで片づけるので、この枝へ来る公開先は専有型ではなくなった。
 * 来るのは破棄の口が別にある公開先だけ＝**無い導線（専有型の手順6）を案内しない**。
 */
const STORAGE_LEFTOVER_GUIDE = STORAGE_PANEL_DELETE_GUIDE
