import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  kindFromImport, buildImportedMeta, importPlanNotes, importDoneNotes, importConsoleLink,
  importedContext, noCandidatesHint,
} from '../src/renderer/importProject'
import { REGISTRY_MONTHLY_YEN } from '../src/shared/cloudCost'

// ④ 公開されているもののインポート・第3段階（画面）。
// 「押す前に何が起きるかを見せる」ことと「記録に何を書くか」を固定する。

describe('何を作ったものかを、取り出した場所から決める', () => {
  it('Vercel のファイル直接アップロードは、静的なサイトしか置けない', () => {
    expect(kindFromImport('vercel', 'src')).toBe('site')
    expect(kindFromImport('vercel', null)).toBe('site')
  })

  it('イメージの app/ は常駐するアプリ、web の置き場所はサイト', () => {
    expect(kindFromImport('sakura-apprun', 'app')).toBe('app')
    expect(kindFromImport('sakura-apprun', 'usr/share/nginx/html')).toBe('site')
    expect(kindFromImport('sakura-apprun', 'var/www/html')).toBe('site')
  })
})

describe('インポートの記録（.sakuraide.json）', () => {
  const base = {
    projectName: 'landingtest',
    importedAt: '2026-08-24T01:00:00.000Z',
  }

  it('どこから・いつのものをインポートしたかを、そのまま残す', () => {
    const meta: any = buildImportedMeta({
      ...base,
      source: {
        target: 'vercel', id: 'dpl_abc', name: 'landingtest',
        url: 'https://landingtest.vercel.app', publishedAt: '2026-08-23T10:00:00.000Z',
        stripped: 'src', fileCount: 18,
      },
    })
    expect(meta.importedFrom).toEqual({
      target: 'vercel', id: 'dpl_abc', name: 'landingtest',
      url: 'https://landingtest.vercel.app', publishedAt: '2026-08-23T10:00:00.000Z',
      importedAt: '2026-08-24T01:00:00.000Z', fileCount: 18, stripped: 'src',
    })
    expect(meta.name).toBe('landingtest')
    expect(meta.target).toBe('vercel')
  })

  // ── Vercel は続けて面倒みられる。ただし**目的で分かれる** ─────────────
  // 間違いの重さが左右で違う。fork のつもりで update になると生きている公開が消える。
  const vercelMeta = (intent: 'update' | 'fork' | 'undecided'): any => buildImportedMeta({
    ...base,
    projectName: 'landingtest-2',
    source: {
      target: 'vercel', id: 'dpl_abc', name: 'landingtest',
      url: 'https://landingtest.vercel.app', publishedAt: '2026-08-23T10:00:00.000Z',
      stripped: 'src', fileCount: 18, intent,
    },
  })

  it('update: 元の公開名を控える（次の公開が同じプロジェクトを更新する）', () => {
    const meta = vercelMeta('update')
    expect(meta.publish.vercel.name).toBe('landingtest')
    expect(meta.publish.targets.vercel).toEqual({
      publishedAt: '2026-08-23T10:00:00.000Z', url: 'https://landingtest.vercel.app',
    })
    expect(meta.importedFrom.intent).toBe('update')
  })

  // ⚠️ ここを間違えると、**生きている公開が消える**。
  it('fork: 公開名は新しいプロジェクト名にする（元を絶対に上書きしない）', () => {
    const meta = vercelMeta('fork')
    expect(meta.publish.vercel.name).toBe('landingtest-2')
    // まだ公開していないので、公開の記録は書かない（幽霊を作らない）
    expect(meta.publish.targets).toBeUndefined()
  })

  it('undecided: 公開先を決めない（③公開の画面で決める）', () => {
    const meta = vercelMeta('undecided')
    expect(meta.publish).toBeUndefined()
    expect(meta.importedFrom.intent).toBe('undecided')
  })

  // ── AppRun は続けて面倒みられない ────────────────────────────────
  // どのアプリかは .sakura-cloud/state.json で決まり、インポートではそれを作れない。
  // ここで公開の記録だけ書くと「📡 公開したもの」に**押しても何も起きない破棄ボタン**が並ぶ。
  it('AppRun は公開の記録を書かない（押しても効かない破棄ボタンを作らない）', () => {
    const meta: any = buildImportedMeta({
      ...base,
      source: {
        target: 'sakura-apprun', id: 'app-1', name: 'landingtest',
        url: 'https://x.apprun.sakura.ne.jp', publishedAt: '2026-08-21T14:19:47.000Z',
        stripped: 'usr/share/nginx/html', fileCount: 6,
        settings: {
          port: 8080, minScale: 0, maxScale: 1, maxCpu: '1', maxMemory: '1Gi',
          timeoutSeconds: 60, env: [{ key: 'NODE_ENV', value: 'production' }],
          probePath: '/', secretKeys: ['DB_PASSWORD'],
        },
      },
    })
    expect(meta.publish).toBeUndefined()
    // 設定は控える（次の公開で入れ直せるように）
    expect(meta.importedFrom.settings.port).toBe(8080)
    expect(meta.importedFrom.settings.secretKeys).toEqual(['DB_PASSWORD'])
  })
})

