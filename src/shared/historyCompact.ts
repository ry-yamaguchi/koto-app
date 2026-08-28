// 会話が長くなったとき、古いやり取りを「切り捨てる」のではなく「まとめて」送る。
//
// ── なぜ要るか（2026-08-20 Ryosuke 指摘）──────────────────────────────
// これまでは直近20件だけを送り、それより前は **黙って捨てていた**。
// 長い相談ほど「さっき決めたこと」を忘れる。利用者から見れば、AIが急に物覚えを失う。
//
// ── 手元の本物の会話12件で実測してから決めた（2026-08-20）───────────────
// 件数で測る設計を先に書いたが、実測に照らして作り直した。
//
//   ・会話はまったく重くない。**直近20件で 476〜2,994トークン**。
//     4000文字を超えるメッセージは12プロジェクトで **1件も無かった**。
//     「コンテキスト上限で壊れる」は、いまのところ起きていない問題だった。
//   ・一方で **捨てている実害は出ている**（landingTEST は本文95件＝75件が消えていた）。
//   ・件数（30件ごと）で畳むと、その会話だけで **7回もまとめ直す**ことになる。
//     合計1万トークンしかない会話を7回要約するのは、伝言ゲームで情報が落ちるだけ。
//
// そこで **量（概算トークン）で測る**。多くの会話ではまとめが一度も走らない
// （＝余計な料金も待ち時間も発生しない）。長くなったときだけ効く。
//
// ── 決めごと ──────────────────────────────────────────────────────────
//   ・**元の会話は消さない。** 画面には全部残り、送信のときだけまとめを使う。
//   ・**黙ってやらない。** まとめたら「🗂 ここまでの内容をまとめました」を会話に出す。
//   ・まとめは **いま選んでいるモデル**で作る（利用者が知らない経路・料金を使わない）。
//   ・まとめは会話の中の1メッセージとして残る。だから **保存され、次の起動でも効く**
//     （新しい保存形式を足していない＝古い chat.json をそのまま読める）。
//   ・食い違い（🕘 元に戻す 等で会話が短くなった）を見つけたら、まとめを捨てて作り直す。
//
// ── 送るものの内訳 ────────────────────────────────────────────────────
//   [まとめ（system）] + [まとめが覆っていないところ]
// **どこにも入らずに消えるやり取りは無い。** 例外はまとめ作りが失敗し続けたときだけで、
// そのときは上限で頭打ちにしつつ「省略した」と本文に書いて伝える。
//
// なぜ shared にあるか（B'-3b）: 次の段で main プロセスで動くループ（chatTurn.ts）の
// ports.h を、renderer からも main からも同じ実装で組み立てられるようにするため。

import { estimateTokens } from './modelInfo'
import { MATERIALS_DIR } from './publishExclude'

/** 履歴に使ってよい概算トークン。これを超えたときだけ、古いぶんをまとめる。
 *
 *  **Koto はモデルごとのコンテキスト長を知らない**（モデル一覧にその情報が無い）。
 *  だから上限から逆算はできず、システムプロンプト・ツール定義・資料・Web取得のぶんを
 *  見込んだ保守的な固定値にしてある。実測（1件あたり約106トークン）だと **約75件・37往復**で、
 *  従来の20件（10往復）よりずっと長く覚えていられる。 */
export const SEND_BUDGET_TOKENS = 8000

/** まとめたあと、そのまま残す直近ぶんの概算トークン。 */
export const KEEP_TOKENS = 4000

/** 量が上限を超えていても、**直近これだけは必ずそのまま送る**
 *  （1件が極端に大きいときに、直近の文脈まで消さないため）。 */
export const KEEP_MIN_MESSAGES = 6

/** 1メッセージあたりの上限（長いコード貼り付け等を切詰め）。実測では未発動だが、
 *  AIがファイル全文を貼る場面では効く。 */
export const MAX_CHARS_PER_MSG = 4000

/** まとめ本文の上限（モデルが長々と書いても、ここで頭打ちにする）。 */
export const MAX_SUMMARY_CHARS = 4000

/** これより短いものは、まとめとして受け取らない。 */
export const MIN_SUMMARY_CHARS = 20

/** まとめの本文が始まる目印。**この行より後ろだけ**をまとめとして受け取る。
 *
 *  ── なぜ要るか（2026-08-20 実機・Ryosuke 報告）──────────────────────
 *  推論型モデル（Kimi 等）は、考えた過程を丸ごと返してくることがある。
 *  実際に landingTEST で、英語の思考と下書き2本が**そのまま**まとめとして保存された
 *  （4,007文字中 3,324文字が英語）。**目印の最後の出現から後ろ**だけを採れば、
 *  下書きが並んでいても最終版だけが残る。目印が無い返事は受け取らない
 *  （変なまとめをAIへ渡すより、作らないほうがよい。作れなかったことは画面に出す）。 */
