import { describe, it, expect, afterEach } from 'vitest'

// ── projectA（サイドバー・新規作成・置き場）担当の、振る舞いを変えた分（掟10）────────────
//
// 文字列一致（grep）ではなく、実際に関数を呼んで振る舞いを固定する。
// 対象:
//  A. W-121: 既定の置き場所 getWorkspaceDir()（新しく入れた人だけ ~/Koto。~/SAKURAIDE が
//     ある人・localStorage に設定がある人はそのまま）。**利用者のプロジェクトを見失わせる
//     危険がある変更**なので、偽のファイルシステムで3通り（無い／SAKURAIDE がある／
//     設定がある）を固定する。既存のフォルダを動かしたり作り直したりしないことも確かめる
//     （fs.exists の確認だけで、fs.mkdir 等は一切呼ばれない）。
//  B. W-23: isMoveTargetPublished / moveConfirmBody（Sidebar.tsx）。public/ が無いプロジェクト
//     直下のファイルは、isInPublishDir だけでは「公開されない側」に誤判定されていた
//     （すでに「公開されるもの」に並んでいるのに「🌐 公開するものへ移動」が出ていた）。
//  C. W-69: projectDeleteBlockOf(...) !== null（teardown/projectDeletePlan.ts。段階3A で Sidebar.tsx の「止めるかを返すだけの薄い関数」から移し、3A-5b でその関数を消した）。専有型（sakura-apprun-dedicated）の
//     資源（公開記録・クラスタ／ASG／LB）が残っている間は、「公開も一緒に破棄する」の
//     チェックの有無に関わらずプロジェクト削除そのものを止める（先に専有型タブの⑥で片づけさせる）。
//     2026-09-27 の再検分で、公開記録（publish.targets）だけでは (a)📡一覧でアプリだけ
//     破棄した後 (b)クラスタだけ作ってまだ公開していない、の2つを見落とすと指摘され、
//     （(a) のアプリだけを消す口は 2026-10-08 に廃止した。(a) の状態は、削除が途中で止まって記録だけ外れた場合の保険として残す）
//     クラスタ・ASG・LB の資源ID（publish.apprunDedicated）も見るよう拡張した。
//  D. W-59: cleanRemoteError（remoteError.ts・認証情報の接続テストと共通の1つ）。ipcRenderer.invoke が付ける
//     英語の頭「Error invoking remote method '…': Error: 」を取り除く。
//  E（2026-09-27 再検分）. isMoveTargetPublished の直し漏れ: public/ が無いプロジェクトの
//     入れ子ファイル（例: css/style.css）も、先頭の段（トップのフォルダ名）で判定する。
//  F（2026-09-27 再検分）. remainingPlacementsNote（teardown/projectDeletePlan.ts。段階3A で Sidebar.tsx から移した）: プロジェクト削除で保存場所が
//     残ることを伝える文。同じ保存場所がプレフィックス違いで2件あっても名前は重複させない。

import { getWorkspaceDir, WORKSPACE_KEY, LEGACY_WORKSPACE_DIRNAME, WORKSPACE_DIRNAME } from '../src/renderer/workspace'
import { isMoveTargetPublished, moveConfirmBody } from '../src/renderer/components/Sidebar'
import { projectDeleteBlockOf, remainingPlacementsNote, type DedicatedResourceIds } from '../src/renderer/teardown/projectDeletePlan'
import type { PublishTargetKind } from '../src/renderer/publishStatus'
import { cleanRemoteError } from '../src/renderer/remoteError'
import { newProjectHeaderNote, newProjectSubmitLabel } from '../src/renderer/components/NewProjectModal'
import { MATERIALS_DIR } from '../src/shared/publishExclude'
import * as fs from 'fs'
import * as path from 'path'

// ─────────────────────────────────────────────────────────────────
// A. getWorkspaceDir（W-121）
// ─────────────────────────────────────────────────────────────────

