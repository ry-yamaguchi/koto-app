import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  hasMeaningfulValue, describeLeftoverData, describeLeftoverSites, isLeftoverDataFile,
  shouldAskLeftoverData, askAiMoveDataText, askAiMoveDataPlan,
  shouldLookForLeftoverData, leftoverScanLine, SQLITE_EMPTY_MAX_BYTES,
  LEFTOVER_DATA_HEADING, LEFTOVER_DATA_MOVE_LABEL, LEFTOVER_DATA_MOVE_NOTE,
  LEFTOVER_DATA_SKIP_LABEL, LEFTOVER_DATA_SKIP_NOTE,
  LEFTOVER_DATA_ASK_AI_NOTE, LEFTOVER_DATA_SKIP_LATER_NOTE,
} from '../src/shared/leftoverData'
import { rewriteCheckLine, rewriteCheckDone, KEEP_SHAPE, dataLayerUsageLine } from '../src/shared/storageNoticeText'
import { storageNeedFor } from '../src/shared/storageNeed'

// ── 2026-09-23、実機で起きたこと（作者 Ryosuke さん・ScheduleAPP）──────────────
//
// AI がアプリを koto-data へ書き直すと、**それまでに入力されたデータは引き継がれない**。
// 実機では合言葉が 2D88A8 → 8FC36D に変わった（アプリが古い保存を見つけられず作り直した
// ＝**配った合言葉が通じなくなる**）。中身が空だったので実害は無かったが、参加者が
// 入っていれば見えなくなっていた。
//
// **⚠️ そして、その古い保存は「件数だけ見れば空」だった**:
//
//     { "joinCode": "2D88A8", "dates": [], "entries": [] }
//
// 日程0件・参加者0件で、**合言葉だけ**。一覧の件数で判断すると「空だから知らせなくて
// よい」に倒れる。ここで固定するのは、その取りこぼしを二度と起こさないこと。

/** 実機の ScheduleAPP に残っていた古い保存（そのまま）。 */
const REAL_OLD_SAVE = '{ "joinCode": "2D88A8", "dates": [], "entries": [] }'

