#!/usr/bin/env node
// check-electron-assets.mjs — Electron 本体と、配布物に入れるライセンスの2ファイルがあるかを確かめる。
//
// ── なぜ要るか ──────────────────────────────────────────────────────────
// Electron 42 以降は、npm install のときに本体を落とさない（postinstall が無くなった。
// 初めて起動したときか `npx install-electron --no` で落ちる）。本体が無いと
// node_modules/electron/dist/LICENSE と LICENSES.chromium.html も無いが、electron-builder は
// extraResources の元が無くても**警告を出して飛ばすだけ**なので、ライセンスの2ファイルが
// 黙って配布物から抜ける。ここで止める。
//
// package.json の build.extraResources のうち node_modules/electron/ から取るものを、
// 設定から読んで確かめる（ファイル名を二重に持たない）。
//
// あわせて、次の5つも確かめる（どれも黙って古い・壊れたものを配らないため）。
//   1. Brotli の誤り名の印: 同梱の Claude 実行ファイルと Electron 本体の両方に `_ERROR_FORMAT_BLOCK_SWITCH` があること。
//      google/brotli の v1.2.1（0ed4268）で decode.h に足された名前で、Brotli の復号の修正を含む版で作った
//      バイナリには必ず入る。無ければ「Brotli が直っていない版」。版の文字列（Bun v…）では判定しない。
//   2. Electron 本体の最低の macOS: Info.plist の LSMinimumSystemVersion が、package.json の
//      build.mac.minimumSystemVersion より高ければ止める（アプリの下限が本体の下限を下回ってはいけない）。
//   3. 入っている Electron 本体の版（dist/version）が package.json の electron と同じであること。
//   4. eMudhra の中間 CA 8つの公開鍵ハッシュ（GHSA-jr5w-w6x2-84p9）をバイト列で探す。
//      - Electron 本体の中の Chromium の拒否リスト8つ（cert_verify_proc_blocklist の生の32バイトの並び）
//      - 同梱の Claude 実行ファイルの拒否リスト8つ
//      ※ Node の拒否リスト（kBlockedSPKIs）は arm64 の機械語に即値として埋め込まれていて、バイト列の検索では見えない。
//        なので、これはバイト列では確かめない（次の5で版で確かめる）。
//   5. Electron の中の Node の版が v24.22.1 以上であること（Node の SubjectPublicKeyInfo の拒否リストが入る最初の版。
//      Electron の tls_adapt_the_upstream_spki_blocklist_for_electron.patch に「Node.js v24.22.1 ships the
//      SubjectPublicKeyInfo blocklist」とある。GHSA-jr5w-w6x2-84p9）。Koto の本体側の通信の大半は Node の TLS
//      （グローバルの fetch・node:https）を通るので、Chromium 側だけでは足りない。本体の実行ファイルを
//      ELECTRON_RUN_AS_NODE=1 で窓なしの Node として動かし、process.versions.node を読む。
//
//   node scripts/check-electron-assets.mjs

import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** extraResources のうち、Electron 本体の側から取るものの元のパスを返す。 */
export function electronAssetSources(extraResources) {
  return (extraResources || [])
    .map((r) => (typeof r === 'string' ? r : r && r.from))
    .filter((from) => typeof from === 'string' && from.startsWith('node_modules/electron/'))
}

/** 無いものを返す（空なら全部ある）。本体の実行ファイルも見る。 */
export function missingElectronAssets(root, extraResources, exists = existsSync) {
  const wanted = ['node_modules/electron/dist/Electron.app', ...electronAssetSources(extraResources)]
  return wanted.filter((rel) => !exists(join(root, rel)))
}

/** Brotli の修正を含む版で作ったバイナリに必ず入る名前（google/brotli v1.2.1 の decode.h）。 */
export const BROTLI_FIX_MARKER = '_ERROR_FORMAT_BLOCK_SWITCH'

