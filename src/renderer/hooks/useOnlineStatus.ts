// useOnlineStatus.ts — 回線がつながっているか（ブラウザの印）。
// navigator.onLine は「つながっているのに届かない」を見分けられないので、押せるものを止める根拠にはしない。
// 帯で知らせるだけにして、押したあとの失敗の文（回線の文）を本番とする。

import { useSyncExternalStore } from 'react'

/** いまの印。navigator が無い環境（描画の下見など）はつながっている扱い。 */
export function readOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false
}

/** window の online / offline の出来事を購読する。外すための関数を返す。 */
export function subscribeOnline(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => {
    window.removeEventListener('online', listener)
    window.removeEventListener('offline', listener)
  }
}

/** navigator.onLine を初期値にして、online / offline の出来事で更新する。 */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeOnline, readOnline, readOnline)
}
