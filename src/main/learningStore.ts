// learningStore.ts — モデルの「ツール対応」「画像対応」学習キャッシュの唯一の持ち主（B'-3d-1a）。
//
// ── なぜ（B'-3d の第一歩）────────────────────────────────────────────
// これまでの持ち主は renderer の localStorage で、main のループ（turnRunner.ts）からは
// ask（main→renderer の問い合わせ）で読み書きしていた。ask はウィンドウが生きていることが
// 前提なので、「窓を閉じても作業が続く」（B'-3d）の障害の一つだった（ask 18本のうち6本）。
// ここからは main がメモリ＋ファイル（userData/learning.json）で持ち、保存のデバウンスも
// main が行う（src/main/chat/convStore.ts＝会話データの持ち主・B'-3c と同じ作法）。
// renderer は起動時に読み込む写し（src/renderer/learningMirror.ts）＋変更イベントを持つだけ。
//
// electron の `app` は「保存先ディレクトリ」を得るためだけに使う。それ以外（判定ロジック・
// 検証）は shared/modelLearning.ts の純関数（node のテストからも直接呼べる）。
//
// 予算・利用実績（usage.ts）は課金データなので対象外（次の段・B'-3d-1b）。
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { sanitizeStore, type LearnStore } from '../shared/modelLearning'

export type LearningKind = 'tool' | 'vision'

/** renderer へ渡す読み取り用の写し（learning:get の返り値・learning:changed の中身）。 */
export type LearningSnapshot = { toolSupport: LearnStore; visionSupport: LearnStore }

/** 保存のデバウンス（convStore.ts と同じ間隔。頻繁な学習記録でファイルI/Oが連発しないように）。 */
const DEBOUNCE_MS = 1500

/** テスト用に差し替える保存先ディレクトリ。null なら app.getPath('userData')（本番）。
 *  convStore.ts は projectDir を呼び出し側が毎回渡すため差し替えが要らないが、こちらは
 *  グローバル1箇所（userData）なので、その代わりに init 関数で差し替える（仕様書の指示どおり）。 */
let dirOverride: string | null = null

/** メモリ上の状態。読み込み前は未確定（loaded=false）。convStore.ts の Map と違い、
 *  learning.json はプロジェクト単位ではなくアプリ全体で1つなので、素の変数で持つ。 */
let loaded = false
let toolStore: LearnStore = {}
let visionStore: LearnStore = {}
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 変更のたび呼ばれる通知先（ipc/learning.ts が learning:changed として renderer へ配線する）。
 *  convStore.ts の applyListener と同じ形。テストでは差し替える（setLearningListener(null) で外す）。 */
let listener: ((snapshot: LearningSnapshot) => void) | null = null
export function setLearningListener(fn: ((snapshot: LearningSnapshot) => void) | null): void {
  listener = fn
}

/**
 * テスト用: 保存先ディレクトリを差し替え、メモリ上の状態を空にリセットする。
 * dir に null を渡すと本番の app.getPath('userData') へ戻る。
 * 本番コード（main.ts・ipc/learning.ts）はこれを呼ばない。
 */
export function initLearningStore(dir: string | null): void {
  dirOverride = dir
  loaded = false
  toolStore = {}
  visionStore = {}
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
}

function learningFilePath(): string {
  return path.join(dirOverride ?? app.getPath('userData'), 'learning.json')
}

/** 未読み込みなら、ファイルから読む（壊れたJSON・無い場合は sanitizeStore を通した空として扱う）。 */
function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = fs.readFileSync(learningFilePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    toolStore = sanitizeStore(parsed?.toolSupport)
    visionStore = sanitizeStore(parsed?.visionSupport)
  } catch {
    // ファイルが無い・JSONとして壊れている → 空として扱う（掟1: 推測せず安全側へ倒す。
    // 旧localStorageの片道移行＝learning:migrate は、この空の状態に対して行われる）。
    toolStore = {}
    visionStore = {}
  }
}

function snapshot(): LearningSnapshot {
  // 呼び出し側が内部の Store を直接書き換えられないようコピーを返す（convStore.loadConversation
  // が配列のコピーを返すのと同じ理由）。
  return { toolSupport: { ...toolStore }, visionSupport: { ...visionStore } }
}

function notify(): void {
  listener?.(snapshot())
}

function storeFor(kind: LearningKind): LearnStore {
  return kind === 'tool' ? toolStore : visionStore
}

function saveNow(): void {
  const file = learningFilePath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, toolSupport: toolStore, visionSupport: visionStore }), 'utf-8')
    fs.renameSync(tmp, file) // クラッシュ時の破損防止（chatStore/file.ts の atomicWriteFileSync と同じ作法）
  } catch {
    // 保存できなくても致命的ではない（次回また学習し直すだけ・旧localStorage実装のコメントを踏襲）
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveNow()
  }, DEBOUNCE_MS)
}

/** 読み取り用スナップショット（learning:get・renderer 起動時のミラー初期化に使う）。 */
export function getLearning(): LearningSnapshot {
  ensureLoaded()
  return snapshot()
}

/** 実測結果を記録する（上書き保存。at を現在時刻に更新）。 */
export function recordLearning(kind: LearningKind, model: string, supported: boolean, now: number = Date.now()): void {
  ensureLoaded()
  storeFor(kind)[model] = { supported, at: now }
  scheduleSave()
  notify()
}

/** 記録を消す。model省略時は全消去（設定UIからのリセットや不具合時の逃げ道用）。 */
export function forgetLearning(kind: LearningKind, model?: string): void {
  ensureLoaded()
  if (model === undefined) {
    if (kind === 'tool') toolStore = {}
    else visionStore = {}
  } else {
    delete storeFor(kind)[model]
  }
  scheduleSave()
  notify()
}

/** src < dst へ、モデルごとに「dst に無いか、dst の at より新しいエントリだけ」取り込む。 */
function mergeNewerInto(dst: LearnStore, src: LearnStore): boolean {
  let changed = false
  for (const [model, entry] of Object.entries(src)) {
    const existing = dst[model]
    if (!existing || entry.at > existing.at) {
      dst[model] = entry
      changed = true
    }
  }
  return changed
}

/**
 * 旧 renderer/localStorage からの片道移行。**model ごとに、main 側に無いか main 側の at より
 * 新しいエントリだけ**取り込む＝何度呼ばれても安全（renderer は起動のたびに
 * primeLearningMirror() からこれを呼ぶが、2回目以降は「もう取り込み済み」で何も変わらない）。
 * 旧localStorageのキー自体は消さない（renderer 側の責務・戻せる保険）。
 */
export function mergeMigration(payload: { toolSupport?: unknown; visionSupport?: unknown }): void {
  ensureLoaded()
  const toolChanged = mergeNewerInto(toolStore, sanitizeStore(payload?.toolSupport))
  const visionChanged = mergeNewerInto(visionStore, sanitizeStore(payload?.visionSupport))
  if (toolChanged || visionChanged) {
    scheduleSave()
    notify()
  }
}

/** 保存待ちを即座に書き切る（quit 時・テスト用）。保存待ちが無ければ何もしない
 *  （convStore.flushConversations と同じ判断: 変化が無ければ書かない）。 */
export function flushLearningNow(): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  saveNow()
}
