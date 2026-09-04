// chatTime.ts — チャットの吹き出しに「いつのものか」を出すための純粋ロジック（DOM/electron 非依存）。
//
// ── なぜ要るのか（利用者からの要望）────────────────────────────────────
// 会話がいつのものか分からず、あとで見返したときに「これはなんだっけ？」となる。
// 日付が変わったところに区切りを出し、吹き出しに触れたら時刻が分かるようにする。
//
// ── 古い会話には時刻が無い（推測で埋めない）───────────────────────────
// これまで保存してきた chat.json には `at` が無い。あとから「保存時刻」等で埋めると、
// 実際にはいつ話したか分からないものに嘘の時刻が付く。**古い会話は「記録なし」のまま扱う**。
// 新しく作るメッセージにだけ `stamp()` で時刻を入れる（useAiChat.ts の appendBubble/replaceLast）。

/** 新しく作るメッセージにだけ時刻を入れる。既に `at` があれば触らない（上書きしない）。 */
export function stamp<T extends { at?: string }>(msg: T, now: Date = new Date()): T {
  if (msg.at !== undefined) return msg
  return { ...msg, at: now.toISOString() }
}

/** 画面に出す区切り。 */
export type TimelineMark =
  | { kind: 'none' }
  /**
   * ここより上には日時の記録が無い、という境目。
   *
   * ⚠️ **置き場所を変えた（2026-08-26 Ryosuke 実機報告）。** 最初は「記録の無い塊の
   * **先頭**」に出していたが、**一度も見られなかった**——チャットは常にいちばん下から
   * 始まるので、200件の会話の先頭は誰もそこまで遡らない。
   * **記録の無い塊の終わり**（＝最初の記録あるメッセージの直前）へ移した。
   * そこは「最近の会話」のすぐ上なので、少し遡れば目に入る。
   *
   * **その日の日付も一緒に持つ。** 境目で日付を潰すと、記録がある最初の会話が
   * 「いつのものか分からない」ままになる——**それこそが直したかったこと**だった
   * （2026-08-26、一度そう作って画面で気づいた）。画面は2本の細い線として出す。
   */
  | { kind: 'unknown'; label: string }
  /** その日の始まり。 */
  | { kind: 'date'; label: string }

/** `at` が壊れていない（parse できる）かどうか。 */
function validAt(at: string | undefined): Date | null {
  if (!at) return null
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? null : d
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** 曜日つきの日付ラベル（今日／昨日／同じ年／去年以前の4通り）。 */
function dateLabel(at: Date, now: Date): string {
  if (isSameDay(at, now)) return '今日'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (isSameDay(at, yesterday)) return '昨日'
  const weekday = '日月火水木金土'[at.getDay()]
  const monthDay = `${at.getMonth() + 1}月${at.getDate()}日（${weekday}）`
  return at.getFullYear() === now.getFullYear() ? monthDay : `${at.getFullYear()}年${monthDay}`
}

/**
 * 画面に出す並びに対して、各メッセージの上に何を出すかを決める。
 * 戻り値は messages と同じ長さ・同じ順。
 *
 * - `at` があるメッセージは、直前に出した日付と日が変わったときだけ `date`。
 * - **先頭から続く「記録なし」の塊が終わる直前**に `unknown` を1つ
 *   （＝最初の記録あるメッセージの上）。`unknown` は**その日の日付も持つ**ので、
 *   画面は「日時の記録がありません」と日付の2本を出す。
 * - 記録あるメッセージが1件も無ければ `unknown` は出さない（**出しても誰も見ない**うえ、
 *   区別すべき相手がいない）。
 * - それ以外は `none`。
 */
export function timelineMarks(messages: readonly { at?: string }[], now: Date): TimelineMark[] {
  const list = messages ?? []
  // 先頭から続く「記録なし」の塊は、どこで終わるか。
  let boundary = -1
  for (let i = 0; i < list.length; i++) {
    if (validAt(list[i]?.at)) { boundary = i; break }
  }
  // 先頭が既に記録あり（＝記録なしの塊が無い）なら、境目は出さない。
  const showUnknownAt = boundary > 0 ? boundary : -1

  const marks: TimelineMark[] = []
  let lastDateKey: string | null = null // 直前に「date」として出した日（年月日の文字列キー）
  for (let i = 0; i < list.length; i++) {
    const at = validAt(list[i]?.at)
    if (!at) { marks.push({ kind: 'none' }); continue }
    const key = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`
    const changed = key !== lastDateKey
    lastDateKey = key
    // 境目は日付より優先する（**同じ場所に2本引かない**）。日付はこのすぐ下の
    // メッセージから始まるので、境目の1本で「ここから記録がある」ことが分かる。
    if (i === showUnknownAt) marks.push({ kind: 'unknown', label: dateLabel(at, now) })
    else marks.push(changed ? { kind: 'date', label: dateLabel(at, now) } : { kind: 'none' })
  }
  return marks
}

/**
 * 吹き出しの下に出す時刻（`13:57`）。`at` が無ければ null（何も出さない）。
 *
 * ⚠️ **`title` 属性をやめた（2026-08-26 Ryosuke 実機報告）。**
 * 「非常にシビアなのか1度表示されましたが、その後表示できませんでした」——
 * OS のツールチップは**出るまでに間があり、少し動かすと消える**。
 * **触れたら吹き出しの下にすっと出る**形へ変えた。
 *
 * **日付は付けない。** すぐ上の区切りが日付を持っているので、ここは時刻だけでよい
 * （長いと吹き出しの下がうるさくなる）。
 */
export function bubbleTime(at: string | undefined): string | null {
  const d = validAt(at)
  if (!d) return null
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土']

/**
 * AI へ渡す「今の日時」1行（この端末＝利用者のローカル時刻）。
 *
 * ── なぜ要るか（2026-08-27 実機・Ryosuke 発見 → 2026-08-30 実装）──────────────
 * Koto は AI に「今日が何日か」を渡していなかったため、AI は学習内容や検索結果から
 * 日付を**推測**していた（実機: 8/27 に「2026年8月26日時点の」と回答）。ここで現在時刻を
 * 明示的に渡す。NTP は使わない（吹き出しの時刻・ファイル更新時刻・git など Koto の他の
 * 時刻はすべて OS の時計を見ており、AI にだけ別ソースを渡すとズレて混乱が増えるため。
 * macOS の時計は OS レベルで NTP 同期済み・2026-08-30 Ryosuke と合意）。
 *
 * systemPrompt は**送信ごと**に組まれるので、送信の瞬間の now を渡せば常に最新になる
 * （キャッシュ不要。窓を開けっぱなしで日付が変わっても次の送信で更新される）。getHours 等は
 * ローカルタイムゾーンで返るので、利用者の時間帯そのままになる。純関数（now を引数に取る）。
 */
export function nowContext(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const d = now.getDate()
  const w = WEEKDAYS_JA[now.getDay()]
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  // roadmap #11（2026-08-30 実機: 過去に日付を手入力した会話で、履歴の古い日付に引きずられた。
  // 「古い案内は真似しない」と同じ手法で、履歴より現在日時を優先させる一文を足す）
  return `【現在の日時】${y}年${m}月${d}日（${w}）${hh}:${mm}（利用者の端末のローカル時刻）。` +
    `日付や時刻・曜日に言及するときは推測せず、必ずこの時刻を基準にすること。` +
    `会話の履歴に別の日付・時刻が書かれていても、それは過去のやり取りの時点のもの。現在を答えるときはこの値を最優先すること。`
}
