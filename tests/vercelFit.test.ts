import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serverListens, looksLikeFramework, judgeVercelFit } from '../src/shared/vercelFit'
import { summarizePreflight } from '../src/shared/preflight'

// ── なぜ要るか（2026-08-15）──────────────────────────────────────────
// Vercel の公開ボタンには確認が無く、注意書きは折りたたみの中にしか無かった。
// 常駐サーバのアプリを公開すると**デプロイは成功し、ソースが丸見えのページが出る**。
// 「成功と表示されながら壊れている」のがいちばん質の悪い失敗である（掟10）。

const dataTestServer = `
import http from 'node:http'
import { list, get, save, remove } from './koto-data.js'
http.createServer(async (req, res) => { res.end('hi') }).listen(process.env.PORT || 8080)
`

describe('常駐サーバかどうかを見分ける', () => {
  it('実機の data-test（http.createServer）を見分ける', () => {
    expect(serverListens(dataTestServer)).toBe(true)
  })

  it('express / fastify の定番も見分ける', () => {
    expect(serverListens("const app = express()\napp.listen(3000)")).toBe(true)
    expect(serverListens("fastify.listen({ port: 3000 })")).toBe(true)
  })

  it('ブラウザ側のコードを常駐サーバと誤解しない', () => {
    expect(serverListens("document.addEventListener('click', () => {})")).toBe(false)
    expect(serverListens("export function list() { return fetch('/api') }")).toBe(false)
  })
})

describe('Vercel が得意な作りかどうか', () => {
  it('Next.js を見分ける', () => {
    expect(looksLikeFramework({ dependencies: { next: '15.0.0' } })).toBe(true)
  })

  it('ビルドのあるプロジェクトを見分ける', () => {
    expect(looksLikeFramework({ scripts: { build: 'vite build' } })).toBe(true)
  })

  it('ただの package.json をフレームワークと決めつけない', () => {
    expect(looksLikeFramework({ name: 'x', scripts: { start: 'node server.js' } })).toBe(false)
    expect(looksLikeFramework(null)).toBe(false)
  })
})

