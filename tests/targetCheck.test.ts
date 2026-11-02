// 公開先を変えたあとの確認（src/renderer/targetCheck.ts）。
// 偽の ports に流して、呼ばれた要求の一覧（送信の回数・順序・文）を検査する。
// 守るもの: 公開先を変えただけでは AI へ何も送らない／送るのはボタンを押したときの1回だけ／
// 押した時点の公開先で確かめる／別のプロジェクトの会話に吹き出しを置かない。

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  onTargetChanged, runTargetCheck, buildTargetCheckPrompt, targetChangedNote, targetChangedPublishedNote,
  spendsTargetCheckOffer, markTargetCheckSpent, targetCheckButtonState,
  TARGET_CHECK_BUTTON_LABEL, TARGET_CHECK_STALE_NOTE, TARGET_CHECK_OTHER_BUSY_NOTE,
  type TargetCheckPorts, type TargetCheckBubble, type RunTargetCheckResult, type TargetCheckSpent,
} from '../src/renderer/targetCheck'
import { getTargetProfile } from '../src/renderer/targetProfiles'
import { formatPublishedAt } from '../src/renderer/publishStatus'
import { isChatUsable } from '../src/renderer/claudeMode'

const DIR = '/work/my-app'
const OTHER_DIR = '/work/other-app'
const PUBLISHED_AT = '2026-10-01T00:00:00.000Z'
const LATEST_BEFORE = '2026-09-30T00:00:00.000Z'
const LATEST_AFTER = '2026-10-05T00:00:00.000Z'

type KeyKind = 'ai-engine' | 'none' | 'claude-only'
const KEYS: Record<KeyKind, { apiKey: string; claudeActive: boolean }> = {
  'ai-engine': { apiKey: 'sk-test', claudeActive: false },
  none: { apiKey: '', claudeActive: false },
  'claude-only': { apiKey: '', claudeActive: true },
}
type Published = 'none' | 'fresh' | 'stale'

interface World {
  target: string
  published: Published
  keys: KeyKind
  busy: boolean
  /** ほかのプロジェクトで AI が作業中（送り先が Claude のとき、いま送ると、その作業を止めてしまう） */
  otherBusy: boolean
  currentDir: string | null
  /** `.sakuraide.json` の中身を丸ごと差し替える（壊れた JSON など）。undefined なら world から作る。null ならファイルが無い */
  metaRaw?: string | null
  /** `.sakura-cloud/state.json`。無ければファイルが無い */
  stateRaw?: string
  /** latestChangeAt の答えを差し替える */
  latest?: () => Promise<{ ok: boolean; latest: string | null }>
}

function makeWorld(over: Partial<World> = {}) {
  const world: World = { target: 'sakura-apprun', published: 'none', keys: 'ai-engine', busy: false, otherBusy: false, currentDir: DIR, ...over }
  const log: string[] = []
  const sent: { text: string; images: string[] }[] = []
  const bubbles: TargetCheckBubble[] = []
  const refreshed: string[] = []
  const metaText = (): string | null => {
    if (world.metaRaw !== undefined) return world.metaRaw
    const publish = world.published === 'none' ? undefined : { targets: { [world.target]: { publishedAt: PUBLISHED_AT, url: 'https://example.test/' } } }
    return JSON.stringify({ name: 'my-app', target: world.target, ...(publish ? { publish } : {}) })
  }
  const ports: TargetCheckPorts = {
    readFile: async (p) => {
      log.push(`read ${p}`)
      const v = p === `${DIR}/.sakuraide.json` ? metaText() : p === `${DIR}/.sakura-cloud/state.json` ? (world.stateRaw ?? null) : null
      if (v === null) throw new Error('ENOENT')
      return v
    },
    latestChangeAt: async () => {
      log.push('latest')
      if (world.latest) return world.latest()
      return { ok: true, latest: world.published === 'stale' ? LATEST_AFTER : LATEST_BEFORE }
    },
    appendBubble: (m) => { log.push('bubble'); bubbles.push(m) },
    refreshProjectContext: async (d) => { log.push('refresh'); refreshed.push(d) },
    send: (text, images) => { log.push('send'); sent.push({ text, images }) },
    currentDir: () => world.currentDir,
    isBusy: () => world.busy,
    otherProjectBusy: () => world.otherBusy,
    keys: () => KEYS[world.keys],
  }
  return { world, ports, log, sent, bubbles, refreshed }
}

