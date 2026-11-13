import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { restartOutcomeOf, restartMetaPatchOf, healthCheckChangedBy, endSentence, HANAMII_RESTART_HEALTH_HINT } from '../src/renderer/hanamiiRestartOutcome'

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

describe('★★★ 再起動の失敗 × ヘルスチェックを変えた回: 公開（更新）への案内を1行足す', () => {
  const fail = { ok: false, message: '再起動に失敗しました（HTTP 400）: x', detail: 'raw', healthCheckSaved: true }
  it('★★★ 失敗かつヘルスチェックを変えた回だけ、文の最後に案内。detail と保存の判断は変わらない', () => {
    const o = restartOutcomeOf(fail, { healthCheckChanged: true })
    expect(o.message).toBe(fail.message + '。' + HANAMII_RESTART_HEALTH_HINT)
    expect(o.message).toContain('「🚀 公開する（更新）」')
    expect(o.detail).toBe('raw')
    expect(o.saveHealthCheck).toBe(true)
  })
  it('★★★ 変えていない回・ctx なしの失敗には足さない', () => {
    expect(restartOutcomeOf(fail, { healthCheckChanged: false }).message).toBe(fail.message)
    expect(restartOutcomeOf(fail).message).toBe(fail.message)
  })
  it('★★★ 成功・noop・確かめられない回には足さない（失敗のときだけ）', () => {
    for (const r of [{ ok: true }, { ok: true, noop: true }, { ok: true, unconfirmed: true }]) {
      expect(restartOutcomeOf(r, { healthCheckChanged: true }).message).not.toContain('公開する（更新）')
    }
  })
  it('★★ 文に「詳細: 原文」の行が付いていても、案内は詳細の前（詳細が最後の行のまま）', () => {
    const o = restartOutcomeOf({ ok: false, message: '再起動に失敗しました。\n詳細: raw text' }, { healthCheckChanged: true })
    expect(o.message).toBe('再起動に失敗しました。' + HANAMII_RESTART_HEALTH_HINT + '\n詳細: raw text')
  })
  it('★★★ 実機の文（0.6.30-rc.1・2026-11-12）: HANAMII の断りの文は句点なしで来る。案内とのあいだに句点を足し、1つの文に見せない', () => {
    // 実機で出た主の文そのもの。直す前は「…必要ですヘルスチェックの設定を変えたときは、…」と続けて出た。
    const real = '再起動に失敗しました（HTTP 400）: 現在の設定に対応するイメージを生成するため、通常の再デプロイが必要です'
    const o = restartOutcomeOf({ ok: false, message: real, detail: 'raw', healthCheckSaved: true }, { healthCheckChanged: true })
    expect(o.message).toBe('再起動に失敗しました（HTTP 400）: 現在の設定に対応するイメージを生成するため、通常の再デプロイが必要です。ヘルスチェックの設定を変えたときは、「🚀 公開する（更新）」で反映できることがあります。')
    expect(o.message).not.toContain('必要ですヘルスチェック')
    // 文が無いとき（main が文を返さなかった回）の既定の文にも句点が入る
    expect(restartOutcomeOf({ ok: false }, { healthCheckChanged: true }).message).toBe('再起動に失敗しました。' + HANAMII_RESTART_HEALTH_HINT)
    // 変えていない回は、HANAMII の文に手を入れない（句点も足さない）
    expect(restartOutcomeOf({ ok: false, message: real }, { healthCheckChanged: false }).message).toBe(real)
  })
  it('★★ endSentence: 句点・感嘆符・疑問符・ピリオドで終わっていれば足さない。終わりの空白は落とす。空は空のまま', () => {
    expect(endSentence('必要です')).toBe('必要です。')
    expect(endSentence('必要です。')).toBe('必要です。')
    expect(endSentence('必要です。  ')).toBe('必要です。')
    expect(endSentence('（先に公開してください）')).toBe('（先に公開してください）。')
    for (const done of ['できません！', 'failed!', 'ですか？', 'why?', 'redeploy is required.', '終わり．']) expect(endSentence(done)).toBe(done)
    expect(endSentence('')).toBe('')
  })
  it('★★★ HANAMII の断りの文は見ない（文が何であれ、変えたかだけで決まる）', () => {
    for (const m of ['通常の再デプロイが必要です', 'something else', '']) {
      expect(restartOutcomeOf({ ok: false, message: m || undefined }, { healthCheckChanged: true }).message).toContain(HANAMII_RESTART_HEALTH_HINT)
    }
  })
  it('★★★ healthCheckChangedBy: 記録と比べる。無効→有効・有効→無効・パスの変更は「変えた」。同じ・無効どうしは「変えていない」', () => {
    const meta = (hc: unknown) => ({ publish: { hanamii: { healthCheck: hc } } })
    expect(healthCheckChangedBy(meta({ enabled: false, path: '/' }), { enabled: true, path: '/nope' })).toBe(true)
    expect(healthCheckChangedBy(meta({ enabled: true, path: '/a' }), { enabled: false, path: '/a' })).toBe(true)
    expect(healthCheckChangedBy(meta({ enabled: true, path: '/a' }), { enabled: true, path: '/b' })).toBe(true)
    expect(healthCheckChangedBy(meta({ enabled: true, path: '/a' }), { enabled: true, path: '/a' })).toBe(false)
    expect(healthCheckChangedBy(meta({ enabled: false, path: '/a' }), { enabled: false, path: '/zzz' })).toBe(false)
    // 記録が無い・壊れている＝無効（フォームの初期値と同じ）
    for (const m of [undefined, null, {}, 'x', { publish: null }, { publish: { hanamii: {} } }]) {
      expect(healthCheckChangedBy(m, { enabled: false, path: '/' })).toBe(false)
      expect(healthCheckChangedBy(m, { enabled: true, path: '/' })).toBe(true)
    }
  })
})

describe('★★★ HanamiiPanel は restartOutcomeOf を呼ぶだけ（呼び出しの形ごと固定）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/components/HanamiiPanel.tsx'), 'utf-8')
  it('main の返り値を restartOutcomeOf に通し、結果の表示と写しの更新は out から行う', () => {
    expect(src).toContain("import { restartOutcomeOf, restartMetaPatchOf, healthCheckChangedBy } from '../hanamiiRestartOutcome'")
    expect(src).toContain('const r = await window.electronAPI.hanamii.restart(projectId, { token, envs: sendEnvs, healthCheck })\n    const out = restartOutcomeOf(r, { healthCheckChanged: hcChanged })')
    // ヘルスチェックを変えたかは、押した時点のディスクの記録と比べる（restart の呼びの前に1回）
    expect(src.split('const hcChanged = healthCheckChangedBy(await readMeta(), { enabled: healthCheck.enabled, path: healthCheck.path })').length - 1).toBe(1)
    expect(src.indexOf('const hcChanged = ')).toBeLessThan(src.indexOf('await window.electronAPI.hanamii.restart('))
    expect(src).toContain('setRestartOk(out.ok); setRestartMsg(out.message); setRestartMsgDetail(out.detail)')
    expect(src).toContain('const out = restartOutcomeOf(r, { healthCheckChanged: hcChanged })\n    const metaPatch = restartMetaPatchOf(out, persistEnvs, { enabled: healthCheck.enabled, path: healthCheck.path })')
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
