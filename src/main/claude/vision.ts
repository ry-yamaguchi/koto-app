// vision.ts — Claude頭脳モード（C2d）: 画像添付ターンを Claude 自身に直接処理させるための
// ユーザーメッセージ content 組み立て（純粋関数・Vitest対象）。
//
// 型注記（実装前に実機確認・2026-07-11）: SDK の `SDKUserMessage.message` は
// `@anthropic-ai/sdk/resources` の `MessageParam` 型（sdk.d.ts 冒頭の import）。しかしこのプロジェクトでは
// `@anthropic-ai/sdk` は claude-agent-sdk の peerDependencies 止まりで node_modules に実体が無い
// （`npm ls @anthropic-ai/sdk` は空。agent.ts 冒頭コメントのESM専用配布事情とは別の理由）。
// 自前の .ts ファイルから `import type { MessageParam } from '@anthropic-ai/sdk/resources'` を書くと
// `npx tsc -p tsconfig.main.json --noEmit` が TS2307 (Cannot find module) で落ちることを実機確認済み。
// （sdk.d.ts 自身の中でこの未解決importが使われる分には skipLibCheck の効果で `any` 扱いになり
//   コンパイルは通るが、型としての検証機能は失われる＝借りても意味が無い。）
// そのため、ここでは Anthropic Messages API 準拠のブロック形を素直にローカル型として定義する
// （実行時のスキーマ検証は Anthropic 側APIが行うため、コンパイル時の型はドキュメント目的で十分）。
// 形は公式ドキュメント通り: `{ type:'image', source:{ type:'base64', media_type, data } }`。

/** Anthropic Messages API が受理する画像の media_type（それ以外は添付から除外する）。 */
export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number]

export type TextBlock = { type: 'text'; text: string }
export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: AllowedImageType; data: string } }
/** SDKUserMessage.message.content に渡すブロック配列の要素型（MessageParam の content 要素と同一形）。 */
export type UserContentBlock = TextBlock | ImageBlock

/**
 * `data:<mediaType>;base64,<data>` 形式の data URL を分解する。
 * renderer 側は `src/renderer/imageInput.ts` の fileToDataUrl がこの形式（FileReader.readAsDataURL /
 * canvas.toDataURL の出力）で生成する。base64 エンコーディング以外（例: `data:image/svg+xml,<svg/>` の
 * ような非base64データURL）や、そもそも data URL の形をしていない文字列は null を返す。
 */
export function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  if (typeof dataUrl !== 'string') return null
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim())
  if (!m) return null
  const [, mediaType, data] = m
  if (!mediaType || !data) return null
  return { mediaType, data }
}

/**
 * テキスト＋画像添付（data URL配列）から、SDKUserMessage.message.content に渡すブロック配列を組み立てる。
 * - 許可外の media_type・不正な data URL の画像は黙って除外する（1件も有効な画像が無ければテキストのみの配列になる）。
 * - text が空文字なら、テキストブロック自体を含めない（画像のみの配列になり得る）。
 */
export function buildUserContent(text: string, imageDataUrls: string[]): UserContentBlock[] {
  const blocks: UserContentBlock[] = []
  if (text) blocks.push({ type: 'text', text })
  for (const url of imageDataUrls) {
    const parsed = parseDataUrl(url)
    if (!parsed) continue
    if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(parsed.mediaType)) continue
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: parsed.mediaType as AllowedImageType, data: parsed.data },
    })
  }
  return blocks
}
