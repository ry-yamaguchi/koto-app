import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getOps, ackOps, progressReporter, summarizeResult, scrub, capUnseen,
  setProjectOpsListener, resetProjectOpsForTests,
} from '../src/main/projectOps'
import { withProjectLock, runningOp } from '../src/main/projectLock'
import { unseenOf, ackUpToFor, isHanamiiOp } from '../src/renderer/projectOpsView'
import { remainingCostWarning, teardownRemainingWarnings } from '../src/shared/cloudCost'

// ── なぜこのテストが要るか（2026-09-29・作者の決定 ①②）──────────────────────────
// 公開・破棄・作成の本体は main の1回の IPC で最後まで進む。処理中にダイアログを閉じても止まらないが、
// **画面が持っていた表示（進み具合・結果・警告）は窓の状態にしか無く、開き直すと消えた**。
// そこで main が「プロジェクトごとの処理の記録」を持つ（src/main/projectOps.ts）。ここはその記録の**振る舞い**を
// 本物の鍵（withProjectLock）を通して固定する（ソースの文字列は読まない・掟10）:
//   走っている間は running と最新の進み具合／終わると last に結果（警告を含む）／ack で消える／
//   別プロジェクトの記録は混ざらない（掟11）／秘密が記録に入らない（掟4）

const A = '/p/ops-a'
const B = '/p/ops-b'
const META = { target: 'sakura-apprun' as const, handler: 'test:handler' }

/** 外から開けるまで止まっている処理（「走っている最中」を作る）。 */
function gate<T>(value: T) {
  let open!: () => void
  const closed = new Promise<void>(r => { open = r })
  return { open, wait: async () => { await closed; return value } }
}

beforeEach(() => resetProjectOpsForTests())

describe('走っている間: get は running と最新の進み具合を返す', () => {
  it('★ 始まった記録には、操作名・公開先・IPC 名・開始時刻・running:true・最初の進み具合が入る', async () => {
    const g = gate({ ok: true })
    const p = withProjectLock(A, '公開', g.wait, META)
    const snap = getOps(A)
    expect(snap.last).toBeNull()
    expect(snap.running).toMatchObject({ op: '公開', target: 'sakura-apprun', handler: 'test:handler', running: true, seen: false })
    expect(typeof snap.running!.startedAt).toBe('number')
    expect(snap.running!.progress.label).toContain('公開')
    expect(snap.running!.result).toBeUndefined()
    expect(snap.running!.finishedAt).toBeUndefined()
    g.open(); await p
  })

  it('★ 進捗を送るたび、running の progress が最新に変わる（label・detail・step/total・at）', async () => {
    const g = gate({ ok: true })
    const progress = progressReporter(A)
    const p = withProjectLock(A, '公開', g.wait, META)
    progress('アップロード中… (2/5)', { step: 2, total: 5, detail: '経過 3秒' })
    const pr = getOps(A).running!.progress
    expect(pr).toMatchObject({ label: 'アップロード中… (2/5)', detail: '経過 3秒', step: 2, total: 5 })
    expect(typeof pr.at).toBe('number')
    progress('公開の準備をしています…')
    const pr2 = getOps(A).running!.progress
    expect(pr2.label).toBe('公開の準備をしています…')
    expect(pr2.detail).toBe('')
    // 前の段の step/total を引きずらない
    expect(pr2.step).toBeUndefined()
    expect(pr2.total).toBeUndefined()
    g.open(); await p
  })

  it('進捗の送り口は、renderer への送信（send）もこれまでどおり行う。送信が落ちても記録は更新される', async () => {
    const g = gate({ ok: true })
    const sent: string[] = []
    const progress = progressReporter(A, m => { sent.push(m); throw new Error('ウィンドウは破棄済み') })
    const p = withProjectLock(A, '削除', g.wait, META)
    expect(() => progress('削除しています…')).not.toThrow()
    expect(sent).toEqual(['削除しています…'])
    expect(getOps(A).running!.progress.label).toBe('削除しています…')
    g.open(); await p
  })

  it('走っていないときの進捗は何も起こさない（記録を作らない・別の操作の記録を汚さない）', async () => {
    progressReporter(A)('迷子の進捗')
    expect(getOps(A)).toEqual({ running: null, last: null, earlier: [] })
    // A が走っている間に、B の進捗（B は走っていない）を送っても A の記録は変わらない
    const g = gate({ ok: true })
    const p = withProjectLock(A, '公開', g.wait, META)
    progressReporter(A)('Aの進捗')
    progressReporter(B)('Bの迷子')
    expect(getOps(A).running!.progress.label).toBe('Aの進捗')
    expect(getOps(B)).toEqual({ running: null, last: null, earlier: [] })
    g.open(); await p
  })

  it('★ 走っているあいだ、鍵に断られた側は記録を作らず、走っている記録を変えない', async () => {
    const g = gate({ ok: true })
    const p = withProjectLock(A, '削除', g.wait, META)
    progressReporter(A)('削除を待っています…')
    const refused = await withProjectLock(A, '公開', async () => ({ ok: true }), { target: 'hanamii', handler: 'x' })
    expect(refused).toEqual({ busy: true, running: '削除' })
    const running = getOps(A).running!
    expect(running.op).toBe('削除')
    expect(running.handler).toBe('test:handler')
    expect(running.progress.label).toBe('削除を待っています…')
    g.open(); await p
    // 終わった記録も1件だけ（断られた側は残らない）
    expect(getOps(A).last!.op).toBe('削除')
    expect(getOps(A).earlier).toEqual([])
  })

  it('同じフォルダの別の書き方（末尾の / ・ ..）でも、同じ記録を読む', async () => {
    const g = gate({ ok: true })
    const p = withProjectLock(`${A}/`, '公開', g.wait, META)
    expect(getOps(A).running?.op).toBe('公開')
    expect(getOps('/p/ops-a/sub/..').running?.op).toBe('公開')
    g.open(); await p
    expect(getOps(`${A}/.`).last?.op).toBe('公開')
  })
})

