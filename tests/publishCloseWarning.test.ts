import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 公開中の close ダイアログの文言を実態へ（roadmap #14）の配線を固定する。
//
// 公開処理（3パネル）は main の1 invoke で完走するため、窓を閉じても公開そのものは
// 中断されない。実際に失われるのは結果の表示と、renderer 側で書く公開の記録
// （publish.targets・pending の後片づけ）。そこで beginActivity('公開処理') に
// closeWarning（PUBLISH_CLOSE_WARNING）を渡し、main の close ダイアログまで文言を通す。
//
// ソースを読んで「呼び出しの形そのもの」を固定する（tests/unusedWiring.test.ts と同じ流儀。
// 掟10: 「どこかに書いてある」だけでは直し忘れを捕まえられない。呼び出しごと見る）。

const ROOT = path.join(__dirname, '..')
const raw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
// コメントでの言及だけを拾って誤検知しないよう、コメント行を除く。
const stripped = (rel: string) => raw(rel).split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

describe('公開3パネル: beginActivity に PUBLISH_CLOSE_WARNING を渡している', () => {
  const panels = [
    'src/renderer/components/AppRunPanel.tsx',
    'src/renderer/components/HanamiiPanel.tsx',
    'src/renderer/components/VercelPanel.tsx',
  ]

  for (const rel of panels) {
    it(`${rel}: 新形（closeWarning あり）を含み、旧形（closeWarning 無し）は含まない`, () => {
      const src = stripped(rel)
      expect(src).toContain("beginActivity('公開処理', { closeWarning: PUBLISH_CLOSE_WARNING })")
      expect(src).not.toContain("beginActivity('公開処理')")
    })
  }
})

describe('main.ts: close ダイアログの文言差し替え（#14）', () => {
  it('buttons/detail が closeBlockingConfirm/closeBlockingDetail を優先し、旧形の detail 組み立てには戻っていない', () => {
    const src = stripped('src/main/main.ts')
    expect(src).toContain("buttons: [closeBlockingConfirm || '中断して終了', 'キャンセル'],")
    expect(src).toContain('detail: closeBlockingDetail || ')
    expect(src).not.toContain('detail: `${closeBlockingLabel')
  })
})

describe('activity.ts: PUBLISH_CLOSE_WARNING の文言（要点）', () => {
  it('detail に「結果の表示」と「公開の記録も Koto に残りません」の要点を含む', () => {
    const src = raw('src/renderer/activity.ts')
    expect(src).toContain('公開の記録も Koto に残りません')
  })
})

describe('本当に中断される処理（NewProjectModal / VpsPanel）は closeWarning を使っていない', () => {
  it('NewProjectModal.tsx', () => {
    const src = stripped('src/renderer/components/NewProjectModal.tsx')
    expect(src).not.toContain('closeWarning')
  })

  it('VpsPanel.tsx', () => {
    const src = stripped('src/renderer/components/VpsPanel.tsx')
    expect(src).not.toContain('closeWarning')
  })
})
