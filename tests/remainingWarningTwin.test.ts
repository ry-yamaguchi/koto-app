import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  remainingCostWarning, teardownRemainingWarnings, keptSharedRegistryNote, registryDeleteHelp, registryIsOnlyThisProjects,
  REGISTRY_MONTHLY_YEN, BUCKET_MONTHLY_YEN,
} from '../src/shared/cloudCost'
import { toTeardownView, teardownWarningsOf } from '../src/shared/teardownResult'
import { summarizeResult } from '../src/main/projectOps'

// ── 破棄の結果の警告の双子（2026-10-19）──────────────────────────────────────────────────────────────────────────
// 確認の既定・削除の画面の月額の文は、レジストリが「このプロジェクトだけのもの」（owned で借り手なし。registryIsOnlyThisProjects）かで出し分けている。
// なのに破棄の**結果の警告**だけが、残したレジストリ・保存場所を一律に「…の課金は続きます。後で消す場合は、さくらのクラウドのコントロールパネルから
// 削除してください。」と言っていた。借りたレジストリ（作者の手元の「scheduleapp」は5つのプロジェクトが使う）を残した回に、言われたとおり消すと、
// ほかのアプリが動かなくなる。保存場所も同じで、ほかのプロジェクトも使うものを消すと、そのプロジェクトのアプリが止まる。
//
// ここは、返り値の事実（由来・借り手・残した理由）から作る警告の文を、**全文で**固定する（文を作る関数は1つ。3つの公開先・その場・開き直しが同じ道を通る）。
// 本物の main を通した固定（返り値に由来・借り手・理由が載ること）は tests/remainingWarningTwinFlow.test.ts。

const LATER = '後で消す場合は'
const REG = 'scheduleapp'
/** このプロジェクトだけのレジストリ（Koto が作り、ほかが使っていない）を残した回の事実。 */
const OWN = { keptRegistryName: 'myreg', keptRegistryOrigin: 'owned', keptRegistryUsers: [] } as const
const PANEL = 'さくらのクラウドのコントロールパネル'
const FIVE = ['Tsukaisute', 'landingTEST', 'landingtest-2', 'reminder', 'tsukaisute2'] // 作者の手元の実例（scheduleapp を使うプロジェクト）の形

