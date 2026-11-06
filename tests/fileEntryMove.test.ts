import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fileEntryMoveAction, moveFileEntry, moveConfirmBody,
  MOVE_FAILED_TITLE, MOVE_CHECK_UNREADABLE_MESSAGE, MOVE_FAILED_FALLBACK_MESSAGE,
  type FileEntryMoveDeps,
} from '../src/renderer/fileEntryOps'

// ── 0.6.26 ファイル一覧の「移動」は、先に main へ聞く（project:moveCheck）→ 断りなら通知だけ → 確認 → 移す ───────────────────
// 偽の口（deps）に流し、**呼ばれた順の一覧**を見る（掟10: 聞いた答えを無視すると、確認も出さずに移す要求が飛ぶ）。
//   ・断り（ok:false）→ 通知だけ。確認も moveFiles も 0 回
//   ・聞けなかった（投げた・形が違う）→ 断る（不明を「移してよい」と読まない）
//   ・確認でやめた → moveFiles 0 回
//   ・同名があって別の名前で移す分は、確認の本文で先に言う

const DIR = '/work/proj'
const ENTRY = { name: 'a.html', path: `${DIR}/a.html`, isDir: false }

function setup(check: unknown | Error, opts: { confirm?: boolean; moved?: unknown | Error; hasPublishDir?: boolean; projectDir?: string | null } = {}) {
  const calls: string[] = []
  const log = {
    checked: [] as unknown[][], moved: [] as unknown[][], confirms: [] as { title: string; body: string; confirmLabel?: string }[],
    notices: [] as { title: string; body: string }[], renamed: [] as [string, string][], hints: [] as string[],
  }
  const deps: FileEntryMoveDeps = {
    projectDir: opts.projectDir === undefined ? DIR : opts.projectDir,
    hasPublishDir: opts.hasPublishDir ?? true,
    moveCheck: async (...a) => { calls.push('moveCheck'); log.checked.push(a); if (check instanceof Error) throw check; return check },
    moveFiles: async (...a) => {
      calls.push('moveFiles'); log.moved.push(a)
      if (opts.moved instanceof Error) throw opts.moved
      return 'moved' in opts ? opts.moved : { ok: true, moved: ['a.html'], snapshotOk: true }
    },
    confirm: async o => { calls.push('confirm'); log.confirms.push(o as never); return opts.confirm ?? true },
    notify: o => { calls.push('notify'); log.notices.push({ title: o.title, body: o.body }) },
    refreshTree: () => { calls.push('refresh') },
    announceRenamed: (from, to) => { calls.push('announce'); log.renamed.push([from, to]) },
    showHint: t => { calls.push('hint'); log.hints.push(t) },
  }
  return { calls, log, deps }
}

describe('fileEntryMoveAction（純関数）: main の答えから、画面の動きを決める', () => {
  it('★★★ ok:true だけが確認へ進む。renamed に自分の分があれば予告の名前を持つ', () => {
    expect(fileEntryMoveAction({ ok: true, renamed: [] }, 'a.html')).toEqual({ kind: 'confirm', renamedTo: undefined })
    expect(fileEntryMoveAction({ ok: true, renamed: [{ from: 'a.html', to: 'a-2.html' }] }, 'a.html')).toEqual({ kind: 'confirm', renamedTo: 'a-2.html' })
    expect(fileEntryMoveAction({ ok: true, renamed: [{ from: 'b.html', to: 'b-2.html' }] }, 'a.html')).toEqual({ kind: 'confirm', renamedTo: undefined })
    expect(fileEntryMoveAction({ ok: false, message: '記録は移せません' }, 'a.html')).toEqual({ kind: 'refuse', message: '記録は移せません' })
  })

  it('★★★ 読めない答え（undefined・null・{}・ok が true でない・文が無い）は断る側。確認へ進めない', () => {
    const odd: unknown[] = [undefined, null, {}, 'ok', 1, { ok: 'true' }, { ok: 1 }, { ok: 0 }, { ok: false }, { ok: false, message: '' }, { ok: false, message: 5 }]
    for (const a of odd) {
      expect(fileEntryMoveAction(a, 'a.html'), JSON.stringify(a)).toEqual({ kind: 'refuse', message: MOVE_CHECK_UNREADABLE_MESSAGE })
    }
  })
})

