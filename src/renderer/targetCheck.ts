// targetCheck.ts — 公開先を変えたあとの「この公開先で動くか」の確認。
//
// 公開先を変えただけでは AI へ何も送らない。変えたあとにチャットへ出すのは吹き出し1つで、
// 必要なときだけ「この公開先で動くか AI に確かめる」ボタンを添える。AI へ送るのは、そのボタンを
// 押したときの1回だけ（runTargetCheck）。
//
// 外との出入り（ファイルの読み書き・吹き出し・送信）はすべて ports で受けるので、
// 偽の ports を渡せば「呼ばれた要求の一覧」を検査できる（electron・DOM 非依存）。

import { getTargetProfile, hasTargetConstraint, shouldOfferTargetCheck } from './targetProfiles'
import { isChatUsable } from './claudeMode'
import { buildPublishStatusRows, parseApprunLegacy, formatPublishedAt, isStale, type PublishMeta, type PublishStatusRow } from './publishStatus'

/** 吹き出しのボタンに出す文。ボタンは、その場で今の公開先を確かめるときだけ使う。 */
export const TARGET_CHECK_BUTTON_LABEL = 'この公開先で動くか AI に確かめる'

/** 公開後にコードが変わっているときに、実績ありの吹き出しへ添える一言。 */
export const TARGET_CHECK_STALE_NOTE = '※ 公開後にコードが変更されています。'

/** ほかのプロジェクトで AI が作業中のため、ボタンを押しても送らなかったときの一言。 */
export const TARGET_CHECK_OTHER_BUSY_NOTE = 'ℹ️ ほかのプロジェクトで AI が作業中です。終わってから、もう一度押してください。'

/** 公開先を変えたことを知らせる吹き出し。`offerTargetCheck` が付いたものだけがボタンを持つ。 */
export interface TargetCheckBubble {
  role: 'assistant'
  content: string
  offerTargetCheck?: true
}

/** 公開先の変更の知らせ。`dir` は変更したプロジェクト（別のプロジェクトの会話に出さないための印）。 */
export interface TargetChangedDetail {
  target?: string
  dir?: string
}

export interface TargetCheckPorts {
  readFile(path: string): Promise<string>
  latestChangeAt(dir: string): Promise<{ ok: boolean; latest: string | null }>
  /** 開いているプロジェクトの会話へ吹き出しを足す */
  appendBubble(msg: TargetCheckBubble): void
  /** プロジェクトの文脈（公開先の前提つき）を読み直す。送る前に呼ぶ */
  refreshProjectContext(dir: string): Promise<void>
  /** 会話へ送る（利用者が打ったのと同じ扱いで吹き出しに並ぶ） */
  send(text: string, images: string[]): unknown
  /** いま開いているプロジェクト。待っている間に切り替わったかを見るため、値でなく呼ぶたびに返す */
  currentDir(): string | null | undefined
  /** 応答中か。押した時点と、送る直前の2回見る */
  isBusy(): boolean
  /**
   * ほかのプロジェクトで AI が動いていて、いま送るとその作業を止めてしまうか。
   * Claude は同時に1つの作業しか持てず、新しく始めると動いているものを黙って止めるため、
   * 送り先が Claude のときだけ真になりうる。押した時点と、送る直前の2回見る。
   */
  otherProjectBusy(): boolean
  keys(): { apiKey: string | null | undefined; claudeActive: boolean }
}

/** AI へ送る依頼文。利用者の発言として吹き出しに並ぶので、内部の名前は使わず短い言葉で書く。 */
export function buildTargetCheckPrompt(label: string): string {
  return (
    `公開先を「${label}」に変更しました。今のコードがこの公開先でそのまま動くか確認してください。` +
    '結論を先に一言で述べてください: ' +
    '「✅ そのまま動きます」／「✅ そのまま動きます（任意の改善あり）」／「⚠️ このままでは動きません」。' +
    '⚠️ は動かない確実な根拠（必須ファイルの欠落・この環境が対応しない言語など）がある場合だけにし、' +
    '動くけれど理想形でない点は「任意の改善」として1〜2行で簡潔に添えるだけにしてください。' +
    '公開先の設定で吸収できる事柄は「動かない根拠」にしないでください。' +
    '対応が必要な場合は、既存ファイルの書き換えではなく不足ファイルの追加を優先した最小の提案をし、私の承認を待ってから実行してください。'
  )
}

