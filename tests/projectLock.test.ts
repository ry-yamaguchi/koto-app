import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withProjectLock, projectBusyMessage, runningOp, runningOpEntry } from '../src/main/projectLock'

// ── H-1（2026-09-17）──────────────────────────────────────────────────────────
// 横断点検（6視点）のうち4つが独立に同じ欠陥へ収束した: ⑥「すべて削除する」の実行中でも
// ⑧「公開する」が押せた。破棄は実測で約9分かかるので窓が広い。割り込まれると記録が交錯し、
// applicationID があるのに clusterID が無い状態になって **Koto からは二度と消せない**
// （月額およそ2万2千円が止まらない）。
//
// 画面のフラグ（tearingDown / publishing）は**窓の再読み込みで消える**ので、main にも歯止めを置く。

/** 決まった回数だけ待ってから値を返す（同時実行を作るための小道具）。 */
const later = <T>(value: T, ticks = 3) => async () => {
  for (let i = 0; i < ticks; i++) await Promise.resolve()
  return value
}

describe('withProjectLock: 同じプロジェクトで作成・削除・公開を同時に走らせない', () => {
  it('走っていなければ、そのまま実行して値を返す', async () => {
    const r = await withProjectLock('/p/a', '公開', later('done'))
    expect(r).toEqual({ busy: false, value: 'done' })
  })

  it('★ 破棄の実行中に公開を呼ぶと、公開の処理が1つも走らない', async () => {
    const calls: string[] = []
    const teardown = withProjectLock('/p/b', '削除', async () => {
      // 破棄が走っているあいだに公開を割り込ませる。
      const p = await withProjectLock('/p/b', '公開', async () => {
        calls.push('公開が走ってしまった')
        return 'published'
      })
      expect(p).toEqual({ busy: true, running: '削除', runningTarget: 'unknown' })
      return 'torn'
    })
    await expect(teardown).resolves.toEqual({ busy: false, value: 'torn' })
    // **公開の中身は1度も呼ばれていない**（振る舞いで固定する・掟10）。
    expect(calls).toEqual([])
  })

  it('★ 公開の実行中に破棄を呼ぶと、破棄の処理が1つも走らない（逆向き）', async () => {
    const calls: string[] = []
    await withProjectLock('/p/c', '公開', async () => {
      const t = await withProjectLock('/p/c', '削除', async () => {
        calls.push('破棄が走ってしまった')
        return 'torn'
      })
      expect(t).toEqual({ busy: true, running: '公開', runningTarget: 'unknown' })
      return 'published'
    })
    expect(calls).toEqual([])
  })

  it('★ 作成の実行中も、公開・破棄は断られる', async () => {
    await withProjectLock('/p/d', '作成', async () => {
      expect(await withProjectLock('/p/d', '公開', later('x'))).toEqual({ busy: true, running: '作成', runningTarget: 'unknown' })
      expect(await withProjectLock('/p/d', '削除', later('x'))).toEqual({ busy: true, running: '作成', runningTarget: 'unknown' })
      return 'created'
    })
  })

  it('★ 中で例外が出ても印が外れる（外れないと「二度と押せない」になる）', async () => {
    await expect(
      withProjectLock('/p/e', '削除', async () => { throw new Error('落ちた') }),
    ).rejects.toThrow('落ちた')
    expect(runningOp('/p/e')).toBeUndefined()
    // もう一度呼べる。
    expect(await withProjectLock('/p/e', '公開', later('ok'))).toEqual({ busy: false, value: 'ok' })
  })

  it('終わったあとは印が残らない', async () => {
    await withProjectLock('/p/f', '公開', later('ok'))
    expect(runningOp('/p/f')).toBeUndefined()
  })

  it('★ 別のプロジェクトどうしは互いに影響しない', async () => {
    const calls: string[] = []
    await withProjectLock('/p/g', '削除', async () => {
      const other = await withProjectLock('/p/h', '公開', async () => {
        calls.push('別プロジェクトの公開が走った')
        return 'published'
      })
      expect(other).toEqual({ busy: false, value: 'published' })
      return 'torn'
    })
    expect(calls).toEqual(['別プロジェクトの公開が走った'])
  })
})

describe('projectBusyMessage: 何が走っているかを名指しする', () => {
  it('★ 走っている操作の名前が文面に入る（「いま使えません」で終わらせない）', () => {
    expect(projectBusyMessage('削除', 'sakura-apprun-dedicated')).toContain('削除')
    expect(projectBusyMessage('公開', 'vercel')).toContain('公開')
    expect(projectBusyMessage('作成', 'sakura-apprun-dedicated')).toContain('作成')
  })

  it('どうすればよいかまで書く', () => {
    expect(projectBusyMessage('削除', 'hanamii')).toContain('お試しください')
  })

  // 記録の op は、共用型・HANAMII の破棄も専有型の削除も '削除'。画面は前者を「破棄」と言う（0.6.22 の決定 D3。opWordFor が決める）。
  // 断る文が記録の op をそのまま言うと、破棄の最中に別の操作を押すと「（削除）」と出る（0.6.22-rc.3 の実機のあとの確かめで見つかった）。
  it.each([
    ['削除', 'sakura-apprun', '破棄'],
    ['削除', 'hanamii', '破棄'],
    ['削除', 'sakura-apprun-dedicated', '削除'],
    ['削除', 'vercel', '削除'],
    ['削除', 'sakura-rental', '削除'],
    ['削除', 'unknown', '削除'],
    ['公開', 'sakura-apprun', '公開'],
    ['公開', 'hanamii', '公開'],
    ['作成', 'sakura-apprun-dedicated', '作成'],
  ] as const)('★★ %s・%s → 「（%s）」。共用型・HANAMII の破棄だけ「破棄」、公開先が分からなければ op のまま', (op, target, word) => {
    expect(projectBusyMessage(op, target)).toBe(`いま別の操作（${word}）を実行中です。終わってからもう一度お試しください。`)
  })
})

