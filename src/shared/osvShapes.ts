// OSV.dev（https://google.github.io/osv.dev/api/）の応答の読み取り（純関数のみ）。
// 形が違う応答は読み替えず、全体を null にする。別のキー名を当てにしない。
import { compareSemver, parseSemver, type SemverParts } from './semverLite'

// 先頭は英数字だけ（「.」「..」だけの ID は、URL に入れると上の階層を指してしまう）
export const OSV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

export function isOsvId(id: unknown): id is string {
  return typeof id === 'string' && OSV_ID_RE.test(id)
}

/** 画面に出すリンクは ID から自分で組む（応答の中の URL は使わない）。 */
export function osvLinkFor(id: string): string | null {
  return isOsvId(id) ? 'https://osv.dev/vulnerability/' + id : null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export interface BatchItem { ids: string[]; nextPageToken: string | null }

/** 続きを取るための値の長さの上限（そのまま次の要求に入れて送り返すので、長すぎるものは受けない）。 */
const PAGE_TOKEN_MAX = 2000

export function readBatchReply(json: unknown, expected: number): BatchItem[] | null {
  if (!isPlainObject(json)) return null
  const results = json.results
  if (!Array.isArray(results) || results.length !== expected) return null
  const out: BatchItem[] = []
  for (const r of results) {
    if (!isPlainObject(r)) return null
    const ids: string[] = []
    if (r.vulns !== undefined) {
      if (!Array.isArray(r.vulns)) return null
      for (const v of r.vulns) {
        if (!isPlainObject(v)) return null
        const id = v.id
        if (!isOsvId(id)) return null
        if (!ids.includes(id)) ids.push(id)
      }
    }
    let nextPageToken: string | null = null
    if (r.next_page_token !== undefined) {
      if (typeof r.next_page_token !== 'string' || r.next_page_token.length === 0 || r.next_page_token.length > PAGE_TOKEN_MAX) return null
      nextPageToken = r.next_page_token
    }
    out.push({ ids, nextPageToken })
  }
  return out
}

export interface OsvEvent { introduced?: string; fixed?: string; last_affected?: string; limit?: string }
export interface OsvRange { type: string; events: OsvEvent[] }
export interface OsvAffected { name: string; ecosystem: string; ranges: OsvRange[] }
export interface OsvDetail { id: string; withdrawn: boolean; severityLabel: string | null; affected: OsvAffected[] }

const EVENT_KEYS = ['introduced', 'fixed', 'last_affected', 'limit'] as const

function readEvent(v: unknown): OsvEvent | null {
  if (!isPlainObject(v)) return null
  const ev: OsvEvent = {}
  for (const k of EVENT_KEYS) {
    const x = v[k]
    if (x === undefined) continue
    if (typeof x !== 'string') return null
    ev[k] = x
  }
  return ev
}

function readRanges(v: unknown): OsvRange[] | null {
  if (v === undefined) return []
  if (!Array.isArray(v)) return null
  const out: OsvRange[] = []
  for (const r of v) {
    if (!isPlainObject(r) || typeof r.type !== 'string' || !Array.isArray(r.events)) return null
    const events: OsvEvent[] = []
    for (const e of r.events) {
      const ev = readEvent(e)
      if (!ev) return null
      events.push(ev)
    }
    out.push({ type: r.type, events })
  }
  return out
}

const SEVERITY_RE = /^[A-Za-z]{1,20}$/

export function readVulnDetail(json: unknown, expectedId: string): OsvDetail | null {
  if (!isPlainObject(json) || typeof json.id !== 'string' || json.id !== expectedId) return null
  let withdrawn = false
  if (json.withdrawn !== undefined) {
    if (typeof json.withdrawn !== 'string') return null
    withdrawn = json.withdrawn.length > 0
  }
  const affected: OsvAffected[] = []
  if (json.affected !== undefined) {
    if (!Array.isArray(json.affected)) return null
    for (const a of json.affected) {
      if (!isPlainObject(a)) return null
      const p = a.package
      if (!isPlainObject(p) || typeof p.name !== 'string' || typeof p.ecosystem !== 'string') continue
      const ranges = readRanges(a.ranges)
      if (!ranges) return null
      affected.push({ name: p.name, ecosystem: p.ecosystem, ranges })
    }
  }
  let severityLabel: string | null = null
  const ds = json.database_specific
  if (isPlainObject(ds) && typeof ds.severity === 'string' && SEVERITY_RE.test(ds.severity)) severityLabel = ds.severity
  return { id: json.id, withdrawn, severityLabel, affected }
}

/** 入っているバージョンを含む範囲の fixed のうち、いちばん大きいものを記録の文字列のまま返す。 */
export function fixedVersionFor(detail: OsvDetail, name: string, version: string): string | null {
  const v = parseSemver(version)
  if (!v) return null
  let best: { raw: string; parts: SemverParts } | null = null
  for (const a of detail.affected) {
    if (a.ecosystem !== 'npm' || a.name !== name) continue
    for (const r of a.ranges) {
      if (r.type !== 'SEMVER') continue
      let start: SemverParts | 'min' | null = null
      let cand: { raw: string; parts: SemverParts } | null = null
      let dead = false
      for (const e of r.events) {
        if (e.introduced !== undefined) {
          if (e.introduced === '0') start = 'min'
          else {
            const p = parseSemver(e.introduced)
            if (!p) { dead = true; break }
            start = p
          }
        } else if (e.fixed !== undefined) {
          const f = parseSemver(e.fixed)
          if (!f) { dead = true; break }
          if (start !== null && (start === 'min' || compareSemver(start, v) <= 0) && compareSemver(v, f) < 0) {
            if (!cand || compareSemver(f, cand.parts) > 0) cand = { raw: e.fixed, parts: f }
          }
          start = null
        } else if (e.last_affected !== undefined) {
          start = null
        }
      }
      if (dead || !cand) continue
      if (!best || compareSemver(cand.parts, best.parts) > 0) best = cand
    }
  }
  if (!best) return null
  // 選んだバージョン自身が、同じライブラリの別の範囲でまだ弱点に入る（または確かめられない）なら出さない
  return stillAffected(detail, name, best.parts) ? null : best.raw
}

/** x が、同じライブラリのどれかの範囲に入るか。読めない範囲があれば「入るかもしれない」として true。 */
function stillAffected(detail: OsvDetail, name: string, x: SemverParts): boolean {
  for (const a of detail.affected) {
    if (a.ecosystem !== 'npm' || a.name !== name) continue
    for (const r of a.ranges) {
      if (r.type !== 'SEMVER') continue
      let start: SemverParts | 'min' | null = null
      for (const e of r.events) {
        if (e.introduced !== undefined) {
          if (e.introduced === '0') start = 'min'
          else {
            const p = parseSemver(e.introduced)
            if (!p) return true
            start = p
          }
        } else if (e.fixed !== undefined) {
          const f = parseSemver(e.fixed)
          if (!f) return true
          if (start !== null && (start === 'min' || compareSemver(start, x) <= 0) && compareSemver(x, f) < 0) return true
          start = null
        } else if (e.last_affected !== undefined) {
          const la = parseSemver(e.last_affected)
          if (!la) return true
          if (start !== null && (start === 'min' || compareSemver(start, x) <= 0) && compareSemver(x, la) <= 0) return true
          start = null
        }
      }
      // 終わりの無い範囲（introduced だけ）
      if (start !== null && (start === 'min' || compareSemver(start, x) <= 0)) return true
    }
  }
  return false
}

export function highestVersion(versions: string[]): string | null {
  if (versions.length === 0) return null
  let best: { raw: string; parts: SemverParts } | null = null
  for (const raw of versions) {
    const parts = parseSemver(raw)
    if (!parts) return null
    if (!best || compareSemver(parts, best.parts) > 0) best = { raw, parts }
  }
  return best ? best.raw : null
}
