import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { IDE_CONTEXT } from '../src/renderer/aiContext'
import { dataLayerUsageLine } from '../src/shared/storageNoticeText'
import { DATA_LAYER_FILE, DATA_LAYER_FILE_CJS } from '../src/shared/objectStorage'

// AI への説明文が、Koto が実際にすることと合っているか（2026-09-23 実機）。
//
// ── 何が起きたか ──────────────────────────────────────────────────────
// 説明文は「koto-data.js が無ければ Koto が自動で用意します」と約束していた。
// **だが Koto は置いていなかった。** 置く条件が「すでに koto-data を使っている
// ファイルがあるか」で、これから書き直してもらう時点では必ず0件だったため。
//
// AI は存在しないファイルからの読み込みを頼まれ、完了できないまま
// 「完了しました」と3回答えた。そのうえ読み込めるようにしようと package.json に
// "type": "module" を足し、**利用者のアプリが起動しなくなった**
// （ReferenceError: require is not defined in ES module scope）。
//
// **出発点は、守れない約束を書いたことである。** 説明文に書いてよいのは、
// Koto が実際にすることだけ。ここでは、文と実物が離れないように縛る。

describe('AI への説明文が、Koto の実物と合っている', () => {
  // ★ 読み込み方の案内は、実際に置くファイルと同じでなければならない。
  //   文字列を二重に書き下すと、置くファイルを変えたときに片方だけ古くなる
  it('読み込み方の案内が、実際に置くファイルと一致している', () => {
    expect(IDE_CONTEXT).toContain(dataLayerUsageLine('esm'))
    expect(IDE_CONTEXT).toContain(dataLayerUsageLine('cjs'))
  })

  it('用意するファイルの名前を、両方とも伝えている', () => {
    expect(IDE_CONTEXT).toContain(DATA_LAYER_FILE)
    expect(IDE_CONTEXT).toContain(DATA_LAYER_FILE_CJS)
  })

  // ★ アプリを壊した変更。ここを言わなかったために起きた
  it('package.json の "type" を変えさせない', () => {
    expect(IDE_CONTEXT).toContain('package.json の "type" を変更してはいけません')
  })

  // ★ 「ESM へ移行して」はアプリ全体の作り変えで、途中で止まると起動しなくなる。
  //   コードを書かない利用者に背負わせるものではない
  it('形を作り変えるよう求めていない', () => {
    expect(IDE_CONTEXT).not.toContain('ESM へ移行')
    expect(IDE_CONTEXT).not.toContain('ESM に移行')
    expect(IDE_CONTEXT).not.toContain('"type": "module" を追加')
  })

  // ★ 直す前の文（守れない約束）が戻ってきたら落ちる
  it('直す前の、守れない約束が戻っていない', () => {
    expect(IDE_CONTEXT).not.toContain('koto-data.js が無ければ Koto が自動で用意します')
  })

  it('どちらが置かれているかを、AI が自分で確かめる手順を示している', () => {
    expect(IDE_CONTEXT).toContain('list_files で確かめ')
  })
})

