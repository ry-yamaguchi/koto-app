import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildProjectContext } from '../src/renderer/aiContext'

// D-3 残作業（2026-09-15）: 公開先の表示ラベル・コンパネURLの唯一の定義は
// src/renderer/publishStatus.ts（PUBLISH_TARGET_LABEL・PUBLISH_TARGET_CONSOLE）。
//
// 'sakura-apprun-dedicated' を PublishTargetKind に足した D-3（コミット 3309360）のとき、
// aiContext.ts の TARGET_LABEL と PublishedListModal.tsx の CONSOLE_LINKS という**複製の表**は
// 更新されないまま残っていた（掟10と同じ形の穴）。
// - aiContext.ts: 専有型のキーが無いので、AIへの「公開先: 」行が生の id 'sakura-apprun-dedicated'
//   のまま渡る。
// - PublishedListModal.tsx: 'sakura-apprun' の URL が publishStatus.ts と食い違っていた
//   （複製側 https://secure.sakura.ad.jp/cloud/ ・正 https://secure.sakura.ad.jp/cloud/apprun/）。
//
// 両方とも複製をやめ、一元定義を import する形に直した。ソースを読んで、複製の表（キー・値）が
// 戻っていないことを固定する。

const root = join(__dirname, '..')
const aiContextSrc = readFileSync(join(root, 'src/renderer/aiContext.ts'), 'utf-8')
const publishedListModalSrc = readFileSync(join(root, 'src/renderer/components/PublishedListModal.tsx'), 'utf-8')

describe('aiContext.ts: TARGET_LABEL は PUBLISH_TARGET_LABEL を import して合成する（複製しない・掟10）', () => {
  it('publishStatus.ts から PUBLISH_TARGET_LABEL を import している', () => {
    expect(aiContextSrc).toContain("import { PUBLISH_TARGET_LABEL } from './publishStatus'")
  })

  it('TARGET_LABEL の合成に PUBLISH_TARGET_LABEL を展開している', () => {
    const at = aiContextSrc.indexOf('const TARGET_LABEL')
    expect(at).toBeGreaterThan(0)
    const block = aiContextSrc.slice(at, aiContextSrc.indexOf('\n\n', at))
    expect(block).toContain('...PUBLISH_TARGET_LABEL')
  })

  it('消したはずの複製ラベル（旧・自前の sakura-apprun / sakura-rental の文言）が残っていない', () => {
    // 変異試験 (a) の対象: これらの文字列を TARGET_LABEL に書き戻すとこのテストが検知する。
    expect(aiContextSrc).not.toContain('さくらのAppRun（Dockerコンテナ）')
    expect(aiContextSrc).not.toContain('さくらのレンタルサーバ（PHP + MySQL）')
  })
})

describe('buildProjectContext: 「公開先: 」行は表示ラベルになり、生の id が漏れない', () => {
  afterEach(() => {
    delete (globalThis as any).window
  })

  const withMeta = (meta: unknown) => {
    ;(globalThis as any).window = {
      electronAPI: {
        fs: {
          readFile: async () => JSON.stringify(meta),
          projectFiles: async () => [],
        },
      },
    }
  }

  it("meta.target='sakura-apprun-dedicated' は 📦 さくらのAppRun（専有型）というラベルになる。生の id のまま出ない", async () => {
    withMeta({ name: 'proj', target: 'sakura-apprun-dedicated' })
    const ctx = await buildProjectContext('/tmp/proj')
    expect(ctx).toContain('公開先: 📦 さくらのAppRun（専有型）\n')
    expect(ctx).not.toContain('公開先: sakura-apprun-dedicated')
  })

  it("meta.target='sakura-apprun'（共用型）も PUBLISH_TARGET_LABEL 由来のラベルになる", async () => {
    withMeta({ name: 'proj', target: 'sakura-apprun' })
    const ctx = await buildProjectContext('/tmp/proj')
    expect(ctx).toContain('公開先: 📦 さくらのAppRun\n')
  })

  it("meta.target='local'（PublishTargetKind に無い、公開前のプロジェクト）は従来どおりのラベル", async () => {
    withMeta({ name: 'proj', target: 'local' })
    const ctx = await buildProjectContext('/tmp/proj')
    expect(ctx).toContain('公開先: ローカルのみ（公開設定なし）\n')
  })
})

describe('PublishedListModal.tsx: 管理画面のURLは複製せず PUBLISH_TARGET_CONSOLE を使う（複製しない・掟10）', () => {
  it('publishStatus.ts から PUBLISH_TARGET_CONSOLE を import している', () => {
    expect(publishedListModalSrc).toContain('PUBLISH_TARGET_CONSOLE')
    expect(publishedListModalSrc).toMatch(/import\s*\{[^}]*PUBLISH_TARGET_CONSOLE[^}]*\}\s*from\s*'\.\.\/publishStatus'/)
  })

  it('CONSOLE_LINKS という複製の表（label と url を両方持つ表）が戻っていない', () => {
    // 変異試験 (b) の対象: この表を書き戻すとこのテストが検知する。
    expect(publishedListModalSrc).not.toContain('const CONSOLE_LINKS')
  })

  it("'sakura-apprun' の URL を直書きで複製していない（.../cloud/ のような複製の値が無い）", () => {
    // JSXの中で PUBLISH_TARGET_CONSOLE[g.target] を参照しており、URL文字列を直書きしていない。
    expect(publishedListModalSrc).toContain('href={PUBLISH_TARGET_CONSOLE[g.target]}')
    expect(publishedListModalSrc).not.toContain("'sakura-apprun': { label:")
  })
})