export const SUMMARY_HEADING = '## まとめ'

/** 会話に出す印。**利用者にはこれだけが見える**（本文は折りたたむ）。 */
export const COMPACT_NOTE = '🗂 ここまでの内容をまとめました'

/** まとめメッセージに付ける印。upTo = 覆っている本文の件数。 */
export type CompactMark = {
  /** 本文列の先頭から何件を覆っているか。 */
  upTo: number
  /** 覆っている最後の1件の指紋。会話が作り替えられたことを見つけるために使う。 */
  mark: string
}

type Msg = {
  role: string
  content: string
  /** 表示専用（AIへは送らない）。ただし**まとめの材料には使う**（下記 compactSource）。 */
  toolNote?: boolean
  /** これが付いていれば「まとめ」。content にまとめ本文が入る。 */
  summary?: CompactMark
  /** 添付画像（data URL）。まとめには枚数だけ残す。 */
  images?: string[]
}

/** 長すぎる1件を切り詰める（切詰めたことは本文に明記する。黙って落とさない）。 */
export function capMessage<T extends { role: string; content: string }>(m: T): { role: string; content: string } {
  const c = m?.content ?? ''
  return {
    role: m?.role ?? '',
    content: c.length > MAX_CHARS_PER_MSG ? c.slice(0, MAX_CHARS_PER_MSG) + '\n…（長いため後半を省略）' : c,
  }
}

/**
 * AIへ送る対象の並び（＝本文列）。
 * 表示専用（toolNote）と、まとめ自身を除く。**hidden は含む**（画面に出ないだけでAIには送る）。
 */
export function bodyMessages<T extends Msg>(msgs: readonly T[]): T[] {
  return (msgs ?? []).filter(m => !!m && !m.toolNote && !m.summary)
}

/** 送るときの概算トークン（切詰め後で数える。実際に送る量と一致させる）。 */
export function tokensOf<T extends Msg>(list: readonly T[]): number {
  return (list ?? []).reduce((s, m) => s + estimateTokens(capMessage(m).content), 0)
}

/**
 * 末尾から予算に収まるぶんだけ取る。**直近 KEEP_MIN_MESSAGES 件は予算を超えても必ず残す**
 * （1件が極端に大きいときに、直近の文脈まで落とさないため）。
 */
export function capToBudget<T extends Msg>(list: readonly T[], budget: number): { kept: T[]; omitted: number } {
  const src = list ?? []
  let used = 0
  let i = src.length
  while (i > 0) {
    const t = estimateTokens(capMessage(src[i - 1]).content)
    const keptSoFar = src.length - i
    if (used + t > budget && keptSoFar >= KEEP_MIN_MESSAGES) break
    used += t
    i--
  }
  return { kept: src.slice(i), omitted: i }
}

/** 1件の指紋（長さと書き出しで足りる。中身をまるごと持たない）。 */
export function markOf(m: { role: string; content: string }): string {
  const c = m?.content ?? ''
  return `${m?.role ?? ''}:${c.length}:${c.slice(0, 32)}`
}

/**
 * いま有効なまとめを取り出す。**食い違っていたら null**（作り直させる）。
 * 会話に複数のまとめがあれば、いちばん新しいものを使う。
 */
export function currentSummary<T extends Msg>(msgs: readonly T[]): { text: string; upTo: number } | null {
  const list = msgs ?? []
  let found: CompactMark | null = null
  let text = ''
  for (const m of list) {
    if (m?.summary) { found = m.summary; text = m.content ?? '' }
  }
  if (!found || !text.trim()) return null
  const body = bodyMessages(list)
  const upTo = found.upTo
  // 覆っている件数が会話より多い＝🕘 元に戻す 等で短くなった。作り直す。
  if (!Number.isInteger(upTo) || upTo <= 0 || upTo > body.length) return null
  if (markOf(body[upTo - 1]) !== found.mark) return null
  return { text, upTo }
}

/** まとめをAIへ渡すときの1件（履歴の先頭に置く）。 */
export function summaryMessage(text: string): { role: string; content: string } {
  return {
    role: 'system',
    content: '（これより前のやり取りのまとめ。古い会話の代わりに読んでください）\n' + text.trim(),
  }
}

/**
 * 送信する履歴を組み立てる。
 * まとめがあれば先頭に置き、そのあとは覆われていない分を予算のぶんだけ送る。
 */
