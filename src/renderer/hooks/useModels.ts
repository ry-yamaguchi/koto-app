import { useEffect, useState } from 'react'
import { fetchModels, getCachedModelIds, modelLabel } from '../usage'

export interface ModelOption { id: string; label: string }

/**
 * 利用可能なモデル一覧を返すフック。
 * APIキーがあれば さくらのAI Engine から動的に取得し、無ければ（または失敗時は）
 * キャッシュ／既定のモデル一覧にフォールバックする。
 */
export function useModels(apiKey: string): ModelOption[] {
  return useModelList(apiKey).models
}

/**
 * useModels に「この一覧は今回サービスから実際に取得できたものか」を添えた版。
 * live が false のとき（キー無し・取得失敗・取得前）の一覧は、キャッシュ／予備の一覧であり、
 * 提供中かどうかの根拠にはならない（保存済みの既定モデルを書き換える判断には使わない）。
 */
export function useModelList(apiKey: string): { models: ModelOption[]; live: boolean } {
  const [ids, setIds] = useState<string[]>(() => getCachedModelIds())
  const [live, setLive] = useState(false)

  useEffect(() => {
    if (!apiKey) return
    let cancelled = false
    fetchModels(apiKey)
      .then(list => { if (!cancelled && list.length) { setIds(list); setLive(true) } })
      .catch(() => { /* 取得失敗時はキャッシュ/既定のまま */ })
    return () => { cancelled = true }
  }, [apiKey])

  return { models: ids.map(id => ({ id, label: modelLabel(id) })), live }
}
