import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { projectFilesInfoFs, projectFilesFs } from '../src/main/ipc/fs'
import { MATERIALS_DIR } from '../src/shared/publishExclude'

// walkProjectFiles（src/main/ipc/fs.ts）の除外規則・打ち切りの正直さを、実際のフォルダで検証する。
// src/main/ipc/fs.ts はトップレベルで 'electron' を import しているが、**import されるだけでは
// electron の実体には触れない**（tests/portOpen.test.ts / tests/sakuraIpc.test.ts の前例と同じ）。
// projectFilesInfoFs / projectFilesFs 自体は fs / path しか使わないため、electron 非依存のまま実駆動できる。
//
// ── なぜ要るか（roadmap #17 追補・2026-09-03 Ryosuke「200件で打ち切るのは正しいのか」から発覚）───
// 公開前セキュリティチェックの一覧取得（fs:projectFilesInfo）は、既定では WALK_IGNORE_DIRS
// （node_modules/.git/dist/build/vendor/…）＋ドット始まりフォルダを丸ごと飛ばして歩いていた。
// だが実際の公開経路（src/main/vercel/client.ts collectDeployFiles・src/main/cloud/imageBuild.ts
// copyTree）が除外するのは publishExcludedDirNames()（HEAVY_DIRS＋KOTO_INTERNAL_DIRS＋
// PUBLISH_ONLY_DIRS）だけで、dist/build/out や .well-known 等は除外していない
// （vercel/client.ts のコメント「dist/build 等のビルド成果物は除外しない」・実装 copyTree で確認済み）。
// つまり従来の既定走査は「公開されるのに検査の目に入らない」ものを取りこぼしていた
// （dist の sourcemap にソース全文、が典型的なすり抜け）。
// projectFilesInfoFs の opts.publishView: true は、除外規則を公開と同じ定義に揃える。

let projectDir = ''

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-fswalk-'))
})
afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

function write(rel: string, content = 'x'): void {
  const full = path.join(projectDir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

describe('projectFilesInfoFs: publishView（公開と同じ除外定義で走査する）', () => {
  it('publishView: true なら dist/ の中身が一覧に載る（公開経路は dist/build を除外しないため）', () => {
    write('dist/bundle.js.map')
    write('index.html')
    const { files } = projectFilesInfoFs(projectDir, { publishView: true })
    expect(files).toContain('dist/bundle.js.map')
    expect(files).toContain('index.html')
  })

  it('publishView: true なら .well-known/ の中身が一覧に載る（ドット始まりの一律除外をやめたため）', () => {
    write('.well-known/apple-app-site-association')
    const { files } = projectFilesInfoFs(projectDir, { publishView: true })
    expect(files).toContain('.well-known/apple-app-site-association')
  })

  it('publishView: true でも node_modules/.git/.sakuraide/素材置き場は載らない（公開の一元定義どおり）', () => {
    write('node_modules/pkg/index.js')
    write('.git/HEAD')
    write('.sakuraide/log.json')
    write(`${MATERIALS_DIR}/original.psd`)
    write('index.html')
    const { files } = projectFilesInfoFs(projectDir, { publishView: true })
    expect(files).not.toContain('node_modules/pkg/index.js')
    expect(files).not.toContain('.git/HEAD')
    expect(files).not.toContain('.sakuraide/log.json')
    expect(files).not.toContain(`${MATERIALS_DIR}/original.psd`)
    expect(files).toContain('index.html')
  })

  it('publishView: true でも .sakuraide.json（Kotoの内部メタ）と .DS_Store はファイルとして除外', () => {
    write('.sakuraide.json', '{}')
    write('.DS_Store')
    write('index.html')
    const { files } = projectFilesInfoFs(projectDir, { publishView: true })
    expect(files).not.toContain('.sakuraide.json')
    expect(files).not.toContain('.DS_Store')
    expect(files).toContain('index.html')
  })

  // ── 対: 既定モードは1文字も変えない ──────────────────────────────────
  it('既定モード（publishView 未指定）は従来どおり dist/ を飛ばす', () => {
    write('dist/bundle.js.map')
    write('index.html')
    const { files } = projectFilesInfoFs(projectDir)
    expect(files).not.toContain('dist/bundle.js.map')
    expect(files).toContain('index.html')
  })

  it('既定モードは従来どおりドット始まりフォルダを丸ごと飛ばす', () => {
    write('.well-known/apple-app-site-association')
    const { files } = projectFilesInfoFs(projectDir)
    expect(files).not.toContain('.well-known/apple-app-site-association')
  })

  it('既定モードでは .DS_Store は除外されない（従来どおり。fs:projectFiles の挙動を変えない）', () => {
    write('.DS_Store')
    const { files } = projectFilesInfoFs(projectDir)
    expect(files).toContain('.DS_Store')
  })
})

describe('projectFilesInfoFs: 深さの打ち切りを truncated に反映する', () => {
  it('深さ上限（既定6）を超えて実在するフォルダを捨てたら truncated になる（黙って欠けない）', () => {
    // root/d1/d2/d3/d4/d5/d6/d7/deep.txt … d7 の読み込みは depth=7 で打ち切られる
    write('d1/d2/d3/d4/d5/d6/d7/deep.txt')
    const { files, truncated } = projectFilesInfoFs(projectDir, { publishView: true })
    expect(files).not.toContain('d1/d2/d3/d4/d5/d6/d7/deep.txt')
    expect(truncated).toBe(true)
  })

  it('深さ上限に収まっていれば truncated は立たない', () => {
    write('d1/d2/shallow.txt')
    write('index.html')
    const { files, truncated } = projectFilesInfoFs(projectDir, { publishView: true })
    expect(files).toContain('d1/d2/shallow.txt')
    expect(files).toContain('index.html')
    expect(truncated).toBe(false)
  })

  it('既定モードでも同じく深さ打ち切りが truncated に反映される（この変更は既定にも適用してよい）', () => {
    write('d1/d2/d3/d4/d5/d6/d7/deep.txt')
    const { truncated } = projectFilesInfoFs(projectDir)
    expect(truncated).toBe(true)
  })
})

describe('projectFilesInfoFs: maxFiles（従来どおりの上限打ち切り）', () => {
  it('maxFiles を超えたら truncated になる', () => {
    for (let i = 0; i < 5; i++) write(`f${i}.txt`)
    const { files, truncated } = projectFilesInfoFs(projectDir, { maxFiles: 3 })
    expect(files).toHaveLength(3)
    expect(truncated).toBe(true)
  })

  it('maxFiles 未満なら truncated は立たない', () => {
    for (let i = 0; i < 3; i++) write(`f${i}.txt`)
    const { files, truncated } = projectFilesInfoFs(projectDir, { maxFiles: 10 })
    expect(files).toHaveLength(3)
    expect(truncated).toBe(false)
  })

  it('opts 未指定なら既定の200件のまま（互換性維持）', () => {
    for (let i = 0; i < 5; i++) write(`f${i}.txt`)
    const { files, truncated } = projectFilesInfoFs(projectDir)
    expect(files).toHaveLength(5)
    expect(truncated).toBe(false)
  })
})

describe('projectFilesFs（fs:projectFiles・互換性維持）', () => {
  it('除外規則は従来どおり（publishView という概念自体が無い）', () => {
    write('dist/bundle.js')
    write('.well-known/x')
    write('index.html')
    const files = projectFilesFs(projectDir)
    expect(files).not.toContain('dist/bundle.js')
    expect(files).not.toContain('.well-known/x')
    expect(files).toContain('index.html')
  })
})