describe('moveFileEntry: 先に聞く → 断りなら通知だけ → 確認 → 移す', () => {
  it('★★★ 通る: 聞く → 確認 → 移す → 反映 → タブへ知らせる（この順）。公開するものへ', async () => {
    const { calls, log, deps } = setup({ ok: true, renamed: [] })
    await moveFileEntry(ENTRY, false, deps)
    expect(calls).toEqual(['moveCheck', 'confirm', 'moveFiles', 'refresh', 'announce'])
    expect(log.checked).toEqual([[DIR, ['a.html'], 'publish']])
    expect(log.moved).toEqual([[DIR, ['a.html'], 'publish']])
    expect(log.confirms[0].title).toBe('ファイルを移動します')
    expect(log.confirms[0].confirmLabel).toBe('移動する')
    expect(log.renamed).toEqual([[ENTRY.path, `${DIR}/public/a.html`]])
    expect(log.notices).toEqual([])
  })

  it('★★★ 公開される側から → 素材置き場（materials）へ', async () => {
    const { log, deps } = setup({ ok: true, renamed: [] })
    await moveFileEntry({ name: 'a.html', path: `${DIR}/public/a.html`, isDir: false }, true, deps)
    expect(log.checked).toEqual([[DIR, ['public/a.html'], 'materials']])
    expect(log.moved).toEqual([[DIR, ['public/a.html'], 'materials']])
  })

  it('★★★ 断り（ok:false）: 通知だけ。確認も moveFiles も 0 回。文は main のまま', async () => {
    const { calls, log, deps } = setup({ ok: false, message: 'このファイルは移せません。' })
    await moveFileEntry(ENTRY, false, deps)
    expect(calls).toEqual(['moveCheck', 'notify'])
    expect(log.notices).toEqual([{ title: MOVE_FAILED_TITLE, body: 'このファイルは移せません。' }])
    expect(log.moved).toEqual([])
  })

  it('★★★ 形違いの答えは断る: 確認も moveFiles も 0 回（不明を「移してよい」にしない）', async () => {
    for (const answer of [undefined, null, {}, { ok: 'true' }, { ok: 1, renamed: [] }, 'ok']) {
      const { calls, log, deps } = setup(answer)
      await moveFileEntry(ENTRY, false, deps)
      expect(calls, JSON.stringify(answer)).toEqual(['moveCheck', 'notify'])
      expect(log.notices[0].body).toBe(MOVE_CHECK_UNREADABLE_MESSAGE)
    }
  })

  it('★★★ moveCheck が投げる: 通知だけ。確認も moveFiles も 0 回。英語の頭は出ない', async () => {
    const { calls, log, deps } = setup(new Error("Error invoking remote method 'project:moveCheck': Error: 調べられませんでした"))
    await moveFileEntry(ENTRY, false, deps)
    expect(calls).toEqual(['moveCheck', 'notify'])
    expect(log.notices[0].title).toBe(MOVE_FAILED_TITLE)
    expect(log.notices[0].body).toContain('調べられませんでした')
    expect(log.notices[0].body).not.toContain('Error invoking')
  })

  it('★★★ 確認でやめた: moveFiles 0 回・反映も知らせもしない', async () => {
    const { calls, deps } = setup({ ok: true, renamed: [] }, { confirm: false })
    await moveFileEntry(ENTRY, false, deps)
    expect(calls).toEqual(['moveCheck', 'confirm'])
  })

  it('★★ 同名がある: 確認の本文で先に言う。実際も同じ名前なら、あとから帯は出さない', async () => {
    const { calls, log, deps } = setup({ ok: true, renamed: [{ from: 'a.html', to: 'a-2.html' }] }, { moved: { ok: true, moved: ['a-2.html'], snapshotOk: true, renamed: [{ from: 'a.html', to: 'a-2.html' }] } })
    await moveFileEntry(ENTRY, false, deps)
    expect(log.confirms[0].body).toContain('移動先に同じ名前があるため、「a-2.html」にします。')
    expect(calls).toEqual(['moveCheck', 'confirm', 'moveFiles', 'refresh', 'announce'])
    expect(log.renamed).toEqual([[ENTRY.path, `${DIR}/public/a-2.html`]])
    expect(log.hints).toEqual([])
  })

  it('★★ 同名が無いと聞いたのに、実行時に名前が変わった: 既存の帯で知らせる', async () => {
    const { calls, log, deps } = setup({ ok: true, renamed: [] }, { moved: { ok: true, moved: ['a-2.html'], snapshotOk: true, renamed: [{ from: 'a.html', to: 'a-2.html' }] } })
    await moveFileEntry(ENTRY, false, deps)
    expect(log.confirms[0].body).not.toContain('同じ名前')
    expect(calls).toEqual(['moveCheck', 'confirm', 'moveFiles', 'refresh', 'announce', 'hint'])
    expect(log.hints).toEqual(['「a.html」と同じ名前が移動先にあったため、「a-2.html」にしました。'])
  })

  it('★★★ moveFiles が断る・形違い: 通知を出し、反映もタブへの知らせもしない', async () => {
    for (const [moved, body] of [
      [{ ok: false, moved: [], snapshotOk: true, message: '移動先に書き込めません' }, '移動先に書き込めません'],
      [{ ok: false, moved: [], snapshotOk: true }, MOVE_FAILED_FALLBACK_MESSAGE],
      [{ ok: 'true' }, MOVE_FAILED_FALLBACK_MESSAGE],
      [undefined, MOVE_FAILED_FALLBACK_MESSAGE],
    ] as [unknown, string][]) {
      const { calls, log, deps } = setup({ ok: true, renamed: [] }, { moved })
      await moveFileEntry(ENTRY, false, deps)
      expect(calls, JSON.stringify(moved)).toEqual(['moveCheck', 'confirm', 'moveFiles', 'notify'])
      expect(log.notices).toEqual([{ title: MOVE_FAILED_TITLE, body }])
    }
  })

  it('★★ moveFiles が投げる: 通知を出し、反映もタブへの知らせもしない', async () => {
    const { calls, log, deps } = setup({ ok: true, renamed: [] }, { moved: new Error('boom') })
    await moveFileEntry(ENTRY, false, deps)
    expect(calls).toEqual(['moveCheck', 'confirm', 'moveFiles', 'notify'])
    expect(log.notices[0].title).toBe(MOVE_FAILED_TITLE)
  })

  it('★★ public/ がまだ無いプロジェクトで初めて公開するものへ移すときは、その影響を確認の本文で言う。素材置き場へは言わない', async () => {
    const a = setup({ ok: true, renamed: [] }, { hasPublishDir: false })
    await moveFileEntry(ENTRY, false, a.deps)
    expect(a.log.confirms[0].body).toContain('フォルダができるため')
    const b = setup({ ok: true, renamed: [] }, { hasPublishDir: false })
    await moveFileEntry({ name: 'a.html', path: `${DIR}/public/a.html`, isDir: false }, true, b.deps)
    expect(b.log.confirms[0].body).not.toContain('フォルダができるため')
  })

  it('★★ 防御: プロジェクトが無い・フォルダ・プロジェクト外のパスは、何も聞かない・何もしない', async () => {
    for (const [entry, opts] of [
      [ENTRY, { projectDir: null }],
      [{ ...ENTRY, isDir: true }, {}],
      [{ name: 'x', path: '/elsewhere/x', isDir: false }, {}],
      [{ name: 'x', path: '/work/proj-other/x', isDir: false }, {}],
    ] as [typeof ENTRY, { projectDir?: string | null }][]) {
      const { calls, deps } = setup({ ok: true, renamed: [] }, opts)
      await moveFileEntry(entry, false, deps)
      expect(calls).toEqual([])
    }
  })
})

