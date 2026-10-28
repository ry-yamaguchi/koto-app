import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { trashFs, renameFs, trashCheckFs, trashProjectFs, FS_TRASH_MESSAGES, verdictOf } from '../src/main/ipc/fsTrash'
import { NOT_CONFIRMED_MESSAGE } from '../src/main/cloud/teardownShell'
import { withProjectLock } from '../src/main/projectLock'
import { resetProjectOpsForTests } from '../src/main/projectOps'

// ── T-E2・T-E3: ファイル一覧のゴミ箱・名前の変更と、プロジェクトのフォルダのゴミ箱を、実フォルダ（一時のホーム）で駆動する（0.6.24 E-2）──────────
// 守るもの: 記録（.sakura-cloud・.sakuraide.json ほか）・プロジェクトのフォルダ・中にプロジェクトがあるフォルダ・調べられない（chmod 000）ものは、
// ゴミ箱へ送らない・名前を変えない。**断った回は `trashItem` が0回で、ディスクは1つも変わらない**（偽の `trashItem` の呼ばれた一覧と、フォルダの全中身の写しで見る）。
// ふつうのファイル・フォルダは、1回だけ送る（止めすぎない）。プロジェクトの削除の口（`trashProjectFs`）は、確認の印・走っている操作・専有型の残りを順に確かめる。
// 断り方の違いごとの文は、画面にそのまま出る（仕様 E-5）。ここで文を書き下して固定する。

let home = ''
let trashed: string[] = []
const deps = () => ({ home, trashItem: async (p: string) => { trashed.push(p) } })

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-fstrash-'))
  trashed = []
})
afterEach(() => {
  resetProjectOpsForTests()
  const unlock = (d: string) => { try { fs.chmodSync(d, 0o755); for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) unlock(path.join(d, e.name)) } catch { /* 無い・読めない */ } }
  unlock(home)
  fs.rmSync(home, { recursive: true, force: true })
})

const at = (...rel: string[]) => path.join(home, ...rel)
function put(rel: string, content: unknown = 'x'): string {
  const full = at(rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content))
  return full
}
/** フォルダの全中身の写し（名前・種類・中身）。断った回に、これが変わらないことを見る。 */
function tree(dir = home): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const full = path.join(d, e.name)
      if (e.isDirectory()) { out.push(`${r}/`); try { walk(full, r) } catch { out.push(`${r}/(読めない)`) } }
      else out.push(`${r}=${fs.readFileSync(full, 'utf-8')}`)
    }
  }
  walk(dir, '')
  return out
}
/** プロジェクトの根（`.sakuraide.json` と、あれば記録）を作る。 */
function project(rel: string, meta: unknown = { name: 'p' }): string {
  put(`${rel}/.sakuraide.json`, meta)
  put(`${rel}/index.html`, '<p>hi</p>')
  return at(rel)
}
const lock = (dir: string) => {
  let open!: () => void
  const gate = new Promise<void>(r => { open = r })
  const holder = withProjectLock(dir, '公開', () => gate, { target: 'sakura-apprun-dedicated', handler: 'test:hold' })
  return { release: async () => { open(); await holder } }
}

const REFUSED_DISK_UNCHANGED = async (act: () => unknown | Promise<unknown>) => {
  const before = tree()
  let threw: unknown = null
  try { await act() } catch (e) { threw = e }
  expect(trashed).toEqual([]) // ゴミ箱へ送っていない
  expect(tree()).toEqual(before) // ディスクは1つも変わらない
  return threw as Error | null
}

