// learningMirror.ts — モデルの「ツール対応」「画像対応」学習キャッシュの、renderer 側の写し
// （B'-3d-1a）。持ち主は main の src/main/learningStore.ts（userData/learning.json）。
//
// ── なぜ写し（ミラー）にしたか ────────────────────────────────────────
// toolSupport.ts の shouldSendTools() / visionSupport.ts の shouldTryImagesDirectly() は、
// エージェントループの中（src/shared/chatTurn.ts）や ChatPanel.tsx の表示ヒントから**同期**で
// 呼ばれる。main へ毎回 IPC 往復していては同期のままでは書けない。そこで、モジュールレベルの
// 変数（mirror）に main の内容を写し、判定はこの写しに対して行う（判定ロジック自体は
// shared/modelLearning.ts の純関数・store を引数に取る形）。
//
// ── なぜ起動時の非同期プライムで足りるか ────────────────────────────────
// 読みが必要になるのは①送信時（shouldSendTools 等）②モデル選択時③ChatPanel の表示ヒント
// （shouldTryImagesDirectly）だけで、いずれも利用者の操作（アプリ起動直後ではない）の後に
// 発生する。**初回描画の同期読み込みには使われない**ので、mirror が空のまま最初の数十ms
// レンダーされても実害は無く（判定は「未確認→楽観的に送る/試す」という既定の安全側に倒れる
// だけ）、primeLearningMirror() が learning:get の応答を受け取り次第すぐに実体で上書きされる。
import { sanitizeStore, type LearnStore } from '../shared/modelLearning'

type Mirror = { toolSupport: LearnStore; visionSupport: LearnStore }

let mirror: Mirror = { toolSupport: {}, visionSupport: {} }

/** toolSupport.ts / visionSupport.ts が判定に使う、現在の写し（コピーは取らない＝読み取り専用の
 *  利用を前提にする。書き換えは setMirrorEntry / clearMirrorEntry を必ず経由する）。 */
export function getLearningMirror(): Mirror {
  return mirror
}

/** 楽観更新: main への learning:record の返事を待たずに、その場で写しへ反映する
 *  （recordToolSupport/recordVisionSupport から呼ぶ・fire-and-forget の一部）。 */
export function setMirrorEntry(kind: 'tool' | 'vision', model: string, supported: boolean, at: number): void {
  const key = kind === 'tool' ? 'toolSupport' : 'visionSupport'
  mirror = { ...mirror, [key]: { ...mirror[key], [model]: { supported, at } } }
}

/** 楽観更新: learning:forget の返事を待たずに写しから消す。model 省略時は全消去。 */
export function clearMirrorEntry(kind: 'tool' | 'vision', model?: string): void {
  const key = kind === 'tool' ? 'toolSupport' : 'visionSupport'
  if (model === undefined) {
    mirror = { ...mirror, [key]: {} }
    return
  }
  const next = { ...mirror[key] }
  delete next[model]
  mirror = { ...mirror, [key]: next }
}

function applySnapshot(snapshot: { toolSupport: unknown; visionSupport: unknown }): void {
  mirror = { toolSupport: sanitizeStore(snapshot?.toolSupport), visionSupport: sanitizeStore(snapshot?.visionSupport) }
}

// ── 片道移行（旧 localStorage → main の learning.json）────────────────────
//
// 値そのものは renderer/toolSupport.ts の TOOL_SUPPORT_KEY・renderer/visionSupport.ts の
// VISION_SUPPORT_KEY と同じ（両ファイルが変えずに残している定数）。ここで import すると
// 「toolSupport.ts が learningMirror.ts を使う／learningMirror.ts が toolSupport.ts の定数を
// 使う」という循環importになるため、値をそのまま複製する（移行専用の一度きりの処理であり、
// 一致していることは tests/learningMirror.test.ts で固定する）。
const LEGACY_TOOL_SUPPORT_KEY = 'sakura_model_tool_support'
const LEGACY_VISION_SUPPORT_KEY = 'sakura_model_vision_support'

function readLegacy(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    return JSON.parse(raw)
  } catch {
    return undefined // 壊れたJSONは無視する（main 側の sanitizeStore もどのみち弾く）
  }
}

/**
 * 旧 localStorage の中身を main（learning.json）へ送る。**消さない**（2026-08-28以降の
 * 他の片道移行と違い、これは「壊れたら戻せる保険」を残す判断——学習キャッシュは失っても
 * 実害が小さい（次のターンでまた学習し直すだけ）ため、削除で得られる安心より、
 * 万一 learning.json 側の実装に不具合があったときに旧データが残っている安心を優先した）。
 * main 側の mergeMigration は「新しい at だけ勝つ」ため、起動のたび呼んでも安全（何度目でも
 * 結果は同じ＝冪等）。
 */
function migrateLegacyOnce(): void {
  const toolSupport = readLegacy(LEGACY_TOOL_SUPPORT_KEY)
  const visionSupport = readLegacy(LEGACY_VISION_SUPPORT_KEY)
  if (toolSupport === undefined && visionSupport === undefined) return
  window.electronAPI.learning.migrate({ toolSupport, visionSupport }).catch(() => { /* 次回起動時にまた試す */ })
}

let primed = false

/**
 * 起動時に1度だけ呼ぶ（App.tsx のマウント時 effect）。learning:get で写しを初期化し、
 * learning:changed を購読して以後の変更を反映する。window が無い環境（node のテスト）では
 * 何もしない（mirror は既定の空のまま＝shared/modelLearning.ts の判定が「未確認」として
 * 安全側に倒れる）。
 */
export function primeLearningMirror(): void {
  if (typeof window === 'undefined' || !window.electronAPI?.learning) return
  if (primed) return
  primed = true

  migrateLegacyOnce()

  window.electronAPI.learning.get()
    .then(applySnapshot)
    .catch(() => { /* 読めなくても mirror は空のまま続く。次にモデルを試したときに学習し直す */ })

  window.electronAPI.learning.onChanged(applySnapshot)
}

/** テスト用: モジュール内の状態（mirror・primed）をリセットする。 */
export function resetLearningMirrorForTest(): void {
  mirror = { toolSupport: {}, visionSupport: {} }
  primed = false
}
