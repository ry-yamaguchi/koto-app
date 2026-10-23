import { describe, it, expect } from 'vitest'
import { teardownSupport, manualTeardownGuide, teardownDataNote } from '../src/shared/teardownSupport'
import { teardownRemovesStorage, teardownDataNoteFor, teardownDataNoteForAll } from '../src/shared/teardownSupport'
import { STORAGE_TEARDOWN_PROGRESS, storageTeardownDoneLine } from '../src/shared/teardownSupport'
import { bucketNamesText, dedicatedStorageLeftoverNames, dedicatedTeardownHasWork } from '../src/shared/teardownSupport'
import type { PublishTargetKind } from '../src/renderer/publishStatus'
import { planProjectDeleteTeardown } from '../src/renderer/teardown/projectDeletePlan'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// 2026-08-09 Ryosuke の指摘で、破棄の導線を「公開」以外にも増やした
// （📡 公開したもの一覧・プロジェクト削除時）。公開先は5つあるが破棄の口は3つしかないため、
// ここを間違えると「押しても何も起きないボタン」が生まれる。

const ALL: PublishTargetKind[] = ['sakura-apprun', 'sakura-apprun-dedicated', 'hanamii', 'vercel', 'sakura-rental']

describe('破棄できる公開先', () => {
  it('AppRun と HANAMII は Koto から破棄できる', () => {
    expect(teardownSupport('sakura-apprun')).toBe('supported')
    expect(teardownSupport('hanamii')).toBe('supported')
  })

  // D-3（2026-09-11 Ryosuke 決定）: 専有型もアプリの削除は Koto からできる（実際の呼び出しは D-4）
  it('AppRun 専有型も Koto から破棄できる', () => {
    expect(teardownSupport('sakura-apprun-dedicated')).toBe('supported')
  })

  it('Vercel とレンタルサーバは破棄の実装が無い', () => {
    expect(teardownSupport('vercel')).toBe('manual')
    expect(teardownSupport('sakura-rental')).toBe('manual')
  })
})

describe('破棄できない公開先の案内', () => {
  // 「できません」だけで終わらせると、課金が続くものを放置させることになる
  it('どこで消せばよいかを必ず書く', () => {
    expect(manualTeardownGuide('vercel')).toContain('vercel.com')
    expect(manualTeardownGuide('sakura-rental')).toContain('レンタルサーバ')
    expect(manualTeardownGuide('sakura-rental')).toContain('削除')
  })

  // 2026-09-24 検分の指摘13。この日から Vercel への公開は、さくらのオブジェクトストレージへ
  // 読み書きできる鍵を1本発行する。Vercel のプロジェクトを消しても**鍵は残り**、
  // Koto 側に Vercel 向けの片づけの口は無い。案内どおり片づけたのに鍵が生き続ける、を防ぐ。
  it('★ Vercel の案内は、発行した鍵の片づけ方も書く', () => {
    const g = manualTeardownGuide('vercel')
    expect(g).toContain('koto-')            // 鍵の名前の形（探せる手がかり）
    expect(g).toContain('_vercel')
    expect(g).toContain('オブジェクトストレージ')
    expect(g).toContain('コントロールパネル')  // どこで消すか（無い導線を案内しない）
  })

  it('破棄できる公開先には案内を出さない', () => {
    expect(manualTeardownGuide('sakura-apprun')).toBe('')
    expect(manualTeardownGuide('sakura-apprun-dedicated')).toBe('')
    expect(manualTeardownGuide('hanamii')).toBe('')
  })
})

describe('文言に Markdown 記法を混ぜない', () => {
  // v0.2.98 の教訓。画面には素のテキストとして描画されるため ** がそのまま出る
  const texts = ALL.map(t => manualTeardownGuide(t)).filter(Boolean)

  it.each(texts)('記法がそのまま画面に出ない: %s', (text) => {
    expect(text).not.toMatch(/\*\*|__|`|\[[^\]]+\]\([^)]+\)/)
  })
})

describe('公開先を足したときの取りこぼし防止', () => {
  // 新しい公開先を足したのに判定を書き忘れると manual に落ちる。それ自体は安全側だが、
  // 案内文が空だとユーザーは何をすればよいか分からなくなる
  it('manual と判定した公開先には必ず案内文がある', () => {
    for (const t of ALL) {
      if (teardownSupport(t) === 'manual') expect(manualTeardownGuide(t).length).toBeGreaterThan(0)
    }
  })
})

// 2026-08-14。破棄の確認画面が「アプリとレジストリを消します」としか言っておらず、
// **利用者が入れたデータが消えることを伝えていなかった**。
describe('保存場所のデータについての案内', () => {
  it('保存場所が無ければ、何も言わない', () => {
    expect(teardownDataNote(null)).toBe('')
    expect(teardownDataNote(undefined)).toBe('')
    expect(teardownDataNote({ bucket: '' })).toBe('')
  })

  it('保存場所の名前を必ず出す（心当たりが無ければやめられるように）', () => {
    expect(teardownDataNote({ bucket: 'koto-data-x', shared: true })).toContain('koto-data-x')
  })

  // ★ 実装（teardownPlanFor の3段構え）と約束を合わせる。「バケットも消えます」と
  //    言い切ると嘘になる（ほかのプロジェクトや利用者のファイルがあれば残す）
  it('ほかのプロジェクトや利用者のファイルは残す、と約束する', () => {
    for (const shared of [true, false]) {
      const note = teardownDataNote({ bucket: 'koto-data-x', prefix: 'projects/x/', shared })
      expect(note).toContain('自分で置いたファイルは残します')
      expect(note).not.toContain('すべて削除')
    }
  })

  it('月額が止まる条件を添える（消し忘れを防ぐ）', () => {
    expect(teardownDataNote({ bucket: 'b', shared: true })).toContain('月額')
    expect(teardownDataNote({ bucket: 'b', shared: false })).toContain('月額')
  })

  it('画面には素のテキストで出るので、Markdown 記法を混ぜない', () => {
    const note = teardownDataNote({ bucket: 'koto-data-x', shared: true })
    expect(note).not.toMatch(/\*\*|`|^- /m)
  })
})

