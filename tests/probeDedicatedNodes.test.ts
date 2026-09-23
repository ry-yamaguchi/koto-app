import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// roadmap #23（docs/apprun-dedicated-plan.md 12-4）。
// scripts/probe-dedicated-nodes.mjs は、AppRun 専有型を「作る→壊す」の作った直後に
// Ryosuke さんが手で実行する GET だけの疎通スクリプト。ソースをコンパイル・実行はせず、
// **ソースを文字列として読み**、掟に反する形（書き込み系メソッド・maxItems 抜け・
// 秘密の出力）が入っていないことを固定する（tests/apprunDedicatedWiring.test.ts と同じ
// 「ソースを読んで配線を確かめる」形）。ネットワークへは出ない。

const src = readFileSync(join(__dirname, '..', 'scripts/probe-dedicated-nodes.mjs'), 'utf-8')

describe('probe-dedicated-nodes.mjs: GETのみ（書き込み系メソッドが1つも無い）', () => {
  it('method: に POST/PUT/PATCH/DELETE が1つも無い', () => {
    const methodValues = [...src.matchAll(/method:\s*['"]([A-Za-z]+)['"]/g)].map(m => m[1].toUpperCase())
    expect(methodValues.length).toBeGreaterThan(0) // fetch の method: 自体は使っている（GETのみ）
    for (const v of methodValues) {
      expect(['POST', 'PUT', 'PATCH', 'DELETE']).not.toContain(v)
    }
  })

  it('POST/PUT/PATCH/DELETE がコード上の値（クォート付き）として1つも現れない（説明文中の言及は除く）', () => {
    expect(src).not.toMatch(/['"]POST['"]/)
    expect(src).not.toMatch(/['"]PUT['"]/)
    expect(src).not.toMatch(/['"]PATCH['"]/)
    expect(src).not.toMatch(/['"]DELETE['"]/)
  })
})

// ⚠️ ヘッダコメント（①〜⑦の手順書き）にも "maxItems=20" という文字列が出てくるため、
// ソース全体への toContain だけでは「実際の get() 呼び出し」からではなく**コメントから**
// マッチしてしまい、コードの maxItems を外す変異を見逃す（掟10「当て先が他の行に出ないか
// 確認する」・2026-08-20 の4連続失敗と同じ形）。**実際の get(...) 呼び出しの引数だけ**を
// 抜き出して確かめる。
function extractGetCallArgs(source: string): string[] {
  const re = /await get\(\s*(`[^`]*`|'[^']*'|"[^"]*")\s*\)/g
  return [...source.matchAll(re)].map(m => m[1])
}

function findUniqueCallContaining(calls: string[], marker: string): string {
  const found = calls.filter(c => c.includes(marker))
  expect(found.length).toBe(1) // マーカーが複数の呼び出しに当たっていないことも確認する
  return found[0]
}

describe('probe-dedicated-nodes.mjs: 一覧系6本の get() 呼び出しすべてに maxItems= が付いている（5-1・付け忘れは400）', () => {
  const calls = extractGetCallArgs(src)

  it('get(...) の呼び出しが7個ある（①clusters ②cluster詳細 ③asg ④worker_nodes ⑤load_balancers ⑥load_balancer_nodes ⑦applications）', () => {
    expect(calls.length).toBe(7)
  })

  it('① GET /clusters?maxItems=20', () => {
    expect(findUniqueCallContaining(calls, "'clusters?")).toContain('maxItems=20')
  })
  it('③ GET .../asg?maxItems=20', () => {
    expect(findUniqueCallContaining(calls, '/asg?')).toContain('maxItems=20')
  })
  it('④ GET .../worker_nodes?maxItems=20', () => {
    expect(findUniqueCallContaining(calls, '/worker_nodes?')).toContain('maxItems=20')
  })
  it('⑤ GET .../load_balancers?maxItems=20', () => {
    expect(findUniqueCallContaining(calls, '/load_balancers?')).toContain('maxItems=20')
  })
  it('⑥ GET .../load_balancer_nodes?maxItems=20', () => {
    expect(findUniqueCallContaining(calls, 'load_balancer_nodes')).toContain('maxItems=20')
  })
  it('⑦ GET /applications?clusterID=...&maxItems=20', () => {
    const call = findUniqueCallContaining(calls, 'applications?clusterID=')
    expect(call).toContain('maxItems=20')
  })
})

describe('probe-dedicated-nodes.mjs: 環境変数名の両対応（既存probeと同じ受け方）', () => {
  it('SAKURA_TOKEN / SAKURA_CLOUD_TOKEN / SAKURA_SECRET / SAKURA_CLOUD_SECRET の4つが含まれる', () => {
    expect(src).toContain('SAKURA_TOKEN')
    expect(src).toContain('SAKURA_CLOUD_TOKEN')
    expect(src).toContain('SAKURA_SECRET')
    expect(src).toContain('SAKURA_CLOUD_SECRET')
  })

  it('TOKEN/SECRET は両方の環境変数名を || で受けている', () => {
    expect(src).toContain("process.env.SAKURA_TOKEN || process.env.SAKURA_CLOUD_TOKEN")
    expect(src).toContain("process.env.SAKURA_SECRET || process.env.SAKURA_CLOUD_SECRET")
  })
})

describe('probe-dedicated-nodes.mjs: 「コマンド行は貼らない」の注意書きがある', () => {
  it('コマンド行を貼らないよう明記している', () => {
    expect(src).toMatch(/コマンド行.*貼らない/)
  })
})

describe('probe-dedicated-nodes.mjs: Authorization ヘッダやトークンの値を出力していない', () => {
  it('console.log / console.error の呼び出しに TOKEN・SECRET・authHeader という識別子が現れない', () => {
    const logLines = src.split('\n').filter(l => /console\.(log|error)\(/.test(l))
    expect(logLines.length).toBeGreaterThan(0)
    for (const l of logLines) {
      expect(l).not.toMatch(/\bTOKEN\b/)
      expect(l).not.toMatch(/\bSECRET\b/)
      expect(l).not.toMatch(/\bauthHeader\b/)
    }
  })

  it('Authorization ヘッダの値は Basic 認証の組み立て（1箇所）にしか登場しない', () => {
    const occurrences = (src.match(/Authorization:/g) ?? []).length
    expect(occurrences).toBe(1)
  })
})

describe('probe-dedicated-nodes.mjs: 途中で失敗しても次へ進む（1つの失敗で全部が見えなくならない）', () => {
  it('showFailure で continue し、①〜⑦の途中では process.exit しない（呼ぶのは冒頭の未設定チェックと末尾のcatchのみ）', () => {
    // 冒頭のトークン未設定チェックと、想定外の例外を拾う末尾の catch 以外に
    // process.exit を呼んでいないこと（main の①〜⑦の各ステップは showFailure → continue で先へ進む設計）
    const exitCalls = (src.match(/process\.exit\(/g) ?? []).length
    expect(exitCalls).toBe(2)
    // ①〜⑦の中（showFailure の呼び出し箇所）に process.exit が無いことも確かめる
    const stepsBlock = src.slice(src.indexOf('① クラスタ一覧'), src.lastIndexOf('showFailure('))
    expect(stepsBlock).not.toContain('process.exit(')
  })

  it('4000字を超える応答本文は打ち切り、省略した事実を明記する', () => {
    expect(src).toContain('MAX_BODY_CHARS')
    expect(src).toMatch(/省略/)
  })
})

describe('probe-dedicated-nodes.mjs: クラスタが 0 件のときの案内（2026-09-11 に実行順を取り違えたため）', () => {
  it('0 件なら「⑤で作った直後に実行」を案内する', () => {
    expect(src).toMatch(/clusters\.length === 0/)
    expect(src).toMatch(/0 件.*作った直後/)
  })
})