describe('★★★ T-E2 記録: ゴミ箱へ送らない・名前を変えない（深さ2以上の記録も）', () => {
  const RECORDS = [
    'SAKURAIDE/p/.sakura-cloud', 'SAKURAIDE/p/.sakura-cloud/state.json', 'SAKURAIDE/p/.sakura-cloud/env.json',
    'SAKURAIDE/p/.sakuraide.json', 'SAKURAIDE/p/.sakuraide', 'SAKURAIDE/p/.sakuraide/chat.json',
    'SAKURAIDE/p/.sakuraide-backup', 'SAKURAIDE/p/.sakuraide-backup/1/a',
  ]
  beforeEach(() => {
    project('SAKURAIDE/p')
    put('SAKURAIDE/p/.sakura-cloud/state.json', {}); put('SAKURAIDE/p/.sakura-cloud/env.json', {})
    put('SAKURAIDE/p/.sakuraide/chat.json', '[]'); put('SAKURAIDE/p/.sakuraide-backup/1/a', 'a')
  })

  for (const rel of RECORDS) {
    it(`${rel}: fs:trash は記録の文で断り、trashItem 0・ディスクは変わらない`, async () => {
      const e = await REFUSED_DISK_UNCHANGED(() => trashFs(at(rel), deps()))
      expect(e?.message).toBe(FS_TRASH_MESSAGES.record)
      expect(FS_TRASH_MESSAGES.record).toBe('Koto の記録のファイルなので、ここからは削除できません。')
    })
    it(`${rel}: fs:rename も断り、ディスクは変わらない`, async () => {
      const e = await REFUSED_DISK_UNCHANGED(() => renameFs(at(rel), 'renamed'))
      expect(e?.message).toBe('Koto の記録のファイルなので、名前を変えられません。')
    })
  }

  it('大文字小文字を区別しない（macOS の既定は区別しない。`.SAKURA-CLOUD` も同じ実体）', async () => {
    for (const name of ['.SAKURA-CLOUD', '.Sakuraide.json', '.SAKURAIDE-BACKUP']) {
      const e = await REFUSED_DISK_UNCHANGED(() => trashFs(at('SAKURAIDE/p', name, 'x'), deps()))
      expect(e?.message, name).toBe(FS_TRASH_MESSAGES.record)
      const r = await REFUSED_DISK_UNCHANGED(() => renameFs(at('SAKURAIDE/p', name), 'renamed'))
      expect(r?.message, name).toBe(FS_TRASH_MESSAGES.renameRecord)
    }
  })

  it('★★ 新しい名前が記録の名前でも断る（ふつうのファイルを `.sakuraide.json` へ改名して、記録を作らせない）', async () => {
    put('SAKURAIDE/p/note.txt', 'メモ')
    for (const name of ['.sakuraide.json', '.SAKURAIDE.JSON', '.sakura-cloud', '.sakuraide', '.sakuraide-backup']) {
      const e = await REFUSED_DISK_UNCHANGED(() => renameFs(at('SAKURAIDE/p/note.txt'), name))
      expect(e?.message, name).toBe(FS_TRASH_MESSAGES.renameRecord)
    }
  })
})

