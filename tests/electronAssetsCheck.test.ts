import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — ビルド用スクリプト（型定義は持たない）
import {
  electronAssetSources, missingElectronAssets, BROTLI_FIX_MARKER, bufferHasMarker, fileHasMarker, brotliProblems,
  plistMinimumSystemVersion, electronConsistencyProblems, claudeBinaries,
  EMUDHRA_SPKI_HASHES, bufferFindEmudhraHashes, fileFindEmudhraHashes, emudhraProblems,
  embeddedNodeProblems, NODE_SPKI_BLOCKLIST_MIN, electronExecutablePath, electronFrameworkPath,
  allElectronAssetProblems, embeddedNodeEnv, runEmbeddedNodeVersion,
} from '../scripts/check-electron-assets.mjs'

// Electron 42 以降は npm install で本体を落とさず、electron-builder は extraResources の元が無くても
// 警告だけで飛ばす。ライセンスの2ファイルが黙って配布物から抜けないよう、check:build で止める。

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
const repoRoot = join(__dirname, '..')

// 本物の node_modules（Electron 本体・同梱の Claude）を読むテストは、macOS で本体が入っているときだけ走らせる。
// 本体が無い環境（本体を落としていない Mac など）では飛ばす。CI（ubuntu）は、ほかの多くのテストが electron を読み込むので、
// .github/workflows/ci.yml の `npm run ensure:electron` で先に本体を取る（このテストが CI を緑にしているわけではない。
// 実物を読むテストは darwin 以外では飛ぶ）。
const hasElectronApp = process.platform === 'darwin' && existsSync(electronFrameworkPath(repoRoot)) && existsSync(electronExecutablePath(repoRoot))
const hasClaudeBin = claudeBinaries(repoRoot).length > 0

