// OSV.dev（https://api.osv.dev）への照会。同意が無ければ1件も通信しない。
// 外へ出る口はこのファイルの2つの定数だけ。応答の形の判断は shared/osvShapes.ts に置く。
import type { LockDep } from '../../shared/lockfileDeps'
import type { OsvStopReason, OsvStop, OsvVuln, OsvFinding, OsvRunResult } from '../../shared/osvTypes'
import { failureDetailOf } from '../../shared/failureText'
import {
  OSV_BATCH_SIZE, OSV_MAX_PACKAGES, OSV_MAX_PAGE_ROUNDS, OSV_DETAIL_LIMIT, OSV_DETAIL_CONCURRENCY,
  OSV_BATCH_TIMEOUT_MS, OSV_DETAIL_TIMEOUT_MS, OSV_BATCH_REPLY_LIMIT_BYTES, OSV_DETAIL_REPLY_LIMIT_BYTES,
} from '../../shared/osvLimits'
import {
  isOsvId, osvLinkFor, readBatchReply, readVulnDetail, fixedVersionFor, highestVersion,
  type BatchItem, type OsvDetail,
} from '../../shared/osvShapes'

export const OSV_QUERYBATCH_URL = 'https://api.osv.dev/v1/querybatch'
export const OSV_VULN_URL_PREFIX = 'https://api.osv.dev/v1/vulns/'

export interface OsvRunOptions {
  /** 画面の初回の確認を通ったときだけ true。true でなければ1件も通信しない。 */
  consented: boolean
  deps: LockDep[]
  fetchImpl: typeof fetch
}
export type { OsvStopReason, OsvStop, OsvVuln, OsvFinding, OsvRunResult } from '../../shared/osvTypes'

class StopError extends Error {
  constructor(readonly stop: OsvStop) { super(stop.detail) }
}

function stopOfException(e: unknown): OsvStop {
  const name = (e as { name?: unknown } | null)?.name
  const reason: OsvStopReason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'offline'
  return { reason, detail: failureDetailOf(e) }
}

class TooLarge extends Error {}

/** 本文を読みながら上限で打ち切る。 */
async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      throw new TooLarge()
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.byteLength }
  return new TextDecoder().decode(buf)
}

async function postBatch(fetchImpl: typeof fetch, queries: unknown[]): Promise<BatchItem[]> {
  let text: string
  try {
    const res = await fetchImpl(OSV_QUERYBATCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ queries }),
      redirect: 'error',
      signal: AbortSignal.timeout(OSV_BATCH_TIMEOUT_MS),
    })
    if (res.status !== 200) {
      let head = ''
      try { head = (await readLimited(res, OSV_BATCH_REPLY_LIMIT_BYTES)).slice(0, 200) } catch { /* 本文は添え物 */ }
      throw new StopError({ reason: 'http', detail: failureDetailOf(new Error('HTTP ' + res.status + ': ' + head)) })
    }
    text = await readLimited(res, OSV_BATCH_REPLY_LIMIT_BYTES)
  } catch (e) {
    if (e instanceof StopError) throw e
    if (e instanceof TooLarge) throw new StopError({ reason: 'too-large', detail: failureDetailOf(new Error('応答が大きすぎます')) })
    throw new StopError(stopOfException(e))
  }
  let json: unknown
  try { json = JSON.parse(text) } catch { json = undefined }
  const items = readBatchReply(json, queries.length)
  if (!items) throw new StopError({ reason: 'shape', detail: failureDetailOf(new Error('読み取れない応答: ' + text.slice(0, 200))) })
  return items
}

async function fetchDetail(fetchImpl: typeof fetch, id: string): Promise<OsvDetail | null> {
  try {
    const res = await fetchImpl(OSV_VULN_URL_PREFIX + id, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(OSV_DETAIL_TIMEOUT_MS),
    })
    if (res.status !== 200) return null
    const text = await readLimited(res, OSV_DETAIL_REPLY_LIMIT_BYTES)
    return readVulnDetail(JSON.parse(text), id)
  } catch {
    return null
  }
}

export async function runOsvCheck(opts: OsvRunOptions): Promise<OsvRunResult> {
  if (opts.consented !== true) return { kind: 'not-consented' }
  try {
    return await run(opts)
  } catch (e) {
    const total = Array.isArray(opts.deps) ? opts.deps.length : 0
    return { kind: 'done', total, sent: 0, checked: 0, findings: [], withdrawn: 0, stop: stopOfException(e) }
  }
}

