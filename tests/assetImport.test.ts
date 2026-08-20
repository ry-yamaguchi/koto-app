import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isImageFileName, safeAssetName, destinationDir, uniqueName, tellAiAboutAsset,
  assetSavedNote, useImageHint, ASSET_USE_LABEL,
} from '../src/shared/assetImport'
import { IDE_CONTEXT } from '../src/renderer/aiContext'
import { MATERIALS_DIR } from '../src/shared/publishExclude'

// ── 2026-08-19 Ryosuke 提案 ─────────────────────────────────────────
// 画像は「AIに見せる」ためだけに読み込まれ、**プロジェクトには残らなかった**。
// アプリの部品として使えるようにする。ただし「置いておきたいが公開はしたくない」
// ものもあるので、置き場を分ける。

describe('画像かどうか', () => {
  it('よくある形式を受ける', () => {
    for (const n of ['a.png', 'B.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg', 'g.avif']) {
      expect(isImageFileName(n)).toBe(true)
    }
  })

  it('画像でないものは受けない', () => {
    for (const n of ['a.txt', 'b.pdf', 'c', 'd.png.zip']) expect(isImageFileName(n)).toBe(false)
  })
})

describe('入れ先を決める', () => {
  it('★ public があれば public/images（公開先によって配られる場所が違う）', () => {
    expect(destinationDir('app', ['index.html', 'public', 'server.js'])).toBe('public/images')
  })

  it('無ければ images', () => {
    expect(destinationDir('app', ['index.html', 'style.css'])).toBe('images')
  })

  it('★ 素材は公開しない置き場へ', () => {
    expect(destinationDir('material', ['public'])).toBe(MATERIALS_DIR)
  })
})

describe('名前の扱い', () => {
  it('★ 日本語は残す（利用者が付けた名前を勝手に消さない）', () => {
    expect(safeAssetName('店の外観.png')).toBe('店の外観.png')
  })

  it('パス区切りと先頭のドットだけ直す', () => {
    expect(safeAssetName('a/b.png')).toBe('a-b.png')
    expect(safeAssetName('.hidden.png')).toBe('hidden.png')
    expect(safeAssetName('')).toBe('image.png')
  })

  it('★ 同じ名前があっても、黙って上書きしない', () => {
    expect(uniqueName('logo.png', [])).toBe('logo.png')
    expect(uniqueName('logo.png', ['logo.png'])).toBe('logo-2.png')
    expect(uniqueName('logo.png', ['logo.png', 'logo-2.png'])).toBe('logo-3.png')
  })

  it('拡張子が無くても連番を付けられる', () => {
    expect(uniqueName('photo', ['photo'])).toBe('photo-2')
  })
})

describe('入れたことを AI に知らせる', () => {
  it('★ 入れただけでは AI は知らない（知らせるところまでが「入れる」）', () => {
    const t = tellAiAboutAsset('public/images/logo.png', 'app')
    expect(t).toContain('public/images/logo.png')
    expect(t).toContain('使ってください')
  })

  it('素材のときは、公開されないことを伝える', () => {
    const t = tellAiAboutAsset(`${MATERIALS_DIR}/写真.png`, 'material')
    expect(t).toContain('公開はされません')
  })
})

