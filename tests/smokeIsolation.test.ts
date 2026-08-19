import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 2026-08-19 の事故 ────────────────────────────────────────────────
// スモークテストは、起動して11秒後に SIGTERM と pkill で**強制終了**する。
// ところが**利用者と同じ保存領域**でアプリを起動していたため、書き込みの
// 途中で殺された localStorage（leveldb）が壊れ、作り直された。
// **中央ストアに入っていたAPIキーが全部消えた**（さくらのAI Engine・Claude・
// GitHub・HANAMII）。ファイルで持っているもの（さくらのクラウド・レジストリ）
// だけが残った。Time Machine もローカルスナップショットも無く、復元できなかった。
//
// 09:00:50 スモークテスト実行 → 09:01:32 leveldb 作り直し（時刻が一致）。
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

describe('検証が、利用者の持ち物を壊さない', () => {
  const smoke = read('scripts/smoke-test.mjs')

  it('★ 使い捨ての保存領域で起動する（利用者の領域を使わない）', () => {
    expect(smoke).toContain('--user-data-dir=')
    expect(smoke).toContain('mkdtempSync')
  })

  it('★ 巻き添えで殺さない（利用者が開いている Koto に触れない）', () => {
    // 以前は `pkill -f "release/mac-arm64.*MacOS/Koto"` で、パスが一致すれば
    // 利用者が自分で開いたものまで落としていた
    expect(smoke).not.toContain('pkill -f "release/mac-arm64')
    expect(smoke).toMatch(/pkill -f "user-data-dir=/)
  })

  it('後始末する（使い捨ての領域を残さない）', () => {
    expect(smoke).toMatch(/rmSync\(PROFILE/)
  })
})

describe('同じ保存領域で2つ動かさない', () => {
  const main = read('src/main/main.ts')

  it('★ 二重起動を防ぐ', () => {
    expect(main).toContain('requestSingleInstanceLock')
  })

  it('★ 黙って前の窓を出さない（別の版を試しているつもりで古い版を見る事故を防ぐ）', () => {
    // 後から起動したほうは、何が起きたかを伝えて終了する
    // ダイアログ本体は関数へ切り出した（相手が名乗らない場合の経路でも使うため）
    expect(main).toContain('warnAlreadyRunningAndQuit')
    expect(main).toMatch(/function warnAlreadyRunningAndQuit[\s\S]{0,400}showMessageBoxSync/)
    expect(main).toContain('すでに起動しています')
  })
})

// ── 2026-08-19 実機: 二重起動の守りを入れた副作用 ──────────────────────
// 「A JavaScript error occurred in the main process /
//   Cannot create BrowserWindow before app is ready」が利用者の画面に出た。
// `activate`（Dock やアイコンのクリック）は**準備前にも飛ぶ**うえ、
// 二重起動で終了しようとしている側にも飛ぶ。そのまま窓を作ると落ちる。
describe('準備前に窓を作らない', () => {
  const main = readFileSync(join(__dirname, '..', 'src/main/main.ts'), 'utf-8')

  it('★ activate では、準備できてから作る', () => {
    expect(main).toMatch(/app\.on\('activate'[\s\S]{0,300}app\.isReady\(\)/)
  })

  it('★ 終了しようとしている側（鍵を持たない）では作らない', () => {
    expect(main).toMatch(/app\.on\('activate'[\s\S]{0,300}hasSingleInstanceLock\(\)/)
  })
})
