// appHealth.ts — 公開したアプリが「本当に動いているか」を判断する（純ロジック）。
//
// ── なぜ要るか（2026-08-14 実機）────────────────────────────────────────
// Koto は公開のあと「✅ 完了しました」と出していたが、**アプリは起動に失敗していた**。
// 見ていたのは「デプロイのAPIが 200 を返したか」だけで、その後どうなったかを
// 誰も確かめていなかった。利用者は公開URLを開いて初めて気づき、原因は
// さくらのコントロールパネルのログにしか無い。
//
// これは今日の10件と**同じ形**である（「成功と読んだ応答は、結果を確かめるまで
// 成功ではない」CLAUDE.md 掟10）。
//
// ── さくらの契約（公式ライブラリ sacloud/apprun-api-go で確認・掟1）────────
//   GET /applications/{id}/status
//     → { status: 'Healthy' | 'UnHealthy' | 'Deploying', message: string }
//   message は「ステータス失敗時のメッセージ」。実機では
//   `Component is exited: ExitCode1` が入っていた。
//
// **ログ本文を取るAPIは存在しない**（操作は16個で logs は無い）。ログ機能は
// モニタリングスイート連携でコントロールパネルからのみ。だから Koto ができるのは
// 「失敗したことと、その一言を伝え、ログの場所へ案内する」ところまで。

/** さくらが返すアプリの状態。 */
export type AppRunStatus = 'Healthy' | 'UnHealthy' | 'Deploying' | 'Unknown'

/** 公開のあとに何を伝えるか。 */
export type AppHealth = {
  /** 利用者にとって成功と言えるか。**Deploying はまだ言えない。** */
  ok: boolean
  /** まだ待てば変わるか（呼び出し側が待ち直す判断に使う）。 */
  pending: boolean
  /** 画面に出す一言。 */
  note: string
  /** さくらが返した失敗の理由（あれば）。 */
  detail?: string
}

/** 応答から状態を取り出す（形が違っても落ちない）。 */
export function parseAppStatus(data: unknown): { status: AppRunStatus; message: string } {
  const d = (data ?? {}) as Record<string, unknown>
  const raw = typeof d.status === 'string' ? d.status : ''
  const status: AppRunStatus =
    raw === 'Healthy' || raw === 'UnHealthy' || raw === 'Deploying' ? raw : 'Unknown'
  return { status, message: typeof d.message === 'string' ? d.message : '' }
}

/**
 * 状態を、利用者に伝える形へ翻訳する（純関数）。
 *
 * **分からないときは「成功」と言わない。** ただし「失敗」とも言い切らない
 * （状態を取れないだけで、アプリは動いているかもしれない）。
 */
export function judgeAppHealth(opts: { status: AppRunStatus; message?: string; timedOut?: boolean }): AppHealth {
  const detail = (opts.message ?? '').trim()
  switch (opts.status) {
    case 'Healthy':
      return { ok: true, pending: false, note: 'アプリが動いています。' }
    case 'UnHealthy':
      return {
        ok: false,
        pending: false,
        note: '公開はできましたが、アプリを起動できませんでした。'
          + 'プログラムが起動の途中で止まっている可能性があります。',
        ...(detail ? { detail } : {}),
      }
    case 'Deploying':
      return opts.timedOut
        ? {
            ok: false,
            pending: true,
            note: 'まだ準備中です。しばらくしてから公開URLを開いてみてください。'
              + '数分待っても開けないときは、もう一度公開するか、下の案内をご覧ください。',
          }
        : { ok: false, pending: true, note: '準備しています…' }
    default:
      return {
        ok: false,
        pending: false,
        note: 'アプリの状態を確認できませんでした。公開URLを開いて動いているか確かめてください。',
        ...(detail ? { detail } : {}),
      }
  }
}

/** さくらのコントロールパネルで、このアプリのログを見るためのURL。 */
export function appLogUrl(appId: string): string {
  return `https://secure.sakura.ad.jp/cloud/apprun/#/apps/${encodeURIComponent(appId)}/logs`
}