describe('★★★ T-E2 プロジェクトの根・中にプロジェクトがあるフォルダ・調べられないもの', () => {
  it('★★★ プロジェクトの根（.sakuraide.json か .sakura-cloud/ が直下にある）→ fs:trash は最後の砦の文で断る。rename は根の文', async () => {
    project('SAKURAIDE/with-meta')
    put('SAKURAIDE/only-cloud/.sakura-cloud/env.json', {}); put('SAKURAIDE/only-cloud/index.html', 'x')
    for (const rel of ['SAKURAIDE/with-meta', 'SAKURAIDE/only-cloud']) {
      const e = await REFUSED_DISK_UNCHANGED(() => trashFs(at(rel), deps()))
      expect(e?.message, rel).toBe('プロジェクトのフォルダは、プロジェクトの 🗑 から削除してください。')
      const r = await REFUSED_DISK_UNCHANGED(() => renameFs(at(rel), 'renamed'))
      expect(r?.message, rel).toBe('プロジェクトのフォルダの名前は変えられません。')
    }
  })

  it('★★★ 作業場所（直下の子のどれかがプロジェクト）→ 断る。rename も断る', async () => {
    project('Documents/koto/myapp')
    put('Documents/koto/plain/a.txt', 'a')
    const e = await REFUSED_DISK_UNCHANGED(() => trashFs(at('Documents/koto'), deps()))
    expect(e?.message).toBe('中にプロジェクトがあるフォルダは、まとめて削除できません。プロジェクトごとに削除してください。')
    const r = await REFUSED_DISK_UNCHANGED(() => renameFs(at('Documents/koto'), 'renamed'))
    expect(r?.message).toBe('中にプロジェクトがあるフォルダは、名前を変えられません。')
  })

  it('作業場所の子の1つが読めなくても、ほかの子がプロジェクトなら「中にプロジェクトがある」と言う（調べられないより具体的）', async () => {
    project('Documents/koto/myapp')
    put('Documents/koto/locked/a.txt', 'a'); fs.chmodSync(at('Documents/koto/locked'), 0o000)
    const e = await REFUSED_DISK_UNCHANGED(() => trashFs(at('Documents/koto'), deps()))
    expect(e?.message).toBe(FS_TRASH_MESSAGES.workspace)
  })

  it('★★★ 読めない子（chmod 000）→ 調べられないので断る（ふつうのものと読んで通さない）。rename も断る', async () => {
    put('SAKURAIDE/locked/a.txt', 'a'); fs.chmodSync(at('SAKURAIDE/locked'), 0o000)
    const e = await REFUSED_DISK_UNCHANGED(() => trashFs(at('SAKURAIDE/locked'), deps()))
    expect(e?.message).toBe('フォルダの中を確かめられないため、削除していません。')
    const r = await REFUSED_DISK_UNCHANGED(() => renameFs(at('SAKURAIDE/locked'), 'renamed'))
    expect(r?.message).toBe('フォルダの中を確かめられないため、名前を変えていません。')
  })

  it('★★★ 中身の一覧だけが読めない（-wx。直下の記録の有無は引ける）フォルダ → 子を調べられないので断る（ふつうのものと読まない）', async () => {
    put('SAKURAIDE/blind/a/1.txt', '1')
    fs.chmodSync(at('SAKURAIDE/blind'), 0o300)
    const e = await REFUSED_DISK_UNCHANGED(() => trashFs(at('SAKURAIDE/blind'), deps()))
    expect(e?.message).toBe(FS_TRASH_MESSAGES.unknown)
    const r = await REFUSED_DISK_UNCHANGED(() => renameFs(at('SAKURAIDE/blind'), 'renamed'))
    expect(r?.message).toBe(FS_TRASH_MESSAGES.renameUnknown)
    expect(verdictOf(at('SAKURAIDE/blind'))).toBe('unknown')
  })

  it('★★★ 中に読めないフォルダがあり、プロジェクトが1つも見つからない → 調べられないので断る', async () => {
    put('SAKURAIDE/box/ok/a.txt', 'a'); put('SAKURAIDE/box/locked/a.txt', 'a')
    fs.chmodSync(at('SAKURAIDE/box/locked'), 0o000)
    const e = await REFUSED_DISK_UNCHANGED(() => trashFs(at('SAKURAIDE/box'), deps()))
    expect(e?.message).toBe(FS_TRASH_MESSAGES.unknown)
    expect(verdictOf(at('SAKURAIDE/box'))).toBe('unknown')
  })

  it('ホームの深さの守り（canTrash）は今までどおり。ホームの外・ホーム直下・空・相対・文字列でないものは、記録でなくても断る', async () => {
    put('Library/x.txt', 'x'); put('SAKURAIDE/p/a.txt', 'a')
    for (const p of [path.dirname(home), home, at('Library'), '', 'SAKURAIDE/p/a.txt', undefined, 42 as unknown]) {
      const e = await REFUSED_DISK_UNCHANGED(() => trashFs(p, deps()))
      expect(e, String(p)).toBeInstanceOf(Error)
    }
  })
})