/** バッファに印があるか。 */
export function bufferHasMarker(buf, marker = BROTLI_FIX_MARKER) {
  return Buffer.from(buf).includes(marker)
}

/** ファイルに印があるか。数百 MB でも全部は読まず、8MB ずつ（境目をまたぐ分は重ねて）読む。 */
export function fileHasMarker(filePath, marker = BROTLI_FIX_MARKER) {
  const needle = Buffer.from(marker)
  const CHUNK = 8 * 1024 * 1024
  const buf = Buffer.alloc(CHUNK + needle.length - 1)
  const fd = openSync(filePath, 'r')
  try {
    let carry = 0
    for (;;) {
      const n = readSync(fd, buf, carry, CHUNK, null)
      if (n === 0) return false
      const end = carry + n
      if (buf.subarray(0, end).includes(needle)) return true
      carry = Math.min(needle.length - 1, end)
      buf.copy(buf, 0, end - carry, end)
    }
  } finally {
    closeSync(fd)
  }
}

/** 同梱の Claude 実行ファイル（node_modules/@anthropic-ai/claude-agent-sdk-<OS>-<CPU>/claude）の一覧。 */
export function claudeBinaries(root, listDir = (d) => readdirSync(d), exists = existsSync) {
  const base = join(root, 'node_modules/@anthropic-ai')
  let names = []
  try { names = listDir(base) } catch { names = [] }
  return names
    .filter((n) => /^claude-agent-sdk-(darwin|linux|win32)-/.test(n))
    .map((n) => join(base, n, n.startsWith('claude-agent-sdk-win32-') ? 'claude.exe' : 'claude'))
    .filter((f) => exists(f))
}

/** Electron 本体の実行ファイル（Electron Framework）の位置。 */
export function electronFrameworkPath(root) {
  return join(root, 'node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework')
}

/**
 * Brotli の印が無いバイナリを返す（空なら問題なし）。Claude 実行ファイルが1つも無いのも問題。
 * hasMarker は差し替えられる（テストでは本物の巨大なバイナリを読まない）。
 */
export function brotliProblems(root, { hasMarker = fileHasMarker, listDir, exists = existsSync } = {}) {
  const problems = []
  const claudes = claudeBinaries(root, listDir, exists)
  if (claudes.length === 0) {
    problems.push('node_modules/@anthropic-ai/claude-agent-sdk-*/claude（同梱の Claude 実行ファイル）がありません')
  }
  const targets = [...claudes, electronFrameworkPath(root)]
  for (const f of targets) {
    if (!exists(f)) { problems.push(`${relative(root, f)} がありません`); continue }
    if (!hasMarker(f)) problems.push(`${relative(root, f)} に ${BROTLI_FIX_MARKER} がありません（Brotli が直っていない版が入っています）`)
  }
  return problems
}

/**
 * eMudhra/emSign の中間 CA のうち、秘密鍵の漏えいが報告された8つの公開鍵（SPKI）の SHA-256（16進）。
 * GHSA-jr5w-w6x2-84p9。確かめたのは次のことだけ。
 *  - 同梱の Claude 実行ファイル（Bun）は、この8つすべてを生の32バイトの並びとして含む
 *    （Bun 自身の TLS 拒否リスト。oven-sh/bun PR #46300・bun-v1.4.4）。並びは Node の一覧と違う。バイト列の確認は並びによらない。
 *  - Electron 本体（Electron Framework）についても、この確認が8つの生のバイト列を要求する（Chromium の拒否リスト。出どころの裏取りはここでは主張しない）。
 *  - Node の kBlockedSPKIs（src/crypto/crypto_context.cc）は arm64 では機械語の即値になっていて、バイト列では見えない（Node は版で確かめる）。
 * ここの並びと CN は Node の kBlockedSPKIs の注釈どおり。
 */
