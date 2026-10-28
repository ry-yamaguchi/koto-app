import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isSameDirFs, bucketUsersFromRecords } from '../src/main/cloud/bucketUsers'
import { recordTwinsFs } from '../src/main/cloud/recordTwins'
import { otherProjectsUsingRegistry } from '../src/main/cloud/registryUsers'
import { trashProjectFs, FS_TRASH_MESSAGES } from '../src/main/ipc/fsTrash'
import { withProjectLock, runningOpEntryAt } from '../src/main/projectLock'
import { resetProjectOpsForTests } from '../src/main/projectOps'

// ── 0.6.24 R2-b: 「自分」をパスの文字列でなく、実体（dev・ino）で比べる ──────────────────────────────────────────────
// 検分で実測: 自分を指すシンボリックリンク・大文字小文字だけ違うパス（APFS は既定で区別しない）・NFC/NFD の違いで、
//   ・recordTwins（I-2・I-3）… 自分を「複製」と数える。I-3 は専有型の止めが画面と main の両方で外れ、フォルダが移る。I-2 は自分の名前を挙げて断り続ける
//   ・bucketUsers … 自分を「使用者」「同じ prefix」と数える
//   ・registryUsers … 自分を「レジストリの使用者」と数える
//   ・fs:trashProject の「走っている操作」の確かめ … 大文字小文字違い・リンク経由のパスで素通りする
// 4つとも同じ `isSameDirFs`（bucketUsers.ts）を通る。変異: 3か所それぞれを文字列の比較だけに戻す／走っている操作の比べ方を文字列だけに戻す。
// 大文字小文字・NFC/NFD は、その試験を作る場所の FS が区別しないときだけ走る（区別する FS では、同じ関数をリンクの試験が見る）。

let ws = ''
let self = ''
beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-r2b-')))
  self = path.join(ws, 'myapp')
  fs.mkdirSync(self)
})
afterEach(() => {
  resetProjectOpsForTests()
  fs.rmSync(ws, { recursive: true, force: true })
})

const put = (file: string, v: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v))
}
const HANAMII_META = { publish: { hanamii: { projectId: 'p-1' }, targets: { hanamii: { publishedAt: '2026-10-19T00:00:00.000Z' } } } }
const DEDICATED_META = { publish: { apprunDedicated: { applicationID: 'app-1', clusterID: 'c-1', loadBalancerID: 'lb-1', asgID: 'asg-1' } } }
const BUCKET_ENV = { persistence: { objectStorage: [{ bucket: 'koto-data-x', prefix: 'projects/myapp/', consentedAt: '2026-10-01T00:00:00Z' }] } }
const BUCKET_STATE = (registry?: string) => ({
  name: 'myapp', backend: 'apprun',
  resources: [{ kind: 'apprun-app', id: 'a-1', key: 'apprun-app:myapp', stateful: false }, { kind: 'bucket', id: 'koto-data-x', prefix: 'projects/myapp/' }],
  ...(registry ? { meta: { registryName: registry } } : {}),
})
/** 自分の記録（公開・保存場所・レジストリ）を置く。 */
function writeSelf(dir = self, registry = 'reg-1') {
  put(path.join(dir, '.sakuraide.json'), { ...HANAMII_META, publish: { ...HANAMII_META.publish, ...DEDICATED_META.publish } })
  put(path.join(dir, '.sakura-cloud', 'env.json'), BUCKET_ENV)
  put(path.join(dir, '.sakura-cloud', 'state.json'), BUCKET_STATE(registry))
}

