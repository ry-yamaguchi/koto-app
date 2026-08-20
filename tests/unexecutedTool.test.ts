import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unexecutedToolWarning, hasTextToolMarkup } from '../src/renderer/aiTools'

// ── 2026-08-19 実機（Ryosuke 報告）──────────────────────────────────
// 画像を添付したターンで、AI は
//   「✅ おすすめメニューの画像を反映しました／プレースホルダーを差し替え」
// と答えたのに、**index.html は何も変わっていなかった**。
// あとで理由を尋ねると「保存処理が完了していなかったようです」と答えた。
//
// このモデル（Kimi 系）は構造化のツール呼び出しができず、本文に特殊トークンで
// 「呼んだつもり」を書く。Koto はそれを取り除いて読める文だけを見せるので、
// **見た目は成功の報告そのもの**になる。黙って成功に見せるのがいちばん悪い。

describe('やったと書いてあるが、実行していないとき', () => {
  it('★★ 実行していなければ、そう伝える', () => {
    const w = unexecutedToolWarning(true, false)
    expect(w).toBeTruthy()
    expect(w).toContain('変わっていません')
    expect(w).toContain('切り替えて')
  })

  it('★ 実際にツールを使ったなら、何も言わない（正常な応答を汚さない）', () => {
    expect(unexecutedToolWarning(true, true)).toBeNull()
  })

  it('★ マークアップが無ければ、何も言わない', () => {
    expect(unexecutedToolWarning(false, false)).toBeNull()
    expect(unexecutedToolWarning(false, true)).toBeNull()
  })

  it('テキスト形式のツール呼び出しを見分けられる', () => {
    expect(hasTextToolMarkup('<|tool_calls_section_begin|>functions.write_file:0')).toBe(true)
    expect(hasTextToolMarkup('ふつうの文章です')).toBe(false)
  })
})

// 掟10「一元化したことと、全経路が実際にそこを通っていることは別」。
describe('画像ターンでも、ツールを使えるモデルへ切り替える', () => {
  const chat = readFileSync(join(__dirname, '..', 'src/renderer/hooks/useAiChat.ts'), 'utf-8')

  // 以前は `&& !hasImages` で、画像ターンだけ切り替えを見送っていた。
  // 二段構え（視覚モデルが読み取り→本文は文章）なら画像は失われないのに、
  // 切り替えないせいで「差し替えました」と書くだけの応答になっていた。
  it('★★ 画像が文章になっていれば切り替える', () => {
    // 切り替えの判定（読み取りの前処理ではなく、最後の条件）を見る
    const at = chat.lastIndexOf('r.hadToolMarkup && !r.toolCalls?.length')
    const line = chat.slice(at, at + 120)
    expect(line).toContain('!hasImages || imageIsText')
  })

  // 2026-08-19 実機: Kimi-K2.7 は画像を直接読める（二段構えにならない）。
  // そのため「画像をそのまま渡しているターン」に当たり、切り替えが効かないまま
  // 「差し替えました」とだけ答えていた。**先に文章にしてから**差し替える。
  it('★★ そのまま渡している画像は、文章にしてから切り替える', () => {
    const at = chat.indexOf('const desc = await readImagesAsText()')
    expect(at).toBeGreaterThan(0)
    const block = chat.slice(at, at + 400)
    expect(block).toContain('# 添付画像の内容（AIによる読み取り）')
    expect(block).toContain('apiMessages[apiMessages.length - 1]')
    expect(block).toContain('imageIsText = true')
  })

  it('★ 読み取れなければ切り替えない（画像を落とさない）', () => {
    // readImagesAsText は失敗・中断で null を返し、そのときは imageIsText のまま
    const at = chat.indexOf('const readImagesAsText')
    expect(chat.slice(at, at + 1600)).toContain('if (aborted || !acc.trim()) return null')
  })

  it('★ 読み取りは1か所に集める（二段構えと同じ道を通す）', () => {
    expect(chat).toContain('const readImagesAsText = async ()')
  })

  it('★★ 実行したかどうかを、ターン全体で見ている', () => {
    expect(chat).toContain('let usedTools = false')
    expect(chat).toContain('usedTools = true')
    expect(chat).toContain('unexecutedToolWarning(sawToolMarkup, usedTools)')
  })
})

