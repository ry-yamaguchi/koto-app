import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runTeardownShell, twinsRefusedMessage, TWINS_UNKNOWN_MESSAGE, NOT_CONFIRMED_MESSAGE, type TeardownShellSpec } from '../src/main/cloud/teardownShell'
import { withProjectLock, runningOp } from '../src/main/projectLock'
import { getOps, resetProjectOpsForTests } from '../src/main/projectOps'
import type { PublishTargetKind } from '../src/shared/publishMeta'

// ── T-I4（骨）: 複製があれば、公開先ごとの本体（run）を呼ばず、公開の記録も消さずに断る（0.6.24 I-2・作者の決定 K1）────────────────────────
// `twinsOf` は骨の必須の項目。置く位置は、鍵（withProjectLock）の**中**・公開の記録の有無を読むより前・run より前。
// **本物の withProjectLock と一時フォルダ**に、偽の仕様書（偽の twinsOf・偽の run）を流し、呼ばれた順と回数で固定する（掟10。ソースの文字列は読まない）。
// 3つの公開先それぞれが複製を断ること（twinsOf を実際に渡していること）は tests/twinsRefusal.test.ts が、本物の IPC で固定する。

type Res = { ok: boolean; executed?: string[]; message?: string }
type Auth = { token: string }
const SECRET = 'SECRET-TOKEN-0123456789'

