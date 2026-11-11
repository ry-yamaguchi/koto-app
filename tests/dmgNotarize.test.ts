import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
// @ts-expect-error — ビルド用スクリプト（型定義は持たない）
import { darwinVersionForMacOS, setMinimumSystemVersion, minimumDarwinVersionFromPackage, pickDmgs, pickSigningIdentity, notarytoolCredentialArgs, updateDmgEntry, judgeGatekeeper, dmgsForVersion, applyMinimumSystemVersion, assertMinimumSystemVersionRecorded } from '../scripts/dmg-notarize.mjs'

// 2026-08-11。v0.3.1 の DMG が署名も公証もされていないことが分かって足した工程。
// electron-builder は .app しか公証しないので、ここが唯一の防波堤になる。
//
// **この工程が黙って何もしないのがいちばん危ない。** 「公証したつもりの DMG」を
// 配ると、利用者の最初の1操作（DMG を開く）で Gatekeeper に止められる。
// だから判定は「迷ったら止める」に倒し、それをここで固定する（掟10）。

describe('DMG の選び出し', () => {
  it('成果物から DMG だけを取る', () => {
    expect(pickDmgs([
      '/r/Koto-0.3.2-arm64.dmg',
      '/r/Koto-0.3.2-arm64-mac.zip',
      '/r/latest-mac.yml',
      '/r/Koto-0.3.2-arm64.dmg.blockmap',
    ])).toEqual(['/r/Koto-0.3.2-arm64.dmg'])
  })

  it('DMG が無ければ空（zip だけの構成でも落ちない）', () => {
    expect(pickDmgs(['/r/Koto-0.3.2-arm64-mac.zip'])).toEqual([])
    expect(pickDmgs([])).toEqual([])
    expect(pickDmgs(undefined)).toEqual([])
  })
})

describe('署名に使う証明書の選択', () => {
  const ONE = '  1) 625811BD214A424C3B43E4678C8EAEE8587E7354 "Developer ID Application: RYOSUKE YAMAGUCHI (6L9VX84LZU)"'

  it('Developer ID Application を1枚だけ見つけたら、それを使う', () => {
    const got = pickSigningIdentity(`${ONE}\n     1 valid identities found`)
    expect(got.hash).toBe('625811BD214A424C3B43E4678C8EAEE8587E7354')
    expect(got.name).toContain('RYOSUKE YAMAGUCHI')
  })

  it('証明書が無ければ止める', () => {
    expect(() => pickSigningIdentity('     0 valid identities found')).toThrow(/見つかりません/)
  })

  // 配布に使えない証明書で署名しても、公証で落ちるまで気づけない
  it('Developer ID Application 以外は使わない', () => {
    const other = '  1) AAAA1111AAAA1111AAAA1111AAAA1111AAAA1111 "Apple Development: someone (ABCDE12345)"'
    expect(() => pickSigningIdentity(other)).toThrow(/見つかりません/)
  })

  // 証明書を更新した直後は同名のものが2枚ある。古い方で署名すると公証で落ちる
  it('複数あって決められないときは、黙って選ばずに止める', () => {
    const two = `${ONE}\n  2) BBBB2222BBBB2222BBBB2222BBBB2222BBBB2222 "Developer ID Application: RYOSUKE YAMAGUCHI (ZZZZZZZZZZ)"`
    expect(() => pickSigningIdentity(two)).toThrow(/複数/)
  })

  it('Team ID を指定すれば絞り込める', () => {
    const two = `${ONE}\n  2) BBBB2222BBBB2222BBBB2222BBBB2222BBBB2222 "Developer ID Application: RYOSUKE YAMAGUCHI (ZZZZZZZZZZ)"`
    expect(pickSigningIdentity(two, '6L9VX84LZU').hash).toBe('625811BD214A424C3B43E4678C8EAEE8587E7354')
  })

  it('指定した Team ID が無ければ止める（別の証明書で代用しない）', () => {
    expect(() => pickSigningIdentity(ONE, 'NOPE000000')).toThrow(/見つかりません/)
  })
})

