import { useEffect, useSyncExternalStore } from 'react'
import { getClaudeModelListState, mergeClaudeModels, recordClaudeModelList } from '../claudeMode'
import { subscribeModelList, getModelListVersion } from '../modelListSignal'

/**
 * 利用可能な Claude モデル一覧を {models, live} で返すフック（useModels.ts の useModelList の Claude版）。
 * Claudeキーがあれば Anthropic API から実際の提供ラインナップをライブ取得し、
 * 無ければ（または失敗時は）キャッシュ／CLAUDE_MODELS（埋め込みの固定表）にフォールバックする。
 * live は取得に成功したときだけ true。一覧の本体は claudeMode.ts の置き場に1つで、購読で全員に届く。
 */
/** 最後に取りに行った Claude のキー。キーを替えた直後に前のキーの取得があとで返っても、置き場を上書きしない。 */
let latestClaudeModelsKey: string | null = null

export function useClaudeModelList(claudeKey: string): { models: { id: string; label: string }[]; live: boolean } {
  useSyncExternalStore(subscribeModelList, getModelListVersion, getModelListVersion)

  useEffect(() => {
    if (!claudeKey) return
    let cancelled = false
    latestClaudeModelsKey = claudeKey
    window.electronAPI.claude.models(claudeKey)
      .then(res => {
        if (cancelled || latestClaudeModelsKey !== claudeKey || !res.ok || !res.models?.length) return // 取得失敗時はキャッシュ/既定のまま
        recordClaudeModelList(mergeClaudeModels(res.models))
      })
      .catch(() => { /* 取得失敗時はキャッシュ/既定のまま（UIにエラーは出さない） */ })
    return () => { cancelled = true }
  }, [claudeKey])

  const { models, live } = getClaudeModelListState()
  return { models, live }
}

/** Claude の提供中の一覧を取り直す。取れたら置き場も更新される。取れなかったときは null。 */
export async function refetchClaudeModelIds(claudeKey: string): Promise<string[] | null> {
  try {
    latestClaudeModelsKey = claudeKey
    const res = await window.electronAPI.claude.models(claudeKey)
    if (!res.ok || !res.models?.length) return null
    const merged = mergeClaudeModels(res.models)
    if (latestClaudeModelsKey === claudeKey) recordClaudeModelList(merged)
    return merged.map(m => m.id)
  } catch {
    return null
  }
}

export function useClaudeModels(claudeKey: string): { id: string; label: string }[] {
  return useClaudeModelList(claudeKey).models
}
