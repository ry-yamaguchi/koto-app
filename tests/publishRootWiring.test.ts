import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// 「全経路が同じ根を見ている」ことを固定する（2026-08-20）。
//
// ── なぜこのテストが要るか ────────────────────────────────────────────
// この製品は「公開経路の一部だけ直して穴が空く」事故を**3回**起こしている:
//   2026-08-05 `.sakuraide` 流出（レンタルサーバ経路だけ抜けていた）
//   2026-08-09 `.env` 流出（3経路が独自判定を持っていた）
//   2026-08-14 `.sakuraide.json` 焼き込み（imageBuild が名簿を手で組み直していた）
// いずれも「一元化したモジュールがあるのに、呼ぶ側が部分的に使った」形（掟10）。
//
// 公開の**根**を変える今回は、同じ形の事故がいちばん起きやすい。
// 1つでも直し忘れると「その公開先だけ中身が空」「その公開先だけ古い場所を配る」になる。
//
// これらのファイルは electron に依存していて import できないので、
// **ソースを読んで配線を確かめる**（imageBuildWiring.test.ts と同じ流儀）。

const ROOT = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

/**
 * 根を受け取るべき場所。**配線が済んだものからここへ足す。**
 *
 * `must` はその**呼び出しの形そのもの**を書く。「ファイルのどこかに書いてある」だけでは
 * 直し忘れを捕まえられない（2026-08-20、実際に3経路とも素通りした）。
 * `mustNot` には**直す前の形**を書き、戻されたら落ちるようにする。
 *
 * これで③の配線は全部そろった。**新しい経路を足すときは、必ずここへも足すこと。**
 */
const CONSUMERS: { name: string; file: string; must: string; mustNot: string; viaResolver?: boolean }[] = [
  {
    name: 'AppRun（標準・Docker とも contextAbs を通る）',
    file: 'src/main/ipc/cloud.ts',
    must: 'resolveBuildContext(resolvePublishRoot(projectDir)',
    mustNot: 'resolveBuildContext(projectDir,',
  },
  {
    name: 'Vercel',
    file: 'src/main/ipc/vercel.ts',
    must: 'collectDeployFiles(resolvePublishRoot(projectDir))',
    mustNot: 'collectDeployFiles(projectDir)',
  },
  {
    name: 'HANAMII（ZIP）',
    file: 'src/main/ipc/hanamii.ts',
    must: 'zipProjectToBuffer(root,',
    mustNot: 'zipProjectToBuffer(projectDir,',
  },
  {
    name: 'レンタルサーバ（rsync）',
    file: 'src/renderer/components/PublishModal.tsx',
    must: 'cd "${root}"',
    mustNot: 'cd "${projectDir}"',
  },
  {
    // AI の読み書き・コマンド・プレビューは、ここで渡す基準がすべてを決める。
    // ここが projectDir に戻ると、AI が作ったものが公開されなくなる。
    name: 'AIのファイル操作（executeTool へ渡す基準）',
    file: 'src/renderer/components/ChatPanel.tsx',
    must: 'projectDir: aiRoot ?? projectDir',
    mustNot: '      projectDir,\n      applyFile: onApplyFile,',
  },
  {
    name: 'ターミナルの作業フォルダ',
    file: 'src/renderer/App.tsx',
    must: 'cwd={termDir ?? currentDir}',
    mustNot: 'cwd={currentDir}',
  },
  {
    // Claude の cwd と書き込み範囲。**退避先（projectDir）とは別物**で、
    // 取り違えると 🕘 履歴が公開フォルダの中に入る。
    name: 'Claude頭脳モードの作業フォルダ',
    file: 'src/main/ipc/claude.ts',
    must: 'writeRoot: resolvePublishRoot(projectDir)',
    mustNot: 'writeRoot: projectDir',
  },
  {
    name: '② 試す（実行するもの）',
    file: 'src/renderer/components/WorkflowBar.tsx',
    must: 'cd "${root}"',
    mustNot: 'cd "${projectDir}"',
  },
  {
    // ここがずれると「チェックは通ったのに、公開すると別の中身」になる。
    name: '公開前セキュリティチェックの走査',
    file: 'src/renderer/securityCheck.ts',
    must: 'await resolvePublishRoot(projectDir)',
    mustNot: 'projectFiles(projectDir)\n',
  },
  {
    // 2026-08-20 実機: `main.js` が同じフォルダにあるのに「見つかりません」と出た。
    // 走査の基準がずれると、相対パスの解決が全部おかしくなる。
    name: '見た目チェック（findSiteIssues）の走査',
    file: 'src/main/ipc/cloud.ts',
    must: 'findSiteIssues(resolvePublishRoot(projectDir))',
    mustNot: 'findSiteIssues(projectDir)',
  },
  {
    name: '画像を使う（アプリで使う画像の入り先）',
    file: 'src/renderer/components/ChatPanel.tsx',
    must: "purpose === 'material' ? projectDir : (aiRoot ?? projectDir)",
    mustNot: 'importImageData(projectDir,',
  },
  {
    // 新規プロジェクトも最初からこの形。移行とまったく同じ判断を使う。
    name: '新規プロジェクトの雛形',
    file: 'src/main/ipc/fs.ts',
    must: 'placeInProject(f.path,',
    mustNot: 'path.join(root, f.path)',
    // まだ存在しないプロジェクトを作るので、ディスクを見る窓口は通らない。
    // 代わりに**移行とまったく同じ判断**（placeInProject）を使う。
    viaResolver: false,
  },
]

