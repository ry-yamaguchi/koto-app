// teardown/confirm.ts — 破棄（削除）の確認ダイアログの文を作る純関数（React にも window にも依存しない）。
//
// 段階0で作った部品（いまは3つの公開先〔共用型・HANAMII・専有型〕の入口がすべてこれを通る）。設計書: docs/teardown-unify-plan.md の 10.3.2 (3)。
// 3つの公開先の確認の文は、ここだけが作る（専有型の手本 dedicatedTeardownFlow.ts の buildDedicatedTeardownConfirm と、
// apprunDedicatedActions.ts の teardownConfirmMessage・teardownKindsOf は、0.6.22 段階3B-7 で消した）。
//
// 公開先ごとの違いと、0.6.21 の手本（専有型だけがあった）との違い:
//  1. 文の中の「削除」は verb（'破棄' | '削除'）から作る（次を${verb}します・${verb}すると）。💾 の文は共通の定義のまま変えない。
//  2. 💾 の文は公開先（target）だけで決まる（shared/teardownSupport.ts の teardownRemovesStorage。0.6.22 段階3B-3 で、入口の範囲を言う
//     scope をやめた。手本は 'full' 決め打ちだったが、'full' を HANAMII に渡すと「保存場所とその中のデータは残ります」と事実と逆の文になる罠があった）。
//  3. 「課金は止まります」の一文は、claimsComputeBillingStops が true の公開先だけ言う（HANAMII は原本で確かめていない）。
//  4. 「この操作は元に戻せません」は irreversibleNote で出し分ける（手本は無条件）。
//  5. 保存場所だけが残った回は、先頭の段落を leftoverNote の文に差し替える。
//  6. 保存場所の設定を問い合わせられなかった回（'call'）は、保存場所の名前を挙げられないことと、挙げられない保存場所は削除しないことを言う
//     （0.6.24 F-6。画面は確認で見せた保存場所の組だけを main へ運ぶ〔flow.ts の shownPlacementsOf〕。見せていないものは main が消さない）。
//  7. 「ほかの公開先の記録を読めなかった」注意の例（HANAMII・Vercel・共用型など）は、この公開先自身を除いて作る（手本は専有型の文のまま）。
//  8. 保存場所だけが残った回でも、保存場所の設定を読めない（'settings'・'call'）ときは、先頭の段落を「保存場所だけが残っています」の事実だけにする
//     （main は保存場所に触れないので、仕様書の「残っている保存場所を削除します」を出すと、下の注意と正反対のことを言う）。
//  9. 仕様書が持つ任意の段落（notes。共用型の 🔗 公開URL・レジストリの記録なし・設定から外した保存場所）を、
//     💾・ほかの公開先の段落のあと、時間の予告と最後の問いの前に足す（段階2・2b-1）。notes が無い・空のときの文は 1文字も変えない。
// 10. 確認の見出しは、仕様書が confirmTitleOf を持つときだけ記録の中身で言い換える（共用型で、アプリが無く保存場所・コンテナレジストリだけの回は「保存場所を破棄します」。
//     0.6.24 A-8）。null・持たない仕様書は words.confirmTitle のまま。3つの入口が同じこの関数で確認を作るので、これ1つで全部に効く。
//
// 本文を作る関数は buildTeardownConfirmBody の1つだけ（定義はこのファイル。呼ぶのは buildTeardownConfirm だけ。tests/dedicatedTeardownEntriesF.test.ts が固定する）。

import type { ConfirmOptions } from '../useConfirm'
import type { PublishTargetKind } from '../../shared/publishMeta'
import { teardownDataNoteForAll, bucketNamesText } from '../../shared/teardownSupport'
import { PUBLISH_TARGET_LABEL } from '../publishStatus'
import { PUBLISH_TARGETS_USING_STORAGE } from '../publishRecord'
import type { TargetSpec, TeardownFacts, TeardownPlacement, TeardownWords } from './types'

/**
 * 確認の文に出す、公開先の短い呼び名。表示名（`PUBLISH_TARGET_LABEL`＝絵文字つき）は文の中では長いので、ここで短くする。
 * 保存場所を使わない公開先（レンタルサーバ）は持たない。
 */
const SHORT_TARGET_NAME: Readonly<Partial<Record<PublishTargetKind, string>>> = {
  hanamii: 'HANAMII',
  vercel: 'Vercel',
  'sakura-apprun': '共用型',
  'sakura-apprun-dedicated': '専有型',
}

