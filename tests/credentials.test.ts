import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  SERVICES, groupServices, CREDENTIAL_GROUP_ORDER, CREDENTIAL_GROUP_LABEL, CREDENTIAL_GROUP_DESCRIPTION,
  type CredentialGroup,
} from '../src/renderer/components/CredentialsModal'

// ── UX-A・判断10（2026-09-11 利用者目線レビュー推奨①）─────────────────────────────
// 認証情報を「まず必要／公開先ごとに必要／開発中・自動管理」の3グループへ分け、3つ目は既定で折りたたむ。
// タイトルバーの「💾 保存」は README の「GitHubへの保存」と揃えて「💾 GitHubに保存」に変えた。

describe('groupServices（SERVICES を3グループへ分ける純関数・UX-A判断10）', () => {
  it('SERVICES の全 id が、3グループ（first/perTarget/auto）のどれかに入っている', () => {
    for (const s of SERVICES) {
      expect(['first', 'perTarget', 'auto'] as CredentialGroup[], `${s.id} の group が想定外`).toContain(s.group)
    }
  })

  it('仕様どおりの割り当て: first=aiEngine／auto=vps・registry／それ以外はperTarget', () => {
    const byId = Object.fromEntries(SERVICES.map(s => [s.id, s.group]))
    expect(byId.aiEngine).toBe('first')
    expect(byId.vps).toBe('auto')
    expect(byId.registry).toBe('auto')
    for (const id of ['cloud', 'hanamii', 'vercel', 'github', 'anthropic', 'tavily', 'braveSearch']) {
      expect(byId[id], `${id} は perTarget のはず`).toBe('perTarget')
    }
  })

  it('順序は常に first → perTarget → auto', () => {
    const sections = groupServices(SERVICES)
    expect(sections.map(s => s.group)).toEqual(['first', 'perTarget', 'auto'])
    expect(sections.map(s => s.group)).toEqual(CREDENTIAL_GROUP_ORDER)
  })

  it('件数を固定する: まず必要=1（aiEngine）／公開先ごとに必要=7／開発中・自動管理=2（vps・registry）', () => {
    const sections = groupServices(SERVICES)
    expect(sections[0].services.map(s => s.id)).toEqual(['aiEngine'])
    expect(sections[1].services.map(s => s.id)).toEqual([
      'cloud', 'hanamii', 'vercel', 'github', 'anthropic', 'tavily', 'braveSearch',
    ])
    expect(sections[2].services.map(s => s.id)).toEqual(['registry', 'vps'])
  })

  // ★ 変異試験(c): 「groupServices が auto を落とす」バグを検知する砦。
  it('★ 3つ目のグループ（開発中・自動管理）を落とさない。空にならず、vps・registry を含む', () => {
    const auto = groupServices(SERVICES).find(s => s.group === 'auto')
    expect(auto).toBeDefined()
    expect(auto!.services.length).toBe(2)
    expect(auto!.services.map(s => s.id)).toContain('vps')
    expect(auto!.services.map(s => s.id)).toContain('registry')
  })

  it('見出し文言・折りたたみ表示に使う件数がラベルと一致する', () => {
    expect(CREDENTIAL_GROUP_LABEL.first).toBe('まず必要')
    expect(CREDENTIAL_GROUP_LABEL.perTarget).toBe('公開先ごとに必要')
    expect(CREDENTIAL_GROUP_LABEL.auto).toBe('開発中・自動管理')
    // 折りたたみの表示文言「開発中・自動管理（2件）を表示」の元になる件数
    const auto = groupServices(SERVICES).find(s => s.group === 'auto')!
    expect(`${CREDENTIAL_GROUP_LABEL.auto}（${auto.services.length}件）を表示`).toBe('開発中・自動管理（2件）を表示')
  })

  it('各グループの見出し直下の1行案内: first/perTargetにはあり、auto（折りたたみ）には無い', () => {
    expect(CREDENTIAL_GROUP_DESCRIPTION.first).toBe('これだけで作る・試すまでできます')
    expect(CREDENTIAL_GROUP_DESCRIPTION.perTarget).toBe('使う公開先のものだけ登録すれば十分です')
    expect(CREDENTIAL_GROUP_DESCRIPTION.auto).toBeUndefined()
  })
})

describe('配線: CredentialsModal.tsx が groupServices を実際に使い、3つ目を既定で畳んでいる（掟10）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/CredentialsModal.tsx'), 'utf-8')

  it('一覧は groupServices(SERVICES) を並べて描画する（手で並べ直さない）', () => {
    expect(src).toContain('{groupServices(SERVICES).map(renderGroupSection)}')
  })

  it('折りたたみの初期値は false（毎回畳む）で、localStorage には保存しない', () => {
    expect(src).toContain("const [autoOpen, setAutoOpen] = useState(false)")
    // autoOpen 自体を localStorage に読み書きしていないこと（仕様: 保存しない・単純に毎回畳む）
    const autoOpenLines = src.split('\n').filter(l => l.includes('autoOpen'))
    for (const l of autoOpenLines) {
      expect(l, `autoOpen が localStorage に触れている: ${l}`).not.toMatch(/localStorage/)
    }
  })

  it('折りたたみのトグル文言が「（N件）を表示」の形で、件数は services.length から動的に出す', () => {
    expect(src).toContain('（${services.length}件）を表示')
  })
})

describe('配線: タイトルバーの「💾 GitHubに保存」（README「GitHubへの保存」と揃える・UX-A判断10）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/TitleBar.tsx'), 'utf-8')

  it('★ onOpenGithubSave ボタンのラベルが「💾 GitHubに保存」になっている（旧「💾 保存」には戻っていない）', () => {
    expect(src).toMatch(/onClick=\{onOpenGithubSave\}[\s\S]{0,400}>\s*💾 GitHubに保存\s*</)
    expect(src).not.toMatch(/onClick=\{onOpenGithubSave\}[\s\S]{0,400}>\s*💾 保存\s*</)
  })
})
