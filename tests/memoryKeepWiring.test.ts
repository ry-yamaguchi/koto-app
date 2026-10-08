import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-10-01 rc.5 の実機）──────────────────────────
// 「メモリだけに持つ形」の検出（memoryKeep.test.ts）は純関数と走査では固定してある。
// ここは**画面まで届いているか**——走査の新しい信号 `keepsInMemory` が
//   main の `storage:scan` → renderer の型 → ③公開の判定（StorageNotice）
//   main の `vercel:preflight` → judgeVercelFit
// の**全部の入口**で運ばれていること。型が通ること・純関数が正しいことは、繋がっている
// 証拠にならない（掟10。2026-08-13「applyPlan に storage を渡す1行が無かった」と同じ形）。
//
// 実際のハンドラを偽の electron に登録させて叩き、**返ってきた値そのもの**を判定へ流す。
// 画面（React）は動かせないので、StorageNotice だけは原本を読む形で固定する。

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

import { registerCloudHandlers } from '../src/main/ipc/cloud'
import { registerVercelHandlers } from '../src/main/ipc/vercel'
import { storageNeedForScan, memorySitesFor, memorySitesNotWarned } from '../src/shared/storageNeed'
import { askAiRewritePlan, rewriteCheckLine, rewriteCheckDone } from '../src/shared/storageNoticeText'
import { IDE_CONTEXT } from '../src/renderer/aiContext'

registerCloudHandlers({} as any)
registerVercelHandlers({} as any)
const scanHandler = h.handlers.get('storage:scan')!
const preflight = h.handlers.get('vercel:preflight')!

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

/** 実機のアプリの server.js（要点）。memoryKeep.test.ts と同じ形。 */
const NAMES_SERVER_JS = [
  "const express = require('express');",
  'const app = express();',
  'app.use(express.urlencoded({ extended: true }));',
  'const names = [];',
  "app.get('/', (req, res) => { res.send(String(names.length)); });",
  "app.post('/names', (req, res) => {",
  '  names.push(String(req.body.name).trim());',
  "  res.redirect('/');",
  '});',
  "app.listen(process.env.PORT || 8080, '0.0.0.0');",
].join('\n')

let projectDir = ''
beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-memkeep-wiring-')) })
afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }) })

const put = (rel: string, text: string) => {
  const full = path.join(projectDir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text, 'utf-8')
}

describe('storage:scan（main の窓口）が、メモリの信号を画面まで運ぶ', () => {
  it('★★★ 実機の server.js を置くと、返事に keepsInMemory が載り、③公開の判定が will-lose-data になる', async () => {
    put('package.json', '{"name":"names-app","dependencies":{"express":"^4"}}')
    put('server.js', NAMES_SERVER_JS)

    const r = await scanHandler(null, projectDir)
    expect(r.ok).toBe(true)
    // **この1件が載っていなければ、画面は「何も無い」と読む**（運び忘れの検知）
    expect(r.keepsInMemory).toEqual([{ file: 'server.js', lines: [7] }])
    // 画面と同じ入口（StorageNotice が通る純関数）へ、返事をそのまま渡す
    const need = storageNeedForScan(r, 'hanamii')
    expect(need.kind).toBe('will-lose-data')
    expect(need.kind === 'will-lose-data' && need.note).toContain('メモリ')
    // 見せる場所・AI へ渡す場所も同じ返事から出る
    expect(memorySitesFor(r, 'hanamii')).toEqual([{ file: 'server.js', lines: [7] }])
  })

  it('★★ 画面の「AIに書き直してもらう」で送る依頼文に、メモリの場所が入る', async () => {
    put('package.json', '{"name":"names-app"}')
    put('server.js', NAMES_SERVER_JS)
    const r = await scanHandler(null, projectDir)
    const plan = askAiRewritePlan(r.writesFiles, { ok: true, ready: true, moduleKind: 'cjs' }, memorySitesFor(r, 'hanamii'))
    expect(plan.send && plan.text).toContain('server.js の 7行目')
  })

  it('メモリの形が無いプロジェクトでは、keepsInMemory は空で、判定は none', async () => {
    put('index.html', '<html></html>')
    const r = await scanHandler(null, projectDir)
    expect(r.keepsInMemory).toEqual([])
    expect(storageNeedForScan(r, 'hanamii').kind).toBe('none')
  })

  it('koto-data を使うアプリでは、メモリの形があっても declared（警告しない）', async () => {
    put('package.json', '{"name":"app"}')
    put('server.js', NAMES_SERVER_JS.replace('const names = [];', "const names = [];\nconst { save } = require('./koto-data.cjs');"))
    const r = await scanHandler(null, projectDir)
    expect(r.usesDataLayer).toBe(true)
    expect(storageNeedForScan(r, 'hanamii').kind).toBe('declared')
    expect(memorySitesFor(r, 'hanamii')).toEqual([])
  })

  it('★★ 窓口の返事から確かめる文まで: koto-data の1行だけ足して push が残っていれば、✅ が場所を名指しする', async () => {
    put('package.json', '{"name":"app"}')
    put('server.js', NAMES_SERVER_JS.replace('const names = [];', "const names = [];\nconst { save } = require('./koto-data.cjs');"))
    const r = await scanHandler(null, projectDir)
    // 画面（StorageNotice の recheck）と同じ組み立て
    const result = {
      usesDataLayer: r.usesDataLayer,
      writesFiles: r.writesFiles,
      keepsInMemory: memorySitesFor(r, 'hanamii'),
      memoryNotWarned: memorySitesNotWarned(r, 'hanamii'),
      truncated: r.truncated === true,
    }
    const line = rewriteCheckLine(result)
    expect(rewriteCheckDone(result)).toBe(true)
    expect(line.startsWith('✅')).toBe(true)
    expect(line).toContain('server.js の 8行目')
  })

  it('存在しないフォルダでも落ちず、keepsInMemory は空の配列（形が欠けない）', async () => {
    const r = await scanHandler(null, path.join(projectDir, 'no-such-folder'))
    expect(Array.isArray(r.keepsInMemory)).toBe(true)
    expect(r.keepsInMemory).toEqual([])
  })
})

