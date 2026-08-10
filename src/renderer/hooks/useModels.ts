import { useEffect, useState } from 'react'
import { fetchModels, getCachedModelIds, modelLabel } from '../usage'

export interface ModelOption { id: string; label: string }

/**
 * 利用可能なモデル一覧を返すフック。
 * APIキーがあれば さくらのAI Engine から動的に取得し、無ければ（または失敗時は）
 * キャッシュ／既定のモデル一覧にフォールバックする。
 */
export function useModels(apiKey: string): ModelOption[] {
  const [ids, setIds] = useState<string[]>(() => getCachedModelIds())

  useEffect(() => {
    if (!apiKey) return
    let cancelled = false
    fetchModels(apiKey)
      .then(list => { if (!cancelled && list.length) setIds(list) })
      .catch(() => { /* 取得失敗時はキャッシュ/既定のまま */ })
    return () => { cancelled = true }
  }, [apiKey])

  return ids.map(id => ({ id, label: modelLabel(id) }))
}