// ── 2026-09-24 検分の指摘7: 📡 公開したもの一覧の確認が「保存場所のデータも消えます」と嘘をつく ──
//
// 2026-10-08 より前、📡 の「🗑 破棄」は、専有型では**アプリだけ**を消し、
// 保存場所へは1件も要求を出さなかった。いまは手順6と同じ「すべて削除」（保存場所まで片づける。
// tests/apprunDedicatedStorageTeardown.test.ts・tests/dedicatedTeardownEntries.test.ts が固定）。
// それなのに「保存場所〇〇にある、このプロジェクトのデータも削除します…保存場所そのものも
// 削除して月額を止めます」と出していた。利用者は「データも保存場所も消えて月額も止まった」と
// 受け取るが、実際は**どちらも残る**＝いちばん気づけない形の課金残り。
//
// ── 2026-09-25 検分: 同じ嘘が HANAMII に残っていた ───────────────────────────
// この判定は HANAMII を true にしていて、下のテストも `toBe(true)` で固定していた。
// ところが当時の hanamii:teardown は HANAMII のプロジェクトを消すだけで、**バケットも
// データも鍵も1件も消していなかった**。つまり**テストは「そう書いてある」ことだけを固定し、
// それが本当かは一度も確かめていなかった**（掟10「テストは断定を固定するだけで、
// 断定が正しいかは確かめない」＝#34 レジストリとまったく同じ形）。
//
// 直し方は「実物を文面に合わせる」側を採った（掟5「同じ画面の同じボタンで振る舞いを変えない」）。
// **この判定が true と言う公開先は、実際に削除の要求を出すことを振る舞いのテストで固定する**:
//   - hanamii … tests/hanamiiStorageTeardown.test.ts（偽の保存場所に実際に流して、
//               どの要求が出たか・出なかったかを見る）
//   - sakura-apprun-dedicated … tests/apprunDedicatedStorageTeardown.test.ts・tests/dedicatedTeardownEntries.test.ts

