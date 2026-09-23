import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

// ── `npm install` の代わりに、npm が作るのと同じ形の node_modules を置く（検分の指摘・2026-09-16）──
//
// `stageAndTar` は copyTree の**あと**に `installDependencies`（`npm install`）を走らせる。
// 本物を呼ぶとネットワークが要り、mode も走らせた機械の umask 次第になってしまうので、
// **npm が作る形**（フォルダ `0o755`・ファイル `0o666`／実行物 `0o777`）を置く偽物に差し替える。
// これで「node_modules も書庫では他人が書けない」を、**実際に layer.tar を読んで**確かめられる
// （ソースに `normalizeStageTree(appDir)` と書いてあるかを見るだけの検査は、
// その行をコメントにする変異を**素通りさせた**。掟10「当て先が他の行に出ないか確かめる」）。
// 依存が無いプロジェクト（このファイルの他の試験）では、そもそも呼ばれない。
vi.mock('../src/main/cloud/npmInstall', () => ({
  installDependencies: async (appDir: string) => {
    const dir = path.join(appDir, 'node_modules', 'left-pad')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports=1')
    fs.chmodSync(path.join(dir, 'index.js'), 0o666)
    fs.writeFileSync(path.join(dir, 'cli.js'), '#!/usr/bin/env node\n')
    fs.chmodSync(path.join(dir, 'cli.js'), 0o777)
    fs.chmodSync(dir, 0o755)
    fs.chmodSync(path.join(appDir, 'node_modules'), 0o755)
    return { ok: true, nativeBlocked: [], log: '' }
  },
}))

import { copyTree, stageAndTar, fileModeForImage, normalizeStageTree } from '../src/main/cloud/imageBuild'

// D-8（2026-09-16 実機・0.6.19-rc.1・専有型）。
//
// 専有型に公開したアプリが **1分ごとに再起動を繰り返していた**（コンテナIDが毎回変わる）。
// コントロールパネルのランタイムログの全文:
//   Error: EACCES: permission denied, mkdir '/app/data'
//     at Object.mkdirSync (node:fs:1370:26)
//     at Object.<anonymous> (/app/server.js:39:6)
//   errno: -13, code: 'EACCES', syscall: 'mkdir', path: '/app/data'
//
// **専有型のコンテナは uid 951:gid 951 で動く**（さくらのマニュアル「技術概要 →
// コンテナ実行環境仕様」）。`copyTree` はフォルダに `0o555`（読む・辿るだけ）しか与えて
// いなかったので、`/app` に自分のデータフォルダすら作れなかった。**同じ像で共用型では
// 動いていた**（事実）。共用型のコンテナがどの uid で動くかは**未確認**なので、
// 「root だから書けていた」とは書かない（確かめていないことを理由にしない・掟1）。
//
// **ソースの文字列を読むだけの検査では「そう書いてあるか」しか分からない**（掟10）。
// ここでは一時フォルダへ実際にコピーさせ、`fs.statSync` の mode を見る。

let tmp = ''
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-imagebuildperm-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

/** mode の下12ビット（パーミッション）だけを取り出す。 */
function modeOf(p: string): number {
  return fs.statSync(p).mode & 0o7777
}

// ── D-13 A: 像に入れるファイルの mode を決める純関数（式そのものを固定する）───────────
//
// 式は `(mode | 0o444) & ~0o022`。
//   ・`| 0o444` ＝ コンテナの中の誰でも**読める**ようにする（2026-08-14 の `EACCES`）
//   ・`& ~0o022` ＝ **グループと他人の書き込みだけ**を落とす（その場の上書きを止める）
// **実行ビットは奪わない**（`0o755` のスクリプトが動かなくなる）。
// **所有者の w には触らない**（像の中の所有者はビルドした人の番号で、コンテナの実行ユーザとは別）。
describe('fileModeForImage: 読みを足し、他人の書き込みだけを落とす（純関数・D-13 A）', () => {
  const oct = (n: number): string => n.toString(8)

  it('★★ 0o666（手元でよくある形）→ 0o644（グループ・その他の w が落ちる）', () => {
    expect(oct(fileModeForImage(0o666))).toBe(oct(0o644))
  })

  it('★★ 0o777 → 0o755（実行ビットは残し、他人の w だけ落とす）', () => {
    expect(oct(fileModeForImage(0o777))).toBe(oct(0o755))
  })

  it('★★ 0o755（スクリプト）はそのまま（奪うものが無い）', () => {
    expect(oct(fileModeForImage(0o755))).toBe(oct(0o755))
  })

  it('★★ 0o600（2026-08-14 の EACCES の形）→ 0o644（読みが足される）', () => {
    expect(oct(fileModeForImage(0o600))).toBe(oct(0o644))
  })

  it('★★ 0o400（読み取り専用）→ 0o444（所有者の w を勝手に与えない）', () => {
    expect(oct(fileModeForImage(0o400))).toBe(oct(0o444))
  })

  it('★★ 所有者の書き込み（0o200）は残す——像の所有者はビルドした人の番号で、コンテナの実行ユーザとは別', () => {
    expect(fileModeForImage(0o644) & 0o200).toBe(0o200)
    expect(fileModeForImage(0o666) & 0o200).toBe(0o200)
  })

  it('★★ どんな入力でも、グループ・その他の w は必ず 0 になり、読みは必ず立つ', () => {
    for (let m = 0; m <= 0o777; m++) {
      const next = fileModeForImage(m)
      expect(next & 0o022, `mode=${oct(m)} → ${oct(next)}`).toBe(0)
      expect(next & 0o444, `mode=${oct(m)} → ${oct(next)}`).toBe(0o444)
      // 実行ビットは1つも奪わない（入力にあったものは必ず残る）
      expect(next & (m & 0o111), `mode=${oct(m)} → ${oct(next)}`).toBe(m & 0o111)
    }
  })
})