let dir: string
const metaPath = () => path.join(dir, '.sakuraide.json')
beforeEach(() => {
  resetProjectOpsForTests()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-shell-twins-'))
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
function harness(twinsOf: (projectDir: string) => string[], over: Partial<TeardownShellSpec<Auth, Res>> = {}) {
  const log: string[] = []
  const twinsSeenIn: string[] = []
  const lockWhenTwinsAsked: Array<string | undefined> = []
  const spec: TeardownShellSpec<Auth, Res> = {
    target: 'hanamii',
    handler: 'hanamii:teardown',
    parseAuth: a => { log.push('parseAuth'); const t = (a as { token?: unknown } | null | undefined)?.token; return typeof t === 'string' && t ? { token: t } : null },
    authMissingMessage: 'トークンが未登録です',
    secretsOf: a => [a.token],
    twinsOf: d => { log.push('twinsOf'); twinsSeenIn.push(d); lockWhenTwinsAsked.push(runningOp(d)); return twinsOf(d) },
    run: async () => { log.push('run'); return { ok: true, executed: ['✅ 消しました'] } },
    shouldForgetRecord: ({ result }) => { log.push('shouldForget'); return result.ok },
    forgetRecord: () => { log.push('forget'); return { ok: true } },
    refused: message => ({ ok: false, message }),
    ...over,
  }
  return { spec, log, twinsSeenIn, lockWhenTwinsAsked }
}
type Harness = ReturnType<typeof harness>
const shell = (h: Harness, args: Record<string, unknown> = {}) =>
  runTeardownShell(h.spec, { projectDir: dir, auth: { token: SECRET }, opts: { confirmed: true }, ...args } as { projectDir: unknown; auth: unknown; opts: unknown })

describe('★★★ T-I4 骨: 複製があれば、run を呼ばず・記録も消さずに断る', () => {
  it('★★★ twinsOf が1件返す → run 0回・shouldForget 0回・forget 0回。断りの文はフォルダ名を言い、次の一手（要らないほうを削除）を言う。記録（.sakuraide.json）はそのまま', async () => {
    writeRecordFor('hanamii')
    const before = fs.readFileSync(metaPath(), 'utf-8')
    const h = harness(() => ['myapp copy'])
    const r = await shell(h)

    expect(r).toEqual({
      ok: false,
      message: 'フォルダ『myapp copy』にも同じ公開の記録があるため、何も破棄していません。要らないほうのフォルダを削除すると、残ったほうから破棄できます。',
    })
    expect(h.log, '断った回に run・記録を消す判断が走った').toEqual(['parseAuth', 'twinsOf'])
    expect(fs.readFileSync(metaPath(), 'utf-8'), '断った回に記録が変わった').toBe(before)
  })

  it('複製が複数 → 名前を全部並べる（・で区切る）。文は twinsRefusedMessage の1つが作る', async () => {
    const h = harness(() => ['a copy', 'b copy'])
    const r = await shell(h)
    expect(r.message).toBe('フォルダ『a copy』・『b copy』にも同じ公開の記録があるため、何も破棄していません。要らないほうのフォルダを削除すると、残ったほうから破棄できます。')
    expect(r.message).toBe(twinsRefusedMessage(['a copy', 'b copy']))
  })

  it('★★★ 順序: twinsOf は鍵の中・認証の形を確かめたあと・run より前（複製がなければ、そのあと run → 規則 → 記録を消す）', async () => {
    writeRecordFor('hanamii')
    const h = harness(() => [])
    const r = await shell(h)

    expect(r.ok).toBe(true)
    expect(h.log).toEqual(['parseAuth', 'twinsOf', 'run', 'shouldForget', 'forget'])
    expect(h.twinsSeenIn).toEqual([dir])
    expect(h.lockWhenTwinsAsked, 'twinsOf は鍵の外で呼ばれた（確かめと本体のあいだに別の操作が割り込める）').toEqual(['削除'])
  })

  it('★★★ 公開の記録の有無を読むより前: twinsOf が見る時点で、記録はまだ run に触られていない（run が記録を消す偽の仕様書でも、断った回は消えない）', async () => {
    writeRecordFor('hanamii')
    const seen: boolean[] = []
    const h = harness(() => { seen.push(fs.existsSync(metaPath())); return ['myapp copy'] }, {
      run: async () => { fs.rmSync(metaPath(), { force: true }); return { ok: true } },
    })
    await shell(h)
    expect(seen).toEqual([true])
    expect(fs.existsSync(metaPath())).toBe(true)
  })

  it('★★ 断った回も鍵の中の処理として記録される（失敗の結果・公開先は仕様書のもの）。鍵は外れていて、次の呼び出しが通る', async () => {
    const h = harness(() => ['myapp copy'])
    await shell(h)
    expect(runningOp(dir)).toBeUndefined()
    const ops = getOps(dir)
    expect(ops.running).toBeNull()
    expect(ops.last?.target).toBe('hanamii')
    expect(ops.last?.handler).toBe('hanamii:teardown')
    expect(ops.last?.result?.ok).toBe(false)
    expect(ops.last?.result?.message).toContain('フォルダ『myapp copy』にも同じ公開の記録があるため')

    const next = harness(() => [])
    expect((await shell(next)).ok).toBe(true)
  })

  it('★★★ 確かめられない（twinsOf が投げた）→ 断る（安全側）。run 0回。確かめられなかったと言う', async () => {
    const h = harness(() => { throw new Error('テスト用の失敗') })
    const r = await shell(h)
    expect(r).toEqual({ ok: false, message: '同じ公開の記録を持つフォルダがあるか確かめられなかったため、何も破棄していません。' })
    expect(r.message).toBe(TWINS_UNKNOWN_MESSAGE)
    expect(h.log).toEqual(['parseAuth', 'twinsOf'])
  })
})

describe('★★ 骨の入口で断った回は、twinsOf も呼ばない（確認の印・projectDir・認証の形・鍵が埋まっている回）', () => {
  it('確認の印が無い → twinsOf 0回', async () => {
    const h = harness(() => ['myapp copy'])
    const r = await shell(h, { opts: {} })
    expect(r.message).toBe(NOT_CONFIRMED_MESSAGE)
    expect(h.log).toEqual([])
  })

  it('認証の形が違う → twinsOf 0回', async () => {
    const h = harness(() => ['myapp copy'])
    await shell(h, { auth: {} })
    expect(h.log).toEqual(['parseAuth'])
  })

  it('projectDir が不正 → twinsOf 0回', async () => {
    const h = harness(() => ['myapp copy'])
    await shell(h, { projectDir: '' })
    expect(h.log).toEqual([])
  })

  it('同じプロジェクトで別の操作が走っている → twinsOf 0回（鍵を取れない）', async () => {
    let open!: () => void
    const gate = new Promise<void>(r => { open = r })
    const held = withProjectLock(dir, '公開', () => gate, { target: 'hanamii', handler: 'test:hold' })
    const h = harness(() => ['myapp copy'])
    const r = await shell(h)
    expect(r.ok).toBe(false)
    expect(h.log).toEqual(['parseAuth'])
    open()
    await held
  })
})
