import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  localRefs, checkRefs, backgroundImageIssues, sizedClassNames, sizedImageClassNames,
  localLinks, hasViewportMeta, imgWithoutSizing, unusedImages, heavyImages, humanBytes,
  siteIssueNote, siteCheckSummary, fixInstruction, aiFixable, type SiteIssue,
} from '../src/shared/siteCheck'
import { IDE_CONTEXT } from '../src/renderer/aiContext'

// ── 2026-08-19 実機（Ryosuke 報告）──────────────────────────────────
// 公開したページのヒーローが**タイル表示**になっていた。記録では、背景画像を
// 入れてから `background-size: cover` が足されるまで25分あり、その間のページは
// 本当にタイル表示だった（試すでも公開でも同じ）。
//
// 「見た目が良いか」は人が決めることだが、**決まった落とし穴**は機械で拾える。

describe('参照している画像を拾う', () => {
  it('★ HTML の src と CSS の url を拾う', () => {
    const html = `<img src="images/a.png"><section style="background-image: url('images/b.jpg')">`
    expect(localRefs(html)).toEqual(['images/a.png', 'images/b.jpg'])
  })

  it('★★ 外の世界のものは拾わない（チェックの対象外）', () => {
    const t = `<img src="https://example.com/x.png"><img src="data:image/png;base64,AAA">`
      + `<a href="#top"></a>@font-face{src:url(//cdn.example.com/f.woff)}`
    expect(localRefs(t)).toEqual([])
  })

  it('★ ?v= や #ハッシュは落とす（同じファイルとして見る）', () => {
    expect(localRefs(`<img src="images/a.png?v=2">`)).toEqual(['images/a.png'])
  })

  it('★ 同じものは1つにまとめる', () => {
    expect(localRefs(`<img src="a.png"><img src="./a.png">`)).toEqual(['a.png'])
  })
})

describe('参照が実在するか', () => {
  const actual = ['images/hero.jpg', 'images/karubi.jpg', 'style.css']

  it('★ あるものは何も言わない', () => {
    expect(checkRefs(['images/hero.jpg'], actual)).toEqual({ missing: [], miscased: [] })
  })

  it('★★ 無いものは「無い」と言う', () => {
    expect(checkRefs(['images/none.jpg'], actual).missing).toEqual(['images/none.jpg'])
  })

  // macOS は Hero.jpg と hero.jpg を同じ扱いにするが、公開先の Linux は別物。
  // **手元では絶対に気づけない**種類の失敗なので、ここで拾う。
  it('★★ 大文字小文字の違いを見つける（手元では通り、公開先で 404）', () => {
    const r = checkRefs(['images/Hero.jpg'], actual)
    expect(r.missing).toEqual([])
    expect(r.miscased).toEqual([{ ref: 'images/Hero.jpg', actual: 'images/hero.jpg' }])
  })
})

