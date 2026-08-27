// B'-1: chat.json を追記式にする（保存層のみ）のテスト。2026-08-27 の仕様修正3件を反映済み:
//   1. foldChatLog の v2 判定は「最初の空でない行が JSON オブジェクトで v キーを持つとき」だけ。
//      持たなければ null（壊れたファイルを空の会話に畳んで localStorage 退避を止めない）。
//   2. fs を使う層は src/main/chatStore/file.ts（electron非依存）に切り出し、本物の一時フォルダで検証する。
//      以前 ipc/chatStore.ts に置いていたときの readCode ベースの配線テストは、実際に
//      shouldRewrite の呼び出し引数の入れ替えを検知できなかった（実測で確認済み）ため置き換えた。
//   3. 追記の直前に実ファイルのサイズを確認し、cache の記録と食い違っていれば（外から消された等）
//      書き直しに切り替える（丸ごと書き直していた頃の「治る性質」を保つ）。
//   4. cache は上限4件、LRUで最も古く使ったものから捨てる（touchCache。log.ts の純粋関数）。
// 対象: src/main/chatStore/log.ts（純粋ロジック）と src/main/chatStore/file.ts（実ファイルIO）。
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  foldChatLog,
  rewriteChatLog,
  appendChatLog,
  shouldRewrite,
  serializeMessages,
  isV1ChatLog,
  touchCache,
} from '../src/main/chatStore/log'
import { loadProjectChatFile, saveProjectChatFile, resetChatLogCache } from '../src/main/chatStore/file'

describe('foldChatLog', () => {
  it('null / 空文字列 / 空白のみ → null', () => {
    expect(foldChatLog(null)).toBeNull()
    expect(foldChatLog('')).toBeNull()
    expect(foldChatLog('   ')).toBeNull()
  })

  it('v1（配列）をそのまま読める', () => {
    const arr = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]
    expect(foldChatLog(JSON.stringify(arr))).toEqual({ messages: arr, lines: serializeMessages(arr) })
  })

  it('v1で壊れたJSON → null', () => {
    expect(foldChatLog('[{oops')).toBeNull()
  })

  it('v1 branch の「配列でなければnull」を直接踏む入力は作れないため、防御として残す（壊れたJSONはこちらのnullで捕まる）', () => {
    // [1,2,3 のように '[' で始まり壊れているものは JSON.parse 自体が失敗し、上の「壊れたJSON」側の null になる。
    // JSON文法上、'[' で始まって JSON.parse が成功する値は必ず配列になるため、「先頭が'['なのに配列でない」
    // という状況自体を作れない（Array.isArray チェックは防御として残すが、直接踏む入力は無い）。
    expect(foldChatLog('[1,2,3')).toBeNull()
  })

  // ── 2026-08-27 仕様修正1: v2 と認めるのは「最初の空でない行が v キーを持つJSONオブジェクト」のときだけ ──
  it('でたらめな中身 → null（壊れたファイルを空の会話にしない）', () => {
    expect(foldChatLog('でたらめな中身')).toBeNull()
  })

  it('{"a":1}（JSONオブジェクトだが v キーが無い）→ null', () => {
    expect(foldChatLog('{"a":1}')).toBeNull()
  })

  it('知らないバージョン（v:3）でも、レコードとして読める範囲は読む（未来の版を空にしない）', () => {
    const text = '{"v":3}\n{"i":0,"m":{"role":"user","content":"あ"}}'
    expect(foldChatLog(text)?.messages).toEqual([{ role: 'user', content: 'あ' }])
  })

  it('ヘッダの前に空行があっても v2 と認める', () => {
    const text = '\n\n{"v":2}\n{"i":0,"m":{"role":"user","content":"a"}}\n'
    expect(foldChatLog(text)?.messages).toEqual([{ role: 'user', content: 'a' }])
  })

  it('v2: ヘッダ + {"i":0,"m":..} を畳める', () => {
    const text = '{"v":2}\n{"i":0,"m":{"role":"user","content":"hi"}}\n'
    expect(foldChatLog(text)).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
      lines: ['{"role":"user","content":"hi"}'],
    })
  })

  it('v2: 同じ i を2回書いたらあとの勝ち', () => {
    const text = [
      '{"v":2}',
      '{"i":0,"m":{"role":"user","content":"first"}}',
      '{"i":0,"m":{"role":"user","content":"second"}}',
    ].join('\n') + '\n'
    expect(foldChatLog(text)?.messages).toEqual([{ role: 'user', content: 'second' }])
  })

  it('v2: {"n":1} で切り詰まる', () => {
    const text = [
      '{"v":2}',
      '{"i":0,"m":{"role":"user","content":"a"}}',
      '{"i":1,"m":{"role":"user","content":"b"}}',
      '{"n":1}',
    ].join('\n') + '\n'
    expect(foldChatLog(text)?.messages).toEqual([{ role: 'user', content: 'a' }])
  })

  it('v2: 末尾の行が途中で切れていても、その手前までは読める', () => {
    // クラッシュ等で書き込み途中に落ちた想定。最後の行は改行も閉じ括弧も無い
    const text = [
      '{"v":2}',
      '{"i":0,"m":{"role":"user","content":"a"}}',
      '{"i":1,"m":{"role":"user","content":"b"',
    ].join('\n')
    expect(foldChatLog(text)?.messages).toEqual([{ role: 'user', content: 'a' }])
  })

  it('v2: 知らないキーだけの行・空行は無視される', () => {
    const text = [
      '{"v":2}',
      '',
      '{"x":123}',
      '{"i":0,"m":{"role":"user","content":"a"}}',
      '',
    ].join('\n') + '\n'
    expect(foldChatLog(text)?.messages).toEqual([{ role: 'user', content: 'a' }])
  })

  it('v2: i が件数より大きい行は捨てられる（穴が開かない）', () => {
    const text = [
      '{"v":2}',
      '{"i":0,"m":{"role":"user","content":"a"}}',
      '{"i":5,"m":{"role":"user","content":"unreachable"}}',
    ].join('\n') + '\n'
    const folded = foldChatLog(text)
    // i:5 の行が素通りして配列を伸ばすと、途中に undefined の穴ができる（length が 6 になる）
    expect(folded?.messages).toEqual([{ role: 'user', content: 'a' }])
    expect(folded?.messages.length).toBe(1)
  })

  it('v2: ヘッダだけ → { messages: [], lines: [] }（null ではない）', () => {
    expect(foldChatLog('{"v":2}\n')).toEqual({ messages: [], lines: [] })
  })
})

