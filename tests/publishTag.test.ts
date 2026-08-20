import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishTag, shouldReplaceTag, tagForPublish, DEFAULT_TAG } from '../src/shared/publishTag'
import { validateTag, buildRef } from '../src/main/cloud/docker'

// ── 2026-08-19 実機（Ryosuke 報告）──────────────────────────────────
// 「試すだと画像が表示されるが、公開すると画像が表示されていない」
//
// 実測（公開先のURLを直接叩いた）:
//   ・トップページ 200 だが **4,841 バイト**（手元は 5,168 バイト）
//   ・配信中の HTML に画像の参照が**1つも無い**（＝画像を入れる前の古い版）
//   ・`images/` は **404**
//   ・tar の往復・python の配信は手元で再現して**正常**（配り方の問題ではない）
//
// 原因は、公開のたびに**同じ参照**（`…:latest`）を渡していたこと。中身が
// 変わっても名前が同じなので、新しいイメージが使われない。

describe('公開のたびに違うタグ', () => {
  it('★★ 時刻から、並べれば順番が分かる名前を作る', () => {
    expect(publishTag(new Date(2026, 7, 19, 18, 23, 0))).toBe('v20260819-182300')
    expect(publishTag(new Date(2026, 0, 2, 3, 4, 5))).toBe('v20260102-030405')
  })

  it('★★ 1秒違えば別の名前になる（同じ名前を渡さない）', () => {
    const a = publishTag(new Date(2026, 7, 19, 18, 23, 0))
    const b = publishTag(new Date(2026, 7, 19, 18, 23, 1))
    expect(a).not.toBe(b)
  })

  it('★★ レジストリが受け付ける形になっている', () => {
    // docker.ts の検証を通ること（通らないと公開そのものが失敗する）
    expect(() => validateTag(publishTag(new Date()))).not.toThrow()
    expect(buildRef('example.sakuracr.jp', 'landingtest', publishTag(new Date())))
      .toMatch(/^example\.sakuracr\.jp\/landingtest:v\d{8}-\d{6}$/)
  })
})

describe('どのタグを使うか', () => {
  it('★★ 既定（latest）のままなら置き換える', () => {
    expect(shouldReplaceTag(DEFAULT_TAG)).toBe(true)
    expect(shouldReplaceTag('')).toBe(true)
    expect(shouldReplaceTag(null)).toBe(true)
    expect(tagForPublish('latest', new Date(2026, 7, 19, 18, 23, 0))).toBe('v20260819-182300')
  })

  it('★ 利用者がわざわざ決めたタグは尊重する（エキスパートの固定を壊さない）', () => {
    expect(shouldReplaceTag('v1.2.3')).toBe(false)
    expect(tagForPublish('v1.2.3', new Date())).toBe('v1.2.3')
  })
})

// 掟10「一元化したことと、全経路が実際にそこを通っていることは別」。
describe('公開の経路が、実際にこれを通っている', () => {
  const cloud = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')

  it('★★ 参照はここで決めたタグで組み立てる', () => {
    expect(cloud).toContain('const publishRefTag = tagForPublish(source.tag, new Date())')
    expect(cloud).toContain('buildRef(server, source.image, publishRefTag)')
  })

  it('★★ env.json のタグを直接使っていない（同じ名前を渡さない）', () => {
    expect(cloud).not.toContain('buildRef(server, source.image, source.tag)')
  })
})
