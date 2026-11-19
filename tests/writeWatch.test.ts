import { describe, it, expect } from 'vitest'
import { createWriteWatch } from '../src/shared/writeWatch'

// 見本のキーは、リポジトリの秘密検出に当たらないよう連結で組み立てる（実在しない値）。
const GH_BODY = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const GH = 'gh' + 'p_' + GH_BODY
const WITH_KEY = `const t = "${GH}"\n`

function makeWatch(files: Record<string, string | null>, extra: { maxFiles?: number; maxChars?: number; root?: string } = {}) {
  const reads: string[] = []
  const watch = createWriteWatch({
    displayRoot: extra.root ?? '/proj',
    read: async (p) => { reads.push(p); return p in files ? files[p] : null },
    maxFiles: extra.maxFiles,
    maxChars: extra.maxChars,
  })
  return { watch, reads }
}

describe('createWriteWatch', () => {
  it('キーを新しく書いたファイルは、相対パスと行つきで1つの知らせになる。値は text にも marks にも入らない', async () => {
    const { watch } = makeWatch({ '/proj/src/a.js': `x\n${WITH_KEY}` })
    watch.touch('/proj/src/a.js', 'x\n')
    const n = await watch.finish()
    expect(n).not.toBeNull()
    expect(n!.text).toContain('src/a.js')
    expect(n!.text).toContain('2行目')
    expect(n!.marks).toEqual([{ file: 'src/a.js', kind: 'known-key', line: 2 }])
    expect(JSON.stringify(n)).not.toContain(GH_BODY)
    expect(JSON.stringify(n)).not.toContain(GH)
  })

  it('touch は、そのパスを初めて渡されたときの before だけを覚える（2回目は上書きしない）', async () => {
    // 1回目の before にはキーの行がある（前からある行は出さない）。2回目の before（キーなし）で上書きすると出てしまう。
    const { watch } = makeWatch({ '/proj/a.js': WITH_KEY })
    watch.touch('/proj/a.js', WITH_KEY)
    watch.touch('/proj/a.js', '')
    expect(await watch.finish()).toBeNull()
  })

  it('finish は「いまの内容」で比べる。ターンの途中で AI が直した分は出ない', async () => {
    const { watch } = makeWatch({ '/proj/a.js': 'const t = process.env.TOKEN\n' })
    watch.touch('/proj/a.js', null)
    expect(await watch.finish()).toBeNull()
  })

  it('読めないファイルは何も言わずに飛ばす（ほかのファイルの知らせは出る）', async () => {
    const { watch } = makeWatch({ '/proj/gone.js': null, '/proj/b.js': WITH_KEY })
    watch.touch('/proj/gone.js', null)
    watch.touch('/proj/b.js', null)
    const n = await watch.finish()
    expect(n!.marks.map(m => m.file)).toEqual(['b.js'])
  })

  it('読めないファイルだけなら null（「問題なし」とは言わない）', async () => {
    const { watch } = makeWatch({})
    watch.touch('/proj/gone.js', null)
    expect(await watch.finish()).toBeNull()
  })

  it('大きすぎるファイルは見ない', async () => {
    const { watch } = makeWatch({ '/proj/big.js': WITH_KEY }, { maxChars: 10 })
    watch.touch('/proj/big.js', null)
    expect(await watch.finish()).toBeNull()
  })

  it('read が投げても finish は投げず、そのファイルを飛ばす', async () => {
    const watch = createWriteWatch({
      displayRoot: '/proj',
      read: async (p) => { if (p.endsWith('bad.js')) throw new Error('boom'); return WITH_KEY },
    })
    watch.touch('/proj/bad.js', null)
    watch.touch('/proj/ok.js', null)
    const n = await watch.finish()
    expect(n!.marks.map(m => m.file)).toEqual(['ok.js'])
  })

  it('0 件は null', async () => {
    const { watch } = makeWatch({ '/proj/a.js': 'const a = 1\n' })
    watch.touch('/proj/a.js', null)
    expect(await watch.finish()).toBeNull()
  })

  it('何も touch していなければ null で、読みにも行かない', async () => {
    const { watch, reads } = makeWatch({ '/proj/a.js': WITH_KEY })
    expect(await watch.finish()).toBeNull()
    expect(reads).toEqual([])
  })

  it('displayRoot の外のファイルは、名前だけを表示する', async () => {
    const { watch } = makeWatch({ '/elsewhere/deep/c.js': WITH_KEY })
    watch.touch('/elsewhere/deep/c.js', null)
    const n = await watch.finish()
    expect(n!.marks[0].file).toBe('c.js')
  })

  it('displayRoot の末尾が / でも、相対パスは同じ', async () => {
    const { watch } = makeWatch({ '/proj/a/b.js': WITH_KEY }, { root: '/proj/' })
    watch.touch('/proj/a/b.js', null)
    expect((await watch.finish())!.marks[0].file).toBe('a/b.js')
  })

  it('finish のあとは空に戻る（同じ集め役で、次の finish は null・読みにも行かない）', async () => {
    const { watch, reads } = makeWatch({ '/proj/a.js': WITH_KEY })
    watch.touch('/proj/a.js', null)
    expect(await watch.finish()).not.toBeNull()
    const before = reads.length
    expect(await watch.finish()).toBeNull()
    expect(reads.length).toBe(before)
  })

  it('maxFiles を超えた分は覚えない', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 5; i++) files[`/proj/f${i}.js`] = WITH_KEY
    const { watch, reads } = makeWatch(files, { maxFiles: 2 })
    for (let i = 0; i < 5; i++) watch.touch(`/proj/f${i}.js`, null)
    await watch.finish()
    expect(reads.sort()).toEqual(['/proj/f0.js', '/proj/f1.js'])
  })

  it('同じ中身を次のターン（新しい集め役・before に同じ行）で書いても、知らせは出ない', async () => {
    const { watch } = makeWatch({ '/proj/a.js': WITH_KEY })
    watch.touch('/proj/a.js', WITH_KEY)
    expect(await watch.finish()).toBeNull()
  })
})
