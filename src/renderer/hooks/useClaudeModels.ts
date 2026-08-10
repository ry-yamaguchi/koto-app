import { useEffect, useState } from 'react'
import { getCachedClaudeModels, mergeClaudeModels, cacheClaudeModels } from '../claudeMode'

/**
 * 利用可能な Claude モデル一覧を返すフック（useModels.ts の Claude版）。
 * Claudeキーがあれば起動時に Anthropic API から実際の提供ラインナップをライブ取得し、
 * 無ければ（または失敗時は）キャッシュ／CLAUDE_MODELS（埋め込みの固定表）にフォールバックする。
 */
export function useClaudeModels(claudeKey: string): { id: string; label: string }[] {
  const [list, setList] = useState<{ id: string; label: string }[]>(() => getCachedClaudeModels())

  useEffect(() => {
    if (!claudeKey) return
    let cancelled = false
    window.electronAPI.claude.models(claudeKey)
      .then(res => {
        if (cancelled || !res.ok || !res.models?.length) return // 取得失敗時はキャッシュ/既定のまま
        const merged = mergeClaudeModels(res.models)
        cacheClaudeModels(merged)
        setList(merged)
      })
      .catch(() => { /* 取得失敗時はキャッシュ/既定のまま（UIにエラーは出さない） */ })
    return () => { cancelled = true }
  }, [claudeKey])

  return list
}