/** 偽のファイルシステム。呼ばれた fs 操作をすべて記録する（既存フォルダを動かしていないかも見る）。 */
function fakeWindow(opts: { homeDir: string; existingDirs: Set<string> }) {
  const calls: { fn: string; args: unknown[] }[] = []
  return {
    calls,
    win: {
      electronAPI: {
        fs: {
          homeDir: async () => { calls.push({ fn: 'homeDir', args: [] }); return opts.homeDir },
          exists: async (p: string) => { calls.push({ fn: 'exists', args: [p] }); return opts.existingDirs.has(p) },
          // 既存のフォルダを動かしたり作り直したりしてはいけない（呼ばれたら即エラーにする）。
          mkdir: async (...args: unknown[]) => { throw new Error(`getWorkspaceDir が fs.mkdir を呼んだ: ${JSON.stringify(args)}`) },
          rename: async (...args: unknown[]) => { throw new Error(`getWorkspaceDir が fs.rename を呼んだ: ${JSON.stringify(args)}`) },
        },
      },
    },
  }
}

function memoryLocalStorage() {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v) },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { store = {} },
  }
}

afterEach(() => {
  delete (globalThis as any).window
  delete (globalThis as any).localStorage
})

describe('getWorkspaceDir（W-121・2026-09-27）: 新しく入れた人だけ ~/Koto。既存の人は見失わせない', () => {
  it('1. localStorage に設定が無く、~/SAKURAIDE も無い（新しく入れた人）→ 新しい既定 ~/Koto', async () => {
    const home = '/Users/newbie'
    const { win, calls } = fakeWindow({ homeDir: home, existingDirs: new Set() })
    ;(globalThis as any).window = win
    ;(globalThis as any).localStorage = memoryLocalStorage()

    const dir = await getWorkspaceDir()

    expect(dir).toBe(`${home}/${WORKSPACE_DIRNAME}`)
    expect(WORKSPACE_DIRNAME).toBe('Koto')
    // 確かめただけ（exists）で、作成・移動はしていない。
    expect(calls.some(c => c.fn === 'exists' && c.args[0] === `${home}/${LEGACY_WORKSPACE_DIRNAME}`)).toBe(true)
  })

  it('2. localStorage に設定が無いが、~/SAKURAIDE がすでにある（既存の人）→ ~/SAKURAIDE のまま（動かさない）', async () => {
    const home = '/Users/oldtimer'
    const legacy = `${home}/${LEGACY_WORKSPACE_DIRNAME}`
    const { win } = fakeWindow({ homeDir: home, existingDirs: new Set([legacy]) })
    ;(globalThis as any).window = win
    ;(globalThis as any).localStorage = memoryLocalStorage()

    const dir = await getWorkspaceDir()

    expect(dir).toBe(legacy)
    expect(dir).not.toBe(`${home}/${WORKSPACE_DIRNAME}`)
  })

  it('3. localStorage に設定がある（選び直し済み）→ ~/SAKURAIDE の有無に関わらずその設定を使う', async () => {
    const home = '/Users/customized'
    const chosen = '/Volumes/External/my-projects'
    const legacy = `${home}/${LEGACY_WORKSPACE_DIRNAME}`
    const { win, calls } = fakeWindow({ homeDir: home, existingDirs: new Set([legacy]) })
    ;(globalThis as any).window = win
    const ls = memoryLocalStorage()
    ls.setItem(WORKSPACE_KEY, chosen)
    ;(globalThis as any).localStorage = ls

    const dir = await getWorkspaceDir()

    expect(dir).toBe(chosen)
    // 設定があるときは、既定の判定（homeDir/exists）にすら触れない。
    expect(calls.length).toBe(0)
  })

  it('4. ~/SAKURAIDE も設定も無い人がもう一度呼んでも、同じ ~/Koto を指す（作り直しではなく毎回同じ既定）', async () => {
    const home = '/Users/newbie2'
    const { win } = fakeWindow({ homeDir: home, existingDirs: new Set() })
    ;(globalThis as any).window = win
    ;(globalThis as any).localStorage = memoryLocalStorage()

    const first = await getWorkspaceDir()
    const second = await getWorkspaceDir()
    expect(first).toBe(second)
  })
})

