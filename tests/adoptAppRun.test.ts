import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  adoptedSpec, adoptedState, adoptionBlocker, adoptionWarnings,
  adoptionRegistryReuse, registryLabelFromServer, adoptionPreview, adoptedFiles,
} from '../src/main/cloud/adopt'
import { validateSpec, normalizeSpecName } from '../src/main/cloud/spec'
import { registrySubdomainLabel, stateAfterTeardown } from '../src/main/cloud/state'
import { registryDeleteDefault, adoptedRegistryNote, projectDeleteRegistryNote, REGISTRY_MONTHLY_YEN } from '../src/shared/cloudCost'
import { computePlan } from '../src/main/cloud/planner'
import { buildPatchBody, buildCreateBody } from '../src/main/cloud/client'
import { appRunSettings, type AppRunSettings } from '../src/shared/publishImport'

// ── AppRun の引き継ぎ（dev-plan ④ 第4段階・2026-08-25）────────────────────
// インポートしただけでは、公開すると**別の新しいアプリ**が作られる。原因はただ1つ、
// `.sakura-cloud/state.json` にアプリIDが無いこと。書けば引き継げる。

/** 実測（2026-08-22）の形に寄せた、公開中アプリの詳細。 */
const DETAIL = {
  id: 'app-1234',
  name: 'landingtest',
  port: 3000,
  min_scale: 1,
  max_scale: 4,
  timeout_seconds: 90,
  components: [{
    name: 'web',
    max_cpu: '0.2',
    max_memory: '2Gi',
    deploy_source: { container_registry: { image: 'landingtest.sakuracr.jp/landingtest:v20260821-231947', server: 'landingtest.sakuracr.jp' } },
    env: [{ key: 'NODE_ENV', value: 'production' }, { key: 'GREETING', value: 'hello' }],
    secret: [{ key: 'DB_PASS' }],
    probe: { http_get: { path: '/healthz', port: 3000 } },
  }],
}

const S = (over: Partial<AppRunSettings> = {}): AppRunSettings => ({ ...appRunSettings(DETAIL), ...over })

describe('実物から設定を読み取る', () => {
  it('入れ物の名前まで拾う（引き継ぎで元のまま送り返すため）', () => {
    expect(appRunSettings(DETAIL).componentName).toBe('web')
  })

  it('名前が無ければ null（勝手に main と決めない）', () => {
    expect(appRunSettings({ components: [{ max_cpu: '1' }] }).componentName).toBeNull()
  })
})

describe('引き継げるかを決める', () => {
  it('ポートが読めれば引き継げる', () => {
    expect(adoptionBlocker(S())).toBeNull()
  })

  // ⚠️ ポートは**健康診断の宛先**でもある。分からないまま 8080 を入れて再デプロイすると、
  // 動いているアプリが健康診断に落ちる。**分からないなら引き継がない**（掟1）。
  it('ポートが読めないときは引き継がない（既定値で埋めない）', () => {
    const b = adoptionBlocker(S({ port: null }))
    expect(b).toContain('ポート')
    expect(b).toContain('引き継げません')
    // 行き止まりにしない（別物としてなら公開できる）
    expect(b).toContain('別のアプリとして公開する')
  })
})

describe('引き継ぐ前に伝えること', () => {
  it('秘密が設定されているなら、公開で失われることを言う', () => {
    const w = adoptionWarnings(S())
    expect(w.some(n => n.includes('DB_PASS') && n.includes('失われます'))).toBe(true)
    // 「駄目です」で終わらせない。代わりの道を書く（2026-08-24 の教訓）
    expect(w.some(n => n.includes('env.json') || n.includes('別物として公開する'))).toBe(true)
  })

  it('秘密が無ければ、その話はしない', () => {
    expect(adoptionWarnings(S({ secretKeys: [] })).some(n => n.includes('秘密'))).toBe(false)
  })

  // ⚠️ 2026-08-25 Ryosuke 指摘で外した。破棄がそのアプリを消すのは**引き継いだかどうかに
  // 関係のない普通の意味**で、すぐ上の「公開すると置き換わります」から出てくる話。
  // 新しい情報が無い行は、隣の本当に読ませたい行（URL・お金・秘密）を薄める。
  it('破棄の話はここでしない（普通の意味を、わざわざ強調しない）', () => {
    for (const keys of [[], ['DB_PASS']]) {
      const w = adoptionWarnings(S({ secretKeys: keys }))
      expect(w.some(n => n.includes('破棄'))).toBe(false)
    }
  })

  it('秘密が無ければ、伝えることは何も無い', () => {
    expect(adoptionWarnings(S({ secretKeys: [] }))).toEqual([])
  })
})

