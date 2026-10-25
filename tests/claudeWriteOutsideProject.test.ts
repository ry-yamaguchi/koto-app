// tests/claudeWriteOutsideProject.test.ts — Claude モードの Write/Edit が、プロジェクトの外や
// 直下の管理領域へ届いていた穴の固定（2026-10-23・0.6.23）。
//
// 穴: src/main/claude/agent.ts の makeCanUseTool は、書き込み先を writeRoot（Claude の作業フォルダ。
// public/ があればその中）基準で点検し、writeRoot の外を指すと点検を飛ばして承認の判定へ進んでいた。
// おまかせ（auto）の承認判定は「許可」なので、プロジェクトの外の任意のファイル（~/.zshrc など）や、
// public/ のあるプロジェクトの直下の管理領域（.sakuraide.json・.git/hooks・.sakuraide-backup）へ書けた。
//
// ここでは makeCanUseTool を**直接呼び**、承認（requestApproval）だけを偽物にして、
// 返った許可/拒否と、承認を求めた回数を見る（掟10: ソースの文字列を grep しない・振る舞いで固定する）。
// 偽物にする書き方は tests/w-chat-claudeApproval.test.ts のねらい（承認は main の帳簿へ駐機する）に倣い、
// 駐機の代わりに「呼ばれた回数と文面を記録して、決めておいた答えを即返す」形にしている。

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'

const approvals = vi.hoisted(() => ({
  calls: [] as { turnId: string; dir: string | null; label: string }[],
  answer: true,
}))

vi.mock('../src/main/chat/approvalStore', () => ({
  requestApproval: async (entry: { turnId: string; dir: string | null; label: string }) => {
    approvals.calls.push(entry)
    return approvals.answer
  },
}))

import { makeCanUseTool } from '../src/main/claude/agent'
import { writeDenialMessage } from '../src/shared/approvalPlan'
import { protectedWriteMessage } from '../src/shared/protectedPaths'

const PROJECT = '/Users/someone/proj'
const PUBLIC = `${PROJECT}/public`

async function run(
  writeRoot: string, writeMode: 'auto' | 'confirm', tool: 'Write' | 'Edit', input: unknown,
) {
  const canUseTool = makeCanUseTool(PROJECT, writeRoot, writeMode, 't-outside')
  return canUseTool(tool, input as Record<string, unknown>, {} as any)
}

const w = (file_path: unknown) => ({ file_path, content: 'x' })
const e = (file_path: unknown) => ({ file_path, old_string: 'a', new_string: 'b' })

describe('Claude の Write/Edit: プロジェクトの外には書けない（おまかせ・作業フォルダ＝プロジェクト直下）', () => {
  beforeEach(() => { approvals.calls.length = 0; approvals.answer = true })

  it('★★ 絶対パス /Users/someone/.zshrc は deny・承認は0回', async () => {
    const r = await run(PROJECT, 'auto', 'Write', w('/Users/someone/.zshrc'))
    expect(r.behavior).toBe('deny')
    expect((r as any).message).toContain('プロジェクトのフォルダの外')
    expect((r as any).message).toContain('/Users/someone/.zshrc')
    expect(approvals.calls).toEqual([])
  })

  it('★★ 相対パス ../outside.txt は deny（作業フォルダ基準で解いて外と判る）', async () => {
    const r = await run(PROJECT, 'auto', 'Write', w('../outside.txt'))
    expect(r.behavior).toBe('deny')
    expect(approvals.calls).toEqual([])
  })

  it('★ ホームの省略形 ~/.zshrc も外（SDK 側で展開されても外へ出さない）', async () => {
    const r = await run(PROJECT, 'auto', 'Write', w('~/.zshrc'))
    expect(r.behavior).toBe('deny')
    expect((r as any).message).toContain(`${os.homedir()}/.zshrc`)
    expect(approvals.calls).toEqual([])
  })

  it('★ プロジェクトの兄弟フォルダ（/Users/someone/proj-other/x）は外（前方一致で中と誤判定しない）', async () => {
    const r = await run(PROJECT, 'auto', 'Write', w('/Users/someone/proj-other/x'))
    expect(r.behavior).toBe('deny')
    expect(approvals.calls).toEqual([])
  })

  it('プロジェクトそのもの（フォルダを指す）は deny', async () => {
    const r = await run(PROJECT, 'auto', 'Write', w(PROJECT))
    expect(r.behavior).toBe('deny')
    expect(approvals.calls).toEqual([])
  })

  it('プロジェクトの中の <project>/index.html は allow（絶対パス）', async () => {
    const r = await run(PROJECT, 'auto', 'Write', w(`${PROJECT}/index.html`))
    expect(r).toEqual({ behavior: 'allow' })
    expect(approvals.calls).toEqual([])
  })

  it('プロジェクトの中の相対パス css/style.css は allow（作業フォルダ基準）', async () => {
    const r = await run(PROJECT, 'auto', 'Write', w('css/style.css'))
    expect(r).toEqual({ behavior: 'allow' })
  })

  it('プロジェクトの中でも管理領域（.git/hooks）は deny（プロジェクト直下基準の点検）', async () => {
    const r = await run(PROJECT, 'auto', 'Write', w('.git/hooks/pre-commit'))
    expect(r.behavior).toBe('deny')
    expect((r as any).message).toBe(protectedWriteMessage('.git/hooks/pre-commit'))
  })
})

