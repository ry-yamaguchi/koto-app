import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 結果の双子（HANAMII）: 残った保存場所・受付済み（段階1の1a-2）──────────────────────────────────────
// 破棄の結果は、その場の返り値（toTeardownView）でも、閉じて開き直した記録（本物の summarizeResult を通したもの。
// resumedTeardownView）でも、同じ TeardownView になる（設計書 10.4.9 の「双子」。共通の双子は tests/teardownResultCommon.test.ts）。
//
// ここで固定する新しい事実は2つ（どちらも、足す前は記録の警告に出なかった）:
//   ・HANAMII が保存場所を残した（remainingBucket(s)）→ 「残っている間は課金が続きます」の警告（専有型の「消せずに残った」と同じ文）
//   ・HANAMII が削除を受け付けただけ（deletionAccepted）→ HANAMII_DELETION_ACCEPTED_WARNING。専有型向けの「待ち切れずに止まりました」ではない
// 前半は文で書いた返り値、後半は**本物の main（hanamii:teardown）が返した値**と、main が書いた記録で比べる
// （main の返し方を変えると、ここが落ちる）。最後に、summarizeResult が文を自分で作らないことをソースで固定する。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  status: 200,
  calls: [] as string[],
  listThrows: false,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {} },
  dialog: {},
}))

vi.mock('../src/main/cloud/auth', async (importOriginal) => {
  const real = await importOriginal<any>()
  return { ...real, loadCredentials: () => ({ token: 'tok', secret: 'sec' }) }
})

// 偽の保存場所クライアント（実物の判断はそのまま動かす）。一覧を失敗させると、保存場所が丸ごと残る回になる。
vi.mock('../src/main/cloud/storageAdapter', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    createStorageAdapter: async () => ({
      siteInfo: () => ({ s3Endpoint: 's3.isk01.sakurastorage.jp', region: 'jp-north-1' }),
      async isSiteReady() { return true },
      async ensureBucket() {},
      async putMarker() {},
      async listAllKeys(bucket: string) {
        h.calls.push(`list ${bucket}`)
        if (h.listThrows) throw new Error('一覧を取得できませんでした（テスト）')
        return [`${PREFIX}a.txt`]
      },
      async deleteKeys(bucket: string) { h.calls.push(`deleteKeys ${bucket}`) },
      async deleteBucket(bucket: string) { h.calls.push(`deleteBucket ${bucket}`) },
      async deletePermission() {},
      async issueKey() { return { accessKey: 'AKIA-X', secretKey: 'S3CRET-X', permissionId: 'perm-tmp' } },
      async listPermissions() { return [] },
      async dispose() {},
    }),
  }
})

import { registerHanamiiHandlers } from '../src/main/ipc/hanamii'
import { getOps, resetProjectOpsForTests, summarizeResult } from '../src/main/projectOps'
import { defaultSpec, type EnvSpec } from '../src/main/cloud/spec'
import { holdsWarning } from '../src/renderer/projectOpsView'
import { teardownRemainingWarnings } from '../src/shared/cloudCost'
import type { PublishTargetKind } from '../src/shared/publishMeta'
import {
  toTeardownView, resumedTeardownView, teardownWarningsOf,
  HANAMII_DELETION_ACCEPTED_WARNING, TEARDOWN_REMAINING_WARNING_HEAD, TEARDOWN_IN_PROGRESS_WARNING_HEAD,
  type TeardownLeftover,
} from '../src/shared/teardownResult'
import { deleteProjectReplyText } from './hanamiiTeardownFixtures'
import { isolatedProjectDir } from './isolatedProject'
import { shownTeardown } from './shownFromEnv'

registerHanamiiHandlers({} as any)
const teardown = shownTeardown(h.handlers.get('hanamii:teardown')!) // 画面の代わりに、確認で見せた保存場所（env.json の記録）を渡す

