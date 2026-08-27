import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  flattenVercelTree, stripSingleRoot, isGitBacked, gitSourceHint, vercelCandidates,
  appRunImageRef, appRunSettings, appRunCandidates, pickImageContentRoot,
  importedFilePath, importFolderName, importedRelPathsFromTar,
  historyOriginSkipReason, HISTORY_ORIGIN_MAX_FILES,
  collectManagedTargets, markManagedCandidates, managedNote, type ImportCandidate,
} from '../src/shared/publishImport'

// ④ 公開済みのものを引き取る（2026-08-22 Ryosuke 提案）。
// 実測（dev-plan ④）で確かめた応答の形に合わせて固定する。

describe('Vercel のファイルツリーを平らにする', () => {
  const tree = [{
    name: 'src', type: 'directory', mode: 16749, children: [
      { name: 'README.md', type: 'file', mode: 33206, uid: 'a1acc89' },
      { name: 'images', type: 'directory', children: [{ name: 'hero.jpg', type: 'file', uid: 'bbb' }] },
    ],
  }]

  it('入れ子をたどって、ファイルだけを取り出す', () => {
    expect(flattenVercelTree(tree)).toEqual([
      { path: 'src/README.md', uid: 'a1acc89' },
      { path: 'src/images/hero.jpg', uid: 'bbb' },
    ])
  })

  it('uid の無いもの・ファイル以外は落とす（中身を取れないため）', () => {
    const t = [
      { name: 'a.html', type: 'file', uid: 'x' },
      { name: 'fn', type: 'lambda', uid: 'y' },
      { name: 'b.html', type: 'file' },
      { name: 'link', type: 'symlink', uid: 'z' },
    ]
    expect(flattenVercelTree(t)).toEqual([{ path: 'a.html', uid: 'x' }])
  })

  it('空でも落ちない', () => {
    expect(flattenVercelTree(undefined)).toEqual([])
    expect(flattenVercelTree([])).toEqual([])
  })
})

// ── ⚠️ 2026-08-23 実測で見つかった落とし穴 ────────────────────────────
// Vercel は `src/` で包んで返すが、**Koto は `src/` を付けずに送っている**。
// 剥がさずに取り込むと、余計な階層ができる。
describe('包みの1階層を剥がす', () => {
  it('最上位が単一のディレクトリなら剥がし、その名前を返す', () => {
    const { files, stripped } = stripSingleRoot([
      { path: 'src/README.md', uid: 'a' },
      { path: 'src/images/hero.jpg', uid: 'b' },
    ])
    expect(stripped).toBe('src')
    expect(files).toEqual([{ path: 'README.md', uid: 'a' }, { path: 'images/hero.jpg', uid: 'b' }])
  })

  it('包みの名前を決めつけない（src 以外でも剥がす）', () => {
    const { files, stripped } = stripSingleRoot([{ path: 'dist/index.html', uid: 'a' }])
    expect(stripped).toBe('dist')
    expect(files).toEqual([{ path: 'index.html', uid: 'a' }])
  })

  it('最上位に素のファイルがあれば剥がさない（包みではない）', () => {
    const input = [{ path: 'index.html', uid: 'a' }, { path: 'images/hero.jpg', uid: 'b' }]
    const { files, stripped } = stripSingleRoot(input)
    expect(stripped).toBeNull()
    expect(files).toEqual(input)
  })

  it('最上位のフォルダが2つ以上あれば剥がさない', () => {
    const input = [{ path: 'a/x.html', uid: '1' }, { path: 'b/y.html', uid: '2' }]
    expect(stripSingleRoot(input).stripped).toBeNull()
    expect(stripSingleRoot(input).files).toEqual(input)
  })

  it('空でも落ちない', () => {
    expect(stripSingleRoot([])).toEqual({ files: [], stripped: null })
  })
})

// ── Git 由来の判定は gitSource だけで行う ──────────────────────────────
// 公式が `source` を「推測にすぎず、動作を分岐させるな」と明記している。
describe('Git 由来かどうか', () => {
  it('gitSource があれば Git 由来', () => {
    expect(isGitBacked({ gitSource: { org: 'me', repo: 'site', ref: 'main' } })).toBe(true)
  })

  it('gitSource が無ければファイル直接アップロード（実測どおり）', () => {
    expect(isGitBacked({ uid: 'dpl_x' })).toBe(false)
    expect(isGitBacked(null)).toBe(false)
  })

  it('source フィールドは判定に使わない（あっても左右されない）', () => {
    expect(isGitBacked({ source: 'git' })).toBe(false)
    expect(isGitBacked({ source: 'cli', gitSource: { repo: 'x' } })).toBe(true)
  })

  it('Git 由来なら、どこから取ればよいかを伝える', () => {
    const hint = gitSourceHint({ gitSource: { org: 'me', repo: 'site', ref: 'main' } })
    expect(hint).toContain('me/site')
    expect(hint).toContain('main')
    expect(gitSourceHint({})).toBeNull()
  })
})