describe('「中身がある」を、件数だけで判断しない', () => {
  // ★ 今回の核心。合言葉だけでも、消えれば利用者が困る
  it('合言葉だけが入っている（配列は空）古いデータでも「中身がある」', () => {
    const found = describeLeftoverData({ file: 'data/schedule.json', text: REAL_OLD_SAVE, size: REAL_OLD_SAVE.length })
    expect(found).not.toBeNull()
    expect(found!.file).toBe('data/schedule.json')
    // 依頼文に渡す手がかりに、合言葉があることと配列が空なことの両方が出る
    expect(found!.detail).toContain('joinCode あり')
    expect(found!.detail).toContain('dates 0件')
    expect(found!.detail).toContain('entries 0件')
  })

  it('★ 値そのものの判定: 空の配列・空のオブジェクト・空文字は「中身が無い」', () => {
    expect(hasMeaningfulValue({})).toBe(false)
    expect(hasMeaningfulValue({ a: [] })).toBe(false)
    expect(hasMeaningfulValue({ a: [], b: {}, c: '', d: null })).toBe(false)
    expect(hasMeaningfulValue([])).toBe(false)
    expect(hasMeaningfulValue([[], {}])).toBe(false)
    expect(hasMeaningfulValue('')).toBe(false)
    expect(hasMeaningfulValue('   ')).toBe(false)
    expect(hasMeaningfulValue(null)).toBe(false)
    expect(hasMeaningfulValue(undefined)).toBe(false)
  })

  it('★ 値そのものの判定: 小さな設定・数値・false でも「中身がある」', () => {
    expect(hasMeaningfulValue({ joinCode: '2D88A8', dates: [], entries: [] })).toBe(true)
    expect(hasMeaningfulValue({ count: 0 })).toBe(true)
    expect(hasMeaningfulValue({ open: false })).toBe(true)
    expect(hasMeaningfulValue([{ a: [] }, { b: 'x' }])).toBe(true)
  })

  it('★ 本当に空なら「中身がある」としない（空振りの問い合わせをしない）', () => {
    expect(describeLeftoverData({ file: 'data/a.json', text: '{}', size: 2 })).toBeNull()
    expect(describeLeftoverData({ file: 'data/a.json', text: '{"a":[]}', size: 8 })).toBeNull()
    expect(describeLeftoverData({ file: 'data/a.json', text: '""', size: 2 })).toBeNull()
    expect(describeLeftoverData({ file: 'data/a.json', text: '   ', size: 3 })).toBeNull()
    expect(describeLeftoverData({ file: 'data/a.json', text: '[]', size: 2 })).toBeNull()
  })

  it('中身をテキストとして読めない保存（.db 等）は、大きさで見る', () => {
    // 行が入れば表のページが別に要るので、2ページ目（8192バイト）以上になる
    expect(describeLeftoverData({ file: 'data/schedule.db', text: null, size: 8192 })).not.toBeNull()
    expect(describeLeftoverData({ file: 'data/schedule.db', text: null, size: 0 })).toBeNull()
  })

  // ★ 実機の data/schedule.db は 4096バイト＝SQLite 1ページぶん（表の定義だけ）だった。
  //    これを「中身あり」にすると、**1件も入っていないアプリでも必ず**問いが出る
  //    （＝仕様が禁じている空振りの問い合わせ。AI に「移しました」と嘘をつかせる余地）
  it('★ 空のデータベース（1ページ＝4096バイト）では問いの材料にしない', () => {
    expect(SQLITE_EMPTY_MAX_BYTES).toBe(4096)
    expect(describeLeftoverData({ file: 'data/schedule.db', text: null, size: 4096 })).toBeNull()
    expect(describeLeftoverData({ file: 'data/schedule.db', text: null, size: 1 })).toBeNull()
    expect(describeLeftoverData({ file: 'data/old.sqlite', text: null, size: 4096 })).toBeNull()
    // 1バイトでも超えれば、中身が入っている側に倒す
    expect(describeLeftoverData({ file: 'data/schedule.db', text: null, size: 4097 })).not.toBeNull()
  })

  it('データらしきものに絞る（画像やコードは対象にしない）', () => {
    expect(isLeftoverDataFile('data/schedule.json')).toBe(true)
    expect(isLeftoverDataFile('data/schedule.db')).toBe(true)
    expect(isLeftoverDataFile('data/old.sqlite')).toBe(true)
    expect(isLeftoverDataFile('data/list.csv')).toBe(true)
    expect(isLeftoverDataFile('public/logo.png')).toBe(false)
    expect(isLeftoverDataFile('server.js')).toBe(false)
    expect(isLeftoverDataFile('README.md')).toBe(false)
  })

  // ★ 設定は「利用者が入れたデータ」ではない。参照の無い設定 JSON で問いを出すと、
  //    依頼文がそれを名指しして「koto-data の保存へ入れて」と頼むことになる
  it('★ 設定ファイルは「いま入っているデータ」に数えない', () => {
    expect(isLeftoverDataFile('.eslintrc.json')).toBe(false)
    expect(isLeftoverDataFile('src/.prettierrc.json')).toBe(false)
    expect(isLeftoverDataFile('package.json')).toBe(false)
    expect(isLeftoverDataFile('package-lock.json')).toBe(false)
    expect(isLeftoverDataFile('tsconfig.json')).toBe(false)
    expect(isLeftoverDataFile('tsconfig.build.json')).toBe(false)
    expect(isLeftoverDataFile('vite.config.json')).toBe(false)
    expect(isLeftoverDataFile('vercel.json')).toBe(false)
    // **利用者が入れたデータは、従来どおり拾う**（倒しすぎない）
    expect(isLeftoverDataFile('data/schedule.json')).toBe(true)
    expect(isLeftoverDataFile('locales/ja.json')).toBe(true)
    expect(describeLeftoverData({ file: 'package.json', text: '{"name":"x"}', size: 12 })).toBeNull()
  })

  it('壊れた入力でも落ちない', () => {
    expect(() => describeLeftoverData(null as never)).not.toThrow()
    expect(() => describeLeftoverData({ file: '', text: null, size: 0 })).not.toThrow()
    expect(() => hasMeaningfulValue((() => 1) as never)).not.toThrow()
    expect(() => describeLeftoverSites(null as never)).not.toThrow()
  })
})