describe('copyTree: 像に入るフォルダは書ける・ファイルは他人が書き換えられない（D-8・D-13 A）', () => {
  // ⚠️ ここで見ているのは**ステージング（配る複製）のフォルダの mode** であって、
  // 書庫（layer.tar）の中身ではない。像に効くこと＝**tar に mode が保たれること**は、
  // このファイル末尾の describe（stageAndTar）が layer.tar を読んで固定する。
  it('★★ ステージングの一番上のフォルダ（のちに /app になるもの）に書き込みが付く（ここが 0o555 だと mkdir /app/data が EACCES）', () => {
    const src = path.join(tmp, 'src')
    const dest = path.join(tmp, 'dest', 'app')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'server.js'), 'console.log(1)')
    copyTree(src, dest)

    const mode = modeOf(dest)
    // 所有者・グループ・その他の**すべて**に w が要る。コンテナは uid 951:gid 951 で動く一方、
    // フォルダの所有者は**ビルドした人の uid**のまま（`copyTree` も `stageAndTar` も chown しない）で、
    // その番号が 951 と一致する保証はどこにも無いため、other の w が無いと書けないことがある。
    expect(mode & 0o222, `一番上のフォルダに書き込みが無い（mode=${mode.toString(8)}）`).toBe(0o222)
    // 読み・辿るも従来どおり付いている
    expect(mode & 0o555).toBe(0o555)
  })

  // スティッキービット（2026-09-16 Ryosuke さんの問い）。
  // `0o777` のままだと、**フォルダの中のファイルを消して置き換え**られる——ファイルを `0o444`
  // にしても、消せるかどうかは**親フォルダの権限**で決まるため、アプリのコードが実質的に
  // 差し替え可能になる。スティッキー（`/tmp` と同じ）なら「新しく作るのは誰でもできるが、
  // 他人が作ったものは消せない」になる。
  it('★★ ステージングのフォルダにスティッキービットが付く（0o777 だと像のファイルを消して置き換えられる）', () => {
    const src = path.join(tmp, 'src')
    fs.mkdirSync(path.join(src, 'public'), { recursive: true })
    fs.writeFileSync(path.join(src, 'server.js'), 'console.log(1)')
    fs.writeFileSync(path.join(src, 'public', 'index.html'), '<p>hi</p>')
    const dest = path.join(tmp, 'dest', 'app')
    copyTree(src, dest)

    const top = modeOf(dest)
    expect(top & 0o1000, `一番上のフォルダにスティッキービットが無い（mode=${top.toString(8)}）`).toBe(0o1000)
    // 書き込み・読み・辿るは落ちていない（スティッキーだけ立てて他を奪っていないこと）
    expect(top & 0o777).toBe(0o777)
    const nested = modeOf(path.join(dest, 'public'))
    expect(nested & 0o1000, `入れ子のフォルダにスティッキービットが無い（mode=${nested.toString(8)}）`).toBe(0o1000)
  })

  it('★★ 入れ子のフォルダにも同じ権限が付く（アプリが深い場所にフォルダを作れる）', () => {
    const src = path.join(tmp, 'src')
    fs.mkdirSync(path.join(src, 'public', 'assets'), { recursive: true })
    fs.writeFileSync(path.join(src, 'public', 'assets', 'a.css'), 'body{}')
    // 手元が読み取り専用（0o500）でも、配る複製では書けるようにする
    fs.chmodSync(path.join(src, 'public'), 0o500)
    const dest = path.join(tmp, 'dest', 'app')
    copyTree(src, dest)
    // 後始末（rmSync）のために手元の権限を戻す。0o500 のままだと中身を消せない
    fs.chmodSync(path.join(src, 'public'), 0o700)

    expect(modeOf(path.join(dest, 'public')) & 0o222).toBe(0o222)
    expect(modeOf(path.join(dest, 'public', 'assets')) & 0o222).toBe(0o222)
  })

  it('★★ ファイルは読み取り専用のまま（書き込みを与えない。アプリのコードは像の中で書き換わらないほうがよい）', () => {
    const src = path.join(tmp, 'src')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'server.js'), 'console.log(1)')
    fs.chmodSync(path.join(src, 'server.js'), 0o400) // 手元が読み取り専用
    const dest = path.join(tmp, 'dest', 'app')
    copyTree(src, dest)

    const mode = modeOf(path.join(dest, 'server.js'))
    expect(mode & 0o444, 'コンテナの中で読めない').toBe(0o444) // 読めること（2026-08-14 の EACCES）
    expect(mode & 0o222, `ファイルに書き込みが付いている（mode=${mode.toString(8)}）`).toBe(0) // 書けないこと
  })

  it('★★ 実行ビットは奪わない（0o755 のスクリプトが動かなくならない）', () => {
    const src = path.join(tmp, 'src')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'run.sh'), '#!/bin/sh\n')
    fs.chmodSync(path.join(src, 'run.sh'), 0o755)
    const dest = path.join(tmp, 'dest', 'app')
    copyTree(src, dest)

    const mode = modeOf(path.join(dest, 'run.sh'))
    expect(mode & 0o111, `実行ビットを奪っている（mode=${mode.toString(8)}）`).toBe(0o111)
    // 読みは残り、他人の書き込みは無い（0o755 はもともと他人に w が無い）
    expect(mode & 0o444).toBe(0o444)
    expect(mode & 0o022).toBe(0)
  })

  // ── D-13 A（2026-09-16）: 「書き換えられません」を**本当にそうする** ──────────────────
  // スティッキービットは「**消して置き換える**」を防ぐが、「**その場の上書き**」は防がない。
  // 以前の `addPermission(dest, 0o444)` は**足すだけ**だったので、手元が `0o666`/`0o777` の
  // ファイルはグループ・その他の w を持ったまま像に入り、**所有者と違う実行ユーザで動く
  // コンテナから上書きできた**。README・使い方ガイド・CHANGELOG の「最初から入っている
  // ファイルは書き換えられません」は、その状態では言い切れない。
  it('★★ 手元が 0o666 のファイルは、像では他人の書き込みが落ちている（上書きを防ぐ・D-13 A）', () => {
    const src = path.join(tmp, 'src')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'data.json'), '{}')
    fs.chmodSync(path.join(src, 'data.json'), 0o666) // 利用者の手元がこうなっていることはふつうにある
    const dest = path.join(tmp, 'dest', 'app')
    copyTree(src, dest)

    const mode = modeOf(path.join(dest, 'data.json'))
    expect(mode & 0o022, `グループ・その他の書き込みが残っている（mode=${mode.toString(8)}）`).toBe(0)
    expect(mode & 0o444, 'コンテナの中で読めない').toBe(0o444)
  })

  it('★★ 手元が 0o777 の実行ファイルでも、他人の書き込みだけが落ちて実行ビットは残る', () => {
    const src = path.join(tmp, 'src')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'run.sh'), '#!/bin/sh\n')
    fs.chmodSync(path.join(src, 'run.sh'), 0o777)
    const dest = path.join(tmp, 'dest', 'app')
    copyTree(src, dest)

    const mode = modeOf(path.join(dest, 'run.sh'))
    expect(mode & 0o022, `グループ・その他の書き込みが残っている（mode=${mode.toString(8)}）`).toBe(0)
    expect(mode & 0o111, `実行ビットを奪っている（mode=${mode.toString(8)}）`).toBe(0o111)
  })

  it('★★ 手元が 0o600 なら、読みが足される（他人の書き込みは元から無い）', () => {
    const src = path.join(tmp, 'src')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'koto-data.js'), 'module.exports={}')
    fs.chmodSync(path.join(src, 'koto-data.js'), 0o600) // 2026-08-14 の EACCES はこの形
    const dest = path.join(tmp, 'dest', 'app')
    copyTree(src, dest)

    const mode = modeOf(path.join(dest, 'koto-data.js'))
    expect(mode & 0o444, 'コンテナの中で読めない').toBe(0o444)
    expect(mode & 0o022).toBe(0)
  })

  it('★ 所有者（uid/gid）は変えない（特定の番号に寄せると、番号の違う公開先で壊れる）', () => {
    const src = path.join(tmp, 'src')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'a.txt'), 'x')
    const dest = path.join(tmp, 'dest', 'app')
    copyTree(src, dest)

    const before = fs.statSync(src)
    const after = fs.statSync(dest)
    expect(after.uid).toBe(before.uid)
    expect(after.gid).toBe(before.gid)
  })

  it('★ 秘密ファイル（.env）と除外フォルダ（node_modules）は、そもそも複製されない', () => {
    const src = path.join(tmp, 'src')
    fs.mkdirSync(path.join(src, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(src, 'node_modules', 'x.js'), '1')
    fs.writeFileSync(path.join(src, '.env'), 'SECRET=1')
    fs.writeFileSync(path.join(src, 'index.html'), '<p>hi</p>')
    const dest = path.join(tmp, 'dest', 'app')
    copyTree(src, dest)

    expect(fs.existsSync(path.join(dest, '.env'))).toBe(false)
    expect(fs.existsSync(path.join(dest, 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(dest, 'index.html'))).toBe(true)
  })
})

