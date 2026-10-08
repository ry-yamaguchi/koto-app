import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ── なぜこのテストが要るか（2026-09-25 検分の指摘9・14・15）────────────────
//
// (1) 指摘9・14「目印を置けなかった警告（markerNote）が画面に一度も届かない」
//     main（storage:prepare）は目印（.koto-keep）を置けなかったときに markerNote を
//     返しているのに、**画面はそれを一度も読んでいなかった**。目印が無いと、用意した
//     だけでまだ何も保存していないプロジェクトはバケットの一覧に現れず、同じ保存場所を
//     共有する別のプロジェクトを⑥で破棄したときに**巻き込まれて消える**。
//     tests/storagePrepareWiring.test.ts の `toContain('markerNote')` は main のソースに
//     文字列があるかしか見ないので、この断線を捕まえられなかった。
//
// (2) 指摘15「koto-data を差し替えた／触れなかったの一行が、次の行で画面ごと閉じられる」
//     `askAi()` は `setCheckLine(updateLine)` の直後に `onAskAi?.()`（＝③公開のモーダルを
//     閉じる関数。PublishModal が onClose を渡している）を呼ぶので、その1行は描き直される
//     前に消え、モーダルの作り直しで state ごと空に戻る。「Koto は触っていません」と
//     伝える唯一の口が塞がっていた。
//
// ここはソースの文字列だけに頼らない（掟10）。
//   ・(1) は**偽の main の応答**を実物の変換（storagePrepareLines）へ流して確かめる
//   ・(2) は**実物の部品を描画して**、覚えてある1行が開き直した画面に出ることを確かめる

import StorageNotice, {
  storagePrepareLines, readDataLayerLine, rememberDataLayerLine, dataLayerLineKey,
  readDataLayerNote, dataLayerNoteText, rememberLayerLine, KeptLines,
  DATA_LAYER_LINE_MAX_AGE_MS,
} from '../src/renderer/components/StorageNotice'

const src = readFileSync(join(__dirname, '..', 'src/renderer/components/StorageNotice.tsx'), 'utf-8')

const PROJECT = '/tmp/koto-test-project'
const PLACEMENT = { bucket: 'koto-data-aaa', prefix: 'projects/myapp/', shared: true }
const MARKER_NOTE =
  '保存場所は用意できましたが、目印を置けませんでした（403 Forbidden）。'
  + 'このままでも保存は使えますが、同じ保存場所を共有するほかのプロジェクトを破棄したときに、'
  + 'この保存場所が巻き込まれることがあります。一度データを保存すれば解消します。'

/** 手元の localStorage（node には無い）。**中身は素の Map**。 */
function fakeLocalStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)) },
    removeItem: (k: string) => { map.delete(k) },
    map,
  }
}

/** 偽の main。`storage:prepare` が実際に返す形（cloud.ts の戻り値）をそのまま返す。 */
function fakePrepare(opts: { markerFails: boolean }) {
  return async () => ({
    ok: true,
    placement: PLACEMENT,
    siteName: '石狩第1',
    startedSite: false,
    dataLayerPlaced: true,
    dataLayerFile: 'koto-data.cjs',
    note: '月額495円（税込）がかかります。',
    ...(opts.markerFails ? { markerNote: MARKER_NOTE } : {}),
  })
}

beforeEach(() => {
  ;(globalThis as any).localStorage = fakeLocalStorage()
})