describe('背景画像の指定漏れ', () => {
  it('★★ 大きさの指定が無ければ拾う（今回のタイル表示）', () => {
    const css = `.hero { background: linear-gradient(#000, #111); min-height: 70vh; }
.card { background-image: url('images/a.jpg'); }`
    expect(backgroundImageIssues(css)).toEqual(['.card'])
  })

  it('★★ 指定があれば拾わない（正しいものを騒がない）', () => {
    const css = `.hero { background-image: url('a.jpg'); background-size: cover; background-repeat: no-repeat; }`
    expect(backgroundImageIssues(css)).toEqual([])
  })

  it('★ 一括指定の中に cover があれば拾わない', () => {
    const css = `.hero { background: url('a.jpg') center/cover no-repeat; }`
    expect(backgroundImageIssues(css)).toEqual([])
  })

  it('★★ HTML のインライン指定も見る（今回はここにも書かれていた）', () => {
    const html = `<section class="hero" style="background-image: url('images/hero.jpg');">`
    expect(backgroundImageIssues(html).length).toBe(1)
    const ok = `<section style="background-image: url('images/hero.jpg'); background-size: cover;">`
    expect(backgroundImageIssues(ok)).toEqual([])
  })

  // ── 2つのファイルにまたがる（2026-08-19 実物で確認）────────────────────
  // 今回のページは **HTML に背景画像・CSS に大きさ**、と分かれて書かれていた。
  // 片方だけ見て判断すると、正しいページを「指定漏れ」と騒ぐ。
  // **騒ぐ検査は使われなくなる。**
  it('★★ CSS 側で大きさを指定していれば、HTML 側は騒がない', () => {
    const css = `.hero { background: linear-gradient(#000,#111); background-size: cover; background-repeat: no-repeat; }`
    const html = `<section class="hero" style="background-image: url('images/hero.jpg');">`
    expect(sizedClassNames(css).has('hero')).toBe(true)
    expect(backgroundImageIssues(html, sizedClassNames(css))).toEqual([])
  })

  it('★★ CSS 側にも大きさが無ければ、ちゃんと拾う（今回の症状そのもの）', () => {
    const css = `.hero { background: linear-gradient(#000,#111); min-height: 70vh; }`
    const html = `<section class="hero" style="background-image: url('images/hero.jpg');">`
    expect(sizedClassNames(css).has('hero')).toBe(false)
    expect(backgroundImageIssues(html, sizedClassNames(css))).toEqual(['class="hero"'])
  })

  it('★ 背景画像を使っていないものは対象外', () => {
    expect(backgroundImageIssues(`.x { color: red; }`)).toEqual([])
  })
})

describe('画面に出す言葉', () => {
  it('★★ どうなるかまで書く（「指定がありません」だけでは動けない）', () => {
    expect(siteIssueNote('background', '.hero')).toContain('タイル状')
    expect(siteIssueNote('missing', 'images/a.png')).toContain('空白')
    expect(siteIssueNote('miscased', 'Hero.jpg')).toContain('公開先では表示されません')
  })

  it('★ 何も無ければ何も言わない', () => {
    expect(siteCheckSummary([])).toBe('')
  })

  // 2026-08-19 Ryosuke 指定の言い回し
  // ── ファイル名を繰り返さない・大げさに言わない（2026-08-19 実機・Ryosuke 指摘）──
  // 画面は「・<ファイル名>: <説明>」で出す。説明にも名前を入れると2回出る。
  // また、使っていない画像は**ページの問題ではない**（置いたままなだけ）。
  it('★★ 説明にファイル名を繰り返さない', () => {
    expect(siteIssueNote('unused', '')).not.toContain('images/')
    expect(siteIssueNote('unused', '')).toContain('公開物に混ざります')
    expect(siteIssueNote('heavy', '3.3MB')).toContain('3.3MB')
    expect(siteIssueNote('heavy', '3.3MB')).not.toContain('.jpg')
  })

  it('★★ 片づけのボタンがあるので「ファイル一覧から削除」とは言わない', () => {
    expect(siteIssueNote('unused', '')).not.toContain('ファイル一覧から削除')
  })

  it('★★ 使っていない画像だけなら「問題」と言わない', () => {
    const only: SiteIssue[] = [{ kind: 'unused', file: 'images/a.png', detail: '', note: '' }]
    const m = siteCheckSummary(only)
    expect(m).toContain('使っていない画像などが 1 件')
    expect(m).toContain('公開はできます')
    expect(m).not.toContain('問題があります')
    expect(m).not.toContain('直してから')
  })

  it('★★ 直せるものと片づけるものが混ざっていたら、分けて数える', () => {
    const mixed: SiteIssue[] = [
      { kind: 'background', file: 'index.html', detail: '.hero', note: '' },
      { kind: 'unused', file: 'images/a.png', detail: '', note: '' },
      { kind: 'heavy', file: 'images/b.png', detail: '2.0MB', note: '' },
    ]
    const m = siteCheckSummary(mixed)
    expect(m).toContain('問題があります（1件）')
    expect(m).toContain('ほかに、使っていない画像などが 2 件')
  })

  it('★★ 「AIに修正させてから公開」をすすめる', () => {
    const issues: SiteIssue[] = [{ kind: 'background', file: 'index.html', detail: '.hero', note: 'x' }]
    // 項目名がすでに「見た目」なので、本文の頭は重ねない（2026-08-19 実機）
    expect(siteCheckSummary(issues)).toContain('作ったページに問題があります（1件）')
    expect(siteCheckSummary(issues)).not.toContain('ほかに、')
    expect(siteCheckSummary(issues)).not.toContain('見た目に問題があります')
    expect(siteCheckSummary(issues)).toContain('AIに修正させてから公開する')
  })

  it('★★ AI で直せないものだけなら、そうは言わない（できないことを勧めない）', () => {
    const issues: SiteIssue[] = [{ kind: 'unused', file: 'images/a.png', detail: '', note: 'x' }]
    expect(siteCheckSummary(issues)).not.toContain('AIに修正させて')
  })
})