describe('いま作った版の DMG を選ぶ', () => {
  // release/ には過去の版が全部残してある（docs/release-flow.md「過去版を残す」）。
  // 版で絞らないと、何十個もの古い DMG を公証に出しにいくことになる
  const DIR = [
    'Koto-0.3.1-arm64.dmg', 'Koto-0.3.1-arm64-mac.zip', 'Koto-0.3.1-arm64.dmg.blockmap',
    'Koto-0.3.2-arm64.dmg', 'Koto-0.3.2-arm64-mac.zip', 'Koto-0.3.2-arm64.dmg.blockmap',
    'latest-mac.yml', 'builder-debug.yml',
  ]

  it('その版の DMG だけを取る', () => {
    expect(dmgsForVersion(DIR, '0.3.2')).toEqual(['Koto-0.3.2-arm64.dmg'])
  })

  it('過去の版を巻き込まない', () => {
    expect(dmgsForVersion(DIR, '0.3.2')).not.toContain('Koto-0.3.1-arm64.dmg')
  })

  it('zip や blockmap は取らない', () => {
    const got = dmgsForVersion(DIR, '0.3.2')
    expect(got.some((n: string) => n.endsWith('.zip') || n.endsWith('.blockmap'))).toBe(false)
  })

  // 0.3.1 を求めたときに 0.3.10 が混ざらないこと（前方一致の落とし穴）
  it('版番号の前方一致で取り違えない', () => {
    const dir = ['Koto-0.3.1-arm64.dmg', 'Koto-0.3.10-arm64.dmg']
    expect(dmgsForVersion(dir, '0.3.1')).toEqual(['Koto-0.3.1-arm64.dmg'])
  })

  it('無ければ空（呼び出し側が気づける）', () => {
    expect(dmgsForVersion(DIR, '9.9.9')).toEqual([])
  })
})

describe('Gatekeeper の判定を読む', () => {
  // 2026-08-11、実際にここで v0.3.2 のビルドを誤って止めた。
  // spctl は判定を stderr に書き、stdout は空。stdout だけを見ていたため、
  // 完全に仕上がった DMG を「拒否されました」と報告した（しかも本文が空だった）
  it('stderr に accepted と出ていれば通す（stdout は空になる）', () => {
    expect(judgeGatekeeper({
      status: 0,
      text: 'Koto-0.3.2-arm64.dmg: accepted\nsource=Notarized Developer ID',
    })).toBe(true)
  })

  it('rejected は通さない', () => {
    expect(judgeGatekeeper({
      status: 3,
      text: 'Koto-0.3.1-arm64.dmg: rejected\nsource=no usable signature',
    })).toBe(false)
  })

  // 「読めなかったから、たぶん大丈夫」にすると、今度は本当に拒否される DMG を配る
  it('出力が読めないときは通さない', () => {
    expect(judgeGatekeeper({ status: 0, text: '' })).toBe(false)
    expect(judgeGatekeeper({ status: 0, text: undefined })).toBe(false)
    expect(judgeGatekeeper({ status: null, text: 'accepted' })).toBe(false)
  })

  it('終了コードと本文の食い違いは通さない', () => {
    // 終了コードは0でも rejected と書いてあれば通さない
    expect(judgeGatekeeper({ status: 0, text: 'x: rejected' })).toBe(false)
    // accepted と書いてあっても終了コードが0でなければ通さない
    expect(judgeGatekeeper({ status: 3, text: 'x: accepted' })).toBe(false)
  })

  // 判定は「安全側に倒す」。どこかに rejected と書いてあるなら、
  // 別の行に accepted があっても通さない（掟10: 迷ったら警告）
  it('accepted と rejected が混在したら通さない', () => {
    expect(judgeGatekeeper({
      status: 0,
      text: 'a.dmg: accepted\nsource=Notarized Developer ID\nb.dmg: rejected',
    })).toBe(false)
  })
})