describe('vercel:preflight（公開前の確認）が、メモリの信号を判断まで運ぶ', () => {
  const storageCheck = async () => {
    const r = await preflight(null, projectDir)
    expect(r.ok).toBe(true)
    const c = (r.checks as { id: string; status: string; note: string }[]).find(x => x.id === 'storage')
    expect(c, 'データの保存の行が無い').toBeTruthy()
    return { result: r, check: c! }
  }

  it('★★★ Vercel の関数の先頭に配列を置いて push するアプリを、データの行ごと ✅ で通さない', async () => {
    put('index.html', '<html><body>hi</body></html>')
    put('api/names.js', [
      'const names = []',
      'export default function handler(req, res) {',
      '  names.push(req.body.name)',
      '  res.json(names)',
      '}',
    ].join('\n'))
    const { check, result } = await storageCheck()
    expect(check.status, 'データの行が ✅ のまま（メモリの信号が渡っていない）').not.toBe('ok')
    expect(check.note).toContain('メモリ')
    expect(check.note).toContain('names.js')
    expect(check.note).toContain('残りません')
    // **止めない**（データが残らないのは困るが、公開そのものはできる）
    expect(result.canPublish).toBe(true)
  })

  it('メモリの形が無ければ、これまでどおり ✅', async () => {
    put('index.html', '<html><body>hi</body></html>')
    const { check } = await storageCheck()
    expect(check.status).toBe('ok')
  })
})

describe('画面（StorageNotice）の配線: 開いたときと「確かめる」の両方が同じ入口を通る', () => {
  const src = read('src/renderer/components/StorageNotice.tsx')
  const count = (s: string, needle: string) => s.split(needle).length - 1

  it('★ 判定は storageNeedForScan の1本だけ（2か所で条件を書き写さない）', () => {
    // useEffect（開いたとき）と recheck（確かめる）の2か所
    expect(count(src, 'setNeed(storageNeedForScan(scan, target))')).toBe(2)
    // 直す前の、メモリを知らない呼び方が戻っていないこと
    expect(src).not.toContain('storageNeedFor({')
    expect(src).not.toContain('writesFiles: scan.writesFiles.length > 0')
  })

  it('★ メモリの場所は memorySitesFor を通し、状態へ入れ、確かめる文と依頼文へ渡す', () => {
    expect(count(src, 'const memory = memorySitesFor(scan, target)')).toBe(2)
    expect(count(src, 'setMemoryFiles(memory)')).toBe(2)
    // 「書き直せたか確かめる」の結果（rewriteCheckLine へ流れる result）に載っている
    expect(count(src, 'keepsInMemory: memory,')).toBe(2)
    // 「AIに書き直してもらう」の依頼文へ
    expect(src).toContain('askAiRewritePlan(files, layer, memoryFiles)')
    expect(src).not.toContain('askAiRewritePlan(files, layer)')
  })

  it('★ 「確かめる」の結果には、警告にはしないメモリの場所（memoryNotWarned）も載る（✅ が黙らないため）', () => {
    expect(src).toContain('memoryNotWarned: memorySitesNotWarned(scan, target),')
    // 確かめる文へ流れる result（recheck の中）にだけ載せる。開いたときは判断（Done）にしか使わない
    const recheck = src.slice(src.indexOf('const recheck = async'), src.indexOf('const askAi = async'))
    expect(recheck).toContain('memoryNotWarned: memorySitesNotWarned(scan, target),')
    expect(recheck).toContain('setCheckLine(rewriteCheckLine(result))')
  })

  it('見出しは、理由が推定だけ（memoryOnly）のとき断定しない', () => {
    expect(src).toContain("const guess = need.kind === 'will-lose-data' && need.memoryOnly === true")
    expect(src).toContain('          guess,\n        })}')
  })

  it('場所の見せ方は、ファイルに書き込んでいる箇所と同じ（ファイル名と行番号・describeWriteSite）', () => {
    expect(src).toContain('{warn && memoryFiles.length > 0 && (')
    expect(src).toContain('メモリだけにデータを持っている箇所: {memoryFiles.slice(0, 3).map(describeWriteSite).join(\'、\')}')
    // 既存の見せ方はそのまま
    expect(src).toContain('ファイルに書き込んでいる箇所: {files.slice(0, 3).map(describeWriteSite).join(\'、\')}')
  })
})

