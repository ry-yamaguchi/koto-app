import { describe, it, expect } from 'vitest'
import { teardownConfirmMessage, teardownKindsOf } from '../src/renderer/apprunDedicatedActions'

// ── W-14（2026-09-27 決定・案1+案2）: 専有型⑥「すべて削除する」の確認が「課金は止まります」と
// 言い切っていた ────────────────────────────────────────────────────────
//
// 直す前の文面は2つの点で実物と食い違っていた:
//  1. 一覧の「保存場所『…』（中のデータも消えます）」は、保存場所そのものが丸ごと消えるように
//     読めるが、すぐ下の💾の行（teardownDataNoteForAll）は「ほかのプロジェクトのデータや、
//     自分で置いたファイルは残す・ほかに使う人がいなければ保存場所ごと削除」と言っていて食い違う。
//  2. 「ここに挙げたものの月額の課金は止まります」は言い切りすぎで、共有の保存場所は
//     ほかのプロジェクトが使っていれば残る（月額495円は続く）。
//
// **注意（wording-review.md W-14）**: 「消すものの名前は固定で書かず、実際に消すものの一覧
// （opts.targets）から組み立てる」。ここは文字列一致ではなく、**targets を変えたら文面が
// 追従して変わること**（＝固定文言に戻す変異を捕まえる）を確かめる（掟10）。

describe('W-14: ⑥の確認ダイアログ「保存場所（中のデータも消えます）」→「にある、このプロジェクトのデータ」', () => {
  const TARGETS = ['アプリ『myapp』', 'ロードバランサ『lb-z』', 'クラスタ『cluster-x』']
  const PLACEMENT = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true }

  it('一覧の項目は「保存場所ごと消える」と読める言い方をしない', () => {
    const msg = teardownConfirmMessage({ targets: TARGETS, placements: [PLACEMENT], dataNote: 'ダミーのdataNote' })
    const list = msg.split('\n\n')[0]
    expect(list).toContain('保存場所『koto-data-x』にある、このプロジェクトのデータ')
    // 直す前の文言（保存場所そのものが消えると読める）が残っていないこと
    expect(msg).not.toContain('（中のデータも消えます）')
  })

  it('保存場所が消えるかどうかは💾の行（dataNote）に任せる。一覧側では言わない', () => {
    const msg = teardownConfirmMessage({ targets: TARGETS, placements: [PLACEMENT], dataNote: '💾のダミー文' })
    const list = msg.split('\n\n')[0]
    expect(list).not.toContain('消えます')
  })
})

