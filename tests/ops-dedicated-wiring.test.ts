import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── 専有型パネルが「閉じて開き直したとき、続きと結果を出す」部品を通っていること（2026-09-29）──────────────
//
// 振る舞い（走っていれば進み具合・終わっていれば結果と警告・ack のあとは出ない・別の公開先を巻き込まない）は
// tests/ops-dedicated-resume.test.ts が偽の projectOps で固定している。ここは**画面がその部品を通している**ことだけを、
// 呼び出しの形ごと（前後の文脈つき）で確かめる。文字列の一致は「そう書いてあるか」しか見ないので、
// 単独で信用せず、変異（ops-dedicated-* の変異試験）で「壊すと落ちる」ことを確かめてある。

const ROOT = join(__dirname, '..')
const panel = readFileSync(join(ROOT, 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')
const actions = readFileSync(join(ROOT, 'src/renderer/apprunDedicatedActions.ts'), 'utf-8')
// 2026-10-08: 手順6の進み具合・結果の見た目と、進み具合の文の選び方は、📡 の行と共有する部品・関数へ移した。
// 0.6.22 3B-6a: 共有の先は、HANAMII・共用型・専有型で1つの共通の部品（TeardownProgress・TeardownResultView・teardown/flow.ts）。
// 手順6の節は DedicatedTeardownSection.tsx、記録の見張りの付け外しは hooks/useDedicatedOpsWatch.ts へ切り出した（巨大ファイルの決まり）。
const progressView = readFileSync(join(ROOT, 'src/renderer/components/teardown/TeardownProgress.tsx'), 'utf-8')
const resultView = readFileSync(join(ROOT, 'src/renderer/components/teardown/TeardownResultView.tsx'), 'utf-8')
const flow = readFileSync(join(ROOT, 'src/renderer/teardown/flow.ts'), 'utf-8')
const section = readFileSync(join(ROOT, 'src/renderer/components/DedicatedTeardownSection.tsx'), 'utf-8')
const watchHook = readFileSync(join(ROOT, 'src/renderer/hooks/useDedicatedOpsWatch.ts'), 'utf-8')

const count = (src: string, needle: string) => src.split(needle).length - 1
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from)
  expect(a, `${from} が無い`).toBeGreaterThan(-1)
  const b = src.indexOf(to, a + from.length)
  expect(b, `${to} が ${from} の後に無い`).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('記録を読む部品を、開いたとき付け・閉じたとき外している', () => {
  const END = "return () => { watch?.stop(); if (opsWatchRef.current === watch) opsWatchRef.current = null }\n  }, [projectDir])"
  it('★ watchDedicatedOps を projectOps・projectDir で作り、押し出しは state へ・外すときは stop する（付け外しは useDedicatedOpsWatch。パネルは直接作らない）', () => {
    expect(count(watchHook, 'watch = watchDedicatedOps({')).toBe(1)
    expect(panel).not.toContain('watchDedicatedOps(')
    expect(panel).toContain('useDedicatedOpsWatch(projectDir, panelVisible, finished => {')
    const block = between(watchHook, 'watch = watchDedicatedOps({', END)
    expect(block).toContain('api: window.electronAPI.projectOps,')
    expect(block).toContain('projectDir,')
    expect(block).toContain('onRunning: setOpsRunning,')
    expect(block).toContain('onFinished: finished => {')
    // 開き直したとき、前のプロジェクト・前の開き方の表示を持ち越さない（掟11）
    const effect = between(watchHook, "setOpsRunning({ running: null, other: null })\n    setResumedNotes(", 'let watch: DedicatedOpsWatch | null = null')
    expect(effect).toContain("{ create: [], teardown: [], publish: [] }")
    // 付け外しは projectDir ごと（別のプロジェクトの記録を出さない）
    expect(watchHook).toContain(END)
  })

  it('★★ 終わった結果は、手順5・6・8それぞれの既存の結果欄（state）へ入り、警告は知らせに集める', () => {
    // パネルが渡す「結果が届いたとき」の置き場（手順5・6・8それぞれの結果欄の state）
    const panelBlock = between(panel, 'useDedicatedOpsWatch(projectDir, panelVisible, finished => {', '  const runningKind: DedicatedOpKind')
    expect(panelBlock).toContain('setCreateResult(resumedCreateResult(f.record)); setTeardownView(null)')
    expect(panelBlock).toContain("setTeardownView(resumedTeardownView('sakura-apprun-dedicated', f.record.result))")
    expect(panelBlock).toContain('setPublishResult(resumedPublishResult(f.record))')
    // 見張りの部品は、結果を渡したあとで、警告を知らせに集め、記録が変わったことを開いている画面へ知らせる
    const block = between(watchHook, 'onFinished: finished => {', '} catch { /* preload 未注入')
    expect(block).toContain('finishedRef.current(finished)')
    expect(block).toContain('setResumedNotes(prev => addResumedNotes(prev, finished.map(resumedNoteOf)))')
    expect(block.indexOf('finishedRef.current(finished)')).toBeLessThan(block.indexOf('setResumedNotes(prev => addResumedNotes('))
    // 記録が変わったことを開いている画面へ知らせる（作られたもの・公開の記録を取り直す）
    expect(block).toContain("window.dispatchEvent(new Event('sakura-meta-changed'))")
  })

  it('走っている間、時計を進めるついでに記録を聞き直す（押し出しが1つ届かなくても固まらない）', () => {
    const block = between(panel, 'const runningStartedAt = runningRecord?.startedAt ?? null', '}, [runningStartedAt])')
    expect(block).toContain('if (runningStartedAt === null) return')
    expect(block).toContain('window.setInterval(() => { setNowMs(Date.now()); opsWatchRef.current?.refresh() }, 15000)')
    expect(block).toContain('return () => window.clearInterval(id)')
  })

  it('★★ ack は部品の中の1か所だけ。画面は直接 ack を呼ばない（別の公開先の結果を巻き込まないため）', () => {
    expect(panel).not.toContain('projectOps.ack')
    expect(panel).not.toContain('.ack(')
    // 伝える口は共通の sendAck（projectOpsView.ts）。範囲は共通の ackUpToFor が決める（ここで独自に決めない）
    expect(count(actions, 'sendAck(api, projectDir, ackUpTo)')).toBe(1)
    expect(actions).toContain('const ackUpTo = ackUpToFor(unseen, rec => {')
  })
})

describe('この画面が始める操作は beginLocal〜endLocal で囲む（結果を二重に出さず、出し終えたら ack される）', () => {
  const cases: Array<{ kind: string; ipc: string; setter: string }> = [
    { kind: 'create', ipc: 'window.electronAPI.apprunDedicated.create(projectDir, auth, s, opts)', setter: 'setCreating(false)' },
    // 手順6の IPC は、📡 の行と共有する流れ（teardown/flow.ts）が呼ぶ。画面（onStart）が beginLocal し、流れが onStart を IPC の前に呼ぶ
    // （順序は下の別のテストと tests/dedicatedTeardownEntries.test.ts・tests/dedicatedTeardownSection.test.ts が固定している）。
    { kind: 'teardown', ipc: "setResumedNotes(n => ({ ...n, teardown: [] }))", setter: 'setTearingDown(false)' },
    { kind: 'publish', ipc: 'window.electronAPI.apprunDedicated.publishApp(projectDir, auth, i, opts)', setter: 'setPublishing(false)' },
  ]
  it('★ 手順6: 共有の流れは onStart（beginLocal）を、キーの読み込み・IPC より前に呼ぶ。節の onStart は画面の口（beginLocal を持つ）へつながる', () => {
    const at = flow.indexOf('export async function runTeardownFlow<R, A, Res>(')
    expect(at).toBeGreaterThan(-1)
    const block = flow.slice(at, at + 5200)
    expect(block.indexOf('deps.onStart?.()')).toBeGreaterThan(-1)
    expect(block.indexOf('deps.onStart?.()')).toBeLessThan(block.indexOf('await deps.loadAuth(facts.record)'))
    expect(block.indexOf('await deps.loadAuth(facts.record)')).toBeLessThan(block.indexOf('await deps.invoke(projectDir, auth, invokeOpts, facts.record)'))
    // 節: 流れの onStart が、画面の onStart（パネルの onTeardownStart）を呼ぶ。パネルのそれが beginLocal('teardown') を持つ
    expect(section).toContain('onStart: () => { setProgressLocal(null); panelRef.current.onStart() },')
    expect(panel).toContain('onStart={onTeardownStart}')
    // 画面を「削除中」にし、前の結果と知らせを片づけ、記録の見張りへ「この画面が始めた」と伝える（IPC の前）
    const startBlock = between(panel, 'const onTeardownStart = () => {', 'const onTeardownDone')
    expect(startBlock).toContain('setTearingDown(true); setTeardownView(null)')
    expect(startBlock).toContain("opsWatchRef.current?.beginLocal('teardown')")
    expect(startBlock).toContain('setResumedNotes(n => ({ ...n, teardown: [] }))')
  })

  for (const c of cases) {
    it(`${c.kind}: IPC を呼ぶ前に beginLocal・finally で endLocal`, () => {
      expect(count(panel, `opsWatchRef.current?.beginLocal('${c.kind}')`)).toBe(1)
      expect(count(panel, `opsWatchRef.current?.endLocal('${c.kind}')`)).toBe(1)
      const begin = panel.indexOf(`opsWatchRef.current?.beginLocal('${c.kind}')`)
      const ipc = panel.indexOf(c.ipc)
      expect(ipc, `${c.ipc} が無い`).toBeGreaterThan(-1)
      expect(begin).toBeLessThan(ipc) // 記録が作られる前に「自分が始めた」と伝える
      // endLocal は finally の中（成功・失敗・キャンセルのどれでも呼ばれる）で、走っている印を下ろした直後
      expect(panel).toContain(`    } finally {\n      ${c.setter}\n`)
      const endAt = panel.indexOf(`opsWatchRef.current?.endLocal('${c.kind}')`)
      const setterAt = panel.lastIndexOf(c.setter, endAt)
      expect(endAt - setterAt).toBeLessThan(400)
      expect(panel.slice(setterAt, endAt)).not.toContain('await')
    })
  }
})

describe('走っているか・進み具合は「この画面が始めたもの」と「記録から分かるもの」を合わせる', () => {
  it('★★ 走っている印（creating／tearingDown／publishing）は記録の種類でも立つ。ボタンの止め方（panelBusy）は従来のまま', () => {
    expect(panel).toContain("const creating = creatingLocal || runningKind === 'create'")
    expect(panel).toContain("const tearingDown = tearingDownLocal || runningKind === 'teardown'")
    expect(panel).toContain("const publishing = publishingLocal || runningKind === 'publish'")
    // 元の名前で state を持ち直していない（持ち直すと、記録から立てた印が効かない）
    expect(panel).not.toContain('const [creating, setCreating]')
    expect(panel).not.toContain('const [tearingDown, setTearingDown]')
    expect(panel).not.toContain('const [publishing, setPublishing]')
    // 全部の操作を止める判定は、名前を変えずに合わせた値を受ける
    expect(count(panel, 'panelBusy({ creating, tearingDown, publishing, lbRefreshing })')).toBeGreaterThanOrEqual(8)
  })

  it('★ 進み具合の文は、走っている記録があればそれ（開き直した画面）・無ければ従来の進捗', () => {
    // 手順6の進み具合の文の選び方は、📡 の行と同じ関数（teardown/flow.ts の teardownProgressText）。手順6の節がそれで選ぶ
    expect(section).toContain('progress={teardownProgressText({ running, runningRecord, local: progressLocal })}')
    expect(flow).toContain('return s.running ? opProgressText(s.runningRecord) : s.local')
    expect(panel).not.toContain('teardownProgressText')
    expect(panel).toContain("const publishProgress = runningKind === 'publish' ? opProgressText(runningRecord) : publishProgressLocal")
    expect(panel).toContain("const createProgress = runningKind === 'create' ? opProgressText(runningRecord) : ''")
    // 従来の進捗の購読（この画面が始めた操作の分）は残している
    expect(panel).toContain('window.electronAPI.apprunDedicated.onPublishProgress((msg) => setPublishProgress(msg))')
    // 手順6の削除の進み具合の購読は、専有型の仕様書の subscribeProgress の1行（節が受ける）。パネルには無い
    expect(section).toContain('try { unsubscribe = dedicatedTeardownSpec.subscribeProgress?.(msg => setProgressLocal(msg)) ?? unsubscribe } catch')
    expect(panel).not.toContain('onTeardownProgress')
  })

  it('★★ 手順6の節は、走っている間は記録が空でも出し続ける（消し切って保存場所を片づけている最中も進み具合を出す）', () => {
    const call = between(panel, 'const showTeardownButton = shouldShowTeardownButton({', '  })')
    expect(call).toContain("running: runningKind === 'teardown',")
    // 2026-10-08 検分 E: 記録（state の中身）ごと渡す。「消すものがあるか」の判断は dedicatedTeardownHasWork の1つ（📡 の 🗑 と同じ）
    expect(call).toContain('record: apprunState,')
    expect(call).not.toContain('hasAnyResource,')
    expect(call).not.toContain('storageLeftoverBucket: apprunState?.storageLeftoverBucket,')
  })
})

describe('各節に、進み具合・結果に添える知らせを出す', () => {
  it('手順5・6・8の結果欄の直前に、その操作の知らせ（警告）を出す', () => {
    expect(count(panel, '<ResumedNotesView notes={resumedNotes.create} />')).toBe(1)
    // 手順6の知らせと結果は 📡 の行と共有する部品（TeardownResultView）が描く。知らせは結果欄の直前。パネルは知らせを節へ渡す。
    expect(count(panel, 'notes={resumedNotes.teardown}')).toBe(1)
    expect(count(resultView, '<ResumedNotesView notes={notes} shownInResult={warnings.map(warningLine)} />')).toBe(1)
    expect(count(panel, '<ResumedNotesView notes={resumedNotes.publish} />')).toBe(1)
    expect(panel.indexOf('<ResumedNotesView notes={resumedNotes.create} />')).toBeLessThan(panel.indexOf('{shouldShowCreateResult(createResult, apprunState) && createResult && ('))
    expect(resultView.indexOf('<ResumedNotesView notes={notes} shownInResult={warnings.map(warningLine)} />')).toBeLessThan(resultView.indexOf('<div className="space-y-1" data-teardown-result>'))
    expect(panel.indexOf('<ResumedNotesView notes={resumedNotes.publish} />')).toBeLessThan(panel.indexOf('{publishResult && ('))
  })

  it('★★ 手順5の結果欄は「記録が空のとき」の枝の外にある（作成が終わって記録ができても、開き直したあとでも消えない）', () => {
    const at = panel.indexOf('{shouldShowCreateResult(createResult, apprunState) && createResult && (')
    expect(at).toBeGreaterThan(-1)
    // 手順5の節の先頭から結果欄までの間で、「記録が空のとき」の枝（<>…</>）が閉じている
    const head = panel.lastIndexOf('手順5 クラスタを作る */}', at)
    expect(head).toBeGreaterThan(-1)
    const before = panel.slice(head, at)
    expect(before).toContain('作られたものの記録があります。作り直すには、まず手順6で削除してください。')
    expect(before).not.toContain('まず手順6で破棄してください') // 0.6.21: 手順6の呼び方は見出し（手順6 作ったものを削除する）に揃えた。直す前の言い方は戻さない
    expect(before).not.toContain('まず⑥で削除してください') // 旧い丸数字の案内（2026-10-07・作者の決定）
    expect(before).toContain('          </>\n        )}\n')
    // 枝の外に出した結果欄の直前で、この節の枝は1つも開いていない
    expect(before.lastIndexOf('</>')).toBeGreaterThan(before.lastIndexOf('<>'))
  })

  it('手順5の進み具合・手順6・8の経過と、閉じても進むことの一文（Koto を終了すると止まる、も同じ定義から）', () => {
    expect(panel).toContain("{creating && runningKind === 'create' && (")
    expect(panel).toContain("{runningKind === 'publish' && runningRecord && (")
    // 手順6の経過と一文は、📡 の行と共有する部品（TeardownProgress）が出す。「削除」の動詞は専有型の言葉（words.verb）から作る
    expect(progressView).toContain('{running && runningRecord && (')
    expect(count(progressView, 'opElapsedText(runningRecord.startedAt, nowMs)')).toBe(1)
    expect(progressView).toContain('この画面を閉じても、{words.verb}は最後まで進みます。{PUBLISH_QUIT_STOPS}')
    // 経過（始まってから約N分）は手順5・8がパネルに、手順6が共有の部品に1か所ずつ
    expect(count(panel, 'opElapsedText(runningRecord.startedAt, nowMs)')).toBe(2)
    expect(panel).toContain('import { PUBLISH_QUIT_STOPS } from')
  })

  it('別の操作が走っているときは、詳細を出さず1行だけ（掟11）', () => {
    const block = between(panel, '{opsRunning.other && (', '</p>\n      )}')
    expect(block).toContain('otherOpNote(opsRunning.other)')
    expect(block).not.toContain('progress')
    expect(block).not.toContain('warnings')
  })
})

describe('画面に出す文の作法（掟5・掟8）', () => {
  it('新しく足した画面の文に、Markdown 記法・「Claude Code」を使わない', () => {
    for (const src of [panel, actions]) {
      expect(src).not.toContain('Claude Code')
    }
    // 知らせ・進み具合を描く部品は素のテキスト（** や ` を文に入れない）
    const notes = panel.slice(panel.indexOf('function RunningLines('))
    expect(notes).not.toMatch(/\*\*[^/]/)
  })
})

// ── 隠れているタブ・描かれない節（2026-09-30 検分）──────────────────────────────────────────────
// 振る舞い（隠れている間は ack しない・出たとき ack する）は tests/ops-dedicated-resume.test.ts が固定している。
// ここは画面の配線だけを、呼び出しの形ごとで確かめる（変異で落ちることを確かめてある）。
describe('隠れているタブのパネルは、結果を「見た」と伝えない', () => {
  it('★★ 目の前に出ているか（visible）を watchDedicatedOps へ渡し、変わったら部品へ知らせる', () => {
    const block = between(watchHook, 'watch = watchDedicatedOps({', "return () => { watch?.stop(); if (opsWatchRef.current === watch) opsWatchRef.current = null }\n  }, [projectDir])")
    expect(block).toContain('isVisible: () => panelVisibleRef.current,')
    expect(watchHook).toContain('panelVisibleRef.current = panelVisible')
    expect(watchHook).toContain('useEffect(() => { opsWatchRef.current?.visibilityChanged() }, [panelVisible])')
    // パネルは、目の前に出ているか（visible）を見張りへ渡す
    expect(panel).toContain('visible: panelVisible = true')
    expect(panel).toContain('useDedicatedOpsWatch(projectDir, panelVisible, finished => {')
  })
})

describe('手順8の節が描かれないときも、手順8の結果の知らせは出す', () => {
  it('★★ 手順8の節（shouldShowPublishSection）の外に、節が無いときだけ出す知らせがある（結果の一言つき）', () => {
    expect(count(panel, '{!shouldShowPublishSection(apprunState) && <ResumedNotesView notes={resumedNotes.publish} withMessage />}')).toBe(1)
    // 節の中の知らせは、これまでどおり（二重にしない: 節が描かれるときは、外のほうは出ない）
    expect(count(panel, '<ResumedNotesView notes={resumedNotes.publish} />')).toBe(1)
  })
})
