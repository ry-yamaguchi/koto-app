import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { runPublishScanView } from '../src/renderer/publishScanRun'

const ROOT = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
const count = (src: string, needle: string) => src.split(needle).length - 1
const SECTION = 'src/renderer/components/SecurityCheckSection.tsx'

describe('SecurityCheckSection の配線', () => {
  const s = read(SECTION)
  const flow = read('src/renderer/securityCheckFlow.ts')
  it('Koto の点検は流れの1か所だけから呼び、点検の流れに送る口を渡さない', () => {
    expect(count(s, "runScan: (dir) => runPublishScanResult(dir, 'publish'),")).toBe(1)
    expect(count(s, 'void runScanFlow({')).toBe(1)
    const a = s.indexOf('void runScanFlow({')
    const b = s.indexOf('void runAiFlow({')
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
    expect(s.slice(a, b)).not.toContain('runSecurityCheck')
    // 直接呼ぶのは流れの中の1か所だけ
    expect(count(s, 'runSecurityCheck(')).toBe(0)
    expect(count(flow, 'a.deps.runSecurityCheck(')).toBe(1)
    expect(count(flow, 'runSecurityCheck(')).toBe(1)
  })
  it('AI の確認は見積りの枠のボタンからだけ始まる（点検のボタンは runScan だけ）', () => {
    expect(count(s, 'void runAiFlow({')).toBe(1)
    expect(count(s, 'onRun={runAi}')).toBe(1)
    expect(count(s, 'onClick={runScan}')).toBe(1)
    expect(count(s, 'function runAi() {')).toBe(1)
    expect(count(s, 'runAi()')).toBe(1) // 定義だけ（呼ぶ所は見積りの枠の onRun だけ）
    // 流れの中でも、点検の流れは送る口を呼ばない
    const scanFlow = flow.slice(flow.indexOf('export async function runScanFlow'), flow.indexOf('export type AiFlowEnd'))
    expect(scanFlow).not.toContain('runSecurityCheck')
    expect(s).toContain('runSecurityCheck,\n        writeRecord:')
  })
  it('点検のあとに勝手に AI の確認が続く仕組み（旧い順番の部品・中止の印）が無い', () => {
    for (const w of ['runSecuritySteps', 'securityCheckSteps', 'stopRef', 'aiStopped', 'aiRan', 'AI_STOPPED_NOTE']) expect(s).not.toContain(w)
  })
  it('中止の出し分けは AI の確認が走っている間だけ（点検の間は出さない）', () => {
    expect(count(s, '{aiRunning && mine && (\n            <button')).toBe(1)
    expect(count(s, '{aiRunning && (\n            <p className="text-[11px] text-ink-muted">')).toBe(1)
    expect(s).toContain("'中止しています。少しお待ちください。'")
    expect(s).toContain('時間がかかるときは「⏹ 中止する」で AI の確認を止められます。途中までの結果は「確認した」ことにはしません。')
    expect(s).not.toContain('AI への問い合わせが終わるまで')
    const st = s.indexOf('function stop() {')
    expect(s.slice(st, s.indexOf('\n  }', st))).toContain('if (!aiRunning) return')
  })
  it('進み具合と中止の口は、走らせたプロジェクトの画面にだけ出す（別のプロジェクトへ替えたら出さない）', () => {
    expect(count(s, 'const mine = checking && runDir === projectDir')).toBe(1)
    expect(count(s, '{mine && (\n        <>\n          <p className="text-xs text-ink-secondary">⏳ {progress')).toBe(1)
    expect(s).not.toContain('{checking && (')
    // 走らせたプロジェクトは、始めるときに置き、終わるときに外す（点検と AI の確認の両方）
    expect(count(s, 'setRunDir(projectDir)')).toBe(2)
    expect(count(s, 'setRunDir(null)')).toBe(2)
  })
  it('見積りの枠は点検の結果の下・AI の結果の前に1回だけ。キーが消えたら出さない', () => {
    const el = '{estimate && apiKey && (\n        <AiCheckEstimateBox estimate={estimate} running={aiRunning && mine} disabled={checking} onRun={runAi} />'
    expect(count(s, el)).toBe(1)
    expect(count(s, '{scan && <PublishScanResult view={scan.view} />}')).toBe(1)
    expect(s.indexOf('{scan && <PublishScanResult')).toBeLessThan(s.indexOf(el))
    expect(s.indexOf(el)).toBeLessThan(s.indexOf('{result && ('))
    expect(count(s, '{scan && !apiKey && <p className="text-[11px] text-ink-muted">{PUBLISH_SCAN_NO_AI_NOTE}</p>}')).toBe(1)
  })
  it('上のボタンは1つで、札は点検中だけ変わる', () => {
    expect(count(s, '{scanning ? PUBLISH_SCAN_BUSY : PUBLISH_SCAN_BUTTON_NO_AI}')).toBe(1)
    expect(s).not.toContain('apiKey ? \'AIに確認してもらう\'')
    expect(count(s, '<button\n            onClick={runScan}\n            disabled={checking}')).toBe(1)
  })
  it('【ファイルを点検する】で3つとも消し、【AIに確認してもらう】では AI の結果だけを消す', () => {
    const a = s.indexOf('function runScan() {')
    const b = s.indexOf('function runAi() {')
    const c = s.indexOf('function stop() {')
    const scanBody = s.slice(a, b)
    const aiBody = s.slice(b, c)
    for (const w of ['setResult(null)', 'setScan(null)', 'setEstimate(null)']) expect(scanBody).toContain(w)
    expect(aiBody).toContain('setResult(null)')
    expect(aiBody).not.toContain('setScan(null)')
    expect(aiBody).not.toContain('setEstimate(null)')
  })
  it('プロジェクトが変わったら、点検の結果・見積り・AI の結果を消す', () => {
    const e = s.indexOf('useEffect(() => {')
    const eff = s.slice(e, s.indexOf('}, [projectDir])'))
    for (const w of ['setResult(null)', 'setScan(null)', 'setEstimate(null)']) expect(eff).toContain(w)
  })
  it('押した時点のプロジェクトかの判断は dirRef 1つで、流れに渡す', () => {
    expect(count(s, 'const isCurrent = (dir: string) => dirRef.current === dir')).toBe(1)
    expect(count(s, '      isCurrent,')).toBe(2)
  })
  it('「前回の確認」の記録は1回だけ書く（押した時点の鍵へ）。置くのは流れが渡した記録だけ', () => {
    expect(count(s, 'window.localStorage.setItem(checkRecordKey(dir), JSON.stringify(rec))')).toBe(1)
    expect(count(s, 'window.localStorage.setItem(')).toBe(1)
    expect(s).toContain('if (rec) setRecord(rec)')
    expect(flow).toContain("if (r.verdict === 'ok' || r.verdict === 'warn') {")
  })
  it('修正のボタンは1つで、2つの枠の下。点検の項目と AI の項目を1つの依頼文にする', () => {
    expect(count(s, "window.dispatchEvent(new CustomEvent('sakura:fix-with-ai'")).toBe(1)
    expect(count(s, '🛠 AIに修正させる')).toBe(1)
    expect(count(s, 'buildSecurityFixPrompt(')).toBe(1)
    expect(s).toContain('const fixPrompt = buildSecurityFixPrompt(mergeFixItems(scan?.fixItems ?? [], fixItemsOf(result?.findings ?? [])))')
    expect(s).toContain('{fixPrompt !== null && !checking && (')
    expect(s.indexOf('{fixPrompt !== null && !checking && (')).toBeGreaterThan(s.indexOf('{result && ('))
    expect(s.indexOf('{fixPrompt !== null && !checking && (')).toBeLessThan(s.indexOf('<OsvCheckBlock'))
    expect(s).toContain('押すとチャットに移り、AIに直すよう頼みます（AIが応答中のときは入力欄に入るので、終わってから送信してください）')
  })
  it('説明の文は、キーがあるとき・無いときで出し分ける', () => {
    const open = s.indexOf('{apiKey ? (\n          <>')
    const mid = s.indexOf(') : (', open)
    const end = s.indexOf(')}\n      </p>', mid)
    expect(open).toBeGreaterThan(-1)
    expect(mid).toBeGreaterThan(open)
    expect(end).toBeGreaterThan(mid)
    const withKey = s.slice(open, mid)
    const noKey = s.slice(mid, end)
    expect(withKey).toContain('Koto の点検と AI の確認で調べます。')
    expect(noKey).toContain('Koto が点検します。')
    for (const part of [withKey, noKey]) {
      expect(part).toContain('公開されるファイルを、原則すべて確認します（確認しきれなかったファイルは、結果に名前を出します）。')
      expect(part).toContain('簡易的な確認であるため、最終的にはご自身で確認してください。')
    }
    // AI Engine へ送る話は、キーがあるときの側にだけある
    expect(withKey).toContain('AI の確認では、ファイルの中身をさくらのAI Engine へ送ります。')
    expect(withKey).toContain('パスワードなどに見えるものは伏せて送ります。')
    expect(noKey).not.toContain('AI Engine')
    expect(noKey).not.toContain('伏せて送ります')
    expect(withKey).toContain('チェック後、修正するかどうか選択可能です。')
    expect(noKey).not.toContain('修正するかどうか')
    expect(s).not.toContain('AIによる簡易的な確認')
    expect(s).not.toContain('簡易的なセキュリティチェックを実施')
  })
  it('OsvCheckBlock は </section> の直前のまま', () => {
    expect(s).toContain('<OsvCheckBlock projectDir={projectDir} />\n    </section>')
  })
})