describe('残したレジストリ: 「月額」と「後で消す場合は」を言うのは、このプロジェクトだけのレジストリだけ', () => {
  it('★★★ このプロジェクトだけのもの（owned・借り手なし）を残した回は、今の文のまま（月額・後で消す場合は）', () => {
    expect(teardownRemainingWarnings(OWN)).toEqual([
      `⚠️ コンテナレジストリ『myreg』は残るため、月額${REGISTRY_MONTHLY_YEN}円（税込）の課金は続きます。後で消す場合は、${PANEL}から削除してください。`,
    ])
  })

  // 作者の実例の形: 共用型で、借りた（adopted）「scheduleapp」を、チェックを入れずに（残して）破棄した回
  it('★★★ 作者の実例: 借りた「scheduleapp」を5つのプロジェクトが使っている回を残す → 「後で消す場合は」を言わず、使っているプロジェクトを言う', () => {
    const w = teardownRemainingWarnings({ keptRegistryName: REG, keptRegistryOrigin: 'adopted', keptRegistryUsers: FIVE })
    expect(w).toEqual([`⚠️ コンテナレジストリ『${REG}』は残しました。ほかのプロジェクト（Tsukaisute ほか4件）も使っています。`])
    expect(w[0]).not.toContain(LATER)
    expect(w[0]).not.toContain('削除してください')
    expect(w[0]).not.toContain('月額')
  })

  // 全文で固定する表（言い方が変わったら、ここが落ちる）。どの行にも「後で消す場合は」「削除してください」が無い。
  // 「…ため、残しました」とも言わない（残した理由を Koto が決めたとは限らない: 利用者がチェックを外した回・確認のあとで記録が変わって見送った回もこの文が出る）。
  // 月額（4つ目）は、このプロジェクトのものかもしれない回（作ったか分からない・作ったが借り手を調べられなかった）にだけ言う。
  const MONEY = `（月額${REGISTRY_MONTHLY_YEN}円・税込は続きます）`
  const UNKNOWN_SENTENCE = `⚠️ コンテナレジストリ『${REG}』は残しました${MONEY}。このプロジェクトのために作ったか分かりません。ほかのアプリも使っていることがあります。`
  const SHARED_ROWS: Array<[string, Parameters<typeof teardownRemainingWarnings>[0], string, boolean]> = [
    ['借りた（adopted）・借り手は調べて0件', { keptRegistryName: REG, keptRegistryOrigin: 'adopted', keptRegistryUsers: [] },
      `⚠️ コンテナレジストリ『${REG}』は残しました。このプロジェクトのために作ったものではありません。`, false],
    ['借りた（adopted）・借り手を調べられなかった', { keptRegistryName: REG, keptRegistryOrigin: 'adopted' },
      `⚠️ コンテナレジストリ『${REG}』は残しました。このプロジェクトのために作ったものではありません。`, false],
    ['作ったか分からない（unknown）・借り手は0件', { keptRegistryName: REG, keptRegistryOrigin: 'unknown', keptRegistryUsers: [] }, UNKNOWN_SENTENCE, true],
    ['由来が返り値に無い（旧い返り値）', { keptRegistryName: REG, keptRegistryUsers: [] }, UNKNOWN_SENTENCE, true],
    ['由来が3つのどれでもない値', { keptRegistryName: REG, keptRegistryOrigin: 'mine' as never, keptRegistryUsers: [] }, UNKNOWN_SENTENCE, true],
    ['作った（owned）が、借り手を調べられなかった', { keptRegistryName: 'myreg', keptRegistryOrigin: 'owned' },
      `⚠️ コンテナレジストリ『myreg』は残しました${MONEY}。ほかのプロジェクトが使っていないか確かめられませんでした。`, true],
    ['作った（owned）が、借り手が配列でない値', { keptRegistryName: 'myreg', keptRegistryOrigin: 'owned', keptRegistryUsers: 'reminder' as never },
      `⚠️ コンテナレジストリ『myreg』は残しました${MONEY}。ほかのプロジェクトが使っていないか確かめられませんでした。`, true],
    ['作った（owned）が、1件の借り手がいる', { keptRegistryName: 'myreg', keptRegistryOrigin: 'owned', keptRegistryUsers: ['reminder'] },
      '⚠️ コンテナレジストリ『myreg』は残しました。ほかのプロジェクト（reminder）も使っています。', false],
    ['作った（owned）が、借り手が2件', { keptRegistryName: 'myreg', keptRegistryOrigin: 'owned', keptRegistryUsers: ['reminder', 'landingTEST'] },
      '⚠️ コンテナレジストリ『myreg』は残しました。ほかのプロジェクト（reminder・landingTEST）も使っています。', false],
    ['作った（owned）が、借り手が4件（先頭と件数）', { keptRegistryName: 'myreg', keptRegistryOrigin: 'owned', keptRegistryUsers: ['a', 'b', 'c', 'd'] },
      '⚠️ コンテナレジストリ『myreg』は残しました。ほかのプロジェクト（a ほか3件）も使っています。', false],
    ['借りた（adopted）で借り手が分かっている → 借り手のほうを言う', { keptRegistryName: REG, keptRegistryOrigin: 'adopted', keptRegistryUsers: ['reminder'] },
      `⚠️ コンテナレジストリ『${REG}』は残しました。ほかのプロジェクト（reminder）も使っています。`, false],
    ['作ったか分からない（unknown）で借り手が分かっている → 借り手のほうを言う', { keptRegistryName: REG, keptRegistryOrigin: 'unknown', keptRegistryUsers: ['reminder'] },
      `⚠️ コンテナレジストリ『${REG}』は残しました。ほかのプロジェクト（reminder）も使っています。`, false],
  ]
  it.each(SHARED_ROWS)('★★★ このプロジェクトだけのものでない: %s → 「残しました」の1文だけ（月額の合計に入れない・後で消す場合は・削除の案内・残した理由の断定を言わない）', (_name, facts, sentence, money) => {
    const w = teardownRemainingWarnings(facts)
    expect(w).toEqual([sentence])
    for (const bad of [LATER, '削除してください', 'は残るため', 'コントロールパネル', 'ため、残しました', 'ため残しました']) expect(w[0], bad).not.toContain(bad)
    // 月額は、このプロジェクトのものかもしれない回にだけ言う（お金は削らない）。借りた・ほかが使っていると分かっているものには言わない
    if (money) expect(w[0]).toContain(`月額${REGISTRY_MONTHLY_YEN}円・税込は続きます`)
    else expect(w[0]).not.toContain('月額')
    // 判断は、確認の既定オンと同じ関数（registryIsOnlyThisProjects）。ここが false のものだけが「残しました」になる
    expect(registryIsOnlyThisProjects({ registryName: facts.keptRegistryName as string, origin: facts.keptRegistryOrigin === 'owned' ? 'owned' : 'adopted', otherUsers: Array.isArray(facts.keptRegistryUsers) ? facts.keptRegistryUsers.length : Number.NaN })).toBe(false)
  })

  it('★★ 名前が空のレジストリは「残した」と言わない（名前の無い回は keptRegistryUnnamed が言う）', () => {
    expect(teardownRemainingWarnings({ keptRegistryName: '', keptRegistryOrigin: 'adopted', keptRegistryUsers: [] })).toEqual([])
    expect(teardownRemainingWarnings({ keptRegistryName: null })).toEqual([])
  })

  it('★★ 名前の無い回（keptRegistryUnnamed）は、これまでの文のまま。名前つきの文があれば重ねない', () => {
    expect(teardownRemainingWarnings({ keptRegistryUnnamed: true })).toHaveLength(1)
    expect(teardownRemainingWarnings({ keptRegistryUnnamed: true })[0]).toContain('記録がない')
    expect(teardownRemainingWarnings({ keptRegistryUnnamed: true, ...OWN })).toEqual(teardownRemainingWarnings(OWN))
    expect(teardownRemainingWarnings({ keptRegistryUnnamed: true, keptRegistryName: REG, keptRegistryOrigin: 'adopted', keptRegistryUsers: [] }))
      .toEqual([keptSharedRegistryNote({ registryName: REG, origin: 'adopted', users: [] })])
  })

  it('★★★ このプロジェクトのものでないレジストリは、月額の合計に入れない（保存場所の月額だけを言う）', () => {
    const w = teardownRemainingWarnings({
      keptBucketName: 'koto-data-x', keptBucketNames: ['koto-data-x'], keptBucketsUsedByOthers: ['koto-data-x'],
      keptRegistryName: REG, keptRegistryOrigin: 'adopted', keptRegistryUsers: FIVE,
    })
    expect(w).toHaveLength(2)
    expect(w[0]).toContain(`月額${BUCKET_MONTHLY_YEN}円（税込）`)                      // 保存場所の495円だけ（715円ではない）
    expect(w[0]).not.toContain(`${REGISTRY_MONTHLY_YEN + BUCKET_MONTHLY_YEN}円`)
    expect(w[0]).not.toContain('コンテナレジストリ')
    expect(w[1]).toBe(`⚠️ コンテナレジストリ『${REG}』は残しました。ほかのプロジェクト（Tsukaisute ほか4件）も使っています。`)
  })

  it('★★ このプロジェクトだけのレジストリと保存場所が両方残れば、合算（月額715円）して1つの警告にする', () => {
    const w = teardownRemainingWarnings({ ...OWN, keptBucketName: 'koto-data-x', keptBucketNames: ['koto-data-x'], keptBucketsUsedByOthers: ['koto-data-x'] })
    expect(w).toEqual([
      `⚠️ コンテナレジストリ『myreg』とデータの保存場所『koto-data-x』は残るため、月額${REGISTRY_MONTHLY_YEN + BUCKET_MONTHLY_YEN}円（税込）の課金は続きます。`
      + `コンテナレジストリを後で消す場合は、${PANEL}から削除してください。`
      + 'データの保存場所『koto-data-x』は、ほかのプロジェクトも使っています。消すと、そのプロジェクトのデータも消えます。',
    ])
  })
})

