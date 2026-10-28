import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canTrash, fileOpVerdict, isRecordName, KOTO_RECORD_NAMES, type FileOpProbe, type FileOpVerdict } from '../src/shared/trashGuard'
import { KOTO_INTERNAL_DIRS, KOTO_INTERNAL_FILES } from '../src/shared/publishExclude'
import { DATA_LAYER_LOCAL_DIR } from '../src/shared/objectStorage'

// ── 2026-08-20 セキュリティ点検 ──────────────────────────────────────
// `fs:trash` は**どんな絶対パスでも**ゴミ箱へ送れる作りだった。
// いまは画面側の守り（contextIsolation / sandbox / dangerouslySetInnerHTML なし /
// eval なし）で到達する道は無いが、1枚目の守りに頼り切らない。

const HOME = '/Users/taro'

describe('ゴミ箱へ送ってよい場所', () => {
  it('★★ ホームの外は送れない', () => {
    for (const p of ['/', '/Applications', '/System/Library', '/etc/passwd', '/Users/hanako/x/y']) {
      expect(canTrash(HOME, p).ok).toBe(false)
    }
  })

  it('★★ ホーム直下は送れない（Library・作業フォルダ自体を守る）', () => {
    for (const p of [HOME, `${HOME}/Library`, `${HOME}/SAKURAIDE`, `${HOME}/Documents`]) {
      expect(canTrash(HOME, p).ok).toBe(false)
    }
  })

  it('★★ プロジェクトとその中身は送れる（狭めすぎない）', () => {
    // プロジェクトごと削除する機能があるので、プロジェクト自体も送れる必要がある
    expect(canTrash(HOME, `${HOME}/SAKURAIDE/landingTEST`).ok).toBe(true)
    expect(canTrash(HOME, `${HOME}/SAKURAIDE/landingTEST/images/a.jpg`).ok).toBe(true)
    // 作業フォルダを変えている人もいる
    expect(canTrash(HOME, `${HOME}/Documents/koto/myapp`).ok).toBe(true)
  })

  it('★★ `..` を含む道は受けない', () => {
    expect(canTrash(HOME, `${HOME}/SAKURAIDE/../../etc/passwd`).ok).toBe(false)
  })

  it('★ 断るときは理由をそのまま出せる文にする', () => {
    const r = canTrash(HOME, '/etc/passwd')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('ホームフォルダの中')
  })
})

describe('配線', () => {
  const fsIpc = readFileSync(join(__dirname, '..', 'src/main/ipc/fs.ts'), 'utf-8')

  // fs:trash が canTrash を通ること（home は os.homedir()＝$HOME を尊重。app.getPath('home') は macOS で $HOME を見ないため、
  // e2e の HOME 隔離時に fs:homeDir 側の home とズレる〔2026-09-02 実測〕）は、ソースの文字列ではなく、本物の登録を通して
  // tests/fsTrashHandlers.test.ts が固定する（0.6.24 E。以前ここにあった文字列一致は、振る舞いのテストに置き換えた）。

  it('★★ fs:homeDir は $HOME を尊重する os.homedir() を返す', () => {
    expect(fsIpc).toContain("ipcMain.handle('fs:homeDir', () => os.homedir())")
    expect(fsIpc).not.toContain("ipcMain.handle('fs:homeDir', () => app.getPath('home'))")
  })
})

// ── 強制終了で権限が上がったまま残らないようにする（2026-08-20 点検）────────
describe('権限の上げっぱなしを残さない', () => {
  const cloud = readFileSync(join(__dirname, '..', 'src/main/ipc/cloud.ts'), 'utf-8')

  it('★★ 上げる前に印を残す（途中で落ちても分かるように）', () => {
    const at = cloud.indexOf('async function withDeletePermission')
    const block = cloud.slice(at, at + 3000)
    expect(block).toContain('opts.markElevated(true)')
    expect(block).toContain('if (restored) opts.markElevated(false)')
  })

  it('★★ 印は state に残す（アプリを閉じても消えない）', () => {
    expect(cloud).toContain('meta.registryElevatedAt = new Date().toISOString()')
    expect(cloud).toContain('delete meta.registryElevatedAt')
  })

  it('★★ 次に片づけを始めるとき、まず戻す', () => {
    const at = cloud.indexOf('if (state.meta?.registryElevatedAt)')
    expect(at).toBeGreaterThan(0)
    expect(cloud.slice(at, at + 900)).toContain("permission: 'readwrite'")
  })

  it('★ 上げられなかったときは印を残さない', () => {
    const at = cloud.indexOf('削除のための権限に変更できませんでした')
    expect(cloud.slice(Math.max(0, at - 300), at)).toContain('opts.markElevated(false)')
  })
})

