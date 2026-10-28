// shownFromEnv.ts — 破棄の main を直接呼ぶテストが、画面の代わりに渡す「確認で見せた保存場所」（0.6.24 F）。
//
// 画面は、確認の材料（共用型は cloud:teardownRecord の placements）が挙げた保存場所の組（バケット名と prefix）を、そのまま main へ運ぶ（flow.ts の shownPlacementsOf）。
// main は、その組と一致する保存場所だけを消す。画面を通さず main を `{ confirmed: true }` だけで呼ぶ試験は、見せたものが無い扱いになり、保存場所に触れなくなる。
// そこで、フォルダの記録（共用型の確認が言うのと同じ読み方: env.json の同意済み全件 + state にだけある bucket）から、見せたはずの組を作って渡す。
// electron に依存しない（記録の JSON を読むだけ）。**画面が見せなかったものを試すときは、これを使わず、組を自分で書く。**
import fs from 'node:fs'
import path from 'node:path'
import { consentedPlacementsOf } from '../src/shared/objectStorage'

export type ShownPair = { bucket: string; prefix: string }

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return null }
}

/** 共用型の確認が見せる保存場所の組を、フォルダの記録から作る（名前と prefix。並びは env.json → state にだけあるもの）。 */
export function shownFromEnv(dir: string): ShownPair[] {
  const env = readJson(path.join(dir, '.sakura-cloud', 'env.json'))
  const state = readJson(path.join(dir, '.sakura-cloud', 'state.json'))
  const fromEnv: ShownPair[] = consentedPlacementsOf(env?.persistence?.objectStorage).map(p => ({ bucket: p.bucket, prefix: p.prefix }))
  const known = new Set(fromEnv.map(p => p.bucket))
  const stateOnly: ShownPair[] = []
  for (const r of Array.isArray(state?.resources) ? state.resources : []) {
    if (!r || r.kind !== 'bucket' || typeof r.id !== 'string' || !r.id || known.has(r.id)) continue
    known.add(r.id)
    stateOnly.push({ bucket: r.id, prefix: typeof r.prefix === 'string' ? r.prefix : '' })
  }
  return [...fromEnv, ...stateOnly]
}

/** 破棄の opts に、見せた保存場所を足す（`{ confirmed: true, … }` の呼び出しをそのまま包む）。 */
export const withShown = <T extends Record<string, unknown>>(dir: string, opts: T): T & { shownPlacements: ShownPair[] } =>
  ({ ...opts, shownPlacements: shownFromEnv(dir) })

type Handler = (event: unknown, dir: any, auth: unknown, opts: any) => any

/**
 * `cloud:teardown` の本物のハンドラを包む。opts がオブジェクトで `shownPlacements` を持たず、dir が文字列のとき、フォルダの記録から見せた組を足して渡す
 * （画面の代わり。確認の印が無い・opts の形が違う・dir が文字列でない呼び出しは、そのまま通す＝断りの試験を変えない）。
 * 見せた組を試験が自分で決めるときは、opts に `shownPlacements` を書く（上書きしない）。
 */
export function shownTeardown(handler: Handler): Handler {
  return (event, dir, auth, opts) => {
    const adds = typeof dir === 'string' && dir !== '' && opts && typeof opts === 'object' && !Array.isArray(opts) && !('shownPlacements' in opts)
    return handler(event, dir, auth, adds ? { ...opts, shownPlacements: shownFromEnv(dir) } : opts)
  }
}
