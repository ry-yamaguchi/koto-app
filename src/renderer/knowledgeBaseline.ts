// knowledgeBaseline.ts — 資料を取り込んだときのページの指紋を控える（renderer の保存）。
//
// ── なぜ要るか（2026-08-18 実機）──────────────────────────────────────
// 更新の有無を「さくらの AI Engine に保存された本文」と「いまのページ」を比べて
// 判定していた。ところが**保存して読み戻すと本文の形が変わる**ため当てにならず、
// 同じ資料が「最新です」にも「更新されています」にもなった（Ryosuke 指摘）。
//
// 比べるのは **Koto が取ってきたページどうし**にする。そのために、取り込んだ
// 時点の指紋をここに控える。**本文そのものは持たない**（容量を食うだけで、
// 判定には指紋で足りる）。
//
// 置き場は localStorage。消えても困らない（消えたら「分かりません」と言うだけ）。

import type { Baseline } from '../shared/freshness'

const KEY = 'koto.knowledge.baseline'

type Store = Record<string, Baseline>

export function loadBaselines(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return raw && typeof raw === 'object' ? raw as Store : {}
  } catch {
    return {}
  }
}

function save(store: Store): void {
  try { localStorage.setItem(KEY, JSON.stringify(store)) } catch { /* 使えなくても機能は成立する */ }
}

/** 取り込んだときの指紋を控える。 */
export function setBaseline(documentId: string, hash: string, at: Date = new Date()): void {
  if (!documentId || !hash) return
  const store = loadBaselines()
  store[documentId] = { hash, at: at.toISOString() }
  save(store)
}

export function getBaseline(documentId: string): Baseline | null {
  return loadBaselines()[documentId] ?? null
}

/**
 * もう存在しない資料の控えを捨てる。
 *
 * **控えは資料に付いているもの**なので、資料が消えたら一緒に消す。
 * 残すと localStorage が際限なく太る（今日の「記録だけ残る」と同じ形）。
 */
export function pruneBaselines(aliveIds: readonly string[]): void {
  const alive = new Set(aliveIds)
  const store = loadBaselines()
  let changed = false
  for (const id of Object.keys(store)) {
    if (!alive.has(id)) { delete store[id]; changed = true }
  }
  if (changed) save(store)
}