describe('Vercel の候補一覧', () => {
  const deployments = [
    { uid: 'dpl_new', name: 'landingtest', projectId: 'prj_1', url: 'a-new.vercel.app', created: 200, state: 'READY', inspectorUrl: 'https://vercel.com/rryosuke/landingtest/new' },
    { uid: 'dpl_old', name: 'landingtest', projectId: 'prj_1', url: 'a-old.vercel.app', created: 100, state: 'READY', inspectorUrl: 'https://vercel.com/rryosuke/landingtest/old' },
    { uid: 'dpl_other', name: 'blog', projectId: 'prj_2', url: 'b.vercel.app', created: 150, state: 'READY', inspectorUrl: 'https://vercel.com/rryosuke/blog/x' },
  ]

  it('同じプロジェクトは最新の1件だけにする（古い版を並べない）', () => {
    const c = vercelCandidates(deployments)
    expect(c).toHaveLength(2)
    expect(c[0].id).toBe('dpl_new')
    expect(c.map(x => x.name)).toEqual(['landingtest', 'blog'])
  })

  it('どこのものかを添える（個人の一覧にチームのものが出るため）', () => {
    expect(vercelCandidates(deployments)[0].note).toContain('rryosuke')
  })

  it('公開が完了していないものは選ばせない', () => {
    const c = vercelCandidates([{ uid: 'd', name: 'x', projectId: 'p', created: 1, state: 'BUILDING' }])
    expect(c[0].blocked).toBeTruthy()
  })

  it('URL は https を付けて返す', () => {
    expect(vercelCandidates(deployments)[0].url).toBe('https://a-new.vercel.app')
  })
})

// ── AppRun（2026-08-22 実測の応答）──────────────────────────────────────
const appDetail = {
  id: '10c655bd', name: 'landingtest', timeout_seconds: 60, port: 8080,
  min_scale: 0, max_scale: 1,
  components: [{
    name: 'main', max_cpu: '1', max_memory: '1Gi',
    deploy_source: { container_registry: { image: 'landingtest.sakuracr.jp/landingtest:v20260821-231947', server: 'landingtest.sakuracr.jp', username: 'sakuraide' } },
    env: [{ key: 'NODE_ENV', value: 'production' }],
    secret: [],
    probe: { http_get: { port: 8080, path: '/' } },
  }],
  status: 'Healthy', public_url: 'https://app-10c655bd.ingress.apprun.sakura.ne.jp',
  created_at: '2026-08-19T08:50:17+09:00',
}

describe('AppRun のアプリ詳細から取り出す', () => {
  it('イメージの参照（タグまで）を取れる', () => {
    expect(appRunImageRef(appDetail)).toEqual({
      image: 'landingtest.sakuracr.jp/landingtest:v20260821-231947',
      server: 'landingtest.sakuracr.jp',
      username: 'sakuraide',
    })
  })

  it('イメージが無ければ null（レジストリ側から辿る合図）', () => {
    expect(appRunImageRef({ components: [{}] })).toBeNull()
    expect(appRunImageRef(null)).toBeNull()
  })

  it('公開の設定も戻せる', () => {
    const s = appRunSettings(appDetail)
    expect(s.port).toBe(8080)
    expect(s.minScale).toBe(0)
    expect(s.maxScale).toBe(1)
    expect(s.maxCpu).toBe('1')
    expect(s.maxMemory).toBe('1Gi')
    expect(s.timeoutSeconds).toBe(60)
    expect(s.probePath).toBe('/')
    expect(s.env).toEqual([{ key: 'NODE_ENV', value: 'production' }])
  })

  // 実測: secret は空配列で返る。**値は戻らない**ので、入れ直しが要ることを伝える
  it('秘密は名前しか拾わない（値は返ってこない）', () => {
    expect(appRunSettings(appDetail).secretKeys).toEqual([])
    const withSecret = { ...appDetail, components: [{ ...appDetail.components[0], secret: [{ key: 'DB_PASSWORD' }] }] }
    expect(appRunSettings(withSecret).secretKeys).toEqual(['DB_PASSWORD'])
  })

  it('一覧を候補に整える（新しい順）', () => {
    const c = appRunCandidates([
      { id: 'a', name: 'old', status: 'Healthy', created_at: '2026-08-01T00:00:00+09:00' },
      { id: 'b', name: 'new', status: 'Healthy', created_at: '2026-08-19T00:00:00+09:00' },
    ])
    expect(c.map(x => x.name)).toEqual(['new', 'old'])
    expect(c[0].target).toBe('sakura-apprun')
  })
})

