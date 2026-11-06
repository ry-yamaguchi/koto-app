import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import EditorSyncBand from '../src/renderer/components/EditorSyncBand'
import { syncBandOf, runBandAction, quitBlockedNotice, leaveUnsavedNotice, RELOAD_CONFIRM, type BandAction, type BandDeps } from '../src/renderer/editorSyncBand'
import { runReloadExternal } from '../src/renderer/confirmedActions'
import type { OpenFile } from '../src/renderer/editorTabs'

// ── エディタの帯（外で書き換わった・消えた・読めない）の文・ボタン・押したあとの流れ ──
// 文は画面の文の案どおり（一字一句）。「外の内容を読み込む」は未保存の編集を捨てるので、確認（赤い確認）の答えが no なら読まない。

const file = (over: Partial<OpenFile> = {}): OpenFile =>
  ({ path: '/p/a.txt', name: 'a.txt', content: 'mine', isDirty: true, language: 'plaintext', diskContent: 'base', ...over })

describe('帯の文とボタン（一字一句）', () => {
  it('★ 外で書き換わった: 文と、「外の内容を読み込む」「自分の編集を保存する」の順', () => {
    expect(syncBandOf('changed')).toEqual({
      message: 'このファイルは Koto の外で書き換えられました。',
      actions: [{ id: 'reload', label: '外の内容を読み込む' }, { id: 'keep', label: '自分の編集を保存する' }],
    })
  })
  it('★ 消えた: 文と、「自分の内容で作り直す」「閉じる」の順', () => {
    expect(syncBandOf('missing')).toEqual({
      message: 'このファイルは Koto の外で削除または移動されました。',
      actions: [{ id: 'recreate', label: '自分の内容で作り直す' }, { id: 'close', label: '閉じる' }],
    })
  })
  it('★ 読めない: 保存していないことと、権限の確かめ方を言う。ボタンは「もう一度保存する」だけ', () => {
    expect(syncBandOf('unreadable')).toEqual({
      message: 'このファイルを読めないため、保存していません。Finder で権限を確かめてください。',
      actions: [{ id: 'retry', label: 'もう一度保存する' }],
    })
  })
  it('印が無ければ帯は出さない。知らない印は「読めない」の帯（書かないのに帯が出ない、を作らない）', () => {
    expect(syncBandOf(undefined)).toBeNull()
    expect(syncBandOf('')).toBeNull()
    expect(syncBandOf('weird')).toEqual(syncBandOf('unreadable'))
    expect(syncBandOf('toString')).toEqual(syncBandOf('unreadable'))
  })
  it('「外の内容を読み込む」の確認は、題と本文が案のとおり', () => {
    expect(RELOAD_CONFIRM.title).toBe('外の内容を読み込みます')
    expect(RELOAD_CONFIRM.body).toBe('保存していない編集は消えます。')
  })
  it('新しい文に「Claude Code」「無償」「無料」と丸数字、内部の名前を書いていない', () => {
    const all: string[] = [RELOAD_CONFIRM.title, RELOAD_CONFIRM.body, RELOAD_CONFIRM.confirmLabel]
    for (const m of ['changed', 'missing', 'unreadable']) {
      const b = syncBandOf(m)!
      all.push(b.message, ...b.actions.map(a => a.label))
    }
    for (const unsaved of [[{ name: 'a.txt' }], [{ name: 'a.txt', syncMark: 'changed' }], [{ name: 'a.txt', syncMark: 'changed' }, { name: 'b.txt' }]]) {
      const n = quitBlockedNotice(unsaved)
      all.push(n.title, n.body, n.confirmLabel, n.cancelLabel)
    }
    const l = leaveUnsavedNotice([{ name: 'a.txt' }])
    all.push(l.title, l.body, l.confirmLabel)
    for (const t of all) {
      expect(t).not.toMatch(/Claude Code|無償|無料|[①-⑳㉑-㊿]/)
      expect(t).not.toMatch(/syncMark|diskContent|writeFile|baseline|expected|ENOENT|EACCES/)
    }
  })
})

