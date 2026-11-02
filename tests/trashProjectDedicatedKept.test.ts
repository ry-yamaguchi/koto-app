import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { trashProjectFs, FS_TRASH_MESSAGES } from '../src/main/ipc/fsTrash'
import { readTwinFacts } from '../src/main/cloud/twinFacts'
import { loadCloudSpec } from '../src/main/cloud/specStore'
import { defaultSpec } from '../src/main/cloud/spec'
import { readApprunDedicatedFs } from '../src/main/publishMetaFs'
import { consentedPlacementsOf } from '../src/shared/objectStorage'
import { planProjectDeleteTeardown, type ProjectDeleteFacts } from '../src/renderer/teardown/projectDeletePlan'
import { resetProjectOpsForTests } from '../src/main/projectOps'

// ── 専有型で、残っている保存場所（印）が全部「消さずに残す」とき、main の fs:trashProject はフォルダを移す（画面と同じ判断）──────────────────
// 本物の trashProjectFs に、実フォルダ（親フォルダ・自分・複製の兄弟）と偽の trashItem を渡し、フォルダを移したか（偽の trashItem が呼ばれたか）で見る（掟10）。
// 残す判断は、同じ保存場所の同じ prefix を持つ兄弟（複製）がいる・複製かどうか確かめられない兄弟（記録を読めない）がいること。
// 画面の判断（planProjectDeleteTeardown の block）は、同じフォルダから main と同じ読み方で作った材料に流し、「画面が止める ⇔ main が断る」を表で突き合わせる。
// 変異: 判断が keep を見ない・材料に無い名前を残す側に数える・ID を見ない・main が env.json を読めない回を通す（画面だけ外す・main だけ外す）、がそれぞれ落ちる。

const DEDICATED_MESSAGE = FS_TRASH_MESSAGES.dedicated
const CONSENTED_AT = '2026-08-14T00:00:00.000Z'
const PREFIX = 'projects/myapp/'
const GO = { confirmed: true, skippedForTwins: [] as string[] }

let home = ''
let trashed: string[] = []
const deps = () => ({ home, trashItem: async (p: string) => { trashed.push(p) } })
const at = (...rel: string[]): string => path.join(home, ...rel)
const SELF = (): string => at('SAKURAIDE', 'p')

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koto-dedicated-kept-')))
  trashed = []
})
afterEach(() => {
  resetProjectOpsForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

function put(full: string, content: string): void {
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}
type Place = { bucket: string; prefix?: string; consented?: boolean }
function envJson(places: Place[]): string {
  const spec = defaultSpec({ name: 'myapp', hasDockerfile: false })
  spec.persistence = {
    objectStorage: places.map(p => ({ bucket: p.bucket, prefix: p.prefix ?? PREFIX, shared: true, ...(p.consented === false ? {} : { consentedAt: CONSENTED_AT }) })),
  } as any
  return JSON.stringify(spec, null, 2)
}
/** 自分（専有型の行つき・記録は `record`・env.json は `places`。`env` を文字列で渡せば、それをそのまま env.json にする）。 */
function writeSelf(record: Record<string, unknown>, places: Place[] | null, env?: string): void {
  put(path.join(SELF(), '.sakuraide.json'), JSON.stringify({
    name: 'p',
    publish: { targets: { 'sakura-apprun-dedicated': { publishedAt: '2026-10-19T00:00:00.000Z', url: 'https://dedicated.example.com/' } }, apprunDedicated: record },
  }))
  put(path.join(SELF(), 'index.html'), '<p>hi</p>')
  if (env !== undefined) put(path.join(SELF(), '.sakura-cloud', 'env.json'), env)
  else if (places !== null) put(path.join(SELF(), '.sakura-cloud', 'env.json'), envJson(places))
}
/** 同じ親フォルダの兄弟。env.json に、同じ保存場所（同意済み）を持つ。 */
function writeTwin(name: string, places: Place[]): void {
  put(at('SAKURAIDE', name, '.sakura-cloud', 'env.json'), envJson(places))
}
/** 同じ親フォルダの、複製かどうか確かめられない兄弟（env.json が壊れている）。 */
function writeUnread(name = 'broken'): void {
  put(at('SAKURAIDE', name, '.sakura-cloud', 'env.json'), '{ not json')
}
const mark = (...names: string[]): Record<string, unknown> => ({ storageLeftoverBucket: names[0], storageLeftoverBuckets: names })
function tree(dir = home): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const full = path.join(d, e.name)
      if (e.isDirectory()) { out.push(`${r}/`); walk(full, r) } else out.push(`${r}=${fs.readFileSync(full, 'utf-8')}`)
    }
  }
  walk(dir, '')
  return out
}

