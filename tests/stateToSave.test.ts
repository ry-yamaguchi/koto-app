import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { stateToSave, emptyState, type EnvState } from '../src/main/cloud/state'

// 2026-08-14 実機。破棄が保存場所の 403 で落ちたが、**AppRunアプリは既に消えていた**。
// 記録は `if (result.ok)` の中でしか保存しておらず、state.json は「アプリはまだある」と
// 言い続けた。次に公開すると、消えたアプリへ再デプロイを試みて HTTP 404。
// **公開も破棄もできない袋小路。**
//
// applyPlan が返す state は「実際に何が起きたか」であって「成功したか」ではない。

function stateWith(resources: EnvState['resources']): EnvState {
  return { ...emptyState('myapp', 'sakura-apprun'), resources }
}

const APP = { kind: 'apprun-app' as const, id: 'app-1', stateful: false, key: 'apprun-app:myapp' }
const BUCKET = { kind: 'bucket' as const, id: 'koto-data-x', stateful: true, key: 'bucket:koto-data-x' }

describe('失敗しても、起きたことを記録する', () => {
  // ★ 実機で起きた形
  it('破棄が途中で落ちても、消えたアプリは記録から外れる', () => {
    const afterDelete = stateWith([BUCKET]) // apply がアプリを消した後の state
    const saved = stateToSave({ ok: false, state: afterDelete, kind: 'teardown' })
    expect(saved.resources.some(r => r.kind === 'apprun-app')).toBe(false)
    expect(saved.resources.some(r => r.kind === 'bucket')).toBe(true)
  })

  // 公開で同じことが起きるともっと悪い。**記録の無いアプリは Koto から消せない**
  it('公開が途中で落ちても、作られたアプリは記録に残る', () => {
    const created = stateWith([APP])
    const saved = stateToSave({ ok: false, state: created, kind: 'apply', ttlHours: 0, now: new Date() })
    expect(saved.resources).toEqual([APP])
  })

  it('失敗したときは、成功時だけの仕上げをしない（作成メタを付けない）', () => {
    const saved = stateToSave({ ok: false, state: stateWith([APP]), kind: 'apply', ttlHours: 24, now: new Date() })
    expect(saved.meta?.createdAt).toBeUndefined()
  })

  it('失敗したときは、レジストリの記録も落とさない', () => {
    const s = { ...stateWith([APP]), meta: { registryName: 'myapp-x1' } }
    const saved = stateToSave({ ok: false, state: s, kind: 'teardown' })
    expect(saved.meta?.registryName).toBe('myapp-x1')
  })
})

describe('成功したときの仕上げ', () => {
  it('公開の初回は作成メタを付ける', () => {
    const now = new Date('2026-08-14T00:00:00.000Z')
    const saved = stateToSave({ ok: true, state: stateWith([APP]), kind: 'apply', ttlHours: 24, now })
    expect(saved.meta?.createdAt).toBe('2026-08-14T00:00:00.000Z')
    expect(saved.meta?.ttlHours).toBe(24)
  })

  it('二度目の公開では作成メタを書き換えない', () => {
    const s = { ...stateWith([APP]), meta: { createdAt: '2026-08-01T00:00:00.000Z', ttlHours: 0 } }
    const saved = stateToSave({ ok: true, state: s, kind: 'apply', ttlHours: 24, now: new Date() })
    expect(saved.meta?.createdAt).toBe('2026-08-01T00:00:00.000Z')
  })

  it('破棄でレジストリを残したときは、名前を記録に残す（消せなくならないように）', () => {
    const s = { ...stateWith([]), meta: { registryName: 'myapp-x1' } }
    expect(stateToSave({ ok: true, state: s, kind: 'teardown', registryDeleted: false }).meta?.registryName).toBe('myapp-x1')
    expect(stateToSave({ ok: true, state: s, kind: 'teardown', registryDeleted: true }).meta?.registryName).toBeUndefined()
  })
})

// 判断を一元化しても、呼ぶ側が `if (result.ok)` で囲めば同じ穴が空く（掟10）。
describe('記録の保存が、成功の中に閉じ込められていない', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc', 'cloud.ts'), 'utf-8')

  it('applyPlan が返した state は、必ず stateToSave を通してから保存する', () => {
    // `result.state`（＝実際に何が起きたか）を素で保存している箇所があってはならない。
    // ※レジストリ名だけを書き足す保存（別の目的）はここでは見ない
    // 保存に渡している箇所（`state: result.state`）だけを見る。読み取りは対象外
    const positions: number[] = []
    for (let i = source.indexOf('state: result.state'); i !== -1; i = source.indexOf('state: result.state', i + 1)) positions.push(i)
    expect(positions.length).toBeGreaterThanOrEqual(3)
    for (const at of positions) {
      const before = source.slice(Math.max(0, at - 120), at)
      expect(before).toContain('stateToSave')
    }
  })

  it('失敗したときにも保存する道がある', () => {
    expect(source).toContain('ok: false, state: result.state')
  })
})