// ── 実物のアプリが壊れていた4つの形を、説明文で塞ぐ（2026-09-24）──────────
// docs/storage-options.md の調査で、公開中のアプリ（ScheduleAPP）が4つの形で
// 壊れていた: ①全件を1レコードに詰める ②変更のたび全件を PUT ③インスタンスが
// 増えて互いに上書き ④remove を import しているのに一度も呼ばず、消した件が復活。
// **AI への説明文が、この4つを一度も止めていなかった。**
describe('AI への説明文が、実物で起きた壊れ方を止めている', () => {
  it('★ 全件を1レコードに詰めさせない（今回の事故の原因）', () => {
    expect(IDE_CONTEXT).toContain('1件＝1レコードにすること')
  })

  it('★ 消すときは remove を呼ばせる（呼ばないと再起動で復活する）', () => {
    expect(IDE_CONTEXT).toContain('消すときは remove を呼ぶこと')
  })

  it('★ 足した引数（limit / skip / where / sort）を伝えている', () => {
    for (const arg of ['limit', 'skip', 'where', 'sort', 'order']) {
      expect(IDE_CONTEXT, `${arg} を伝えていない`).toContain(arg)
    }
  })

  // ★ ここを曖昧にすると「絞り込めば速くなる」という新しい守れない約束になる
  it('★ where と sort が通信を減らさないことを伝えている', () => {
    expect(IDE_CONTEXT).toContain('where と sort は全部読んでから効くので、通信は減りません')
  })

  it('★ 同時に書き換えると断られること（取り直して書き直す）を伝えている', () => {
    expect(IDE_CONTEXT).toContain('save が断ることがあります')
    expect(IDE_CONTEXT).toContain('overwrite: true')
  })

  // ★ 守れない約束（1件1ファイルなら同時更新でも壊れない）が戻っていない
  it('★ 「同時更新でも壊れない」と書いていない', () => {
    expect(IDE_CONTEXT).not.toContain('同時更新でも壊れない')
  })
})