describe('isV1ChatLog', () => {
  it('先頭の非空白文字が [ なら v1', () => {
    expect(isV1ChatLog('[{"role":"user"}]')).toBe(true)
    expect(isV1ChatLog('  \n [1,2]')).toBe(true) // 先頭の空白・改行は無視する
  })

  it('先頭が { （v2のヘッダ）なら v1 ではない', () => {
    expect(isV1ChatLog('{"v":2}\n{"i":0,"m":{}}\n')).toBe(false)
  })
})

describe('rewriteChatLog', () => {
  it('1行目は必ずヘッダ {"v":2}、以降は {"i":<番号>,"m":<行>} の形（往復テストは中身しか見ないため、生の形をここで固定する）', () => {
    expect(rewriteChatLog(['{"a":1}', '{"b":2}'])).toBe(
      '{"v":2}\n{"i":0,"m":{"a":1}}\n{"i":1,"m":{"b":2}}\n'
    )
  })

  it('空配列でもヘッダ行だけは書く', () => {
    expect(rewriteChatLog([])).toBe('{"v":2}\n')
  })
})

describe('appendChatLog', () => {
  it('末尾に1件足したらレコードは1件だけ', () => {
    const prev = ['{"role":"user","content":"a"}']
    const next = ['{"role":"user","content":"a"}', '{"role":"user","content":"b"}']
    expect(appendChatLog(prev, next)).toBe('{"i":1,"m":{"role":"user","content":"b"}}\n')
  })

  it('末尾を差し替えたら最後の位置のレコード1件だけ', () => {
    const prev = ['{"role":"user","content":"a"}', '{"role":"user","content":"b"}']
    const next = ['{"role":"user","content":"a"}', '{"role":"user","content":"B!"}']
    expect(appendChatLog(prev, next)).toBe('{"i":1,"m":{"role":"user","content":"B!"}}\n')
  })

  it('1件減ったら {"n":..} が入る', () => {
    const prev = ['{"role":"user","content":"a"}', '{"role":"user","content":"b"}']
    const next = ['{"role":"user","content":"a"}']
    expect(appendChatLog(prev, next)).toBe('{"n":1}\n')
  })

  it('減ったうえに中身も変わったら、n が先に来る', () => {
    const prev = [
      '{"role":"user","content":"a"}',
      '{"role":"user","content":"b"}',
      '{"role":"user","content":"c"}',
    ]
    const next = ['{"role":"user","content":"A!"}', '{"role":"user","content":"b"}']
    expect(appendChatLog(prev, next)).toBe(
      '{"n":2}\n{"i":0,"m":{"role":"user","content":"A!"}}\n'
    )
  })

  it('変化なし → 空文字列', () => {
    const lines = ['{"role":"user","content":"a"}', '{"role":"user","content":"b"}']
    expect(appendChatLog(lines, lines.slice())).toBe('')
  })
})

