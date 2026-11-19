import { describe, it, expect } from 'vitest'
import { runOsvFlow, type OsvFlowPorts } from '../src/renderer/osvCheck'
import { OSV_CONFIRM_TITLE, OSV_CONFIRM_OK, OSV_CONFIRM_CANCEL, osvConfirmBody } from '../src/renderer/osvCheckWords'
import { splitFailureDetail } from '../src/shared/failureDetail'
import type { OsvCheckReply, OsvPreview } from '../src/shared/osvTypes'

const NO_SKIP = { dev: 0, notPublic: 0, badShape: 0 }
const PREVIEW_OK: OsvPreview = { state: 'ok', sendCount: 7, total: 9, examples: ['lodash 4.17.21', 'react 18.2.0', 'vue 3.0.0'], skipped: { dev: 99, notPublic: 0, badShape: 0 }, manifest: 'match' }
const CHECK_OK: OsvCheckReply = { state: 'done', result: { kind: 'done', total: 7, sent: 7, checked: 7, findings: [], withdrawn: 0, stop: null }, skipped: NO_SKIP, manifest: 'match' }

function makePorts(over: Partial<{ preview: OsvPreview; consent: boolean; confirm: boolean; check: OsvCheckReply }> = {}) {
  const calls: string[] = []
  const args: { check: unknown[][]; confirm: unknown[] } = { check: [], confirm: [] }
  const ports: OsvFlowPorts = {
    preview: async () => { calls.push('preview'); return over.preview ?? PREVIEW_OK },
    check: async (dir, consented) => { calls.push('check'); args.check.push([dir, consented]); return over.check ?? CHECK_OK },
    hasConsent: () => { calls.push('hasConsent'); return over.consent ?? false },
    recordConsent: () => { calls.push('record') },
    confirm: async (o) => { calls.push('confirm'); args.confirm.push(o); return over.confirm ?? true },
  }
  return { ports, calls, args }
}

describe('同意の流れ', () => {
  it('未同意で「やめる」なら、通信する口を呼ばず・同意も記録しない', async () => {
    const t = makePorts({ consent: false, confirm: false })
    expect(await runOsvFlow(t.ports, '/p')).toEqual({ kind: 'cancelled' })
    expect(t.calls).not.toContain('check')
    expect(t.calls).not.toContain('record')
  })

  it('同意済みなら確認を出さず、check を (projectDir, true) で1回', async () => {
    const t = makePorts({ consent: true })
    const out = await runOsvFlow(t.ports, '/p')
    expect(t.calls).not.toContain('confirm')
    expect(t.args.check).toEqual([['/p', true]])
    expect(out.kind).toBe('view')
  })

  it('未同意で「送って調べる」なら、記録してから check（この順）。確認の引数は完全に同じ', async () => {
    const t = makePorts({ consent: false, confirm: true })
    const out = await runOsvFlow(t.ports, '/p')
    expect(t.calls).toEqual(['preview', 'hasConsent', 'confirm', 'record', 'check'])
    expect(t.args.confirm).toEqual([{
      title: OSV_CONFIRM_TITLE,
      body: osvConfirmBody(7, ['lodash 4.17.21', 'react 18.2.0', 'vue 3.0.0']),
      confirmLabel: OSV_CONFIRM_OK,
      cancelLabel: OSV_CONFIRM_CANCEL,
      danger: false,
      initialFocus: 'cancel',
    }])
    expect((t.args.confirm[0] as { body: string }).body).toContain('ライブラリ7件の')
    expect(t.args.check).toEqual([['/p', true]])
    expect(out).toMatchObject({ kind: 'view', view: { verdict: 'ok' } })
  })

  it('記録が何もしなくても（保存できなくても）check は呼ばれる', async () => {
    const t = makePorts({ consent: false, confirm: true })
    t.ports.recordConsent = () => { t.calls.push('record') }
    await runOsvFlow(t.ports, '/p')
    expect(t.args.check).toHaveLength(1)
  })

  it('同意は preview のあとに読む', async () => {
    const t = makePorts({ consent: true })
    await runOsvFlow(t.ports, '/p')
    expect(t.calls).toEqual(['preview', 'hasConsent', 'check'])
  })
})

describe('下調べで言い切れる回', () => {
  it('ok 以外・sendCount 0 は、確認も check も出さず、その場の画面', async () => {
    for (const preview of [
      { state: 'no-lockfile' } as OsvPreview,
      { state: 'ok', sendCount: 0, total: 2, examples: [], skipped: { dev: 2, notPublic: 0, badShape: 0 }, manifest: 'match' } as OsvPreview,
    ]) {
      const t = makePorts({ preview })
      const out = await runOsvFlow(t.ports, '/p')
      expect(t.calls).toEqual(['preview'])
      expect(out.kind).toBe('view')
    }
  })
})

describe('例外', () => {
  const offline = () => Object.assign(new Error('getaddrinfo ENOTFOUND osv.dev'), { code: 'ENOTFOUND' })

  it('preview が投げたら skip の画面。英語の文を文として出さず、原文は詳細へ', async () => {
    const t = makePorts()
    t.ports.preview = async () => { throw offline() }
    const out = await runOsvFlow(t.ports, '/p')
    expect(out.kind).toBe('view')
    if (out.kind !== 'view') return
    expect(out.view.verdict).toBe('skip')
    const line = out.view.lines[0]
    expect(line.kind).toBe('failure')
    const { text, detail } = splitFailureDetail(line.text)
    expect(text).not.toContain('getaddrinfo')
    expect(detail).toContain('ENOTFOUND')
  })

  it('check が投げても同じ', async () => {
    const t = makePorts({ consent: true })
    t.ports.check = async () => { throw offline() }
    const out = await runOsvFlow(t.ports, '/p')
    expect(out.kind).toBe('view')
    if (out.kind !== 'view') return
    expect(out.view.verdict).toBe('skip')
    const { text, detail } = splitFailureDetail(out.view.lines[0].text)
    expect(text).not.toContain('getaddrinfo')
    expect(detail).toContain('ENOTFOUND')
  })
})
