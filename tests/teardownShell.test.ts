import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  runTeardownShell, isConfirmed, NOT_CONFIRMED_MESSAGE, BAD_PROJECT_DIR_MESSAGE,
  type TeardownShellSpec, type TeardownShellCtx,
} from '../src/main/cloud/teardownShell'
import { withProjectLock, projectBusyMessage, runningOp, type ProjectOp } from '../src/main/projectLock'
import { getOps, resetProjectOpsForTests, setStageTimingSink, type StageTimingSinkEntry, type OpTarget } from '../src/main/projectOps'
import { STAGE } from '../src/shared/stageTiming'
import type { PublishTargetKind } from '../src/shared/publishMeta'
import { TEARDOWN_HANDLER_TARGET, isTeardownRecordOf } from '../src/renderer/teardown/watch'

// ── 何を固定するか（設計書 docs/teardown-unify-plan.md 10.3.2 (10)・10.3.4 の C・D）──────────────────
// 破棄の共通の骨。ソースの文字列は読まない（掟10）。**本物の withProjectLock と一時フォルダ**に、偽の run を流し、
//   C … 断るべき回（確認の印が無い・projectDir が不正・認証の形が違う・鍵が埋まっている）は、
//       run が **0回**（＝外部へ1本も出ない）で、処理の記録も増えない
//   D … 公開の記録を消すのは「run のあと・鍵の中・規則が true のときだけ」。消し損ねても run の結果は失わない
// 段階0では、どの IPC もこの骨にまだ載っていない。部品と単体テストだけ。

type Res = { ok: boolean; executed?: string[]; message?: string }
type Auth = { token: string }
const SECRET = 'SECRET-TOKEN-0123456789'
const EMPTY_OPS = { running: null, last: null, earlier: [] }