describe('T-E2 ふつうのものは1回だけ送る・名前を変える（止めすぎない）', () => {
  it('ふつうのファイル・フォルダ・.env・.koto-data（記録の名前ではない）→ trashItem が1回ずつ', async () => {
    project('SAKURAIDE/p')
    const files = [put('SAKURAIDE/p/public/index.html'), put('SAKURAIDE/p/.env', 'KEY=1'), put('SAKURAIDE/p/.koto-data/x', '{}')]
    put('SAKURAIDE/p/images/a.png', 'png')
    for (const f of [...files, at('SAKURAIDE/p/images'), at('SAKURAIDE/p/.koto-data')]) await trashFs(f, deps())
    expect(trashed).toEqual([...files, at('SAKURAIDE/p/images'), at('SAKURAIDE/p/.koto-data')])
  })

  it('中にフォルダが並ぶだけの（プロジェクトが入っていない）フォルダも送れる', async () => {
    put('SAKURAIDE/p/a/1.txt', '1'); put('SAKURAIDE/p/b/2.txt', '2')
    await trashFs(at('SAKURAIDE/p'), deps())
    expect(trashed).toEqual([at('SAKURAIDE/p')])
  })

  it('ふつうのファイル・フォルダの名前は変えられる（新しい場所を返す・ディスクが変わる）', () => {
    put('SAKURAIDE/p/a.txt', 'a'); put('SAKURAIDE/p/dir/b.txt', 'b')
    expect(renameFs(at('SAKURAIDE/p/a.txt'), 'c.txt')).toBe(at('SAKURAIDE/p/c.txt'))
    expect(renameFs(at('SAKURAIDE/p/dir'), 'dir2')).toBe(at('SAKURAIDE/p/dir2'))
    expect(tree(at('SAKURAIDE/p'))).toEqual(['c.txt=a', 'dir2/', 'dir2/b.txt=b'])
  })

  it('今までの断り（不正な名前・同名がある）は変わらない', async () => {
    put('SAKURAIDE/p/a.txt', 'a'); put('SAKURAIDE/p/b.txt', 'b')
    for (const bad of ['', 'x/y', '..', 'a/../b', undefined as unknown as string]) {
      const e = await REFUSED_DISK_UNCHANGED(() => renameFs(at('SAKURAIDE/p/a.txt'), bad))
      expect(e?.message, String(bad)).toBe('不正なファイル名です')
    }
    const dup = await REFUSED_DISK_UNCHANGED(() => renameFs(at('SAKURAIDE/p/a.txt'), 'b.txt'))
    expect(dup?.message).toBe('同名のファイルが既に存在します')
  })
})

describe('★★ T-E2 fs:trashCheck は fs:trash と同じ判断を、何も動かさずに答える', () => {
  it('種類ごとの答え（ok・denied・record・project・workspace・unknown）と、fs:trash が通るかが一致する', async () => {
    project('SAKURAIDE/root'); put('SAKURAIDE/root/.sakura-cloud/state.json', '{}'); put('SAKURAIDE/root/pub/a.html', 'a')
    project('Documents/koto/myapp'); put('SAKURAIDE/lk/a.txt', 'a'); fs.chmodSync(at('SAKURAIDE/lk'), 0o000)
    const cases: Array<[string, string, string | null]> = [
      ['ふつうのファイル', at('SAKURAIDE/root/pub/a.html'), null],
      ['記録', at('SAKURAIDE/root/.sakura-cloud/state.json'), 'record'],
      ['プロジェクトの根', at('SAKURAIDE/root'), 'project'],
      ['作業場所', at('Documents/koto'), 'workspace'],
      ['読めない', at('SAKURAIDE/lk'), 'unknown'],
      ['ホーム直下', at('Library'), 'denied'],
      ['ホームの外', path.dirname(home), 'denied'],
    ]
    const before = tree()
    for (const [name, p, kind] of cases) {
      const check = trashCheckFs(p, { home })
      if (kind === null) expect(check, name).toEqual({ ok: true })
      else {
        expect(check.ok, name).toBe(false)
        if (!check.ok) { expect(check.kind, name).toBe(kind); expect(check.message, name).not.toBe('') }
      }
      const moved = trashed.length
      const act = await trashFs(p, deps()).then(() => true, (e: Error) => { expect(e.message, name).toBe((check as { message: string }).message); return false })
      expect(act, name).toBe(check.ok) // trashCheck が ok のときだけ fs:trash も通る
      expect(trashed.length - moved, name).toBe(check.ok ? 1 : 0)
    }
    expect(tree()).toEqual(before) // trashCheck は読むだけ。偽の trashItem も動かさない
  })
})