describe('結果の描き方と呼び出し元', () => {
  it('PublishScanResult に、AI の結果の描き方を書かない', () => {
    const p = read('src/renderer/components/PublishScanResult.tsx')
    for (const w of ['<SecurityReportBody', '<pre', 'AiText', 'sakura.chat', '{result && (', 'koto_seccheck']) expect(p).not.toContain(w)
    expect(p).toContain('rounded-lg border border-line p-3 space-y-1 select-text')
  })
  const scan = () => {
    const out = { api: [] as string[], run: [] as string[] }
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) { walk(rel); continue }
        if (!/\.tsx?$/.test(e.name) || rel.endsWith('.d.ts')) continue
        const src = read(rel)
        if (src.includes('electronAPI.publishScan.')) out.api.push(rel)
        if (src.includes('runPublishScanView(') && !rel.endsWith('publishScanRun.ts')) out.run.push(rel)
      }
    }
    walk('src/renderer')
    return out
  }
  it('electronAPI.publishScan. を呼ぶのは publishScanRun.ts だけ', () => {
    expect(scan().api).toEqual(['src/renderer/publishScanRun.ts'])
  })
  it('runPublishScanView を呼ぶのは GithubSaveScan（github）だけ。🛡 の節は結果と修正の項目を返す口を使う', () => {
    expect(scan().run).toEqual(['src/renderer/components/GithubSaveScan.tsx'])
    expect(count(read('src/renderer/components/GithubSaveScan.tsx'), "runPublishScanView(started, 'github')")).toBe(1)
    expect(count(read(SECTION), "runPublishScanResult(dir, 'publish')")).toBe(1)
  })
  it('GitHub 保存の点検には修正のボタンを足さない', () => {
    const g = read('src/renderer/components/GithubSaveScan.tsx')
    for (const w of ['sakura:fix-with-ai', 'buildSecurityFixPrompt', 'AIに修正させる', 'runSecurityCheck']) expect(g).not.toContain(w)
  })
})

describe('runPublishScanView', () => {
  const g = globalThis as unknown as { window?: unknown }
  afterEach(() => { delete g.window })
  it('成功の返事は画面の行になり、scope を渡す', async () => {
    const calls: unknown[][] = []
    g.window = { electronAPI: { publishScan: { run: async (...a: unknown[]) => { calls.push(a); return { state: 'bad-dir' } } } } }
    const v = await runPublishScanView('/p', 'github')
    expect(calls).toEqual([['/p', 'github']])
    expect(v.verdict).toBe('skip')
    expect(v.lines[0].text).toContain('点検できません')
  })
  it('拒否されても throw せず、⏭ の失敗の行になる', async () => {
    g.window = { electronAPI: { publishScan: { run: async () => { throw new Error('boom') } } } }
    const v = await runPublishScanView('/p', 'publish')
    expect(v.verdict).toBe('skip')
    expect(v.lines[0].kind).toBe('failure')
    expect(v.lines[0].text.startsWith('⏭ ')).toBe(true)
  })
})