export const EMUDHRA_SPKI_HASHES = [
  { cn: 'EM DV TLS CA - G3C', hex: '49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f' },
  { cn: 'EM EV TLS CA - G3C', hex: '5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0' },
  { cn: 'EM OV TLS CA - G3C', hex: '63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8' },
  { cn: 'EM OV CS CA - G3C', hex: '92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30' },
  { cn: 'EM DV TLS CA - G3B', hex: 'ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105' },
  { cn: 'EM OV CS CA - G3B', hex: 'ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6' },
  { cn: 'EM OV TLS CA - G3B', hex: '43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b' },
  { cn: 'EM EV TLS CA - G3B', hex: 'e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41' },
]

/** バッファの中にある eMudhra のハッシュ（生の32バイト）の hex を返す。 */
export function bufferFindEmudhraHashes(buf) {
  const b = Buffer.from(buf)
  return EMUDHRA_SPKI_HASHES.filter((h) => b.includes(Buffer.from(h.hex, 'hex'))).map((h) => h.hex)
}

/** ファイルの中にある eMudhra のハッシュの hex を返す。8MB ずつ（境目をまたぐ分は重ねて）読む。読めなければ例外。 */
export function fileFindEmudhraHashes(filePath) {
  const needles = EMUDHRA_SPKI_HASHES.map((h) => ({ hex: h.hex, buf: Buffer.from(h.hex, 'hex') }))
  const found = new Set()
  const CHUNK = 8 * 1024 * 1024
  const OVERLAP = 31
  const buf = Buffer.alloc(CHUNK + OVERLAP)
  const fd = openSync(filePath, 'r')
  try {
    let carry = 0
    for (;;) {
      const n = readSync(fd, buf, carry, CHUNK, null)
      if (n === 0) break
      const end = carry + n
      const view = buf.subarray(0, end)
      for (const nd of needles) if (!found.has(nd.hex) && view.includes(nd.buf)) found.add(nd.hex)
      carry = Math.min(OVERLAP, end)
      buf.copy(buf, 0, end - carry, end)
    }
  } finally {
    closeSync(fd)
  }
  return [...found]
}

/**
 * eMudhra の8つのハッシュ（生のバイト列）が全部入っていないバイナリを返す（空なら問題なし）。
 * 見るのは Chromium の拒否リスト（Electron Framework の中）と同梱の Claude のもので、Node の拒否リストは見えない
 * （embeddedNodeProblems が版で確かめる）。対象は同梱の Claude 実行ファイルすべてと Electron Framework。ファイルが無い・読めないときも問題（安全側に倒す）。
 * findHashes は差し替えられる（テストでは本物の巨大なバイナリを読まない）。
 */
export function emudhraProblems(root, { findHashes = fileFindEmudhraHashes, listDir, exists = existsSync } = {}) {
  const problems = []
  const claudes = claudeBinaries(root, listDir, exists)
  if (claudes.length === 0) {
    problems.push('node_modules/@anthropic-ai/claude-agent-sdk-*/claude（同梱の Claude 実行ファイル）がありません（eMudhra の拒否リストを確かめられない）')
  }
  for (const f of [...claudes, electronFrameworkPath(root)]) {
    const name = relative(root, f)
    if (!exists(f)) { problems.push(`${name} がありません（eMudhra の拒否リストを確かめられない）`); continue }
    let found
    try { found = new Set(findHashes(f)) } catch (e) {
      problems.push(`${name} を読めません（eMudhra の拒否リストを確かめられない）: ${e && e.message ? e.message : e}`)
      continue
    }
    const lacking = EMUDHRA_SPKI_HASHES.filter((h) => !found.has(h.hex)).map((h) => h.cn)
    if (lacking.length) problems.push(`${name} に eMudhra の拒否リスト（GHSA-jr5w-w6x2-84p9）の ${lacking.join('・')} がありません`)
  }
  return problems
}

