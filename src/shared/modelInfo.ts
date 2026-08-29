// modelInfo.ts — さくらのAI Engine のモデル情報のうち、window/localStorage/electron に
// 依存しない純粋な部分（renderer の usage.ts / visionSupport.ts から実体を移した）。
//
// なぜ shared にあるか（B'-3b）: 次の段で main プロセスで動くループ（chatTurn.ts）の
// ports.h を、renderer からも main からも同じ実装で組み立てられるようにするため。

/** 利用可能なモデル（UI表示用ラベル付き） */
// ============================================================================
// 【メンテナンス】さくらのAI Engine の提供モデル・単価の変化に追従すること
//   1. 差分チェック:  SAKURA_API_KEY=<キー> npm run check:models
//      → 提供モデルと下記 MODELS/VISION_MODELS/PRICING を突き合わせ、
//        新規モデル／提供終了／価格未設定 を一覧表示する（scripts/check-models.mjs）
//   2. 公開単価はさくらの情報で確認（APIから取れないため手動）:
//      https://ai.sakura.ad.jp/sakura-ai/ai-engine/ ／ コントロールパネルの提供モデル
//   3. 差分を MODELS / VISION_MODELS / PRICING に反映し、DEFAULT_MODEL を
//      「その時点でコード作成に最も適したモデル」に見直す
//   最終確認: v0.1.0（2026-06 時点の最適は Qwen3-Coder-480B-A35B-Instruct-FP8）
// ============================================================================

// さくらのAI Engine のモデルID（「Qwen/」等のプレフィックスは付かない）
export const MODELS: { id: string; label: string }[] = [
  { id: 'Qwen3-Coder-480B-A35B-Instruct-FP8', label: 'Qwen3-Coder 480B' },
  { id: 'Qwen3-Coder-30B-A3B-Instruct', label: 'Qwen3-Coder 30B' },
  { id: 'gpt-oss-120b', label: 'GPT-OSS 120B' },
  { id: 'llm-jp-3.1-8x13b-instruct4', label: 'llm-jp 3.1 8x13b（日本語）' },
  // 2026-07-14 ユーザー実測（probe-models.mjs）で tools=ok を確認しツール（ファイル参照）対応に昇格。
  { id: 'preview/Kimi-K2.6', label: 'Kimi K2.6（プレビュー）' },
]

/** マルチモーダル（画像入力）対応モデル（さくらのAI Engine パブリックプレビュー） */
export const VISION_MODELS: { id: string; label: string }[] = [
  { id: 'preview/Qwen3-VL-30B-A3B-Instruct', label: 'Qwen3-VL 30B（画像対応・プレビュー）' },
  { id: 'preview/Phi-4-multimodal-instruct', label: 'Phi-4 マルチモーダル（プレビュー）' },
]

export function modelLabel(id: string): string {
  return [...MODELS, ...VISION_MODELS].find(m => m.id === id)?.label ?? id
}

const VISION_IDS = new Set(VISION_MODELS.map(m => m.id))

/** モデルが画像入力に対応しているか（ID命名からも推定）。
 *  kimi-k2.6: 2026-07-14 ユーザー実測（verify-vision.mjs）で画像を直接読めることを確認（content に回答）→
 *  画像添付時に2段階処理（Qwen3-VLで読み取り→本来モデルで実行）を挟まず、そのまま読ませる。
 *  ※ 提供終了した K2.5 と区別するためバージョンまで含めて判定する。
 *  ── B'-3d-1a で renderer/usage.ts からここ（shared）へ移した。main のターン実行
 *  （turnRunner.ts の vision.defaultModel）と renderer の両方が使うため。**複製しないこと**
 *  （掟10: 片方だけ直されて、ずれても誰も気づかない）。 */
export function isVisionModel(id: string): boolean {
  return VISION_IDS.has(id) || /-VL-|multimodal|kimi-k2\.6/i.test(id)
}

// 画像送信時に既定で使うvisionモデル（コード理解も得意な Qwen3-VL を優先）。isVisionModel と同じ理由で shared に置く。
export const DEFAULT_VISION_MODEL = 'preview/Qwen3-VL-30B-A3B-Instruct'

// IDE（コード/エージェント）は品質重視、チャット（会話/調査）は速度重視を既定にする。
// ※ バージョンアップ時は npm run check:models / probe:models で見直すこと
export const DEFAULT_MODEL = 'Qwen3-Coder-480B-A35B-Instruct-FP8'   // IDE 既定（コード最適）

/**
 * 提供中のモデル一覧から「コード作成に最適な」モデルを選ぶ。
 * 既定モデルが提供終了した場合のフォールバックに使う（Coder系 → Qwen3系 → 先頭）。
 */
export function pickBestModel(ids: string[]): string {
  if (!ids.length) return DEFAULT_MODEL
  return (
    ids.find(id => /coder/i.test(id) && /480/.test(id)) ??
    ids.find(id => /coder/i.test(id)) ??
    ids.find(id => /^qwen3/i.test(id)) ??
    ids[0]
  )
}

/** 大まかなトークン見積り（APIがusageを返さない場合のフォールバック）。 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let tokens = 0
  for (const ch of text) tokens += ch.charCodeAt(0) > 0x7f ? 1 : 0.25
  return Math.ceil(tokens)
}

/**
 * 「このモデルは画像を受け付けない」というサーバーの返事か（純関数）。
 *
 * **見分けられないものを非対応と決めつけない。** 通信エラーや混雑（429・500）で
 * 記録してしまうと、対応しているモデルが二段構えのまま固定される。
 */
export function isImageUnsupportedError(message?: string): boolean {
  const m = String(message ?? '')
  if (/\b(429|500|502|503|504)\b|timeout|network|ECONN/i.test(m)) return false
  return /image|vision|multimodal|image_url|content type|not support.*image|画像.*(対応|使えま)/i.test(m)
}