export function planSend<T extends Msg>(msgs: readonly T[]): { role: string; content: string }[] {
  const body = bodyMessages(msgs)
  const cur = currentSummary(msgs)
  const tail = cur ? body.slice(cur.upTo) : body
  const { kept, omitted } = capToBudget(tail, SEND_BUDGET_TOKENS)
  const out: { role: string; content: string }[] = []
  if (cur) out.push(summaryMessage(cur.text))
  // ここに来るのは **まとめが作れていないとき**（通信の失敗などが続いた場合）。
  // 頭打ちにしないと送るものが際限なく増えて壊れるが、**捨てたことは隠さない**。
  if (omitted > 0) {
    out.push({ role: 'system', content: `（注: これより前に${omitted}件の古いやり取りがありますが、送信を省略しています。必要なら read_file 等で現状を確認してください）` })
  }
  out.push(...kept.map(capMessage))
  return out
}

/** まとめ直す範囲。null なら「いまは要らない」。 */
export type CompactPlan = {
  /** 本文列のこの位置から */
  from: number
  /** この位置の手前まで（＝新しい upTo） */
  to: number
  /** 前回までのまとめ（あれば。これも一緒にまとめ直す） */
  base: string | null
  /** 新しい印（append するまとめメッセージにそのまま付ける） */
  mark: string
}

/** いま、まとめ直すべきか。**量が予算を超えたときだけ**（件数では測らない）。 */
export function planCompact<T extends Msg>(msgs: readonly T[]): CompactPlan | null {
  const body = bodyMessages(msgs)
  const cur = currentSummary(msgs)
  const from = cur?.upTo ?? 0
  if (tokensOf(body.slice(from)) <= SEND_BUDGET_TOKENS) return null
  // 直近 KEEP_TOKENS ぶんは残し、それより古いところを畳む。
  const { kept } = capToBudget(body, KEEP_TOKENS)
  const to = body.length - kept.length
  if (to <= from) return null // 畳んでも減らない（直近だけで予算を超えている）
  return { from, to, base: cur?.text ?? null, mark: markOf(body[to - 1]) }
}

/** 手動で「ここまでをまとめる」を押したとき、そのまま残す直近の件数（3往復）。
 *
 *  自動は「壊れないため」に畳むので量（KEEP_TOKENS）で測るが、手動は
 *  **利用者が区切りたくて押す**ので、件数のほうが分かりやすく、押した意味が必ず出る。 */
export const MANUAL_KEEP_MESSAGES = 6

/** 手動でも、これだけ畳めないなら押す意味が無い（ボタン自体を出さない）。 */
export const MANUAL_MIN_FOLD = 4

/** 手動でまとめる範囲。null なら「いま押しても意味が無い」。 */
export function planManualCompact<T extends Msg>(msgs: readonly T[]): CompactPlan | null {
  const body = bodyMessages(msgs)
  const cur = currentSummary(msgs)
  const from = cur?.upTo ?? 0
  const to = body.length - MANUAL_KEEP_MESSAGES
  if (to - from < MANUAL_MIN_FOLD) return null
  return { from, to, base: cur?.text ?? null, mark: markOf(body[to - 1]) }
}

/** いま「🗂 まとめる」を押せるか。**押しても何も起きないボタンは出さない**（掟5）。 */
export function canCompactNow<T extends Msg>(msgs: readonly T[]): boolean {
  return planManualCompact(msgs) !== null
}

/** 「実際にやったこと」の記録として残す行（書き込み・実行だけ。読んだだけの行は残さない）。 */
const WORK_MARKS = ['✏️', '⚡']

/** 実況の吹き出しから、書き込み・実行の行だけを取り出す。 */
export function workLines(content: string): string[] {
  return (content ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => WORK_MARKS.some(mark => l.startsWith(mark)))
}

/**
 * まとめの材料を、元の並びのまま取り出す。
 *
 * 本文だけでなく **書き込み・実行の実況も混ぜる**（2026-08-20 実測）。
 * 実況は本文より多いことがあり（landingTEST は本文95件に対し実況82件）、
 * そこにしか「どのファイルを変えたか」が残っていない。実況はAIへ直接は送らない決まりなので、
 * **まとめを作るときだけ**材料として使う。
 */
export function compactSource<T extends Msg>(msgs: readonly T[], from: number, to: number): T[] {
  const out: T[] = []
  let bi = 0
  for (const m of msgs ?? []) {
    if (!m || m.summary) continue
    if (m.toolNote) {
      if (bi >= from && bi < to && workLines(m.content).length > 0) out.push(m)
      continue
    }
    if (bi >= from && bi < to) out.push(m)
    bi++
  }
  return out
}