describe('この問いを出すかどうか', () => {
  const found = [{ file: 'data/schedule.json', detail: 'joinCode あり' }]

  it('★ 書き直せていないときは出さない（まず書き直しが先）', () => {
    expect(shouldAskLeftoverData({ rewritten: false, files: found, answered: false })).toBe(false)
    expect(shouldAskLeftoverData({ files: found })).toBe(false)
  })

  it('★ 古いデータが無いときは出さない', () => {
    expect(shouldAskLeftoverData({ rewritten: true, files: [], answered: false })).toBe(false)
    expect(shouldAskLeftoverData({ rewritten: true, files: null, answered: false })).toBe(false)
  })

  it('★ 選んだあとは出し直さない（毎回聞かれると鬱陶しい）', () => {
    expect(shouldAskLeftoverData({ rewritten: true, files: found, answered: true })).toBe(false)
  })

  it('書き直せていて、中身のある古いデータがあるときだけ出す', () => {
    expect(shouldAskLeftoverData({ rewritten: true, files: found, answered: false })).toBe(true)
  })
})

describe('「書き直せた（✅）」の判断は、文面から拾わない', () => {
  const cases = [
    { usesDataLayer: true, writesFiles: [] },
    { usesDataLayer: true, writesFiles: [], truncated: true },
    { usesDataLayer: false, writesFiles: [] },
    { usesDataLayer: true, writesFiles: [{ file: 'server.js', lines: [66] }] },
    { usesDataLayer: false, writesFiles: [{ file: 'server.js', lines: [66] }] },
  ]

  // ★ 文言を1文字直した瞬間に問いが出なくなる、という壊れ方を防ぐ（掟10）
  it('rewriteCheckDone は rewriteCheckLine の ✅ と必ず一致する', () => {
    for (const c of cases) {
      expect(rewriteCheckDone(c)).toBe(rewriteCheckLine(c).startsWith('✅'))
    }
    expect(rewriteCheckDone(null)).toBe(false)
  })
})

describe('画面に出す文（作者が2回直して確定したもの）', () => {
  it('★ 確定した文面そのもの', () => {
    expect(LEFTOVER_DATA_HEADING).toBe('💾 いま入っているデータをどうしますか')
    expect(LEFTOVER_DATA_MOVE_LABEL).toBe('一緒に移してもらう')
    expect(LEFTOVER_DATA_MOVE_NOTE).toBe('これまでのデータがそのまま使えます')
    expect(LEFTOVER_DATA_SKIP_LABEL).toBe('移さない')
    expect(LEFTOVER_DATA_SKIP_NOTE).toBe('空の状態から始めます')
  })

  // ★ 利用者はファイルを意識していない。意識しているのは「自分が入れたデータ」
  it('★ 画面の文にファイル名が出てこない', () => {
    const shown = [
      LEFTOVER_DATA_HEADING, LEFTOVER_DATA_MOVE_LABEL, LEFTOVER_DATA_MOVE_NOTE,
      LEFTOVER_DATA_SKIP_LABEL, LEFTOVER_DATA_SKIP_NOTE,
      LEFTOVER_DATA_ASK_AI_NOTE, LEFTOVER_DATA_SKIP_LATER_NOTE,
    ].join('\n')
    expect(shown).not.toContain('.json')
    expect(shown).not.toContain('.db')
    expect(shown).not.toContain('schedule')
    expect(shown).not.toContain('koto-data')
    // 落とすと決めた2文が復活していないこと
    expect(shown).not.toContain('読まなくなります')
    expect(shown).not.toContain('ファイルは消えません')
  })

  it('画面には素のテキストとして出る（Markdown 記法を使わない）', () => {
    const shown = [
      LEFTOVER_DATA_HEADING, LEFTOVER_DATA_MOVE_NOTE, LEFTOVER_DATA_SKIP_NOTE,
      LEFTOVER_DATA_ASK_AI_NOTE, LEFTOVER_DATA_SKIP_LATER_NOTE,
    ].join('\n')
    expect(shown).not.toContain('**')
    expect(shown).not.toContain('`')
  })

  // ★ 押すとチャットに文面が入るだけで、送信するのは利用者。書き直しの枠と同じ言い回しで
  //    伝える（この枠に無かったので、押した人には何が起きたのか分からなかった）
  it('★ 押すと何が起きるかを伝える1行がある（書き直しの枠と同じ言い回し）', () => {
    // W-39（2026-09-27 決定・別案）: 読めない依頼文を「確かめて」と言われて不安になるより、
    // 何のためのものかと、送るとAIが動き出すことを伝える。
    expect(LEFTOVER_DATA_ASK_AI_NOTE).toBe('チャットに AI へのお願いが入ります（中身は AI 向けの指示です）。送信すると AI が作業を始めます。')
    const NOTICE_SRC = readFileSync(join(__dirname, '..', 'src/renderer/components/StorageNotice.tsx'), 'utf-8')
    expect(NOTICE_SRC).toContain('チャットに AI へのお願いが入ります（中身は AI 向けの指示です）。送信すると AI が作業を始めます。')
  })

  // ★ 「移さない」は覚えるので二度と出ない。戻る道があることだけは伝える
  it('★ 「移さない」の側に、あとから頼めることを伝える1行がある', () => {
    expect(LEFTOVER_DATA_SKIP_LATER_NOTE).toBe('あとでチャットから頼むこともできます。')
    expect(LEFTOVER_DATA_SKIP_LATER_NOTE).not.toContain('.json')
  })
})

