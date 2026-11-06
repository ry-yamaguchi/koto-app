// registryPreflight.ts — 公開前の確認（cloud:preflight）の「コンテナレジストリ」の行を決める（0.6.26）。
// 一覧を読めなかった回を「無い」と読むと、実在するレジストリを「見つかりません」と言い、
// 作り直しのボタンまで出してしまう。読めなかったときは何も断定せず、押せるものも出さない。
// 判断は electron 非依存の関数に置き、偽の client で振る舞いを確かめる（掟10）。

import { readContainerRegistryList, type SakuraCloudClient } from './client'
import type { PreflightCheck } from '../../shared/preflight'
import { withFailureDetail } from '../../shared/failureText'

const LABEL = 'コンテナレジストリ'
export const REGISTRY_UNREADABLE_NOTE = 'レジストリの一覧の応答を読み取れませんでした（公開はできます）。'

type Row = Pick<PreflightCheck, 'status' | 'note' | 'fix'>

export async function registryPreflightRow(
  client: Pick<SakuraCloudClient, 'listContainerRegistries'>,
  region: string,
  recorded: string | undefined,
): Promise<{ id: 'registry'; label: string } & Row> {
  const row = (r: Row) => ({ id: 'registry' as const, label: LABEL, ...r })
  const unconfirmed = (e?: unknown) => row({ status: 'warn', note: e === undefined ? '確認できませんでした（公開はできます）。' : withFailureDetail('確認できませんでした（公開はできます）。', e) })
  try {
    const listed = await client.listContainerRegistries(region)
    if (!(listed.dryRun === false && listed.ok)) return unconfirmed()
    const rows = readContainerRegistryList(listed.data)
    if (!recorded) return row({ status: 'ok', note: '公開のときに用意します。' })
    // 形が読めない応答は「0件」ではない。見つからないとも言わず、作り直しも勧めない
    if (rows === null) return row({ status: 'warn', note: REGISTRY_UNREADABLE_NOTE })
    if (rows.some(r => r.subdomainLabel === recorded)) return row({ status: 'ok', note: `『${recorded}』が使えます。` })
    // **直し方が分かっているなら、その場で押せるようにする**（2026-08-14 Ryosuke 指摘）
    return row({ status: 'ng', note: `『${recorded}』が見つかりません（削除された可能性があります）。下のボタンで作り直せます。`, fix: 'reset-registry' })
  } catch (e) { return unconfirmed(e ?? new Error('unknown')) }
}
