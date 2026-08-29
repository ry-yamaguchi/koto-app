import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createProjectOnDisk } from '../src/main/projectCreateFs'

// project:create（main の IPC ハンドラ）の中身を、本物の一時フォルダで検証する（改善1）。
// electron 非依存に切り出してあるので（vitest.config.ts の方針）、ここは実ファイルで確かめられる。
//
// ── なぜこのテストが要るか ────────────────────────────────────────────
// 新規プロジェクトは、フォルダを掘るだけで public/ を作らなかった（2026-08-20〜）。
// AI の初期ファイル生成時、writeRoot（resolvePublishRoot）は public/ がまだ無いので
// プロジェクト直下になり、全ファイルが直下へ書かれてしまっていた（0.3.52 実機確認）。
// withPublishDir=true のときに実際に public/ フォルダが掘られることを固定する。

let parentDir = ''

beforeEach(() => {
  parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-projectcreate-'))
})
afterEach(() => {
  fs.rmSync(parentDir, { recursive: true, force: true })
})

describe('createProjectOnDisk: withPublishDir（最初から public/ を掘る）', () => {
  it('withPublishDir=true なら <project>/public が最初から存在する（テスト1）', () => {
    const r = createProjectOnDisk(parentDir, 'newproj', [], false, true)
    expect(fs.existsSync(path.join(r.root, 'public'))).toBe(true)
    expect(fs.statSync(path.join(r.root, 'public')).isDirectory()).toBe(true)
  })

  it('withPublishDir=false なら public/ は掘らない（公開されるファイルが無ければ従来どおり）', () => {
    const r = createProjectOnDisk(parentDir, 'newproj', [], false, false)
    expect(fs.existsSync(path.join(r.root, 'public'))).toBe(false)
  })

  it('files が空でも root フォルダ自体は作る', () => {
    const r = createProjectOnDisk(parentDir, 'blank', [], false, false)
    expect(fs.existsSync(r.root)).toBe(true)
    expect(fs.statSync(r.root).isDirectory()).toBe(true)
  })
})

describe('createProjectOnDisk: files 引数の置き場所（掟1・実物で確かめる）', () => {
  // fs:createProject の files 引数（テンプレートファイル）の置き場所は、
  // 「public/ が実在するか」ではなく isPublished/placeInProject の判断だけで決まる。
  // withPublishDir の有無に**引きずられない**ことを実際に書いて確かめる。
  it('公開されるファイル（index.html）は withPublishDir の有無に関わらず public/ の中へ入る', () => {
    const files = [{ path: 'index.html', content: '<h1>hi</h1>' }]
    const withFlag = createProjectOnDisk(parentDir, 'a', files, false, true)
    const withoutFlag = createProjectOnDisk(parentDir, 'b', files, false, false)
    expect(fs.readFileSync(path.join(withFlag.root, 'public', 'index.html'), 'utf-8')).toBe('<h1>hi</h1>')
    expect(fs.readFileSync(path.join(withoutFlag.root, 'public', 'index.html'), 'utf-8')).toBe('<h1>hi</h1>')
  })

  it('Koto内部のメタ（.sakuraide.json）は公開対象ではないので直下に残る', () => {
    const files = [{ path: '.sakuraide.json', content: '{}' }]
    const r = createProjectOnDisk(parentDir, 'c', files, false, true)
    expect(fs.readFileSync(path.join(r.root, '.sakuraide.json'), 'utf-8')).toBe('{}')
    expect(fs.existsSync(path.join(r.root, 'public', '.sakuraide.json'))).toBe(false)
  })

  it('公開先が未定義の相対パス（既に public/ を含む）も二重化しない', () => {
    const files = [{ path: 'public/index.php', content: '<?php ?>' }]
    const r = createProjectOnDisk(parentDir, 'd', files, false, false)
    expect(fs.readFileSync(path.join(r.root, 'public', 'index.php'), 'utf-8')).toBe('<?php ?>')
    expect(fs.existsSync(path.join(r.root, 'public', 'public'))).toBe(false)
  })
})

describe('createProjectOnDisk: 既存フォルダへのマージ（allowExisting）は従来どおり', () => {
  it('既に同名フォルダがあり allowExisting=false なら例外', () => {
    fs.mkdirSync(path.join(parentDir, 'dup'))
    expect(() => createProjectOnDisk(parentDir, 'dup', [], false, false)).toThrow(/既に同名のフォルダ/)
  })

  it('allowExisting=true なら既存ファイルを上書きせず skipped に積む', () => {
    const root = path.join(parentDir, 'merge')
    fs.mkdirSync(path.join(root, 'public'), { recursive: true })
    fs.writeFileSync(path.join(root, 'public', 'index.html'), '元からある内容')
    const r = createProjectOnDisk(parentDir, 'merge', [{ path: 'index.html', content: '新しい内容' }], true, false)
    expect(r.merged).toBe(true)
    expect(r.skipped).toContain('public/index.html')
    expect(fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf-8')).toBe('元からある内容')
  })

  it('allowExisting=true でも withPublishDir=true なら public/ の mkdir 自体は無害（既存でも壊さない）', () => {
    const root = path.join(parentDir, 'merge2')
    fs.mkdirSync(path.join(root, 'public'), { recursive: true })
    fs.writeFileSync(path.join(root, 'public', 'existing.txt'), '既存')
    createProjectOnDisk(parentDir, 'merge2', [], true, true)
    expect(fs.readFileSync(path.join(root, 'public', 'existing.txt'), 'utf-8')).toBe('既存')
  })
})

describe('createProjectOnDisk: パス脱出は拒む（従来どおり）', () => {
  // '../evil.txt' は public/ プレフィックスが足された上で正規化されると root の中に収まる
  // （public/../evil.txt → <root>/evil.txt）。root の外へ実際に出ようとする深さ（'../../evil.txt'）
  // で確かめる。
  it('root の外へ出ようとする相対パスは書かない', () => {
    const files = [{ path: '../../evil.txt', content: 'x' }]
    const r = createProjectOnDisk(parentDir, 'e', files, false, false)
    expect(fs.existsSync(path.join(parentDir, '..', 'evil.txt'))).toBe(false)
    expect(fs.existsSync(path.join(parentDir, 'evil.txt'))).toBe(false)
    expect(fs.readdirSync(r.root)).toEqual([])
  })
})
