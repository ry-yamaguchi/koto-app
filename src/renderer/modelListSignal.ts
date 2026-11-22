// modelListSignal.ts — さくらのAI Engine と Claude の「提供中のモデルの一覧」が取り直されたことを知らせる購読口。
// 一覧の本体は usage.ts（さくら）と claudeMode.ts（Claude）が1つずつ持つ。ここは知らせるだけ。
// aiChoiceSignal.ts と同じ形で、import を持たない。

let version = 0
const listeners = new Set<() => void>()

export function notifyModelListChanged(): void {
  version++
  for (const l of [...listeners]) l()
}

export function subscribeModelList(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getModelListVersion(): number {
  return version
}