describe('EditorSyncBand: 印のあるタブにだけ帯を描く', () => {
  const html = (mark: string | undefined, busy = false) =>
    renderToStaticMarkup(createElement(EditorSyncBand, { mark, busy, onAction: () => undefined }))
  const text = (h: string) => h.replace(/<[^>]*>/g, '')

  it('★ 印ごとに、文とボタンがその順で出る', () => {
    for (const m of ['changed', 'missing', 'unreadable'] as const) {
      const band = syncBandOf(m)!
      const t = text(html(m))
      expect(t).toBe(band.message + band.actions.map(a => a.label).join(''))
    }
  })
  it('印が無ければ何も描かない', () => {
    expect(html(undefined)).toBe('')
  })
  it('操作の最中はボタンを押せない（二重に押させない）。そうでなければ押せる', () => {
    expect(html('changed', true).match(/disabled=""/g)).toHaveLength(2)
    expect(html('changed', false)).not.toContain('disabled=""')
  })
  it('文は選択・コピーできる（select-text）', () => {
    expect(html('changed')).toContain('select-text')
  })
})

describe('runReloadExternal: 未保存の編集を捨てるので、確認の答えが no なら読まない', () => {
  it('★ 編集があって no: reload は0回・確認は1回、{cancelled:true}', async () => {
    const confirm = vi.fn(async () => false)
    const reload = vi.fn()
    const out = await runReloadExternal('/p/a.txt', true, '保存していない編集は消えます。', { confirm, reload })
    expect(out).toEqual({ cancelled: true })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith('保存していない編集は消えます。')
    expect(reload).not.toHaveBeenCalled()
  })
  it('★ 編集があって yes: reload を path で1回', async () => {
    const reload = vi.fn()
    const out = await runReloadExternal('/p/a.txt', true, 'x', { confirm: async () => true, reload })
    expect(out).toEqual({ cancelled: false, result: undefined })
    expect(reload.mock.calls).toEqual([['/p/a.txt']])
  })
  it('編集が無いタブ（捨てるものが無い）は、確認を出さずに読む', async () => {
    const confirm = vi.fn(async () => false)
    const reload = vi.fn()
    await runReloadExternal('/p/a.txt', false, 'x', { confirm, reload })
    expect(confirm).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledTimes(1)
  })
  it('★ 真偽の値でないもの（不明値）は「編集がある」側。確認を通る', async () => {
    for (const odd of [undefined, null, 0, 'false'] as unknown as boolean[]) {
      const confirm = vi.fn(async () => false)
      const reload = vi.fn()
      const out = await runReloadExternal('/p/a.txt', odd, 'x', { confirm, reload })
      expect(out, String(odd)).toEqual({ cancelled: true })
      expect(confirm, String(odd)).toHaveBeenCalledTimes(1)
      expect(reload, String(odd)).not.toHaveBeenCalled()
    }
  })
})

describe('runBandAction: 押したボタンが、決まった操作を1回だけ呼ぶ（表）', () => {
  function fakes(answer = true) {
    const log: string[] = []
    const deps: BandDeps = {
      confirmReload: async body => { log.push(`confirm ${body}`); return answer },
      reload: p => { log.push(`reload ${p}`) },
      keepMine: p => { log.push(`keep ${p}`) },
      recreate: p => { log.push(`recreate ${p}`) },
      save: (p, c) => { log.push(`save ${p} ${c}`) },
      close: f => { log.push(`close ${f.name}`) },
    }
    return { log, deps }
  }

  const TABLE: Array<[BandAction, string[]]> = [
    ['reload', ['confirm 保存していない編集は消えます。', 'reload /p/a.txt']],
    ['keep', ['keep /p/a.txt']],
    ['recreate', ['recreate /p/a.txt']],
    ['retry', ['save /p/a.txt mine']],
    ['close', ['close a.txt']],
  ]
  for (const [action, expected] of TABLE) {
    it(`${action}: ${expected.join(' → ')}`, async () => {
      const { log, deps } = fakes()
      await runBandAction(file(), action, deps)
      expect(log).toEqual(expected)
    })
  }

  it('★ 「外の内容を読み込む」: 確認の答えが no なら、読み込みの口は呼ばれない', async () => {
    const { log, deps } = fakes(false)
    await runBandAction(file(), 'reload', deps)
    expect(log).toEqual(['confirm 保存していない編集は消えます。'])
  })

  it('知らないボタンは何もしない', async () => {
    const { log, deps } = fakes()
    await runBandAction(file(), 'weird' as BandAction, deps)
    expect(log).toEqual([])
  })

  it('帯のボタンは、帯ごとに決まった操作だけを出す（印と操作の組）', () => {
    expect(syncBandOf('changed')!.actions.map(a => a.id)).toEqual(['reload', 'keep'])
    expect(syncBandOf('missing')!.actions.map(a => a.id)).toEqual(['recreate', 'close'])
    expect(syncBandOf('unreadable')!.actions.map(a => a.id)).toEqual(['retry'])
  })
})

