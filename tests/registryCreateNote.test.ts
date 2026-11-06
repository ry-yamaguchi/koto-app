import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { registryCreateNote, registryNotFoundCostNote, REGISTRY_MONTHLY_YEN } from '../src/shared/cloudCost'
import AppRunPrereqChecklist from '../src/renderer/components/AppRunPrereqChecklist'

// コンテナレジストリを新しく作る操作の行に、月額と、使い終わったときの次の操作を常に出す。
//   ・作り手（shared/cloudCost.ts の registryCreateNote・registryNotFoundCostNote）: 金額は定数から取り、引数で上書きできる
//   ・前提チェックの「レジストリ登録」の行（AppRunPrereqChecklist）: ✗ のときだけ、常に出る
//   ・入口: autoCreateRegistry に集まる3つ（前提チェック・結果の hint・「設定し直す」）の配線

const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const text = (html: string) => html.replace(/<[^>]*>/g, '')
const count = (s: string, part: string) => s.split(part).length - 1

/** 次の操作の文（既存の費用の文と同じ言い方）。 */
const NEXT_STEP = '使い終わったら「🗑 破棄する」で削除してください'

describe('registryCreateNote（作る操作の行に出す文）', () => {
  it('既定の金額は REGISTRY_MONTHLY_YEN で、月額と次の操作の文を1つの文章で言う', () => {
    expect(registryCreateNote()).toBe(
      `コンテナレジストリを新しく作ると、月額${REGISTRY_MONTHLY_YEN}円（税込）がかかります。`
      + `${NEXT_STEP}。アプリを消すだけでは止まりません。`,
    )
  })

  it('金額を引数で上書きすると、その金額が出る（定数を直書きに戻すと落ちる）', () => {
    const n = registryCreateNote({ registryYen: 999 })
    expect(n).toContain('月額999円（税込）')
    expect(n).not.toContain(`${REGISTRY_MONTHLY_YEN}円`)
  })

  it('次の操作の文「🗑 破棄する」で削除、と、アプリを消すだけでは止まらないことを必ず言う', () => {
    const n = registryCreateNote({ registryYen: 999 })
    expect(n).toContain(NEXT_STEP)
    expect(n).toContain('アプリを消すだけでは止まりません')
  })

  it('記法・料金の言い換え・ブランドの禁句を混ぜない', () => {
    for (const n of [registryCreateNote(), registryNotFoundCostNote()]) {
      expect(n).not.toMatch(/\*\*|__|`|\[[^\]]+\]\([^)]+\)/)
      expect(n).not.toMatch(/無償|無料/)
    }
  })
})

describe('registryNotFoundCostNote（「設定し直す」の説明に添える文）', () => {
  it('既定の金額は REGISTRY_MONTHLY_YEN で、見つからないときだけ新しく作ると言う', () => {
    expect(registryNotFoundCostNote()).toBe(`見つからないときは新しく作るので、月額${REGISTRY_MONTHLY_YEN}円（税込）がかかります。`)
  })

  it('金額を引数で上書きすると、その金額が出る', () => {
    const n = registryNotFoundCostNote({ registryYen: 999 })
    expect(n).toContain('月額999円（税込）')
    expect(n).not.toContain(`${REGISTRY_MONTHLY_YEN}円`)
  })
})

describe('cloudCost.ts の作り手は、金額を定数から取る（直書きに戻さない）', () => {
  const src = read('src/shared/cloudCost.ts')
  const body = src.slice(src.indexOf('export function registryCreateNote'), src.indexOf('export function registryDeleteLabel'))

  it('2つの作り手がどちらも `opts.registryYen ?? REGISTRY_MONTHLY_YEN` で金額を取る', () => {
    expect(count(body, 'const yen = opts.registryYen ?? REGISTRY_MONTHLY_YEN')).toBe(2)
  })

  it('作り手の中に金額の数字を書かない', () => {
    expect(body).not.toMatch(/\b220\b/)
  })
})

describe('前提チェックの「レジストリ登録」の行（AppRunPrereqChecklist）', () => {
  const NOTE = registryCreateNote()
  const render = (over: Partial<Parameters<typeof AppRunPrereqChecklist>[0]> = {}) => renderToStaticMarkup(createElement(AppRunPrereqChecklist, {
    prereqs: { builderMode: 'builtin', builder: true, registry: false },
    onOpenCredentials: () => {},
    onAutoCreateRegistry: () => {},
    regCreating: false,
    regNotice: '',
    keyReady: true,
    ...over,
  }))
  /** 「レジストリ登録」の行（`<li>` 1つ分）の文字。 */
  const registryRow = (html: string) => {
    const li = html.split('<li').find(part => part.includes('レジストリ登録'))
    expect(li, 'レジストリ登録の行がある').toBeTruthy()
    return text(li!.slice(0, li!.indexOf('</li>')))
  }

  it('✗（未登録）のとき、行の中に月額と次の操作を常に出す', () => {
    const row = registryRow(render())
    expect(row).toContain(NOTE)
    expect(row).toContain(`月額${REGISTRY_MONTHLY_YEN}円（税込）`)
    expect(row).toContain(NEXT_STEP)
  })

  it('✓（登録済み）のときは、金額も次の操作も出さず、ボタンも出さない', () => {
    const html = render({ prereqs: { builderMode: 'builtin', builder: true, registry: true } })
    expect(text(html)).not.toContain('月額')
    expect(text(html)).not.toContain('コンテナレジストリを新しく作ると')
    expect(html).not.toContain('自動作成')
    expect(registryRow(html)).toContain('✓')
  })

  it('状態が分からない（prereqs が null）ときも、作る操作が出るので金額を言う（不明を登録済みと読まない）', () => {
    const html = render({ prereqs: null })
    expect(registryRow(html)).toContain(NOTE)
    expect(html).toContain('🛠 レジストリを自動作成')
  })

  it('Docker 方式（エキスパート）でも、✗ なら金額を言う', () => {
    const html = render({ prereqs: { builderMode: 'docker', docker: true, dockerfile: true, registry: false } })
    expect(registryRow(html)).toContain(NOTE)
  })

  it('キーが未登録・作成中でも金額は出る（ボタンの hover だけに頼らない）', () => {
    expect(registryRow(render({ keyReady: false }))).toContain(NOTE)
    expect(registryRow(render({ regCreating: true }))).toContain(NOTE)
  })

  it('金額は1画面に1回だけ（ボタンの title で言い直さない）', () => {
    for (const over of [{}, { keyReady: false }, { regCreating: true }]) {
      expect(count(render(over), `${REGISTRY_MONTHLY_YEN}円`), JSON.stringify(over)).toBe(1)
    }
  })

  it('キーが未登録のときのボタンの説明は、これまでどおり', () => {
    expect(render({ keyReady: false })).toContain('title="先に認証情報でクラウドのAPIキーを登録してください"')
  })

  it('結果の知らせ（regNotice）は、これまでどおりコピーボタンつきで出る', () => {
    const html = render({ regNotice: '作成しました: example.sakuracr.jp（認証情報に保存済み）' })
    expect(text(html)).toContain('作成しました: example.sakuracr.jp（認証情報に保存済み）')
    expect(html).toContain('📋 コピー')
  })
})

describe('autoCreateRegistry に集まる入口の配線（AppRunPanel.tsx）', () => {
  const panel = read('src/renderer/components/AppRunPanel.tsx')

  it('前提チェックは切り出した部品を、同じ props で呼ぶ（古い関数は残さない）', () => {
    expect(panel).toContain(
      '<AppRunPrereqChecklist prereqs={prereqs} onOpenCredentials={onOpenCredentials} onAutoCreateRegistry={autoCreateRegistry} regCreating={regCreating} regNotice={regNotice} regNoticeFailed={regNoticeFailed} keyReady={keyReady} />',
    )
    expect(panel).toContain("import AppRunPrereqChecklist from './AppRunPrereqChecklist'")
    expect(panel).not.toContain('<PrereqChecklist')
    expect(panel).not.toContain('function PrereqChecklist')
  })

  it('結果の hint の説明は、費用の一文を作り手から取る（金額を直に組まない）', () => {
    const at = panel.indexOf("opResult.hint === 'reset-registry'")
    expect(at).toBeGreaterThan(0)
    const hint = panel.slice(at, at + 2200)
    expect(hint).toContain('{registryNotFoundCostNote()}')
    expect(hint).not.toContain('REGISTRY_MONTHLY_YEN')
    expect(hint).not.toContain('見つからない場合は新しく作るため')
    expect(hint).not.toContain('かかり始めます')
  })

  it('autoCreateRegistry を呼ぶ入口は、前提チェック1・「設定し直す」の2つのボタンだけ（増えたらここで気づく）', () => {
    expect(count(panel, 'onAutoCreateRegistry={autoCreateRegistry}')).toBe(1)
    expect(count(panel, 'onClick={autoCreateRegistry}')).toBe(2)
    expect(count(panel, 'cloud.ensureRegistry(')).toBe(1)
  })

  it('レジストリを作る口 cloud.ensureRegistry を呼ぶ画面は AppRunPanel だけ', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`
        if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue }
        if (!/\.(ts|tsx)$/.test(name)) continue
        if (read(rel).includes('cloud.ensureRegistry(')) hits.push(rel)
      }
    }
    walk('src/renderer')
    expect(hits).toEqual(['src/renderer/components/AppRunPanel.tsx'])
  })
})

describe('切り出した部品の大きさと中身', () => {
  const src = read('src/renderer/components/AppRunPrereqChecklist.tsx')

  it('400 行以下', () => {
    expect(src.split('\n').length).toBeLessThanOrEqual(400)
  })

  it('金額は作り手から取り、部品の中で定数や数字を直に組まない', () => {
    expect(src).toContain("import { registryCreateNote } from '../../shared/cloudCost'")
    expect(src).toContain('{registryCreateNote()}')
    expect(src).not.toContain('REGISTRY_MONTHLY_YEN')
    expect(src).not.toMatch(/\b220\b/)
  })
})