/** 画面の材料を、main と同じ読み方（env.json の同意済みの保存場所＋ cloud:twinFacts の本体）で作る。読めない回は保存場所が空（readProjectDeleteFacts の storage:placement が ok:false の回と同じ）。 */
function screenFacts(): ProjectDeleteFacts {
  let placements: ProjectDeleteFacts['placements'] = []
  try {
    const list = consentedPlacementsOf(loadCloudSpec(SELF())?.persistence?.objectStorage).map(p => ({ bucket: p.bucket, prefix: p.prefix, shared: p.shared }))
    const read = list.length === 0 ? null : readTwinFacts(SELF(), { target: 'sakura-apprun-dedicated', placements: list.map(p => ({ bucket: p.bucket, prefix: p.prefix })) })
    placements = list.map((p, i) => {
      const keep = read && read.ok ? read.placements[i]?.keep : null
      return keep ? { ...p, keep } : p
    })
  } catch { placements = [] }
  return {
    targets: ['sakura-apprun-dedicated'], unreadable: false, unconfirmed: false, dedicated: readApprunDedicatedFs(SELF()),
    placements, running: null, sharedLeftover: null, sharedRegistry: null, twins: null,
  }
}

/** `ids` は資源の ID が残る回（main は材料の読み直しの印〔twins-gone〕を付けずに断る）。印だけの回の断りは、画面に材料を読み直させる（twins-gone）。 */
type Scenario = { name: string; build: () => void; moves: boolean; ids?: true }
const SCENARIOS: Scenario[] = [
  { name: '複製が同じ保存場所の同じ prefix を持つ', moves: true, build: () => { writeSelf(mark('koto-a'), [{ bucket: 'koto-a' }]); writeTwin('p copy', [{ bucket: 'koto-a' }]) } },
  { name: '複製かどうか確かめられない兄弟がいる（記録を読めない）', moves: true, build: () => { writeSelf(mark('koto-a'), [{ bucket: 'koto-a' }]); writeUnread() } },
  { name: '印が旧い形（先頭の1件だけ）でも、複製がいれば通す', moves: true, build: () => { writeSelf({ storageLeftoverBucket: 'koto-a' }, [{ bucket: 'koto-a' }]); writeTwin('p copy', [{ bucket: 'koto-a' }]) } },
  { name: '保存場所が2件とも複製と共有している', moves: true, build: () => { writeSelf(mark('koto-a', 'koto-b'), [{ bucket: 'koto-a' }, { bucket: 'koto-b' }]); writeTwin('p copy', [{ bucket: 'koto-a' }, { bucket: 'koto-b' }]) } },
  { name: '同じバケット名を2回書いた env.json（検証に通らない）', moves: false, build: () => {
    writeSelf(mark('koto-a'), [{ bucket: 'koto-a', prefix: 'p1/' }, { bucket: 'koto-a', prefix: 'p2/' }]); writeTwin('p copy', [{ bucket: 'koto-a', prefix: 'p1/' }]) } },
  { name: '複製がいない（複製のフォルダを消したあと）', moves: false, build: () => { writeSelf(mark('koto-a'), [{ bucket: 'koto-a' }]) } },
  { name: '同じバケットでも prefix が違う兄弟しかいない（複製ではない）', moves: false, build: () => { writeSelf(mark('koto-a'), [{ bucket: 'koto-a' }]); writeTwin('other', [{ bucket: 'koto-a', prefix: 'projects/other/' }]) } },
  { name: '保存場所2件のうち1件だけ複製と共有している', moves: false, build: () => { writeSelf(mark('koto-a', 'koto-b'), [{ bucket: 'koto-a' }, { bucket: 'koto-b' }]); writeTwin('p copy', [{ bucket: 'koto-a' }]) } },
  { name: '印の名前が、env.json の保存場所に無い（材料に無い名前）', moves: false, build: () => { writeSelf(mark('koto-gone'), [{ bucket: 'koto-a' }]); writeTwin('p copy', [{ bucket: 'koto-a' }]) } },
  { name: '印の名前の保存場所が、同意済みでない（env.json にあるが consentedAt が無い）', moves: false, build: () => { writeSelf(mark('koto-a'), [{ bucket: 'koto-a', consented: false }]); writeTwin('p copy', [{ bucket: 'koto-a' }]) } },
  { name: '印の複数形と単数が食い違い、単数の名前が env.json の保存場所に無い（複数形の名前は複製と共有している）', moves: false, build: () => {
    writeSelf({ storageLeftoverBucket: 'koto-gone', storageLeftoverBuckets: ['koto-a'] }, [{ bucket: 'koto-a' }]); writeTwin('p copy', [{ bucket: 'koto-a' }]) } },
  { name: '印の複数形に、文字列でない値が混ざる', moves: false, build: () => {
    writeSelf({ storageLeftoverBucket: 'koto-a', storageLeftoverBuckets: ['koto-a', 42] }, [{ bucket: 'koto-a' }]); writeTwin('p copy', [{ bucket: 'koto-a' }]) } },
  { name: '印の複数形と単数が食い違うが、両方の名前が複製と共有している', moves: true, build: () => {
    writeSelf({ storageLeftoverBucket: 'koto-b', storageLeftoverBuckets: ['koto-a'] }, [{ bucket: 'koto-a' }, { bucket: 'koto-b' }]); writeTwin('p copy', [{ bucket: 'koto-a' }, { bucket: 'koto-b' }]) } },
  { name: '自分の env.json が無い', moves: false, build: () => { writeSelf(mark('koto-a'), null); writeTwin('p copy', [{ bucket: 'koto-a' }]) } },
  { name: '自分の env.json が JSON として読めない', moves: false, build: () => { writeSelf(mark('koto-a'), null, '{ not json'); writeTwin('p copy', [{ bucket: 'koto-a' }]) } },
  { name: '自分の env.json が検証に通らない（{}）', moves: false, build: () => { writeSelf(mark('koto-a'), null, '{}'); writeTwin('p copy', [{ bucket: 'koto-a' }]) } },
  ...(['applicationID', 'clusterID', 'asgID', 'loadBalancerID'] as const).map((f): Scenario => ({
    name: `資源の ID（${f}）が残っている。保存場所は複製と共有していても断る`, moves: false, ids: true,
    build: () => { writeSelf({ ...mark('koto-a'), [f]: 'x-1' }, [{ bucket: 'koto-a' }]); writeTwin('p copy', [{ bucket: 'koto-a' }]) },
  })),
]

