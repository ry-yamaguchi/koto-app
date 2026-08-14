import { describe, it, expect } from 'vitest'
import { detectRuntime } from '../src/shared/runtimeDetect'

// 2026-08-14 実機で発覚。内蔵ビルダーが static 決め打ちだったため、`server.js` を書いた
// アプリを公開すると **python の http.server がソースの一覧を配って**いた。
// 永続データ（S-1）は Node のモジュール（koto-data.js）を前提にしているので、
// **サーバーが動かなければ、保存場所を用意しても意味がない。**
//
// ここで守るのは2つ:
//   ① Node のアプリを static と決めつけない（ソースが丸見えになる）
//   ② 動かせないものを「動く」と言わない（依存パッケージはまだ運べない）

describe('起動方法の判断', () => {
  it('package.json が無ければ静的配信（これまでどおり）', () => {
    expect(detectRuntime({ packageJson: null, fileNames: ['index.html', 'style.css'] })).toEqual({ kind: 'static' })
  })

  // ★ 実機で起きた形（data-test）
  it('scripts.start の「node ○○」から起動ファイルを決める', () => {
    const r = detectRuntime({
      packageJson: { name: 'data-test', type: 'module', scripts: { start: 'node server.js' } },
      fileNames: ['package.json', 'server.js', 'koto-data.js'],
    })
    expect(r).toEqual({ kind: 'node', entry: 'server.js' })
  })

  it('./ 付きでも拾う', () => {
    const r = detectRuntime({ packageJson: { scripts: { start: 'node ./app.js' } }, fileNames: ['app.js'] })
    expect(r).toEqual({ kind: 'node', entry: 'app.js' })
  })

  it('main からも決められる', () => {
    const r = detectRuntime({ packageJson: { main: 'index.js' }, fileNames: ['index.js'] })
    expect(r).toEqual({ kind: 'node', entry: 'index.js' })
  })

  it('書いていなければ、よくある名前から探す', () => {
    expect(detectRuntime({ packageJson: {}, fileNames: ['server.js'] })).toEqual({ kind: 'node', entry: 'server.js' })
    expect(detectRuntime({ packageJson: {}, fileNames: ['index.js'] })).toEqual({ kind: 'node', entry: 'index.js' })
  })

  it('書いてあっても、そのファイルが無ければ次の候補を見る', () => {
    const r = detectRuntime({ packageJson: { main: 'dist/bundle.js' }, fileNames: ['server.js'] })
    expect(r).toEqual({ kind: 'node', entry: 'server.js' })
  })

  // ★ 止めすぎも害（掟10）。ただし「動かないのに動くと言う」よりはよい
  it('依存パッケージがあれば、動かせないと正直に伝える', () => {
    const r = detectRuntime({
      packageJson: { dependencies: { express: '^4.0.0' }, scripts: { start: 'node server.js' } },
      fileNames: ['server.js'],
    })
    expect(r.kind).toBe('unsupported')
    if (r.kind !== 'unsupported') throw new Error('unreachable')
    expect(r.reason).toContain('express')      // 何が原因かを名指しする
    expect(r.reason).toContain('公開先を変えて') // 次の行動を示す
  })

  it('開発用の依存（devDependencies）だけなら動かせる', () => {
    const r = detectRuntime({
      packageJson: { devDependencies: { vitest: '^4.0.0' }, scripts: { start: 'node server.js' } },
      fileNames: ['server.js'],
    })
    expect(r).toEqual({ kind: 'node', entry: 'server.js' })
  })

  it('空の dependencies は「無い」と同じ', () => {
    const r = detectRuntime({ packageJson: { dependencies: {}, scripts: { start: 'node server.js' } }, fileNames: ['server.js'] })
    expect(r).toEqual({ kind: 'node', entry: 'server.js' })
  })

  // ★ ここを static に倒すと、また「ソースが丸見え」になる
  it('package.json はあるのに起動ファイルが無ければ、静的だと決めつけない', () => {
    const r = detectRuntime({ packageJson: { name: 'x' }, fileNames: ['package.json', 'README.md'] })
    expect(r.kind).toBe('unsupported')
  })

  it('nodemon や複合コマンドは start から拾わない（別の候補で判断する）', () => {
    const r = detectRuntime({ packageJson: { scripts: { start: 'nodemon server.js' } }, fileNames: ['server.js'] })
    // start は読めないが、よくある名前で拾えるので動かせる
    expect(r).toEqual({ kind: 'node', entry: 'server.js' })
  })

  it('壊れた入力でも落ちない', () => {
    expect(detectRuntime({ packageJson: 'なにか' as any, fileNames: [] })).toEqual({ kind: 'static' })
    expect(detectRuntime({ packageJson: { scripts: 'x', main: 5 } as any, fileNames: ['server.js'] })).toEqual({ kind: 'node', entry: 'server.js' })
  })
})