describe('3点セット（掟6）: 型と窓口', () => {
  it('main の窓口が keepsInMemory を返す（成功のときも、失敗の形のときも）', () => {
    const cloud = read('src/main/ipc/cloud.ts')
    expect(cloud).toContain('keepsInMemory: scan.keepsInMemory,')
    expect(cloud).toContain('writesFiles: [], keepsInMemory: [], truncated: true')
  })

  it('renderer の型が keepsInMemory を持つ（writesFiles と同じ形）', () => {
    const d = read('src/renderer/global.d.ts')
    expect(d).toContain('keepsInMemory: { file: string; lines: number[] }[]')
  })

  it('走査は歩く処理の中で拾い、写しを別に持たない（除外は writesFiles と同じ場所で効く）', () => {
    const dl = read('src/main/dataLayer.ts')
    expect(dl).toContain('keepsInMemory: FileWriteSite[]')
    // サーバーの印の無いファイル（lib/store.ts など）は、歩き終わってから「サーバーから読み込まれているか」で決める
    expect(dl).toContain('const memoryLines = memoryKeepLines(text, { assumeServer: true })')
    expect(dl).toContain('if (memoryLines.length > 0) memoryCandidates.set(rel, memoryLines)')
    expect(dl).toContain('const serverSide = serverReachableFiles(sources)')
    expect(dl).toContain('if (serverSide.has(file)) keepsInMemory.push({ file, lines })')
    // 歩く処理は1つのまま（メモリのために、もう1つ歩かない）
    expect(dl.split('fs.readdirSync(').length - 1).toBe(1)
    // 置く条件（AIに書き直してもらう導線）にも数える
    expect(dl).toContain('...scan.keepsInMemory.map(w => w.file)')
  })
})

describe('AI への指示（毎回のリクエストに乗る）', () => {
  // ★ 実機の原因(a)。「koto-data を使う」「ファイルに書かない」しか言っていなかった
  it('★ 「メモリだけに持たないこと」を言っている（1行・koto-data へ誘導する）', () => {
    expect(IDE_CONTEXT).toContain(
      '- **入力されたデータを、変数や配列（メモリ）だけに持たないこと。** サーバーが再起動したり公開し直したりすると消えます。'
      + '入力を一覧に出す・あとで見返すデータは、保存が必要なデータです（koto-data を使う）。\n',
    )
  })

  it('データの保存の決まりの中にある（別の節へ紛れていない）', () => {
    const rule = IDE_CONTEXT.indexOf('【データの保存（とても重要）】')
    const memoryLine = IDE_CONTEXT.indexOf('変数や配列（メモリ）だけに持たないこと')
    const nextSection = IDE_CONTEXT.indexOf('【', rule + 1)
    expect(rule).toBeGreaterThanOrEqual(0)
    expect(memoryLine).toBeGreaterThan(rule)
    expect(memoryLine).toBeLessThan(nextSection)
  })

  it('もとからある「ファイルに書き込んで保存しないこと」も残っている（弱めていない）', () => {
    expect(IDE_CONTEXT).toContain('**自分でファイル（JSON等）に書き込んで保存しないこと。**')
    expect(IDE_CONTEXT).toContain('入力内容・投稿・記録などを保存する必要があるときは、必ず koto-data を使うこと。')
  })
})
