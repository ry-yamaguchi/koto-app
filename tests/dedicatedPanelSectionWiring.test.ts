import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── 段階3B（3B-6a）: 専有型のパネル（AppRunDedicatedPanel.tsx）が、手順6の節（DedicatedTeardownSection.tsx）へ渡す口 ──────────────
// 設計書: docs/teardown-unify-plan.md の 10.11.9（D1 手順6）の2。
// 節の振る舞い（確認 → 実行・二重押し・stale・進み具合）は tests/dedicatedTeardownSection.test.ts が偽の React の上で固定している。
// ここは**パネルが節へ渡す属性が、1つも欠けず、決まった式のままであること**を固定する。
// 任意の属性で機能を繋ぐと、渡し忘れても型も画面も黙って通る（CLAUDE.md 掟10「型が通ることは、繋がっている証拠にならない」）。
// 実際に、節へ渡す `running`・`nowMs`・`tearingDown`・`appRecord`・`projectDir` のどれを外しても、既存のテストは全部緑のままだった
// （3B-6a の再検分で変異を当てて確かめた）。パネルは 2,800 行を超えるので偽の React では開けない。呼び出しの形ごと見る。
// 当て先が他の行に出ないか: 要素 `<DedicatedTeardownSection` はパネルに1つだけ（下で数える）。コメントは除いて読む。

const ROOT = path.join(__dirname, '..')
const PANEL = 'src/renderer/components/AppRunDedicatedPanel.tsx'
const SECTION = 'src/renderer/components/DedicatedTeardownSection.tsx'
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

/** コメントを除く（行番号がずれないよう改行は残す）。文字列の中の `//`（https://…）は直前が空白でないので消えない。 */
function stripComments(text: string): string {
  return text
    .replace(/(?<![^\s({[,;])\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
    .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)
}
const panel = stripComments(read(PANEL))
const section = stripComments(read(SECTION))

/** `name={式}` と `name="文字"` を読む（式の中の波括弧は釣り合いを数える）。 */
function readAttributes(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < body.length) {
    const m = /([A-Za-z_]\w*)=/y
    m.lastIndex = i
    const hit = m.exec(body)
    if (!hit) { i++; continue }
    const name = hit[1]
    let j = m.lastIndex
    if (body[j] === '{') {
      let depth = 0
      const start = j
      for (; j < body.length; j++) {
        if (body[j] === '{') depth++
        else if (body[j] === '}') { depth--; if (depth === 0) break }
      }
      out[name] = body.slice(start + 1, j).trim()
      i = j + 1
    } else if (body[j] === '"') {
      const end = body.indexOf('"', j + 1)
      out[name] = JSON.stringify(body.slice(j + 1, end))
      i = end + 1
    } else {
      i = j
    }
  }
  return out
}

/** パネルが節へ渡している属性（名前 → 式）。 */
function passedProps(): Record<string, string> {
  const at = panel.indexOf('<DedicatedTeardownSection')
  expect(at, 'パネルに節の要素が無い').toBeGreaterThan(-1)
  const end = panel.indexOf('/>', at)
  expect(end).toBeGreaterThan(at)
  return readAttributes(panel.slice(at + '<DedicatedTeardownSection'.length, end))
}

/** 節が受け取ると宣言している属性の名前（分割代入の名前と、型の宣言の名前の両方）。 */
function declaredProps(): { destructured: string[]; typed: string[] } {
  const head = section.indexOf('export default function DedicatedTeardownSection({')
  expect(head, '節の部品が無い').toBeGreaterThan(-1)
  const typeAt = section.indexOf('}: {', head)
  expect(typeAt).toBeGreaterThan(head)
  const destructured = section.slice(head + 'export default function DedicatedTeardownSection({'.length, typeAt)
    .split(',').map(s => s.trim()).filter(Boolean)
  const typeEnd = section.indexOf('\n}) {', typeAt)
  expect(typeEnd).toBeGreaterThan(typeAt)
  const typed = [...section.slice(typeAt, typeEnd).matchAll(/^ {2}(\w+)\??:/gm)].map(m => m[1])
  return { destructured, typed }
}

/** パネルが節へ渡す式。**1つ変えるときは、節の側の使い方と、この表を一緒に直す**（表に無い属性・欠けた属性は落ちる）。 */
const EXPECTED: Record<string, string> = {
  projectDir: 'projectDir',
  locked: 'panelBusy({ creating, tearingDown, publishing, lbRefreshing })',
  showButton: 'showTeardownButton',
  tearingDown: 'tearingDown',
  running: "runningKind === 'teardown'",
  runningRecord: 'runningRecord',
  nowMs: 'nowMs',
  apprunState: 'apprunState',
  appRecord: 'appRecord',
  summaryLines: 'hasAnyResource ? buildTeardownSummary(teardownSummaryRecord, { worker: workerPlans, lb: lbPlans }).lines : []',
  view: 'teardownView',
  notes: 'resumedNotes.teardown',
  onStart: 'onTeardownStart',
  onDone: 'onTeardownDone',
}

describe('パネル → 手順6の節: 渡す属性', () => {
  it('★★★ 節の要素はパネルに1つだけ。節が宣言した属性（分割代入・型）と、パネルが渡す属性は、名前が過不足なく同じ', () => {
    expect(panel.split('<DedicatedTeardownSection').length - 1, '節の要素が1つでない').toBe(1)
    const passed = Object.keys(passedProps()).sort()
    const { destructured, typed } = declaredProps()
    expect(destructured.length, '節の属性を読み取れていない').toBeGreaterThan(8)
    expect([...destructured].sort(), '分割代入と型の宣言が食い違っている').toEqual([...typed].sort())
    expect(passed, '節が受け取る属性と、パネルが渡す属性が食い違っている（渡し忘れは型も画面も黙って通る）').toEqual([...destructured].sort())
  })

  it.each(Object.entries(EXPECTED))('★★ %s={…} は決まった式のまま', (name, expr) => {
    expect(passedProps()[name], `${name} の式が変わった・消えた`).toBe(expr)
  })

  it('★ 渡す式の材料（走っているものの種類・記録・実行中の印）の定義が、手順6の記録の見張りと同じ形のまま', () => {
    // 閉じて開き直したときも、別の窓で始めた削除も、記録が「走っている」と言えば節は「削除しています…」を出す（この画面が始めたものだけにしない）
    expect(panel).toContain("const tearingDown = tearingDownLocal || runningKind === 'teardown'")
    expect(panel).toContain('const runningRecord = opsRunning.running?.record ?? null')
    expect(panel).toContain("const runningKind: DedicatedOpKind | null = opsRunning.running?.kind ?? null")
  })
})

describe('パネル: 手順5の作成が始まったら、手順6の古い結果を消す（B-2・2026-09-10 実機）', () => {
  it('★★ 作成の本体（create の中）は、実行中の印を立てて、手順5の結果と手順6の結果を消す。IPC を呼ぶより前', () => {
    const start = 'setCreating(true); setCreateResult(null); setTeardownView(null)'
    expect(panel.split(start).length - 1, '作成を始める所の「結果を消す」が1か所でない').toBe(1)
    expect(panel.indexOf(start)).toBeLessThan(panel.indexOf('window.electronAPI.apprunDedicated.create(projectDir, auth, s, opts)'))
  })
})