describe('終わると: last に結果（警告を含む）が載り、ack で消える', () => {
  it('★ 終わった記録: running:false・finishedAt・result（ok・message・url・warnings）・seen:false。get の running は null', async () => {
    const r = await withProjectLock(A, '削除', async () => ({
      ok: false, message: '保存場所だけ片づけられませんでした',
      warnings: ['⚠️ 保存場所『koto-data-x』が残っています（消すまで月額が続きます）'],
      url: 'https://example.test/', executed: ['アプリを削除しました', '⚠️ 鍵を無効にできませんでした'],
    }), META)
    expect(r.busy).toBe(false)
    const snap = getOps(A)
    expect(snap.running).toBeNull()
    expect(snap.last).toMatchObject({ op: '削除', running: false, seen: false })
    expect(typeof snap.last!.finishedAt).toBe('number')
    expect(snap.last!.finishedAt!).toBeGreaterThanOrEqual(snap.last!.startedAt)
    const res = snap.last!.result!
    expect(res.ok).toBe(false)
    expect(res.message).toBe('保存場所だけ片づけられませんでした')
    expect(res.url).toBe('https://example.test/')
    // 「月額が続きます」の警告を見逃さない。executed の ⚠️ 行も警告へ集める
    expect(res.warnings).toContain('⚠️ 保存場所『koto-data-x』が残っています（消すまで月額が続きます）')
    expect(res.warnings).toContain('⚠️ 鍵を無効にできませんでした')
    expect(res.lines).toEqual(['アプリを削除しました'])
    // 鍵は外れている
    expect(runningOp(A)).toBeUndefined()
  })

  it('★ ack すると last が消える（何度呼んでも壊れない）', async () => {
    await withProjectLock(A, '公開', async () => ({ ok: true }), META)
    expect(getOps(A).last).not.toBeNull()
    expect(ackOps(A)).toBe(1)
    expect(getOps(A).last).toBeNull()
    expect(ackOps(A)).toBe(0)
    expect(getOps(A)).toEqual({ running: null, last: null, earlier: [] })
  })

  it('例外で終わった操作も記録される（例外は呼び出し側へそのまま届き、鍵は外れる）', async () => {
    await expect(withProjectLock(A, '削除', async () => { throw new Error('落ちた') }, META)).rejects.toThrow('落ちた')
    expect(runningOp(A)).toBeUndefined()
    const res = getOps(A).last!.result!
    expect(res.ok).toBe(false)
    expect(res.message).toContain('落ちた')
  })

  it('★ 結果を見ないうちに次の操作が終わっても、前の結果（警告）を上書きで見逃さない（earlier）', async () => {
    await withProjectLock(A, '削除', async () => ({ ok: false, warnings: ['保存場所が残りました（月額が続きます）'] }), META)
    await withProjectLock(A, '公開', async () => ({ ok: true }), META)
    const snap = getOps(A)
    expect(snap.last!.op).toBe('公開')
    expect(snap.earlier).toHaveLength(1)
    expect(snap.earlier[0].op).toBe('削除')
    expect(snap.earlier[0].result!.warnings).toEqual(['保存場所が残りました（月額が続きます）'])
  })

  it('★ ack(upToStartedAt) は、見せた記録までだけ見たことにする（見せている間に終わった次の結果を消さない）', async () => {
    await withProjectLock(A, '削除', async () => ({ ok: true }), META)
    const shown = getOps(A).last!
    // 画面が結果を見せている間に、次の操作が終わる
    await withProjectLock(A, '公開', async () => ({ ok: false, message: '次の結果' }), META)
    expect(ackOps(A, shown.startedAt)).toBe(1)
    const snap = getOps(A)
    expect(snap.last!.op).toBe('公開')
    expect(snap.last!.result!.message).toBe('次の結果')
    expect(snap.earlier).toEqual([])
    // 引数なしなら残りも全部
    expect(ackOps(A)).toBe(1)
    expect(getOps(A).last).toBeNull()
  })

  it('startedAt は同じプロジェクトで必ず増える（記録の識別子として使える）', async () => {
    const seen: number[] = []
    for (let i = 0; i < 4; i++) {
      await withProjectLock(A, '公開', async () => ({ ok: true }), META)
      seen.push(getOps(A).last!.startedAt)
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1])
  })

  it('見られていない記録は最大5件まで（古いものから捨てる）', async () => {
    for (let i = 0; i < 7; i++) await withProjectLock(A, '公開', async () => ({ ok: true, message: `結果${i}` }), META)
    const snap = getOps(A)
    expect([...snap.earlier, snap.last!].map(r => r.result!.message)).toEqual(['結果2', '結果3', '結果4', '結果5', '結果6'])
  })
})