/** この FS が、大文字小文字だけ違う名前を同じものと読むか（APFS の既定は読む）。 */
const caseInsensitive = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-r2b-case-'))
  try { fs.mkdirSync(path.join(d, 'abc')); return fs.existsSync(path.join(d, 'ABC')) } finally { fs.rmSync(d, { recursive: true, force: true }) }
})()
const NFC = 'がっこう'.normalize('NFC')
const NFD = 'がっこう'.normalize('NFD')
/** この FS が、NFC と NFD の名前を同じものと読むか。 */
const normalizationInsensitive = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-r2b-nfc-'))
  try { fs.mkdirSync(path.join(d, NFC)); return fs.existsSync(path.join(d, NFD)) } finally { fs.rmSync(d, { recursive: true, force: true }) }
})()

describe('★★★ isSameDirFs: dev と ino で比べる。stat が失敗したら別（false）。投げない', () => {
  it('同じパス・自分を指すリンクは同じ。別のフォルダ・ファイルどうしは別', () => {
    const other = path.join(ws, 'other'); fs.mkdirSync(other)
    const link = path.join(ws, 'link'); fs.symlinkSync(self, link)
    const file = path.join(ws, 'f.txt'); fs.writeFileSync(file, 'x')
    expect(isSameDirFs(self, self)).toBe(true)
    expect(isSameDirFs(self, link)).toBe(true)
    expect(isSameDirFs(link, self)).toBe(true)
    expect(isSameDirFs(self, other)).toBe(false)
    expect(isSameDirFs(file, file)).toBe(false) // フォルダではない
  })

  it('★★ どちらかの stat が失敗（無い・たどれないリンク）→ false。投げない', () => {
    const broken = path.join(ws, 'broken'); fs.symlinkSync(path.join(ws, 'nowhere'), broken)
    expect(isSameDirFs(self, path.join(ws, 'missing'))).toBe(false)
    expect(isSameDirFs(path.join(ws, 'missing'), path.join(ws, 'missing'))).toBe(false) // 文字列が同じでも、stat できなければ false（文字列の一致は呼び手が見る）
    expect(isSameDirFs(self, broken)).toBe(false)
    expect(isSameDirFs(broken, broken)).toBe(false)
  })

  it.runIf(caseInsensitive)('★★ 大文字小文字だけ違うパスは同じ（この FS は区別しない）', () => {
    expect(isSameDirFs(self, path.join(ws, 'MYAPP'))).toBe(true)
  })

  it.runIf(normalizationInsensitive)('★★ NFC と NFD だけ違うパスは同じ（この FS は区別しない）', () => {
    const a = path.join(ws, NFC); fs.mkdirSync(a)
    expect(isSameDirFs(a, path.join(ws, NFD))).toBe(true)
  })
})

describe('★★★ recordTwinsFs（I-2・I-3）: 自分は複製に数えない。ほかの複製は数える', () => {
  const TARGETS = ['hanamii', 'sakura-apprun', 'sakura-apprun-dedicated'] as const
  const twinsOf = (dir: string) => TARGETS.map(t => recordTwinsFs(dir, t))

  it('★★★ 自分を指すリンクの兄弟 → 数えない（以前は自分を複製と数え、I-3 は専有型の止めが外れ、I-2 は自分の名前を挙げて断り続けた）', () => {
    writeSelf()
    fs.symlinkSync(self, path.join(ws, 'link'))
    expect(twinsOf(self)).toEqual([[], [], []])
  })

  it('★★★ リンク経由のパスを自分として渡しても、本物のフォルダを複製と数えない', () => {
    writeSelf()
    const link = path.join(ws, 'link'); fs.symlinkSync(self, link)
    expect(twinsOf(link)).toEqual([[], [], []])
  })

  it.runIf(caseInsensitive)('★★★ 大文字小文字だけ違うパスで渡しても、自分を複製と数えない', () => {
    writeSelf()
    expect(twinsOf(path.join(ws, 'MYAPP'))).toEqual([[], [], []])
  })

  it.runIf(normalizationInsensitive)('★★★ NFC と NFD だけ違うパスで渡しても、自分を複製と数えない', () => {
    const real = path.join(ws, NFC); fs.mkdirSync(real)
    writeSelf(real)
    expect(twinsOf(path.join(ws, NFD))).toEqual([[], [], []])
  })

  it('★★★ 対照: 自分を指すリンクがあっても、本物の複製（別のフォルダ）は数える', () => {
    writeSelf()
    fs.symlinkSync(self, path.join(ws, 'link'))
    writeSelf(path.join(ws, 'copy-of-myapp'))
    expect(twinsOf(self)).toEqual([['copy-of-myapp'], ['copy-of-myapp'], ['copy-of-myapp']])
  })

  it('★★ 対照: 別のフォルダを指すリンクは、今までどおり兄弟として数える（リンクされたプロジェクト）', () => {
    writeSelf()
    writeSelf(path.join(ws, 'real-copy'))
    fs.symlinkSync(path.join(ws, 'real-copy'), path.join(ws, 'linked'))
    expect(twinsOf(self)).toEqual([['linked', 'real-copy'], ['linked', 'real-copy'], ['linked', 'real-copy']])
  })
})

