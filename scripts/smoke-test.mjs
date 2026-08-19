// パッケージ済みアプリ（release/mac-arm64/...）を実際に起動し、
// 数秒間で「起動できない／画面が描画されない」致命的エラーが出ないかを確認するスモークテスト。
// `npm run dist` の後に実行する想定。問題があれば非ゼロ終了する。
//
// 重要: ELECTRON_ENABLE_LOGGING=1 を付けて起動し、**レンダラ（画面側）のコンソールエラーも拾う**。
//   メイン側 stdout だけ見ていると、レンダラのJS実行時エラー（真っ黒画面）を見逃すため。
import { spawn, execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const APP = 'release/mac-arm64/Koto.app/Contents/MacOS/Koto'
const LOG = '/tmp/sakura-smoke.log'
const WAIT_MS = 11000

if (!fs.existsSync(APP)) {
  console.error(`❌ パッケージ版が見つかりません: ${APP}\n   先に \`npm run dist\` を実行してください。`)
  process.exit(1)
}

// ── **利用者の保存領域を使わない**（2026-08-19 の事故）────────────────────
// このスモークテストは、起動して11秒後に SIGTERM と pkill で**強制終了**する。
// ところが既定では利用者と同じ保存領域（~/Library/Application Support/Koto）を
// 使うため、**書き込みの途中で殺すと localStorage（leveldb）が壊れる**。
// 2026-08-19 09:00:50 にこのテストが走り、09:01:32 に leveldb が作り直され、
// **中央ストアに入っていたAPIキーが全部消えた**（さくらのAI Engine・Claude・
// GitHub・HANAMII）。ファイルで持っているもの（さくらのクラウド・レジストリ）
// だけが残った。復元手段は無かった。
//
// 起動できるかを見るのが目的なので、**使い捨ての保存領域**で十分である。
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-smoke-profile-'))

const out = fs.openSync(LOG, 'w')
const child = spawn(APP, [`--user-data-dir=${PROFILE}`], {
  stdio: ['ignore', out, out],
  detached: true,
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1', // レンダラのconsoleをstdout/stderrへ
    SMOKE_CLAUDE_BINARY_CHECK: '1', // C系 C1-4: Claude Agent SDK のネイティブバイナリがパッケージから実行できるか検証
  },
})
child.unref()

console.log(`起動スモークテスト中…（${WAIT_MS / 1000}秒待機）`)
await new Promise(r => setTimeout(r, WAIT_MS))

// 起動したアプリと取りこぼしプロセスを終了。
// **使い捨ての保存領域で起動したものだけ**を狙う（利用者が開いている Koto を巻き込まない）。
try { process.kill(child.pid, 'SIGTERM') } catch { /* 既に終了 */ }
try { execSync(`pkill -f "user-data-dir=${PROFILE}"`, { stdio: 'ignore' }) } catch { /* 無ければ無視 */ }

const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''

// 「画面が描画されない／起動が壊れている」ことを示す致命的パターン（レンダラ・メイン両方）。
// ELECTRON_ENABLE_LOGGING は INFO ログが多く "error" 部分一致は誤検知するため、致命パターンに絞る。
const FATAL = [
  /Cannot access '[^']+' before initialization/, // TDZ（循環参照・宣言前参照）＝今回の真っ黒画面の原因
  /\bUncaught\b/,
  /\bReferenceError\b/, /\bTypeError\b/, /\bSyntaxError\b/,
  /render-process-gone|Renderer process .*crashed|did-fail-load/,
  /Failed to load resource|net::ERR/,
]
const lines = log.split('\n')
const hits = lines.filter(l => FATAL.some(re => re.test(l)))

if (hits.length > 0) {
  console.error(`❌ スモークテスト失敗: 致命的エラーを検出（${hits.length}件）。画面が描画されない可能性があります。`)
  console.error('--- 該当ログ ---\n' + hits.slice(0, 10).join('\n'))
  process.exit(1)
}

// C系 C1-4: Claude Agent SDK のネイティブバイナリが「パッケージ済みアプリ」から実行できるかの検証。
// asar化・asarUnpack設定に問題があるとここで検出される（main.ts が SMOKE_CLAUDE_BINARY_CHECK=1 のときのみログ出力）。
if (!lines.some(l => l.includes('[claude-binary-check] ok'))) {
  console.error('❌ スモークテスト失敗: Claudeバイナリがパッケージから実行できません（[claude-binary-check] ok が見つかりません）。')
  const failLine = lines.find(l => l.includes('[claude-binary-check]'))
  if (failLine) console.error('--- 該当ログ ---\n' + failLine)
  process.exit(1)
}

try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch { /* 消せなくても害は無い */ }

console.log(`✅ スモークテスト成功（起動${WAIT_MS / 1000}秒・レンダラ/メインに致命的エラーなし・Claudeバイナリ実行OK）`)
