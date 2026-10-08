import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-25 検分）──────────────────────────────
// 「💾 いま入っているデータをどうしますか」の**探す側（main）**には、振る舞いのテストが
// 1件も無かった。純関数 describeLeftoverData は手厚く固定されていたのに、それを呼ぶ
// 一巡（checkUnusedFiles → isLeftoverDataFile で絞る → statSync → 読む →
// describeLeftoverData → files.push）は誰も通していない。tests/leftoverData.test.ts の
// 「探す側（main）」は**原本の文字列を読むだけ**で、`if (found) files.push(found)` を
// `if (false && found)` に変えても全件緑だった。
//
// 壊れると `files: []` が黙って返り、問いが一度も出ない。利用者は何も聞かれないまま
// 公開し、配った合言葉（joinCode）が通じなくなる（2026-09-23 の ScheduleAPP の再現）。
//
// ここは**ソースの文字列を読まない**（掟10）。偽のプロジェクトフォルダを実際に作り、
// `leftoverDataFilesFs` に本物のファイルを走査・読み取りさせて、返り値を固定する。

// unused.ts は登録のために electron を import するだけ（ハンドラは使わない）。
vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
}))

import { leftoverDataFilesFs } from '../src/main/ipc/unused'
import { LEFTOVER_MAX_READ_BYTES, SQLITE_EMPTY_MAX_BYTES } from '../src/shared/leftoverData'

/** 実機に残っていた形そのもの（日程0件・参加者0件で、合言葉だけ入っている）。 */
const SCHEDULE_JSON = '{"joinCode":"2D88A8","dates":[],"entries":[]}'

/** koto-data へ書き直したあとのアプリ。**古い保存の名前はどこにも出てこない**。 */
const SERVER_JS = [
  "const { readJson, writeJson } = require('./koto-data.cjs')",
  'const express = require(\'express\')',
  'const app = express()',
  'app.get(\'/api/state\', async (_req, res) => res.json(await readJson(\'state\', {})))',
  'app.listen(8080)',
  '',
].join('\n')

let projectDir = ''

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-leftover-'))
})
afterEach(() => {
  // 読めないファイルを作るテストがあるので、消せるように戻してから片づける
  try { fs.chmodSync(path.join(projectDir, 'data', 'secret-entries.json'), 0o644) } catch { /* 無ければよい */ }
  try { fs.rmSync(projectDir, { recursive: true, force: true }) } catch { /* 消せなくてもよい */ }
})