describe('破棄が保存場所まで片づけるか（指摘7・2026-09-25 に HANAMII を実物へ合わせた）', () => {
  const PLACEMENT = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true }

  it('★★ 📡 一覧からの破棄で保存場所まで片づけるのは、共用型 AppRun・HANAMII・専有型の3つだけ', () => {
    // 片づける側（実際に削除の要求を出すことを、それぞれの振る舞いのテストが固定している）
    expect(teardownRemovesStorage('sakura-apprun')).toBe(true)
    expect(teardownRemovesStorage('hanamii')).toBe(true)
    // 専有型の 📡 は 2026-10-08 から手順6と同じ「すべて削除」（保存場所まで片づける）。アプリだけ、ではない
    expect(teardownRemovesStorage('sakura-apprun-dedicated')).toBe(true)
    // **破棄の口すら無い公開先を「片づけます」側に入れない。**
    // `!== 'sakura-apprun-dedicated'` のような除外で書くと、ここが黙って true に落ちる。
    expect(teardownRemovesStorage('vercel')).toBe(false)
    expect(teardownRemovesStorage('sakura-rental')).toBe(false)
  })

  // ── 0.6.22 段階3B-3: 入口の範囲 `scope`（'list'＝📡 の 🗑・'full'＝専有型の手順6）をやめた（設計書 10.11.7 (5)） ──────
  // 専有型は 2026-10-08 から、手順6も 📡 の 🗑 も同じ流れで、'full' を渡す入口が消えた。答えは公開先だけで決まる。
  // 前は 'full' 側が `if (scope === 'full') return true` で target を見ておらず、公開先を足すと黙って true に落ちる穴が隣にあった（9/25 の指摘25）。
  // **書き下した表**で固定する: 片づけるのは3つだけ。2つ目の引数を足して分岐を戻しても、ここで落ちる。
  it('★★ 保存場所まで片づける公開先の表（書き下し）: ALL のうち true は共用型・専有型・HANAMII の3つだけ。ほかは片づけない', () => {
    const table: Record<PublishTargetKind, boolean> = {
      'sakura-apprun': true, 'sakura-apprun-dedicated': true, hanamii: true, vercel: false, 'sakura-rental': false,
    }
    for (const t of ALL) expect(teardownRemovesStorage(t), `${t} の答えが表と違う`).toBe(table[t])
    expect(ALL.filter(t => teardownRemovesStorage(t))).toEqual(['sakura-apprun', 'sakura-apprun-dedicated', 'hanamii'])
    // 引数は公開先だけ（入口の範囲を渡す口は無い）。teardownDataNoteFor・teardownDataNoteForAll はオブジェクト1つを受けるので、
    // 引数の数では見えない——下の「src のどこにも無い」の走査が、項目に戻した形を捕まえる。
    expect(teardownRemovesStorage.length).toBe(1)
    // 破棄の口すら無い公開先が「月額を止めます」と言い切らないこと（いちばん危ない形）
    expect(teardownDataNoteFor({ target: 'vercel', placement: PLACEMENT })).toContain('残ります')
    expect(teardownDataNoteFor({ target: 'vercel', placement: PLACEMENT })).not.toContain('月額を止めます')
  })

  it('★★ 入口の範囲 scope が src のどこにも無い（0 か所）: dataNoteScope・`scope: \'list\' | \'full\'`・teardownRemovesStorage の2つ目の引数。コメントは見ない', () => {
    // 直す前は、引数 5 か所＋仕様書の値 2 か所＋型 2 か所（設計書 10.11.15）。戻すと、公開先を足したとき黙って true に落ちる枝が復活する。
    const root = join(__dirname, '..', 'src')
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : []
    })
    const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    const hits: string[] = []
    for (const p of walk(root)) {
      const c = code(p)
      const rel = p.slice(root.length + 1)
      if (/\bdataNoteScope\b/.test(c)) hits.push(`${rel}: dataNoteScope`)
      if (/\bscope\s*\??\s*:\s*['"](list|full)['"]/.test(c)) hits.push(`${rel}: scope: 'list' | 'full'`)
      if (/\bteardownRemovesStorage\s*\([^()]*,/.test(c)) hits.push(`${rel}: teardownRemovesStorage の2つ目の引数`)
    }
    expect(hits, 'scope が戻っている').toEqual([])
  })

  it('★★ 📡 から専有型を破棄するときも、手順6と同じ文で「保存場所のデータも削除します」と言う（実際にそうする）', () => {
    const note = teardownDataNoteFor({ target: 'sakura-apprun-dedicated', placement: PLACEMENT })
    expect(note).toContain('koto-data-x')
    expect(note).toContain('も削除します')
    // 「残ります」「月額が続きます」（アプリだけの口だった頃の文）は戻らない
    expect(note).not.toContain('残ります（消すまで月額が続きます）')
    expect(note).not.toContain('手順6')
  })

  it('★★ 保存場所まで片づける破棄では、従来どおり teardownDataNote と同じ文を出す', () => {
    expect(teardownDataNoteFor({ target: 'sakura-apprun-dedicated', placement: PLACEMENT }))
      .toBe(teardownDataNote(PLACEMENT))
    expect(teardownDataNoteFor({ target: 'sakura-apprun', placement: PLACEMENT }))
      .toBe(teardownDataNote(PLACEMENT))
    // ★ HANAMII も同じ文を出す（そしてそのとおりに片づける。振る舞いは
    //    tests/hanamiiStorageTeardown.test.ts が固定している）。
    expect(teardownDataNoteFor({ target: 'hanamii', placement: PLACEMENT }))
      .toBe(teardownDataNote(PLACEMENT))
  })

  // 「片づけません」と言うときに、**無い導線へ案内しない**（manualTeardownGuide の Vercel と同じ轍）。
  // 2026-10-08: 専有型はどの入口でも片づけるので、この枝へ来るのは破棄の口が別にある公開先だけ。専有型の手順6へは案内しない。
  it('★ 片づけない破棄の案内は、コントロールパネルへ。専有型の手順6へは案内しない（そこには何も無い）', () => {
    const other = teardownDataNoteFor({ target: 'vercel', placement: PLACEMENT })
    expect(other).toContain('残ります')
    expect(other).toContain('月額が続きます')
    expect(other).not.toContain('手順6')
    expect(other).toContain('コントロールパネル') // どこから消せるかは必ず添える
  })

  // 保存場所は、ほかのプロジェクトも使っていることがある。残るものを「削除してください」とだけ言うと、保存場所ごと消し、ほかのプロジェクトのデータも消える（2026-10-19 検分）
  it('★★★ 片づけない破棄が「コントロールパネルから削除」と案内するときは、削除する前に、ほかのプロジェクトも使っていないか確かめてもらう（1件でも複数でも）', () => {
    const SAY = 'さくらのクラウドのコントロールパネル（オブジェクトストレージ）で、ほかのプロジェクトも使っていないか確かめてから削除してください。消すと、そのプロジェクトのデータも消えます。'
    expect(teardownDataNoteFor({ target: 'vercel', placement: PLACEMENT })).toContain(SAY)
    expect(teardownDataNoteForAll({ target: 'vercel', placements: [{ bucket: 'a' }, { bucket: 'b' }] })).toContain(SAY)
    for (const t of ['vercel', 'sakura-rental'] as const) {
      expect(teardownDataNoteFor({ target: t, placement: PLACEMENT }), t).not.toContain('オブジェクトストレージ）から削除してください')
    }
  })

  it('★ 保存場所を使っていなければ、空文字（行ごと出さない）', () => {
    expect(teardownDataNoteFor({ target: 'sakura-apprun-dedicated', placement: null })).toBe('')
    expect(teardownDataNoteFor({ target: 'sakura-apprun-dedicated', placement: { bucket: '' } })).toBe('')
  })

  it('画面には素のテキストとして出る（Markdown 記法を使わない・v0.2.98 の教訓）', () => {
    const note = teardownDataNoteFor({ target: 'sakura-apprun-dedicated', placement: PLACEMENT })
    expect(note).not.toMatch(/\*\*|__|`/)
  })
})

describe('📡 公開したもの一覧が、出し分けの純関数を通している（指摘7）', () => {
  const modal = readFileSync(join(__dirname, '../src/renderer/components/PublishedListModal.tsx'), 'utf8')

  // 段階2の2b-2: 共用型の 🗑 も共通の流れ（TeardownRow）に置き換わり、一覧自身の確認のオーバーレイは無くなった。
  // 💾 の行（保存場所のデータの注意）を作るのは共通の確認（teardown/confirm.ts の buildTeardownConfirm）の1つで、
  // 共用型の分の文は tests/sharedTeardownSpec.test.ts（B）が固定している。一覧は文を組み立てない。
  it('★★ 一覧は確認の 💾 の文を自分では組み立てない（共通の確認が作る）。直す前の形（一覧自身の確認・先頭1件の placement）へ戻っていない', () => {
    for (const gone of ['teardownDataNoteForAll(', 'teardownDataNote(', 'teardownScopeNote(', 'confirmPlacement', '💾']) {
      expect(modal.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, ''), gone).not.toContain(gone)
    }
  })

  // ── 段階1（1b）: 一覧の HANAMII の 🗑 は、共通の流れ（TeardownRow）に渡す ─────────────────────
  // 2026-09-25 検分では、一覧が HANAMII の破棄を自分で呼び（projectDir を渡す・appDeleted を見て記録を片づける）、その形を文字列で固定していた。
  // 段階1の1b で、一覧は HANAMII の破棄を呼ばなくなった。呼ぶのは仕様書（teardown/targets/hanamii.ts）の invoke だけで、
  // 公開の記録を消すのは main の1か所（画面は消さない）。projectDir を渡すことは、下の「入口は projectDir を渡す」と、
  // 振る舞いの試験（tests/hanamiiTeardownRow.test.ts・hanamiiTeardownSpec.test.ts）が固定している。
  it('★★ HANAMII の行は TeardownRow（共通の流れ）に渡し、一覧は HANAMII の破棄を自分では呼ばない。key は添字を含めない', () => {
    expect(modal).toContain('<TeardownRow')
    expect(modal).toContain('spec={hanamiiTeardownSpec}')
    expect(modal).toContain('key={rowKey}')
    // 直す前の形が戻っていないこと
    expect(modal).not.toContain('hanamii.teardown(')
    expect(modal).not.toContain('getHanamiiToken(')
    expect(modal).not.toContain('readHanamiiProjectId(')
    expect(modal).not.toContain('r.appDeleted')
  })

  // HANAMII のプロジェクトは消えたのに保存場所だけ失敗したとき、`ok:false` だけを見て記録を残すと、
  // 存在しない公開が一覧に並び続ける（専有型の指摘4・9・13 と同じ形）。この判断は main の1か所（settleHanamiiTeardownFs）。
  it('★★ 一覧の HANAMII の枝は、公開の記録を消さない（消すのは main の1か所）', () => {
    const start = modal.indexOf("if (e.target === 'hanamii' && supported) {")
    const end = modal.indexOf("if (e.target === 'sakura-apprun' && supported) {")
    expect(start, 'HANAMII の枝が見つからない').toBeGreaterThan(0)
    expect(end, '共用型の枝が HANAMII の枝のあとに無い（HANAMII の枝の終わりを決められない）').toBeGreaterThan(start)
    // 枝の中（次の共用型の枝の手前まで）に clearPublishRecord が無い。
    const inBranch = modal.slice(start, end)
    expect(inBranch).not.toContain('clearPublishRecord')
    expect(inBranch).not.toContain('forgetPublishTargetRecord')
  })

  // 段階2の2b-2: 共用型の行も TeardownRow（sharedTeardownSpec）。公開の記録（📡 の行）を消すのは main の1か所で、一覧は消さない。
  it('★★ 一覧の共用型の枝は TeardownRow（sharedTeardownSpec）に渡し、共用型の破棄を自分では呼ばず、公開の記録を消さない。key は添字を含めない', () => {
    const start = modal.indexOf("if (e.target === 'sakura-apprun' && supported) {")
    const end = modal.indexOf('return <React.Fragment key={`${rowKey}-${i}`}>', start)
    expect(start, '共用型の枝が見つからない').toBeGreaterThan(0)
    expect(end, '共用型の枝の終わり（破棄の口が無い公開先の行）が見つからない').toBeGreaterThan(start)
    const inBranch = modal.slice(start, end)
    expect(inBranch).toContain('<TeardownRow')
    expect(inBranch).toContain('spec={sharedTeardownSpec}')
    expect(inBranch).toContain('keyMissingMessage={SHARED_KEY_MISSING_MESSAGE}')
    expect(inBranch).toContain('key={rowKey}')
    expect(inBranch).not.toContain('clearPublishRecord')
    expect(inBranch).not.toContain('forgetPublishTargetRecord')
    // 共用型の破棄の IPC を一覧が直接呼ばない・直す前の形が戻っていない（呼ぶのは仕様書の invoke だけ）
    expect(modal).not.toContain('cloud.teardown(')
    expect(modal).not.toContain('runTeardown')
    expect(modal).not.toContain('askConfirm')
  })
})

// ── 2026-09-25 検分の指摘5: 確認で見せるものと、実際に消すものを一致させる ──────────
//
// 破棄は `teardownStorageForProject` が同意済みの保存場所を**全件**片づける
// （tests/hanamiiStorageTeardown.test.ts の「2つあれば2つとも片づける」が実物で固定している）。
// ところが確認画面は `storage:placement` の `placement`（**先頭1件**）で文を組み立てていたので、
// env.json に2件あると「保存場所『A』のデータも削除します」としか出ないまま、
// **名前が一度も出なかった『B』とその中のデータまで消えた。**
// 元に戻せない削除を、名指ししないまま実行させてはいけない（掟10「お金・破壊の歯止め」）。

describe('確認画面の 💾 は、消す保存場所を全部名指しする（指摘5）', () => {
  const A = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true }
  const B = { bucket: 'koto-data-y', prefix: 'projects/myapp/', shared: true }

  it('★★ 2件あれば、2件とも名前が出る（片づけるほう）', () => {
    const note = teardownDataNoteForAll({ target: 'hanamii', placements: [A, B] })
    expect(note).toContain('koto-data-x')
    expect(note, '2件目の保存場所の名前が出ていない（名指ししないまま消える）').toContain('koto-data-y')
    expect(note).toContain('月額を止めます')
  })

  it('★★ 2件あれば、2件とも名前が出る（片づけないほう＝残るものを全部言う）', () => {
    const note = teardownDataNoteForAll({ target: 'vercel', placements: [A, B] })
    expect(note).toContain('koto-data-x')
    expect(note).toContain('koto-data-y')
    expect(note).toContain('残ります')
    expect(note).toContain('月額が続きます')
    expect(note).toContain('コントロールパネル') // どこから消せるか
    expect(note).not.toContain('手順6')
  })

  it('★★ 専有型は 📡 から押しても、2件とも名前が出て「削除します」と言う（手順6と同じ文）', () => {
    const list = teardownDataNoteForAll({ target: 'sakura-apprun-dedicated', placements: [A, B] })
    expect(list).toContain('koto-data-x')
    expect(list).toContain('koto-data-y')
    expect(list).toContain('も削除します')
  })

  it('★★ 1件のときは、これまでとまったく同じ文（文言を二重管理しない）', () => {
    for (const target of ALL) {
      expect(teardownDataNoteForAll({ target, placements: [A] }))
        .toBe(teardownDataNoteFor({ target, placement: A }))
    }
  })

  it('★ 保存場所を使っていなければ、行ごと出さない', () => {
    expect(teardownDataNoteForAll({ target: 'hanamii', placements: [] })).toBe('')
    expect(teardownDataNoteForAll({ target: 'hanamii', placements: null })).toBe('')
    expect(teardownDataNoteForAll({ target: 'hanamii', placements: undefined })).toBe('')
    // 名前の無いものは数えない（『』だけの空行を出さない）
    expect(teardownDataNoteForAll({ target: 'hanamii', placements: [{ bucket: '' }, A] }))
      .toBe(teardownDataNoteFor({ target: 'hanamii', placement: A }))
  })

  it('画面には素のテキストとして出る（Markdown 記法を使わない・v0.2.98 の教訓）', () => {
    for (const target of ALL) {
      const note = teardownDataNoteForAll({ target, placements: [A, B] })
      expect(note).not.toMatch(/\*\*|__|`/)
    }
  })
})

