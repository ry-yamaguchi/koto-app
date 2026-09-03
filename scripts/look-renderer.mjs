// look-renderer.mjs — **画面が本当に描けているか**を、自分の目で確かめるための道具。
//
// ── なぜ要るか（掟2「ビルドが通ること＝画面が出ること、ではない」）──────────
// レンダラのエラーは main の stdout に出ない。テストが緑でも、JSX が壊れていれば
// 画面は白いまま。**表示に関わる変更は、実際に描かせて見る。**
//
// ── 触ってはいけないもの ──────────────────────────────────────────────
// - **利用者の保存領域**（2026-08-19、スモークが同じ領域を使い、強制終了で
//   localStorage が壊れて中央ストアのAPIキーが全部消えた）。**使い捨ての
//   `--user-data-dir` で起動する。**
// - **キー**（掟4）。使い捨ての領域にはキーが無いので、キーが要る画面は
//   そのままでは出ない。見たいときは**ソースの門を一時的に開けて**確かめ、
//   必ず戻す（ミューテーション試験と同じやり方。偽のキーを localStorage に
//   置くと safeStorage がキーチェーンに項目を作るので、そちらは採らない）。
//
// 使い方:
//   npm run build                     # 先に dist/ を作る（これを描かせる）
//   node scripts/look-renderer.mjs <出力.png> [light|dark] <プロジェクトの絶対パス>
//
// 出力: 撮った画面と、DOM から読んだ要点、レンダラの致命的なログ。
import { spawn, execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'

/** リポジトリの根（このファイルの位置から求める。**個人のパスを埋め込まない**）。 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const OUT = process.argv[2]
const THEME = process.argv[3] || 'light'
const PROJECT = process.argv[4]
if (!OUT || !PROJECT) {
  console.log('使い方: node scripts/look-renderer.mjs <出力.png> [light|dark] <プロジェクトの絶対パス>')
  process.exit(1)
}
const WS = path.dirname(PROJECT)
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-look-'))
// 起動しただけで実ワークスペース（既定のホーム配下）へ移行が走るため、HOMEごと使い捨てにする
// （main の fs:homeDir は os.homedir() 実装のため $HOME の差し替えが効く）。
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-look-home-'))
const PORT = 9333 + Math.floor(Math.random() * 200)

const child = spawn('npx', ['electron', '.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`], {
  cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HOME: HOME_DIR, ELECTRON_ENABLE_LOGGING: '1' },
})
let log = ''
child.stdout.on('data', d => { log += d })
child.stderr.on('data', d => { log += d })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const cleanup = () => {
  try { execSync(`pkill -f "user-data-dir=${PROFILE}"`, { stdio: 'ignore' }) } catch {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(HOME_DIR, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)
setTimeout(() => { console.log('⏱ 時間切れ'); cleanup(); process.exit(1) }, 100000)

let wsUrl = null
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    wsUrl = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl
  } catch {}
  if (!wsUrl) await sleep(500)
}
if (!wsUrl) { console.log('CDP に繋がりませんでした'); cleanup(); process.exit(1) }

const sock = new WebSocket(wsUrl)
await new Promise(r => sock.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
sock.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise(res => {
  const n = ++id
  pending.set(n, res)
  setTimeout(() => { if (pending.has(n)) { pending.delete(n); res(null) } }, 20000)
  sock.send(JSON.stringify({ id: n, method, params }))
})
const evaluate = expression => send('Runtime.evaluate', { expression, returnByValue: true })
  .then(r => r?.result?.result?.value)

await evaluate(`localStorage.setItem('sakura_workspace', ${JSON.stringify(WS)});`
  + `localStorage.setItem('sakura_current_dir', ${JSON.stringify(PROJECT)});`
  + `localStorage.setItem('sakura_onboarded','1');`
  + `localStorage.setItem('sakura_theme', ${JSON.stringify(THEME)}); 'ok'`)
await send('Page.reload')
await sleep(9000)
// 起動直後は画面側の初期化と競合して開かないことがある。開くまで数回試す。
for (let i = 0; i < 3; i++) {
  const opened = await evaluate(`document.body.innerText.includes('プロジェクトの場所') ? 'not-open' : 'open'`)
  if (opened === 'open') break
  await evaluate(`localStorage.setItem('sakura_current_dir', ${JSON.stringify(PROJECT)}); 'ok'`)
  await send('Page.reload')
  await sleep(7000)
}

// 会話の先頭（古いほう）へ寄せる。区切りは上にあるので、下端のままだと写らない。
console.log('巻き戻し:', await evaluate(
  `(()=>{const el=[...document.querySelectorAll('div')].find(d=>d.className&&String(d.className).includes('overflow-y-auto')&&d.scrollHeight>d.clientHeight+50);`
  + `if(!el)return 'スクロール先が無い';el.scrollTop=0;return 'ok'})()`))
await sleep(1200)

console.log('画面から読めたもの:', await evaluate(
  `JSON.stringify({marks:[...document.querySelectorAll('span')].map(e=>e.textContent).filter(t=>t==='日時の記録がありません'||/^(今日|昨日|\\d+月\\d+日（.）|\\d{4}年\\d+月\\d+日（.）)$/.test(t||'')),`
  + `times:[...document.querySelectorAll('span,div')].map(e=>e.childElementCount===0&&e.textContent).filter(t=>/^\\d\\d:\\d\\d$/.test(t||'')),`
  + `bubbles:document.querySelectorAll('.rounded-2xl').length})`))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.result?.data) { fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64')); console.log('撮りました:', OUT) }
else console.log('撮れませんでした')
const fatal = log.match(/Uncaught|Minified React error|Invariant|is not a function|Cannot read/gi)
console.log('レンダラの致命的なログ:', fatal ? [...new Set(fatal)].join(' / ') : 'なし')
sock.close(); cleanup(); process.exit(0)
