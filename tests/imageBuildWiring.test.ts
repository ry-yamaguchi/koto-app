import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { excludedFileNames, excludedDirNames } from '../src/shared/publishExclude'

// 2026-08-14 実機で発覚。公開したアプリのURLを開くと、`.sakuraide.json` が
// ブラウザから読めていた（静的配信だったため一覧に出た）。
//
// 原因は imageBuild.ts が除外リストを**手で並べ直していた**こと:
//   const EXCLUDE_NAMES = new Set([...excludedDirNames(), ...NOISE_FILES])
// ファイル側は NOISE_FILES しか足しておらず、KOTO_INTERNAL_FILES が抜けていた。
//
// publishExclude.ts は **まさにこれを防ぐために作った**モジュールである
// （2026-08-05 の `.sakuraide` 流出・2026-08-09 の `.env` 流出と同じ構造）。
// それでも同じ穴が空いた。imageBuild.ts は electron に依存していて import できないので、
// **ソースを読んで、手で並べ直していないことを確かめる**。
//
// 掟10「一元化したことと、全経路が実際にそこを通っていることは別」。

const SRC = path.join(__dirname, '..', 'src', 'main', 'cloud', 'imageBuild.ts')

describe('公開イメージの除外リスト', () => {
  const source = fs.readFileSync(SRC, 'utf-8')

  it('フォルダとファイルの両方を、一元定義から取っている', () => {
    const line = source.split('\n').find(l => l.includes('const EXCLUDE_NAMES'))
    expect(line).toBeDefined()
    expect(line!).toContain('excludedDirNames()')
    expect(line!).toContain('excludedFileNames()')
  })

  it('一元定義に、Koto の内部ファイルが入っている', () => {
    expect(excludedFileNames().has('.sakuraide.json')).toBe(true)
    expect(excludedFileNames().has('.DS_Store')).toBe(true)
  })

  it('一元定義に、Koto の内部フォルダと重いフォルダが入っている', () => {
    for (const name of ['.sakuraide', '.sakuraide-backup', '.sakura-cloud', '.git', 'node_modules']) {
      expect(excludedDirNames().has(name)).toBe(true)
    }
  })

  it('秘密ファイルの判定も通している（.env をイメージへ焼かない）', () => {
    expect(source).toContain('isSecretFile')
  })
})

describe('起動方法の配線', () => {
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc', 'cloud.ts'), 'utf-8')

  // static 決め打ちに戻ると、Node のアプリでソースが丸見えになる
  it('内蔵ビルダーの呼び出しで、ランタイムを決め打ちしていない', () => {
    expect(ipc).not.toContain("runtime: 'static'")
    expect(ipc).toContain('detectRuntime')
  })

  it('動かせないと分かったら、公開せずに理由を返す', () => {
    expect(ipc).toContain("choice.kind === 'unsupported'")
  })
})

// 2026-08-14 実機。公開したアプリが起動せず、AppRun のログにこう出た:
//   Error: EACCES: permission denied, open '/app/koto-data.js'
//
// 手元の `koto-data.js` が `-rw-------`（0600）だった。`fs.copyFileSync` は
// **元の権限を引き継ぐ**ので、そのままイメージへ入り、コンテナの Node が
// 自分のファイルを読めずに落ちた。
//
// **原因は手元の権限なのに、症状は容器の中で出る。** 画面には「デプロイに失敗」
// としか出ず、ログを開くまで辿り着けない。手元がどうであれ、配るものは
// 誰でも読める形に揃える。
describe('公開イメージのファイル権限', () => {
  const source = fs.readFileSync(SRC, 'utf-8')

  // 最初は `chmod 0644` と固定で書いた。Ryosuke の点検で改めた（2026-08-14）:
  //   ・0755 の実行可能ファイルが 0644 になり、**実行できなくなる**（奪いすぎ）
  //   ・0400 の読み取り専用に**書き込みを与えてしまう**（与えすぎ）
  // 要るのは「コンテナの中の誰かが読めること」だけ。ビット単位で足すだけにする。
  it('読み取りだけを足す（ファイル）', () => {
    expect(source).toContain('0o444')
  })

  it('フォルダは読み＋辿るだけを足す（書き込みは与えない）', () => {
    expect(source).toContain('0o555')
  })

  it('権限を固定で上書きしない（実行ビットを落とさない）', () => {
    expect(source).not.toMatch(/chmodSync\([^,]+,\s*0o644\)/)
    expect(source).not.toMatch(/chmodSync\([^,]+,\s*0o755\)/)
    // 足す形になっていること
    expect(source).toMatch(/mode \| bits/)
  })

  it('秘密ファイルは、権限を触る前に除外されている', () => {
    // isSecretFile の判定が copyFileSync より前にあること（順序が逆だと
    // 「複製してから除外」になり、一瞬でも秘密が複製される）
    expect(source.indexOf('isSecretFile')).toBeLessThan(source.indexOf('fs.copyFileSync'))
  })

  it('権限を変えられなくても、公開そのものは止めない', () => {
    const at = source.indexOf('function addPermission')
    expect(source.slice(at, at + 400)).toContain('catch')
  })
})
