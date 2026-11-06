// modalManager.ts — 窓（モーダル）の積み重ね・Esc の振り分け・Tab の閉じ込め・フォーカスの記録と復帰。
//
// React と DOM から切り離してある。`document` 相当（ModalDocumentLike）を引数で受けるので、
// 偽の document を渡して振る舞いをテストできる。本物の document はそのまま渡せる。
//
// ── 約束 ────────────────────────────────────────────────────────────
// ・Esc を受けるのは**最前面の1枚だけ**。その窓の `onRequestClose('escape')` を呼ぶだけで、閉じてよいかは窓の持ち主が決める
//   （未保存なら確認を出す・実行中は閉じない、など）。変換中の Esc と、中の部品がすでに受けた Esc は受けない。
// ・Tab は最前面の窓の中で一周する。枠の外にフォーカスがあれば先頭（Shift なら末尾）へ戻す。
// ・窓を開くとき、その時点でフォーカスのあった要素を覚える。最前面の窓を閉じたら、そこへ戻す。
//   戻れなければ（要素が無くなった・フォーカスできない）次の最前面の窓の枠へ、それも無ければ何もしない。
// ・keydown の listener は、窓が1枚でもある間だけ document に1本つける。最後の1枚が閉じたら外す。
//   つけるのはバブル段階（第3引数なし）。中の部品の onKeyDown が先に動くので、部品が preventDefault した Esc は窓が受けない。
// ・`close()` は何度呼んでも同じ（React の StrictMode は effect を「登録 → 解除 → 登録」と二重に回す）。
//   同じ枠を二重に登録しても1枚として数える。
// ・`document` が無い環境では何もしない（登録も解除も空振りする）。

import {
  collectTabbables,
  planTab,
  shouldHandleEscape,
  tabDirection,
  type ModalKeyEvent,
  type TabbableRootLike,
} from './modalKeys'

/** フォーカスを受け取れるもの（本物の HTMLElement がそのまま入る）。 */
export interface FocusTargetLike {
  focus(): void
  /** 画面から外れた要素は false。取れない環境では生きているとみなす。 */
  isConnected?: boolean
}

/** 窓の枠（本物の HTMLElement がそのまま入る）。 */
export interface ModalFrameLike extends TabbableRootLike {
  focus(): void
}

/** document のうち、窓の管理に要るところだけ（本物の document がそのまま入る）。 */
export interface ModalDocumentLike {
  readonly activeElement: unknown
  readonly body?: unknown
  addEventListener(type: 'keydown', listener: (e: ModalKeyEvent) => void): void
  removeEventListener(type: 'keydown', listener: (e: ModalKeyEvent) => void): void
}

export interface ModalRegistration {
  frame: ModalFrameLike
  /** 閉じてほしいと言われたとき。閉じてよいかの判断は呼ばれた側がする。 */
  onRequestClose: (reason: 'escape') => void
}

export interface ModalHandle {
  /** 積み重ねの深さ。いちばん下の窓が 0。窓を開いた時点で決まり、あとから変わらない。 */
  readonly depth: number
  /** 窓を閉じる。2回目以降は何もしない。 */
  close(): void
}

export interface ModalManager {
  open(registration: ModalRegistration): ModalHandle
  /** 次に開く窓が持つ深さ。 */
  nextDepth(): number
  /** いま開いている窓の数。 */
  size(): number
}

// ── 純関数: 積み重ね ────────────────────────────────────────────────

/** z-index。深さ0は今までの窓と同じ 50、1つ重なるごとに 10 上がる。 */
export function modalZIndex(depth: number): number {
  const d = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0
  return 50 + 10 * d
}

/** 最前面の窓（いちばん後ろの要素）。無ければ undefined。 */
export function topOf<T>(stack: readonly T[]): T | undefined {
  return stack[stack.length - 1]
}

/** 次に重ねる窓の深さ。途中の窓が抜けても、最前面より必ず1つ深くする（前後が入れ替わらないように）。 */
export function nextDepthOf(stack: readonly { depth: number }[]): number {
  const top = topOf(stack)
  return top ? top.depth + 1 : 0
}

/** 最前面に1枚重ねる（元の配列は変えない）。 */
export function pushEntry<T>(stack: readonly T[], entry: T): T[] {
  return [...stack, entry]
}

