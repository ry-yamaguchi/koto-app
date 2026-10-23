import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ProjectDeleteResults from '../src/renderer/components/teardown/ProjectDeleteResults'
import { HANAMII_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/hanamii'
import { SHARED_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/shared'
import type { ProjectDeletePhase } from '../src/renderer/teardown/projectDelete'
import type { ProjectDeleteStep } from '../src/renderer/teardown/projectDeletePlan'
import type { TeardownView } from '../src/shared/teardownResult'

// ── プロジェクトの削除の結果の欄（ProjectDeleteResults。段階3A・3A-5b。設計書 10.9.5）─────────────────────────────────
// 描くだけの部品を、本物の React で HTML にして見る。何が起きたか（phase）と、公開先ごとの結果（step）を渡すと、
//   ・見出し／本体／末尾の文を、phase ごとに出す（stopped・review）。blocked は止める文（showBlockNote が true のときだけ）。trashFailed は理由（選択・コピーできる形）。trashed は何も出さない
//   ・step に結果（view と words）があれば、【公開】・📡 の 🗑 と同じ部品（TeardownResultView）で出す。無ければ 1 行（選択できる）。やめたは 1 行。消すものが無いは中立の 1 行
//   ・「AIに相談する」は出さない。window.alert は使わない
// 文の期待は、関数を通さず書き下す。

const ROOT = join(__dirname, '..')
const SRC = 'src/renderer/components/teardown/ProjectDeleteResults.tsx'

const view = (over: Partial<TeardownView> = {}): TeardownView => ({
  ok: true, state: 'done', appDeleted: true, executed: ['アプリを削除しました'], message: '', remaining: [], inProgress: [], warnings: [], stageTimings: null, ...over,
})
const done = (target: ProjectDeleteStep['target'], over: Partial<TeardownView> = {}): ProjectDeleteStep =>
  ({ target, kind: 'done', view: view(over), words: target === 'hanamii' ? HANAMII_TEARDOWN_WORDS : SHARED_TEARDOWN_WORDS })
const html = (run: ProjectDeletePhase, showBlockNote = true) => renderToStaticMarkup(createElement(ProjectDeleteResults, { run, showBlockNote }))

const STOPPED_HEAD = '公開の破棄を完了できなかったため、プロジェクトの削除を中止しました。'
const STOPPED_TAIL = 'このままフォルダを削除すると、どこに何を公開したかの記録も消えて、Koto から破棄できなくなります。【公開】の画面から破棄するか、各サービスの管理画面で削除してください。'
const REVIEW_HEAD = '公開の破棄は済みましたが、残ったものがあります。'
const REVIEW_TAIL = '「🗑 ゴミ箱に移動」を押すと、フォルダをゴミ箱へ移します。残ったものは、各サービスの管理画面から削除できます。ほかのプロジェクトも使う保存場所とコンテナレジストリは、消さないでください。消すと、保存場所はそのプロジェクトのデータが消え、コンテナレジストリはそのアプリが止まります。'

describe('phase ごとの見出しと末尾', () => {
  it('★★★ trashed は何も描かない（ダイアログはもう閉じている）', () => {
    expect(html({ phase: 'trashed', steps: [done('hanamii')] })).toBe('')
  })

  it('★★★ stopped: 見出し「…中止しました。」→ 公開先ごとの結果 → 末尾「…記録も消えて…」の順', () => {
    const h = html({ phase: 'stopped', steps: [done('hanamii'), { target: 'sakura-apprun', kind: 'failed', line: 'さくらのAppRun: 失敗', view: null, words: null }] })
    expect(h).toContain(STOPPED_HEAD)
    expect(h).toContain(STOPPED_TAIL)
    expect(h.indexOf(STOPPED_HEAD)).toBeLessThan(h.indexOf('HANAMII'))
    expect(h.indexOf('HANAMII')).toBeLessThan(h.indexOf('さくらのAppRun: 失敗'))
    expect(h.indexOf('さくらのAppRun: 失敗')).toBeLessThan(h.indexOf(STOPPED_TAIL))
    expect(h).not.toContain(REVIEW_HEAD)
  })

  it('★★★ review: 見出し「…残ったものがあります。」→ 結果 → 末尾「🗑 ゴミ箱に移動 を押すと…」。stopped の文は出さない', () => {
    const h = html({ phase: 'review', steps: [done('hanamii', { warnings: ['保存場所「koto-data」は残しました'] })] })
    expect(h).toContain(REVIEW_HEAD)
    expect(h).toContain(REVIEW_TAIL)
    expect(h).toContain('保存場所「koto-data」は残しました')
    expect(h.indexOf(REVIEW_HEAD)).toBeLessThan(h.indexOf('koto-data'))
    expect(h.indexOf('koto-data')).toBeLessThan(h.indexOf(REVIEW_TAIL))
    expect(h).not.toContain(STOPPED_HEAD)
    expect(h).not.toContain(STOPPED_TAIL)
  })
})

describe('step: 結果の部品で出すもの・1 行で出すもの', () => {
  it('★★★ 結果（view と words）がある step は、公開先の名前と、結果の部品（data-teardown-result）で出す。警告は ⚠️ つきで出る', () => {
    const h = html({ phase: 'review', steps: [done('hanamii', { warnings: ['鍵を無効にできませんでした'] }), done('sakura-apprun')] })
    expect(h.match(/data-teardown-result/g)).toHaveLength(2)
    expect(h).toContain('🌸 HANAMII')
    expect(h).toContain('📦 さくらのAppRun')
    expect(h).toContain('✅ 破棄しました')
    expect(h).toContain('✅ アプリを削除しました')
    expect(h).toContain('⚠️ 鍵を無効にできませんでした')
    expect(h).toContain('data-teardown-warnings')
  })

  it('★★ 失敗の結果（view あり）は、部品が出す失敗の見出しと理由（選択・コピーできる）で出る。管理画面への案内は公開先ごとの行き先', () => {
    const failedView = view({ ok: false, state: 'failed', appDeleted: false, executed: [], message: 'HANAMII へ頼めませんでした', remaining: [{ kind: 'service', label: 'HANAMII のプロジェクト' } as any] })
    const h = html({ phase: 'stopped', steps: [{ target: 'hanamii', kind: 'failed', line: 'HANAMII: HANAMII へ頼めませんでした', view: failedView, words: HANAMII_TEARDOWN_WORDS }] })
    expect(h).toContain('⚠️ 破棄できませんでした')
    expect(h).toContain('HANAMII へ頼めませんでした')
    expect(h).toContain('select-text')
    expect(h).toContain('https://hanamii.jp/')
  })

  it('★★ 途中で止まった結果の「しばらくして…もう一度押してください」は、この画面のボタン名（「🗑 ゴミ箱に移動」）を言う', () => {
    const h = html({ phase: 'stopped', steps: [done('hanamii', { ok: false, state: 'inProgress', executed: [], inProgress: [{ kind: 'service', label: 'HANAMII のプロジェクト' } as any] })] })
    expect(h).toContain('破棄中です。しばらくして「🗑 ゴミ箱に移動」をもう一度押してください。')
  })

  it('★★ 結果の部品を持たない失敗（専有型の砦・例外）は、文を選択できる 1 行で出す', () => {
    const h = html({ phase: 'stopped', steps: [{ target: 'sakura-apprun-dedicated', kind: 'failed', line: '専有型: ここからは削除できません', view: null, words: null }] })
    expect(h).toMatch(/<p class="[^"]*select-text[^"]*">専有型: ここからは削除できません<\/p>/)
    expect(h).not.toContain('data-teardown-result')
  })

  it('★★ やめた（cancelled）は 1 行（選択できる）。残りの公開先を始めていない文もそのまま', () => {
    const h = html({ phase: 'stopped', steps: [{ target: 'hanamii', kind: 'cancelled', line: 'HANAMII: 破棄をやめました。さくらのAppRunの破棄も始めていません' }] })
    expect(h).toMatch(/<p class="[^"]*select-text[^"]*">HANAMII: 破棄をやめました。さくらのAppRunの破棄も始めていません<\/p>/)
  })

  it('★★ 消すものが無い（nothingToDo）は、失敗の赤ではなく中立の 1 行「公開先: 文」', () => {
    const h = html({ phase: 'review', steps: [{ target: 'sakura-apprun', kind: 'nothingToDo', message: '公開されていないため、破棄するものはありません。' }, done('hanamii', { warnings: ['x'] })] })
    expect(h).toMatch(/<p class="[^"]*text-ink-secondary[^"]*select-text[^"]*">📦 さくらのAppRun: 公開されていないため、破棄するものはありません。<\/p>/)
    expect(h).not.toMatch(/text-brand-red[^>]*>📦 さくらのAppRun: 公開されていない/)
  })

  it('★ 文が空の nothingToDo でも、「公開先: 」だけの行にしない', () => {
    const h = html({ phase: 'review', steps: [{ target: 'sakura-apprun', kind: 'nothingToDo', message: '' }] })
    expect(h).toContain('📦 さくらのAppRun: 破棄するものはありません。')
  })

  it('★★ 「AIに相談する」は出さない（失敗の結果にも）', () => {
    const failedView = view({ ok: false, state: 'failed', executed: [], message: '失敗しました' })
    const h = html({ phase: 'stopped', steps: [{ target: 'hanamii', kind: 'failed', line: 'x', view: failedView, words: HANAMII_TEARDOWN_WORDS }] })
    expect(h).not.toContain('AIに相談')
  })
})

describe('blocked・trashFailed', () => {
  it('★★★ blocked（走っている操作）: showBlockNote が true なら止める文を ⚠️ つきで出す。false なら重ねない（赤い箱がもう同じ文を出している）', () => {
    const run: ProjectDeletePhase = { phase: 'blocked', block: { reason: 'running', op: '公開', target: 'hanamii' }, steps: [] }
    const note = '⚠️ いまこのプロジェクトの公開が進んでいます。終わってから、もう一度このプロジェクトを削除してください。'
    expect(html(run, true)).toContain(note)
    expect(html(run, false)).not.toContain('が進んでいます')
    expect(html(run, false)).not.toContain('⚠️')
  })

  // 記録の op は共用型・HANAMII の破棄も専有型の削除も '削除'。結果の欄の止める文は、画面の言葉（破棄／削除）で言う（0.6.22 の決定 D3）
  it.each([
    ['削除', 'sakura-apprun', '破棄'], ['削除', 'hanamii', '破棄'], ['削除', 'sakura-apprun-dedicated', '削除'], ['削除', 'unknown', '削除'], ['公開', 'hanamii', '公開'],
  ] as const)('★★★ blocked（%s・%s）: 「いまこのプロジェクトの%sが進んでいます。…」と言う', (op, target, word) => {
    const h = html({ phase: 'blocked', block: { reason: 'running', op, target }, steps: [] }, true)
    expect(h).toContain(`⚠️ いまこのプロジェクトの${word}が進んでいます。終わってから、もう一度このプロジェクトを削除してください。`)
  })

  it('★★ blocked でも、済んだ公開先の結果（steps）は出す', () => {
    const h = html({ phase: 'blocked', block: { reason: 'running', op: '削除', target: 'sakura-apprun-dedicated' }, steps: [done('hanamii')] }, false)
    expect(h).toContain('data-teardown-result')
    expect(h).toContain('🌸 HANAMII')
  })

  it('★★ blocked は stopped・review の見出しと末尾を出さない', () => {
    const h = html({ phase: 'blocked', block: { reason: 'running', op: '作成', target: 'sakura-apprun-dedicated' }, steps: [] })
    for (const w of [STOPPED_HEAD, STOPPED_TAIL, REVIEW_HEAD, REVIEW_TAIL]) expect(h).not.toContain(w)
  })

  it('★★★ trashFailed: 理由を選択・コピーできる形で出す（コピーのボタンつき）。見出し・末尾の文は出さない', () => {
    const h = html({ phase: 'trashFailed', steps: [done('hanamii')], message: 'プロジェクトを削除できませんでした: 権限がありません' })
    expect(h).toMatch(/<p class="[^"]*select-text[^"]*">プロジェクトを削除できませんでした: 権限がありません<\/p>/)
    expect(h).toContain('>コピー</button>')
    expect(h).toContain('data-teardown-result')
    for (const w of [STOPPED_HEAD, STOPPED_TAIL, REVIEW_HEAD, REVIEW_TAIL]) expect(h).not.toContain(w)
  })

  it('結果の欄の外側に、phase を印として持つ（data-project-delete-result）', () => {
    expect(html({ phase: 'stopped', steps: [] })).toContain('data-project-delete-result="stopped"')
    expect(html({ phase: 'review', steps: [] })).toContain('data-project-delete-result="review"')
  })
})

describe('作り', () => {
  const src = readFileSync(join(ROOT, SRC), 'utf-8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, '')).replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)

  it('150 行以下。window.alert・window.confirm を書かない。判断を持たない（フォルダを移す・破棄する口を持たない）', () => {
    expect(src.split('\n').length).toBeLessThanOrEqual(150)
    expect(code).not.toContain('window.alert')
    expect(code).not.toContain('window.confirm')
    for (const w of ['fs.trash', 'teardownPublished', 'pressProjectDelete', 'runProjectDelete', 'electronAPI', 'useState', 'useEffect']) expect(code, w).not.toContain(w)
  })

  it('公開先の管理画面の行き先は、唯一の定義 PUBLISH_TARGET_CONSOLE とコントロールパネル CONTROL_PANEL_URL から渡す（URL を自分では書かない）', () => {
    expect(code).toContain('serviceConsoleUrl={PUBLISH_TARGET_CONSOLE[step.target]} storageConsoleUrl={CONTROL_PANEL_URL}')
    expect(code).not.toContain('https://')
  })

  it('「AIに相談する」の口（onAskAi）を渡さない', () => {
    expect(code).not.toContain('onAskAi')
  })
})
