import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ProjectDeleteResults from '../src/renderer/components/teardown/ProjectDeleteResults'
import { HANAMII_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/hanamii'
import { SHARED_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/shared'
import type { ProjectDeletePhase } from '../src/renderer/teardown/projectDelete'
import { keptLinesOf, stepLabelOf, type ProjectDeleteStep } from '../src/renderer/teardown/projectDeletePlan'
import { projectDeleteStoppedTail } from '../src/renderer/teardown/projectDeleteWords'
import type { TeardownView } from '../src/shared/teardownResult'

// ── 0.6.24 A-5・A-7（U11）: 結果の欄の、残りの段（共用型の行が無いのに記録の残りを破棄する段）──────────────────────────────
//   ・見出し・⚠️ の行は名詞（step の label。保存場所など）で言う。名詞の無い残りの段（アプリが残る回）・ふつうの段は、公開先の名前
//   ・消すものが無かった（nothingToDo）残りの段は描かない
//   ・止まった回の尻は、公開なしの回（済んでいない step がすべて残りの段）だけ、保存場所などの言い方にする
// 文の期待は、関数を通さず書き下す。

const view = (over: Partial<TeardownView> = {}): TeardownView => ({
  ok: true, state: 'done', appDeleted: true, executed: [], message: '', remaining: [], inProgress: [], warnings: [], stageTimings: null, ...over,
})
const failedView = view({ ok: false, state: 'failed', appDeleted: false, message: '保存場所の一覧を取れませんでした' })
const html = (run: ProjectDeletePhase) => renderToStaticMarkup(createElement(ProjectDeleteResults, { run, showBlockNote: true }))

const LEFTOVER = { leftover: true, label: '保存場所' } as const
const leftoverFailed: ProjectDeleteStep = { target: 'sakura-apprun', kind: 'failed', line: '保存場所: 失敗', view: failedView, words: SHARED_TEARDOWN_WORDS, ...LEFTOVER }
const leftoverCancelled: ProjectDeleteStep = { target: 'sakura-apprun', kind: 'cancelled', line: '保存場所: 破棄をキャンセルしました', ...LEFTOVER }
const hanamiiDone: ProjectDeleteStep = { target: 'hanamii', kind: 'done', view: view(), words: HANAMII_TEARDOWN_WORDS }
const hanamiiFailed: ProjectDeleteStep = {
  target: 'hanamii', kind: 'failed', line: 'HANAMII: 受け付けました。保存場所の破棄も始めていません', view: failedView, words: HANAMII_TEARDOWN_WORDS, notStarted: '保存場所の破棄も始めていません',
}

const PUBLIC_TAIL = 'このままフォルダを削除すると、どこに何を公開したかの記録も消えて、Koto から破棄できなくなります。【公開】の画面から破棄するか、各サービスの管理画面で削除してください。'
const LEFTOVER_TAIL = 'このままフォルダを削除すると、保存場所などの記録も消えて、Koto から破棄できなくなります。'
  + 'もう一度「🗑 ゴミ箱に移動」を押してください。保存場所がもう無いことをコントロールパネルで確かめたときだけ、チェックを外して削除できます。'
const STOPPED_HEAD = '破棄を完了できなかったため、プロジェクトの削除を中止しました。'

describe('A-7 止まった回（stopped）の尻: 公開なしの回だけ、保存場所などの言い方', () => {
  it('★★★ 残りの段だけが済まなかった（失敗・キャンセル）: 尻は保存場所の言い方。公開の尻は出さない。見出し（先頭の文）は同じ', () => {
    for (const step of [leftoverFailed, leftoverCancelled]) {
      const h = html({ phase: 'stopped', steps: [step] })
      expect(h, step.kind).toContain(LEFTOVER_TAIL)
      expect(h, step.kind).not.toContain(PUBLIC_TAIL)
      expect(h, step.kind).toContain(STOPPED_HEAD)
    }
  })

  it('★★★ HANAMII が済まなかった回（あとの段は始めていない）は、公開が残っているので公開の尻のまま。「…の破棄も始めていません」も描く', () => {
    const h = html({ phase: 'stopped', steps: [hanamiiFailed] })
    expect(h).toContain(PUBLIC_TAIL)
    expect(h).not.toContain(LEFTOVER_TAIL)
    expect(h).toContain('保存場所の破棄も始めていません。') // 結果の部品（view）で出す回は line を描かないので、別に描く
  })

  it('★★★ HANAMII が済んだあとに残りの段だけが済まなかった回（HANAMII は carried の done）は、公開が残っていないので保存場所の尻', () => {
    const h = html({ phase: 'stopped', steps: [hanamiiDone, leftoverFailed] })
    expect(h).toContain(LEFTOVER_TAIL)
    expect(h).not.toContain(PUBLIC_TAIL)
  })

  it('★★★ 済まなかった step に、残りの段でないものが1つでもあれば公開の尻（不明な形を、保存場所の尻に倒さない）', () => {
    expect(projectDeleteStoppedTail([hanamiiFailed, leftoverFailed])).toBe(PUBLIC_TAIL)
    expect(projectDeleteStoppedTail([{ target: 'sakura-apprun', kind: 'failed', line: '共用型: 失敗', view: null, words: null }])).toBe(PUBLIC_TAIL) // 行のある共用型の失敗
    expect(projectDeleteStoppedTail([{ ...leftoverFailed, label: undefined }])).toBe(PUBLIC_TAIL) // 残りの段でも、名詞が無い（アプリが残る回＝公開の回）
    expect(projectDeleteStoppedTail([{ ...leftoverFailed, label: '' }])).toBe(PUBLIC_TAIL)
    expect(projectDeleteStoppedTail([{ ...leftoverFailed, leftover: undefined }])).toBe(PUBLIC_TAIL) // 印が無い
  })

  it('★★ 済まなかった step が無い stopped（チェックの値が不明など）は、今の公開の尻のまま。done・nothingToDo は数えない', () => {
    expect(projectDeleteStoppedTail([])).toBe(PUBLIC_TAIL)
    expect(projectDeleteStoppedTail([hanamiiDone])).toBe(PUBLIC_TAIL)
    expect(projectDeleteStoppedTail([{ target: 'sakura-apprun', kind: 'nothingToDo', message: '', ...LEFTOVER }])).toBe(PUBLIC_TAIL)
    expect(projectDeleteStoppedTail([hanamiiDone, { target: 'sakura-apprun', kind: 'nothingToDo', message: '', ...LEFTOVER }, leftoverFailed])).toBe(LEFTOVER_TAIL)
  })
})

describe('R4-c 止まった回の尻の後半は、残りの呼び名（step の label）で言う。名詞が「保存場所」なら、これまでの文と1文字も同じ', () => {
  const tailOf = (noun: string) => 'このままフォルダを削除すると、保存場所などの記録も消えて、Koto から破棄できなくなります。'
    + `もう一度「🗑 ゴミ箱に移動」を押してください。${noun}がもう無いことをコントロールパネルで確かめたときだけ、チェックを外して削除できます。`
  const withLabel = (step: ProjectDeleteStep, label: string): ProjectDeleteStep => ({ ...step, label } as ProjectDeleteStep)

  it('★★★ 名詞が「保存場所」の尻は、書き下した今の文のまま（R4-c で1文字も変えない）', () => {
    expect(tailOf('保存場所')).toBe(LEFTOVER_TAIL)
    expect(projectDeleteStoppedTail([leftoverFailed])).toBe(LEFTOVER_TAIL)
  })

  it.each(['コンテナレジストリ', '保存場所・コンテナレジストリ'])('★★★ 名詞が「%s」の回: 尻は「{名詞}がもう無いこと」と言う。「保存場所がもう無いこと」とは言わない（失敗・キャンセルのどちらも、結果の欄の描画まで）', noun => {
    for (const step of [withLabel(leftoverFailed, noun), withLabel(leftoverCancelled, noun)]) {
      expect(projectDeleteStoppedTail([step]), step.kind).toBe(tailOf(noun))
      const h = html({ phase: 'stopped', steps: [step] })
      expect(h, step.kind).toContain(tailOf(noun))
      expect(h, step.kind).not.toContain('保存場所がもう無いこと')
      expect(h, step.kind).not.toContain(PUBLIC_TAIL)
    }
  })

  it('★★ 尻の名詞は、済んでいない残りの段の呼び名。済んだ HANAMII（carried の done）・済んだ段は数えない。公開の尻は今のまま', () => {
    expect(projectDeleteStoppedTail([hanamiiDone, withLabel(leftoverFailed, 'コンテナレジストリ')])).toBe(tailOf('コンテナレジストリ'))
    expect(projectDeleteStoppedTail([hanamiiFailed, withLabel(leftoverFailed, 'コンテナレジストリ')])).toBe(PUBLIC_TAIL)
  })
})

describe('A-5 残りの段の見出しは名詞。ふつうの段は公開先の名前のまま', () => {
  it('★★★ 失敗（view あり）の見出しは「保存場所」。「📦 さくらのAppRun」とは言わない', () => {
    const h = html({ phase: 'stopped', steps: [leftoverFailed] })
    expect(h).toContain('<p class="text-ink font-medium">保存場所</p>')
    expect(h).not.toContain('📦 さくらのAppRun')
    const plain = html({ phase: 'stopped', steps: [{ ...leftoverFailed, leftover: undefined, label: undefined }] })
    expect(plain).toContain('<p class="text-ink font-medium">📦 さくらのAppRun</p>')
  })

  it('★★ 済んだ残りの段（警告つき）も、見出しは名詞。尻は review のまま（変えない）', () => {
    const done: ProjectDeleteStep = { target: 'sakura-apprun', kind: 'done', view: view({ warnings: ['保存場所『koto-data-a』は残しました'] }), words: SHARED_TEARDOWN_WORDS, ...LEFTOVER }
    const h = html({ phase: 'review', steps: [done] })
    expect(h).toContain('<p class="text-ink font-medium">保存場所</p>')
    expect(h).toContain('保存場所『koto-data-a』は残しました')
    expect(h).toContain('ほかのプロジェクトも使う保存場所とコンテナレジストリは、消さないでください。')
    expect(h).not.toContain(LEFTOVER_TAIL)
  })

  it('★★★ 消すものが無かった（nothingToDo）残りの段は描かない。ふつうの nothingToDo は今までどおり描く', () => {
    const ghostLeftover: ProjectDeleteStep = { target: 'sakura-apprun', kind: 'nothingToDo', message: '公開されていないため、破棄するものはありません。', ...LEFTOVER }
    const warned: ProjectDeleteStep = { target: 'hanamii', kind: 'done', view: view({ warnings: ['x'] }), words: HANAMII_TEARDOWN_WORDS }
    const h = html({ phase: 'review', steps: [warned, ghostLeftover] })
    expect(h).not.toContain('破棄するものはありません')
    expect(h).not.toContain('保存場所:')
    expect(h).not.toContain('さくらのAppRun')
    expect(h).toContain('🌸 HANAMII')
    expect(html({ phase: 'review', steps: [warned, { ...ghostLeftover, leftover: undefined, label: undefined }] })).toContain('📦 さくらのAppRun: 公開されていないため、破棄するものはありません。')
  })

  it('★★ やめた（cancelled）の1行は、step の line のまま（名詞はすでに line に入っている）', () => {
    expect(html({ phase: 'stopped', steps: [leftoverCancelled] })).toMatch(/<p class="[^"]*select-text[^"]*">保存場所: 破棄をキャンセルしました<\/p>/)
  })
})

describe('A-5 移す前の ⚠️ の行（keptLinesOf）と stepLabelOf: 残りの段は名詞、それ以外は公開先の名前', () => {
  const warn = (target: ProjectDeleteStep['target'], w: string[], mark: object = {}): ProjectDeleteStep => ({ target, kind: 'done', view: view({ warnings: w }), words: SHARED_TEARDOWN_WORDS, ...mark })
  it('★★★ 残りの段の警告は「保存場所: …」、ふつうの段は「📦 さくらのAppRun: …」、HANAMII は「🌸 HANAMII: …」', () => {
    expect(keptLinesOf([warn('sakura-apprun', ['a'], LEFTOVER), warn('sakura-apprun', ['b']), warn('hanamii', ['c', 'd'])]))
      .toEqual(['保存場所: a', '📦 さくらのAppRun: b', '🌸 HANAMII: c', '🌸 HANAMII: d'])
  })

  it('★★ 名詞の無い残りの段・空の label は公開先の名前。label が文字列でなければ公開先の名前（不明な形に倒さない）', () => {
    expect(stepLabelOf({ target: 'sakura-apprun', label: undefined })).toBe('📦 さくらのAppRun')
    expect(stepLabelOf({ target: 'sakura-apprun', label: '' })).toBe('📦 さくらのAppRun')
    expect(stepLabelOf({ target: 'sakura-apprun', label: 5 as unknown as string })).toBe('📦 さくらのAppRun')
    expect(stepLabelOf({ target: 'sakura-apprun', label: '保存場所・コンテナレジストリ' })).toBe('保存場所・コンテナレジストリ')
  })
})