// ── 上限で押し出すとき、「確認しました」を待つ警告を捨てない（2026-09-30 検分の指摘2）──────────────────
// 単純に古いものから捨てると、共用型の破棄の「月額が続きます」の警告が、その後に別の公開先の操作が
// 何度か終わっただけで main から黙って消える（画面は消えた警告を二度と出せない）。
describe('★★★ 見られていない記録が上限を超えても、警告つき・失敗の記録は、ただの成功より後まで残す', () => {
  const HANAMII = { target: 'hanamii' as const, handler: 'hanamii:publish' }
  const SHARED_TEARDOWN = { target: 'sakura-apprun' as const, handler: 'cloud:teardown' }
  const KEPT = 'データの保存場所『koto-b』'

  /** HANAMII の画面が、開いている間に自分の記録を出しては「見た」と伝える（useProjectOpsView と同じ ack の決め方）。 */
  const hanamiiPanelAcks = () => {
    const upTo = ackUpToFor(unseenOf(getOps(A)), isHanamiiOp)
    if (upTo !== null) ackOps(A, upTo)
  }

  it('★★★ 先頭に共用型の破棄の警告（月額が続く）があり、HANAMII の公開が6回終わっても、その警告は main に残る', async () => {
    await withProjectLock(A, '削除', async () => ({ ok: true, keptBucketName: 'koto-b' }), SHARED_TEARDOWN)
    const warned = getOps(A).last!
    expect(warned.result!.warnings.join('\n')).toContain(KEPT)
    for (let i = 0; i < 6; i++) {
      await withProjectLock(A, '公開', async () => ({ ok: true, message: `HANAMII ${i}` }), HANAMII)
      hanamiiPanelAcks() // 共用型の警告が先頭にあるので、HANAMII の画面は何も見たことにできない（巻き添えで消さない）
    }
    const left = unseenOf(getOps(A))
    expect(left.some(r => r.startedAt === warned.startedAt), '警告つきの記録が上限の押し出しで消えた').toBe(true)
    expect(left.length).toBeLessThanOrEqual(5)
    // 残っているのは、警告の記録と、いちばん新しい成功の記録たち
    expect(left[0].handler).toBe('cloud:teardown')
    expect(left[left.length - 1].result!.message).toBe('HANAMII 5')
  })

  it('★★ うまくいかなかった記録（警告は無い）も、ただの成功より後まで残す', async () => {
    await withProjectLock(A, '公開', async () => ({ ok: false, message: '公開に失敗しました' }), HANAMII)
    const failed = getOps(A).last!
    for (let i = 0; i < 6; i++) await withProjectLock(A, '公開', async () => ({ ok: true, message: `成功 ${i}` }), HANAMII)
    const left = unseenOf(getOps(A))
    expect(left.some(r => r.startedAt === failed.startedAt)).toBe(true)
    expect(left).toHaveLength(5)
  })

  it('★★ いま終わった操作の結果は、上限で押し出さない（古い警告が5件あっても、新しい成功の結果は画面が読める）', async () => {
    for (let i = 0; i < 5; i++) {
      await withProjectLock(A, '削除', async () => ({ ok: true, keptBucketName: `koto-${i}` }), SHARED_TEARDOWN)
    }
    await withProjectLock(A, '公開', async () => ({ ok: true, message: '新しい成功' }), HANAMII)
    const left = unseenOf(getOps(A))
    expect(left).toHaveLength(5)
    expect(left[left.length - 1].result!.message).toBe('新しい成功')
    // 押し出されたのは、いちばん古い警告（全部が警告つきのときだけ、古い順に捨てる）
    expect(left.filter(r => r.handler === 'cloud:teardown')).toHaveLength(4)
  })

  it('全部が警告つきのときは、古いものから捨てる（無限には溜めない）', async () => {
    for (let i = 0; i < 8; i++) {
      await withProjectLock(A, '削除', async () => ({ ok: true, keptBucketName: `koto-${i}` }), SHARED_TEARDOWN)
    }
    const left = unseenOf(getOps(A))
    expect(left).toHaveLength(5)
    expect(left.map(r => r.result!.warnings.join(''))).toEqual([3, 4, 5, 6, 7].map(i => expect.stringContaining(`koto-${i}`)))
  })

  it('capUnseen は、警告も失敗も無い成功の記録だけを先に捨てる（純関数）', () => {
    const rec = (n: number, over: Record<string, unknown> = {}) => ({
      op: '公開', target: 'hanamii', handler: 'h', startedAt: n, running: false, seen: false,
      progress: { label: '', detail: '', at: n },
      result: { ok: true, lines: [], warnings: [], extra: {}, ...over },
    }) as any
    const list = [rec(1, { warnings: ['w'] }), rec(2), rec(3, { ok: false }), rec(4), rec(5), rec(6)]
    expect(capUnseen(list).map(r => r.startedAt)).toEqual([1, 3, 4, 5, 6])
    expect(capUnseen(list.slice(0, 5)).map(r => r.startedAt)).toEqual([1, 2, 3, 4, 5]) // 上限以内は何も捨てない
  })
})

