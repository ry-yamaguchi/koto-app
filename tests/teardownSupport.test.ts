import { describe, it, expect } from 'vitest'
import { teardownSupport, manualTeardownGuide, teardownScopeNote, teardownDataNote } from '../src/shared/teardownSupport'
import { teardownRemovesStorage, teardownDataNoteFor, teardownDataNoteForAll } from '../src/shared/teardownSupport'
import type { PublishTargetKind } from '../src/renderer/publishStatus'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 2026-08-09 Ryosuke の指摘で、破棄の導線を「③公開」以外にも増やした
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

describe('破棄で何が消えるか', () => {
  // W-16（2026-09-27 決定・案1+案2）: 「レジストリも消す」と言い切ると、削除するかは
  // 実際は選択式（registryDeleteHelp・cloudCost.ts）なのに常に消えると誤解させる。
  // 1行目は「AppRun のアプリを削除します。」だけにし、レジストリの話はすぐ下の欄に任せる。
  it('AppRun のアプリだけを言い切り、レジストリを消すとは言い切らない', () => {
    expect(teardownScopeNote('sakura-apprun')).toBe('AppRun のアプリを削除します。')
    expect(teardownScopeNote('sakura-apprun')).not.toContain('コンテナレジストリ') // 直す前の形
  })

  // 専有型は「アプリだけ消える」。クラスタ・LB は月額が続くので、⑥で別に消すことを必ず伝える
  it('★ AppRun 専有型は、アプリ（全バージョン）だけ消え、クラスタ・LB は⑥で別に消すと書く', () => {
    const note = teardownScopeNote('sakura-apprun-dedicated')
    expect(note).toContain('全バージョン')
    expect(note).toContain('クラスタ')
    expect(note).toContain('ロードバランサ')
    expect(note).toContain('⑥')
    expect(note).toContain('課金が続きます')
    expect(note).not.toBe(teardownScopeNote('sakura-apprun')) // 共用型の文を使い回さない
  })

  it('破棄できる公開先には必ず説明がある', () => {
    for (const t of ALL) {
      if (teardownSupport(t) === 'supported') expect(teardownScopeNote(t).length).toBeGreaterThan(0)
    }
  })
})

