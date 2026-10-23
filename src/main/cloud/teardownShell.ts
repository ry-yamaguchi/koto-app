// teardownShell.ts — 破棄の IPC の共通の骨（main。electron に依存しない）。
//
// ── 何のためにあるか ──────────────────────────────────────────────────────────
// 破棄の IPC は公開先ごと（共用型 cloud:teardown・HANAMII hanamii:teardown・専有型 apprunDedicated:teardown）に
// 3つあり、それぞれが「確認の印を見る → 鍵を取る → 本体を走らせる → 公開の記録を消す」を自分で書いていた。
// 順序の書き間違い（確認の前に外へ出す・記録を先に消す）は、お金と持ち物に直接効く。そこで順序をここ1か所に置き、
// 公開先ごとの本体（run）だけを差し込む形にする（設計書 docs/teardown-unify-plan.md 3.2・10.3.2 (10)）。
//
// ── 順序（0.6.22 段階3B-1 より前の専有型の削除とは、確認の印の位置が違う）────────────────
//   1. projectDir が空でない文字列でなければ断る
//   2. opts.confirmed が true でなければ断る（**鍵より前**。処理の記録も作らない）
//        以前の専有型は鍵を取ってから teardownFlow の中で断っていたため、確認の印が無い呼び出しでも「削除」の記録が1件できた
//   3. 認証の形が違えば断る
//   4. withProjectLock（同じプロジェクトで作成・削除・公開を同時に走らせない）。断られたら外へ1本も出さない
//   5. 鍵の中で: 公開の記録の有無を**先に**読む → run → 規則が true のときだけ記録を消す
//   6. 段ごとの所要時間を足して返す
// 外部サービスへ要求を出してよいのは run の中だけ。1〜4 で断った回は、run を呼ばない。
//
// ── 載っている IPC ───────────────────────────────────────────────────────────
// HANAMII（hanamii:teardown・段階1）・共用型（cloud:teardown・段階2）・専有型（apprunDedicated:teardown・段階3B-1）の3つが載っている。
// 本物の画面・本物のさくらのクラウドからは、まだ一度も通っていない（0.6.22-rc.1 の実機で確かめる）。

import { withProjectLock, projectBusyMessage } from '../projectLock'
import { progressReporter, stageReporter } from '../projectOps'
import { hasPublishRecordFs } from '../publishMetaFs'
import type { PublishTargetKind } from '../../shared/publishMeta'
import type { StageMark, StageTimings } from '../../shared/stageTiming'

/** run と forgetRecord が受け取るもの。 */
export type TeardownShellCtx<A> = {
  projectDir: string
  auth: A
  /** confirmed 以外の、公開先ごとの追加（HANAMII の projectId・共用型の deleteRegistry）。形の確かめは run の側。 */
  opts: Record<string, unknown>
  /** 進み具合の送り口（処理の記録を更新し、sendProgress があればそこへも送る）。 */
  progress: (message: string, extra?: { stage?: string }) => void
  /** 段の切り替わりだけを記録する送り口（画面に出す文は変えない）。 */
  onStage: (stage: string, mark?: StageMark) => void
}

export type TeardownShellResultBase = { ok: boolean; executed?: string[]; message?: string }

export interface TeardownShellSpec<A, R extends TeardownShellResultBase> {
  target: PublishTargetKind
  /** 処理の記録の見分け（'hanamii:teardown' など）。 */
  handler: string
  /** 共用型（段階2）は main が鍵を持つので、秘密を含まない印 { heldByMain: true } だけを通す（設計書 10.6.1）。 */
  parseAuth(auth: unknown): A | null
  authMissingMessage: string
  /** 処理の記録の文から伏せる秘密（完全一致）。 */
  secretsOf(auth: A): ReadonlyArray<string | null | undefined>
  /** 段の所要時間を保存するときに添えるゾーン（分かるときだけ）。 */
  zoneOf?(projectDir: string): string | null
  /** 外部サービスへ要求を出す本体。ここだけが外へ出てよい。 */
  run(ctx: TeardownShellCtx<A>): Promise<R>
  /** 公開の記録（📡 の行）を消してよいか。run の結果と、run の前に読んだ記録の有無から決める。 */
  shouldForgetRecord(s: { hadPublishRecord: boolean; result: R }): boolean
  forgetRecord(ctx: TeardownShellCtx<A>, result: R): { ok: true } | { ok: false; message: string }
  /** 断りの返り値（形は公開先ごとの型のまま）。 */
  refused(message: string): R
}

/** apprunDedicatedApply.ts:1519 の写し。 */
export const NOT_CONFIRMED_MESSAGE = '確認ダイアログを通っていません'
/** 3B-1 までの専有型の削除（ipc/apprunDedicated.ts）の断りの文と同じ。 */
export const BAD_PROJECT_DIR_MESSAGE = 'プロジェクトフォルダが不正です'