const labelOf = (t: string) => getTargetProfile(t).label
const notSent = (r: RunTargetCheckResult, reason: string) => expect(r).toEqual({ sent: false, reason })

describe('T-4a 押さなければ送らない（公開先の変更を流しても send は0件）', () => {
  const targets = ['local', 'other', 'sakura-apprun']
  const published: Published[] = ['none', 'fresh', 'stale']
  const keys: KeyKind[] = ['ai-engine', 'none', 'claude-only']
  const busy = [true, false]

  it('公開先 × 実績 × キー × 実行中 の全54行で、呼ばれた要求の一覧に send も文脈の読み直しも無い', async () => {
    let rows = 0
    for (const target of targets) for (const pub of published) for (const key of keys) for (const b of busy) {
      const w = makeWorld({ target, published: pub, keys: key, busy: b })
      await onTargetChanged({ target, dir: DIR }, w.ports)
      const name = `${target}/${pub}/${key}/busy=${b}`
      expect(w.sent, name).toEqual([])
      expect(w.log.filter(l => l === 'send' || l === 'refresh'), name).toEqual([])
      rows++
    }
    expect(rows).toBe(54)
  })

  it('ボタンを押す前後で、変更の知らせだけでは何度流しても送らない', async () => {
    const w = makeWorld()
    for (let i = 0; i < 3; i++) await onTargetChanged({ target: 'sakura-apprun', dir: DIR }, w.ports)
    expect(w.sent).toEqual([])
    expect(w.bubbles).toHaveLength(3)
  })
})

