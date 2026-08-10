import { describe, it, expect } from 'vitest'
import {
  buildNewProjectRequest,
  stashNewProjectRequest,
  takeNewProjectRequest,
  SITE_TYPES,
  type NewProjectRequestArgs,
} from '../src/renderer/newProjectRequest'

function siteArgs(overrides: Partial<NewProjectRequestArgs> = {}): NewProjectRequestArgs {
  return {
    kind: 'site',
    name: 'my-shop',
    siteType: 'lp',
    target: 'local',
    description: '',
    ...overrides,
  }
}

function appArgs(overrides: Partial<NewProjectRequestArgs> = {}): NewProjectRequestArgs {
  return {
    kind: 'app',
    name: 'my-tool',
    templateLabel: 'React',
    templateHint: 'Vite + React + TypeScript',
    target: 'local',
    description: '',
    ...overrides,
  }
}

describe('buildNewProjectRequest — kind別の基本挙動', () => {
  it('kind==="blank" は依頼文を送らない（null）', () => {
    expect(buildNewProjectRequest({ kind: 'blank', name: 'x', target: 'local', description: '' })).toBeNull()
  })

  it('kind==="site" は名前・要望・README指示・実際に作る指示を含む', () => {
    const p = buildNewProjectRequest(siteArgs({ name: 'sakura-cafe', description: '手作りパン屋のサイト' }))
    expect(p).not.toBeNull()
    expect(p).toContain('sakura-cafe')
    expect(p).toContain('手作りパン屋のサイト')
    expect(p).toContain('README.md')
    expect(p).toMatch(/write_file/)
    expect(p).toMatch(/edit_file/)
  })

  it('kind==="app" は名前・ベース表示・要望・README指示・実際に作る指示を含む', () => {
    const p = buildNewProjectRequest(appArgs({ name: 'todo-app', description: 'タスク管理アプリ' }))
    expect(p).not.toBeNull()
    expect(p).toContain('todo-app')
    expect(p).toContain('React')
    expect(p).toContain('タスク管理アプリ')
    expect(p).toContain('README.md')
    expect(p).toMatch(/write_file/)
    expect(p).toMatch(/edit_file/)
  })

  it('要望が空でも成立し、「特になし」相当が入る（site/app どちらも）', () => {
    const site = buildNewProjectRequest(siteArgs({ description: '' }))
    const app = buildNewProjectRequest(appArgs({ description: '' }))
    expect(site).toContain('特になし')
    expect(app).toContain('特になし')
  })

  it('要望が空白のみ（trim後に空）でも「特になし」になる', () => {
    const p = buildNewProjectRequest(siteArgs({ description: '   \n  ' }))
    expect(p).toContain('特になし')
  })

  it('一通り作り終えるまで止めない・次にすべきことを一言添える指示を含む', () => {
    const p = buildNewProjectRequest(siteArgs())
    expect(p).toMatch(/途中で止めない/)
    expect(p).toMatch(/次に何をすればよいか/)
  })

  it('プロジェクトは作成済み・オープン済みであることを明示する', () => {
    const p = buildNewProjectRequest(siteArgs({ name: 'already-here' }))
    expect(p).toMatch(/作成済み/)
  })
})

describe('buildNewProjectRequest — サイト種別ごとの構成指示（sitePrompt の再利用）', () => {
  for (const t of SITE_TYPES) {
    it(`siteType=${t.id}（${t.label}）の見出しが入る`, () => {
      const p = buildNewProjectRequest(siteArgs({ siteType: t.id }))
      expect(p).toContain(t.label)
    })
  }

  it('LPは1ページ構成、それ以外は複数ページ構成の指示になる', () => {
    const lp = buildNewProjectRequest(siteArgs({ siteType: 'lp' }))
    const shop = buildNewProjectRequest(siteArgs({ siteType: 'shop' }))
    expect(lp).toMatch(/1ページ構成/)
    expect(shop).toMatch(/複数ページ構成/)
  })
})

describe('buildNewProjectRequest — 公開先ごとの構成指示（sitePrompt/targetPrompt の再利用）', () => {
  it('サイト×さくらのレンタルサーバ: public/ 構成・deploy.sh の指示', () => {
    const p = buildNewProjectRequest(siteArgs({ target: 'sakura-rental' }))
    expect(p).toContain('public/')
    expect(p).toContain('deploy.sh')
  })

  it('サイト×さくらのAppRun: Dockerfile・8080ポートの指示', () => {
    const p = buildNewProjectRequest(siteArgs({ target: 'sakura-apprun' }))
    expect(p).toContain('Dockerfile')
    expect(p).toContain('8080')
  })

  it('アプリ×さくらのレンタルサーバ: PHP+MySQLの指示', () => {
    const p = buildNewProjectRequest(appArgs({ target: 'sakura-rental' }))
    expect(p).toMatch(/PHP/)
    expect(p).toMatch(/MySQL/)
  })

  it('アプリ×さくらのAppRun: PORT環境変数・Dockerfileの指示', () => {
    const p = buildNewProjectRequest(appArgs({ target: 'sakura-apprun' }))
    expect(p).toContain('Dockerfile')
    expect(p).toMatch(/PORT/)
  })

  it('アプリ×HANAMII: EXPOSE 8080の指示', () => {
    const p = buildNewProjectRequest(appArgs({ target: 'hanamii' }))
    expect(p).toContain('EXPOSE 8080')
  })

  it('アプリ×さくらのVPS/クラウド: それぞれの一言案内が入る', () => {
    expect(buildNewProjectRequest(appArgs({ target: 'sakura-vps' }))).toContain('さくらのVPS')
    expect(buildNewProjectRequest(appArgs({ target: 'sakura-cloud' }))).toContain('さくらのクラウド')
  })

  it('target=local（あとで決める）では公開先特有の指示を追加しない', () => {
    const site = buildNewProjectRequest(siteArgs({ target: 'local' }))
    const app = buildNewProjectRequest(appArgs({ target: 'local' }))
    expect(site).not.toContain('deploy.sh')
    expect(app).not.toMatch(/重要・最優先で従うこと/)
  })
})

describe('stashNewProjectRequest / takeNewProjectRequest — ChatPanel未マウント時の取りこぼし救済', () => {
  it('stash後、同じdirでtakeすると取り出せて、その後は空になる（一度きり）', () => {
    stashNewProjectRequest('/tmp/proj-a', 'ここに依頼文')
    expect(takeNewProjectRequest('/tmp/proj-a')).toBe('ここに依頼文')
    expect(takeNewProjectRequest('/tmp/proj-a')).toBeNull()
  })

  it('dirが一致しないとtakeできず、stash内容は保持されたままになる', () => {
    stashNewProjectRequest('/tmp/proj-b', '依頼B')
    expect(takeNewProjectRequest('/tmp/other-dir')).toBeNull()
    // 一致しないtakeは消費しない＝正しいdirで後から取り出せる
    expect(takeNewProjectRequest('/tmp/proj-b')).toBe('依頼B')
  })

  it('何もstashされていなければ null', () => {
    expect(takeNewProjectRequest('/tmp/never-stashed')).toBeNull()
  })

  it('後からのstashは前の内容を上書きする', () => {
    stashNewProjectRequest('/tmp/proj-c', '古い依頼')
    stashNewProjectRequest('/tmp/proj-d', '新しい依頼')
    expect(takeNewProjectRequest('/tmp/proj-c')).toBeNull()
    expect(takeNewProjectRequest('/tmp/proj-d')).toBe('新しい依頼')
  })
})
