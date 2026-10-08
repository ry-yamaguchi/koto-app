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

const count = (src: string, needle: string) => src.split(needle).length - 1
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from)
  expect(a, `${from} が無い`).toBeGreaterThan(-1)
  const b = src.indexOf(to, a + from.length)
  expect(b, `${to} が ${from} の後に無い`).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('記録を読む部品を、開いたとき付け・閉じたとき外している', () => {
  it('★ watchDedicatedOps を projectOps・projectDir で作り、押し出しは state へ・外すときは stop する', () => {
    expect(count(panel, 'watch = watchDedicatedOps({')).toBe(1)
    const block = between(panel, 'watch = watchDedicatedOps({', "return () => { watch?.stop(); if (opsWatchRef.current === watch) opsWatchRef.current = null }\n  }, [projectDir])")
    expect(block).toContain('api: window.electronAPI.projectOps,')
    expect(block).toContain('projectDir,')
    expect(block).toContain('onRunning: setOpsRunning,')
    expect(block).toContain('onFinished: finished => {')
    // 開き直したとき、前のプロジェクト・前の開き方の表示を持ち越さない（掟11）
    const effect = between(panel, "setOpsRunning({ running: null, other: null })\n    setResumedNotes(", 'let watch: DedicatedOpsWatch | null = null')
    expect(effect).toContain("{ create: [], teardown: [], publish: [] }")
  })

  it('★★ 終わった結果は、⑤⑥⑧それぞれの既存の結果欄（state）へ入り、警告は知らせに集める', () => {
    const block = between(panel, 'onFinished: finished => {', '} catch { /* preload 未注入')
    expect(block).toContain('setCreateResult(resumedCreateResult(f.record)); setTeardownResult(null)')
    expect(block).toContain('setTeardownResult(resumedTeardownResult(f.record))')
    expect(block).toContain('setPublishResult(resumedPublishResult(f.record))')
    expect(block).toContain('setResumedNotes(prev => addResumedNotes(prev, finished.map(resumedNoteOf)))')
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
    { kind: 'teardown', ipc: 'window.electronAPI.apprunDedicated.teardown(projectDir, auth, opts)', setter: 'setTearingDown(false)' },
    { kind: 'publish', ipc: 'window.electronAPI.apprunDedicated.publishApp(projectDir, auth, i, opts)', setter: 'setPublishing(false)' },
  ]
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
    expect(panel).toContain("const teardownProgress = runningKind === 'teardown' ? opProgressText(runningRecord) : teardownProgressLocal")
    expect(panel).toContain("const publishProgress = runningKind === 'publish' ? opProgressText(runningRecord) : publishProgressLocal")
    expect(panel).toContain("const createProgress = runningKind === 'create' ? opProgressText(runningRecord) : ''")
    // 従来の進捗の購読（この画面が始めた操作の分）は残している
    expect(panel).toContain('window.electronAPI.apprunDedicated.onPublishProgress((msg) => setPublishProgress(msg))')
    expect(panel).toContain('window.electronAPI.apprunDedicated.onTeardownProgress((msg) => setTeardownProgress(msg))')
  })

  it('★★ ⑥の節は、走っている間は記録が空でも出し続ける（消し切って保存場所を片づけている最中も進み具合を出す）', () => {
    const call = between(panel, 'const showTeardownButton = shouldShowTeardownButton({', '  })')
    expect(call).toContain("running: runningKind === 'teardown',")
    expect(call).toContain('hasAnyResource,')
    expect(call).toContain('storageLeftoverBucket: apprunState?.storageLeftoverBucket,')
  })
})

