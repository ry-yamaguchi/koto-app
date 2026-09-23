import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  askAiRewriteText, askAiRewritePlan, dataLayerUsageLine, rewriteCheckLine,
  storageNoticeHeadline, describeWriteSite, storagePreparedText, STORAGE_REWRITE_REMAINING,
} from '../src/shared/storageNoticeText'
import { DATA_LAYER_FILE, DATA_LAYER_FILE_CJS } from '../src/shared/objectStorage'

// 2026-09-23、実機で起きたこと（作者 Ryosuke さん）。
//
// ③公開に「⚠️ データが消えてしまいます」と出た。アプリの server.js が
// ファイルへ直接書いていたためで、**この判定は正しかった**。
// 「AIに書き直してもらう」を押して頼むと、AI は**2回とも「書き直しは既に
// 完了しています」と答えたのに、実際には1文字も変わっていなかった**
// （fs.writeFileSync は 66行目に残り、koto-data への参照は1件も無かった）。
// AI はファイルを読まずに答えていた。
//
// 利用者から見ると:
//   1. Koto が「データが消えます。AI に書き直してもらってください」と言う
//   2. AI が「完了しました」と答える
//   3. Koto は「まだです」と言い続ける
//   4. どちらを信じればよいか、利用者には確かめる手段がない
//
// **この行き止まりを作っているのは Koto である。** ここで固定するのは、
// その行き止まりを作らないための3つ:
//   1. 依頼文に「どのファイルの何行目か」を入れる
//   2. 書き直せたかを、その場で確かめられる（結果は断定しすぎない）
//   3. 「用意済み」と「まだ危ない」を同じ見出しに同居させない

describe('AI への依頼文（Koto が見つけた場所を渡す）', () => {
  const site = [{ file: 'public/server.js', lines: [66] }]

  // ★ 今回の事故の核心。場所を渡さないと AI は自分の記憶で答える
  it('ファイル名と行番号が文に入る', () => {
    const text = askAiRewriteText(site)
    expect(text).toContain('public/server.js')
    expect(text).toContain('66行目')
  })

  // ★ 「完了しました」と言い切らせないための一文。無かったから事故になった
  it('読み直して確かめてから完了と答えるよう頼んでいる', () => {
    const text = askAiRewriteText(site)
    expect(text).toContain('読み直して')
    expect(text).toContain('残っていないことを確かめて')
    expect(text).toContain('完了と答えて')
  })

  it('書き直し先（koto-data の import）を示す', () => {
    expect(askAiRewriteText(site)).toContain("import { list, get, save, remove } from './koto-data.js'")
  })

  // ★ 嘘を書かない。見つかっていない場所を、あるかのように書かない
  it('0件のときは場所を書かない', () => {
    const text = askAiRewriteText([])
    expect(text).not.toContain('行目')
    expect(text).not.toContain('ファイルに直接書き込んでいるのは')
    // それでも「読み直して確かめてから」は残す
    expect(text).toContain('完了と答えて')
    expect(text).toContain("import { list, get, save, remove } from './koto-data.js'")
  })

  it('複数の場所を並べ、多すぎるときは「ほかN件」にまとめる', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ file: `a${i}.js`, lines: [i + 1] }))
    const text = askAiRewriteText(many)
    expect(text).toContain('a0.js の 1行目')
    expect(text).toContain('a4.js の 5行目')
    expect(text).toContain('ほか2件')
    expect(text).not.toContain('a5.js')
  })

  it('1つのファイルに複数行あれば、全部並べる', () => {
    const text = askAiRewriteText([{ file: 'server.js', lines: [12, 66] }])
    expect(text).toContain('server.js の 12行目、66行目')
  })

  it('壊れた入力でも落ちない', () => {
    expect(() => askAiRewriteText(null as never)).not.toThrow()
    expect(() => askAiRewriteText([{ file: '', lines: [] }] as never)).not.toThrow()
    expect(askAiRewriteText([{ file: 'a.js', lines: null as never }])).toContain('a.js')
  })

  // **画面には素のテキストとして出る**（v0.2.98 の教訓）
  it('Markdown 記法を使わない', () => {
    const text = askAiRewriteText(site)
    expect(text).not.toContain('**')
    expect(text).not.toContain('`')
  })
})