describe('目印を置けなかった知らせ（markerNote）を、画面まで届ける', () => {
  it('★★★ 目印を置けなかった応答を流すと、警告の行がそのまま出てくる（捨てない）', async () => {
    const r = await fakePrepare({ markerFails: true })()
    const lines = storagePrepareLines(r)
    expect(lines.warn).toBe(MARKER_NOTE)
    expect(lines.error).toBe('')
    // 用意そのものは成立している＝「用意しました」も出る（警告のために成功を隠さない）
    expect(lines.done).toContain(PLACEMENT.bucket)
  })

  it('★★★ 置けたときは警告を出さない（いつも警告が出ると、本物が埋もれる）', async () => {
    const r = await fakePrepare({ markerFails: false })()
    expect(storagePrepareLines(r).warn).toBe('')
  })

  it('★★ 用意そのものに失敗したときは、main の理由をそのまま出す（黙らない）', () => {
    const lines = storagePrepareLines({ ok: false, message: '保存場所『x』が一覧に現れません。' })
    expect(lines.error).toBe('保存場所『x』が一覧に現れません。')
    expect(lines.done).toBe('')
    expect(lines.warn).toBe('')
  })

  it('★★ 応答が壊れていても（ok なのに placement が無い）、成功扱いにしない', () => {
    expect(storagePrepareLines({ ok: true }).error).not.toBe('')
    expect(storagePrepareLines(null).error).not.toBe('')
    expect(storagePrepareLines(undefined).done).toBe('')
  })

  it('★★ 「用意する」の処理が、この変換を通って警告を画面の状態へ入れている', () => {
    // 押したあとに走る道。ここが切れると、上の変換が正しくても画面には出ない
    expect(src).toContain('const lines = storagePrepareLines(r)')
    expect(src).toContain('setMarkerNote(lines.warn)')
    // 直す前の形（戻り値を見ずに message だけ拾う）へ戻っていないこと
    expect(src).not.toContain("setError(r.message ?? '用意できませんでした')")
  })

  it('★★ 警告を描く場所がある（値をそのまま出す・素のテキスト）', () => {
    const at = src.indexOf('{markerNote && <p')
    expect(at).toBeGreaterThan(-1)
    expect(src.slice(at, at + 200)).toContain('{markerNote}')
    // 掟5: 画面の文に Markdown 記法を混ぜない
    expect(src.slice(at, at + 200)).not.toContain('**')
  })
})

describe('koto-data を差し替えた／触れなかったの1行は、画面を閉じても残る', () => {
  it('★★★ 覚えた1行は、③公開を開き直した最初の描画に出る（閉じられて消えない）', () => {
    const line = 'ℹ️ koto-data.cjs は Koto が置いた版か分からなかったので、そのままにしました。'
    rememberDataLayerLine(PROJECT, line)
    // 画面を作り直す＝新しく描く。state は空から始まるので、覚えてある分だけが頼り
    const html = renderToStaticMarkup(
      createElement(StorageNotice, { projectDir: PROJECT, target: 'sakura-apprun' as const }),
    )
    expect(html).toContain('そのままにしました')
  })

  it('★★★ 覚えていないプロジェクトでは、何も出さない（前のプロジェクトの話を持ち越さない）', () => {
    rememberDataLayerLine(PROJECT, 'ℹ️ 覚えた行')
    const html = renderToStaticMarkup(
      createElement(StorageNotice, { projectDir: '/tmp/another-project', target: 'sakura-apprun' as const }),
    )
    expect(html).not.toContain('覚えた行')
  })

  it('★★ 覚える・読む・消すが、プロジェクトごとに分かれている', () => {
    rememberDataLayerLine(PROJECT, '🔄 差し替えました')
    expect(readDataLayerLine(PROJECT)).toContain('🔄 差し替えました')
    expect(readDataLayerLine('/tmp/other')).toBe('')
    // 空文字は「もう言うことが無い」＝消す（古い話を出し続けない）
    rememberDataLayerLine(PROJECT, '')
    expect(readDataLayerLine(PROJECT)).toBe('')
    expect(dataLayerLineKey(PROJECT)).toContain(PROJECT)
  })

  it('★★ localStorage が使えなくても落ちない（覚えられないだけ）', () => {
    ;(globalThis as any).localStorage = {
      getItem: () => { throw new Error('使えません') },
      setItem: () => { throw new Error('使えません') },
      removeItem: () => { throw new Error('使えません') },
    }
    expect(() => rememberDataLayerLine(PROJECT, 'x')).not.toThrow()
    expect(readDataLayerLine(PROJECT)).toBe('')
    expect(() => renderToStaticMarkup(
      createElement(StorageNotice, { projectDir: PROJECT, target: 'sakura-apprun' as const }),
    )).not.toThrow()
  })

  it('★★ 「AIに書き直してもらう」が、その1行を覚えてから画面を閉じる', () => {
    // dataLayerUpdateLine を呼ぶのはここ1か所（tests/storageNoticeText.test.ts が固定）。
    // その結果を**閉じたら消える state だけ**に入れる形へ戻っていないこと
    expect(src).toContain('const updateLine = dataLayerUpdateLine(layer)')
    expect(src).toContain('rememberDataLayerLine(projectDir, updateLine)')
    expect(src).not.toContain('if (updateLine) setCheckLine(updateLine)')
  })
})