describe('「一緒に移してもらう」で AI へ渡す依頼文', () => {
  const found = [
    { file: 'data/schedule.json', detail: 'joinCode あり、dates 0件、entries 0件' },
    { file: 'data/schedule.db', detail: '4096バイト' },
  ]

  // ★ Koto が知っている事実を渡さないと、AI は記憶で答えて嘘をつく（2026-09-23 の教訓）
  it('★ 見つけた場所（ファイル名と件数）が入る', () => {
    const text = askAiMoveDataText(found)
    expect(text).toContain('data/schedule.json')
    expect(text).toContain('joinCode あり')
    expect(text).toContain('dates 0件')
    expect(text).toContain('data/schedule.db')
  })

  it('★ 「読み直して確かめてから完了と答えて」が入る', () => {
    const text = askAiMoveDataText(found)
    expect(text).toContain('読み直して')
    expect(text).toContain('確かめてから')
    expect(text).toContain('完了と答えて')
  })

  // ★ Koto の片づけは全部「移動・戻せる」。依頼文でも消させない
  it('★ 古いファイルを消さないよう頼んでいる', () => {
    expect(askAiMoveDataText(found)).toContain('古いファイルは消さないでください')
  })

  it('形が分からないところを勝手に捨てさせない（黙ってデータを壊さない）', () => {
    expect(askAiMoveDataText(found)).toContain('勝手に捨て')
  })

  it('多すぎるときは「ほかN件」にまとめる', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ file: `data/a${i}.json`, detail: `${i}件` }))
    const text = askAiMoveDataText(many)
    expect(text).toContain('data/a0.json')
    expect(text).toContain('data/a4.json')
    expect(text).toContain('ほか2件')
    expect(text).not.toContain('data/a5.json')
  })

  it('場所が無ければ、あるかのように書かない（嘘を書かない）', () => {
    const text = askAiMoveDataText([])
    // 見つかってもいないファイル名・件数を、あるかのように書かない
    // （`package.json` は「形を変えないで」のお願いに出るだけなので、そこは除いて見る）
    expect(text.split(KEEP_SHAPE).join('')).not.toContain('.json')
    expect(text).not.toContain('件）')
    expect(text).toContain('完了と答えて')
  })

  it('Markdown 記法を使わない', () => {
    const text = askAiMoveDataText(found)
    expect(text).not.toContain('**')
    expect(text).not.toContain('`')
  })

  // ★ 2026-09-23 の事故: 形を言わなかったために AI が "type": "module" を足し、
  //    実機アプリが起動しなくなった。移行を書く AI も同じ読み込みの壁にぶつかる
  //    （しかもデータを移している最中なので、起きれば被害が重なる）
  it('★ 読み込み方（import / require）と「type を変えない」が、書き直しの依頼文と同じく入る', () => {
    const esm = askAiMoveDataText(found, 'esm')
    expect(esm).toContain(dataLayerUsageLine('esm'))
    expect(esm).toContain(KEEP_SHAPE)

    const cjs = askAiMoveDataText(found, 'cjs')
    expect(cjs).toContain(dataLayerUsageLine('cjs'))
    expect(cjs).toContain(KEEP_SHAPE)
    // require のアプリに import の形を渡さない（これが起動しなくなる引き金だった）
    expect(cjs).not.toContain(dataLayerUsageLine('esm'))
  })

  // ★ 手元で移しても公開したアプリには届かない（KOTO_STORAGE_* は公開のときだけ渡る。
  //    手元の .koto-data は公開除外なので、バケットへ運ぶ経路がどこにも無い）
  it('★ 手元のスクリプトで移させない（アプリ自身が起動時に取り込む形を頼む）', () => {
    const text = askAiMoveDataText(found)
    expect(text).toContain('手元で移すスクリプトを書いて動かすのではなく')
    expect(text).toContain('アプリ自身が起動したときに一度だけ取り込む')
    // 二度目以降の起動で、公開先のデータを上書きさせない
    expect(text).toContain('まだ1件も入っていないときだけ')
    expect(text).toContain('1件でも入っていれば、何もしないでください')
  })
})

