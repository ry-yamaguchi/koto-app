// servicePrincipalCandidates.ts — AppRun 専有型 ②「サービスプリンシパルの用意」で、
// 「前のプロジェクトで使った ID」を候補として集める純関数（electron・DOM 非依存。Vitest 対象）。
//
// ── なぜ要るか（作者 Ryosuke さん・2026-10-06）────────────────────────────────
// ②のリソースID（12桁）は、Koto の**プロジェクトごとの記録**（.sakuraide.json の
// publish.apprunDedicated.servicePrincipalId）に保存している。新しいプロジェクトで専有型を開くと
// 欄が空になり、「バージョンアップで消えたのでは」と感じさせた。ところが画面の説明は
// 「使い回せるので最初の一度だけ」と言っていて、実際の動き（プロジェクトごとに入力）と合っていなかった。
// 作者の決定: 前に使った ID を自動で入れておく。新しく作るリンクと、複数あるときの選択も付ける。
//
// ── 掟11（環境の独立）との関係 ─────────────────────────────────────────────────
// 「ある環境のものを、別の環境の画面に出さない」が原則で、ここは**ほかのプロジェクトの記録を読んで
// この画面に出す**。例外にしてよい理由は3つ:
//   1. サービスプリンシパルは**さくらのクラウドの「プロジェクト」の資源**であって、Koto の
//      プロジェクトの中身ではない（公式マニュアル「サービスプリンシパルはプロジェクトのリソースです」
//      https://manual.sakura.ad.jp/cloud/controlpanel/service-principal.html ・更新 2026-07-09 の
//      「プロジェクト」はさくらのクラウドのプロジェクトで、Koto のプロジェクトとは別のもの。
//      原本は「アカウント」とは書いていない。「別のアカウントの ID は使えない」は、そのアカウントの
//      プロジェクトも別のプロジェクトになる、という読みで添えている）。
//   2. 作者が決めたこと（2026-10-06）。
//   3. 出すのは **ID とプロジェクト名だけ**で、秘密ではない（APIキーでも鍵でもない）。
// 吹き出し・実行状態・承認ダイアログ・エラーのような「中身」は、これまでどおり持ち場に留める。
// ここは**読むだけ**で、ほかのプロジェクトの記録を書き換えない。

import { servicePrincipalIdOf } from './publishMeta'

/**
 * サービスプリンシパルID（リソースID）の形: **12桁の数字**。この定義は**ここ1つだけ**（掟10）。
 * ②の入力欄の「✓ 形は合っています」・候補に入れてよいか（collectServicePrincipalCandidates）・
 * クラスタ作成の入口の検証（main の validateClusterSpec・apprunDedicatedApply.ts）が、すべてここから引く。
 *
 * 以前は、画面と候補集めは「12文字」（長さだけ）、main の作成入口は `/^\d{12}$/`（12桁の数字）と**2つあった**。
 * 12文字だが数字でない ID は、画面では「✓ 形は合っています」と出るのに main に拒否され、しかも
 * ⑤の作成の直前に記録へ保存されるため、次のプロジェクトで候補として自動入力されて持ち越された
 * （2026-10-06 検分の指摘）。**厳しいほう（main がすでに強制していた形）に揃えた**ので、画面が通す ID は
 * 従来から作成の入口も通る。
 *
 * 補足（原本）: apprun-dedicated-api.json の `ServicePrincipalID` は `type: string, minLength: 12, maxLength: 12`
 * （数字とは書いていない。例は "123456789012"）。さくらのクラウドのリソースIDが12桁の数字であることは
 * 実機の ID で確かめてきた範囲の話で、原本が保証する形ではない。数字以外の ID が現れたら、
 * **ここだけ**を直す（画面・候補・main が一緒に変わる）。
 */
export const SERVICE_PRINCIPAL_ID_RE = /^\d{12}$/

/** `SERVICE_PRINCIPAL_ID_RE` に合うか（前後の空白は落とさない。落とすのは呼び出し側）。 */
export function isServicePrincipalId(v: string): boolean {
  return SERVICE_PRINCIPAL_ID_RE.test(v)
}

