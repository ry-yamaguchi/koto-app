import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePsLine, isKotoMain, userDataDirOf, findOtherKoto, isDefaultDir } from '../src/shared/singleInstance'

// ── 2026-08-19 実機 ──────────────────────────────────────────────────
// requestSingleInstanceLock は**互いに名乗り合う**仕組みなので、相手が古い版だと効かない。
//   ・rc（守りあり）が先 → 正式版（守りなし）が異常終了した
//   ・正式版（守りなし）が先 → 鍵は誰も握っていないので rc も開いてしまう
// 相手が名乗らないなら、こちらから見に行く。

const HOME = '/Users/x/Library/Application Support/Koto'
const PS = [
  '  501 /Applications/Koto.app/Contents/MacOS/Koto',
  '  502 /Applications/Koto.app/Contents/Frameworks/Koto Helper (Renderer).app/Contents/MacOS/Koto Helper (Renderer) --type=renderer',
  '  777 /Users/x/sakura-ide/release/mac-arm64/Koto.app/Contents/MacOS/Koto --user-data-dir=/tmp/throwaway',
  '  900 /Applications/Safari.app/Contents/MacOS/Safari',
].join('\n')

describe('プロセス一覧を読む', () => {
  it('pid とコマンドに分ける', () => {
    expect(parsePsLine('  501 /Applications/Koto.app/Contents/MacOS/Koto'))
      .toEqual({ pid: 501, command: '/Applications/Koto.app/Contents/MacOS/Koto' })
    expect(parsePsLine('こわれた行')).toBeNull()
  })

  it('★ 画面や補助のプロセスは数えない（数えると必ず二重起動に見える）', () => {
    expect(isKotoMain('/Applications/Koto.app/Contents/MacOS/Koto')).toBe(true)
    expect(isKotoMain('/Applications/Koto.app/Contents/Frameworks/Koto Helper (Renderer).app/Contents/MacOS/Koto Helper (Renderer)')).toBe(false)
    expect(isKotoMain('/Applications/Safari.app/Contents/MacOS/Safari')).toBe(false)
  })

  it('使っている保存領域を読む', () => {
    expect(userDataDirOf('… --user-data-dir=/tmp/x')).toBe('/tmp/x')
    expect(userDataDirOf('… --user-data-dir="/tmp/a b"')).toBe('/tmp/a b')
    expect(userDataDirOf('… なし')).toBeNull()   // 指定なし＝既定の場所
  })
})

describe('同じ保存領域の別の Koto を見つける', () => {
  it('★ 既定の保存領域どうしなら見つける（古い版が先に動いている形）', () => {
    expect(findOtherKoto({ psOutput: PS, myPid: 777, myUserDataDir: HOME })).toEqual({ pid: 501 })
  })

  it('★ 保存領域が違えば、二重起動ではない（検証用の使い捨てなど）', () => {
    expect(findOtherKoto({ psOutput: PS, myPid: 501, myUserDataDir: '/tmp/throwaway2' })).toBeNull()
  })

  it('自分自身は数えない', () => {
    expect(findOtherKoto({ psOutput: '  501 /Applications/Koto.app/Contents/MacOS/Koto', myPid: 501, myUserDataDir: HOME })).toBeNull()
  })

  it('★ 読めなければ通す（これは追加の守りであって、唯一の砦ではない）', () => {
    expect(findOtherKoto({ psOutput: '', myPid: 1, myUserDataDir: HOME })).toBeNull()
  })

  it('既定の保存領域を見分ける', () => {
    expect(isDefaultDir(HOME)).toBe(true)
    expect(isDefaultDir('/tmp/throwaway')).toBe(false)
  })
})

// ── 配線（判断だけ正しくても、止まらなければ意味がない）────────────────────
describe('二重起動を、相手が名乗らなくても止める', () => {
  const main = readFileSync(join(__dirname, '..', 'src/main/main.ts'), 'utf-8')

  it('★ こちらから見に行く（相手が古い版でも効くように）', () => {
    expect(main).toContain('findOtherKoto')
    // 判断をログに残すため、鍵の取得は変数へ受けている（2026-08-19）
    expect(main).toMatch(/const gotLock = app\.requestSingleInstanceLock\(\)/)
    expect(main).toMatch(/if \(!gotLock \|\| anotherKotoIsRunning\(\)\)/)
  })

  it('★ 読めなければ通す（起動できなくなるほうが害が大きい）', () => {
    // 例外の中身もログに残すようにしたので、catch 節は1行ではない
    expect(main).toMatch(/catch \(e: any\) \{[\s\S]{0,200}return false/)
  })
})