describe('T-4b 吹き出しとボタン', () => {
  const target = 'sakura-apprun'

  it('実績なし: 案内の吹き出し1つ・ボタンあり', async () => {
    const w = makeWorld({ target, published: 'none' })
    await onTargetChanged({ target, dir: DIR }, w.ports)
    expect(w.bubbles).toEqual([{ role: 'assistant', content: targetChangedNote(labelOf(target)), offerTargetCheck: true }])
  })

  it('local・other: 吹き出しもボタンも出さない', async () => {
    for (const t of ['local', 'other']) {
      const w = makeWorld({ target: t })
      await onTargetChanged({ target: t, dir: DIR }, w.ports)
      expect(w.bubbles, t).toEqual([])
    }
  })

  it('target が無い知らせ: 何も出さない', async () => {
    const w = makeWorld()
    await onTargetChanged({ dir: DIR }, w.ports)
    await onTargetChanged(undefined, w.ports)
    expect(w.bubbles).toEqual([])
  })

  it('実績あり・公開後に変更なし: 実績の案内だけ・ボタンなし', async () => {
    const w = makeWorld({ target, published: 'fresh' })
    await onTargetChanged({ target, dir: DIR }, w.ports)
    expect(w.bubbles).toHaveLength(1)
    expect(w.bubbles[0].content).toBe(targetChangedPublishedNote(labelOf(target), PUBLISHED_AT, false))
    expect(w.bubbles[0].content).not.toContain(TARGET_CHECK_STALE_NOTE)
    expect('offerTargetCheck' in w.bubbles[0]).toBe(false)
  })

  it('実績あり・公開後にコード変更: 実績の案内に一言を添え・ボタンあり', async () => {
    const w = makeWorld({ target, published: 'stale' })
    await onTargetChanged({ target, dir: DIR }, w.ports)
    expect(w.bubbles).toEqual([{
      role: 'assistant',
      content: targetChangedPublishedNote(labelOf(target), PUBLISHED_AT, true),
      offerTargetCheck: true,
    }])
    expect(w.bubbles[0].content.endsWith(`\n${TARGET_CHECK_STALE_NOTE}`)).toBe(true)
  })

  it('キーが無い回: 吹き出しは出るがボタンは付かない（実績なし・コード変更あり、どちらも）', async () => {
    for (const published of ['none', 'stale'] as const) {
      const w = makeWorld({ target, published, keys: 'none' })
      await onTargetChanged({ target, dir: DIR }, w.ports)
      expect(w.bubbles, published).toHaveLength(1)
      expect('offerTargetCheck' in w.bubbles[0], published).toBe(false)
    }
  })

  it('公開後の変更を確かめられない回（読めない・投げる）は、変更ありとは言わずボタンも付けない', async () => {
    for (const latest of [
      async () => ({ ok: false, latest: null }),
      async () => ({ ok: false, latest: LATEST_AFTER }), // 読めなかった答えは、公開後の時刻が入っていても使わない
      async () => ({ ok: true, latest: null }),
      async () => ({ ok: true, latest: 'not-a-date' }),
      async (): Promise<{ ok: boolean; latest: string | null }> => { throw new Error('boom') },
    ]) {
      const w = makeWorld({ target, published: 'fresh', latest })
      await onTargetChanged({ target, dir: DIR }, w.ports)
      expect(w.bubbles).toHaveLength(1)
      expect(w.bubbles[0].content).not.toContain(TARGET_CHECK_STALE_NOTE)
      expect('offerTargetCheck' in w.bubbles[0]).toBe(false)
    }
  })

  it('公開した日時が分からない実績（旧い記録）: 変更の確認はせず、ボタンなし', async () => {
    const w = makeWorld({ target: 'hanamii', metaRaw: JSON.stringify({ target: 'hanamii', publish: { hanamii: { projectId: 'p-1' } } }) })
    await onTargetChanged({ target: 'hanamii', dir: DIR }, w.ports)
    expect(w.log).not.toContain('latest')
    expect(w.bubbles).toEqual([{ role: 'assistant', content: targetChangedPublishedNote(labelOf('hanamii'), null, false) }])
  })

  it('AppRun の旧い構築の記録（state.json）も実績に数える', async () => {
    const w = makeWorld({
      target,
      metaRaw: JSON.stringify({ target }),
      stateRaw: JSON.stringify({ meta: { createdAt: PUBLISHED_AT }, resources: [{ kind: 'apprun-app' }] }),
    })
    await onTargetChanged({ target, dir: DIR }, w.ports)
    expect(w.bubbles).toEqual([{ role: 'assistant', content: targetChangedPublishedNote(labelOf(target), PUBLISHED_AT, false) }])
  })

  it('記録が読めない・壊れている回は、実績なしとして案内する', async () => {
    for (const metaRaw of [null, '{broken', '', '[]', 'null', '5']) {
      const w = makeWorld({ target, metaRaw })
      await onTargetChanged({ target, dir: DIR }, w.ports)
      expect(w.bubbles, String(metaRaw)).toEqual([{ role: 'assistant', content: targetChangedNote(labelOf(target)), offerTargetCheck: true }])
    }
  })

  it('別のプロジェクトの知らせ（dir が違う・dir が無い）は捨てる', async () => {
    for (const detail of [{ target, dir: OTHER_DIR }, { target, dir: '' }, { target }]) {
      const w = makeWorld()
      await onTargetChanged(detail, w.ports)
      expect(w.bubbles, JSON.stringify(detail)).toEqual([])
      expect(w.log, JSON.stringify(detail)).toEqual([])
    }
  })

  it('開いているプロジェクトが無いときは捨てる', async () => {
    const w = makeWorld({ currentDir: null })
    await onTargetChanged({ target, dir: DIR }, w.ports)
    expect(w.bubbles).toEqual([])
  })

  it('記録を読んでいる間にプロジェクトが切り替わったら、吹き出しを置かない', async () => {
    const w = makeWorld({ target, published: 'stale' })
    const orig = w.ports.latestChangeAt
    w.ports.latestChangeAt = async (d) => { const r = await orig(d); w.world.currentDir = OTHER_DIR; return r }
    await onTargetChanged({ target, dir: DIR }, w.ports)
    expect(w.bubbles).toEqual([])
  })

  it('実績なしの回で、記録を読んでいる間に切り替わっても置かない', async () => {
    const w = makeWorld({ target, published: 'none' })
    const orig = w.ports.readFile
    w.ports.readFile = async (p) => { w.world.currentDir = OTHER_DIR; return orig(p) }
    await onTargetChanged({ target, dir: DIR }, w.ports)
    expect(w.bubbles).toEqual([])
  })

  it('ボタンの文・吹き出しの文は決めた言葉のまま', () => {
    expect(TARGET_CHECK_BUTTON_LABEL).toBe('この公開先で動くか AI に確かめる')
    expect(TARGET_CHECK_STALE_NOTE).toBe('※ 公開後にコードが変更されています。')
    expect(targetChangedNote('さくらのAppRun（コンテナで公開）'))
      .toBe('ℹ️ 公開先を「さくらのAppRun（コンテナで公開）」に変えました。公開先によっては、作り直しが要ることがあります。')
    expect(targetChangedPublishedNote('X', null, false))
      .toBe('✅ 公開先を「X」に変更しました。この公開先には公開した実績があります。今のコードのまま【公開】から再公開できます。')
    expect(targetChangedPublishedNote('X', null, true))
      .toBe('✅ 公開先を「X」に変更しました。この公開先には公開した実績があります。今のコードのまま【公開】から再公開できます。\n※ 公開後にコードが変更されています。')
    const when = formatPublishedAt(PUBLISHED_AT)
    expect(when).not.toBeNull()
    expect(targetChangedPublishedNote('X', PUBLISHED_AT, false))
      .toBe(`✅ 公開先を「X」に変更しました。この公開先には${when} に公開した実績があります。今のコードのまま【公開】から再公開できます。`)
  })

  it('Claude の利用料の言い方を、ボタンの文にも吹き出しにも入れない', () => {
    for (const s of [TARGET_CHECK_BUTTON_LABEL, targetChangedNote('X'), targetChangedPublishedNote('X', null, true)]) {
      expect(s).not.toMatch(/円|料金|費用|Claude|トークン/)
    }
  })
})