/**
 * 保存場所を使いうる公開先の呼び名（確認の文に出す）。「読めなかった」注意の例は、この表から**この公開先自身を除いて**作る
 * （自分自身を「ほかの公開先」に数えない）。専有型の確認の例は「HANAMII・Vercel・共用型など」になる。
 *
 * **公開先の一覧と並びは `publishRecord.ts` の `PUBLISH_TARGETS_USING_STORAGE`（保存場所を使いうる公開先の唯一の定義）から作る**
 * （0.6.22 段階3B-3。それまでは手本の文に合わせて Vercel だけ入れていなかった）。ここで書くのは短い呼び名だけ
 * （新しい公開先が一覧に増えて呼び名が無いときは、表示名で挙げる。tests/teardownConfirmTable.test.ts が、呼び名を書き下した表と突き合わせて落ちる）。
 */
export const STORAGE_USING_TARGETS: ReadonlyArray<readonly [PublishTargetKind, string]> =
  PUBLISH_TARGETS_USING_STORAGE.map(kind => [kind, SHORT_TARGET_NAME[kind] ?? PUBLISH_TARGET_LABEL[kind]] as const)

/** この公開先以外の、保存場所を使いうる公開先の呼び名（「・」でつなぐ）。 */
function otherStorageUsersOf(self: PublishTargetKind): string {
  return STORAGE_USING_TARGETS.filter(([kind]) => kind !== self).map(([, label]) => label).join('・')
}

/**
 * 削除するものの**種類**だけを、一覧（`targets`）から取り出す（純関数）。
 * 「アプリ『tsukaisute』」→「アプリ」。一覧の順を保ち、同じ種類は1つにする。
 *
 * 種類は**実際に消すものの一覧から**引く（固定で「アプリ・ロードバランサ…」と書かない）——
 * 一覧に無い種類の課金停止を語ると、無いものの話をする嘘になる。名前（『…』）が付いていない項目は
 * 全体を種類として扱い、種類が空になる項目は数えない。
 */