// ─────────────────────────────────────────────────────────────────
// B. isMoveTargetPublished / moveConfirmBody（W-23）
// ─────────────────────────────────────────────────────────────────

describe('isMoveTargetPublished（W-23・2026-09-27）: 右クリックメニュー・移動の向き', () => {
  const currentDir = '/Users/x/Koto/myapp'

  it('public/ が無いプロジェクト直下の、除外されていないファイルは「もう公開されている」', () => {
    // これが直った本体。旧実装（isInPublishDir だけ）は false を返し、
    // すでに「公開されるもの」に並ぶ index.html にも「🌐 公開するものへ移動」を出していた。
    const published = isMoveTargetPublished({
      currentDir,
      entryPath: `${currentDir}/index.html`,
      entryName: 'index.html',
      entryIsDir: false,
      hasPublishDir: false,
    })
    expect(published).toBe(true)
  })

  it('public/ が無いプロジェクト直下でも、素材（除外対象）の名前なら「公開されない側」のまま', () => {
    const published = isMoveTargetPublished({
      currentDir,
      entryPath: `${currentDir}/${MATERIALS_DIR}`,
      entryName: MATERIALS_DIR,
      entryIsDir: true,
      hasPublishDir: false,
    })
    expect(published).toBe(false)
  })

  it('public/ がすでにあるプロジェクトでは、直下でも isInPublishDir どおり（public/ の中だけ公開側）', () => {
    const inPublic = isMoveTargetPublished({
      currentDir,
      entryPath: `${currentDir}/public`,
      entryName: 'public',
      entryIsDir: true,
      hasPublishDir: true,
    })
    // 'public' フォルダ自身は「public/ の中」（isInPublishDir の rel === PUBLISH_DIR）として
    // 公開される側に数える（isPublishedTop(name, isDir, true) と同じ判定になる）。
    expect(inPublic).toBe(true)

    const fileInPublic = isMoveTargetPublished({
      currentDir,
      entryPath: `${currentDir}/public/index.html`,
      entryName: 'index.html',
      entryIsDir: false,
      hasPublishDir: true,
    })
    expect(fileInPublic).toBe(true)

    const fileOutsidePublic = isMoveTargetPublished({
      currentDir,
      entryPath: `${currentDir}/notes.txt`,
      entryName: 'notes.txt',
      entryIsDir: false,
      hasPublishDir: true,
    })
    expect(fileOutsidePublic).toBe(false)
  })

  it('ネストしたファイル（depth>0）で public/ がすでにあるときは、isInPublishDir（実際の置き場所）に従う', () => {
    const nestedInPublic = isMoveTargetPublished({
      currentDir,
      entryPath: `${currentDir}/public/assets/logo.png`,
      entryName: 'logo.png',
      entryIsDir: false,
      hasPublishDir: true,
    })
    expect(nestedInPublic).toBe(true)

    const nestedOutsidePublic = isMoveTargetPublished({
      currentDir,
      entryPath: `${currentDir}/${MATERIALS_DIR}/memo.txt`,
      entryName: 'memo.txt',
      entryIsDir: false,
      hasPublishDir: true,
    })
    expect(nestedOutsidePublic).toBe(false)
  })

  // ── 2026-09-27 再検分の指摘: 直し漏れ ──────────────────────────────────
  // public/ が無いプロジェクトでは、入れ子のファイル（例: css/style.css）も
  // ファイル一覧の見出し「公開されるもの」にすでに並ぶ（直下フォルダごと除外されない限り）。
  // ところが旧実装は depth>0 で isInPublishDir に戻ってしまい、これは実フォルダ public/ の
  // 中かしか見ないので常に false ＝「🌐 公開するものへ移動」が出たままだった。押すと
  // public/style.css へ階層を潰して移り、public/ ができて css/ 以外の直下ファイルも
  // 一斉に「公開されないもの」へ移る（副作用に誰も気づけない）。
  // 「素材/memo.txt」だけを試すテストは、除外対象の名前を使っていたため旧実装でも
  // 偶然 false のまま一致しており、この直し漏れを検知できていなかった。
  it('public/ が無いプロジェクトのネストしたファイル（css/style.css）は「もう公開されている」', () => {
    const published = isMoveTargetPublished({
      currentDir,
      entryPath: `${currentDir}/css/style.css`,
      entryName: 'style.css',
      entryIsDir: false,
      hasPublishDir: false,
    })
    expect(published).toBe(true)
  })

  it('public/ が無いプロジェクトでも、入れ子ファイルのトップのフォルダが除外対象（素材置き場）なら「公開されない側」のまま', () => {
    const published = isMoveTargetPublished({
      currentDir,
      entryPath: `${currentDir}/${MATERIALS_DIR}/memo.txt`,
      entryName: 'memo.txt',
      entryIsDir: false,
      hasPublishDir: false,
    })
    expect(published).toBe(false)
  })

  it('public/ が無いプロジェクトのさらに深い入れ子（css/vendor/reset.css）も、トップのフォルダ（css）で判定する', () => {
    const published = isMoveTargetPublished({
      currentDir,
      entryPath: `${currentDir}/css/vendor/reset.css`,
      entryName: 'reset.css',
      entryIsDir: false,
      hasPublishDir: false,
    })
    expect(published).toBe(true)
  })
})