describe('T-4c ボタンを押す（runTargetCheck）と、今の公開先で確かめる依頼を1回だけ送る', () => {
  const target = 'sakura-apprun'

  it('send がちょうど1回。送る文は依頼文のまま・画像は無し', async () => {
    const w = makeWorld({ target })
    const r = await runTargetCheck(w.ports)
    expect(r).toEqual({ sent: true, dir: DIR, target })
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0].text.startsWith(`公開先を「${labelOf(target)}」に変更しました。`)).toBe(true)
    expect(w.sent[0].text).toBe(buildTargetCheckPrompt(labelOf(target)))
    expect(w.sent[0].images).toEqual([])
  })

  it('依頼文は変えない（公開先の前提を隠して足すこともしない）', () => {
    expect(buildTargetCheckPrompt('X')).toBe(
      '公開先を「X」に変更しました。今のコードがこの公開先でそのまま動くか確認してください。' +
      '結論を先に一言で述べてください: ' +
      '「✅ そのまま動きます」／「✅ そのまま動きます（任意の改善あり）」／「⚠️ このままでは動きません」。' +
      '⚠️ は動かない確実な根拠（必須ファイルの欠落・この環境が対応しない言語など）がある場合だけにし、' +
      '動くけれど理想形でない点は「任意の改善」として1〜2行で簡潔に添えるだけにしてください。' +
      '公開先の設定で吸収できる事柄は「動かない根拠」にしないでください。' +
      '対応が必要な場合は、既存ファイルの書き換えではなく不足ファイルの追加を優先した最小の提案をし、私の承認を待ってから実行してください。',
    )
  })

  it('送る前に、プロジェクトの文脈を読み直す（読み直しが先・送るのはそのあと）', async () => {
    const w = makeWorld({ target })
    await runTargetCheck(w.ports)
    expect(w.refreshed).toEqual([DIR])
    expect(w.log.indexOf('refresh')).toBeGreaterThan(-1)
    expect(w.log.indexOf('refresh')).toBeLessThan(w.log.indexOf('send'))
  })

  it('押した時点の公開先（.sakuraide.json を読み直した値）で送る。吹き出しを出したときの公開先ではない', async () => {
    const w = makeWorld({ target: 'sakura-apprun' })
    await onTargetChanged({ target: 'sakura-apprun', dir: DIR }, w.ports)
    w.world.target = 'hanamii' // 吹き出しを出したあとに公開先がまた変わった
    const r = await runTargetCheck(w.ports)
    expect(r).toEqual({ sent: true, dir: DIR, target: 'hanamii' })
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0].text).toBe(buildTargetCheckPrompt(labelOf('hanamii')))
    expect(w.sent[0].text).not.toContain(labelOf('sakura-apprun'))
  })

  it('Claude のキーだけ（apiKey 空・claudeActive）でもボタンが出て、押せば送れる（T-4e）', async () => {
    const w = makeWorld({ target, keys: 'claude-only' })
    expect(isChatUsable(!!KEYS['claude-only'].apiKey, KEYS['claude-only'].claudeActive)).toBe(true)
    await onTargetChanged({ target, dir: DIR }, w.ports)
    expect(w.bubbles).toHaveLength(1)
    expect(w.bubbles[0].offerTargetCheck).toBe(true)
    expect((await runTargetCheck(w.ports)).sent).toBe(true)
    expect(w.sent).toHaveLength(1)
  })

  it('同じプロジェクトで押し直しが重なっても、送るのは1回（もう一方は busy）', async () => {
    const w = makeWorld({ target })
    const [a, b] = await Promise.all([runTargetCheck(w.ports), runTargetCheck(w.ports)])
    expect(w.sent).toHaveLength(1)
    expect([a.sent, b.sent].sort()).toEqual([false, true])
    expect([a, b].find(r => !r.sent)).toEqual({ sent: false, reason: 'busy' })
  })

  it('送り終えたあと・止まったあとは、また押せる（印が残らない）', async () => {
    const w = makeWorld({ target })
    await runTargetCheck(w.ports)
    await runTargetCheck(w.ports)
    expect(w.sent).toHaveLength(2)
    const w2 = makeWorld({ target: 'local' })
    expect((await runTargetCheck(w2.ports)).sent).toBe(false)
    w2.world.target = 'hanamii'
    expect((await runTargetCheck(w2.ports)).sent).toBe(true)
  })
})