describe('公開する前の確認（Vercel）', () => {
  it('★ 常駐サーバは止める — 公開先を変える道を示す', () => {
    const checks = judgeVercelFit({ packageJson: { name: 'data-test' }, listens: ['server.js'], usesData: [], hasStorage: false, hasFiles: true })
    const r = summarizePreflight(checks)
    expect(r.canPublish).toBe(false)
    const runtime = checks.find(c => c.id === 'runtime')!
    expect(runtime.status).toBe('ng')
    expect(runtime.note).toContain('AppRun')     // どうすればよいかまで書く
    expect(runtime.fix).toBe('ask-ai')
  })

  // ── 2026-09-24: 渡せるようになったので、もう止めない ──────────────────
  // 制約は Vercel 側ではなく Koto 側だった（環境変数を渡す口が無かっただけ）。
  // 実際に渡していることは tests/vercelStorageEnv.test.ts が偽の client で固定している。
  it('★ データを使うアプリを、もう止めない（保存場所の設定は公開時に渡す）', () => {
    // `writesFiles: []` ＝「ファイルに直接書いている箇所は**無いと確かめた**」。
    // 渡さない（分からない）ときに言い切らないことは、下の describe で固定している。
    const checks = judgeVercelFit({ packageJson: null, listens: [], usesData: ['app.js'], hasStorage: true, hasFiles: true, writesFiles: [] })
    expect(summarizePreflight(checks).canPublish).toBe(true)
    const storage = checks.find(c => c.id === 'storage')!
    expect(storage.status).not.toBe('ng')
    expect(storage.note).not.toContain('読み書きできません')
    expect(storage.note).toContain('データは残ります')
  })

  it('★ できないことを隠さない — サーバーレス関数の中から呼ぶよう添える', () => {
    const checks = judgeVercelFit({ packageJson: { dependencies: { next: '15' } }, listens: [], usesData: ['app.js'], hasStorage: true, hasFiles: true })
    const storage = checks.find(c => c.id === 'storage')!
    // ブラウザでは動かない（koto-data は Node の部品）。**どこから呼べばよいかまで書く。**
    expect(storage.note).toContain('ブラウザからは使えません')
    expect(storage.note).toContain('サーバーレス関数')
    expect(storage.note).toContain('中から呼んでください')
    // 利用者向けの文。画面には素のテキストとして出る（Markdown 記法を使わない）
    expect(storage.note).not.toMatch(/\*\*|`/)
    expect(storage.fix).toBe('ask-ai')
  })

  it('★ 作りでは分けない — 静的サイトでも Next.js でも同じ注記を出す', () => {
    const note = (packageJson: unknown) =>
      judgeVercelFit({ packageJson, listens: [], usesData: ['app.js'], hasStorage: true, hasFiles: true }).find(c => c.id === 'storage')!.note
    // `looksLikeFramework` は build スクリプトがあれば真になる緩い判定。
    // 見分けを間違えると「公開できるはずのものを止める」か「動かないものを通す」になるので、
    // **判定は変えず、注記で正直に伝える**（案1）。
    expect(note(null)).toBe(note({ dependencies: { next: '15' } }))
    expect(note({ scripts: { build: 'vite build' } })).toBe(note(null))
  })

  it('★ データの置き場所を正しく伝える（保存場所はさくら＝国内）', () => {
    const checks = judgeVercelFit({ packageJson: null, listens: [], usesData: ['app.js'], hasStorage: true, hasFiles: true })
    expect(checks.find(c => c.id === 'storage')!.note).toContain('日本国内')
  })

  // ── 2026-09-24 検分の指摘1・4・12: 保存場所が未用意なら「残ります」と言わない ──────
  // 用意していないプロジェクトでは `issueStorageEnvFor` が reason:'none' を返し、
  // **環境変数を1件も渡さないまま公開が成功する**。そのとき `koto-data` は手元のフォルダ
  // （`.koto-data`）へ落ちるので、Vercel では書けたように見えて次の公開で消える。
  // 「残ります」と読ませたまま公開させるのが、いちばん気づけない壊れ方。
  const storageNote = (hasStorage: boolean, writesFiles: readonly string[] = []) =>
    judgeVercelFit({ packageJson: null, listens: [], usesData: ['app.js'], hasStorage, hasFiles: true, writesFiles })
      .find(c => c.id === 'storage')!

  it('★ 保存場所が未用意のとき「データは残ります」と言わない', () => {
    const storage = storageNote(false)
    expect(storage.note).not.toContain('データは残ります')
    expect(storage.note).toContain('残りません')
    // 直し方まで書く（どこを押せばよいか）
    expect(storage.note).toContain('保存場所を用意する')
  })

  it('★ 保存場所が未用意でも公開は止めない（warn どまり）', () => {
    const storage = storageNote(false)
    expect(storage.status).toBe('warn')
    expect(summarizePreflight(judgeVercelFit({
      packageJson: null, listens: [], usesData: ['app.js'], hasStorage: false, hasFiles: true,
    })).canPublish).toBe(true)
  })

  it('★ 用意済みと未用意で、注記が実際に変わる（同じ文を出さない）', () => {
    expect(storageNote(true).note).not.toBe(storageNote(false).note)
    expect(storageNote(true).note).toContain('データは残ります')
  })

  // ── 2026-09-24 検分の指摘8: 静的サイトの人にも逃げ道を示す ─────────────────
  // 「サーバーレス関数の中から呼んでください」で終わると、package.json を持たない
  // 純粋な静的サイトの人には**呼ぶ場所そのものが無い**。常駐サーバの分岐と同じく、
  // 公開先を変えればそのまま使えることを添える。
  it('★ サーバーレス関数が無いアプリへの逃げ道を示す（公開先を変えれば書き直さずに使える）', () => {
    for (const hasStorage of [true, false]) {
      const note = storageNote(hasStorage).note
      expect(note).toContain('ページだけのサイト')
      expect(note).toContain('AppRun')
      expect(note).toContain('HANAMII')
      expect(note).toContain('書き直さずに')
    }
  })

  it('データを使わないアプリには、余計な注記を出さない', () => {
    const checks = judgeVercelFit({ packageJson: null, listens: [], usesData: [], hasStorage: false, hasFiles: true })
    const storage = checks.find(c => c.id === 'storage')!
    expect(storage.status).toBe('ok')
    expect(storage.note).not.toContain('サーバーレス関数')
  })

  it('静的サイトは通す', () => {
    const checks = judgeVercelFit({ packageJson: null, listens: [], usesData: [], hasStorage: false, hasFiles: true })
    expect(summarizePreflight(checks).canPublish).toBe(true)
    expect(checks.every(c => c.status === 'ok')).toBe(true)
  })

  it('Next.js も通す', () => {
    const checks = judgeVercelFit({ packageJson: { dependencies: { next: '15' } }, listens: [], usesData: [], hasStorage: false, hasFiles: true })
    expect(summarizePreflight(checks).canPublish).toBe(true)
  })

  it('判別できないものは止めない（warn どまり）', () => {
    const checks = judgeVercelFit({ packageJson: { name: 'x' }, listens: [], usesData: [], hasStorage: false, hasFiles: true })
    const r = summarizePreflight(checks)
    expect(r.canPublish).toBe(true)
    expect(checks.find(c => c.id === 'runtime')!.status).toBe('warn')
  })

  it('ファイルが無ければ止める', () => {
    const checks = judgeVercelFit({ packageJson: null, listens: [], usesData: [], hasStorage: false, hasFiles: false })
    expect(summarizePreflight(checks).canPublish).toBe(false)
  })
})

// ── ファイル直書きが残っているとき、「データは残ります」と言わない（2026-09-24 検分）──
// 書き直しの途中（koto-data も使うが fs.writeFileSync も残っている）アプリでは、
// 保存場所を用意してあっても**ファイルに書いたぶんは公開のたびに消える**。
// 同じ③公開の画面で、上の枠（storageNeed.ts）が「⚠️ 残っています」と言い、
// 下の確認が「✅ データは残ります」と言う——利用者は下を信じて公開する。
describe('公開する前の確認（Vercel）: ファイル直書きが残っているとき', () => {
  const storage = (opts: { hasStorage: boolean; usesData: string[]; writesFiles?: readonly string[] }) =>
    judgeVercelFit({
      packageJson: null, listens: [], hasFiles: true,
      usesData: opts.usesData, hasStorage: opts.hasStorage, writesFiles: opts.writesFiles,
    }).find(c => c.id === 'storage')!

  it('★ 保存場所を用意してあっても、直書きが残っていれば「データは残ります」と言わない', () => {
    const c = storage({ hasStorage: true, usesData: ['app.js'], writesFiles: ['server.js'] })
    expect(c.note).not.toContain('データは残ります')
    expect(c.note).toContain('ファイルに直接書いている箇所が残っている')
    // W-30（2026-09-27 決定・案1）: 「公開のたびに消えます」では弱すぎるため、
    // 「残りません（何もしなくても消えることがあります）」に揃えた。
    expect(c.note).toContain('データは残りません（何もしなくても消えることがあります）')
    expect(c.note).not.toContain('公開のたびに消えます') // 直す前の形
    // 直し方まで書く（どこを押せばよいか）
    expect(c.note).toContain('AIに書き直してもらう')
    expect(c.status).toBe('warn')          // **止めはしない**（canPublish は true のまま）
    expect(c.fix).toBe('ask-ai')
  })

  it('★ 直書きが残っていて保存場所も無いときは、両方を言う', () => {
    const c = storage({ hasStorage: false, usesData: ['app.js'], writesFiles: ['server.js'] })
    expect(c.note).toContain('ファイルに直接書いている箇所が残っている')
    expect(c.note).toContain('保存場所を用意する')
    expect(c.note).not.toContain('データは残ります')
  })

  it('★ 直書きが無いと確かめたときだけ言い切る（同じ文を出さない）', () => {
    const clean = storage({ hasStorage: true, usesData: ['app.js'], writesFiles: [] })
    const dirty = storage({ hasStorage: true, usesData: ['app.js'], writesFiles: ['server.js'] })
    expect(clean.note).toContain('データは残ります')
    expect(clean.note).not.toBe(dirty.note)
  })

  // **渡し忘れても、断定しない側へ倒れる**（`writesFiles` は任意なので、呼ぶ側が
  // 渡さないことがある。そのとき「無い」に倒すと、また断定できないことを断定する）。
  it('★ 渡されていない（分からない）ときは「データは残ります」と言い切らない', () => {
    const c = storage({ hasStorage: true, usesData: ['app.js'] })
    expect(c.note).not.toContain('データは残ります')
    expect(c.note).toContain('koto-data に保存したぶんは残ります')
    expect(c.note).toContain('ファイルに直接書いている箇所が残っていると')
    expect(c.note).toContain('日本国内')
  })

  it('★ koto-data を使わず直書きだけのアプリを、丸ごと ✅ にしない', () => {
    const c = storage({ hasStorage: false, usesData: [], writesFiles: ['server.js'] })
    expect(c.status).toBe('warn')
    expect(c.note).not.toContain('データの保存を使っていません。')
    expect(c.note).toContain('残りません')
    expect(c.fix).toBe('ask-ai')
    expect(summarizePreflight(judgeVercelFit({
      packageJson: null, listens: [], usesData: [], hasStorage: false, hasFiles: true, writesFiles: ['server.js'],
    })).canPublish).toBe(true)   // 止めはしない
  })

  it('★ 直書きも保存も無いアプリには、余計な注記を出さない（従来どおり）', () => {
    const c = storage({ hasStorage: false, usesData: [], writesFiles: [] })
    expect(c.status).toBe('ok')
    expect(c.note).toBe('このアプリはデータの保存を使っていません。')
  })

  it('★ どの分かれ道でも、画面に出る文に Markdown 記法を混ぜない', () => {
    for (const w of [undefined, [], ['server.js']] as (readonly string[] | undefined)[]) {
      for (const hasStorage of [true, false]) {
        for (const usesData of [[], ['app.js']]) {
          expect(storage({ hasStorage, usesData, writesFiles: w }).note).not.toMatch(/\*\*|`/)
        }
      }
    }
  })
})

