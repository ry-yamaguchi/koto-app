import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ── なぜこのテストが要るか（2026-09-29・作者の問い「公開のダイアログを閉じると止まりますか」の調査で判明）──
//
// main は公開の開始時に publish.pending を書き、終了時（finally）に消す。ところが公開ダイアログは
// 「5秒以上前の pending」をすべて「前回、公開が完了前に中断された可能性があります」と出していた
// （detectInterruptedPublish）。**公開が走っている最中に閉じて開き直すと、中断していないのに**この警告が出た。
//
// 直し方: 「いま走っているか」を知っている main の鍵（projectLock.ts）を画面が聞き（`publishMeta:runningOp`）、
// **3通り**に出し分ける:
//   ・pending があり、いま走っている       → 「公開が進んでいます」（閉じても最後まで進みます）
//   ・pending があり、走っていない         → 従来どおり「中断された可能性があります」
//   ・pending が無い                       → 何も出さない
// 出し分けの判断は純関数 judgePendingPublish（publishStatus.ts）。ここは
// ①純関数の3通り ②本物の main の鍵（withProjectLock）＋本物の記録ファイルを通した3通り
// ③聞く順序（走っているかを先に聞く）を固定する。

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => { h.handlers.set(channel, fn) } },
}))

import { registerPublishMetaHandlers } from '../src/main/ipc/publishMeta'
import { markPendingFs } from '../src/main/publishMetaFs'
import { withProjectLock } from '../src/main/projectLock'
import {
  judgePendingPublish, pendingPublishMessage, detectInterruptedPublish, PUBLISH_TARGET_LABEL,
  type PublishMeta,
} from '../src/renderer/publishStatus'
import { loadPublishSnapshot, readRunningOp, mergeProjectMetaThenLoad, forgetPublishTargetThenLoad } from '../src/renderer/projectMeta'

registerPublishMetaHandlers()

const NOW = new Date('2026-09-29T12:00:00.000Z').getTime()
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const OLD = ago(60_000)   // 1分前に始まった公開（5秒のしきい値より古い）

describe('judgePendingPublish: 3通りの出し分け（純関数）', () => {
  it('★ pending があり、いま公開が走っている → running（中断ではない）', () => {
    const meta: PublishMeta = { pending: { target: 'hanamii', startedAt: OLD } }
    expect(judgePendingPublish(meta, '公開', NOW)).toEqual({ kind: 'running', pending: meta.pending })
  })

  it('★ pending があり、走っていない → interrupted（従来どおり「中断された可能性」）', () => {
    const meta: PublishMeta = { pending: { target: 'vercel', startedAt: OLD } }
    expect(judgePendingPublish(meta, null, NOW)).toEqual({ kind: 'interrupted', pending: meta.pending })
    expect(judgePendingPublish(meta, undefined, NOW).kind).toBe('interrupted')
  })

  it('★ pending が無い → none（走っていても、走っていなくても）', () => {
    expect(judgePendingPublish({}, null, NOW)).toEqual({ kind: 'none' })
    expect(judgePendingPublish({}, '公開', NOW)).toEqual({ kind: 'none' })
    expect(judgePendingPublish({ pending: null }, '公開', NOW)).toEqual({ kind: 'none' })
    expect(judgePendingPublish(undefined, null, NOW)).toEqual({ kind: 'none' })
  })

  it('★★ 直す前の誤り: 走っているのに、古い pending が「中断」と判定されていた（これが直った）', () => {
    const meta: PublishMeta = { pending: { target: 'sakura-apprun', startedAt: OLD } }
    // 直す前の判定（detectInterruptedPublish 単独）は、走っていても中断とする——ここが誤表示の原因
    expect(detectInterruptedPublish(meta, NOW)).not.toBeNull()
    // 走っているなら、中断とは言わない
    expect(judgePendingPublish(meta, '公開', NOW).kind).toBe('running')
  })

  it('走っているのが「公開」でないとき（作成・削除）は、pending は前の公開の名残＝中断の可能性のまま', () => {
    const meta: PublishMeta = { pending: { target: 'hanamii', startedAt: OLD } }
    expect(judgePendingPublish(meta, '削除', NOW).kind).toBe('interrupted')
    expect(judgePendingPublish(meta, '作成', NOW).kind).toBe('interrupted')
  })

  it('走っていなくて、pending がごく直近（5秒以内）なら何も出さない（開いた瞬間に始まった公開を誤検知しない）', () => {
    const meta: PublishMeta = { pending: { target: 'hanamii', startedAt: ago(2_000) } }
    expect(judgePendingPublish(meta, null, NOW).kind).toBe('none')
  })

  it('走っているなら、開始時刻が読めなくても running（走っている事実のほうが確か）', () => {
    const meta: PublishMeta = { pending: { target: 'hanamii', startedAt: 'not-a-date' } }
    expect(judgePendingPublish(meta, '公開', NOW).kind).toBe('running')
    // 走っていないなら、読めない pending は従来どおり出さない
    expect(judgePendingPublish(meta, null, NOW).kind).toBe('none')
  })

  it('公開先が既知でない pending は none（壊れた記録を画面に出さない）', () => {
    const meta = { pending: { target: 'not-a-real-target', startedAt: OLD } } as unknown as PublishMeta
    expect(judgePendingPublish(meta, '公開', NOW).kind).toBe('none')
    expect(judgePendingPublish(meta, null, NOW).kind).toBe('none')
  })
})

