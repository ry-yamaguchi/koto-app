import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── なぜこのテストが要るか（2026-09-24 検分の指摘4）──────────────────────
// 「データは残ります／残りません」の出し分けは、純関数（judgeVercelFit）には
// `hasStorage` を直接渡して固定してあった。ところが**その `hasStorage` を実際に
// 作っている側**（src/main/ipc/vercel.ts の `storagePlacementOf(projectDir) !== null`）を
// 確かめるテストが1件も無く、そこを `true` 固定・`false` 固定に変えても
// **Vercel 関係のテストは全件緑のまま**だった。
//
// ・常に true に倒れると: 保存場所を用意していない人に「データは残ります」と出す
//   → 安心して公開する → 環境変数は1件も渡らず、データは公開のたびに消える
// ・常に false に倒れると: 用意済みの人に「用意してください」と出す
//   → 既に月額を払っている保存場所を、もう1つ作らせる
//
// どちらも「断定できないことを断定しない」の**正反対**で、画面にしか出ない。
// **ソースの文字列は読まない。** 一時プロジェクトを実際に作って
// `vercel:preflight` を叩き、**画面に出る note そのもの**を見る。

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

import { registerVercelHandlers } from '../src/main/ipc/vercel'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'

registerVercelHandlers({} as any)
const preflight = h.handlers.get('vercel:preflight')!

/** 同意済みの保存場所（**実キーは使わない**・掟4）。 */
const CONSENTED_BUCKET = { bucket: 'koto-data-x', prefix: 'projects/myapp/', shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }

let projectDir = ''

beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-vercel-preflight-')) })
afterEach(() => { fs.rmSync(projectDir, { recursive: true, force: true }) })

/**
 * 公開できるファイルと、koto-data を使うサーバーレス関数を置く。
 *
 * `storage: true` のときだけ `.sakura-cloud/env.json` に**同意済みの**保存場所を書く
 * （＝③公開の「保存場所を用意する」を押した状態）。
 */