describe('W-14: ⑥の確認ダイアログ「ここに挙げたものの月額の課金は止まります」→ 実際の一覧から組み立てる', () => {
  const PLACEMENT = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true }

  it('固定文言の「ここに挙げたものの月額の課金は止まります」はもう出さない', () => {
    const msg = teardownConfirmMessage({
      targets: ['アプリ『myapp』', 'クラスタ『cluster-x』'],
      placements: [],
      dataNote: '',
    })
    expect(msg).not.toContain('ここに挙げたものの月額の課金は止まります')
  })

  it('★★ 課金が止まる対象は targets（実際に消えるものの一覧）から組み立てる。名前は固定で書かない', () => {
    const targetsA = ['アプリ『myapp』', 'クラスタ『cluster-x』']
    const targetsB = ['クラスタ『別のクラスタ』']
    const msgA = teardownConfirmMessage({ targets: targetsA, placements: [], dataNote: '' })
    const msgB = teardownConfirmMessage({ targets: targetsB, placements: [], dataNote: '' })
    // targets を変えると、課金の文もそれに追従して変わる（固定文言なら変わらない＝この比較で捕まる）。
    // 2026-09-29（作者の決定）: 課金の文は**種類だけ**（ID は一覧の側で一度出している）。
    expect(msgA).toContain('アプリ・クラスタの課金は止まります。')
    expect(msgB).toContain('クラスタの課金は止まります。')
    expect(msgB).not.toContain('アプリ')
    expect(msgB).not.toContain('アプリ『myapp』')
    // 決定に無い固定名（アプリ・ロードバランサ・オートスケーリンググループ・クラスタ、を
    // 一律で書き並べる案）になっていないこと——targets に無い種類の名前は出ない
    expect(msgB).not.toContain('ロードバランサ')
    expect(msgB).not.toContain('オートスケーリンググループ')
  })

  it('保存場所があるときは「共有なら残る」ことを、計算資源の課金停止とは分けて言う', () => {
    const msg = teardownConfirmMessage({
      targets: ['クラスタ『cluster-x』'],
      placements: [PLACEMENT],
      dataNote: 'ダミー',
    })
    expect(msg).toContain('クラスタの課金は止まります。')
    expect(msg).toContain('保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。')
    // 「ここに挙げたものの月額の課金は止まります」のような、保存場所も一律で止まる言い切りはしない
    expect(msg).not.toMatch(/ここに挙げたもの.*止まります/)
  })

  it('★★ 保存場所だけが残っている状態（targets が空）でも、無い費用の話をしない（W-14 の注意）', () => {
    // 計算資源はすべて消え、保存場所の片づけだけが前回失敗して残っている、という実在しうる状態。
    const msg = teardownConfirmMessage({ targets: [], placements: [PLACEMENT], dataNote: 'ダミー' })
    // 一覧が「保存場所」だけになっても、存在しないアプリ・ロードバランサ等の課金停止を語らない
    expect(msg).not.toContain('アプリ')
    expect(msg).not.toContain('ロードバランサ')
    expect(msg).not.toContain('オートスケーリンググループ')
    expect(msg).not.toContain('クラスタ')
    expect(msg).toContain('保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。')
  })

  it('計算資源も保存場所も無いとき（想定外の呼び出し）は、無い課金の話を作らない', () => {
    const msg = teardownConfirmMessage({ targets: [], placements: [], dataNote: '' })
    expect(msg).not.toContain('課金')
    expect(msg).toContain('この操作は元に戻せません。よろしいですか？')
  })

  it('画面には素のテキストとして出る（Markdown 記法を使わない・掟5）', () => {
    const msg = teardownConfirmMessage({ targets: ['クラスタ『cluster-x』'], placements: [PLACEMENT], dataNote: 'ダミー' })
    expect(msg).not.toMatch(/\*\*|__|`/)
  })
})

// ── 2026-09-29（作者の決定）: 課金の文は「種類だけ」。長い ID を2回目も並べない ─────────────────────
// 直す前は「削除すると、アプリ『tsukaisute』・ロードバランサ『01a0…』・… の課金は止まります」と、
// 一覧で一度出した長い ID を課金の文でもう一度並べていた。種類（アプリ・ロードバランサ・
// オートスケーリンググループ・クラスタ）は、**実際に消すものの一覧から**組み立てる（固定で書かない）。
describe('⑥の確認ダイアログ: 課金の文は種類だけ（ID は一覧で一度だけ）', () => {
  const FULL = [
    'アプリ『tsukaisute』',
    'ロードバランサ『01a0b2c3d4e5』',
    'オートスケーリンググループ『02b1c2d3e4f5』',
    'クラスタ『03c1d2e3f4a5』',
  ]
  const costParagraph = (msg: string) => msg.split('\n\n').find(p => p.includes('この操作は元に戻せません')) ?? ''

  it('★★ 全部あるとき、作者が示した文そのもの（種類だけ）になる', () => {
    const msg = teardownConfirmMessage({ targets: FULL, placements: [], dataNote: '' })
    expect(costParagraph(msg)).toBe(
      'この操作は元に戻せません。削除すると、アプリ・ロードバランサ・オートスケーリンググループ・クラスタの課金は止まります。よろしいですか？',
    )
  })

  it('★★ 課金の文に ID も『』も入らない。ID は一覧（最初の段落）にだけ、ちょうど1回出る', () => {
    const msg = teardownConfirmMessage({ targets: FULL, placements: [], dataNote: '' })
    expect(costParagraph(msg)).not.toContain('『')
    for (const id of ['tsukaisute', '01a0b2c3d4e5', '02b1c2d3e4f5', '03c1d2e3f4a5']) {
      expect(msg.split(id).length - 1, `ID『${id}』が一覧のほかにも出ている`).toBe(1)
    }
    expect(msg.split('\n\n')[0]).toContain('アプリ『tsukaisute』')
  })

  it('★★ 種類は実際に消すものの一覧から作る。一覧に無い種類は言わない（固定で並べない）', () => {
    // アプリを公開していなかった（一覧にアプリが無い）プロジェクト
    const noApp = teardownConfirmMessage({ targets: FULL.slice(1), placements: [], dataNote: '' })
    expect(costParagraph(noApp)).toContain('ロードバランサ・オートスケーリンググループ・クラスタの課金は止まります。')
    expect(costParagraph(noApp)).not.toContain('アプリ')
    // クラスタだけが残っているプロジェクト
    const onlyCluster = teardownConfirmMessage({ targets: [FULL[3]], placements: [], dataNote: '' })
    expect(costParagraph(onlyCluster)).toContain('クラスタの課金は止まります。')
    expect(costParagraph(onlyCluster)).not.toContain('ロードバランサ')
    expect(costParagraph(onlyCluster)).not.toContain('オートスケーリンググループ')
  })

  it('同じ種類が並んでも1つにまとめる・順は一覧のとおり・空の種類は数えない', () => {
    expect(teardownKindsOf(['クラスタ『a』', 'クラスタ『b』', 'アプリ『c』'])).toEqual(['クラスタ', 'アプリ'])
    expect(teardownKindsOf(['『名前だけ』', ''])).toEqual([])
    // 名前の付いていない項目は全体を種類として扱う
    expect(teardownKindsOf(['アプリ'])).toEqual(['アプリ'])
    // 種類が1つも取れない一覧では、壊れた「の課金は止まります。」を作らない
    const msg = teardownConfirmMessage({ targets: ['『名前だけ』'], placements: [], dataNote: '' })
    expect(msg).not.toContain('の課金は止まります')
  })

  it('★ 保存場所だけが残っていて一覧が空でも、無い費用の話はしない（保存場所の文は残る）', () => {
    const msg = teardownConfirmMessage({ targets: [], placements: [{ bucket: 'koto-data-x' }], dataNote: 'ダミー' })
    expect(costParagraph(msg)).toBe('この操作は元に戻せません。削除すると、保存場所は、ほかに使っているプロジェクトが無いときだけ止まります。よろしいですか？')
  })
})
