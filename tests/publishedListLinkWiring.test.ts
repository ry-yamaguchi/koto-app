import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 判断3（2026-09-11）: プロジェクトを開いていないときの「📡 公開したものと費用を見る」。
// App.tsx → Sidebar への onOpenPublishedList の受け渡しと、リンクの文言を固定する
// （掟10: OSメニュー・PublishModal 奥のリンクと**同じ関数**を渡しているか＝複製していないか）。

const ROOT = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

const app = read('src/renderer/App.tsx')
const sidebar = read('src/renderer/components/Sidebar.tsx')

describe('App.tsx → Sidebar: onOpenPublishedList の受け渡し', () => {
  it('Sidebar へ onOpenPublishedList={() => setShowPublishedList(true)} を渡している（PublishModal と同じ関数）', () => {
    const at = app.indexOf('<Sidebar')
    expect(at).toBeGreaterThan(-1)
    const end = app.indexOf('/>', at)
    const block = app.slice(at, end)
    expect(block).toContain('onOpenPublishedList={() => setShowPublishedList(true)}')
  })

  it('PublishModal も同じ setShowPublishedList(true) を渡している（複製せず同じ関数を共有）', () => {
    expect(app).toContain('onOpenPublishedList={() => setShowPublishedList(true)}')
    // Sidebar・PublishModal の2箇所から同じ呼び出し文字列が使われている
    const occurrences = app.split('onOpenPublishedList={() => setShowPublishedList(true)}').length - 1
    expect(occurrences).toBe(2)
  })

  it('PublishedListModal は currentDir を条件にせず開ける（showPublishedList だけで描画）', () => {
    const at = app.indexOf('{showPublishedList && (')
    expect(at).toBeGreaterThan(-1)
    const end = app.indexOf(')}', at)
    const block = app.slice(at, end)
    expect(block).toContain('<PublishedListModal')
    expect(block).not.toContain('currentDir &&')
  })
})

describe('Sidebar.tsx: プロジェクト未オープン画面の「📡 公開したものと費用を見る」リンク', () => {
  it('Props に onOpenPublishedList?: () => void を持つ', () => {
    expect(sidebar).toContain('onOpenPublishedList?: () => void')
  })

  it('コンポーネント引数で受け取っている', () => {
    expect(sidebar).toContain('onOpenPublishedList,')
  })

  it('未オープン画面の一覧より上に、短い1行のテキストリンクとして常に出す（掟11: 印ではなく入口なので常設可）', () => {
    const at = sidebar.indexOf('{onOpenPublishedList && (')
    expect(at).toBeGreaterThan(-1)
    const block = sidebar.slice(at, at + 260)
    expect(block).toContain('onClick={onOpenPublishedList}')
    expect(block).toContain('📡 公開したものと費用を見る')
    // 未オープン画面の中身（プロジェクトの場所一覧）より前に置かれている
    // （「プロジェクトの場所」は開いているプロジェクトのスイッチャー内にも同じ文言があるため、
    // このリンクより後ろで最初に出てくるものを探す）
    const projectsAt = sidebar.indexOf('プロジェクトの場所', at)
    expect(projectsAt).toBeGreaterThan(at)
  })
})