describe('引き継ぎで書く env.json', () => {
  const spec = adoptedSpec({ appName: 'landingtest', appId: 'app-1234', settings: S() })

  it('公開の設定として通る形になっている', () => {
    const v = validateSpec(spec)
    expect(v.ok, v.ok ? '' : (v as any).errors.join(' / ')).toBe(true)
  })

  // ⚠️ ここが第4段階でいちばん危ないところ。PATCH は components を**丸ごと差し替える**ので、
  // 書き写し忘れた項目は Koto の既定値で上書きされ、**動いているアプリが壊れる**。
  it('実物の設定を書き写す（書き漏らすと、次の公開で既定値に戻る）', () => {
    expect(spec.service.port).toBe(3000)
    expect(spec.service.componentName).toBe('web')
    expect(spec.service.cpu).toBe('0.2')
    expect(spec.service.memory).toBe('2Gi')
    expect(spec.service.probePath).toBe('/healthz')
    expect(spec.service.scale).toEqual({ min: 1, max: 4 })
  })

  it('環境変数もそのまま引き継ぐ（落とすと、次の公開で消える）', () => {
    expect(spec.service.env).toEqual([
      { name: 'NODE_ENV', value: 'production' },
      { name: 'GREETING', value: 'hello' },
    ])
  })

  // 値は返ってこない。**ref を捏造しない**（掟4・秘密を発明しない）。
  it('秘密は空にする', () => {
    expect(spec.service.secrets).toEqual([])
  })

  it('保存場所は付けない（バケットは1つにつき月額が発生する）', () => {
    expect(spec.persistence.objectStorage).toEqual([])
    expect(spec.guardrails.ttlHours).toBe(0)
  })

  it('公開名は正規化して入れる（大文字・記号のままだと検証に落ちる）', () => {
    const s2 = adoptedSpec({ appName: 'My_Shop', appId: 'x', settings: S() })
    expect(s2.name).toBe(normalizeSpecName('My_Shop'))
    expect(validateSpec(s2).ok).toBe(true)
  })

  it('規模が読めないときだけ既定に倒す', () => {
    const s2 = adoptedSpec({ appName: 'landingtest', appId: 'x', settings: S({ minScale: null, maxScale: null }) })
    expect(s2.service.scale).toEqual({ min: 0, max: 1 })
    expect(validateSpec(s2).ok).toBe(true)
  })

  it('min が max を超える壊れた値でも、検証を通る形にする', () => {
    const s2 = adoptedSpec({ appName: 'landingtest', appId: 'x', settings: S({ minScale: 5, maxScale: 2 }) })
    expect(validateSpec(s2).ok).toBe(true)
  })
})

describe('引き継ぎで書く state.json', () => {
  const base = { appName: 'landingtest', appId: 'app-1234', settings: S() }
  const state = adoptedState({ ...base, imageServer: 'landingtest.sakuracr.jp' })

  it('アプリIDを記録する（これが無いと再デプロイできない）', () => {
    expect(state.resources).toEqual([
      { kind: 'apprun-app', id: 'app-1234', stateful: false, key: 'apprun-app:landingtest' },
    ])
  })

  // ⚠️ 書かないと、次の公開は「アプリ全体に1つだけある接続情報」——最後にレジストリを
  // 用意した**別プロジェクト**のもの——を使い、関係のない置き場へイメージが入る。
  // もとの置き場は誰にも使われないまま月220円がかかり続ける（2026-08-25）。
  it('いま使っている置き場の名前を記録する', () => {
    expect(state.meta?.registryName).toBe('landingtest')
  })

  // ⚠️ 印が無いと、破棄の「置き場も削除する」が既定オンのままになり、
  // **利用者が自分で作った置き場を、うっかり消せてしまう**。
  it('それが借り物であることの印もつける', () => {
    expect(state.meta?.registryAdopted).toBe(true)
  })

  it('さくら以外の置き場から引いているアプリでは、名前を控えない', () => {
    for (const server of ['docker.io/library/nginx', 'registry.example.com/acme/app']) {
      const s2 = adoptedState({ ...base, imageServer: server })
      expect(s2.meta, server).toBeUndefined()
      expect(JSON.stringify(s2), server).not.toContain('registryName')
    }
  })
})