describe('インポートする前に見せる「このあと起きること」', () => {
  it('Vercel: 何個をどこへ置くか・包みを外すことを伝える', () => {
    const notes = importPlanNotes({
      target: 'vercel', publishDirLabel: '公開されるもの', fileCount: 18, stripped: 'src', intent: 'update',
    })
    expect(notes.some(n => n.includes('18 個') && n.includes('公開されるもの'))).toBe(true)
    expect(notes.some(n => n.includes('src/') && n.includes('外して'))).toBe(true)
  })

  // ⚠️ プロジェクト名（手元のフォルダ名）を変えても、公開先は元のまま。
  // 「landingtest2 にしたのに landingtest が置き換わる」は、言われないと分からない。
  it('update: 置き換わるのがどのプロジェクトかを名指しする', () => {
    const notes = importPlanNotes({
      target: 'vercel', publishDirLabel: '公開されるもの', fileCount: 18,
      publishName: 'landingtest', intent: 'update',
    })
    expect(notes.some(n => n.includes('「landingtest」が**置き換わります**'))).toBe(true)
  })

  it('fork: 元がそのまま残ることを、両方の名前を出して伝える', () => {
    const notes = importPlanNotes({
      target: 'vercel', publishDirLabel: '公開されるもの', fileCount: 18,
      publishName: 'landingtest', intent: 'fork', projectName: 'landingtest-2',
    })
    const line = notes.find(n => n.includes('別の新しい Vercel プロジェクト'))
    expect(line).toContain('「landingtest-2」')
    expect(line).toContain('「landingtest」は、そのまま公開され続けます')
    // 上書きを匂わせない
    expect(notes.some(n => n.includes('置き換わります'))).toBe(false)
  })

  it('undecided: いまは決まらないこと・そのままなら元が残ることを伝える', () => {
    const notes = importPlanNotes({
      target: 'vercel', publishDirLabel: '公開されるもの', fileCount: 1,
      publishName: 'landingtest', intent: 'undecided',
    })
    expect(notes.some(n => n.includes('③公開の画面で決めます'))).toBe(true)
    expect(notes.some(n => n.includes('そのまま残ります'))).toBe(true)
  })

  it('目的を選ぶまでは、公開したときの話をしない', () => {
    const notes = importPlanNotes({ target: 'vercel', publishDirLabel: '公開されるもの', fileCount: 1 })
    expect(notes.some(n => n.includes('置き換わります') || n.includes('別の新しい'))).toBe(false)
  })

  it('Vercel: 包みが無ければ、剥がすとは言わない', () => {
    const notes = importPlanNotes({ target: 'vercel', publishDirLabel: '公開されるもの', fileCount: 3, stripped: null })
    expect(notes.some(n => n.includes('外して'))).toBe(false)
  })

  // ⚠️ 知らずに公開すると**動かないものが出る**。押す前に必ず出す。
  it('AppRun: 秘密は取り戻せないことを、鍵の名前つきで言う', () => {
    const notes = importPlanNotes({
      target: 'sakura-apprun', publishDirLabel: '公開されるもの',
      image: 'landingtest.sakuracr.jp/landingtest:v1', secretKeys: ['DB_PASSWORD', 'API_KEY'],
    })
    expect(notes.some(n => n.includes('秘密の値') && n.includes('DB_PASSWORD') && n.includes('入れ直して'))).toBe(true)
    expect(notes.some(n => n.includes('landingtest.sakuracr.jp/landingtest:v1'))).toBe(true)
  })

  it('AppRun: 秘密が無ければ、入れ直しの話はしない', () => {
    const notes = importPlanNotes({ target: 'sakura-apprun', publishDirLabel: '公開されるもの', secretKeys: [] })
    expect(notes.some(n => n.includes('秘密の値'))).toBe(false)
  })

  // ⚠️ 2026-08-24 Ryosuke 指摘。「別の新しいアプリとして作られます」はシステム側の言い分で、
  // 利用者は「自分のサイトを更新している」と受け取る。それでよい。
  // **言わなければならないのは、アドレスが変わることと費用が増えること。**
  it('AppRun: 手を入れて公開していけると言う（できない話にしない）', () => {
    const notes = importPlanNotes({ target: 'sakura-apprun', publishDirLabel: '公開されるもの' })
    expect(notes.some(n => n.includes('手を入れて公開していけます'))).toBe(true)
    expect(notes.some(n => n.includes('できません'))).toBe(false)
  })

  it('AppRun: アドレスが変わることと、月220円増えることを言う', () => {
    const notes = importPlanNotes({ target: 'sakura-apprun', publishDirLabel: '公開されるもの' })
    expect(notes.some(n => n.includes('アドレス（URL）が変わります'))).toBe(true)
    // 費用の数字は一元定義から取る（掟10）。ここに直書きしない
    expect(notes.some(n => n.includes(`月額${REGISTRY_MONTHLY_YEN}円`))).toBe(true)
    expect(notes.some(n => n.includes('コントロールパネル'))).toBe(true)
    // Vercel の文言と混ぜない
    expect(notes.some(n => n.includes('置き換わります'))).toBe(false)
  })

  it('どちらでも「公開先には何も作らず、何も消さない」を言う', () => {
    for (const target of ['vercel', 'sakura-apprun'] as const) {
      const notes = importPlanNotes({ target, publishDirLabel: '公開されるもの' })
      expect(notes.some(n => n.includes('何も作らず') && n.includes('何も消しません'))).toBe(true)
    }
  })
})

