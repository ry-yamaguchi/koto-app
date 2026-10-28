import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { stoppedWhenText } from '../src/shared/inFlightOps'
import { STAGE_TIMING_STOPPED_WORDS } from '../src/shared/stageTiming'

// ── 「どこにどれくらい時間がかかったか」の配線（2026-10-07）─────────────────────────────────────
// 振る舞い（段の記録・保存・目安・双子の値）は stageTimingRecord / stageTimingHandlers / stageTimingFlows / stageEstimate が
// 実際に動かして固定している。ここは**画面と IPC が、その部品を通している**ことと、**固定の目安の文が残っていない**ことを、
// 呼び出しの形ごとに確かめる（文字列の一致は「そう書いてあるか」しか見ないので、単独では信用せず、変異試験で
// 「壊すと落ちる」ことを確かめてある）。

const ROOT = path.join(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
/** コメントを除いたコード（文字列の中の // は残す）。 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`])\/\/.*$/gm, '$1')
const count = (src: string, needle: string) => src.split(needle).length - 1
const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e => {
  const rel = `${dir}/${e.name}`
  return e.isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(e.name) ? [rel] : []
})
const SRC = walk('src')

const panel = read('src/renderer/components/AppRunDedicatedPanel.tsx')
const modal = read('src/renderer/components/PublishModal.tsx')
// 2026-10-08: 手順6の進み具合・結果の見た目は、📡 の行と共有する別の部品へ移した。
// 0.6.22 3B-5・3B-6a: 📡 の行も手順6も、共通の部品（TeardownProgress・TeardownResultView）に替わった。手順6の節は DedicatedTeardownSection.tsx。
const teardownProgress = read('src/renderer/components/teardown/TeardownProgress.tsx')
const teardownResult = read('src/renderer/components/teardown/TeardownResultView.tsx')
const teardownSection = read('src/renderer/components/DedicatedTeardownSection.tsx')
const actions = read('src/renderer/apprunDedicatedActions.ts')

describe('IPC の3点セット（掟6）: stageTiming:estimates は main・preload・global.d.ts が揃っている', () => {
  it('main: ipc/stageTiming.ts が登録し、registerAllHandlers（ipc/index.ts）が呼ぶ', () => {
    const ipc = read('src/main/ipc/stageTiming.ts')
    expect(ipc).toContain("ipcMain.handle('stageTiming:estimates'")
    expect(ipc).toContain('estimatesFor(loadStageTimings())') // 目安の決め方は shared の純関数・読むのは保存の部品
    const index = read('src/main/ipc/index.ts')
    expect(index).toContain("import { registerStageTimingHandlers } from './stageTiming'")
    expect(count(index, 'registerStageTimingHandlers()')).toBe(1)
  })

  it('preload: window.electronAPI.stageTiming.estimates が同じチャンネルを呼ぶ', () => {
    const preload = read('src/main/preload.ts')
    expect(preload).toContain("estimates: () => ipcRenderer.invoke('stageTiming:estimates')")
    expect(preload).toMatch(/stageTiming: \{\s*(\/\/[^\n]*\n\s*)*estimates:/)
  })

  it('global.d.ts: 型が宣言されている（値は StageEstimate の一覧）', () => {
    const d = read('src/renderer/global.d.ts')
    expect(d).toContain('stageTiming: {')
    expect(d).toContain("estimates(): Promise<Record<string, import('../shared/stageEstimate').StageEstimate>>")
  })

  it('画面から段の名前などを受け取らない（引数なし）。送るのも読み取りだけ', () => {
    const ipc = read('src/main/ipc/stageTiming.ts')
    expect(ipc).toMatch(/ipcMain\.handle\('stageTiming:estimates', \(\) =>/)
    expect(ipc).not.toMatch(/ipcMain\.handle\('[^']+', [^)]*(projectDir|auth|stage)/)
  })

  it('保存の口（setStageTimingSink）は ipc/stageTiming.ts の1か所だけで付ける。日付・版・ゾーン以外（場所・名前）は渡さない', () => {
    const users = SRC.filter(f => /setStageTimingSink\(/.test(code(read(f))) && f !== 'src/main/projectOps.ts')
    expect(users).toEqual(['src/main/ipc/stageTiming.ts'])
    const ipc = code(read('src/main/ipc/stageTiming.ts'))
    expect(ipc).toContain('recordStageTimings({')
    expect(ipc).not.toMatch(/projectDir/)
  })
})

describe('専有型のハンドラは、段の切り替わりを記録へ渡し、結果に時間を載せる', () => {
  const ipc = read('src/main/ipc/apprunDedicated.ts')
  // 削除は 0.6.22 段階3B-1 から、仕様書（ipc/apprunDedicatedTeardown.ts）と共通の骨（cloud/teardownShell.ts）に載った。
  // 段の送り口（stageReporter）・進み具合の送り口・段の時間を返り値へ載せる・ゾーンを渡す、は骨が持ち、仕様書は ctx から flow へ渡す。
  const td = code(read('src/main/ipc/apprunDedicatedTeardown.ts'))
  const shell = code(read('src/main/cloud/teardownShell.ts'))
  const block = (channel: string) => {
    const a = ipc.indexOf(`ipcMain.handle('${channel}'`)
    expect(a, `${channel} が無い`).toBeGreaterThan(-1)
    const b = ipc.indexOf('\n  ipcMain.handle(', a + 10)
    return ipc.slice(a, b > 0 ? b : undefined)
  }

  it('★ 3本とも stageReporter を作り、flow の onStage へ渡す（渡し忘れると時間が測れない）。削除の stageReporter は骨が作り、仕様書が ctx から渡す。アプリだけを消す teardownApp は無い', () => {
    expect(block('apprunDedicated:create')).toContain('const onStage = stageReporter(projectDir)')
    expect(block('apprunDedicated:create')).toContain('createClusterFlow(auth, projectDir, spec, { confirmed: isConfirmed(opts), onStage })')
    // 削除: 骨の ctx が段の送り口を持ち、仕様書の run が teardownFlow の onStage へ渡す（渡し忘れると時間が測れない）
    expect(shell).toContain('onStage: stageReporter(projectDir),')
    expect(td).toContain('const { projectDir, auth, progress, onStage } = ctx')
    expect(td).toContain('teardownFlow(auth, projectDir, { confirmed: true, progress, onStage })')
    expect(block('apprunDedicated:publishApp')).toContain('const onStage = stageReporter(projectDir)')
    expect(block('apprunDedicated:publishApp')).toContain('}, { confirmed: isConfirmed(opts), progress, onStage })')
    expect(ipc).not.toContain("ipcMain.handle('apprunDedicated:teardownApp'")
    expect(td).not.toContain('teardownApp')
  })

  it('★ 3本とも、返り値に段の時間を載せる（作成・公開は withStageTimings・削除は骨）。鍵の戻り値の stageTimings を渡す', () => {
    expect(block('apprunDedicated:create')).toMatch(/withStageTimings\(r\.value, r\.stageTimings\)/)
    expect(block('apprunDedicated:publishApp')).toContain('withStageTimings(locked.value, locked.stageTimings)')
    // 削除: 骨が鍵の戻り値の stageTimings を返り値へ載せる（記録の extra.stageTimings と同じ値）
    expect(shell).toContain('return locked.stageTimings ? { ...locked.value, stageTimings: locked.stageTimings } : locked.value')
  })

  it('★ ゾーンを記録のために渡す（作成は入力の spec.zone・削除は仕様書の zoneOf から骨が・公開は記録のゾーン）', () => {
    expect(block('apprunDedicated:create')).toContain('zone: spec.zone')
    expect(block('apprunDedicated:publishApp')).toContain('zone: recordedZone(projectDir)')
    // 削除: 関数を値で渡さず包む（循環した require で undefined のまま渡って、ゾーンが黙って記録されなくなる形を避ける）。
    // 振る舞いは tests/dedicatedTeardownShell.test.ts の C-7 が固定している。
    expect(td).toContain('zoneOf: dir => recordedZone(dir),')
    expect(td).not.toContain('zoneOf: recordedZone')
    expect(shell).toContain("{ target: spec.target, handler: spec.handler, secrets: spec.secretsOf(auth), zone }")
  })

  it('公開の準備・イメージ・古いアクセスキーの段は IPC が渡す（順序: 準備 → … → イメージ → publishAppFlow）', () => {
    const b = block('apprunDedicated:publishApp')
    const prepare = b.indexOf('onStage(STAGE.publishPrepare)')
    const loadSpec = b.indexOf('const spec = loadCloudSpec(projectDir)')
    const image = b.indexOf('onStage(STAGE.publishImage)')
    const prepareImage = b.indexOf('await prepareAppImage(')
    const flow = b.indexOf('await publishAppFlow(')
    const keyCleanup = b.indexOf('onStage(STAGE.publishKeyCleanup)')
    const cleanupText = b.indexOf("progress('🧹 保存場所の古いアクセスキーを削除しています…')")
    expect([prepare, loadSpec, image, prepareImage, flow, keyCleanup, cleanupText].every(i => i > -1)).toBe(true)
    expect(prepare).toBeLessThan(loadSpec)
    expect(image).toBeLessThan(prepareImage)
    expect(prepareImage).toBeLessThan(flow)
    expect(keyCleanup).toBeLessThan(cleanupText) // 段の切り替えが、その段の文の直前
  })

  it('保存場所の段は、文（STORAGE_TEARDOWN_PROGRESS）に段の内部名を添えて渡す。手順6も 📡 の 🗑 も同じ破棄の道（apprunDedicated:teardown）を通る', () => {
    expect(td).toContain('progress(STORAGE_TEARDOWN_PROGRESS, { stage: STAGE.teardownStorage })')
    expect(td).toContain('teardownProjectStorage(auth, projectDir, res, progress, onStage, ctx.opts.shownPlacements)')
    expect(ipc).not.toContain('STORAGE_TEARDOWN_PROGRESS')
  })

  it('★ 画面へ送る進捗は文だけ（event.sender.send へ渡すのは msg。段の内部名を送らない）', () => {
    expect(count(td, "msg => event.sender.send('apprunDedicated:teardown-progress', msg)")).toBe(1)
    expect(count(ipc, "msg => event.sender.send('apprunDedicated:teardown-progress', msg)")).toBe(0)
    expect(count(ipc, "msg => event.sender.send('apprunDedicated:publish-progress', msg)")).toBe(1)
  })

  it('★ 段の内部名の直書きが無い（STAGE の定義から引く）。定義は shared/stageTiming.ts の1か所', () => {
    const literal = /['"`](create|publish|teardown)\.(cluster|asg|lb|prepare|image|check|app|cleanup|lb-address|verify|containers|key-cleanup|storage)['"`]/
    const holders = SRC.filter(f => literal.test(code(read(f))))
    expect(holders).toEqual(['src/shared/stageTiming.ts'])
  })
})

describe('画面: 結果の下の「かかった時間を見る」と、待っている段の目安は、別の部品（巨大なパネルに足さない）', () => {
  it('★ 手順5・6・8の結果の下に、同じ部品を置く（その場の結果も、記録から出す結果も、同じ stageTimings を渡す＝双子）', () => {
    expect(panel).toContain("import StageTimingDetails from './StageTimingDetails'")
    expect(panel).toContain('<StageTimingDetails timings={createResult.stageTimings} />')
    // 手順6の結果は 📡 の行と共有する部品（TeardownResultView）が描く（手順6の節が置く）。その中に同じ部品を置く。
    expect(teardownResult).toContain('<StageTimingDetails timings={view.stageTimings} />')
    expect(count(teardownResult, '<StageTimingDetails')).toBe(1)
    expect(teardownSection).toContain('<TeardownResultView')
    expect(panel).toContain('<StageTimingDetails timings={publishResult.stageTimings} />')
    expect(count(panel, '<StageTimingDetails')).toBe(2)
    // 結果の state は、その場の結果（outcome.result・手順6は onDone の view）も、記録から読み戻した結果（resumed*）も同じ state へ入る
    expect(panel).toContain('setCreateResult(outcome.result)')
    expect(panel).toContain('setTeardownView(view)')
    expect(panel).toContain('setPublishResult(outcome.result)')
    expect(panel).toContain('setCreateResult(resumedCreateResult(f.record))')
    expect(panel).toContain("setTeardownView(resumedTeardownView('sakura-apprun-dedicated', f.record.result))")
    expect(panel).toContain('setPublishResult(resumedPublishResult(f.record))')
  })

  it('★★ 記録から読み戻す3つ（手順5・8の resumedCreateResult・resumedPublishResult と、削除の共通の resumedTeardownView）が、すべて stageTimings を足す', () => {
    // 手順5・8: 専有型のパネルの部品。手順6の削除は 0.6.22 段階3B-7 から、3つの公開先で共通の resumedTeardownView（shared/teardownResult.ts）の1つ。
    expect(count(actions, '...timingsPart(ex),')).toBe(2)
    expect(actions).toContain("import { readStageTimings } from '../shared/stageTiming'")
    for (const fn of ['resumedCreateResult', 'resumedPublishResult']) {
      const a = actions.indexOf(`export function ${fn}(`)
      expect(a, fn).toBeGreaterThan(-1)
      const b = actions.indexOf('\n}\n', a)
      expect(actions.slice(a, b), fn).toContain('...timingsPart(ex),')
    }
    expect(actions).not.toContain('export function resumedTeardownResult(')
    const shared = read('src/shared/teardownResult.ts')
    expect(shared).toContain('export function resumedTeardownView(')
    expect(count(shared, 'stageTimings: readStageTimings(x.stageTimings),')).toBe(1)
  })

  it('★ 待っている段の目安は、記録の progress.stage（内部名）で引く。画面に出す文では見分けない', () => {
    expect(panel).toContain("import StageEstimate from './StageEstimate'")
    expect(panel).toContain('stage={runningRecord?.progress?.stage}') // 手順5（RunningLines）
    // 手順6は 📡 の行と共有する部品（TeardownProgress）が、記録の progress.stage で目安を引く。手順6の節がそれを置く。
    expect(teardownProgress).toContain('{running && <StageEstimate stage={runningRecord?.progress?.stage} />}')
    expect(teardownSection).toContain('<TeardownProgress')
    expect(teardownSection).toContain('running={running} runningRecord={runningRecord} nowMs={nowMs}')
    expect(panel).toContain("{runningKind === 'publish' && <StageEstimate stage={runningRecord?.progress?.stage} />}")
    // 目安のために文を照合する関数・文字列をパネルに足していない
    expect(code(panel)).not.toMatch(/startsWith\('(ロードバランサの削除を待っています|ロードバランサの IP が付くのを待っています)[^']*'\)[^\n]*(estimate|目安)/)
  })

  it('公開ダイアログ上部の枠（持ち場の画面が出さない記録）にも、同じ2つの部品を置く', () => {
    expect(modal).toContain("import StageEstimate from './StageEstimate'")
    expect(modal).toContain("import StageTimingDetails from './StageTimingDetails'")
    expect(modal).toContain('<StageEstimate stage={rec.progress?.stage} />')
    expect(modal).toContain('<StageTimingDetails timings={readStageTimings(r?.extra?.stageTimings)} />')
  })

  it('新しい部品は各400行以下。パネルに <details> の見た目を直接書いていない', () => {
    for (const f of ['src/renderer/components/StageTimingDetails.tsx', 'src/renderer/components/StageEstimate.tsx']) {
      expect(read(f).split('\n').length, f).toBeLessThanOrEqual(400)
    }
    expect(code(panel)).not.toContain('かかった時間を見る')
    expect(read('src/renderer/components/StageTimingDetails.tsx')).toContain('<summary')
    expect(read('src/renderer/components/StageTimingDetails.tsx')).toContain('stageTimingView(timings)')
    expect(read('src/renderer/components/StageEstimate.tsx')).toContain('estimateLineFor(stage, estimates)')
  })

  it('「かかった時間を見る」の見出しの定義は shared の1か所（部品は stageTimingView から引く）', () => {
    const holders = SRC.filter(f => code(read(f)).includes('かかった時間を見る'))
    expect(holders).toEqual(['src/shared/stageTiming.ts'])
  })
})

describe('固定の目安の文が残っていない（同じ数字を2か所に持たない）', () => {
  it('★ 「実測ではおよそ」「（目安です）」「およそN分」「ふつうN分」の固定文が、コード（コメントを除く）のどこにも無い', () => {
    const offenders = SRC.filter(f => /実測では|（目安です）|およそ\d+分|ふつう\d+分|ふつう数分/.test(code(read(f))))
    expect(offenders).toEqual([])
  })

  it('★ 固定文を作っていた関数・定数（lbDeleteEstimateNote・lbAddressEstimateNote・LB_DELETE_MEASURED_MINUTES…）が消えている', () => {
    for (const f of [...SRC, ...walk('tests').filter(t => !t.endsWith('stageTimingWiring.test.ts') && !t.endsWith('ops-dedicated-wait.test.ts'))]) {
      expect(code(read(f)), f).not.toMatch(/lbDeleteEstimateNote|lbAddressEstimateNote|LB_DELETE_MEASURED_MINUTES|LB_ADDRESS_EMPTY_AFTER_MINUTES/)
    }
  })

  it('進み具合の文（main）に目安が入っていない: 待ちの文は「…を待っています（N分経過）…」の形だけ', () => {
    const apply = code(read('src/main/cloud/apprunDedicatedApply.ts'))
    expect(apply).toContain('return `${label}の削除を待っています${elapsed}…`')
    const appApply = code(read('src/main/cloud/apprunDedicatedAppApply.ts'))
    expect(appApply).toContain('progress(`ロードバランサの IP が付くのを待っています（${formatLbWaitElapsed(lbElapsedMs)}）…`)')
  })

  it('開発時の実測の数字は shared/stageEstimate.ts の DEV_MEASURES の1か所（実測の分数を書いたコードがほかに無い）', () => {
    const holders = SRC.filter(f => /minutes:\s*\d+/.test(code(read(f))))
    expect(holders).toEqual(['src/shared/stageEstimate.ts'])
  })
})

describe('使い方ガイド・README に、目安と「かかった時間を見る」が書いてある（掟9）', () => {
  it('使い方ガイドの専有型の節: 見る場所・目安の決め方（最近5回の中央値／開発時の実測）・測っていない段には出さない・外へ送らない', () => {
    const guide = read('docs/usage-guide.html')
    const a = guide.indexOf('id="apprun-dedicated"')
    expect(a).toBeGreaterThan(-1)
    const section = guide.slice(a)
    expect(section).toContain('かかった時間を見る')
    expect(section).toContain('最近5回の中央値')
    expect(section).toContain('開発時に測った値')
    expect(section).toContain('測っていないステップには目安を出しません')
    expect(section.slice(section.indexOf('かかった時間を見る'), section.indexOf('かかった時間を見る') + 600), '画面の言葉は「段」ではなく「ステップ」（wording-decisions.md）').not.toContain('段')
    expect(section).toContain('外へは送りません')
    expect(guide).not.toMatch(/[①-⓿❶-➓㉑-㊿]/) // 丸数字を使わない
  })

  it('README: 1行（かかった時間を見る・目安・外へは送らない）', () => {
    const readme = read('README.md')
    expect(readme).toContain('「かかった時間を見る」')
    expect(readme).toContain('最近5回の中央値')
    expect(readme).toContain('外へは送りません')
  })

  // 途中で止まった回（設計書 10.13.14 の3）。画面の言い回しは実物の定数から引く（文書だけが別の言い方をしない）。
  it('★ README・使い方ガイド: 止まった回の段と時間も並べて出す／合計は止まっていた間を除く／目安に入れない／止まった削除は1回お知らせする', () => {
    const notice = stoppedWhenText(undefined) // 「Koto の終了で止まりました」
    expect(notice).toBe('Koto の終了で止まりました')
    for (const [name, doc] of [['README.md', read('README.md')], ['docs/usage-guide.html', read('docs/usage-guide.html')]] as const) {
      expect(doc, name).toContain('削除の途中で Koto を終了して止まったとき')
      expect(doc, name).toContain('（または待ち切れずに止まったとき）')
      expect(doc, name).toContain('止まった回のステップと時間も')
      expect(doc, name).toContain('止まっていた間を除いて')
      expect(doc, name).toContain('止まった回の時間は、目安には入れません')
      expect(doc, name).toContain(`「${notice}」と`)
      expect(doc, name).toContain('1回お知らせ')
    }
    // 合計の行の名前の「止まっていた間を除く」は、画面の定数と同じ言い回し
    expect(STAGE_TIMING_STOPPED_WORDS.totalWithStopped).toContain('止まっていた間を除く')
  })
})


// ── 測らない印は1か所で定義（掟10・2026-10-07 検分2巡目）──────────────────────────────
describe('★ 測らない印 UNMEASURED は shared/stageTiming.ts の1か所だけ', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const read = (p: string): string => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', p), 'utf-8')
  it('定義は shared にあり、各 flow と IPC は自前で作らない', () => {
    expect(read('src/shared/stageTiming.ts')).toContain('export const UNMEASURED: StageMark = Object.freeze({ unmeasured: true })')
    for (const p of ['src/main/cloud/apprunDedicatedApply.ts', 'src/main/cloud/apprunDedicatedAppApply.ts', 'src/main/ipc/apprunDedicated.ts', 'src/main/ipc/apprunDedicatedTeardown.ts']) {
      const src = read(p)
      expect(src, p).not.toContain('const UNMEASURED')
      expect(src, p).not.toContain('{ unmeasured: true })')
      expect(src, p).toContain('UNMEASURED')
    }
  })
})
