// projectAi.ts — プロジェクトごとの「使う AI とモデル」の記憶と、その判断（resolveAiChoice）。
// 記憶は localStorage（koto_project_ai:<プロジェクトのフォルダ>）に、項目ごとに持つ。
// 設定の既定（getDefaultModel / getSavedClaudeModel / isClaudeModeEnabled）には書かない。
// 使う AI とモデルを決めるのは resolveAiChoice だけ（表示も送る回も、ここを通す）。
// window・IPC には触れない。

import { notifyAiChoiceChanged } from './aiChoiceSignal'
import { DEFAULT_CLAUDE_MODEL, getClaudeModelListState, getSavedClaudeModel, isClaudeModeEnabled } from './claudeMode'
import { getDefaultModel, getSakuraModelList } from './usage'
import { pickBestModel } from '../shared/modelInfo'
import { creationProjectAi, type CreationBrain } from './newProjectAgent'

export type AiBrain = 'claude' | 'sakura'
export type ProjectAiMemory = { brain?: AiBrain; sakuraModel?: string; claudeModel?: string }
export type AiDefaults = { brain: AiBrain; sakuraModel: string; claudeModel: string | null }
export type AiChoiceInput = {
  memory: ProjectAiMemory
  defaults: AiDefaults
  hasClaudeKey: boolean
  hasEngineKey: boolean
  sakuraModelIds: readonly string[]
  claudeModelIds: readonly string[]
}
export type AiRetired = { brain: AiBrain; from: string; to: string; fromProject: boolean }
export type AiChoice = {
  /** 実際に使う AI。null は使える AI が無いこと。 */
  brain: AiBrain | null
  /** 記憶 → 既定の順で望まれている AI。 */
  wanted: AiBrain
  /** wanted の側のキーが無いとき、その AI。 */
  missingKey: AiBrain | null
  sakuraModel: string
  claudeModel: string
  retired: AiRetired[]
}

export const PROJECT_AI_KEY_PREFIX = 'koto_project_ai:'

/** 記憶の鍵。末尾の / は落とす（/ws/a/ と /ws/a を同じ鍵にする）。これ以上は正規化しない。 */
export function projectAiKey(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '')
  return PROJECT_AI_KEY_PREFIX + (trimmed === '' ? dir : trimmed)
}

function isBrain(v: unknown): v is AiBrain {
  return v === 'claude' || v === 'sakura'
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v !== ''
}

/** 記憶を読む。無い・壊れている・版が違うときは {}。項目ごとに、読めないものだけ捨てる。 */
export function readProjectAi(dir: string | null | undefined): ProjectAiMemory {
  if (!dir) return {}
  let raw: string | null = null
  try { raw = localStorage.getItem(projectAiKey(dir)) } catch { return {} }
  if (!raw) return {}
  try {
    const p = JSON.parse(raw) as Record<string, unknown> | null
    if (!p || typeof p !== 'object' || p.v !== 1) return {}
    const out: ProjectAiMemory = {}
    if (isBrain(p.brain)) out.brain = p.brain
    if (nonEmpty(p.sakuraModel)) out.sakuraModel = p.sakuraModel
    if (nonEmpty(p.claudeModel)) out.claudeModel = p.claudeModel
    return out
  } catch {
    return {}
  }
}

function writeMemory(dir: string, mem: ProjectAiMemory): boolean {
  const key = projectAiKey(dir)
  try {
    if (!mem.brain && !mem.sakuraModel && !mem.claudeModel) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, JSON.stringify({ v: 1, ...mem }))
    }
    return true
  } catch {
    return false
  }
}

/** 記憶に patch を重ねて書く（undefined の項目は今の値を残す）。既定の鍵には触れない。書けたかどうかを返す。 */
export function rememberProjectAi(dir: string | null | undefined, patch: ProjectAiMemory): boolean {
  if (!dir) return false
  const next: ProjectAiMemory = { ...readProjectAi(dir) }
  if (isBrain(patch.brain)) next.brain = patch.brain
  if (nonEmpty(patch.sakuraModel)) next.sakuraModel = patch.sakuraModel
  if (nonEmpty(patch.claudeModel)) next.claudeModel = patch.claudeModel
  const ok = writeMemory(dir, next)
  if (ok) notifyAiChoiceChanged()
  return ok
}

export function rememberProjectBrain(dir: string | null | undefined, brain: AiBrain): boolean {
  return rememberProjectAi(dir, { brain })
}

export function rememberProjectModel(dir: string | null | undefined, brain: AiBrain, id: string): void {
  rememberProjectAi(dir, brain === 'claude' ? { claudeModel: id } : { sakuraModel: id })
}

/** その AI の側のモデルの記憶だけを消す。 */
export function forgetProjectModel(dir: string | null | undefined, brain: AiBrain): void {
  if (!dir) return
  const cur = readProjectAi(dir)
  const field = brain === 'claude' ? 'claudeModel' : 'sakuraModel'
  if (cur[field] === undefined) return
  const next = { ...cur }
  delete next[field]
  if (writeMemory(dir, next)) notifyAiChoiceChanged()
}

/** そのプロジェクトの記憶を丸ごと消す（完全一致の鍵だけ。前方一致では消さない）。消せた（または元から無い）かどうかを返す。 */
export function forgetProjectAi(dir: string | null | undefined): boolean {
  if (!dir) return true
  const key = projectAiKey(dir)
  try {
    const existed = localStorage.getItem(key) !== null
    localStorage.removeItem(key)
    if (existed) notifyAiChoiceChanged()
    return true
  } catch {
    // 消せなくても例外にはしない（呼び出し側が戻り値で見る）
    return false
  }
}