describe('残した保存場所: 月額は言うが、「後で消す場合は削除して」は理由に合わせる', () => {
  const MONTHLY = (n: number) => `月額${BUCKET_MONTHLY_YEN * n}円（税込）の課金は続きます。`
  // 事実だけを言い、「…ため残しました」とは言わない（上の文が「残るため」と言うので「残」が重なる）。
  // ほかのプロジェクトも使う保存場所に言うのは「消すと、そのプロジェクトのデータも消えます」。確かめたのはほかのプロジェクトのデータがあることだけで、アプリがあるか・動いているかは見ていない。
  const OTHERS = 'ほかのプロジェクトも使っています。消すと、そのプロジェクトのデータも消えます。'
  const OWN_FILES = `Koto が作ったのではないファイルがあります。消す前に、${PANEL}で中身を確かめてください。`
  const UNKNOWN = `消す前に、${PANEL}で、使っているプロジェクトが無いか確かめてください。`

  it('★★★ ほかのプロジェクトも使っている → 「使っています。消すと、そのプロジェクトのデータも消えます」。「後で消す場合は」「アプリが止まります」を言わない', () => {
    const w = teardownRemainingWarnings({ keptBucketName: 'koto-data-x', keptBucketsUsedByOthers: ['koto-data-x'] })
    expect(w).toEqual([`⚠️ データの保存場所『koto-data-x』は残るため、${MONTHLY(1)}${OTHERS}`])
    expect(w[0]).not.toContain(LATER)
    expect(w[0]).not.toContain('アプリが止まります') // 確かめていない（そのプロジェクトがアプリを公開しているか・動いているかは見ていない）
  })

  it('★★★ 利用者のファイルがある → 「Koto が作ったのではないファイルがあります。消す前に、中身を確かめてください」', () => {
    const w = teardownRemainingWarnings({ keptBucketName: 'koto-data-x', keptBucketsWithOwnFiles: ['koto-data-x'] })
    expect(w).toEqual([`⚠️ データの保存場所『koto-data-x』は残るため、${MONTHLY(1)}${OWN_FILES}`])
    expect(w[0]).not.toContain(LATER)
  })

  it('★★★ 理由が返り値で分からない（旧い返り値・理由の印なし）→ 分からない側。「消す前に、使っているプロジェクトが無いか確かめてください」', () => {
    const w = teardownRemainingWarnings({ keptBucketName: 'koto-data-x' })
    expect(w).toEqual([`⚠️ データの保存場所『koto-data-x』は残るため、${MONTHLY(1)}${UNKNOWN}`])
    expect(w[0]).not.toContain(LATER)
    // 印の配列が空・別の名前だけ → その保存場所の理由は分からない
    expect(teardownRemainingWarnings({ keptBucketName: 'koto-data-x', keptBucketsUsedByOthers: [], keptBucketsWithOwnFiles: ['other'] })).toEqual(w)
  })

  it('★★ 両方に当てはまる（利用者のファイルもあり、ほかのプロジェクトも使う）→ 消すと止まるほう（ほかが使っている）を言う', () => {
    const w = teardownRemainingWarnings({ keptBucketName: 'koto-data-x', keptBucketsUsedByOthers: ['koto-data-x'], keptBucketsWithOwnFiles: ['koto-data-x'] })
    expect(w).toEqual([`⚠️ データの保存場所『koto-data-x』は残るため、${MONTHLY(1)}${OTHERS}`])
  })

  it('★★ 同じ理由の保存場所が複数 → 名前を並べ、月額は数ぶん。理由の文は1つ（主語を重ねない）', () => {
    const w = teardownRemainingWarnings({ keptBucketNames: ['koto-data-x', 'koto-data-y'], keptBucketsUsedByOthers: ['koto-data-x', 'koto-data-y'] })
    expect(w).toEqual([`⚠️ データの保存場所『koto-data-x』『koto-data-y』は残るため、${MONTHLY(2)}${OTHERS}`])
  })

  it('★★★ 理由が違う保存場所が混ざる → 理由ごとに、どの保存場所かを言う（ほかが使う → 利用者のファイル → 分からない の順）', () => {
    const w = teardownRemainingWarnings({
      keptBucketNames: ['b-unknown', 'b-files', 'b-others'], keptBucketsUsedByOthers: ['b-others'], keptBucketsWithOwnFiles: ['b-files'],
    })
    expect(w).toEqual([
      `⚠️ データの保存場所『b-unknown』『b-files』『b-others』は残るため、${MONTHLY(3)}`
      + 'データの保存場所『b-others』は、ほかのプロジェクトも使っています。消すと、そのプロジェクトのデータも消えます。'
      + `データの保存場所『b-files』には、Koto が作ったのではないファイルがあります。消す前に、${PANEL}で中身を確かめてください。`
      + `データの保存場所『b-unknown』は、消す前に、${PANEL}で、使っているプロジェクトが無いか確かめてください。`,
    ])
  })

  it('★★ keptBucketName と keptBucketNames が重なっても、1つと数える。理由の印も同じ名前で効く', () => {
    const w = teardownRemainingWarnings({ keptBucketName: 'koto-data-x', keptBucketNames: ['koto-data-x'], keptBucketsUsedByOthers: ['koto-data-x'] })
    expect(w).toEqual(teardownRemainingWarnings({ keptBucketName: 'koto-data-x', keptBucketsUsedByOthers: ['koto-data-x'] }))
    expect(w[0].split('koto-data-x').length - 1).toBe(1)
  })

  it('★★ どの理由でも、月額は削らない（お金は言う）', () => {
    for (const facts of [{ keptBucketsUsedByOthers: ['b'] }, { keptBucketsWithOwnFiles: ['b'] }, {}]) {
      const w = teardownRemainingWarnings({ keptBucketName: 'b', ...facts })
      expect(w[0], JSON.stringify(facts)).toContain(`月額${BUCKET_MONTHLY_YEN}円（税込）の課金は続きます`)
    }
  })

  it('★ remainingCostWarning（保存場所だけ）は、理由の印が無ければ分からない側の文', () => {
    expect(remainingCostWarning({ deleteRegistry: true, registryName: null, keptBucketName: 'b' }))
      .toBe(`⚠️ データの保存場所『b』は残るため、${MONTHLY(1)}${UNKNOWN.replace('koto-data-x', 'b')}`)
  })
})

