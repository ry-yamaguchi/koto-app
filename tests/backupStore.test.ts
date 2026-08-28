import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  snapshotBeforeWrite, snapshotBeforeChange, listSnapshotSummaries, restoreToSnapshot,
  snapshotCurrentFiles, restoreNoteMessage,
} from '../src/main/backup/store'
import { BACKUP_DIRNAME } from '../src/main/backup/plan'

// 「前の状態に戻す」の実ファイル動作を、本物の一時フォルダで検証する。
// 復元はユーザーのファイルを上書き・削除する最も危険な処理なので、純ロジック（plan.ts）の
// テストだけでは足りない。ここでは実際に書いて・戻して・中身を読み直して確かめる。

let dir = ''

// 実際の呼び出し側（renderer / claude/agent.ts）と同じ規則でIDを作る
const idAt = (sec: number) => new Date(Date.UTC(2026, 7, 5, 12, 0, sec)).toISOString().replace(/[:.]/g, '-')

const write = (rel: string, content: string) => {
  const full = path.join(dir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}
const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf-8')
const exists = (rel: string) => fs.existsSync(path.join(dir, rel))

/** AIの1ターン（保存前に退避 → 実際に保存）を再現する。 */
const aiTurn = (id: string, label: string, files: Record<string, string>) => {
  for (const [rel, content] of Object.entries(files)) {
    snapshotBeforeWrite(dir, id, rel, content, label)
    write(rel, content)
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-backup-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('スナップショットの記録', () => {
  it('上書き前の内容を退避し、新規作成は create として記録する', () => {
    write('index.html', '最初')
    const r1 = snapshotBeforeWrite(dir, idAt(1), 'index.html', '2回目', 'トップページを直して')
    const r2 = snapshotBeforeWrite(dir, idAt(1), 'style.css', 'body{}', 'トップページを直して')
    expect(r1).toMatchObject({ ok: true, backedUp: true })  // 既存 → 退避した
    expect(r2).toMatchObject({ ok: true, backedUp: false }) // 新規 → 退避するものが無い

    const list = listSnapshotSummaries(dir)
    expect(list.ok).toBe(true)
    expect(list.snapshots).toHaveLength(1)
    expect(list.snapshots[0].label).toBe('トップページを直して')
    expect(list.snapshots[0].files).toEqual([
      { path: 'index.html', action: 'overwrite' },
      { path: 'style.css', action: 'create' },
    ])
  })

  it('同じスナップショット内で同じファイルを2回保存しても「作業開始時点」を保つ', () => {
    write('a.txt', 'v0')
    snapshotBeforeWrite(dir, idAt(1), 'a.txt', 'v1', '直して')
    write('a.txt', 'v1')
    snapshotBeforeWrite(dir, idAt(1), 'a.txt', 'v2', '直して') // 同一ターンの2回目
    write('a.txt', 'v2')

    restoreToSnapshot(dir, idAt(1))
    expect(read('a.txt')).toBe('v0') // v1 ではなく、ターン開始時点の v0 に戻る
  })

  it('内容が変わらない保存では履歴を作らない（write_file の最適化）', () => {
    write('a.txt', 'same')
    const r = snapshotBeforeWrite(dir, idAt(1), 'a.txt', 'same')
    expect(r.backedUp).toBe(false)
    expect(listSnapshotSummaries(dir).snapshots).toHaveLength(0)
  })

  it('最終内容が分からない編集（Claudeの Edit）は、変化の有無に関わらず退避する', () => {
    write('a.txt', 'before')
    expect(snapshotBeforeChange(dir, idAt(1), 'a.txt').backedUp).toBe(true)
  })

  it('プロジェクト外を指すパスは拒否する', () => {
    const r = snapshotBeforeWrite(dir, idAt(1), '../outside.txt', 'x')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('プロジェクトの外')
  })
})

describe('その時点の状態に戻す', () => {
  // 友人からの指摘そのもの:「3つ前のデザインに戻したい」
  it('3つ前に戻すと、その後の変更がすべて取り消される', () => {
    write('index.html', 'デザインA')
    aiTurn(idAt(1), '青くして', { 'index.html': 'デザインB' })
    aiTurn(idAt(2), '見出しを大きく', { 'index.html': 'デザインC' })
    aiTurn(idAt(3), '装飾を足して', { 'index.html': 'デザインD', 'extra.css': '.deco{}' })
    expect(read('index.html')).toBe('デザインD')

    // 「青くして」の直前＝デザインA の時点へ
    const r = restoreToSnapshot(dir, idAt(1))
    expect(r.ok).toBe(true)
    expect(read('index.html')).toBe('デザインA')
    // 後のターンで追加されたファイルも、その時点には無かったので消える
    expect(exists('extra.css')).toBe(false)
    expect(r.deleted).toContain('extra.css')
    expect(r.failed).toEqual([])
  })

  // 今回の修正前はここが壊れていた（対象ターンのファイルしか戻さず、新旧が混ざった）
  it('対象ターンが触っていないファイルも、その時点の状態へ戻す', () => {
    write('index.html', 'HTML旧')
    aiTurn(idAt(1), 'HTMLを直して', { 'index.html': 'HTML新' })
    write('style.css', 'CSS旧') // ターン1の後に存在していたCSS
    aiTurn(idAt(2), 'CSSを直して', { 'style.css': 'CSS新' })

    restoreToSnapshot(dir, idAt(1))
    expect(read('index.html')).toBe('HTML旧')
    expect(read('style.css')).toBe('CSS旧') // ← ターン2の変更も取り消される
  })

  it('戻した直後の状態も履歴に残り、戻しすぎをやり直せる', () => {
    write('a.txt', 'v0')
    aiTurn(idAt(1), '一度目', { 'a.txt': 'v1' })
    aiTurn(idAt(2), '二度目', { 'a.txt': 'v2' })

    const back = restoreToSnapshot(dir, idAt(1))
    expect(read('a.txt')).toBe('v0')

    // 「戻す前（v2）」が新しい履歴として残っている
    const undoId = back.preRestoreSnapshotId!
    const summaries = listSnapshotSummaries(dir).snapshots
    expect(summaries[0].id).toBe(undoId) // 新しい順の先頭
    expect(summaries[0].label).toBe('「元に戻す」を実行する直前の状態')

    restoreToSnapshot(dir, undoId)
    expect(read('a.txt')).toBe('v2') // 戻しすぎをやり直せた
  })

  it('一覧に「この時点に戻すと何ファイル変わるか」を出す', () => {
    write('index.html', 'A')
    aiTurn(idAt(1), '一度目', { 'index.html': 'B' })
    aiTurn(idAt(2), '二度目', { 'style.css': 'new' })

    const byId = Object.fromEntries(listSnapshotSummaries(dir).snapshots.map(s => [s.id, s]))
    // 古い方に戻す = index.html を戻し、後から作られた style.css を消す（計2件・うち削除1件）
    expect(byId[idAt(1)]).toMatchObject({ fileCount: 1, restoreCount: 2, deleteCount: 1 })
    // 新しい方に戻す = style.css を消すだけ
    expect(byId[idAt(2)]).toMatchObject({ fileCount: 1, restoreCount: 1, deleteCount: 1 })
  })

  it('サブフォルダのファイルも正しく戻す', () => {
    write('src/js/app.js', '旧')
    aiTurn(idAt(1), '直して', { 'src/js/app.js': '新' })
    restoreToSnapshot(dir, idAt(1))
    expect(read('src/js/app.js')).toBe('旧')
  })

  it('退避ファイルが失われていても、戻せた分は戻し、失敗分を報告する', () => {
    write('a.txt', 'a旧')
    write('b.txt', 'b旧')
    aiTurn(idAt(1), '両方直して', { 'a.txt': 'a新', 'b.txt': 'b新' })
    // 退避ファイルの片方を人為的に削除する（ディスク不調・手動削除の再現）
    fs.rmSync(path.join(dir, BACKUP_DIRNAME, idAt(1), 'a.txt'))

    const r = restoreToSnapshot(dir, idAt(1))
    expect(r.ok).toBe(true)
    expect(r.failed).toEqual(['a.txt'])
    expect(read('b.txt')).toBe('b旧') // もう片方は戻っている
  })

  // CI（高速なLinux）で実際に落ちて見つかったバグ。時計を止めて確実に再現させる。
  // 同一ミリ秒に2回「元に戻す」を実行すると退避先のIDが同じになり、2回目の退避が
  // 1回目の退避内容を上書きして、やり直したい内容が失われていた。
  it('同じミリ秒に2回戻しても、退避内容が上書きされない', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-05T13:00:00.000Z')) // 以降どれだけ処理しても時刻は進まない
      write('a.txt', 'v0')
      aiTurn(idAt(1), '一度目', { 'a.txt': 'v1' })
      aiTurn(idAt(2), '二度目', { 'a.txt': 'v2' })

      const back1 = restoreToSnapshot(dir, idAt(1))
      expect(read('a.txt')).toBe('v0')

      // 1回目とまったく同じ時刻で2回目を実行する
      const back2 = restoreToSnapshot(dir, idAt(2))
      expect(back2.preRestoreSnapshotId).not.toBe(back1.preRestoreSnapshotId) // 退避先が別であること

      // 1回目の退避（v2 が入っている）が生きているので、やり直せる
      restoreToSnapshot(dir, back1.preRestoreSnapshotId!)
      expect(read('a.txt')).toBe('v2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('存在しない履歴を指定したら、何も壊さずエラーを返す', () => {
    write('a.txt', 'v0')
    const r = restoreToSnapshot(dir, idAt(9))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('見つかりません')
    expect(read('a.txt')).toBe('v0')
  })

  it('不正なスナップショットID（パス脱出）を拒否する', () => {
    const r = restoreToSnapshot(dir, '../../etc')
    expect(r.ok).toBe(false)
  })
})

describe('履歴のローテーション', () => {
  it('50件を超えると古いものから消える', () => {
    for (let i = 0; i < 55; i++) {
      write('a.txt', `v${i}`)
      snapshotBeforeWrite(dir, idAt(i), 'a.txt', `v${i + 1}`, `${i}回目`)
      write('a.txt', `v${i + 1}`)
    }
    const snapshots = listSnapshotSummaries(dir).snapshots
    expect(snapshots).toHaveLength(50)
    expect(snapshots[snapshots.length - 1].id).toBe(idAt(5)) // 0〜4 が消えた
  })
})

describe('古い形式との共存', () => {
  it('マニフェストの無いフォルダやファイルは一覧に出さない（旧形式のまま壊れない）', () => {
    fs.mkdirSync(path.join(dir, BACKUP_DIRNAME), { recursive: true })
    fs.writeFileSync(path.join(dir, BACKUP_DIRNAME, 'index.html.2026-07-06T21-15-00-123Z'), '旧形式', 'utf-8')
    fs.mkdirSync(path.join(dir, BACKUP_DIRNAME, idAt(1))) // マニフェスト無しのフォルダ
    expect(listSnapshotSummaries(dir).snapshots).toEqual([])
  })

  it('label の無い履歴（v0.2.86以前）も一覧に出る', () => {
    write('a.txt', 'v0')
    snapshotBeforeWrite(dir, idAt(1), 'a.txt', 'v1') // label 無し
    const s = listSnapshotSummaries(dir).snapshots
    expect(s).toHaveLength(1)
    expect(s[0].label).toBeUndefined()
  })
})

// ── 引き取った直後の「戻れる起点」（④ 第3段階・2026-08-24）────────────────
// 公開されているものを引き取った直後は履歴が1つも無い。そのまま AI に触らせると、
// **公開されていた姿へ戻す手立てが無いまま**作業が始まる。
describe('いま在るものを、そのまま「戻れる起点」にする', () => {
  it('起点へ戻すと、引き取った直後の中身が書き戻る', () => {
    write('public/index.html', '公開されていた中身')
    write('public/images/hero.txt', '画像のかわり')
    const origin = snapshotCurrentFiles(dir, ['public/index.html', 'public/images/hero.txt'], '公開されていたものを引き取った時点')
    expect(origin.ok).toBe(true)
    expect(origin.count).toBe(2)
    expect(origin.snapshotId).toBeTruthy()

    // このあと AI が壊す
    aiTurn(idAt(30), 'デザインを変えて', { 'public/index.html': 'AIが書き換えた' })
    expect(read('public/index.html')).toBe('AIが書き換えた')

    const r = restoreToSnapshot(dir, origin.snapshotId!)
    expect(r.ok).toBe(true)
    expect(read('public/index.html')).toBe('公開されていた中身')
    expect(read('public/images/hero.txt')).toBe('画像のかわり')
  })

  it('起点へ戻しても、引き取ったファイルは消えない（create として記録しない）', () => {
    write('public/index.html', '公開されていた中身')
    const origin = snapshotCurrentFiles(dir, ['public/index.html'], '引き取った時点')
    restoreToSnapshot(dir, origin.snapshotId!)
    expect(exists('public/index.html')).toBe(true)
  })

  it('起点は履歴の一覧に見出しつきで出る', () => {
    write('public/index.html', 'x')
    snapshotCurrentFiles(dir, ['public/index.html'], '公開されていたものを引き取った時点')
    const list = listSnapshotSummaries(dir)
    expect(list.ok).toBe(true)
    expect(list.snapshots[0].label).toBe('公開されていたものを引き取った時点')
    expect(list.snapshots[0].fileCount).toBe(1)
  })

  it('バイナリを壊さない（読み書きではなく写しで残す）', () => {
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01])
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'public/logo.png'), bytes)
    const origin = snapshotCurrentFiles(dir, ['public/logo.png'], '引き取った時点')
    fs.writeFileSync(path.join(dir, 'public/logo.png'), Buffer.from([0x11]))
    restoreToSnapshot(dir, origin.snapshotId!)
    expect(fs.readFileSync(path.join(dir, 'public/logo.png')).equals(bytes)).toBe(true)
  })

  it('プロジェクトの外は残さない（脱出を許さない）', () => {
    write('public/index.html', 'x')
    const r = snapshotCurrentFiles(dir, ['../外のファイル.txt'], '引き取った時点')
    expect(r.ok).toBe(false)
    expect(r.count).toBe(0)
  })

  // イメージの tar にはフォルダの項目も並ぶ。1件でも写そうとすると例外になり、
  // **起点づくりが丸ごと失敗する**（戻れないまま作業が始まる）。
  it('フォルダが紛れても、ファイルの分はちゃんと残る', () => {
    write('public/index.html', '中身')
    const r = snapshotCurrentFiles(dir, ['public', 'public/index.html'], '引き取った時点')
    expect(r.ok).toBe(true)
    expect(r.count).toBe(1)
    write('public/index.html', '壊した')
    restoreToSnapshot(dir, r.snapshotId!)
    expect(read('public/index.html')).toBe('中身')
  })

  it('残すものが1つも無ければ、空の履歴を作らない', () => {
    const r = snapshotCurrentFiles(dir, ['public/ない.html'], '引き取った時点')
    expect(r.ok).toBe(true)
    expect(r.count).toBe(0)
    expect(r.snapshotId).toBeUndefined()
    expect(listSnapshotSummaries(dir).snapshots).toEqual([])
  })
})