/**
 * `opts.confirmed === true` のときだけ true（3B-1 までの ipc/apprunDedicated.ts の同名の関数と同じ中身。いまは作成・公開もこれを使う）。
 * renderer から渡された値の形は信用しない。`'true'`・`1`・`{}` など、true でないものは全部 false（未確認＝安全側）。
 */
export function isConfirmed(opts: unknown): boolean {
  return !!opts && typeof opts === 'object' && (opts as any).confirmed === true
}

/** 公開の記録を消せなかったときの、結果の起きたことへ足す1行（hanamii.ts:799-807 の文と同じ）。 */
function forgetFailedLine(message: string): string {
  return `⚠️ 公開の記録を削除できませんでした。📡 公開したもの一覧に、もう無い公開が残っているときは「一覧から削除」で消してください: ${message}`
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** confirmed を除いた、公開先ごとの追加。isConfirmed を通ったあとなので opts は必ずオブジェクト。 */
function extraOptsOf(opts: unknown): Record<string, unknown> {
  const { confirmed: _confirmed, ...rest } = opts as Record<string, unknown>
  return rest
}

/**
 * 破棄の共通の骨。順序はファイル冒頭のとおり。
 *
 * - `run` の例外は握らない（withProjectLock が記録に残して投げ直す）。このとき記録は消さない。
 * - 記録を消せなかった（`forgetRecord` が失敗を返す・投げる）ときも、`run` の結果は失わない。`ok` は変えず、
 *   `executed` へ ⚠️ の1行を足す。外部のものはもう消えているので、結果が投げ直しで失われるほうが悪い。
 * - 返り値の `stageTimings` は、記録（projectOps の結果の extra.stageTimings）と同じ値。段を渡さなかった回は付かない。
 */
export async function runTeardownShell<A, R extends TeardownShellResultBase>(
  spec: TeardownShellSpec<A, R>,
  args: { projectDir: unknown; auth: unknown; opts: unknown; sendProgress?: (message: string) => void },
): Promise<R & { stageTimings?: StageTimings }> {
  const { projectDir } = args
  // 1. projectDir
  if (typeof projectDir !== 'string' || !projectDir) return spec.refused(BAD_PROJECT_DIR_MESSAGE)
  // 2. 確認の印。鍵より前（処理の記録も作らない）。
  if (!isConfirmed(args.opts)) return spec.refused(NOT_CONFIRMED_MESSAGE)
  // 3. 認証の形。
  const auth = spec.parseAuth(args.auth)
  if (auth === null || auth === undefined) return spec.refused(spec.authMissingMessage)
  const opts = extraOptsOf(args.opts)

  // 4. 同じプロジェクトで作成・削除・公開を同時に走らせない。断られたら外へ1本も出さない。
  // ゾーンは段の時間の保存に添えるだけ。読めないことで破棄を止めない。
  let zone: string | undefined
  try { zone = spec.zoneOf?.(projectDir) ?? undefined } catch { zone = undefined }
  const locked = await withProjectLock(projectDir, '削除', async () => {
    const ctx: TeardownShellCtx<A> = {
      projectDir,
      auth,
      opts,
      progress: progressReporter(projectDir, args.sendProgress),
      onStage: stageReporter(projectDir),
    }
    // 5. 公開の記録の有無を**先に**読む。run の中で記録が外れても、「破棄の前に行があったか」で決めるため。
    const hadPublishRecord = hasPublishRecordFs(projectDir, spec.target)
    const result = await spec.run(ctx)
    // 記録を消すのは run のあと・鍵の中。消し損ねても run の結果は返す。
    try {
      if (spec.shouldForgetRecord({ hadPublishRecord, result }) !== true) return result
      const forgot = spec.forgetRecord(ctx, result)
      if (forgot?.ok === true) return result
      const why = (forgot as { message?: unknown } | null | undefined)?.message
      return withForgetFailure(result, typeof why === 'string' && why ? why : '理由は分かりませんでした')
    } catch (e) {
      return withForgetFailure(result, messageOf(e))
    }
  }, { target: spec.target, handler: spec.handler, secrets: spec.secretsOf(auth), zone })

  if (locked.busy) return spec.refused(projectBusyMessage(locked.running, locked.runningTarget))
  // 6. 段ごとの所要時間（withStageTimings の写し）。
  return locked.stageTimings ? { ...locked.value, stageTimings: locked.stageTimings } : locked.value
}

function withForgetFailure<R extends TeardownShellResultBase>(result: R, message: string): R {
  return { ...result, executed: [...(result.executed ?? []), forgetFailedLine(message)] }
}
