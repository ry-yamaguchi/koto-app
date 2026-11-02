// teardownCall.ts — 破棄（削除）の結果を、画面でどう呼ぶか（済んだ／警告つきで済んだ／途中／失敗）を決める純関数。**定義はこの1か所**（掟10）。
//
// 結果を読む側（shared/teardownResult.ts の見出し〔TeardownView.state〕と記録の読み〔resultCallOf〕・【公開】の結果カード・開き直しの知らせ）は、
// 「失敗」と「途中」の言い分けをすべてここから取る。ここは electron にも React にも依存しない（renderer からも main からも読まれる shared）。
// 事実の読み取り（返り値・記録のどこに受付済みの印があるか）は teardownResult.ts の仕事で、ここは読み取った事実から呼び名を決めるだけ。

// ── 結果を、画面でどう呼ぶか（済んだ／途中／失敗）。**決める定義はこの1か所**（掟10）──────────────────
// 0.6.22-rc.3 の実機（2026-10-21・10.18.15 の d1）: HANAMII が削除を受け付けただけの回（記録は ok:false・`extra.deletionAccepted`）を、
// 【公開】の結果カードは「HANAMIIの破棄に失敗しました」と言い、すぐ下の結果欄は「⏳ 破棄の途中です」と言った。同じ記録を読む画面が、
// `r.ok` だけで「失敗」と言う所と、`TeardownView.state` で「途中」と言う所に分かれていたため。
// 受け付けただけの回は失敗ではなく**途中**（押し直せば済む。0.6.22 の決定 D7）。見出し・知らせの一行・「AIに相談する」を出すかは、
// すべてここが返す呼び名で決める（`r.ok` だけで失敗と決めない）。
//   done             … 済んだ（✅）
//   doneKeptOnly     … 済んだが、何も消していない（保存場所だけが残った回の `keptOnly`）。state は done のまま（移してよい）。見出し・一言・結果カードが言い分けるための別の呼び名
//   doneWithWarnings … 済んだが、確認が要る知らせがある（残した保存場所の月額など）
//   inProgress       … 途中。HANAMII が受け付けただけ（deletionAccepted）／専有型が待ち切れて止まった（inProgress）
//   stoppedByQuit    … 途中。Koto の終了で止まった（起動の読み戻しが置く知らせ。失敗ではない）
//   failed           … 失敗
export type TeardownCall = 'done' | 'doneKeptOnly' | 'doneWithWarnings' | 'inProgress' | 'stoppedByQuit' | 'failed'

/**
 * 呼び名を決める。**ok が先**（成功した記録は途中でも失敗でもない。失敗の回は `keptOnly` を読まない）。受け付けただけ・待ち切れて止まったは、ok:false でも失敗ではなく途中。
 * `warnings` は知らせの件数（済んだ回を「警告つき」と呼び分けるだけに使う）。`keptOnly` は「何も消さなかった」の印（真偽値の `true` だけを真と読む。警告の有無より先）。
 */
export function teardownCallOf(f: { ok: boolean; accepted: boolean; stopped: boolean; stoppedByQuit: boolean; warnings: number; keptOnly?: boolean }): TeardownCall {
  if (f.ok) return f.keptOnly === true ? 'doneKeptOnly' : f.warnings > 0 ? 'doneWithWarnings' : 'done'
  if (f.stoppedByQuit) return 'stoppedByQuit'
  if (f.accepted || f.stopped) return 'inProgress'
  return 'failed'
}

/** 結果欄の見出しの3つ（✅ 済んだ／⏳ 途中／⚠️ できなかった）への畳み方。`TeardownView.state` はこれで決まる。 */
export function teardownStateOf(call: TeardownCall): 'done' | 'inProgress' | 'failed' {
  return call === 'done' || call === 'doneKeptOnly' || call === 'doneWithWarnings' ? 'done' : call === 'failed' ? 'failed' : 'inProgress'
}

/**
 * 開き直しの知らせ（古い記録）の、結果の一言。呼び名から作る（成功／途中／失敗を言い分ける所は、ここ1か所）。
 * 「Koto の終了で止まりました」の知らせは、見出しがもう言っているので一言を足さず、次の操作の案内（message）だけを出す。
 * 出すものが無ければ null。tone は色の出し分け（ok=緑・wait=黄・fail=赤・plain=ふつうの文字）。
 */
export function teardownCallLine(call: TeardownCall, message: string): { text: string; tone: 'ok' | 'wait' | 'fail' | 'plain' } | null {
  const finished = call === 'done' || call === 'doneWithWarnings'
  // 何も消していない回（doneKeptOnly）に「成功しました」とは言わない。この一言は公開先の言葉（破棄・削除）を受け取らないので、どちらの動詞も使わない形にする。色は黄（見出しと同じ）。
  const lead = finished ? '✅ 成功しました。' : call === 'doneKeptOnly' ? '⚠️ 何も消していません。' : call === 'inProgress' ? '⏳ 途中です。' : call === 'failed' ? '⚠️ 失敗しました。' : ''
  const tone = finished ? 'ok' : call === 'doneKeptOnly' || call === 'inProgress' ? 'wait' : call === 'failed' ? 'fail' : 'plain'
  const text = [lead, message].filter(t => t !== '').join(' ')
  return text === '' ? null : { text, tone }
}

/**
 * 【公開】の結果カードの見出し（何も消していない回〔doneKeptOnly〕）。終わったと言わない。`what` は「〇〇の破棄」「〇〇の削除」（`opHeadlineSubject`）。
 * 警告つきで済んだ回（doneWithWarnings）の見出しは、カード側で今のまま。
 */
export function keptOnlyCardHeadline(what: string): string {
  return `⚠️ ${what}はしていません`
}
