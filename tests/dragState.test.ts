import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isFileDrag, leftWindow, leftReceiver, endsDrag } from '../src/shared/dragState'

// ── 2026-08-19 実機（Ryosuke 報告）──────────────────────────────────
// 「画像をアプリに重ねると受け入れる表示になり、**落とさずに外へ出しても
//   その表示のままで他の作業ができない**」
//
// 画面全体の受け口はこう書いていた:
//   onDragLeave={e => { if (e.currentTarget === e.target) setWindowDragOver(false) }}
// 中の部品へ移ったときに消えないようにする工夫だが、**窓の外へ出るときの離脱は
// 中の部品から出る形で届く**ので、この条件では一度も消えない。

describe('ファイルのドラッグかどうか', () => {
  it('★ ファイルのときだけ受ける（文字を選んで動かしただけで光らせない）', () => {
    expect(isFileDrag(['Files'])).toBe(true)
    expect(isFileDrag(['text/plain'])).toBe(false)
    expect(isFileDrag([])).toBe(false)
    expect(isFileDrag(undefined)).toBe(false)
  })
})

// 2026-08-19 ブラウザに実際の出来事を投げて発覚。窓ぜんたいの見張りに
// leftReceiver を使ったら、**中の部品へ移るたびに表示が消えた**（見張りは
// 受け口の中かどうかを知らないため、常に「外へ出た」と読んでいた）。
// 見張りが見るのは「窓の外へ出たか」だけ。
describe('窓の外へ出たか', () => {
  it('★★ 行き先が無い離脱＝窓の外', () => {
    expect(leftWindow(null)).toBe(true)
    expect(leftWindow(undefined)).toBe(true)
  })

  it('★★ 行き先がある離脱は、窓の中の移動（消してはいけない）', () => {
    expect(leftWindow({})).toBe(false)
  })

  it('★★ 窓ぜんたいの見張りは leftWindow で判断する', () => {
    const hook = readFileSync(join(__dirname, '..', 'src/renderer/hooks/useFileDrag.ts'), 'utf-8')
    const at = hook.indexOf('const onLeave')
    expect(hook.slice(at, at + 120)).toContain('leftWindow(')
    expect(hook.slice(at, at + 120)).not.toContain('leftReceiver(')
  })
})

describe('離脱で表示を消すか', () => {
  it('★ 中の部品へ移っただけなら消さない（消すとチラつく）', () => {
    expect(leftReceiver({}, true)).toBe(false)
  })

  it('★★ 窓の外へ出たら消す（ここが抜けていて、表示が残り続けた）', () => {
    expect(leftReceiver(null, false)).toBe(true)
    expect(leftReceiver(undefined, false)).toBe(true)
  })

  it('受け口の外の要素へ移ったら消す', () => {
    expect(leftReceiver({}, false)).toBe(true)
  })
})

describe('ドラッグが終わったと見なす出来事', () => {
  it('★ 落とした・やめた・窓から焦点が外れた', () => {
    for (const t of ['drop', 'dragend', 'blur']) expect(endsDrag(t)).toBe(true)
  })

  // Finder から持ってきたドラッグは、外で手を離しても dragend が届かないことがある。
  // ドラッグ中はマウス移動イベントが出ないので、これが来た＝もう終わっている。
  it('★★ マウスが動いた＝もうドラッグしていない', () => {
    expect(endsDrag('mousemove')).toBe(true)
  })

  it('ドラッグの最中は消さない', () => {
    for (const t of ['dragover', 'dragenter', 'dragstart']) expect(endsDrag(t)).toBe(false)
  })
})

