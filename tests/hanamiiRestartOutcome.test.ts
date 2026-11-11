import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { restartOutcomeOf, restartMetaPatchOf } from '../src/renderer/hanamiiRestartOutcome'

// 再起動の結果（main の hanamii:restart の返り値）を、画面の状態にする純関数。
// 確かめられない回に ✅ を出さないこと・設定の保存が済んだ回は写しを更新することを、返り値で固定する。

describe('★★★ restartOutcomeOf: 結果を画面の状態にする', () => {
  it('確かめられない回（unconfirmed）は ✅ も「再起動して設定を反映しました」も出さず、⚠️ の文と detail。写しは更新する', () => {
    const o = restartOutcomeOf({ ok: true, noop: false, unconfirmed: true, message: '⚠️ 再起動の結果を確かめられませんでした。HANAMII の管理画面で状態を確かめてください。', detail: '{"project":{}}' })
    expect(o.ok).toBe(false)
    expect(o.message).toBe('⚠️ 再起動の結果を確かめられませんでした。HANAMII の管理画面で状態を確かめてください。')
    expect(o.message).not.toContain('✅')
    expect(o.message).not.toContain('再起動して設定を反映しました')
    expect(o.detail).toBe('{"project":{}}')
    expect(o.saveEnvs).toBe(true)
    expect(o.saveHealthCheck).toBe(true)
  })
  it('unconfirmed で message が無くても ⚠️ の文（✅ にしない）', () => {
    const o = restartOutcomeOf({ ok: true, unconfirmed: true })
    expect(o.ok).toBe(false)
    expect(o.message).toBe('⚠️ 再起動の結果を確かめられませんでした。')
  })
  it('noop は「設定に変更がなかったため、再起動は不要でした。」（成功の表示・写しは更新）', () => {
    expect(restartOutcomeOf({ ok: true, noop: true })).toEqual({ ok: true, message: '設定に変更がなかったため、再起動は不要でした。', detail: '', saveEnvs: true, saveHealthCheck: true })
  })
  it('成功は「✅ 再起動して設定を反映しました。」', () => {
    expect(restartOutcomeOf({ ok: true, noop: false })).toEqual({ ok: true, message: '✅ 再起動して設定を反映しました。', detail: '', saveEnvs: true, saveHealthCheck: true })
  })
  it('失敗は main の文と detail のまま。保存が済んだ側（envsSaved・healthCheckSaved）だけ写しを更新する', () => {
    const base = { ok: false, message: '再起動に失敗しました（health_check_failed）: x', detail: 'raw' }
    expect(restartOutcomeOf({ ...base, envsSaved: true, healthCheckSaved: true })).toEqual({ ok: false, message: base.message, detail: 'raw', saveEnvs: true, saveHealthCheck: true })
    // 環境変数は保存できて、ヘルスチェックの保存で止まった回: 環境変数の写しだけ更新する
    expect(restartOutcomeOf({ ...base, envsSaved: true })).toEqual({ ok: false, message: base.message, detail: 'raw', saveEnvs: true, saveHealthCheck: false })
    expect(restartOutcomeOf(base)).toEqual({ ok: false, message: base.message, detail: 'raw', saveEnvs: false, saveHealthCheck: false })
    expect(restartOutcomeOf({ ok: false, envsSaved: false })).toEqual({ ok: false, message: '再起動に失敗しました', detail: '', saveEnvs: false, saveHealthCheck: false })
  })
  it('restartMetaPatchOf: 書く側だけを差分に入れる。どちらも書かないなら null', () => {
    const envs = [{ key: 'A', secret: false }]
    const hc = { enabled: true, path: '/' }
    expect(restartMetaPatchOf({ saveEnvs: true, saveHealthCheck: true }, envs, hc)).toEqual({ envs, healthCheck: hc })
    expect(restartMetaPatchOf({ saveEnvs: true, saveHealthCheck: false }, envs, hc)).toEqual({ envs })
    expect(restartMetaPatchOf({ saveEnvs: false, saveHealthCheck: true }, envs, hc)).toEqual({ healthCheck: hc })
    expect(restartMetaPatchOf({ saveEnvs: false, saveHealthCheck: false }, envs, hc)).toBeNull()
  })
})

describe('★★★ HanamiiPanel は restartOutcomeOf を呼ぶだけ（呼び出しの形ごと固定）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/components/HanamiiPanel.tsx'), 'utf-8')
  it('main の返り値を restartOutcomeOf に通し、結果の表示と写しの更新は out から行う', () => {
    expect(src).toContain("import { restartOutcomeOf, restartMetaPatchOf } from '../hanamiiRestartOutcome'")
    expect(src).toContain('const r = await window.electronAPI.hanamii.restart(projectId, { token, envs: sendEnvs, healthCheck })\n    const out = restartOutcomeOf(r)')
    expect(src).toContain('setRestartOk(out.ok); setRestartMsg(out.message); setRestartMsgDetail(out.detail)')
    expect(src).toContain('const out = restartOutcomeOf(r)\n    const metaPatch = restartMetaPatchOf(out, persistEnvs, { enabled: healthCheck.enabled, path: healthCheck.path })')
    expect(src).toContain('if (metaPatch) await saveHanamiiMeta(metaPatch).catch(() => {})')
    expect(src.split('if (metaPatch) await saveHanamiiMeta(metaPatch)').length - 1).toBe(2)
    // 直す前の形（保存できなかった側まで写しを書き換える）に戻っていない
    expect(src).not.toContain('if (out.saveMeta) await saveHanamiiMeta')
  })
  it('直す前の形（パネルが r.ok・r.unconfirmed を直接読み、成功の文を持つ）に戻っていない', () => {
    expect(src).not.toContain('r.unconfirmed')
    expect(src).not.toContain('再起動して設定を反映しました')
    expect(src).not.toContain('再起動は不要でした')
    expect(src).not.toContain('if (r.ok) await saveHanamiiMeta')
  })
})