describe('公証の資格情報', () => {
  // electron-builder.config.js と同じ優先順位。ずれると「設定したつもりの方法と
  // 違う方法で認証して落ちる」ことになる
  it('キーチェーンのプロファイルを最優先する', () => {
    const got = notarytoolCredentialArgs({
      APPLE_KEYCHAIN_PROFILE: 'koto',
      APPLE_ID: 'a@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'x',
      APPLE_TEAM_ID: 'T',
    })
    expect(got.args).toEqual(['--keychain-profile', 'koto'])
  })

  it('次に API キー、最後に App用パスワード', () => {
    expect(notarytoolCredentialArgs({
      APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'i', APPLE_API_ISSUER: 's',
      APPLE_ID: 'a@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'x', APPLE_TEAM_ID: 'T',
    }).args).toEqual(['--key', 'k', '--key-id', 'i', '--issuer', 's'])

    expect(notarytoolCredentialArgs({
      APPLE_ID: 'a@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'x', APPLE_TEAM_ID: 'T',
    }).args).toEqual(['--apple-id', 'a@example.com', '--password', 'x', '--team-id', 'T'])
  })

  it('揃っていない資格情報は使わない（欠けたまま公証に出さない）', () => {
    expect(() => notarytoolCredentialArgs({})).toThrow()
    expect(() => notarytoolCredentialArgs({ APPLE_ID: 'a@example.com' })).toThrow()
    expect(() => notarytoolCredentialArgs({ APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'i' })).toThrow()
    expect(() => notarytoolCredentialArgs({ APPLE_ID: 'a@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'x' })).toThrow()
  })

  it('どの方法を使ったかは言うが、秘密そのものは持ち出さない', () => {
    const got = notarytoolCredentialArgs({ APPLE_KEYCHAIN_PROFILE: 'koto' })
    expect(got.method).toContain('キーチェーン')
  })
})

describe('latest-mac.yml の記録を実物に合わせる', () => {
  // 署名と staple で DMG の中身が変わる。electron-builder は署名前に yml を書くので、
  // ここで直さないと「配る記録が実物と違う」状態が残る
  const YML = [
    'version: 0.3.2',
    'files:',
    '  - url: Koto-0.3.2-arm64-mac.zip',
    '    sha512: ZIPHASH==',
    '    size: 187127012',
    '  - url: Koto-0.3.2-arm64.dmg',
    '    sha512: OLDDMGHASH==',
    '    size: 187267232',
    'path: Koto-0.3.2-arm64-mac.zip',
    'sha512: ZIPHASH==',
    "releaseDate: '2026-08-11T00:00:00.000Z'",
    '',
  ].join('\n')

  it('DMG のエントリだけを書き換える', () => {
    const out = updateDmgEntry(YML, { url: 'Koto-0.3.2-arm64.dmg', sha512: 'NEWDMGHASH==', size: 999 })
    expect(out).toContain('    sha512: NEWDMGHASH==')
    expect(out).toContain('    size: 999')
    expect(out).not.toContain('OLDDMGHASH')
  })

  // zip は自動更新が実際に使うファイル。ここを壊すと更新が落ちる
  it('zip のエントリと、更新が読む path・sha512 には触らない', () => {
    const out = updateDmgEntry(YML, { url: 'Koto-0.3.2-arm64.dmg', sha512: 'NEWDMGHASH==', size: 999 })
    expect(out).toContain('  - url: Koto-0.3.2-arm64-mac.zip\n    sha512: ZIPHASH==\n    size: 187127012')
    expect(out).toContain('path: Koto-0.3.2-arm64-mac.zip')
    expect(out.match(/^sha512: ZIPHASH==$/m)).not.toBeNull()
  })

  it('version や releaseDate を巻き込まない', () => {
    const out = updateDmgEntry(YML, { url: 'Koto-0.3.2-arm64.dmg', sha512: 'NEWDMGHASH==', size: 999 })
    expect(out).toContain('version: 0.3.2')
    expect(out).toContain("releaseDate: '2026-08-11T00:00:00.000Z'")
  })

  // electron-builder が yml の形を変えたら、黙って何もしないより止まったほうがよい
  it('対象のエントリが無ければ止める', () => {
    expect(() => updateDmgEntry(YML, { url: 'Koto-9.9.9-arm64.dmg', sha512: 'x', size: 1 })).toThrow(/見つかりません/)
  })

  it('エントリに sha512 や size が無ければ止める', () => {
    const broken = 'files:\n  - url: Koto-0.3.2-arm64.dmg\n    size: 1\n'
    expect(() => updateDmgEntry(broken, { url: 'Koto-0.3.2-arm64.dmg', sha512: 'x', size: 2 })).toThrow(/sha512/)
  })
})

// ── 試作（-rc.N）を巻き込まない（2026-08-18 実機）────────────────────────
// v0.3.34 の署名ビルドが、release/ に残っていた**未署名の rc** まで公証に出し、
// `Invalid` で ❌ を出した。**成功しているのに失敗に見える**うえ、数分待たされる。
// 版の付け方を -rc.N にしたことで新しく生まれた穴（2026-08-18 に運用を変えた）。
describe('版の DMG を選ぶ — 試作を巻き込まない', () => {
  const FILES = [
    'Koto-0.3.34-arm64.dmg',
    'Koto-0.3.34-rc.1-arm64.dmg',
    'Koto-0.3.34-rc.2-arm64.dmg',
    'Koto-0.3.33-arm64.dmg',
    'Koto-0.3.34-arm64-mac.zip',
  ]

  it('★ 0.3.34 を選ぶと、0.3.34-rc.N は入らない', () => {
    expect(dmgsForVersion(FILES, '0.3.34')).toEqual(['Koto-0.3.34-arm64.dmg'])
  })

  it('rc そのものをビルドしたときは、その rc だけを選ぶ', () => {
    expect(dmgsForVersion(FILES, '0.3.34-rc.1')).toEqual(['Koto-0.3.34-rc.1-arm64.dmg'])
  })

  it('ほかの版は巻き込まない', () => {
    expect(dmgsForVersion(FILES, '0.3.33')).toEqual(['Koto-0.3.33-arm64.dmg'])
  })
})

// ── 古い macOS へ自動更新を配らない（Electron 44 は macOS 13 以上）──────────────
describe('latest-mac.yml の minimumSystemVersion', () => {
  it('macOS の版を Darwin の版にする（13 = 22.0.0、electron-updater は os.release() と比べる）', () => {
    expect(darwinVersionForMacOS('13.0')).toBe('22.0.0')
    expect(darwinVersionForMacOS('12')).toBe('21.0.0')
    expect(darwinVersionForMacOS('14.2')).toBe('23.0.0')
    expect(darwinVersionForMacOS('11')).toBe('20.0.0')
    expect(darwinVersionForMacOS('15.1')).toBe('24.0.0')
    // macOS 26 以降は「主版 + 9」から外れる
    expect(darwinVersionForMacOS('26.0')).toBe('25.0.0')
    expect(darwinVersionForMacOS('27.2')).toBe('27.0.0')
    // 表に無い版は止める
    expect(() => darwinVersionForMacOS('28.0')).toThrow(/表にありません/)
    expect(() => darwinVersionForMacOS('16')).toThrow(/表にありません/)
    expect(() => darwinVersionForMacOS('10.15')).toThrow()
    expect(() => darwinVersionForMacOS('')).toThrow()
  })
  it('yml に足す・置き換える（何度かけても同じ）', () => {
    const yml = 'version: 0.6.29\npath: a.zip\n'
    const once = setMinimumSystemVersion(yml, '22.0.0')
    expect(once).toBe('version: 0.6.29\npath: a.zip\nminimumSystemVersion: 22.0.0\n')
    expect(setMinimumSystemVersion(once, '22.0.0')).toBe(once)
    expect(setMinimumSystemVersion(once, '23.0.0')).toContain('minimumSystemVersion: 23.0.0')
    expect(() => setMinimumSystemVersion(yml, '13')).toThrow()
  })
  it('★ 設定が無ければ止める（黙って古い OS に配らない）', () => {
    expect(() => minimumDarwinVersionFromPackage({ build: { mac: {} } })).toThrow(/minimumSystemVersion/)
    expect(minimumDarwinVersionFromPackage({ build: { mac: { minimumSystemVersion: '13.0' } } })).toBe('22.0.0')
  })
  it('★ 署名あり・なしのどちらの設定でも mac.minimumSystemVersion が 13.0（Info.plist の LSMinimumSystemVersion）', () => {
    const saved = { ...process.env }
    try {
      for (const env of [{}, { KOTO_SIGN: '1', APPLE_KEYCHAIN_PROFILE: 'koto' }]) {
        delete process.env.KOTO_SIGN; delete process.env.APPLE_KEYCHAIN_PROFILE
        Object.assign(process.env, env)
        const p = require.resolve('../electron-builder.config.js')
        delete require.cache[p]
        expect(require(p).mac.minimumSystemVersion).toBe('13.0')
      }
    } finally {
      process.env = saved
    }
  })
  it('★ dist の最後（--auto）が、署名の有無より前に yml を書く', () => {
    const src = readFileSync(join(__dirname, '..', 'scripts', 'dmg-notarize.mjs'), 'utf8')
    const auto = src.indexOf('if (auto) {')
    expect(auto).toBeGreaterThan(0)
    expect(src.indexOf('applyMinimumSystemVersion(fileURLToPath', auto)).toBeLessThan(src.indexOf("process.env.KOTO_SIGN !== '1'", auto))
  })
})

describe('latest-mac.yml への最低の版の書き込み（配線）', () => {
  const root = join(__dirname, '..')
  const base = 'version: 1.0.0\nfiles:\n  - url: a.zip\n    sha512: x\n    size: 1\npath: a.zip\n'
  const withTmp = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'koto-yml-'))
    try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('applyMinimumSystemVersion は yml に 22.0.0 を書き、2回かけても同じ', () => {
    withTmp((dir) => {
      const yml = join(dir, 'latest-mac.yml')
      writeFileSync(yml, base)
      applyMinimumSystemVersion(yml)
      const once = readFileSync(yml, 'utf8')
      expect(once).toMatch(/^minimumSystemVersion: 22\.0\.0$/m)
      applyMinimumSystemVersion(yml)
      expect(readFileSync(yml, 'utf8')).toBe(once)
      expect(once.match(/minimumSystemVersion/g)).toHaveLength(1)
    })
  })

  it('yml が無ければ止まる', () => {
    withTmp((dir) => {
      expect(() => applyMinimumSystemVersion(join(dir, 'latest-mac.yml'))).toThrow(/がありません/)
    })
  })

  it('★ --auto は release/latest-mac.yml に最低の版を書く（署名・公証・通信なしの未署名の形で実走）', () => {
    // スクリプトは自分の位置からの相対（../release・../package.json）を読むので、
    // 一時フォルダに scripts/・package.json・release/ を組んで、そこで走らせる。
    withTmp((dir) => {
      mkdirSync(join(dir, 'scripts'))
      mkdirSync(join(dir, 'release'))
      copyFileSync(join(root, 'scripts/dmg-notarize.mjs'), join(dir, 'scripts/dmg-notarize.mjs'))
      copyFileSync(join(root, 'package.json'), join(dir, 'package.json'))
      const yml = join(dir, 'release/latest-mac.yml')
      writeFileSync(yml, base)
      const env = { ...process.env }
      delete env.KOTO_SIGN // 未署名の形: 書き込みのあと何もせず終わる
      execFileSync(process.execPath, [join(dir, 'scripts/dmg-notarize.mjs'), '--auto'], { env, cwd: dir, stdio: 'pipe' })
      expect(readFileSync(yml, 'utf8')).toMatch(/^minimumSystemVersion: 22\.0\.0$/m)
    })
  })

  it('★ syncUpdateRecord の中でも applyMinimumSystemVersion を呼ぶ（署名ありの流れは実走できないのでソースで固定）', () => {
    // syncUpdateRecord は DMG の実物（署名・staple 済み）を前提にするため、テストでは走らせない。
    const src = readFileSync(join(root, 'scripts/dmg-notarize.mjs'), 'utf8')
    const start = src.indexOf('export function syncUpdateRecord')
    const end = src.indexOf('\nexport function', start + 1)
    expect(start).toBeGreaterThan(0)
    expect(src.slice(start, end)).toContain('applyMinimumSystemVersion(yml)')
  })

  it('★ --verify-only の確かめ（verifyDmg）は、yml に minimumSystemVersion が無ければ失敗にする', () => {
    withTmp((dir) => {
      const yml = join(dir, 'latest-mac.yml')
      expect(() => assertMinimumSystemVersionRecorded(yml)).toThrow(/がありません/)
      writeFileSync(yml, base)
      expect(() => assertMinimumSystemVersionRecorded(yml)).toThrow(/minimumSystemVersion がありません/)
      applyMinimumSystemVersion(yml)
      expect(() => assertMinimumSystemVersionRecorded(yml)).not.toThrow()
    })
    // verifyDmg が実際にこの確認を呼んでいること（verifyDmg は spctl を走らせるのでソースで固定）
    const src = readFileSync(join(root, 'scripts/dmg-notarize.mjs'), 'utf8')
    const start = src.indexOf('export function verifyDmg')
    const end = src.indexOf('\nexport function', start + 1)
    expect(src.slice(start, end)).toContain("assertMinimumSystemVersionRecorded(join(dirname(dmgPath), 'latest-mac.yml'))")
  })
})