describe('破棄で「置き場も削除する」の最初の状態', () => {
  // Koto が作った置き場は、そのプロジェクト専用。残すと月220円が止まらないので既定オン。
  it('Koto が作ったものなら、これまでどおりオン', () => {
    expect(registryDeleteDefault({ registryName: 'landingtest', adopted: false })).toBe(true)
  })

  // 借り物には、他のアプリのイメージも入っていることがある。
  it('借り物ならオフにしておく', () => {
    expect(registryDeleteDefault({ registryName: 'landingtest', adopted: true })).toBe(false)
  })

  it('記録が無ければ、そもそも消せない', () => {
    expect(registryDeleteDefault({ registryName: null, adopted: false })).toBe(false)
  })

  it('黙って外さず、理由をその場で言う', () => {
    const note = adoptedRegistryNote('landingtest')
    expect(note).toContain('landingtest')
    expect(note).toContain('Koto が作ったものではありません')
    expect(note).toContain('ほかのアプリのイメージ')
    expect(note).toContain(`月額${REGISTRY_MONTHLY_YEN}円`)
  })

  // ⚠️ 名前だけ残して印を落とすと、次の破棄で「Koto が作ったもの」に見えて既定オンに戻る。
  it('破棄でレジストリを残したときは、名前と一緒に印も残す', () => {
    const kept = stateAfterTeardown(
      { name: 'x', backend: 'apprun', resources: [], meta: { registryName: 'landingtest', registryAdopted: true } },
      false,
    )
    expect(kept.meta).toEqual({ registryName: 'landingtest', registryAdopted: true })
  })

  it('レジストリを消したときは、名前も印も残さない', () => {
    const gone = stateAfterTeardown(
      { name: 'x', backend: 'apprun', resources: [], meta: { registryName: 'landingtest', registryAdopted: true } },
      true,
    )
    expect(gone.meta).toBeUndefined()
  })

  // Koto が新しく作ったら、借り物ではなくなる。印を古いまま残さない。
  it('新しく作ったときは、借り物の印を落とす', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')
    expect(src).toContain('...(created ? { registryAdopted: false } : {})')
  })

  // ⚠️ **破棄の導線は3つある**（③公開・📡公開したもの一覧・プロジェクトごと削除）。
  // 2026-08-25、2つだけ直して**3つめ（プロジェクト削除）を見落としていた**。
  // そこは `deleteRegistry: true` の決め打ちで、しかもチェックボックスが無い＝
  // **借りている置き場を、断る手段なく消していた**（Ryosuke の問いで見つけた）。
  //
  // 一覧を**書き下す**（配列を回すだけだと、中身が減っても気づけない・掟10）。
  it('破棄の導線は3つとも、同じ判断を通す', () => {
    const paths = [
      'src/renderer/components/AppRunPanel.tsx',       // ③公開の破棄
      'src/renderer/components/PublishedListModal.tsx', // 📡公開したもの一覧
      'src/renderer/components/Sidebar.tsx',            // プロジェクトごと削除
    ]
    for (const f of paths) {
      const src = readCode(f)
      expect(src, f).toContain('registryDeleteDefault(')
      // **決め打ちで消しにいく形が残っていないこと**（3つめがまさにこれだった）
      expect(src, f).not.toContain('deleteRegistry: true')
      expect(src, f).not.toContain('setDeleteRegistry(true)')
    }
  })

  // 選ばせない導線（プロジェクト削除）は、**選ばせない代わりに必ず書く**。
  it('プロジェクトごと削除では、置き場を残すことを書く', () => {
    const src = readCode('src/renderer/components/Sidebar.tsx')
    // ⚠️ 「どこかに名前がある」だけでは足りない（**出す条件**を消しても通ってしまう。
    // 実際にミューテーションで素通りした・掟10）。**出している場所ごと**押さえる。
    expect(src).toContain('{teardownOnDelete && projectDeleteRegistryNote(pendingRegistry) && (')
    expect(src).toContain('{projectDeleteRegistryNote(pendingRegistry)}</p>')
    // 借り物かどうかは、確認を開くときに実物から読む
    expect(src).toContain('window.electronAPI.cloud.registryName(confirmProjDelete)')
    // 前のプロジェクトのものを引きずらない（8/24 の事故と同じ形を作らない）
    expect(src).toContain('前のプロジェクトのものを引きずらない')
  })

  // ③公開・📡一覧のほうは、**外した理由**をその場に出す（チェックがあるので）。
  it('チェックのある2つは、既定を外した理由を出す', () => {
    for (const f of [
      'src/renderer/components/AppRunPanel.tsx',
      'src/renderer/components/PublishedListModal.tsx',
    ]) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf-8')
      expect(src, f).toContain('adoptedRegistryNote(')
    }
  })
})