// ── そもそも起こさせない（2026-08-19 Ryosuke と相談して決めた順番）──────
// ①機械で拾う ②AIに最初から正しく書かせる の2段。②の方が安く、効きも早い。
describe('AI に最初から正しく書かせる', () => {
  it('★★ 背景画像には大きさ・位置・繰り返しを一緒に書かせる', () => {
    expect(IDE_CONTEXT).toContain('background-size: cover;')
    expect(IDE_CONTEXT).toContain('background-repeat: no-repeat;')
    expect(IDE_CONTEXT).toContain('タイル状')
  })

  it('★★ 一括指定が個別指定を打ち消すことを伝える（今回の書き順の問題）', () => {
    expect(IDE_CONTEXT).toContain('一括指定は前の個別指定を打ち消します')
  })

  it('★ 大文字小文字を合わせさせる（公開先の Linux で 404 になる）', () => {
    expect(IDE_CONTEXT).toContain('大文字小文字まで完全に一致')
  })

  // 2026-08-19 実物: about.html に class="feature-img" があるのに CSS に定義が無く、
  // 画像が原寸のまま出ていた（公開前チェックの「imgSize」で検出できた）
  it('★★ 付けたクラスは CSS にも定義させる', () => {
    expect(IDE_CONTEXT).toContain('必ず CSS にも定義すること')
  })
})


// 掟10「一元化したことと、全経路が実際にそこを通っていることは別」。
describe('公開前チェックが、実際にこれを通っている', () => {
  const cloud = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')

  it('★★ 公開前チェックで見た目も見る', () => {
    expect(cloud).toContain('function findSiteIssues')
    expect(cloud).toContain("add('look', '見た目'")
  })

  it('★★ 大きさの指定は CSS 側も集めてから判断する（誤検知を出さない）', () => {
    const at = cloud.indexOf('function findSiteIssues')
    const block = cloud.slice(at, at + 1800)
    expect(block).toContain('const sizedBg = sizedClassNames(allCss)')
    expect(block).toContain('backgroundImageIssues(text, sizedBg)')
  })

  it('★★ 公開は止めない（直すかどうかは人が決める）', () => {
    expect(cloud).toContain("status: 'warn'")
    expect(cloud).not.toContain("add('look', '見た目', 'ng'")
  })

  it('★ 見つからなければ、その旨も出す（黙らない）', () => {
    expect(cloud).toContain('よくある落とし穴（背景画像・リンク切れ・スマホ対応・画像の大きさ）は見つかりませんでした')
  })

  it('★ 公開に出さないフォルダは見に行かない（素材・node_modules 等）', () => {
    const at = cloud.indexOf('function findSiteIssues')
    expect(cloud.slice(at, at + 900)).toContain('publishExcludedDirNames()')
  })
})