describe('書き直せたかを確かめた結果の1行', () => {
  // ★ 残っているなら、利用者が AI に突き返せる形で名指しする
  it('まだ残っているときは場所を名指しする', () => {
    const line = rewriteCheckLine({
      usesDataLayer: false,
      writesFiles: [{ file: 'public/server.js', lines: [66] }],
    })
    expect(line).toContain('❌')
    expect(line).toContain('まだ書き直されていません')
    expect(line).toContain('public/server.js')
    expect(line).toContain('66行目')
  })

  // ★ 書き直せていれば ✅
  it('書き直せているときは ✅', () => {
    const line = rewriteCheckLine({ usesDataLayer: true, writesFiles: [] })
    expect(line).toContain('✅')
    expect(line).not.toContain('❌')
    expect(line).not.toContain('まだ書き直されていません')
  })

  // ★ 走査が打ち切られたなら「見つかりませんでした」と断定しない（2026-09-23 検分）
  //   大きすぎるファイル・深いフォルダは見ていない。**調べていないものを済んだにしない**
  it('全部は調べられていないときは ✅ を出さない', () => {
    const line = rewriteCheckLine({ usesDataLayer: true, writesFiles: [], truncated: true })
    expect(line).not.toContain('✅')
    expect(line).toContain('全部は調べられませんでした')
  })

  // ★ 書き込みが消えただけでは「書き直せた」ことにならない。
  //   AI が保存そのものを消してしまった形を ✅ と言わない
  it('koto-data を使っている箇所が無ければ ✅ と言い切らない', () => {
    const line = rewriteCheckLine({ usesDataLayer: false, writesFiles: [] })
    expect(line).not.toContain('✅')
    expect(line).toContain('データの保存を使っている箇所も見つかりません')
  })

  // ★ 確かめていないことを断定しない。済んだにも まだ にも倒さない
  it('調べられなかったときは、済んだにも まだ にも倒さない', () => {
    for (const bad of [null, undefined, { usesDataLayer: false, writesFiles: null as never }]) {
      const line = rewriteCheckLine(bad as never)
      expect(line).toContain('確かめられませんでした')
      expect(line).not.toContain('✅')
      expect(line).not.toContain('❌')
    }
  })
})

describe('枠の見出し（用意済みと、まだ危ないを同居させない）', () => {
  // ★ 保存場所はできたが、コードの書き直しが残っている状態。
  //   ここを「用意済み」で終わらせたため、作者自身が「正常か？」と疑った
  it('保存場所があっても、書き直しが残っていれば「用意済み」で終わらせない', () => {
    const h = storageNoticeHeadline({ hasPlacement: true, warn: true })
    expect(h).not.toBe('💾 データの保存（用意済み）')
    expect(h).toContain('書き直し')
    // 残りの作業が1行で分かること
    expect(STORAGE_REWRITE_REMAINING).toContain('コードの書き直しだけ')
  })

  it('保存場所があって危なくなければ「用意済み」', () => {
    expect(storageNoticeHeadline({ hasPlacement: true, warn: false })).toBe('💾 データの保存（用意済み）')
  })

  it('保存場所が無くて危ないときは「データが消えてしまいます」', () => {
    expect(storageNoticeHeadline({ hasPlacement: false, warn: true })).toBe('⚠️ データが消えてしまいます')
  })

  it('どちらでもないときは案内だけ', () => {
    expect(storageNoticeHeadline({ hasPlacement: false, warn: false })).toBe('💾 データの保存について')
  })
})

describe('場所の書き表し', () => {
  it('ファイル名と行番号を並べる', () => {
    expect(describeWriteSite({ file: 'server.js', lines: [66] })).toBe('server.js の 66行目')
  })

  it('行番号が無ければファイル名だけ（嘘の行番号を作らない）', () => {
    expect(describeWriteSite({ file: 'server.js', lines: [] })).toBe('server.js')
  })
})

