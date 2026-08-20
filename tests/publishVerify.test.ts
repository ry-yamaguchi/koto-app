import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MARKER_FILE, markerContent, matchesMarker, markerUrl, canVerify, verifyDelaysMs, verifyMessage,
} from '../src/shared/publishVerify'
import { tagOfRef } from '../src/main/cloud/imageBuild'

// ── 2026-08-19 実機（Ryosuke 報告と提案）────────────────────────────
// 「試すだと画像が表示されるが、公開すると画像が表示されていない」
// 公開は「✅ 完了しました」と出ていたのに、配られていたのは**画像を入れる前の
// 古いページ**だった。**誰も確かめていなかったこと自体**が本当の問題。
//   ・デプロイのAPIが 200 … 反映された証拠にならない
//   ・アプリが起動した   … 中身が新しい証拠にならない
// 配る中身に版の目印を混ぜ、公開のあとに読みに行く。

describe('版の目印', () => {
  it('★ 中身は版の名前だけ', () => {
    expect(markerContent('v20260819-182300')).toBe('v20260819-182300\n')
  })

  it('★★ 前後の空白や改行があっても一致と見る', () => {
    expect(matchesMarker('v20260819-182300\n', 'v20260819-182300')).toBe(true)
    expect(matchesMarker('  v20260819-182300  ', 'v20260819-182300')).toBe(true)
  })

  it('★★ 違う版は一致にしない（ここが緩むと確認の意味が消える）', () => {
    expect(matchesMarker('v20260819-182300', 'v20260819-190000')).toBe(false)
    expect(matchesMarker('', 'v20260819-182300')).toBe(false)
    expect(matchesMarker(null, 'v20260819-182300')).toBe(false)
    // 版が空なら、何が返ってきても一致にしない
    expect(matchesMarker('', '')).toBe(false)
  })

  it('★ 読みに行く先は公開URLの直下（重ね書きの / を作らない）', () => {
    expect(markerUrl('https://example.com')).toBe(`https://example.com/${MARKER_FILE}`)
    expect(markerUrl('https://example.com/')).toBe(`https://example.com/${MARKER_FILE}`)
  })
})

describe('確認できる公開かどうか', () => {
  it('★★ 静的配信のときだけ確かめる', () => {
    expect(canVerify('static', 'https://x.example.com')).toBe(true)
    // Node のアプリは自分で経路を決めるので、目印が読めるとは限らない。
    // **読めないことを失敗と呼ばない**ため、はじめから対象にしない
    expect(canVerify('node', 'https://x.example.com')).toBe(false)
  })

  it('★ URLが無ければ確かめない', () => {
    expect(canVerify('static', null)).toBe(false)
    expect(canVerify('static', 'not-a-url')).toBe(false)
  })
})

describe('待ち方', () => {
  it('★ 短く諦めない（合計60秒以上）／待たせすぎない（3分以内）', () => {
    const total = verifyDelaysMs().reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThanOrEqual(60000)
    expect(total).toBeLessThanOrEqual(180000)
  })

  it('★ だんだん間隔を空ける（最初は素早く確かめる）', () => {
    const d = verifyDelaysMs()
    expect(d[0]).toBeLessThanOrEqual(3000)
    expect(d[d.length - 1]).toBeGreaterThanOrEqual(d[0])
  })
})

describe('画面に出す言葉', () => {
  it('★★ 古いままなら、そう言う（黙って成功に見せない）', () => {
    const m = verifyMessage('stale')
    expect(m).toContain('まだ古い内容')
    expect(m).toContain('公開')
  })

  it('★ 確認できたら、はっきり伝える', () => {
    expect(verifyMessage('ok')).toContain('確認しました')
  })

  it('★★ 確認できなかっただけのときは、失敗と混ぜない', () => {
    const m = verifyMessage('unreachable')
    expect(m).toContain('公開そのものは完了しています')
  })
})

describe('目印に書く版の名前', () => {
  it('★ イメージ参照からタグを取り出す', () => {
    expect(tagOfRef('example.sakuracr.jp/landingtest:v20260819-182300')).toBe('v20260819-182300')
  })

  it('★★ ポート付きのサーバでも間違えない', () => {
    expect(tagOfRef('registry.local:5000/app:v1')).toBe('v1')
    // タグが無い形（最後の : がサーバのポート）は空にする
    expect(tagOfRef('registry.local:5000/app')).toBe('')
  })
})

// 掟10「一元化したことと、全経路が実際にそこを通っていることは別」。
describe('公開の経路が、実際に確認を通っている', () => {
  const cloud = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')
  const build = readFileSync(join(__dirname, '..', 'src/main/cloud/imageBuild.ts'), 'utf-8')

  it('★★ 配る中身に目印を混ぜている', () => {
    expect(build).toContain('markerContent(opts.buildTag)')
    expect(build).toContain('buildTag: tagOfRef(opts.ref)')
  })

  it('★★ 起動を確認したあとに、中身も確かめる', () => {
    expect(cloud).toContain('verified = await verifyPublished(')
    expect(cloud).toContain('canVerify(runtimeKind, publicUrl)')
  })

  it('★★ 確認できたときだけ一言を返す（無言を失敗と混ぜない）', () => {
    expect(cloud).toContain('const verifyNote = verified ? verifyMessage(verified) : \'\'')
  })

  it('★ キャッシュに騙されない問い合わせにする', () => {
    const at = cloud.indexOf('async function verifyPublished')
    const block = cloud.slice(at, at + 1400)
    expect(block).toContain('?t=${Date.now()}')
    expect(block).toContain("cache: 'no-store'")
  })
})

// 目印そのものが公開から外れていたら、確認は永久に成立しない（掟10）
describe('目印は公開物から外されない', () => {
  it('★★ 秘密ファイル扱いにならない', async () => {
    const { isSecretFile, excludedFileNames } = await import('../src/shared/publishExclude')
    expect(isSecretFile(MARKER_FILE)).toBe(false)
    expect(excludedFileNames().has(MARKER_FILE)).toBe(false)
  })
})