describe('★★ 別のプロジェクトの記録は混ざらない（掟11）', () => {
  it('A が走っていて B が終わっているとき、それぞれ自分の記録だけを返す', async () => {
    await withProjectLock(B, '公開', async () => ({ ok: true, message: 'B の結果' }), META)
    const g = gate({ ok: true })
    const p = withProjectLock(A, '削除', g.wait, { target: 'hanamii', handler: 'a' })
    progressReporter(A)('A の進捗')

    const a = getOps(A)
    const b = getOps(B)
    expect(a.running!.progress.label).toBe('A の進捗')
    expect(a.last).toBeNull()
    expect(b.running).toBeNull()
    expect(b.last!.result!.message).toBe('B の結果')
    // A の ack は B の結果を消さない
    ackOps(A)
    expect(getOps(B).last).not.toBeNull()
    // B の ack は A の結果（あとで終わる）を消さない
    g.open(); await p
    ackOps(B)
    expect(getOps(A).last!.op).toBe('削除')
    expect(getOps(B).last).toBeNull()
  })

  it('押し出しの通知は、変わったプロジェクトの分だけ（正規化した projectDir 付き）', async () => {
    const events: Array<{ dir: string; running: boolean; last: boolean }> = []
    setProjectOpsListener((dir, snap) => events.push({ dir, running: !!snap.running, last: !!snap.last }))
    await withProjectLock(`${A}/`, '公開', async () => ({ ok: true }), META)
    expect(events.map(e => e.dir)).toEqual([A, A])      // 始まり・終わり（どちらも A の分）
    expect(events[0]).toEqual({ dir: A, running: true, last: false })
    expect(events[1]).toEqual({ dir: A, running: false, last: true })
    ackOps(A)
    expect(events[2]).toEqual({ dir: A, running: false, last: false })
    expect(events.some(e => e.dir === B)).toBe(false)
  })

  it('押し出しの受け手が例外を投げても、操作は止まらない', async () => {
    setProjectOpsListener(() => { throw new Error('受け手の失敗') })
    const r = await withProjectLock(A, '公開', async () => ({ ok: true }), META)
    expect(r).toEqual({ busy: false, value: { ok: true } })
    expect(getOps(A).last).not.toBeNull()
  })
})