function setupProject(opts: { storage: boolean }) {
  const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  if (opts.storage) spec.persistence = { objectStorage: [CONSENTED_BUCKET] }
  fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
  fs.writeFileSync(path.join(projectDir, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
  fs.mkdirSync(path.join(projectDir, 'api'), { recursive: true })
  fs.writeFileSync(
    path.join(projectDir, 'api', 'save.js'),
    "import { get, set } from '../koto-data.js'\nexport default async () => set('k', await get('k'))\n",
    'utf-8',
  )
}

const storageCheck = async () => {
  const r = await preflight(null, projectDir)
  expect(r.ok).toBe(true)
  const c = (r.checks as { id: string; status: string; note: string }[]).find(x => x.id === 'storage')
  expect(c, 'データの保存の行が無い').toBeTruthy()
  return { result: r, check: c! }
}

describe('Vercel の公開前チェック: 保存場所の有無が画面まで届いている', () => {
  it('★ 用意してあるとき「残ります」と出す（「残りません」とは言わない）', async () => {
    setupProject({ storage: true })
    const { check, result } = await storageCheck()
    expect(check.note).toContain('残ります')
    expect(check.note).not.toContain('残りません')
    expect(check.note).not.toContain('保存場所を用意する')
    expect(result.canPublish).toBe(true)
  })

  it('★ 用意していないとき「残りません」と出し、どこを押せばよいかまで書く', async () => {
    setupProject({ storage: false })
    const { check, result } = await storageCheck()
    expect(check.note).toContain('残りません')
    expect(check.note).toContain('保存場所を用意する')
    // **止めない。** データが残らないのは困るが、公開そのものはできる
    expect(check.status).toBe('warn')
    expect(result.canPublish).toBe(true)
  })

  it('★ 用意済みと未用意で、実際に別の文が出る（どちらかに固定されていない）', async () => {
    setupProject({ storage: true })
    const prepared = (await storageCheck()).check.note
    fs.rmSync(path.join(projectDir, '.sakura-cloud'), { recursive: true, force: true })
    const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
    fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
    const none = (await storageCheck()).check.note
    expect(prepared).not.toBe(none)
  })

  it('★ 同意していない保存場所（consentedAt が無い）は「用意済み」と数えない', async () => {
    // 同意の記録が無いものを用意済みと読むと、**払っていない月額を前提に**
    // 「データは残ります」と言うことになる（お金の歯止め・掟10）。
    const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
    spec.persistence = { objectStorage: [{ bucket: 'koto-data-x', prefix: '', shared: true } as any] }
    fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
    fs.writeFileSync(path.join(projectDir, 'index.html'), '<html><body>hi</body></html>', 'utf-8')
    fs.mkdirSync(path.join(projectDir, 'api'), { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, 'api', 'save.js'),
      "import { get, set } from '../koto-data.js'\nexport default async () => set('k', await get('k'))\n",
      'utf-8',
    )
    const { check } = await storageCheck()
    expect(check.note).toContain('残りません')
  })

  it('★★★ 直書きだけのアプリを、データの行ごと ✅ で通さない（2026-09-25 検分の指摘18）', async () => {
    // koto-data を一度も使わず `fs.writeFileSync` で保存しているアプリ。Vercel は公開のたびに
    // 中身が元へ戻るので、**書いたデータは残らない**。ところが走査の結果（writesFiles）を
    // 判断へ渡していなかったため、「このアプリはデータの保存を使っていません」＝✅ で通っていた。
    // 利用者から見ると**データの行が丸ごと緑**で、失うことがどこにも出ない。
    setupProject({ storage: true })
    fs.rmSync(path.join(projectDir, 'api'), { recursive: true, force: true })   // koto-data は使わない
    fs.writeFileSync(
      path.join(projectDir, 'server.js'),
      "const fs = require('fs')\nfs.writeFileSync('./data.json', JSON.stringify({ a: 1 }))\n",
      'utf-8',
    )
    const { check } = await storageCheck()
    expect(check.status, 'データの行が ✅ のまま（直書きが渡っていない）').not.toBe('ok')
    expect(check.note).toContain('ファイルに直接書いて')
    expect(check.note).toContain('server.js')
    expect(check.note).toContain('残りません')
  })

  // W-30（2026-09-27 決定・案1）: 「公開のたびに消えます」では弱すぎるため、
  // 「残りません（何もしなくても消えることがあります）」に揃えた。
  it('★★★ 直書きが残っていれば、保存場所があっても「データは残りません」と言う', async () => {
    // 書き直しの途中（koto-data も使うが fs.writeFileSync も残っている）。保存場所があっても
    // **ファイルに書いたぶんは残らない**。隣の枠（storageNeed.ts）と同じことを言う。
    setupProject({ storage: true })
    fs.writeFileSync(
      path.join(projectDir, 'server.js'),
      "const fs = require('fs')\nfs.writeFileSync('./data.json', '{}')\n",
      'utf-8',
    )
    const { check } = await storageCheck()
    expect(check.note).toContain('データは残りません（何もしなくても消えることがあります）')
    expect(check.note).not.toContain('公開のたびに消えます') // 直す前の形
    expect(check.note).toContain('server.js')
  })

  it('★★★ 直書きが無いと確かめられた回は、言い切る（毎回の但し書きを出さない）', async () => {
    // **ここが「渡し忘れ」の検知になる。** `judgeVercelFit` に writesFiles を渡さないと
    // 判断は「分からない」側へ倒れ、きれいに書き直し終えたアプリにも
    // 「ファイルに直接書いている箇所が残っていると…」という但し書きが毎回出る
    // （＝新しい分岐が本番では一度も通らない死んだ枝になっている）。
    setupProject({ storage: true })                     // koto-data を使い、直書きは無い
    const { check } = await storageCheck()
    expect(check.note).toContain('データは残ります')
    expect(check.note, '直書きを確かめたのに「残っていると…」と但し書きが出ている').not.toContain('残っていると')
    expect(check.note).not.toContain('公開のたびに消えます')
  })

  // ── 走査が打ち切られた回（2026-09-25 検分の指摘V4）────────────────────────────
  //
  // `scanDataUsage` は 2000ファイル・512KB・深さ8 で**打ち切る**（scan.truncated）。
  // 打ち切られたのに空の配列を渡すと、`judgeVercelFit` の
  // `writesKnown = Array.isArray(scan.writesFiles)` が true になり、**見ていないだけ**のものを
  // 「直書きは無いと確かめた」に倒す。その結果「データは残ります」と言い切るが、
  // 見ていない側に fs.writeFileSync が実在すれば、そのデータは公開のたびに消える。
  // **確かめられなかったことを断定しない**（隣の storageNoticeText.ts の rewriteCheckDone と同じ向き）。

  /** 512KB を超える `.js` を1つ置いて、走査を打ち切らせる（中身は読まれない）。 */
  function makeScanTruncate() {
    fs.writeFileSync(path.join(projectDir, 'big.js'), `// ${'x'.repeat(600 * 1024)}\n`, 'utf-8')
  }

  it('★★★ 全部は調べられなかった回は「データは残ります」と言い切らない', async () => {
    // koto-data を使い、見えた範囲には直書きが無い。**ただし走査は打ち切られている。**
    // ここで言い切ると、見ていないファイルに残った fs.writeFileSync のぶんが黙って消える。
    setupProject({ storage: true })
    makeScanTruncate()
    const { check } = await storageCheck()
    expect(check.note, '打ち切られたのに「データは残ります」と断定している').not.toContain('データは残ります')
    // 但し書き（分からない側）へ倒れていること
    expect(check.note).toContain('ファイルに直接書いている箇所が残っていると')
    expect(check.note).toContain('公開のたびに消えます')
  })

  it('★★★ 打ち切られても、見つかった直書きは捨てない（データの行ごと ✅ に戻さない）', async () => {
    // 「分からない」へ倒すのは**「無い」と言えるかどうか**だけ。拾えた直書きまで捨てると、
    // koto-data を使わず直書きだけのアプリが「データの保存を使っていません」＝✅ へ戻り、
    // 指摘18 の穴を打ち切りの回にだけ作り直すことになる。
    setupProject({ storage: true })
    fs.rmSync(path.join(projectDir, 'api'), { recursive: true, force: true })   // koto-data は使わない
    fs.writeFileSync(
      path.join(projectDir, 'server.js'),
      "const fs = require('fs')\nfs.writeFileSync('./data.json', '{}')\n",
      'utf-8',
    )
    makeScanTruncate()
    const { check } = await storageCheck()
    expect(check.status, '見つかった直書きを捨てて ✅ に戻している').not.toBe('ok')
    expect(check.note).toContain('server.js')
    expect(check.note).toContain('残りません')
  })

  it('★★ 打ち切られ、かつ直書きも見つかった回は、その場所を名指しして「残りません」と言う', async () => {
    setupProject({ storage: true })                     // koto-data も使っている（書き直しの途中）
    fs.writeFileSync(
      path.join(projectDir, 'server.js'),
      "const fs = require('fs')\nfs.writeFileSync('./data.json', '{}')\n",
      'utf-8',
    )
    makeScanTruncate()
    const { check } = await storageCheck()
    expect(check.note).toContain('server.js')
    expect(check.note).toContain('データは残りません（何もしなくても消えることがあります）')
    expect(check.note).not.toContain('公開のたびに消えます') // 直す前の形
    expect(check.note).not.toContain('データは残ります')
  })

  it('★ 画面に出る文に Markdown 記法を混ぜない（素のテキストとして出る）', async () => {
    for (const storage of [true, false]) {
      setupProject({ storage })
      const { result } = await storageCheck()
      for (const c of result.checks as { note: string }[]) expect(c.note).not.toMatch(/\*\*|`/)
    }
  })
})
