import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { summarizePreflight, sortChecks, askAiAboutCheck, type PreflightCheck } from '../src/shared/preflight'

// 2026-08-14 の実機検証で、公開は10回以上失敗した。
// そのうち**4件は押す前に分かったはず**のもの（レジストリが消えている／保存場所が
// 作られていない／公開名の衝突／Node で動かせない作り）。
// どれも「押す → 数分待つ → 分からないエラー」で返ってきた。

const C = (id: string, status: PreflightCheck['status'], label = id): PreflightCheck =>
  ({ id, label, status, note: 'x' })

describe('確認結果をまとめる', () => {
  it('全部よければ、公開できると言う', () => {
    const r = summarizePreflight([C('key', 'ok'), C('spec', 'ok')])
    expect(r.canPublish).toBe(true)
    expect(r.summary).toBe('公開できます')
  })

  it('★ 1つでも駄目なら止める（何が駄目かを見出しに出す）', () => {
    const r = summarizePreflight([C('key', 'ok'), C('registry', 'ng', 'イメージの置き場')])
    expect(r.canPublish).toBe(false)
    expect(r.summary).toContain('イメージの置き場')
  })

  it('駄目が複数なら件数を出す', () => {
    const r = summarizePreflight([C('registry', 'ng'), C('name', 'ng')])
    expect(r.canPublish).toBe(false)
    expect(r.summary).toContain('2件')
  })

  // ★ 確かめられなかっただけで公開できないのは、利用者には「壊れている」のと同じ
  it('気になる点だけなら止めない', () => {
    const r = summarizePreflight([C('storage', 'warn'), C('key', 'ok')])
    expect(r.canPublish).toBe(true)
    expect(r.summary).toContain('1件')
  })

  it('駄目と気になるが混ざれば、駄目を優先する', () => {
    const r = summarizePreflight([C('storage', 'warn'), C('registry', 'ng')])
    expect(r.canPublish).toBe(false)
  })

  it('何も確認できなくても落ちない', () => {
    expect(summarizePreflight([]).canPublish).toBe(true)
    expect(summarizePreflight(undefined as any).canPublish).toBe(true)
  })

  it('元の配列を書き換えない', () => {
    const src = [C('a', 'ok')]
    summarizePreflight(src)
    expect(src.length).toBe(1)
  })
})

describe('並べる順', () => {
  it('利用者が直しやすい順に並べる（手前のものから）', () => {
    const shuffled = [C('storage', 'ok'), C('key', 'ok'), C('name', 'ok'), C('spec', 'ok')]
    expect(sortChecks(shuffled).map(c => c.id)).toEqual(['key', 'spec', 'name', 'storage'])
  })

  it('知らない項目は最後に回す（並びが壊れない）', () => {
    const r = sortChecks([C('なにか', 'ok'), C('key', 'ok')])
    expect(r[0].id).toBe('key')
    expect(r[1].id).toBe('なにか')
  })
})

// 判断を一元化しても、呼ぶ側が通っていなければ意味がない（掟10）
describe('公開前の確認が、実物と繋がっている', () => {
  const ipc = readFileSync(join(__dirname, '..', 'src', 'main', 'ipc', 'cloud.ts'), 'utf-8')
  const panel = readFileSync(join(__dirname, '..', 'src', 'renderer', 'components', 'AppRunPanel.tsx'), 'utf-8')
  const preload = readFileSync(join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf-8')
  const dts = readFileSync(join(__dirname, '..', 'src', 'renderer', 'global.d.ts'), 'utf-8')

  // 掟6: main / preload / global.d.ts の3点セット
  it('IPCの3点セットが揃っている', () => {
    expect(ipc).toContain("ipcMain.handle('cloud:preflight'")
    expect(preload).toContain("ipcRenderer.invoke('cloud:preflight'")
    expect(dts).toContain('preflight(projectDir: string)')
  })

  it('画面から呼ばれている', () => {
    expect(panel).toContain('runPreflight')
    expect(panel).toContain('公開できるか確かめる')
  })

  // ★ 今日の失敗のうち、押す前に分かったはずの4件
  it('実機で詰まった4点を、すべて見ている', () => {
    expect(ipc).toContain("'registry', 'イメージの置き場'")   // 消えたレジストリ
    expect(ipc).toContain("'storage', 'データの保存場所'")     // 作られていない保存場所
    expect(ipc).toContain("'name', '公開名'")                  // 孤児との衝突
    expect(ipc).toContain("'runtime', 'アプリの作り'")         // 動かせない作り
  })

  // ★ 確認そのものが何かを作ってしまっては本末転倒
  it('確認では何も作らない・変えない', () => {
    const at = ipc.indexOf("ipcMain.handle('cloud:preflight'")
    const body = ipc.slice(at, ipc.indexOf('ipcMain.handle', at + 10))
    for (const forbidden of ['createBucket', 'createContainerRegistry', 'startSite', 'issueKey', 'applyPlan', 'saveCloudState']) {
      expect(body).not.toContain(forbidden)
    }
  })

  it('自分が公開済みのアプリを「衝突」と誤解しない', () => {
    expect(ipc).toContain('このプロジェクトが公開済みのもの')
  })
})

// 2026-08-14 Ryosuke 指摘:「『レジストリを設定し直す』が出るタイミングは、
// 確認したときのほうがよいのでは。一度公開を押してからの方が良い理由は何か」
//
// **理由は無かった。** 回復のボタンを「公開の失敗」に紐づけて作っていたため、
// 確認で分かっていても、わざと失敗させてからでないと出なかった。
// **直し方が分かっているのに、失敗させてから見せるのは筋が通らない。**
describe('確認で見つけた問題を、その場で直せる', () => {
  const ipc = readFileSync(join(__dirname, '..', 'src', 'main', 'ipc', 'cloud.ts'), 'utf-8')
  const panel = readFileSync(join(__dirname, '..', 'src', 'renderer', 'components', 'AppRunPanel.tsx'), 'utf-8')

  it('レジストリが消えていたら、直す手段を添える', () => {
    expect(ipc).toContain("'reset-registry'")
    // 「公開すると出ます」という遠回しな案内をやめる
    expect(ipc).not.toContain('公開すると「レジストリを設定し直す」が出る')
  })

  it('コードを直せば通るものは、AIに相談できる', () => {
    expect(ipc).toContain("'ask-ai'")
  })

  it('画面が、確認結果からその場で直せるようにしている', () => {
    expect(panel).toContain("c.fix === 'reset-registry'")
    expect(panel).toContain("c.fix === 'ask-ai'")
  })

  it('直したら確認をやり直す（直したのに ❌ のままにしない）', () => {
    expect(panel).toMatch(/setRegistryFixed\(true\)[\s\S]{0,200}runPreflight\(\)/)
  })
})

describe('AIへの相談文（確認で見つけた問題）', () => {
  it('何が問題かをそのまま渡す', () => {
    const t = askAiAboutCheck({ label: 'アプリの作り', note: '外部のライブラリを使っています。' })
    expect(t).toContain('アプリの作り')
    expect(t).toContain('外部のライブラリ')
  })

  it('何を変えたか教えてもらう（黙って直されると追えない）', () => {
    expect(askAiAboutCheck({ label: 'a', note: 'b' })).toContain('何を変えたか')
  })

  it('画面文言に Markdown 記法を混ぜない', () => {
    expect(askAiAboutCheck({ label: 'a', note: 'b' })).not.toMatch(/\*\*|`/)
  })
})