describe('quitBlockedNotice: 終了しなかったときの知らせ', () => {
  it('帯のあるファイル（印のあるタブ）だけなら、ファイルの上の案内を確かめてからもう一度終了するよう言う', () => {
    const n = quitBlockedNotice([{ name: 'a.html', syncMark: 'changed' }, { name: 'b.css', syncMark: 'missing' }])
    expect(n.title).toBe('終了しませんでした')
    expect(n.body).toBe('保存できていないファイルがあります。\n・a.html\n・b.css\nファイルの上の案内を確かめてから、もう一度終了してください。')
    expect(n.confirmLabel).toBe('ファイルを見る')
    expect(n.cancelLabel).toBe('閉じる')
  })
  it('★★ 帯の無いファイル（書き込みに失敗した・保存の間に編集が続いた）だけなら、無い案内を指さず、権限と空き容量を確かめるよう言う', () => {
    const n = quitBlockedNotice([{ name: 'a.txt' }])
    expect(n.body).toBe('保存できていないファイルがあります。\n・a.txt\n保存先の権限と空き容量を確かめてから、もう一度終了してください。')
    expect(n.body).not.toContain('ファイルの上の案内')
  })
  it('★ 両方あれば、両方の確かめ先を言う。印が空・不明な値のファイルは、帯の有無を syncBandOf の答えに合わせる', () => {
    const n = quitBlockedNotice([{ name: 'a.txt', syncMark: 'unreadable' }, { name: 'b.txt', syncMark: '' }])
    expect(n.body).toBe('保存できていないファイルがあります。\n・a.txt\n・b.txt\nファイルの上の案内を確かめて、案内が出ていないファイルは、保存先の権限と空き容量を確かめてから、もう一度終了してください。')
    // 知らない印にも帯は出る（syncBandOf は「読めない」の帯にする）ので、案内を指してよい
    expect(quitBlockedNotice([{ name: 'a.txt', syncMark: 'weird' }]).body).toContain('ファイルの上の案内を確かめてから')
  })
  it('5つを超えたら、残りは件数で言う', () => {
    const names = ['1', '2', '3', '4', '5', '6', '7'].map(n => ({ name: `${n}.txt` }))
    const n = quitBlockedNotice(names)
    expect(n.body).toContain('・5.txt')
    expect(n.body).not.toContain('・6.txt')
    expect(n.body).toContain('ほか 2 件')
  })
})

describe('leaveUnsavedNotice: プロジェクトを切り替える前に保存できなかったファイルの確認（赤い確認）', () => {
  it('名前を並べ、切り替えると編集が消えることを言う。確認は赤（danger）で、ボタンは何を捨てるかを言う', () => {
    const n = leaveUnsavedNotice([{ name: 'a.html' }, { name: 'b.css' }])
    expect(n).toEqual({
      title: '未保存の変更があります',
      body: '保存できていないファイルがあります。\n・a.html\n・b.css\n切り替えると、保存していない編集は消えます。',
      confirmLabel: '保存せずに切り替える',
      danger: true,
    })
  })
  it('5つを超えたら、残りは件数で言う', () => {
    const names = ['1', '2', '3', '4', '5', '6'].map(n => ({ name: `${n}.txt` }))
    expect(leaveUnsavedNotice(names).body).toContain('ほか 1 件')
  })
  it('フォルダの整理の前は「整理する」と言い、「切り替える」とは言わない', () => {
    const n = leaveUnsavedNotice([{ name: 'a.html' }], 'organize')
    expect(n).toEqual({
      title: '未保存の変更があります',
      body: '保存できていないファイルがあります。\n・a.html\n整理すると、保存していない編集は消えます。',
      confirmLabel: '保存せずに整理する',
      danger: true,
    })
    expect(JSON.stringify(n)).not.toContain('切り替え')
  })
})

