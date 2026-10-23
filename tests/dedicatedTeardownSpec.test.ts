import { describe, it, expect, afterEach } from 'vitest'
import {
  dedicatedTeardownSpec, DEDICATED_TEARDOWN_WORDS, DEDICATED_LIST_KEY_MISSING_MESSAGE, DEDICATED_PANEL_KEY_MISSING_MESSAGE,
  DEDICATED_NOTHING_TO_DELETE_MESSAGE, dedicatedTeardownTargets, lbWaitNote, dnsRecordNote, type DedicatedTeardownRecord,
} from '../src/renderer/teardown/targets/dedicated'
import { buildTeardownConfirm } from '../src/renderer/teardown/confirm'
import { runTeardownFlow, electronFlowDeps } from '../src/renderer/teardown/flow'
import type { TeardownFacts } from '../src/renderer/teardown/types'
import { dedicatedTeardownHasWork } from '../src/shared/teardownSupport'
import { toTeardownView } from '../src/shared/teardownResult'
import { estimatesFor, emptyStore } from '../src/shared/stageEstimate'
import { shouldShowTeardownButton } from '../src/renderer/apprunDedicatedActions'

// ── 段階3B（3B-4）: 専有型の削除の仕様書（teardown/targets/dedicated.ts）の単体 ─────────────────────────────────────
// 設計書 docs/teardown-unify-plan.md の 10.11.8・10.11.14 の B。手本の出力の写しとの比べは tests/dedicatedTeardownGolden.test.ts。
// 本物の main を通した流れは tests/dedicatedTeardownEntries.test.ts（A〜D3）。
//
//   言葉・項目 … 手本の文を1文字も変えずに移した（rowButton だけ 10.6.2 の0 で「🗑 削除」）
//   キー       … 入口ごとの「キーが無いとき」の2つの文／loadAuth は token と secret の両方があるときだけ
//   invoke・購読 … 呼び形／進み具合の購読と解除
//   hasWork    … main の apprunDedicated:teardown と手順6のボタンと同じ1つの判断（32通り）
//   D10        … DNS の A レコードの1行（ロードバランサが記録にあるときだけ）

const spec = dedicatedTeardownSpec
const FULL: DedicatedTeardownRecord = { clusterID: 'c1', asgID: 'a1', loadBalancerID: 'l1', applicationID: 'app1', applicationName: 'myapp' }
const D10_NAMELESS = '🌐 独自ドメインの DNS に、このロードバランサを指す A レコードがあれば、DNS の管理画面で削除してください。削除するロードバランサの IP は、いずれ別の利用者に割り当てられることがあります。'
const d10With = (hosts: string) => `🌐 DNS に ${hosts} の A レコードがあれば、DNS の管理画面で削除してください。削除するロードバランサの IP は、いずれ別の利用者に割り当てられることがあります。`

afterEach(() => { delete (globalThis as any).window })