/**
 * リソースID（サービスプリンシパルID）の形式チェック。**12桁の数字かどうか**だけを見る。
 * 実在するかどうかはここでは確認できない（IAM APIが通常のAPIキーでは使えないため・実測403）。
 *
 * ②の入力欄の「✓ 形は合っています」の判定と、候補に入れてよいかの判定の**唯一の入口**
 * （掟10: 同じ判定を書き写さない。もとは AppRunDedicatedPanel.tsx にあったものをここへ移した）。
 */
export function resourceIdFormatOk(raw: string): boolean | null {
  const v = raw.trim()
  if (!v) return null
  return isServicePrincipalId(v)
}

/** 候補1つ分: 同じ ID を記録している全プロジェクトをまとめたもの。 */
export interface ServicePrincipalCandidate {
  /** 12桁の数字のID（前後の空白は落としてある）。 */
  id: string
  /** この ID を記録しているプロジェクト名。記録が新しいプロジェクトが先。重複なし。 */
  projectNames: string[]
  /**
   * そのうちいちばん新しい記録の更新時刻（ミリ秒）。分からなければ null。
   * **.sakuraide.json 全体のファイルの更新時刻**であって、ID を入れた時刻ではない（公開・名前変更など
   * 何かの書き込みでも進む）。「新しい順」はその近似で、先頭が「いちばん最近使った ID」とは限らない
   * （2026-10-06 検分の指摘。画面の印も「いちばん最近更新された記録」と、実際の意味で書く）。
   */
  updatedAtMs: number | null
}

const UNKNOWN_PROJECT_NAME = '（名前不明）'

/** 末尾の / を落とす（比べるためだけ。ルート "/" はそのまま）。 */
function normalizeDir(p: string): string {
  const t = p.replace(/\/+$/, '')
  return t === '' ? p : t
}

function lastSegment(dir: string): string {
  const parts = normalizeDir(dir).split('/')
  return parts[parts.length - 1] ?? ''
}

function finiteNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 新しい順（null は最後）。 */
function newerFirst(a: number | null, b: number | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return b - a
}

/**
 * ワークスペース内の全プロジェクトの記録（main の `fs:publishedRecords` の `projects`）から、
 * 空でない servicePrincipalId を集める。
 *
 * - 同じ ID は1つにまとめ、使っているプロジェクト名を束ねる（記録が新しいプロジェクトが先・重複なし）。
 * - 新しい順（いちばん新しい記録の更新時刻。分からないものは最後）に並べる。同じなら
 *   使っているプロジェクトが多いほうが先、それも同じなら ID の昇順（結果が毎回同じになるように）。
 * - **現在のプロジェクト自身は除く**（`currentProjectDir` と同じフォルダの記録）。
 * - 12桁の数字でないものは候補にしない（`resourceIdFormatOk` と同じ判定）。
 * - 入力は信用しない: 配列でない・要素がオブジェクトでない・`publish` が無い・形が違う、はすべて
 *   黙って飛ばす（壊れた記録 1 件で候補の一覧ごと落とさない）。
 */
