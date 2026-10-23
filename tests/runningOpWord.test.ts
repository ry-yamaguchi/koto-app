import { describe, it, expect, vi, afterEach } from 'vitest'

// ── 走っている操作の言葉を、main の鍵から画面の赤字まで一本で通す（0.6.22 の決定 D3）──────────────────────────
// 記録の op は、共用型・HANAMII の破棄も専有型の削除も '削除'。画面は前者を「破棄」と言う（確認・進み具合・結果まで1つの言葉）。
// プロジェクトの削除は、公開・破棄・作成が進んでいる間は止まり、赤字で「いまこのプロジェクトの○○が進んでいます」と言う。
// ここの ○○ が記録の op のままだと、共用型・HANAMII の破棄が走っている間に「削除が進んでいます」と出る
// （0.6.22-rc.3 の実機のあとの確かめで見つかった）。
//
// 通す道（どれも本物）:
//   本物の鍵（withProjectLock。公開先つきで取る）→ 本物の IPC ハンドラ（publishMeta:runningOp）→ 本物の読み口（readProjectDeleteFacts）
//   → 本物の判断（planProjectDeleteTeardown）→ 本物の文（projectDeleteBlockNote）
// 偽にするのは、画面の preload（IPC をそのまま呼ぶ橋）と、走っている操作と関係のない読み口（専有型の記録・保存場所・共用型の記録）だけ。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
}))

import { registerPublishMetaHandlers } from '../src/main/ipc/publishMeta'
import { withProjectLock } from '../src/main/projectLock'
import type { ProjectOp, OpTarget } from '../src/main/projectOps'
import { readProjectDeleteFacts } from '../src/renderer/teardown/projectDeleteFacts'
import { planProjectDeleteTeardown, projectDeleteBlockNote } from '../src/renderer/teardown/projectDeletePlan'
import { readRunningOp } from '../src/renderer/projectMeta'

registerPublishMetaHandlers()

const emptyRecord = { appNames: [], registryName: null, registryOrigin: 'unknown', registryUsers: [], placements: [], stateOnlyBuckets: [] }

/** 画面の preload の代わり。runningOp は本物の IPC ハンドラへ、そのまま渡す。 */
function installWindow() {
  ;(globalThis as any).window = {
    electronAPI: {
      fs: {
        exists: async () => false,
        readFile: async () => { throw new Error('ENOENT') },
      },
      publishMeta: { runningOp: (dir: string) => h.handlers.get('publishMeta:runningOp')!({}, dir) },
      apprunDedicated: { state: async () => null },
      storage: { placement: async () => ({ ok: true, placements: [] }) },
      cloud: { teardownRecord: async () => ({ ok: true, record: emptyRecord }) },
    },
  }
}
afterEach(() => { delete (globalThis as any).window })

let n = 0
/** 鍵を取って走らせたまま、`during` を呼ぶ。 */
async function whileRunning<T>(op: ProjectOp, target: OpTarget, during: (dir: string) => Promise<T>): Promise<T> {
  const dir = `/work/running-op-word-${++n}`
  let open!: () => void
  const gate = new Promise<void>(r => { open = r })
  const held = withProjectLock(dir, op, () => gate, { target, handler: 'test:hold' })
  try {
    return await during(dir)
  } finally {
    open()
    await held
  }
}

describe('★★★ 走っている操作の言葉: 鍵 → IPC → 材料 → 判断 → プロジェクト削除の赤字', () => {
  it.each([
    ['削除', 'sakura-apprun', '破棄'],
    ['削除', 'hanamii', '破棄'],
    ['削除', 'sakura-apprun-dedicated', '削除'],
    ['削除', 'unknown', '削除'],
    ['公開', 'sakura-apprun', '公開'],
    ['公開', 'hanamii', '公開'],
    ['作成', 'sakura-apprun-dedicated', '作成'],
  ] as const)('%s・%s が走っている間 → 赤字は「いまこのプロジェクトの%sが進んでいます」。止める判断は公開先で変わらない', async (op, target, word) => {
    installWindow()
    await whileRunning(op, target, async dir => {
      expect(await readRunningOp(dir)).toEqual({ op, target })
      const facts = await readProjectDeleteFacts(dir)
      expect(facts.running).toEqual({ op, target })
      const plan = planProjectDeleteTeardown(facts)
      // 止める判断: どの公開先の何が走っていても、走っていれば止める（言葉だけが公開先で決まる）
      expect(plan.block).toEqual({ reason: 'running', op, target })
      expect(plan.teardown).toEqual([])
      expect(projectDeleteBlockNote(plan.block!)).toBe(`いまこのプロジェクトの${word}が進んでいます。終わってから、もう一度このプロジェクトを削除してください。`)
    })
  })

  it('走っていなければ null（止めない）。終わったあとも null', async () => {
    installWindow()
    let dirUsed = ''
    await whileRunning('削除', 'hanamii', async dir => { dirUsed = dir })
    expect(await readRunningOp(dirUsed)).toBeNull()
    expect((await readProjectDeleteFacts(dirUsed)).running).toBeNull()
    expect(planProjectDeleteTeardown(await readProjectDeleteFacts(dirUsed)).block).toBeNull()
  })
})