describe('文言に Markdown 記法を混ぜない', () => {
  // v0.2.98 の教訓。画面には素のテキストとして描画されるため ** がそのまま出る
  const texts = ALL.flatMap(t => [manualTeardownGuide(t), teardownScopeNote(t)]).filter(Boolean)

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
// 📡 の「🗑 破棄」は、専有型では apprunDedicated:teardownApp（appOnly）＝**アプリだけ**を消し、
// 保存場所へは1件も要求を出さない（tests/apprunDedicatedStorageTeardown.test.ts が固定）。
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
//   - sakura-apprun-dedicated（'full'）… tests/apprunDedicatedStorageTeardown.test.ts

describe('破棄が保存場所まで片づけるか（指摘7・2026-09-25 に HANAMII を実物へ合わせた）', () => {
  const PLACEMENT = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true }

  it('★★ 📡 一覧からの破棄で保存場所まで片づけるのは、共用型 AppRun と HANAMII だけ', () => {
    // 片づける側（実際に削除の要求を出すことを、それぞれの振る舞いのテストが固定している）
    expect(teardownRemovesStorage('sakura-apprun', 'list')).toBe(true)
    expect(teardownRemovesStorage('hanamii', 'list')).toBe(true)
    // 専有型の 📡 は appOnly ＝アプリだけ
    expect(teardownRemovesStorage('sakura-apprun-dedicated', 'list')).toBe(false)
    // **破棄の口すら無い公開先を「片づけます」側に入れない。**
    // `!== 'sakura-apprun-dedicated'` のような除外で書くと、ここが黙って true に落ちる。
    expect(teardownRemovesStorage('vercel', 'list')).toBe(false)
    expect(teardownRemovesStorage('sakura-rental', 'list')).toBe(false)
  })

  it('★★ 専有型タブの⑥（すべて削除する）は保存場所まで片づける', () => {
    expect(teardownRemovesStorage('sakura-apprun-dedicated', 'full')).toBe(true)
  })

  // ── 2026-09-25 検分の指摘25: 直した行の隣に、同じ形の包括的 true が残っていた ──────
  // 'list' 側は公開先を書き下したのに、'full' 側は `if (scope === 'full') return true` で
  // **target を一度も見ていなかった**。'full' を持つのは専有型タブの⑥だけなので実害は
  // 出ていなかったが、`teardownDataNoteFor({ target: 'vercel', scope: 'full', … })` は
  // 「保存場所そのものも削除して月額を止めます」と言い切る。
  // **'list' で閉じたはずの穴（公開先を足すと黙って true に落ちる）が、隣に残っていた。**
  it('★★ ⑥（full）を持つのは専有型だけ。ほかの公開先は full でも片づけない', () => {
    for (const t of ALL) {
      if (t === 'sakura-apprun-dedicated') continue
      expect(teardownRemovesStorage(t, 'full'), `${t} が full で「片づけます」側に落ちている`).toBe(false)
    }
    // 破棄の口すら無い公開先が「月額を止めます」と言い切らないこと（いちばん危ない形）
    expect(teardownDataNoteFor({ target: 'vercel', scope: 'full', placement: PLACEMENT })).toContain('残ります')
    expect(teardownDataNoteFor({ target: 'vercel', scope: 'full', placement: PLACEMENT })).not.toContain('月額を止めます')
  })

  it('★★ 📡 から専有型を破棄するときは「消えます」と言わず、「残ります」と言う', () => {
    const note = teardownDataNoteFor({ target: 'sakura-apprun-dedicated', scope: 'list', placement: PLACEMENT })
    expect(note).toContain('koto-data-x')
    expect(note).toContain('残ります')
    expect(note).toContain('月額が続きます')
    // すぐ上の teardownScopeNote（アプリだけ）と矛盾しないこと。
    expect(note).not.toContain('も削除します')
    expect(note).not.toContain('月額を止めます')
    // どこから消せるかを必ず添える（「できません」だけで放り出さない）。
    expect(note).toContain('⑥')
  })

  it('★★ 保存場所まで片づける破棄では、従来どおり teardownDataNote と同じ文を出す', () => {
    expect(teardownDataNoteFor({ target: 'sakura-apprun-dedicated', scope: 'full', placement: PLACEMENT }))
      .toBe(teardownDataNote(PLACEMENT))
    expect(teardownDataNoteFor({ target: 'sakura-apprun', scope: 'list', placement: PLACEMENT }))
      .toBe(teardownDataNote(PLACEMENT))
    // ★ HANAMII も同じ文を出す（そしてそのとおりに片づける。振る舞いは
    //    tests/hanamiiStorageTeardown.test.ts が固定している）。
    expect(teardownDataNoteFor({ target: 'hanamii', scope: 'list', placement: PLACEMENT }))
      .toBe(teardownDataNote(PLACEMENT))
  })

  // 「片づけません」と言うときに、**無い導線へ案内しない**（manualTeardownGuide の Vercel と同じ轍）。
  it('★ 片づけない破棄の案内は、公開先ごとに出し分ける（専有型にだけ⑥と言う）', () => {
    const dedicated = teardownDataNoteFor({ target: 'sakura-apprun-dedicated', scope: 'list', placement: PLACEMENT })
    expect(dedicated).toContain('専有型タブの⑥')
    // 専有型以外が false 側へ来ても、専有型の⑥へ案内しない（そこには何も無い）。
    const other = teardownDataNoteFor({ target: 'vercel', scope: 'list', placement: PLACEMENT })
    expect(other).toContain('残ります')
    expect(other).toContain('月額が続きます')
    expect(other).not.toContain('⑥')
    expect(other).toContain('コントロールパネル') // どこから消せるかは必ず添える
  })

  it('★ 保存場所を使っていなければ、どちらでも空文字（行ごと出さない）', () => {
    for (const scope of ['list', 'full'] as const) {
      expect(teardownDataNoteFor({ target: 'sakura-apprun-dedicated', scope, placement: null })).toBe('')
      expect(teardownDataNoteFor({ target: 'sakura-apprun-dedicated', scope, placement: { bucket: '' } })).toBe('')
    }
  })

  it('画面には素のテキストとして出る（Markdown 記法を使わない・v0.2.98 の教訓）', () => {
    const note = teardownDataNoteFor({ target: 'sakura-apprun-dedicated', scope: 'list', placement: PLACEMENT })
    expect(note).not.toMatch(/\*\*|__|`/)
  })
})

describe('📡 公開したもの一覧が、出し分けの純関数を通している（指摘7）', () => {
  const modal = readFileSync(join(__dirname, '../src/renderer/components/PublishedListModal.tsx'), 'utf8')

  it('★★ 確認オーバーレイの 💾 の行は teardownDataNoteForAll（公開先つき・全件）を通る', () => {
    expect(modal).toContain("teardownDataNoteForAll({ target: confirm.target, scope: 'list', placements: confirmPlacements })")
    // 直す前の形（公開先を見ない teardownDataNote／先頭1件だけの placement）へ戻っていないこと。
    expect(modal).not.toContain('teardownDataNote(confirmPlacement)')
    expect(modal).not.toContain("placement: confirmPlacement }")
  })

  // ── 2026-09-25 検分: HANAMII の破棄に projectDir を渡す ─────────────────────
  // main は `.sakura-cloud/env.json` を読まないと、どのバケットを片づけるのか分からない。
  // **渡し忘れると保存場所へ1件も要求が出ず、確認画面の「月額を止めます」が嘘に戻る**
  // （掟10「任意の引数で機能を繋ぐと、渡し忘れても誰も気づかない」）。
  // 片づけそのものの振る舞いは tests/hanamiiStorageTeardown.test.ts が固定している。
  it('★★ HANAMII の破棄には projectDir（e.dir）を渡す', () => {
    expect(modal).toContain('window.electronAPI.hanamii.teardown(e.hanamiiProjectId, token, e.dir)')
    // 直す前の形（projectDir を渡さない）へ戻っていないこと。
    expect(modal).not.toContain('window.electronAPI.hanamii.teardown(e.hanamiiProjectId, token)')
  })

  // HANAMII のプロジェクトは消えたのに保存場所だけ失敗したとき、`ok:false` だけを見て
  // 記録を残すと、**存在しない公開が一覧に並び続ける**（専有型の指摘4・9・13 と同じ形）。
  it('★★ appDeleted（アプリは消えた）を見て、公開の記録を片づける', () => {
    expect(modal).toContain('if (!r.ok && r.appDeleted) {')
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
    const note = teardownDataNoteForAll({ target: 'hanamii', scope: 'list', placements: [A, B] })
    expect(note).toContain('koto-data-x')
    expect(note, '2件目の保存場所の名前が出ていない（名指ししないまま消える）').toContain('koto-data-y')
    expect(note).toContain('月額を止めます')
  })

  it('★★ 2件あれば、2件とも名前が出る（片づけないほう＝残るものを全部言う）', () => {
    const note = teardownDataNoteForAll({ target: 'sakura-apprun-dedicated', scope: 'list', placements: [A, B] })
    expect(note).toContain('koto-data-x')
    expect(note).toContain('koto-data-y')
    expect(note).toContain('残ります')
    expect(note).toContain('月額が続きます')
    expect(note).toContain('⑥') // どこから消せるかは公開先ごとに出し分ける
  })

  it('★★ 1件のときは、これまでとまったく同じ文（文言を二重管理しない）', () => {
    for (const target of ALL) {
      for (const scope of ['list', 'full'] as const) {
        expect(teardownDataNoteForAll({ target, scope, placements: [A] }))
          .toBe(teardownDataNoteFor({ target, scope, placement: A }))
      }
    }
  })

  it('★ 保存場所を使っていなければ、行ごと出さない', () => {
    expect(teardownDataNoteForAll({ target: 'hanamii', scope: 'list', placements: [] })).toBe('')
    expect(teardownDataNoteForAll({ target: 'hanamii', scope: 'list', placements: null })).toBe('')
    expect(teardownDataNoteForAll({ target: 'hanamii', scope: 'list', placements: undefined })).toBe('')
    // 名前の無いものは数えない（『』だけの空行を出さない）
    expect(teardownDataNoteForAll({ target: 'hanamii', scope: 'list', placements: [{ bucket: '' }, A] }))
      .toBe(teardownDataNoteFor({ target: 'hanamii', scope: 'list', placement: A }))
  })

  it('画面には素のテキストとして出る（Markdown 記法を使わない・v0.2.98 の教訓）', () => {
    for (const target of ALL) {
      const note = teardownDataNoteForAll({ target, scope: 'list', placements: [A, B] })
      expect(note).not.toMatch(/\*\*|__|`/)
    }
  })
})

