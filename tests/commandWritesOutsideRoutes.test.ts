// tests/commandWritesOutsideRoutes.test.ts — 「作業フォルダの外へ書くコマンドは、おまかせでも承認が出る」が
// 2つの経路の両方で効いていることの固定（2026-10-23・0.6.23 の2巡目）。
//
//   Claude の Bash       … src/main/claude/agent.ts の makeCanUseTool（Bash の枝）
//   さくらのAI Engine    … src/main/chat/turnRunner.ts の decideApproval（run_command）
//
// どちらも requiresConfirmation（shared/aiToolsCore.ts）→ writesOutsideWorkingDir（shared/commandGuard.ts）を通る。
// 判定そのもの（止める例・通す例）は tests/commandGuard.test.ts。ここは**配線**を、実際に呼んで見る
// （掟10: ソースの文字列を grep しない。承認 requestApproval だけを偽物にして、呼ばれた回数と文面を記録する）。

import { describe, it, expect, beforeEach, vi } from 'vitest'

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
import { decideApproval } from '../src/main/chat/turnRunner'
import { runCommandDenialMessage } from '../src/shared/approvalPlan'

const PROJECT = '/Users/someone/proj'

type Route = { name: string; run: (mode: 'auto' | 'confirm', command: string) => Promise<{ allowed: boolean }> }

const routes: Route[] = [
  {
    name: 'Claude の Bash',
    run: async (mode, command) => {
      const r = await makeCanUseTool(PROJECT, PROJECT, mode, 't-route')('Bash', { command }, {} as any)
      return { allowed: r.behavior === 'allow' }
    },
  },
  {
    name: 'AI Engine の run_command',
    run: async (mode, command) => {
      const payload: any = { turnId: 't-route', spec: { toolsProjectDir: PROJECT, turnOpts: { writeMode: mode } } }
      const denied = await decideApproval('run_command', JSON.stringify({ command }), { writeRoot: PROJECT }, payload, 't-route')
      return { allowed: denied === null }
    },
  },
]

// 検分の実測（おまかせ・偽の承認）で承認0回のまま通っていた4つ + 追記の例
const STOP = [
  'echo x >> /Users/me/.zshrc',
  'mv a ~/b',
  'ln -s ~ home',
  'ln -s /Users/me/Library link',
  'echo x >> ~/.zshrc',
  'touch ~/Library/LaunchAgents/x.plist',
  'cp a ../../x',
  'rsync -a . /tmp/y',
  'mkdir /tmp/z',
]
// 普段の作業。承認を出さない
const PASS = [
  'npm run build > /dev/null',
  'cp .env.example .env',
  'mv old.html new.html',
  'mkdir -p src/components',
  'echo hi > out.txt',
  'ls /usr/bin',
  'cat ~/.npmrc',
]

// プロジェクトの**中**を指す絶対パス（Claude は Bash で絶対パスを書くことが多い）。承認0回で通る。
// 2つの呼び出し元が projectDir（プロジェクト直下）を渡し忘れると、これらに承認が出る＝このテストが落ちる。
const INSIDE_ABSOLUTE = [
  `mkdir -p ${PROJECT}/public/css`,
  `echo x > ${PROJECT}/public/a.txt`,
  `cp a.png ${PROJECT}/public/images/`,
  `echo x > ${PROJECT}/public/../server.js`,
  `bash -c 'mkdir -p ${PROJECT}/public/css'`,
]
// プロジェクトの**外**を指す絶対パス（兄弟のフォルダ・親へ出る・別の場所）。承認が1回出る
const OUTSIDE_ABSOLUTE = [
  '/Users/someone/proj-other/public/css',
  '/Users/someone/other/public/images/',
  `${PROJECT}/../other/x`,
]

