import { describe, it, expect } from 'vitest'
import {
  MAX_SNAPSHOTS,
  MAX_LABEL_LENGTH,
  isoToSnapshotId,
  looksLikeSnapshotId,
  isValidManifest,
  normalizeSnapshotLabel,
  snapshotIdToIso,
  nextFreeSnapshotId,
  sortSnapshotsDesc,
  rotationTargets,
  computeRestorePlanTo,
  buildPreRestoreManifest,
  type Manifest,
  type SnapshotRecord,
  type SnapshotSummary,
} from '../src/main/backup/plan'

// ISO日時 → スナップショットID（ディレクトリ名）の相互ルール
describe('isoToSnapshotId / looksLikeSnapshotId', () => {
  it('converts ISO date to a directory-safe id (colons and dots to hyphens)', () => {
    expect(isoToSnapshotId('2026-07-06T21:15:00.123Z')).toBe('2026-07-06T21-15-00-123Z')
  })

  it('accepts ids produced by isoToSnapshotId', () => {
    const id = isoToSnapshotId(new Date().toISOString())
    expect(looksLikeSnapshotId(id)).toBe(true)
  })

  it('rejects legacy flat-file backup names (old format)', () => {
    // 旧形式: .sakuraide-backup/<相対パス>.<stamp> のファイル名
    expect(looksLikeSnapshotId('index.html.2026-07-06T21-15-00-123Z')).toBe(false)
    expect(looksLikeSnapshotId('src')).toBe(false)
    expect(looksLikeSnapshotId('')).toBe(false)
  })

  it('rejects path traversal attempts', () => {
    expect(looksLikeSnapshotId('..')).toBe(false)
    expect(looksLikeSnapshotId('../2026-07-06T21-15-00-123Z')).toBe(false)
    expect(looksLikeSnapshotId('2026-07-06T21-15-00-123Z/..')).toBe(false)
  })
})

describe('isValidManifest', () => {
  it('accepts a well-formed manifest', () => {
    const m: Manifest = {
      createdAt: '2026-07-06T21:15:00.123Z',
      files: [
        { path: 'index.html', action: 'overwrite' },
        { path: 'js/app.js', action: 'create' },
        { path: 'style.css', action: 'pre-restore' },
      ],
    }
    expect(isValidManifest(m)).toBe(true)
  })

  it('rejects null, missing fields, and unknown actions', () => {
    expect(isValidManifest(null)).toBe(false)
    expect(isValidManifest({})).toBe(false)
    expect(isValidManifest({ createdAt: 'x' })).toBe(false)
    expect(isValidManifest({ files: [] })).toBe(false)
    expect(isValidManifest({ createdAt: 'x', files: [{ path: 'a', action: 'delete' }] })).toBe(false)
    expect(isValidManifest({ createdAt: 'x', files: [{ action: 'create' }] })).toBe(false)
  })

  it('accepts an empty files array (manifest just created)', () => {
    expect(isValidManifest({ createdAt: '2026-07-06T21:15:00.123Z', files: [] })).toBe(true)
  })

  // label は後から足したフィールド。無い（＝v0.2.86以前に作られた）履歴を弾いてはならない
  it('accepts manifests with and without a label', () => {
    expect(isValidManifest({ createdAt: 'x', label: 'トップページを青くして', files: [] })).toBe(true)
    expect(isValidManifest({ createdAt: 'x', files: [] })).toBe(true)
  })
})