// ── 0.6.24 E-1（T-E1）: ゴミ箱・名前の変更の対象が何か ───────────────────────────────────────────────
// 純関数。fs は読まない（probe を差し込む）。記録の名前は、書き下した表と一元定義（publishExclude.ts）を突き合わせる。

describe('★★★ T-E1 記録の名前（書き下した表と、一元定義の突き合わせ）', () => {
  it('★★★ 記録の名前は4つ（`.koto-data` は入れない）。一元定義に新しい管理領域が増えたら、ここが落ちて、守りに入れるか決めさせる', () => {
    expect([...KOTO_RECORD_NAMES].sort()).toEqual(['.sakura-cloud', '.sakuraide', '.sakuraide-backup', '.sakuraide.json'])
    expect(KOTO_RECORD_NAMES).not.toContain(DATA_LAYER_LOCAL_DIR)
    expect(DATA_LAYER_LOCAL_DIR).toBe('.koto-data')
  })

  it('一元定義（KOTO_INTERNAL_DIRS・KOTO_INTERNAL_FILES）の、`.koto-data` を除いた全部が入っている', () => {
    for (const n of [...KOTO_INTERNAL_DIRS, ...KOTO_INTERNAL_FILES]) {
      expect(isRecordName(n), n).toBe(n !== DATA_LAYER_LOCAL_DIR)
    }
  })

  it('★★ 大文字小文字を区別しない（`.SAKURAIDE.JSON`・`.Sakura-Cloud`）。似た名前は記録ではない', () => {
    for (const n of ['.SAKURAIDE.JSON', '.Sakura-Cloud', '.SAKURAIDE-BACKUP', '.Sakuraide']) expect(isRecordName(n), n).toBe(true)
    for (const n of ['sakuraide.json', '.sakuraide.json.bak', '.sakura-cloud2', '.env', 'public', '.koto-data', '.KOTO-DATA', '']) expect(isRecordName(n), n).toBe(false)
  })
})

type Spy = { calls: string[] }
/** 呼ばれた口を記録する偽の probe。`over` で答えを差し替える。 */
function probeOf(over: Partial<FileOpProbe> = {}): FileOpProbe & Spy {
  const calls: string[] = []
  const base: FileOpProbe = {
    kindOfSelf: () => 'dir',
    hasProjectMarker: () => false,
    childDirs: () => [],
  }
  const p = { ...base, ...over }
  return {
    calls,
    kindOfSelf: () => { calls.push('kindOfSelf'); return p.kindOfSelf() },
    hasProjectMarker: c => { calls.push(`marker:${c ?? ''}`); return p.hasProjectMarker(c) },
    childDirs: () => { calls.push('childDirs'); return p.childDirs() },
  }
}
const verdict = (path: string, probe: FileOpProbe): FileOpVerdict => fileOpVerdict({ segments: path.split('/').filter(Boolean), probe })