// ── normalizeStageTree: copyTree が通らないもの（node_modules）を、書庫の直前でそろえる ────
//
// 検分の指摘（medium・2026-09-16）: **`copyTree` が mode を決められるのは「手元から複製した分」
// だけだった。** `node_modules` は上の試験のとおり複製の対象外で、`stageAndTar` が copyTree の
// **あとに** `installDependencies`（`npm install`）で作り直す。つまり:
//   ・ファイルは `fileModeForImage` を**一度も通らない**（mode は npm と umask 任せ。
//     既定の umask 022 なら他人の w は立たないが、**緩い umask の機械では立ちうる**）
//   ・フォルダは npm が作る `0o755` のままで、アプリはその中にファイルを作れない
//     （D-8 で `/app` 全体に与えたはずの前提から、node_modules だけが外れていた）
// **README・使い方ガイドは「最初から入っているファイル」と広く書いている**ので、ここだけ
// 守りの外にあるのは食い違いである。`stageAndTar` は tar の直前に `normalizeStageTree` を通す。
//
// ここでは `npm install` を走らせずに、**npm が作るのと同じ形**（`0o755` のフォルダ・
// `0o666` のファイル）を手で置いて、実際に mode が変わることを見る（掟10・ソースの文字列ではなく振る舞い）。
describe('normalizeStageTree: npm が作った node_modules も同じ形にそろえる（検分の指摘・2026-09-16）', () => {
  /** npm install のあとのステージングに近い形を作る。 */
  function makeStage(): string {
    const appDir = path.join(tmp, 'stage', 'app')
    fs.mkdirSync(path.join(appDir, 'node_modules', 'left-pad'), { recursive: true })
    fs.writeFileSync(path.join(appDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1')
    fs.chmodSync(path.join(appDir, 'node_modules', 'left-pad', 'index.js'), 0o666) // umask が緩い機械の形
    fs.writeFileSync(path.join(appDir, 'node_modules', 'left-pad', 'cli.js'), '#!/usr/bin/env node\n')
    fs.chmodSync(path.join(appDir, 'node_modules', 'left-pad', 'cli.js'), 0o777)
    fs.chmodSync(path.join(appDir, 'node_modules', 'left-pad'), 0o755) // npm が作るフォルダ
    fs.chmodSync(path.join(appDir, 'node_modules'), 0o755)
    return appDir
  }

  it('★★ node_modules 配下のファイルから、グループと他人の書き込みが落ちる（copyTree を通らない分の穴）', () => {
    const appDir = makeStage()
    const f = path.join(appDir, 'node_modules', 'left-pad', 'index.js')
    expect(modeOf(f) & 0o022, '前提（0o666 で置けている）が崩れている').toBe(0o022)

    normalizeStageTree(appDir)

    expect(modeOf(f) & 0o022, `node_modules のファイルが w を持ったまま（mode=${modeOf(f).toString(8)}）`).toBe(0)
    expect(modeOf(f) & 0o444, 'コンテナの中で読めない').toBe(0o444)
  })

  it('★★ node_modules の実行ファイル（0o777）でも、実行ビットは残る（.bin から呼ばれるスクリプトを殺さない）', () => {
    const appDir = makeStage()
    const cli = path.join(appDir, 'node_modules', 'left-pad', 'cli.js')

    normalizeStageTree(appDir)

    expect(modeOf(cli) & 0o022).toBe(0)
    expect(modeOf(cli) & 0o111, `実行ビットを奪っている（mode=${modeOf(cli).toString(8)}）`).toBe(0o111)
  })

  it('★★ node_modules のフォルダにも書き込みとスティッキーが付く（ここだけ D-8 の前提から外れていた）', () => {
    const appDir = makeStage()
    const dir = path.join(appDir, 'node_modules', 'left-pad')
    expect(modeOf(dir), '前提（npm が作る 0o755）が崩れている').toBe(0o755)

    normalizeStageTree(appDir)

    expect(modeOf(dir) & 0o222, `node_modules のフォルダに書き込みが無い（mode=${modeOf(dir).toString(8)}）`).toBe(0o222)
    expect(modeOf(dir) & 0o1000, 'スティッキーが無い（他人のファイルを消して置き換えられる）').toBe(0o1000)
    expect(modeOf(path.join(appDir, 'node_modules')) & 0o1222).toBe(0o1222)
    // 一番上（のちの /app）も同じ形になる
    expect(modeOf(appDir) & 0o1222).toBe(0o1222)
  })

  it('★★ シンボリックリンクは追従しない（リンク先が外にあるとき、その mode を変えない）', () => {
    const appDir = makeStage()
    // ステージングの**外**にあるファイル（＝利用者の持ち物）を指すリンクを置く。
    // `fs.chmodSync` はリンクを辿って**リンク先**の mode を変えてしまうので、追従すると
    // ここが 0o644 に変わる＝「配る複製にしか触らない」が破れる（copyTree も追従していない）。
    const outside = path.join(tmp, 'outside.txt')
    fs.writeFileSync(outside, 'x')
    fs.chmodSync(outside, 0o666)
    fs.mkdirSync(path.join(appDir, 'node_modules', '.bin'), { recursive: true })
    const link = path.join(appDir, 'node_modules', '.bin', 'left-pad')
    fs.symlinkSync(outside, link)

    normalizeStageTree(appDir)

    expect(fs.lstatSync(link).isSymbolicLink(), 'リンクが実体に置き換わっている').toBe(true)
    expect(modeOf(outside), `リンクを辿って外のファイルの mode を変えた（mode=${modeOf(outside).toString(8)}）`).toBe(0o666)
  })

  it('★ すでにその形なら何も変わらない（copyTree が通した分に二度当ててもよい）', () => {
    const src = path.join(tmp, 'proj')
    fs.mkdirSync(path.join(src, 'public'), { recursive: true })
    fs.writeFileSync(path.join(src, 'server.js'), 'console.log(1)')
    const dest = path.join(tmp, 'stage2', 'app')
    copyTree(src, dest)
    const before = [modeOf(dest), modeOf(path.join(dest, 'public')), modeOf(path.join(dest, 'server.js'))]

    normalizeStageTree(dest)

    expect([modeOf(dest), modeOf(path.join(dest, 'public')), modeOf(path.join(dest, 'server.js'))]).toEqual(before)
  })
})

// ── layer.tar に mode が保たれているか（検分の指摘・2026-09-16）─────────────────────
//
// 上の describe が見ているのは **ステージング（配る複製）のフォルダの mode** だけである。
// **像に効くのは「layer.tar に mode が入っていること」**で、そこが抜けていた:
// tar の呼び方が mode を落とす形（`--no-same-permissions` 相当・`--mode` の指定・
// 書庫の作り方の変更）に変われば、上の試験はすべて緑のまま **/app が読み取り専用に戻り、
// 実機の EACCES 再起動ループが黙って再発する**。
//
// 仕様書 29 行目の「tar に書き出すときに mode が保たれているか」の確認は、これまで
// imageBuild.ts の散文コメント（「実測で確かめた」）としてしか残っていなかった。
// **コメントは変異を止めない。** ここで実際に `stageAndTar` を通し、書庫の
// ヘッダ（ustar の mode 欄）を読んで固定する。
//
// tar のヘッダ（POSIX ustar・512 バイト/ブロック）:
//   0..100 name / 100..108 mode（8進の文字列）/ **108..116 uid（8進）** / 124..136 size（8進）/
//   156 typeflag（'0' or '\0' = ファイル・'5' = フォルダ）/ 345..500 prefix
type TarEntry = { name: string; mode: number; uid: number; type: string }

/** NUL/空白で終わる固定長フィールドを文字列にする。 */
function field(b: Buffer, from: number, to: number): string {
  const s = b.subarray(from, to).toString('utf-8')
  const end = s.indexOf('\0')
  return (end === -1 ? s : s.slice(0, end)).trim()
}

/** layer.tar を読んで、各エントリの名前・mode・種別を返す（ライブラリを足さずに自前で読む）。 */
function readTarEntries(tarPath: string): TarEntry[] {
  const buf = fs.readFileSync(tarPath)
  const out: TarEntry[] = []
  for (let off = 0; off + 512 <= buf.length;) {
    const head = buf.subarray(off, off + 512)
    if (head.every(b => b === 0)) break // 終端（NUL ブロック）
    const size = parseInt(field(head, 124, 136) || '0', 8) || 0
    const type = String.fromCharCode(head[156] || 0x30)
    const prefix = field(head, 345, 500)
    const name = field(head, 0, 100)
    // 'x'/'g'（pax の拡張ヘッダ）は中身を飛ばすだけで、エントリとしては数えない
    if (type !== 'x' && type !== 'g') {
      out.push({
        name: prefix ? `${prefix}/${name}` : name,
        mode: parseInt(field(head, 100, 108) || '0', 8) & 0o7777,
        uid: parseInt(field(head, 108, 116) || '0', 8) || 0,
        type,
      })
    }
    off += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

/** 末尾の `/` を無視して1件だけ取り出す（tar はフォルダを `app/` のように書く）。 */
function entry(entries: TarEntry[], name: string): TarEntry {
  const hit = entries.filter(e => e.name.replace(/\/+$/, '') === name)
  expect(hit.length, `${name} が書庫に1件だけ入っていない（${entries.map(e => e.name).join(' ')}）`).toBe(1)
  return hit[0]
}

describe('stageAndTar: layer.tar に mode が保たれる（像に効くのはここ・D-8）', () => {
  it('★★ 書庫の中の app/（＝コンテナの /app）に書き込みが入っている——ここが落ちると EACCES 再起動ループが再発する', async () => {
    const src = path.join(tmp, 'proj')
    fs.mkdirSync(path.join(src, 'public'), { recursive: true })
    fs.writeFileSync(path.join(src, 'server.js'), 'console.log(1)')
    fs.writeFileSync(path.join(src, 'public', 'index.html'), '<p>hi</p>')

    const layer = await stageAndTar(src)
    try {
      const entries = readTarEntries(layer)
      const app = entry(entries, 'app')
      expect(app.type, 'app/ がフォルダとして入っていない').toBe('5')
      // **所有者・グループ・その他のすべてに w**。コンテナは uid 951:gid 951 で動く一方、
      // 書庫に記録される所有者は**ビルドした人の uid**（下の「uid 欄」の試験で実測を固定している）で、
      // その番号が 951 と一致する保証は無いため、other の w が無いと書けないことがある。
      expect(app.mode & 0o222, `書庫の app/ に書き込みが無い（mode=${app.mode.toString(8)}）`).toBe(0o222)
      expect(app.mode & 0o555, '読み・辿るが落ちている').toBe(0o555)
      // **スティッキービットも書庫に入っていること**（2026-09-16）。ここが落ちると、
      // 展開された /app は `0o777` になり、像に最初から入っているファイルを消して
      // 置き換えられる状態で配られる。
      expect(app.mode & 0o1000, `書庫の app/ にスティッキービットが無い（mode=${app.mode.toString(8)}）`).toBe(0o1000)
    } finally {
      fs.rmSync(path.dirname(layer), { recursive: true, force: true })
    }
  })

  it('★★ 入れ子のフォルダ（app/public）にも書き込みが入っている', async () => {
    const src = path.join(tmp, 'proj')
    fs.mkdirSync(path.join(src, 'public'), { recursive: true })
    fs.writeFileSync(path.join(src, 'public', 'index.html'), '<p>hi</p>')

    const layer = await stageAndTar(src)
    try {
      const pub = entry(readTarEntries(layer), 'app/public')
      expect(pub.type).toBe('5')
      expect(pub.mode & 0o222, `書庫の app/public に書き込みが無い（mode=${pub.mode.toString(8)}）`).toBe(0o222)
      expect(pub.mode & 0o1000, `書庫の app/public にスティッキービットが無い（mode=${pub.mode.toString(8)}）`).toBe(0o1000)
    } finally {
      fs.rmSync(path.dirname(layer), { recursive: true, force: true })
    }
  })

  it('★★ 書庫の中のファイルは読めて、書けない（0o444 のまま。アプリのコードは像の中で書き換わらない）', async () => {
    const src = path.join(tmp, 'proj')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'server.js'), 'console.log(1)')
    fs.chmodSync(path.join(src, 'server.js'), 0o400) // 手元が読み取り専用（2026-08-14 の EACCES の形）

    const layer = await stageAndTar(src)
    try {
      const f = entry(readTarEntries(layer), 'app/server.js')
      expect(f.mode & 0o444, `書庫のファイルが読めない（mode=${f.mode.toString(8)}）`).toBe(0o444)
      expect(f.mode & 0o222, `書庫のファイルに書き込みが付いている（mode=${f.mode.toString(8)}）`).toBe(0)
    } finally {
      fs.rmSync(path.dirname(layer), { recursive: true, force: true })
    }
  })

  // 上の3件は**自前のヘッダ読み**（readTarEntries）に頼っている。読み手を間違えていれば
  // 一緒に間違うので、**tar 自身に書庫の中身を読ませた出力**でも同じことを固定する
  // （2026-09-16 の実測と同じ見え方＝`drwxrwxrwt`）。
  it('★★ tar -tvf の出力でも、フォルダは drwxrwxrwt（書き込み＋スティッキー）・ファイルは所有者以外に w が無い', async () => {
    const src = path.join(tmp, 'proj')
    fs.mkdirSync(path.join(src, 'public'), { recursive: true })
    fs.writeFileSync(path.join(src, 'server.js'), 'console.log(1)')
    fs.writeFileSync(path.join(src, 'public', 'index.html'), '<p>hi</p>')

    const layer = await stageAndTar(src)
    try {
      const listing = execFileSync('tar', ['-tvf', layer], { encoding: 'utf-8' })
      // 行の形: `drwxrwxrwt  0 user staff  0 Sep 16 12:45 app/`
      const lines = listing.split('\n').map(l => l.trim()).filter(Boolean)
      const rowOf = (name: string): string => {
        const hit = lines.filter(l => l.endsWith(` ${name}`) || l.endsWith(` ${name}/`))
        expect(hit.length, `${name} の行が1件だけ出ていない:\n${listing}`).toBe(1)
        return hit[0]
      }
      expect(rowOf('app').split(/\s+/)[0], `app/ が drwxrwxrwt でない:\n${listing}`).toMatch(/^drwxrwxrwt/)
      expect(rowOf('app/public').split(/\s+/)[0], `app/public が drwxrwxrwt でない:\n${listing}`).toMatch(/^drwxrwxrwt/)
      // ファイルの行（`-` で始まる）は、**グループとその他に w が無い**こと。
      // ⚠️ 所有者の w は残りうる——`copyFileSync` が手元の mode を引き継ぎ、`fileModeForImage` は
      // **所有者の w には触らない**ので、手元が `0644` のファイルは書庫でも `-rw-r--r--` になる。
      // 像の中の所有者は**ビルドした人の uid** で、コンテナの実行ユーザ（専有型は uid 951）とは
      // 別の番号である（下の describe で uid 欄を固定している）。
      // **手元が `0o666`/`0o777` のファイルでもここは同じ形になる**（D-13 A でグループ・その他の
      // w を落とすようにした。それを固定したのが下の describe）。
      // 消して置き換えられないことは、親フォルダのスティッキービットと uid の違いが受け持つ。
      for (const line of lines) {
        const perm = line.split(/\s+/)[0]
        if (!perm.startsWith('-')) continue
        expect(perm[5], `書庫のファイルのグループに書き込みが付いている: ${line}`).toBe('-')
        expect(perm[8], `書庫のファイルのその他に書き込みが付いている: ${line}`).toBe('-')
      }
    } finally {
      fs.rmSync(path.dirname(layer), { recursive: true, force: true })
    }
  })
})

// ── 書庫に記録される「所有者」と、残る制限の**実際の姿**（検分の指摘・2026-09-16）────────
//
// スティッキービットの効き目は「**他人**が作ったものは消せない」であり、その「他人」が誰かは
// **書庫のヘッダに入る uid** で決まる。ここを取り違えた説明が、コードとドキュメントに入っていた:
// 「像の中のファイルの所有者は root」——**未確認のうえ、実測と食い違う**。
// `stageAndTar` は `tar -cf <layer> -C <stage> app` を `--owner`/`--numeric-owner` なしで呼び、
// `chown` もしないので、**ヘッダに入るのはビルドした人の uid** である
// （この機械での実測・2026-09-16: mode 欄 `001777`・uid 欄 `000766`＝10進 **502**・`uname=r-yamaguchi`）。
// 結論（アプリは配布物のファイルを消せない）は **502 ≠ 951 の間は**成り立つが、
// 理由として書いてあった事実が違った。**理由まで含めて振る舞いで固定する**（掟1・掟10）。
describe('stageAndTar: 書庫の所有者と、残る制限の実際の姿（検分の指摘・2026-09-16）', () => {
  it('★★ 書庫に入る uid は「ビルドした人の uid」（root(0) に寄せていない＝スティッキーの「他人」はこの番号で決まる）', async () => {
    const src = path.join(tmp, 'proj')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'server.js'), 'console.log(1)')

    const layer = await stageAndTar(src)
    try {
      const entries = readTarEntries(layer)
      const me = process.getuid?.() ?? -1
      expect(me, 'この試験は POSIX（uid のある環境）専用').toBeGreaterThanOrEqual(0)
      // `tar` に `--owner` を足す・`chown` する形へ変わると、ここが落ちる。
      expect(entry(entries, 'app').uid, '書庫の app/ の uid がビルドした人のものでない').toBe(me)
      expect(entry(entries, 'app/server.js').uid, '書庫のファイルの uid がビルドした人のものでない').toBe(me)
      // ⚠️ 「だから 951 とは必ず違う」とは書かない。**ビルドした人の uid が 951 のときどうなるかは未確認**。
      // 分かっているのは「書庫の uid は固定値ではなく、ビルドした人の番号がそのまま入る」ことだけ。
    } finally {
      fs.rmSync(path.dirname(layer), { recursive: true, force: true })
    }
  })

  // ── D-13 A（2026-09-16）: ここが「書き換えられません」の最後の砦 ──────────────────
  // 以前この試験は**逆**を固定していた（「手元が 0o666 のファイルは w を持ったまま書庫に入る」）。
  // つまりコードは「配ったものは書き換えられない」を満たしておらず、README・使い方ガイド・
  // CHANGELOG の説明だけが先に進んでいた。`fileModeForImage` で落とすようにしたので、
  // **書庫の中でも他人の w が無いこと**をここで固定する（足すだけに戻すと赤になる）。
  it('★★ 手元が 0o666/0o777 のファイルでも、書庫ではグループ・その他の書き込みが落ちている（その場の上書きを防ぐ）', async () => {
    const src = path.join(tmp, 'proj')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'data.json'), '{}')
    fs.chmodSync(path.join(src, 'data.json'), 0o666) // 利用者の手元がこうなっていることはふつうにある
    fs.writeFileSync(path.join(src, 'run.sh'), '#!/bin/sh\n')
    fs.chmodSync(path.join(src, 'run.sh'), 0o777)
    fs.writeFileSync(path.join(src, 'server.js'), 'console.log(1)') // umask 022 の既定＝0o644

    const layer = await stageAndTar(src)
    try {
      const entries = readTarEntries(layer)
      const data = entry(entries, 'app/data.json')
      expect(data.mode & 0o022,
        `0o666 のファイルが w を持ったまま書庫に入っている（mode=${data.mode.toString(8)}）`).toBe(0)
      expect(data.mode & 0o444, '書庫のファイルが読めない').toBe(0o444)
      const run = entry(entries, 'app/run.sh')
      expect(run.mode & 0o022,
        `0o777 のファイルが w を持ったまま書庫に入っている（mode=${run.mode.toString(8)}）`).toBe(0)
      // **実行ビットは奪わない**（ここが落ちると、同梱のスクリプトが像の中で動かなくなる）
      expect(run.mode & 0o111, `実行ビットを奪っている（mode=${run.mode.toString(8)}）`).toBe(0o111)
      // 既定の umask で作ったファイルは、従来どおり所有者以外に w が無い
      expect(entry(entries, 'app/server.js').mode & 0o022).toBe(0)
    } finally {
      fs.rmSync(path.dirname(layer), { recursive: true, force: true })
    }
  })

  // 上は**自前のヘッダ読み**に頼っている。読み手を間違えていれば一緒に間違うので、
  // **tar 自身に読ませた出力**でも「w が落ちている」ことを固定する（仕様書 A の最後の1本）。
  it('★★ tar -tvf の出力でも、0o666 のファイルは -rw-r--r--・0o777 は -rwxr-xr-x（他人の w が無い）', async () => {
    const src = path.join(tmp, 'proj')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'data.json'), '{}')
    fs.chmodSync(path.join(src, 'data.json'), 0o666)
    fs.writeFileSync(path.join(src, 'run.sh'), '#!/bin/sh\n')
    fs.chmodSync(path.join(src, 'run.sh'), 0o777)

    const layer = await stageAndTar(src)
    try {
      const listing = execFileSync('tar', ['-tvf', layer], { encoding: 'utf-8' })
      const lines = listing.split('\n').map(l => l.trim()).filter(Boolean)
      const permOf = (name: string): string => {
        const hit = lines.filter(l => l.endsWith(` ${name}`))
        expect(hit.length, `${name} の行が1件だけ出ていない:\n${listing}`).toBe(1)
        return hit[0].split(/\s+/)[0]
      }
      expect(permOf('app/data.json'), `0o666 のファイルの w が落ちていない:\n${listing}`).toMatch(/^-rw-r--r--/)
      expect(permOf('app/run.sh'), `0o777 のファイルが -rwxr-xr-x になっていない:\n${listing}`).toMatch(/^-rwxr-xr-x/)
    } finally {
      fs.rmSync(path.dirname(layer), { recursive: true, force: true })
    }
  })
})

