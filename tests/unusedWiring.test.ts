import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 未使用ファイルの検出＋片づけ（roadmap #18）の配線を固定する。
//
// src/main/ipc/unused.ts・src/main/ipc/index.ts・src/main/preload.ts は electron
// （ipcMain / ipcRenderer）を import しているため、node の vitest からそのまま呼び出せない
// （tests/restoreNoteWiring.test.ts / tests/publishRootWiring.test.ts と同じ事情）。
// ソースを読んで「呼び出しの形そのもの」を固定する（掟10: 「どこかに書いてある」だけでは
// 直し忘れを捕まえられない。呼び出しごと見る）。

const ROOT = path.join(__dirname, '..')
const raw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')
// コメントでの言及だけを拾って誤検知しないよう、コメント行を除く。
const stripped = (rel: string) => raw(rel).split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

describe('3点セット: project:unusedCheck / project:moveToMaterials（main / preload / global.d.ts）', () => {
  it('main（ipc/unused.ts）が2つのハンドラを登録している', () => {
    const src = stripped('src/main/ipc/unused.ts')
    expect(src).toContain("ipcMain.handle('project:unusedCheck', (_, projectDir: string) => checkUnusedFiles(projectDir))")
    expect(src).toContain("ipcMain.handle('project:moveToMaterials', (_, projectDir: string, files: string[]) => moveToMaterialsFs(projectDir, files))")
  })

  it('ipc/index.ts が registerUnusedHandlers を import し、呼んでいる', () => {
    const src = stripped('src/main/ipc/index.ts')
    expect(src).toContain("import { registerUnusedHandlers } from './unused'")
    expect(src).toContain('registerUnusedHandlers()')
  })

  it('preload.ts が fs.unusedCheck / fs.moveToMaterials を、その channel 名で公開している', () => {
    const src = stripped('src/main/preload.ts')
    expect(src).toContain("unusedCheck: (projectDir: string) => ipcRenderer.invoke('project:unusedCheck', projectDir),")
    expect(src).toContain("moveToMaterials: (projectDir: string, files: string[]) => ipcRenderer.invoke('project:moveToMaterials', projectDir, files),")
  })

  it('global.d.ts に unusedCheck / moveToMaterials の型がある（unusedCheck は runtime を含む・roadmap #22）', () => {
    const src = stripped('src/renderer/global.d.ts')
    expect(src).toContain("unusedCheck(projectDir: string): Promise<{ supported: boolean; unused: string[]; runtime: 'static' | 'dynamic' }>")
    expect(src).toContain('moveToMaterials(projectDir: string, files: string[]): Promise<{')
  })
})

describe('未使用ファイルの判定は shared/unusedFiles.ts の一元定義を通す', () => {
  it('ipc/unused.ts が findUnusedFiles / ALWAYS_USED_RE の一元定義を import して使っている（手で並べ直さない）', () => {
    const src = stripped('src/main/ipc/unused.ts')
    expect(src).toContain("import { findUnusedFiles, nextFreeMaterialName, NODE_ALWAYS_USED_RE, PHP_ALWAYS_USED_RE } from '../../shared/unusedFiles'")
    expect(src).toContain('const unused = findUnusedFiles(files,')
  })

  it('checkUnusedFiles は runtime に応じた extraAlwaysUsed を findUnusedFiles へ渡している（roadmap #22）', () => {
    const src = stripped('src/main/ipc/unused.ts')
    // ランタイム判定: detectRuntime（Node）と .php の有無（PHP）の両方を見る
    expect(src).toContain("const isNode = choice.kind !== 'static'")
    expect(src).toContain("const isPhp = files.some(f => /\\.php$/i.test(f))")
    expect(src).toContain("const runtime: UnusedRuntime = (isNode || isPhp) ? 'dynamic' : 'static'")
    // 両方に当てはまれば合成する
    expect(src).toContain("new RegExp(NODE_ALWAYS_USED_RE.source + '|' + PHP_ALWAYS_USED_RE.source, 'i')")
    // findUnusedFiles の呼び出しは3引数目に extraAlwaysUsed を渡す形（呼び出しの形ごと見る）
    expect(src).toContain('}, extraAlwaysUsed ? { extraAlwaysUsed } : undefined)')
    // 戻り値は runtime を含む
    expect(src).toContain('return { supported: true, unused, runtime }')
  })

  it('公開の根（resolvePublishRoot）を通している。securityCheck.ts / migrate.ts と同じ窓口', () => {
    const src = stripped('src/main/ipc/unused.ts')
    expect(src).toContain("import { resolvePublishRoot } from '../publishRootFs'")
    expect(src).toContain('const root = resolvePublishRoot(projectDir) || projectDir')
  })

  it('一覧は projectFilesInfoFs を publishView:true・maxFiles:5000 で直接呼ぶ', () => {
    const src = stripped('src/main/ipc/unused.ts')
    expect(src).toContain('projectFilesInfoFs(root, { maxFiles: UNUSED_CHECK_MAX_FILES, publishView: true })')
    expect(src).toContain('const UNUSED_CHECK_MAX_FILES = 5000')
  })

  it('静的サイト以外を丸ごと対象外にする旧形は無い（roadmap #22 で Node/PHP へ対応を広げた）', () => {
    const src = stripped('src/main/ipc/unused.ts')
    expect(src).toContain("import { detectRuntime } from '../../shared/runtimeDetect'")
    // 旧形（ランタイムで丸ごと対象外にする）へ戻していない
    expect(src).not.toContain("if (choice.kind !== 'static') return { supported: false, unused: [] }")
    // supported は projectDir が不正なときだけ false（ランタイムでは落とさない）
    expect(src).toContain("if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) return { supported: false, unused: [], runtime: 'static' }")
  })
})