describe('プロジェクトごと削除するときの断り', () => {
  it('借り物なら、残すことと課金が続くことを言う', () => {
    const note = projectDeleteRegistryNote({ registryName: 'landingtest', adopted: true })
    expect(note).toContain('landingtest')
    expect(note).toContain('残します')
    expect(note).toContain(`月額${REGISTRY_MONTHLY_YEN}円`)
    // 行き止まりにしない（消したい人の行き先を書く）
    expect(note).toContain('コントロールパネル')
  })

  // Koto が作った置き場は今までどおり消す。消えるものの話は「公開も一緒に破棄する」で足りる。
  it('Koto が作ったものなら、何も言わない（消すので）', () => {
    expect(projectDeleteRegistryNote({ registryName: 'landingtest', adopted: false })).toBeNull()
  })

  it('記録が無ければ、何も言わない（そもそも消せない）', () => {
    expect(projectDeleteRegistryNote({ registryName: null, adopted: true })).toBeNull()
  })
})

// ── ここが本体。**env.json と state.json のキーが噛み合って初めて引き継げる。** ──
describe('引き継いだあと、公開が「更新」になる', () => {
  it('計画が update になり、作成にならない', () => {
    const input = { appName: 'landingtest', appId: 'app-1234', settings: S() }
    const plan = computePlan(adoptedSpec(input), adoptedState(input))
    const app = plan.actions.filter(a => a.kind === 'apprun-app')
    expect(app.map(a => a.type)).toEqual(['update'])
  })

  // 名前の正規化が spec 側と state 側でずれると、`findRef` が引けず
  // 「対象アプリのIDが state に無く再デプロイできません」で黙って飛ぶ。
  it('大文字や記号を含む名前でも噛み合う', () => {
    const input = { appName: 'My_Shop', appId: 'app-9', settings: S() }
    const spec = adoptedSpec(input)
    const state = adoptedState(input)
    expect(state.resources[0].key).toBe(`apprun-app:${spec.name}`)
    expect(computePlan(spec, state).actions.filter(a => a.kind === 'apprun-app').map(a => a.type)).toEqual(['update'])
  })

  it('引き継いでいなければ、作成になる（第4段階の前の姿）', () => {
    const spec = adoptedSpec({ appName: 'landingtest', appId: 'app-1234', settings: S() })
    const plan = computePlan(spec, { name: spec.name, backend: 'apprun', resources: [] })
    expect(plan.actions.filter(a => a.kind === 'apprun-app').map(a => a.type)).toEqual(['create'])
  })
})

describe('再デプロイの中身（PATCH は components を丸ごと差し替える）', () => {
  const spec = adoptedSpec({ appName: 'landingtest', appId: 'app-1234', settings: S() })

  it('引き継いだ設定が、そのまま送り返される', () => {
    const c = buildPatchBody(spec).components[0]
    expect(c.name).toBe('web')
    expect(c.max_cpu).toBe('0.2')
    expect(c.max_memory).toBe('2Gi')
    expect(c.probe.http_get).toEqual({ path: '/healthz', port: 3000 })
    expect(c.env).toEqual([{ key: 'NODE_ENV', value: 'production' }, { key: 'GREETING', value: 'hello' }])
  })

  // Koto が作ったプロジェクトの動きは変えない（任意の項目が無ければ従来の既定値）。
  it('書いていなければ、これまでどおりの既定値', () => {
    const plain = { ...spec, service: { ...spec.service, componentName: undefined, cpu: undefined, memory: undefined, probePath: undefined } }
    const c = buildPatchBody(plain as any).components[0]
    expect(c.name).toBe('main')
    expect(c.max_cpu).toBe('1')
    expect(c.max_memory).toBe('1Gi')
    expect(c.probe.http_get.path).toBe('/')
    // create 側も同じ既定（片方だけ直さない）
    expect(buildCreateBody(plain as any).components[0].name).toBe('main')
  })
})