describe('イメージの中の公開物を探す', () => {
  it('よくある置き場所を前から順に見る', () => {
    expect(pickImageContentRoot(['usr/share/nginx/html/index.html', 'etc/nginx/nginx.conf'])).toBe('usr/share/nginx/html')
    expect(pickImageContentRoot(['app/server.js', 'app/package.json'])).toBe('app')
  })

  it('見つからなければ null（呼び出し側が選ばせる）', () => {
    expect(pickImageContentRoot(['bin/sh', 'lib/ld.so'])).toBeNull()
  })

  it('似た名前に引っかからない（前方一致は区切りまで見る）', () => {
    expect(pickImageContentRoot(['application/x.js'])).toBeNull()
  })
})

describe('置き場所と名前', () => {
  it('公開されていたものは、公開される場所へ置く', () => {
    expect(importedFilePath('public', 'index.html')).toBe('public/index.html')
    expect(importedFilePath('public', 'images/hero.jpg')).toBe('public/images/hero.jpg')
  })

  it('フォルダ名に使えない文字を落とす', () => {
    expect(importFolderName('my/site:v1')).toBe('my-site-v1')
    expect(importFolderName('  landingtest  ')).toBe('landingtest')
  })

  it('名前が空になるときは既定の名前にする', () => {
    expect(importFolderName('')).toBe('imported-project')
    expect(importFolderName('...')).toBe('imported-project')
  })

  // 新規プロジェクトの名前の規則（NAME_OK）と食い違うと、引き取りだけ通って
  // あとの画面（公開名・イメージのタグ）で弾かれる。
  it('新規プロジェクトで使える文字だけにする', () => {
    const ok = /^[A-Za-z0-9._-]+$/
    for (const src of ['わたしのサイト', 'my site', 'shop@2026', 'landing/test:v1']) {
      expect(ok.test(importFolderName(src))).toBe(true)
    }
    expect(importFolderName('my site')).toBe('my-site')
    expect(importFolderName('わたしのサイト')).toBe('imported-project')
  })

  it('新規プロジェクトの画面と同じ規則であること（別々に緩めない）', () => {
    const s = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/components/NewProjectModal.tsx'), 'utf-8')
    expect(s).toContain('const NAME_OK = /^[A-Za-z0-9._-]+$/')
  })
})

// ── 🕘 履歴の起点（④ 第3段階・2026-08-24）──────────────────────────────
describe('イメージから取り込んだファイルの置き場所', () => {
  it('根を剥がして、公開される場所へ置いたときの位置にする', () => {
    expect(importedRelPathsFromTar(
      ['usr/share/nginx/html/index.html', 'usr/share/nginx/html/img/a.png'],
      'usr/share/nginx/html', 'public',
    )).toEqual(['public/index.html', 'public/img/a.png'])
  })

  it('ディレクトリと、根の外のものは数えない', () => {
    expect(importedRelPathsFromTar(
      // 入れ子のディレクトリ（`app/img/`）も混ぜる。これを数えると、
      // 履歴の起点づくりがフォルダを写そうとして失敗する。
      ['app/', 'app/img/', 'app/img/a.png', 'app/server.js', 'etc/nginx/nginx.conf', 'application/x.js'],
      'app', 'public',
    )).toEqual(['public/img/a.png', 'public/server.js'])
  })
})

describe('履歴の起点をつくる上限', () => {
  it('ふつうの大きさなら作る', () => {
    expect(historyOriginSkipReason(18)).toBeNull()
    expect(historyOriginSkipReason(HISTORY_ORIGIN_MAX_FILES)).toBeNull()
  })

  // 8/21 の失敗（黙って先頭8ファイルしか見ない）を繰り返さない。
  it('上限に当たったら、当たった事実と件数を言う', () => {
    const r = historyOriginSkipReason(HISTORY_ORIGIN_MAX_FILES + 1)
    expect(r).toContain(String(HISTORY_ORIGIN_MAX_FILES + 1))
    expect(r).toContain(String(HISTORY_ORIGIN_MAX_FILES))
    expect(r).toContain('取り込んだファイルはそのまま入っています')
  })
})

