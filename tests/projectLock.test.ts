import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withProjectLock, projectBusyMessage, runningOp } from '../src/main/projectLock'

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
      expect(p).toEqual({ busy: true, running: '削除' })
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
      expect(t).toEqual({ busy: true, running: '公開' })
      return 'published'
    })
    expect(calls).toEqual([])
  })

  it('★ 作成の実行中も、公開・破棄は断られる', async () => {
    await withProjectLock('/p/d', '作成', async () => {
      expect(await withProjectLock('/p/d', '公開', later('x'))).toEqual({ busy: true, running: '作成' })
      expect(await withProjectLock('/p/d', '削除', later('x'))).toEqual({ busy: true, running: '作成' })
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
    expect(projectBusyMessage('削除')).toContain('削除')
    expect(projectBusyMessage('公開')).toContain('公開')
    expect(projectBusyMessage('作成')).toContain('作成')
  })

  it('どうすればよいかまで書く', () => {
    expect(projectBusyMessage('削除')).toContain('お試しください')
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

  it('★ createClusterFlow / teardownFlow / publishApp の本体が withProjectLock の中にある', () => {
    // 3つの操作それぞれで歯止めを取っていること（渡す名前まで見る）。
    expect(ipc).toContain("withProjectLock(projectDir, '作成'")
    expect(ipc).toContain("withProjectLock(projectDir, '削除'")
    expect(ipc).toContain("withProjectLock(projectDir, '公開'")
  })

  it('★ 破棄は2か所（⑥の全部・📡のアプリだけ）とも歯止めを通る', () => {
    const hits = ipc.split("withProjectLock(projectDir, '削除'").length - 1
    expect(hits).toBe(2)
  })

  it('★ 断ったときは projectBusyMessage を使う（文面を書き散らさない）', () => {
    expect(ipc).toContain('projectBusyMessage(')
    expect(ipc).not.toContain('いま別の操作（')
  })
})
