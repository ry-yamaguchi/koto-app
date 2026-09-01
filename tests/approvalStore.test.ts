import { describe, it, expect, beforeEach } from 'vitest'
import {
  requestApproval, answerApproval, listPending, setApprovalListener, resetApprovalsForTest,
} from '../src/main/chat/approvalStore'

// approvalStore.ts — 承認（approveToolCall）の main 側マネージャ（B'-3d-3）。
// electron 非依存の純粋なロジックなので、node の Vitest から直接検証する
// （askBridge.test.ts・learningStore.test.ts と同じ流儀）。

describe('approvalStore', () => {
  beforeEach(() => { resetApprovalsForTest() })

  it('request → answer(true) で許可として resolve し、一覧から消える', async () => {
    const p = requestApproval({ turnId: 't1', dir: '/proj', label: 'コマンド実行: ls' })
    const list = listPending()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ dir: '/proj', label: 'コマンド実行: ls' })
    expect(typeof list[0].id).toBe('string')
    expect(answerApproval(list[0].id, true)).toBe(true)
    await expect(p).resolves.toBe(true)
    expect(listPending()).toHaveLength(0)
  })

  it('answer(false) で拒否として resolve する', async () => {
    const p = requestApproval({ turnId: 't1', dir: null, label: 'ファイル保存: a.js' })
    const id = listPending()[0].id
    expect(answerApproval(id, false)).toBe(true)
    await expect(p).resolves.toBe(false)
  })

  it('未知の id は false を返して無視する（帳簿を変えない）', () => {
    requestApproval({ turnId: 't1', dir: null, label: 'A' })
    expect(answerApproval('no-such-id', true)).toBe(false)
    expect(listPending()).toHaveLength(1) // 何も変わっていない
  })

  it('二重回答は2回目が false（1回目で既に帳簿から消えている）', () => {
    requestApproval({ turnId: 't1', dir: null, label: 'A' })
    const id = listPending()[0].id
    expect(answerApproval(id, true)).toBe(true)
    expect(answerApproval(id, true)).toBe(false)
    expect(answerApproval(id, false)).toBe(false)
  })

  it('listPending は複数件を保持し、id はそれぞれ別（同時に複数プロジェクトが承認を求め得る・B-1b）', () => {
    requestApproval({ turnId: 't1', dir: '/a', label: 'A' })
    requestApproval({ turnId: 't2', dir: '/b', label: 'B' })
    const list = listPending()
    expect(list).toHaveLength(2)
    expect(list[0].id).not.toBe(list[1].id)
    expect(list.map(x => x.dir).sort()).toEqual(['/a', '/b'])
  })

  it('listPending が返す一覧に resolve は含まれない（呼び出し側が触れない）', () => {
    requestApproval({ turnId: 't1', dir: null, label: 'A' })
    const entry = listPending()[0] as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(entry, 'resolve')).toBe(false)
  })

  it('listener は request/answer のたびに最新の一覧（の件数）で呼ばれる', () => {
    const counts: number[] = []
    setApprovalListener(list => counts.push(list.length))
    requestApproval({ turnId: 't1', dir: null, label: 'A' })
    expect(counts).toEqual([1])
    const id = listPending()[0].id
    answerApproval(id, true)
    expect(counts).toEqual([1, 0])
  })

  it('setApprovalListener(null) で通知が止まる', () => {
    let called = 0
    setApprovalListener(() => { called++ })
    setApprovalListener(null)
    requestApproval({ turnId: 't1', dir: null, label: 'A' })
    expect(called).toBe(0)
  })

  // ── タイムアウトしない（駐機の本体）─────────────────────────────────────
  // 窓が何時間閉じていても待ち続ける、という設計を「answerApproval を呼ぶまで
  // 自然には解決しない」ことで確かめる（setTimeout 等の自動解決が無いことの間接証明）。
  it('タイムアウトしない: answerApproval を呼ぶまで、いつまでも pending のまま', async () => {
    let resolved = false
    const p = requestApproval({ turnId: 't1', dir: null, label: 'A' }).then(() => { resolved = true })
    for (let i = 0; i < 50; i++) await new Promise(r => setTimeout(r, 0))
    expect(resolved).toBe(false)
    const id = listPending()[0].id
    answerApproval(id, true)
    await p
    expect(resolved).toBe(true)
  })

  it('resetApprovalsForTest は帳簿とリスナーを空にする', () => {
    let called = false
    setApprovalListener(() => { called = true })
    requestApproval({ turnId: 't1', dir: null, label: 'A' })
    resetApprovalsForTest()
    expect(listPending()).toHaveLength(0)
    called = false
    requestApproval({ turnId: 't1', dir: null, label: 'A' })
    expect(called).toBe(false) // リスナーも外れている
  })
})