describe('Claude の Write/Edit: 作業フォルダが <project>/public のとき（おまかせ）', () => {
  beforeEach(() => { approvals.calls.length = 0; approvals.answer = true })

  it('★★ <project>/.sakuraide.json は deny（直下の管理領域。以前は点検の外）', async () => {
    const r = await run(PUBLIC, 'auto', 'Write', w(`${PROJECT}/.sakuraide.json`))
    expect(r.behavior).toBe('deny')
    expect((r as any).message).toBe(protectedWriteMessage('.sakuraide.json'))
    expect(approvals.calls).toEqual([])
  })

  it('★★ <project>/.git/hooks/pre-commit は deny', async () => {
    const r = await run(PUBLIC, 'auto', 'Write', w(`${PROJECT}/.git/hooks/pre-commit`))
    expect(r.behavior).toBe('deny')
    expect(approvals.calls).toEqual([])
  })

  it('★★ <project>/.sakuraide-backup/x は deny（🕘 履歴）', async () => {
    const r = await run(PUBLIC, 'auto', 'Write', w(`${PROJECT}/.sakuraide-backup/x`))
    expect(r.behavior).toBe('deny')
    expect(approvals.calls).toEqual([])
  })

  it('<project>/.sakuraide/chat.json と <project>/.env は deny', async () => {
    expect((await run(PUBLIC, 'auto', 'Write', w(`${PROJECT}/.sakuraide/chat.json`))).behavior).toBe('deny')
    expect((await run(PUBLIC, 'auto', 'Write', w(`${PROJECT}/.env`))).behavior).toBe('deny')
    expect(approvals.calls).toEqual([])
  })

  it('相対パス ../.sakuraide.json（作業フォルダ public/ の一つ上）も deny', async () => {
    const r = await run(PUBLIC, 'auto', 'Write', w('../.sakuraide.json'))
    expect(r.behavior).toBe('deny')
  })

  // 相対パスは SDK が cwd（＝作業フォルダ public/）基準で解く。こちらも同じ基準で解いていることの固定。
  // 変異「相対パスを scopeDir（プロジェクト直下）基準で解く」では、次の2件が逆になる
  // （../server.js が <project> の一つ上＝外になって deny、.sakuraide.json が直下の管理領域になって deny）。
  it('★★ 相対パス ../server.js は allow（作業フォルダ public/ の一つ上＝<project>/server.js。プロジェクトの中）', async () => {
    const r = await run(PUBLIC, 'auto', 'Write', w('../server.js'))
    expect(r).toEqual({ behavior: 'allow' })
    expect(approvals.calls).toEqual([])
  })

  it('★★ 相対パス .sakuraide.json は allow（<project>/public/.sakuraide.json は管理領域ではない）', async () => {
    const r = await run(PUBLIC, 'auto', 'Write', w('.sakuraide.json'))
    expect(r).toEqual({ behavior: 'allow' })
    expect(approvals.calls).toEqual([])
  })

  it('相対パス ../../x は deny（作業フォルダ public/ の二つ上＝プロジェクトの外）', async () => {
    const r = await run(PUBLIC, 'auto', 'Write', w('../../x'))
    expect(r.behavior).toBe('deny')
  })

  it('Edit でも同じ基準（../server.js は allow、.sakuraide.json は allow、../.sakuraide.json は deny）', async () => {
    expect(await run(PUBLIC, 'auto', 'Edit', e('../server.js'))).toEqual({ behavior: 'allow' })
    expect(await run(PUBLIC, 'auto', 'Edit', e('.sakuraide.json'))).toEqual({ behavior: 'allow' })
    expect((await run(PUBLIC, 'auto', 'Edit', e('../.sakuraide.json'))).behavior).toBe('deny')
  })

  it('<project>/public/index.html は allow', async () => {
    const r = await run(PUBLIC, 'auto', 'Write', w(`${PUBLIC}/index.html`))
    expect(r).toEqual({ behavior: 'allow' })
    expect(approvals.calls).toEqual([])
  })

  it('相対パス index.html は作業フォルダ（public/）の中として allow', async () => {
    const r = await run(PUBLIC, 'auto', 'Write', w('index.html'))
    expect(r).toEqual({ behavior: 'allow' })
  })

  it('★ <project>/server.js（プロジェクトの中・public/ の外）は、これまでどおり allow（広げも狭めもしない）', async () => {
    const r = await run(PUBLIC, 'auto', 'Write', w(`${PROJECT}/server.js`))
    expect(r).toEqual({ behavior: 'allow' })
    expect(approvals.calls).toEqual([])
  })

  it('★★ /tmp/x は deny', async () => {
    const r = await run(PUBLIC, 'auto', 'Write', w('/tmp/x'))
    expect(r.behavior).toBe('deny')
    expect(approvals.calls).toEqual([])
  })

  it('public/ の中の管理領域名（public/.git/hooks/x）も deny（従来どおり）', async () => {
    const r = await run(PUBLIC, 'auto', 'Write', w(`${PUBLIC}/.git/hooks/x`))
    expect(r.behavior).toBe('deny')
  })
})