describe('★★★ T-E3 fs:trashProject: 確認の印が無ければ移さない', () => {
  it('確認の印が無い（未指定・null・{}・false・\'true\'・1）→ ok:false・trashItem 0・ディスクは変わらない（確認を無視しない）', async () => {
    const dir = project('SAKURAIDE/p')
    for (const opts of [undefined, null, {}, { confirmed: false }, { confirmed: 'true' }, { confirmed: 1 }, 'confirmed']) {
      const before = tree()
      const r = await trashProjectFs(dir, opts, deps())
      expect(r, JSON.stringify(opts)).toEqual({ ok: false, message: NOT_CONFIRMED_MESSAGE })
      expect(trashed).toEqual([])
      expect(tree()).toEqual(before)
    }
  })

  it('確認の印があり・ふつうのプロジェクト → 1回だけ移して ok（プロジェクトの根は、ここだけが移せる）', async () => {
    const dir = project('SAKURAIDE/p', { name: 'p', publish: { hanamii: { projectId: 'prj-1' }, targets: { hanamii: { publishedAt: null } } } })
    expect(await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, deps())).toEqual({ ok: true })
    expect(trashed).toEqual([dir])
  })

  it('.sakuraide.json の無いふつうのフォルダ（記録なしで開いたもの）も移せる', async () => {
    put('SAKURAIDE/plain/a.txt', 'a')
    expect(await trashProjectFs(at('SAKURAIDE/plain'), { confirmed: true, skippedForTwins: [] }, deps())).toEqual({ ok: true })
    expect(trashed).toEqual([at('SAKURAIDE/plain')])
  })

  it('★★ 記録・作業場所・読めないもの・ホームの深さに合わない場所 → 確認の印があっても移さない', async () => {
    project('Documents/koto/myapp'); put('SAKURAIDE/lk/a.txt', 'a'); fs.chmodSync(at('SAKURAIDE/lk'), 0o000)
    put('SAKURAIDE/p/.sakura-cloud/state.json', '{}'); put('Library/x.txt', 'x')
    const cases: Array<[string, string, string]> = [
      ['記録', at('SAKURAIDE/p/.sakura-cloud'), FS_TRASH_MESSAGES.record],
      ['作業場所', at('Documents/koto'), FS_TRASH_MESSAGES.workspace],
      ['読めない', at('SAKURAIDE/lk'), FS_TRASH_MESSAGES.unknown],
      ['ホーム直下', at('Library'), 'ホームフォルダの直下は、まとめてゴミ箱へ送れません（中のファイルやプロジェクトを選んでください）'],
      ['ホームの外', path.dirname(home), 'ゴミ箱へ送れるのは、ホームフォルダの中のものだけです'],
      ['空', '', FS_TRASH_MESSAGES.noPlace],
    ]
    for (const [name, p, message] of cases) {
      const before = tree()
      expect(await trashProjectFs(p, { confirmed: true, skippedForTwins: [] }, deps()), name).toEqual({ ok: false, message })
      expect(tree(), name).toEqual(before)
    }
    expect(trashed).toEqual([])
  })

  it('★★★ このプロジェクトで処理が走っている → 移さない。終わったら移せる', async () => {
    const dir = project('SAKURAIDE/p')
    const held = lock(dir)
    expect(await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, deps())).toEqual({ ok: false, message: 'このプロジェクトで処理が進んでいます。終わってから、もう一度削除してください。' })
    expect(trashed).toEqual([])
    await held.release()
    expect(await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, deps())).toEqual({ ok: true })
    expect(trashed).toEqual([dir])
  })

  it('別のプロジェクトで処理が走っていても、このプロジェクトは移せる（鍵は別々）', async () => {
    const dir = project('SAKURAIDE/p'); const other = project('SAKURAIDE/q')
    const held = lock(other)
    expect(await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, deps())).toEqual({ ok: true })
    await held.release()
  })

  describe('★★★ 専有型のリソースが残っている回は移さない（月額が止まらない）。同じ記録の複製があれば移せる', () => {
    const DEDICATED_MESSAGE = 'さくらのAppRun 専有型のリソースが残っているため、フォルダを移していません。'
    const FIELDS = ['applicationID', 'clusterID', 'loadBalancerID', 'asgID', 'storageLeftoverBucket'] as const
    const dedicated = (rec: Record<string, unknown>) => ({ name: 'p', publish: { apprunDedicated: rec } })

    for (const f of FIELDS) {
      it(`${f} が残っていて複製が無い → 移さない（trashItem 0・ディスクは変わらない）`, async () => {
        const dir = project('SAKURAIDE/p', dedicated({ [f]: 'x-1' }))
        const before = tree()
        expect(await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, deps())).toEqual({ ok: false, message: DEDICATED_MESSAGE })
        expect(trashed).toEqual([])
        expect(tree()).toEqual(before)
      })
    }

    it('同じ clusterID を持つ複製が同じ親フォルダにある → 移せる（複製からは破棄を断るので、複製を消せる道を残す）', async () => {
      const dir = project('SAKURAIDE/p', dedicated({ clusterID: 'c-1', asgID: 'a-1' }))
      project('SAKURAIDE/p copy', dedicated({ clusterID: 'c-1', asgID: 'a-1' }))
      // 画面が複製のために専有型を外した（skippedForTwins）と言い、覆う複製がいまもあるときだけ通る（R2-e。外したと言わなければ、複製がいても断る）
      expect(await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, deps())).toEqual({ ok: false, message: DEDICATED_MESSAGE })
      expect(trashed).toEqual([])
      expect(await trashProjectFs(dir, { confirmed: true, skippedForTwins: ['sakura-apprun-dedicated'] }, deps())).toEqual({ ok: true })
      expect(trashed).toEqual([dir])
    })

    it('★★ 別の記録（別の clusterID）の兄弟しかいない → 複製ではないので移さない（兄弟がいるだけでは通さない）', async () => {
      const dir = project('SAKURAIDE/p', dedicated({ clusterID: 'c-1' }))
      project('SAKURAIDE/other', dedicated({ clusterID: 'c-2' }))
      expect(await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, deps())).toEqual({ ok: false, message: DEDICATED_MESSAGE })
      expect(trashed).toEqual([])
    })

    it('★★ 保存場所だけが残った記録（ID が無い）は、複製の識別子が無いので、兄弟がいても移さない', async () => {
      const dir = project('SAKURAIDE/p', dedicated({ storageLeftoverBucket: 'b1' }))
      project('SAKURAIDE/p copy', dedicated({ storageLeftoverBucket: 'b1' }))
      expect(await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, deps())).toEqual({ ok: false, message: DEDICATED_MESSAGE })
      expect(trashed).toEqual([])
    })

    it('専有型の資源が空（作ってない・破棄が済んだ）・HANAMII だけ・共用型だけ → 止めない（保存場所などの残りでは止めない）', async () => {
      for (const [name, meta] of [
        ['空', dedicated({ clusterID: null, applicationID: '' })],
        ['HANAMII', { publish: { hanamii: { projectId: 'prj-1' } } }],
        ['記録なし', {}],
      ] as const) {
        const dir = project(`SAKURAIDE/${name}`, meta)
        expect(await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, deps()), name).toEqual({ ok: true })
      }
      expect(trashed.length).toBe(3)
    })
  })

  it('ゴミ箱へ送る口が失敗したら ok:false と原因の文を返す（投げない。画面が「移せませんでした」として受ける）', async () => {
    const dir = project('SAKURAIDE/p')
    const r = await trashProjectFs(dir, { confirmed: true, skippedForTwins: [] }, { home, trashItem: async () => { throw new Error('ゴミ箱を開けません') } })
    expect(r).toEqual({ ok: false, message: 'ゴミ箱を開けません' })
  })
})