describe('言葉と項目: 手本の文を1文字も変えずに移した', () => {
  it('★★ 言葉は書き下した表と同じ（専有型は「削除」。rowButton だけ「🗑 削除」）', () => {
    expect(DEDICATED_TEARDOWN_WORDS).toEqual({
      verb: '削除',
      confirmTitle: '専有型クラスタを削除します',
      confirmLabel: '削除する',
      activityLabel: '専有型クラスタの削除',
      rowButton: '🗑 削除',
      running: '削除しています…',
      doneHeadline: '✅ すべて削除しました',
      inProgressHeadline: '⏳ 削除中です',
      failedHeadline: '⚠️ 削除できませんでした',
      factsUnreadable: '削除するものの記録を読めませんでした',
      nothingToDo: DEDICATED_NOTHING_TO_DELETE_MESSAGE,
      askAiTarget: 'さくらのAppRun（専有型）',
    })
    expect(spec.words).toBe(DEDICATED_TEARDOWN_WORDS)
  })

  it('★ 項目: 公開先・IPC の名前・課金を言う・元に戻せませんは無条件。選択・保存場所の決め方・幽霊の行を成功にする印・保存場所だけ残った回の文は持たない', () => {
    expect(spec.target).toBe('sakura-apprun-dedicated')
    expect(spec.handler).toBe('apprunDedicated:teardown')
    expect(spec.claimsComputeBillingStops).toBe(true)
    expect(spec.irreversibleNote).toBe('always')
    // 持たないもの（持つと確認の文・流れが変わる）。保存場所だけ残った押し直しの先頭は、共通の「次を削除します: 保存場所『A』にある…」のまま（10.5.1 の10 (b)）
    expect(spec.choices).toBeUndefined()
    expect(spec.placementsOf).toBeUndefined()
    expect(spec.nothingToDoIsOk).toBeUndefined()
    expect(spec.leftoverNote).toBeUndefined()
  })

  it('★★ 幽霊の行の案内は、さくらには何も要求していないこと・「一覧から削除」の前にさくら側を確かめることを言う（README・ガイドの引用と同じ文）', () => {
    expect(DEDICATED_NOTHING_TO_DELETE_MESSAGE).toContain('さくらのクラウドには何も要求していません')
    expect(DEDICATED_NOTHING_TO_DELETE_MESSAGE).toContain('さくら側に残っていないかは、📡 の「さくら側にあるものと、かかっている費用」で「調べる」を押すか、コントロールパネルで確かめてから、「一覧から削除」してください。')
  })

  it('★★ キーが無いときの文は入口ごとに違う（📡 は「認証情報」、手順6は「手順1」）。1文字ずつ固定する', () => {
    expect(DEDICATED_LIST_KEY_MISSING_MESSAGE).toBe('さくらのクラウドの API キーが未登録です。「認証情報」で登録してから、もう一度お試しください。')
    expect(DEDICATED_PANEL_KEY_MISSING_MESSAGE).toBe('さくらのクラウドAPIキーが未登録です。手順1で登録してください。')
    expect(DEDICATED_LIST_KEY_MISSING_MESSAGE).not.toBe(DEDICATED_PANEL_KEY_MISSING_MESSAGE)
  })

  it('failure と toView: 何も始まっていない失敗の形・返り値を専有型の結果の読み方で読む', () => {
    expect(spec.failure('だめでした')).toEqual({ ok: false, executed: [], message: 'だめでした', remaining: {} })
    const raw = { ok: false, executed: [], message: '待ち切れませんでした', remaining: { loadBalancerID: 'l1' }, inProgress: { loadBalancerID: 'l1', clusterID: 'c1' } }
    expect(spec.toView(raw)).toEqual(toTeardownView('sakura-apprun-dedicated', raw))
    expect(spec.toView(raw).state).toBe('inProgress')
  })
})

