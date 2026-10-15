import { describe, it, expect } from 'vitest'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ServicePrincipalSection, {
  CONTROL_PANEL_URL,
  type ServicePrincipalState,
} from '../src/renderer/components/ServicePrincipalSection'
import { SERVICE_PRINCIPALS_URL } from '../src/renderer/components/ServicePrincipalPicker'
import type { ServicePrincipalCandidate } from '../src/shared/servicePrincipalCandidates'

// AppRun 専有型 手順2「サービスプリンシパルの用意」の節（AppRunDedicatedPanel.tsx から切り出した・2026-10-07）。
// 節のコンポーネントは、フック（useServicePrincipal）の結果 `sp` を描くだけの見た目。実際に描いて、
//   ・出る文（見出し・実測で裏づけた「使い回せます」・(A)/(B)・ロール名）
//   ・描いただけでは、保存・欄の書き換え・候補選びの口を一度も呼ばない（開いただけでは .sakuraide.json を書かない）
// を見る。配線（呼び出し元・effect・stale の守り）は tests/servicePrincipalPanelWiring.test.ts が構文木で固定している。

const ID_A = '111111111111'
const A: ServicePrincipalCandidate = { id: ID_A, projectNames: ['Landingtest'], updatedAtMs: 200 }

function fakeState(over: Partial<ServicePrincipalState> = {}) {
  const calls: string[] = []
  const sp: ServicePrincipalState = {
    resourceId: '',
    setResourceId: (() => { calls.push('setResourceId') }) as ServicePrincipalState['setResourceId'],
    saveResourceId: async () => { calls.push('saveResourceId') },
    idSaveWarning: null,
    spCandidates: [],
    resourceInputRef: createRef<HTMLInputElement>(),
    pickServicePrincipal: async () => { calls.push('pickServicePrincipal') },
    pickManualServicePrincipal: () => { calls.push('pickManualServicePrincipal') },
    ...over,
  }
  return { sp, calls }
}
const render = (sp: ServicePrincipalState, onEdit: () => void = () => {}) =>
  renderToStaticMarkup(createElement(ServicePrincipalSection, { sp, onEdit }))
const flat = (html: string) => html.replace(/\s+/g, '')

describe('ServicePrincipalSection: 見た目', () => {
  it('見出し・入力欄のラベル・1行の説明・「詳しい手順を見る」（(A)/(B)・ロール名のコピー）が出る', () => {
    const html = render(fakeState().sp)
    expect(html).toContain('手順2 サービスプリンシパルの用意（最初の一度だけ手作業）')
    expect(html, '旧い丸数字の見出しが戻っている').not.toContain('② サービスプリンシパルの用意')
    expect(html).toContain('サービスプリンシパルのリソースID（12桁）')
    expect(html).toContain('コントロールパネルで一度だけ作ります。作り方は「詳しい手順を見る」。')
    expect(html).toContain('詳しい手順を見る')
    expect(html).toContain('(A) サービスプリンシパルを作る')
    expect(html).toContain('(B) そのサービスプリンシパルにロールを付ける')
    expect(html).toContain('さくらのクラウド &gt; 作成・削除') // ROLE_TEXT（HTML エスケープされる）
    expect(html).toContain(`href="${CONTROL_PANEL_URL}"`)
    expect(CONTROL_PANEL_URL).toBe('https://secure.sakura.ad.jp/cloud/')
  })

  it('★ 使い回せることは、実測の裏づけつきで言い切る（「想定」へ戻さない）', () => {
    const html = flat(render(fakeState().sp))
    expect(html).toContain(flat('さくら側のサービスプリンシパルは使い回せます（さくらのクラウドの「プロジェクト」のリソースで、Koto のプロジェクトとは別のものです。同じものでクラスタを2回作れたことを確かめています）。前のプロジェクトで使った ID があれば、ここに入れておきます。'))
    expect(html).not.toContain('使い回せる想定')
    expect(html).not.toContain('エラーになったときは、コントロールパネルで確かめてください')
  })

  it('欄の値の形の表示: 12桁の数字なら「形は合っています」、そうでなければ「違うようです」、空なら何も出さない', () => {
    expect(render(fakeState({ resourceId: ID_A }).sp)).toContain('✓ 形は合っています（12桁の数字）')
    expect(render(fakeState({ resourceId: '12345' }).sp)).toContain('⚠️ 違うようです（12桁の数字ではありません）')
    const empty = render(fakeState({ resourceId: '' }).sp)
    expect(empty).not.toContain('形は合っています')
    expect(empty).not.toContain('違うようです')
  })

  it('候補が1つなら、欄にその ID が入り、前のプロジェクト名つきの一文と「新しく作る」リンクが出る', () => {
    const html = render(fakeState({ resourceId: ID_A, spCandidates: [A] }).sp)
    expect(html).toContain(`value="${ID_A}"`)
    expect(html).toContain('前のプロジェクト（Landingtest）で使った ID を入れました。違うときは書き換えてください。')
    expect(html).toContain(`href="${SERVICE_PRINCIPALS_URL}"`)
  })

  it('保存に失敗したときの知らせは、渡されたものを手順2の欄の下（詳しい手順の前）に出す。無ければ何も出さない', () => {
    const warn = createElement('p', null, '⚠️ 残せませんでした')
    const html = render(fakeState({ idSaveWarning: warn }).sp)
    expect(html).toContain('⚠️ 残せませんでした')
    expect(html.indexOf('⚠️ 残せませんでした')).toBeLessThan(html.indexOf('詳しい手順を見る'))
    expect(render(fakeState().sp)).not.toContain('残せませんでした')
  })
})

describe('ServicePrincipalSection: 描いただけでは何も書かない・何も変えない', () => {
  it('★★ 描画のあいだに、保存・欄の書き換え・候補選び・「別の ID」・パネルへの「触った」通知を一度も呼ばない（候補が複数・失敗の知らせつきでも）', () => {
    const B: ServicePrincipalCandidate = { id: '222222222222', projectNames: ['blog'], updatedAtMs: 100 }
    for (const over of [{}, { resourceId: ID_A, spCandidates: [A] }, { resourceId: ID_A, spCandidates: [A, B] }, { resourceId: '', spCandidates: [A, B] }]) {
      const { sp, calls } = fakeState(over)
      let edited = 0
      render(sp, () => { edited++ })
      expect(calls).toEqual([])
      expect(edited).toBe(0)
    }
  })
})
