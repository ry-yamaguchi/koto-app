import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  PUBLISH_CLOSE_WARNING, PUBLISH_CLOSE_NOTE, PUBLISH_QUIT_STOPS, PUBLISH_STOP_NOTE_MAIN_RECORD,
} from '../src/renderer/activity'

// 窓を閉じるときの警告（公開・作成・破棄の全部で**1つの文**）の配線と中身を固定する。
//
// ── いつ出るか・何が起きるか（2026-09-29 に原本 src/main/main.ts で確かめ直した）──────────
// 出るのは main.ts の `mainWindow.on('close')`＝**Koto の窓を閉じようとしたとき**で、
// いま beginActivity が走っているとき。公開ダイアログの ×・外側のクリックでは出ない。
// 公開・作成・破棄の本体は main の1 invoke で完走し、**記録も main が書く**ので、窓を閉じても処理は続く
// （macOS は窓を閉じてもアプリは終了しない）。失うのは結果の表示。Koto 自体を終了すると途中で止まる。
// 以前の警告文は「公開の記録も Koto に残りません」と言っていたが、**記録は main が書く**ので事実と違った
// （専有型の⑧だけが正しい文を持っていた）。文を分けると片方だけ古くなるので、1つにまとめた。
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

describe('activity.ts: PUBLISH_CLOSE_WARNING の文言（事実と合っている）', () => {
  it('★ 「公開の記録も Koto に残りません」とは言わない（記録は main が書く・直す前の嘘を禁じる）', () => {
    expect(PUBLISH_CLOSE_WARNING.detail).not.toContain('公開の記録も Koto に残りません')
    expect(PUBLISH_CLOSE_WARNING.detail).not.toContain('記録も Koto に残りません')
    expect(raw('src/renderer/activity.ts')).not.toContain("'公開処理が進行中です。公開そのものは裏で最後まで進みますが、いま閉じると結果の表示が失われ、公開の記録も Koto に残りません。よろしいですか？'")
  })

  it('★ 窓を閉じても続くこと・開き直すと結果が出ること・Koto を終了すると止まること、の3つを言う', () => {
    const d = PUBLISH_CLOSE_WARNING.detail
    expect(d).toContain('Koto の窓を閉じても、処理は裏で最後まで進み')
    expect(d).toContain('作ったものの記録は Koto が残します')
    // 2026-09-30 検分: 結果は main の処理の記録（projectOps）が持つので、窓を開き直して公開の画面を開けば出る。
    // 以前の「結果（成功か失敗か）は画面に出なくなります」は事実と逆になった
    expect(d).toContain('窓を開き直して公開の画面を開けば、進み具合と結果（成功か失敗か）が出ます')
    expect(d).not.toContain('画面に出なくなります')
    // 課金の歯止め: 終了すると記録が残らないことがある＝⑥で破棄できなくなりうる、という一文を落とさない
    expect(d).toContain('Koto 自体を終了すると、処理は途中で止まり、作られたものが記録に残らないことがあります')
    expect(d.endsWith('よろしいですか？')).toBe(true)
  })

  it('★ 「終了すると止まる」の一文は、窓を閉じる警告と⑧の画面の一文で同じ定義（PUBLISH_QUIT_STOPS）から引く', () => {
    expect(PUBLISH_CLOSE_NOTE).toContain(PUBLISH_QUIT_STOPS)
    expect(PUBLISH_CLOSE_WARNING.detail).toContain(PUBLISH_QUIT_STOPS)
    expect(PUBLISH_STOP_NOTE_MAIN_RECORD).toContain(PUBLISH_QUIT_STOPS)
  })

  it('⑧の画面の一文は、画面を閉じても進むこと・⑥で破棄できることを言う（専有型だけの案内）', () => {
    expect(PUBLISH_STOP_NOTE_MAIN_RECORD).toContain('この公開の画面を閉じても、公開は最後まで進みます')
    expect(PUBLISH_STOP_NOTE_MAIN_RECORD).toContain('公開の記録は Koto が残す')
    // 開き直すと結果が出る（以前の「見られなくなるのは結果…の表示だけです」は、事実と逆になった・2026-09-30 検分）
    expect(PUBLISH_STOP_NOTE_MAIN_RECORD).toContain('開き直すと、ここに進み具合と結果（アプリが応答したか・ロードバランサの IP）が出ます')
    expect(PUBLISH_STOP_NOTE_MAIN_RECORD).not.toContain('見られなくなる')
  })
})

// 警告文は**1つだけ**。専有型の⑧だけ別の定義（PUBLISH_CLOSE_WARNING_MAIN_RECORD）を持つ形はやめた。
describe('警告文は1つだけ: closeWarning を渡す呼び出しは、すべて PUBLISH_CLOSE_WARNING', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p)
    }
    return out
  }
  const RENDERER = path.join(ROOT, 'src/renderer')
  const files = walk(RENDERER).filter(f => !f.endsWith('activity.ts'))
  const code = (f: string) => fs.readFileSync(f, 'utf-8').split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

  it('★ closeWarning の渡し先は、書き下した6か所（共用型・HANAMII・Vercel・専有型の作成/破棄/公開）だけで、どれも PUBLISH_CLOSE_WARNING', () => {
    const hits: string[] = []
    for (const f of files) {
      for (const m of code(f).matchAll(/closeWarning:\s*([A-Za-z_]+)/g)) {
        hits.push(`${path.relative(ROOT, f)} -> ${m[1]}`)
      }
    }
    expect(hits.sort()).toEqual([
      'src/renderer/components/AppRunDedicatedPanel.tsx -> PUBLISH_CLOSE_WARNING',
      'src/renderer/components/AppRunDedicatedPanel.tsx -> PUBLISH_CLOSE_WARNING',
      'src/renderer/components/AppRunDedicatedPanel.tsx -> PUBLISH_CLOSE_WARNING',
      'src/renderer/components/AppRunPanel.tsx -> PUBLISH_CLOSE_WARNING',
      'src/renderer/components/HanamiiPanel.tsx -> PUBLISH_CLOSE_WARNING',
      'src/renderer/components/VercelPanel.tsx -> PUBLISH_CLOSE_WARNING',
    ])
  })

  it('★ 別の警告文（PUBLISH_CLOSE_WARNING_MAIN_RECORD）が src のどこにも残っていない（コメント以外）', () => {
    for (const f of walk(RENDERER)) {
      expect(code(f), path.relative(ROOT, f)).not.toContain('PUBLISH_CLOSE_WARNING_MAIN_RECORD')
    }
  })

  it('専有型: 作成・破棄・公開のどれも、beginActivity に PUBLISH_CLOSE_WARNING を渡す', () => {
    const src = stripped('src/renderer/components/AppRunDedicatedPanel.tsx')
    expect(src).toContain("beginActivity('専有型クラスタの作成', { closeWarning: PUBLISH_CLOSE_WARNING })")
    expect(src).toContain("beginActivity('専有型クラスタの破棄', { closeWarning: PUBLISH_CLOSE_WARNING })")
    expect(src).toContain("beginActivity('専有型アプリの公開', { closeWarning: PUBLISH_CLOSE_WARNING })")
    // ⑧の画面の一文も同じ定義から引く（2か所で別々に書かない・掟10）
    expect(src).toContain('export const PUBLISH_STOP_NOTE = PUBLISH_STOP_NOTE_MAIN_RECORD')
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