describe('公開の根（public/）の配線', () => {
  it('根を決める場所は1つだけ（shared/publishRoot.ts）', () => {
    expect(fs.existsSync(path.join(ROOT, 'src/shared/publishRoot.ts'))).toBe(true)
  })

  it('フォルダ名を手で書いている場所が無い（定数を使う）', () => {
    // 名前を直書きすると、変えたときに1箇所だけ古いまま残る。
    const files = ['src/main', 'src/renderer', 'src/shared']
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) { walk(rel); continue }
        if (!/\.(ts|tsx)$/.test(e.name)) continue
        if (rel.endsWith('shared/publishRoot.ts')) continue // 定義元だけは書いてよい
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
        // コメントでの言及は許す。**コード中の文字列リテラル**だけを咎める
        const inCode = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        // 名前を直書きすると、変えたときに1箇所だけ古いまま残る。
        // 2026-08-20 に実際に2度改名した（公開されるもの → サーバーに置くもの → public）。
        // そのとき直書きが1つも無かったので、変更は定数の1行で済んだ。
        if (inCode.some(l => /(['"])public\1/.test(l) && /PUBLISH_DIR|publishRoot/.test(src))) offenders.push(rel)
      }
    }
    files.forEach(walk)
    expect(offenders, `フォルダ名を直書きしている: ${offenders.join(', ')}`).toEqual([])
  })

  it.each(CONSUMERS)('$name が、その呼び出しで根を使っている', ({ file, must }) => {
    expect(read(file), `この形で呼んでいない: ${must}`).toContain(must)
  })

  it.each(CONSUMERS)('$name が、直す前の形へ戻っていない', ({ file, mustNot }) => {
    // 「どこかに publishRoot と書いてある」だけでは直し忘れを捕まえられない。
    // 直す前の呼び出しが残っていたら落とす。
    expect(read(file), `古い呼び出しが残っている: ${mustNot}`).not.toContain(mustNot)
  })

  it('公開の経路が、根をディスクから解決する共通の窓口を通っている', () => {
    // main と renderer に1つずつ。ここを通さずに自前で組み立てると、
    // 「その公開先だけ古い場所を配る」形の穴が空く（掟10）。
    expect(fs.existsSync(path.join(ROOT, 'src/main/publishRootFs.ts'))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, 'src/renderer/publishRootRenderer.ts'))).toBe(true)
    for (const c of CONSUMERS.filter(x => x.viaResolver !== false)) {
      expect(read(c.file), `${c.name} が共通の窓口を通っていない`).toContain('resolvePublishRoot')
    }
  })
})