// ── 2026-09-25 検分の指摘1・2: 片づけの入口は3つある ────────────────────────
//
// `hanamii:teardown` の `projectDir` は**任意の引数**だった。渡し忘れても型検査は通り、渡さないと main は保存場所へ1件も要求を出さずに
// `ok:true` を返す。その直後にプロジェクト削除（Sidebar）がフォルダごとゴミ箱へ移すと、バケットの唯一の記録
// （.sakura-cloud/env.json）も消え、**Koto から二度と消せない**（掟10「任意の引数で機能を繋ぐと、渡し忘れても誰も気づかない」）。
// 段階1で、projectDir は必須の引数になり（main の骨が断る。tests/hanamiiTeardownShell.test.ts）、入口は3つとも共通の流れ
// （確認 → 実行）を通る。**入口の網羅（呼び口が仕様書の1行だけ・入口ごとの呼び出しの形・直す前の形の禁止）は
// tests/hanamiiTeardownEntries.test.ts（F）に移した。** ここは、保存場所の確認の文を見る。

describe('HANAMII の破棄の確認の文と、プロジェクト削除の 💾（入口の網羅は tests/hanamiiTeardownEntries.test.ts）', () => {
  // ── データが消えることを、言わずに押させない（掟5・掟10）──────────────────
  // 3つとも同じ口（保存場所まで片づける）を通るようになったので、**確認の文も揃える**。
  // **出し方まで見る**（掟10「ファイルのどこかにあるだけでは、行を消しても通る」）:
  //   (1)その行を出す条件（`… && (`）と (2)実際に出している文（`💾 {…}`）の両方を確かめる。
  // HANAMII の分（【公開】の 🗑・一覧の行）は、共通の確認（teardown/confirm.ts の buildTeardownConfirm）が 💾 を出す。
  // 入口が文を組み立て直さないことは tests/hanamiiTeardownSection.test.ts（H1）・tests/hanamiiTeardownSpec.test.ts・teardownConfirmCommon が固定している。
  // 共用型の確認画面は段階2の2b-2 で共通の確認に置き換わった（📡 一覧自身の確認のオーバーレイは無い）。文は共通の確認の1つが作り、
  // 共用型の分（💾 に全件の名前が出る・teardownDataNoteForAll を通る）は tests/sharedTeardownSpec.test.ts の B が振る舞いで固定している。
  it('★★ 共通の確認は、保存場所のことを teardownDataNoteForAll（全件）で出す。一覧・HANAMII の【公開】は文を組み立てない', () => {
    const confirm = readFileSync(join(__dirname, '../src/renderer/teardown/confirm.ts'), 'utf8')
    expect(confirm, '共通の確認が 💾 の文を teardownDataNoteForAll（全件）で作っていない').toContain('teardownDataNoteForAll(')
    for (const rel of ['../src/renderer/components/PublishedListModal.tsx', '../src/renderer/components/HanamiiPanel.tsx']) {
      const src = readFileSync(join(__dirname, rel), 'utf8')
      expect(src, `${rel} が確認の💾の文を自分で組み立てている（共通の確認が作る）`).not.toContain('teardownDataNoteForAll(')
    }
  })

  // ── プロジェクト削除の 💾 は、公開先を決め打ちしない（3巡目の指摘3）────────────────
  //
  // ここ（もとは Sidebar。段階3A の 3A-5a で ProjectDeleteDialog へ移した）は `pendingPublish.includes('hanamii')` の決め打ちだったので、**共用型 AppRun だけで
  // 公開しているプロジェクトを「公開も一緒に破棄する」ON で消すと、データが消えることを
  // 一言も言わないまま元に戻せない削除が走った**（`cloud:teardown` は state.resources を全部
  // delete にし、bucket があれば storage アダプタを渡して中身ごと消す）。
  // 指摘2で閉じたはずの穴が、**同じダイアログの隣に、直した本人の手でそのまま残っていた。**
  //
  // 判定は一元定義（teardownSupport / teardownRemovesStorage）に通す。そうすれば
  // **新しい公開先が増えても勝手に正しくなる**。決め打ちは `not.toContain` で禁じる。
  it('★★ プロジェクト削除の 💾 は、公開先を決め打ちせず teardownRemovesStorage で選ぶ', () => {
    const raw = readFileSync(join(__dirname, '../src/renderer/components/ProjectDeleteDialog.tsx'), 'utf8')
    // 「直す前の形」はコメントで説明してあるので、**コードだけ**を見る（コメントの引用に当たらない）。
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')   // ブロックコメント（JSX の {/* … */} もこれで落ちる）
      .replace(/^[ \t]*\/\/.*$/gm, '')     // 行コメント
    // (1)出す公開先の選び方: 先に破棄する公開先（plan.teardown。Koto から破棄できるもの）を、一元定義（teardownRemovesStorage）に通す
    expect(src, '💾 を出す公開先を、先に破棄する公開先（plan.teardown）から一元定義（teardownRemovesStorage）で選んでいない')
      .toMatch(/teardownOnDelete && shownTeardown\s*\.filter\(t => teardownRemovesStorage\(t\)\)/)
    // shownTeardown は plan.teardown から済んだ公開先を除いたもの（別の出どころから選ばない）
    expect(src).toContain('const shownTeardown = plan ? withoutDoneTargets(plan.teardown, doneSteps) : []')
    // (2)文の組み立て（公開先ごと・全件）
    expect(src, '公開先ごとに teardownDataNoteForAll（全件）を通していない')
      .toContain("teardownDataNoteForAll({ target: t, placements: facts.placements })")
    // (3)実際に 💾 の行として出している
    expect(src, '💾 の行を実際に出していない').toContain('💾 {PUBLISH_TARGET_LABEL[x.t]}: {x.note}')
    // (4)直す前の形（HANAMII 決め打ち）が戻っていないか
    expect(src, "公開先の決め打ち（includes('hanamii')）が残っている").not.toMatch(/includes\(\s*'hanamii'\s*\)/)
    expect(src, '💾 の行が HANAMII 決め打ちのまま残っている')
      .not.toContain("💾 {teardownDataNoteForAll({ target: 'hanamii'")
    // (5)Sidebar には 💾 の行が無い（ダイアログへ移した）
    expect(readFileSync(join(__dirname, '../src/renderer/components/Sidebar.tsx'), 'utf8')).not.toContain('teardownDataNoteForAll')
  })

  // 決め打ちをやめた効き目そのもの（純関数の側）。共用型 AppRun がこの網に入ることを言い切る。
  it('★★ 共用型 AppRun は 💾 を出す側に入る（ダイアログのフィルタが拾う公開先）', () => {
    const all = ['sakura-apprun', 'sakura-apprun-dedicated', 'hanamii', 'vercel', 'sakura-rental'] as PublishTargetKind[]
    const shown = all.filter(t => teardownSupport(t) === 'supported' && teardownRemovesStorage(t))
    // 専有型も入る（2026-10-08 から、📡 の 🗑 も保存場所まで片づける）。ただしこの 💾 の行はプロジェクト削除の「公開も一緒に破棄する」の
    // 枝にあり、専有型が残っていれば削除そのものを止める（projectDeleteBlockOf）ので、専有型の行は実際には出ない。
    expect(shown, '共用型 AppRun がデータの注意書きから漏れている').toEqual(['sakura-apprun', 'sakura-apprun-dedicated', 'hanamii'])
    // ダイアログが回すのは先に破棄する公開先（plan.teardown）。専有型は入らず、共用型・HANAMII が入る（並びは HANAMII が先）
    const facts = { targets: all, unreadable: false, dedicated: null, placements: [], running: null, sharedLeftover: null, sharedRegistry: null }
    expect(planProjectDeleteTeardown(facts).teardown.filter(t => teardownRemovesStorage(t))).toEqual(['hanamii', 'sakura-apprun'])
  })

  // ── 破棄の確認に出す一覧は「全件」（前の巡回で見送られた指摘37）──────────────────
  // main は `storage:placement` で `placements`（全件）を返す。画面が `placement`（先頭1件）
  // しか読まないと、名前が一度も出なかった保存場所とデータまで消える（掟10）。
  it('★★ 破棄の確認の材料は、placements（全件）を読む。HANAMII・共用型（【公開】・一覧の行）は共通の読み口が押した時点に全件を読み、一覧は読まない', () => {
    // 📡 一覧は段階2の2b-2 から保存場所を自分では読まない（`storage.placement(` を呼ばない）。
    const listSrc = readFileSync(join(__dirname, '../src/renderer/components/PublishedListModal.tsx'), 'utf8')
    expect(listSrc, '一覧が保存場所を自分で読んでいる（確認の材料は共通の読み口が押した時点に読む）').not.toContain('storage.placement(')
    const files = [
      // 共通の確認の材料の読み口（teardown/facts.ts）。【公開】の 🗑 も 📡 の行も、押した時点にここで全件を読む。
      '../src/renderer/teardown/facts.ts',
    ]
    for (const f of files) {
      const src = readFileSync(join(__dirname, f), 'utf8')
      expect(src, `${f}: placements（全件）を読んでいない＝先頭1件しか見ていない`)
        .toMatch(/\.placements \?\? \(\w+\.placement \? \[\w+\.placement\] : \[\]\)/)
    }
    // 【公開】は保存場所の全件を画面の state に抱えない（抱えると、確認が押した時点より古い写しで文を作ることになる）。
    expect(readFileSync(join(__dirname, '../src/renderer/components/HanamiiPanel.tsx'), 'utf8')).not.toContain('setPlacements')
  })
})