/** プロジェクトにファイルを置く（中身は文字列でもバイト列でもよい）。 */
function put(rel: string, content: string | Buffer): string {
  const full = path.join(projectDir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  return full
}

/** 書き直しが済んだアプリ一式（古い保存はまだ置かない）。 */
function putApp(prefix = ''): void {
  put(path.join(prefix, 'server.js'), SERVER_JS)
  put(path.join(prefix, 'package.json'), JSON.stringify({ name: 'schedule-app', main: 'server.js' }, null, 2))
  put(path.join(prefix, 'index.html'), '<!doctype html><html><body><h1>日程調整</h1></body></html>')
}

/** 見つかったファイル名だけ（並び順は走査の順）。 */
function found(r: { files: { file: string }[] }): string[] {
  return r.files.map(f => f.file)
}

describe('古いデータを探す（main・実際にファイルを走査して読む）', () => {
  it('★★★ 合言葉だけ残った古い保存を見つけ、中身の手がかりまで返す（実機 2026-09-23 の形）', () => {
    putApp()
    put('data/schedule.json', SCHEDULE_JSON)

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    expect(found(r)).toEqual(['data/schedule.json'])
    // 件数だけで「空」に倒さない。合言葉が入っていることが依頼文へ渡る
    expect(r.files[0].detail).toContain('joinCode あり')
    expect(r.files[0].detail).toContain('dates 0件')
  })

  it('★★★ 本当に空なら1件も出さない（空振りの問い合わせをしない）', () => {
    putApp()
    put('data/schedule.json', '{"joinCode":"","dates":[],"entries":[]}')

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    expect(found(r)).toEqual([])
  })

  it('★★ 読めない保存（.db）は大きさで見る（1ページぶんまでは中身なし）', () => {
    putApp()
    put('data/empty.db', Buffer.alloc(SQLITE_EMPTY_MAX_BYTES, 0))
    put('data/filled.db', Buffer.alloc(SQLITE_EMPTY_MAX_BYTES + 1, 0))

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    expect(found(r)).toEqual(['data/filled.db'])
    expect(r.files[0].detail).toBe(`${SQLITE_EMPTY_MAX_BYTES + 1}バイト`)
  })

  it('★★ 大きすぎるファイルは読まずに、大きさだけで知らせる（黙って落とさない）', () => {
    putApp()
    const size = LEFTOVER_MAX_READ_BYTES + 1
    put('data/entries.json', Buffer.alloc(size, 0x78)) // 'x' で埋めた＝JSON としては壊れている

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    expect(found(r)).toEqual(['data/entries.json'])
    // 読んでいれば「◯行」になる。読まずに大きさで答えたことを固定する
    expect(r.files[0].detail).toBe(`${size}バイト`)
  })

  it('★★ 読めなかったファイルでも、大きければ知らせる（1件読めなくても全体は落ちない）', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // root では権限を落とせない
    putApp()
    put('data/schedule.json', SCHEDULE_JSON)
    put('data/secret-entries.json', Buffer.alloc(5000, 0x20))
    fs.chmodSync(path.join(projectDir, 'data', 'secret-entries.json'), 0o000)

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    expect(found(r).sort()).toEqual(['data/schedule.json', 'data/secret-entries.json'])
    expect(r.files.find(f => f.file === 'data/secret-entries.json')?.detail).toBe('5000バイト')
  })

  it('★★ 大きさが取れないファイル（壊れたリンク）は飛ばし、ほかの件は返す', () => {
    putApp()
    put('data/schedule.json', SCHEDULE_JSON)
    fs.symlinkSync(path.join(projectDir, 'data', 'どこにも無い.json'), path.join(projectDir, 'data', 'broken.json'))

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    expect(found(r)).toEqual(['data/schedule.json'])
  })

  // ⚠️ この1件が固定しているのは、**共有の純関数側の判定**（shared/leftoverData.ts の
  // describeLeftoverData 冒頭 `if (!file || !isLeftoverDataFile(file)) return null`）である。
  // main 側（unused.ts:181 の `if (!isLeftoverDataFile(rel)) continue`）は**同じ判定を
  // もう一度している**ので、そこだけ外しても結果は1バイトも変わらない＝**等価変異**になる。
  //
  // 実測（2026-09-25・当て直し）:
  //   ・`if (!isLeftoverDataFile(rel)) continue` を**無条件 continue** に → 9件落ちる
  //     （これは「ループ全体を殺す」変異で、絞り込みが外れる方向ではない）
  //   ・**絞り込みだけを外す**（行ごと消す）→ **12件すべて緑**。落とせない。
  //
  // つまり main 側の絞り込みは、いまどのテストも見張れていない。テストの書き方の問題ではなく
  // **二重判定という構造の問題**なので、直すなら unused.ts 側の1行を消して
  // describeLeftoverData を唯一の門にする（掟10「守りは定義を1箇所に集める」）。
  // ここではその区別を記録として残す（次に「落ちるから守れている」と読み違えないために）。
  it('★★ 設定ファイルは「いま入っているデータ」ではない（.eslintrc.json・package.json）', () => {
    putApp()
    put('.eslintrc.json', '{"root":true,"extends":"eslint:recommended"}')
    put('vite.config.json', '{"build":{"outDir":"dist"}}')
    put('data/schedule.json', SCHEDULE_JSON)

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    expect(found(r)).toEqual(['data/schedule.json'])
  })

  it('★★ どこかから名前で参照されている保存は出さないが、件数は隠さない（referenced）', () => {
    putApp()
    put('data/schedule.json', SCHEDULE_JSON)
    put('notes.md', '# 覚え書き\n\n以前のデータは data/old-entries.json に入っています。\n')
    put('data/old-entries.json', '{"entries":[{"name":"やまぐち"}]}')

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    // 参照があるものは未使用に出ない＝ここにも出ない
    expect(found(r)).toEqual(['data/schedule.json'])
    // **見落としうる件数を黙らせない**（0件を「ありません」と断定させないための材料）
    expect(r.referenced).toBe(1)
  })

  // ── referenced の数え方（2026-09-25 検分・指摘V8）───────────────────────────
  // 前は「データらしき拡張子の総数 − 未使用に出た件数」だったので、**アプリが正規に読んでいる
  // .json が1つでもあれば必ず 1 以上**になった。呼ぶ側（leftoverScanLine）はそれを材料に
  // 注意書きを出すので、古いデータが1件も無いプロジェクトにも毎回出る。読み飛ばされて、
  // 本当に取りこぼしたときに効かなくなる。いまは「**覚え書きや説明にだけ名前が残っていたせいで
  // 隠れたもの**」だけを数える（コメントと .md / .txt を抜いた参照コーパスで同じ判定をもう一度流す）。
  it('★★★ 正規に読んでいるデータは取りこぼしに数えない（毎回出る注意書きにしない）', () => {
    put('server.js', [
      "const { readJson } = require('./koto-data.cjs')",
      "const fs = require('fs')",
      "const settings = JSON.parse(fs.readFileSync('data/settings.json', 'utf-8'))",
      'console.log(settings)',
      '',
    ].join('\n'))
    put('package.json', JSON.stringify({ name: 'schedule-app', main: 'server.js' }, null, 2))
    put('index.html', '<!doctype html><html><body><h1>日程調整</h1></body></html>')
    put('data/settings.json', '{"theme":"dark"}')

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    expect(found(r)).toEqual([])
    // ここが 1 に戻ると、③公開を開くたびに注意書きが出るようになる
    expect(r.referenced).toBe(0)
  })

  it('★★★ 移行メモ1行で隠れた古い保存は、取りこぼしとして数える（コメントを参照と見なさない）', () => {
    put('server.js', [
      "const { readJson } = require('./koto-data.cjs')",
      '// 旧: data/schedule.json はもう使いません（koto-data へ移しました）',
      'console.log(readJson)',
      '',
    ].join('\n'))
    put('package.json', JSON.stringify({ name: 'schedule-app', main: 'server.js' }, null, 2))
    put('index.html', '<!doctype html><html><body><h1>日程調整</h1></body></html>')
    put('data/schedule.json', SCHEDULE_JSON)

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    // 名前がコメントに出ているので未使用には出ない＝**一覧は空**になる
    expect(found(r)).toEqual([])
    // 一覧が空のときこそ、この件数だけが利用者に知らせる材料になる（指摘V8）
    expect(r.referenced).toBe(1)
  })

  it('★★★ 移行メモが HTML のコメント（<!-- … -->）でも、取りこぼしとして数える', () => {
    put('server.js', SERVER_JS)
    put('package.json', JSON.stringify({ name: 'schedule-app', main: 'server.js' }, null, 2))
    put('index.html', '<!doctype html><html><body>\n<!-- 旧: data/schedule.json は使いません -->\n<h1>日程調整</h1></body></html>')
    put('data/schedule.json', SCHEDULE_JSON)

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    expect(found(r)).toEqual([])
    expect(r.referenced).toBe(1)
  })

  it('★★★ 移行メモがブロックコメント（/* … */）でも、取りこぼしとして数える', () => {
    put('server.js', [
      "const { readJson } = require('./koto-data.cjs')",
      '/*',
      ' * 旧: data/schedule.json はもう使いません（koto-data へ移しました）',
      ' */',
      'console.log(readJson)',
      '',
    ].join('\n'))
    put('package.json', JSON.stringify({ name: 'schedule-app', main: 'server.js' }, null, 2))
    put('index.html', '<!doctype html><html><body><h1>日程調整</h1></body></html>')
    put('data/schedule.json', SCHEDULE_JSON)

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    expect(found(r)).toEqual([])
    expect(r.referenced).toBe(1)
  })

  it('★★ 行コメントの切り出しで https:// を巻き込まない（正規の参照を取りこぼしに数えない）', () => {
    put('server.js', [
      "const { readJson } = require('./koto-data.cjs')",
      // 同じ行に URL の // が先にある。`:` の直後を行コメントと読むと、この行の
      // `data/seed.json` まで消えて「取りこぼし1件」に化ける
      "fetch('https://example.com/seed').then(() => require('./data/seed.json'))",
      '',
    ].join('\n'))
    put('package.json', JSON.stringify({ name: 'schedule-app', main: 'server.js' }, null, 2))
    put('index.html', '<!doctype html><html><body><h1>日程調整</h1></body></html>')
    put('data/seed.json', '{"entries":[{"name":"やまぐち"}]}')

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    expect(found(r)).toEqual([])
    expect(r.referenced).toBe(0)
  })

  it('★★ 全部を見ていないときは truncated を立てる（深さで打ち切った）', () => {
    putApp()
    put('data/schedule.json', SCHEDULE_JSON)
    put('a/b/c/d/e/f/g/deep.txt', 'ふかいところにあるファイル')

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    expect(r.truncated).toBe(true)
    expect(found(r)).toEqual(['data/schedule.json'])
  })

  it('★★ 打ち切っていなければ truncated は立たない（いつでも真にしない）', () => {
    putApp()
    put('data/schedule.json', SCHEDULE_JSON)

    const r = leftoverDataFilesFs(projectDir)

    expect(r.truncated).toBe(false)
    expect(r.referenced).toBe(0)
  })

  // ── この検査自身に穴があった（2026-09-25 検分・実証済み）──────────────────
  // 前は根の中と外に**同じ中身**（どちらも SCHEDULE_JSON）を置いていた。だから
  // どちらを読んでも `files` も `detail` も同じで、unused.ts の
  // `const root = resolvePublishRoot(projectDir) || projectDir` を `const root = projectDir`
  // に変えても**12件すべて緑**だった。
  //
  // 根の外を読むと、依頼文（「💾 いま入っているデータをどうしますか」）に
  // **別のファイルの合言葉と件数**が載る。黙って間違うほうの事故なので、
  // **中身を変えて、どちらを読んだかが返り値に出る**ようにする。
  it('★★ public/ があるときは公開の根の中を見て、根からの相対パスで返す', () => {
    putApp('public')
    put('public/data/schedule.json', SCHEDULE_JSON) // 根の中: joinCode 2D88A8・dates 0件
    // 根の外（プロジェクト直下）にある同名のものは見ない。**中身をわざと変えてある**——
    // 同じ中身だと「どちらを読んだか」が返り値に出ず、根の解決を外しても緑になる
    put('data/schedule.json', '{"joinCode":"ZZZZZZ","dates":["2026-01-01","2026-01-02","2026-01-03"],"entries":[]}')

    const r = leftoverDataFilesFs(projectDir)

    expect(r.ok).toBe(true)
    expect(found(r)).toEqual(['data/schedule.json'])
    // **根の中のほうを読んだ**ことを、中身で固定する（根の外は dates 3件）
    expect(r.files[0].detail, '公開の根の外にあるファイルを読んでいる').toContain('dates 0件')
    expect(r.files[0].detail).not.toContain('dates 3件')
  })

  it('★ プロジェクトのパスが不正なら、0件ではなく「調べられなかった」を返す', () => {
    const r = leftoverDataFilesFs('data/schedule.json')

    expect(r.ok).toBe(false)
    expect(r.files).toEqual([])
    expect(String(r.message ?? '')).not.toBe('')
  })
})