describe('AIへの指示', () => {
  it('作業フォルダがどこかを伝えている', () => {
    // 伝えないと、AI は古い前提（プロジェクト直下）で書こうとして毎回エラーになる。
    const src = read('src/renderer/aiContext.ts')
    expect(src).toContain('PUBLISH_DIR')
    expect(src).toContain('あなたの作業フォルダ')
  })

  it('素材フォルダには触れないことを伝えている', () => {
    // 素材は作業フォルダの外にある。触れると信じたまま失敗すると、
    // 利用者には理由の分からないエラーだけが見える。
    expect(read('src/renderer/aiContext.ts')).toContain('あなたは触れません')
  })
})

describe('Claude頭脳モード: 作業フォルダと退避先を取り違えない', () => {
  it('退避（🕘 履歴）はプロジェクト直下を基準にする', () => {
    // ここを作業フォルダにすると、履歴が`public/` の中に入ってしまう。
    const agent = read('src/main/claude/agent.ts')
    // **呼び出しの側**を見る。関数の定義（`function makePreToolUseHook(projectDir: string`）にも
    // 同じ文字列があるので、そこに当たると中身が変わっても気づけない
    //（2026-08-20、実際に素通りした）。
    expect(agent).toContain("hooks: [makePreToolUseHook(projectDir, snapshotId, snapshotLabel)]")
    expect(agent).toContain("hooks: [makePostToolUseHook(projectDir, onFileWritten)]")
    expect(agent).toContain('cwd: writeRoot')
    expect(agent).toContain('canUseTool: makeCanUseTool(writeRoot)')
  })

  it('委譲の書き込みも、書き込みは作業フォルダ・退避はプロジェクト直下', () => {
    const tools = read('src/main/claude/tools.ts')
    // 書き込み先。`relForBackup` の行にも同じ式が出るので、代入ごと見る。
    expect(tools).toContain('const full = path.join(writeRoot, f.path)')
    expect(tools).toContain('const relForBackup = path.relative(projectDir, path.join(writeRoot, f.path))')
    expect(tools).toContain('snapshotBeforeWrite(projectDir, snapshotId, relForBackup')
  })
})

describe('移行（既存プロジェクトを新しい形へ）', () => {
  it('移す前に 🕘 履歴のスナップショットを取る', () => {
    // Koto 自身の安全網。これが無いと、強制で移したあと戻す手段が無い。
    expect(read('src/main/ipc/migrate.ts')).toContain('snapshotBeforeChange(projectDir, snapshotId, name')
  })

  it('途中で失敗したら、移した分を元へ戻す', () => {
    // 半分だけ移った状態を残さない。
    const src = read('src/main/ipc/migrate.ts')
    expect(src).toContain('for (const name of [...moved].reverse())')
    expect(src).toContain('restored')
  })

  it('空になったフォルダを片づける（「移行済み」と誤判定されないように）', () => {
    expect(read('src/main/ipc/migrate.ts')).toContain('fs.rmdirSync(dest)')
  })

  it('移行でファイルが動いたら、開いているタブを閉じる', () => {
    // 古い場所を指したまま保存すると、移したファイルが元の場所に復活する
    //（2026-07-11 の stale tab 事故と同じ形）。
    expect(read('src/renderer/App.tsx')).toContain('onProjectFilesMoved={() => {')
    expect(read('src/renderer/components/ChatPanel.tsx')).toContain('onProjectFilesMoved?.()')
  })

  it('外へ出るコマンドは、止めずに確認だけ出す', () => {
    const src = read('src/renderer/aiTools.ts')
    // **requiresConfirmation の中**を見る。confirmReason にも同じ呼び出しがあるので、
    // 単に `leavesWorkingDir(cmd)` を探すと素通りする（2026-08-20、実際に素通りした）。
    expect(src).toContain('isSensitiveCommand(cmd) || leavesWorkingDir(cmd)')
    // requiresConfirmation に足す＝確認が出る。拒否の一覧（isDangerousCommand）には足さない。
    expect(read('src/shared/commandGuard.ts')).toContain('export function leavesWorkingDir')
    expect(src).not.toContain('isDangerousCommand(cmd) || leavesWorkingDir')
  })
})