/** 公開の実績がない公開先へ変えたときの案内。 */
export function targetChangedNote(label: string): string {
  return `ℹ️ 公開先を「${label}」に変えました。公開先によっては、作り直しが要ることがあります。`
}

/** 公開の実績がある公開先へ変えたときの案内。`stale` は公開後にコードが変わっているか。 */
export function targetChangedPublishedNote(label: string, publishedAt: string | null, stale: boolean): string {
  const when = formatPublishedAt(publishedAt) ?? ''
  return (
    `✅ 公開先を「${label}」に変更しました。この公開先には${when ? `${when} に` : ''}公開した実績があります。今のコードのまま【公開】から再公開できます。` +
    (stale ? `\n${TARGET_CHECK_STALE_NOTE}` : '')
  )
}

async function readJson(path: string, ports: TargetCheckPorts): Promise<unknown> {
  try { return JSON.parse(await ports.readFile(path)) } catch { return null }
}

/** いまの公開先（`.sakuraide.json` の target）。読めない・文字列でないときは null。 */
async function readCurrentTarget(dir: string, ports: TargetCheckPorts): Promise<string | null> {
  const meta = (await readJson(`${dir}/.sakuraide.json`, ports)) as { target?: unknown } | null
  return typeof meta?.target === 'string' && meta.target ? meta.target : null
}

/** その公開先に公開の実績があれば、その行。旧い構築の記録（state.json）も実績に数える。 */
async function findPublishedRow(dir: string, target: string, ports: TargetCheckPorts): Promise<PublishStatusRow | null> {
  const meta = (await readJson(`${dir}/.sakuraide.json`, ports)) as { publish?: PublishMeta } | null
  const apprunLegacy = parseApprunLegacy(await readJson(`${dir}/.sakura-cloud/state.json`, ports))
  return buildPublishStatusRows(meta?.publish, { apprunLegacy }).find(r => r.target === target) ?? null
}

/** 公開後にコードが変わっているか。判定できないときは変わっていない扱い（注記を足さない）。 */
async function isCodeChangedSince(row: PublishStatusRow, dir: string, ports: TargetCheckPorts): Promise<boolean> {
  if (row.dateUnknown) return false
  try {
    const r = await ports.latestChangeAt(dir)
    return r.ok && isStale(row.publishedAt, r.latest)
  } catch { return false }
}

/**
 * 公開先が変わった知らせを受けて、吹き出しを1つ出す。**AI へは送らない。**
 *
 * - `local`・`other`（制約が無い）: 何も出さない。
 * - 公開の実績なし: 案内。ボタンあり。
 * - 公開の実績あり: 実績の案内。公開後にコードが変わっているときだけボタンあり。
 * - 別のプロジェクトの知らせ・待つ間にプロジェクトが切り替わった: 捨てる（吹き出しを置かない）。
 */
export async function onTargetChanged(detail: TargetChangedDetail | undefined, ports: TargetCheckPorts): Promise<void> {
  const target = detail?.target
  const dir = detail?.dir
  if (!target || !hasTargetConstraint(target)) return
  if (!dir || dir !== ports.currentDir()) return
  const label = getTargetProfile(target).label
  const row = await findPublishedRow(dir, target, ports)
  const stale = row ? await isCodeChangedSince(row, dir, ports) : false
  if (dir !== ports.currentDir()) return
  const offerable = (!row || stale) && shouldOfferTargetCheck({ target, projectDir: dir, ...ports.keys() })
  const content = row ? targetChangedPublishedNote(label, row.publishedAt, stale) : targetChangedNote(label)
  ports.appendBubble({ role: 'assistant', content, ...(offerable ? { offerTargetCheck: true as const } : {}) })
}

export type RunTargetCheckResult =
  | { sent: true; dir: string; target: string }
  | { sent: false; reason: 'busy' | 'no-key' | 'other-busy' | 'no-project' | 'no-target' | 'no-constraint' | 'project-changed' | 'context-failed' }

// 送り終わる前に同じプロジェクトで押し直されても、2回送らない
const inFlight = new Set<string>()

/** ほかのプロジェクトで AI が動いているときは送らず、押したプロジェクトの会話に一言だけ出す。 */
function refuseWhileOtherBusy(dir: string, ports: TargetCheckPorts): RunTargetCheckResult | null {
  if (!ports.otherProjectBusy()) return null
  // 待つ間にほかのプロジェクトへ切り替わっていたら、一言も置かない
  if (dir === ports.currentDir()) ports.appendBubble({ role: 'assistant', content: TARGET_CHECK_OTHER_BUSY_NOTE })
  return { sent: false, reason: 'other-busy' }
}