describe('各節に、進み具合・結果に添える知らせを出す', () => {
  it('⑤⑥⑧の結果欄の直前に、その操作の知らせ（警告）を出す', () => {
    expect(count(panel, '<ResumedNotesView notes={resumedNotes.create} />')).toBe(1)
    expect(count(panel, '<ResumedNotesView notes={resumedNotes.teardown} />')).toBe(1)
    expect(count(panel, '<ResumedNotesView notes={resumedNotes.publish} />')).toBe(1)
    expect(panel.indexOf('<ResumedNotesView notes={resumedNotes.create} />')).toBeLessThan(panel.indexOf('{shouldShowCreateResult(createResult, apprunState) && createResult && ('))
    expect(panel.indexOf('<ResumedNotesView notes={resumedNotes.teardown} />')).toBeLessThan(panel.indexOf('{shouldShowTeardownResult(teardownResult) && teardownResult && ('))
    expect(panel.indexOf('<ResumedNotesView notes={resumedNotes.publish} />')).toBeLessThan(panel.indexOf('{publishResult && ('))
  })

  it('★★ ⑤の結果欄は「記録が空のとき」の枝の外にある（作成が終わって記録ができても、開き直したあとでも消えない）', () => {
    const at = panel.indexOf('{shouldShowCreateResult(createResult, apprunState) && createResult && (')
    expect(at).toBeGreaterThan(-1)
    // ⑤の節の先頭から結果欄までの間で、「記録が空のとき」の枝（<>…</>）が閉じている
    const head = panel.lastIndexOf('⑤ クラスタを作る */}', at)
    expect(head).toBeGreaterThan(-1)
    const before = panel.slice(head, at)
    expect(before).toContain('作られたものの記録があります。作り直すには、まず⑥で破棄してください。')
    expect(before).toContain('          </>\n        )}\n')
    // 枝の外に出した結果欄の直前で、この節の枝は1つも開いていない
    expect(before.lastIndexOf('</>')).toBeGreaterThan(before.lastIndexOf('<>'))
  })

  it('⑤の進み具合・⑥⑧の経過と、閉じても進むことの一文（Koto を終了すると止まる、も同じ定義から）', () => {
    expect(panel).toContain("{creating && runningKind === 'create' && (")
    expect(panel).toContain("{tearingDown && runningKind === 'teardown' && runningRecord && (")
    expect(panel).toContain("{runningKind === 'publish' && runningRecord && (")
    // 経過（始まってから約N分）は⑤⑥⑧の3か所
    expect(count(panel, 'opElapsedText(runningRecord.startedAt, nowMs)')).toBe(3)
    expect(panel).toContain('import { PUBLISH_QUIT_STOPS } from')
    expect(panel).toContain('この画面を閉じても、削除は最後まで進みます。{PUBLISH_QUIT_STOPS}')
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
    const notes = between(panel, 'function RunningLines(', '// 失敗メッセージの表示ブロック')
    expect(notes).not.toMatch(/\*\*[^/]/)
  })
})

// ── 隠れているタブ・描かれない節（2026-09-30 検分）──────────────────────────────────────────────
// 振る舞い（隠れている間は ack しない・出たとき ack する）は tests/ops-dedicated-resume.test.ts が固定している。
// ここは画面の配線だけを、呼び出しの形ごとで確かめる（変異で落ちることを確かめてある）。
describe('隠れているタブのパネルは、結果を「見た」と伝えない', () => {
  it('★★ 目の前に出ているか（visible）を watchDedicatedOps へ渡し、変わったら部品へ知らせる', () => {
    const block = between(panel, 'watch = watchDedicatedOps({', "return () => { watch?.stop(); if (opsWatchRef.current === watch) opsWatchRef.current = null }\n  }, [projectDir])")
    expect(block).toContain('isVisible: () => panelVisibleRef.current,')
    expect(panel).toContain('useEffect(() => { opsWatchRef.current?.visibilityChanged() }, [panelVisible])')
    expect(panel).toContain('visible: panelVisible = true')
  })
})

describe('⑧の節が描かれないときも、⑧の結果の知らせは出す', () => {
  it('★★ ⑧の節（shouldShowPublishSection）の外に、節が無いときだけ出す知らせがある（結果の一言つき）', () => {
    expect(count(panel, '{!shouldShowPublishSection(apprunState) && <ResumedNotesView notes={resumedNotes.publish} withMessage />}')).toBe(1)
    // 節の中の知らせは、これまでどおり（二重にしない: 節が描かれるときは、外のほうは出ない）
    expect(count(panel, '<ResumedNotesView notes={resumedNotes.publish} />')).toBe(1)
  })
})
