import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import React from 'react'
import { failureDetailOf, failureText } from '../src/shared/failureText'
import { failureCopyText } from '../src/shared/failureDetail'
import { maskHomePath } from '../src/shared/homePath'
import AppRunPrereqChecklist from '../src/renderer/components/AppRunPrereqChecklist'
import CopyButton from '../src/renderer/components/CopyButton'

// 検分の指摘で足した守り: コピーに版と日時が入ること・詳細を伏せる順・描き口の配線。
// DOM は使わない。フックの無い部品は関数として直接呼び、返った木から CopyButton の getText を取り出して呼ぶ。

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf-8')
const once = (src: string, shape: string) => expect(src.split(shape).length - 1, shape).toBe(1)

function findAll(node: any, pred: (el: any) => boolean, out: any[] = []): any[] {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach(n => findAll(n, pred, out)); return out }
  if (pred(node)) out.push(node)
  findAll(node.props?.children, pred, out)
  return out
}

function stubWindow(getVersion: () => Promise<string>) {
  ;(globalThis as any).window = { electronAPI: { app: { getVersion } } }
}
afterEach(() => { delete (globalThis as any).window; vi.resetModules() })

describe('failureCopyNow: 版が聞けなかったときは覚えず、聞き直す', () => {
  it('1回目に getVersion が失敗しても、2回目のコピーには版が入る', async () => {
    let n = 0
    stubWindow(async () => { n++; if (n === 1) throw new Error('preload not ready'); return '0.6.26' })
    const { failureCopyNow } = await import('../src/renderer/failureCopy')
    expect(await failureCopyNow('文')).toContain('Koto 不明・')
    expect(await failureCopyNow('文')).toContain('Koto 0.6.26・')
    // 聞けたあとは聞き直さない
    await failureCopyNow('文')
    expect(n).toBe(2)
  })
})

describe('AppRunPrereqChecklist: 登録の知らせのコピー', () => {
  const props = { prereqs: null, onOpenCredentials: () => {}, onAutoCreateRegistry: () => {}, regCreating: false, keyReady: true }
  const copyOf = (regNotice: string, regNoticeFailed?: boolean) => {
    const tree = (AppRunPrereqChecklist as any)({ ...props, regNotice, regNoticeFailed })
    return findAll(tree, el => el.type === CopyButton)[0]?.props
  }

  it('失敗の知らせのコピーには、文・詳細・Koto の版・日時が入る', async () => {
    stubWindow(async () => '0.6.26')
    const p = copyOf('自動作成に失敗しました: 接続できません\n詳細: getaddrinfo ENOTFOUND h.example', true)
    const text = await p.getText()
    expect(text).toContain('詳細: getaddrinfo ENOTFOUND h.example')
    expect(text).toMatch(/\nKoto 0\.6\.26・\d{4}-\d\d-\d\d \d\d:\d\d$/)
  })

  it('成功の知らせは、そのまま写す（版と日時を付けない）', () => {
    const p = copyOf('作成しました: reg.example（認証情報に保存済み）', false)
    expect(p.getText).toBeUndefined()
    expect(p.text).toBe('作成しました: reg.example（認証情報に保存済み）')
  })
})