describe('shouldRewrite', () => {
  it('境界: ちょうど2倍+64KBは false、1バイト超えたら true', () => {
    const contentBytes = 1000
    const boundary = contentBytes * 2 + 65536
    expect(shouldRewrite(boundary, contentBytes)).toBe(false)
    expect(shouldRewrite(boundary + 1, contentBytes)).toBe(true)
  })
})

// ── 2026-08-27 仕様修正4: cache の上限（LRU） ───────────────────────────────
describe('touchCache（cacheの上限・LRU）', () => {
  it('上限2で a, b, c と入れたら a が消えている', () => {
    const map = new Map<string, number>()
    touchCache(map, 'a', 1, 2)
    touchCache(map, 'b', 2, 2)
    touchCache(map, 'c', 3, 2)
    expect([...map.keys()]).toEqual(['b', 'c'])
  })

  it('上限2で a, b, a, c と入れたら b が消えている（a は使い直したので残る）', () => {
    const map = new Map<string, number>()
    touchCache(map, 'a', 1, 2)
    touchCache(map, 'b', 2, 2)
    touchCache(map, 'a', 10, 2) // a を使い直す（値も更新される）
    touchCache(map, 'c', 3, 2)
    expect([...map.keys()]).toEqual(['a', 'c'])
    expect(map.get('a')).toBe(10) // 値も上書きされていること
  })
})

describe('往復（rewriteChatLog → foldChatLog が元に戻る）', () => {
  it('単純なメッセージ配列で往復する', () => {
    const msgs = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]
    expect(foldChatLog(rewriteChatLog(serializeMessages(msgs)))?.messages).toEqual(msgs)
  })

  it('実際の会話の形（role/content/toolNote/images/hidden/summary/at）で往復する', () => {
    const msgs = [
      { role: 'user', content: 'こんにちは、これを直して', at: '2026-08-27T01:00:00.000Z' },
      {
        role: 'assistant',
        content: '直しました。改行\nを含む本文や "引用符" も入ります。',
        toolNote: 'read_file: src/App.tsx',
        images: ['data:image/png;base64,AAAA'],
        hidden: false,
        summary: '要約テキスト',
        at: '2026-08-27T01:00:05.000Z',
      },
    ]
    expect(foldChatLog(rewriteChatLog(serializeMessages(msgs)))?.messages).toEqual(msgs)
  })
})

