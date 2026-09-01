// approvalStore.ts — 承認（approveToolCall）の main 側マネージャ（B'-3d-3・掟10）。
// electron 非依存の純粋なロジックで、単体テストの対象（tests/approvalStore.test.ts）。
//
// ── なぜ要るか ─────────────────────────────────────────────────────
// これまで承認は turnRunner.ts が askBridge 経由で renderer へ ask（'approveToolCall'）
// していた。ask は renderer（窓）が生きていることが前提なので、窓を閉じる・リロードすると
// turnRunner.ts の `wc.once('destroyed')`/`did-navigate` → `bridge.rejectAll(...)` で
// 未回答の承認ごとターンが死んでいた。
//
// ここからは承認を askBridge から完全に外し、この専用マネージャ（main のメモリ）が持つ。
// **タイムアウトしない**——窓が何時間閉じていても、答えが来るまで待ち続ける（駐機）。
// 窓が閉じている間は誰も答えられないだけで、ターン自体は生きたまま止まっている。
// 画面が（再）起動したら `listPending()` で取りこぼしを回収し、答えが来れば
// `answerApproval()` で解決する（掟11「環境の独立」の窓またぎ版）。
//
// 要否判定・文面組み立て（何を・どう聞くか）はここでは行わない——それは
// src/shared/approvalPlan.ts の純関数（planApproval）の仕事。ここは「聞いて、待って、
// 答えを届ける」帳簿の管理だけに専念する（askBridge.ts と同じ役割分担）。

/** 承認待ちの1件（renderer に見せる形。resolve は含まない）。 */
export type PendingApproval = {
  id: string
  /** このターンが縛られているプロジェクト（null=単独チャット・ChatApp。今回は実質発生しない）。 */
  dir: string | null
  /** ダイアログに出す文面（src/shared/approvalPlan.ts の planApproval が組み立てたもの）。 */
  label: string
}

/** 帳簿の内部表現。renderer には見せない turnId（将来ターン単位で扱うときの備え・今回は未使用）と
 *  resolve を PendingApproval に足したもの。 */
type PendingEntry = PendingApproval & { turnId: string; resolve: (approved: boolean) => void }

/** id の採番。askBridge.ts の nextCallId と同じ形（連番＋乱数。衝突しなければ形は問わない）。 */
let seq = 0
function nextId(): string {
  seq += 1
  return `${seq}-${Math.random().toString(36).slice(2)}`
}

const pending = new Map<string, PendingEntry>()

/** 一覧が変わるたび呼ばれる通知先（ipc/approval.ts が approval:changed として renderer へ配線する）。
 *  learningStore.ts の listener と同じ形。テストでは差し替える（setApprovalListener(null) で外す）。 */
let listener: ((list: PendingApproval[]) => void) | null = null
export function setApprovalListener(fn: ((list: PendingApproval[]) => void) | null): void {
  listener = fn
}

/** 呼び出し側が resolve・turnId に触れないよう、それらを除いた写しを返す（learningStore.ts の
 *  snapshot と同じ理由）。 */
function toPublic({ resolve: _resolve, turnId: _turnId, ...rest }: PendingEntry): PendingApproval {
  return rest
}

function snapshot(): PendingApproval[] {
  return Array.from(pending.values()).map(toPublic)
}

function notify(): void {
  listener?.(snapshot())
}

/**
 * 承認を求め、答え（許可=true／拒否=false）が来るまで待つ Promise を返す。
 * **タイムアウトしない**（窓が閉じていても、answerApproval が呼ばれるまでずっと待つ＝駐機）。
 */
export function requestApproval(entry: { turnId: string; dir: string | null; label: string }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const id = nextId()
    pending.set(id, { id, turnId: entry.turnId, dir: entry.dir, label: entry.label, resolve })
    notify() // 新しい保留を push（窓が生きていれば、その場でダイアログが出る）
  })
}

/**
 * renderer からの回答を帳簿へ反映し、待っている Promise を解決する。
 * 知らない id・二重回答（1回目で既に帳簿から消えている）は false を返して無視する
 * （askBridge.ts の answer と同じ形）。
 */
export function answerApproval(id: string, approved: boolean): boolean {
  const entry = pending.get(id)
  if (!entry) return false
  pending.delete(id)
  entry.resolve(approved)
  notify() // 一覧から消えたことを push（窓が生きていればダイアログが閉じる）
  return true
}

/** 現在の承認待ち一覧（画面が（再）起動したときの取りこぼし回収に使う・approval:list の実体）。 */
export function listPending(): PendingApproval[] {
  return snapshot()
}

/** テスト用: 帳簿とリスナーを空にリセットする。本番コード（main.ts・ipc/approval.ts）はこれを呼ばない。 */
export function resetApprovalsForTest(): void {
  pending.clear()
  listener = null
  seq = 0
}
