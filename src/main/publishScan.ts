// publishScan.ts — 公開されるファイルを Koto が自分で読んで点検する（main 側）。
//
// AI は呼ばず、外へは送らない。読む範囲は、実際に出るものと同じ一覧（公開は公開の根の中。GitHub 保存は保存されるファイル）。
// 秘密の形・危ない書き方の判断は findingsInWrite に任せる。戻り値には、ファイルの中身・値・絶対パスを入れない。

import * as path from 'node:path'
import { resolvePublishRoot } from './publishRootFs'
import { projectFilesInfoFs } from './ipc/fs'
import { githubSaveFilesFs } from './github/saveFiles'
import { readTextInsideDirFs, readScanFileInsideDirFs } from './readInsideDirFs'
import { findingsInWrite, hasLongLineSkipped, isSampleFileName } from '../shared/writeCheck'
import { detectRuntime } from '../shared/runtimeDetect'
import { looksSecretButPublished } from '../shared/publishExclude'
import { scanTargetOf } from '../shared/publishScanTargets'
import {
  PUBLISH_SCAN_MAX_FILES, PUBLISH_SCAN_FILE_LIMIT_BYTES, PUBLISH_SCAN_TOTAL_LIMIT_BYTES,
  PUBLISH_SCAN_SNIFF_BYTES, PUBLISH_SCAN_FINDINGS_LIMIT, PUBLISH_SCAN_NAME_LIMIT, PUBLISH_SCAN_YIELD_BYTES,
} from '../shared/publishScanLimits'
import { isServedPath, isSecretKind, severityOf, sortScanFindings, type RuntimeMode, type ScanFinding } from '../shared/securityFindings'
import type { PublishScanDone, PublishScanScope } from '../shared/publishScanTypes'

const YIELD_EVERY = 50
const PACKAGE_JSON_LIMIT_BYTES = 1_000_000

function modeOf(root: string, fileNames: readonly string[]): RuntimeMode {
  const r = readTextInsideDirFs(root, 'package.json', PACKAGE_JSON_LIMIT_BYTES)
  if (r.state !== 'text') return 'static'
  let packageJson: unknown | null = null
  try { packageJson = JSON.parse(r.content) } catch { return 'static' }
  const choice = detectRuntime({ packageJson, fileNames: fileNames.filter(f => !f.includes('/')) })
  return choice.kind === 'static' ? 'static' : 'node'
}

interface ScanSetup {
  root: string
  files: string[]
  listTruncated: boolean
  mode: RuntimeMode | null
}

function setupOf(projectDir: string, scope: PublishScanScope): ScanSetup {
  if (scope === 'github') {
    const root = path.resolve(projectDir)
    return { root, files: githubSaveFilesFs(root).included, listTruncated: false, mode: null }
  }
  const root = resolvePublishRoot(projectDir)
  const { files, truncated } = projectFilesInfoFs(root, { maxFiles: PUBLISH_SCAN_MAX_FILES, publishView: true })
  return { root, files, listTruncated: truncated, mode: modeOf(root, files) }
}

export async function runPublishScanFs(projectDir: string, scope: PublishScanScope): Promise<PublishScanDone> {
  const { root, files, listTruncated, mode } = setupOf(projectDir, scope)
  const secretsOnly = scope === 'github'
  const sorted = [...files].sort()

  const findings: ScanFinding[] = []
  const tooLarge: string[] = []
  const unreadable: string[] = []
  const longLine: string[] = []
  const overTotal: string[] = []
  const binary: string[] = []
  const sample: string[] = []
  let binaryCount = 0
  let sampleCount = 0
  let overTotalCount = 0
  let scanned = 0
  let readBytes = 0
  let yieldedAt = 0
  let tooLargeCount = 0
  let unreadableCount = 0
  let longLineCount = 0

  let i = 0
  for (const rel of sorted) {
    if (i++ > 0 && i % YIELD_EVERY === 0) await new Promise<void>(r => setImmediate(r))
    const target = scanTargetOf(rel, scope)
    if (target === 'skip') continue
    const served = mode !== null && isServedPath(mode, rel)
    if (target === 'secret-name') {
      // 'github' の一覧に入っているものは、保存される
      if (secretsOnly || looksSecretButPublished(rel)) findings.push({ kind: 'secret-name', file: rel, severity: severityOf('secret-name', served) })
      continue
    }
    if (isSampleFileName(rel)) {
      sampleCount++
      if (sample.length < PUBLISH_SCAN_NAME_LIMIT) sample.push(rel)
      continue
    }
    if (readBytes > PUBLISH_SCAN_TOTAL_LIMIT_BYTES) {
      overTotalCount++
      if (overTotal.length < PUBLISH_SCAN_NAME_LIMIT) overTotal.push(rel)
      continue
    }
    const r = readScanFileInsideDirFs(root, rel, PUBLISH_SCAN_FILE_LIMIT_BYTES, PUBLISH_SCAN_SNIFF_BYTES)
    if (r.state === 'text') {
      scanned++
      readBytes += r.bytes
      if (readBytes - yieldedAt > PUBLISH_SCAN_YIELD_BYTES) {
        yieldedAt = readBytes
        await new Promise<void>(res => setImmediate(res))
      }
      for (const f of findingsInWrite({ path: rel, before: null, after: r.content })) {
        if (secretsOnly && !isSecretKind(f.kind)) continue
        findings.push({ kind: f.kind, severity: severityOf(f.kind, served), file: rel, line: f.line, length: f.length, sample: f.sample })
      }
      if (!secretsOnly && hasLongLineSkipped(rel, r.content)) {
        longLineCount++
        if (longLine.length < PUBLISH_SCAN_NAME_LIMIT) longLine.push(rel)
      }
    } else if (r.state === 'too-large') {
      tooLargeCount++
      if (tooLarge.length < PUBLISH_SCAN_NAME_LIMIT) tooLarge.push(rel)
    } else if (r.state === 'unreadable') {
      unreadableCount++
      if (unreadable.length < PUBLISH_SCAN_NAME_LIMIT) unreadable.push(rel)
    } else if (r.state === 'binary') {
      binaryCount++
      if (binary.length < PUBLISH_SCAN_NAME_LIMIT) binary.push(rel)
    }
  }

  const ordered = sortScanFindings(findings)
  return {
    state: 'done',
    scope,
    mode,
    listed: files.length,
    scanned,
    findings: ordered.slice(0, PUBLISH_SCAN_FINDINGS_LIMIT),
    findingsTotal: ordered.length,
    notScanned: { tooLarge, tooLargeCount, unreadable, unreadableCount, longLine, longLineCount, binary, binaryCount, sample, sampleCount, overTotal, overTotalCount, listTruncated },
  }
}