// ── 検査の種類を増やす（2026-08-19 Ryosuke 指示）────────────────────────
// 「有るか無いか」で判定できるものに絞る。CSS をまたぐ判断が要るものは、
// **騒がないように**別の情報（CSSのクラス）を集めてから見る。
describe('リンク切れ', () => {
  it('★★ 同じサイトの中のページだけを見る', () => {
    const html = `<a href="menu.html">品書き</a><a href="https://example.com">外</a>`
      + `<a href="#top">上へ</a><a href="mailto:a@example.com">メール</a>`
    expect(localLinks(html)).toEqual(['menu.html'])
  })

  it('★★ 行き先が無ければ拾う', () => {
    expect(checkRefs(localLinks(`<a href="none.html">x</a>`), ['index.html']).missing).toEqual(['none.html'])
  })
})

describe('スマホ用の指定', () => {
  it('★★ 無ければ分かる（スマホで文字が極小になる）', () => {
    expect(hasViewportMeta('<head><title>x</title></head>')).toBe(false)
    expect(hasViewportMeta('<meta name="viewport" content="width=device-width, initial-scale=1.0">')).toBe(true)
  })
})

describe('画像の大きさの指定', () => {
  it('★★ 指定が無いものだけを拾う（控えめに見る）', () => {
    expect(imgWithoutSizing('<img src="a.png">')).toEqual(['a.png'])
    expect(imgWithoutSizing('<img src="a.png" width="300">')).toEqual([])
    expect(imgWithoutSizing('<img src="a.png" style="max-width:100%">')).toEqual([])
  })

  it('★★ CSS 側で幅を決めていれば騒がない', () => {
    const css = '.card-img { width: 100%; height: 180px; }'
    expect(sizedImageClassNames(css).has('card-img')).toBe(true)
    expect(imgWithoutSizing('<img class="card-img" src="a.png">', sizedImageClassNames(css))).toEqual([])
  })
})

describe('使っていない画像・重い画像', () => {
  it('★★ どこからも参照されていない画像を拾う', () => {
    const files = ['images/a.png', 'images/b.png', 'index.html']
    expect(unusedImages(files, ['images/a.png'])).toEqual(['images/b.png'])
  })

  it('★ 画像以外は対象外（HTML を「使っていない」と言わない）', () => {
    expect(unusedImages(['index.html', 'style.css'], [])).toEqual([])
  })

  it('★★ 大きすぎる画像を拾う', () => {
    const files = [{ path: 'a.jpg', bytes: 3_292_853 }, { path: 'b.jpg', bytes: 150_000 }]
    expect(heavyImages(files, ['a.jpg', 'b.jpg']).map(x => x.path)).toEqual(['a.jpg'])
  })

  // ── 使っていない画像は「重い」と言わない（2026-08-19 実機・Ryosuke 指摘）──
  // 「直前まで対応しろと言われていたのに、実際には使われていなくて削除されて
  //   いる、という状況になるのは困ります」。読み込まれない画像はページを
  //   重くしないし、片づけで消えるものに対応を求めるのは筋が通らない。
  it('★★ 使われていない大きな画像は拾わない', () => {
    const files = [{ path: 'unused.jpg', bytes: 3_292_853 }]
    expect(heavyImages(files, [])).toEqual([])
    expect(heavyImages(files, ['unused.jpg']).length).toBe(1)
  })

  it('★ 大きさは読める形にする', () => {
    expect(humanBytes(3_292_853)).toBe('3.3MB')
    expect(humanBytes(150_000)).toBe('150KB')
  })
})