describe('moveConfirmBody（W-23）: public/ を初めて作るときだけ、ほかのファイルへの影響を伝える', () => {
  it('willCreatePublishDir=true のとき、ほかの直下ファイルが公開されなくなる旨を含む', () => {
    const body = moveConfirmBody('index.html', '公開されるもの（public）', true)
    expect(body).toContain('index.html')
    expect(body).toContain('ほかのファイルは公開されなくなります')
  })

  it('willCreatePublishDir=false のときは、その一文を含まない', () => {
    const body = moveConfirmBody('index.html', '公開されるもの（public）', false)
    expect(body).not.toContain('ほかのファイルは公開されなくなります')
    expect(body).toContain('index.html')
  })
})

// ─────────────────────────────────────────────────────────────────
// C. 止めるか＝projectDeleteBlockOf(...) !== null（W-69・2026-09-27・作者決定。止めるかを返すだけの薄い関数は 3A-5b で消えた）
// ─────────────────────────────────────────────────────────────────

// 旧い薄い包みと同じ形で呼ぶ小さな関数（ケースは1件も減らさない）。第2引数を省略する呼び方（undefined）も、そのまま通す。
const blocksDelete = (targets: readonly PublishTargetKind[], dedicated?: DedicatedResourceIds): boolean => projectDeleteBlockOf(targets, dedicated) !== null