describe('Claude の Write/Edit: 毎回確認（confirm）', () => {
  beforeEach(() => { approvals.calls.length = 0; approvals.answer = true })

  it('★★ プロジェクトの外は、承認を出さずに deny（承認は0回・答えが yes でも書かせない）', async () => {
    approvals.answer = true
    const r = await run(PROJECT, 'confirm', 'Write', w('/Users/someone/.zshrc'))
    expect(r.behavior).toBe('deny')
    expect(approvals.calls).toEqual([])
  })

  it('管理領域（public/ 基準の作業フォルダから見た直下の .sakuraide.json）も、承認を出さずに deny', async () => {
    const r = await run(PUBLIC, 'confirm', 'Write', w(`${PROJECT}/.sakuraide.json`))
    expect(r.behavior).toBe('deny')
    expect(approvals.calls).toEqual([])
  })

  it('★ <project>/public/index.html は承認が1回出る（文面はプロジェクト直下からの相対 public/index.html）。答えが no なら deny', async () => {
    approvals.answer = false
    const r = await run(PUBLIC, 'confirm', 'Write', w(`${PUBLIC}/index.html`))
    expect(approvals.calls).toHaveLength(1)
    expect(approvals.calls[0]).toEqual({ turnId: 't-outside', dir: PROJECT, label: '✏️ ファイルの保存（public/index.html）' })
    expect(r.behavior).toBe('deny')
    expect((r as any).message).toBe(writeDenialMessage('write_file', JSON.stringify({ path: 'public/index.html' })))
  })

  it('★ <project>/public/index.html は、承認の答えが yes なら allow', async () => {
    approvals.answer = true
    const r = await run(PUBLIC, 'confirm', 'Write', w(`${PUBLIC}/index.html`))
    expect(approvals.calls).toHaveLength(1)
    expect(r).toEqual({ behavior: 'allow' })
  })

  it('★ <project>/server.js（public/ の外・プロジェクトの中）も承認が1回出る', async () => {
    approvals.answer = true
    const r = await run(PUBLIC, 'confirm', 'Write', w(`${PROJECT}/server.js`))
    expect(approvals.calls).toHaveLength(1)
    expect(approvals.calls[0].label).toBe('✏️ ファイルの保存（server.js）')
    expect(r).toEqual({ behavior: 'allow' })
  })

  it('Edit の承認は「ファイルの編集」の文面', async () => {
    approvals.answer = false
    const r = await run(PUBLIC, 'confirm', 'Edit', e(`${PUBLIC}/app.js`))
    expect(approvals.calls).toHaveLength(1)
    expect(approvals.calls[0].label).toBe('✏️ ファイルの編集（public/app.js）')
    expect(r.behavior).toBe('deny')
  })

  // 2巡目（2026-10-23）: 作業フォルダが <project>/public のとき、writeRoot 基準で出すと
  // <project>/index.html と <project>/public/index.html がどちらも「index.html」になり区別がつかなかった。
  it('★★ 作業フォルダが public/ のとき、<project>/index.html と <project>/public/index.html の承認の文は別（常にプロジェクト直下からの相対）', async () => {
    approvals.answer = true
    await run(PUBLIC, 'confirm', 'Write', w(`${PROJECT}/index.html`))
    await run(PUBLIC, 'confirm', 'Write', w(`${PUBLIC}/index.html`))
    expect(approvals.calls).toHaveLength(2)
    expect(approvals.calls[0].label).toBe('✏️ ファイルの保存（index.html）')
    expect(approvals.calls[1].label).toBe('✏️ ファイルの保存（public/index.html）')
    expect(approvals.calls[0].label).not.toBe(approvals.calls[1].label)
  })

  it('相対パス index.html（＝作業フォルダ public/ の中）の承認の文は public/index.html。断った文も同じパス', async () => {
    approvals.answer = false
    const r = await run(PUBLIC, 'confirm', 'Write', w('index.html'))
    expect(approvals.calls[0].label).toBe('✏️ ファイルの保存（public/index.html）')
    expect((r as any).message).toBe(writeDenialMessage('write_file', JSON.stringify({ path: 'public/index.html' })))
  })

  it('public/ の無いプロジェクト（作業フォルダ＝プロジェクト直下）の表示は、これまでと変わらない', async () => {
    approvals.answer = true
    await run(PROJECT, 'confirm', 'Write', w(`${PROJECT}/src/app.js`))
    expect(approvals.calls[0].label).toBe('✏️ ファイルの保存（src/app.js）')
  })
})