/** Node の SubjectPublicKeyInfo の拒否リストが入る最初の版（Electron の tls_adapt_the_upstream_spki_blocklist_for_electron.patch・GHSA-jr5w-w6x2-84p9）。 */
export const NODE_SPKI_BLOCKLIST_MIN = [24, 22, 1]

/** Electron 本体の実行ファイル（macOS）の位置。 */
export function electronExecutablePath(root) {
  return join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
}

/** 子の Node に渡す環境変数。CLAUDE*・ANTHROPIC*（大文字小文字は問わない）は引き継がず、ELECTRON_RUN_AS_NODE=1 を足す。 */
export function embeddedNodeEnv(parentEnv = process.env) {
  const env = {}
  for (const [k, v] of Object.entries(parentEnv)) if (!/^(CLAUDE|ANTHROPIC)/i.test(k)) env[k] = v
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

/** 失敗の原文（stderr があればその先頭 300 字を1行にしたもの）を添えた説明にする。 */
export function failureDetail(e) {
  const err = e && e.stderr ? String(e.stderr).replace(/\s+/g, ' ').trim().slice(0, 300) : ''
  const msg = e && e.message ? String(e.message) : String(e)
  return err ? `${msg}（stderr: ${err}）` : msg
}

/** Electron 本体を窓なしの Node として動かし、process.versions.node を返す。失敗は例外（stderr は e.stderr に残る）。exec は差し替えられる。 */
export function runEmbeddedNodeVersion(exe, { exec = execFileSync, parentEnv = process.env } = {}) {
  return exec(exe, ['-p', 'process.versions.node'], {
    env: embeddedNodeEnv(parentEnv), timeout: 20000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Electron の中の Node が v24.22.1 以上かを返す（空なら問題なし）。
 * Node の拒否リストは機械語に埋め込まれていてバイト列で探せないので、版で確かめる。
 * 安全側に倒す: 本体が無い・動かない・出力が読めない・版が低い、はどれも問題。
 * runNode(exe) は差し替えられる（テストでは本物の本体を動かさない）。
 */
export function embeddedNodeProblems(root, { runNode = runEmbeddedNodeVersion, exists = existsSync } = {}) {
  const exe = electronExecutablePath(root)
  const name = relative(root, exe)
  const need = NODE_SPKI_BLOCKLIST_MIN.join('.')
  if (!exists(exe)) return [`${name} がありません（Electron の中の Node の版を確かめられない）`]
  let out
  try { out = runNode(exe) } catch (e) {
    return [`${name} を Node として動かせません（Electron の中の Node の版を確かめられない）: ${failureDetail(e)}`]
  }
  const m = String(out || '').trim().match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return [`Electron の中の Node の版を読めません（出力: ${JSON.stringify(String(out || '').trim().slice(0, 80))}）`]
  const have = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) {
    if (have[i] > NODE_SPKI_BLOCKLIST_MIN[i]) return []
    if (have[i] < NODE_SPKI_BLOCKLIST_MIN[i]) {
      return [`Electron の中の Node が v${have.join('.')} です（eMudhra の拒否リスト GHSA-jr5w-w6x2-84p9 を持つのは v${need} 以上）`]
    }
  }
  return []
}

/** "13.0"・"13" などを [主, 副] の数にする。読めなければ null。 */
function parseMajorMinor(v) {
  const m = String(v || '').match(/^(\d+)(?:\.(\d+))?/)
  return m ? [Number(m[1]), Number(m[2] || 0)] : null
}

/** Info.plist（XML）の LSMinimumSystemVersion を返す。無ければ null。 */
export function plistMinimumSystemVersion(plistText) {
  const m = String(plistText).match(/<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/)
  return m ? m[1].trim() : null
}

/**
 * Electron 本体との突き合わせの問題を返す（空なら問題なし）。
 *  - アプリの下限（build.mac.minimumSystemVersion）が本体の LSMinimumSystemVersion 未満
 *  - dist/version が package.json の electron と違う
 */
export function electronConsistencyProblems(pkg, { plistText, distVersion }) {
  const problems = []
  const appMin = pkg && pkg.build && pkg.build.mac && pkg.build.mac.minimumSystemVersion
  const electronMinText = plistMinimumSystemVersion(plistText)
  const a = parseMajorMinor(appMin)
  const e = parseMajorMinor(electronMinText)
  if (!a) problems.push(`package.json の build.mac.minimumSystemVersion が読めません: ${appMin}`)
  else if (!e) problems.push('Electron 本体の Info.plist に LSMinimumSystemVersion がありません')
  else if (a[0] < e[0] || (a[0] === e[0] && a[1] < e[1])) {
    problems.push(`build.mac.minimumSystemVersion ${appMin} が Electron 本体の最低の macOS ${electronMinText} より低い（動かない OS に配られる）`)
  }
  const want = pkg && pkg.devDependencies && pkg.devDependencies.electron
  const have = String(distVersion || '').trim()
  if (!want || have !== want) {
    problems.push(`入っている Electron 本体の版 ${have || '(不明)'} が package.json の electron ${want || '(なし)'} と違います`)
  }
  return problems
}

/**
 * 配布物の部品の問題を全部集めて返す（空なら問題なし）。CLI はこれを呼ぶだけ。
 * 各検査は deps で差し替えられる（テストでは、どれか1つを呼び忘れたら落ちるように偽を渡す）。
 */
export function allElectronAssetProblems(root, pkg, deps = {}) {
  const d = {
    brotli: brotliProblems, emudhra: emudhraProblems, embeddedNode: embeddedNodeProblems,
    consistency: electronConsistencyProblems, readConsistencyInput: readConsistencyInput, ...deps,
  }
  const problems = []
  problems.push(...d.brotli(root))
  problems.push(...d.emudhra(root))
  problems.push(...d.embeddedNode(root))
  problems.push(...d.consistency(pkg, d.readConsistencyInput(root)))
  return problems
}

/** electronConsistencyProblems に渡す材料（Info.plist と dist/version）を実物から読む。 */
export function readConsistencyInput(root) {
  const dist = join(root, 'node_modules/electron/dist')
  return {
    plistText: readFileSync(join(dist, 'Electron.app/Contents/Info.plist'), 'utf8'),
    distVersion: existsSync(join(dist, 'version')) ? readFileSync(join(dist, 'version'), 'utf8') : '',
  }
}

if (process.argv[1] && process.argv[1].endsWith('check-electron-assets.mjs')) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const sources = electronAssetSources(pkg.build && pkg.build.extraResources)
  if (sources.length === 0) {
    console.error('❌ package.json の build.extraResources に Electron のライセンスがありません（配布物から抜ける）。')
    process.exit(1)
  }
  const missing = missingElectronAssets(root, pkg.build.extraResources)
  if (missing.length) {
    console.error('❌ Electron 本体かライセンスのファイルがありません（Electron 42 以降は npm install で本体を落とさない）:')
    for (const m of missing) console.error(`   - ${m}`)
    console.error('   `npx install-electron --no` で落としてからやり直してください（npm run ensure:electron）。')
    process.exit(1)
  }
  console.log('✅ Electron 本体と配布するライセンスの2ファイルがあります')

  const problems = allElectronAssetProblems(root, pkg)
  if (problems.length) {
    console.error('❌ 配布物の部品に問題があります:')
    for (const p of problems) console.error(`   - ${p}`)
    process.exit(1)
  }
  console.log('✅ Brotli の修正の印・最低の macOS・Electron の版・eMudhra の拒否リスト（Chromium の8つ［Electron 本体の中・バイト列］・同梱の Claude の8つ［バイト列］・Electron の中の Node が v24.22.1 以上［版で確かめる。Node の拒否リストは機械語に埋め込まれていてバイト列では見えない］）に問題はありません')
}