// 一覧の並び（createdAt）と復元の畳み込み（id）を同じ時計に揃えるための逆変換。
// これが無いと、AIの応答に時間がかかったとき「並び順」と「どこまで戻るか」が食い違う。
describe('snapshotIdToIso', () => {
  it('isoToSnapshotId の逆変換になっている（往復して元に戻る）', () => {
    const iso = '2026-08-05T12:00:05.123Z'
    expect(snapshotIdToIso(isoToSnapshotId(iso))).toBe(iso)
  })

  it('妥当でないIDには null を返す（呼び出し側が現在時刻へ退避できるように）', () => {
    expect(snapshotIdToIso('')).toBeNull()
    expect(snapshotIdToIso('index.html.2026-07-06T21-15-00-123Z')).toBeNull() // 旧形式
    expect(snapshotIdToIso('../2026-07-06T21-15-00-123Z')).toBeNull()
    expect(snapshotIdToIso('2026-13-45T99-99-99-999Z')).toBeNull()            // 形は合うが日時として無効
  })

  it('変換結果は文字列比較でも時系列順になる（一覧の並びに使うため）', () => {
    const a = snapshotIdToIso(isoToSnapshotId('2026-08-05T12:00:05.000Z'))!
    const b = snapshotIdToIso(isoToSnapshotId('2026-08-05T12:00:06.000Z'))!
    expect(a < b).toBe(true)
  })
})

// 同一ミリ秒に2回操作されると退避先が衝突し、直前の退避内容を上書きしてしまうため、
// 空いているIDまで1ミリ秒ずつ進める（実害のあるバグの修正。CIで実際に再現した）
describe('nextFreeSnapshotId', () => {
  it('空いていればその時刻のIDをそのまま使う', () => {
    const iso = '2026-08-05T12:00:05.000Z'
    expect(nextFreeSnapshotId(iso, () => false)).toBe(isoToSnapshotId(iso))
  })

  it('埋まっていたら1ミリ秒ずつ進めて空きを探す', () => {
    const iso = '2026-08-05T12:00:05.000Z'
    const taken = new Set([
      isoToSnapshotId('2026-08-05T12:00:05.000Z'),
      isoToSnapshotId('2026-08-05T12:00:05.001Z'),
    ])
    expect(nextFreeSnapshotId(iso, id => taken.has(id))).toBe(isoToSnapshotId('2026-08-05T12:00:05.002Z'))
  })

  it('返すIDは必ず妥当な形（そのままディレクトリ名に使えること）', () => {
    const id = nextFreeSnapshotId('2026-08-05T12:00:05.999Z', () => false)
    expect(looksLikeSnapshotId(id)).toBe(true)
    // 999ms から繰り上がっても壊れない
    const next = nextFreeSnapshotId('2026-08-05T12:00:05.999Z', i => i === id)
    expect(looksLikeSnapshotId(next)).toBe(true)
    expect(snapshotIdToIso(next)).toBe('2026-08-05T12:00:06.000Z')
  })

  it('無限には探さない（全部埋まっていれば諦めて例外）', () => {
    expect(() => nextFreeSnapshotId('2026-08-05T12:00:05.000Z', () => true)).toThrow()
  })
})

describe('normalizeSnapshotLabel', () => {
  it('collapses newlines and surrounding whitespace into one line', () => {
    expect(normalizeSnapshotLabel('  トップページを\n青くして  ')).toBe('トップページを 青くして')
  })

  it('truncates long instructions and marks them with an ellipsis', () => {
    const long = 'あ'.repeat(MAX_LABEL_LENGTH + 10)
    const out = normalizeSnapshotLabel(long)
    expect(out).toBe('あ'.repeat(MAX_LABEL_LENGTH) + '…')
    expect(out.length).toBe(MAX_LABEL_LENGTH + 1)
  })

  it('keeps a label that is exactly at the limit unchanged', () => {
    const exact = 'あ'.repeat(MAX_LABEL_LENGTH)
    expect(normalizeSnapshotLabel(exact)).toBe(exact)
  })

  it('returns an empty string for empty / whitespace / nullish input', () => {
    expect(normalizeSnapshotLabel('')).toBe('')
    expect(normalizeSnapshotLabel('   \n ')).toBe('')
    expect(normalizeSnapshotLabel(null)).toBe('')
    expect(normalizeSnapshotLabel(undefined)).toBe('')
  })
})