describe('Claude の Write/Edit: パスが無い・文字列でない', () => {
  beforeEach(() => { approvals.calls.length = 0; approvals.answer = true })

  it.each([
    ['file_path が無い', {}],
    ['file_path が空文字', { file_path: '' }],
    ['file_path が数値', { file_path: 123 }],
    ['file_path が null', { file_path: null }],
    ['file_path が配列', { file_path: ['/tmp/x'] }],
    ['入力そのものが無い', undefined],
  ])('%s → deny（おまかせ・毎回確認のどちらでも承認は0回）', async (_name, input) => {
    for (const mode of ['auto', 'confirm'] as const) {
      for (const tool of ['Write', 'Edit'] as const) {
        const r = await run(PROJECT, mode, tool, input)
        expect(r.behavior).toBe('deny')
      }
    }
    expect(approvals.calls).toEqual([])
  })
})

describe('Claude の Edit も Write と同じ守りを通る', () => {
  beforeEach(() => { approvals.calls.length = 0; approvals.answer = true })

  it('★★ Edit: プロジェクトの外（絶対パス・../ ・~/）は deny', async () => {
    expect((await run(PROJECT, 'auto', 'Edit', e('/Users/someone/.zshrc'))).behavior).toBe('deny')
    expect((await run(PROJECT, 'auto', 'Edit', e('../outside.txt'))).behavior).toBe('deny')
    expect((await run(PROJECT, 'auto', 'Edit', e('~/.zshrc'))).behavior).toBe('deny')
    expect(approvals.calls).toEqual([])
  })

  it('★★ Edit: public/ 基準でも直下の .sakuraide.json と .git/hooks は deny', async () => {
    expect((await run(PUBLIC, 'auto', 'Edit', e(`${PROJECT}/.sakuraide.json`))).behavior).toBe('deny')
    expect((await run(PUBLIC, 'auto', 'Edit', e(`${PROJECT}/.git/hooks/pre-commit`))).behavior).toBe('deny')
    expect(approvals.calls).toEqual([])
  })

  it('Edit: プロジェクトの中は allow（public/ の中・外ともに）', async () => {
    expect(await run(PUBLIC, 'auto', 'Edit', e(`${PUBLIC}/index.html`))).toEqual({ behavior: 'allow' })
    expect(await run(PUBLIC, 'auto', 'Edit', e(`${PROJECT}/server.js`))).toEqual({ behavior: 'allow' })
  })
})

