import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 2026-08-14 Ryosuke の問い:「『🩺 アプリが動いているか確かめています…』はどこに出ますか？」
//
// **出ていなかった。** 確認ダイアログが出ている間は早期 return で
// そのダイアログだけが描かれ、進捗を出していた場所（後ろの画面）は
// **そもそも描かれない**。公開にかかる数分間、利用者に見えていたのは
// 「実行中…」の4文字だけだった。
//
// 待たせている時間に何も出ていないのは、不安を増やすだけでなく、
// **どこで止まっているか**（組み立て／反映／起動待ち）が分からない。

const SRC = readFileSync(join(__dirname, '..', 'src', 'renderer', 'components', 'AppRunPanel.tsx'), 'utf-8')

describe('公開中の進捗が、利用者に見えるところに出る', () => {
  it('確認ダイアログに進捗を渡している', () => {
    const at = SRC.indexOf('<ConfirmDialog')
    expect(at).toBeGreaterThan(0)
    expect(SRC.slice(at, at + 600)).toContain('progress={progress}')
  })

  it('確認ダイアログの中で進捗を描いている', () => {
    const at = SRC.indexOf('function ConfirmDialog')
    expect(at).toBeGreaterThan(0)
    const body = SRC.slice(at)
    expect(body).toContain('{busy && progress && (')
    // 出しっぱなしにしない（実行中だけ）
    expect(body).toContain('{progress}')
  })

  it('main 側は、公開の各段を進捗として送っている', () => {
    const ipc = readFileSync(join(__dirname, '..', 'src', 'main', 'ipc', 'cloud.ts'), 'utf-8')
    for (const step of ['イメージを組み立てています', 'AppRun に反映しています', 'アプリが動いているか確かめています']) {
      expect(ipc).toContain(step)
    }
  })
})
