import { describe, it, expect } from 'vitest'
import { MATERIALS_DIR } from '../src/shared/publishExclude'
import {
  SEND_BUDGET_TOKENS, KEEP_TOKENS, KEEP_MIN_MESSAGES, COMPACT_NOTE, MAX_SUMMARY_CHARS, MAX_CHARS_PER_MSG,
  bodyMessages, tokensOf, capToBudget, capMessage, markOf, currentSummary, summaryMessage,
  planSend, planCompact, compactSource, workLines, transcript, compactPrompt, acceptSummary,
  planManualCompact, canCompactNow, MANUAL_KEEP_MESSAGES, MANUAL_MIN_FOLD, SUMMARY_HEADING, MIN_SUMMARY_CHARS,
  summaryFilePath, summaryFileBody,
} from '../src/renderer/historyCompact'

type M = {
  role: string; content: string
  toolNote?: boolean; hidden?: boolean; images?: string[]
  summary?: { upTo: number; mark: string }
}

/** 実測に近い長さ（手元の会話の中央値は 28〜715文字）。1件あたり概ね100トークン。 */
const BODY = 'あ'.repeat(100)

/** n件の会話（user/assistant 交互）を作る。 */
function conv(n: number, prefix = 'm'): M[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${prefix}${i}:${BODY}`,
  }))
}

/** まとめメッセージを作る（本文列 body の先頭 upTo 件を覆う）。 */
function sum(body: M[], upTo: number, text = 'これまでのまとめ'): M {
  return { role: 'assistant', content: text, summary: { upTo, mark: markOf(body[upTo - 1]) } }
}

describe('bodyMessages（AIへ送る対象の並び）', () => {
  it('表示専用（toolNote）とまとめ自身を除く', () => {
    const msgs: M[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '🔧 実行中', toolNote: true },
      { role: 'assistant', content: 'まとめ', summary: { upTo: 1, mark: 'x' } },
      { role: 'assistant', content: 'b' },
    ]
    expect(bodyMessages(msgs).map(m => m.content)).toEqual(['a', 'b'])
  })

  it('hidden は残す（画面に出ないだけでAIには送るため）', () => {
    expect(bodyMessages([{ role: 'user', content: 'a', hidden: true }])).toHaveLength(1)
  })

  it('空・null 混じりでも壊れない', () => {
    expect(bodyMessages([])).toEqual([])
    expect(bodyMessages([null as any, { role: 'user', content: 'a' }])).toHaveLength(1)
  })
})

describe('量で測る（件数では測らない）', () => {
  it('切り詰めたあとの量で数える（実際に送る量と一致させる）', () => {
    const huge: M[] = [{ role: 'user', content: 'あ'.repeat(50000) }]
    expect(tokensOf(huge)).toBeLessThan(MAX_CHARS_PER_MSG + 100)
  })

  it('実測に近い会話では、20件でも予算のごく一部しか使わない', () => {
    // 手元の実測: 直近20件で 476〜2,994トークン。予算 8,000 に対して余裕がある。
    expect(tokensOf(conv(20))).toBeLessThan(SEND_BUDGET_TOKENS / 2)
  })

  it('予算に収まるぶんだけ末尾から取る', () => {
    const { kept, omitted } = capToBudget(conv(200), SEND_BUDGET_TOKENS)
    expect(tokensOf(kept)).toBeLessThanOrEqual(SEND_BUDGET_TOKENS)
    expect(kept.length + omitted).toBe(200)
    expect(kept[kept.length - 1].content).toContain('m199') // 直近は必ず入る
  })

  it('1件が巨大でも、直近の文脈は必ず残す', () => {
    const big: M[] = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `x${i}:` + 'あ'.repeat(4000) }))
    const { kept } = capToBudget(big, 100) // 予算をわざと極端に小さくする
    expect(kept.length).toBe(KEEP_MIN_MESSAGES)
    expect(kept[kept.length - 1].content).toContain('x9')
  })
})

describe('currentSummary（有効なまとめの取り出し）', () => {
  it('まとめが無ければ null', () => {
    expect(currentSummary(conv(4))).toBeNull()
  })

  it('印が合っていれば取り出せる', () => {
    const body = conv(10)
    expect(currentSummary([...body, sum(body, 4)])).toEqual({ text: 'これまでのまとめ', upTo: 4 })
  })

  it('いちばん新しいまとめを使う', () => {
    const body = conv(30)
    const msgs = [...body, sum(body, 4, '古い'), sum(body, 10, '新しい')]
    expect(currentSummary(msgs)?.text).toBe('新しい')
    expect(currentSummary(msgs)?.upTo).toBe(10)
  })

  it('🕘 元に戻す などで会話が短くなったら捨てる', () => {
    const body = conv(10)
    expect(currentSummary([...body.slice(0, 5), sum(body, 8)])).toBeNull()
  })

  it('壊れた記録（実在しない位置を覆っている）でも、会話をまるごと落とさない', () => {
    // chat.json が壊れる・作り替えられると、指紋まで一致してしまうことがある
    //（無い位置の指紋は空。それに合わせて書かれていれば素通りする）。
    // 覆っている件数そのものを見ていないと、planSend が全部を切り落として
    // 「まとめだけ送る」＝会話が消えたのと同じことになる。
    const body = conv(10)
    const broken: M = { role: 'assistant', content: 'まとめ', summary: { upTo: 99, mark: markOf(undefined as any) } }
    expect(currentSummary([...body, broken])).toBeNull()
    expect(planSend([...body, broken])).toHaveLength(10)
  })

  it('覆っている最後の1件が書き換わっていたら捨てる', () => {
    const body = conv(10)
    const s = sum(body, 4)
    const changed = [...body]
    changed[3] = { role: 'assistant', content: 'すり替え' }
    expect(currentSummary([...changed, s])).toBeNull()
  })

  it('本文が空のまとめは無効', () => {
    const body = conv(10)
    expect(currentSummary([...body, sum(body, 4, '   ')])).toBeNull()
  })

  it('upTo が 0 や小数なら無効', () => {
    const body = conv(10)
    expect(currentSummary([...body, { role: 'assistant', content: 'x', summary: { upTo: 0, mark: '' } }])).toBeNull()
    expect(currentSummary([...body, { role: 'assistant', content: 'x', summary: { upTo: 1.5, mark: '' } }])).toBeNull()
  })
})

describe('planSend（送る履歴の組み立て）', () => {
  it('予算に収まる会話は、まとめずに全部そのまま送る', () => {
    // 従来は20件で切っていた。実測ではここが実害の本体（本文95件のうち75件が消えていた）。
    const out = planSend(conv(60))
    expect(out).toHaveLength(60)
    expect(out[0].content).toContain('m0')
  })

  it('まとめがあれば、先頭にまとめ・そのあとは覆われていない分を送る', () => {
    const body = conv(40)
    const out = planSend([...body, sum(body, 10)])
    expect(out).toHaveLength(1 + 30)
    expect(out[0].role).toBe('system')
    expect(out[0].content).toContain('これまでのまとめ')
    expect(out[1].content).toContain('m10') // 覆われた次から
  })

  it('まとめが効いていれば「省略しました」を出さない（捨てていないため）', () => {
    const body = conv(40)
    const out = planSend([...body, sum(body, 10)])
    expect(out.some(m => m.content.includes('送信を省略しています'))).toBe(false)
  })

  it('まとめが作れない状態が続いても、送る量が際限なく増えない', () => {
    const body = conv(400) // 予算をはるかに超える
    const out = planSend(body)
    expect(tokensOf(out as any)).toBeLessThanOrEqual(SEND_BUDGET_TOKENS + 200) // 注記のぶんの余裕
    expect(out[0].content).toContain('送信を省略しています')
    expect(out[out.length - 1].content).toContain('m399')
  })

  it('長すぎる1件は切り詰める', () => {
    const body: M[] = [{ role: 'user', content: 'あ'.repeat(5000) }, ...conv(2)]
    const out = planSend(body)
    expect(out[0].content.length).toBeLessThan(5000)
    expect(out[0].content).toContain('長いため後半を省略')
  })

  it('表示専用の吹き出しは送らない', () => {
    const msgs: M[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: '🔧', toolNote: true }]
    expect(planSend(msgs).map(m => m.content)).toEqual(['a'])
  })
})

describe('planCompact（まとめ直す範囲）', () => {
  it('予算内なら、何件あってもまとめない', () => {
    // 件数で測っていたときは、実測の会話（本文95件）で7回もまとめ直していた。
    expect(planCompact(conv(60))).toBeNull()
  })

  it('予算を超えたら、直近を残して古いところを畳む', () => {
    const msgs = conv(400)
    const plan = planCompact(msgs)!
    expect(plan).not.toBeNull()
    expect(plan.from).toBe(0)
    expect(plan.base).toBeNull()
    expect(tokensOf(msgs.slice(plan.to))).toBeLessThanOrEqual(KEEP_TOKENS)
    expect(plan.mark).toBe(markOf(msgs[plan.to - 1]))
  })

  it('2回目は、前回のまとめを土台にして続きだけをまとめる', () => {
    const body = conv(400)
    const first = planCompact(body)!
    const msgs = [...body, { role: 'assistant', content: '1回目', summary: { upTo: first.to, mark: first.mark } } as M,
      ...conv(400, 'n')]
    const plan = planCompact(msgs)!
    expect(plan.from).toBe(first.to)
    expect(plan.base).toBe('1回目')
  })

  it('まとめた直後は、もう一度まとめようとしない', () => {
    const body = conv(400)
    const plan = planCompact(body)!
    const msgs = [...body, { role: 'assistant', content: 'まとめ', summary: { upTo: plan.to, mark: plan.mark } } as M]
    expect(planCompact(msgs)).toBeNull()
  })

  it('表示専用の吹き出しは量に数えない', () => {
    const noise: M[] = Array.from({ length: 500 }, () => ({ role: 'assistant', content: '🔧 ' + BODY, toolNote: true }))
    expect(planCompact([...conv(5), ...noise])).toBeNull()
  })

  it('直近だけで予算を超えていたら、畳んでも減らないので何もしない', () => {
    const big: M[] = Array.from({ length: KEEP_MIN_MESSAGES }, (_, i) => ({ role: 'user', content: `x${i}:` + 'あ'.repeat(4000) }))
    expect(planCompact(big)).toBeNull()
  })

  it('まとめが無効なら、先頭からまとめ直す', () => {
    const body = conv(400)
    const broken: M = { role: 'assistant', content: 'まとめ', summary: { upTo: 9999, mark: 'x' } }
    const plan = planCompact([...body, broken])!
    expect(plan.from).toBe(0)
    expect(plan.base).toBeNull()
  })
})

describe('🗂 手動でまとめる（ボタン）', () => {
  it('押しても意味が無いうちは、ボタンを出さない', () => {
    // 自動は約47往復を超えないと働かない。だからといって、短い会話で押せてしまうと
    // 数件をまとめるだけの無駄な費用と待ち時間になる。
    expect(canCompactNow([])).toBe(false)
    expect(canCompactNow(conv(MANUAL_KEEP_MESSAGES + MANUAL_MIN_FOLD - 1))).toBe(false)
  })

  it('畳める分がたまったら押せる', () => {
    expect(canCompactNow(conv(MANUAL_KEEP_MESSAGES + MANUAL_MIN_FOLD))).toBe(true)
  })

  it('直近3往復（6件）はそのまま残す', () => {
    const msgs = conv(30)
    const plan = planManualCompact(msgs)!
    expect(plan.to).toBe(30 - MANUAL_KEEP_MESSAGES)
    expect(plan.from).toBe(0)
    expect(plan.mark).toBe(markOf(msgs[plan.to - 1]))
    // 押したあとに送るのは「まとめ＋直近6件」
    const after = [...msgs, { role: 'assistant', content: 'まとめ', summary: { upTo: plan.to, mark: plan.mark } } as M]
    expect(planSend(after)).toHaveLength(1 + MANUAL_KEEP_MESSAGES)
  })

  it('自動より短い会話でも押せる（自動は予算を超えるまで働かない）', () => {
    const msgs = conv(30)
    expect(planCompact(msgs)).toBeNull()   // 自動はまだ働かない
    expect(canCompactNow(msgs)).toBe(true) // 手動なら押せる
  })

  it('2回目は、前回のまとめを土台にして続きだけをまとめる', () => {
    const body = conv(30)
    const first = planManualCompact(body)!
    const msgs = [...body, { role: 'assistant', content: '1回目', summary: { upTo: first.to, mark: first.mark } } as M, ...conv(20, 'n')]
    const plan = planManualCompact(msgs)!
    expect(plan.from).toBe(first.to)
    expect(plan.base).toBe('1回目')
  })

  it('押した直後は、もう押せない（同じところを二度まとめない）', () => {
    const body = conv(30)
    const plan = planManualCompact(body)!
    const msgs = [...body, { role: 'assistant', content: 'まとめ', summary: { upTo: plan.to, mark: plan.mark } } as M]
    expect(canCompactNow(msgs)).toBe(false)
  })

  it('表示専用の吹き出しは件数に数えない', () => {
    const noise: M[] = Array.from({ length: 50 }, () => ({ role: 'assistant', content: '🔧', toolNote: true }))
    expect(canCompactNow([...conv(4), ...noise])).toBe(false)
  })
})

describe('「捨てない」ことの保証', () => {
  it('どのやり取りも「まとめの中」か「そのまま送る分」のどちらかに入る', () => {
    let msgs: M[] = []
    let covered = 0
    let compactions = 0
    for (let turn = 0; turn < 200; turn++) {
      msgs = [...msgs, { role: 'user', content: `q${turn}:${BODY}` }, { role: 'assistant', content: `a${turn}:${BODY}` }]
      const plan = planCompact(msgs)
      if (plan) {
        compactions++
        // 覆う範囲は必ず前回の続きから始まる（飛びが無い＝落ちるやり取りが無い）
        expect(plan.from).toBe(covered)
        msgs = [...msgs, { role: 'assistant', content: `まとめ(${plan.to})`, summary: { upTo: plan.to, mark: plan.mark } }]
        covered = plan.to
      }
      // まとめが効いている限り「省略しました」は出ない
      expect(planSend(msgs).some(m => m.content.includes('送信を省略しています'))).toBe(false)
    }
    expect(compactions).toBeGreaterThan(0)
    // 実測に近い長さの400件でも、まとめ直しは十数回まで（件数式なら約39回だった）
    expect(compactions).toBeLessThan(20)
  })
})

describe('まとめの材料（書き込み・実行の実況を混ぜる）', () => {
  it('書き込み・実行の行だけを拾う（読んだだけの行は拾わない）', () => {
    expect(workLines('📄 ファイルを読んでいます… a.html')).toEqual([])
    expect(workLines('✏️ ファイルを保存しています… index.html')).toEqual(['✏️ ファイルを保存しています… index.html'])
    expect(workLines('直しました\n\n✏️ ファイルを編集しています… a.css\n⚡ コマンドを実行しています… npm i'))
      .toEqual(['✏️ ファイルを編集しています… a.css', '⚡ コマンドを実行しています… npm i'])
  })

  it('本文の範囲に挟まっている実況だけを材料にする', () => {
    const msgs: M[] = [
      { role: 'user', content: 'つくって' },
      { role: 'assistant', content: '📄 読んでいます… a\n✏️ ファイルを保存しています… index.html', toolNote: true },
      { role: 'assistant', content: 'できました' },
      { role: 'user', content: 'つぎ' },
      { role: 'assistant', content: '✏️ ファイルを保存しています… next.html', toolNote: true },
      { role: 'assistant', content: 'できました2' },
    ]
    const src = compactSource(msgs, 0, 2) // 本文の 0..1（「つくって」「できました」）まで
    expect(src.map(m => m.content)).toEqual([
      'つくって',
      '📄 読んでいます… a\n✏️ ファイルを保存しています… index.html',
      'できました',
    ])
  })

  it('書き込み・実行を含まない実況は材料にしない', () => {
    const msgs: M[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '🔀 モデルを切り替えます', toolNote: true },
      { role: 'assistant', content: 'b' },
    ]
    expect(compactSource(msgs, 0, 2).map(m => m.content)).toEqual(['a', 'b'])
  })

  it('まとめ自身は材料に混ぜない', () => {
    const body = conv(4)
    const msgs = [...body, sum(body, 2)]
    expect(compactSource(msgs, 0, 4).every(m => !m.summary)).toBe(true)
  })

  it('書き起こしは話し手と、実際の操作が分かる形にする', () => {
    const t = transcript([
      { role: 'user', content: 'これを直して' },
      { role: 'assistant', content: '✏️ ファイルを保存しています… a.html', toolNote: true },
      { role: 'assistant', content: '直しました' },
    ])
    expect(t).toContain('🧑 利用者: これを直して')
    expect(t).toContain('🛠 ✏️ ファイルを保存しています… a.html')
    expect(t).toContain('🤖 AI: 直しました')
  })

  it('添付した画像は枚数を残す（画像そのものは渡さない）', () => {
    const t = transcript([{ role: 'user', content: 'これに合わせて', images: ['data:image/png;base64,AA', 'data:image/png;base64,BB'] }])
    expect(t).toContain('（画像2枚を添付）')
    expect(t).not.toContain('base64')
  })
})

describe('まとめを頼む文面', () => {
  it('初回は土台なし、2回目は前回のまとめを含める', () => {
    const chunk: M[] = [{ role: 'user', content: 'あ' }]
    expect(compactPrompt(null, chunk).user).not.toContain('# これまでのまとめ')
    const second = compactPrompt('前回のまとめ', chunk).user
    expect(second).toContain('# これまでのまとめ')
    expect(second).toContain('前回のまとめ')
  })

  it('推測を足させない指示と、操作の記録の読み方が入っている', () => {
    const sys = compactPrompt(null, []).system
    expect(sys).toContain('推測')
    expect(sys).toContain('🛠')
  })
})

describe('acceptSummary（受け入れの判断）', () => {
  const OK = `${SUMMARY_HEADING}\n- プロジェクト landingTEST を作った\n- 画像は images/ に置いた`

  it('目印より後ろを本文として受け取る', () => {
    expect(acceptSummary(OK)).toBe('- プロジェクト landingTEST を作った\n- 画像は images/ に置いた')
  })

  it('空なら受け付けない', () => {
    expect(acceptSummary('')).toBeNull()
    expect(acceptSummary('   \n ')).toBeNull()
  })

  it('目印が無い返事は受け取らない', () => {
    // 変なまとめをAIへ渡すより、作らないほうがよい（作れなかったことは画面に出す）。
    expect(acceptSummary('- なんとなくまとめました\n- あれこれ')).toBeNull()
  })

  it('目印だけで中身が無ければ受け取らない', () => {
    expect(acceptSummary(`${SUMMARY_HEADING}\n  `)).toBeNull()
    expect(acceptSummary(`${SUMMARY_HEADING}\n短い`)).toBeNull()
    expect(acceptSummary(`${SUMMARY_HEADING}\n${'あ'.repeat(MIN_SUMMARY_CHARS)}`)).not.toBeNull()
  })

  it('推論型モデルが「考えた過程」を丸ごと返しても、最終版だけを取り出す', () => {
    // 2026-08-20 実機（landingTEST）: Kimi が英語の思考と下書き2本をそのまま返し、
    // 4,007文字中 3,324文字が英語のまま「まとめ」として保存された。
    const cot = [
      'We need summarize conversation in Japanese, bullet points, concise.',
      "Let's draft.",
      `${SUMMARY_HEADING}`,
      '- 下書き1: プロジェクトを作った（この版は捨てられる）',
      'Check char count. Let me rewrite and count.',
      'Final text:',
      `${SUMMARY_HEADING}`,
      '- プロジェクト landingTEST を静的Webサイトとして作成',
      '- 画像は images/ フォルダに置いた',
    ].join('\n')
    const out = acceptSummary(cot)!
    expect(out).toContain('landingTEST を静的Webサイト')
    expect(out).not.toContain('下書き1')       // 古い下書きは残らない
    expect(out).not.toContain('We need')       // 英語の思考も残らない
    expect(out).not.toContain('Check char count')
  })

  it('長すぎるときは頭打ちにする', () => {
    const out = acceptSummary(`${SUMMARY_HEADING}\n` + 'あ'.repeat(MAX_SUMMARY_CHARS + 500))!
    expect(out.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 10)
    expect(out).toContain('以下略')
  })
})

describe('まとめを頼む文面（2026-08-20 実機の失敗をふまえて）', () => {
  it('文字数を数えさせない', () => {
    // 「1200文字以内」と書いていたため、モデルが延々と文字数を数え、
    // 数え終わる前に出力の上限に達していた。
    const sys = compactPrompt(null, []).system
    expect(sys).not.toMatch(/\d+\s*文字/)
  })

  it('目印から始めるよう指示する（そこだけを受け取るため）', () => {
    expect(compactPrompt(null, []).system).toContain(SUMMARY_HEADING)
  })

  it('考えた過程を書かせない', () => {
    expect(compactPrompt(null, []).system).toContain('考えた過程')
  })
})

describe('📄 資料として残す（プロジェクトへの書き出し）', () => {
  const now = new Date(2026, 7, 20, 14, 5, 30) // 2026-08-20 14:05:30

  it('置き場所は「素材（公開しません）」の中', () => {
    // まとめはアプリの一部ではない。直下に置くとそのまま公開物に入る。
    // MATERIALS_DIR は publishExclude.ts の一元定義で、全経路から除かれる。
    expect(summaryFilePath(now).startsWith(`${MATERIALS_DIR}/`)).toBe(true)
  })

  it('名前に日時が入る（同じ分に2回押しても上書きしない）', () => {
    expect(summaryFilePath(now)).toBe(`${MATERIALS_DIR}/まとめ-20260820-140530.md`)
    const later = new Date(2026, 7, 20, 14, 5, 31)
    expect(summaryFilePath(later)).not.toBe(summaryFilePath(now))
  })

  it('1桁の月日時分秒はゼロ詰めする', () => {
    expect(summaryFilePath(new Date(2026, 0, 2, 3, 4, 5))).toBe(`${MATERIALS_DIR}/まとめ-20260102-030405.md`)
  })

  it('中身の先頭に、何のファイルかと公開されないことを書く', () => {
    const body = summaryFileBody('- 決めたこと', now)
    expect(body).toContain('# ここまでのまとめ（2026-08-20 14:05）')
    expect(body).toContain('アプリでは使いません')
    expect(body).toContain(MATERIALS_DIR)
    expect(body).toContain('- 決めたこと')
  })

  it('まとめ本文の前後の空白は落とす', () => {
    expect(summaryFileBody('  - あ  \n\n', now)).toContain('\n- あ\n')
  })
})

describe('画面に出す印', () => {
  it('何が起きたか一言で分かる', () => {
    expect(COMPACT_NOTE).toBe('🗂 ここまでの内容をまとめました')
  })

  it('AIへ渡すまとめには、古い会話の代わりであることを書く', () => {
    expect(summaryMessage('内容').content).toContain('古い会話の代わり')
    expect(summaryMessage('内容').role).toBe('system')
  })

  it('capMessage は切り詰めたことを本文に書く', () => {
    expect(capMessage({ role: 'user', content: 'あ'.repeat(MAX_CHARS_PER_MSG + 1) }).content).toContain('長いため後半を省略')
  })
})