// ── 配線（ソースを読んで確かめる）────────────────────────────────────
// StorageNotice.tsx は React と electron に依存していて import できないので、
// **ソースを読んで配線を確かめる**（publishRootWiring.test.ts と同じ流儀）。
// `mustNot` には**直す前の形**を書き、戻されたら落ちるようにする。
const ROOT = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

/**
 * 「AIに書き直してもらう」を押したときに走る関数の本体だけを取り出す。
 *
 * **ファイル全体に当てると、別の場所にある同じ文字列に当たる**（掟10・2026-08-20）。
 * 順序を見るテストなので、見る範囲を1つの関数に絞る。
 */
function askAiBody(src: string): string {
  const start = src.indexOf('const askAi = async () => {')
  expect(start, 'askAi が見つからない').toBeGreaterThan(-1)
  const end = src.indexOf('\n  }', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('画面への配線', () => {
  const src = read('src/renderer/components/StorageNotice.tsx')

  it('依頼文は、見つけた場所を渡して作る', () => {
    expect(src).toContain('const plan = askAiRewritePlan(files, layer)')
    expect(src).toContain("detail: { text: plan.text }")
    // 直す前は、場所を持たない固定の文面だった
    expect(src).not.toContain('const ASK_AI_TEXT =')
    expect(src).not.toContain('text: ASK_AI_TEXT')
    // 直す前は、用意もせずその場で文面を作って送っていた
    expect(src).not.toContain('text: askAiRewriteText(files) }')
  })

  // ★ 2026-09-23 の事故の本体。読み込み先が無いまま頼むと、必ず失敗する
  it('依頼ボタンは、文面を送る前に ensureLayer を呼ぶ', () => {
    const body = askAiBody(src)
    const ensure = body.indexOf('await window.electronAPI.storage.ensureLayer(projectDir)')
    const dispatch = body.indexOf("window.dispatchEvent(new CustomEvent('sakura:ask-ai'")
    expect(ensure, 'ensureLayer を呼んでいない').toBeGreaterThan(-1)
    expect(dispatch, '依頼文を送っていない').toBeGreaterThan(-1)
    expect(ensure).toBeLessThan(dispatch)
    // ボタンは自分で送らず、この関数を通す（二重に文面を作らせない）
    expect(src).toContain('onClick={() => { void askAi() }}')
  })

  // ★ 置けなかったときに送ると、「必ず失敗する頼みごと」になる
  it('用意できなかったときは、文面を送らずに理由を画面へ出す', () => {
    const body = askAiBody(src)
    expect(body).toContain('if (!plan.send) { setError(plan.error); return }')
    // 送る判断より前に return していること（送ってから気づくのでは遅い）
    const guard = body.indexOf('if (!plan.send)')
    const dispatch = body.indexOf("window.dispatchEvent(new CustomEvent('sakura:ask-ai'")
    expect(guard).toBeLessThan(dispatch)
  })

  it('「書き直せたか確かめる」ボタンがあり、押すと調べ直す', () => {
    expect(src).toContain('🔎 書き直せたか確かめる')
    expect(src).toContain('onClick={() => { void recheck() }}')
    // 調べ直したのに画面が古いままでは意味がない
    expect(src).toContain('const scan = await window.electronAPI.storage.scan(projectDir)')
    expect(src).toContain('setFiles(scan.writesFiles)')
    expect(src).toContain('writesFiles: scan.writesFiles,')
    // **打ち切りの有無も渡す**（渡さないと「調べていない」が「済んだ」になる）
    expect(src).toContain('truncated: scan.truncated === true,')
    // 直す前は打ち切りを渡していなかった
    expect(src).not.toContain('setCheckLine(rewriteCheckLine({ usesDataLayer: scan.usesDataLayer, writesFiles: scan.writesFiles }))')
    // 調べられなかったときは、済んだにも まだ にも倒さない
    expect(src).toContain('setCheckLine(rewriteCheckLine(null))')
  })

  it('見出しは純関数が決める（画面に条件を書き散らさない）', () => {
    expect(src).toContain('storageNoticeHeadline({ hasPlacement: !!placement, warn })')
    // 直す前は、見出しの条件が JSX に直接書かれていた
    expect(src).not.toContain("placement ? '💾 データの保存（用意済み）' : warn ?")
  })
})

describe('storage.scan の3点セット（掟6）', () => {
  it('main の handle が行番号つきで返す', () => {
    const cloud = read('src/main/ipc/cloud.ts')
    expect(cloud).toContain("ipcMain.handle('storage:scan'")
    expect(cloud).toContain('writesFiles: scan.writesFiles')
    // 打ち切りの有無も3点セットで運ぶ（2026-09-23 検分）
    expect(cloud).toContain('truncated: scan.truncated')
    const dl = read('src/main/dataLayer.ts')
    expect(dl).toContain('writesFiles: FileWriteSite[]')
    expect(dl).toContain('if (lines.length > 0) writesFiles.push({ file: rel, lines })')
    // 直す前は相対パスだけを積んでいた
    expect(dl).not.toContain('writesFiles.push(rel)')
    // **koto-data を使っていても書き込みを調べる。** 直す前は else で外していた
    expect(dl).not.toContain('if (usesDataLayer(text)) usedBy.push(rel)\n      else {')
  })

  it('preload が橋渡ししている', () => {
    expect(read('src/main/preload.ts')).toContain("scan: (projectDir: string) => ipcRenderer.invoke('storage:scan', projectDir)")
  })

  it('renderer の型が行番号を持つ', () => {
    const d = read('src/renderer/global.d.ts')
    expect(d).toContain('writesFiles: { file: string; lines: number[] }[]')
    expect(d).toContain('truncated?: boolean')
    expect(d).not.toContain('usedBy: string[]; writesFiles: string[]')
  })

  // storage.scan は HANAMII の画面も使っている。**壊さないこと**
  it('HANAMII の画面は usedBy しか見ていない（形を変えても壊れない）', () => {
    const h = read('src/renderer/components/HanamiiPanel.tsx')
    expect(h).toContain('setUsesData(!!(scan as any)?.usedBy?.length)')
    expect(h).not.toContain('writesFiles')
  })
})

// ── 依頼文は、実際に置いたファイルに合わせる（2026-09-23 実機）─────────────
//
// 依頼文はずっと import の形だけを渡していた。**require で動いているアプリ**に
// その形を頼むと、AI は読み込めるようにしようとして package.json に
// `"type": "module"` を足す。するとアプリ全体が require を使えなくなり、
// **起動しなくなった**（ReferenceError: require is not defined in ES module scope）。
// 実機で実際にこれが起き、利用者のアプリが動かなくなった。

describe('依頼文の書き方は、置いたファイルに合わせる', () => {
  const site = [{ file: 'public/server.js', lines: [66] }]

  it('import のアプリには import の1行を渡す', () => {
    expect(dataLayerUsageLine('esm')).toBe("import { list, get, save, remove } from './koto-data.js'")
    const text = askAiRewriteText(site, 'esm')
    expect(text).toContain("import { list, get, save, remove } from './koto-data.js'")
    expect(text).not.toContain('require(')
  })

  it('require のアプリには require の1行を渡す', () => {
    expect(dataLayerUsageLine('cjs')).toBe("const { list, get, save, remove } = require('./koto-data.cjs')")
    const text = askAiRewriteText(site, 'cjs')
    expect(text).toContain("const { list, get, save, remove } = require('./koto-data.cjs')")
    // **import の形を混ぜない。** 混ぜると AI がアプリを作り変えようとする
    expect(text).not.toContain("from './koto-data.js'")
  })

  // ★ アプリを壊した張本人。どちらの形でも必ず止める
  it('どちらの形でも、package.json の "type" を触らせない', () => {
    for (const kind of ['esm', 'cjs'] as const) {
      const text = askAiRewriteText(site, kind)
      expect(text).toContain('package.json の "type" は変更しないでください')
      // 「ESM へ移行して」とは絶対に言わない
      expect(text).not.toContain('ESM')
      expect(text).not.toContain('"type": "module"')
    }
  })
})

describe('送ってよいかの判断（用意できなければ送らない）', () => {
  const site = [{ file: 'public/server.js', lines: [66] }]

  it('用意できていれば、その形に合った文面を送る', () => {
    const esm = askAiRewritePlan(site, { ok: true, ready: true, moduleKind: 'esm' })
    expect(esm.send).toBe(true)
    if (esm.send) expect(esm.text).toContain("from './koto-data.js'")

    const cjs = askAiRewritePlan(site, { ok: true, ready: true, moduleKind: 'cjs' })
    expect(cjs.send).toBe(true)
    if (cjs.send) expect(cjs.text).toContain("require('./koto-data.cjs')")
  })

  // ★ 送れば必ず失敗する頼みごとになる。送らずに理由を出す
  it('読み込み先が無いときは送らない', () => {
    for (const layer of [
      null,
      undefined,
      { ok: false, ready: false, message: 'テンプレートが見つかりません' },
      { ok: true, ready: false },
      { ok: true, placed: true } as { ok: boolean },
    ]) {
      const plan = askAiRewritePlan(site, layer as never)
      expect(plan.send, JSON.stringify(layer)).toBe(false)
      if (!plan.send) expect(plan.error).toContain('保存の部品を用意できませんでした')
    }
  })

  it('用意できなかった理由が分かれば、画面の文に添える', () => {
    const plan = askAiRewritePlan(site, { ok: false, ready: false, message: 'テンプレートが見つかりません' })
    expect(plan.send).toBe(false)
    if (!plan.send) expect(plan.error).toContain('テンプレートが見つかりません')
  })

  it('形が分からないときは require 側に倒す（勝手に import へ倒さない）', () => {
    // import のアプリに require を頼んでも動かないだけだが、逆は
    // **AI が package.json を書き換えてアプリを壊す**。倒す先は安全な側にする
    const plan = askAiRewritePlan(site, { ok: true, ready: true })
    expect(plan.send).toBe(true)
    if (plan.send) expect(plan.text).toContain("require('./koto-data.cjs')")
  })
})

// ── 「用意できました」の文（2026-09-23 検分）──────────────────────────
// ここは長らく `koto-data.js もプロジェクトに置きました。` という**決め打ち**だった。
// require のアプリに置かれるのは koto-data.cjs なので、**画面だけが違う名前を言う**。
// 利用者はファイル一覧に koto-data.js が見当たらず「用意できていないのでは」と考えたり、
// AI に「koto-data.js を使って」と伝えて、存在しないファイルからの読み込みを
// もう一度作らせることになる。**今回の事故の出発点と同じ『実物と違うことを書く』形。**
describe('保存場所を用意したときの完了文', () => {
  // ★ require のアプリ。ここが今回の指摘そのもの
  it('require のアプリで用意したとき、完了文に koto-data.cjs が出る', () => {
    const text = storagePreparedText('koto-data-abc', true, DATA_LAYER_FILE_CJS)
    expect(text).toContain('koto-data.cjs')
    // 置いていない名前を言わない
    expect(text).not.toContain(DATA_LAYER_FILE)
  })

  it('import のアプリで用意したとき、完了文に koto-data.js が出る', () => {
    const text = storagePreparedText('koto-data-abc', true, DATA_LAYER_FILE)
    expect(text).toContain('koto-data.js')
    expect(text).not.toContain(DATA_LAYER_FILE_CJS)
  })

  // ★ 名前が運ばれてこなかったら、名前を言わない（嘘を書かない）
  it('置いたファイル名が分からなければ、名前を出さない', () => {
    for (const file of [null, undefined, '']) {
      const text = storagePreparedText('koto-data-abc', true, file)
      expect(text).not.toContain('koto-data.js')
      expect(text).not.toContain('koto-data.cjs')
      expect(text).toContain('データの保存の部品')
    }
  })

  it('置いていないときは、置いたとは言わない', () => {
    const text = storagePreparedText('koto-data-abc', false, DATA_LAYER_FILE_CJS)
    expect(text).not.toContain('置きました')
    expect(text).toContain('保存場所『koto-data-abc』を用意しました。')
  })

  it('保存場所の名前と、次にやることは必ず出る', () => {
    const text = storagePreparedText('my-bucket', true, DATA_LAYER_FILE_CJS)
    expect(text).toContain('my-bucket')
    expect(text).toContain('次に公開すると、アプリから読み書きできるようになります。')
  })
})
