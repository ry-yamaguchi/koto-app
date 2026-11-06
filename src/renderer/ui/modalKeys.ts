// modalKeys.ts — 窓（モーダル）が受けるキーの判定（純関数）。Esc と Tab だけ。
//
// 窓の積み重ねと、フォーカスの記録・復帰は modalManager.ts が持つ。ここは「このキーを窓が受けてよいか」
// 「Tab でどこへ動かすか」だけを、React と DOM から切り離して決める（テストできる形）。
//
// 変換中の判定は keyInput.ts の isComposing をそのまま使う（複製しない）。日本語入力で変換を確定する
// Enter や、変換を取り消す Esc で、窓が一緒に閉じるのを防ぐ。

import { isComposing } from '../keyInput'

/** document の keydown が運んでくる値のうち、判定に要るところだけ（本物の KeyboardEvent がそのまま入る）。 */
export interface ModalKeyEvent {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  /** 窓の中の部品がすでに受けたキー（例: 名前編集の Esc）。窓は重ねて受けない。 */
  defaultPrevented?: boolean
  isComposing?: boolean
  keyCode?: number
  preventDefault?(): void
}

/** 変換中か。keyInput.ts の判定に、生のイベントとしてそのまま渡す。 */
function composing(e: ModalKeyEvent): boolean {
  return isComposing({ key: e.key, nativeEvent: e, keyCode: e.keyCode })
}

/**
 * 最前面の窓が Esc として受けてよいか。
 * 変換中の Esc（変換の取り消し）と、中の部品がすでに受けた Esc（`defaultPrevented`）は受けない。
 */
export function shouldHandleEscape(e: ModalKeyEvent): boolean {
  if (e.key !== 'Escape') return false
  if (e.defaultPrevented) return false
  if (composing(e)) return false
  return true
}

/**
 * 窓の Tab の閉じ込めで受けるキーか。受けるなら向きを返す。
 * 修飾キー付き（⌘・Ctrl・Alt）、変換中、中の部品がすでに受けたものは受けない。
 */
export function tabDirection(e: ModalKeyEvent): 'forward' | 'backward' | null {
  if (e.key !== 'Tab') return null
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  if (e.defaultPrevented) return null
  if (composing(e)) return null
  return e.shiftKey ? 'backward' : 'forward'
}

/** Tab で止まる要素を探す selector（無効・隠し・tabindex=-1 は含めない）。 */
export const TABBABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/** Tab で止まる要素の、判定に要るところだけ。 */
export interface TabbableLike {
  focus(): void
  disabled?: boolean
  hidden?: boolean
  /** 見えない要素（display: none の中など）は 0 個になる。取れない環境では見えているとみなす。 */
  getClientRects?(): ArrayLike<unknown>
}

/** 枠の中を探せるもの（本物の HTMLElement がそのまま入る）。 */
export interface TabbableRootLike {
  querySelectorAll(selector: string): ArrayLike<unknown>
}

function isShownTabbable(el: TabbableLike): boolean {
  if (el.disabled || el.hidden) return false
  if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false
  return true
}

/** 枠の中で Tab が止まる要素を、文書の順で返す。 */
export function collectTabbables(root: TabbableRootLike): TabbableLike[] {
  return (Array.from(root.querySelectorAll(TABBABLE_SELECTOR)) as TabbableLike[]).filter(isShownTabbable)
}

/**
 * Tab の動かし方。
 * - `native`: ブラウザに任せる（枠の中の途中。端でも外でもない）
 * - `focus`: `index` 番の要素へ動かす（端で一周する・枠の外から戻す）
 * - `hold`: 止まる要素が1つも無い。動かさず、枠自身にとどめる
 */
export type TabPlan = { kind: 'native' } | { kind: 'focus'; index: number } | { kind: 'hold' }

/**
 * @param count        枠の中で Tab が止まる要素の数
 * @param activeIndex  いまフォーカスのある要素がその何番目か。枠の外・枠自身・並びに無い要素は -1
 * @param backward     Shift+Tab か
 */
export function planTab(count: number, activeIndex: number, backward: boolean): TabPlan {
  if (count <= 0) return { kind: 'hold' }
  // 外にある（または枠自身にある）ときは、先頭（Shift なら末尾）へ戻す
  if (activeIndex < 0 || activeIndex >= count) return { kind: 'focus', index: backward ? count - 1 : 0 }
  if (!backward && activeIndex === count - 1) return { kind: 'focus', index: 0 }
  if (backward && activeIndex === 0) return { kind: 'focus', index: count - 1 }
  return { kind: 'native' }
}
