import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { zipExcludePatterns, BUILD_CONFIG_FILES } from '../src/shared/publishExclude'

// HANAMII へ送る ZIP の中身の決まりを固定する（2026-08-20）。
//
// ── 分かっていること（2026-07-03 実測・docs/sakura-requests.md）──────────
// HANAMII の check API は言語マニフェスト（package.json 等）を必須とし、
// **待受ポートを Dockerfile の EXPOSE から判定する**。
// 純粋な静的サイトは拒否されるため、Koto が最小サーバ＋EXPOSE 付き Dockerfile を同梱する。
//
// ── そこから導かれる決まり ────────────────────────────────────────────
//   ・Koto が Dockerfile を同梱するとき（静的サイト）は、プロジェクト側の
//     ビルド設定を**外す**。同じ名前が2つ入ると、どちらが使われるか決まらないため。
//   ・マニフェストがあるときは**外さない**。HANAMII がプロジェクトのものを
//     使う可能性があり、外して壊れないことを確かめられていない（掟1）。
//
// zip の実行は electron 依存で import できないので、**ソースを読んで配線を確かめる**
// （imageBuildWiring.test.ts と同じ流儀）。

const SRC = path.join(__dirname, '..', 'src', 'main', 'ipc', 'hanamii.ts')
const source = fs.readFileSync(SRC, 'utf-8')

describe('HANAMII へ送る ZIP', () => {
  it('除外は一元定義から取っている（手で並べ直さない・掟10）', () => {
    expect(source).toContain('zipExcludePatterns(')
  })

  it('Koto が Dockerfile を同梱するときだけ、プロジェクト側のビルド設定を外す', () => {
    // extra があるとき＝静的サイト＝Koto が Dockerfile を入れるとき。
    expect(source).toContain('zipProjectToBuffer(root, extra, !!extra)')
    expect(source).toContain('dropBuildConfig ? [...BUILD_CONFIG_FILES] : []')
  })

  it('送るのは public/ の中身（ZIPのルート直下に言語マニフェストが来る）', () => {
    // HANAMII は ZIP のルート直下の package.json 等で言語を判定する。
    // 根がずれると公開を拒否される（2026-07-03 実測）。
    expect(source).toContain('const root = resolvePublishRoot(projectDir)')
    expect(source).toContain("fs.existsSync(path.join(root, 'index.html'))")
  })

  it('Koto が同梱する Dockerfile には EXPOSE が付いている', () => {
    // HANAMII は EXPOSE から待受ポートを判定する。無いと公開が失敗する。
    expect(source).toContain('EXPOSE 8080')
  })

  it('外すのは、そのまま配信される公開先と同じ顔ぶれ', () => {
    const dropped = zipExcludePatterns([...BUILD_CONFIG_FILES])
    for (const f of ['Dockerfile', 'nginx.conf', '.dockerignore']) {
      expect(dropped, `${f} が残ってしまう`).toContain(f)
    }
  })

  it('既定（マニフェストあり）では外さない', () => {
    const kept = zipExcludePatterns()
    for (const f of ['Dockerfile', 'nginx.conf', '.dockerignore']) {
      expect(kept, `${f} を勝手に外している`).not.toContain(f)
    }
  })
})