describe('3つの公開先・その場・開き直しが、同じ判断を通る（文の作り手は1つ）', () => {
  const FACTS = {
    ok: true, keptBucketName: 'koto-data-x', keptBucketNames: ['koto-data-x'], keptBucketsUsedByOthers: ['koto-data-x'],
    keptRegistryName: REG, keptRegistryOrigin: 'adopted', keptRegistryUsers: FIVE,
  }
  const EXPECTED = teardownRemainingWarnings(FACTS)

  it('★★★ 共用型・HANAMII・専有型の返り値（その場の画面 toTeardownView）が、同じ事実から同じ警告を作る', () => {
    expect(EXPECTED).toHaveLength(2)
    for (const target of ['sakura-apprun', 'hanamii', 'sakura-apprun-dedicated'] as const) {
      expect(toTeardownView(target, FACTS).warnings, target).toEqual(EXPECTED)
    }
  })

  it('★★★ 開き直したときの記録（summarizeResult が作る警告）も、その場と同じ文。返り値の事実が記録の extra にも残る', () => {
    const rec = summarizeResult(FACTS)
    expect(rec.warnings).toEqual(EXPECTED)
    expect(teardownWarningsOf(FACTS)).toEqual(EXPECTED)
    expect(rec.extra).toMatchObject({
      keptBucketsUsedByOthers: ['koto-data-x'], keptRegistryOrigin: 'adopted', keptRegistryUsers: FIVE,
    })
    expect(rec.warnings.join('')).not.toContain(LATER)
  })

  it('★★★ 返り値に由来・借り手・理由が無い（旧い返り値・形が違う）→ 分からない側（「後で消す場合は」を言わない）', () => {
    const bare = { ok: true, keptBucketName: 'koto-data-x', keptRegistryName: REG }
    const w = toTeardownView('sakura-apprun', bare).warnings
    expect(w.join('')).not.toContain(LATER)
    expect(w[0]).toContain(`月額${BUCKET_MONTHLY_YEN}円`)
    expect(w[1]).toContain('このプロジェクトのために作ったか分かりません')
    // 形の違う値（文字列でない配列・オブジェクト）も、安全側
    const bad = { ok: true, keptRegistryName: REG, keptRegistryOrigin: 7, keptRegistryUsers: [1, 2], keptBucketName: 'b', keptBucketsUsedByOthers: 'b', keptBucketsWithOwnFiles: {} }
    const wb = toTeardownView('hanamii', bad).warnings
    expect(wb.join('')).not.toContain(LATER)
    expect(wb[1]).toContain('このプロジェクトのために作ったか分かりません')
  })

  it('★★ このプロジェクトだけのレジストリの回は、3つの公開先とも今の文のまま（月額・後で消す場合は）', () => {
    for (const target of ['sakura-apprun', 'hanamii', 'sakura-apprun-dedicated'] as const) {
      expect(toTeardownView(target, { ok: true, ...OWN }).warnings, target).toEqual([remainingCostWarning({ deleteRegistry: false, registryName: 'myreg' })])
    }
  })
})