describe('「一緒に移してもらう」を送ってよいか（書き直しと同じ作法）', () => {
  const found = [{ file: 'data/schedule.json', detail: 'joinCode あり' }]

  // ★ 読み込み先が無いまま頼むと、AI は読み込めるようにしようとして package.json を触る
  it('★ koto-data が用意できていなければ送らない', () => {
    for (const layer of [null, undefined, {}, { ok: true }, { ok: true, ready: false }, { ok: false, ready: true }]) {
      const plan = askAiMoveDataPlan(found, layer as never)
      expect(plan.send).toBe(false)
    }
  })

  it('用意できていれば、その形（import / require）の依頼文を送る', () => {
    const plan = askAiMoveDataPlan(found, { ok: true, ready: true, moduleKind: 'cjs' })
    expect(plan.send).toBe(true)
    if (plan.send) {
      expect(plan.text).toContain(dataLayerUsageLine('cjs'))
      expect(plan.text).toContain(KEEP_SHAPE)
    }
  })

  it('送れないときの文に、内部の言い回しをそのまま出さない（括弧で補うだけ）', () => {
    const plan = askAiMoveDataPlan(found, { ok: false, message: 'ENOENT' })
    expect(plan.send).toBe(false)
    if (!plan.send) {
      expect(plan.error).toContain('（ENOENT）')
      expect(plan.error).toContain('もう一度お試しください')
    }
  })
})

// ── 2026-09-24 検分の核心: 「書き直したあとに ③公開 を開き直すと、問いが二度と出ない」──
describe('★ 移した／移さないを選ぶまでは、③公開を開けば必ず問いが出る', () => {
  const found = [{ file: 'data/schedule.json', detail: 'joinCode あり' }]
  /** 書き直しが済んだあとの走査結果（ファイルへの書き込みは無く、koto-data を使っている）。 */
  const afterRewrite = { usesDataLayer: true, writesFiles: [] as { file: string; lines: number[] }[] }

  it('★ 書き直しが済むと warn は下りる（＝その場の 🔎 の結果には頼れない）', () => {
    const need = storageNeedFor({ usesDataLayer: true, writesFiles: false, target: 'sakura-apprun' })
    expect(need.kind).toBe('declared')
    // warn（⚠️ データが消えてしまいます）は will-lose-data のときだけ
    expect(need.kind === 'will-lose-data').toBe(false)
  })

  it('★ warn が下りた状態で開き直しても、古いデータを探しに行く', () => {
    expect(shouldLookForLeftoverData(afterRewrite, false)).toBe(true)
    // 探した結果があれば、問いはそのまま出る
    expect(shouldAskLeftoverData({ rewritten: true, files: found, answered: false })).toBe(true)
  })

  it('★ もう選んだあとは探しに行かない（毎回聞かれると鬱陶しい）', () => {
    expect(shouldLookForLeftoverData(afterRewrite, true)).toBe(false)
  })

  it('★ 書き直せていないときは探しに行かない（まず書き直しが先）', () => {
    expect(shouldLookForLeftoverData({ usesDataLayer: true, writesFiles: [{ file: 'server.js', lines: [66] }] }, false)).toBe(false)
    expect(shouldLookForLeftoverData({ usesDataLayer: false, writesFiles: [] }, false)).toBe(false)
    // 全部は調べられていないなら、済んだ扱いにしない
    expect(shouldLookForLeftoverData({ ...afterRewrite, truncated: true }, false)).toBe(false)
    expect(shouldLookForLeftoverData(null, false)).toBe(false)
  })

  // ★ 判断は rewriteCheckDone と必ず同じ（片方だけ直して食い違う、を防ぐ）
  it('★ 探しに行く条件は「✅ 書き直せている」と一致する', () => {
    const cases = [
      { usesDataLayer: true, writesFiles: [] },
      { usesDataLayer: true, writesFiles: [], truncated: true },
      { usesDataLayer: false, writesFiles: [] },
      { usesDataLayer: true, writesFiles: [{ file: 'server.js', lines: [66] }] },
    ]
    for (const c of cases) expect(shouldLookForLeftoverData(c, false)).toBe(rewriteCheckDone(c))
  })
})