describe('readRecord・targets・waitNote', () => {
  it('★ readRecord は apprunDedicated:state の答えをそのまま返す。読めなければ投げる（流れが確認も実行も出さずに止める）', async () => {
    const seen: string[] = []
    ;(globalThis as any).window = { electronAPI: { apprunDedicated: { state: async (d: string) => { seen.push(d); return FULL } } } }
    expect(await spec.readRecord('/p')).toBe(FULL)
    expect(seen).toEqual(['/p'])
    ;(globalThis as any).window.electronAPI.apprunDedicated.state = async () => { throw new Error('記録なし') }
    await expect(spec.readRecord('/p')).rejects.toThrow('記録なし')
  })

  it('★ dedicatedTeardownTargets: 記録にあるものだけを、アプリ → LB → ASG → クラスタの順に。アプリは名前があれば名前、無ければ ID', () => {
    expect(dedicatedTeardownTargets(FULL)).toEqual(["アプリ『myapp』", "ロードバランサ『l1』", "オートスケーリンググループ『a1』", "クラスタ『c1』"])
    expect(dedicatedTeardownTargets({ clusterID: 'c1', applicationID: 'app1' })).toEqual(["アプリ『app1』", "クラスタ『c1』"])
    expect(dedicatedTeardownTargets({ storageLeftoverBucket: 'koto-a' })).toEqual([])
    expect(dedicatedTeardownTargets(null)).toEqual([])
    expect(dedicatedTeardownTargets(undefined)).toEqual([])
    expect(spec.targets(FULL)).toEqual(dedicatedTeardownTargets(FULL))
  })

  it('★★ waitNote: ロードバランサが記録にあり、目安が読めるときだけ。目安の数字は目安の仕組み（estimatesFor）の出力そのもの', () => {
    const estimates = estimatesFor(emptyStore())
    expect(spec.waitNote!(FULL, estimates)).toBe('⏳ ロードバランサの削除には時間がかかります。目安 約9分（開発時の実測・2026-09-10）。')
    expect(spec.waitNote!({ clusterID: 'c1' }, estimates)).toBeNull() // ロードバランサが記録に無い
    expect(spec.waitNote!(FULL, null)).toBeNull() // 目安が読めない
    expect(lbWaitNote(FULL, null)).toBeNull()
    expect(lbWaitNote(null, '目安 約9分')).toBeNull()
    // 測れていれば、その中央値に変わる（文は同じ仕組み）
    const measured = { ...emptyStore(), stages: { 'teardown.lb': [{ ms: 6 * 60_000, at: '2026-10-01T00:00:00.000Z', version: '0', zone: null }] } }
    expect(spec.waitNote!(FULL, estimatesFor(measured))).toBe('⏳ ロードバランサの削除には時間がかかります。目安 約6分（この Mac での前回の実測）。')
  })
})

describe('hasWork: 「消すものが記録にあるか」は1つの判断', () => {
  it('★★ 記録の全組み合わせ（applicationID を含む5項目・32通り）で、main の判断（dedicatedTeardownHasWork）・手順6のボタン（shouldShowTeardownButton）と同じ答え', () => {
    const vals = [null, 'x']
    let n = 0
    for (const applicationID of vals) for (const clusterID of vals) for (const asgID of vals) for (const loadBalancerID of vals) for (const storageLeftoverBucket of vals) {
      const rec = { applicationID, clusterID, asgID, loadBalancerID, storageLeftoverBucket }
      const expected = !!(applicationID || clusterID || asgID || loadBalancerID || storageLeftoverBucket)
      expect(spec.hasWork(rec), JSON.stringify(rec)).toBe(expected)
      expect(spec.hasWork(rec), JSON.stringify(rec)).toBe(dedicatedTeardownHasWork(rec))
      expect(spec.hasWork(rec), JSON.stringify(rec)).toBe(shouldShowTeardownButton({ record: rec, running: false }))
      n++
    }
    expect(n).toBe(32)
    // 空の文字列・null・undefined は「無い」
    expect(spec.hasWork({ applicationID: '', clusterID: '', asgID: null, loadBalancerID: undefined, storageLeftoverBucket: '' })).toBe(false)
  })
})