describe('コピーの配線（当て先は一意。直す前の形を禁じる）', () => {
  it('SecurityCheckSection: 実施できなかった結果だけ failureCopyNow を通す', () => {
    const src = read('renderer/components/SecurityCheckSection.tsx')
    once(src, "getText={result.verdict === 'skip' && !aborted ? () => failureCopyNow(result.report) : undefined}")
    // 折りたたみの「問題なし」の側は従来どおり（スタンプを付けない）
    once(src, '<CopyButton text={result.report} title="チェック結果をコピー" />')
  })

  it('AppRunPanel: 公開の結果のコピーは失敗のときだけ版・日時を付け、伏せる', () => {
    const src = read('renderer/components/AppRunPanel.tsx')
    once(src, 'getText={result.ok ? undefined : getCopyText}')
    once(src, 'maskForCopy([result.message ? await failureCopyNow(result.message) : \'\'')
    once(src, 'regNoticeFailed={regNoticeFailed}')
    expect(src).not.toContain('navigator.clipboard.writeText(copyText)')
  })

  it('HanamiiPanel・VercelPanel: 失敗のコピーは failureCopyNow を通し、応答の詳細も伏せる', () => {
    const h = read('renderer/components/HanamiiPanel.tsx')
    once(h, 'const head = ok ? msg : await failureCopyNow(msg)')
    once(h, 'return maskForCopy(detail ? `${head}\\n${detail}` : head)')
    const v = read('renderer/components/VercelPanel.tsx')
    once(v, 'const head = await failureCopyNow(msg)')
    once(v, 'return maskForCopy(detail ? `${head}\\n${detail}` : head)')
  })

  it('TeardownResultView・DedicatedOpsParts: 失敗のコピーは failureCopyNow を通す', () => {
    for (const f of ['renderer/components/teardown/TeardownResultView.tsx', 'renderer/components/DedicatedOpsParts.tsx']) {
      const src = read(f)
      once(src, 'failureCopyNow(msg).then(t => navigator.clipboard.writeText(t))')
    }
  })
})

describe('描き口: 詳細の行を出す FailureLines の数（{x} へ戻すと数が減って落ちる）', () => {
  const table: Array<[string, number]> = [
    ['KnowledgeModal', 4], ['KnowledgePacksTab', 1], ['StorageNotice', 4], ['PublishedListModal', 1],
    ['RollbackSection', 2], ['ServerFilesModal', 1], ['CredentialsModal', 4], ['AppRunPanel', 6],
    ['VercelPanel', 3], ['HanamiiPanel', 3], ['SettingsModal', 2], ['HistoryModal', 2], ['UnusedFilesSection', 1], ['AppRunPrereqChecklist', 1],
    ['TelemetryNotice', 2], ['StorageSettings', 2],
  ]
  for (const [name, n] of table) {
    it(`${name}: <FailureLines> が ${n} か所`, () => {
      const src = read(`renderer/components/${name}.tsx`)
      expect(src.split('<FailureLines text=').length - 1).toBe(n)
    })
  }

  it('当て先の式（直した画面ごと）', () => {
    const k = read('renderer/components/KnowledgeModal.tsx')
    once(k, '<FailureLines text={uploadNotice} />')
    once(k, '<FailureLines text={listError} />')
    once(read('renderer/components/KnowledgePacksTab.tsx'), '<FailureLines text={r.error} />')
    once(read('renderer/components/StorageNotice.tsx'), '<FailureLines text={leftoverNote} />')
    once(read('renderer/components/PublishedListModal.tsx'), '<FailureLines text={error} />')
    once(read('renderer/components/ServerFilesModal.tsx'), '<FailureLines text={notice} />')
    const r = read('renderer/components/RollbackSection.tsx')
    once(r, '⚠️ <FailureLines text={error} />')
    once(r, '<FailureLines text={actionMsg} />')
    once(read('renderer/components/HanamiiPanel.tsx'), '<FailureLines text={msg} />')
    once(read('renderer/components/SettingsModal.tsx'), '<FailureLines text={updateStatusText(update) ||')
    const a = read('renderer/components/AppRunPanel.tsx')
    once(a, '<FailureLines text={result.message} />')
    once(a, '<FailureLines text={regNotice} />')
  })
})

