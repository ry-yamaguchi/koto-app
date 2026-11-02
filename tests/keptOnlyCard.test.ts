import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 子のパネルは本題ではないので空の部品に差し替える（公開ダイアログの結果カードだけを描く。tests/opWord.test.ts と同じ）。
vi.mock('../src/renderer/components/StorageNotice', () => ({ default: () => null }))
vi.mock('../src/renderer/components/SecurityCheckSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/UnusedFilesSection', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AppRunPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/HanamiiPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/VercelPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/VpsPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/components/AppRunDedicatedPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/publishRootRenderer', () => ({ resolvePublishRoot: async () => '' }))

import { OpFinishedCard, opHeadlineSubject } from '../src/renderer/components/PublishModal'
import * as ops from '../src/main/projectOps'
import type { OpTarget } from '../src/main/projectOps'

// ── 【公開】の結果カード: 何も消さなかった記録（keptOnly）の見出しは、終わったと言わない「⚠️ ${what}はしていません」 ─────────────────────
// 見出しだけが変わる。黄色の枠・月額の警告・「に終わりました」の行は、警告つきの済んだ回と同じ。印が無い同じ記録（doneWithWarnings）の見出しは変わらない。
// 記録は本物の main（projectOps.ts の finishOp → summarizeResult）で作る。

const DIR = '/tmp/koto-kept-only-card'
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)
const text = (s: string) => s.replace(/<[^>]*>/g, '')
beforeEach(() => { ops.resetProjectOpsForTests() })

function finished(target: OpTarget, handler: string, value: Record<string, unknown>) {
  ops.resetProjectOpsForTests()
  ops.beginOp(DIR, '削除', { target, handler })
  ops.finishOp(DIR, { value })
  return ops.getOps(DIR).last!
}

const KEPT = { ok: true, keptBucketName: 'koto-data-bucket', keptBucketNames: ['koto-data-bucket'], keptBucketsUsedByOthers: ['koto-data-bucket'], executed: ['保存場所『koto-data-bucket』のデータは残しました'] }
/** カードの見出し（いちばん上の太字の段落）。 */
const headlineOf = (raw: string): string => text(raw.match(/<p class="text-sm font-semibold[^>]*>(.*?)<\/p>/)?.[1] ?? '')

describe('OpFinishedCard: keptOnly の記録', () => {
  it.each([
    ['sakura-apprun', 'cloud:teardown', '⚠️ 📦 さくらのAppRunの破棄はしていません'],
    ['sakura-apprun-dedicated', 'apprunDedicated:teardown', '⚠️ 📦 さくらのAppRun（専有型）の削除はしていません'],
  ] as const)('★★★ %s: 見出しは「⚠️ ${what}はしていません」。「終わりました」「確認が必要なことがあります」と言わない。枠は黄色・「に終わりました」の行と月額の警告は残る', (target, handler, expected) => {
    const rec = finished(target, handler, { ...KEPT, keptOnly: true })
    const raw = html(createElement(OpFinishedCard, { rec }))
    expect(headlineOf(raw)).toBe(expected)
    expect(headlineOf(raw)).toBe(`⚠️ ${opHeadlineSubject(rec)}はしていません`) // what は opHeadlineSubject の1つ
    expect(headlineOf(raw)).not.toContain('終わりました')
    expect(headlineOf(raw)).not.toContain('確認が必要')
    expect(text(raw)).not.toMatch(/✅ .*が終わりました/)
    expect(raw).toContain('border-brand-yellow')
    expect(text(raw)).toContain('に終わりました') // 時刻の行（見出しではなく、記録が終わった時刻の行）
    expect(text(raw)).toContain('koto-data-bucket') // 月額の警告（残した保存場所の事実から作る）は削らない
  })

  it.each([
    ['sakura-apprun', 'cloud:teardown'],
    ['sakura-apprun-dedicated', 'apprunDedicated:teardown'],
  ] as const)('★★★ %s: 印が無い同じ記録（警告つきの済んだ回）の見出しは今のまま「…は終わりましたが、確認が必要なことがあります」。黄色の枠', (target, handler) => {
    const plain = finished(target, handler, KEPT)
    const plainRaw = html(createElement(OpFinishedCard, { rec: plain }))
    expect(headlineOf(plainRaw)).toBe(`⚠️ ${opHeadlineSubject(plain)}は終わりましたが、確認が必要なことがあります`)
    expect(plainRaw).toContain('border-brand-yellow')
  })

  it('★★ 何も消していない回の見出しだけが言い分けられる: keptOnly でない成功（✅）・失敗・途中の見出しは変わらない', () => {
    const done = finished('sakura-apprun', 'cloud:teardown', { ok: true, executed: ['アプリを削除'] })
    expect(headlineOf(html(createElement(OpFinishedCard, { rec: done })))).toBe(`✅ ${opHeadlineSubject(done)}が終わりました`)
    const failed = finished('sakura-apprun', 'cloud:teardown', { ok: false, message: '失敗', keptOnly: true })
    expect(headlineOf(html(createElement(OpFinishedCard, { rec: failed })))).toBe(`⚠️ ${opHeadlineSubject(failed)}に失敗しました`)
  })
})
