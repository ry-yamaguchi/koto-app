// hanamiiResumeTeardown.ts — HANAMII の破棄の「自動の続き」（hanamii:resumeTeardown）。
//
// ── 何のためにあるか ─────────────────────────────────────────────────────────
// HANAMII が削除を受け付けた（202）あと、Koto は最長で約5分待つ（hanamiiDeletionFlow.ts）。待ち切れなかった回・確認が要る回・待っている間に
// Koto を終えた回は、記録（.sakuraide.json）に「受け付けの印」が残る。次に Koto を起動したとき（または 📡 一覧・【公開】の HANAMII の画面を開いたとき）、
// 画面はこの印があるプロジェクトだけを探し、このハンドラを呼ぶ（renderer/teardown/hanamiiResume.ts）。**利用者に押し直しをさせない。**
//
// ── 呼び形 ────────────────────────────────────────────────────────────────
//   hanamii:resumeTeardown (projectDir, { token }, { projectId })
// **`confirmed` も `shownPlacements` も受け取らない。** 確認は最初の破棄で済んでおり、そのとき見せた保存場所は印の中にある。
// 掟10「確認で見せた保存場所だけを消す」のため、消すのは**印の shownPlacements だけ**（selectShown・mustKeepDataOf の今ある判断をそのまま通す）。
//
// ── 順序（共通の骨 runTeardownShell を、確認の印なし〔requireConfirmed:false〕で流用）──────────────────────────
//   projectDir → 認証の形 → 鍵（同時に1つだけ）→ 複製の断り（twinsOf）→ **記録の照合（run の頭）**→ run → 印が済んだ回だけ記録を消す
// 記録の照合: projectId が記録のものと一致し、**受け付けの印があり、印の projectId も一致する**ときだけ進む。
// 無ければ HANAMII へも保存場所へも1本も要求を出さずに断る（印が無いのに続けると、確認なしの破棄になる）。
// 進み方は最初の破棄と同じ continueAcceptedDeletion を通る。ただし最初の DELETE は送らず、GET から始める（受け付け済みのため）。
// さらに、**上限の直前の確かめの DELETE も送らない**（finalConfirm:false）。続きは起動のたび・画面を開くたびに走るので、GET が 200 のまま（確認待ち・却下で残った）
// のプロジェクトへ DELETE を送り続けない。DELETE を送るのは、GET が 404 を見せた回の確かめだけ。
// トークンは renderer が引数で渡したものだけ（掟4・D8。main は保存しない）。
import { ipcMain } from 'electron'
import { HanamiiClient } from '../hanamii/client'
import { runTeardownShell, type TeardownShellCtx, type TeardownShellSpec } from '../cloud/teardownShell'
import { readHanamiiProjectIdFs, readHanamiiAcceptedMarkFs, settleHanamiiTeardownFs } from '../publishMetaFs'
import { HANAMII_TEARDOWN_SHELL, PROJECT_MISMATCH_TEARDOWN, projectIdOf, teardownAfterGone, type HanamiiAuth, type HanamiiTeardownResult } from './hanamiiTeardown'
import { continueAcceptedDeletion } from './hanamiiDeletionFlow'
import { HANAMII_RESUME_NO_MARK_MESSAGE } from '../../shared/teardownResult'

async function runHanamiiResume(ctx: TeardownShellCtx<HanamiiAuth>): Promise<HanamiiTeardownResult> {
  const { projectDir, auth } = ctx
  // 渡された projectId は、記録が指すものと一致するときだけ（最初の破棄と同じ守り・掟11）。
  const projectId = projectIdOf(ctx.opts)
  if (!projectId || readHanamiiProjectIdFs(projectDir) !== projectId) return { ok: false, message: PROJECT_MISMATCH_TEARDOWN }
  // 受け付けの印。無い・形が違う・別のプロジェクトのものなら、何も出さずに断る。**鍵の中**で読む（最初の破棄が書いている最中を見ない）。
  const mark = readHanamiiAcceptedMarkFs(projectDir)
  if (!mark || mark.projectId !== projectId) return { ok: false, message: HANAMII_RESUME_NO_MARK_MESSAGE }
  ctx.progress('🗑 HANAMII の削除の続きを確かめています…')
  return continueAcceptedDeletion({
    ctx, client: new HanamiiClient({ token: auth.token }), projectId, mark,
    deleteJustSent: false, finalConfirm: false, stopOnReview: false, markFailure: null,
    // 消すのは、最初の破棄の確認で見せた保存場所（印の shownPlacements）だけ。
    onGone: () => teardownAfterGone(ctx, projectId, mark.shownPlacements),
  })
}

/** HANAMII の自動の続きを骨に載せる定義。認証・複製の断り・記録の消し方は最初の破棄と同じで、確認の印だけを見ない。 */
export const HANAMII_RESUME_SHELL: TeardownShellSpec<HanamiiAuth, HanamiiTeardownResult> = {
  ...HANAMII_TEARDOWN_SHELL,
  handler: 'hanamii:resumeTeardown',
  requireConfirmed: false,
  run: runHanamiiResume,
  forgetRecord: ctx => settleHanamiiTeardownFs(ctx.projectDir, projectIdOf(ctx.opts) ?? ''),
}

/**
 * 鍵を取る前の下見: 記録の projectId と合わない・受け付けの印が無いなら、**処理の記録を作らずに**断る（外へも1本も出さない）。
 * 自動の続きは利用者が押したものではない。画面が候補を読んだあと（前のプロジェクトの続きを待っている間など）に、手で押した破棄や
 * 「一覧から削除」で印が外れていれば、断りを「失敗」の結果として画面に出さない（何も起きていない）。
 * **歯止めの本体は run の頭**（鍵の中で読み直す）。ここは記録を作るかどうかだけを決める。projectDir の形の断りは骨に任せる。
 */
export function resumePrecheck(projectDir: unknown, opts: unknown): HanamiiTeardownResult | null {
  if (typeof projectDir !== 'string' || !projectDir) return null
  const projectId = opts && typeof opts === 'object' && !Array.isArray(opts) ? projectIdOf(opts as Record<string, unknown>) : null
  if (!projectId || readHanamiiProjectIdFs(projectDir) !== projectId) return { ok: false, message: PROJECT_MISMATCH_TEARDOWN }
  const mark = readHanamiiAcceptedMarkFs(projectDir)
  if (!mark || mark.projectId !== projectId) return { ok: false, message: HANAMII_RESUME_NO_MARK_MESSAGE }
  return null
}

/** hanamii:resumeTeardown を登録する（registerHanamiiHandlers から呼ぶ）。 */
export function registerHanamiiResumeHandler(): void {
  ipcMain.handle('hanamii:resumeTeardown', async (_event, projectDir: unknown, auth: unknown, opts: unknown): Promise<HanamiiTeardownResult> =>
    resumePrecheck(projectDir, opts) ?? runTeardownShell(HANAMII_RESUME_SHELL, { projectDir, auth, opts }))
}