// ── 指摘16: ensureLayer を呼ぶ経路が2つとも「覚える側」を通る ─────────────────
//
// `storage:ensureLayer` は読み込み先を用意するだけの口ではなく、**古い koto-data を
// 新しい版へ置き替える唯一の自動経路**でもある（`replaced` / `needsUpdate` を返す）。
// 呼ぶのは askAi（AIに書き直してもらう）と moveDataWithAi（一緒に移してもらう）の2か所
// なのに、覚えて見せていたのは askAi だけだった——「一緒に移してもらう」を押した人には、
// Koto が差し替えたことも触れなかったことも一度も伝わらず、しかも askAi で覚えた
// 「ℹ️ …そのままにしました」が**もう正しくないまま出続ける**。
//
// ミューテーション（当てて落ちることを確認した）:
//   ・`setDataLayerLine(rememberLayerLine(projectDir, layer))` を moveDataWithAi から消す
//     → 「★★★ ensureLayer を呼ぶ経路は、2つとも覚える側を通る」が落ちる
//   ・rememberLayerLine から `rememberDataLayerLine(projectDir, updateLine)` を消す
//     → 「★★★ 通るたびに上書きする」が落ちる
describe('ensureLayer を呼ぶ経路は、どちらも「覚える側」を通る', () => {
  /** `storage.ensureLayer(` を呼んでいる関数を、呼び出しごとに切り出す。 */
  function ensureLayerCallers(): { name: string; body: string }[] {
    const found: { name: string; body: string }[] = []
    const re = /storage\.ensureLayer\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      const declAt = src.lastIndexOf('\n  const ', m.index)
      expect(declAt, 'ensureLayer の呼び出しが関数の外にある').toBeGreaterThan(-1)
      const name = (/\n {2}const (\w+)/.exec(src.slice(declAt, declAt + 40)) ?? [])[1] ?? '(名前不明)'
      const end = src.indexOf('\n  }', m.index)
      found.push({ name, body: src.slice(declAt, end) })
    }
    return found
  }

  it('★★★ ensureLayer を呼ぶ経路は、2つとも覚える側を通る', () => {
    const callers = ensureLayerCallers()
    // **名前は書き下す**（一覧を回すだけだと、増えても減っても気づけない・掟10）
    expect(callers.map(c => c.name).sort()).toEqual(['askAi', 'moveDataWithAi'])
    for (const c of callers) {
      expect(c.body, `${c.name} が覚えずに進んでいる（指摘16 と同じ形）`)
        .toContain('setDataLayerLine(rememberLayerLine(projectDir, layer))')
    }
  })

  it('★★★ 通るたびに上書きする（古い断定を残さない・言うことが無ければ消す）', () => {
    // ① 「そのままにしました」を覚える（書き直しを頼んだとき）
    const untouched = rememberLayerLine(PROJECT, { ok: true, placed: false, file: 'koto-data.cjs', needsUpdate: true } as any)
    expect(untouched).toContain('そのままにしました')
    expect(readDataLayerLine(PROJECT)).toContain('そのままにしました')

    // ② そのあと「一緒に移してもらう」で実際に差し替わったら、その場で書き換わる
    const replaced = rememberLayerLine(PROJECT, { ok: true, placed: true, file: 'koto-data.cjs', replaced: true } as any)
    expect(replaced).toContain('新しい版に差し替えました')
    expect(readDataLayerLine(PROJECT)).toContain('新しい版に差し替えました')
    expect(readDataLayerLine(PROJECT)).not.toContain('そのままにしました')

    // ③ 言うことが無くなったら消す（古い話を出し続けない）
    expect(rememberLayerLine(PROJECT, { ok: true, placed: false, file: 'koto-data.cjs' } as any)).toBe('')
    expect(readDataLayerLine(PROJECT)).toBe('')
    // ④ ensureLayer に失敗した（null）ときも、古い記録を残さない
    rememberLayerLine(PROJECT, { ok: true, placed: false, file: 'koto-data.cjs', needsUpdate: true } as any)
    expect(rememberLayerLine(PROJECT, null)).toBe('')
    expect(readDataLayerLine(PROJECT)).toBe('')
  })

  it('★★ 覚えられなくても、その回は画面に出す（localStorage が使えない環境）', () => {
    ;(globalThis as any).localStorage = {
      getItem: () => { throw new Error('使えません') },
      setItem: () => { throw new Error('使えません') },
      removeItem: () => { throw new Error('使えません') },
    }
    const line = rememberLayerLine(PROJECT, { ok: true, placed: false, file: 'koto-data.js', needsUpdate: true } as any)
    expect(line).toContain('そのままにしました')
    expect(line).toContain('に調べたときの記録です') // いつの話かは落とさない
  })
})

