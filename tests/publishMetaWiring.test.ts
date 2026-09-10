import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// roadmap #20: 公開の記録（publish.targets への書き込み）と開始マーカーの後片づけ
// （publish.pending の削除）を renderer から main へ移した配線を固定する。
//
// ── 背景（#14 の調査で判明・2026-08-31）───────────────────────────────
// 公開そのもの（hanamii.publish / cloud.apply / vercel.publish）は main の1 invoke で
// 完走するので窓を閉じても中断されないが、公開の記録と pending の後片づけは従来 renderer 側
// にあったため、公開中に閉じると「公開は完了しているのに記録が残らない」状態になっていた
// （HANAMII は projectId が保存されないと次回の公開が二重作成になりうる）。
//
// electron に依存するファイルは import できないので、ソースを読んで配線を確かめる
// （publishRootWiring.test.ts / learningWiring.test.ts と同じ流儀）。
// must は**呼び出しの形そのもの**を書く（「どこかに書いてある」だけでは直し忘れを捕まえられない・掟10）。

const ROOT = path.join(__dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

describe('main の3経路: markPendingFs / clearPendingFs / writePublishRecordFs を呼んでいる', () => {
  const CONSUMERS: { name: string; file: string; imports: string; mark: string; clear: string; record: string }[] = [
    {
      name: 'HANAMII（hanamii:publish）',
      file: 'src/main/ipc/hanamii.ts',
      imports: "import { markPendingFs, clearPendingFs, writePublishRecordFs, writeHanamiiProjectIdFs } from '../publishMetaFs'",
      mark: "markPendingFs(projectDir, 'hanamii')",
      clear: 'finally { clearPendingFs(projectDir) }',
      record: "writePublishRecordFs(projectDir, 'hanamii', { publishedAt: new Date().toISOString(), url: null })",
    },
    {
      name: 'Vercel（vercel:publish）',
      file: 'src/main/ipc/vercel.ts',
      imports: "import { markPendingFs, clearPendingFs, writePublishRecordFs } from '../publishMetaFs'",
      mark: "markPendingFs(projectDir, 'vercel')",
      clear: 'clearPendingFs(projectDir)',
      record: "writePublishRecordFs(projectDir, 'vercel', { publishedAt: new Date().toISOString(), url: info.url ?? null })",
    },
    {
      name: 'さくらのAppRun（cloud:apply）',
      file: 'src/main/ipc/cloud.ts',
      // 2026-09-10: 棚卸し（cloud:inventory）が専有型クラスタとの突き合わせのため
      // readApprunDedicatedFs も同じ import 文で読むようになった（読むだけで使う。
      // src/main/publishMetaFs.ts は他エージェントの持ち場のため変更していない）。
      imports: "import { markPendingFs, clearPendingFs, writePublishRecordFs, readApprunDedicatedFs } from '../publishMetaFs'",
      mark: "markPendingFs(projectDir, 'sakura-apprun')",
      clear: 'clearPendingFs(projectDir)',
      record: "writePublishRecordFs(projectDir, 'sakura-apprun', { publishedAt: new Date().toISOString(), url: publicUrl })",
    },
  ]

  for (const c of CONSUMERS) {
    it(`${c.name}: publishMetaFs を import し、開始時にmark・完了時にclear・成功時に記録する`, () => {
      const s = read(c.file)
      expect(s).toContain(c.imports)
      expect(s).toContain(c.mark)
      expect(s).toContain(c.clear)
      expect(s).toContain(c.record)
    })
  }

  it('HANAMII: projectId も main 側で保存する（二重作成の防止）', () => {
    const s = read('src/main/ipc/hanamii.ts')
    expect(s).toContain('writeHanamiiProjectIdFs(projectDir, projectId ?? null)')
  })

  it('★★ 3経路とも clearPendingFs は try/catch の外（finally）で呼ばれている（成功/失敗どちらでも消える）', () => {
    for (const rel of ['src/main/ipc/hanamii.ts', 'src/main/ipc/vercel.ts', 'src/main/ipc/cloud.ts']) {
      const s = read(rel)
      // finally ブロックの中に clearPendingFs(projectDir) がある形を確かめる
      // （catch の中や try の中だけに書かれていると、別の失敗経路で後片づけが漏れる）。
      expect(s).toMatch(/finally\s*\{\s*(\/\/[^\n]*\n\s*)?clearPendingFs\(projectDir\)/)
    }
  })
})

describe('renderer の3パネル: markPublishPending / clearPublishPending / saveAppRunPublishRecord の呼び出しが残っていない', () => {
  // ── なぜこの3つを禁止するか ──────────────────────────────────────────
  // main が pending のマーク/後片づけと公開記録の保存を担うようになったため、renderer 側が
  // 二重に同じことをすると、書き込みが競合したり、片方だけ直されて食い違う穴になる（掟10）。
  const PANELS = [
    'src/renderer/components/HanamiiPanel.tsx',
    'src/renderer/components/VercelPanel.tsx',
    'src/renderer/components/AppRunPanel.tsx',
  ]

  for (const rel of PANELS) {
    it(`${rel}: markPublishPending( / clearPublishPending( / saveAppRunPublishRecord( を含まない`, () => {
      const s = read(rel)
      expect(s).not.toContain('markPublishPending(')
      expect(s).not.toContain('clearPublishPending(')
      expect(s).not.toContain('saveAppRunPublishRecord(')
      // publishPending.ts 自体の import も残していない（呼び出しだけでなく引き込みも消す）
      expect(s).not.toContain("from '../publishPending'")
    })
  }
})

describe('消しすぎの検出: HanamiiPanel のポーリングによる URL 更新（main では取れない）は残っている', () => {
  it('startPolling が READY 後に publish.targets の url を saveHanamiiMeta で書き込む形が残っている', () => {
    const s = read('src/renderer/components/HanamiiPanel.tsx')
    expect(s).toContain('await saveHanamiiMeta({}, { publishedAt: prevAt, url: r.url })')
  })
})

describe('消しすぎの検出: 公開成功後、main の書いた記録を画面へ反映する経路が残っている', () => {
  it('HanamiiPanel: 公開成功時に saveHanamiiMeta（読み直し＋sakura-meta-changed）を呼んでいる', () => {
    const s = read('src/renderer/components/HanamiiPanel.tsx')
    expect(s).toContain('await saveHanamiiMeta(\n          { projectId: pid, workspaceId, envs: persistEnvs, tokenId, healthCheck: { enabled: healthCheck.enabled, path: healthCheck.path }, name },\n        )')
  })

  it('VercelPanel: 公開成功時に saveVercelMeta（読み直し＋sakura-meta-changed）を呼んでいる', () => {
    const s = read('src/renderer/components/VercelPanel.tsx')
    expect(s).toContain('await saveVercelMeta({ tokenId, name })')
  })

  it('AppRunPanel: 適用成功時に sakura-meta-changed を通知している（App.tsx の reloadMeta が拾う）', () => {
    const s = read('src/renderer/components/AppRunPanel.tsx')
    // 2026-09-08 検分で、この分岐に refreshRegistryName()（錠前の直し2）が足された。
    // 呼び出しの形ごと見る（掟10）: if (r.ok) の中に両方入っていること。
    const at = s.indexOf('const doApply = async () => {')
    expect(at).toBeGreaterThan(0)
    const end = s.indexOf('\n  const doTeardown = async () => {', at)
    expect(end).toBeGreaterThan(at)
    const block = s.slice(at, end)
    const okAt = block.indexOf('if (r.ok) {')
    expect(okAt).toBeGreaterThan(0)
    const okEnd = block.indexOf('\n      }', okAt)
    const okBlock = block.slice(okAt, okEnd)
    expect(okBlock).toContain('refreshRegistryName()')
    expect(okBlock).toContain("window.dispatchEvent(new Event('sakura-meta-changed'))")
  })
})