export function collectServicePrincipalCandidates(records: unknown, currentProjectDir: string): ServicePrincipalCandidate[] {
  if (!Array.isArray(records)) return []
  const self = normalizeDir(currentProjectDir)
  const byId = new Map<string, { name: string; at: number | null }[]>()

  for (const rec of records) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue
    const r = rec as Record<string, unknown>
    const dir = typeof r.dir === 'string' ? r.dir : ''
    if (dir && normalizeDir(dir) === self) continue // 自分自身

    const raw = servicePrincipalIdOf(r.publish)
    if (raw === null) continue
    const id = raw.trim()
    if (resourceIdFormatOk(id) !== true) continue

    const nameField = typeof r.name === 'string' ? r.name.trim() : ''
    const name = nameField || (dir ? lastSegment(dir) : '') || UNKNOWN_PROJECT_NAME
    const list = byId.get(id) ?? []
    list.push({ name, at: finiteNumberOrNull(r.metaUpdatedAtMs) })
    byId.set(id, list)
  }

  const out: ServicePrincipalCandidate[] = []
  for (const [id, projects] of byId) {
    const sorted = [...projects].sort((a, b) => newerFirst(a.at, b.at) || a.name.localeCompare(b.name, 'ja'))
    const names = Array.from(new Set(sorted.map(p => p.name)))
    const times = projects.map(p => p.at).filter((t): t is number => t !== null)
    out.push({ id, projectNames: names, updatedAtMs: times.length > 0 ? Math.max(...times) : null })
  }
  out.sort((a, b) =>
    newerFirst(a.updatedAtMs, b.updatedAtMs)
    || b.projectNames.length - a.projectNames.length
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

/** プロジェクト名を画面に並べる形にする（3つまで。超えたら「ほかN件」）。 */
export function formatProjectNames(names: readonly string[], max = 3): string {
  if (names.length <= max) return names.join('・')
  return `${names.slice(0, max).join('・')}ほか${names.length - max}件`
}

/**
 * このプロジェクトの記録に ID が**無い**ときだけ、候補を探す（出す・入れる）。
 * 記録にあるときは、それがこのプロジェクトの正（候補で上書きしない・他の ID を並べて迷わせない）。
 */
export function needsServicePrincipalCandidates(savedId: string | null | undefined): boolean {
  return !(typeof savedId === 'string' && savedId.trim() !== '')
}

/** ②の画面に出す内容: 候補の一覧と、欄へ最初から入れておく ID（入れないなら null）。 */
export interface ServicePrincipalPrefillPlan {
  candidates: ServicePrincipalCandidate[]
  fillId: string | null
}

/**
 * 候補をどう出すかを決める（**ファイルへは書かない**。決めるだけ）。
 * - 記録に ID がある → 何も出さない・何も入れない。
 * - 候補が 0 → 何も出さない（いまと同じ・欄は空）。
 * - 候補が 1 → その ID を入れる。
 * - 候補が 2 以上 → 一覧で選べるようにし、既定は先頭（いちばん新しいもの）を入れる。
 * `candidates` は collectServicePrincipalCandidates の結果（新しい順）。
 */
export function planServicePrincipalPrefill(
  savedId: string | null | undefined,
  candidates: readonly ServicePrincipalCandidate[],
): ServicePrincipalPrefillPlan {
  if (!needsServicePrincipalCandidates(savedId) || candidates.length === 0) return { candidates: [], fillId: null }
  return { candidates: [...candidates], fillId: candidates[0].id }
}

/** 候補が1つで、欄へ自動で入れたときに添える一文。 */
export function singlePrefillNote(c: ServicePrincipalCandidate): string {
  return `前のプロジェクト（${formatProjectNames(c.projectNames)}）で使った ID を入れました。違うときは書き換えてください。`
}

/**
 * ②の入力欄の下に、**候補が0件のときも含め、どの場合も**添える一文（仕様「どの場合も一言添える」の
 * 文字どおりの読み。0件でも、利用者が別のところから持ってきた ID を自分で貼ることがあるため）。
 *
 * 制約の単位は**プロジェクト**。サービスプリンシパルは「さくらのクラウドのプロジェクト」の資源で、
 * 別のプロジェクトで作ったものは、別のアカウントのものだけでなく**同じアカウントの別のプロジェクト**
 * （別のAPIキー）のものでも、このキーの側からは使えない。出典は公式マニュアル
 * https://manual.sakura.ad.jp/cloud/controlpanel/service-principal.html の注意書き
 * 「サービスプリンシパルはプロジェクトのリソースです。他のプロジェクトに権限を持つようなIAMポリシーの
 * 設定を行ったとしても操作はできない仕様」（更新 2026-07-09。原本は「アカウント」とは書いていない）。
 */
export const ACCOUNT_MISMATCH_NOTE =
  '※ 別のさくらのアカウント、または別のプロジェクトで作った ID は使えません（サービスプリンシパルは、さくらのクラウドの「プロジェクト」のリソースです）。'
