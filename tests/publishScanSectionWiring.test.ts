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
  it('Koto の点検は1回だけで、AI の部分より前', () => {
    const call = "await runPublishScanView(projectDir, 'publish')"
    expect(count(s, call)).toBe(1)
    expect(s.indexOf(call)).toBeLessThan(s.indexOf('await runSecurityCheck('))
  })
  it('AI の部分は apiKey があるときだけ呼ぶ', () => {
    const call = 'await runSecurityCheck(projectDir, apiKey, setProgress, (abort) => { abortRef.current = abort })'
    expect(count(s, call)).toBe(1)
    expect(count(s, 'ai: apiKey ? async () => {')).toBe(1)
    expect(s).not.toContain('if (apiKey) {')
    const gate = s.indexOf('ai: apiKey ? async () => {')
    const close = s.indexOf('} : null,', gate)
    expect(gate).toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(gate)
    expect(s.indexOf(call)).toBeGreaterThan(gate)
    expect(s.indexOf(call)).toBeLessThan(close)
    // 門のあとに別の呼びが無い
    expect(s.indexOf('runSecurityCheck(', gate)).toBe(s.indexOf(call) + 'await '.length)
    expect(s.indexOf('runSecurityCheck(', close)).toBe(-1)
  })
  it('順番は runSecuritySteps に任せ、中止の印を配線する', () => {
    expect(count(s, 'await runSecuritySteps({')).toBe(1)
    expect(count(s, 'stopRequested: () => stopRef.current,')).toBe(1)
    const st = s.indexOf('function stop() {')
    const stBody = s.slice(st, s.indexOf('\n  }', st))
    expect(stBody).toContain('stopRef.current = true')
    const run = s.indexOf('async function run() {')
    const reset = s.indexOf('stopRef.current = false', run)
    expect(reset).toBeGreaterThan(-1)
    expect(reset).toBeLessThan(s.indexOf('await runSecuritySteps({'))
    // 前の回の「中止したため行っていません」を、次の回へ持ち越さない
    const noteReset = s.indexOf('setAiStopped(false)', run)
    expect(noteReset).toBeGreaterThan(-1)
    expect(noteReset).toBeLessThan(s.indexOf('await runSecuritySteps({'))
    expect(count(s, 'setAiStopped(false)')).toBe(1)
    // 中止を待つ間の文は、AI への問い合わせを待っているとは言わない（AI を呼ぶ前に押した回・キーが無い回がある）
    expect(s).toContain("'中止しています。少しお待ちください。'")
    expect(s).not.toContain('AI への問い合わせが終わるまで')
    expect(s).toContain("if (end === 'stopped-before-ai' && dirRef.current === started) setAiStopped(true)")
  })
  it('中止の注記は1回だけで、{result && ( より前', () => {
    const el = '{scan && aiStopped && <p className="text-[11px] text-ink-muted">{PUBLISH_SCAN_AI_STOPPED_NOTE}</p>}'
    expect(count(s, el)).toBe(1)
    expect(s.indexOf(el)).toBeLessThan(s.indexOf('{result && ('))
  })
  it('結果は {result && ( より前に1回だけ描く', () => {
    const el = '{scan && <PublishScanResult view={scan} />}'
    expect(count(s, el)).toBe(1)
    expect(s.indexOf(el)).toBeLessThan(s.indexOf('{result && ('))
    expect(count(s, '{scan && !aiRan && <p className="text-[11px] text-ink-muted">{PUBLISH_SCAN_NO_AI_NOTE}</p>}')).toBe(1)
  })
  it('AI の確認を走らせる回かは押した時点の apiKey で決め、注記と中止の出し分けはそれを使う', () => {
    expect(count(s, 'setAiRan(!!apiKey)')).toBe(1)
    expect(count(s, '{checking && aiRan && (')).toBe(1)
    expect(count(s, '{aiRan && (\n            <p className="text-[11px] text-ink-muted">')).toBe(1)
    expect(s).toContain('時間がかかるときは「⏹ 中止する」で AI の確認を止められます。途中までの結果は「確認した」ことにはしません。')
    expect(s).not.toContain('「⏹ 中止する」を押すと、AI の確認を止めます')
    expect(s).not.toContain('時間がかかるときは「⏹ 中止する」で止められます')
  })
  it('「前回の確認」の記録は1回だけで、AI の確認が実施できた分岐の中にある', () => {
    const set = 'window.localStorage.setItem(checkRecordKey(projectDir)'
    expect(count(s, set)).toBe(1)
    const ai = s.indexOf('ai: apiKey ? async () => {')
    const ok = s.indexOf("if (r.verdict === 'ok' || r.verdict === 'warn') {", ai)
    expect(ai).toBeGreaterThan(-1)
    expect(ok).toBeGreaterThan(ai)
    expect(s.indexOf(set)).toBeGreaterThan(ok)
    expect(s.indexOf(set)).toBeLessThan(s.indexOf('} : null,', ok))
  })
  it('ボタンの札を apiKey の有無で出し分ける', () => {
    expect(count(s, "{checking ? '確認中…' : apiKey ? 'AIに確認してもらう' : PUBLISH_SCAN_BUTTON_NO_AI}")).toBe(1)
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
  it('押した時点のプロジェクトのままのときだけ結果を置く（成功・例外の両方）', () => {
    expect(count(s, 'if (dirRef.current === started) setScan(view)')).toBe(1)
  })
  it('プロジェクトが変わったら前の点検の結果を消す', () => {
    expect(count(s, 'useEffect(() => { setScan(null) }, [projectDir])')).toBe(1)
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
  it('runPublishScanView を呼ぶのは SecurityCheckSection（publish）と GithubSaveScan（github）だけ', () => {
    expect(scan().run.sort()).toEqual([SECTION, 'src/renderer/components/GithubSaveScan.tsx'].sort())
    expect(count(read('src/renderer/components/GithubSaveScan.tsx'), "runPublishScanView(started, 'github')")).toBe(1)
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
