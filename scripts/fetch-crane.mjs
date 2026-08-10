// crane（go-containerregistry）の単体バイナリを build/bin/ に取得する。
// Dockerを使わずにコンテナイメージをビルド/プッシュするために同梱する（Apache-2.0）。
// 既に存在すればスキップ。dist/start の前に実行する。
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

const VERSION = 'v0.21.6'
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x86_64'
const URL = `https://github.com/google/go-containerregistry/releases/download/${VERSION}/go-containerregistry_Darwin_${ARCH}.tar.gz`
const BIN_DIR = path.join(process.cwd(), 'build', 'bin')
const BIN = path.join(BIN_DIR, 'crane')

if (fs.existsSync(BIN)) {
  console.log(`crane は既に存在します: ${BIN}（スキップ）`)
  process.exit(0)
}

fs.mkdirSync(BIN_DIR, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crane-'))
const tgz = path.join(tmp, 'crane.tgz')
try {
  console.log(`crane ${VERSION} (${ARCH}) を取得中…`)
  execFileSync('curl', ['-sSL', '-o', tgz, URL], { stdio: ['ignore', 'inherit', 'inherit'] })
  // tarball から crane だけを取り出す
  execFileSync('tar', ['xzf', tgz, '-C', tmp, 'crane'], { stdio: 'inherit' })
  fs.copyFileSync(path.join(tmp, 'crane'), BIN)
  fs.chmodSync(BIN, 0o755)
  console.log(`✅ crane を配置しました: ${BIN}`)
} catch (e) {
  console.error('crane の取得に失敗しました:', e?.message ?? e)
  process.exit(1)
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
}