describe('★★★ bucketUsersFromRecords（I-1・保存場所の使用者）: 自分は使用者にも同じ prefix にも数えない', () => {
  const read = (dir: string) => bucketUsersFromRecords(dir, 'koto-data-x', 'projects/myapp/')

  it('★★★ 自分を指すリンクの兄弟 → users にも samePrefix にも入らない（以前は自分の名前を挙げて、データの破棄を止めた）', () => {
    writeSelf()
    fs.symlinkSync(self, path.join(ws, 'link'))
    expect(read(self)).toMatchObject({ known: true, users: [], samePrefix: [], samePrefixUnread: [], samePrefixChecked: true })
  })

  it.runIf(caseInsensitive)('★★★ 大文字小文字だけ違うパスで渡しても、自分を数えない', () => {
    writeSelf()
    expect(read(path.join(ws, 'MYAPP'))).toMatchObject({ known: true, users: [], samePrefix: [] })
  })

  it.runIf(normalizationInsensitive)('★★ NFC と NFD だけ違うパスで渡しても、自分を数えない', () => {
    const real = path.join(ws, NFC); fs.mkdirSync(real)
    writeSelf(real)
    expect(read(path.join(ws, NFD))).toMatchObject({ known: true, users: [], samePrefix: [] })
  })

  it('★★★ 対照: 別のフォルダが同じ prefix を持てば、今までどおり users と samePrefix に入る', () => {
    writeSelf()
    fs.symlinkSync(self, path.join(ws, 'link'))
    writeSelf(path.join(ws, 'twin'))
    expect(read(self)).toMatchObject({ known: true, users: ['twin'], samePrefix: ['twin'] })
  })
})

describe('★★★ otherProjectsUsingRegistry（レジストリの使用者）: 自分は数えない', () => {
  it.runIf(caseInsensitive)('★★★ 大文字小文字だけ違うパスで渡しても、自分を使用者と数えない', () => {
    writeSelf()
    expect(otherProjectsUsingRegistry(path.join(ws, 'MYAPP'), 'reg-1')).toEqual([])
  })

  it.runIf(normalizationInsensitive)('★★ NFC と NFD だけ違うパスで渡しても、自分を使用者と数えない', () => {
    const real = path.join(ws, NFC); fs.mkdirSync(real)
    writeSelf(real)
    expect(otherProjectsUsingRegistry(path.join(ws, NFD), 'reg-1')).toEqual([])
  })

  it('★★★ 対照: 別のプロジェクトが同じレジストリを使っていれば、今までどおり数える。自分を指すリンクは数えない', () => {
    writeSelf()
    fs.symlinkSync(self, path.join(ws, 'link'))
    writeSelf(path.join(ws, 'other'))
    expect(otherProjectsUsingRegistry(self, 'reg-1')).toEqual(['other'])
  })
})