// ── 「mode を落とした書庫」なら、この検査はちゃんと落ちる（省略した変異(d)の代わり・2026-09-16）──
//
// 上の2つの describe は「`stageAndTar` が作った書庫に mode が入っている」ことを見ている。
// だが**読み手（readTarEntries／`tar -tvf` の行）が mode を見ていなければ**、tar の呼び方が
// mode を落とす形に変わっても緑のままになる——検分で「(d) mode を落とす偽 tar での検証」を
// **実施していない**（変異を入れていない）ので、その素通りの可能性が残っていた。
//
// `stageAndTar` の中の `tar` 呼び出しを差し替える口は無いので、**同じ形の書庫を
// 読み取り専用のステージングから自分で作り**、検査側が「落ちている」と読めることを固定する。
// これが緑なら、mode を落とす書庫が来たときに上の試験は**必ず赤になる**（読み手が素通りしない）。
describe('検査側の効き目: mode を落とした書庫は「落ちている」と読める（変異(d)の代わり）', () => {
  /** `stageAndTar` と同じ形（`app/…`）の書庫を、指定の mode のステージングから作る。 */
  function tarFromStage(dirMode: number, fileMode: number): string {
    const stage = path.join(tmp, 'stage-ro')
    fs.mkdirSync(path.join(stage, 'app', 'public'), { recursive: true })
    fs.writeFileSync(path.join(stage, 'app', 'server.js'), 'console.log(1)')
    fs.chmodSync(path.join(stage, 'app', 'server.js'), fileMode)
    fs.chmodSync(path.join(stage, 'app', 'public'), dirMode)
    fs.chmodSync(path.join(stage, 'app'), dirMode)
    const layer = path.join(tmp, 'dropped.tar')
    execFileSync('tar', ['-cf', layer, '-C', stage, 'app'])
    // 後始末（rmSync）のために手元の権限を戻す
    fs.chmodSync(path.join(stage, 'app'), 0o700)
    fs.chmodSync(path.join(stage, 'app', 'public'), 0o700)
    return layer
  }

  it('★★ 書き込みもスティッキーも無い書庫は、ヘッダの mode 欄でそう読める（読み手が素通りしない）', () => {
    const layer = tarFromStage(0o555, 0o444) // D-8 の**直す前**の権限
    const entries = readTarEntries(layer)
    const app = entry(entries, 'app')
    expect(app.type).toBe('5')
    // 上の describe が `toBe(0o222)` / `toBe(0o1000)` で見ている当の欄が、ここでは 0 になる
    expect(app.mode & 0o222, 'mode を落とした書庫なのに書き込みが読めてしまう').toBe(0)
    expect(app.mode & 0o1000, 'mode を落とした書庫なのにスティッキーが読めてしまう').toBe(0)
    expect(entry(entries, 'app/public').mode & 0o1000).toBe(0)
  })

  it('★★ `tar -tvf` の行でも drwxrwxrwt にならない（もう一方の読み手も素通りしない）', () => {
    const layer = tarFromStage(0o555, 0o444)
    const listing = execFileSync('tar', ['-tvf', layer], { encoding: 'utf-8' })
    const row = listing.split('\n').map(l => l.trim()).filter(l => l.endsWith(' app/'))
    expect(row.length, `app/ の行が1件だけ出ていない:\n${listing}`).toBe(1)
    expect(row[0].split(/\s+/)[0], `mode を落とした書庫なのに drwxrwxrwt に見えている:\n${listing}`).not.toMatch(/^drwxrwxrwt/)
    expect(row[0].split(/\s+/)[0]).toMatch(/^dr-xr-xr-x/)
  })
})

