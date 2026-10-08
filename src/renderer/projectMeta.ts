// projectMeta.ts — renderer から `<projectDir>/.sakuraide.json`（公開の記録・公開先・GitHub の保存先・資料設定）を
// **更新する唯一の入口**（2026-09-29・掟10の一元化）。
//
// ── なぜ1か所に集めたか ────────────────────────────────────────────────────
// 以前は各画面（PublishModal・HanamiiPanel・VercelPanel・VpsPanel・AppRunDedicatedPanel・
// GithubSaveModal・App の公開先変更・資料設定・記録の片づけ）が、それぞれ .sakuraide.json を
// 読んで・マージして・**全体を書き戻して**いた。とくに PublishModal は、画面を開いたときに
// 一度だけ読んだ**古い写し**で全体を書き戻し、開いている間に main が書いた記録
// （専有型の資源ID publish.apprunDedicated・publish.targets・HANAMII の projectId）を消した。
// 専有型のクラスタの記録が消えると⑥で破棄できず、月額22,000円が止められなくなる
// （掟10「画面が持っている写しは、いつでも古い」）。
//
// ここは**差分（patch）だけ**を main へ渡す。main が書く直前にディスクから読み直して当てて書く
// （src/main/publishMetaFs.ts の mergeMetaPatchFs。読む→当てる→書くは1回の同期処理で、
// ほかの main の書き込みとも交錯しない）。**全体を渡す口が無い**ので、古い写しで書き戻すことが
// そもそもできない。renderer から .sakuraide.json へ直接 `fs.writeFile` する書き方は、
// tests/projectMetaWiring.test.ts が禁じている。
//
// patch の当て方（src/shared/publishMeta.ts の withMetaPatch）:
//   ・プレーンオブジェクトは再帰でマージ（patch に無いキーはディスクのまま）
//   ・配列・文字列・数値・null は置き換え／`undefined` のキーは取り除く

import type { PublishTargetKind } from './publishStatus'

/** 差分を、書く直前にディスクから読み直した .sakuraide.json へ当てて書く。書いた結果の全体を返す。 */
export async function mergeProjectMeta(projectDir: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await window.electronAPI.publishMeta.merge(projectDir, patch)
  if (!r.ok) throw new Error(r.message)
  return r.meta
}

/**
 * 「記録を片づける」: その公開先の記録**だけ**を消す（専有型の資源ID・ほかの公開先・pending は残る）。
 * 書いた結果の全体を返す。
 */
export async function forgetPublishTargetRecord(projectDir: string, target: PublishTargetKind): Promise<Record<string, unknown>> {
  const r = await window.electronAPI.publishMeta.forgetTarget(projectDir, target)
  if (!r.ok) throw new Error(r.message)
  return r.meta
}

/**
 * 「確認しました（この通知を消す）」: 中断の可能性の印（publish.pending）を消す。
 * いま公開が走っているプロジェクトでは main が断る（`running: true`）。
 */
export async function dismissInterruptedPublish(projectDir: string): Promise<{ ok: true } | { ok: false; running: boolean; message: string }> {
  const r = await window.electronAPI.publishMeta.dismissInterrupted(projectDir)
  if (r.ok) return { ok: true }
  return { ok: false, running: 'running' in r && r.running === true, message: r.message }
}

export type RunningOp = '作成' | '削除' | '公開' | null

/** 公開の画面が持つ2つ: いま main が走らせている操作と、公開の記録（.sakuraide.json）。 */
export type PublishSnapshot = { runningOp: RunningOp; meta: Record<string, unknown> }

/** いま main が走らせている操作。聞けなかったとき（preload 未注入など）は null（＝走っていない扱い）。 */
export async function readRunningOp(projectDir: string): Promise<RunningOp> {
  try {
    return await window.electronAPI.publishMeta.runningOp(projectDir)
  } catch {
    return null
  }
}

/**
 * 公開の画面が最初に要る2つ——「いま main が走らせている操作」と「公開の記録（.sakuraide.json）」——を
 * 取る。**走っているかを先に聞き、記録は後で読む。この順序が要る**（2026-09-29）:
 *
 *   記録を先に読むと、その直後に公開が終わったとき（pending は消え、鍵も外れる）、
 *   読んだ写しには pending が残っているのに「走っていない」と返り、**中断していないのに
 *   「中断された可能性」と出る**。走っているかを先に聞けば、終わったあとに読んだ記録には
 *   pending が無い。逆に、聞いた直後に公開が始まった場合は、pending が直近（数秒以内）なので
 *   `judgePendingPublish` が中断とは扱わない。
 *
 * `io` はテストで差し替える（既定は preload の window.electronAPI）。
 */
export async function loadPublishSnapshot(
  projectDir: string,
  io: {
    runningOp: (projectDir: string) => Promise<RunningOp>
    readFile: (path: string) => Promise<string>
  } = { runningOp: readRunningOp, readFile: p => window.electronAPI.fs.readFile(p) },
): Promise<PublishSnapshot> {
  const runningOp = await io.runningOp(projectDir)
  let meta: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await io.readFile(`${projectDir}/.sakuraide.json`))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed
  } catch { /* メタ無し（既存フォルダ等） */ }
  return { runningOp, meta }
}

/**
 * 差分を書いたあと、画面が持つ「いま走っているか」と「記録」を**まとめて**取り直す
 * （2026-09-29 検分）。
 *
 * 記録（.sakuraide.json）だけを画面へ取り込むと、ディスクの publish.pending と、画面が前に聞いた
 * 「走っていない」が食い違う。**画面のなかで公開を始めた**あと（ダイアログを開いたときは走っていなかった）に
 * 書き込みや「記録を片づける」をすると、走っている公開自身の印を「中断の可能性」と誤る
 * （押せば main は断るが、その前に誤表示が出る）。だから書いたあとは**必ず**
 * `loadPublishSnapshot`（走っているかを先に聞き、記録を後で読む）を通す。
 */
export async function mergeProjectMetaThenLoad(
  projectDir: string,
  patch: Record<string, unknown>,
  io?: Parameters<typeof loadPublishSnapshot>[1],
): Promise<PublishSnapshot> {
  await mergeProjectMeta(projectDir, patch)
  return loadPublishSnapshot(projectDir, io)
}

/** 「記録を片づける」のあと、`mergeProjectMetaThenLoad` と同じ理由で、走っているかと記録を取り直す。 */
export async function forgetPublishTargetThenLoad(
  projectDir: string,
  target: PublishTargetKind,
  io?: Parameters<typeof loadPublishSnapshot>[1],
): Promise<PublishSnapshot> {
  await forgetPublishTargetRecord(projectDir, target)
  return loadPublishSnapshot(projectDir, io)
}

/**
 * レンタルサーバへ公開したときの記録の差分（PublishModal の「🚀 公開する」）。
 * publish.targets は**自分の行（'sakura-rental'）だけ**を渡す（ほかの公開先の記録は、
 * main が書く直前にディスクから読み直したものが残る）。
 */
export function rentalPublishPatch(args: { account: string; host: string; publishedAt: string }): Record<string, unknown> {
  const url = `https://${args.host}/`
  return {
    target: 'sakura-rental',
    publish: {
      account: args.account,
      host: args.host,
      url,
      lastPublishedAt: args.publishedAt,
      targets: { 'sakura-rental': { publishedAt: args.publishedAt, url } },
    },
  }
}