describe('止めるか（W-69）: 専有型が残っている間はプロジェクト削除を止める', () => {
  it('専有型（sakura-apprun-dedicated）を含むときは true（チェックの有無は見ない＝引数に無い）', () => {
    expect(blocksDelete(['sakura-apprun-dedicated'])).toBe(true)
    expect(blocksDelete(['hanamii', 'sakura-apprun-dedicated'])).toBe(true)
  })

  it('専有型を含まず、専有型の資源IDも無ければ false（共用型・HANAMII だけなら止めない）', () => {
    expect(blocksDelete([])).toBe(false)
    expect(blocksDelete(['sakura-apprun'])).toBe(false)
    expect(blocksDelete(['hanamii', 'vercel', 'sakura-rental'])).toBe(false)
    expect(blocksDelete([], null)).toBe(false)
    expect(blocksDelete([], undefined)).toBe(false)
    expect(blocksDelete([], {})).toBe(false)
    expect(blocksDelete([], { clusterID: null, asgID: null, loadBalancerID: null })).toBe(false)
  })

  // ── 2026-09-27 再検分の指摘3: publish.targets だけでは足りない2つの穴 ──────────────
  // クラスタ・ASG・LB の ID は publish.targets とは別の場所（publish.apprunDedicated）にある。
  it('(a) 公開記録（publish.targets）は外れたが、クラスタの記録が残っている（pendingPublish は空）ときも true', () => {
    // 以前は 📡 一覧のアプリだけを消す口（廃止）がこの状態を作った。いまは、削除が途中で止まったあとに公開記録だけが外れた場合の保険。
    // 記録が残っているものを置き去りにしてフォルダを消せば、月額を Koto から止められなくなる。この状態を偽のAPI応答（state()の戻り値）で再現する。
    expect(blocksDelete([], { clusterID: 'cluster-1', asgID: 'asg-1', loadBalancerID: 'lb-1' })).toBe(true)
  })

  it('(b) ⑤でクラスタを作ったが、⑧でまだアプリを公開していない（pendingPublish は空）ときも true', () => {
    // publish.targets['sakura-apprun-dedicated'] はアプリを公開して初めて書かれる（D-3）。
    // クラスタだけ作った段階では pendingPublish には何も入らない。
    expect(blocksDelete([], { clusterID: 'cluster-2', asgID: null, loadBalancerID: null })).toBe(true)
  })

  it('クラスタ・ASG・LB のどれか1つでも残っていれば true（3つとも消えて初めて false）', () => {
    expect(blocksDelete([], { clusterID: null, asgID: 'asg-only', loadBalancerID: null })).toBe(true)
    expect(blocksDelete([], { clusterID: null, asgID: null, loadBalancerID: 'lb-only' })).toBe(true)
  })
})


// ─────────────────────────────────────────────────────────────────
// C-2. ProjectDeleteDialog.tsx の配線（段階3A・3A-5a で Sidebar.tsx から移し、3A-5b で押す口を pressProjectDelete に替えた）:
//      押したときの先頭ガード・削除ボタンの disabled・赤い箱が、止める判断（plan.block＝planProjectDeleteTeardown → projectDeleteBlockOf）を実際に見ていること
//      （2026-09-27 再検分の指摘: 判定だけ直しても、呼び出し側に配線されていなければ効かない）。
//      Sidebar は、もう止める判断を持たない。振る舞い（押すと何が起きるか）は tests/projectDeleteDialog*.test.ts が動かして固定する。
// ─────────────────────────────────────────────────────────────────