describe('T-4d 押しても送らない場合', () => {
  const target = 'sakura-apprun'
  it('応答中は送らない（押した時点）', async () => {
    const w = makeWorld({ target, busy: true })
    notSent(await runTargetCheck(w.ports), 'busy')
    expect(w.sent).toEqual([])
    expect(w.refreshed).toEqual([])
  })

  it('文脈を読み直している間に応答が始まったら、送らない（送る直前にもう一度見る）', async () => {
    const w = makeWorld({ target })
    const orig = w.ports.refreshProjectContext
    w.ports.refreshProjectContext = async (d) => { await orig(d); w.world.busy = true }
    notSent(await runTargetCheck(w.ports), 'busy')
    expect(w.sent).toEqual([])
  })

  it('ほかのプロジェクトで AI が作業中なら送らない（押した時点）。読み直しもせず、押した会話に一言だけ出す', async () => {
    const w = makeWorld({ target, otherBusy: true })
    notSent(await runTargetCheck(w.ports), 'other-busy')
    expect(w.sent).toEqual([])
    expect(w.refreshed).toEqual([])
    expect(w.bubbles).toEqual([{ role: 'assistant', content: TARGET_CHECK_OTHER_BUSY_NOTE }])
  })

  it('一言は、同じ文・1つだけ（吹き出しに押せるボタンの印を付けない）', async () => {
    const w = makeWorld({ target, otherBusy: true })
    await runTargetCheck(w.ports)
    expect(w.bubbles).toHaveLength(1)
    expect(w.bubbles[0]).not.toHaveProperty('offerTargetCheck')
    expect(TARGET_CHECK_OTHER_BUSY_NOTE).toBe('ℹ️ ほかのプロジェクトで AI が作業中です。終わってから、もう一度押してください。')
  })

  it('文脈を読み直している間にほかのプロジェクトで AI が動き出したら、送らない（送る直前にもう一度見る）', async () => {
    const w = makeWorld({ target })
    const orig = w.ports.refreshProjectContext
    w.ports.refreshProjectContext = async (d) => { await orig(d); w.world.otherBusy = true }
    notSent(await runTargetCheck(w.ports), 'other-busy')
    expect(w.sent).toEqual([])
    expect(w.bubbles).toEqual([{ role: 'assistant', content: TARGET_CHECK_OTHER_BUSY_NOTE }])
  })

  it('対照: ほかが作業中でなければ送る。一言も出さない', async () => {
    const w = makeWorld({ target, otherBusy: false })
    expect((await runTargetCheck(w.ports)).sent).toBe(true)
    expect(w.sent).toHaveLength(1)
    expect(w.bubbles).toEqual([])
  })

  it('ほかが作業中でも、自分の応答中が先（busy）。公開先が local・other・読めないときもそちらが先で、一言は出さない', async () => {
    const a = makeWorld({ target, busy: true, otherBusy: true })
    notSent(await runTargetCheck(a.ports), 'busy')
    expect(a.bubbles).toEqual([])
    const b = makeWorld({ target: 'local', otherBusy: true })
    notSent(await runTargetCheck(b.ports), 'no-constraint')
    expect(b.bubbles).toEqual([])
    const c = makeWorld({ metaRaw: null, otherBusy: true })
    notSent(await runTargetCheck(c.ports), 'no-target')
    expect(c.bubbles).toEqual([])
  })

  it('断る一言は、押したプロジェクトの会話にだけ置く（公開先を読んでいる間に切り替わったら、置かない）', async () => {
    const w = makeWorld({ target, otherBusy: true })
    const orig = w.ports.readFile
    w.ports.readFile = async (p) => { const v = await orig(p); w.world.currentDir = OTHER_DIR; return v }
    notSent(await runTargetCheck(w.ports), 'other-busy')
    expect(w.bubbles).toEqual([])
    expect(w.sent).toEqual([])
  })

  it('一言を出して断った回は、ボタンを隠さない（終わったあとに、また押せる）', async () => {
    const w = makeWorld({ target, otherBusy: true })
    const refused = await runTargetCheck(w.ports)
    expect(spendsTargetCheckOffer(refused)).toBe(false)
    w.world.otherBusy = false
    expect((await runTargetCheck(w.ports)).sent).toBe(true)
    expect(w.sent).toHaveLength(1)
  })

  it('押した時点の公開先が local・other なら送らない', async () => {
    for (const t of ['local', 'other']) {
      const w = makeWorld({ target: t })
      notSent(await runTargetCheck(w.ports), 'no-constraint')
      expect(w.sent, t).toEqual([])
      expect(w.refreshed, t).toEqual([])
    }
  })

  it('公開先を読めない（記録なし・壊れ・target が無い・文字列でない）なら送らない', async () => {
    for (const metaRaw of [null, '{broken', '', '{}', '{"target":5}', '{"target":""}', '[]']) {
      const w = makeWorld({ metaRaw })
      notSent(await runTargetCheck(w.ports), 'no-target')
      expect(w.sent, String(metaRaw)).toEqual([])
    }
  })

  it('プロジェクトが開いていなければ送らない', async () => {
    const w = makeWorld({ currentDir: null })
    notSent(await runTargetCheck(w.ports), 'no-project')
    expect(w.sent).toEqual([])
  })

  it('読み直している間にプロジェクトが切り替わったら送らない', async () => {
    const w = makeWorld({ target })
    const orig = w.ports.refreshProjectContext
    w.ports.refreshProjectContext = async (d) => { await orig(d); w.world.currentDir = OTHER_DIR }
    notSent(await runTargetCheck(w.ports), 'project-changed')
    expect(w.sent).toEqual([])
  })

  it('文脈を読み直せなかったら送らない（古い公開先の前提で確かめない）', async () => {
    const w = makeWorld({ target })
    w.ports.refreshProjectContext = async () => { throw new Error('boom') }
    notSent(await runTargetCheck(w.ports), 'context-failed')
    expect(w.sent).toEqual([])
  })

  it('dir が違う知らせは捨てる（吹き出しも置かず、送りもしない）', async () => {
    const w = makeWorld({ target })
    await onTargetChanged({ target, dir: OTHER_DIR }, w.ports)
    expect(w.bubbles).toEqual([])
    expect(w.sent).toEqual([])
  })

  it('押したあとにボタンを隠す回は、送った回と、もう確かめる意味が無い回（local・other・公開先なし）だけ', () => {
    const sentResult: RunTargetCheckResult = { sent: true, dir: DIR, target }
    expect(spendsTargetCheckOffer(sentResult)).toBe(true)
    expect(spendsTargetCheckOffer({ sent: false, reason: 'no-constraint' })).toBe(true)
    expect(spendsTargetCheckOffer({ sent: false, reason: 'no-target' })).toBe(true)
    for (const reason of ['busy', 'no-key', 'other-busy', 'no-project', 'project-changed', 'context-failed'] as const) {
      expect(spendsTargetCheckOffer({ sent: false, reason }), reason).toBe(false)
    }
  })

  it('ボタンの見え方: 応答中は出したまま押せない・印の無い吹き出しとプロジェクトが無い回は出さない', () => {
    const none: TargetCheckSpent = new Map()
    expect(targetCheckButtonState({ offered: true, dir: DIR, spent: none, isLoading: true })).toEqual({ show: true, disabled: true })
    expect(targetCheckButtonState({ offered: true, dir: DIR, spent: none, isLoading: false })).toEqual({ show: true, disabled: false })
    expect(targetCheckButtonState({ offered: undefined, dir: DIR, spent: none, isLoading: false }).show).toBe(false)
    expect(targetCheckButtonState({ offered: false, dir: DIR, spent: none, isLoading: false }).show).toBe(false)
    expect(targetCheckButtonState({ offered: true, dir: null, spent: none, isLoading: false }).show).toBe(false)
    expect(targetCheckButtonState({ offered: true, dir: undefined, spent: none, isLoading: false }).show).toBe(false)
  })
})