// 2巡目（2026-10-23）: macOS（APFS）は大文字小文字を区別しない。`.GIT/hooks/pre-commit` は `.git/hooks/pre-commit` と
// 同じ実体なのに、区別して比べていたため Claude の Write/Edit の守りから漏れた。
describe('Claude の Write/Edit: 管理領域の名前を大文字に変えても断る', () => {
  beforeEach(() => { approvals.calls.length = 0; approvals.answer = true })

  it.each([
    '.GIT/hooks/pre-commit', '.Sakuraide.json', '.SAKURAIDE-BACKUP/x', '.ENV', '.Env.local', '.SAKURAIDE/chat.json',
  ])('★★ おまかせ・作業フォルダ＝直下: %s は deny・承認は0回', async (rel) => {
    for (const tool of ['Write', 'Edit'] as const) {
      const r = await run(PROJECT, 'auto', tool, tool === 'Write' ? w(`${PROJECT}/${rel}`) : e(`${PROJECT}/${rel}`))
      expect(r.behavior, `${tool} ${rel}`).toBe('deny')
    }
    expect(approvals.calls).toEqual([])
  })

  it('★★ 作業フォルダ＝public/ でも、直下の .GIT/hooks・.Sakuraide.json は deny（毎回確認でも承認は0回）', async () => {
    for (const mode of ['auto', 'confirm'] as const) {
      expect((await run(PUBLIC, mode, 'Write', w(`${PROJECT}/.GIT/hooks/pre-commit`))).behavior).toBe('deny')
      expect((await run(PUBLIC, mode, 'Write', w(`${PROJECT}/.Sakuraide.json`))).behavior).toBe('deny')
    }
    expect(approvals.calls).toEqual([])
  })

  it('断った文には、書かれた綴りのパスが入る', async () => {
    const r = await run(PROJECT, 'auto', 'Write', w(`${PROJECT}/.GIT/hooks/pre-commit`))
    expect((r as any).message).toBe(protectedWriteMessage('.GIT/hooks/pre-commit'))
  })

  it.each(['Readme.md', 'src/Env.ts', 'Src/App.tsx', 'public/Index.html'])('普通の名前 %s は守りに巻き込まない（allow）', async (rel) => {
    expect(await run(PROJECT, 'auto', 'Write', w(`${PROJECT}/${rel}`))).toEqual({ behavior: 'allow' })
    expect(approvals.calls).toEqual([])
  })
})