/** 材料を、読みやすい書き起こしにする（1件ずつ切詰め済み）。 */
export function transcript<T extends Msg>(items: readonly T[]): string {
  const out: string[] = []
  for (const m of items ?? []) {
    if (m.toolNote) {
      for (const l of workLines(m.content)) out.push(`🛠 ${l}`)
      continue
    }
    const imgs = m.images?.length ? `（画像${m.images.length}枚を添付）` : ''
    out.push(`${m.role === 'user' ? '🧑 利用者' : '🤖 AI'}: ${imgs}${capMessage(m).content}`)
  }
  return out.join('\n\n')
}

/** まとめを頼むときの文面（system / user）。 */
export function compactPrompt<T extends Msg>(base: string | null, chunk: readonly T[]): { system: string; user: string } {
  // 文字数の上限は**指示しない**。以前は「1200文字以内」と書いていたため、モデルが
  // 延々と文字数を数え（"Check char count" "I will rewrite and count"）、
  // 数え終わる前に出力の上限に達していた（2026-08-20 実機）。長さは Koto 側で頭打ちにする。
  const system =
    'あなたは会話の記録係です。利用者とAIのやり取りを、**あとで作業を続けられるように**日本語でまとめます。\n\n'
    + '出力の形（厳守）:\n'
    + `・1行目に「${SUMMARY_HEADING}」とだけ書き、2行目から本文を書く。\n`
    + '・本文は箇条書き。簡潔に、多くても20項目まで。\n'
    + '・考えた過程・前置き・感想は書かない。まとめ本文だけを出す。\n\n'
    + '入れること:\n'
    + '・決まったこと\n'
    + '・作った/変えたファイル名（「🛠」で始まる行は、AIが実際に行った操作の記録）\n'
    + '・利用者の好みや指示\n'
    + 'まだ終わっていないこと\n\n'
    + 'やらないこと:\n'
    + '・書かれていないことを足さない。推測や提案は書かない。'
  const user = (base ? `# これまでのまとめ\n${base}\n\n` : '')
    + `# 追加のやり取り\n${transcript(chunk)}\n\n`
    + (base
      ? '上の2つを1つのまとめに書き直してください。'
      : '上のやり取りをまとめてください。')
  return { system, user }
}

/** 2桁ゼロ詰め（日付の組み立て用）。 */
const two = (n: number) => String(n).padStart(2, '0')

/**
 * まとめを「資料」としてプロジェクトに残すときの置き場所（プロジェクトからの相対パス）。
 *
 * ── なぜ「素材（公開しません）」なのか（2026-08-20 Ryosuke 提案）──────────
 * まとめは**アプリの一部ではない**（会話の記録）。プロジェクト直下に置くと
 * そのまま公開物に入る。`MATERIALS_DIR` は publishExclude.ts の一元定義で、
 * **公開・配布のどの経路からも除かれる**ことがテストで固定されている。
 *
 * 同じ分のうちに2回押しても上書きしないよう、秒まで名前に入れる。
 */
export function summaryFilePath(now: Date): string {
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
    + `-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  return `${MATERIALS_DIR}/まとめ-${stamp}.md`
}

/** 資料として残すファイルの中身。**何のファイルかを先頭に書いておく**（あとで見て分かるように）。 */
export function summaryFileBody(text: string, now: Date): string {
  const when = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} `
    + `${two(now.getHours())}:${two(now.getMinutes())}`
  return [
    `# ここまでのまとめ（${when}）`,
    '',
    'Koto が会話のまとめとして書き出したものです。',
    `**アプリでは使いません。**（「${MATERIALS_DIR}」の中身は公開されません）`,
    '',
    text.trim(),
    '',
  ].join('\n')
}

/**
 * モデルの返事をまとめ本文として受け入れられるか。
 * **目印（SUMMARY_HEADING）の最後の出現から後ろだけ**を採る。
 * 目印が無い・短すぎるものは受け取らない（null）。
 */
export function acceptSummary(raw: string): string | null {
  const t = (raw ?? '').trim()
  if (!t) return null
  const at = t.lastIndexOf(SUMMARY_HEADING)
  if (at < 0) return null
  const body = t.slice(at + SUMMARY_HEADING.length).trim()
  if (body.length < MIN_SUMMARY_CHARS) return null
  return body.length > MAX_SUMMARY_CHARS ? body.slice(0, MAX_SUMMARY_CHARS) + '\n…（以下略）' : body
}