describe('★ 探せなかったときに、黙って「無かった」に倒さない', () => {
  it('★ 調べられなかったら、そう言う（rewriteCheckLine と同じ作法）', () => {
    const line = leftoverScanLine({ ok: false, message: 'EPERM' })
    expect(line).toContain('確かめられませんでした')
    expect(line).toContain('もう一度お試しください')
    // 内部の言い回しはそのまま出さず、括弧書きの補足にとどめる
    expect(line).toContain('（EPERM）')
    expect(leftoverScanLine(null)).toContain('確かめられませんでした')
    expect(leftoverScanLine(undefined)).toContain('確かめられませんでした')
  })

  it('★ 全部は調べられなかったときは断定しない（打ち切りを捨てない）', () => {
    const line = leftoverScanLine({ ok: true, truncated: true, files: [] } as never)
    expect(line).toContain('全部は調べられませんでした')
    expect(line).not.toContain('見つかりませんでした')
  })

  it('ちゃんと全部見られたときは、何も言わない（余計な行を増やさない）', () => {
    expect(leftoverScanLine({ ok: true, truncated: false, referenced: 0 })).toBe('')
    expect(leftoverScanLine({ ok: true })).toBe('')
  })

  it('Markdown 記法を使わない', () => {
    for (const line of [leftoverScanLine({ ok: false }), leftoverScanLine({ ok: true, truncated: true })]) {
      expect(line).not.toContain('**')
      expect(line).not.toContain('`')
    }
  })
})

// ── ここから下は「呼ぶ側」の固定（掟10。純関数にテストがあっても、呼ばれていなければ
//    画面には何も起きない。2026-09-24 の storagePrepareWiring.test.ts と同じ理由）────

const NOTICE = readFileSync(join(__dirname, '..', 'src/renderer/components/StorageNotice.tsx'), 'utf-8')
const UNUSED = readFileSync(join(__dirname, '..', 'src/main/ipc/unused.ts'), 'utf-8')
const CLOUD = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')
const PRELOAD = readFileSync(join(__dirname, '..', 'src/main/preload.ts'), 'utf-8')

/** 「💾 いま入っているデータをどうしますか」を出している JSX の塊だけを切り出す。 */
function leftoverBlock(): string {
  const start = NOTICE.indexOf('shouldAskLeftoverData({')
  expect(start).toBeGreaterThan(-1)
  const end = NOTICE.indexOf('</div>\n      )}', start)
  expect(end).toBeGreaterThan(start)
  return NOTICE.slice(start, end)
}

/** 「一緒に移してもらう」を押したときの処理だけを切り出す。 */
function moveHandler(): string {
  const start = NOTICE.indexOf('const moveDataWithAi = async () => {')
  expect(start).toBeGreaterThan(-1)
  return NOTICE.slice(start, NOTICE.indexOf('\n  }', start))
}

/** 「移さない」を押したときの処理だけを切り出す。 */
function skipHandler(): string {
  const start = NOTICE.indexOf('const skipMoveData = () => {')
  expect(start).toBeGreaterThan(-1)
  return NOTICE.slice(start, NOTICE.indexOf('\n  }', start))
}

