import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 「②試す」改善2点（2026-09-01・実機: ScheduleAPP で helmet が node_modules に無く
// node server.js が即クラッシュ→旧実装の固定1.5秒待ちでは「接続が拒否されました」だけが
// 見えていた）の配線を固定する（tests/toolExecMainWiring.test.ts と同じ readCode 流儀）。
//
// ⚠️ コメントを外してから判定する（2026-08-20 に自分の説明コメントにテストが当たって落ちた事故の
// 再発防止。他の readCode テストと同じ流儀）。各 must/mustNot は、実装直後に実際のソースへ
// 実在すること／存在しないことを確認済み（掟10: 当て先が他の行に出ないか）。

const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

describe('WorkflowBar.tsx: ① needsInstall のとき npm install を前置する', () => {
  const src = readCode('src/renderer/components/WorkflowBar.tsx')

  it('node-server: needsInstall で npm install && node server.js、それ以外は従来どおり', () => {
    expect(src).toContain('`cd "${root}" && npm install && node server.js`')
    expect(src).toContain('`cd "${root}" && node server.js`')
    expect(src).toContain('const cmd = plan.needsInstall')
  })

  it('npm-start: needsInstall で npm install && npm start、それ以外は従来どおり', () => {
    expect(src).toContain('`cd "${root}" && npm install && npm start`')
    expect(src).toContain('`cd "${root}" && npm start`')
  })
})

describe('WorkflowBar.tsx: ② 固定1.5秒待ち（旧実装）が消え、ポート疎通確認に置き換わっている', () => {
  const src = readCode('src/renderer/components/WorkflowBar.tsx')

  it('window.setTimeout(() => window.open(openUrl), 1500) が無い（直す前の形）', () => {
    expect(src).not.toContain('window.setTimeout(() => window.open(openUrl), 1500)')
  })

  it('ensureRuntimeThenRun は openUrl があるとき waitForPortThenOpen を呼ぶ', () => {
    expect(src).toContain('void waitForPortThenOpen(openUrl)')
  })

  it('waitForPortThenOpen は api.shell.portOpen(port) をポーリングし、開通したら window.open する', () => {
    const idx = src.indexOf('async function waitForPortThenOpen(openUrl: string) {')
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, idx + 500)
    expect(block).toContain('for (let i = 0; i < 40; i++) {')
    expect(block).toContain('if (await api.shell.portOpen(port)) {')
    expect(block).toContain('window.open(openUrl)')
    expect(block).toContain('await new Promise(r => setTimeout(r, 500))')
  })

  it('タイムアウトしても serverRunning を戻していない（npm install が進行中かもしれないため。waitForPortThenOpen の中に限定して確認）', () => {
    const idx = src.indexOf('async function waitForPortThenOpen(openUrl: string) {')
    expect(idx).toBeGreaterThan(-1)
    const end = src.indexOf('\n  }\n', idx)
    const block = src.slice(idx, end)
    expect(block).not.toContain('setServerRunning')
  })
})

describe('WorkflowBar.tsx: waitForPortThenOpen はプロジェクト切替・アンマウントで中断できる', () => {
  const src = readCode('src/renderer/components/WorkflowBar.tsx')

  it('pollCancelledRef があり、切替時に effect でリセット/真にしている', () => {
    expect(src).toContain('const pollCancelledRef = useRef(false)')
    expect(src).toContain('pollCancelledRef.current = false')
    expect(src).toContain('return () => { pollCancelledRef.current = true }')
    expect(src).toContain('}, [projectDir])')
  })

  it('waitForPortThenOpen の中で pollCancelledRef.current を見てループを打ち切る', () => {
    const idx = src.indexOf('async function waitForPortThenOpen(openUrl: string) {')
    const block = src.slice(idx, idx + 500)
    expect(block).toContain('if (pollCancelledRef.current) return')
  })
})

describe('WorkflowBar.tsx: 疎通確認タイムアウト時のインライン案内', () => {
  const src = readCode('src/renderer/components/WorkflowBar.tsx')

  it('タイムアウト文言が実在する', () => {
    expect(src).toContain('サーバーの起動を確認できませんでした。下のターミナルにエラーが出ていないか確認してください')
  })

  it('showPortHint パネルが表示条件として実在する', () => {
    expect(src).toContain('{showPortHint && (')
  })
})

describe('shell:portOpen: main/preload/global.d.ts の3点セット（掟6）', () => {
  it('main: isPortOpen が export され、shell:portOpen ハンドラから呼ばれている', () => {
    const src = readCode('src/main/ipc/shell.ts')
    expect(src).toContain('export function isPortOpen(port: number): Promise<boolean> {')
    expect(src).toContain("ipcMain.handle('shell:portOpen', (_, port: number) => isPortOpen(port))")
  })

  it('preload.ts: shell.portOpen が shell:portOpen を invoke する', () => {
    const src = readCode('src/main/preload.ts')
    expect(src).toContain("portOpen: (port: number) => ipcRenderer.invoke('shell:portOpen', port),")
  })

  it('global.d.ts: shell.portOpen の型がある', () => {
    const src = readCode('src/renderer/global.d.ts')
    expect(src).toContain('portOpen(port: number): Promise<boolean>')
  })
})

// ── 開く先・バインド先は 127.0.0.1 に固定（2026-09-01 実機・IPv6 の罠）──────────────
//
// サーバー（kickoff の標準形）は 0.0.0.0＝IPv4 のみで待ち受ける。疎通確認（shell:portOpen）は
// 127.0.0.1 で成功するのに、ブラウザに localhost の URL を渡すと ::1（IPv6）を先に試して
// 「接続が拒否されました」で止まることがある（実測: curl はフォールバックしたが Chrome は
// 止まった）。**確認した先と開く先を一致させる**——URL とバインドはすべて 127.0.0.1。
describe('開く先・バインド先の 127.0.0.1 固定', () => {
  const wb = readCode('src/renderer/components/WorkflowBar.tsx')

  it('★★ node の開く先は 127.0.0.1（localhost へ戻っていない）', () => {
    expect(wb).toContain("ensureRuntimeThenRun('node', cmd, 'http://127.0.0.1:8080')")
    expect(wb).not.toContain("'http://localhost:8080'")
  })

  it('★★ php はバインドも開く先も 127.0.0.1（localhost へ戻っていない）', () => {
    expect(wb).toContain('php -S 127.0.0.1:8000')
    expect(wb).toContain("'http://127.0.0.1:8000'")
    expect(wb).not.toContain('php -S localhost:8000')
    expect(wb).not.toContain("'http://localhost:8000'")
  })
})