const HANAMII = 'hanamii' as const
const SHARED = 'sakura-apprun' as const
const DEDICATED = 'sakura-apprun-dedicated' as const
const PROJECT_ID = 'hnm-proj-1'
const BUCKET = 'koto-data-x'
const PREFIX = 'projects/myapp/'
const DELETE_CALL = `DELETE https://hanamii.jp/api/v1/projects/${PROJECT_ID}`

/** 同じ返り値を、その場で読む／記録（summarizeResult）から読む。 */
function twin(target: PublishTargetKind, raw: unknown) {
  return { live: toTeardownView(target, raw), resumed: resumedTeardownView(target, summarizeResult(raw)) }
}
const STORAGE = (b: string): TeardownLeftover => ({ label: `保存場所『${b}』（月額が続きます）`, billing: true, kind: 'storage' })
// 保存場所が入っているときは、削除する前の確かめを添える（保存場所はほかのプロジェクトも使っていることがある。Koto は中身を確かめていない）
const STORAGE_CHECK = '保存場所は、ほかのプロジェクトも使っていないか確かめてから削除してください。消すと、そのプロジェクトのデータも消えます。'
const REMAINING_SENTENCE = (names: string) =>
  `削除できずに残っているものがあります。残っている間は課金が続きます。コントロールパネルから直接削除することもできます: ${names}${names.includes('保存場所『') ? `。${STORAGE_CHECK}` : ''}`
const KEY_WARN = '⚠️ 保存場所のアクセスキーを無効にできませんでした。コントロールパネルから確認してください'
const PROJECT_LINE = "HANAMII のプロジェクト『myapp』を削除しました"