describe('loadAuth・invoke・subscribeProgress', () => {
  const installKey = (key: unknown) => { ;(globalThis as any).window = { electronAPI: { cloud: { loadKey: async () => key } } } }

  it('★★★ loadAuth: token と secret が**どちらも**空でない文字列のときだけ { token, secret }。ほかは null（空の secret のまま IPC へ進めない）', async () => {
    installKey({ token: 't', secret: 's' })
    expect(await spec.loadAuth(FULL)).toEqual({ token: 't', secret: 's' })
    for (const key of [null, undefined, {}, { token: 't' }, { secret: 's' }, { token: '', secret: 's' }, { token: 't', secret: '' }, { token: 1, secret: 's' }, { token: 't', secret: null }]) {
      installKey(key)
      expect(await spec.loadAuth(FULL), JSON.stringify(key)).toBeNull()
    }
    // 余計な項目は渡さない（鍵の入れ物をそのまま main へ流さない）
    installKey({ token: 't', secret: 's', extra: 'x' })
    expect(await spec.loadAuth(FULL)).toEqual({ token: 't', secret: 's' })
  })

  it('★★ invoke: apprunDedicated.teardown(projectDir, auth, { confirmed: true }) を1回。選択（choices）は渡さない', async () => {
    const calls: unknown[][] = []
    ;(globalThis as any).window = { electronAPI: { apprunDedicated: { teardown: async (...a: unknown[]) => { calls.push(a); return { ok: true, executed: [], message: '', remaining: {} } } } } }
    const out = await spec.invoke('/p', { token: 't', secret: 's' }, { confirmed: true, choices: { deleteRegistry: true } }, FULL)
    expect(out).toEqual({ ok: true, executed: [], message: '', remaining: {} })
    expect(calls).toEqual([['/p', { token: 't', secret: 's' }, { confirmed: true }]])
  })

  it('★★ invoke は流れが渡した確認の印をそのまま main へ渡す（`confirmed: true` の決め打ちにしない。印の判断は流れと main の骨が持つ）', async () => {
    const calls: unknown[][] = []
    ;(globalThis as any).window = { electronAPI: { apprunDedicated: { teardown: async (...a: unknown[]) => { calls.push(a); return { ok: false, executed: [], message: '', remaining: {} } } } } }
    await spec.invoke('/p', { token: 't', secret: 's' }, { confirmed: false as unknown as true }, FULL)
    expect(calls).toEqual([['/p', { token: 't', secret: 's' }, { confirmed: false }]])
  })

  it('★ subscribeProgress: 進み具合の購読を始め、戻り値で解除できる', () => {
    const got: string[] = []
    const listeners = new Set<(m: string) => void>()
    ;(globalThis as any).window = { electronAPI: { apprunDedicated: { onTeardownProgress: (cb: (m: string) => void) => { listeners.add(cb); return () => { listeners.delete(cb) } } } } }
    const off = spec.subscribeProgress!(m => got.push(m))
    expect(listeners.size).toBe(1)
    for (const cb of [...listeners]) cb('アプリを削除しています…')
    expect(got).toEqual(['アプリを削除しています…'])
    off()
    expect(listeners.size).toBe(0)
  })

  it('★★ 流れに載せると、キーが空の secret なら IPC は0回で、入口ごとの案内文が結果になる（空の secret を main の断りに流さない）', async () => {
    const calls: unknown[][] = []
    ;(globalThis as any).window = {
      electronAPI: {
        apprunDedicated: { state: async () => FULL, teardown: async (...a: unknown[]) => { calls.push(a); return { ok: true, executed: [], message: '', remaining: {} } } },
        cloud: { loadKey: async () => ({ token: 't', secret: '' }) },
        storage: { placement: async () => ({ ok: true, placement: null, placements: [] }) },
        fs: { readFile: async () => JSON.stringify({ publish: { targets: { 'sakura-apprun-dedicated': { publishedAt: 't' } } } }), exists: async () => false },
        stageTiming: { estimates: async () => null },
        win: { setBusy: () => {} },
      },
    }
    for (const [message] of [[DEDICATED_LIST_KEY_MISSING_MESSAGE], [DEDICATED_PANEL_KEY_MISSING_MESSAGE]] as const) {
      const out = await runTeardownFlow('/p', spec, electronFlowDeps('/p', spec, { confirm: async () => true, keyMissingMessage: message }))
      expect(out).toEqual({ cancelled: false, result: { ok: false, executed: [], message, remaining: {} } })
    }
    expect(calls).toEqual([])
  })
})

