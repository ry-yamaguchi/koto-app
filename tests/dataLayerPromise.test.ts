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

  // ★ いちばん通る道（① 作る → すぐ ② 試す）
  it('② 試す は、走らせる直前に koto-data を用意する', () => {
    const src = read('src/renderer/components/WorkflowBar.tsx')
    const at = src.indexOf('await api.storage.ensureLayer(projectDir)')
    expect(at, '② 試す で ensureLayer を通していない').toBeGreaterThan(-1)
    // **handleRun の中で、実行方法を決めるより前**であること（位置まで縛る）
    const handleRun = src.indexOf('async function handleRun()')
    const plan = src.indexOf('const plan = await planRun(')
    expect(handleRun).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(handleRun)
    expect(at).toBeLessThan(plan)
  })

  // ★ AppRun（コンテナ）。読み込み先がイメージに入らないと起動できない
  it('AppRun への公開は、組み立てる前に koto-data を用意する', () => {
    const src = read('src/main/ipc/cloud.ts')
    const apply = src.indexOf("ipcMain.handle('cloud:apply'")
    expect(apply).toBeGreaterThan(-1)
    const at = src.indexOf('ensureDataLayer(resolvePublishRoot(projectDir), projectDir)', apply)
    expect(at, 'cloud:apply で ensureDataLayer を通していない').toBeGreaterThan(-1)
    // spec を読むより前＝公開の処理が始まる前
    expect(at).toBeLessThan(src.indexOf('const spec = loadCloudSpec(projectDir)', apply))
  })

  // ★ HANAMII。ZIP に入っていなければ、公開先には無い
  it('HANAMII への公開は、ZIP に詰める前に koto-data を用意する', () => {
    const src = read('src/main/ipc/hanamii.ts')
    const at = src.indexOf('ensureDataLayer(root, projectDir)')
    expect(at, 'hanamii:publish で ensureDataLayer を通していない').toBeGreaterThan(-1)
    expect(at).toBeLessThan(src.indexOf('const zip = await zipProjectToBuffer(root, extra, !!extra)'))
  })

  // ★ レンタルサーバ。rsync で送る前に置く
  it('レンタルサーバへの公開は、送る前に koto-data を用意する', () => {
    const src = read('src/renderer/components/PublishModal.tsx')
    const at = src.indexOf('await window.electronAPI.storage.ensureLayer(projectDir)')
    expect(at, 'startPublish で ensureLayer を通していない').toBeGreaterThan(-1)
    expect(at).toBeLessThan(src.indexOf('onRun(cmd)'))
  })

  // ★ Vercel。アップロードするファイルを集める前に置く
  it('Vercel への公開は、ファイルを集める前に koto-data を用意する', () => {
    const src = read('src/main/ipc/vercel.ts')
    const at = src.indexOf('ensureDataLayer(resolvePublishRoot(projectDir), projectDir)')
    expect(at, 'vercel:publish で ensureDataLayer を通していない').toBeGreaterThan(-1)
    expect(at).toBeLessThan(src.indexOf('const files = collectDeployFiles(resolvePublishRoot(projectDir))'))
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
