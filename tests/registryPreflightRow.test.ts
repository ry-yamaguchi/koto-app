import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registryPreflightRow, REGISTRY_UNREADABLE_NOTE } from '../src/main/cloud/registryPreflight'

// 公開前の確認の「コンテナレジストリ」の行（0.6.26）。
// 一覧の応答の形が読めない回を「0件」と読むと、実在するレジストリを「見つかりません」と言い、
// 作り直しのボタンまで出してしまう（押すと「読み取れませんでした」で失敗する）。偽の client で行の中身を固定する。

const fake = (res: unknown) => {
  const calls: string[] = []
  return { calls, client: { listContainerRegistries: async (zone: string) => { calls.push(zone); return res } } as any }
}
const ok = (data: unknown) => ({ dryRun: false as const, ok: true, status: 200, data })
const item = (label: string) => ({ ID: `id-${label}`, Provider: { Class: 'containerregistry' }, Status: { registry_name: label } })

describe('registryPreflightRow', () => {
  it.each([
    ['CommonServiceItems が無い', {}],
    ['配列でない', { CommonServiceItems: 'oops' }],
    ['応答が文字列', 'not json'],
    ['応答が null', null],
  ])('★ HTTP 200 でも形が読めない（%s）→ warn・「見つかりません」と言わず・作り直しも出さない', async (_n, data) => {
    const { client, calls } = fake(ok(data))
    const r = await registryPreflightRow(client, 'is1a', 'myapp')
    expect(calls).toEqual(['is1a'])
    expect(r).toEqual({ id: 'registry', label: 'コンテナレジストリ', status: 'warn', note: REGISTRY_UNREADABLE_NOTE })
    expect(r.fix).toBeUndefined()
    expect(r.note).not.toContain('見つかりません')
    expect(r.note).not.toContain('作り直せます')
  })

  it('読めたうえで記録の名前が無ければ、従来どおり ng と作り直しのボタン', async () => {
    const r = await registryPreflightRow(fake(ok({ CommonServiceItems: [item('other')] })).client, 'is1a', 'myapp')
    expect(r).toMatchObject({ status: 'ng', fix: 'reset-registry' })
    expect(r.note).toContain('『myapp』が見つかりません')
  })

  it('読めて記録の名前があれば ok', async () => {
    const r = await registryPreflightRow(fake(ok({ CommonServiceItems: [item('myapp')] })).client, 'is1a', 'myapp')
    expect(r).toMatchObject({ status: 'ok', note: '『myapp』が使えます。' })
    expect(r.fix).toBeUndefined()
  })

  it('記録が無ければ、一覧が読めなくても ok（公開のときに用意する）', async () => {
    const r = await registryPreflightRow(fake(ok({})).client, 'is1a', undefined)
    expect(r).toMatchObject({ status: 'ok', note: '公開のときに用意します。' })
  })

  it('一覧が失敗（HTTP 503）・例外のときは warn で確認できませんでした', async () => {
    const a = await registryPreflightRow(fake({ dryRun: false, ok: false, status: 503, data: null }).client, 'is1a', 'myapp')
    expect(a).toMatchObject({ status: 'warn', note: '確認できませんでした（公開はできます）。' })
    const b = await registryPreflightRow({ listContainerRegistries: async () => { throw new Error('x') } } as any, 'is1a', 'myapp')
    expect(b.status).toBe('warn')
    // 原文を捨てない: 日本語の文のまま、最後の行に詳細が残る
    expect(b.note).toMatch(/^確認できませんでした（公開はできます）。\n詳細: x$/)
  })
})

describe('配線（cloud:preflight と cloud:inventory は、一覧を読めなかった回を「0件」と読まない）', () => {
  const ipc = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')
  it('preflight は registryPreflightRow を通り、pickContainerRegistries を直接使わない', () => {
    const at = ipc.indexOf("ipcMain.handle('cloud:preflight'")
    const body = ipc.slice(at, ipc.indexOf('ipcMain.handle', at + 10))
    expect(body).toContain('await registryPreflightRow(client, spec.region, state.meta?.registryName)')
    expect(body).not.toContain('pickContainerRegistries(')
  })
  it('棚卸しは readContainerRegistryList を通り、読めなければ failed に積む', () => {
    const at = ipc.indexOf("ipcMain.handle('cloud:inventory'")
    const body = ipc.slice(at, ipc.indexOf('ipcMain.handle', at + 10))
    expect(body).toContain('const regs = readContainerRegistryList(r.data)')
    expect(body).toContain("if (regs === null) failed.push('コンテナレジストリ')")
    expect(body).not.toContain('pickContainerRegistries(')
  })
})