describe('rotationTargets', () => {
  const idAt = (i: number) => isoToSnapshotId(new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString())

  it('returns nothing when at or under the limit', () => {
    const ids = Array.from({ length: MAX_SNAPSHOTS }, (_, i) => idAt(i))
    expect(rotationTargets(ids)).toEqual([])
    expect(rotationTargets([])).toEqual([])
  })

  it('returns the oldest ids beyond the limit (default 30)', () => {
    const ids = Array.from({ length: MAX_SNAPSHOTS + 3 }, (_, i) => idAt(i))
    const targets = rotationTargets(ids)
    expect(targets).toEqual([idAt(0), idAt(1), idAt(2)]) // 古い3件が削除対象
  })

  it('works regardless of input order', () => {
    const ids = [idAt(2), idAt(0), idAt(1)]
    expect(rotationTargets(ids, 1)).toEqual([idAt(0), idAt(1)])
  })

  it('respects a custom keep count', () => {
    const ids = [idAt(0), idAt(1), idAt(2), idAt(3)]
    expect(rotationTargets(ids, 2)).toEqual([idAt(0), idAt(1)])
  })
})

describe('sortSnapshotsDesc', () => {
  // 旧版が作った履歴は createdAt が書き込み時刻なので同値になり得る。そのとき id で決めないと
  // ファイルシステムの読み出し順（macOS と Linux で違う）で並びが変わってしまう
  it('createdAt が同じときは id で決める（環境によって並びが変わらない）', () => {
    const mk = (id: string): SnapshotSummary => ({
      id, createdAt: '2026-08-05T12:00:00.000Z', fileCount: 0, files: [], restoreCount: 0, deleteCount: 0,
    })
    const older = mk(isoToSnapshotId('2026-08-05T11:00:00.000Z'))
    const newer = mk(isoToSnapshotId('2026-08-05T13:00:00.000Z'))
    expect(sortSnapshotsDesc([older, newer]).map(s => s.id)).toEqual([newer.id, older.id])
    expect(sortSnapshotsDesc([newer, older]).map(s => s.id)).toEqual([newer.id, older.id])
  })

  it('sorts newest first without mutating the input', () => {
    const mk = (createdAt: string): SnapshotSummary => ({
      id: isoToSnapshotId(createdAt), createdAt, fileCount: 0, files: [], restoreCount: 0, deleteCount: 0,
    })
    const a = mk('2026-07-04T10:00:00.000Z')
    const b = mk('2026-07-06T21:15:00.000Z')
    const c = mk('2026-07-05T12:30:00.000Z')
    const input = [a, b, c]
    const sorted = sortSnapshotsDesc(input)
    expect(sorted.map(s => s.createdAt)).toEqual([b.createdAt, c.createdAt, a.createdAt])
    expect(input.map(s => s.createdAt)).toEqual([a.createdAt, b.createdAt, c.createdAt]) // 入力は不変
  })
})