describe('★★ 秘密が記録に入らない（掟4）', () => {
  const TOKEN = 'hnm_SECRET-TOKEN-0123456789'
  const SECRET = 'sakura-secret-value-9876543210'

  it('渡した秘密は、進捗・メッセージ・詳細・行・警告・extra のどこからも伏せられる（完全一致）', async () => {
    const progress = progressReporter(A)
    await withProjectLock(A, '公開', async () => {
      progress(`認証に失敗しました（${TOKEN}）`, { detail: `secret=${SECRET}` })
      // 進行中の記録にも入っていない
      expect(JSON.stringify(getOps(A).running)).not.toContain(TOKEN)
      expect(JSON.stringify(getOps(A).running)).not.toContain(SECRET)
      return {
        ok: false,
        message: `HTTP 401: ${TOKEN} は無効です`,
        detail: `Authorization を確認: ${SECRET}`,
        executed: [`トークン ${TOKEN} で接続しました`, `⚠️ ${SECRET} は使えません`],
        warnings: [`${TOKEN} を確認してください`],
        notice: `お知らせ ${SECRET}`,
        stage: `image-${TOKEN}`,
      }
    }, { ...META, secrets: [TOKEN, SECRET, undefined, null] })

    const json = JSON.stringify(getOps(A))
    expect(json).not.toContain(TOKEN)
    expect(json).not.toContain(SECRET)
    // 文としては残っている（消しすぎて読めなくならない）
    expect(getOps(A).last!.result!.message).toBe('HTTP 401: *** は無効です')
  })

  it('例外のメッセージに秘密が入っていても、記録には伏せて残る（例外自体は呼び出し側へ届く）', async () => {
    await expect(
      withProjectLock(A, '公開', async () => { throw new Error(`fetch failed: Bearer ${TOKEN}`) }, { ...META, secrets: [TOKEN] }),
    ).rejects.toThrow('fetch failed')
    expect(JSON.stringify(getOps(A))).not.toContain(TOKEN)
  })

  it('★ 許可した項目だけを extra に写す。秘密の入れ物（レジストリの認証・鍵のID・secret 系の名前）は写さない', () => {
    const res = summarizeResult({
      ok: true,
      stage: 'done',
      projectId: 'prj_1',
      registryAuth: { server: 'r.example', username: 'u', password: 'PASSWORD-VALUE-1' },
      storagePermissionId: 'perm-1',
      secretKey: 'S3CRET-VALUE-2',
      remaining: { applicationID: 'app-1', apiToken: 'TOKEN-VALUE-3' },
      verify: { outcome: 'ok', accessKey: 'AKIA-VALUE-4' },
    })
    expect(res.extra).toEqual({ stage: 'done', projectId: 'prj_1', remaining: { applicationID: 'app-1' }, verify: { outcome: 'ok' } })
    const json = JSON.stringify(res)
    for (const leaked of ['PASSWORD-VALUE-1', 'perm-1', 'S3CRET-VALUE-2', 'TOKEN-VALUE-3', 'AKIA-VALUE-4']) {
      expect(json, leaked).not.toContain(leaked)
    }
  })

  it('形で分かる秘密（Bearer・ghp_・URL の資格情報）は、渡していなくても伏せる', () => {
    const t = scrub('Authorization: Bearer abcdefghijklmnop1234 と https://user:pw12345678@example.test/x と ghp_abcdefghijklmnopqrst')
    expect(t).not.toContain('abcdefghijklmnop1234')
    expect(t).not.toContain('pw12345678')
    expect(t).not.toContain('ghp_abcdefghijklmnopqrst')
  })

  it('短すぎる秘密（5文字以下）では全置換しない（文がめちゃくちゃにならない）', async () => {
    await withProjectLock(A, '公開', async () => ({ ok: true, message: 'abc の公開に成功しました' }), { ...META, secrets: ['abc'] })
    expect(getOps(A).last!.result!.message).toBe('abc の公開に成功しました')
  })
})