// ── 決定的な証拠（2026-08-19 実機・Ryosuke）──────────────────────────
// 失敗した会話にはこう出ていた:
//   📄 ファイルを読んでいます… index.html
//   ✅ くらすけについてのカード画像を反映しました（変更内容: …差し替え）
//
// **読み取りは実行できているのに、書き込みは1度も走っていない。**
// つまり「ツールを扱えない」のではなく、**やっていないことをやったと書いた**。
// 原因が何であれ（嘘の報告・通信の失敗・処理落ち）、言っていることと
// 実際に起きたことの食い違いは、ここで捕まえる。
import { claimsFileChange, unexecutedChangeWarning, WRITING_TOOLS } from '../src/renderer/aiTools'

describe('変えたと言っているか', () => {
  it('★★ 完了の言い方を捕まえる', () => {
    for (const t of [
      '✅ くらすけについてのカード画像を反映しました',
      'プレースホルダーを images/a.jpeg に差し替えました',
      'index.html を修正しました',
      'style.css を更新しました',
      'ファイルを保存しました',
    ]) expect(claimsFileChange(t)).toBe(true)
  })

  it('★★ これからやる／尋ねているものは捕まえない（余計なやり直しをしない）', () => {
    for (const t of [
      'index.html を変更しますか？',
      'この画像に差し替えましょうか',
      '変更点はありません',
      '画像の内容を説明します。日本酒の瓶が並んでいます',
      'まず read_file で確認します',
    ]) expect(claimsFileChange(t)).toBe(false)
  })
})

describe('変えたと言っているのに書き込みが無いとき', () => {
  // 2026-08-19 実機: AI が「✏️ style.css を保存しました」と書いた直後に
  // 「変更されていません」と出て、**どちらが本当か分からない**見え方になっていた。
  it('★★ 実際には変わっていない、と伝える（矛盾に見えないように）', () => {
    const w = unexecutedChangeWarning(true, false)
    expect(w).toContain('実際には書き込みが行われていません')
    expect(w).toContain('Koto がこのやり取りを確認しました')
    expect(w).toContain('Qwen3-Coder')
  })

  it('★ 書き込んだなら何も言わない', () => {
    expect(unexecutedChangeWarning(true, true)).toBeNull()
  })

  it('★ 変えたと言っていなければ何も言わない', () => {
    expect(unexecutedChangeWarning(false, false)).toBeNull()
  })

  it('★ 書き込みのツールは、読み取りを含めない', () => {
    expect([...WRITING_TOOLS]).toEqual(['write_file', 'edit_file'])
    expect((WRITING_TOOLS as readonly string[]).includes('read_file')).toBe(false)
  })
})

describe('まず実際にやらせる（言うだけで終わらせない）', () => {
  const chat = readFileSync(join(__dirname, '..', 'src/renderer/hooks/useAiChat.ts'), 'utf-8')

  it('★★ 書き込みが走ったかを、ツールの実行から数えている', () => {
    expect(chat).toContain('WRITING_TOOLS as readonly string[]).includes(toolName)) wroteFiles = true')
  })

  it('★★ 1回だけ「いますぐ実行して」と促す（無限に往復しない）', () => {
    expect(chat).toContain('askedToActuallyWrite = true')
    expect(chat).toContain('!askedToActuallyWrite')
    expect(chat).toContain('いますぐ変更を実行してください')
  })

  it('★★ 事実と違う報告は残さない', () => {
    const at = chat.indexOf('askedToActuallyWrite = true')
    expect(chat.slice(at, at + 300)).toContain('removeLast()')
  })

  it('★ 促してもやらなければ、警告を付ける', () => {
    expect(chat).toContain('unexecutedChangeWarning(claimsFileChange(r.content), wroteFiles)')
  })
})
