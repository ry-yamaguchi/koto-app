import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// ── 配線の固定（2026-09-29・掟6・掟10）──────────────────────────────────────────
//
// 振る舞い（main が書く直前にディスクから読み直して当てる）は tests/projectMetaStale.test.ts が
// 本物のファイルで固定している。ここは、**renderer の全部の書き込み口が、その1つの入口
// （src/renderer/projectMeta.ts）を通っている**ことを、ソースで固定する。
//
// 直す前は、9か所（PublishModal・HANAMII・Vercel・VPS・専有型・GitHub保存・公開先の変更・資料設定・
// 記録の片づけ）が、それぞれ .sakuraide.json を読んで・マージして・全体を書き戻していた。
// 1か所だけ直しても、ほかの8か所が同じ穴を残す（「一部だけ直す」は何度も起きている）。
//
// 当て先が他の行に出ないかを確認済み: 「直す前の形」は `fs.writeFile(` の**第1引数**が
// `metaPath` か `.sakuraide.json` を含むかで見る。ほかの `fs.writeFile(`（エディタの保存・
// 新規ファイル・資料の Markdown）は第1引数がこれらを含まないので当たらない。

const ROOT = path.join(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
/** コメント行を除く（当て先がコメントに出るのを避ける）。 */
const code = (rel: string): string => read(rel).split('\n')
  .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*'))
  .join('\n')

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) out.push(p)
  }
  return out
}