export function teardownKindsOf(targets: readonly string[]): string[] {
  const kinds: string[] = []
  for (const t of targets) {
    const kind = String(t ?? '').split('『')[0].trim()
    if (kind && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

/**
 * 確認ダイアログの本文（純関数）。
 *
 * - `targets` は消すものの名前。`placements` があるときだけ、一覧に**保存場所の名前（全件）**を足し、`dataNote`
 *   （shared/teardownSupport.ts の teardownDataNoteForAll）を挟む。「ほか◯件」で省かない（名前が出ていないものは、利用者にとって存在しないのと同じ）。
 * - 要素の null・空の bucket は数えない（手本と同じ。`teardownDataNoteForAll` の選び方と揃える）。
 * - 最後の一言は**止まる側**の説明にする（押したら何が止まるのかを言う）。
 * - `leftoverNote` を渡したときは、先頭の段落（「次を{verb}します: …」）だけをその文に差し替える。
 *   公開先のものはもう無いので、`targets` は使わない（一覧にも、課金の一文の種類にも入れない。呼び手が [] を渡す約束に頼らない。
 *   HANAMII の仕様書の targets は、残りの印があるとき [] を返すが、渡されても無視する）。
 *   差し替えるのは先頭の段落だけで、💾・ほかの公開先・課金（保存場所の一文）・元に戻せませんの段落は変わらない。
 */
export function buildTeardownConfirmBody(opts: {
  verb: '破棄' | '削除'
  targets: string[]
  placements: ReadonlyArray<TeardownPlacement | null | undefined> | null | undefined
  dataNote: string
  otherTargets?: string[]
  waitNote?: string
  claimsComputeBillingStops: boolean
  irreversibleNote: 'always' | 'storage-only'
  leftoverNote?: string
  /** 仕様書が足す段落（空の文字列は数えない）。💾・ほかの公開先の段落のあと、時間の予告の前に置く。 */
  notes?: string[]
}): string {
  const { verb } = opts
  // 名前の無いもの（null・空の bucket）は数えない。
  const buckets = (opts.placements ?? [])
    .filter((p): p is TeardownPlacement => !!p && typeof p.bucket === 'string' && p.bucket.length > 0)
    .map(p => p.bucket)
  // 1件なら『A』、2件以上なら『A』『B』。「ほか◯件」で省かない。
  const names = bucketNamesText(buckets)
  const list = buckets.length > 0 ? [...opts.targets, `保存場所${names}にある、このプロジェクトのデータ`] : [...opts.targets]
  // 一覧が空なら、空のまま「次を…します: 」と出さない（何も名前を出していないのに実行を押させない）。
  // leftoverNote のときは targets を使わない（公開先のものはもう無い）。上の list も、下の課金の一文の種類も、その前提で作る。
  const head = opts.leftoverNote
    ? opts.leftoverNote
    : `次を${verb}します: ${list.length > 0 ? list.join('・') : '（記録に名前を挙げられるものがありません）'}`
  const paragraphs = [head]
  if (buckets.length > 0 && opts.dataNote) paragraphs.push(`💾 ${opts.dataNote}`)
  const others = (opts.otherTargets ?? []).filter(t => !!t)
  if (buckets.length > 0 && others.length > 0) {
    // 2件以上あるときだけ「これらの」にする（0.6.22 段階3B-3 の T161 で、公開先の名前を2回並べずに「そちら」にまとめた）。
    paragraphs.push(`⚠️ ${buckets.length > 1 ? 'これらの保存場所' : 'この保存場所'}は ${others.join('・')} でも使っているため、`
      + 'そちらで公開中のアプリのデータも消えます（アプリ自体は消えません）。')
  }
  // 仕様書が足す段落（共用型の 🔗・記録の無いレジストリ・設定から外した保存場所）。
  for (const note of opts.notes ?? []) if (typeof note === 'string' && note) paragraphs.push(note)
  // 課金の文は種類だけ（長い ID は上の一覧で一度出しているので、2回目を並べない）。種類も固定で書かず、同じ一覧から引く。
  // 言ってよいのは claimsComputeBillingStops が true の公開先だけ。保存場所の一文は Koto 自身の判断（teardownPlanFor）なので残す。
  const kinds = teardownKindsOf(opts.leftoverNote ? [] : opts.targets)
  const computeCost = opts.claimsComputeBillingStops && kinds.length > 0 ? `${kinds.join('・')}の課金は止まります。` : ''
  const storageCost = buckets.length > 0 ? '保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。' : ''
  const costLine = [computeCost, storageCost].filter(Boolean).join('')
  // 時間のかかる段の予告は、最後の問いの直前に置く（押す前に読む位置）。
  if (opts.waitNote) paragraphs.push(opts.waitNote)
  const question = costLine ? `${verb}すると、${costLine}よろしいですか？` : 'よろしいですか？'
  if (opts.irreversibleNote === 'always') {
    paragraphs.push(`この操作は元に戻せません。${question}`)
  } else {
    // 'storage-only': 根拠にできるのは、Koto が消す保存場所のデータが戻せないことだけ。保存場所が無い回は言わない。
    paragraphs.push(buckets.length > 0 ? `保存場所にあるデータの削除は元に戻せません。${question}` : question)
  }
  return paragraphs.join('\n\n')
}

/**
 * 確認の材料を読めなかったときの注意（読めた材料だけで確認を出すと、利用者が事実と違う理解で実行を押すため）。
 *
 * ・ほかの公開先の記録を読めなかった: main は、見せた保存場所を、ほかの公開先が使っていても片づける。巻き添えになる公開先の名前を出せない。
 *   **ただし保存場所に触れない回（下の `'settings'`・`'call'`）は、この注意を出さない**（保存場所は消えないので、「そちらのデータも消えます」は事実と逆。0.6.24 R1-e）。
 * ・保存場所の設定を読めなかった（`'settings'`）: **逆に、main も保存場所に触れない**（保存場所の削除は行われず、残る）。
 *   「保存場所も消える」と言うと事実と逆になる。残る保存場所は月額が続くので、そう言う。
 * ・保存場所の設定を**問い合わせられなかった**（`'call'`・IPC の失敗）: 確認で保存場所の名前を挙げられない。
 *   画面は「見せた保存場所」を空にして main へ渡し（flow.ts の `shownPlacementsOf`）、main は見せていない保存場所を削除しない（0.6.24 F）。
 *   なので「名前を挙げられない保存場所は削除しません」と言う。使っていれば残り、月額が続く（これが注意の要点）。
 *   以前は「削除される場合があります」と言い、元に戻せないこと・ほかの公開先のデータも消えることを足していたが、消えなくなったので言わない
 *   （消えない保存場所について「データが消えます」と言うのは事実と逆）。
 *   'settings'（設定そのものを読めない）も、読めた回は変えない。
 *
 * `words` は受け取るだけで、文には使わない。ここで言う「削除」は保存場所のデータの削除で、公開先ごとの言い分け（破棄・削除）とは別の話
 * （手本と同じ文のまま。verb を入れると、保存場所のデータの話まで「破棄」になる）。
 * `irreversibleNote` も、'call' の文が変わったので、いまは使わない（呼び手の形は変えない）。
 * `target` は、ほかの公開先の記録を読めなかったときの例（HANAMII・共用型・専有型）から、この公開先自身を除くために使う
 * （手本は専有型の文をそのまま書いていて、HANAMII の確認が自分を「ほかの公開先」に挙げてしまう）。
 */
export function unreadableCautions(
  facts: Pick<TeardownFacts<unknown>, 'placementsUnreadable' | 'placementsUnreadableCause' | 'otherTargetsUnreadable' | 'otherTargets'>,
  words: TeardownWords,
  irreversibleNote: 'always' | 'storage-only',
  target: PublishTargetKind,
): string[] {
  const out: string[] = []
  if (facts.placementsUnreadable) {
    if (facts.placementsUnreadableCause === 'settings') {
      out.push('⚠️ 保存場所の設定を読めないため、保存場所の削除は行われません。'
        + 'このプロジェクトが保存場所を使っていれば、その保存場所は残り、月額が続きます。'
        + '保存場所も削除したいときは、この確認を閉じて、設定を直してからやり直してください。')
    } else {
      out.push('⚠️ 保存場所の設定を問い合わせられなかったため、保存場所の名前を挙げられません。'
        + '名前を挙げられない保存場所は削除しません（使っていれば残り、月額が続きます）。')
    }
  }
  // 保存場所に触れない回（`placementsUnreadable`。'settings'・'call'）は、巻き添えになる公開先の話をしない。上の文が「保存場所は削除しない」と言っており、
  // 「そちらのアプリのデータも消えます」を並べると、1つの確認の中で正反対のことを言う（0.6.24 R1-e）。
  if (facts.otherTargetsUnreadable && !facts.placementsUnreadable) {
    out.push('⚠️ ほかの公開先の記録を読めなかったため、ここに挙げられません。'
      + `保存場所をほかの公開先（${otherStorageUsersOf(target)}など）が使っていれば、そちらのアプリのデータも消えます。`)
  }
  return out
}

/**
 * 確認ダイアログ（ConfirmModal に渡すもの）。**入口が確認の文を作るのは、これだけにする**（同じ材料なら同じ文。
 * 段階0の時点では、どの入口もまだこれを呼んでいない。最初の利用者は段階1の HANAMII）。
 *
 * 先頭: どのプロジェクトのものを消すか。続けて、材料を読めなかったときの注意（名前を出せないものが消えうることを黙らない）。
 * 文の本体は buildTeardownConfirmBody。保存場所の約束は shared/teardownSupport.ts の teardownDataNoteForAll
 * （公開先だけで決まる）。W-117: ConfirmModal は danger のとき自分で「⚠️ 」を title の前に付ける。ここでは付けない。
 */
export function buildTeardownConfirm<R>(
  spec: Pick<TargetSpec<R, unknown, unknown>, 'target' | 'words' | 'claimsComputeBillingStops' | 'irreversibleNote' | 'targets' | 'leftoverNote' | 'notes' | 'confirmTitleOf'>,
  facts: TeardownFacts<R>,
): Required<Pick<ConfirmOptions, 'title' | 'body' | 'confirmLabel' | 'danger'>> {
  // 保存場所だけが残った回でも、保存場所の設定を読めない（'settings'）・問い合わせられなかった（'call'）ときは、main が保存場所に触れない（残る。
  // 画面が見せた保存場所の組は空で、main は見せていないものを消さない。0.6.24 F）。
  // 仕様書の leftoverNote は「残っている保存場所を削除します」と言う文なので、そのまま先頭に置くと、下の注意
  // （保存場所の名前を挙げられない・削除しない）と1つの確認の中で正反対のことを言う。この回は、事実だけを言う文に替える。
  const leftover = spec.leftoverNote?.(facts.record) ?? undefined
  const storageUntouched = facts.placementsUnreadable
  const leftoverNote = leftover && storageUntouched ? `前回の${spec.words.verb}で、保存場所だけが残っています。` : leftover
  const body = buildTeardownConfirmBody({
    verb: spec.words.verb,
    targets: spec.targets(facts.record),
    placements: facts.placements,
    dataNote: teardownDataNoteForAll({ target: spec.target, placements: facts.placements }),
    otherTargets: facts.otherTargets,
    waitNote: facts.waitNote ?? undefined,
    claimsComputeBillingStops: spec.claimsComputeBillingStops,
    irreversibleNote: spec.irreversibleNote,
    leftoverNote,
    notes: spec.notes?.(facts.record),
  })
  const head = [`対象のプロジェクト: 『${facts.projectName}』`, ...unreadableCautions(facts, spec.words, spec.irreversibleNote, spec.target)].join('\n\n')
  // 見出しは、仕様書が記録の中身で言い換えるとき（confirmTitleOf。共用型で、アプリが無く保存場所・コンテナレジストリだけの回。0.6.24 A-8）はそれを先に使う。
  const title = spec.confirmTitleOf?.(facts.record) ?? spec.words.confirmTitle
  return { title, body: `${head}\n\n${body}`, confirmLabel: spec.words.confirmLabel, danger: true }
}
