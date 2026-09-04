import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 「開いているファイル」の注入の出し分け（C・#15。実測は docs/measure-openfile.md・2026-09-04）。
//
// 実測の結論:
//   ・ツール対応モデル＋ファイルが AI ルート内 → **AI相対パスの1行だけ**（中身は read_file で読む。
//     中身4000字の常時注入は毎ラウンド再送で高くつき、basename 表示が誤パス呼び出しを誘発していた）
//   ・ツール非対応モデル・ルート外・ルート未解決 → 従来どおり中身つき（内容へ届く手段が他に無い）
//
// ChatPanel は React 部品で node の vitest から呼べないため、ソースを読んで
// 「呼び出しの形そのもの」を固定する（掟10。tests/unusedWiring.test.ts と同じ流儀）。

const ROOT = path.join(__dirname, '..')
const src = fs.readFileSync(path.join(ROOT, 'src/renderer/components/ChatPanel.tsx'), 'utf-8')

describe('ChatPanel: openFileBlock の出し分け（C・#15）', () => {
  it('shouldSendTools を toolSupport の一元定義から import している', () => {
    expect(src).toContain("import { shouldSendTools } from '../toolSupport'")
  })

  it('出し分けの条件は「(claudeActive || ツール対応) かつ AIルート内」', () => {
    expect(src).toContain('(claudeActive || shouldSendTools(model)) && aiRel')
  })

  it('名前だけの形は AI相対パス（aiRel）を使う（basename は誤パス呼び出しを誘発するため使わない）', () => {
    // eslint-disable-next-line no-template-curly-in-string
    expect(src).toContain('`\\n\\n# 開いているファイル: ${aiRel} (${activeFile.language})`')
  })

  it('中身つきの従来形（4000字）はフォールバックとして残っている（ツール非対応・ルート外用）', () => {
    // eslint-disable-next-line no-template-curly-in-string
    expect(src).toContain('${activeFile.content.slice(0, 4000)}')
  })

  it('AIルートは「いまのプロジェクトの分か」を確かめてから使う（バグ⑤と同じレース対策の作法）', () => {
    expect(src).toContain('const rootReady = aiRoot && aiRoot.dir === projectDir ? aiRoot.root : null')
    expect(src).toContain("activeFile.path.startsWith(rootReady + '/')")
  })

  it('旧形（無条件で中身つきを注入する形）へ戻っていない', () => {
    // 旧形は activeFile の三項の直後に中身つきテンプレートが来ていた。
    // 新形は必ず (claudeActive || shouldSendTools(model)) の分岐を挟む。
    // eslint-disable-next-line no-template-curly-in-string
    const oldShape = '? `\\n\\n# 開いているファイル: ${activeFile.name}'
    expect(src).not.toContain(oldShape)
  })
})