/**
 * ボタンを押したとき: 今の公開先を `.sakuraide.json` から読み直し、その公開先で動くかを AI へ頼む（1回）。
 * 古い吹き出しのボタンを後で押しても、今の公開先の話になる。
 * 応答中・押した時点でキーが無い・ほかのプロジェクトで AI が作業中・公開先が `local`/`other`/未知/読めない・
 * プロジェクトが無い／切り替わった・文脈を読み直せないときは送らない。
 */
export async function runTargetCheck(ports: TargetCheckPorts): Promise<RunTargetCheckResult> {
  if (ports.isBusy()) return { sent: false, reason: 'busy' }
  // 古い吹き出しのボタンは、キーを消したあとにも残る。押した時点でもう一度見る（何も出さず・ボタンも隠さない）
  const { apiKey, claudeActive } = ports.keys()
  if (!isChatUsable(!!apiKey, claudeActive)) return { sent: false, reason: 'no-key' }
  const dir = ports.currentDir()
  if (!dir) return { sent: false, reason: 'no-project' }
  if (inFlight.has(dir)) return { sent: false, reason: 'busy' }
  inFlight.add(dir)
  try {
    const target = await readCurrentTarget(dir, ports)
    if (!target) return { sent: false, reason: 'no-target' }
    if (!hasTargetConstraint(target)) return { sent: false, reason: 'no-constraint' }
    const busyAtPress = refuseWhileOtherBusy(dir, ports)
    if (busyAtPress) return busyAtPress
    try { await ports.refreshProjectContext(dir) } catch { return { sent: false, reason: 'context-failed' } }
    if (dir !== ports.currentDir()) return { sent: false, reason: 'project-changed' }
    if (ports.isBusy()) return { sent: false, reason: 'busy' }
    const busyBeforeSend = refuseWhileOtherBusy(dir, ports)
    if (busyBeforeSend) return busyBeforeSend
    void ports.send(buildTargetCheckPrompt(getTargetProfile(target).label), [])
    return { sent: true, dir, target }
  } finally {
    inFlight.delete(dir)
  }
}

/** 押したあとに、そのプロジェクトのボタンを隠してよいか（送った回、またはもう確かめる意味が無い回）。 */
export function spendsTargetCheckOffer(result: RunTargetCheckResult): boolean {
  return result.sent || result.reason === 'no-constraint' || result.reason === 'no-target'
}

/** プロジェクトごとに、ボタンを最後に押した時刻（ISO）。吹き出しの `at` と比べて、押す前の吹き出しだけを隠す。 */
export type TargetCheckSpent = ReadonlyMap<string, string>

/** 押した時刻（`now`。試験で差し替えられる）を、そのプロジェクトの分として足す。元の集まりは変えない。 */
export function markTargetCheckSpent(spent: TargetCheckSpent, dir: string, now: Date = new Date()): Map<string, string> {
  return new Map(spent).set(dir, now.toISOString())
}

/**
 * 押した時刻より前の吹き出しか（隠す側か）。押した時刻が無ければ前ではない。
 * `at` が無い・読めない吹き出しは、押した時刻より前とみなす。押した時刻と同じ時刻も後ではない。
 */
function isBeforePress(pressedAt: string | undefined, at: string | undefined): boolean {
  if (pressedAt === undefined) return false
  const bubbleMs = typeof at === 'string' ? Date.parse(at) : NaN
  return !(bubbleMs > Date.parse(pressedAt))
}

/**
 * 吹き出しのボタンの見え方。`offered` は吹き出しの `offerTargetCheck`、`at` は吹き出しの時刻。
 * そのプロジェクトで押したあとは、押す前の吹き出しのボタンを隠す（押したあとに出た吹き出しには出す）。
 * 応答中は押せない。
 */
export function targetCheckButtonState(args: {
  offered: boolean | undefined
  dir: string | null | undefined
  spent: TargetCheckSpent
  isLoading: boolean
  at?: string
}): { show: boolean; disabled: boolean } {
  const { offered, dir, spent, isLoading, at } = args
  return { show: !!offered && !!dir && !isBeforePress(spent.get(dir), at), disabled: isLoading }
}