describe('runningOpEntry と、断られたときに返す公開先（断る文の材料）', () => {
  it('★ 走っている間は、操作名と公開先を同じ記録から返す。終われば undefined（runningOp と同じ答え）', async () => {
    const dir = '/p/entry-a'
    expect(runningOpEntry(dir)).toBeUndefined()
    await withProjectLock(dir, '削除', async () => {
      expect(runningOpEntry(dir)).toEqual({ op: '削除', target: 'sakura-apprun' })
      expect(runningOp(dir)).toBe('削除')
      return 'x'
    }, { target: 'sakura-apprun', handler: 'cloud:teardown' })
    expect(runningOpEntry(dir)).toBeUndefined()
    expect(runningOp(dir)).toBeUndefined()
  })

  it('★★ 断られた側が受け取る runningTarget は、走っているほうの公開先（断った側の公開先ではない）', async () => {
    const dir = '/p/entry-b'
    await withProjectLock(dir, '削除', async () => {
      const refused = await withProjectLock(dir, '公開', later('x'), { target: 'vercel', handler: 'vercel:publish' })
      expect(refused).toEqual({ busy: true, running: '削除', runningTarget: 'hanamii' })
      if (refused.busy) expect(projectBusyMessage(refused.running, refused.runningTarget)).toContain('（破棄）')
      return 'x'
    }, { target: 'hanamii', handler: 'hanamii:teardown' })
  })

  it('記録に公開先が無い鍵（meta を渡さない呼び出し）は \'unknown\' → 断る文は op のまま', async () => {
    const dir = '/p/entry-c'
    await withProjectLock(dir, '削除', async () => {
      expect(runningOpEntry(dir)).toEqual({ op: '削除', target: 'unknown' })
      return 'x'
    })
  })
})

/** コメント行を剥がす（当て先がコメントに出るのを避ける）。 */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*'))
    .join('\n')
}

describe('IPC の配線: 作成・破棄・公開のすべてが歯止めを通る', () => {
  const ipc = codeOnly(readFileSync(join(__dirname, '../src/main/ipc/apprunDedicated.ts'), 'utf8'))
  // 破棄は 0.6.22 段階3B-1 から ipc/apprunDedicatedTeardown.ts（仕様書）と共通の骨 cloud/teardownShell.ts に載った。
  const teardownIpc = codeOnly(readFileSync(join(__dirname, '../src/main/ipc/apprunDedicatedTeardown.ts'), 'utf8'))
  const shell = codeOnly(readFileSync(join(__dirname, '../src/main/cloud/teardownShell.ts'), 'utf8'))

  it('★ createClusterFlow / teardownFlow / publishApp の本体が withProjectLock の中にある（破棄の鍵は骨が取る）', () => {
    // 3つの操作それぞれで歯止めを取っていること（渡す名前まで見る）。
    expect(ipc).toContain("withProjectLock(projectDir, '作成'")
    expect(ipc).toContain("withProjectLock(projectDir, '公開'")
    expect(shell).toContain("withProjectLock(projectDir, '削除'")
  })

  it('★ 破棄は1か所（手順6も 📡 の 🗑 も同じ apprunDedicated:teardown）。その1か所が骨を通り、鍵は骨の1か所。アプリだけを消す口は無い', () => {
    // 専有型のファイル2つには、削除の鍵の取り方が無い（骨だけが取る）。仕様書は骨を呼ぶだけ。
    expect(ipc.split("withProjectLock(projectDir, '削除'").length - 1).toBe(0)
    expect(teardownIpc.split("withProjectLock(projectDir, '削除'").length - 1).toBe(0)
    expect(teardownIpc).toContain('runTeardownShell(DEDICATED_TEARDOWN_SHELL')
    expect(shell.split("withProjectLock(projectDir, '削除'").length - 1).toBe(1)
    expect(ipc).not.toContain("ipcMain.handle('apprunDedicated:teardownApp'")
    expect(teardownIpc).not.toContain("ipcMain.handle('apprunDedicated:teardownApp'")
    expect(teardownIpc).not.toContain('teardownApp')
  })

  it('★ 断ったときは projectBusyMessage を使う（文面を書き散らさない）', () => {
    expect(ipc).toContain('projectBusyMessage(')
    expect(ipc).not.toContain('いま別の操作（')
  })
})
