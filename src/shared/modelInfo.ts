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
//   最終確認: v0.1.0（2026-06 時点の最適は旧世代のコード特化480Bモデル）
//   2026-09-04 見直し: 旧世代のコード特化モデル（480B/30B）が提供終了。check:models 実測で
//     8モデルへ世代交代（詳細は下の MODELS のコメント）。
// ============================================================================

// さくらのAI Engine のモデルID（「Qwen/」等のプレフィックスは付かない）
// 2026-09-04 世代交代: 旧世代のコード特化モデル（480B版・30B版の2件）は提供終了
// （480B は実 API で「This model is not available」を確認）。check:models 実測の
// 提供モデルへ置き換えた。tools 実測（probe-models.mjs）: Kimi-K2.7-Code / Qwen3.6-35B-A3B /
// gemma-4-31B-it は ok(tool_call)、Phi-4-mini-instruct-cpu / Qwen3-0.6B-cpu は 400（非対応）。
export const MODELS: { id: string; label: string }[] = [
  { id: 'preview/Kimi-K2.7-Code', label: 'Kimi K2.7 Code（プレビュー）' },
  { id: 'preview/Qwen3.6-35B-A3B', label: 'Qwen3.6 35B（プレビュー）' },
  { id: 'preview/gemma-4-31B-it', label: 'Gemma 4 31B（プレビュー）' },
  { id: 'gpt-oss-120b', label: 'GPT-OSS 120B' },
  { id: 'llm-jp-3.1-8x13b-instruct4', label: 'llm-jp 3.1 8x13b（日本語）' },
  // 2026-07-14 ユーザー実測（probe-models.mjs）で tools=ok を確認しツール（ファイル参照）対応に昇格。
  { id: 'preview/Kimi-K2.6', label: 'Kimi K2.6（プレビュー）' },
  { id: 'preview/Qwen3-0.6B-cpu', label: 'Qwen3 0.6B（CPU・プレビュー）' },
  { id: 'preview/Phi-4-mini-instruct-cpu', label: 'Phi-4 mini（CPU・プレビュー）' },
]

/** マルチモーダル（画像入力）対応モデル（さくらのAI Engine パブリックプレビュー） */
// 2026-09-04: preview/Phi-4-multimodal-instruct は提供終了のため削除。Qwen3-VL は継続提供。
export const VISION_MODELS: { id: string; label: string }[] = [
  { id: 'preview/Qwen3-VL-30B-A3B-Instruct', label: 'Qwen3-VL 30B（画像対応・プレビュー）' },
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
// 2026-09-04 見直し。旧コード特化モデルの提供終了に伴い、実測で tools ok のコード系へ
export const DEFAULT_MODEL = 'preview/Kimi-K2.7-Code'   // IDE 既定（コード最適）

/**
 * 提供中のモデル一覧から「コード作成に最適な」モデルを選ぶ。
 * 既定モデルが提供終了した場合のフォールバックに使う
 * （Kimi-K2.x-Code系 → coder系 → Qwen3系（-cpu の小型版・VL の画像用は除外） → 先頭）。
 * qwen3 の枝で -cpu/VL を除外するのは、0.6B（preview/Qwen3-0.6B-cpu）のような
 * 非力な小型モデルが既定に選ばれる事故を防ぐため。
 */
export function pickBestModel(ids: string[]): string {
  if (!ids.length) return DEFAULT_MODEL
  return (
    ids.find(id => /kimi-k2[.\d]*-code/i.test(id)) ??
    ids.find(id => /coder/i.test(id)) ??
    ids.find(id => /qwen3/i.test(id) && !/-cpu|vl/i.test(id)) ??
    ids[0]
  )
}

/**
 * system ロールの**本文がテンプレートで捨てられる**モデル（2026-09-04 Ryosuke 実測で確定）。
 *
 * 証跡（llm-jp）: ①probe-openfile の実測で、system に4,000字を注入しても prompt_tokens が
 * user 文＋雑費ぶんしか増えない ②「にゃテスト」= system の「語尾ににゃ」を完全無視、
 * **同じ指示を user ロールに入れると完全に従う**（対の実測）＝指示追従の弱さではなくロールの問題。
 * このままでは境界ガード（untrustedBlock）・現在日時・IDEの全指示が届かないため、
 * 送信の一元の通り道（main/sakura/engine.ts）で user への畳み込みを行う（roadmap #21）。
 */
export const SYSTEM_ROLE_UNSUPPORTED = ['llm-jp-3.1-8x13b-instruct4']

/**
 * system が捨てられるモデル向けに、先頭の system メッセージを
 * 「user（指示）→ assistant（了解）」の往復へ畳み込む（純関数・roadmap #21）。
 *
 * 対象外のモデル・先頭に system が無い場合は、渡された配列をそのまま返す（複製しない）。
 * 万一 2つ目以降に system が混ざっていた場合も、user へ変換して落とさない（防御・
 * 本来は v0.5.0 の「先頭 system へ畳み込み」で先頭1つに揃っている）。
 */
export function foldSystemForModel(
  model: string,
  messages: { role: string; content: any }[],
): { role: string; content: any }[] {
  if (!SYSTEM_ROLE_UNSUPPORTED.includes(model)) return messages
  if (!messages.some(m => m.role === 'system')) return messages
  const out: { role: string; content: any }[] = []
  let foldedFirst = false
  for (const m of messages) {
    if (m.role !== 'system') { out.push(m); continue }
    out.push({ role: 'user', content: `（Koto からの実行指示。以降のやり取り全体に必ず適用すること）\n\n${m.content}` })
    if (!foldedFirst) {
      foldedFirst = true
      out.push({ role: 'assistant', content: 'わかりました。指示に従います。' })
    }
  }
  return out
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