// ── 2026-09-25 検分の指摘26: 画面の文にアスタリスクが見えている ─────────────────
//
// JSX のテキストに書いた `**強調**` は、画面に ** ごとそのまま出る（掟5・v0.2.98 の教訓）。
// 棚卸しが部分的にしか取れなかったときだけ出る行だったので、長く気づかれていなかった。
// ここは**コメントを外してから**見る（コメントの ** は画面に出ないので触らない）。

describe('画面に出る文に Markdown 記法を混ぜない（指摘26）', () => {
  const FILES = [
    '../src/renderer/components/PublishedListModal.tsx',
    '../src/renderer/components/HanamiiPanel.tsx',
    '../src/renderer/components/HanamiiTeardownSection.tsx',
    '../src/renderer/components/Sidebar.tsx',
    '../src/renderer/components/ProjectDeleteDialog.tsx',
    '../src/renderer/components/teardown/ManualTeardownNote.tsx',
    '../src/renderer/components/teardown/ProjectDeleteResults.tsx',
  ]

  it.each(FILES)('%s のコード部分に ** が無い', (rel) => {
    const src = readFileSync(join(__dirname, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')   // ブロックコメント（JSX の {/* … */} もこれで落ちる）
      .replace(/^[ \t]*\/\/.*$/gm, '')     // 行コメント
    const lines = src.split('\n').filter(l => l.includes('**'))
    expect(lines, `画面に ** がそのまま出る: ${lines.join(' / ')}`).toEqual([])
  })
})


// ── 専有型と HANAMII の「保存場所のデータを削除」の文は、同じ関数から作る（0.6.21・検分）──────────
// 前は同じ文字列を2か所に別々に書いていた。片方だけ直すと、双子の文が食い違う
// （モックの返事を固定するテストは、実装の文字を読まないので気づけない）。
describe('保存場所の削除の進み具合・完了の1行は、専有型と HANAMII で同じ関数から出る', () => {
  it('文の形（「保存場所を削除」とは言わない。note が「保存場所は残します」と続く回と矛盾するため）', () => {
    expect(STORAGE_TEARDOWN_PROGRESS).toBe('🗄️ 保存場所のデータを削除しています…')
    expect(storageTeardownDoneLine('koto-x', '保存場所は残します')).toBe('保存場所『koto-x』のデータを削除しました — 保存場所は残します')
  })

  it.each(['../src/main/ipc/apprunDedicatedTeardown.ts', '../src/main/ipc/hanamiiTeardown.ts'])('%s は共通の定数・関数を使い、同じ文を直書きしていない', (rel) => {
    const src = readFileSync(join(__dirname, rel), 'utf8')
    // 専有型は 2026-10-07 から、文はそのままに段の内部名（teardown.storage）を添えて渡す。定数から引くことは変わらない。
    expect(src).toMatch(/progress\(STORAGE_TEARDOWN_PROGRESS[,)]/)
    expect(src).toContain('storageTeardownDoneLine(b.bucket, b.note)')
    expect(src).not.toContain("progress('🗄️ 保存場所")
    expect(src).not.toContain('のデータを削除しました — ${b.note}')
  })
})

// ── 専有型の「保存場所だけ残った」名前の全件（0.6.22 段階3B-2・B=2）────────────────────────────
describe('bucketNamesText: 保存場所の名前を『A』『B』で並べる', () => {
  it('1件・複数・空', () => {
    expect(bucketNamesText(['koto-a'])).toBe('『koto-a』')
    expect(bucketNamesText(['koto-a', 'koto-b'])).toBe('『koto-a』『koto-b』')
    expect(bucketNamesText([])).toBe('')
  })

  // 3B の検分: 3つの公開先の「残っています」の行を同じ関数から作っていたのは専有型だけで、HANAMII と共用型は自分用の整形を持っていた。
  // 片方の区切りを変えても、もう片方は黙ってずれる（変異で、専有型の試験だけが落ちた）。名前を『』で囲んで並べる整形は、この関数の1つだけ。
  it('★★ src のどこにも、名前を『』で囲んで並べる整形が別に無い（定義は teardownSupport.ts の bucketNamesText だけ）', () => {
    const root = join(__dirname, '..', 'src')
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : []
    })
    const files = walk(root)
    expect(files.length, 'src を読めていない').toBeGreaterThan(300)
    const SHAPES = [/=>\s*`『\$\{[^}]*\}』`\s*\)\s*\.join\(\s*''\s*\)/, /=>\s*'『'\s*\+[^)]*\+\s*'』'\s*\)\s*\.join\(\s*''\s*\)/]
    const found = files.filter(f => { const t = readFileSync(f, 'utf8'); return SHAPES.some(re => re.test(t)) })
      .map(f => f.slice(root.length - 'src'.length).replace(/\\/g, '/'))
    expect(found).toEqual(['src/shared/teardownSupport.ts'])
  })

  it.each([
    '../src/main/ipc/apprunDedicatedTeardown.ts', '../src/main/ipc/hanamiiTeardown.ts', '../src/main/ipc/cloudTeardown.ts',
  ])('★★ %s は、残っている保存場所の名前を bucketNamesText で並べる（3つの公開先の main が同じ関数を通る）', (rel) => {
    const src = readFileSync(join(__dirname, rel), 'utf8')
    expect(src).toMatch(/\bbucketNamesText\(/)
    expect(src).toMatch(/が残っています（消すまで月額が続きます）/)
  })
})