describe('インポートしたあとの知らせ', () => {
  it('戻れる起点ができたことを伝える', () => {
    const notes = importDoneNotes({ fileCount: 18, historySnapshotId: '2026-08-24T01-00-00-000Z' })
    expect(notes[0]).toContain('18 個')
    expect(notes.some(n => n.includes('インポートした時点') && n.includes('戻せます'))).toBe(true)
  })

  // ── 8/21 の失敗（黙って先頭8ファイルしか見ていなかった）を繰り返さない ──
  it('起点を作らなかったときは、その理由を必ず出す', () => {
    const notes = importDoneNotes({ fileCount: 9000, historySnapshotId: null, historyNote: 'ファイルが多いため…' })
    expect(notes.some(n => n === 'ファイルが多いため…')).toBe(true)
  })

  it('取り出せなかったファイルを黙らない', () => {
    const notes = importDoneNotes({ fileCount: 16, failed: ['a.html', 'b.png'] })
    expect(notes.some(n => n.includes('2 件') && n.includes('a.html'))).toBe(true)
  })

  it('起点ができたなら、作れなかった理由は出さない', () => {
    const notes = importDoneNotes({ fileCount: 1, historySnapshotId: 'x', historyNote: '作れませんでした' })
    expect(notes.some(n => n.includes('作れませんでした'))).toBe(false)
  })
})

describe('インポートしたあとの行き先', () => {
  // キーを失くしても、外に生きているものへ辿り着けるようにする（publishStatus.ts の約束）。
  it('公開先の管理画面は publishStatus.ts の一覧から引く（別表を作らない）', () => {
    expect(importConsoleLink('vercel').url).toBe('https://vercel.com/dashboard')
    expect(importConsoleLink('sakura-apprun').label).toBe('📦 さくらのAppRun')
  })
})

