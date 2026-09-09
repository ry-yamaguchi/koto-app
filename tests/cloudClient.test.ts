import { describe, it, expect } from 'vitest'
import { apiErrorMessage, buildPatchBody, buildCreateBody } from '../src/main/cloud/client'
import { defaultSpec } from '../src/main/cloud/spec'

// apiErrorMessage: さくらのクラウドAPIのエラー応答から人間可読なメッセージを取り出す（ユーザー指摘 2026-07-12・
// AppRunアプリ作成上限のエラーで、ネストした error.errors[0] を拾えず生JSONが画面に出てしまっていた）。
describe('apiErrorMessage', () => {
  it('extracts the nested error.errors[0].message, appending a differing reason in parens (real-world example)', () => {
    const data = {
      error: {
        code: 400,
        message: 'Validation Error',
        errors: [{ domain: 'global', reason: 'violates application restriction', message: 'Creation limit reached.', location_type: 'body' }],
      },
    }
    const result = apiErrorMessage(data)
    expect(result).toBe('Creation limit reached.（violates application restriction）')
    // renderer側 isCreationLimitError のパターンマッチが依存する文言をそのまま含んでいること
    expect(result).toContain('Creation limit reached')
  })

  it('does not duplicate the reason in parens when it is identical to the message', () => {
    const data = { error: { errors: [{ reason: 'Creation limit reached.', message: 'Creation limit reached.' }] } }
    expect(apiErrorMessage(data)).toBe('Creation limit reached.')
  })

  it('falls back to error.message when errors[] is absent or empty', () => {
    expect(apiErrorMessage({ error: { message: 'Validation Error' } })).toBe('Validation Error')
    expect(apiErrorMessage({ error: { message: 'Validation Error', errors: [] } })).toBe('Validation Error')
  })

  it('falls back to top-level message/error_msg/error_code when there is no nested error object', () => {
    expect(apiErrorMessage({ message: 'Some top-level error' })).toBe('Some top-level error')
    expect(apiErrorMessage({ error_msg: '認証エラー', error_code: 'auth_failed' })).toBe('auth_failed: 認証エラー')
  })

  it('falls back to JSON.stringify as a last resort when nothing recognizable is present', () => {
    const data = { foo: 'bar' }
    expect(apiErrorMessage(data)).toBe(JSON.stringify(data))
  })

  it('returns a sliced string as-is for a plain string response', () => {
    expect(apiErrorMessage('plain text error')).toBe('plain text error')
  })

  it('returns an empty string for null/undefined', () => {
    expect(apiErrorMessage(null)).toBe('')
    expect(apiErrorMessage(undefined)).toBe('')
  })
})

// ── buildPatchBody: min_scale を送る／max_scale は送らない ──────────────────
//
// #31 の検分（2026-09-09）で見つかった【高】: buildPatchBody は components と
// all_traffic_available しか送っておらず、③公開で「常時動かす」を選んで再デプロイしても
// 実物のアプリの min_scale は変わらないまま、画面は「課金されません」と言い切っていた。
// 原本 `PATCH /applications/{id}`（apprun-shared.json v1.5.0）は min_scale・max_scale
// ともに任意（送れる）。ここでは **min_scale だけ**を足す——max_scale まで送ると、
// 利用者がコントロールパネルで広げた上限を Koto の再デプロイが黙って戻してしまうため、
// roadmap #31 が選ばせている範囲（min だけ）を超えて送らない。
describe('buildPatchBody: min_scale を送る（roadmap #31・2026-09-09 検分で修理）', () => {
  const spec = defaultSpec({ name: 'sample-app', port: 3000 })

  it('戻り値のキーに min_scale が入っている', () => {
    const body = buildPatchBody({ ...spec, service: { ...spec.service, scale: { min: 1, max: 4 } } })
    expect(body).toHaveProperty('min_scale')
  })

  it('★ max_scale は入っていない（範囲までは広げない）', () => {
    const body = buildPatchBody({ ...spec, service: { ...spec.service, scale: { min: 1, max: 4 } } }) as any
    expect(body.max_scale).toBeUndefined()
    expect('max_scale' in body).toBe(false)
    // 送るキーを書き下す（新しいキーが増えても・減っても気づけるように・掟10）
    expect(Object.keys(body).sort()).toEqual(['all_traffic_available', 'components', 'min_scale'].sort())
  })

  it('★ 値は spec.service.scale.min のとおり（0・1・5 いずれも）', () => {
    for (const min of [0, 1, 5]) {
      const body = buildPatchBody({ ...spec, service: { ...spec.service, scale: { min, max: Math.max(min, 1) } } })
      expect(body.min_scale).toBe(min)
    }
  })

  it('components・all_traffic_available は従来どおり（後退していない）', () => {
    const body = buildPatchBody(spec)
    expect(Array.isArray(body.components)).toBe(true)
    expect(body.all_traffic_available).toBe(true)
  })

  // create（新規作成）は従来どおり両方送る。patch だけを直したはずが create まで
  // 巻き込んでいないかを確かめる（2026-08-14 の教訓「create を確かめたら update も確かめる」の逆）。
  it('buildCreateBody は従来どおり min_scale・max_scale の両方を送る', () => {
    const created = buildCreateBody({ ...spec, service: { ...spec.service, scale: { min: 1, max: 4 } } })
    expect(created.min_scale).toBe(1)
    expect(created.max_scale).toBe(4)
  })
})
