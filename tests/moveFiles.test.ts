import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { moveFilesToFs, moveToMaterialsFs } from '../src/main/ipc/unused'
import { listSnapshotSummaries, restoreToSnapshot } from '../src/main/backup/store'
import { MATERIALS_DIR } from '../src/shared/publishExclude'
import { PUBLISH_DIR } from '../src/shared/publishRoot'

// moveFilesToFs（roadmap #9②「ファイルの移動手段が無い」）: 任意のファイルを手で移す
// project:moveFiles の実体を、実ドライブ（mkdtemp）で駆動して確かめる。
//
// tests/unused.test.ts と同じ事情（src/main/ipc/unused.ts は 'electron' を import するが、
// import されるだけでは electron の実体には触れない）で、fs/path しか使わない
// moveFilesToFs / moveToMaterialsFs は本物の一時フォルダで実駆動できる。
//
// `files` は**プロジェクト直下からの相対パス**として扱う（moveToMaterials とは基準が違う。
// unused.ts 冒頭コメント参照）。dest='materials' の既存の挙動（moveToMaterialsFs 経由）が
// 変わっていないことは、tests/unused.test.ts が引き続き全緑であることで確かめる。

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-movefiles-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function write(rel: string, content = 'x'): void {
  const full = path.join(dir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}
const exists = (rel: string) => fs.existsSync(path.join(dir, rel))
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf-8')

describe('moveFilesToFs: dest="publish"（公開しないもの→公開されるもの）', () => {
  it('① 素材（公開しません）/a.png → public/a.png へ移る', () => {
    write(`${MATERIALS_DIR}/a.png`, '画像のふり')
    const r = moveFilesToFs(dir, [`${MATERIALS_DIR}/a.png`], 'publish')
    expect(r.ok).toBe(true)
    expect(r.moved).toEqual([`${MATERIALS_DIR}/a.png`])
    expect(exists(`${MATERIALS_DIR}/a.png`)).toBe(false)
    expect(exists(`${PUBLISH_DIR}/a.png`)).toBe(true)
    expect(read(`${PUBLISH_DIR}/a.png`)).toBe('画像のふり')
  })

  it('② 移動先（public/）に同名があれば拒否せず改名し、renamed が返る', () => {
    write(`${MATERIALS_DIR}/a.png`, '新しい方')
    write(`${PUBLISH_DIR}/a.png`, '既に公開されている方')
    const r = moveFilesToFs(dir, [`${MATERIALS_DIR}/a.png`], 'publish')
    expect(r.ok).toBe(true)
    expect(exists(`${PUBLISH_DIR}/a.png`)).toBe(true)
    expect(read(`${PUBLISH_DIR}/a.png`)).toBe('既に公開されている方') // 既存はそのまま
    expect(exists(`${PUBLISH_DIR}/a-2.png`)).toBe(true)
    expect(read(`${PUBLISH_DIR}/a-2.png`)).toBe('新しい方')
    expect(r.renamed).toEqual([{ from: `${MATERIALS_DIR}/a.png`, to: 'a-2.png' }])
  })

  it('公開されるもの→公開しないもの（逆方向）も同じ形で動く', () => {
    write(`${PUBLISH_DIR}/old.html`, '古いページ')
    const r = moveFilesToFs(dir, [`${PUBLISH_DIR}/old.html`], 'materials')
    expect(r.ok).toBe(true)
    expect(exists(`${PUBLISH_DIR}/old.html`)).toBe(false)
    expect(exists(`${MATERIALS_DIR}/old.html`)).toBe(true)
  })
})

describe('moveFilesToFs: dest="materials" は moveToMaterialsFs（project:moveToMaterials）の既存の挙動を変えない', () => {
  it('③ moveToMaterialsFs（公開の根からの相対パス）は従来どおり動く。moveFilesToFs 直呼び（プロジェクト直下相対）と一致する', () => {
    write('old.html', '古い内容')
    const viaWrapper = moveToMaterialsFs(dir, ['old.html'])
    expect(viaWrapper.ok).toBe(true)
    expect(exists('old.html')).toBe(false)
    expect(exists(`${MATERIALS_DIR}/old.html`)).toBe(true)
    expect(read(`${MATERIALS_DIR}/old.html`)).toBe('古い内容')
  })

  it('public/ がある場合の moveToMaterialsFs も従来どおり（公開の根からの相対パスをそのまま渡す）', () => {
    write(`${PUBLISH_DIR}/old.html`, '古い内容')
    const r = moveToMaterialsFs(dir, ['old.html']) // 公開の根（public/）からの相対
    expect(r.ok).toBe(true)
    expect(exists(`${PUBLISH_DIR}/old.html`)).toBe(false)
    expect(exists(`${MATERIALS_DIR}/old.html`)).toBe(true)
  })
})

describe('moveFilesToFs: 保護パス拒否は移動元・移動先の両方（対で。dest によらない）', () => {
  it('④-a 移動元が保護パス（.env）なら dest="publish" でも拒否する', () => {
    write('.env', 'SECRET=1')
    const r = moveFilesToFs(dir, ['.env'], 'publish')
    expect(r.ok).toBe(false)
    expect(exists('.env')).toBe(true) // 触られていない
    expect(exists(`${PUBLISH_DIR}/.env`)).toBe(false)
  })

  it('④-b 移動元が Koto の管理領域（.sakuraide-backup 配下）なら dest="publish" でも拒否する', () => {
    write('.sakuraide-backup/whatever.json', '{}')
    const r = moveFilesToFs(dir, ['.sakuraide-backup/whatever.json'], 'publish')
    expect(r.ok).toBe(false)
    expect(exists('.sakuraide-backup/whatever.json')).toBe(true)
  })

  it('④-c .. を含む相対パスは移動先を問わず脱出として拒否する', () => {
    const r = moveFilesToFs(dir, ['../outside.txt'], 'publish')
    expect(r.ok).toBe(false)
    expect(r.moved).toEqual([])
  })
})

describe('moveFilesToFs: 🕘 履歴（dest="publish" でも移動元・移動先の両方を同じスナップショットIDで退避する）', () => {
  it('⑤ 移動元（内容退避）・移動先（まだ無かった印）の両方が同じ snapshotId で記録される', () => {
    write(`${MATERIALS_DIR}/a.png`, '画像のふり')
    const r = moveFilesToFs(dir, [`${MATERIALS_DIR}/a.png`], 'publish')
    expect(r.ok).toBe(true)
    expect(r.snapshotOk).toBe(true)
    const { snapshots } = listSnapshotSummaries(dir)
    expect(snapshots).toHaveLength(1)
    const paths = snapshots[0].files.map(f => f.path).sort()
    expect(paths).toEqual([`${MATERIALS_DIR}/a.png`, `${PUBLISH_DIR}/a.png`].sort())
    const byPath = Object.fromEntries(snapshots[0].files.map(f => [f.path, f.action]))
    expect(byPath[`${MATERIALS_DIR}/a.png`]).toBe('overwrite') // 移動元は内容があった＝退避
    expect(byPath[`${PUBLISH_DIR}/a.png`]).toBe('create') // 移動先はまだ無かった

    // その時点へ戻すと、移動そのものが取り消される形になる（restoreToSnapshot と組み合わせ）。
    const restored = restoreToSnapshot(dir, snapshots[0].id)
    expect(restored.ok).toBe(true)
    expect(exists(`${MATERIALS_DIR}/a.png`)).toBe(true)
    expect(exists(`${PUBLISH_DIR}/a.png`)).toBe(false)
  })
})

describe('moveFilesToFs: 0件・空フォルダの片づけ（dest によらず共通の挙動）', () => {
  it('0件の呼び出しは何もせず ok:true', () => {
    const r = moveFilesToFs(dir, [], 'publish')
    expect(r).toEqual({ ok: true, moved: [], snapshotOk: true })
  })

  it('移動元の親フォルダが空になったら片づける（publish 方向でも）', () => {
    write('images/unused.jpg', 'x')
    const r = moveFilesToFs(dir, ['images/unused.jpg'], 'publish')
    expect(r.ok).toBe(true)
    expect(exists('images')).toBe(false)
  })
})