/**
 * 新規作成のあとの、作ったプロジェクトの記憶の扱い（作成のたびにここを通す）。
 * - 新しく作ったフォルダ（merged でない）は、useChat によらず先に、同じパスに前にあった記憶を消す。
 * - useChat のときは、選んだ AI とモデルをそのプロジェクトの記憶に書く（merged なら今の記憶に重ねる）。
 * - 書くのは koto_project_ai:<root> だけ。設定の既定には触れない。
 * 戻り値は、記憶が意図どおりになったか（消せなかった・書けなかった・読み戻して違うときは false）。
 */
export function applyCreationAi(o: {
  root: string
  merged: boolean
  useChat: boolean
  brain: CreationBrain | null
  claudeModelId: string
  sakuraModelId: string
}): boolean {
  let ok = true
  if (!o.merged && !forgetProjectAi(o.root)) ok = false
  if (o.useChat) {
    const mem = creationProjectAi({ brain: o.brain, claudeModelId: o.claudeModelId, sakuraModelId: o.sakuraModelId })
    if (mem) {
      if (!rememberProjectAi(o.root, mem) || readProjectAi(o.root).brain !== mem.brain) ok = false
    }
  }
  return ok
}

/** 設定の既定を読む。 */
export function readAiDefaults(): AiDefaults {
  return {
    brain: isClaudeModeEnabled() ? 'claude' : 'sakura',
    sakuraModel: getDefaultModel('ide'),
    claudeModel: getSavedClaudeModel(),
  }
}

function pickOffered(cands: (string | null | undefined)[], ids: readonly string[], last: (ids: string[]) => string): string {
  const cs = cands.filter(nonEmpty)
  if (ids.length === 0) return cs[0]
  return cs.find(c => ids.includes(c)) ?? last([...ids])
}

/**
 * 使う AI とモデルを決める唯一の場所（純関数）。
 * - 記憶 → 既定の順。記憶は項目ごと。
 * - さくらを望んでいてさくらのキーが無いときは null（Claude のキーがあっても黙って Claude にしない）。
 * - 提供終了（一覧に無い）モデルは、記憶 → 既定 → 一覧の最適の順に落とす。
 *   Claude の DEFAULT_CLAUDE_MODEL は落とし先の候補としてだけ使い、提供終了には数えない。
 */
export function resolveAiChoice(i: AiChoiceInput): AiChoice {
  const wanted: AiBrain = i.memory.brain ?? i.defaults.brain
  let brain: AiBrain | null
  if (wanted === 'claude') brain = i.hasClaudeKey ? 'claude' : (i.hasEngineKey ? 'sakura' : null)
  else brain = i.hasEngineKey ? 'sakura' : null
  const missingKey: AiBrain | null =
    wanted === 'claude' && !i.hasClaudeKey ? 'claude'
      : wanted === 'sakura' && !i.hasEngineKey ? 'sakura'
        : null

  const sakuraWants = [i.memory.sakuraModel, i.defaults.sakuraModel]
  const claudeWants = [i.memory.claudeModel, i.defaults.claudeModel]
  const sakuraModel = pickOffered(sakuraWants, i.sakuraModelIds, ids => pickBestModel(ids))
  const claudeModel = pickOffered([...claudeWants, DEFAULT_CLAUDE_MODEL], i.claudeModelIds, ids => ids[0])

  const retired: AiRetired[] = []
  const check = (b: AiBrain, wants: (string | null | undefined)[], ids: readonly string[], to: string, mem: string | undefined) => {
    const want = wants.filter(nonEmpty)[0]
    if (want === undefined || ids.length === 0 || to === want) return
    retired.push({ brain: b, from: want, to, fromProject: mem === want })
  }
  check('sakura', sakuraWants, i.sakuraModelIds, sakuraModel, i.memory.sakuraModel)
  check('claude', claudeWants, i.claudeModelIds, claudeModel, i.memory.claudeModel)

  return { brain, wanted, missingKey, sakuraModel, claudeModel, retired }
}

/**
 * 送る瞬間（同期）に、記憶・既定・提供中の一覧を読む。dir が無いときの記憶は override（画面の中だけの選び）。
 * send() の冒頭で1回だけ呼んで固定する。
 */
export function aiChoiceInputsNow(
  dir: string | null | undefined,
  override?: ProjectAiMemory,
): Pick<AiChoiceInput, 'memory' | 'defaults' | 'sakuraModelIds' | 'claudeModelIds'> {
  return {
    memory: dir ? readProjectAi(dir) : (override ?? {}),
    defaults: readAiDefaults(),
    sakuraModelIds: getSakuraModelList().ids,
    claudeModelIds: getClaudeModelListState().models.map(m => m.id),
  }
}

/** いまの値から AI とモデルを決める。一覧を渡さなければ、一覧の置き場の値を使う。 */
export function currentAiChoice(
  dir: string | null | undefined,
  keys: { hasClaudeKey: boolean; hasEngineKey: boolean },
  opts: { sakuraModelIds?: readonly string[]; claudeModelIds?: readonly string[]; override?: ProjectAiMemory } = {},
): AiChoice {
  const now = aiChoiceInputsNow(dir, opts.override)
  return resolveAiChoice({
    ...now,
    ...keys,
    sakuraModelIds: opts.sakuraModelIds ?? now.sakuraModelIds,
    claudeModelIds: opts.claudeModelIds ?? now.claudeModelIds,
  })
}