describe('★★★ 本物の trashProjectFs: 残っている保存場所が全部「消さずに残す」なら、フォルダを移す。そうでなければ断り、ディスクは変わらない', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.moves ? '移す' : '断る'}: ${sc.name}`, async () => {
      sc.build()
      const before = tree()
      const r = await trashProjectFs(SELF(), GO, deps())
      if (sc.moves) {
        expect(r).toEqual({ ok: true })
        expect(trashed, '偽の trashItem に渡したフォルダ').toEqual([SELF()])
      } else {
        expect(r).toEqual(sc.ids ? { ok: false, message: DEDICATED_MESSAGE } : { ok: false, message: DEDICATED_MESSAGE, reason: 'twins-gone' })
        expect(trashed, '断ったのに trashItem が呼ばれた').toEqual([])
      }
      expect(tree(), 'フォルダの中身が変わった').toEqual(before)
    })
  }

  it('★★ 複製のフォルダを消すと、同じフォルダを専有型の文で断る（複製がいる間だけ通る。いなくなったら止める）', async () => {
    writeSelf(mark('koto-a'), [{ bucket: 'koto-a' }])
    writeTwin('p copy', [{ bucket: 'koto-a' }])
    expect(await trashProjectFs(SELF(), GO, deps())).toEqual({ ok: true })
    expect(trashed).toEqual([SELF()])
    fs.rmSync(at('SAKURAIDE', 'p copy'), { recursive: true, force: true })
    // 開いたときの画面の判断（全部残す）は古い。材料を読み直させる印（twins-gone）を付けて断る
    expect(await trashProjectFs(SELF(), GO, deps())).toEqual({ ok: false, message: DEDICATED_MESSAGE, reason: 'twins-gone' })
    expect(trashed, '複製を消したあとに移した').toEqual([SELF()])
  })

  it('★★ 確認の印が無ければ、この判断より前に断る（confirmed が無い・skippedForTwins が配列でない回は今までどおり。判断を通る前に止まる）', async () => {
    writeSelf(mark('koto-a'), [{ bucket: 'koto-a' }])
    writeTwin('p copy', [{ bucket: 'koto-a' }])
    expect((await trashProjectFs(SELF(), { skippedForTwins: [] }, deps())).ok).toBe(false)
    expect(await trashProjectFs(SELF(), { confirmed: true }, deps())).toEqual({ ok: false, message: FS_TRASH_MESSAGES.skippedInvalid })
    expect(trashed).toEqual([])
  })

  it('★★ 専有型の資源が無い・保存場所の印も無いプロジェクトは、この判断に関わらず今までどおり移す（env.json が壊れていても）', async () => {
    put(path.join(SELF(), '.sakuraide.json'), JSON.stringify({ name: 'p' }))
    put(path.join(SELF(), '.sakura-cloud', 'env.json'), '{ not json')
    expect(await trashProjectFs(SELF(), GO, deps())).toEqual({ ok: true })
    expect(trashed).toEqual([SELF()])
  })
})

describe('★★★ 画面が止める ⇔ main が断る（同じフォルダから、同じ読み方で材料を作って突き合わせる）', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.name}: 画面の止める理由が無い ⇔ main がフォルダを移す（${sc.moves ? '移す' : '止める'}）`, async () => {
      sc.build()
      const plan = planProjectDeleteTeardown(screenFacts())
      const r = await trashProjectFs(SELF(), GO, deps())
      expect(plan.block === null, `画面と main が食い違う: 画面の block=${JSON.stringify(plan.block)}、main=${JSON.stringify(r)}`).toBe(r.ok)
      expect(plan.block === null).toBe(sc.moves)
      // 外した回だけ、残す保存場所を plan に載せる（外さない回はキーごと無い）
      expect('dedicatedKept' in plan).toBe(sc.moves)
    })
  }

  it('★★ 印が無い専有型の行（幽霊の行）は、画面は今までどおり dedicated で止める。main は、消すものが記録に無いので止めない（今までどおり）', async () => {
    writeSelf({}, [{ bucket: 'koto-a' }])
    expect(planProjectDeleteTeardown(screenFacts()).block).toEqual({ reason: 'dedicated' })
    expect(await trashProjectFs(SELF(), GO, deps())).toEqual({ ok: true })
  })
})