let dir: string
const metaPath = () => path.join(dir, '.sakuraide.json')
beforeEach(() => {
  resetProjectOpsForTests()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-teardown-shell-'))
})
afterEach(() => {
  resetProjectOpsForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 公開の記録（📡 の1行）がある `.sakuraide.json` を置く。 */
function writeRecordFor(target: PublishTargetKind) {
  fs.writeFileSync(metaPath(), JSON.stringify({
    publish: { targets: { [target]: { publishedAt: '2026-10-01T00:00:00.000Z', url: 'https://example.invalid/' } } },
  }))
}

/** 呼ばれた順を `log` に残す偽の仕様書。外部サービスへ出る道は `run` だけ。 */
function harness(over: Partial<TeardownShellSpec<Auth, Res>> = {}) {
  const log: string[] = []
  const ctxs: TeardownShellCtx<Auth>[] = []
  const spec: TeardownShellSpec<Auth, Res> = {
    target: 'hanamii',
    handler: 'hanamii:teardown',
    parseAuth: a => {
      log.push('parseAuth')
      const t = (a as { token?: unknown } | null | undefined)?.token
      return typeof t === 'string' && t ? { token: t } : null
    },
    authMissingMessage: 'トークンが未登録です',
    secretsOf: a => [a.token],
    run: async ctx => { log.push('run'); ctxs.push(ctx); return { ok: true, executed: ['✅ 消しました'] } },
    shouldForgetRecord: ({ result }) => { log.push('shouldForget'); return result.ok },
    forgetRecord: () => { log.push('forget'); return { ok: true } },
    refused: message => ({ ok: false, message }),
    ...over,
  }
  return { spec, log, ctxs }
}
type Harness = ReturnType<typeof harness>

function shell(h: Harness, args: Record<string, unknown> = {}) {
  return runTeardownShell(h.spec, {
    projectDir: dir, auth: { token: SECRET }, opts: { confirmed: true }, ...args,
  } as { projectDir: unknown; auth: unknown; opts: unknown; sendProgress?: (m: string) => void })
}

/** 終わらない処理で鍵を埋める（本物の withProjectLock）。release すると終わる。 */
function holdLock(op: ProjectOp, projectDir = dir, target: OpTarget = 'unknown') {
  let open!: () => void
  const gate = new Promise<void>(r => { open = r })
  const done = withProjectLock(projectDir, op, () => gate, { target, handler: 'test:hold' })
  return { release: () => { open(); return done } }
}

const NOT_CONFIRMED_OPTS: ReadonlyArray<readonly [string, unknown]> = [
  ['undefined', undefined], ['null', null], ['true（真偽値そのもの）', true], ['文字列 "true"', 'true'], ['数 1', 1],
  ['空配列', []], ['空オブジェクト', {}], ['confirmed: false', { confirmed: false }],
  ['confirmed: "true"', { confirmed: 'true' }], ['confirmed: 1', { confirmed: 1 }], ['confirmed: "yes"', { confirmed: 'yes' }],
  ['confirmed: {}', { confirmed: {} }], ['confirmed: []', { confirmed: [] }],
  ['confirmed: undefined', { confirmed: undefined }], ['confirmed: null', { confirmed: null }],
]

describe('isConfirmed: confirmed が true のときだけ true（不明値を肯定に戻さない）', () => {
  it('true のときだけ true。余計な項目があっても変わらない', () => {
    expect(isConfirmed({ confirmed: true })).toBe(true)
    expect(isConfirmed({ confirmed: true, projectId: 'p' })).toBe(true)
  })
  it.each(NOT_CONFIRMED_OPTS)('opts が %s → false', (_label, opts) => {
    expect(isConfirmed(opts)).toBe(false)
  })
})

describe('C-1 確認の印が無い: 鍵より前に断る（外部へ1本も出ない）', () => {
  it.each(NOT_CONFIRMED_OPTS)('opts が %s → run 0回・認証も見ない・処理の記録が増えない・公開の記録に触れない', async (_label, opts) => {
    writeRecordFor('hanamii')
    const before = fs.readFileSync(metaPath(), 'utf-8')
    const h = harness()
    const r = await shell(h, { opts })
    expect(r).toEqual({ ok: false, message: NOT_CONFIRMED_MESSAGE })
    expect(h.log).toEqual([]) // parseAuth・run・規則・記録消しのどれも呼ばれていない
    expect(getOps(dir)).toEqual(EMPTY_OPS)
    expect(runningOp(dir)).toBeUndefined()
    expect(fs.readFileSync(metaPath(), 'utf-8')).toBe(before)
  })

  it('確認の印が true なら、同じ呼び出しで run が1回走る（上の断りは印のせいである）', async () => {
    const h = harness()
    expect(await shell(h)).toMatchObject({ ok: true })
    expect(h.log.filter(x => x === 'run')).toEqual(['run'])
  })

  it('順序: projectDir が不正なら、確認の印が無くてもその理由で断る。確認の印が無ければ、認証が不正でも確認の理由で断る', async () => {
    const h = harness()
    expect(await shell(h, { projectDir: '', opts: undefined })).toEqual({ ok: false, message: BAD_PROJECT_DIR_MESSAGE })
    expect(await shell(h, { auth: undefined, opts: {} })).toEqual({ ok: false, message: NOT_CONFIRMED_MESSAGE })
    expect(h.log).toEqual([]) // どちらも認証を見る前
  })
})

describe('C-2 projectDir が不正: 断る', () => {
  it.each([['空文字', ''], ['undefined', undefined], ['null', null], ['数', 123], ['オブジェクト', {}], ['配列', ['/tmp']]] as const)(
    'projectDir が %s → run 0回',
    async (_label, bad) => {
      const h = harness()
      expect(await shell(h, { projectDir: bad })).toEqual({ ok: false, message: BAD_PROJECT_DIR_MESSAGE })
      expect(h.log).toEqual([])
    },
  )
})

describe('C-3 認証の形が違う: 断る', () => {
  it.each([
    ['undefined', undefined], ['null', null], ['空オブジェクト', {}], ['token が空', { token: '' }],
    ['token が数', { token: 1 }], ['文字列', 'x'], ['配列', []],
  ] as const)('認証が %s → run 0回・処理の記録が増えない', async (_label, auth) => {
    const h = harness()
    expect(await shell(h, { auth })).toEqual({ ok: false, message: 'トークンが未登録です' })
    expect(h.log).toEqual(['parseAuth'])
    expect(getOps(dir)).toEqual(EMPTY_OPS)
    expect(runningOp(dir)).toBeUndefined()
  })

  it('parseAuth が null でなく undefined を返しても断る（run は 0回）', async () => {
    const h = harness({ parseAuth: () => undefined as unknown as null })
    expect(await shell(h)).toEqual({ ok: false, message: 'トークンが未登録です' })
    expect(h.log).toEqual([])
  })

  it('run に渡る認証は parseAuth が返した形（呼び出し側が渡した生の値ではない）', async () => {
    const h = harness()
    await shell(h, { auth: { token: SECRET, extra: '余計な項目' } })
    expect(h.ctxs[0].auth).toEqual({ token: SECRET })
  })
})

describe('C-4 鍵が埋まっている: 外へ1本も出さずに断る', () => {
  it.each(['公開', '作成', '削除'] as const)('同じプロジェクトで「%s」が走っている間 → run 0回・busy の文・走っている処理を止めない', async op => {
    const holder = holdLock(op)
    const h = harness()
    const r = await shell(h)
    expect(r).toEqual({ ok: false, message: projectBusyMessage(op, 'unknown') })
    expect(h.log).toEqual(['parseAuth']) // 認証は見たが、run も記録消しも呼ばれていない
    // 断った側が、走っている側の鍵と記録を外していない
    expect(runningOp(dir)).toBe(op)
    expect(getOps(dir).running?.op).toBe(op)
    await holder.release()
    expect(getOps(dir).last?.op).toBe(op)
    expect(getOps(dir).earlier).toEqual([]) // 断った回の記録は無い（1件だけ）
    expect(getOps(dir).running).toBeNull()
  })

  // 断る文の言葉は、走っている側の op と公開先で決まる（共用型・HANAMII の破棄は「破棄」、専有型の削除は「削除」。記録の op はどれも '削除'）。
  it.each([
    ['削除', 'sakura-apprun', '破棄'], ['削除', 'hanamii', '破棄'], ['削除', 'sakura-apprun-dedicated', '削除'],
    ['公開', 'hanamii', '公開'], ['作成', 'sakura-apprun-dedicated', '作成'],
  ] as const)('★★ 「%s」（%s）が走っている間 → 骨は「（%s）」で断る', async (op, target, word) => {
    const holder = holdLock(op, dir, target)
    const h = harness()
    const r = await shell(h)
    expect(r).toEqual({ ok: false, message: `いま別の操作（${word}）を実行中です。終わってからもう一度お試しください。` })
    expect(h.log).toEqual(['parseAuth'])
    await holder.release()
  })

  it('別のプロジェクトの鍵は関係しない（そちらが走っていても run は1回走る）', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-teardown-shell-other-'))
    try {
      const holder = holdLock('公開', other)
      const h = harness()
      expect(await shell(h)).toMatchObject({ ok: true })
      expect(h.log.filter(x => x === 'run')).toHaveLength(1)
      await holder.release()
    } finally { fs.rmSync(other, { recursive: true, force: true }) }
  })

  it('run は鍵の中で走る（走っている間は「削除」が記録され、公開先・IPC 名が残る）。終われば鍵が外れる', async () => {
    let during: { op?: string; target?: string; handler?: string; lock?: string } = {}
    const h = harness({
      run: async () => {
        const running = getOps(dir).running
        during = { op: running?.op, target: running?.target, handler: running?.handler, lock: runningOp(dir) }
        return { ok: true }
      },
    })
    await shell(h)
    expect(during).toEqual({ op: '削除', target: 'hanamii', handler: 'hanamii:teardown', lock: '削除' })
    expect(runningOp(dir)).toBeUndefined()
    expect(getOps(dir).last).toMatchObject({ op: '削除', target: 'hanamii', handler: 'hanamii:teardown', running: false })
  })
})

describe('C-5 秘密は記録の文から伏せられる', () => {
  it('進み具合・結果・失敗の文にある秘密が、処理の記録に残らない（secretsOf を鍵に渡している）', async () => {
    const h = harness({
      run: async ctx => {
        ctx.progress(`${SECRET} で呼んでいます…`)
        expect(JSON.stringify(getOps(dir).running)).not.toContain(SECRET)
        return { ok: false, message: `失敗: ${SECRET}`, executed: [`✅ ${SECRET}`] }
      },
    })
    await shell(h)
    const rec = JSON.stringify(getOps(dir))
    expect(rec).not.toContain(SECRET)
    expect(rec).toContain('***')
  })

  it('run が秘密を含む例外を投げても、記録に残らない。例外は呼び出し側へ投げ直される', async () => {
    const h = harness({ run: async () => { throw new Error(`HTTP 500 (${SECRET})`) } })
    await expect(shell(h)).rejects.toThrow('HTTP 500')
    expect(JSON.stringify(getOps(dir))).not.toContain(SECRET)
    expect(getOps(dir).last?.result?.ok).toBe(false)
  })
})

describe('run に渡るもの（進み具合・段・ゾーン・追加の引数）', () => {
  it('opts からは confirmed を除いた、公開先ごとの追加だけが渡る', async () => {
    const h = harness()
    await shell(h, { opts: { confirmed: true, projectId: 'p-1', deleteRegistry: false } })
    expect(h.ctxs[0].opts).toEqual({ projectId: 'p-1', deleteRegistry: false })
    expect(h.ctxs[0].projectDir).toBe(dir)
  })

  it('progress は処理の記録を更新し、sendProgress へも同じ文を送る。sendProgress が投げても破棄は止まらない', async () => {
    const sent: string[] = []
    let label = ''
    const h = harness({ run: async ctx => { ctx.progress('進み具合 1'); label = getOps(dir).running?.progress.label ?? ''; return { ok: true } } })
    await shell(h, { sendProgress: (m: string) => { sent.push(m) } })
    expect(sent).toEqual(['進み具合 1'])
    expect(label).toBe('進み具合 1')
    const h2 = harness({ run: async ctx => { ctx.progress('進み具合 2'); return { ok: true } } })
    expect(await shell(h2, { sendProgress: () => { throw new Error('窓が閉じています') } })).toMatchObject({ ok: true })
  })

  it('段を渡した回だけ stageTimings が付く。記録の extra.stageTimings と同じ値（その場と開き直しの双子）', async () => {
    const h = harness({ run: async ctx => { ctx.onStage(STAGE.teardownApp); ctx.onStage(STAGE.teardownLb); return { ok: true } } })
    const r = await shell(h)
    expect(r.stageTimings?.stages.map(s => s.stage)).toEqual(['teardown.app', 'teardown.lb'])
    expect(getOps(dir).last?.result?.extra.stageTimings).toEqual(r.stageTimings)
    const plain = await shell(harness())
    expect('stageTimings' in plain).toBe(false)
  })

  it('zoneOf のゾーンは段の時間の保存に添えられる。zoneOf が投げても破棄は止まらない', async () => {
    const saved: StageTimingSinkEntry[] = []
    setStageTimingSink(e => { saved.push(e) })
    const asked: string[] = []
    const run = async (ctx: TeardownShellCtx<Auth>) => { ctx.onStage(STAGE.teardownApp); return { ok: true } }
    await shell(harness({ run, zoneOf: p => { asked.push(p); return 'is1a' } }))
    expect(asked).toEqual([dir])
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ op: '削除', target: 'hanamii', handler: 'hanamii:teardown', zone: 'is1a' })
    const h2 = harness({ run, zoneOf: () => { throw new Error('記録を読めません') } })
    expect(await shell(h2)).toMatchObject({ ok: true })
  })
})

