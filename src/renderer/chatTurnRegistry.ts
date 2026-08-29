// chatTurnRegistry.ts — 実行状態（考えています…・⏹・入力欄のロック・routedModel）の置き場（B-1b）。
//
// ── なぜ（B-1a の続き）─────────────────────────────────────────────
// 会話の中身（吹き出し）は B-1a でプロジェクト別になった（持ち主は main の convStore.ts）。
// 一方、**実行状態**（isLoading・statusNote・routedModel・⏹・入力欄のロック）は
// useAiChat.ts の useState 1本＝画面全体で1つのままだった。そのため、ターン中に別プロジェクトへ
// 切り替えると「考えています…」が付いてきて、入力欄もロックされたまま（実機で確認）。
//
// main の turnRunner.ts は既に turnId 別に複数ターンを扱える。convStore.ts も projectDir 別。
// 残っていた「renderer の実行状態だけが全体で1つ」を、ここでプロジェクト別にする。
// 副産物として、**待っていないプロジェクトからは並列に送信できる**ようになる。
//
// ── なぜ React の外（モジュールレベルの Map）に置くか ───────────────────────
// useState はコンポーネント（useAiChat の1呼び出し）に紐づく状態で、ChatPanel は projectDir が
// 切り替わっても**同じフックインスタンスのまま**（コンポーネントは再マウントしない）。
// そのため useState では「プロジェクト別」を表現できない。ここはモジュールレベルの Map に持ち、
// React 18 の useSyncExternalStore（React の外にある値を安全に購読する標準API）で読む
// （useAiChat.ts 側の配線）。この置き場自体は React 非依存の純粋なロジックなので node でテストできる。

/** 1つの会話（プロジェクト or 単独チャット）の実行状態。 */
export type TurnState = {
  isLoading: boolean
  statusNote: string
  routedModel: string | null
  /** 応答開始時刻（経過秒の表示用）。isLoading=false のとき null。 */
  startedAt: number | null
  /** 最後にトークン・思考が届いた時刻（停滞判定用）。 */
  lastActivityAt: number
  /** 進行中の応答を止める（main へ chatTurn:abort を送る関数）。無ければ null。 */
  abort: (() => void) | null
}

/** 未登録の鍵（＝アイドル）に対して返す既定値。 */
const IDLE: TurnState = {
  isLoading: false,
  statusNote: '',
  routedModel: null,
  startedAt: null,
  lastActivityAt: 0,
  abort: null,
}

/** 単独チャット（ChatApp・プロジェクト未選択の ChatPanel）の鍵。
 *  projectDir は必ず絶対パス（'/' 始まり）なので、この文字列とは衝突しない。 */
export const CHAT_APP_KEY = '@chat-app'

/**
 * projectDir・sessionId から登録鍵を作る。
 *
 * ── なぜ sessionId を足したか（改善2・2026-08-29）─────────────────────────
 * ChatApp（単独チャット）は projectDir を持たないため、これまで全セッションが
 * `CHAT_APP_KEY` という**1つの鍵**を共有していた（B-1b はプロジェクト別化止まりで、
 * 単独チャットのセッション別化はまだだった）。そのため、あるセッションが応答中に
 * 別のセッションへ切り替えても「考えています…」が付いてきて、待っていない
 * セッションからも送信できなかった。ここを IDE（プロジェクト別）と同じ形に揃える。
 *
 * - projectDir があれば、それをそのまま鍵にする（**プロジェクトが最優先**。IDEモードでは
 *   sessionId を渡さない＝ChatPanel の呼び出しは変えない・注意参照）。
 * - projectDir が無く、sessionId があれば `${CHAT_APP_KEY}:${sessionId}`（単独チャットの
 *   セッション別の鍵）。
 * - どちらも無ければ、従来どおり `CHAT_APP_KEY`（互換のため残す。sessionId 無しの
 *   呼び出しがあっても壊れない）。
 */
export function turnKey(projectDir: string | null | undefined, sessionId?: string): string {
  // ?? のままにする（旧実装と同じ意味）: projectDir が null/undefined のときだけ次を見る。
  // 空文字はここでは来ない想定だが、来ても projectDir 優先を崩さない（truthy 判定にしない）。
  if (projectDir !== null && projectDir !== undefined) return projectDir
  if (sessionId) return `${CHAT_APP_KEY}:${sessionId}`
  return CHAT_APP_KEY
}

const turns = new Map<string, TurnState>()
const listeners = new Set<() => void>()
let version = 0

function notify(): void {
  version++
  for (const listener of listeners) listener()
}

/** 鍵の実行状態を読む。未登録なら既定値（アイドル）を返す。 */
export function getTurn(key: string): TurnState {
  return turns.get(key) ?? IDLE
}

/**
 * 鍵の実行状態の一部を書き換える。変更のたび listener を全部呼ぶ。
 *
 * ── 例外: lastActivityAt **だけ**の更新は通知しない（2026-08-28・実測で発見）──────
 * lastActivityAt はストリーミングの**トークンごと**に更新される。これを通知すると、
 * registry を購読している部品（Sidebar の ⏳ など）が**毎トークン再描画**され、
 * ストリーミング中はプロジェクトメニューの実体が差し替わり続ける（開いたメニューが
 * チラつく・操作を取りこぼす）。lastActivityAt を読むのは停滞判定の毎秒ポーリング
 * （useAiChat の effect）だけで、**通知に依存する読み手がいない**ので静かに書く。
 */
export function updateTurn(key: string, patch: Partial<TurnState>): void {
  const cur = turns.get(key) ?? IDLE
  turns.set(key, { ...cur, ...patch })
  const keys = Object.keys(patch)
  if (keys.length === 1 && keys[0] === 'lastActivityAt') return
  notify()
}

/**
 * ターン終了時、その鍵をアイドルへ戻す。
 *
 * ── なぜ routedModel だけは引き継ぐか ────────────────────────────────
 * routedModel は「この**会話**でツール作業のため切り替えた割り振り先」（ターン単位ではなく
 * 会話単位の状態）。ここで無条件に消すと、1ターン終えるたびに割り振りが消えて、次のメッセージで
 * また同じ再割り振りが起きてしまう（従来から routedModel はターン終了時にリセットしていなかった
 * ＝ useAiChat.ts の emit の 'loading' 分岐は isLoading だけを触っていた）。それ以外
 * （isLoading・statusNote・startedAt・abort）は、そのターン固有の実行中の印なので素直にアイドルへ戻す。
 */
export function resetTurn(key: string): void {
  const cur = turns.get(key) ?? IDLE
  turns.set(key, { ...IDLE, routedModel: cur.routedModel })
  notify()
}

/** どれか1つでも実行中か（使うかは呼び出し側の判断）。 */
export function isAnyLoading(): boolean {
  for (const t of turns.values()) if (t.isLoading) return true
  return false
}

/** 実行中の鍵の一覧（⏳ の印用）。 */
export function loadingKeys(): string[] {
  const keys: string[] = []
  for (const [key, t] of turns) if (t.isLoading) keys.push(key)
  return keys
}

/** useSyncExternalStore 用の購読口。変更のたびに listener を呼ぶ。 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** useSyncExternalStore 用の版数。変更のたびに増える（同一性判定用。実際の値は getTurn で読み直す）。 */
export function getSnapshot(): number {
  return version
}