// ── AI に何を伝えるか（2026-08-24 Ryosuke 指摘）──────────────────────────
// 記録は残していたのに、**AI には1つも渡していなかった**。AI から見ると
// ふつうに新規作成したプロジェクトと区別がつかない状態だった。
describe('インポートしたことを AI に伝える', () => {
  const vercel = {
    target: 'vercel', id: 'dpl_abc', name: 'landingtest',
    url: 'https://x.vercel.app', publishedAt: '2026-08-23T10:00:00.000Z',
    importedAt: '2026-08-24T01:00:00.000Z', fileCount: 18, stripped: 'src', intent: 'update',
  }
  const apprun = {
    target: 'sakura-apprun', id: 'app-1', name: 'landingtest',
    url: 'https://x.apprun.sakura.ne.jp', publishedAt: '2026-08-21T14:19:47.000Z',
    importedAt: '2026-08-24T01:00:00.000Z', fileCount: 6, stripped: 'app',
    settings: {
      port: 8080, minScale: 0, maxScale: 1, maxCpu: '1', maxMemory: '1Gi', timeoutSeconds: 60,
      env: [{ key: 'NODE_ENV', value: 'production' }, { key: 'API_BASE', value: 'https://例' }],
      probePath: '/', secretKeys: ['DB_PASSWORD', 'API_KEY'],
    },
  }

  it('インポートでなければ、何も足さない（ふつうのプロジェクトの文脈を汚さない）', () => {
    expect(importedContext(undefined)).toBe('')
    expect(importedContext(null)).toBe('')
    expect(importedContext('こわれた値')).toBe('')
  })

  it('自分が作ったものではないこと・勝手に作り直さないことを伝える', () => {
    const c = importedContext(vercel)
    expect(c).toContain('あなたが作ったものではありません')
    expect(c).toContain('頼まれていない作り直し')
    expect(c).toContain('2026-08-24')
    expect(c).toContain('landingtest')
  })

  it('update: 次の公開が上書きになることを伝える', () => {
    const c = importedContext(vercel)
    expect(c).toContain('「landingtest」が**置き換わります**')
    // AppRun の話を混ぜない
    expect(c).not.toContain('別の新しいアプリ')
    expect(c).not.toContain('組み立てたあとの状態')
  })

  // ── 利用者の目的を決めつけない（2026-08-24 Ryosuke 指摘）───────────────
  // それまでは「引っ越し・引き継ぎ」の一択を前提に、上書きになると断定していた。
  it('選んだ目的をそのまま伝え、最初に確かめさせる', () => {
    expect(importedContext(vercel)).toContain('利用者が選んだ目的:')
    expect(importedContext(vercel)).toContain('最初の返事で、この目的で合っているかを一言で確かめてください')
  })

  it('fork: 元が残ることを伝える（上書きの話をしない）', () => {
    const c = importedContext({ ...vercel, intent: 'fork' })
    expect(c).toContain('別の新しい Vercel プロジェクト')
    expect(c).toContain('そのまま公開され続けます')
    expect(c).not.toContain('置き換わります')
  })

  it('undecided: 公開の話になったら確かめるよう伝える', () => {
    const c = importedContext({ ...vercel, intent: 'undecided' })
    expect(c).toContain('公開先はまだ決まっていません')
    expect(c).not.toContain('置き換わります')
  })

  it('目的が記録に無いときは、決めつけず AI に聞かせる', () => {
    const c = importedContext({ ...vercel, intent: undefined })
    expect(c).toContain('まだ分かりません')
    expect(c).toContain('手で編集していたものを Koto へ移す')
    expect(c).not.toContain('利用者が選んだ目的:')
  })

  // ⚠️ 2026-08-24 Ryosuke 指摘。いったん「できません」と書いたが、それが誤りだった。
  // 手を入れて公開すること自体はできるし、利用者はそれを「更新している」と受け取ってよい。
  // 内部で別のアプリになるのはシステム側の言い分。**関係があるのは URL とお金の2つだけ。**
  it('AppRun: できない話にせず、URL とお金の2つを伝えさせる', () => {
    const c = importedContext(apprun)
    expect(c).toContain('このまま手を入れて公開していけます')
    expect(c).not.toContain('できません')
    expect(c).toContain('公開のアドレス（URL）が変わります')
    expect(c).toContain(`月額${REGISTRY_MONTHLY_YEN}円`)
    // 古いほうの片づけ先も言う（放っておくと課金が続く）
    expect(c).toContain('コントロールパネル')
  })

  // ── 「触るな」で終わらせない（同日 Ryosuke 再指摘）─────────────────────
  // 代わりに何をすればよいかを書かないと、AI は無視するか止まる。
  // 一括りにすると、直してよい HTML/CSS まで触らなくなる。
  it('そのまま読めるものは「直してよい」と言い切る', () => {
    const c = importedContext(vercel)
    expect(c).toContain('これが原本')
    expect(c).toContain('頼まれたら遠慮なく直してください')
  })

  it('生成物は、作り直さず・元のソースの有無を確かめる、と行き先まで書く', () => {
    const c = importedContext(vercel)
    expect(c).toContain('作り直さず、必要な箇所だけ慎重に直します')
    expect(c).toContain('組み立て前のソースはお持ちですか')
  })

  it('node_modules は「触るな」ではなく、どこを直せばよいかを書く', () => {
    const c = importedContext({ ...apprun })
    expect(c).toContain('組み立て直しで消える')
    expect(c).toContain('`package.json` と自分のソース')
  })

  it('AppRun: 組み立て後であること・生成物を触らせないことを伝える', () => {
    const c = importedContext(apprun)
    expect(c).toContain('組み立てたあとの状態')
    expect(c).toContain('node_modules')
    expect(c).not.toContain('置き換わります')
  })

  // 秘密が無いことを知らないと、AI は「動かない」原因に辿り着けない。
  it('AppRun: 秘密の値が手元に無いことを、鍵の名前つきで伝える', () => {
    const c = importedContext(apprun)
    expect(c).toContain('DB_PASSWORD, API_KEY')
    expect(c).toContain('手元に値がありません')
    // 勝手に .env を作らせない（作っても値が無いので、動かない原因が増えるだけ）
    expect(c).toContain('`.env` を勝手に作らず')
  })

  // ⚠️ 掟10「秘密の中身を外部AIへ送らない」に倒す。
  // さくらは env と secret を分けているが、利用者が env に秘密を入れていることはありうる。
  it('環境変数は名前だけ渡し、値は渡さない', () => {
    const c = importedContext(apprun)
    expect(c).toContain('NODE_ENV, API_BASE')
    expect(c).not.toContain('production')
    expect(c).not.toContain('https://例')
  })

  it('秘密が無いアプリでは、入れ直しの話をしない', () => {
    const c = importedContext({ ...apprun, settings: { ...apprun.settings, secretKeys: [] } })
    expect(c).not.toContain('手元に値がありません')
  })

  it('🕘 戻せることを伝える（思い切った提案をしてよいと分かるように）', () => {
    expect(importedContext(vercel)).toContain('元へ戻せます')
  })
})