// ── 約束が、いちばん通る道でも守られているか（2026-09-23 検分）────────────
//
// 説明文は「koto-data のファイルは Koto が用意します」と言い切っている。
// ところが置く入口は、③公開の「保存場所を用意する」と「AIに書き直してもらう」の
// 2つだけだった。利用者が ① 作る で「問い合わせを保存して」と頼むと、AI はこの
// 説明文どおり koto-data を使うコードを書くが、その時点ではどちらのファイルも無い。
// そのまま ② 試す を押すと `Cannot find module './koto-data.cjs'` で起動しない。
//
// **今回の事故とまったく同じ形（存在しないファイルからの読み込み）が、入口を
// 変えて残っていた。** 走らせる／公開する直前にも必ず通すこと。
// （ensureDataLayer は既にあれば触らないので、何度呼んでも安全。）
describe('「Koto が用意します」の約束が、実行と公開の直前でも守られている', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8')

  /**
   * 文字列の位置。**-1（＝その文字列が無い）はここで落とす。**
   *
   * 位置比較へ -1 をそのまま渡すと、守りが消えたときに素通りする形がある
   * （`-1 < n` は常に真）。この案件では tests/imageBuildWiring.test.ts と
   * tests/applyBucket.test.ts で実際にその形が見つかっている（2026-09-25 検分）。
   */
  const at = (src: string, needle: string, why: string, from = 0): number => {
    const i = src.indexOf(needle, from)
    expect(i, why).toBeGreaterThan(-1)
    return i
  }

  // ★ いちばん通る道（① 作る → すぐ ② 試す）
  it('② 試す は、走らせる直前に koto-data を用意する', () => {
    const src = read('src/renderer/components/WorkflowBar.tsx')
    const ensure = at(src, 'await api.storage.ensureLayer(projectDir)', '② 試す で ensureLayer を通していない')
    // **handleRun の中で、実行方法を決めるより前**であること（位置まで縛る）
    const handleRun = at(src, 'async function handleRun()', 'handleRun が見つからない')
    const plan = at(src, 'const plan = await planRun(', '実行方法を決める処理（planRun）が見つからない')
    expect(ensure, 'handleRun の外で置いている').toBeGreaterThan(handleRun)
    expect(ensure, '実行方法を決めたあとに置いている').toBeLessThan(plan)
  })

  // ★ AppRun（コンテナ）。読み込み先がイメージに入らないと起動できない
  it('AppRun への公開は、組み立てる前に koto-data を用意する', () => {
    const src = read('src/main/ipc/cloud.ts')
    const apply = at(src, "ipcMain.handle('cloud:apply'", 'cloud:apply の処理が見つからない')
    const ensure = at(src, 'ensureDataLayer(resolvePublishRoot(projectDir), projectDir)', 'cloud:apply で ensureDataLayer を通していない', apply)
    // spec を読むより前＝公開の処理が始まる前
    const spec = at(src, 'const spec = loadCloudSpec(projectDir)', 'cloud:apply で spec を読んでいない', apply)
    expect(ensure, 'spec を読んだあとに koto-data を置いている').toBeLessThan(spec)
  })

  // ★ HANAMII。ZIP に入っていなければ、公開先には無い
  it('HANAMII への公開は、ZIP に詰める前に koto-data を用意する', () => {
    const src = read('src/main/ipc/hanamii.ts')
    const ensure = at(src, 'ensureDataLayer(root, projectDir)', 'hanamii:publish で ensureDataLayer を通していない')
    const zip = at(src, 'const zip = await zipProjectToBuffer(root, extra, !!extra)', 'ZIP に詰める処理が見つからない')
    expect(ensure, 'ZIP に詰めたあとに koto-data を置いている（公開先には入らない）').toBeLessThan(zip)
  })

  // ★ レンタルサーバ。rsync で送る前に置く
  it('レンタルサーバへの公開は、送る前に koto-data を用意する', () => {
    const src = read('src/renderer/components/PublishModal.tsx')
    const ensure = at(src, 'await window.electronAPI.storage.ensureLayer(projectDir)', 'startPublish で ensureLayer を通していない')
    const run = at(src, 'onRun(cmd)', '送る処理（onRun）が見つからない')
    expect(ensure, '送ったあとに koto-data を置いている').toBeLessThan(run)
  })

  // ★ Vercel。アップロードするファイルを集める前に置く
  it('Vercel への公開は、ファイルを集める前に koto-data を用意する', () => {
    const src = read('src/main/ipc/vercel.ts')
    const ensure = at(src, 'ensureDataLayer(resolvePublishRoot(projectDir), projectDir)', 'vercel:publish で ensureDataLayer を通していない')
    const collect = at(src, 'const files = collectDeployFiles(resolvePublishRoot(projectDir))', 'アップロードするファイルを集める処理が見つからない')
    expect(ensure, 'ファイルを集めたあとに koto-data を置いている').toBeLessThan(collect)
  })

  // ★ 専有型の AppRun（⑧）。**ここだけ数え上げから漏れていた**（2026-09-25 検分・指摘#34）。
  //   振る舞いは tests/dedicatedDataLayer.test.ts が実行で固定しているが、「経路を数え上げる」
  //   見張りは、**6つ目の公開先が増えたときに抜けを拾う唯一の場所**なので1件だけ古い数のまま
  //   残していた。ここに並べておけば、次に足りない経路が出たときにこの describe で見つかる。
  it('専有型への公開は、組み立てる前に koto-data を用意する', () => {
    const src = read('src/main/ipc/apprunDedicated.ts')
    const publish = at(src, "ipcMain.handle('apprunDedicated:publishApp'", 'apprunDedicated:publishApp の処理が見つからない')
    const ensure = at(src, 'ensureDataLayer(resolvePublishRoot(projectDir), projectDir)', '専有型の公開で ensureDataLayer を通していない', publish)
    // **像を組み立てるより前**であること。あとで置いても、像の中には入らない
    const image = at(src, 'const img = await prepareAppImage(', '像を組み立てる処理（prepareAppImage）が見つからない', publish)
    expect(ensure, '像を組み立てたあとに koto-data を置いている（像には入らない）').toBeLessThan(image)
  })

  // ★ 数え上げそのもの。**公開先は5つ（＋② 試す）**。増えたらここで気づく
  it('★ 公開の経路を、1つも落とさずに数え上げている', () => {
    const ROUTES: readonly { rel: string; needle: string }[] = [
      { rel: 'src/main/ipc/cloud.ts', needle: 'ensureDataLayer(resolvePublishRoot(projectDir), projectDir)' },           // 共用型 AppRun
      { rel: 'src/main/ipc/apprunDedicated.ts', needle: 'ensureDataLayer(resolvePublishRoot(projectDir), projectDir)' }, // 専有型 AppRun
      { rel: 'src/main/ipc/hanamii.ts', needle: 'ensureDataLayer(root, projectDir)' },                                   // HANAMII
      { rel: 'src/main/ipc/vercel.ts', needle: 'ensureDataLayer(resolvePublishRoot(projectDir), projectDir)' },          // Vercel
      { rel: 'src/renderer/components/PublishModal.tsx', needle: 'await window.electronAPI.storage.ensureLayer(projectDir)' }, // レンタルサーバ
      { rel: 'src/renderer/components/WorkflowBar.tsx', needle: 'await api.storage.ensureLayer(projectDir)' },           // ② 試す
    ]
    for (const { rel, needle } of ROUTES) {
      at(read(rel), needle, `${rel} で koto-data を用意していない（この経路だけ約束が守られない）`)
    }
  })

  // ★ 説明文の側。「ファイルが無いから書けない」で AI を止まらせない
  it('まだ置かれていなくても、そのまま書いてよいと伝えている', () => {
    expect(IDE_CONTEXT).toContain('まだファイルが見当たらなくても')
  })

  // ★ いつ置くのかを書く（条件を付けずに言い切ると、また守れない約束になる）
  it('いつ置くのかを、実物どおりに書いている', () => {
    expect(IDE_CONTEXT).toContain('「② 試す」「③ 公開」を押した直前に')
  })
})