describe('T-4d 押した時点でキーが無ければ送らない（古い吹き出しのボタンは、キーを消したあとにも残る）', () => {
  const target = 'sakura-apprun'

  it('キー無し: 送らず・公開先も読まず・文脈も読み直さず・吹き出しも出さない。ボタンは隠さない', async () => {
    const w = makeWorld({ target, keys: 'none' })
    const r = await runTargetCheck(w.ports)
    expect(r).toEqual({ sent: false, reason: 'no-key' })
    expect(w.sent).toEqual([])
    expect(w.log.filter(l => l.startsWith('read ')), '何も読まない').toEqual([])
    expect(w.log.filter(l => l === 'refresh'), '文脈を読み直さない').toEqual([])
    expect(w.bubbles).toEqual([])
    expect(spendsTargetCheckOffer(r)).toBe(false)
  })

  it('対照: Claude のキーだけ・AI Engine のキーだけ・両方なら送る（1回）', async () => {
    for (const keys of ['claude-only', 'ai-engine'] as const) {
      const w = makeWorld({ target, keys })
      expect((await runTargetCheck(w.ports)).sent, keys).toBe(true)
      expect(w.sent, keys).toHaveLength(1)
    }
  })

  it('応答中が先: キーが無くても、応答中なら理由は busy', async () => {
    const w = makeWorld({ target, keys: 'none', busy: true })
    notSent(await runTargetCheck(w.ports), 'busy')
    expect(w.sent).toEqual([])
  })

  it('キー無しはほかの断りより先に見る（公開先が local でも no-key。ほかが作業中でも一言を出さない）', async () => {
    const a = makeWorld({ target: 'local', keys: 'none' })
    notSent(await runTargetCheck(a.ports), 'no-key')
    const b = makeWorld({ target, keys: 'none', otherBusy: true })
    notSent(await runTargetCheck(b.ports), 'no-key')
    expect(b.bubbles).toEqual([])
  })
})

