import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {} },
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {}, openPath: async () => '' },
  dialog: {},
}))

import { buildMainIo, buildMainPorts } from '../src/main/chat/turnRunner'
import { readForWatch } from '../src/main/writeWatchRead'
import { createAskBridge } from '../src/main/chat/askBridge'
import { createWriteWatch } from '../src/shared/writeWatch'
import { executeToolCore } from '../src/shared/toolExecCore'
import { forStorage } from '../src/shared/chatStorage'
import { bodyMessages, compactSource } from '../src/shared/historyCompact'

// 見本のキーは連結で組み立てる（実在しない値）。
const BODY = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const GH = 'gh' + 'p_' + BODY
const CONTENT = `const t = "${GH}"\n`

let tmpDirs: string[] = []
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-writewatch-'))
  tmpDirs.push(d)
  return d
}
beforeEach(() => { tmpDirs = [] })
afterEach(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

const payload = { turnId: 't1', spec: { apiKey: '', toolsProjectDir: null }, caps: {} } as any

function readNow(p: string): Promise<string | null> {
  try { return Promise.resolve(fs.readFileSync(p, 'utf-8')) } catch { return Promise.resolve(null) }
}

describe('本物の buildMainIo と createWriteWatch と executeToolCore', () => {
  it('write_file でキーを書くと、finish が ⚠️ の知らせを返し、text にも marks にも値が入らない', async () => {
    const root = mkTmp()
    const watch = createWriteWatch({ displayRoot: root, read: readNow })
    const io = buildMainIo({ writeRoot: root }, payload, () => {}, watch)
    const r = await executeToolCore('write_file', JSON.stringify({ path: 'src/a.js', content: CONTENT }), { writeRoot: root, projectRoot: root, snapshotId: 's1' }, io)
    expect(r).toContain('保存しました')
    expect(r).not.toContain('⚠️')
    const n = await watch.finish()
    expect(n).not.toBeNull()
    expect(n!.text.startsWith('⚠️')).toBe(true)
    expect(n!.marks).toEqual([{ file: 'src/a.js', kind: 'known-key', line: 1 }])
    const all = JSON.stringify(n)
    expect(all).not.toContain(BODY)
    expect(all).not.toContain(GH)
  })

  it('同じ中身を2回目のターン（新しい集め役・before に同じ行）で書くと、null', async () => {
    const root = mkTmp()
    fs.writeFileSync(path.join(root, 'a.js'), CONTENT)
    const watch = createWriteWatch({ displayRoot: root, read: readNow })
    const io = buildMainIo({ writeRoot: root }, payload, () => {}, watch)
    await executeToolCore('write_file', JSON.stringify({ path: 'a.js', content: CONTENT }), { writeRoot: root, projectRoot: root, snapshotId: 's1' }, io)
    expect(await watch.finish()).toBeNull()
  })

  it('edit_file でキーを足すと、知らせが出る', async () => {
    const root = mkTmp()
    fs.writeFileSync(path.join(root, 'a.js'), 'const t = "PLACE"\n')
    const watch = createWriteWatch({ displayRoot: root, read: readNow })
    const io = buildMainIo({ writeRoot: root }, payload, () => {}, watch)
    await executeToolCore('edit_file', JSON.stringify({ path: 'a.js', old_string: 'PLACE', new_string: GH }), { writeRoot: root, projectRoot: root, snapshotId: 's1' }, io)
    const n = await watch.finish()
    expect(n!.marks).toEqual([{ file: 'a.js', kind: 'known-key', line: 1 }])
  })
})

describe('buildMainPorts: 集め役が executeTool と writeWatch.finish の間で繋がっている', () => {
  function makeEntry() {
    return { bridge: createAskBridge(() => {}), abort: null, stopRequested: false, written: { request: false, failure: false } } as any
  }
  const wc = { isDestroyed: () => false, send: () => {} } as any

  it('同じ ports の executeTool で書いた分が、同じ ports の writeWatch.finish に出る。finish のあとは空', async () => {
    const root = mkTmp()
    const p = { ...payload, spec: { apiKey: '', toolsProjectDir: root } }
    const ports = buildMainPorts('t1', wc, p, makeEntry())
    await ports.executeTool('write_file', JSON.stringify({ path: 'web/a.js', content: CONTENT }), { writeRoot: root, projectRoot: root, snapshotId: 's1' })
    const n = await ports.writeWatch.finish()
    expect(n).not.toBeNull()
    expect(n!.marks).toEqual([{ file: 'web/a.js', kind: 'known-key', line: 1 }])
    expect(JSON.stringify(n)).not.toContain(BODY)
    expect(await ports.writeWatch.finish()).toBeNull()
  })

  it('別の ports（別のターン）の集め役とは混ざらない', async () => {
    const root = mkTmp()
    const p = { ...payload, spec: { apiKey: '', toolsProjectDir: root } }
    const a = buildMainPorts('t1', wc, p, makeEntry())
    const b = buildMainPorts('t2', wc, p, makeEntry())
    await a.executeTool('write_file', JSON.stringify({ path: 'a.js', content: CONTENT }), { writeRoot: root, projectRoot: root, snapshotId: 's1' })
    expect(await b.writeWatch.finish()).toBeNull()
    expect(await a.writeWatch.finish()).not.toBeNull()
  })

  it('何も書かなかったターンは null', async () => {
    const ports = buildMainPorts('t1', wc, payload, makeEntry())
    expect(await ports.writeWatch.finish()).toBeNull()
  })
})

describe('readForWatch: 点検のための読み込み', () => {
  it('ふつうのファイルは中身を返す', async () => {
    const root = mkTmp()
    fs.writeFileSync(path.join(root, 'a.txt'), 'abc')
    expect(await readForWatch(path.join(root, 'a.txt'))).toBe('abc')
  })

  it('上限（4,000,000 バイト）を超えるファイルは読まずに null、ちょうどなら読む', async () => {
    const root = mkTmp()
    const exact = path.join(root, 'exact.txt')
    const over = path.join(root, 'over.txt')
    fs.writeFileSync(exact, 'a'.repeat(4_000_000))
    fs.writeFileSync(over, 'a'.repeat(4_000_001))
    expect(await readForWatch(exact)).toHaveLength(4_000_000)
    expect(await readForWatch(over)).toBeNull()
  })

  it('無いファイルは null（投げない）', async () => {
    const root = mkTmp()
    expect(await readForWatch(path.join(root, 'none.txt'))).toBeNull()
  })
})

describe('⚠️ の吹き出しの保存と、まとめの材料', () => {
  const bubble = {
    role: 'assistant' as const,
    toolNote: true,
    content: '⚠️ a.js の1行目に、APIキーが直接書かれています（ghp_…・40文字）。公開すると、他の人に使われるおそれがあります。',
    writeFix: [{ file: 'a.js', kind: 'known-key' as const, line: 1 }],
  }

  it('forStorage を通しても writeFix が残り、値は無い', () => {
    const saved = JSON.parse(JSON.stringify(forStorage([bubble])))[0]
    expect(saved.writeFix).toEqual(bubble.writeFix)
    expect(saved.toolNote).toBe(true)
    expect(JSON.stringify(saved)).not.toContain(BODY)
  })

  it('AI へ送る履歴（bodyMessages）にもまとめの材料（compactSource）にも入らない', () => {
    const msgs = [{ role: 'user' as const, content: 'こんにちは' }, bubble, { role: 'assistant' as const, content: 'どうぞ' }]
    expect(bodyMessages(msgs)).not.toContain(bubble)
    expect(compactSource(msgs, 0, 10)).not.toContain(bubble)
  })
})