// ── 落とせる場所と、そこで起きること（2026-08-19 Ryosuke 指摘）──────────
// 「ファイル一覧」と「チャットの履歴」でしか受け取れず、しかも**挙動が違った**。
// どこに落としても受け取り、何が起きるかを見せる。
describe('落とせる場所', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

  it('★ 画面全体で受け取る', () => {
    const app = read('src/renderer/App.tsx')
    expect(app).toContain("sakura:attach-images")
    expect(app).toContain('ここに落とすと、AIに見せます')
  })

  it('★ ファイル一覧に落としたときは、そちらの動きが優先される', () => {
    // 止めないと、取り込みと添付の両方が起きる
    const sidebar = read('src/renderer/components/Sidebar.tsx')
    expect(sidebar).toMatch(/onDrop=\{e => \{ e\.preventDefault\(\); e\.stopPropagation\(\)/)
  })

  it('★ 受け口を2つ持たない（実際の取り込みは addImages に一本化）', () => {
    const panel = read('src/renderer/components/ChatPanel.tsx')
    // 受け取った直後に addImages を呼ぶ（別の取り込み処理を作らない）
    expect(panel).toMatch(/if \(files\?\.length\) void addImages\(files\)[\s\S]{0,200}sakura:attach-images/)
  })
})

describe('画像の処理のしかたを、正しく伝える', () => {
  it('★ 二段構え（読み取りは視覚モデル・続きはいまのモデル）と書く', () => {
    // 実装は twoStageVision: true。「画像対応モデルで処理します」だと
    // モデルが丸ごと入れ替わるように読める（2026-08-19 Ryosuke 指摘）
    const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/ChatPanel.tsx'), 'utf-8')
    expect(panel).toContain('が読み取り')
    expect(panel).toContain('続きは')
    expect(panel).not.toContain('送信時に画像対応モデル（')
  })
})

// ── AI に「Koto が保存できる」と伝える（2026-08-19 実機）────────────────
// 添付画像について AI がこう答えた:
//   「私は画像ファイルを直接保存することができないため、まずこの画像を
//     プロジェクトに入れてもらう必要があります。PCに保存して、
//     ファイルツリーにドラッグ＆ドロップしてください」
// **IDE でできる作業をユーザーにやらせない**という決まりに反している。
// AI 自身は保存できない（画像は見せているだけ）が、Koto はできる。
describe('添付画像の案内を、AI に教える', () => {
  const ctx = readFileSync(join(__dirname, '..', 'src/renderer/aiContext.ts'), 'utf-8')

  it('★ 手作業を頼ませない', () => {
    expect(ctx).toContain('手作業を頼まないこと')
    expect(ctx).toContain('📁')
  })

  // ── 案内は Koto が出す（2026-08-19 実機・Ryosuke 指摘）────────────────
  // AI に案内させると、**古い会話を真似て長い手順**を書いた。
  // 文面は毎回同じでよいので Koto が出し、AI には黙っていてもらう。
  it('★★ AI に保存のしかたを説明させない', () => {
    expect(IDE_CONTEXT).toContain('保存のしかた（ボタン名・手順・選び方）を説明してはいけません')
    expect(IDE_CONTEXT).toContain('1文だけ')
  })

  it('★★ 押す場所の案内は、Koto の文言として持つ', () => {
    const hint = useImageHint(1)
    expect(hint).toContain(ASSET_USE_LABEL)
    expect(hint).toContain('画像の下')
    expect(hint).toContain('自動で進みます')
  })

  it('★ 複数枚なら、まとめて指す言い方にする', () => {
    expect(useImageHint(2)).toContain('これらの画像')
    expect(useImageHint(1)).toContain('この画像')
  })

  // 2026-08-19 実機。ボタンの文字を変えたのに案内が「【📁】」のままだと、
  // 利用者は言われた場所を探しても見つけられない（掟9）。
  it('★ 案内する言葉が、画面のボタンと同じ', () => {
    expect(IDE_CONTEXT).toContain(ASSET_USE_LABEL)
    const button = readFileSync(join(__dirname, '..', 'src/renderer/components/AssetUseButton.tsx'), 'utf-8')
    expect(button).toContain('ASSET_USE_LABEL')
    // 定数を素通りして直書きすると、また片方だけ古くなる
    expect(button).not.toContain(">📁 画像を使う<")
  })

  // 2026-08-19: 確認画面をやめたので、公開したくない画像は AI が置く
  it('★ 公開したくない画像の置き場を、AI が知っている', () => {
    expect(IDE_CONTEXT).toContain(MATERIALS_DIR)
  })

  it('★ IDEモードだけに伝える（チャットモードには 📁 が無い）', () => {
    const ide = ctx.slice(ctx.indexOf('export const IDE_CONTEXT'), ctx.indexOf('export const CHAT_CONTEXT'))
    const chat = ctx.slice(ctx.indexOf('export const CHAT_CONTEXT'))
    expect(ide).toContain('IMAGE_RULE_IDE')
    expect(chat).not.toContain('IMAGE_RULE_IDE')
  })
})

// ── 二重に受け取らない（2026-08-19 実機）────────────────────────────────
// 「一つの画像をドロップしたのに2つになる現象が発生した」
// 画面全体でも受けるようにしたため、チャットの上に落とすと
// ここで addImages → 画面全体の受け口へ伝わって、もう一度 addImages、で2枚になっていた。
describe('落としたものを二重に受け取らない', () => {
  const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/ChatPanel.tsx'), 'utf-8')

  it('★ チャットの上に落としたら、そこで止める', () => {
    expect(panel).toMatch(/onDrop=\{e => \{\s*e\.preventDefault\(\); e\.stopPropagation\(\)/)
  })

  // 2026-08-19（続き）: 止めるのは**落としたときだけ**にした。重なっている合図は
  // 上へ流す（案内は画面全体のものひとつでよい・Ryosuke 指摘で二重の枠を整理）。
  it('重なっている合図は止めない（案内をひとつにするため）', () => {
    const at = panel.indexOf('onDrop={e => {\n          e.preventDefault(); e.stopPropagation()')
    expect(at).toBeGreaterThan(0)
    // チャットの受け口自身は、重なりの見た目を持たない
    expect(panel).not.toContain('画像をドロップしてAIに渡す')
  })
})

describe('保存したあとの案内', () => {
  const ctx = readFileSync(join(__dirname, '..', 'src/renderer/aiContext.ts'), 'utf-8')

  it('★ ファイル名を尋ねさせない（Koto が決めて伝える）', () => {
    expect(ctx).toContain('ファイル名や保存場所を尋ねてはいけません')
  })

  // 2026-08-19: 入力欄に文を差し込む仕組みはやめた。案内も実物に合わせる（掟9）
  it('★★ 「入力欄に文が入る」と言わせない（もう入らない）', () => {
    expect(IDE_CONTEXT).not.toContain('入力欄に自動で入ります')
    expect(IDE_CONTEXT).toContain('保存先のパスがこの指示に添えられています')
  })

  // 画面に出す一言は短く。相対パスでの参照のしかたは AI に伝えることであって、
  // 利用者に見せる話ではない（2026-08-19 Ryosuke 指摘）
  // 2026-08-19 Ryosuke 指摘: 「アプリに使われるファイルが公開されるのは自明なので、
  // その警告は不要」。書くと「まずいことをしたのか」と誤解させる。
  it('★★ 保存の知らせに、利用者に要らない話を書かない', () => {
    const n = assetSavedNote('images/a.jpg', 'app')
    expect(n).toContain('images/a.jpg')
    expect(n).not.toContain('相対パス')
    expect(n).not.toContain('公開されます')
  })

  it('★★ 断るのは逆の場合だけ（素材＝公開されない）', () => {
    expect(assetSavedNote(`${MATERIALS_DIR}/a.jpg`, 'material')).toContain('公開されません')
  })

  // 2026-08-19 実機。AI が**会話に残る自分の古い発言を真似て**、廃止した手順を
  // 案内し続けた（「【アプリで使う（公開されます）】を選び、そのまま送信してください」）。
  // 指示を直しても、古い会話を続けている限り再発する。真似るなと明示する。
  it('★★ 古い案内が履歴に残っていても真似させない', () => {
    expect(IDE_CONTEXT).toContain('古い版のものです')
  })
})

// ── 送信したあとも入れられる（2026-08-19 実機）──────────────────────────
// AI は「添付画像の右下の【📁】を押してください」と案内する。ところが
// **送信すると添付欄は空になり、その📁が無くなっていた**。
// 「押してください」と言われた場所に無いのは、いちばん困る形。
describe('送信済みの画像にも入れる導線がある', () => {
  const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/ChatPanel.tsx'), 'utf-8')
  const inMessages = panel.slice(panel.indexOf('msg.images.map('), panel.indexOf('{pendingApproval &&'))

  it('★ 会話の中の画像にも、押せるボタンが付く', () => {
    expect(inMessages).toContain('<AssetUseButton')
  })

  // 送信すると添付欄は空になる。ここが唯一の拠り所なので、押した時点で入れる
  it('★ 押したらその場で入れる（送信を待たない）', () => {
    expect(inMessages).toContain('importFromMessage({ url: src, name })')
  })

  // ── 入れ終わったら導線を消す（2026-08-19 実機・Ryosuke 指摘）──────────
  // 「画像を使うボタンを押して送信した場合には、履歴の画像を使うボタンは
  //   不要ではないだろうか？」
  // 残っていると押せてしまい、**同じ画像がもう1枚増える**（uniqueName が -2 を付ける）。
  it('★★ もう入れた画像には、ボタンを出さない', () => {
    expect(inMessages).toContain('!savedImages.has(src)')
  })

  it('★★ 入れた画像そのものを覚えている（送信で入れた分も含む）', () => {
    // rel（入れ先）ではなく url（画像そのもの）で覚える。同じ画像を2度入れさせない
    expect(panel).toContain('saved.push(img.url)')
    expect(panel).toContain('setSavedImages(prev => new Set([...prev, ...saved]))')
  })

  it('★ 名前が無い画像（貼り付け・送信済み）にも名前を付ける', () => {
    expect(panel).toContain('defaultImageName(mediaTypeOf(src))')
  })

  // 2026-08-19: 送信済みの画像から入れたときは、**会話に一言だけ残す**
  // （小さな字の知らせを添付欄に出す形はやめた。AIも履歴からこの一言を読める）
  // ── 押したら、そのまま続きをやる（2026-08-19 実機・Ryosuke 指摘）────────
  // 押した人がやりたいことは**さっき頼んだこと**。保存できたらこちらから送る。
  it('★★ 押したら、続きを自動で送る（利用者は何も打たない）', () => {
    const at = panel.indexOf('const importFromMessage')
    const block = panel.slice(at, at + 1800)
    expect(block).toMatch(/chat\.send\('画像を使えるようにしました。さきほどの依頼を続けてください。', \[\], forAi\)/)
  })

  it('★★ 応答中には割り込まない（そのときは履歴に残すだけ）', () => {
    const at = panel.indexOf('const importFromMessage')
    const block = panel.slice(at, at + 1800)
    expect(block).toContain('if (chat.isLoading)')
    expect(block).toContain('hidden: true')
  })

  it('★ 入れられなかったら、続きは送らない', () => {
    const at = panel.indexOf('const importFromMessage')
    expect(panel.slice(at, at + 1800)).toContain('if (!done.length) return')
  })

  it('★ 送信済みから入れたら、会話に一言残す', () => {
    expect(panel).toContain('assetSavedNote(rel, purpose)')
    expect(panel).toContain('toolNote: true')
  })

  // ── 2026-08-19 実機。AI が「保存できていないので、もう一度保存して
  //    パスを教えてください」と言い続けた。原因は知らせ方の取り違え:
  //    toolNote は**表示専用でAIには送られない**決まりだった（useAiChat が
  //    filter(m => !m.toolNote) で落とす）。AI には hidden で届ける。
  it('★★ 保存した事実が、AI にも届く', () => {
    const at = panel.indexOf('const importFromMessage')
    const block = panel.slice(at, at + 1600)
    expect(block).toContain('tellAiAboutAsset(rel, purpose)')
    expect(block).toContain('hidden: true')
  })

  it('★★ 送信で入れた分も、次のターン以降に残す', () => {
    const at = panel.indexOf('const send = useCallback')
    const block = panel.slice(at, at + 1800)
    expect(block).toMatch(/content: forAi, hidden: true/)
  })

  // ── 押す場所は「送信」のとなり（2026-08-19 Ryosuke 指摘）──────────────
  // 「『画像を使う』ボタンが画像の上に表示されるのはわかりにくい」
  it('★★ 添付したサムネイルの上には、ボタンを置かない', () => {
    const thumbs = panel.slice(panel.indexOf('{pendingImages.map((img, i) => ('), panel.indexOf('<textarea'))
    expect(thumbs.length).toBeGreaterThan(100) // 目印がずれていないこと
    expect(thumbs).not.toContain('<AssetUseButton')
  })

  it('★★ 印は 📎 と 送信 の間にある', () => {
    const row = panel.slice(panel.indexOf('title="画像を添付"'), panel.indexOf('onClick={() => void send()}'))
    expect(row.length).toBeGreaterThan(100) // 目印がずれていないこと
    expect(row).toContain('<AssetUseCheckbox')
  })

  // ── 送信まで入(オン)のまま待つ印は、チェックボックス（2026-08-19 Ryosuke 指摘）──
  // 押すたびに姿が変わるボタンより、入切がそのまま見える方が正しい。
  // 送信済みの画像は「押した時点で入る」ただの操作なので、そちらはボタンのまま
  //（待たせる状態が無いものにチェックを使うと、入っているように見えてしまう）。
  it('★★ 添付は入切が見える形（チェックボックス）', () => {
    const btn = readFileSync(join(__dirname, '..', 'src/renderer/components/AssetUseButton.tsx'), 'utf-8')
    expect(btn).toContain("type=\"checkbox\"")
    expect(btn).toContain('export function AssetUseCheckbox')
  })

  it('★ 送信済みの画像の方は、押したら終わりの操作（ボタン）', () => {
    const btn = readFileSync(join(__dirname, '..', 'src/renderer/components/AssetUseButton.tsx'), 'utf-8')
    const at = btn.indexOf('export function AssetUseButton')
    expect(btn.slice(at)).toContain('<button')
    expect(btn.slice(at)).not.toContain('checkbox')
  })

  it('★ 添付が複数枚なら、まとめて入れる（1枚ずつ選ばせない）', () => {
    expect(panel).toContain('count={pendingImages.length}')
    expect(panel).toContain('putIntoProject(attached, choice)')
  })
})

// ── 押したら印が付くだけ・入れるのは送信のとき（2026-08-19 実機・Ryosuke 指摘）──
// 「この仕組みは良くない。チャット欄がごちゃっとしてしまうし、ユーザーが混乱する。
//   画像を使うボタンを押すと押したことが分かるようになり（解除も可能）、
//   送信を押した際にAIに必要な情報が付与されて送信される形にするか、
//   ユーザーに見えないところで処理をするようにしたい」
//
// 以前は押した瞬間に入れ、**入力欄に長い説明文を差し込み**、さらに小さな字の
// 知らせを出していた。入力欄は利用者が打つ場所であって、Kotoの説明の置き場ではない。
describe('添付画像は、送信のときに入れる', () => {
  const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/ChatPanel.tsx'), 'utf-8')
  const chat = readFileSync(join(__dirname, '..', 'src/renderer/hooks/useAiChat.ts'), 'utf-8')

  it('★★ チェックを入れた時点では入れない（印を付けるだけ）', () => {
    const at = panel.indexOf('checked={assetChoice')
    const block = panel.slice(at, at + 400)
    expect(block).toContain("onChange={next => setAssetChoice(next ? 'app' : null)}")
    expect(block).not.toContain('putIntoProject')
  })

  // ── 確認画面はもう出さない（2026-08-19 Ryosuke 指摘）────────────────
  // 「アプリで使えば公開されるのは自明だし、何も考えずに送信を押せば
  //   勝手に添付されるだけになると思うがどうか？」→ そのとおりにした
  it('★★ 押したあとに選ばせない（画面をひとつ減らした）', () => {
    expect(panel).not.toContain('AssetImportPanel')
    expect(panel).not.toContain('importHeading')
  })

  it('★★ 入力欄に説明文を差し込まない', () => {
    // ここが今回いちばんの直し。利用者が打った文と混ざって読みにくかった
    expect(panel).not.toMatch(/setInput\(prev =>[^\n]*tellAiAboutAsset/)
  })

  it('★★ 送信のときに入れて、AI にだけ伝える', () => {
    const at = panel.indexOf('const send = useCallback')
    const block = panel.slice(at, at + 2200) // 案内の追加で伸びたぶんまで見る
    expect(block).toContain('putIntoProject(attached, choice)')
    expect(block).toContain('tellAiAboutAsset')
    expect(block).toMatch(/chat\.send\(text, images, forAi \|\| undefined\)/)
  })

  it('★★ AI にだけ添えた一言は、吹き出しには出さない', () => {
    // pagesBlock / searchBlock / ragBlock と同じ扱い（吹き出しの content は text のまま）
    expect(chat).toContain('const assetBlock = aiOnlyNote')
    expect(chat).toMatch(/apiText = text \+ assetBlock/)
    expect(chat).toMatch(/sendViaClaude\(text \+ assetBlock/)
    expect(chat).not.toMatch(/content: text \+ assetBlock/)
  })

  it('★ 印は外せる（チェックを外す）', () => {
    const at = panel.indexOf('checked={assetChoice')
    expect(panel.slice(at, at + 400)).toContain(": null)")
  })

  it('★ 添付が無くなったら印も外れる', () => {
    expect(panel).toMatch(/pendingImages\.length === 0\) setAssetChoice\(null\)/)
  })

  it('★ 入れられなかったときは、黙って落とさず画面に出す', () => {
    const at = panel.indexOf('const send = useCallback')
    expect(panel.slice(at, at + 1400)).toContain('failed.length')
  })
})

describe('入れたあと会話に残す一言', () => {
  it('★ どこに入れたかを書く', () => {
    const n = assetSavedNote('public/images/hero.jpg', 'app')
    expect(n).toContain('public/images/hero.jpg')
  })

  it('★ 素材は「公開されません」と書く（取り違えると事故になる）', () => {
    const n = assetSavedNote(`${MATERIALS_DIR}/hero.jpg`, 'material')
    expect(n).toContain('公開されません')
    expect(n).not.toContain('この場所は公開されます')
  })
})

// ── 入力欄は「打つ場所」であって説明の置き場ではない（2026-08-19 Ryosuke 指摘）──
// 「メッセージを入力と、欄の左下のクリップマークだけで良いと思うがどうか？」
// 以前の注意書きは2行に折り返して場所を取り、毎回目に入っていた。
// 使い方は 📎 のツールチップと、落としたときの案内（画面全体の受け口）で伝わる。
describe('入力欄の注意書き', () => {
  const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/ChatPanel.tsx'), 'utf-8')
  const app = readFileSync(join(__dirname, '..', 'src/renderer/components/ChatApp.tsx'), 'utf-8')

  it('★★ 使い方を書かない（IDEモード）', () => {
    const at = panel.indexOf('placeholder=')
    const line = panel.slice(at, panel.indexOf('\n', at))
    expect(line).not.toContain('⌘+Enter')
    expect(line).not.toContain('ドロップ')
    expect(line).not.toContain('📎')
  })

  it('★★ 使い方を書かない（チャットモード）', () => {
    const at = app.indexOf('placeholder=')
    const line = app.slice(at, app.indexOf('\n', at))
    expect(line).not.toContain('⌘+Enter')
    expect(line).not.toContain('ドロップ')
  })

  it('★ ⌘+Enter は、送信ボタンの説明として残す（覚えたい人は見つけられる）', () => {
    expect(panel).toContain('title="送信（⌘+Enter）"')
    // チャットモードは入力欄の下に元から案内がある
    expect(app).toContain('⌘+Enter で送信')
  })

  it('★ 📎 の説明は残っている（落とし方はここから辿れる）', () => {
    expect(panel).toContain('title="画像を添付"')
  })
})


// ── 保存していない画像の案内は Koto が出す（2026-08-19 実機・Ryosuke 指摘）──
// 「使いたいファイルなのに設定を入れ忘れた時の応答文書が不自然。
//   不要な情報は削除して自然な文書にしてほしい」
// AI 任せだと古い会話を真似て長い手順を書く。Koto が出せば毎回同じで正しい。
describe('保存していない画像への案内', () => {
  const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/ChatPanel.tsx'), 'utf-8')
  const at = panel.indexOf('const send = useCallback')
  const block = panel.slice(at, at + 2200)

  it('★★ チェック無しで画像を送ったときだけ出す', () => {
    expect(block).toContain('const needHint = !choice && projectDir && attached.length > 0')
  })

  it('★★ 案内は AI の返事のあとに置く（埋もれさせない）', () => {
    expect(block).toContain('turn.then(')
    expect(block).toContain('useImageHint(attached.length)')
  })

  it('★★ AI には「説明するな」と、そのターンで伝える', () => {
    expect(block).toContain('保存のしかた・ボタン名・手順は説明しないでください')
  })
})