// ── 配線（ソースを読んで固定。electron に依存するので import できない）─────
// 当て先は呼び出しの形ごと一意に指す（掟10）。
describe('インポートの配線', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

  it('IPC は3点セットが揃っている（main / preload / 型定義）', () => {
    expect(read('src/main/ipc/index.ts')).toContain('registerPublishImportHandlers(deps)')
    const pre = read('src/main/preload.ts')
    for (const m of ['import:list', 'import:inspect', 'import:run', 'import:progress']) expect(pre).toContain(m)
    const dts = read('src/renderer/global.d.ts')
    expect(dts).toContain('onProgress(cb: (message: string) => void): () => void')
  })

  it('判断は共通の純関数に任せ、IPC 側で作り直さない（掟10）', () => {
    const s = read('src/main/ipc/publishImport.ts')
    for (const fn of ['flattenVercelTree(', 'stripSingleRoot(', 'isGitBacked(', 'appRunImageRef(', 'pickImageContentRoot(']) {
      expect(s).toContain(fn)
    }
    // 包みの名前を直書きしない（純関数が決める）
    expect(s).not.toContain("'src/'")
  })

  it('Git 由来のデプロイは取り込まず、どこから取るかを案内する', () => {
    const s = read('src/main/ipc/publishImport.ts')
    expect(s).toContain('if (isGitBacked(detail.data)) {')
    expect(s).toContain('gitBacked: true')
    expect(s).toContain('gitSourceHint(detail.data)')
  })

  it('取り込み先は空のフォルダに限る（既存のものを壊さない）', () => {
    const s = read('src/main/ipc/publishImport.ts')
    expect(s).toContain('fs.readdirSync(args.destDir).length > 0')
  })

  it('取り込んだものは公開される場所（public）へ置く', () => {
    const s = read('src/main/ipc/publishImport.ts')
    expect(s).toContain('importedFilePath(PUBLISH_DIR, f.path)')
    expect(s).toContain("from '../../shared/publishRoot'")
  })

  it('公開先には何も作らない・消さない（読み取りだけ）', () => {
    const s = read('src/main/ipc/publishImport.ts')
    expect(s).not.toContain('createApp')
    expect(s).not.toContain('deleteApp')
    expect(s).not.toContain('createDeployment')
  })

  // 引き取った直後は履歴が1つも無い。**戻れる状態にしてから触らせる。**
  it('取り込んだ直後に 🕘 履歴の起点を作る（両方の公開先で）', () => {
    const s = read('src/main/ipc/publishImport.ts')
    expect(s).toContain("import { snapshotCurrentFiles } from '../backup/store'")
    expect(s).toContain('makeHistoryOrigin(args.destDir, written)') // Vercel
    expect(s).toContain('makeHistoryOrigin(args.destDir, rels)')    // AppRun
    expect(s).toContain("snapshotCurrentFiles(destDir, rels, '公開されていたものをインポートした時点')")
  })

  it('起点は「実際に書けたもの」で作る（失敗したファイルを混ぜない）', () => {
    const s = read('src/main/ipc/publishImport.ts')
    expect(s).toContain('written.push(rel)')
    expect(s).toContain('fileCount: written.length')
  })

  it('起点を作らなかったら、その事実を返す（黙って省かない）', () => {
    const s = read('src/main/ipc/publishImport.ts')
    expect(s).toContain('const skip = historyOriginSkipReason(rels.length)')
    expect(s).toContain('return { historySnapshotId: null, historyNote: skip }')
    expect(read('src/renderer/global.d.ts')).toContain('historyNote?: string | null')
  })

  it('取得系のクライアントは読み取り専用の経路を使う', () => {
    const s = read('src/main/vercel/client.ts')
    // Git 由来を見るために withGitRepoInfo が要る（付けないと gitSource が返らない）
    expect(s).toContain("vercelDeploymentPath(id) + '?withGitRepoInfo=true'")
    expect(s).toContain('async getDeploymentFiles(')
    expect(s).toContain('async getDeploymentFile(')
  })
})