describe('failureDetailOf: 伏せる順と、伏せられない形', () => {
  it('★ 伏せてから 240 文字で切る（切れ目にかかった鍵の前半を残さない）', () => {
    const e = Object.assign(new Error('connect ETIMEDOUT ' + 'x'.repeat(195) + ' key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'), { code: 'ETIMEDOUT' })
    const d = failureDetailOf(e)
    expect(d).not.toContain('sk-ant-api03-abc')
    expect(d).toContain('***')
  })

  it('★ 行頭を前提にする形（ENV・SetEnv）は、改行をまとめる前に伏せる', () => {
    const e = Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443\nENV DB_PASSWORD hunter2hunter2\nSetEnv API_SECRET abcdefgh12345678'), { code: 'ETIMEDOUT' })
    const d = failureDetailOf(e)
    expect(d).not.toContain('hunter2hunter2')
    expect(d).not.toContain('abcdefgh12345678')
    const copy = failureCopyText(failureText(e), { version: '1', at: new Date() })
    expect(copy).not.toContain('hunter2hunter2')
  })

  it('★ URL のクエリ（署名・Azure の sig・X-Amz-Signature）は詳細に出ない', () => {
    for (const q of [
      'signature=abcdef1234567890XYZabcdef',
      'sig=abcdef1234567890XYZabcdef&se=2026',
      'X-Amz-SignedHeaders=host&X-Amz-Signature=' + '0123456789abcdef'.repeat(4),
    ]) {
      const e = Object.assign(new Error(`Cannot download "https://example.com/a/b.zip?${q}"`), { code: 'ENOTFOUND' })
      const d = failureDetailOf(e)
      expect(d, q).toContain('https://example.com/a/b.zip?…')
      expect(d, q).not.toContain('abcdef1234567890XYZabcdef')
      expect(d, q).not.toContain('0123456789abcdef')
    }
  })

  it('クエリの無い URL・原因を見分ける部分（ホスト・パス）は残る', () => {
    const d = failureDetailOf(Object.assign(new Error('getaddrinfo ENOTFOUND api.ai.sakura.ad.jp https://api.ai.sakura.ad.jp/v1/x'), { code: 'ENOTFOUND' }))
    expect(d).toContain('https://api.ai.sakura.ad.jp/v1/x')
  })
})

describe('maskHomePath: 共有フォルダは利用者名ではない', () => {
  it('/Users/Shared は残し、/Users/<名前> は ~ にする', () => {
    expect(maskHomePath("open '/Users/Shared/koto/data.json'")).toBe("open '/Users/Shared/koto/data.json'")
    expect(maskHomePath('/Users/Shared')).toBe('/Users/Shared')
    expect(maskHomePath("open '/Users/alice/koto/data.json'")).toBe("open '~/koto/data.json'")
    // 名前が Shared で始まるだけの利用者は伏せる
    expect(maskHomePath('/Users/SharedBob/x')).toBe('~/x')
  })

  it('failureText の詳細にも共有フォルダが残る', () => {
    const e = Object.assign(new Error("EACCES: permission denied, open '/Users/Shared/koto/data.json'"), { code: 'EACCES' })
    expect(splitDetail(failureText(e))).toContain('/Users/Shared/koto/data.json')
  })
})
function splitDetail(s: string): string { return s.split('\n詳細: ')[1] ?? '' }

describe('installDependencies: npm の失敗は固定文の下に原文を残す', () => {
  it('npm ERR! の行が詳細に出る（警告の行ではなく）', async () => {
    vi.resetModules()
    vi.doMock('child_process', () => ({
      execFile: (cmd: string, args: string[], optsOrCb: any, cb?: any) => {
        const done = cb ?? optsOrCb
        if (args.includes('--version')) return done(null, '10.0.0', '')
        return done(new Error('exit 1'), '', 'npm WARN deprecated foo@1\nnpm ERR! code ENOTFOUND\nnpm ERR! network request to https://registry.npmjs.org/zzz failed\nnpm ERR! A complete log of this run can be found in: /x/y.log\n')
      },
    }))
    vi.doMock('../src/main/loginPath', () => ({ awaitLoginPath: async () => {}, loginPathHintForMissingTool: () => '' }))
    const { installDependencies } = await import('../src/main/cloud/npmInstall')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-npmfail-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"zzz":"1"}}')
      const r = await installDependencies(dir)
      expect(r.ok).toBe(false)
      const [sentence, detail] = (r.message ?? '').split('\n詳細: ')
      // 回線断は回線の文が見出し（package.json の書き間違いと言わない）。原文は詳細に残る
      expect(sentence).toContain('インターネットに接続できませんでした')
      expect(sentence).not.toContain('package.json')
      expect(r.diagnosed).toBe(true)
      expect(detail).toContain('code ENOTFOUND')
      expect(detail).toContain('registry.npmjs.org')
      expect(detail).not.toContain('deprecated')
      expect(detail).not.toContain('complete log')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      vi.doUnmock('child_process')
      vi.doUnmock('../src/main/loginPath')
    }
  })
})
