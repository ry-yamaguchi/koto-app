import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { executeTool, type ToolContext } from '../src/renderer/aiTools'

// 2026-08-27 発見の不具合: aiTools.ts の write_file / edit_file は、保存の実処理が
// ctx.applyFile（App.tsx の applyAiFile）にあるとき、その第3引数（書き込む根＝
// ctx.writeRoot。ふつうは public/）を渡していなかった。IDE のチャットは必ず
// ctx.applyFile の道を通るため、public/ を持つプロジェクトでも常にプロジェクト直下へ
// 書いてしまい、①🕘「元に戻す」が効かない（退避は public/ 前提で記録される）
// ②AI が作ったファイルが公開されない、という実害になっていた。
//
// ここでは「applyFile が呼ばれるときの第3引数（root）が ctx.writeRoot と一致する」
// ことを、実際に executeTool を通して固定する（ソースを読むだけの弱いテストにしない）。
describe('write_file / edit_file: applyFile に writeRoot（公開の根）が渡る', () => {
  const originalWindow = (globalThis as any).window

  beforeEach(() => {
    // node 環境には window が無い。write_file は ctx.applyFile がある限り window に
    // 触れない（バックアップ試行は try/catch で包まれておりReferenceErrorも黙って握り潰される）が、
    // edit_file は「元の内容を読む」ために必ず window.electronAPI.fs.readFileInProject を経由する。
    // 仕様書が挙げた2つの選択肢のうち、こちら（globalThis.window を最小限だけ差し込み、
    // edit_file も実際に最後まで実行させる）を採った——ソースの文字列一致だけで確認する
    // 弱いテストにしないため。
    ;(globalThis as any).window = {
      electronAPI: {
        fs: { readFileInProject: async () => 'before' },
        backup: { snapshotBeforeWrite: async () => ({ ok: false, backedUp: false }) },
      },
    }
  })

  afterEach(() => {
    ;(globalThis as any).window = originalWindow
  })

  it('write_file: applyFile が (rel, content, writeRoot) で呼ばれる', async () => {
    const calls: Array<{ rel: string; content: string; root?: string | null }> = []
    const ctx: ToolContext = {
      writeRoot: '/w/public',
      projectRoot: '/w',
      applyFile: async (rel, content, root) => { calls.push({ rel, content, root }) },
    }
    const result = await executeTool('write_file', JSON.stringify({ path: 'a.txt', content: 'hello' }), ctx)
    expect(result).toContain('保存しました')
    expect(calls).toEqual([{ rel: 'a.txt', content: 'hello', root: '/w/public' }])
  })

  it('edit_file: applyFile が (rel, 置換後の内容, writeRoot) で呼ばれる', async () => {
    const calls: Array<{ rel: string; content: string; root?: string | null }> = []
    const ctx: ToolContext = {
      writeRoot: '/w/public',
      projectRoot: '/w',
      applyFile: async (rel, content, root) => { calls.push({ rel, content, root }) },
    }
    const result = await executeTool(
      'edit_file',
      JSON.stringify({ path: 'a.txt', old_string: 'before', new_string: 'after' }),
      ctx,
    )
    expect(result).toContain('編集しました')
    expect(calls).toEqual([{ rel: 'a.txt', content: 'after', root: '/w/public' }])
  })

  it('writeRoot と projectRoot が同じ（移行前のプロジェクト）でも root は writeRoot の値のまま渡る', async () => {
    const calls: Array<{ root?: string | null }> = []
    const ctx: ToolContext = {
      writeRoot: '/w',
      projectRoot: '/w',
      applyFile: async (_rel, _content, root) => { calls.push({ root }) },
    }
    await executeTool('write_file', JSON.stringify({ path: 'a.txt', content: 'hello' }), ctx)
    expect(calls).toEqual([{ root: '/w' }])
  })
})
