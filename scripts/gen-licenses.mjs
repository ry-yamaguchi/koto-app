#!/usr/bin/env node
// 依存パッケージのライセンス一覧（第三者OSSライセンス）を収集し、
// docs/third-party-licenses.html を生成するスクリプト。
// ローカルにインストールされた license-checker-rseidelsohn を実行して
// 依存ツリー全体のライセンス情報をJSONで取得する。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, isAbsolute } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const outPath = join(projectRoot, 'docs', 'third-party-licenses.html')

// HTMLエスケープ（& < > " ' をすべて変換）
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// license-checker-rseidelsohn をローカル実行（同梱はしない）
function collectLicenses() {
  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'npx.cmd' : 'npx'
  const stdout = execFileSync(
    cmd,
    ['--no-install', 'license-checker-rseidelsohn', '--json', '--relativeLicensePath', '--start', '.'],
    { cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
  return JSON.parse(stdout)
}

function readLicenseText(licenseFile) {
  if (!licenseFile) return '(ライセンス本文が見つかりませんでした)'
  const abs = isAbsolute(licenseFile) ? licenseFile : join(projectRoot, licenseFile)
  try {
    if (existsSync(abs)) {
      const text = readFileSync(abs, 'utf8')
      if (text && text.trim()) return text
    }
  } catch {
    // ignore
  }
  return '(ライセンス本文が見つかりませんでした)'
}

// "name@version" 形式のキーから name と version を分離（スコープ付き対応）
function splitNameVersion(key) {
  const at = key.lastIndexOf('@')
  if (at <= 0) return { name: key, version: '' }
  return { name: key.slice(0, at), version: key.slice(at + 1) }
}

function main() {
  const data = collectLicenses()

  // ルートの自パッケージ名は package.json から読む。
  // 以前は 'sakura-ide@' をハードコードしており、koto へ改名した際に除外が効かなくなって
  // 自分自身が「第三者ライセンス一覧」に混入していた。改名で再発しないよう実名を参照する。
  const rootName = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).name

  const entries = []
  for (const [key, info] of Object.entries(data)) {
    if (key.startsWith(`${rootName}@`)) continue
    const { name, version } = splitNameVersion(key)
    entries.push({
      name,
      version,
      licenses: info.licenses || '(不明)',
      repository: info.repository || '',
      publisher: info.publisher || '',
      licenseText: readLicenseText(info.licenseFile),
    })
  }

  entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

  const cards = entries.map((e) => {
    const licenses = Array.isArray(e.licenses) ? e.licenses.join(', ') : e.licenses
    const repoLink = e.repository
      ? `<a href="${escapeHtml(e.repository)}">${escapeHtml(e.repository)}</a>`
      : '<span class="muted">（リポジトリ情報なし）</span>'
    const publisher = e.publisher
      ? `<div class="meta"><span class="k">作者</span> ${escapeHtml(e.publisher)}</div>`
      : ''
    return `  <section class="pkg">
    <h2><b>${escapeHtml(e.name)}</b> <span class="ver">${escapeHtml(e.version)}</span></h2>
    <div class="meta"><span class="k">ライセンス</span> ${escapeHtml(licenses)}</div>
    ${publisher}
    <div class="meta"><span class="k">リポジトリ</span> ${repoLink}</div>
    <pre>${escapeHtml(e.licenseText)}</pre>
  </section>`
  }).join('\n')

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>オープンソースライセンス - Koto</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0;
    padding: 0 0 64px;
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", "Segoe UI", sans-serif;
    color: #2b2b33;
    background: #fafafc;
    line-height: 1.7;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 0 24px; }
  header {
    background: linear-gradient(135deg, #ff7eb6 0%, #ff5c8d 100%);
    color: #fff;
    padding: 32px 0 28px;
    margin-bottom: 28px;
  }
  header .wrap { padding-top: 0; padding-bottom: 0; }
  header h1 { margin: 0 0 6px; font-size: 26px; }
  header p { margin: 0; opacity: .95; font-size: 14px; }
  .pkg {
    background: #fff;
    border: 1px solid #ececf2;
    border-radius: 14px;
    padding: 18px 22px;
    margin-bottom: 16px;
  }
  .pkg h2 { font-size: 17px; margin: 0 0 10px; color: #d6336c; }
  .pkg h2 b { color: #2b2b33; }
  .ver {
    display: inline-block; font-size: 12px; font-weight: 500;
    color: #8a3d58; background: #fff7fa; border: 1px solid #ffd9e6;
    border-radius: 6px; padding: 0 7px; margin-left: 6px; vertical-align: middle;
  }
  .meta { font-size: 13px; margin: 2px 0; color: #555; }
  .meta .k { display: inline-block; min-width: 76px; color: #9a3d5c; font-weight: 600; }
  .muted { color: #9a9aa8; }
  a { color: #d6336c; word-break: break-all; }
  pre {
    background: #f7f7fb; border: 1px solid #ececf2; border-radius: 10px;
    padding: 12px 14px; margin: 12px 0 0; font-size: 12px;
    font-family: "SF Mono", Menlo, Consolas, monospace;
    white-space: pre-wrap; word-break: break-word;
    max-height: 360px; overflow: auto;
  }
  footer { text-align: center; color: #9a9aa8; font-size: 12px; margin-top: 24px; }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <h1>オープンソースライセンス</h1>
    <p>Koto は以下のオープンソースソフトウェアを利用しています。全 ${entries.length} 件。</p>
    <p>※ Electron に同梱される Chromium 等のライセンスは、メニューバーの［ヘルプ］→［Chromium 等のライセンス（Electron同梱）］からご覧いただけます。</p>
  </div>
</header>

<div class="wrap">
${cards}

  <footer>© 2026 meryo</footer>
</div>
</body>
</html>
`

  writeFileSync(outPath, html, 'utf8')
  console.log(`Generated ${outPath} with ${entries.length} packages.`)
}

main()