describe('確認の「外したとき」の説明も、同じ判断（registryDeleteHelp）', () => {
  it('★★★ このプロジェクトだけのレジストリにだけ、月額と「後で消す場合は」を言う。それ以外は言わない（空の文字列。「レジストリは残ります。」はチェックの名前の言い直しなので言わない）', () => {
    expect(registryDeleteHelp(false, true)).toBe(`レジストリは残ります。月額${REGISTRY_MONTHLY_YEN}円（税込）の課金は続きます。後で消す場合は、${PANEL}から削除してください。`)
    expect(registryDeleteHelp(false, false)).toBe('')
    // 入れたときの説明は、どちらも同じ
    expect(registryDeleteHelp(true, false)).toBe(registryDeleteHelp(true, true))
  })
})

// ── 文書（README・使い方ガイド）が、実物の文と食い違わない（掟9）──────────────────────────────────────────────────
// 文書が引く言い方は、実物の文から取る（別々に書くと、片方だけ直されても誰も気づかない）。
describe('README・使い方ガイドが言う、残したものの結果の言い方は、実物の文と同じ', () => {
  const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf-8')
  const DOCS = [['README.md', read('README.md')], ['docs/usage-guide.html', read('docs/usage-guide.html')]] as const
  const own = teardownRemainingWarnings(OWN)[0]
  const shared = teardownRemainingWarnings({ keptRegistryName: REG, keptRegistryOrigin: 'adopted', keptRegistryUsers: FIVE })[0]
  const bucket = teardownRemainingWarnings({ keptBucketName: 'b', keptBucketsUsedByOthers: ['b'] })[0]

  it('★★ 実物の文が、文書の引く言い方を持っている', () => {
    expect(own).toContain('後で消す場合は、')
    expect(own).toContain('削除してください')
    expect(shared).toContain('は残しました。')
    expect(bucket).toContain('消すと、そのプロジェクトのデータも消えます')
  })

  it('★★ 文書が、その3つの言い方と「このプロジェクトだけのコンテナレジストリだけ」を言っている', () => {
    for (const [name, doc] of DOCS) {
      expect(doc, name).toContain('「後で消す場合は、…削除してください」と出るのは、このプロジェクトのために Koto が作り、ほかのプロジェクトが使っていないコンテナレジストリだけです')
      expect(doc, name).toContain('「…は残しました。」と事実だけが出ます（月額の合計には入れません。作ったか分からないものと、借り手を調べられなかったものには、月額220円（税込）が続くことも出ます）')
      expect(doc, name).toContain('「消すと、そのプロジェクトのデータも消えます」と出ます')
      expect(doc, name).toContain('削除する前に、ほかのプロジェクトも使っていないか確かめるよう添えます')
    }
  })
})
