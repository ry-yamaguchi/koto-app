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
//
// B'-3a（2026-08-28）: ここで確かめている実行ループ本体（readImagesAsText・usedTools 等）は
// src/shared/chatTurn.ts の runEngineTurn へ移った。読む先をそちらに変える（意図は変えない。
// 置き換え表により removeLast() → ports.emit({ kind: 'removeLast' })、
// WRITING_TOOLS → ports.h.writingTools 等、一部の識別子表記も変わっている）。
describe('画像ターンでも、ツールを使えるモデルへ切り替える', () => {
  const chat = readFileSync(join(__dirname, '..', 'src/shared/chatTurn.ts'), 'utf-8')

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

  // 2026-08-30 実機（v0.4.5）: 「lsを実行して」への返答が過去のターンの作業に触れただけで
  // 誤検知し、確認の往復が毎ターン走った。過去参照を含む**文**は完了報告と見なさない。
  it('★★ 過去のターンの話は捕まえない（実行結果の報告を邪魔しない）', () => {
    for (const t of [
      'text.txt は先ほど更新した内容が保存されています',
      '先ほど保存しました。ls の結果は text.txt の1件です',
      '前のターンで作成しました',
      'すでに更新しました。内容は変わっていません',
    ]) expect(claimsFileChange(t)).toBe(false)
  })

  it('★★ 文ごとに見る: 過去の話の隣に、このターンの完了報告があれば捕まえる', () => {
    expect(claimsFileChange('先ほど text.txt を作りました。今回は style.css を更新しました')).toBe(true)
  })
})

describe('変えたと言っているのに書き込みが無いとき', () => {
  // 2026-08-19 実機: AI が「✏️ style.css を保存しました」と書いた直後に
  // 「変更されていません」と出て、**どちらが本当か分からない**見え方になっていた。
  it('★★ 実際には変わっていない、と伝える（矛盾に見えないように）', () => {
    const w = unexecutedChangeWarning(true, false)
    expect(w).toContain('実際には書き込みが行われていません')
    expect(w).toContain('Koto がこのやり取りを確認しました')
    expect(w).toContain('Kimi K2.7 Code')
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

// B'-3a（2026-08-28）: この一連の判定・エージェントループ本体は src/shared/chatTurn.ts へ移った。
// 読む先をそちらに変える（意図は変えない。置き換え表により removeLast() → ports.emit({ kind:
// 'removeLast' })、WRITING_TOOLS → ports.h.writingTools、unexecutedChangeWarning/claimsFileChange →
// ports.h.unexecutedChangeWarning/ports.h.claimsFileChange と表記が変わっている）。
describe('まず実際にやらせる（言うだけで終わらせない）', () => {
  const chat = readFileSync(join(__dirname, '..', 'src/shared/chatTurn.ts'), 'utf-8')

  it('★★ 書き込みが走ったかを、ツールの実行から数えている', () => {
    expect(chat).toContain('ports.h.writingTools as readonly string[]).includes(toolName)) wroteFiles = true')
  })

  it('★★ 1回だけ「いま実行して」と促す（無限に往復しない）。逃げ道（不要なら実行しない）も必ず添える', () => {
    expect(chat).toContain('askedToActuallyWrite = true')
    expect(chat).toContain('!askedToActuallyWrite')
    expect(chat).toContain('write_file または edit_file でいま実行してください')
    // （0.4.5）逃げ道が無いと、誤検知のときに「頼まれていない書き込みのでっち上げ」を
    // 誘発する（2026-08-30 実機: 「lsを実行して」で text.txt へ勝手に追記された）
    expect(chat).toContain('変更が不要な場合（結果の報告や説明だけで、ファイルの変更を求められていないとき）は、ファイルを変更せず、その旨を短く答えてください')
    // 「以前のターンで完了済み」という例は**書かない**（同日実機: この例を悪用して
    // 「前のターンで更新済みです」と答え、頼まれた書き込みを逃げた）
    expect(chat).not.toContain('以前のターンで完了済みのとき')
  })

  it('★★ 促しに書かず終えたら、事実（変更なし）だけを短く添える（嘘の「更新済みです」を利用者が見抜ける）', () => {
    expect(chat).toContain("} else if (askedToActuallyWrite && !wroteFiles) {")
    expect(chat).toContain('ℹ️ このターンでは、ファイルは変更されていません。')
  })

  it('★★ 誤検知でも本物の答えを消さない（2026-08-30・v0.4.5 で非破壊化）', () => {
    // かつては removeLast で「事実と違う報告は残さない」形だったが、誤検知のとき
    // 本物の答え（ls の結果の報告）まで消していた。返事は残し、下に確認中の印を添える。
    const at = chat.indexOf('askedToActuallyWrite = true')
    expect(at).toBeGreaterThan(-1)
    expect(chat.slice(at, at + 400)).not.toContain("ports.emit({ kind: 'removeLast' })")
    expect(chat.slice(at, at + 400)).toContain('実際に変更が必要か確かめています…')
  })

  it('★ 促してもやらなければ、警告を付ける', () => {
    expect(chat).toContain('ports.h.unexecutedChangeWarning(ports.h.claimsFileChange(r.content), wroteFiles)')
  })
})