describe('★★★ T-E1 fileOpVerdict の表', () => {
  it('★★★ 記録は断る（.sakura-cloud・.SAKURA-CLOUD・x/.sakura-cloud/env.json・.sakuraide.json・.sakuraide-backup/1/a）。fs は1回も読まない', () => {
    for (const p of [
      '/h/SAKURAIDE/p/.sakura-cloud', '/h/SAKURAIDE/p/.SAKURA-CLOUD', '/h/SAKURAIDE/p/x/.sakura-cloud/env.json',
      '/h/SAKURAIDE/p/.sakuraide.json', '/h/SAKURAIDE/p/.sakuraide-backup/1/a', '/h/SAKURAIDE/p/.sakuraide/chat.json',
    ]) {
      const probe = probeOf()
      expect(verdict(p, probe), p).toBe('record')
      expect(probe.calls, p).toEqual([]) // 名前だけで決まる（読まない）
    }
  })

  it('★★ 通すもの: public/index.html・.koto-data/x・.env（ファイル）は plain', () => {
    for (const p of ['/h/SAKURAIDE/p/public/index.html', '/h/SAKURAIDE/p/.koto-data/x', '/h/SAKURAIDE/p/.env']) {
      expect(verdict(p, probeOf({ kindOfSelf: () => 'other' })), p).toBe('plain')
    }
    // フォルダの `.koto-data` も、中にプロジェクトが無ければ plain
    expect(verdict('/h/SAKURAIDE/p/.koto-data', probeOf())).toBe('plain')
  })

  it('★★★ 直下に記録がある → project。直下の子のどれかが project → workspace。どちらでもない → plain', () => {
    expect(verdict('/h/SAKURAIDE/p', probeOf({ hasProjectMarker: c => c === undefined }))).toBe('project')
    expect(verdict('/h/Documents/koto', probeOf({ childDirs: () => ['a', 'b', 'c'], hasProjectMarker: c => c === 'b' }))).toBe('workspace')
    expect(verdict('/h/Documents/koto', probeOf({ childDirs: () => ['a', 'b'] }))).toBe('plain')
    // 自分に印があっても、子を調べる（R2-c）。子に印が無ければ project のまま
    const probe = probeOf({ hasProjectMarker: c => c === undefined, childDirs: () => ['a'] })
    expect(verdict('/h/SAKURAIDE/p', probe)).toBe('project')
    expect(probe.calls).toContain('childDirs')
    expect(probe.calls).toContain('marker:a')
  })

  it('★★★ R2-c 自分に印があっても、直下の子に印があれば workspace（印は、開いたフォルダで公開先を選ぶだけで書かれる）。子が調べられなければ unknown。どちらも無ければ project', () => {
    // 自分に印（''）・子 b に印
    expect(verdict('/h/Documents/koto', probeOf({ childDirs: () => ['a', 'b'], hasProjectMarker: c => c === undefined || c === 'b' }))).toBe('workspace')
    // 自分に印・子の一覧が読めない → unknown（project と答えない）
    expect(verdict('/h/Documents/koto', probeOf({ childDirs: () => 'unknown', hasProjectMarker: c => c === undefined }))).toBe('unknown')
    // 自分に印・子の1つが調べられず、ほかの子に印は無い → unknown
    expect(verdict('/h/Documents/koto', probeOf({ childDirs: () => ['a', 'b'], hasProjectMarker: c => (c === undefined ? true : c === 'b' ? 'unknown' : false) }))).toBe('unknown')
    // 自分に印・子の1つが調べられなくても、別の子に印があれば workspace
    expect(verdict('/h/Documents/koto', probeOf({ childDirs: () => ['a', 'b'], hasProjectMarker: c => (c === undefined ? true : c === 'a' ? 'unknown' : true) }))).toBe('workspace')
    // 自分に印・子にフォルダが無い／印の無い子だけ → project
    expect(verdict('/h/SAKURAIDE/p', probeOf({ childDirs: () => [], hasProjectMarker: c => c === undefined }))).toBe('project')
    expect(verdict('/h/SAKURAIDE/p', probeOf({ childDirs: () => ['public', 'images'], hasProjectMarker: c => c === undefined }))).toBe('project')
    // 自分の印が調べられなければ、子は見ずに unknown
    expect(verdict('/h/x', probeOf({ hasProjectMarker: () => 'unknown', childDirs: () => ['a'] }))).toBe('unknown')
  })

  it('ファイル・リンク（other）・無いもの（missing）は中を調べず plain', () => {
    for (const k of ['other', 'missing'] as const) {
      const probe = probeOf({ kindOfSelf: () => k })
      expect(verdict('/h/SAKURAIDE/p/a.txt', probe)).toBe('plain')
      expect(probe.calls).toEqual(['kindOfSelf'])
    }
  })

  it('★★★ 調べられなかった（unknown）は、どの段でも unknown。plain に倒さない', () => {
    expect(verdict('/h/x', probeOf({ kindOfSelf: () => 'unknown' }))).toBe('unknown')
    expect(verdict('/h/x', probeOf({ hasProjectMarker: () => 'unknown' }))).toBe('unknown')
    expect(verdict('/h/x', probeOf({ childDirs: () => 'unknown' }))).toBe('unknown')
    // 子の1つが調べられず、ほかの子は project でない → unknown
    expect(verdict('/h/x', probeOf({ childDirs: () => ['a', 'b'], hasProjectMarker: c => (c === 'b' ? 'unknown' : false) }))).toBe('unknown')
    // 子の1つが調べられなくても、別の子が project なら workspace（より具体的に言う。どちらも断る）
    expect(verdict('/h/x', probeOf({ childDirs: () => ['a', 'b'], hasProjectMarker: c => (c === 'a' ? 'unknown' : c === 'b') }))).toBe('workspace')
  })

  it('★★★ probe が投げても unknown（呼び手の約束が破れた回も、通さない）', () => {
    const boom = () => { throw new Error('EIO') }
    for (const over of [{ kindOfSelf: boom }, { hasProjectMarker: boom }, { childDirs: boom }] as Partial<FileOpProbe>[]) {
      expect(verdict('/h/x', probeOf(over))).toBe('unknown')
    }
  })
})