describe('★★★ fs:trashProject の「走っている操作」: 文字列でなく実体で比べる', () => {
  const trashed: string[] = []
  const deps = () => ({ home: ws, trashItem: async (p: string) => { trashed.push(p) } })
  beforeEach(() => { trashed.length = 0 })

  /** `dir` で処理が走っている状態にする（鍵は path.resolve した文字列）。 */
  const hold = (dir: string) => {
    let open!: () => void
    const gate = new Promise<void>(r => { open = r })
    const holder = withProjectLock(dir, '公開', () => gate, { target: 'hanamii', handler: 'test:hold' })
    return async () => { open(); await holder }
  }
  const project = (dir: string) => { put(path.join(dir, '.sakuraide.json'), { name: 'p' }); put(path.join(dir, 'index.html'), '<p/>') }

  it('★★★ リンク経由のパスで削除を押す → 走っているので断る。移す要求0件', async () => {
    const deep = path.join(ws, 'SAKURAIDE', 'p'); project(deep)
    const link = path.join(ws, 'SAKURAIDE', 'link'); fs.symlinkSync(deep, link)
    const release = hold(deep)
    expect(await trashProjectFs(link, { confirmed: true, skippedForTwins: [] }, deps())).toEqual({ ok: false, message: FS_TRASH_MESSAGES.running })
    expect(trashed).toEqual([])
    await release()
  })

  it.runIf(caseInsensitive)('★★★ 大文字小文字だけ違うパスで削除を押す → 走っているので断る。移す要求0件', async () => {
    const deep = path.join(ws, 'SAKURAIDE', 'p'); project(deep)
    const release = hold(deep)
    expect(await trashProjectFs(path.join(ws, 'SAKURAIDE', 'P'), { confirmed: true, skippedForTwins: [] }, deps())).toEqual({ ok: false, message: FS_TRASH_MESSAGES.running })
    expect(trashed).toEqual([])
    await release()
  })

  it('★★★ 対照: 同じ書き方のパスなら今までどおり断る。ほかのプロジェクトの処理が走っているだけなら断らない（移す1回）', async () => {
    const a = path.join(ws, 'SAKURAIDE', 'a'); project(a)
    const b = path.join(ws, 'SAKURAIDE', 'b'); project(b)
    const release = hold(a)
    expect(await trashProjectFs(a, { confirmed: true, skippedForTwins: [] }, deps())).toEqual({ ok: false, message: FS_TRASH_MESSAGES.running })
    expect(trashed).toEqual([])
    expect(await trashProjectFs(b, { confirmed: true, skippedForTwins: [] }, deps())).toEqual({ ok: true })
    expect(trashed).toEqual([b])
    await release()
  })

  it('runningOpEntryAt: 比べ方の関数が投げたら、その1件は別のフォルダと読む（投げない）。走っていなければ undefined', async () => {
    const deep = path.join(ws, 'p'); project(deep)
    expect(runningOpEntryAt(deep, () => true)).toBeUndefined()
    const release = hold(deep)
    expect(runningOpEntryAt(path.join(ws, 'other'), () => { throw new Error('boom') })).toBeUndefined()
    expect(runningOpEntryAt(path.join(ws, 'other'), () => true)).toEqual({ op: '公開', target: 'hanamii' })
    expect(runningOpEntryAt('', () => true)).toBeUndefined()
    await release()
  })

  it('★★★ I-3 の実測: 専有型の記録のあるプロジェクトに、自分を指すリンクがあっても、複製とは数えず「専有型が残っている」で断る。移す要求0件', async () => {
    const deep = path.join(ws, 'SAKURAIDE', 'p')
    put(path.join(deep, '.sakuraide.json'), DEDICATED_META)
    fs.symlinkSync(deep, path.join(ws, 'SAKURAIDE', 'link'))
    expect(await trashProjectFs(deep, { confirmed: true, skippedForTwins: [] }, deps())).toEqual({ ok: false, message: FS_TRASH_MESSAGES.dedicated })
    expect(trashed).toEqual([])
  })
})