describe('ProjectDeleteDialog.tsx の配線（W-69・2026-09-27再検分）: 専有型の資源の記録を実際に読み、止める判断に渡している', () => {
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, '')).replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)
  const src = (rel: string) => stripComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8'))
  const dialogSrc = src('src/renderer/components/ProjectDeleteDialog.tsx')
  const sidebarSrc = src('src/renderer/components/Sidebar.tsx')
  const factsSrc = src('src/renderer/teardown/projectDeleteFacts.ts')
  const planSrc = src('src/renderer/teardown/projectDeletePlan.ts')

  it('専有型の記録は、開いたときに材料を読む関数（projectDeleteFacts.ts）が apprunDedicated.state を読んで facts.dedicated に入れ、ダイアログはその材料を 1 回だけ読む', () => {
    expect(factsSrc).toContain('window.electronAPI.apprunDedicated.state(dir)')
    expect(factsSrc).toMatch(/return \{ targets, unreadable, dedicated, placements, running, sharedLeftover, sharedRegistry \}/)
    expect(dialogSrc).toContain('readProjectDeleteFacts(projectDir)')
    expect(dialogSrc.match(/readProjectDeleteFacts\(projectDir\)/g)).toHaveLength(1)
    expect(dialogSrc).toContain('.then(f => { if (!cancelled) setFacts(f) })')
    // ダイアログは専有型の記録を自分では読まない
    expect(dialogSrc).not.toContain('apprunDedicated')
  })

  it('止める判断は plan.block の 1 つ。facts（公開先・専有型の記録・走っている操作）から planProjectDeleteTeardown で作る。読み込みの前は plan が null', () => {
    expect(dialogSrc).toContain('const plan = facts ? planProjectDeleteTeardown(facts) : null')
    expect(dialogSrc).not.toContain('projectDeleteBlockOf')
    expect(sidebarSrc).not.toContain('projectDeleteBlockOf')
    expect(sidebarSrc).not.toContain('planProjectDeleteTeardown')
  })

  it('押したときの先頭ガードが、読み込みの前（plan が null）と plan.block を見る（多層防御の最後の砦）', () => {
    expect(dialogSrc).toContain('if (busy || facts === null || plan === null || plan.block !== null) return')
  })

  it('削除ボタンの disabled も、読み込みの前と plan.block を見る。T121: マウスを乗せたヒント（title）は無い', () => {
    expect(dialogSrc).toContain('disabled={busy || plan === null || plan.block !== null}')
    const button = dialogSrc.slice(dialogSrc.lastIndexOf('<button', dialogSrc.indexOf("'🗑 ゴミ箱に移動'")), dialogSrc.indexOf("'🗑 ゴミ箱に移動'"))
    expect(button).toContain('onClick={press}')
    expect(button).not.toContain('title=')
    expect(dialogSrc).not.toContain('専有型を先に専有型タブの手順6で削除してください')
  })

  it('確認ダイアログの赤字ブロックは、公開先が空でも plan.block があれば出る（(b)のケースで見せる文が無いままにしない）', () => {
    // 2026-10-08 検分: 公開の記録を読めなかったときの注意（facts.unreadable）も、同じ箱の中に単独で出る。共用型の記録だけが残る回（leftoverNote）も。
    expect(dialogSrc).toContain("(shownTargets.length > 0 || facts.unreadable || plan.block !== null || leftoverNote !== '') && (")
  })

  // 2026-10-08 検分: 資源の記録が空で公開記録だけが残っている行（幽霊の行）では、案内先の手順6の削除ボタンが出ない。
  // 行き止まりにしないよう、出口（📡 の「一覧から削除」）も、止める文に添える。T094（3A-5b）: その文は 1 か所（projectDeletePlan.ts の projectDeleteBlockNote）にまとまり、
  // alert の写しは無くなった（赤字と警告ダイアログの 2 か所に同じ長文を書いていた）。
  it('★★ T094: 止める文は projectDeleteBlockNote の 1 か所。旧い長い文（括弧の状況説明・「専有型（さくらのAppRun 専有型）」）はどこにも無い', () => {
    const hint = '手順6の削除ボタンが出ていないときは、📡 公開したもの一覧の「一覧から削除」でその行を消してください。'
    expect(planSrc.split(hint).length - 1, '新しい文は projectDeletePlan.ts に 1 か所').toBe(1)
    expect(dialogSrc, 'ダイアログは文を自分では書かない').not.toContain('一覧から削除')
    expect(sidebarSrc).not.toContain('一覧から削除')
    for (const old of ['専有型タブに手順6の削除ボタンが出ていないとき（削除するものの記録が無く、公開の記録だけが残っているとき）', '専有型（さくらのAppRun 専有型）のリソースが残っているため']) {
      expect(planSrc, old).not.toContain(old)
      expect(dialogSrc, old).not.toContain(old)
    }
    expect(dialogSrc.match(/projectDeleteBlockNote\(/g), '赤い箱の 1 か所（結果の欄は ProjectDeleteResults が描く）').toHaveLength(1)
  })

  it('専有型の行には、「…削除します」と言う旧い案内の行を出さない（W-69再検分の指摘2: 同じ枠で「削除できません」と矛盾していた）', () => {
    expect(dialogSrc).not.toContain("{t === 'sakura-apprun-dedicated' && (")
    expect(sidebarSrc).not.toContain("{t === 'sakura-apprun-dedicated' && (")
  })
})

// ─────────────────────────────────────────────────────────────────
// C-3. remainingPlacementsNote（W-22・2026-09-27再検分）
// ─────────────────────────────────────────────────────────────────

