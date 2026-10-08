import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { judgeVercelFit } from '../src/shared/vercelFit'
import { teardownScopeNote } from '../src/shared/teardownSupport'
import { LEFTOVER_DATA_ASK_AI_NOTE } from '../src/shared/leftoverData'

// publishB（HANAMII・Vercel・GitHub と公開の画面）担当・検分で見つかった問題の確かめ（2026-09-28）。
//
// 2026-09-27 検分は、以下5件（W-30・W-16・W-29・W-93・W-39）について
// 「文言そのものは決定どおりに直っているが、既存テストの assert が旧文言のまま残って
// FAIL する」と指摘した。原本で確かめると、文言の直し方はどれも
// docs/wording-decisions.md の決定どおりで正しい。
//
// ただしこの担当には「既存のテストファイルを書き換えるな（あとでまとめて直す段がある）」
// という縛りがあるため、tests/vercelFit.test.ts・tests/vercelPreflightWiring.test.ts・
// tests/teardownSupport.test.ts・tests/vercelPanelNotice.test.ts・tests/publishStatus.test.ts・
// tests/leftoverData.test.ts の該当 assert はここでは直さない（handoff で報告する）。
// 代わりに、**いまの（決定どおりの）文言を新しいテストで固定**し、掟10（振る舞いの歯止めは
// テストで）を満たす。旧テストの stale な assert は、テスト一括修正の段で解消される想定。

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

describe('W-30: Vercel 公開前チェックの「データは残らない」注記（決定どおりに直っているか固定）', () => {
  it('koto-data を使っていて、保存場所ありでも直書きが残っていれば「残りません（何もしなくても消えることがあります）」と言う', () => {
    const check = judgeVercelFit({
      packageJson: null, listens: [], hasFiles: true,
      usesData: ['app.js'], hasStorage: true, writesFiles: ['server.js'],
    }).find(c => c.id === 'storage')!
    expect(check.note).toContain('残りません（何もしなくても消えることがあります）')
    expect(check.note).not.toContain('公開のたびに消えます')
  })

  it('koto-data を使っていて、保存場所が無ければ「残りません（何もしなくても消えることがあります）」と言う', () => {
    const check = judgeVercelFit({
      packageJson: null, listens: [], hasFiles: true,
      usesData: ['app.js'], hasStorage: false,
    }).find(c => c.id === 'storage')!
    expect(check.note).toContain('残りません（何もしなくても消えることがあります）')
  })

  it('koto-data を一度も使わず、ファイル直書きだけが残っていれば「残りません（何もしなくても消えることがあります）」と言う', () => {
    const check = judgeVercelFit({
      packageJson: null, listens: [], hasFiles: true,
      usesData: [], hasStorage: false, writesFiles: ['server.js'],
    }).find(c => c.id === 'storage')!
    expect(check.note).toContain('残りません（何もしなくても消えることがあります）')
  })
})

describe('W-16: AppRun（共用型）の破棄で消えるものの説明（決定どおりに直っているか固定）', () => {
  it('1行目はアプリの削除だけを言い切り、コンテナレジストリの話はしない（下の欄に任せる）', () => {
    expect(teardownScopeNote('sakura-apprun')).toBe('AppRun のアプリを削除します。')
    expect(teardownScopeNote('sakura-apprun')).not.toContain('コンテナレジストリ')
  })
})

describe('W-29: 公開先を選ぶ画面の Vercel 説明（データは条件つきで日本国内、決定どおりに直っているか固定）', () => {
  it('PublishModal.tsx が条件つきの文（データの保存を使う場合…）になっている', () => {
    const src = read('src/renderer/components/PublishModal.tsx')
    expect(src).toContain('データの保存を使う場合、そのデータはさくらのオブジェクトストレージ（日本国内）に置かれます')
    // 旧: 条件なしで「データは日本国内」と言い切る文は、もう無い
    expect(src).not.toContain('アプリが動くのは国外ですが、データはさくらのオブジェクトストレージ（日本国内）に置かれます')
  })
})

describe('W-93: 📡 公開したもの一覧「記録を片づける」の確定ボタン（決定どおりに直っているか固定）', () => {
  it('PublishedListModal.tsx の確定ボタンが「記録を片づける（公開したものは残ります）」に揃っている', () => {
    const src = read('src/renderer/components/PublishedListModal.tsx')
    expect(src).toContain('記録を片づける（公開したものは残ります）')
    // 「実体」は通じない、というのが W-93 の理由なので、もう出てこない
    expect(src).not.toContain('実体は残ります')
  })
})

describe('W-39: 「AIに書き直してもらう」を押した直後の注記（決定どおりに直っているか固定）', () => {
  const EXPECTED = 'チャットに AI へのお願いが入ります（中身は AI 向けの指示です）。送信すると AI が作業を始めます。'

  it('LEFTOVER_DATA_ASK_AI_NOTE が確定文言になっている', () => {
    expect(LEFTOVER_DATA_ASK_AI_NOTE).toBe(EXPECTED)
  })

  it('StorageNotice.tsx の書き直し枠も同じ文言（2か所を揃える、という決定どおり）', () => {
    const src = read('src/renderer/components/StorageNotice.tsx')
    expect(src).toContain(EXPECTED)
  })
})
