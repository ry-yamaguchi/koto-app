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
//  C. W-69: blocksProjectDeleteFor（Sidebar.tsx）。専有型（sakura-apprun-dedicated）の
//     資源（公開記録・クラスタ／ASG／LB）が残っている間は、「公開も一緒に破棄する」の
//     チェックの有無に関わらずプロジェクト削除そのものを止める（先に専有型タブの⑥で片づけさせる）。
//     2026-09-27 の再検分で、公開記録（publish.targets）だけでは (a)📡一覧でアプリだけ
//     破棄した後 (b)クラスタだけ作ってまだ公開していない、の2つを見落とすと指摘され、
//     クラスタ・ASG・LB の資源ID（publish.apprunDedicated）も見るよう拡張した。
//  D. W-59: cleanRemoteError（remoteError.ts・認証情報の接続テストと共通の1つ）。ipcRenderer.invoke が付ける
//     英語の頭「Error invoking remote method '…': Error: 」を取り除く。
//  E（2026-09-27 再検分）. isMoveTargetPublished の直し漏れ: public/ が無いプロジェクトの
//     入れ子ファイル（例: css/style.css）も、先頭の段（トップのフォルダ名）で判定する。
//  F（2026-09-27 再検分）. remainingPlacementsNote（Sidebar.tsx）: プロジェクト削除で保存場所が
//     残ることを伝える文。同じ保存場所がプレフィックス違いで2件あっても名前は重複させない。

import { getWorkspaceDir, WORKSPACE_KEY, LEGACY_WORKSPACE_DIRNAME, WORKSPACE_DIRNAME } from '../src/renderer/workspace'
import { isMoveTargetPublished, moveConfirmBody, blocksProjectDeleteFor, remainingPlacementsNote } from '../src/renderer/components/Sidebar'
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
// C. blocksProjectDeleteFor（W-69・2026-09-27・作者決定）
// ─────────────────────────────────────────────────────────────────

describe('blocksProjectDeleteFor（W-69）: 専有型が残っている間はプロジェクト削除を止める', () => {
  it('専有型（sakura-apprun-dedicated）を含むときは true（チェックの有無は見ない＝引数に無い）', () => {
    expect(blocksProjectDeleteFor(['sakura-apprun-dedicated'])).toBe(true)
    expect(blocksProjectDeleteFor(['hanamii', 'sakura-apprun-dedicated'])).toBe(true)
  })

  it('専有型を含まず、専有型の資源IDも無ければ false（共用型・HANAMII だけなら止めない）', () => {
    expect(blocksProjectDeleteFor([])).toBe(false)
    expect(blocksProjectDeleteFor(['sakura-apprun'])).toBe(false)
    expect(blocksProjectDeleteFor(['hanamii', 'vercel', 'sakura-rental'])).toBe(false)
    expect(blocksProjectDeleteFor([], null)).toBe(false)
    expect(blocksProjectDeleteFor([], undefined)).toBe(false)
    expect(blocksProjectDeleteFor([], {})).toBe(false)
    expect(blocksProjectDeleteFor([], { clusterID: null, asgID: null, loadBalancerID: null })).toBe(false)
  })

  // ── 2026-09-27 再検分の指摘3: publish.targets だけでは足りない2つの穴 ──────────────
  // クラスタ・ASG・LB の ID は publish.targets とは別の場所（publish.apprunDedicated）にある。
  it('(a) 📡一覧でアプリだけ破棄した後（pendingPublish は空だが、クラスタの記録が残っている）でも true', () => {
    // apprunDedicated.teardownApp は publish.targets からは消すが、クラスタ・ASG・LB の
    // 記録には触らない（PublishedListModal.tsx の破棄後の文言「クラスタ・ロードバランサ…は
    // 残っています」のとおり）。この状態を偽のAPI応答（state()の戻り値）で再現する。
    expect(blocksProjectDeleteFor([], { clusterID: 'cluster-1', asgID: 'asg-1', loadBalancerID: 'lb-1' })).toBe(true)
  })

  it('(b) ⑤でクラスタを作ったが、⑧でまだアプリを公開していない（pendingPublish は空）ときも true', () => {
    // publish.targets['sakura-apprun-dedicated'] はアプリを公開して初めて書かれる（D-3）。
    // クラスタだけ作った段階では pendingPublish には何も入らない。
    expect(blocksProjectDeleteFor([], { clusterID: 'cluster-2', asgID: null, loadBalancerID: null })).toBe(true)
  })

  it('クラスタ・ASG・LB のどれか1つでも残っていれば true（3つとも消えて初めて false）', () => {
    expect(blocksProjectDeleteFor([], { clusterID: null, asgID: 'asg-only', loadBalancerID: null })).toBe(true)
    expect(blocksProjectDeleteFor([], { clusterID: null, asgID: null, loadBalancerID: 'lb-only' })).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────
// C-2. Sidebar.tsx の配線: deleteProject の先頭ガード・削除ボタンの disabled/title が、
//      blocksProjectDeleteFor(pendingPublish, pendingDedicated) を実際に呼んでいること
//      （2026-09-27 再検分の指摘: 判定だけ直しても、呼び出し側に配線されていなければ効かない）。
// ─────────────────────────────────────────────────────────────────

describe('Sidebar.tsx の配線（W-69・2026-09-27再検分）: pendingDedicated を実際に読み、渡している', () => {
  const sidebarSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'components', 'Sidebar.tsx'), 'utf-8')

  it('削除確認を開くたびに window.electronAPI.apprunDedicated.state(confirmProjDelete) を読み、pendingDedicated へ入れている', () => {
    expect(sidebarSrc).toContain('window.electronAPI.apprunDedicated.state(confirmProjDelete)')
    expect(sidebarSrc).toContain('setPendingDedicated(r ?? null)')
  })

  it('deleteProject の先頭ガードが blocksProjectDeleteFor(pendingPublish, pendingDedicated) を呼ぶ（多層防御の最後の砦）', () => {
    expect(sidebarSrc).toContain('if (blocksProjectDeleteFor(pendingPublish, pendingDedicated)) {')
  })

  it('削除ボタンの disabled・title も blocksProjectDeleteFor(pendingPublish, pendingDedicated) を見る', () => {
    expect(sidebarSrc).toContain('disabled={deletingBusy || blocksProjectDeleteFor(pendingPublish, pendingDedicated)}')
    expect(sidebarSrc).toContain("title={blocksProjectDeleteFor(pendingPublish, pendingDedicated) ? ")
  })

  it('確認ダイアログの赤字ブロックは、pendingPublish が空でも blocksProjectDeleteFor が true なら出る（(b)のケースで見せる文が無いままにしない）', () => {
    expect(sidebarSrc).toContain("{(pendingPublish.length > 0 || blocksProjectDeleteFor(pendingPublish, pendingDedicated)) && (")
  })

  it('専有型の行には、もう teardownScopeNote（「…削除します」）を出さない（W-69再検分の指摘2: 同じ枠で「削除できません」と矛盾していた）', () => {
    expect(sidebarSrc).not.toContain("{t === 'sakura-apprun-dedicated' && (")
    expect(sidebarSrc).not.toContain('<span className="text-ink-muted"><br />{teardownScopeNote(t)}</span>')
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
    expect(newProjectHeaderNote('blank', true)).toBe('空で始めます。あとからチャットで頼めます')
    expect(newProjectHeaderNote('blank', false)).toBe('空で始めます。あとからチャットで頼めます')
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