// ── もう手元にあるものに印をつける（2026-08-25 Ryosuke 指摘）────────────────
// 「同じものを2つ持つ理由は無い」。それでも作ってしまうのは**気づけない**からで、
// 気づけば起きない。**止めはしない。気づかせる。**
describe('この Koto が既に公開しているもの', () => {
  const PROJECTS = [
    {
      dir: '/ws/landingTEST', name: 'landingTEST',
      publish: { targets: { 'sakura-apprun': {} } },
      apprunState: { resources: [{ kind: 'apprun-app', id: 'app-1234', stateful: false, key: 'apprun-app:landingtest' }] },
    },
    { dir: '/ws/myshop', name: 'myshop', publish: { vercel: { name: 'my-shop' } }, apprunState: null },
    { dir: '/ws/empty', name: 'empty', publish: null, apprunState: null },
  ]

  it('AppRun は state.json のアプリIDで見分ける（名前ではない）', () => {
    const m = collectManagedTargets(PROJECTS)
    expect(m.apprunAppIds['app-1234']).toEqual({ projectName: 'landingTEST', dir: '/ws/landingTEST' })
  })

  it('Vercel は公開名で見分ける（そこで公開先が決まるため）', () => {
    const m = collectManagedTargets(PROJECTS)
    expect(m.vercelNames['my-shop']).toEqual({ projectName: 'myshop', dir: '/ws/myshop' })
  })

  it('壊れた・空のプロジェクトがあっても落ちない', () => {
    const m = collectManagedTargets([
      null as any, { dir: '', name: '' }, { dir: '/ws/a', name: 'a', apprunState: { resources: 'こわれた' } },
      { dir: '/ws/b', name: 'b', publish: { vercel: { name: 123 } } },
    ])
    expect(m.apprunAppIds).toEqual({})
    expect(m.vercelNames).toEqual({})
  })

  const CANDS: ImportCandidate[] = [
    { target: 'sakura-apprun', id: 'app-1234', name: 'landingtest', url: null, at: null, note: '' },
    { target: 'sakura-apprun', id: 'app-9999', name: 'other', url: null, at: null, note: '' },
    { target: 'vercel', id: 'dpl_1', name: 'my-shop', url: null, at: null, note: '' },
    { target: 'vercel', id: 'dpl_2', name: 'unknown', url: null, at: null, note: '' },
  ]

  it('当てはまるものにだけ印がつく', () => {
    const marked = markManagedCandidates(CANDS, collectManagedTargets(PROJECTS))
    expect(marked[0].managedBy?.projectName).toBe('landingTEST')
    expect(marked[1].managedBy).toBeUndefined()
    expect(marked[2].managedBy?.projectName).toBe('myshop')
    expect(marked[3].managedBy).toBeUndefined()
  })

  // **選ばせないのではない。** 件数も並びも変えず、blocked にもしない。
  it('印をつけるだけで、選べなくはしない', () => {
    const marked = markManagedCandidates(CANDS, collectManagedTargets(PROJECTS))
    expect(marked.length).toBe(CANDS.length)
    expect(marked.map(c => c.id)).toEqual(CANDS.map(c => c.id))
    expect(marked.every(c => !c.blocked)).toBe(true)
  })

  it('手元に何も無ければ、何も変えない', () => {
    const marked = markManagedCandidates(CANDS, collectManagedTargets([]))
    expect(marked.every(c => !c.managedBy)).toBe(true)
  })

  it('一言は、どのプロジェクトかを名指しする', () => {
    expect(managedNote('landingTEST')).toContain('landingTEST')
    expect(managedNote('landingTEST')).toContain('このパソコン')
  })
})

// ── 配線（画面は import できないのでソースを読んで固定。掟10）──────────────
describe('印の配線', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

  it('一覧を取ったら、必ず手元と突き合わせる', () => {
    const s = read('src/renderer/components/ImportFromPublishedPanel.tsx')
    expect(s).toContain('setCandidates(markManagedCandidates(r.candidates, await localTargets()))')
    // 突き合わせずにそのまま入れていた古い形が残っていないこと
    expect(s).not.toContain('setCandidates(r.candidates)')
  })

  it('突き合わせはキーもネットワークも使わない（手元のフォルダを見るだけ）', () => {
    const s = read('src/renderer/components/ImportFromPublishedPanel.tsx')
    expect(s).toContain('window.electronAPI.fs.publishedRecords(parentDir)')
  })

  it('一覧の行と、押す前の確認の両方に出す', () => {
    const s = read('src/renderer/components/ImportFromPublishedPanel.tsx')
    expect(s).toContain('managedNote(c.managedBy.projectName)')      // 一覧の行
    expect(s).toContain('managedNote(selected.managedBy.projectName)') // 確認
  })

  // 気づかせるだけでは行き止まり。**そちらを開ける道**を添える。
  it('そのプロジェクトを開ける', () => {
    const s = read('src/renderer/components/ImportFromPublishedPanel.tsx')
    expect(s).toContain('onCreated(selected.managedBy.dir)')
  })
})