// ── AI への説明文と、テンプレートの説明が食い違わない（2026-09-24 検分）────
//
// ① list の例が limit と where/sort を1つにまとめていた。AI は例を丸ごと真似るので、
//    limit を付けているのに全件読みへ落ちるコードが量産される（テンプレート冒頭は
//    「where や sort を指定すると、limit を付けていても全件を読みます」と書いてある）。
// ② id の話が1行も無かった。自分で決めた id が1件でも混ざると、そのコレクションは
//    limit を付けても速くならない。しかも動作は正しいままなので誰も気づけない。
// ③ save が返したレコードを使い続けることを言っていなかった。読んだ写しを持ち回して
//    保存し直すと、2回目から断られる（公開中のアプリが、まさにその形だった）。
describe('AI への説明文が、速くならない書き方を止めている', () => {
  it('★ 速くしたいときの例と、絞り込みの例を分けている', () => {
    expect(IDE_CONTEXT).toContain("await list('entries', { limit: 20, skip: 0 })")
    // ★ 直す前の「全部入り」の例が戻ってきたら落ちる
    expect(IDE_CONTEXT).not.toContain("{ limit: 20, skip: 0, where:")
  })

  it('★ where や sort を一緒に付けると全件を読むことを、はっきり書いてある', () => {
    expect(IDE_CONTEXT).toContain('where や sort を一緒に付けると、limit を付けていても全件を読みます')
  })

  // ★ テンプレート冒頭（利用者向け）と、AI への説明で、同じ事実を言っていること
  it('★ テンプレートも同じことを書いている（文と実物を離さない）', () => {
    const template = fs.readFileSync(path.join(process.cwd(), 'templates/koto-data.js'), 'utf8')
    expect(template).toContain('where や sort を指定すると、limit を付けていても全件を読みます')
    expect(template).toContain('自分で id を決めて保存した件が混ざっていると、limit を付けても全件を')
  })

  it('★ id を自分で決めさせない（決めると limit が効かなくなる）', () => {
    expect(IDE_CONTEXT).toContain('id は自分で決めないこと')
    // 既存レコードの更新はできなくなっては困る
    expect(IDE_CONTEXT).toContain('読んだレコードの id をそのまま使って更新するのは構いません')
  })

  it('★ save が返したレコードを使い続けることを伝えている', () => {
    expect(IDE_CONTEXT).toContain('save が返したレコード')
  })
})