describe('AI に渡す修正の指示', () => {
  const issues: SiteIssue[] = [
    { kind: 'background', file: 'index.html', detail: '.hero', note: '' },
    { kind: 'viewport', file: 'menu.html', detail: '', note: '' },
    { kind: 'unused', file: 'images/old.png', detail: 'images/old.png', note: '' },
  ]

  it('★★ どこを・どう直すかまで書く（「直して」では手順が返ってくる）', () => {
    const t = fixInstruction(issues)
    expect(t).toContain('index.html（.hero）')
    expect(t).toContain('background-size: cover;')
    expect(t).toContain('menu.html')
    expect(t).toContain('width=device-width')
    expect(t).toContain('実際にファイルを直してください')
  })

  it('★★ AI にできないことは渡さない（画像を消す・軽くする）', () => {
    expect(aiFixable('unused')).toBe(false)
    expect(aiFixable('heavy')).toBe(false)
    expect(fixInstruction(issues)).not.toContain('images/old.png')
  })

  it('★ 直せるものが無ければ、指示は作らない（空のボタンを出さない）', () => {
    expect(fixInstruction([{ kind: 'heavy', file: 'a.jpg', detail: 'a.jpg', note: '' }])).toBe('')
  })
})

describe('「AIに修正させる」ボタン', () => {
  const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')
  const chat = readFileSync(join(__dirname, '..', 'src/renderer/components/ChatPanel.tsx'), 'utf-8')
  const cloud = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')

  it('★★ 見た目の項目に、直しにいくボタンが出る', () => {
    expect(panel).toContain("c.fix === 'ai-fix' && c.fixPrompt")
    expect(panel).toContain('AIに修正させる')
    expect(cloud).toContain("fix: 'ai-fix' as const")
    expect(cloud).toContain('fixPrompt: instruction')
  })

  it('★★ 押したら送る（相談＝入力欄に置くだけ、とは別物）', () => {
    const at = chat.indexOf("'sakura:fix-with-ai'")
    const block = chat.slice(Math.max(0, at - 700), at + 200)
    expect(block).toContain('void chat.send(text, [])')
  })

  it('★ 応答中は割り込まない（入力欄に置く）', () => {
    const at = chat.indexOf("'sakura:fix-with-ai'")
    expect(chat.slice(Math.max(0, at - 700), at + 200)).toContain('if (chat.isLoading)')
  })
})


// ── 押したら何が起きているか見えるようにする（2026-08-19 実機・Ryosuke 指摘）──
// 「ナビゲーションがIDEの方に移動せず、後ろ側で処理が動いているようです。
//   これだと何が起こっているのか分からない」
describe('「AIに修正させる」を押したあと', () => {
  const app = readFileSync(join(__dirname, '..', 'src/renderer/App.tsx'), 'utf-8')
  const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')

  it('★★ 公開の画面を閉じて、チャットを前に出す', () => {
    const at = app.indexOf("'sakura:fix-with-ai'")
    const block = app.slice(Math.max(0, at - 700), at + 200)
    expect(block).toContain('setShowPublish(false)')
    expect(block).toContain('setShowChat(true)')
  })

  it('★★ IDEモードにする（チャットモードにはファイルを直す道具が無い）', () => {
    const at = app.indexOf("'sakura:fix-with-ai'")
    expect(app.slice(Math.max(0, at - 700), at + 200)).toContain("setMode('ide')")
  })

  // 「修正提案であることが分かりにくい。一つの問題毎に改行を」
  it('★★ 1件ずつ改行して見せる', () => {
    expect(panel).toContain("String(c.note ?? '').split('\\n')")
    expect(panel).toContain('details.map((d, i) =>')
  })

  it('★★ ボタンは行の途中に埋めない（長い一覧の末尾だと見つからない）', () => {
    const at = panel.indexOf("c.fix === 'ai-fix'")
    const block = panel.slice(at, at + 700)
    expect(block).toContain('mt-2 block')
    expect(block).not.toContain('ml-2 align-middle')
  })

  it('★ 押すと何が起きるかを添える', () => {
    expect(panel).toContain('押すとチャットに移り、AIが直します')
  })
})