describe('★★★ HANAMII の残った保存場所: 月額が続く警告が、その場でも記録からも出る（以前は記録の警告に出ず、自動で「見た」にされうる状態だった）', () => {
  it('★ 複数の保存場所が残った → 全件を名指しした1つの警告。見出しは failed、一覧は2件、その場と記録が一致', () => {
    const raw = {
      ok: false, appDeleted: true, executed: [PROJECT_LINE], remainingBucket: 'koto-a', remainingBuckets: ['koto-a', 'koto-b'],
      message: '保存場所『koto-a』を削除できませんでした',
    }
    const { live, resumed } = twin(HANAMII, raw)
    expect(resumed).toEqual(live)
    expect(live).toMatchObject({ ok: false, state: 'failed', appDeleted: true, inProgress: [] })
    expect(live.remaining).toEqual([STORAGE('koto-a'), STORAGE('koto-b')])
    expect(live.warnings).toEqual([REMAINING_SENTENCE('保存場所『koto-a』（月額が続きます）・保存場所『koto-b』（月額が続きます）')])
    expect(summarizeResult(raw).warnings).toEqual(live.warnings)
    expect(teardownWarningsOf(raw)).toEqual(live.warnings)
    expect(live.warnings[0].startsWith(TEARDOWN_REMAINING_WARNING_HEAD)).toBe(true)
  })

  it('remainingBuckets が無ければ remainingBucket の1件。同じ名前は1つ', () => {
    for (const raw of [
      { ok: false, appDeleted: true, remainingBucket: 'koto-a' },
      { ok: false, appDeleted: true, remainingBucket: 'koto-a', remainingBuckets: [] },
      { ok: false, appDeleted: true, remainingBuckets: ['koto-a', 'koto-a'] },
    ]) {
      const { live, resumed } = twin(HANAMII, raw)
      expect(live.remaining, JSON.stringify(raw)).toEqual([STORAGE('koto-a')])
      expect(live.warnings, JSON.stringify(raw)).toEqual([REMAINING_SENTENCE('保存場所『koto-a』（月額が続きます）')])
      expect(resumed, JSON.stringify(raw)).toEqual(live)
    }
  })

  it('★ 残した保存場所（バケットごとは消さなかった）と、消せずに残った保存場所が同時にある → 警告の並びは「残した」→「残った」', () => {
    const raw = { ok: false, appDeleted: true, executed: [PROJECT_LINE, KEY_WARN], remainingBuckets: ['koto-b'], keptBucketName: 'koto-a', keptBucketNames: ['koto-a'] }
    const { live, resumed } = twin(HANAMII, raw)
    expect(resumed).toEqual(live)
    expect(live.executed).toEqual([PROJECT_LINE])
    expect(live.warnings).toEqual([KEY_WARN, ...teardownRemainingWarnings({ keptBucketName: 'koto-a', keptBucketNames: ['koto-a'] }), REMAINING_SENTENCE('保存場所『koto-b』（月額が続きます）')])
    expect(live.warnings).toHaveLength(3)
  })

  it('保存場所の名前が分からない回（設定を読めない）は、名前を作らない: 一覧も、残った保存場所の警告も空（文は message が言う）', () => {
    const raw = { ok: false, appDeleted: true, executed: [PROJECT_LINE], message: '保存場所の設定を読めないため、保存場所は削除していません' }
    const { live, resumed } = twin(HANAMII, raw)
    expect(live).toMatchObject({ remaining: [], warnings: [], message: raw.message })
    expect(resumed).toEqual(live)
  })

  it('名前が文字列でない・空 → 読まない', () => {
    const raw = { ok: false, appDeleted: true, remainingBucket: 5, remainingBuckets: ['', null, 7, {}] }
    expect(teardownWarningsOf(raw)).toEqual([])
    const { live, resumed } = twin(HANAMII, raw)
    expect(live.remaining).toEqual([])
    expect(resumed).toEqual(live)
  })

  it('★ ok が true でない値（不明値）でも、残った保存場所の警告を落とさない。ok が true のときだけ言わない（専有型の残ったものと同じ扱い）', () => {
    for (const bad of ['true', 1, 'ok', {}, [], null, undefined]) {
      const raw = { ok: bad, executed: [], remainingBuckets: ['koto-a'] }
      const { live, resumed } = twin(HANAMII, raw)
      expect(live.warnings, String(bad)).toEqual([REMAINING_SENTENCE('保存場所『koto-a』（月額が続きます）')])
      expect(resumed.warnings, String(bad)).toEqual(live.warnings)
    }
    expect(teardownWarningsOf({ ok: true, executed: [], remainingBuckets: ['koto-a'] })).toEqual([])
  })

  it('専有型・共用型の返り値は、HANAMII の読みを通らない（専有型は remaining＋remainingBuckets を dedicatedRemaining が1回だけ読む、共用型は keptBucketName。同じ保存場所を二重に言わない）', () => {
    // V10（段階3B-2）: 専有型も保存場所の残りを全件（remainingBuckets）で言う。remaining.storageBucket（止まった1件）と重ねない＝koto-a は1回
    const dedicated = { ok: false, appDeleted: true, executed: [], remaining: { storageBucket: 'koto-a' }, remainingBuckets: ['koto-a', 'koto-b'] }
    const sentence = REMAINING_SENTENCE('保存場所『koto-a』（月額が続きます）・保存場所『koto-b』（月額が続きます）')
    expect(teardownWarningsOf(dedicated)).toEqual([sentence])
    expect(twin(DEDICATED, dedicated).live.warnings).toEqual([sentence])
    expect(sentence.split('『koto-a』').length - 1).toBe(1)
    // 専有型の断り（remaining が空のオブジェクト・残りの名前も無い。main が実際に返す形）は、残ったとは言わない
    expect(teardownWarningsOf({ ok: false, executed: [], message: 'クラウドのAPIキーが未登録です', remaining: {} })).toEqual([])
    // 残りの全件が名前つきで返っているなら、remaining が空でも「残っている」と言う（返り値が名指ししている月額が続く保存場所を、黙らない）
    expect(teardownWarningsOf({ ok: false, executed: [], remaining: {}, remainingBuckets: ['koto-a'] })).toEqual([REMAINING_SENTENCE('保存場所『koto-a』（月額が続きます）')])
    const shared = { ok: false, executed: [], keptBucketName: 'koto-a', message: '失敗' }
    expect(twin(SHARED, shared).live.warnings).toEqual(teardownRemainingWarnings({ keptBucketName: 'koto-a' }))
  })
})

