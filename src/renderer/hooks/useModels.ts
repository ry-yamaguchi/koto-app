import { useEffect, useSyncExternalStore } from 'react'
import { fetchModels, getSakuraModelList, modelLabel } from '../usage'
import { subscribeModelList, getModelListVersion } from '../modelListSignal'

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
 *
 * 一覧の本体は usage.ts の置き場に1つだけある。どの画面が取り直した一覧も、購読で全員に届く
 * （新規作成のダイアログが取り直した一覧も、開いているチャット欄に届く）。
 */
export function useModelList(apiKey: string): { models: ModelOption[]; live: boolean } {
  useSyncExternalStore(subscribeModelList, getModelListVersion, getModelListVersion)

  useEffect(() => {
    if (!apiKey) return
    fetchModels(apiKey).catch(() => { /* 取得失敗時はキャッシュ/既定のまま */ })
  }, [apiKey])

  const { ids, live } = getSakuraModelList()
  return { models: ids.map(id => ({ id, label: modelLabel(id) })), live }
}

/**
 * 提供中の一覧を取り直す（提供終了の判断の前に、古い一覧で誤らないため）。
 * 取れたら置き場も更新される。取れなかった（失敗・空）ときは null（判断の材料にしない）。
 */
export async function refetchSakuraModelIds(apiKey: string): Promise<string[] | null> {
  try {
    const ids = await fetchModels(apiKey)
    return ids.length ? ids : null
  } catch {
    return null
  }
}