describe('remainingPlacementsNote（W-22）: 保存場所が残ることを伝える文。名前の重複を除く', () => {
  it('保存場所が1つなら、そのまま名前と「月額495円」を出す', () => {
    const note = remainingPlacementsNote([{ bucket: 'koto-data' }])
    expect(note).toContain('保存場所「koto-data」')
    expect(note).toContain('月額495円・税込')
    expect(note).not.toContain('1つにつき')
  })

  it('同じ保存場所をプレフィックス違いで2件持っていても、名前は1回だけ出す', () => {
    const note = remainingPlacementsNote([{ bucket: 'koto-data' }, { bucket: 'koto-data' }])
    // 名前が2回並ばない（「koto-data・koto-data」にならない）。
    expect(note).toContain('保存場所「koto-data」')
    expect(note.match(/koto-data/g)?.length).toBe(1)
  })

  it('別々の保存場所が2つ以上あるときは、名前を並べたうえで「1つにつき」と明記する（合算はしない）', () => {
    const note = remainingPlacementsNote([{ bucket: 'koto-data' }, { bucket: 'other-bucket' }])
    expect(note).toContain('保存場所「koto-data・other-bucket」')
    expect(note).toContain('1つにつき月額495円・税込')
  })
})

// ─────────────────────────────────────────────────────────────────
// D. cleanRemoteError（W-59）
// ─────────────────────────────────────────────────────────────────

describe('cleanRemoteError（W-59・初回案内の接続テストが通る形）: ipcRenderer.invoke の英語の頭を取り除く', () => {
  it('Electron が付ける頭を取り除き、日本語の本文だけを残す', () => {
    const raw = "Error invoking remote method 'sakura:models': Error: APIキーが正しくないようです。コピーし直して貼り付けてください"
    expect(cleanRemoteError(raw)).toBe('APIキーが正しくないようです。コピーし直して貼り付けてください')
  })

  it('頭が無い・形が違う文はそのまま返す（推測で削り過ぎない）', () => {
    expect(cleanRemoteError('インターネット接続を確認してください')).toBe('インターネット接続を確認してください')
  })
})

// ─────────────────────────────────────────────────────────────────
// E. newProjectHeaderNote / newProjectSubmitLabel（W-70）
// ─────────────────────────────────────────────────────────────────

describe('newProjectHeaderNote / newProjectSubmitLabel（W-70・2026-09-27）: まっさらは AI に頼まない', () => {
  it('まっさらは、キーの有無に関わらず「空で始めます」', () => {
    // 2026-10-09 画面の文を短くする（T125）: 「あとからチャットで頼めます」は、下の説明（「あとからAIチャットで…頼んでください」）と重なるので外した。
    expect(newProjectHeaderNote('blank', true)).toBe('空で始めます')
    expect(newProjectHeaderNote('blank', false)).toBe('空で始めます')
  })

  it('まっさら以外は、これまでどおりキーの有無で分かれる', () => {
    expect(newProjectHeaderNote('site', true)).toBe('作成後、チャットでAIが初期ファイルを作ります')
    expect(newProjectHeaderNote('site', false)).toBe('フォルダと雛形を作成します')
    expect(newProjectHeaderNote('app', true)).toBe('作成後、チャットでAIが初期ファイルを作ります')
  })

  it('作成ボタン: まっさらはキーがあっても「フォルダを作成」（AIを呼ばない実際の動きと合わせる）', () => {
    expect(newProjectSubmitLabel('blank', true)).toBe('フォルダを作成')
    expect(newProjectSubmitLabel('blank', false)).toBe('フォルダを作成')
  })

  it('作成ボタン: まっさら以外はキーがあるときだけ「✨ AIで作成」', () => {
    expect(newProjectSubmitLabel('site', true)).toBe('✨ AIで作成')
    expect(newProjectSubmitLabel('site', false)).toBe('フォルダを作成')
  })
})