describe('画面の側（StorageNotice）', () => {
  it('★ 問いの JSX にファイル名を出す式が無い（確定した文面だけを出す）', () => {
    const block = leftoverBlock()
    expect(block).toContain('LEFTOVER_DATA_HEADING')
    expect(block).toContain('LEFTOVER_DATA_MOVE_LABEL')
    expect(block).toContain('LEFTOVER_DATA_SKIP_LABEL')
    // 見つけた場所は **AI への依頼文にだけ** 使う
    expect(block).not.toContain('describeLeftoverSites')
    expect(block).not.toContain('leftover.map')
    expect(block).not.toContain('.file')
    expect(block).not.toContain('.detail')
  })

  it('★ 出すかどうかは純関数に決めさせる（画面で条件を組み立て直さない・掟10）', () => {
    expect(NOTICE).toContain('shouldAskLeftoverData({ rewritten: rewriteDone, files: leftover, answered: leftoverAnswered })')
  })

  it('★ ✅（書き直せている）を返したときだけ、古いデータを探しに行く', () => {
    // 探しに行く口は**1か所だけ**（lookForLeftover）で、そこが純関数に判断させる
    expect(NOTICE.split('storage.leftoverData(').length - 1).toBe(1)
    const start = NOTICE.indexOf('const lookForLeftover = async (')
    expect(start).toBeGreaterThan(-1)
    const body = NOTICE.slice(start, NOTICE.indexOf('storage.leftoverData(', start))
    expect(body).toContain('shouldLookForLeftoverData(scan, answered)')
  })

  // ★ 2026-09-24 検分の核心。書き直しが成功すると warn が下りて 🔎 ごと消え、
  //    モーダルは閉じるたびに作り直される。**開いた時点でも探さないと、二度と出ない**
  it('★ ③公開を開いた時点（useEffect）でも、古いデータを探しに行く', () => {
    const start = NOTICE.indexOf('useEffect(() => {')
    expect(start).toBeGreaterThan(-1)
    const body = NOTICE.slice(start, NOTICE.indexOf('}, [projectDir, target])', start))
    // 開いた時点の走査結果でも ✅ を判定し、そのまま探しに行く
    expect(body).toContain('setRewriteDone(rewriteCheckDone(result))')
    expect(body).toContain('await lookForLeftover(result, answered)')
    expect(body).toContain('setLeftover(found.files)')
  })

  // ★ 書き直し済み（warn=false）でも押せないと、問いへ戻る道が無くなる
  it('★ 「🔎 書き直せたか確かめる」は warn の外にある', () => {
    const at = NOTICE.indexOf("'🔎 書き直せたか確かめる'")
    expect(at).toBeGreaterThan(-1)
    // このボタンより前で、直近の warn の条件が閉じている
    const lastWarn = NOTICE.lastIndexOf('warn && (', at)
    expect(lastWarn).toBeGreaterThan(-1)
    expect(NOTICE.slice(lastWarn, at)).toContain(')}')
  })

  it('★ 「一緒に移してもらう」は AI に頼む（既存の sakura:ask-ai をそのまま使う・掟7）', () => {
    const body = moveHandler()
    expect(body).toContain("'sakura:ask-ai'")
    // 送ってよいかの判断も、依頼文の組み立ても純関数に任せる（掟10）
    expect(body).toContain('askAiMoveDataPlan(leftover, layer)')
    expect(body).toContain('if (!plan.send)')
    // Koto が自分で移さない（形を当てそこねると、黙ってデータを壊す）
    expect(body).not.toContain('moveFiles')
    expect(body).not.toContain('writeFile')
  })

  // ★ require で動くアプリに import の形を渡すと、AI が package.json を触って
  //    アプリが起動しなくなる（2026-09-23 実機）。書き直しの依頼文と同じ作法にする
  it('★ 依頼文を作る前に、実際に置いた koto-data の形を取りに行く', () => {
    const body = moveHandler()
    expect(body).toContain('storage.ensureLayer(projectDir)')
    expect(NOTICE.indexOf('storage.ensureLayer(projectDir)', NOTICE.indexOf('const moveDataWithAi')))
      .toBeLessThan(NOTICE.indexOf('askAiMoveDataPlan(leftover, layer)'))
  })

  it('★ 「移さない」は何もしない（ファイルを消さない・移さない）', () => {
    const body = skipHandler()
    expect(body).not.toContain('electronAPI')
    expect(body).not.toContain('delete')
    expect(body).not.toContain('remove')
    expect(body).not.toContain('unlink')
    expect(body).not.toContain('moveFiles')
    expect(body).not.toContain('moveToMaterials')
    // 覚えておくだけ（＝出し直さない）
    expect(body).toContain('setLeftoverAnswered(true)')
    expect(body).toContain('rememberLeftoverAnswered(projectDir)')
  })

  // ★ sakura:ask-ai はチャットの入力欄に文面を入れるだけで、送信はしない。
  //    押した時点で覚えると、送らなかった人・消した人には問いが二度と出ない
  it('★ 「一緒に移してもらう」は「答えた」を覚えない（押しただけでは完了ではない）', () => {
    const body = moveHandler()
    expect(body).not.toContain('rememberLeftoverAnswered')
    expect(body).not.toContain('setLeftoverAnswered')
  })

  it('★ 覚えるのは「移さない」だけ（利用者がはっきり決めたとき）', () => {
    expect(skipHandler()).toContain('rememberLeftoverAnswered(projectDir)')
    // 覚える口は2つ（読み書き1組）のまま増えていない
    expect(NOTICE.split('rememberLeftoverAnswered(projectDir)').length - 1).toBe(1)
  })

  // ★ 調べられなかったときと、本当に無かったときが同じ見え方にならないこと
  it('★ 探した結果（調べられなかった・全部は見ていない）を捨てない', () => {
    const start = NOTICE.indexOf('const lookForLeftover = async (')
    const body = NOTICE.slice(start, NOTICE.indexOf('\n  }\n', start))
    expect(body).toContain('leftoverScanLine(r)')
    expect(body).toContain('leftoverScanLine({ ok: false')
    // 画面にも出す
    expect(NOTICE).toContain('{leftoverNote}')
  })
})