// 「その時点の状態に戻す」の畳み込み（2026-08-05）。
// 各スナップショットは「その作業をする直前の内容」を持つので、target 以降を古い順に見て
// 最初に見つかった記録＝target 時点の内容になる。
describe('computeRestorePlanTo', () => {
  const snap = (id: string, files: Manifest['files']): SnapshotRecord => ({ id, manifest: { createdAt: id, files } })

  it('restores overwritten/pre-restore files and deletes files created after that point', () => {
    const s1 = snap('2026-07-06T21-15-00-000Z', [
      { path: 'index.html', action: 'overwrite' },
      { path: 'js/new-feature.js', action: 'create' },
      { path: 'style.css', action: 'pre-restore' },
    ])
    expect(computeRestorePlanTo([s1], s1.id)).toEqual([
      { path: 'index.html', op: 'restore', fromSnapshotId: s1.id },
      { path: 'js/new-feature.js', op: 'delete', fromSnapshotId: s1.id },
      { path: 'style.css', op: 'restore', fromSnapshotId: s1.id },
    ])
  })

  // これが今回の修正の本体。以前は対象スナップショットのファイルしか戻さず、
  // 「3つ前に戻したのに、その後で足したCSSだけ新しいまま」という混ざった状態になっていた。
  it('also undoes changes made by LATER snapshots (point-in-time, not single-turn undo)', () => {
    const s1 = snap('2026-07-06T21-00-00-000Z', [{ path: 'index.html', action: 'overwrite' }])
    const s2 = snap('2026-07-06T22-00-00-000Z', [{ path: 'style.css', action: 'create' }])
    const s3 = snap('2026-07-06T23-00-00-000Z', [{ path: 'index.html', action: 'overwrite' }])
    const plan = computeRestorePlanTo([s3, s1, s2], s1.id) // 入力順は問わない
    expect(plan).toEqual([
      // index.html は s1 の退避（＝s1の直前＝戻したい時点の内容）を採用する。s3 の退避ではない
      { path: 'index.html', op: 'restore', fromSnapshotId: s1.id },
      // s2 で作られた style.css は、s1 の時点には無かったので削除する
      { path: 'style.css', op: 'delete', fromSnapshotId: s2.id },
    ])
  })

  it('takes the oldest record of each file (a file touched in several later turns)', () => {
    const s1 = snap('2026-07-06T21-00-00-000Z', [{ path: 'a.txt', action: 'overwrite' }])
    const s2 = snap('2026-07-06T22-00-00-000Z', [{ path: 'a.txt', action: 'overwrite' }])
    const s3 = snap('2026-07-06T23-00-00-000Z', [{ path: 'a.txt', action: 'overwrite' }])
    expect(computeRestorePlanTo([s1, s2, s3], s2.id)).toEqual([
      { path: 'a.txt', op: 'restore', fromSnapshotId: s2.id },
    ])
  })

  it('ignores snapshots older than the target', () => {
    const s1 = snap('2026-07-06T21-00-00-000Z', [{ path: 'old.txt', action: 'overwrite' }])
    const s2 = snap('2026-07-06T22-00-00-000Z', [{ path: 'new.txt', action: 'overwrite' }])
    expect(computeRestorePlanTo([s1, s2], s2.id)).toEqual([
      { path: 'new.txt', op: 'restore', fromSnapshotId: s2.id },
    ])
  })

  // 「作成 → 後で上書き」。戻し先の時点では存在しなかったので、上書き内容を書き戻すのではなく削除する
  it('deletes a file that was created at the target turn and edited later', () => {
    const s1 = snap('2026-07-06T21-00-00-000Z', [{ path: 'new.js', action: 'create' }])
    const s2 = snap('2026-07-06T22-00-00-000Z', [{ path: 'new.js', action: 'overwrite' }])
    expect(computeRestorePlanTo([s1, s2], s1.id)).toEqual([
      { path: 'new.js', op: 'delete', fromSnapshotId: s1.id },
    ])
  })

  it('returns an empty plan when the target is unknown or the manifest is empty', () => {
    const s1 = snap('2026-07-06T21-00-00-000Z', [])
    expect(computeRestorePlanTo([s1], '2026-07-06T23-00-00-000Z')).toEqual([])
    expect(computeRestorePlanTo([s1], s1.id)).toEqual([])
    expect(computeRestorePlanTo([], 'x')).toEqual([])
  })
})

describe('buildPreRestoreManifest', () => {
  it('records existing files as pre-restore and missing files as create', () => {
    const paths = [
      'index.html', // 現存 → 退避対象
      'js/app.js',  // 現存 → 退避対象
      'gone.txt',   // 現在は存在しない → 復元で作られる＝取り消し時は削除
    ]
    const now = '2026-07-06T22:00:00.000Z'
    const pre = buildPreRestoreManifest(paths, { 'index.html': true, 'js/app.js': true, 'gone.txt': false }, now)
    expect(pre.createdAt).toBe(now)
    expect(pre.files).toEqual([
      { path: 'index.html', action: 'pre-restore' },
      { path: 'js/app.js', action: 'pre-restore' },
      { path: 'gone.txt', action: 'create' },
    ])
  })

  it('stores a normalized label when given, and omits the field when empty', () => {
    const withLabel = buildPreRestoreManifest([], {}, 'now', '  戻す  直前  ')
    expect(withLabel.label).toBe('戻す 直前')
    expect('label' in buildPreRestoreManifest([], {}, 'now')).toBe(false)
    expect('label' in buildPreRestoreManifest([], {}, 'now', '   ')).toBe(false)
  })
})