// 🕘「元に戻す」の完了を会話に残す1件（0.3.50・roadmap「次の改善2件」その2）。
// 純粋関数なので実ファイルは使わない（fs 系のテストと同じファイルに置いているのは
// restoreToSnapshot と対で読む文脈があるため）。
describe('restoreNoteMessage', () => {
  it('label があれば「◯◯の時点」、件数を埋め込む', () => {
    const msg = restoreNoteMessage({ label: 'トップページを青くして', restored: 3, deleted: 1 })
    expect(msg).toEqual({
      role: 'assistant',
      content: '🕘 「トップページを青くして」の時点までファイルを戻しました（3件を復元・1件を削除。会話はそのまま残っています）',
    })
  })

  it('label が無ければ「選んだ時点」になる', () => {
    const msg = restoreNoteMessage({ label: null, restored: 0, deleted: 2 })
    expect(msg.content).toBe('🕘 選んだ時点までファイルを戻しました（0件を復元・2件を削除。会話はそのまま残っています）')
  })

  it('件数が0でもそのまま埋め込む（該当なしを隠さない）', () => {
    const msg = restoreNoteMessage({ label: null, restored: 0, deleted: 0 })
    expect(msg.content).toContain('0件を復元・0件を削除')
  })

  // toolNote を付けると AI へ送られなくなり（chatTurn.ts の TurnMessage のコメント参照）、
  // 「ディスクと会話を揃える」というこの1件の目的そのものが成立しなくなる。最重要の性質。
  it('toolNote を付けない（AI へ送られる形のまま）', () => {
    const msg = restoreNoteMessage({ label: 'x', restored: 1, deleted: 0 })
    expect('toolNote' in msg).toBe(false)
    expect(msg.role).toBe('assistant')
  })
})