describe('D10: ロードバランサを削除するとき、DNS の A レコードを消すよう案内する', () => {
  it('★★★ ロードバランサが記録にあり、ホスト名が2件 → 2つの名前を「・」でつないだ文', () => {
    expect(dnsRecordNote({ ...FULL, hosts: ['a.example.com', 'b.example.com'] })).toBe(d10With('a.example.com・b.example.com'))
    expect(spec.notes!({ ...FULL, hosts: ['a.example.com', 'b.example.com'] })).toEqual([d10With('a.example.com・b.example.com')])
  })

  it('★★ ロードバランサが記録にあり、ホスト名が無い（null・空・文字列でない）→ 名前なしの文', () => {
    for (const hosts of [undefined, null, [], [''], 'a.example.com' as unknown as string[]]) {
      expect(dnsRecordNote({ ...FULL, hosts }), JSON.stringify(hosts)).toBe(D10_NAMELESS)
    }
    // 空の名前は数えない
    expect(dnsRecordNote({ ...FULL, hosts: ['', 'a.example.com'] })).toBe(d10With('a.example.com'))
  })

  it('★★★ ロードバランサが記録に無い（保存場所だけが残った押し直し・アプリだけ・空）→ 出ない。ホスト名があっても出ない', () => {
    for (const rec of [
      { storageLeftoverBucket: 'koto-a', hosts: ['a.example.com'] },
      { clusterID: 'c1', hosts: ['a.example.com'] },
      { applicationID: 'app1' },
      { loadBalancerID: '' , hosts: ['a.example.com'] },
      { loadBalancerID: null, hosts: ['a.example.com'] },
      {},
    ] as DedicatedTeardownRecord[]) {
      expect(dnsRecordNote(rec), JSON.stringify(rec)).toBeNull()
      expect(spec.notes!(rec), JSON.stringify(rec)).toEqual([])
    }
    expect(dnsRecordNote(null)).toBeNull()
    expect(dnsRecordNote(undefined)).toBeNull()
  })

  it('★ 断定しない: 「割り当てられることがあります」と言い、いつ・必ずとは言わない（返した IP が別の利用者に割り当てられるかは確かめていない）', () => {
    const s = dnsRecordNote(FULL)!
    expect(s).toContain('いずれ別の利用者に割り当てられることがあります')
    for (const strong of ['必ず', 'すぐ', 'ただちに', '乗っ取']) expect(s).not.toContain(strong)
    expect(s, '丸数字').not.toMatch(/[①-⑳]/)
  })

  it('★★ 確認の文での位置: 💾・ほかの公開先の段落のあと、時間の予告と最後の問いの前。ホスト名は記録のまま入る', () => {
    const facts: TeardownFacts<DedicatedTeardownRecord> = {
      projectName: 'myapp', record: { ...FULL, hosts: ['a.example.com'] },
      placements: [{ bucket: 'koto-a', prefix: 'p/', shared: true }], placementsUnreadable: false, placementsUnreadableCause: null,
      otherTargets: ['HANAMII'], otherTargetsUnreadable: false,
      waitNote: spec.waitNote!({ ...FULL }, estimatesFor(emptyStore())),
    }
    const paragraphs = buildTeardownConfirm(spec, facts).body.split('\n\n')
    const at = paragraphs.indexOf(d10With('a.example.com'))
    expect(at).toBeGreaterThan(0)
    expect(paragraphs[at - 1]).toMatch(/^⚠️ この保存場所は HANAMII でも使っているため/)
    expect(paragraphs[at + 1]).toMatch(/^⏳ /)
    expect(paragraphs[at + 2]).toMatch(/^この操作は元に戻せません。/)
    expect(paragraphs).toHaveLength(at + 3)
    // 時間の予告が無い回（目安が読めない）は、最後の問いの前
    const noWait = buildTeardownConfirm(spec, { ...facts, waitNote: null }).body.split('\n\n')
    expect(noWait[noWait.indexOf(d10With('a.example.com')) + 1]).toMatch(/^この操作は元に戻せません。/)
  })

  it('★ 確認の文に出るのは1回だけ（同じ事実を2回言わない）。保存場所だけの押し直しでは出ない', () => {
    const base: TeardownFacts<DedicatedTeardownRecord> = {
      projectName: 'myapp', record: FULL, placements: [], placementsUnreadable: false, placementsUnreadableCause: null,
      otherTargets: [], otherTargetsUnreadable: false, waitNote: null,
    }
    expect(buildTeardownConfirm(spec, base).body.split('🌐')).toHaveLength(2)
    expect(buildTeardownConfirm(spec, { ...base, record: { storageLeftoverBucket: 'koto-a' }, placements: [{ bucket: 'koto-a', prefix: 'p/', shared: true }] }).body).not.toContain('🌐')
  })
})