describe('Electron 本体とライセンスの確認', () => {
  it('配布物に入れる Electron のライセンス2ファイルを設定から読む', () => {
    expect(electronAssetSources(pkg.build.extraResources)).toEqual([
      'node_modules/electron/dist/LICENSE',
      'node_modules/electron/dist/LICENSES.chromium.html',
    ])
  })
  it('1つでも無ければ、その名前を返す（空なら全部ある）', () => {
    const have = new Set(['/r/node_modules/electron/dist/Electron.app', '/r/node_modules/electron/dist/LICENSE'])
    expect(missingElectronAssets('/r', pkg.build.extraResources, (p: string) => have.has(p)))
      .toEqual(['node_modules/electron/dist/LICENSES.chromium.html'])
    expect(missingElectronAssets('/r', pkg.build.extraResources, () => true)).toEqual([])
    expect(missingElectronAssets('/r', pkg.build.extraResources, () => false)).toHaveLength(3)
  })
  it('★ check:build が確認を呼び、dist・electron・start は本体を落としてから始まる', () => {
    expect(pkg.scripts['check:build']).toContain('node scripts/check-electron-assets.mjs')
    expect(pkg.scripts['ensure:electron']).toBe('install-electron --no')
    expect(pkg.scripts.dist.startsWith('npm run ensure:electron && npm run check:build &&')).toBe(true)
    expect(pkg.scripts.electron.startsWith('npm run ensure:electron &&')).toBe(true)
    expect(pkg.scripts.start.startsWith('npm run ensure:electron &&')).toBe(true)
  })
  it('Electron の版は範囲指定ではなく固定', () => {
    expect(pkg.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

// ── Brotli の修正の印 ──────────────────────────────────────────────────
describe('Brotli の修正の印（_ERROR_FORMAT_BLOCK_SWITCH）', () => {
  it('印の名前は固定', () => {
    expect(BROTLI_FIX_MARKER).toBe('_ERROR_FORMAT_BLOCK_SWITCH')
  })
  it('バッファに印がある・無い', () => {
    expect(bufferHasMarker(Buffer.from('xx_ERROR_FORMAT_DISTANCE\0_ERROR_FORMAT_BLOCK_SWITCH\0yy'))).toBe(true)
    expect(bufferHasMarker(Buffer.from('_ERROR_FORMAT_DISTANCE\0_ERROR_COMPOUND_DICTIONARY\0'))).toBe(false)
  })
  it('★ ファイルは塊の境目をまたぐ全ての位置でも見つかり、無ければ false（小さな実ファイルで）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'koto-marker-'))
    try {
      const CHUNK = 8 * 1024 * 1024
      const len = Buffer.from(BROTLI_FIX_MARKER).length
      const f = join(dir, 'f')
      // 印の頭が CHUNK-(len-1) .. CHUNK-1 の全ての位置（重ねる長さが1でも足りないと見落とす）
      for (let start = CHUNK - (len - 1); start <= CHUNK - 1; start++) {
        writeFileSync(f, Buffer.concat([Buffer.alloc(start, 0x61), Buffer.from(BROTLI_FIX_MARKER), Buffer.alloc(100, 0x62)]))
        expect(fileHasMarker(f), `start=${start}`).toBe(true)
      }
      const without = join(dir, 'without'); writeFileSync(without, Buffer.alloc(CHUNK + 1000, 0x61))
      const tiny = join(dir, 'tiny'); writeFileSync(tiny, BROTLI_FIX_MARKER)
      expect(fileHasMarker(without)).toBe(false)
      expect(fileHasMarker(tiny)).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  const root = '/r'
  const claude = '/r/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
  const framework = '/r/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
  const listDir = () => ['claude-agent-sdk', 'claude-agent-sdk-darwin-arm64']
  const opts = (has: (f: string) => boolean, files: string[] = [claude, framework]) => ({
    hasMarker: has, listDir, exists: (f: string) => files.includes(f),
  })
  it('同梱の Claude と Electron 本体の両方に印があれば問題なし', () => {
    expect(brotliProblems(root, opts(() => true))).toEqual([])
  })
  it('★ Claude の側だけ印が無ければ、その名前で止める', () => {
    const p = brotliProblems(root, opts((f) => f !== claude))
    expect(p).toHaveLength(1)
    expect(p[0]).toContain('claude-agent-sdk-darwin-arm64/claude')
    expect(p[0]).toContain('Brotli が直っていない版')
  })
  it('★ Electron 本体の側だけ印が無ければ止める', () => {
    const p = brotliProblems(root, opts((f) => f !== framework))
    expect(p).toHaveLength(1)
    expect(p[0]).toContain('Electron Framework')
  })
  it('★ 失敗の文のパスは先頭が欠けない（root の末尾が / でも node_modules/... と出る）', () => {
    for (const r of [root, `${root}/`]) {
      const p = brotliProblems(r, opts((f) => f !== claude && f !== framework))
      expect(p).toHaveLength(2)
      for (const line of p) expect(line.startsWith('node_modules/')).toBe(true)
      const missing = brotliProblems(r, opts(() => true, [claude]))
      expect(missing).toHaveLength(1)
      expect(missing[0].startsWith('node_modules/electron/dist/Electron.app/')).toBe(true)
    }
  })
  it('同梱の Claude が1つも無ければ止める', () => {
    const p = brotliProblems(root, opts(() => true, [framework]))
    expect(p.some((x) => x.includes('同梱の Claude 実行ファイル'))).toBe(true)
  })
  it('claudeBinaries は本体の包（claude-agent-sdk）を除き、OS ごとの包だけ拾う', () => {
    expect(claudeBinaries(root, () => ['claude-agent-sdk', 'claude-agent-sdk-darwin-arm64', 'other'], () => true)).toEqual([claude])
  })
  it.skipIf(!existsSync(join(repoRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json')))('同梱の Claude の SDK の版は固定（^ なし）で、node_modules に入った版と一致する', () => {
    const want = pkg.dependencies['@anthropic-ai/claude-agent-sdk']
    expect(want).toMatch(/^\d+\.\d+\.\d+$/)
    const installed = JSON.parse(readFileSync(join(__dirname, '..', 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version
    expect(installed).toBe(want)
  })
  it.skipIf(!hasElectronApp || !hasClaudeBin)('check:build が実物を確かめている（本物の node_modules に印がある）', () => {
    expect(brotliProblems(join(__dirname, '..'))).toEqual([])
  })
})

// ── Electron 本体の最低の macOS・版 ─────────────────────────────────────
describe('Electron 本体との突き合わせ', () => {
  const plist = (v: string) => `<dict><key>CFBundleName</key><string>Electron</string>\n\t<key>LSMinimumSystemVersion</key>\n\t<string>${v}</string></dict>`
  const pkgWith = (min: string, electron = '44.11.1') => ({ build: { mac: { minimumSystemVersion: min } }, devDependencies: { electron } })
  it('Info.plist から LSMinimumSystemVersion を読む', () => {
    expect(plistMinimumSystemVersion(plist('13.0'))).toBe('13.0')
    expect(plistMinimumSystemVersion('<dict></dict>')).toBeNull()
  })
  it('同じか高ければ問題なし・版も同じなら問題なし', () => {
    expect(electronConsistencyProblems(pkgWith('13.0'), { plistText: plist('13.0'), distVersion: '44.11.1\n' })).toEqual([])
    expect(electronConsistencyProblems(pkgWith('14.0'), { plistText: plist('13.0'), distVersion: '44.11.1' })).toEqual([])
  })
  it('★ アプリの下限が本体の下限より低ければ止める', () => {
    const p = electronConsistencyProblems(pkgWith('12.0'), { plistText: plist('13.0'), distVersion: '44.11.1' })
    expect(p).toHaveLength(1)
    expect(p[0]).toContain('13.0')
    expect(electronConsistencyProblems(pkgWith('13.0'), { plistText: plist('13.2'), distVersion: '44.11.1' })).toHaveLength(1)
  })
  it('★ Info.plist に下限が無い・設定が読めないときも止める', () => {
    expect(electronConsistencyProblems(pkgWith('13.0'), { plistText: '<dict/>', distVersion: '44.11.1' })).toHaveLength(1)
    expect(electronConsistencyProblems({ build: { mac: {} }, devDependencies: { electron: '44.11.1' } }, { plistText: plist('13.0'), distVersion: '44.11.1' })).toHaveLength(1)
  })
  it('★ 入っている本体の版が package.json と違えば止める（版が空でも）', () => {
    expect(electronConsistencyProblems(pkgWith('13.0'), { plistText: plist('13.0'), distVersion: '44.10.1' })).toHaveLength(1)
    expect(electronConsistencyProblems(pkgWith('13.0'), { plistText: plist('13.0'), distVersion: '' })).toHaveLength(1)
  })
})

// ── eMudhra の中間 CA の拒否リスト（GHSA-jr5w-w6x2-84p9）───────────────────────
describe('eMudhra の拒否リスト8つ', () => {
  const root = '/r'
  const claude = '/r/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
  const framework = '/r/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
  const listDir = () => ['claude-agent-sdk', 'claude-agent-sdk-darwin-arm64']
  const all = Buffer.concat([Buffer.from('xx'), ...EMUDHRA_SPKI_HASHES.map((h: { hex: string }) => Buffer.from(h.hex, 'hex')), Buffer.from('yy')])
  const without = (cn: string) => Buffer.concat([Buffer.from('xx'), ...EMUDHRA_SPKI_HASHES.filter((h: { cn: string }) => h.cn !== cn).map((h: { hex: string }) => Buffer.from(h.hex, 'hex'))])
  const run = (bufs: Record<string, Buffer | undefined>) => emudhraProblems(root, {
    listDir,
    exists: (f: string) => f in bufs,
    findHashes: (f: string) => {
      const b = bufs[f]
      if (!b) throw new Error('ENOENT')
      return bufferFindEmudhraHashes(b)
    },
  })
  it('ハッシュは8つ・全部が32バイトの16進で重複なし', () => {
    expect(EMUDHRA_SPKI_HASHES).toHaveLength(8)
    for (const h of EMUDHRA_SPKI_HASHES) expect(h.hex).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(EMUDHRA_SPKI_HASHES.map((h: { hex: string }) => h.hex)).size).toBe(8)
    expect(new Set(EMUDHRA_SPKI_HASHES.map((h: { cn: string }) => h.cn)).size).toBe(8)
  })
  it('8つとも入っていれば問題なし', () => {
    expect(run({ [claude]: all, [framework]: all })).toEqual([])
  })
  it('★ どの1つが欠けても、その CN とファイル名で止める（Claude 側・本体側のどちらでも）', () => {
    for (const h of EMUDHRA_SPKI_HASHES) {
      const a = run({ [claude]: without(h.cn), [framework]: all })
      expect(a).toHaveLength(1)
      expect(a[0]).toContain('claude-agent-sdk-darwin-arm64/claude')
      expect(a[0]).toContain(h.cn)
      const b = run({ [claude]: all, [framework]: without(h.cn) })
      expect(b).toHaveLength(1)
      expect(b[0]).toContain('Electron Framework')
      expect(b[0]).toContain(h.cn)
    }
  })
  it('★ ファイルが無い・読めない・Claude が1つも無いときは、安全側で止める', () => {
    expect(run({ [claude]: all })).toHaveLength(1)
    expect(run({ [framework]: all }).some((x) => x.includes('同梱の Claude 実行ファイル'))).toBe(true)
    const unreadable = emudhraProblems(root, { listDir, exists: () => true, findHashes: () => { throw new Error('EACCES') } })
    expect(unreadable).toHaveLength(2)
    expect(unreadable[0]).toContain('EACCES')
  })
  it('★ ファイルは塊（8MB）の境目をまたぐ全ての位置でも見つかる（小さな実ファイルで）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'koto-emudhra-'))
    try {
      const CHUNK = 8 * 1024 * 1024
      const h0 = Buffer.from(EMUDHRA_SPKI_HASHES[0].hex, 'hex')
      const edge = join(dir, 'edge')
      // ハッシュの頭が CHUNK-(32-1) .. CHUNK-1 の全ての位置
      for (let start = CHUNK - (h0.length - 1); start <= CHUNK - 1; start++) {
        writeFileSync(edge, Buffer.concat([Buffer.alloc(start, 0x61), h0, Buffer.alloc(100, 0x62)]))
        expect(fileFindEmudhraHashes(edge), `start=${start}`).toEqual([EMUDHRA_SPKI_HASHES[0].hex])
      }
      const none = join(dir, 'none'); writeFileSync(none, Buffer.alloc(CHUNK + 1000, 0x61))
      expect(fileFindEmudhraHashes(none)).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('★ ハッシュの値そのものを固定する（Node の kBlockedSPKIs の写し。1桁変えても落ちる）', () => {
    expect(EMUDHRA_SPKI_HASHES.map((h: { cn: string, hex: string }) => [h.cn, h.hex])).toEqual([
      ['EM DV TLS CA - G3C', '49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f'],
      ['EM EV TLS CA - G3C', '5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0'],
      ['EM OV TLS CA - G3C', '63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8'],
      ['EM OV CS CA - G3C', '92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30'],
      ['EM DV TLS CA - G3B', 'ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105'],
      ['EM OV CS CA - G3B', 'ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6'],
      ['EM OV TLS CA - G3B', '43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b'],
      ['EM EV TLS CA - G3B', 'e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41'],
    ])
  })
  it.skipIf(!hasElectronApp || !hasClaudeBin)('check:build が実物を確かめている（本物の node_modules に8つとも入っている）', () => {
    expect(emudhraProblems(join(__dirname, '..'))).toEqual([])
  })
})

// ── Electron の中の Node の版（Node の拒否リストは機械語に埋め込まれていてバイト列では見えない）──
describe('Electron の中の Node の版', () => {
  const root = '/r'
  const exe = '/r/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  const run = (out: string | Error, exists = true) => embeddedNodeProblems(root, {
    exists: () => exists,
    runNode: (f: string) => { expect(f).toBe(exe); if (out instanceof Error) throw out; return out },
  })
  it('下限は v24.22.1', () => {
    expect(NODE_SPKI_BLOCKLIST_MIN).toEqual([24, 22, 1])
  })
  it('下限以上なら問題なし（改行つきでも・主・副が上がっても）', () => {
    for (const v of ['24.22.1\n', '24.22.2', '24.23.0', '25.0.0', '26.1.0']) expect(run(v), v).toEqual([])
  })
  it('★ 下限未満なら止める', () => {
    for (const v of ['24.22.0', '24.21.9', '24.9.99', '23.99.99', '22.0.0']) {
      const p = run(v)
      expect(p, v).toHaveLength(1)
      expect(p[0]).toContain('GHSA-jr5w-w6x2-84p9')
    }
  })
  it('★ 本体が無い・動かない・出力が読めないときは安全側で止める', () => {
    expect(run('24.22.2', false)).toHaveLength(1)
    expect(run(new Error('ETIMEDOUT'))[0]).toContain('ETIMEDOUT')
    for (const v of ['', 'v24.22.2', 'undefined', '24.22', '24.22.2-rc.1']) expect(run(v), v).toHaveLength(1)
  })
  it('★ 子の Node には CLAUDE*・ANTHROPIC*（大文字小文字不問）を渡さず、ELECTRON_RUN_AS_NODE=1 を付ける', () => {
    const parent = { CLAUDE_X: '1', ANTHROPIC_API_KEY: 'k', claudecode_y: '2', anthropic_z: '3', PATH: '/bin', HOME: '/h', ELECTRON_RUN_AS_NODE: '0' }
    const env = embeddedNodeEnv(parent)
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', ELECTRON_RUN_AS_NODE: '1' })
    expect(parent.CLAUDE_X).toBe('1') // 親は変えない
    const calls: unknown[][] = []
    const out = runEmbeddedNodeVersion('/exe', {
      parentEnv: parent,
      exec: (...args: unknown[]) => { calls.push(args); return '24.22.2\n' },
    })
    expect(out).toBe('24.22.2\n')
    expect(calls).toHaveLength(1)
    const [file, args, opts] = calls[0] as [string, string[], { env: Record<string, string>, stdio: unknown[] }]
    expect(file).toBe('/exe')
    expect(args).toEqual(['-p', 'process.versions.node'])
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(Object.keys(opts.env).filter((k) => /^(claude|anthropic)/i.test(k))).toEqual([])
    expect(opts.stdio[2]).toBe('pipe') // stderr の原文を残す
  })
  it('★ 失敗の原文（stderr の先頭300字・1行）を問題の文に残す', () => {
    const e = Object.assign(new Error('Command failed'), { stderr: Buffer.from('dyld: Library not loaded\n  Referenced from: x\n' + 'z'.repeat(500)) })
    const p = embeddedNodeProblems('/r', { exists: () => true, runNode: () => { throw e } })
    expect(p).toHaveLength(1)
    expect(p[0]).toContain('Command failed')
    expect(p[0]).toContain('dyld: Library not loaded Referenced from: x')
    expect(p[0]).not.toContain('\n')
    const tail = p[0].split('stderr: ')[1]
    expect(tail.length).toBeLessThanOrEqual(300 + 1)
    // 注入した exec が投げた場合も同じ（runEmbeddedNodeVersion → embeddedNodeProblems）
    const p2 = embeddedNodeProblems('/r', { exists: () => true, runNode: (x: string) => runEmbeddedNodeVersion(x, { exec: () => { throw e } }) })
    expect(p2[0]).toContain('dyld: Library not loaded')
  })
  it.skipIf(!hasElectronApp)('check:build が実物を確かめている（本物の Electron の中の Node が下限以上）', () => {
    expect(embeddedNodeProblems(repoRoot)).toEqual([])
  })
})

// ── CLI の検査が全部呼ばれていること（振る舞いで固定。コメントアウトされた呼び出しは通らない）──
describe('allElectronAssetProblems（CLI が呼ぶ検査の束）', () => {
  const pkgFake = { build: {} }
  const mk = (over: Record<string, unknown> = {}) => ({
    brotli: () => [], emudhra: () => [], embeddedNode: () => [], consistency: () => [],
    readConsistencyInput: () => ({ plistText: '', distVersion: '' }), ...over,
  })
  it('★ 検査ごとに別々の問題を返す偽を渡すと、5つの検査の問題が全部出る', () => {
    const p = allElectronAssetProblems('/r', pkgFake, mk({
      brotli: () => ['P-brotli'], emudhra: () => ['P-emudhra'], embeddedNode: () => ['P-node'], consistency: () => ['P-consistency'],
    }))
    expect(p).toEqual(['P-brotli', 'P-emudhra', 'P-node', 'P-consistency'])
  })
  it('★ 全部が問題なしなら空', () => {
    expect(allElectronAssetProblems('/r', pkgFake, mk())).toEqual([])
  })
  it('★ 検査には root と pkg が渡る', () => {
    const seen: unknown[] = []
    allElectronAssetProblems('/r', pkgFake, mk({
      brotli: (r: string) => { seen.push(['brotli', r]); return [] },
      emudhra: (r: string) => { seen.push(['emudhra', r]); return [] },
      embeddedNode: (r: string) => { seen.push(['node', r]); return [] },
      consistency: (p: unknown, input: unknown) => { seen.push(['consistency', p, input]); return [] },
    }))
    expect(seen).toEqual([['brotli', '/r'], ['emudhra', '/r'], ['node', '/r'], ['consistency', pkgFake, { plistText: '', distVersion: '' }]])
  })
  it('★ CLI の本体は allElectronAssetProblems(root, pkg) をちょうど1回呼ぶ（コメントの中の呼び出しは数えない）', () => {
    const raw = readFileSync(join(repoRoot, 'scripts/check-electron-assets.mjs'), 'utf8')
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(src.match(/const problems = allElectronAssetProblems\(root, pkg\)/g)).toHaveLength(1)
    // 失敗の表示（process.exit(1)）より前
    expect(src.indexOf('const problems = allElectronAssetProblems(root, pkg)')).toBeLessThan(src.indexOf("console.error('❌ 配布物の部品に問題があります:')"))
  })
})