// ── 2026-08-27 仕様修正2・3: chatStore/file.ts を本物の一時フォルダで検証する ─────────────────
// electron に依存しない層に切り出したので、readCode でソース文字列を見るのではなく、実際に
// ファイルへ読み書きして確かめる（tests/backupStore.test.ts・tests/envDetect.test.ts の前例と同じ方式）。
describe('chatStore/file.ts: 実ファイルでの検証', () => {
  let dir = ''
  let filePath = ''

  const msg = (i: number, extra = '') => ({ role: 'user', content: `メッセージ${i}${extra}` })
  const json = (msgs: any[]) => JSON.stringify(msgs)

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-chatlog-'))
    filePath = path.join(dir, '.sakuraide', 'chat.json')
    resetChatLogCache() // cache はモジュール内の状態なので、前のテストの残りを持ち込まない
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('v1 → v2 の移行: v1配列を書いたファイルをload→saveすると、ファイルがv2になり、中身は1件も欠けていない', () => {
    const original = [msg(0), msg(1), msg(2)]
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, json(original), 'utf-8') // v1（配列まるごと）として直接書く

    expect(loadProjectChatFile(filePath)).toEqual({ ok: true, json: json(original) })
    expect(saveProjectChatFile(filePath, json(original))).toEqual({ ok: true })

    expect(isV1ChatLog(fs.readFileSync(filePath, 'utf-8'))).toBe(false) // v2になっている
    expect(loadProjectChatFile(filePath)).toEqual({ ok: true, json: json(original) })
  })

  // (b) の事故そのもの: v1をloadしてcacheへ入れてしまうと、1回目の保存で v1 ファイルへ v2 の
  // 行を直接追記して壊す。ここでは load→save→save の順で、実際に壊れないことを確認する。
  it('v1 を load したあと save を2回しても壊れない（1回目で v2 になり、2回目は追記）', () => {
    const v1 = [msg(0), msg(1)]
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, json(v1), 'utf-8')

    loadProjectChatFile(filePath) // ここで v1 のまま cache してしまうと、次の保存で壊れる

    const afterFirst = [msg(0), msg(1), msg(2)]
    expect(saveProjectChatFile(filePath, json(afterFirst))).toEqual({ ok: true })
    expect(loadProjectChatFile(filePath)).toEqual({ ok: true, json: json(afterFirst) })

    const afterSecond = [msg(0), msg(1), msg(2), msg(3)]
    expect(saveProjectChatFile(filePath, json(afterSecond))).toEqual({ ok: true })
    expect(loadProjectChatFile(filePath)).toEqual({ ok: true, json: json(afterSecond) })
  })

  it('追記経路: 末尾に1件足してsaveすると、ファイルの大きさの増分が足した1件ぶん程度（丸ごと書き直していない証拠）', () => {
    const base = [msg(0), msg(1), msg(2)]
    saveProjectChatFile(filePath, json(base)) // 初回は書き直し
    const sizeBefore = fs.statSync(filePath).size

    const next = [...base, msg(3)]
    saveProjectChatFile(filePath, json(next))
    const sizeAfter = fs.statSync(filePath).size

    const delta = sizeAfter - sizeBefore
    const oneRecordSize = Buffer.byteLength(`{"i":3,"m":${JSON.stringify(msg(3))}}\n`, 'utf-8')
    // 追記なら増分は「足した1件のレコード」ちょうど。丸ごと書き直していればヘッダ+4行ぶんになり、これより明らかに大きい
    expect(delta).toBe(oneRecordSize)
  })

  it('追記したあとloadすると、足した1件が読める', () => {
    saveProjectChatFile(filePath, json([msg(0)]))
    const next = [msg(0), msg(1)]
    saveProjectChatFile(filePath, json(next))
    expect(loadProjectChatFile(filePath)).toEqual({ ok: true, json: json(next) })
  })

  it('1件減らしてsave → loadすると減っている（🕘 元に戻す）', () => {
    saveProjectChatFile(filePath, json([msg(0), msg(1), msg(2)]))
    const reduced = [msg(0), msg(1)]
    saveProjectChatFile(filePath, json(reduced))
    expect(loadProjectChatFile(filePath)).toEqual({ ok: true, json: json(reduced) })
  })

  it('resetChatLogCache() のあとsaveすると書き直しになり、それでも中身が保たれる', () => {
    saveProjectChatFile(filePath, json([msg(0), msg(1)])) // 初回書き直し、cache 確立
    saveProjectChatFile(filePath, json([msg(0), msg(1), msg(2)])) // 追記、cache 更新

    resetChatLogCache()

    const grownMore = [msg(0), msg(1), msg(2), msg(3)]
    saveProjectChatFile(filePath, json(grownMore))

    // cache が無い状態からの保存は必ず書き直し。ディスクの中身が rewriteChatLog の出力と
    // 完全一致することで「差分の追記ではなく丸ごと書き直した」ことを確認する
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(rewriteChatLog(serializeMessages(grownMore)))
    expect(loadProjectChatFile(filePath)).toEqual({ ok: true, json: json(grownMore) })
  })

  // 2026-08-27 仕様修正4: cache は上限4件。プロジェクトを切り替え続けても、古いものから
  // 自動で捨てられて増え続けないことを、実際に5つのファイルを確立して確かめる。
  it('cache は上限4件で、超えたぶんは最も古く使ったものから捨てられる（別プロジェクトを開き続けても増え続けない）', () => {
    // 5つの異なるプロジェクト（ファイル）を順番に確立する。上限4なので、5つ目を確立した時点で
    // 最初のもの（paths[0]）は cache から捨てられているはず
    const paths = Array.from({ length: 5 }, (_, i) => path.join(dir, `p${i}`, '.sakuraide', 'chat.json'))
    paths.forEach((p, i) => {
      expect(saveProjectChatFile(p, json([msg(i)]))).toEqual({ ok: true }) // それぞれ初回書き直しで cache を確立
    })

    // 1つ目（cache に残っていれば「追記」、捨てられていれば「書き直し」になる）へ保存する。
    // 最初の1件を「書き換えつつ」1件足す形にする（末尾に足すだけだと、追記の結果＝直前の
    // ヘッダ+1行 に新しい1行が単純に連結されるだけになり、たまたま書き直しと同じバイト列に
    // なってしまって見分けが付かない。実際にこの見分けが付かない形で試して確認した）
    const grown = [msg(0, '-changed'), msg(1)]
    saveProjectChatFile(paths[0], json(grown))

    // cache に残っていない証拠として、ディスクの中身が「丸ごと書き直した」ときの形と完全一致すること
    // （追記であれば、最初に確立した1行だけのヘッダ付きファイルの末尾に差分行が足されるだけで、
    //  この完全な形にはならない）を確かめる
    expect(fs.readFileSync(paths[0], 'utf-8')).toBe(rewriteChatLog(serializeMessages(grown)))
    expect(loadProjectChatFile(paths[0])).toEqual({ ok: true, json: json(grown) })
  })

  // 修正3そのもの。丸ごと書き直していた頃は、外から消されても次の保存で自然に治っていた。
  // 追記化のあとも、この「治る性質」を失っていないことを確かめる。
  it('save で v2 になったあと、ファイルを外から消してから save → load すると、中身が保たれている', () => {
    saveProjectChatFile(filePath, json([msg(0), msg(1)])) // v2確立、cache セット

    fs.rmSync(filePath) // 外から消す（cache は残ったまま）

    const grown = [msg(0), msg(1), msg(2)]
    expect(saveProjectChatFile(filePath, json(grown))).toEqual({ ok: true })
    expect(loadProjectChatFile(filePath)).toEqual({ ok: true, json: json(grown) })
  })

  // 追加検証: shouldRewrite の呼び出し引数（fileBytes, contentBytes）を取り違えても、
  // 「1件足すだけ」の追記テストでは気づけない（両者が同程度の大きさで育つ通常の保存では、
  // 引数を入れ替えた式もたまたま同じ結論=追記になりがちなため。実際にミューテーション試験で
  // 確認済み）。無駄だけが積み上がる状況（同じ位置を上書きし続ける）で初めて表に出るので、
  // 実ファイルの大きさの推移で確かめる。
  it('同じ位置を上書きし続けると、無駄が溜まって書き直しに切り替わる（shouldRewriteの配線の実地証拠）', () => {
    saveProjectChatFile(filePath, json([msg(0)])) // 初回書き直し
    let prevSize = fs.statSync(filePath).size
    let sawShrink = false
    for (let n = 1; n <= 1500 && !sawShrink; n++) {
      saveProjectChatFile(filePath, json([msg(0, `-${n}`)])) // 同じ index 0 だけを書き換え続ける
      const size = fs.statSync(filePath).size
      if (size < prevSize) sawShrink = true // 増え続けていたものが縮んだ＝書き直しが起きた
      prevSize = size
    }
    expect(sawShrink).toBe(true)
    expect(loadProjectChatFile(filePath).ok).toBe(true) // 書き直したあとも読める
  }, 20000) // 64KBの無駄を積むには数百〜千回超の同期fs書き込みが要るため、既定の5秒では足りない
})