// ── 配線（ソースを読む。呼び出しの形ごと指し、直す前の形を not.toContain で禁じる）──
describe('配線: EditorPanel の帯・プレビュー、App の自動保存・終了時の保存', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  const panel = strip(read('src/renderer/components/EditorPanel.tsx'))
  const app = strip(read('src/renderer/App.tsx'))
  const bodyOf = (src: string, head: string, tail: string) => {
    const a = src.indexOf(head)
    expect(a, head).toBeGreaterThanOrEqual(0)
    const b = src.indexOf(tail, a)
    expect(b, tail).toBeGreaterThan(a)
    return src.slice(a, b)
  }

  it('★ 帯は EditorPanel の1か所だけに出し、いま見ているタブの印を渡す', () => {
    expect(panel.split('<EditorSyncBand').length - 1).toBe(1)
    expect(panel).toContain('mark={activeFileObj.syncMark}')
    expect(panel).toContain("import EditorSyncBand from './EditorSyncBand'")
  })

  it('★★ プレビューは previewTab を通る（保存を待ち、止まったら開かない）。待たずに保存を頼み開く、直す前の形は無い', () => {
    const body = bodyOf(panel, 'const previewInBrowser = async () => {', 'const requestClose')
    expect(body).toContain("await previewTab(activeFileObj, { save: onSave, open: p => window.electronAPI.shell.openPath(p) })")
    expect(body).not.toContain('if (activeFileObj.isDirty) onSave(')
    expect(panel).not.toContain('await window.electronAPI.shell.openPath(activeFileObj.path)')
    expect(panel).toContain('onSave: (path: string, content: string) => Promise<SaveResult>')
  })

  it('★★ 帯の操作は runBandAction を通り、「外の内容を読み込む」の確認は赤い確認（danger）', () => {
    const body = bodyOf(panel, 'const handleBandAction = async', 'return (')
    expect(body).toContain('await runBandAction(file, action, {')
    expect(body).toContain('confirmReload: (body) => confirm({ title: RELOAD_CONFIRM.title, body, confirmLabel: RELOAD_CONFIRM.confirmLabel, danger: true }),')
    expect(body).toContain('reload: onReloadFromDisk,')
    expect(body).toContain('keepMine: onKeepMine,')
    expect(body).toContain('recreate: onRecreate,')
    expect(body).toContain('save: onSave,')
    expect(body).toContain('close: requestClose,')
    // 帯のボタンを押す流れの中に、自前の確認や直書きを持たない
    expect(body).not.toContain('window.confirm(')
    expect(body).not.toContain('electronAPI')
  })

  it('★★ 自動保存は autosaveTargets の対象だけ（印のあるタブを飛ばす）。印を見ずに未保存だけで選ぶ形は無い', () => {
    const body = bodyOf(app, 'const autosaveTimer', 'const onDeleted')
    expect(body).toContain('const dirty = autosaveTargets(openFiles)')
    expect(body).toContain('dirty.forEach(f => saveFile(f.path, f.content))')
    expect(body).not.toContain('openFiles.filter(f => f.isDirty)')
  })

  it('★★ 終了時の保存は saveAllAndQuit を通る。基準を見ずに書く直書きと、保存の結果を見ずに終了を頼む形は無い', () => {
    const body = bodyOf(app, 'const { confirm: askUser, element: confirmElement } = useConfirm()', '  return (')
    expect(body).toContain('void saveAllAndQuit({')
    expect(body).toContain('...saveDeps,')
    expect(body).toContain('quit: () => window.electronAPI.win.quitAfterSave(),')
    expect(body).toContain('notifyUnsaved: unsaved => {')
    expect(body).not.toContain('fs.writeFile(')
    expect(body).not.toContain('await window.electronAPI.win.quitAfterSave()')
    // 基準を見ずに書く古い口は、AI の「反映」（利用者が押す明示の書き込み）の1か所だけ
    expect(app.split('electronAPI.fs.writeFile(').length - 1).toBe(1)
    expect(bodyOf(app, 'const applyAiFile = useCallback(', 'const showAiFileInEditor')).toContain('await window.electronAPI.fs.writeFile(full, content)')
  })

  it('★ 帯の3つの操作は、保存と同じ saveDeps を通って EditorPanel に渡る', () => {
    expect(app).toContain('keepMyEdit({ ...saveDeps, resetSnapshotGroup: () => { manualSnapshotRef.current = null } }, filePath)')
    expect(app).toContain('const recreateFile = useCallback((filePath: string) => recreateTab(saveDeps, filePath), [saveDeps])')
    expect(app).toContain('const reloadFromDisk = useCallback((filePath: string) => reloadTabFromDisk(saveDeps, filePath), [saveDeps])')
    expect(app).toContain('onReloadFromDisk={reloadFromDisk}')
    expect(app).toContain('onKeepMine={keepMine}')
    expect(app).toContain('onRecreate={recreateFile}')
  })

  it('★ 終了を止めた知らせは、画面の共通の確認（ConfirmModal）で出す。OS の警告窓は使わない', () => {
    expect(app).toContain('const { confirm: askUser, element: confirmElement } = useConfirm()')
    expect(app).toContain('{confirmElement}')
    const body = bodyOf(app, 'notifyUnsaved: unsaved => {', 'quit: () =>')
    expect(body).toContain('quitBlockedNotice(unsaved)')
    expect(body).not.toContain('window.alert(')
  })

  it('★★ ⌘S は onSave（保存の口 saveFile → saveTab）を通る。基準を見ずに書く直前の形は無い', () => {
    const body = bodyOf(panel, 'const handleMount: OnMount = (editor, monaco) => {', 'const activeFileObj')
    expect(body).toContain('editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {\n      if (!activeFile) return\n      onSave(activeFile, editor.getValue())\n    })')
    expect(body).not.toContain('electronAPI')
    expect(body).not.toContain('writeFile')
    // EditorPanel は、どの経路でもファイルを直に書かない
    expect(panel).not.toContain('electronAPI.fs.writeFile')
    expect(panel).not.toContain('writeFileIfUnchanged')
    // その onSave の先
    expect(app).toContain('onSave={saveFile}')
    expect(app).toContain('const saveFile = useCallback((filePath: string, content: string) => saveTab(saveDeps, filePath, content), [saveDeps])')
  })

  it('★★★ フォルダの整理（タブを全部閉じる道）も、同じ口 leaveProject（保存 → 確認）を通ってから動かす。通さない形は無い', () => {
    const chat = fs.readFileSync(path.join(__dirname, '../src/renderer/components/ChatPanel.tsx'), 'utf-8')
    expect(app).toContain(" onBeforeProjectFilesMove={() => leaveProject('organize')} ")
    expect(app).not.toContain(' onBeforeProjectFilesMove={leaveProject} ')
    expect(chat).toContain('beforeMove: onBeforeProjectFilesMove ?? (async () => true),')
    expect(chat).toContain('runGuardedMigrate({')
    // 直す前の形（確認なしに整理を呼ぶ）
    expect(chat).not.toContain('const r = await window.electronAPI.fs.migrate(projectDir!, snapshotId)')
  })

  it('★★★ プロジェクトを切り替える入口（サイドバー・公開したもの一覧・新規作成）は、すべて changeDir（保存 → 確認）を通る。直に setCurrentDir を呼ぶ形は無い', () => {
    const guard = bodyOf(app, 'const leaveProject = useCallback(', 'const changeDir = useCallback')
    expect(guard).toContain("(action: LeaveAction = 'switch') => saveBeforeLeave({ ...saveDeps, confirmDiscard: unsaved => askUser(leaveUnsavedNotice(unsaved, action)) })")
    const body = bodyOf(app, 'const changeDir = useCallback(async (dir: string | null): Promise<boolean> => {', 'window.electronAPI.win.onSaveAll')
    expect(body).toContain('if (dir !== null && dir !== currentDir) {')
    expect(body).toContain('const ok = await leaveProject()')
    expect(body).not.toContain('saveBeforeLeave')
    expect(body).toContain('if (!ok) return false')
    expect(body.indexOf('leaveProject()')).toBeLessThan(body.indexOf('setCurrentDir(dir)'))
    expect(app).toContain('onSetDir={changeDir}')
    expect(app).toContain('onOpenProject={dir => { void changeDir(dir) }}')
    expect(app).toContain('if (!(await changeDir(root))) return')
    // 直す前の形
    expect(app).not.toContain('onSetDir={setCurrentDir}')
    expect(app).not.toContain('onOpenProject={dir => setCurrentDir(dir)}')
    expect(app).not.toContain('            setCurrentDir(root)\n')
    // setCurrentDir を直に呼ぶのは、この4か所だけ（保存先の選び直し・チャットの切り替え・起動時の復元・changeDir）。足すときは入口として確かめる
    const direct = app.split('\n').filter(l => /\bsetCurrentDir\(/.test(l)).map(l => l.trim())
    expect(direct).toEqual([
      'setCurrentDir(base)',
      'setCurrentDir(switchTarget)',
      'if (dir && !cancelled) setCurrentDir(dir)',
      'setCurrentDir(dir)',
    ])
  })

  it('★ 履歴からの復元のあと、見ているタブが残っていれば選びを外さない（未保存の編集があって残したタブ）', () => {
    const body = bodyOf(app, 'const applyRestoreResult = useCallback(', 'const activeFileObj')
    expect(body).toContain('setActiveFile(prev => (prev && !openFilesRef.current.some(f => f.path === prev)) ? null : prev)')
    expect(body).not.toContain('deletedAbs.has(prev)')
  })
})