describe('引き継いでも月額が増えないか', () => {
  // `registryLookupNames` は**記録した名前を先に試す**ので、名前を控えられたなら
  // いまの置き場がそのまま見つかる（＝新しく作らない＝増えない）。
  it('置き場の名前を読み取れたら、増えない', () => {
    const r = adoptionRegistryReuse({ appName: 'landingtest', imageServer: 'landingtest.sakuracr.jp' })
    expect(r).toEqual({ reuses: true, wanted: 'landingtest', current: 'landingtest' })
  })

  // 公開名と置き場の名前が違っていても、**記録するので見つかる**。
  it('公開名と置き場の名前が違っても、増えない', () => {
    const r = adoptionRegistryReuse({ appName: 'myshop', imageServer: 'acme-reg.sakuracr.jp' })
    expect(r.reuses).toBe(true)
    expect(r.current).toBe('acme-reg')
  })

  it('読み取れなければ「増える」に倒す（安全側）', () => {
    expect(adoptionRegistryReuse({ appName: 'myshop', imageServer: null }).reuses).toBe(false)
  })

  it('イメージ参照そのものからでもレジストリ名を取り出せる', () => {
    expect(registryLabelFromServer('landingtest.sakuracr.jp/landingtest:v1')).toBe('landingtest')
    expect(registryLabelFromServer('')).toBeNull()
  })

  // ⚠️ さくら以外を名前として控えると、次の公開が**その名前で新しい置き場を作る**。
  it('さくらのレジストリでなければ、名前として使わない', () => {
    expect(registryLabelFromServer('docker.io/library/nginx:1')).toBeNull()
    expect(registryLabelFromServer('ghcr.io/acme/app')).toBeNull()
    // ⚠️ **末尾を落とすだけの判定では通ってしまう長さ**のものを必ず入れる
    // （短いホストは偶然 null になるので、守りが外れても気づけない）
    expect(registryLabelFromServer('registry.example.com/acme/app')).toBeNull()
    expect(registryLabelFromServer('my-registry.sakuracr.jp.evil.example/app')).toBeNull()
    expect(registryLabelFromServer('.sakuracr.jp')).toBeNull()
    // 大文字で来ても拾う
    expect(registryLabelFromServer('LandingTest.sakuracr.jp')).toBe('landingtest')
  })

  // ⚠️ 読み取れなかったときの当て先は、**ensureRegistry が実際に探す名前と同じ**でなければ
  // 意味がない。作り方が2箇所にあると、片方だけ直されて黙ってずれる（掟10）。
  it('探しにいく名前の作り方は、ensureRegistry と同じものを使う', () => {
    expect(adoptionRegistryReuse({ appName: 'My_Shop', imageServer: null }).wanted)
      .toBe(registrySubdomainLabel(normalizeSpecName('My_Shop')))
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')
    expect(src).toContain('let label = registrySubdomainLabel(baseName)')
    // 手で作り直していた古い形が残っていないこと
    expect(src).not.toContain("baseName.toLowerCase().replace(/[^a-z0-9-]/g, '')")
  })
})

describe('押す前に見せる見立て', () => {
  it('引き継げるとき', () => {
    const p = adoptionPreview({ appName: 'landingtest', settings: S(), imageServer: 'landingtest.sakuracr.jp' })
    expect(p.canAdopt).toBe(true)
    expect(p.blocker).toBeNull()
    expect(p.reusesRegistry).toBe(true)
    expect(p.specName).toBe('landingtest')
    expect(p.appName).toBe('landingtest')
    expect(p.warnings.length).toBeGreaterThan(0)
  })

  it('引き継げないとき', () => {
    const p = adoptionPreview({ appName: 'landingtest', settings: S({ port: null }), imageServer: 'x' })
    expect(p.canAdopt).toBe(false)
    expect(p.blocker).toContain('ポート')
  })

  it('さくら側の名前と Koto の中の公開名が違うことを見せられる', () => {
    const p = adoptionPreview({ appName: 'My_Shop', settings: S(), imageServer: 'x' })
    expect(p.appName).toBe('My_Shop')
    expect(p.specName).toBe('my-shop')
  })
})