describe('moveToMaterialsFs: 守りの配線（isProtectedWritePath を移動元・移動先の両方に通す）', () => {
  it('isProtectedWritePath を import し、移動元・移動先の**両方**に適用している（口ごと見る）', () => {
    const src = stripped('src/main/ipc/unused.ts')
    expect(src).toContain("import { isProtectedWritePath } from '../../shared/protectedPaths'")
    const count = (needle: string) => src.split(needle).length - 1
    expect(count('isProtectedWritePath(')).toBe(2)
    expect(src).toContain('if (isProtectedWritePath(projectRel))')
    expect(src).toContain('if (isProtectedWritePath(destRel))')
  })

  it('同名衝突は全体を拒否せず、nextFreeMaterialName で空いている名前を自動で採る（検証段・実行段の両方）', () => {
    const src = stripped('src/main/ipc/unused.ts')
    expect(src).toContain("import { findUnusedFiles, nextFreeMaterialName, NODE_ALWAYS_USED_RE, PHP_ALWAYS_USED_RE } from '../../shared/unusedFiles'")
    // 呼び出しの形ごと見る（検証段・実行段の両方に同じ形で存在する＝2箇所）
    const count = (needle: string) => src.split(needle).length - 1
    expect(count('const name = nextFreeMaterialName(base, (candidate) => (')).toBe(2)
    // isTaken は「同じ一括内での予約」と「実ディスク」の両方を見る（fs.existsSync を通す）
    expect(count('fs.existsSync(confineToProject(projectDir, `${MATERIALS_DIR}/${candidate}`))')).toBe(2)
    // 実行段: 直前の再確認（レース）で既に存在していたら、拒否せず採り直す
    expect(src).toContain('if (fs.existsSync(t.toFull)) {')
    // 旧形（1件でも衝突すれば全体を throw で拒否する）へ戻していない
    expect(src).not.toContain('同じ名前が既にあります')
    expect(src).not.toContain('移動先の名前が重複します')
  })

  it('🕘 履歴は移動元・移動先の両方を同じスナップショットIDで退避する', () => {
    const src = stripped('src/main/ipc/unused.ts')
    expect(src).toContain('snapshotBeforeChange(projectDir, snapshotId, t.projectRel, label)')
    expect(src).toContain('snapshotBeforeChange(projectDir, snapshotId, t.destRel, label)')
  })

  it('スナップショットIDはここで発行する（呼び出し側に渡させない）', () => {
    const src = stripped('src/main/ipc/unused.ts')
    expect(src).toContain("import { BACKUP_DIRNAME, nextFreeSnapshotId } from '../backup/plan'")
    expect(src).toContain('const snapshotId = nextFreeSnapshotId(')
  })

  it('途中で失敗したら、動かした分を逆順に戻す（半分だけ動いた状態を残さない）', () => {
    const src = stripped('src/main/ipc/unused.ts')
    expect(src).toContain('for (const movedRel of [...moved].reverse())')
  })

  it('移動元の親フォルダが空になったら片づける', () => {
    const src = stripped('src/main/ipc/unused.ts')
    expect(src).toContain('fs.rmdirSync(dir)')
  })

  it('manifest の action 種別は増やしていない（backup/plan.ts の BackupAction を変更しない）', () => {
    // migrate.ts と同じ2エントリ構成（overwrite/create）で畳み込みが成立するため、
    // 新しい action 種別を足す必要はない（tests/backup*.test.ts の厳密比較を壊さない）。
    const plan = raw('src/main/backup/plan.ts')
    expect(plan).toContain("export type BackupAction = 'overwrite' | 'create' | 'pre-restore'")
  })
})