// ── 2026-09-25 検分の指摘1・2: 片づけの入口は3つある ────────────────────────
//
// `hanamii:teardown` の `projectDir` は**任意の引数**なので、渡し忘れても型検査は通る
// （掟10「任意の引数で機能を繋ぐと、渡し忘れても誰も気づかない」＝2026-08-13 と同じ形）。
// 渡さないと main は保存場所へ1件も要求を出さないまま `ok:true` を返す。しかも:
//   ・③公開（HanamiiPanel）は、そのあと公開の記録を消す＝📡 一覧の 🗑 の行ごと消える
//   ・プロジェクト削除（Sidebar）は、そのあと**フォルダごとゴミ箱へ移す**＝バケットの
//     唯一の記録（.sakura-cloud/env.json）も消える＝**Koto から二度と消せない**
// なので**3つとも数えて**固定する。片づけの振る舞いは tests/hanamiiStorageTeardown.test.ts。

describe('HANAMII の破棄の入口は3つとも projectDir を渡す（指摘1・2）', () => {
  const CALLERS: { name: string; file: string; call: string; old: string }[] = [
    {
      name: '③公開の「🗑 この公開を破棄する」（HanamiiPanel）',
      file: '../src/renderer/components/HanamiiPanel.tsx',
      call: 'window.electronAPI.hanamii.teardown(projectId, token, projectDir)',
      old: 'window.electronAPI.hanamii.teardown(projectId, token)',
    },
    {
      name: 'プロジェクト削除の「公開も一緒に破棄する」（Sidebar）',
      file: '../src/renderer/components/Sidebar.tsx',
      call: 'window.electronAPI.hanamii.teardown(id, token, dir)',
      old: 'window.electronAPI.hanamii.teardown(id, token)',
    },
    {
      name: '📡 公開したもの一覧の「🗑 破棄」（PublishedListModal）',
      file: '../src/renderer/components/PublishedListModal.tsx',
      call: 'window.electronAPI.hanamii.teardown(e.hanamiiProjectId, token, e.dir)',
      old: 'window.electronAPI.hanamii.teardown(e.hanamiiProjectId, token)',
    },
  ]

  for (const c of CALLERS) {
    it(`★★ ${c.name} は projectDir を渡す`, () => {
      const src = readFileSync(join(__dirname, c.file), 'utf8')
      expect(src, '片づけの入口なのに projectDir を渡していない').toContain(c.call)
      expect(src, '直す前の形（渡さない呼び方）が残っている').not.toContain(`${c.old})`)
    })
  }

  it('★★ 呼び出し口を数える（新しい入口が増えたら、ここで気づく）', () => {
    const files = [
      '../src/renderer/components/HanamiiPanel.tsx',
      '../src/renderer/components/Sidebar.tsx',
      '../src/renderer/components/PublishedListModal.tsx',
    ]
    const found = files.flatMap(f => (readFileSync(join(__dirname, f), 'utf8').match(/hanamii\.teardown\(/g) ?? []))
    expect(found.length, 'HANAMII の破棄を呼ぶ場所が増減している（増えた口も projectDir を渡すこと）').toBe(3)
  })

  // ── データが消えることを、言わずに押させない（掟5・掟10）──────────────────
  // 3つとも同じ口（保存場所まで片づける）を通るようになったので、**確認の文も揃える**。
  // **出し方まで見る**（掟10「ファイルのどこかにあるだけでは、行を消しても通る」）:
  //   ①その行を出す条件（`… && (`）と ②実際に出している文（`💾 {…}`）の両方を確かめる。
  it('★★ 3つの確認画面とも、保存場所のことを teardownDataNoteForAll（全件）で出す', () => {
    const shows: { file: string; call: string }[] = [
      { file: '../src/renderer/components/HanamiiPanel.tsx', call: "teardownDataNoteForAll({ target: 'hanamii', scope: 'list', placements })" },
      { file: '../src/renderer/components/PublishedListModal.tsx', call: "teardownDataNoteForAll({ target: confirm.target, scope: 'list', placements: confirmPlacements })" },
    ]
    for (const s of shows) {
      const src = readFileSync(join(__dirname, s.file), 'utf8')
      expect(src, `${s.file}: 💾 の行を出す条件が無い`).toContain(`${s.call} && (`)
      expect(src, `${s.file}: 💾 の行を実際に出していない`).toContain(`💾 {${s.call}}`)
    }
  })

  // ── プロジェクト削除の 💾 は、公開先を決め打ちしない（3巡目の指摘3）────────────────
  //
  // ここは `pendingPublish.includes('hanamii')` の決め打ちだったので、**共用型 AppRun だけで
  // 公開しているプロジェクトを「公開も一緒に破棄する」ON で消すと、データが消えることを
  // 一言も言わないまま元に戻せない削除が走った**（`cloud:teardown` は state.resources を全部
  // delete にし、bucket があれば storage アダプタを渡して中身ごと消す）。
  // 指摘2で閉じたはずの穴が、**同じダイアログの隣に、直した本人の手でそのまま残っていた。**
  //
  // 判定は一元定義（teardownSupport / teardownRemovesStorage）に通す。そうすれば
  // **新しい公開先が増えても勝手に正しくなる**。決め打ちは `not.toContain` で禁じる。
  it('★★ プロジェクト削除の 💾 は、公開先を決め打ちせず teardownRemovesStorage で選ぶ', () => {
    const raw = readFileSync(join(__dirname, '../src/renderer/components/Sidebar.tsx'), 'utf8')
    // 「直す前の形」はコメントで説明してあるので、**コードだけ**を見る（コメントの引用に当たらない）。
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')   // ブロックコメント（JSX の {/* … */} もこれで落ちる）
      .replace(/^[ \t]*\/\/.*$/gm, '')     // 行コメント
    // ①出す公開先の選び方（一元定義に通す）
    expect(src, '💾 を出す公開先を一元定義（teardownSupport/teardownRemovesStorage）で選んでいない')
      .toContain(".filter(t => teardownSupport(t) === 'supported' && teardownRemovesStorage(t, 'list'))")
    // ②文の組み立て（公開先ごと・全件）
    expect(src, '公開先ごとに teardownDataNoteForAll（全件）を通していない')
      .toContain("teardownDataNoteForAll({ target: t, scope: 'list', placements: pendingPlacements })")
    // ③実際に 💾 の行として出している
    expect(src, '💾 の行を実際に出していない').toContain('💾 {PUBLISH_TARGET_LABEL[x.t]}: {x.note}')
    // ④直す前の形（HANAMII 決め打ち）が戻っていないか
    expect(src, "公開先の決め打ち（pendingPublish.includes('hanamii')）が残っている")
      .not.toContain("pendingPublish.includes('hanamii')")
    expect(src, '💾 の行が HANAMII 決め打ちのまま残っている')
      .not.toContain("💾 {teardownDataNoteForAll({ target: 'hanamii'")
  })

  // 決め打ちをやめた効き目そのもの（純関数の側）。共用型 AppRun がこの網に入ることを言い切る。
  it('★★ 共用型 AppRun は 💾 を出す側に入る（Sidebar のフィルタが拾う公開先）', () => {
    const shown = (['sakura-apprun', 'sakura-apprun-dedicated', 'hanamii', 'vercel', 'sakura-rental'] as PublishTargetKind[])
      .filter(t => teardownSupport(t) === 'supported' && teardownRemovesStorage(t, 'list'))
    expect(shown, '共用型 AppRun がデータの注意書きから漏れている').toEqual(['sakura-apprun', 'hanamii'])
  })

  // ── 破棄の確認に出す一覧は「全件」（前の巡回で見送られた指摘37）──────────────────
  // main は `storage:placement` で `placements`（全件）を返す。画面が `placement`（先頭1件）
  // しか読まないと、名前が一度も出なかった保存場所とデータまで消える（掟10）。
  it('★★ 📡 一覧と ③公開の破棄確認は、placements（全件）を読む', () => {
    const files = [
      '../src/renderer/components/PublishedListModal.tsx',
      '../src/renderer/components/HanamiiPanel.tsx',
    ]
    for (const f of files) {
      const src = readFileSync(join(__dirname, f), 'utf8')
      expect(src, `${f}: placements（全件）を読んでいない＝先頭1件しか見ていない`)
        .toMatch(/\.placements \?\? \(\w+\.placement \? \[\w+\.placement\] : \[\]\)/)
    }
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
    '../src/renderer/components/Sidebar.tsx',
  ]

  it.each(FILES)('%s のコード部分に ** が無い', (rel) => {
    const src = readFileSync(join(__dirname, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')   // ブロックコメント（JSX の {/* … */} もこれで落ちる）
      .replace(/^[ \t]*\/\/.*$/gm, '')     // 行コメント
    const lines = src.split('\n').filter(l => l.includes('**'))
    expect(lines, `画面に ** がそのまま出る: ${lines.join(' / ')}`).toEqual([])
  })
})
