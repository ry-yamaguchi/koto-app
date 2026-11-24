import { describe, it, expect, afterEach } from 'vitest'
import { buildProjectContext } from '../src/renderer/aiContext'
import { splitFilesByRoot, rootRelOf } from '../src/shared/publishRoot'
import { publicPrefixHint } from '../src/shared/readPathHint'
import { executeToolCore, type ToolIo } from '../src/shared/toolExecCore'

// P-131: AI に渡す「場所」の書き方を、ツールの実際の根（作業フォルダ）にそろえる。
// 0.6.38-rc.1 の実機で、一覧がプロジェクト直下のパスだったため GLM が public/a.js と付けて失敗した。

afterEach(() => { delete (globalThis as any).window })

const setup = (files: string[], hasPublic: boolean) => {
  ;(globalThis as any).window = {
    electronAPI: {
      fs: {
        readFile: async () => JSON.stringify({ name: 'proj' }),
        projectFiles: async () => files,
        exists: async (p: string) => hasPublic && p === '/p/public',
      },
    },
  }
}

describe('buildProjectContext: 作業フォルダの言い方でファイルを並べる', () => {
  it('public/ がある: 中は作業フォルダからの相対（public/ なし）、外は直下からのパスで分けて出る', async () => {
    setup(['public/a.js', 'public/css/s.css', 'README.md', 'Dockerfile'], true)
    const ctx = await buildProjectContext('/p')
    expect(ctx).toContain('作業フォルダ: /p/public\n')
    expect(ctx).toContain('プロジェクト直下: /p\n')
    expect(ctx).not.toContain('ルートパス')
    expect(ctx).toContain('そのまま read_file などに渡せるパス')
    expect(ctx).toContain('- a.js\n- css/s.css')
    expect(ctx).not.toContain('- public/a.js')
    expect(ctx).toContain('作業フォルダの外のファイル（プロジェクト直下からのパス。読み書きできません）:\n- README.md\n- Dockerfile')
  })

  it('public/ が無い（直下が作業フォルダ）: 1つの一覧で、外の見出しも直下の行も出ない', async () => {
    setup(['a.js', 'css/s.css'], false)
    const ctx = await buildProjectContext('/p')
    expect(ctx).toContain('作業フォルダ: /p\n')
    expect(ctx).not.toContain('プロジェクト直下:')
    expect(ctx).not.toContain('作業フォルダの外')
    expect(ctx).toContain('- a.js\n- css/s.css')
  })

  it('public/ があって外のファイルが無いときは外の見出しを出さない', async () => {
    setup(['public/a.js'], true)
    const ctx = await buildProjectContext('/p')
    expect(ctx).toContain('- a.js')
    expect(ctx).not.toContain('作業フォルダの外')
  })

  it('ファイルが1つも無い: 「まだファイルはありません」', async () => {
    setup([], true)
    expect(await buildProjectContext('/p')).toContain('（まだファイルはありません）')
  })
})

describe('splitFilesByRoot / rootRelOf', () => {
  it('rootRel が空なら全部が中', () => {
    expect(splitFilesByRoot(['a', 'b/c'], '')).toEqual({ inside: ['a', 'b/c'], outside: [] })
  })
  it('public2/x は public の外', () => {
    expect(splitFilesByRoot(['public/a', 'public2/x'], 'public')).toEqual({ inside: ['a'], outside: ['public2/x'] })
  })
  it('rootRelOf: 直下と同じ・外は空、中は相対', () => {
    expect(rootRelOf('/p', '/p')).toBe('')
    expect(rootRelOf('/p', '/p/public')).toBe('public')
    expect(rootRelOf('/p', '/q/public')).toBe('')
  })
})

describe('publicPrefixHint（安全網の判断）', () => {
  it('public/ 始まり・根が public・外したパスが在る → 一文を返す', () => {
    expect(publicPrefixHint('public/a.js', 'public', true))
      .toBe('パスは作業フォルダ（public）からの相対です。public/ を外して a.js を指定してください')
  })
  it.each([
    ['a.js', 'public', true],
    ['public/a.js', 'www', true],
    ['public/a.js', 'public', false],
    ['public/', 'public', true],
  ])('添えない: %s / %s / %s', (rel, root, ex) => {
    expect(publicPrefixHint(rel, root, ex)).toBeNull()
  })
})

describe('read_file の失敗の文', () => {
  const io = (existing: string[]): ToolIo => ({
    readFileInProject: async () => { throw new Error("ENOENT: no such file or directory, open '/p/public/public/a.js'") },
    exists: async (p: string) => existing.includes(p),
  } as unknown as ToolIo)

  it('public/a.js で失敗し a.js が在れば、外して指定する案内が付く（読み替えて読みはしない）', async () => {
    const r = await executeToolCore('read_file', JSON.stringify({ path: 'public/a.js' }), { writeRoot: '/p/public' }, io(['/p/public/a.js']))
    expect(r).toContain('public/ を外して a.js を指定してください')
    expect(r.startsWith('エラー: ファイルを読めませんでした')).toBe(true)
  })
  it('外した先が無ければ案内は付かない', async () => {
    const r = await executeToolCore('read_file', JSON.stringify({ path: 'public/a.js' }), { writeRoot: '/p/public' }, io([]))
    expect(r).not.toContain('を外して')
  })
  it('作業フォルダが public でなければ付かない', async () => {
    const r = await executeToolCore('read_file', JSON.stringify({ path: 'public/a.js' }), { writeRoot: '/p' }, io(['/p/a.js']))
    expect(r).not.toContain('を外して')
  })
  it('./public/a.js でも案内が付く（先頭の ./ は resolveInProject と同じく外して判断する）', async () => {
    const r = await executeToolCore('read_file', JSON.stringify({ path: './public/a.js' }), { writeRoot: '/p/public' }, io(['/p/public/a.js']))
    expect(r).toContain('public/ を外して a.js を指定してください')
  })
  it('IPC が包んだ失敗の文（Error invoking remote method ... ENOENT）でも案内が付く', async () => {
    const wrapped: ToolIo = {
      readFileInProject: async () => { throw new Error("Error invoking remote method 'fs:readFileInProject': Error: ENOENT: no such file or directory, open '/p/public/public/a.js'") },
      exists: async (p: string) => p === '/p/public/a.js',
    } as unknown as ToolIo
    const r = await executeToolCore('read_file', JSON.stringify({ path: 'public/a.js' }), { writeRoot: '/p/public' }, wrapped)
    expect(r).toContain('public/ を外して a.js を指定してください')
  })
})