describe('D 公開の記録の消し方（run のあと・鍵の中・規則が true のときだけ）', () => {
  it('D-1 規則が true → forgetRecord が1回。順序は 規則 → run の後の forgetRecord。鍵の中で走る。ctx と結果を受け取る', async () => {
    const seen: { lock?: string; ctx?: TeardownShellCtx<Auth>; result?: Res } = {}
    const h = harness()
    h.spec.forgetRecord = (ctx, result) => { h.log.push('forget'); seen.lock = runningOp(dir); seen.ctx = ctx; seen.result = result; return { ok: true } }
    const r = await shell(h)
    expect(h.log).toEqual(['parseAuth', 'run', 'shouldForget', 'forget'])
    expect(seen.lock).toBe('削除')
    expect(seen.ctx).toBe(h.ctxs[0])
    expect(seen.result).toEqual({ ok: true, executed: ['✅ 消しました'] })
    expect(r).toEqual({ ok: true, executed: ['✅ 消しました'] }) // 消せたなら結果は変わらない
  })

  it('D-2 run が ok:false（規則が false）→ forgetRecord 0回。結果はそのまま', async () => {
    const h = harness()
    h.spec.run = async () => { h.log.push('run'); return { ok: false, message: '消せませんでした' } }
    expect(await shell(h)).toEqual({ ok: false, message: '消せませんでした' })
    expect(h.log).toEqual(['parseAuth', 'run', 'shouldForget'])
  })

  it('規則が false を返せば、run が ok:true でも消さない。true 以外の値（1・"yes"）は「消す」と読まない', async () => {
    for (const verdict of [false, 1, 'yes', {}, undefined, null]) {
      const h = harness()
      h.spec.shouldForgetRecord = () => { h.log.push('shouldForget'); return verdict as boolean }
      await shell(h)
      expect(h.log, String(verdict)).not.toContain('forget')
    }
  })

  it('D-3 run が例外 → forgetRecord 0回。例外は投げ直され、鍵は外れていて、次の呼び出しが通る', async () => {
    let first = true
    const h = harness()
    h.spec.run = async () => { h.log.push('run'); if (first) { first = false; throw new Error('HTTP 500') } return { ok: true } }
    await expect(shell(h)).rejects.toThrow('HTTP 500')
    expect(h.log).not.toContain('forget')
    expect(h.log).not.toContain('shouldForget')
    expect(runningOp(dir)).toBeUndefined()
    expect(await shell(h)).toMatchObject({ ok: true }) // 二度と押せない、にならない
    expect(h.log.filter(x => x === 'forget')).toHaveLength(1)
  })

  it('D-4 forgetRecord が失敗 → ok は変わらず、executed に ⚠️ の1行（元の行は残る）。記録では警告になる', async () => {
    const h = harness({ forgetRecord: () => ({ ok: false, message: 'ディスクがいっぱいです' }) })
    const r = await shell(h)
    expect(r.ok).toBe(true)
    expect(r.executed).toHaveLength(2)
    expect(r.executed?.[0]).toBe('✅ 消しました')
    expect(r.executed?.[1]).toMatch(/^⚠️ 公開の記録を削除できませんでした/)
    expect(r.executed?.[1]).toContain('ディスクがいっぱいです')
    const rec = getOps(dir).last?.result
    expect(rec?.ok).toBe(true)
    expect(rec?.warnings.some(w => w.includes('公開の記録を削除できませんでした'))).toBe(true)
  })

  it('★★ D-4b forgetRecord が型どおりでない値（undefined・null・{}・ok が true でない・message が無い／空／文字列でない失敗）を返しても、成功とは読まない: ⚠️ の1行を足し、理由が分からないときの一言を使う', async () => {
    // 記録の消し損ねは「📡 の行が残って月額が続く」に直結する。ok が true と確かめられたときだけ成功と読む。
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['undefined', undefined], ['null', null], ['空オブジェクト', {}],
      ['ok:false で message が無い', { ok: false }], ['ok:false で message が空', { ok: false, message: '' }],
      ['ok:false で message が数', { ok: false, message: 1 }],
      ['ok が文字列 "true"', { ok: 'true' }], ['ok が数 1', { ok: 1 }],
    ]
    for (const [label, forgot] of cases) {
      const h = harness({ forgetRecord: () => forgot as { ok: true } })
      const r = await shell(h)
      expect(r.ok, label).toBe(true) // run の結果は変えない
      expect(r.executed, label).toHaveLength(2)
      expect(r.executed?.[0], label).toBe('✅ 消しました')
      expect(r.executed?.[1], label).toMatch(/^⚠️ 公開の記録を削除できませんでした/)
      expect(r.executed?.[1], label).toContain('理由は分かりませんでした')
      expect(getOps(dir).last?.result?.warnings.some(w => w.includes('公開の記録を削除できませんでした')), label).toBe(true)
      expect(runningOp(dir), label).toBeUndefined()
      resetProjectOpsForTests()
    }
    // 成功（ok:true）だけは、足さない。
    const okShell = await shell(harness({ forgetRecord: () => ({ ok: true }) }))
    expect(okShell.executed).toEqual(['✅ 消しました'])
  })

  it('forgetRecord が投げても、規則が投げても、run の結果は失われない（外部のものはもう消えている）。executed が無い結果にも足せる', async () => {
    const throwing = harness({ forgetRecord: () => { throw new Error('書き込めません') }, run: async () => ({ ok: true }) })
    const r = await shell(throwing)
    expect(r.ok).toBe(true)
    expect(r.executed).toHaveLength(1)
    expect(r.executed?.[0]).toContain('書き込めません')
    const rule = harness({ shouldForgetRecord: () => { throw new Error('規則が壊れています') } })
    const r2 = await shell(rule)
    expect(r2.ok).toBe(true)
    expect(r2.executed?.[0]).toBe('✅ 消しました')
    expect(r2.executed?.[1]).toContain('規則が壊れています')
    expect(runningOp(dir)).toBeUndefined()
  })

  it('D-5 hadPublishRecord は run の前に読んだ値（run の中で記録が消えても true のまま渡る）', async () => {
    writeRecordFor('hanamii')
    const seen: boolean[] = []
    const h = harness({
      run: async () => { fs.rmSync(metaPath()); return { ok: true } },
      shouldForgetRecord: s => { seen.push(s.hadPublishRecord); return true },
    })
    await shell(h)
    expect(seen).toEqual([true])
  })

  it('逆向き: run の前に記録が無く、run の中で作られても false のまま。ほかの公開先の記録では true にならない', async () => {
    const seen: boolean[] = []
    const rule = (s: { hadPublishRecord: boolean }) => { seen.push(s.hadPublishRecord); return false }
    await shell(harness({ run: async () => { writeRecordFor('hanamii'); return { ok: true } }, shouldForgetRecord: rule }))
    fs.rmSync(metaPath())
    writeRecordFor('sakura-apprun-dedicated')
    await shell(harness({ shouldForgetRecord: rule }))
    writeRecordFor('hanamii')
    await shell(harness({ shouldForgetRecord: rule }))
    expect(seen).toEqual([false, false, true])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// E 公開先ごとの引き回し（hanamii 以外の仕様書でも、記録の有無と処理の記録がその公開先のものになる）
// ═══════════════════════════════════════════════════════════════════════════════
//
// ここまでの仕様書は target が 'hanamii' だけ。骨が target・handler を 'hanamii' に固定する回帰は、上の試験では落ちない。
// 段階2・3で共用型・専有型を載せたとき、記録を消すかを決める hadPublishRecord（専有型は shouldForgetPublishRecord が、
// 「破棄の前に行があったか」で決める）と、処理の記録の target・handler の組（画面が自分の破棄を見分ける表 TEARDOWN_HANDLER_TARGET）に効く。

describe('E 公開先ごとの引き回し: 骨は、仕様書の target と handler を、記録の有無と処理の記録にそのまま使う', () => {
  // 破棄の IPC と公開先の組（書き下し。画面が見分ける表 TEARDOWN_HANDLER_TARGET と一致することも下で確かめる）
  const PAIRS = [
    ['sakura-apprun', 'cloud:teardown'],
    ['hanamii', 'hanamii:teardown'],
    ['sakura-apprun-dedicated', 'apprunDedicated:teardown'],
  ] as const

  it('書き下した組は、画面が破棄の記録を見分ける表（TEARDOWN_HANDLER_TARGET）と同じ', () => {
    expect(Object.fromEntries(PAIRS.map(([target, handler]) => [handler, target]))).toEqual({ ...TEARDOWN_HANDLER_TARGET })
  })

  it.each(PAIRS)('★★★ %s（%s）の仕様書: その公開先の記録があれば hadPublishRecord は true、ほかの公開先の記録だけ・記録なしなら false', async (target, handler) => {
    const seen: boolean[] = []
    const h = harness({ target, handler, shouldForgetRecord: s => { seen.push(s.hadPublishRecord); return false } })
    writeRecordFor(target)
    await shell(h)
    fs.rmSync(metaPath())
    for (const other of PAIRS.map(p => p[0]).filter(t => t !== target)) {
      writeRecordFor(other)
      await shell(h)
      fs.rmSync(metaPath())
    }
    await shell(h) // 記録なし
    expect(seen).toEqual([true, false, false, false])
  })

  it.each(PAIRS)('★★★ %s（%s）の仕様書: 走っている間も終わったあとも、処理の記録の target・handler は仕様書のもの。画面が自分の破棄と見分けられる（ほかの組では見分けられない）', async (target, handler) => {
    let during: { target?: string; handler?: string } = {}
    const h = harness({
      target, handler,
      run: async () => { const running = getOps(dir).running; during = { target: running?.target, handler: running?.handler }; return { ok: true } },
    })
    await shell(h)
    expect(during).toEqual({ target, handler })
    const last = getOps(dir).last!
    expect({ target: last.target, handler: last.handler }).toEqual({ target, handler })
    expect(isTeardownRecordOf(target, last)).toBe(true)
    for (const [otherTarget] of PAIRS.filter(p => p[0] !== target)) expect(isTeardownRecordOf(otherTarget, last)).toBe(false)
  })
})