describe('T-4d 公開先がプロファイルに無い（手で書いた・別の版が書いた）回は、local・other と同じく制約なし', () => {
  const unknownTargets = ['cloudflare', 'constructor', '__proto__', 'toString', 'hasOwnProperty']

  it('変更の知らせ: 吹き出しを置かない・送らない', async () => {
    for (const t of unknownTargets) {
      const w = makeWorld({ target: t })
      await onTargetChanged({ target: t, dir: DIR }, w.ports)
      expect(w.bubbles, t).toEqual([])
      expect(w.sent, t).toEqual([])
    }
  })

  it('ボタンを押す: 送らず、理由は no-constraint。送らない回なので、ボタンは隠れる', async () => {
    for (const t of unknownTargets) {
      const w = makeWorld({ target: t })
      const r = await runTargetCheck(w.ports)
      notSent(r, 'no-constraint')
      expect(w.sent, t).toEqual([])
      expect(w.refreshed, t).toEqual([])
      expect(spendsTargetCheckOffer(r), t).toBe(true)
    }
  })
})

describe('T-4h ボタンを隠す時刻（押す前の吹き出しだけ隠れ、押したあとに出た吹き出しには出る）', () => {
  const PRESSED = '2026-10-29T10:00:00.000Z'
  const BEFORE = '2026-10-29T09:59:59.000Z'
  const AFTER = '2026-10-29T10:00:01.000Z'
  const show = (spent: TargetCheckSpent, at: string | undefined, dir: string | null | undefined = DIR) =>
    targetCheckButtonState({ offered: true, dir, spent, isLoading: false, at }).show
  const pressedDir = (): TargetCheckSpent => markTargetCheckSpent(new Map(), DIR, new Date(PRESSED))

  it('押した時刻の記録: 差し替えた時刻（ISO）をそのプロジェクトの分として足す。元の記録は変えない・別のプロジェクトの分は残す', () => {
    const none: TargetCheckSpent = new Map()
    const a = markTargetCheckSpent(none, DIR, new Date(PRESSED))
    expect(none.size).toBe(0)
    expect(a.get(DIR)).toBe(PRESSED)
    const b = markTargetCheckSpent(a, OTHER_DIR, new Date(AFTER))
    expect(a.has(OTHER_DIR)).toBe(false)
    expect(b.get(DIR)).toBe(PRESSED)
    expect(b.get(OTHER_DIR)).toBe(AFTER)
    expect(markTargetCheckSpent(b, DIR, new Date(AFTER)).get(DIR)).toBe(AFTER) // 押し直した時刻に変わる
  })

  it('押す前の吹き出しは隠れ、押したあとに出た吹き出しは出る', () => {
    expect(show(pressedDir(), BEFORE)).toBe(false)
    expect(show(pressedDir(), AFTER)).toBe(true)
  })

  it('押した時刻と同じ時刻の吹き出しは、押す前のもの（隠れる）', () => {
    expect(show(pressedDir(), PRESSED)).toBe(false)
  })

  it('at の無い・読めない吹き出しは、押す前のものとみなして隠れる', () => {
    expect(show(pressedDir(), undefined)).toBe(false)
    expect(show(pressedDir(), '')).toBe(false)
    expect(show(pressedDir(), 'not-a-date')).toBe(false)
  })

  it('別のプロジェクトで押しても、こちらの吹き出しは前後どちらも出る', () => {
    const spent = pressedDir()
    for (const at of [BEFORE, AFTER, undefined]) expect(show(spent, at, OTHER_DIR), String(at)).toBe(true)
  })

  it('押した時刻が無いプロジェクトは、at によらず出る', () => {
    const none: TargetCheckSpent = new Map()
    for (const at of [BEFORE, AFTER, undefined, 'not-a-date']) expect(show(none, at), String(at)).toBe(true)
  })

  it('隠れる回は、応答中かどうかによらず隠れたまま', () => {
    expect(targetCheckButtonState({ offered: true, dir: DIR, spent: pressedDir(), isLoading: true, at: BEFORE }).show).toBe(false)
    expect(targetCheckButtonState({ offered: true, dir: DIR, spent: pressedDir(), isLoading: true, at: AFTER })).toEqual({ show: true, disabled: true })
  })
})

describe('部品の大きさと中身', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/targetCheck.ts'), 'utf-8')

  it('400 行以下', () => {
    expect(src.split('\n').length).toBeLessThanOrEqual(400)
  })

  it('electron・DOM に触れない（偽の ports だけで動く）', () => {
    expect(src).not.toMatch(/window\.|document\.|electronAPI|localStorage/)
  })
})