async function run(opts: OsvRunOptions): Promise<OsvRunResult> {
  const { deps, fetchImpl } = opts
  const total = deps.length
  const targets = deps.slice(0, OSV_MAX_PACKAGES)
  const idsOf: string[][] = targets.map(() => [])
  let sent = 0
  let checked = 0
  let stop: OsvStop | null = null
  const addIds = (idx: number, ids: string[]): void => {
    for (const id of ids) if (!idsOf[idx].includes(id)) idsOf[idx].push(id)
  }
  const queryOf = (i: number, token?: string): unknown => ({
    package: { name: targets[i].name, ecosystem: 'npm' },
    version: targets[i].version,
    ...(token !== undefined ? { page_token: token } : {}),
  })

  try {
    for (let start = 0; start < targets.length; start += OSV_BATCH_SIZE) {
      const idxs: number[] = []
      for (let i = start; i < Math.min(start + OSV_BATCH_SIZE, targets.length); i++) idxs.push(i)
      let first: BatchItem[]
      try {
        first = await postBatch(fetchImpl, idxs.map((i) => queryOf(i)))
      } catch (e) {
        // 要求が相手に届いたと言えるのは、応答を受けた回だけ（回線断・時間切れは数えない）
        if (e instanceof StopError && (e.stop.reason === 'http' || e.stop.reason === 'shape' || e.stop.reason === 'too-large')) sent += idxs.length
        throw e
      }
      sent += idxs.length
      let pending: { idx: number; token: string }[] = []
      first.forEach((it, k) => {
        addIds(idxs[k], it.ids)
        if (it.nextPageToken !== null) pending.push({ idx: idxs[k], token: it.nextPageToken })
      })
      for (let round = 0; round < OSV_MAX_PAGE_ROUNDS && pending.length > 0; round++) {
        const items = await postBatch(fetchImpl, pending.map((p) => queryOf(p.idx, p.token)))
        const next: { idx: number; token: string }[] = []
        items.forEach((it, k) => {
          addIds(pending[k].idx, it.ids)
          if (it.nextPageToken !== null) next.push({ idx: pending[k].idx, token: it.nextPageToken })
        })
        pending = next
      }
      // 続きが残った項目の ids は結果に出すが、調べきれていないので checked には数えない
      checked += idxs.length - pending.length
    }
  } catch (e) {
    stop = e instanceof StopError ? e.stop : stopOfException(e)
  }

  // 詳細（止まった回は取らない）
  const details = new Map<string, OsvDetail | 'unreadable'>()
  if (stop === null) {
    const all: string[] = []
    for (const ids of idsOf) for (const id of ids) if (!all.includes(id)) all.push(id)
    const todo = all.filter(isOsvId).slice(0, OSV_DETAIL_LIMIT)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < todo.length) {
        const id = todo[next++]
        const d = await fetchDetail(fetchImpl, id)
        details.set(id, d ?? 'unreadable')
      }
    }
    await Promise.all(Array.from({ length: Math.min(OSV_DETAIL_CONCURRENCY, todo.length) }, worker))
  }

  const withdrawnIds = new Set<string>()
  const findings: OsvFinding[] = []
  targets.forEach((dep, i) => {
    const vulns: OsvVuln[] = []
    for (const id of idsOf[i]) {
      const d = details.get(id)
      if (d && d !== 'unreadable' && d.withdrawn) { withdrawnIds.add(id); continue }
      if (d && d !== 'unreadable') {
        vulns.push({ id, link: osvLinkFor(id), fixed: fixedVersionFor(d, dep.name, dep.version), severityLabel: d.severityLabel, detail: 'ok' })
      } else {
        vulns.push({ id, link: osvLinkFor(id), fixed: null, severityLabel: null, detail: d === 'unreadable' ? 'unreadable' : 'not-fetched' })
      }
    }
    if (vulns.length === 0) return
    const allFixed = vulns.every((v) => v.detail === 'ok' && v.fixed !== null)
    findings.push({
      name: dep.name,
      version: dep.version,
      vulns,
      fixedAll: allFixed ? highestVersion(vulns.map((v) => v.fixed as string)) : null,
    })
  })
  findings.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0))

  return { kind: 'done', total, sent, checked, findings, withdrawn: withdrawnIds.size, stop }
}