// ── node_modules も書庫では他人が書けない（検分の指摘・2026-09-16）────────────────────
//
// `copyTree` は `node_modules` を複製しない（除外リスト）。`stageAndTar` は copyTree の**あと**に
// `installDependencies`（`npm install`）を走らせて作り直すので、**そのままでは mode は
// npm とビルドした人の umask 任せ**だった。umask が緩い機械では、**他人の w を持ったファイルが
// そのまま書庫に入る**——README・使い方ガイドの「最初から入っているファイルは書き換えられない」から
// node_modules だけが外れていたことになる。フォルダも npm の `0o755` のままで、
// D-8 で `/app` 全体に与えたはずの「アプリは自分でフォルダを作れる」からも外れていた。
//
// ここは**書庫を読んで**確かめる（上の `vi.mock` が npm の代わりに同じ形を置く）。
// `stageAndTar` から `normalizeStageTree(appDir)` を外す変異は、この試験が落とす。
describe('stageAndTar: npm が作った node_modules も、書庫では copyTree と同じ形（検分の指摘・2026-09-16）', () => {
  /** 依存のある（＝installDependencies を通る）プロジェクトを作る。 */
  function projectWithDeps(): string {
    const src = path.join(tmp, 'proj')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'server.js'), 'console.log(1)')
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.0.0' } }))
    return src
  }

  it('★★ 手元の npm が 0o666 で作ったファイルでも、書庫ではグループ・その他の w が落ちている', async () => {
    const layer = await stageAndTar(projectWithDeps())
    try {
      const entries = readTarEntries(layer)
      const f = entry(entries, 'app/node_modules/left-pad/index.js')
      expect(f.mode & 0o022,
        `node_modules のファイルが w を持ったまま書庫に入っている（mode=${f.mode.toString(8)}）`).toBe(0)
      expect(f.mode & 0o444, '書庫の node_modules のファイルが読めない').toBe(0o444)
    } finally {
      fs.rmSync(path.dirname(layer), { recursive: true, force: true })
    }
  })

  it('★★ node_modules の実行ファイル（0o777）は、w だけ落ちて実行ビットは残る', async () => {
    const layer = await stageAndTar(projectWithDeps())
    try {
      const cli = entry(readTarEntries(layer), 'app/node_modules/left-pad/cli.js')
      expect(cli.mode & 0o022, `mode=${cli.mode.toString(8)}`).toBe(0)
      expect(cli.mode & 0o111, `実行ビットを奪っている（mode=${cli.mode.toString(8)}）`).toBe(0o111)
    } finally {
      fs.rmSync(path.dirname(layer), { recursive: true, force: true })
    }
  })

  it('★★ node_modules のフォルダにも書き込みとスティッキーが入っている（D-8 の前提から外れていた）', async () => {
    const layer = await stageAndTar(projectWithDeps())
    try {
      const entries = readTarEntries(layer)
      for (const name of ['app/node_modules', 'app/node_modules/left-pad']) {
        const d = entry(entries, name)
        expect(d.type, `${name} がフォルダとして入っていない`).toBe('5')
        expect(d.mode & 0o222, `${name} に書き込みが無い（mode=${d.mode.toString(8)}）`).toBe(0o222)
        expect(d.mode & 0o1000, `${name} にスティッキーが無い（mode=${d.mode.toString(8)}）`).toBe(0o1000)
      }
    } finally {
      fs.rmSync(path.dirname(layer), { recursive: true, force: true })
    }
  })

  it('★★ `tar -tvf` の出力でも、node_modules のファイルは所有者以外に w が無い（読み手を1つに頼らない）', async () => {
    const layer = await stageAndTar(projectWithDeps())
    try {
      const listing = execFileSync('tar', ['-tvf', layer], { encoding: 'utf-8' })
      const rows = listing.split('\n').map(l => l.trim())
      const idx = rows.find(l => l.endsWith(' app/node_modules/left-pad/index.js'))
      expect(idx, `index.js の行が出ていない:\n${listing}`).toBeDefined()
      expect(idx!.split(/\s+/)[0], `他人の w が残っている:\n${idx}`).toBe('-rw-r--r--')
      const cli = rows.find(l => l.endsWith(' app/node_modules/left-pad/cli.js'))
      expect(cli!.split(/\s+/)[0], `実行ビットか w がおかしい:\n${cli}`).toBe('-rwxr-xr-x')
    } finally {
      fs.rmSync(path.dirname(layer), { recursive: true, force: true })
    }
  })
})