describe('pendingPublishMessage: 画面に出す1文（素のテキスト・掟5）', () => {
  it('★ running: 「公開が進んでいます」。閉じても進むことと、Koto を終了すると止まることを言う。「中断」とは言わない', () => {
    const msg = pendingPublishMessage({ kind: 'running', pending: { target: 'hanamii', startedAt: OLD } })!
    expect(msg).toContain(PUBLISH_TARGET_LABEL.hanamii)
    expect(msg).toContain('への公開が進んでいます')
    expect(msg).toContain('この画面を閉じても、公開は最後まで進みます')
    expect(msg).toContain('Koto を終了すると途中で止まります')
    expect(msg).not.toContain('中断')
  })

  it('★ running: 「公開状況に出る」のは成功したときだけ（失敗すると記録は書かれない）。「終わると出ます」と言い切らない', () => {
    const msg = pendingPublishMessage({ kind: 'running', pending: { target: 'vercel', startedAt: OLD } })!
    expect(msg).toContain('公開に成功すると、公開状況に記録されます')
    expect(msg).toContain('失敗したときは記録されません')
    expect(msg).not.toContain('終わると')
  })

  it('★ interrupted: 従来どおり「中断された可能性があります」。確認の導線（公開状況・管理画面）を言う', () => {
    const msg = pendingPublishMessage({ kind: 'interrupted', pending: { target: 'sakura-apprun-dedicated', startedAt: OLD } })!
    expect(msg).toContain(PUBLISH_TARGET_LABEL['sakura-apprun-dedicated'])
    expect(msg).toContain('への公開が完了前に中断された可能性があります')
    expect(msg).toContain('公開状況や公開先の管理画面でご確認ください')
    expect(msg).not.toContain('進んでいます')
  })

  it('none: 何も出さない（null）', () => {
    expect(pendingPublishMessage({ kind: 'none' })).toBeNull()
  })

  it('掟5・掟8: Markdown 記法を使わず、「Claude Code」という製品名を出さない', () => {
    for (const kind of ['running', 'interrupted'] as const) {
      const msg = pendingPublishMessage({ kind, pending: { target: 'vercel', startedAt: OLD } })!
      expect(msg).not.toMatch(/\*\*|`|^#|\n#/)
      expect(msg).not.toContain('Claude Code')
    }
  })
})

// ── 本物の main の鍵と、本物の記録ファイルを通した3通り ──────────────────────────────
describe('★★★ 本物の鍵（withProjectLock）と記録ファイルを通した出し分け', () => {
  let projectDir = ''
  const metaPath = () => path.join(projectDir, '.sakuraide.json')
  const writeMeta = (m: unknown) => fs.writeFileSync(metaPath(), JSON.stringify(m, null, 2), 'utf-8')

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-pendingview-'))
    // 偽の preload。runningOp は**本物の IPC ハンドラ**（本物の鍵を見る）、読み込みは本物のファイル。
    ;(globalThis as any).window = {
      electronAPI: {
        publishMeta: { runningOp: (dir: string) => h.handlers.get('publishMeta:runningOp')!({}, dir) },
        fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8') },
      },
    }
  })
  afterEach(() => {
    delete (globalThis as any).window
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  /** 画面を開いたときと同じ手順（走っているかを聞く → 記録を読む → 判定）。 */
  async function openDialog() {
    const snap = await loadPublishSnapshot(projectDir)
    return { snap, view: judgePendingPublish(snap.meta.publish as PublishMeta | undefined, snap.runningOp, Date.now()) }
  }

  it('★ 走っている: 公開の最中に開き直す（pending あり・main の鍵が「公開」）→ 「進んでいます」。中断ではない', async () => {
    // main が公開を始めた印を、1分前に書いた
    writeMeta({ publish: { pending: { target: 'hanamii', startedAt: new Date(Date.now() - 60_000).toISOString() } } })
    await withProjectLock(projectDir, '公開', async () => {
      const { snap, view } = await openDialog()
      expect(snap.runningOp).toBe('公開')
      expect(view.kind).toBe('running')
      expect(pendingPublishMessage(view)).toContain('公開が進んでいます')
    })
  })

  it('★ 走っていない: 落ちた／閉じられた公開の名残（pending あり・鍵なし）→ 「中断された可能性」', async () => {
    writeMeta({ publish: { pending: { target: 'hanamii', startedAt: new Date(Date.now() - 60_000).toISOString() } } })
    const { snap, view } = await openDialog()
    expect(snap.runningOp).toBeNull()
    expect(view.kind).toBe('interrupted')
    expect(pendingPublishMessage(view)).toContain('中断された可能性')
  })

  it('★ pending が無い: 何も出さない', async () => {
    writeMeta({ publish: { targets: { hanamii: { publishedAt: 't', url: null } } } })
    expect((await openDialog()).view.kind).toBe('none')
    // 記録ファイルが無いプロジェクトでも落ちない
    fs.rmSync(metaPath())
    expect((await openDialog()).view.kind).toBe('none')
  })

  it('★ 実際の公開の流れ: 開始（印が付く）→ 走っている間は running → 終わる（印が消える）と none', async () => {
    let midView: string | undefined
    await withProjectLock(projectDir, '公開', async () => {
      markPendingFs(projectDir, 'vercel')
      // 印は書かれたばかり（直近）でも、走っているので running（5秒のしきい値に頼らない）
      midView = (await openDialog()).view.kind
    })
    expect(midView).toBe('running')
    // 終わっても pending が残っているなら（消し忘れ・落ちた）、直近でなければ中断の可能性になる
    writeMeta({ publish: { pending: { target: 'vercel', startedAt: new Date(Date.now() - 60_000).toISOString() } } })
    expect((await openDialog()).view.kind).toBe('interrupted')
  })
})

describe('loadPublishSnapshot: 走っているかを先に聞き、記録は後で読む（順序が要る）', () => {
  const withPending = JSON.stringify({ publish: { pending: { target: 'hanamii', startedAt: OLD } } })
  const withoutPending = JSON.stringify({ publish: {} })

  it('★★ 聞いた直後に公開が終わっても、「中断」と誤らない（記録を先に読む順序だと誤る）', async () => {
    // 時間の進み: 最初の1回の問い合わせの直後に、公開が終わる（pending が消え、鍵が外れる）。
    let finished = false
    const io = {
      runningOp: async () => { const v = finished ? null : ('公開' as const); finished = true; return v },
      readFile: async () => { const v = finished ? withoutPending : withPending; finished = true; return v },
    }
    const snap = await loadPublishSnapshot('/p/x', io)
    // 正しい順序: 「走っている」と聞き、そのあとの記録には pending が無い
    expect(snap.runningOp).toBe('公開')
    const view = judgePendingPublish(snap.meta.publish as PublishMeta | undefined, snap.runningOp, NOW)
    expect(view.kind).toBe('none')
  })

  it('問い合わせの順序そのもの: runningOp → readFile', async () => {
    const order: string[] = []
    await loadPublishSnapshot('/p/x', {
      runningOp: async () => { order.push('runningOp'); return null },
      readFile: async () => { order.push('readFile'); return '{}' },
    })
    expect(order).toEqual(['runningOp', 'readFile'])
  })

  it('記録が読めない・壊れている・オブジェクトでないときは空の記録として扱う', async () => {
    for (const raw of ['{ broken', '[]', '"x"', 'null']) {
      const snap = await loadPublishSnapshot('/p/x', { runningOp: async () => null, readFile: async () => raw })
      expect(snap.meta).toEqual({})
    }
    const snap = await loadPublishSnapshot('/p/x', { runningOp: async () => null, readFile: async () => { throw new Error('ENOENT') } })
    expect(snap.meta).toEqual({})
  })

  it('readRunningOp: 聞けなかったとき（IPC が落ちた・preload 未注入）は null（＝従来の判定に戻る）', async () => {
    ;(globalThis as any).window = { electronAPI: { publishMeta: { runningOp: async () => { throw new Error('boom') } } } }
    try {
      expect(await readRunningOp('/p/x')).toBeNull()
    } finally {
      delete (globalThis as any).window
    }
    expect(await readRunningOp('/p/x')).toBeNull()
  })
})

// ── 書いたあと・片づけたあとも、走っているかを取り直す（2026-09-29 検分の指摘）──────────────
//
// 公開ダイアログを開いたときは公開が走っていなかった（画面は runningOp=null を覚えている）。そのあと画面のなかで
// 公開を始め（main が publish.pending を書き、鍵を取る）、「← 公開先を変更」で一覧へ戻って「記録を片づける」を
// 押すと、画面は**記録だけ**を取り込んで、走っている公開自身の印（5秒より古い pending）を
// 「中断された可能性」と誤った（「確認しました」も出る。押せば main が断り、読み直して「進んでいます」に変わる）。
// 書いたあとは、走っているかも**一緒に**取り直す（mergeProjectMetaThenLoad / forgetPublishTargetThenLoad）。
describe('★★★ 書いたあと・片づけたあとも、走っているかを取り直す（画面が古い runningOp=null を覚えていても誤らない）', () => {
  let projectDir = ''
  const metaPath = () => path.join(projectDir, '.sakuraide.json')
  const oldPending = () => ({ target: 'hanamii', startedAt: new Date(Date.now() - 60_000).toISOString() })

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-pendingview-reload-'))
    // 偽の preload。runningOp・merge・forgetTarget は**本物の IPC ハンドラ**（本物の鍵・本物の記録ファイル）。
    ;(globalThis as any).window = {
      electronAPI: {
        publishMeta: {
          runningOp: (dir: string) => h.handlers.get('publishMeta:runningOp')!({}, dir),
          merge: (dir: string, patch: unknown) => h.handlers.get('publishMeta:merge')!({}, dir, patch),
          forgetTarget: (dir: string, t: string) => h.handlers.get('publishMeta:forgetTarget')!({}, dir, t),
        },
        fs: { readFile: async (p: string) => fs.readFileSync(p, 'utf-8') },
      },
    }
  })
  afterEach(() => {
    delete (globalThis as any).window
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  const viewOf = (snap: { runningOp: string | null; meta: Record<string, unknown> }) =>
    judgePendingPublish(snap.meta.publish as PublishMeta | undefined, snap.runningOp, Date.now()).kind

  it('★ 「記録を片づける」: 公開が走っている最中は running（中断とは言わない）。pending と専有型の記録は残る', async () => {
    fs.writeFileSync(metaPath(), JSON.stringify({
      publish: {
        pending: oldPending(),
        targets: { vercel: { publishedAt: 't', url: 'https://x.example' } },
        apprunDedicated: { clusterID: 'cluster-1' },
      },
    }), 'utf-8')
    await withProjectLock(projectDir, '公開', async () => {
      const snap = await forgetPublishTargetThenLoad(projectDir, 'vercel')
      expect(snap.runningOp).toBe('公開')
      expect(viewOf(snap)).toBe('running')
      const disk = JSON.parse(fs.readFileSync(metaPath(), 'utf-8'))
      expect(disk.publish.targets?.vercel).toBeUndefined()
      expect(disk.publish.pending).toBeDefined()
      expect(disk.publish.apprunDedicated).toEqual({ clusterID: 'cluster-1' })
    })
  })

  it('★ 書き込み（saveMeta）: 公開が走っている最中は running。走っていなければ、従来どおり interrupted', async () => {
    fs.writeFileSync(metaPath(), JSON.stringify({ publish: { pending: oldPending() } }), 'utf-8')
    await withProjectLock(projectDir, '公開', async () => {
      const snap = await mergeProjectMetaThenLoad(projectDir, { target: 'sakura-rental' })
      expect(snap.runningOp).toBe('公開')
      expect(viewOf(snap)).toBe('running')
      expect((snap.meta as any).target).toBe('sakura-rental')
    })
    // 鍵が外れたあと（走っていない）の pending は、従来どおり「中断の可能性」
    const after = await mergeProjectMetaThenLoad(projectDir, { target: 'sakura-rental' })
    expect(after.runningOp).toBeNull()
    expect(viewOf(after)).toBe('interrupted')
  })

  it('pending が無ければ、片づけたあとも none', async () => {
    fs.writeFileSync(metaPath(), JSON.stringify({ publish: { targets: { vercel: { publishedAt: 't', url: null } } } }), 'utf-8')
    const snap = await forgetPublishTargetThenLoad(projectDir, 'vercel')
    expect(viewOf(snap)).toBe('none')
  })

  // 画面のなかで meta を state へ入れる口は1つ（走っているかと必ず対）。記録だけを入れる口を増やさない。
  it('★ PublishModal.tsx は setMeta を applySnapshot の1か所でしか呼ばない（記録だけを取り込む口を作らない）', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/PublishModal.tsx'), 'utf-8')
    const code = src.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    const calls = code.match(/\bsetMeta\(/g) ?? []
    expect(calls).toHaveLength(1)
    expect(code).toMatch(/const applySnapshot = useCallback\(\(snap: PublishSnapshot\) => \{\s*setRunningOp\(snap\.runningOp\)\s*setMeta\(snap\.meta as Meta\)/)
    // 書いたあと・片づけたあとは、走っているかも取り直す関数を通す
    expect(code).toContain('mergeProjectMetaThenLoad(projectDir')
    expect(code).toContain('forgetPublishTargetThenLoad(projectDir')
  })
})