for (const route of routes) {
  describe(`${route.name}: 作業フォルダの外へ書くコマンド（おまかせ）`, () => {
    beforeEach(() => { approvals.calls.length = 0; approvals.answer = true })

    for (const cmd of STOP) {
      it(`★★ 承認が1回出る: ${cmd}`, async () => {
        await route.run('auto', cmd)
        expect(approvals.calls).toHaveLength(1)
        expect(approvals.calls[0].dir).toBe(PROJECT)
        expect(approvals.calls[0].label).toContain(`コマンド実行: ${cmd}`)
        expect(approvals.calls[0].label).toContain('理由: プロジェクトのフォルダの外に書き込みます。')
      })
    }

    it('★★ 承認の答えが no なら実行させない（yes なら通す）', async () => {
      approvals.answer = false
      expect((await route.run('auto', 'mv a ~/b')).allowed).toBe(false)
      approvals.answer = true
      expect((await route.run('auto', 'mv a ~/b')).allowed).toBe(true)
    })

    for (const cmd of PASS) {
      it(`普段の作業は承認なしで通る: ${cmd}`, async () => {
        const r = await route.run('auto', cmd)
        expect(approvals.calls).toEqual([])
        expect(r.allowed).toBe(true)
      })
    }

    for (const cmd of INSIDE_ABSOLUTE) {
      it(`★★ プロジェクトの中の絶対パスは承認0回: ${cmd}`, async () => {
        const r = await route.run('auto', cmd)
        expect(approvals.calls).toEqual([])
        expect(r.allowed).toBe(true)
      })
    }

    for (const target of OUTSIDE_ABSOLUTE) {
      for (const verb of ['mkdir -p', 'cp a.png', 'echo x >']) {
        const cmd = `${verb} ${target}`
        it(`★★ プロジェクトの外の絶対パスは承認1回: ${cmd}`, async () => {
          await route.run('auto', cmd)
          expect(approvals.calls).toHaveLength(1)
          expect(approvals.calls[0].label).toContain(`コマンド実行: ${cmd}`)
          expect(approvals.calls[0].label).toContain('理由: プロジェクトのフォルダの外に書き込みます。')
        })
      }
    }

    it('★★ 中の絶対パスと外の絶対パスを同じコマンドに書くと、承認は1回（外があるから）', async () => {
      await route.run('auto', `mkdir -p ${PROJECT}/public/css /tmp/z`)
      expect(approvals.calls).toHaveLength(1)
    })

    it('★★ ~ と $HOME は、プロジェクトの中を指していても外（承認1回）', async () => {
      await route.run('auto', 'echo x > ~/proj/a.txt')
      await route.run('auto', 'echo x > $HOME/proj/a.txt')
      expect(approvals.calls).toHaveLength(2)
    })
  })
}

describe('断った文は、これまでの run_command の断り文のまま', () => {
  beforeEach(() => { approvals.calls.length = 0; approvals.answer = false })

  it('Claude の Bash が断ると、runCommandDenialMessage の文', async () => {
    const r = await makeCanUseTool(PROJECT, PROJECT, 'auto', 't-route')('Bash', { command: 'mv a ~/b' }, {} as any)
    expect(r.behavior).toBe('deny')
    expect((r as any).message).toBe(runCommandDenialMessage(JSON.stringify({ command: 'mv a ~/b' })))
  })
})

describe('/dev/null への出力は、Claude の Bash でも拒否されない（以前は危険コマンドとして deny だった）', () => {
  beforeEach(() => { approvals.calls.length = 0; approvals.answer = true })

  it('npm run build > /dev/null は allow・承認0回', async () => {
    const r = await makeCanUseTool(PROJECT, PROJECT, 'auto', 't-route')('Bash', { command: 'npm run build > /dev/null' }, {} as any)
    expect(r).toEqual({ behavior: 'allow' })
    expect(approvals.calls).toEqual([])
  })

  it('本物のデバイスへの書き込み（> /dev/disk0）は、これまでどおり deny', async () => {
    const r = await makeCanUseTool(PROJECT, PROJECT, 'auto', 't-route')('Bash', { command: 'echo x > /dev/disk0' }, {} as any)
    expect(r.behavior).toBe('deny')
    expect(approvals.calls).toEqual([])
  })
})