describe('moveConfirmBody', () => {
  it('同名の予告があれば「移動先に同じ名前があるため、「…」にします。」を足す。無ければ今までの文のまま', () => {
    const plain = moveConfirmBody('a.html', 'public', false)
    expect(plain).toBe('「a.html」を「public」へ移動します。よろしいですか？\n\n🕘 元に戻すで戻せます。')
    expect(moveConfirmBody('a.html', 'public', false, 'a-2.html')).toContain('移動先に同じ名前があるため、「a-2.html」にします。')
  })
})

describe('配線（ソース）: Sidebar は moveFileEntry に口を渡す1本だけ。移動で window.alert を使わない', () => {
  const sidebar = readFileSync(join(__dirname, '..', 'src/renderer/components/Sidebar.tsx'), 'utf-8')
  const ops = readFileSync(join(__dirname, '..', 'src/renderer/fileEntryOps.ts'), 'utf-8')
  it('★★★ moveEntry は moveFileEntry を呼び、moveCheck と moveFiles を口として渡す。旧い形（直の moveFiles 呼び・alert）は無い', () => {
    expect(sidebar).toContain('const moveEntry = (entry: FileEntry, published: boolean) => moveFileEntry(entry, published, {')
    expect(sidebar).toContain('moveCheck: (d, files, dest) => window.electronAPI.fs.moveCheck(d, files, dest),')
    expect(sidebar).toContain('moveFiles: (d, files, dest) => window.electronAPI.fs.moveFiles(d, files, dest),')
    expect(sidebar).not.toContain('const moveEntry = async')
    expect(sidebar).not.toContain('fs.moveFiles(currentDir')
    expect(sidebar).not.toContain('window.alert(')
    expect(sidebar).not.toContain('移動できませんでした')
  })
  it('★★★ moveFileEntry の中で、moveCheck が確認より前・確認が moveFiles より前', () => {
    const body = ops.slice(ops.indexOf('export async function moveFileEntry('))
    const iCheck = body.indexOf('deps.moveCheck(')
    const iConfirm = body.indexOf('deps.confirm(')
    const iMove = body.indexOf('deps.moveFiles(')
    expect(iCheck).toBeGreaterThan(0)
    expect(iConfirm).toBeGreaterThan(iCheck)
    expect(iMove).toBeGreaterThan(iConfirm)
    expect(body).not.toContain('e?.message')
  })
})

describe('移動の失敗の文は、ほかの画面の失敗と同じ言い方', () => {
  it('原因が返らないときは「原因不明」（プロジェクトの削除・整理・素材置き場への移動と同じ）', () => {
    expect(MOVE_FAILED_FALLBACK_MESSAGE).toBe('原因不明')
  })
})
