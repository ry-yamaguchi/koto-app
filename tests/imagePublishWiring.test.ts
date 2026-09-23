import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// D-2a: 共用型 cloud:apply の「イメージを組み立ててレジストリへ反映する」段を
// cloud/imagePublish.ts の prepareAppImage に切り出した（専有型の「⑧ アプリを公開する」
// からも同じ関数を呼ぶ・複製しない・掟10）。
//
// **型が通ることは、繋がっている証拠にならない。** ここでは ipc/cloud.ts のソースを読んで、
// ①本体を呼んでいること ②ビルド／pushの実装呼び出しが ipc/cloud.ts に舞い戻っていないこと
// （＝また複製されていないこと）を固定する。掟10の教訓どおり、当て先が「関数の定義」や
// 他の行にも当たらないよう、呼び出し先は ipc/cloud.ts（呼び出し側）だけを見る。

const IPC = path.join(__dirname, '..', 'src', 'main', 'ipc', 'cloud.ts')

/** ソース中に部分文字列が現れる回数を数える（オーバーラップなし）。 */
function countOccurrences(source: string, needle: string): number {
  let count = 0
  let i = 0
  while (true) {
    const found = source.indexOf(needle, i)
    if (found === -1) break
    count++
    i = found + needle.length
  }
  return count
}

describe('cloud:apply はイメージの組み立て・pushを prepareAppImage に一元化している', () => {
  const source = fs.readFileSync(IPC, 'utf-8')

  it('切り出しそのものが正しく動く（この検査の土台）', () => {
    expect(countOccurrences('prepareAppImage(x); prepareAppImage(y)', 'prepareAppImage(')).toBe(2)
    expect(countOccurrences('buildImage(a, b)', 'buildImage(')).toBe(1)
    expect(countOccurrences('no match here', 'buildImage(')).toBe(0)
  })

  it('prepareAppImage( の呼び出しが1回だけある', () => {
    expect(countOccurrences(source, 'prepareAppImage(')).toBe(1)
  })

  it('呼び出しが await で結果を受け取っている（戻り値を無視していない）', () => {
    expect(source).toContain('await prepareAppImage(')
  })

  // 一元化の固定: ビルド／push の直接呼び出しが ipc/cloud.ts に戻っていないこと。
  // （プロジェクト全体には cloud/imagePublish.ts の定義・呼び出しが残るのは正しい。
  //   ここは呼び出し側の ipc/cloud.ts だけを対象にする。）
  for (const fn of ['buildAndPush(', 'buildImage(', 'pushImage(', 'loginRegistry(', 'tagForPublish(']) {
    it(`${fn} が ipc/cloud.ts に残っていない`, () => {
      expect(source).not.toContain(fn)
    })
  }
})

describe('cloud 層は ipc 層を import しない（循環 import を作らない・2026-09-12 に一度作りかけた）', () => {
  it("imagePublish.ts / specStore.ts / buildContext.ts に \"from '../ipc/\" が無い", () => {
    for (const f of ['imagePublish.ts', 'specStore.ts', 'buildContext.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'cloud', f), 'utf-8')
      expect(src).not.toContain("from '../ipc/")
    }
  })
})

describe('cloud:apply は prepareAppImage の失敗で止まる（失敗を無視して AppRun へ進まない・2026-09-12 の変異 (d) で素通りしたため固定）', () => {
  it("'if (!prepared.ok) return prepared' がある", () => {
    const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc', 'cloud.ts'), 'utf-8')
    expect(ipcSrc).toContain('if (!prepared.ok) return prepared')
  })
})

// ── E（D-7b・検分の指摘）: Docker 分岐は runtimeKind を 'docker' にする ──────────────────
//
// prepareAppImage は runtimeKind を 'static' で初期化するが、Docker 分岐（builderMode ===
// 'docker'）では再代入していなかった。そのため利用者の Dockerfile で作った像（版の目印
// `.koto-build` を持たない）でも canVerify が true になり、目印が 404 → 「⚠️ まだ古い内容が
// 表示されています」と誤報する余地があった。共用型（cloud:apply）・専有型（⑧）とも同じ
// prepareAppImage を呼ぶため、この一元化した関数を直せば両方に効く（掟10）。

describe('E: Docker 分岐（builderMode === \'docker\'）は runtimeKind を \'docker\' に再代入する', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'cloud', 'imagePublish.ts'), 'utf-8')

  it("★★ Docker 分岐のブロック内に \"runtimeKind = 'docker'\" がある（'static' のまま返さない）", () => {
    const at = src.indexOf("if (builderMode === 'docker') {")
    expect(at).toBeGreaterThan(0)
    const end = src.indexOf('} else {', at)
    expect(end).toBeGreaterThan(at)
    const block = src.slice(at, end)
    expect(block).toContain("runtimeKind = 'docker'")
  })

  it('★ canVerify(\'docker\', url) は false（版の目印を持たない Docker 経路は確認をとばす）。対照に canVerify(\'static\', url) は true', async () => {
    const { canVerify } = await import('../src/shared/publishVerify')
    expect(canVerify('docker', 'https://example.com')).toBe(false)
    expect(canVerify('static', 'https://example.com')).toBe(true)
  })
})