/** `fs.writeFile(<第1引数>` の第1引数が .sakuraide.json（の変数）を指している呼び出し。 */
const DIRECT_META_WRITE = /fs\.writeFile\(\s*(?:metaPath\b|`[^`]*\.sakuraide\.json`|'[^']*\.sakuraide\.json'|"[^"]*\.sakuraide\.json")/g

describe('★★★ renderer は .sakuraide.json へ直接書かない（書き込みは main の1か所・入口は projectMeta.ts）', () => {
  it('検出器の自己確認: 直す前の書き方（変数・テンプレート文字列）を、両方とも拾える', () => {
    expect('await window.electronAPI.fs.writeFile(metaPath, JSON.stringify(next, null, 2))'.match(DIRECT_META_WRITE)).toHaveLength(1)
    expect('await window.electronAPI.fs.writeFile(`${projectDir}/.sakuraide.json`, JSON.stringify(next, null, 2))'.match(DIRECT_META_WRITE)).toHaveLength(1)
    expect('await window.electronAPI.fs.writeFile(file, JSON.stringify(next, null, 2))'.match(DIRECT_META_WRITE)).toBeNull() // 変数名が違っても…
    // …ので、下の「書き下した一覧」も別に固定する
    expect('await window.electronAPI.fs.writeFile(filePath, content)'.match(DIRECT_META_WRITE)).toBeNull()
    expect('await window.electronAPI.fs.writeFile(`${dir}/${localName}`, page.markdown)'.match(DIRECT_META_WRITE)).toBeNull()
  })

  it('★ src/renderer のどこにも、.sakuraide.json への直接の fs.writeFile が無い', () => {
    const hits: string[] = []
    for (const f of walk(path.join(ROOT, 'src/renderer'))) {
      const rel = path.relative(ROOT, f)
      const src = code(rel)
      for (const m of src.matchAll(DIRECT_META_WRITE)) hits.push(`${rel}: ${m[0]}`)
    }
    expect(hits).toEqual([])
  })

  it('★ 記録を読んで書き戻していた9つの口は、すべて projectMeta.ts の入口を通っている（書き下し）', () => {
    const MUST: Array<[file: string, needle: string]> = [
      ['src/renderer/components/PublishModal.tsx', 'const snap = await mergeProjectMetaThenLoad(projectDir, patch as Record<string, unknown>)'],
      ['src/renderer/components/PublishModal.tsx', 'applySnapshot(await forgetPublishTargetThenLoad(projectDir, t))'],
      ['src/renderer/components/PublishModal.tsx', 'await dismissInterruptedPublish(projectDir)'],
      ['src/renderer/components/PublishModal.tsx', 'await saveMeta(rentalPublishPatch({ account, host, publishedAt }))'],
      ['src/renderer/components/HanamiiPanel.tsx', "await mergeProjectMeta(projectDir, {\n      target: 'hanamii',"],
      ['src/renderer/components/VercelPanel.tsx', "await mergeProjectMeta(projectDir, {\n      target: 'vercel',"],
      ['src/renderer/components/VpsPanel.tsx', "await mergeProjectMeta(projectDir, { target: 'sakura-vps', publish: { vps: v } })"],
      ['src/renderer/components/AppRunDedicatedPanel.tsx', "target: 'sakura-apprun-dedicated',\n      publish: { apprunDedicated: patch },"],
      ['src/renderer/components/GithubSaveModal.tsx', 'await mergeProjectMeta(projectDir, { github: gh })'],
      ['src/renderer/App.tsx', 'await mergeProjectMeta(currentDir, { target: newTarget })'],
      ['src/renderer/ragContext.ts', 'await mergeProjectMeta(projectDir, ragSettingsPatch(next))'],
      ['src/renderer/publishRecord.ts', 'await forgetPublishTargetRecord(projectDir, target)'],
    ]
    for (const [file, needle] of MUST) {
      expect(code(file), `${file}: ${needle}`).toContain(needle)
    }
  })

  it('直す前の形（読んで・マージして・全体を書き戻す）が、どの口にも残っていない', () => {
    const FORBIDDEN: Array<[file: string, needle: string]> = [
      ['src/renderer/components/HanamiiPanel.tsx', 'hanamii: { ...(m.publish?.hanamii ?? {}), ...h }'],
      ['src/renderer/components/VercelPanel.tsx', 'vercel: { ...(m.publish?.vercel ?? {}), ...v }'],
      ['src/renderer/components/VpsPanel.tsx', 'vps: { ...(m.publish?.vps ?? {}), ...v }'],
      ['src/renderer/components/GithubSaveModal.tsx', 'github: { ...(m.github ?? {}), ...gh }'],
      ['src/renderer/components/AppRunDedicatedPanel.tsx', 'const merged = withApprunDedicatedRecord(m, patch)'],
      ['src/renderer/App.tsx', 'meta.target = newTarget'],
      ['src/renderer/ragContext.ts', 'mergeRagSettings'],
      ['src/renderer/publishRecord.ts', 'withoutPublishTarget(meta?.publish, target)'],
    ]
    for (const [file, needle] of FORBIDDEN) {
      expect(code(file), `${file}: ${needle}`).not.toContain(needle)
    }
  })
})

describe('★★★ PublishModal: 開いたときの写し（state の meta）で全体を書き戻さない', () => {
  const FILE = 'src/renderer/components/PublishModal.tsx'

  it('★ 直す前の saveMeta（古い写しで全体を書き戻す式）が無い', () => {
    const s = code(FILE)
    expect(s).not.toContain('{ ...meta, ...patch, publish: { ...meta.publish, ...patch.publish } }')
    expect(s).not.toContain('publish: { ...meta.publish, ...patch.publish }')
    expect(s).not.toContain('JSON.stringify(next, null, 2)')
    expect(s).not.toContain('fs.writeFile(')
  })

  it('★ 「記録を片づける」は、画面の写し（meta.publish）から作った全体を書き戻さない', () => {
    const s = code(FILE)
    expect(s).not.toContain('withoutPublishTarget(meta.publish')
    expect(s).not.toContain("import { withoutPublishTarget")
  })

  it('★ レンタル公開の差分に、画面の写しの publish.targets を混ぜない（自分の行だけを渡す）', () => {
    const s = code(FILE)
    expect(s).not.toContain('...meta.publish?.targets')
    expect(s).not.toContain('...meta.publish')
    // 差分の中身は rentalPublishPatch（projectMeta.ts）。自分の行（'sakura-rental'）だけを渡す
    const helper = code('src/renderer/projectMeta.ts')
    expect(helper).toContain("targets: { 'sakura-rental': { publishedAt: args.publishedAt, url } },")
  })

  it('★ 記録は書く直前ではなく、開いたときに読む写しなので、読むのは loadPublishSnapshot（走っているかを先に聞く）を通す', () => {
    const s = code(FILE)
    expect(s).toContain('await loadPublishSnapshot(projectDir)')
    // 記録（.sakuraide.json）を直接読む形に戻っていない（state.json の救済読みは別物）
    expect(s).not.toContain('`${projectDir}/.sakuraide.json`')
  })

  it('★ 「確認しました」は中断の可能性のときだけ出る（進んでいる最中は消せない）。走っている間は終わるのを待って更新する', () => {
    const s = code(FILE)
    expect(s).toContain("{pendingView.kind === 'interrupted' && (")
    const at = s.indexOf("{pendingView.kind === 'interrupted' && (")
    expect(s.indexOf('onClick={dismissInterruptedNotice}', at)).toBeGreaterThan(at)
    // 走っている操作があるあいだ、3秒ごとに聞き直し、走っている操作の名前が変わったら（終わったら）読み直す。
    // 2026-09-29: 以前は「公開」のときだけだった。処理の記録（projectOps）を出す作者の決定 ①②で、公開に限らず
    // 作成・削除でも同じ道にした（走っているかの聞き直しは、この同じ 3 秒のポーリングと共用する）。
    expect(s).toContain('if (runningOp === null) return')
    expect(s).toContain('if (snap.runningOp !== runningOp) applySnapshot(snap)')
    expect(s).toContain('window.setInterval(async () => {')
    expect(s).toContain('const OPS_POLL_MS = 3000')
    expect(s).toContain('}, OPS_POLL_MS)')
    expect(s).toContain('return () => window.clearInterval(id)')
  })
})

describe('publishPending.ts: 直接書く口を残していない（残骸）', () => {
  it('書き込み（fs.writeFile）も markPublishPending も無い', () => {
    const s = code('src/renderer/publishPending.ts')
    expect(s).not.toContain('writeFile')
    expect(s).not.toContain('markPublishPending')
    expect(s).toContain('dismissInterruptedPublish(projectDir)')
  })
})

describe('IPC の3点セット（掟6）: publishMeta:merge / forgetTarget / dismissInterrupted / runningOp', () => {
  const CHANNELS = ['merge', 'forgetTarget', 'dismissInterrupted', 'runningOp']

  it('main: ハンドラを登録し、index.ts が登録関数を呼んでいる', () => {
    const main = code('src/main/ipc/publishMeta.ts')
    for (const c of CHANNELS) expect(main, c).toContain(`ipcMain.handle('publishMeta:${c}'`)
    const index = code('src/main/ipc/index.ts')
    expect(index).toContain("import { registerPublishMetaHandlers } from './publishMeta'")
    expect(index).toContain('registerPublishMetaHandlers()')
  })

  it('preload.ts: 4つとも invoke で繋がっている', () => {
    const preload = code('src/main/preload.ts')
    for (const c of CHANNELS) expect(preload, c).toContain(`ipcRenderer.invoke('publishMeta:${c}'`)
    expect(preload).toContain('publishMeta: {')
  })

  it('global.d.ts: 4つとも型がある', () => {
    const dts = code('src/renderer/global.d.ts')
    expect(dts).toContain('publishMeta: {')
    expect(dts).toContain('merge(projectDir: string, patch: Record<string, unknown>)')
    expect(dts).toContain('forgetTarget(projectDir: string, target: string)')
    expect(dts).toContain('dismissInterrupted(projectDir: string)')
    expect(dts).toContain("runningOp(projectDir: string): Promise<'作成' | '削除' | '公開' | null>")
  })
})