// ── 実際にディスクへ書かれる中身（**書く側からは切り離してある**）──────────
describe('引き継ぎで書くファイル', () => {
  const input = { appName: 'landingtest', appId: 'app-1234', settings: S() }

  it('.sakura-cloud の2つを、そのまま置ける中身で返す', () => {
    const r = adoptedFiles(input)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.files.map(f => f.rel)).toEqual(['env.json', 'state.json'])
    const env = JSON.parse(r.files[0].content)
    const state = JSON.parse(r.files[1].content)
    expect(env.name).toBe('landingtest')
    expect(env.service.port).toBe(3000)
    expect(state.resources[0].id).toBe('app-1234')
    // どちらも改行で終わる（他の設定ファイルと同じ流儀）
    for (const f of r.files) expect(f.content.endsWith('\n')).toBe(true)
  })

  // **壊れた env.json を置くと、③公開の画面がエラーで開かなくなる**（原因が見えない）。
  it('ポートが読めないものは、書かずに理由を返す', () => {
    const r = adoptedFiles({ ...input, settings: S({ port: 0 }) })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('引き継げません')
  })

  // よそで作られたアプリは、Koto が想定していない形の設定を持っていることがある。
  // **既定値へ丸めない**（丸めると、動いているアプリの設定が静かに書き換わる）。
  it('そのまま引き継げない設定のときは、断って行き先を添える', () => {
    for (const bad of [
      S({ componentName: 'web/main' }),   // 入れ物の名前に使えない文字
      S({ probePath: 'healthz' }),        // 「/」で始まらない
      S({ maxMemory: '2 Gi' }),           // 空白入り
    ]) {
      const r = adoptedFiles({ ...input, settings: bad })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toContain('そのまま引き継げない形')
      // 行き止まりにしない
      expect(r.reason).toContain('別のアプリとして公開する')
    }
  })

  it('秘密の値は、どちらのファイルにも入らない', () => {
    const r = adoptedFiles(input)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const f of r.files) expect(f.content).not.toContain('DB_PASS')
  })
})

// ── 配線（画面と main は import できないのでソースを読んで固定。掟10）──────────

/**
 * ソースから**注釈を落として**読む。
 *
 * ⚠️ このコードベースは注釈が厚く、「直す前の形」を戒めとして本文に書き残す。
 * そのまま `not.toContain` すると、**自分の書いた注釈にテストが当たって落ちる**
 * （2026-08-25 に実際に起きた）。逆に言えば、注釈を残したまま緑になっていたら
 * **実装ではなく注釈を見て通っていた**ということでもある。見るのはコードだけにする。
 */
const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

describe('引き継ぎの配線', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

  it('引き継ぐのは「いまの公開を更新していく」を選んだときだけ', () => {
    const s = read('src/main/ipc/publishImport.ts')
    expect(s).toContain("if (args.intent === 'update') {")
    // 置き場の名前も渡す（渡し忘れると記録されず、次の公開が別の置き場へ行く）
    expect(s).toContain('adopt = adoptAppRunApp(args.destDir, appName, args.id, settings, ref.server)')
  })

  // 中身の判断は純関数側（テストできる場所）に置き、IPC は書くだけにしてある。
  it('中身の判断を IPC の中でやり直さない', () => {
    const s = read('src/main/ipc/publishImport.ts')
    expect(s).toContain('const built = adoptedFiles({ appName, appId, settings, imageServer })')
    expect(s).toContain('if (!built.ok) return { adopted: false, adoptNote: built.reason }')
    // 検証や組み立てを IPC 側で書き直していないこと
    expect(s).not.toContain('validateSpec(')
    expect(s).not.toContain('adoptedSpec(')
  })

  it('書き込みはプロジェクトの中に閉じ込める', () => {
    const s = read('src/main/ipc/publishImport.ts')
    expect(s).toContain('const full = cloudFileIn(destDir, f.rel)')
    expect(s).toContain("fs.writeFileSync(full, f.content, 'utf-8')")
    expect(s).toContain('プロジェクトの外は操作できません')
    // 素の join で書いていないこと
    expect(s).not.toContain("path.join(destDir, '.sakura-cloud'")
  })

  // 名前は**実物から**取る（画面のフォルダ名を使うと、さくら側と食い違う）
  it('アプリ名は API の応答から取る', () => {
    const s = read('src/main/ipc/publishImport.ts')
    expect(s).toContain("typeof (d.data as any)?.name === 'string'")
  })

  it('引き継げたかどうかを、必ず画面へ返す', () => {
    const s = read('src/main/ipc/publishImport.ts')
    expect(s).toContain('...origin, ...adopt }')
  })
})