// ── 項目名と本文がくっついていた（2026-08-19 実機・Ryosuke 指摘）──────────
// 「公開できるか確かめるボタンを押すと、同じ文書が何回も出る気がします」
// 実際は**項目名と本文が続けて表示**され、「見た目見た目に問題があります」
// 「公開の設定公開名『landingtest』で公開します」と読めていた。
// 原因は行末に置いた全角空白を JSX が落とすこと。区切りは余白で作る。
describe('項目名と本文の区切り', () => {
  const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')

  it('★★ 余白で区切る（行末の全角空白に頼らない）', () => {
    expect(panel).toContain('className="text-ink font-medium mr-1.5">{c.label}</span>')
  })

  it('★★ 行末の全角空白を置かない（落ちて、くっついて見える）', () => {
    expect(panel).not.toMatch(/\{c\.label\}<\/span>　\s*\n/)
  })
})


// ── 押せるものが無いと行き止まりになる（2026-08-19 実機・Ryosuke 指摘）──────
// 「AIに修正させるボタンが無くなっていませんか？」
// 残っていたのは AI に直せないもの（使っていない画像5件・重い画像1件）だけで、
// ボタンが出ない＝**何もできないまま「6件あります」と言われる**状態だった。
// AI にできないことは Koto が引き受ける。
describe('使っていない画像の片づけ', () => {
  const cloud = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')
  const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunPanel.tsx'), 'utf-8')

  it('★★ 片づけられるものを画面へ渡す', () => {
    expect(cloud).toContain("issues.filter(i => i.kind === 'unused').map(i => i.file)")
    expect(cloud).toContain('unusedFiles')
  })

  it('★★ ボタンが出る（件数つき）', () => {
    expect(panel).toContain('c.unusedFiles?.length')
    expect(panel).toContain('🗑 使っていない画像をゴミ箱へ')
  })

  it('★★ 完全には消さない（取り違えても戻せる）', () => {
    const at = panel.indexOf('const cleanUnusedImages')
    const block = panel.slice(at, at + 1200)
    expect(block).toContain('window.electronAPI.fs.trash')
    expect(block).toContain('ゴミ箱')
    expect(block).not.toContain('unlink')
  })

  it('★★ 消す前に一覧を見せて確認する（掟5）', () => {
    const at = panel.indexOf('const cleanUnusedImages')
    const block = panel.slice(at, at + 900)
    expect(block).toContain('window.confirm')
    expect(block).toContain('files.slice(0, 8)')
  })

  it('★ 片づけたら、その場で結果を出し直す', () => {
    const at = panel.indexOf('const cleanUnusedImages')
    expect(panel.slice(at, at + 1400)).toContain('await runPreflight()')
  })

  // 2026-08-19 実機: 片づけたあと黙ってチェックをやり直したため、
  // 「ファイルが大きすぎるという表示がなくなった。これはどういうことか？」となった。
  // （3.3MB の画像は「使っていない」5件にも入っていたので一緒に消えていた）
  it('★★ 何件片づけたかを残す（黙って消さない）', () => {
    const at = panel.indexOf('const cleanUnusedImages')
    const block = panel.slice(at, at + 1800)
    expect(block).toContain('setTrashNote(')
    expect(block).toContain('件をゴミ箱へ移しました')
    expect(block).toContain('戻せます')
    expect(panel).toContain('{trashNote && (')
  })

  it('★ 消せなかったものは黙って落とさない', () => {
    const at = panel.indexOf('const cleanUnusedImages')
    expect(panel.slice(at, at + 1400)).toContain('window.alert')
  })
})

// 重い画像は Koto にも AI にも軽くする道具が無い。**案内だけする。**
describe('重い画像の案内', () => {
  it('★★ どうすればよいかまで書く', () => {
    const n = siteIssueNote('heavy', 'a.jpg（3.3MB）')
    expect(n).toContain('小さい画像を用意して')
    expect(n).toContain('📁 画像を使う')
  })
})


describe('重い画像は使われているものだけ', () => {
  const cloud = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')

  it('★★ 公開前チェックも、参照されている画像だけを見る', () => {
    expect(cloud).toContain('heavyImages(sizes, Array.from(referenced))')
  })
})
