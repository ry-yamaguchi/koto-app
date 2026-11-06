// retryableLazy.ts — 読み込みに失敗した React.lazy を、読み込み直せるようにする小さな部品。
// React.lazy は失敗した Promise を覚えたままなので、領域の「この部分を読み込み直す」で作り直しても同じ失敗が返り続ける。
// 失敗したら次の描画から**新しい lazy** に差し替え、import をもう一度走らせる。
import { createElement, lazy, type ComponentType, type LazyExoticComponent } from 'react'

/** `lazyImpl` はテスト用の差し替え口（既定は React.lazy）。 */
export function createRetryableLazy<P extends object>(
  loader: () => Promise<{ default: ComponentType<P> }>,
  lazyImpl: (f: () => Promise<{ default: ComponentType<P> }>) => LazyExoticComponent<ComponentType<P>> = lazyImpl_default,
): ComponentType<P> {
  let current: LazyExoticComponent<ComponentType<P>>
  const make = (): LazyExoticComponent<ComponentType<P>> => lazyImpl(() => loader().catch(e => {
    // 失敗を覚えた lazy は捨てる（次に描かれるときは新しい lazy で import をやり直す）
    current = make()
    throw e
  }))
  current = make()
  return function RetryableLazy(props: P) {
    return createElement(current as ComponentType<any>, props)
  }
}

function lazyImpl_default<P extends object>(f: () => Promise<{ default: ComponentType<P> }>) {
  return lazy(f)
}