// ── 配線が外れていないか（掟6の3点セット＋UI）────────────────────────
// 判断だけ正しくても、画面に出ていなければ利用者は救われない。
describe('確認が画面まで届いている', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

  it('main / preload / 型 の3点が揃っている', () => {
    expect(read('src/main/ipc/vercel.ts')).toContain("ipcMain.handle('vercel:preflight'")
    expect(read('src/main/preload.ts')).toContain("ipcRenderer.invoke('vercel:preflight'")
    expect(read('src/renderer/global.d.ts')).toMatch(/preflight\(projectDir: string\)/)
  })

  // 実際に効いているか（開いた時点で走る・用意した直後に取り直す）は、
  // tests/vercelPanelRefresh.test.ts が**関数を動かして**固定している。
  it('★ 押さなくても確認が出る（Vercel の失敗は静かなので）', () => {
    const src = read('src/renderer/components/VercelPanel.tsx')
    // **緩めない**（2026-09-25 検分の指摘39）。ここは一度 `toContain('void runPreflight()')` に
    // 書き換えられていた。それだと「用意した直後に取り直す」側の
    // `const onPrepared = () => { void runPreflight() }` にも当たってしまい、
    // **開いた時点で走る呼び出しを丸ごと消しても緑のまま**になる。
    // 見るのは「useEffect の本体が、いきなり runPreflight を呼んでいる」こと。
    expect(src).toMatch(/useEffect\(\(\) => \{\s*void runPreflight\(\)/)
  })

  it('★ 壊れると分かっているものを、一度の操作で公開しない', () => {
    const src = read('src/renderer/components/VercelPanel.tsx')
    expect(src).toContain('canPublish === false && !confirmBroken')
  })
})