describe('結果の写し（summarizeResult）: 返り値がすでに持っている事実だけを、画面の言葉にする', () => {
  it('warnings・notice はそのまま警告。executed の ⚠️・※ で始まる行は警告へ、ほかは lines に', () => {
    const r = summarizeResult({
      ok: true,
      executed: ['✅ アプリを作りました', '※ レジストリの記録が無いため削除していません（月額220円が続きます）', '⚠️ 古い鍵を消せませんでした'],
      warnings: ['起動を確認できていません'],
      notice: '保存場所を用意していないため、データは残りません',
      verifyNote: '⚠️ まだ古い内容が表示されています',
    })
    expect(r.lines).toEqual(['✅ アプリを作りました'])
    expect(r.warnings).toEqual([
      '※ レジストリの記録が無いため削除していません（月額220円が続きます）',
      '⚠️ 古い鍵を消せませんでした',
      '⚠️ まだ古い内容が表示されています',
      '起動を確認できていません',
      '保存場所を用意していないため、データは残りません',
    ])
  })

  it('★ 共用型の破棄: 残った保存場所・選んで残したレジストリは、月額が続くと警告する（既存の remainingCostWarning と同じ文）', () => {
    const bucket = summarizeResult({ ok: true, keptBucketName: 'koto-data-x' })
    expect(bucket.warnings).toHaveLength(1)
    expect(bucket.warnings[0]).toContain('データの保存場所『koto-data-x』')
    expect(bucket.warnings[0]).toContain('月額')
    const registry = summarizeResult({ ok: true, keptRegistryName: 'myreg' })
    expect(registry.warnings[0]).toContain('コンテナレジストリ『myreg』')
    const both = summarizeResult({ ok: true, keptBucketName: 'b1', keptRegistryName: 'myreg' })
    expect(both.warnings[0]).toContain('コンテナレジストリ『myreg』')
    expect(both.warnings[0]).toContain('『b1』')
    // 何も残らなければ警告しない
    expect(summarizeResult({ ok: true, keptBucketName: null }).warnings).toEqual([])
    // 記録に名前が無いレジストリ（残す選択）は、断定せず、確認画面と同じ文で言う。成否によらない
    const unnamed = summarizeResult({ ok: false, keptRegistryUnnamed: true })
    expect(unnamed.warnings).toEqual(teardownRemainingWarnings({ keptRegistryUnnamed: true }))
    expect(unnamed.warnings).toHaveLength(1)
    expect(summarizeResult({ ok: false, keptRegistryName: 'myreg' }).warnings).toEqual([remainingCostWarning({ deleteRegistry: false, registryName: 'myreg' })!])
    expect(unnamed.extra).toMatchObject({ keptRegistryUnnamed: true })
    expect(summarizeResult({ ok: true, keptRegistryUnnamed: false }).warnings).toEqual([])
  })

  it('専有型の破棄: 消せずに残ったものは「課金が続く」と名指しする。待ち切れなかっただけのときは別の文', () => {
    const remaining = summarizeResult({
      ok: false, message: '削除できませんでした',
      remaining: { applicationID: 'app-1', loadBalancerID: 'lb-1', asgID: 'asg-1', clusterID: 'cl-1', storageBucket: 'koto-data-x' },
    })
    expect(remaining.warnings).toHaveLength(1)
    const w = remaining.warnings[0]
    expect(w).toContain('課金が続きます')
    // 削除する順（アプリ→ロードバランサ→ASG→クラスタ→保存場所）
    expect(w.indexOf('アプリケーション『app-1』')).toBeLessThan(w.indexOf('ロードバランサ『lb-1』'))
    expect(w.indexOf('ロードバランサ『lb-1』')).toBeLessThan(w.indexOf('オートスケーリンググループ『asg-1』'))
    expect(w.indexOf('オートスケーリンググループ『asg-1』')).toBeLessThan(w.indexOf('クラスタ『cl-1』'))
    expect(w.indexOf('クラスタ『cl-1』')).toBeLessThan(w.indexOf('保存場所『koto-data-x』'))

    const waiting = summarizeResult({ ok: false, inProgress: { loadBalancerID: 'lb-1' }, remaining: { loadBalancerID: 'lb-1' } })
    expect(waiting.warnings).toHaveLength(1)
    expect(waiting.warnings[0]).toContain('待ち切れず')
    expect(waiting.warnings[0]).not.toContain('課金が続きます')
    // 全部消せたときは何も言わない
    expect(summarizeResult({ ok: true, remaining: {} }).warnings).toEqual([])
  })

  it('★ HANAMII: 公開の依頼は受け付けたが新しい版が起動に失敗（deployState:error）は、うまくいっていないとして記録する', () => {
    const r = summarizeResult({ ok: true, deployState: 'error', message: 'HANAMII が新しい版を起動できませんでした', projectId: 'p1' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('起動できませんでした')
    // pending・unknown は「依頼は通った」まま（ただし警告は返り値の warnings が運ぶ）
    expect(summarizeResult({ ok: true, deployState: 'pending', warnings: ['まだ動いていません'] })).toMatchObject({ ok: true, warnings: ['まだ動いていません'] })
    expect(summarizeResult({ ok: true, deployState: 'ready', url: 'https://x.test' })).toMatchObject({ ok: true, url: 'https://x.test' })
  })

  it('形が違う返り値（null・文字列・配列）でも落ちない', () => {
    for (const v of [null, undefined, 'ok', 42, [1, 2]]) {
      const r = summarizeResult(v)
      expect(r.ok).toBe(false)
      expect(r.warnings).toEqual([])
    }
  })

  it('同じ警告は1回だけ', () => {
    const r = summarizeResult({ ok: true, warnings: ['同じ文', '同じ文'], executed: ['⚠️ 別の文', '⚠️ 別の文'] })
    expect(r.warnings).toEqual(['⚠️ 別の文', '同じ文'])
  })
})

describe('鍵と記録は同じもの（2か所で持たない）', () => {
  it('runningOp は走っている記録の操作名を返す。走っていなければ undefined', async () => {
    const g = gate({ ok: true })
    expect(runningOp(A)).toBeUndefined()
    const p = withProjectLock(A, '作成', g.wait, META)
    expect(runningOp(A)).toBe('作成')
    expect(getOps(A).running?.op).toBe('作成')
    g.open(); await p
    expect(runningOp(A)).toBeUndefined()
    expect(getOps(A).running).toBeNull()
  })

  it('get が返す写しを書き換えても、保管された記録は変わらない', async () => {
    const g = gate({ ok: true })
    const p = withProjectLock(A, '公開', g.wait, META)
    const snap = getOps(A)
    snap.running!.progress.label = '書き換えた'
    snap.running!.op = '削除'
    expect(getOps(A).running!.progress.label).not.toBe('書き換えた')
    expect(getOps(A).running!.op).toBe('公開')
    g.open(); await p
  })

  it('vi の fake timers でも壊れない（時刻は Date.now のみ）', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-29T10:00:00Z'))
      await withProjectLock(A, '公開', async () => ({ ok: true }), META)
      expect(getOps(A).last!.startedAt).toBeGreaterThanOrEqual(new Date('2026-09-29T10:00:00Z').getTime())
    } finally {
      vi.useRealTimers()
    }
  })
})