describe('UI: 4パネルへの埋め込み（SecurityCheckSection の隣・同じ位置）', () => {
  const PANELS = [
    'src/renderer/components/PublishModal.tsx',
    'src/renderer/components/AppRunPanel.tsx',
    'src/renderer/components/HanamiiPanel.tsx',
    'src/renderer/components/VercelPanel.tsx',
  ]

  it.each(PANELS)('%s が UnusedFilesSection を import している', (file) => {
    expect(raw(file)).toContain("import UnusedFilesSection from './UnusedFilesSection'")
  })

  // 2026-09-04 Ryosuke 指摘A: 公開画面は番号付きの手順で並んでいるのに、この2節だけ
  // 無番号で浮いて見える。番号体系を持つ3画面（AppRun・HANAMII・Vercel）は stepNo を
  // 渡し、番号体系の無い PublishModal（公開先選択）は渡さない（現状維持）。
  // 呼び出しの形ごと一意に指す（掟10: 「どこかにある」だけでは直し忘れを捕まえられない）。
  const CALLS: Record<string, { sec: string; unused: string }> = {
    'src/renderer/components/PublishModal.tsx': {
      sec: '<SecurityCheckSection projectDir={projectDir} apiKey={apiKey} />',
      unused: '<UnusedFilesSection projectDir={projectDir} />',
    },
    'src/renderer/components/AppRunPanel.tsx': {
      sec: '<SecurityCheckSection projectDir={projectDir} apiKey={apiKey} stepNo="④" />',
      unused: '<UnusedFilesSection projectDir={projectDir} stepNo="⑤" />',
    },
    'src/renderer/components/HanamiiPanel.tsx': {
      sec: '<SecurityCheckSection projectDir={projectDir} apiKey={apiKey} stepNo="③" />',
      unused: '<UnusedFilesSection projectDir={projectDir} stepNo="④" />',
    },
    'src/renderer/components/VercelPanel.tsx': {
      sec: '<SecurityCheckSection projectDir={projectDir} apiKey={apiKey} stepNo="②" />',
      unused: '<UnusedFilesSection projectDir={projectDir} stepNo="③" />',
    },
  }

  it.each(PANELS)('%s で UnusedFilesSection を、その画面の番号体系に合わせて SecurityCheckSection の直後に描画している', (file) => {
    const src = raw(file)
    const { sec, unused } = CALLS[file]
    const secAt = src.indexOf(sec)
    const unusedAt = src.indexOf(unused)
    expect(secAt).toBeGreaterThan(-1)
    expect(unusedAt).toBeGreaterThan(-1)
    // 間に別のセクションを挟んでいない（すぐ隣であること）。150文字あれば
    // コメント＋空行を挟んでも十分で、次のセクション本体までは届かない幅。
    expect(unusedAt - secAt).toBeLessThan(150)
    expect(unusedAt).toBeGreaterThan(secAt)
  })

  // PublishModal は番号体系の無い画面のため stepNo を渡さない（現状維持）。
  it('PublishModal は SecurityCheckSection / UnusedFilesSection に stepNo を渡していない', () => {
    const src = raw('src/renderer/components/PublishModal.tsx')
    expect(src).not.toContain('<SecurityCheckSection projectDir={projectDir} apiKey={apiKey} stepNo=')
    expect(src).not.toContain('<UnusedFilesSection projectDir={projectDir} stepNo=')
  })
})

describe('UI: 公開・破棄まわりの見出し番号（2026-09-04 付番。指摘Aで①②③に続きをずらした）', () => {
  it('AppRunPanel: ⑥ 公開・破棄（旧「④ 公開・破棄」は残っていない）', () => {
    const s = raw('src/renderer/components/AppRunPanel.tsx')
    expect(s).toContain('⑥ 公開・破棄')
    expect(s).not.toContain('④ 公開・破棄')
  })

  it('HanamiiPanel: ⑤ 公開（旧「③ 公開」は残っていない）', () => {
    const s = raw('src/renderer/components/HanamiiPanel.tsx')
    expect(s).toContain('⑤ 公開')
    expect(s).not.toContain('③ 公開')
  })

  it('VercelPanel: ④ 公開（旧「② 公開」は残っていない）', () => {
    const s = raw('src/renderer/components/VercelPanel.tsx')
    expect(s).toContain('④ 公開')
    expect(s).not.toContain('② 公開')
  })
})