describe('★★★ HANAMII の受付済み（deletionAccepted）: 「待ち切れずに止まりました」ではなく、HANAMII 用の文。見出しは途中', () => {
  const ACCEPTED = { ok: false, appDeleted: false, deletionAccepted: true, message: HANAMII_DELETION_ACCEPTED_WARNING }

  it('★★★ 見出しは inProgress、一覧は空（HANAMII は残っているものの内訳を返さない）、警告は HANAMII 用の文だけ。その場と記録が一致', () => {
    const { live, resumed } = twin(HANAMII, ACCEPTED)
    expect(resumed).toEqual(live)
    expect(live).toMatchObject({ ok: false, state: 'inProgress', appDeleted: false, remaining: [], inProgress: [], executed: [], message: HANAMII_DELETION_ACCEPTED_WARNING })
    expect(live.warnings).toEqual([HANAMII_DELETION_ACCEPTED_WARNING])
  })

  it('★★★ summarizeResult を実際に呼んで確かめる: 警告に HANAMII の文がある・専有型向けの文（TEARDOWN_IN_PROGRESS_WARNING_HEAD で始まる文）が無い・extra に deletionAccepted が写る', () => {
    const rec = summarizeResult(ACCEPTED)
    expect(rec.warnings).toEqual([HANAMII_DELETION_ACCEPTED_WARNING])
    expect(rec.warnings.some(w => w.startsWith(TEARDOWN_IN_PROGRESS_WARNING_HEAD))).toBe(false)
    expect(rec.warnings.some(w => w.includes('待ち切れずに止まりました'))).toBe(false)
    expect(rec.extra.deletionAccepted).toBe(true)
    expect(rec.ok).toBe(false)
    expect(holdsWarning({ result: rec }), '受付済みの記録が「警告つき」でないと、自動で「見た」にされる').toBe(true)
  })

  it('記録から開き直すと受付済みと分かる（extra の deletionAccepted が見出しを決める）', () => {
    const rec = summarizeResult(ACCEPTED)
    expect(resumedTeardownView(HANAMII, rec).state).toBe('inProgress')
    const without = { ...rec, extra: Object.fromEntries(Object.entries(rec.extra).filter(([k]) => k !== 'deletionAccepted')) }
    expect(resumedTeardownView(HANAMII, without).state, 'extra に無ければ受付済みとは読まない').toBe('failed')
  })

  it('★ ok が先: ok:true なら deletionAccepted が付いていても done。true 以外の値（文字列・数・空のオブジェクト）は受付済みと読まない', () => {
    expect(toTeardownView(HANAMII, { ok: true, appDeleted: true, deletionAccepted: true }).state).toBe('done')
    for (const bad of ['true', 1, 'yes', {}, [], null, undefined, false]) {
      const raw = { ok: false, appDeleted: false, deletionAccepted: bad }
      const { live, resumed } = twin(HANAMII, raw)
      expect(live.state, String(bad)).toBe('failed')
      expect(live.warnings, String(bad)).toEqual([])
      expect(resumed, String(bad)).toEqual(live)
    }
  })

  it('受付済みを途中と読むのは HANAMII だけ（専有型の inProgress と同じく、公開先の意味を混ぜない）', () => {
    for (const t of [SHARED, DEDICATED] as const) expect(toTeardownView(t, ACCEPTED).state, t).toBe('failed')
  })

  it('受付済みの文は、HANAMII の main が返す message と同じ1つの定数（文が2か所で書き分けられていない）', () => {
    expect(HANAMII_DELETION_ACCEPTED_WARNING).toBe('HANAMII の削除が済んだと確認できませんでした（受け付けただけで、まだ終わっていない場合があります）。しばらくしてから、もう一度破棄を押してください。保存場所と記録は、削除が確認できるまで残してあります。')
    // 2xx で deleted が true でないものは全部この回に入る（204・空の本文など、原本に例の無い形を含む）。確かめていない「受け付けた」「終わっていない」を断定しない。
    expect(HANAMII_DELETION_ACCEPTED_WARNING).not.toContain('受け付けましたが')
    expect(HANAMII_DELETION_ACCEPTED_WARNING).not.toContain('まだ終わっていません')
  })
})