// ── 指摘17: 覚えた1行に「いつの話か」を持たせ、古くなったら黙る ──────────────
//
// この1行は過去形の記録に見えて、末尾は「入れ替えてよいか分からないときは、Koto に
// 相談してください」という**いま何をすべきかの指示**である。koto-data を差し替えるのは
// ③公開の画面だけではなく、⑤公開の途中で main も差し替える（apprunDedicated.ts・
// vercel.ts）。時点も期限も無いまま覚えると、**もう当てはまらないことを画面が
// 断定し続ける**。
//
// ミューテーション（当てて落ちることを確認した）:
//   ・`if (now - at > DATA_LAYER_LINE_MAX_AGE_MS) return null` を消す → 期限のテストが落ちる
//   ・dataLayerNoteText から時点の括弧を消す → 「いつ調べた話か」のテストが落ちる
describe('覚えた1行は「いつの話か」を持つ（古くなったら黙る）', () => {
  const LINE = 'ℹ️ koto-data.cjs は Koto が置いた版か分からなかったので、そのままにしました。'
  /** 2026-09-25 14:05（手元の時計） */
  const AT = new Date(2026, 8, 25, 14, 5).getTime()

  it('★★★ 出す文に「いつ調べた話か」が入っている（素のテキスト・掟5）', () => {
    const text = dataLayerNoteText({ line: LINE, at: AT })
    expect(text).toContain(LINE)
    expect(text).toContain('9月25日 14:05')
    expect(text).toContain('に調べたときの記録です')
    // そのあと変わりうることまで言う（過去の記録を、いまの断定として読ませない）
    expect(text).toContain('そのあとに公開すると')
    expect(text).not.toContain('**')
    expect(text).not.toContain('`')
  })

  it('★★★ 古くなったら出さない（1日を過ぎた指示は、当てはまらないことがある）', () => {
    rememberDataLayerLine(PROJECT, LINE, AT)
    // 直後・期限ちょうどまでは出す
    expect(readDataLayerLine(PROJECT, AT)).toContain('そのままにしました')
    expect(readDataLayerLine(PROJECT, AT + DATA_LAYER_LINE_MAX_AGE_MS)).toContain('そのままにしました')
    // 1ミリ秒でも過ぎたら黙る
    expect(readDataLayerLine(PROJECT, AT + DATA_LAYER_LINE_MAX_AGE_MS + 1)).toBe('')
    expect(readDataLayerNote(PROJECT, AT + DATA_LAYER_LINE_MAX_AGE_MS + 1)).toBeNull()
  })

  it('★★ 時点の無い記録は出さない（いつの話か言えないものを、指示として出さない）', () => {
    // 時点を持たない古い形（1行をそのまま入れていた版）が残っていても、拾わない
    ;(globalThis as any).localStorage.setItem(dataLayerLineKey(PROJECT), LINE)
    expect(readDataLayerNote(PROJECT)).toBeNull()
    expect(readDataLayerLine(PROJECT)).toBe('')
    // 壊れた形（時点が数でない・行が空）も同じ
    ;(globalThis as any).localStorage.setItem(dataLayerLineKey(PROJECT), JSON.stringify({ line: LINE, at: 'きのう' }))
    expect(readDataLayerLine(PROJECT)).toBe('')
    ;(globalThis as any).localStorage.setItem(dataLayerLineKey(PROJECT), JSON.stringify({ line: '', at: AT }))
    expect(readDataLayerLine(PROJECT)).toBe('')
    expect(dataLayerNoteText(null)).toBe('')
  })

  it('★★ 覚えた時点が、そのまま画面に出る（記憶と画面で言うことをずらさない）', () => {
    rememberDataLayerLine(PROJECT, LINE, AT)
    const note = readDataLayerNote(PROJECT, AT)
    expect(note?.at).toBe(AT)
    expect(readDataLayerLine(PROJECT, AT)).toBe(dataLayerNoteText(note))
  })
})

