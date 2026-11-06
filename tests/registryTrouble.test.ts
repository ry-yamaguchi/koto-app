import { describe, it, expect } from 'vitest'
import { looksLikeRegistryProblem } from '../src/shared/registryTrouble'

// 2026-08-14 実機。レジストリをコンパネで消したあと公開すると
// 「アプリの組み立てに失敗しました」とだけ出て、**回復のボタンが出なかった**。
// 導線は作ってあったのに、印を付けるのが Docker の経路だけだった。
describe('レジストリが原因らしい失敗を見分ける', () => {
  // ★ 2026-08-14 の実機ログ（そのまま）。これを取り違えると、また袋小路になる
  it('★ 実機で出たログを拾う（レジストリが削除済み）', () => {
    const real = 'Error: pushing sample-data-cd35.sakuracr.jp/data-test:latest: '
      + 'GET https://auth.sakuracr.jp/token/?scope=repository%3Adata-test%3Apush%2Cpull&service=sample-data-cd35.sakuracr.jp: '
      + 'unexpected status code 404 Not Found: {"error": "unknown service"}'
    expect(looksLikeRegistryProblem(real)).toBe(true)
  })

  it('消えたレジストリへの push を拾う', () => {
    expect(looksLikeRegistryProblem('Error: HEAD https://sample-data-cd35.sakuracr.jp/v2/: 401 Unauthorized')).toBe(true)
    expect(looksLikeRegistryProblem('dial tcp: lookup sample-data-cd35.sakuracr.jp: no such host')).toBe(true)
    expect(looksLikeRegistryProblem('denied: requested access to the resource is denied')).toBe(true)
    expect(looksLikeRegistryProblem('NAME_UNKNOWN: repository name not known to registry')).toBe(true)
  })

  // **広げすぎない。** コードが悪いのに「レジストリを直せ」と言うと、
  // 関係のない操作をさせることになる
  it('コード側の失敗は拾わない', () => {
    expect(looksLikeRegistryProblem('tar: app/server.js: Cannot open: Permission denied')).toBe(true) // denied は含む（境界）
    expect(looksLikeRegistryProblem('SyntaxError: Unexpected token in package.json')).toBe(false)
    expect(looksLikeRegistryProblem('ファイル層の作成に失敗しました')).toBe(false)
  })

  it('空でも落ちない', () => {
    expect(looksLikeRegistryProblem('')).toBe(false)
    expect(looksLikeRegistryProblem(undefined as any)).toBe(false)
  })
})

// 手元のファイルの失敗は、レジストリの不調ではない（`EACCES: permission denied` の denied をレジストリの拒否と取り違えない）
describe('手元のファイルの失敗（errno の文）は、レジストリの不調に数えない', () => {
  it('EACCES・EPERM・ENOSPC・ENOENT の文', () => {
    expect(looksLikeRegistryProblem("EACCES: permission denied, open '/Users/me/app/a.txt'")).toBe(false)
    expect(looksLikeRegistryProblem("EPERM: operation not permitted, copyfile '/x' -> '/y'")).toBe(false)
    expect(looksLikeRegistryProblem('ENOSPC: no space left on device, write')).toBe(false)
    expect(looksLikeRegistryProblem("ENOENT: no such file or directory, open '/x/not found.txt'")).toBe(false)
  })

  it('errno の行のほかに、レジストリの印の行があれば、レジストリの不調のまま', () => {
    expect(looksLikeRegistryProblem("EACCES: permission denied, open '/x'\nGET https://auth.sakuracr.jp/token: unknown service")).toBe(true)
    expect(looksLikeRegistryProblem("ENOENT: x\ndial tcp: lookup a.sakuracr.jp: no such host")).toBe(true)
  })

  it('errno が無い denied は、今までどおり（境界）', () => {
    expect(looksLikeRegistryProblem('denied: requested access to the resource is denied')).toBe(true)
  })
})