describe('移行の案内', () => {
  it('会話の中ではなく、常に見える場所に出す', () => {
    // 会話のいちばん上に置くと、やり取りが多いプロジェクトではスクロールの外に行き、
    // 「実装されていないように見える」（2026-08-20 実機で発生）。
    const src = read('src/renderer/components/ChatPanel.tsx')
    const notice = src.indexOf('<MigrateNotice')
    const list = src.indexOf("{messages.filter(m => !m.hidden).map(")
    const input = src.indexOf('placeholder="メッセージを入力…"')
    expect(notice).toBeGreaterThan(list)   // 会話の描画より後ろ＝スクロール領域の外
    expect(notice).toBeLessThan(input)     // 入力欄より前＝すぐ目に入る
  })

  it('拒否させない（ボタンは1つだけ）', () => {
    // コメントには「押したあとでも戻せる」等の説明が入るので、**画面に出る文字だけ**を見る。
    const src = read('src/renderer/components/MigrateNotice.tsx')
    const ui = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect((ui.match(/<button/g) ?? []).length, 'ボタンが複数ある＝選ばせている').toBe(1)
    for (const word of ['キャンセル', 'あとにする', 'しない', 'よろしいですか']) {
      expect(ui, `選ばせる言い方が入っている: ${word}`).not.toContain(word)
    }
  })

  it('移したあと、開いているタブを閉じる', () => {
    // 古い場所を指したままのタブを保存すると、移したファイルが元の場所に復活する
    // （2026-07-11 の stale tab 事故と同じ形）。
    expect(read('src/renderer/App.tsx')).toContain('onProjectFilesMoved')
    expect(read('src/renderer/components/ChatPanel.tsx')).toContain('onProjectFilesMoved?.()')
  })
})

describe('移行したあと、根を取り直す', () => {
  // 2026-08-20 実機: 移行しても projectDir は変わらないので、根を取り直す効果が動かず、
  // 「② 試す」が実行方法を見つけられず、ターミナルも古い場所のままだった。
  it('プロジェクトの形が変わった合図を上げている', () => {
    const app = read('src/renderer/App.tsx')
    expect(app).toContain('onProjectFilesMoved')
    expect(app).toContain('setTreeRefresh(n => n + 1)')
  })

  it('根を取り直す効果が、その合図を見ている', () => {
    expect(read('src/renderer/App.tsx')).toContain('}, [currentDir, treeRefresh])')
    expect(read('src/renderer/components/WorkflowBar.tsx')).toContain('}, [projectDir, refreshKey])')
  })

  it('合図が WorkflowBar まで届いている', () => {
    // `refreshKey={treeRefresh}` は Sidebar にもあるので、**その行だけ**では
    // 片方を消しても通ってしまう（2026-08-20、実際に素通りした）。渡し先ごと見る。
    expect(read('src/renderer/App.tsx')).toContain('<WorkflowBar\n          projectDir={currentDir}\n          refreshKey={treeRefresh}')
  })
})

describe('プロジェクトを走査するものは、すべて根から', () => {
  // 「一部だけ直して穴が空く」形をここでまとめて止める（掟10）。
  it.each([
    ['環境変数のキー検出（HANAMII）', 'src/main/ipc/hanamii.ts', 'detectEnvKeysInProject(resolvePublishRoot(projectDir))'],
    ['データの使い方（AppRun）', 'src/main/ipc/cloud.ts', "scanDataUsage(resolvePublishRoot(String(projectDir || '')))"],
    ['データの使い方（Vercel）', 'src/main/ipc/vercel.ts', 'scanDataUsage(resolvePublishRoot(projectDir))'],
    ['公開前セキュリティチェック', 'src/renderer/securityCheck.ts', 'await resolvePublishRoot(projectDir)'],
  ])('%s', (_name, file, must) => {
    expect(read(file)).toContain(must)
  })
})