// ── どのキーで探したのかを伝える（2026-08-24 Ryosuke 指摘）───────────────
// キーを複数持っている人には、「見つかりません」の本当の意味が
// **「そのキーからは見えません」**であることが多い。黙ると「公開したものが消えた」に見える。
describe('見つからなかったときの案内', () => {
  it('キーが1つなら、そのキー特有の理由を言う', () => {
    expect(noCandidatesHint('vercel', 1)).toContain('範囲を絞ったトークン')
    expect(noCandidatesHint('sakura-apprun', 1)).toContain('このアカウントに AppRun のアプリがありません')
  })

  it('キーが複数あるなら、ほかのキーを試せることを、残りの数つきで言う', () => {
    const h = noCandidatesHint('vercel', 3)
    expect(h).toContain('2 個あります')
    expect(h).toContain('切り替えると見つかるかもしれません')
    // キーの問題かもしれないのに、「無い」と決めつけない
    expect(h).not.toContain('公開したものがありません')
  })

  it('キーが無いときも落ちない', () => {
    expect(noCandidatesHint('vercel', 0)).toContain('見つかりませんでした')
  })
})

// ── 配線（画面は import できないのでソースを読んで固定。掟10）──────────────
describe('インポートの画面の配線', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

  // 公開の画面に置くと、空プロジェクトを作ってから探すことになり、
  // **機能があること自体に気づけない**（2026-08-22 Ryosuke 指摘）。
  it('入口は新規プロジェクトのダイアログ（公開の画面には置かない）', () => {
    expect(read('src/renderer/components/NewProjectModal.tsx')).toContain('<ImportFromPublishedPanel')
    expect(read('src/renderer/components/PublishModal.tsx')).not.toContain('ImportFromPublishedPanel')
  })

  it('一覧から利用者に選ばせる（名前が同じだけで勝手に紐づけない）', () => {
    const s = read('src/renderer/components/ImportFromPublishedPanel.tsx')
    expect(s).toContain('onClick={() => choose(c)}')
    // 引き取れないものは選ばせない
    expect(s).toContain('disabled={!!c.blocked}')
  })

  it('取り込む前に「このあと起きること」を見せてから押させる', () => {
    const s = read('src/renderer/components/ImportFromPublishedPanel.tsx')
    expect(s).toContain('importPlanNotes({')
    // 実際に書くのは「引き取る」を押してから
    expect(s).toContain('onClick={runImport}')
    expect(s).toContain("await window.electronAPI.import.run({")
  })

  // 同じ名前のプロジェクトが既にある人は、押してから弾かれて打ち直しになっていた。
  it('空いているフォルダ名をあらかじめ入れる', () => {
    const s = read('src/renderer/components/ImportFromPublishedPanel.tsx')
    expect(s).toContain('setName(await freeName(importFolderName(c.name)))')
    // 押したときの守りも残す（先出しは親切であって、砦ではない）
    expect(s).toContain('if (await window.electronAPI.fs.exists(dest)) {')
  })

  it('置き換わる先は「公開先での名前」で伝える（手元のフォルダ名ではない）', () => {
    const s = read('src/renderer/components/ImportFromPublishedPanel.tsx')
    expect(s).toContain('publishName: selected.name,')
    expect(s).not.toContain('publishName: name')
  })

  // 画面の言葉は「インポート」でそろえる（2026-08-24 Ryosuke 指摘）。
  it('画面に「引き取る」が残っていない', () => {
    for (const f of [
      'src/renderer/components/ImportFromPublishedPanel.tsx',
      'src/renderer/importProject.ts',
      'src/renderer/components/NewProjectModal.tsx',
    ]) {
      expect(read(f)).not.toContain('引き取')
    }
  })

  // 間違いの重さが左右で違うので、既定値を置かず選ばせる（2026-08-24 Ryosuke 指摘）。
  it('目的は Vercel のときだけ聞き、選ぶまで押させない', () => {
    const s = read('src/renderer/components/ImportFromPublishedPanel.tsx')
    // 既定値を置かない（fork のつもりが update になると、生きている公開が消える）
    expect(s).toContain('useState<ImportIntent | null>(null)')
    expect(s).toContain("disabled={!name.trim() || !nameOk || !parentDir || (target === 'vercel' && !intent)}")
    // AppRun は同じアプリを更新できないので、選ばせても効かない
    expect(s).toContain("{target === 'vercel' && (")
    // 選び直したときに前の選択を引きずらない
    expect(s).toContain('setIntent(null) // 前に選んだものを引きずらない')
  })

  it('選んだ目的は、記録にも「このあと起きること」にも渡す', () => {
    const s = read('src/renderer/components/ImportFromPublishedPanel.tsx')
    expect(s).toContain('          intent,\n        },')      // buildImportedMeta の source
    expect(s).toContain('              intent,\n              projectName: name.trim(),') // importPlanNotes
  })

  // 黙って1つのキーで探さない（2026-08-24 Ryosuke 指摘）。
  it('どのキーで探しているかを画面に出し、Vercel はその場で切り替えられる', () => {
    const s = read('src/renderer/components/ImportFromPublishedPanel.tsx')
    // 使用中のキーを決め打ちで読む古い形に戻していないこと
    expect(s).not.toContain('await getVercelToken()')
    expect(s).toContain('listVercelTokenEntries()')
    expect(s).toContain('listCloudKeys(), getActiveCloudKeyId()')
    // 切り替えたら探し直す（Vercel はトークンを引数で渡すので副作用が無い）
    expect(s).toContain("void fetchList('vercel', e.target.value, keys)")
    // さくらのクラウドは使用中キーがアプリ全体の設定なので、ここでは切り替えない
    expect(s).toContain('認証情報で切り替える')
    expect(s).not.toContain('activateCloudKey')
  })

  it('見つからないときの案内は純関数に任せる（画面で書き分けない）', () => {
    const s = read('src/renderer/components/ImportFromPublishedPanel.tsx')
    expect(s).toContain('setError(noCandidatesHint(t, list.length))')
  })

  // 記録を残しただけでは AI には届かない（2026-08-24 Ryosuke 指摘）。
  it('インポートの事情は、毎回の依頼の文脈に載せる', () => {
    const s = read('src/renderer/aiContext.ts')
    expect(s).toContain("import { importedContext } from './importProject'")
    expect(s).toContain('const importedFromBlock = importedContext(meta.importedFrom)')
    // 空のときは何も足さない（ふつうのプロジェクトの文脈を汚さない）
    expect(s).toContain("(importedFromBlock ? importedFromBlock +")
    expect(s).toContain(": '') +")
  })

  it('文言と記録は純関数に任せ、画面で作り直さない（掟10）', () => {
    const s = read('src/renderer/components/ImportFromPublishedPanel.tsx')
    for (const fn of ['buildImportedMeta(', 'importPlanNotes(', 'importDoneNotes(', 'importConsoleLink(']) {
      expect(s).toContain(fn)
    }
  })

  it('インポートの最中は閉じさせない（途中で止めると半端なフォルダが残る）', () => {
    const s = read('src/renderer/components/NewProjectModal.tsx')
    expect(s).toContain('onClick={busy || importBusy ? undefined : onClose}')
    expect(s).toContain('{!busy && !importBusy && (')
  })
})
