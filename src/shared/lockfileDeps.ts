// package-lock.json の文字列から、外の脆弱性データベース（OSV.dev）へ送ってよい
// 「ライブラリの名前とバージョン」の一覧を決める（純関数のみ）。
// 送ってよいか迷うものは送らない（非公開のライブラリの名前を外へ漏らさないため）。
// ただし、registry.npmjs.org に置かれた非公開のライブラリは、URL の形が公開のものと同じで見分けられない（送られる）。
// 「送ってよいか」の判断はこのファイルの lockfileDeps だけに置く。
import { isExactVersion } from './semverLite'

export interface LockDep { name: string; version: string }
export interface LockSkipped { dev: number; notPublic: number; badShape: number }
export interface RootDeps { dependencies: Record<string, string>; optionalDependencies: Record<string, string> }
export type LockfilePlan =
  | { state: 'ok'; deps: LockDep[]; skipped: LockSkipped; rootDeps: RootDeps | null }
  | { state: 'unsupported' }
  | { state: 'unreadable' }

export type ManifestMatch = 'match' | 'mismatch' | 'unreadable'

export const PUBLIC_REGISTRY_PREFIX = 'https://registry.npmjs.org/'

const NAME_RE = /^(?:@[A-Za-z0-9-~][A-Za-z0-9-._~]*\/)?[A-Za-z0-9-~][A-Za-z0-9-._~]*$/
const NAME_MAX = 214
const NODE_MODULES = 'node_modules/'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

/** 値が全部文字列の物ならコピーを返す。無ければ空の物。物でない・文字列でない値があれば null。 */
function stringMap(v: unknown): Record<string, string> | null {
  if (v === undefined) return {}
  if (!isPlainObject(v)) return null
  const out: Record<string, string> = {}
  for (const k of Object.keys(v)) {
    const x = v[k]
    if (typeof x !== 'string') return null
    // キー __proto__ もそのまま自分の項目として写す（代入だと捨てられる）
    Object.defineProperty(out, k, { value: x, enumerable: true, writable: true, configurable: true })
  }
  return out
}

function rootDepsOf(o: Record<string, unknown>): RootDeps | null {
  const dependencies = stringMap(o.dependencies)
  const optionalDependencies = stringMap(o.optionalDependencies)
  if (!dependencies || !optionalDependencies) return null
  return { dependencies, optionalDependencies }
}

export function lockfileDeps(text: string): LockfilePlan {
  const root = parseJson(text)
  if (!isPlainObject(root)) return { state: 'unreadable' }
  const ver = root.lockfileVersion
  if ((ver !== 2 && ver !== 3) || !isPlainObject(root.packages)) return { state: 'unsupported' }
  const packages = root.packages

  const skipped: LockSkipped = { dev: 0, notPublic: 0, badShape: 0 }
  const seen = new Set<string>()
  const deps: LockDep[] = []

  for (const key of Object.keys(packages)) {
    if (key === '') continue
    const entry = packages[key]
    if (!isPlainObject(entry)) { skipped.badShape++; continue }
    if (entry.link === true) continue
    if (!key.includes(NODE_MODULES)) continue
    if (entry.dev === true) { skipped.dev++; continue }
    if (entry.version === undefined && entry.resolved === undefined) continue

    let name: string
    if (entry.name !== undefined) {
      if (typeof entry.name !== 'string') { skipped.badShape++; continue }
      name = entry.name
    } else {
      name = key.slice(key.lastIndexOf(NODE_MODULES) + NODE_MODULES.length)
    }
    if (name.length > NAME_MAX || !NAME_RE.test(name)) { skipped.badShape++; continue }

    const version = entry.version
    // ビルドの印（+…）つきは送らない（自由な文字列を外へ出さないため）
    if (!isExactVersion(version) || version.includes('+')) { skipped.badShape++; continue }

    const resolved = entry.resolved
    if (typeof resolved !== 'string' || !resolved.startsWith(`${PUBLIC_REGISTRY_PREFIX}${name}/-/`)) {
      skipped.notPublic++
      continue
    }

    const id = `${name}\n${version}`
    if (seen.has(id)) continue
    seen.add(id)
    deps.push({ name, version })
  }

  deps.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0))

  const rootEntry = packages['']
  return { state: 'ok', deps, skipped, rootDeps: isPlainObject(rootEntry) ? rootDepsOf(rootEntry) : null }
}

export function manifestDeps(packageJsonText: string): RootDeps | null {
  const o = parseJson(packageJsonText)
  return isPlainObject(o) ? rootDepsOf(o) : null
}

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] === a[k])
}

/** 文字列の一致だけを見る（範囲を満たすかの計算はしない）。 */
export function manifestMatch(root: RootDeps | null, manifest: RootDeps | null): ManifestMatch {
  if (!root || !manifest) return 'unreadable'
  return sameMap(root.dependencies, manifest.dependencies) && sameMap(root.optionalDependencies, manifest.optionalDependencies)
    ? 'match'
    : 'mismatch'
}

export function hasProductionDeps(m: RootDeps): boolean {
  return Object.keys(m.dependencies).length > 0 || Object.keys(m.optionalDependencies).length > 0
}

/** 確認の窓に見せる例（「名前 バージョン」）。package.json に直接書かれたライブラリを先に選ぶ。 */
export function exampleDeps(deps: LockDep[], rootDeps: RootDeps | null, count: number): string[] {
  const direct = rootDeps ? rootDeps.dependencies : {}
  const isDirect = (d: LockDep) => Object.prototype.hasOwnProperty.call(direct, d.name)
  const ordered = [...deps.filter(isDirect), ...deps.filter((d) => !isDirect(d))]
  const out: string[] = []
  for (const d of ordered) {
    if (out.length >= Math.max(0, count)) break
    const s = `${d.name} ${d.version}`
    if (!out.includes(s)) out.push(s)
  }
  return out
}
