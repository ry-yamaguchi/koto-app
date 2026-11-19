// バージョンの厳密な形と大小の比べ方（純関数のみ）。
// 形は https://semver.org/ の 2.0.0 の厳密な形だけを受け、大小は同じ仕様書の 11 節に従う。
// ビルドの印（+…）は大小に関わらないので持たない。

export interface SemverParts { major: number; minor: number; patch: number; pre: string[] }

const MAX_LENGTH = 100
const NUM = '(0|[1-9]\\d*)'
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
const SEMVER_RE = new RegExp(
  `^${NUM}\\.${NUM}\\.${NUM}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
)

/** 厳密な形なら分解した値を、そうでなければ null を返す。 */
export function parseSemver(v: unknown): SemverParts | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_LENGTH) return null
  const m = SEMVER_RE.exec(v)
  if (!m) return null
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return { major, minor, patch, pre: m[4] === undefined ? [] : m[4].split('.') }
}

export function isExactVersion(v: unknown): v is string {
  return parseSemver(v) !== null
}

const isNumericId = (s: string): boolean => /^\d+$/.test(s)

function cmp<T>(a: T, b: T): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0
}

function comparePreId(a: string, b: string): -1 | 0 | 1 {
  const an = isNumericId(a)
  const bn = isNumericId(b)
  if (an && bn) {
    // 先頭の 0 が無いので、桁数 → 文字列の順で数の大小になる（大きな数でも精度が落ちない）
    return a.length !== b.length ? cmp(a.length, b.length) : cmp(a, b)
  }
  if (an) return -1
  if (bn) return 1
  return cmp(a, b)
}

export function compareSemver(a: SemverParts, b: SemverParts): -1 | 0 | 1 {
  const core = cmp(a.major, b.major) || cmp(a.minor, b.minor) || cmp(a.patch, b.patch)
  if (core !== 0) return core as -1 | 1
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const n = Math.min(a.pre.length, b.pre.length)
  for (let i = 0; i < n; i++) {
    const c = comparePreId(a.pre[i], b.pre[i])
    if (c !== 0) return c
  }
  return cmp(a.pre.length, b.pre.length)
}