/**
 * AIに相談するための文面（**秘密は含めない**）。
 *
 * 入力欄に入れるだけで送信はしない（StorageNotice と同じ形）。
 * 利用者が読んでから送れるようにする。
 *
 * ── ログを貼ってもらう（2026-08-14 Ryosuke の指摘で追加）────────────────
 * **Koto はログを読めない**（AppRun にログ取得APIが無い）。それなのに
 * 「原因を調べて」とだけ頼む文面になっていた。AI に渡せる材料が
 * 「起動しなかった」しか無く、**当てずっぽうの修正を促す形**だった。
 *
 * ログはコントロールパネルにしか無いのだから、**貼ってもらうよう文面で頼む**。
 * 隣にログ画面へのリンクも出してある。
 */
export function askAiAboutFailure(opts: { note: string; detail?: string; entry?: string }): string {
  const lines = [
    '公開したアプリが動きません。原因を調べて直してください。',
    `さくら側の状態: ${opts.note}`,
  ]
  if (opts.detail) lines.push(`エラー: ${opts.detail}`)
  if (opts.entry) lines.push(`起動しているファイル: ${opts.entry}`)
  lines.push('起動してすぐ終了していないか、待ち受けるポートが合っているか（PORT の環境変数を見ているか）を確かめてください。')
  lines.push('')
  lines.push('【ログを貼ってください】このメッセージの下に、さくらのコントロールパネルのログを貼り付けると、'
    + '原因がはっきりします（右のボタンから開けます）。ログが無くても分かる範囲で答えます。')
  return lines.join('\n')
}

/**
 * 手で押し直したときの見直し（状態を1回だけ聞く）。
 *
 * ── なぜ要るか（2026-08-14 Ryosuke 指摘・実機）──────────────────────────
 * 公開のあとに待つのは 48秒まで。**それを超えて起動するアプリは珍しくない。**
 * 実機では「まだ準備中です」と出たまま、公開URLは**実際に開けていた**。
 * それでも警告は出っぱなしで、消す手立ては「もう一度公開する」しか無かった。
 *
 * 公開はイメージを作り直す重い操作である。**確かめたいだけの人に払わせるには
 * 大きすぎる代償**なので、「もう一度聞くだけ」の道を用意する。
 *
 * 待ち直しの文面だけが judgeAppHealth と違う（自動の待機中なら「準備しています…」
 * でよいが、手で押した人には**次にどうすればよいか**を返す必要がある）。
 */
export function judgeRecheck(opts: { status: AppRunStatus; message?: string }): AppHealth {
  if (opts.status === 'Deploying') {
    return {
      ok: false,
      pending: true,
      note: 'まだ準備中です。少し待ってから、もう一度お試しください。',
    }
  }
  return judgeAppHealth({ status: opts.status, ...(opts.message !== undefined ? { message: opts.message } : {}) })
}

/**
 * 見直しの結果を、画面に出ている公開の結果へ畳み込む。
 *
 * ── なぜ要るか（2026-08-14 Ryosuke 指摘・実機）──────────────────────────
 * 「↻ 更新」で **✅ アプリが動いています** に変わったのに、その上には
 * **⏳ 起動を確認できていません** が残ったままだった。**同じ画面が二つのことを
 * 同時に言っている。** 読む人はどちらを信じればよいか分からない。
 *
 * 動いていると確かめられた時点で、**公開は成功していた**（デプロイは終わって
 * いて、アプリも起動している）。だから結果そのものを成功へ畳み込む。
 *
 * **触るのは「起動を確認できなかった」失敗だけ。** 別の理由で失敗したもの
 * （push できなかった等）は、アプリが動いていても失敗のままである。
 */
export function foldRecheck<T extends { ok: boolean; hint?: string; pending?: boolean; message?: string }>(
  result: T | null | undefined,
  health: AppHealth,
): T | null {
  if (!result) return result ?? null
  if (!health.ok) return result
  if (result.ok) return result
  if (result.hint !== 'app-unhealthy') return result
  return { ...result, ok: true, pending: false, message: '公開しました。アプリが動いています。' }
}