describe('探す側（main）', () => {
  // ★ 新しい走査を書かない（掟10）。実機で正しく拾った仕組みをそのまま使う
  it('★ 既にある未使用ファイルの仕組みを使う（走査を作り直していない）', () => {
    const start = UNUSED.indexOf('export function leftoverDataFilesFs')
    expect(start).toBeGreaterThan(-1)
    const body = UNUSED.slice(start, UNUSED.indexOf('\nexport type MoveToMaterialsResult', start))
    expect(body).toContain('checkUnusedFiles(projectDir)')
    expect(body).toContain('isLeftoverDataFile(')
    expect(body).toContain('describeLeftoverData(')
    // ★ 見ていない範囲（打ち切り）と、参照ありで外した件数を**捨てない**
    expect(body).toContain('truncated')
    expect(body).toContain('dataFilesReferenced')
    expect(body).toContain('referenced: dataFilesReferenced')
    // 判定を書き下していない
    expect(body).not.toContain('JSON.parse')
    expect(body).not.toContain('readdirSync')
  })

  it('★ 何も変えない・何も消さない（探すだけ）', () => {
    const start = UNUSED.indexOf('export function leftoverDataFilesFs')
    const body = UNUSED.slice(start, UNUSED.indexOf('\nexport type MoveToMaterialsResult', start))
    expect(body).not.toContain('rename')
    expect(body).not.toContain('unlink')
    expect(body).not.toContain('rmSync')
    expect(body).not.toContain('writeFile')
  })

  // 掟6: IPC は3点セット（handler・preload・型）
  it('★ IPC が3点そろっている', () => {
    expect(CLOUD).toContain("ipcMain.handle('storage:leftoverData'")
    expect(PRELOAD).toContain("ipcRenderer.invoke('storage:leftoverData', projectDir)")
    const dts = readFileSync(join(__dirname, '..', 'src/renderer/global.d.ts'), 'utf-8')
    expect(dts).toContain('leftoverData(projectDir: string)')
  })
})

describe('Koto の片づけに、削除は1行も無い（この機能でも増やさない）', () => {
  it('★ 古いデータを消す処理を足していない', () => {
    const leftoverStart = UNUSED.indexOf('export function leftoverDataFilesFs')
    const body = UNUSED.slice(leftoverStart, UNUSED.indexOf('\nexport type MoveToMaterialsResult', leftoverStart))
    for (const forbidden of ['fs.rmSync', 'fs.unlinkSync', 'fs.rmdirSync', 'fs.truncateSync']) {
      expect(body).not.toContain(forbidden)
    }
    // 依頼文でも消させない
    expect(askAiMoveDataText([{ file: 'data/a.json', detail: '1件' }])).toContain('消さないでください')
  })
})