/** 1枚抜く。途中の窓でもよい（元の配列は変えない）。無ければそのまま。 */
export function removeEntry<T>(stack: readonly T[], entry: T): T[] {
  return stack.filter(e => e !== entry)
}

// ── manager ─────────────────────────────────────────────────────────

interface Entry {
  frame: ModalFrameLike
  onRequestClose: (reason: 'escape') => void
  depth: number
  /** 閉じたときに戻す先の候補（先頭から試す）。自分が開いた時点の要素と、途中で抜けた下の窓から引き継いだもの。 */
  returns: FocusTargetLike[]
  handle: ModalHandle
}

function isFocusTarget(x: unknown): x is FocusTargetLike {
  return typeof (x as { focus?: unknown } | null | undefined)?.focus === 'function'
}

const INERT_HANDLE: ModalHandle = { depth: 0, close() {} }

const INERT_MANAGER: ModalManager = {
  open: () => INERT_HANDLE,
  nextDepth: () => 0,
  size: () => 0,
}

/** `document` 相当を受けて manager を作る。無ければ、何もしない manager を返す。 */
export function createModalManager(documentLike: ModalDocumentLike | null | undefined): ModalManager {
  if (!documentLike) return INERT_MANAGER
  const doc: ModalDocumentLike = documentLike
  let stack: Entry[] = []
  let attached = false

  /** 戻り先として覚える要素。フォーカスがどこにも無い（body のまま）ときは覚えない。 */
  function rememberFocus(): FocusTargetLike[] {
    const active = doc.activeElement
    if (!isFocusTarget(active) || active === doc.body) return []
    return [active]
  }

  /** 戻せたら true。要素が無くなっている・フォーカスを受け取らないときは false。 */
  function tryFocus(target: FocusTargetLike): boolean {
    if (target.isConnected === false) return false
    target.focus()
    return doc.activeElement === target
  }

  /** 最前面の窓が閉じたあとのフォーカス。 */
  function restoreFocus(closed: Entry) {
    for (const target of closed.returns) {
      if (tryFocus(target)) return
    }
    topOf(stack)?.frame.focus()
  }

  function trapTab(top: Entry, e: ModalKeyEvent, backward: boolean) {
    const tabbables = collectTabbables(top.frame)
    const active = doc.activeElement
    const plan = planTab(tabbables.length, tabbables.findIndex(t => t === active), backward)
    if (plan.kind === 'native') return
    e.preventDefault?.()
    if (plan.kind === 'hold') top.frame.focus()
    else tabbables[plan.index].focus()
  }

  function onKeyDown(e: ModalKeyEvent) {
    const top = topOf(stack)
    if (!top) return
    if (shouldHandleEscape(e)) {
      top.onRequestClose('escape')
      return
    }
    const direction = tabDirection(e)
    if (direction) trapTab(top, e, direction === 'backward')
  }

  function close(entry: Entry) {
    const index = stack.indexOf(entry)
    if (index < 0) return
    const wasTop = index === stack.length - 1
    stack = removeEntry(stack, entry)
    // 途中の窓を抜いたときは、戻り先を1つ上の窓へ引き継ぐ（上の窓が閉じるとき、元の場所へ戻れるように）
    if (!wasTop) stack[index].returns = [...stack[index].returns, ...entry.returns]
    if (stack.length === 0 && attached) {
      doc.removeEventListener('keydown', onKeyDown)
      attached = false
    }
    if (wasTop) restoreFocus(entry)
  }

  return {
    open(registration) {
      const same = stack.find(e => e.frame === registration.frame)
      if (same) {
        same.onRequestClose = registration.onRequestClose
        return same.handle
      }
      const depth = nextDepthOf(stack)
      const entry: Entry = {
        frame: registration.frame,
        onRequestClose: registration.onRequestClose,
        depth,
        returns: rememberFocus(),
        handle: { depth, close: () => close(entry) },
      }
      if (!attached) {
        doc.addEventListener('keydown', onKeyDown)
        attached = true
      }
      stack = pushEntry(stack, entry)
      return entry.handle
    },
    nextDepth: () => nextDepthOf(stack),
    size: () => stack.length,
  }
}

let shared: ModalManager | null = null

/** 画面全体で1つの manager（窓の積み重ねは全部の窓で共有する）。`document` が無い環境では何もしない。 */
export function getModalManager(): ModalManager {
  if (!shared) shared = createModalManager(typeof document === 'undefined' ? null : document)
  return shared
}