// 掟10「一元化したことと、全経路が実際にそこを通っていることは別」。
// 受け口は4つある（画面全体・IDEのチャット・単独チャット・ファイル一覧）。
// 1つでも自前で真偽値を持つと、そこだけ消えないまま残る。
describe('落とせる表示は、全部の受け口が同じ仕掛けを通る', () => {
  // 2026-08-19（続き）: IDEのチャットは**自前の見た目を持たない**ことにした
  //（画面全体の案内ひとつに任せる）。持っているのはこの3つ。
  const files = {
    '画面全体': 'src/renderer/App.tsx',
    '単独チャット': 'src/renderer/components/ChatApp.tsx',
    'ファイル一覧': 'src/renderer/components/Sidebar.tsx',
  }

  for (const [name, rel] of Object.entries(files)) {
    it(`★ ${name} が useFileDrag を通る`, () => {
      const src = readFileSync(join(__dirname, '..', rel), 'utf-8')
      expect(src).toContain('useFileDrag')
    })

    it(`★ ${name} が自前で真偽値を持たない`, () => {
      const src = readFileSync(join(__dirname, '..', rel), 'utf-8')
      expect(src).not.toMatch(/useState\(false\)[^\n]*\/\/ *drag/i)
      expect(src).not.toContain('setDragOver(')
      expect(src).not.toContain('setTreeDragOver(')
      expect(src).not.toContain('setWindowDragOver(')
    })
  }

  // 受け口自身の onDragLeave は、窓の外へ出したときや外で手を離したときに
  // **届かないことがある**。窓ぜんたいの見張りが受け皿になる。
  it('★★ 消し忘れの受け皿（窓ぜんたいの見張り）がある', () => {
    const hook = readFileSync(join(__dirname, '..', 'src/renderer/hooks/useFileDrag.ts'), 'utf-8')
    for (const ev of ['dragleave', 'drop', 'dragend', 'mousemove', 'blur']) {
      expect(hook).toContain(ev)
    }
    expect(hook).toContain("window.addEventListener")
    // 付けたら外す（画面を切り替えるたびに増えていかない）
    expect(hook).toContain('window.removeEventListener')
  })
})


// ── ブラウザで実際に確かめた動き（2026-08-19）─────────────────────────
// 出来事を実際に投げて、9通りとも意図どおりに動くことを確認した:
//   1 重ねた→出る / 2 中の部品へ移った→消えない / 3 中の部品の上→出たまま
//   4 窓の外へ出た→消える / 5 再び重ねた→出る / 6 外で手を離してマウス移動→消える
//   7 重ねた→出る / 8 落とした→消える / 9 文字のドラッグ→出さない
//
// このうち 2 は、はじめの実装で**消えていた**（見張りが内側の移動まで拾っていた）。
// 純ロジックの表を眺めるだけでは気づけず、実際に動かして分かった。


// ── 落とせる場所の案内はひとつ（2026-08-19 実機・Ryosuke 指摘）──────────
// 「ファイルの位置とチャットの入力欄上部に赤い枠が出ている。以前の挙動の
//   名残ではないか？」→ そのとおり。以前はその2か所だけが受け口だった。
// いまは画面全体で受けるので、枠と全体の案内が二重に出ていた。
describe('落とせる場所の案内', () => {
  const app = readFileSync(join(__dirname, '..', 'src/renderer/App.tsx'), 'utf-8')
  const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/ChatPanel.tsx'), 'utf-8')
  const side = readFileSync(join(__dirname, '..', 'src/renderer/components/Sidebar.tsx'), 'utf-8')

  it('★★ IDEのチャットは自前の枠を持たない（二重に出さない）', () => {
    expect(panel).not.toContain('ring-2 ring-sakura ring-inset')
    expect(panel).not.toContain('画像をドロップしてAIに渡す')
  })

  it('★★ ファイル一覧の上だけ、文面が変わる（そこだけ結果が違う）', () => {
    expect(app).toContain('プロジェクトに取り込みます')
    expect(app).toContain('AIに見せます')
    expect(app).toContain("closest?.('[data-drop=\"tree\"]')")
    expect(side).toContain('data-drop="tree"')
  })

  it('★ ファイル一覧は、落とす処理だけを止める（重なりの合図は上へ流す）', () => {
    expect(side).toContain('onDragOver={treeDrag.onDragOver}')
    expect(side).toMatch(/onDrop=\{e => \{ e\.preventDefault\(\); e\.stopPropagation\(\)/)
  })
})