describe('dedicatedStorageLeftoverNames: 全件（storageLeftoverBuckets）があればそれ、無ければ storageLeftoverBucket の1件', () => {
  it('全件があればその全件（同じ名前は1つ・並びは保つ）。1件の印が先頭と食い違っても全件を言う', () => {
    expect(dedicatedStorageLeftoverNames({ storageLeftoverBucket: 'a', storageLeftoverBuckets: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(dedicatedStorageLeftoverNames({ storageLeftoverBuckets: ['b', 'a', 'b'] })).toEqual(['b', 'a'])
    expect(dedicatedStorageLeftoverNames({ storageLeftoverBucket: 'a', storageLeftoverBuckets: ['b'] })).toEqual(['b'])
  })
  it('全件が無い・空・読めない値だけ → 1件の印（旧い記録）。それも無ければ空', () => {
    expect(dedicatedStorageLeftoverNames({ storageLeftoverBucket: 'a' })).toEqual(['a'])
    expect(dedicatedStorageLeftoverNames({ storageLeftoverBucket: 'a', storageLeftoverBuckets: null })).toEqual(['a'])
    expect(dedicatedStorageLeftoverNames({ storageLeftoverBucket: 'a', storageLeftoverBuckets: [] })).toEqual(['a'])
    expect(dedicatedStorageLeftoverNames({ storageLeftoverBucket: 'a', storageLeftoverBuckets: ['', 5 as any, null as any] })).toEqual(['a'])
    expect(dedicatedStorageLeftoverNames({ storageLeftoverBucket: 'a', storageLeftoverBuckets: 'b' as any })).toEqual(['a'])
    for (const rec of [null, undefined, {}, { storageLeftoverBucket: null }, { storageLeftoverBucket: '' }, { storageLeftoverBucket: 5 as any }]) {
      expect(dedicatedStorageLeftoverNames(rec), JSON.stringify(rec)).toEqual([])
    }
  })
  it('「消すものがあるか」の判断は storageLeftoverBucket の1件を見続ける（main は2つを同時に書く）。全件だけでは「ある」と読まない', () => {
    expect(dedicatedTeardownHasWork({ storageLeftoverBucket: 'a' })).toBe(true)
    expect(dedicatedTeardownHasWork({ storageLeftoverBucket: null })).toBe(false)
    expect(dedicatedTeardownHasWork({ storageLeftoverBuckets: ['a', 'b'] } as any)).toBe(false)
  })
})