describe('★★★ 本物の main（hanamii:teardown）の返り値と、main が書いた記録が、同じ TeardownView になる', () => {
  let projectDir = ''
  const realFetch = globalThis.fetch

  beforeEach(() => {
    resetProjectOpsForTests()
    projectDir = isolatedProjectDir('koto-hanamii-twin-')
    h.status = 200
    h.calls = []
    h.listThrows = false
    globalThis.fetch = (async (input: unknown, init: any) => {
      h.calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
      const status = h.status
      return { ok: status >= 200 && status < 300, status, async text() { return deleteProjectReplyText(status, PROJECT_ID) } }
    }) as unknown as typeof fetch
    const spec: EnvSpec = defaultSpec({ name: 'myapp', hasDockerfile: false })
    spec.persistence = { objectStorage: [{ bucket: BUCKET, prefix: PREFIX, shared: true, consentedAt: '2026-08-14T00:00:00.000Z' }] } as any
    fs.mkdirSync(path.join(projectDir, '.sakura-cloud'), { recursive: true })
    fs.writeFileSync(path.join(projectDir, '.sakura-cloud', 'env.json'), JSON.stringify(spec, null, 2), 'utf-8')
    fs.writeFileSync(path.join(projectDir, '.sakuraide.json'), JSON.stringify({
      publish: { hanamii: { projectId: PROJECT_ID }, targets: { hanamii: { publishedAt: '2026-09-29T00:00:00.000Z', url: null } } },
    }, null, 2), 'utf-8')
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  const run = () => teardown({}, projectDir, { token: 'hnm_test' }, { confirmed: true, projectId: PROJECT_ID })
  const record = () => getOps(projectDir).last?.result

  it('★★★ 202（受け付けただけ）: 保存場所へ触れず、その場の見出しも記録の見出しも「途中」。記録の警告は HANAMII の文だけ', async () => {
    h.status = 202
    const raw = await run()
    expect(h.calls).toEqual([DELETE_CALL])
    const live = toTeardownView(HANAMII, raw)
    const resumed = resumedTeardownView(HANAMII, record())
    expect(resumed).toEqual(live)
    expect(live).toMatchObject({ ok: false, state: 'inProgress', appDeleted: false, remaining: [], inProgress: [] })
    expect(record()?.warnings).toEqual([HANAMII_DELETION_ACCEPTED_WARNING])
    expect(record()?.extra?.deletionAccepted).toBe(true)
    expect(holdsWarning({ result: record() })).toBe(true)
  })

  it('★★★ 200 のあと保存場所の一覧に失敗: 保存場所が丸ごと残る。記録の警告に「課金が続きます」が出る（以前は出なかった）', async () => {
    h.listThrows = true
    const raw = await run()
    expect(raw).toMatchObject({ ok: false, appDeleted: true, remainingBuckets: [BUCKET] })
    const live = toTeardownView(HANAMII, raw)
    const resumed = resumedTeardownView(HANAMII, record())
    expect(resumed).toEqual(live)
    expect(live).toMatchObject({ state: 'failed', appDeleted: true })
    expect(live.remaining).toEqual([STORAGE(BUCKET)])
    expect(record()?.warnings).toEqual([REMAINING_SENTENCE(`保存場所『${BUCKET}』（月額が続きます）`)])
    // 一覧できなかった保存場所は、中身を確かめていない（共有のものかもしれない）。保存場所ごと削除するよう、無条件に勧めない
    expect(raw.message).toContain('やり直しても消えないときは、さくらのクラウドのコントロールパネル（オブジェクトストレージ）で、ほかのプロジェクトも使っていないか確かめてから削除してください。消すと、そのプロジェクトのデータも消えます。')
    expect(raw.message).not.toContain('オブジェクトストレージ）から削除してください')
    expect(holdsWarning({ result: record() }), '月額が続く回の記録が「警告つき」でないと、自動で「見た」にされる').toBe(true)
  })

  it('全部片づいた: 警告なし・見出しは done で、その場と記録が一致', async () => {
    const raw = await run()
    expect(raw.ok).toBe(true)
    const live = toTeardownView(HANAMII, raw)
    expect(resumedTeardownView(HANAMII, record())).toEqual(live)
    expect(live).toMatchObject({ ok: true, state: 'done', appDeleted: true, remaining: [], warnings: [] })
    expect(record()?.warnings).toEqual([])
  })
})

describe('★★ summarizeResult は文を自分で作らない（文の作り手は shared/teardownResult.ts の reportedLinesOf と teardownWarningsOf だけ）', () => {
  // 双子（上）は「いま同じ文になる」ことしか見ない。summarizeResult に文を書き直されても、いまの文と同じなら緑のまま——
  // 次に片方だけ文が直ると、開き直した画面からだけ警告が消える。だから**呼び出しの形**もソースで固定する（コメント行は除く）。
  const code = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8').split('\n').filter(l => {
    const t = l.trimStart()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  }).join('\n')

  it('★★ projectOps.ts は reportedLinesOf( と teardownWarningsOf( を呼ぶ', () => {
    const src = code('src/main/projectOps.ts')
    expect(src).toContain('const reported = reportedLinesOf(v)')
    expect(src).toContain('for (const t of reported.executed) lines.push(s(t))')
    expect(src).toContain('for (const w of reported.warnings) addWarning(w)')
    expect(src).toContain('for (const w of teardownWarningsOf(v)) addWarning(w)')
    expect(src).toContain("from '../shared/teardownResult'")
  })

  it('★★ projectOps.ts に、専有型向けの文・残ったものの文・月額の警告・名前の並べ方を直書きしない（直す前の形を禁じる）', () => {
    const src = code('src/main/projectOps.ts')
    for (const old of [
      '削除の途中で、待ち切れずに止まりました',
      '削除できずに残っているものがあります',
      '課金が続きます',
      'teardownRemainingWarnings(',
      'remainingNames',
      'hasWarnMark(',
    ]) expect(src, old).not.toContain(old)
  })

  it('★ 事実から作った警告も、秘密を伏せる（呼び出し側が渡した秘密の完全一致。起きたことの行と同じ道を通る）', () => {
    const secret = 'hnm_secret_abcdef123'
    const rec = summarizeResult({ ok: false, executed: [`${secret} を使いました`], remainingBuckets: [`koto-${secret}`] }, [secret])
    expect(rec.lines).toEqual(['*** を使いました'])
    expect(rec.warnings).toHaveLength(1)
    expect(rec.warnings[0]).toContain('koto-***')
    expect(JSON.stringify(rec)).not.toContain(secret)
  })

  it('★ 許可リスト EXTRA_KEYS に deletionAccepted がある（無いと extra に写らず、開き直した画面が受付済みと分からない）', () => {
    expect(code('src/main/projectOps.ts')).toMatch(/'remainingBuckets', 'deletionAccepted',/)
    expect(summarizeResult({ ok: false, deletionAccepted: true }).extra).toEqual({ deletionAccepted: true })
    // 真偽値以外の素性（文字列）は写しても受付済みと読まない（読み手は === true だけ）
    expect(resumedTeardownView(HANAMII, { ok: false, extra: { deletionAccepted: 'true' } }).state).toBe('failed')
  })
})
