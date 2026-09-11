import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 委譲仕様: 起動のしかたの食い違いを聞く機能の IPC 3点セット（main / preload / global.d.ts）。
// 掟6「3点セットを必ず同時に更新する」・掟10「呼び出しの形ごと一意に指す」。

const cloud = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')
const preload = readFileSync(join(__dirname, '..', 'src/main/preload.ts'), 'utf-8')
const globalDts = readFileSync(join(__dirname, '..', 'src/renderer/global.d.ts'), 'utf-8')

/** `openAt` の位置にある `(` から、対応する閉じ括弧までの本文を切り出す（applyWiring.test.ts と同じ考え方）。 */
function callBody(source: string, openParenAt: number): string {
  let depth = 0
  let i = openParenAt
  const start = i
  for (; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')') {
      depth--
      if (depth === 0) break
    }
  }
  return source.slice(start, i + 1)
}

describe('cloud:apply の opts に scaleDecision が3点セットで揃っている', () => {
  it("main（cloud.ts）: ハンドラの型に scaleDecision?: 'koto' | 'sakura' がある", () => {
    expect(cloud).toContain("ipcMain.handle('cloud:apply', async (event, projectDir: string, opts?: { confirmed?: boolean; scaleDecision?: 'koto' | 'sakura' }) => {")
  })

  it('main: 値の形を検証してから applyPlan へ渡す（不正値は undefined 扱い）', () => {
    const at = cloud.indexOf("ipcMain.handle('cloud:apply'")
    expect(at).toBeGreaterThan(0)
    const applyPlanAt = cloud.indexOf('result = await applyPlan(', at)
    expect(applyPlanAt).toBeGreaterThan(at)
    const between = cloud.slice(at, applyPlanAt)
    expect(between).toContain("const scaleDecision = opts?.scaleDecision === 'koto' || opts?.scaleDecision === 'sakura' ? opts.scaleDecision : undefined")
    const call = callBody(cloud, applyPlanAt + 'result = await applyPlan'.length)
    expect(call).toContain('...(scaleDecision ? { scaleDecision } : {})')
  })

  it("preload: apply(projectDir, opts?: { confirmed?: boolean; scaleDecision?: 'koto' | 'sakura' })", () => {
    expect(preload).toContain("apply: (projectDir: string, opts?: { confirmed?: boolean; scaleDecision?: 'koto' | 'sakura' }) => ipcRenderer.invoke('cloud:apply', projectDir, opts),")
  })

  it("global.d.ts: apply の opts 引数に scaleDecision がある", () => {
    const at = globalDts.indexOf('apply(projectDir: string, opts?:')
    expect(at).toBeGreaterThan(0)
    const line = globalDts.slice(at, globalDts.indexOf('\n', at))
    expect(line).toContain("scaleDecision?: 'koto' | 'sakura'")
  })
})

describe('cloud:apply の戻り値に needsScaleDecision / adoptedScaleMin が3点セットで揃っている', () => {
  it('main: 結果の needsScaleDecision / adoptedScaleMin を、そのまま renderer へ返している', () => {
    expect(cloud).toContain('...(result.needsScaleDecision ? { needsScaleDecision: result.needsScaleDecision } : {}),')
    expect(cloud).toContain('...(result.adoptedScaleMin !== undefined ? { adoptedScaleMin: result.adoptedScaleMin } : {}),')
  })

  it('main: adoptedScaleMin があれば、cloud:saveEnv と同じ経路（writeValidatedSpec）で env.json を書き戻す', () => {
    const at = cloud.indexOf('if (result.adoptedScaleMin !== undefined) {')
    expect(at).toBeGreaterThan(0)
    const block = cloud.slice(at, cloud.indexOf('\n      }', at))
    expect(block).toContain('writeValidatedSpec(projectDir, specToSave)')
    // resolvedSpec（image 解決後の複製）ではなく、元の spec を土台にしている
    expect(block).toContain('{ ...spec, service: { ...spec.service, scale: { ...spec.service.scale, min: result.adoptedScaleMin } } }')
  })

  it("global.d.ts: apply の戻り値の型に needsScaleDecision / adoptedScaleMin がある", () => {
    const at = globalDts.indexOf('apply(projectDir: string, opts?:')
    const line = globalDts.slice(at, globalDts.indexOf('\n', at))
    expect(line).toContain('needsScaleDecision?: { appId: string; recorded: number; actual: number }')
    expect(line).toContain('adoptedScaleMin?: number')
  })
})

describe('cloud:saveEnv と cloud:apply の env.json 書き込みは、同じ関数（writeValidatedSpec）を共用している（複製しない・掟10）', () => {
  it('writeValidatedSpec の定義は1つだけ', () => {
    const matches = cloud.match(/function writeValidatedSpec\(/g) ?? []
    expect(matches.length).toBe(1)
  })

  it("cloud:saveEnv は writeValidatedSpec を呼ぶだけ", () => {
    const at = cloud.indexOf("ipcMain.handle('cloud:saveEnv'")
    expect(at).toBeGreaterThan(0)
    const end = cloud.indexOf('})', at) + 2
    const block = cloud.slice(at, end)
    expect(block).toContain('return writeValidatedSpec(projectDir, spec)')
  })
})

describe('preflight（cloud:preflight）に「起動のしかた」の項目がある', () => {
  it("mine（記録にある自分のアプリID）があるときだけ確認する", () => {
    const at = cloud.indexOf("ipcMain.handle('cloud:preflight'")
    expect(at).toBeGreaterThan(0)
    const scaleAt = cloud.indexOf("add('scale', '起動のしかた'", at)
    expect(scaleAt).toBeGreaterThan(at)
    // mine を使ったガードが、scale の確認より前にある
    const mineAt = cloud.indexOf('const mine = state.resources.find', at)
    expect(mineAt).toBeGreaterThan(at)
    expect(mineAt).toBeLessThan(scaleAt)
  })

  it('一致・食い違い・確認できないの3通りを warn/ok で出す（止めない。ng にしない）', () => {
    const at = cloud.indexOf("add('scale', '起動のしかた'")
    const end = cloud.indexOf("// 保存場所が**実在するか**", at)
    const block = cloud.slice(at, end)
    expect(block).not.toContain("'ng'")
    expect(block).toContain("'ok'")
    expect(block).toContain("'warn'")
    expect(block).toContain('公開を押すと、どちらにするかを聞きます。')
  })
})