// ── 指摘36: 枠が変わっても、消えてはいけない行がある ─────────────────────────
//
// ⚠️ 目印を置けなかった警告は**お金と破棄に関わる**（目印が無いと、同じ保存場所を
// 共有するほかのプロジェクトを⑥で破棄したときに巻き込まれうる）。ところが出していたのは
// 本体の枠だけで、「🔎 書き直せたか確かめる」で need が none／target-provides に転ぶと、
// **枠ごと黄色い⚠️が消えていた**。
//
// ミューテーション（当てて落ちることを確認した）:
//   ・早期 return の条件を `(checkLine || dataLayerLine)` に戻す → 落ちる
//   ・3つの枠のどれかから <KeptLines /> を消す → 落ちる
//   ・useEffect の `setMarkerNote('')` を消す → 落ちる
describe('need が転んでも、⚠️ と koto-data の1行と確かめた結果は消えない', () => {
  it('★★★ 3つの枠が、どれも同じ3行を同じ部品で出す', () => {
    const use = '<KeptLines markerNote={markerNote} dataLayerLine={dataLayerLine} checkLine={checkLine} />'
    // 枠は3つ（need が none の早期 return・target-provides・本体）
    expect(src.split(use).length - 1).toBe(3)
    // 早期 return の枠が出る条件から markerNote が落ちていない（落ちると枠ごと出ない）
    expect(src).toContain('return (markerNote || checkLine || dataLayerLine) ? (')
    // 直す前の形（markerNote を見ない条件）へ戻っていないこと
    expect(src).not.toContain('return (checkLine || dataLayerLine) ? (')
  })

  it('★★★ その部品は、渡された3行をそのまま素のテキストで出す', () => {
    const html = renderToStaticMarkup(createElement(KeptLines, {
      markerNote: '目印を置けませんでした',
      dataLayerLine: 'ℹ️ そのままにしました',
      checkLine: '✅ 書き直せています',
    }))
    expect(html).toContain('目印を置けませんでした')
    expect(html).toContain('ℹ️ そのままにしました')
    expect(html).toContain('✅ 書き直せています')
    expect(html).toContain('⚠️') // 警告は警告として見える
    expect(html).not.toContain('**')
  })

  it('★★ 空の行は出さない（枠が空の段落で膨らまない）', () => {
    const html = renderToStaticMarkup(createElement(KeptLines, { markerNote: '', dataLayerLine: '', checkLine: '' }))
    expect(html).toBe('')
  })

  it('★★ プロジェクトが変わったら、前のプロジェクトの結果を持ち越さない', () => {
    const start = src.indexOf('useEffect(() => {')
    const body = src.slice(start, src.indexOf('}, [projectDir, target])', start))
    // ⚠️ は「いまのプロジェクトの保存場所」の話（別のプロジェクトに出してはいけない）
    expect(body).toContain("setMarkerNote('')")
    expect(body).toContain("setDone('')")
    expect(body).toContain("setCheckLine('')")
    // 覚えてある1行は、そのプロジェクトのものを読み直す
    expect(body).toContain('setDataLayerLine(readDataLayerLine(projectDir))')
  })
})