describe('UnusedFilesSection: 掟5（UIの文法）', () => {
  const src = () => raw('src/renderer/components/UnusedFilesSection.tsx')

  it('パネルは rounded-xl border border-line bg-surface p-4 のセクション積み', () => {
    expect(src()).toContain('className="rounded-xl border border-line bg-surface p-4 space-y-3"')
  })

  // 2026-09-04 Ryosuke 指摘B: 非対応のときに節ごと消えると、
  // 「動いていないのか、検知できていないのか」利用者に区別が付かない（実機のExpress
  // アプリで「節が出ない＝壊れている？」と受け取られた）。節は常に描画し、対象外なら
  // 理由を書く（移動ボタンだけ出さない）。
  it('非対応（projectDir が不正）でも節ごと消さず、理由を書いて表示する。0件でも常時表示（2026-09-04 Ryosuke 要望）', () => {
    const s = src()
    // 旧形（節ごと消す）へ戻さない
    expect(s).not.toContain('if (!supported) return null')
    expect(s).not.toContain('if (!supported || unused.length === 0) return null')
    // 対象外のときの理由文（旧: 「静的サイトではないため」は roadmap #22 で Node/PHP にも
    // 対応したため無くなった。いまは projectDir が不正なときだけ）
    expect(s).not.toContain('静的サイトではないため')
    expect(s).toContain('いまは確認できません（プロジェクトが選ばれていない可能性があります）')
    expect(s).toContain('⚠️')
    // 0件のときの表示は従来どおり
    expect(s).toContain('✅ すべてのファイルが、どこかのページ・コードから使われています。')
    expect(s).toContain('🧹 使われていないファイルの確認')
    // 対象外のときは移動ボタンを出さない（対象が無いので押せる必要が無い）。
    // ボタンの描画条件が supported を含むことで固定する（対象外では出ない）。
    expect(s).toContain('素材置き場へ移動')
    expect(s).toContain('{supported && unused.length > 0 && (')
  })

  // roadmap #22（2026-09-06）: Node/PHP は実行時にファイル名を組み立てることがあり、
  // 文字列出現だけでは追い切れない。runtime:'dynamic' のときだけ但し書きを出す。
  it('runtime:dynamic のときは一覧の上に但し書きを出す（0件のときは出さない）', () => {
    const s = src()
    expect(s).toContain("runtime === 'dynamic' && (")
    expect(s).toContain('プログラムが動くタイプです')
    // 0件（✅の節）の描画ブロックには但し書きの文言が無い
    const okAt = s.indexOf('✅ すべてのファイルが、どこかのページ・コードから使われています。')
    const dynamicAt = s.indexOf('プログラムが動くタイプです')
    expect(okAt).toBeGreaterThan(-1)
    expect(dynamicAt).toBeGreaterThan(okAt) // 但し書きは0件の分岐より後（unused.length>0の分岐）にある
  })

  it('ファイル名一覧は最初から表示する（隠さない・折りたたみが無い）', () => {
    const s = src()
    // <ul> の描画は unused をそのまま map する（confirm ダイアログ側の slice(0, 8) とは別物）。
    const at = s.indexOf('<ul')
    expect(at).toBeGreaterThan(-1)
    const block = s.slice(at, s.indexOf('</ul>', at))
    expect(block).toContain('{unused.map(f =>')
    expect(block).not.toContain('.slice(') // 一覧を間引いていない＝全件表示
    // 開閉トグル（詳細を隠して押すと開く、の類）を持っていない
    for (const word of ['collapsed', 'expanded', 'showAll', 'setOpen']) expect(s).not.toContain(word)
  })

  it('移動ボタンは window.confirm で確認してから実行する（AppRunPanel の confirm パターン）', () => {
    const s = src()
    const at = s.indexOf('const move = async () => {')
    expect(at).toBeGreaterThan(-1)
    expect(s.slice(at, at + 400)).toContain('window.confirm(')
  })

  it('拒否できない誘導文言を使っていない（確認は「よろしいですか」で1回だけ・選ばせない体裁ではない）', () => {
    const s = src()
    // 移動の可否そのものはユーザー操作（confirmダイアログ）で選べるが、
    // 案内文の中に「キャンセル」等の独自の選択肢を並べていないことを確かめる
    for (const word of ['あとにする', 'しないでおく']) {
      expect(s).not.toContain(word)
    }
  })

  it('失敗時のメッセージは select-text で表示する（掟5）', () => {
    const s = src()
    const at = s.indexOf('{note && <p')
    expect(at).toBeGreaterThan(-1)
    expect(s.slice(at, at + 80)).toContain('select-text')
  })

  it('snapshotOk を読んで表示する（MigrateNotice の「snapshotOk を読まない」抜けを引き継がない）', () => {
    expect(src()).toContain('r.snapshotOk')
  })

  it('マウント時・projectDir が変わったときに自動で調べる（AIを使わない決定論チェックのため）', () => {
    const s = src()
    expect(s).toContain('if (projectDir) void check(projectDir)')
    expect(s).toContain('}, [projectDir, check])')
  })
})
