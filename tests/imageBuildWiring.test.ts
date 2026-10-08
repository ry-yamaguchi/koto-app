import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { excludedFileNames, excludedDirNames, servedExcludedFileNames, BUILD_CONFIG_FILES, isSecretFile } from '../src/shared/publishExclude'
import { copyTree } from '../src/main/cloud/imageBuild'

/**
 * 文字列の位置。**-1（＝その文字列が無い）はここで落とす。**
 *
 * ── なぜ要るか（2026-09-25 検分・実証済み）──────────────────────────────
 * `expect(source.indexOf(a)).toBeLessThan(source.indexOf(b))` は、a が**消えた**ときに
 * `-1 < （b の位置）` で**常に真**になる。つまり守りが消えた瞬間に、それを見張る検査が
 * いちばん静かに通る。位置を比べる前に必ず -1 を弾く。
 */
function at(body: string, needle: string, why: string): number {
  const i = body.indexOf(needle)
  expect(i, why).toBeGreaterThan(-1)
  return i
}

// 2026-08-14 実機で発覚。公開したアプリのURLを開くと、`.sakuraide.json` が
// ブラウザから読めていた（静的配信だったため一覧に出た）。
//
// 原因は imageBuild.ts が除外リストを**手で並べ直していた**こと:
//   const EXCLUDE_NAMES = new Set([...excludedDirNames(), ...NOISE_FILES])
// ファイル側は NOISE_FILES しか足しておらず、KOTO_INTERNAL_FILES が抜けていた。
//
// publishExclude.ts は **まさにこれを防ぐために作った**モジュールである
// （2026-08-05 の `.sakuraide` 流出・2026-08-09 の `.env` 流出と同じ構造）。
// それでも同じ穴が空いた。imageBuild.ts は electron に依存していて import できないので、
// **ソースを読んで、手で並べ直していないことを確かめる**。
//
// 掟10「一元化したことと、全経路が実際にそこを通っていることは別」。

const SRC = path.join(__dirname, '..', 'src', 'main', 'cloud', 'imageBuild.ts')

describe('公開イメージの除外リスト', () => {
  const source = fs.readFileSync(SRC, 'utf-8')

  it('フォルダとファイルの両方を、一元定義から取っている', () => {
    const line = source.split('\n').find(l => l.includes('const EXCLUDE_NAMES'))
    expect(line).toBeDefined()
    // 2026-08-19: 公開経路は publishExcludedDirNames（素材フォルダも外れる）を使う
    expect(line!).toContain('publishExcludedDirNames()')
    // 2026-08-20: **配信されるもの**を集めるので、ビルド用の設定も外す版を使う。
    // servedExcludedFileNames は excludedFileNames を丸ごと含む（下の検査で固定）。
    expect(line!).toContain('servedExcludedFileNames()')
  })

  it('配信用の除外が、通常の除外を丸ごと含んでいる（部分的に使わない）', () => {
    // 「一元化したモジュールがあっても、呼ぶ側が部分的に使えば穴は空く」（掟10）。
    for (const f of excludedFileNames()) expect(servedExcludedFileNames().has(f)).toBe(true)
  })

  it('ビルド用の設定ファイルが、配信されるものから外れている', () => {
    // 2026-08-20 実測: /Dockerfile /nginx.conf /.dockerignore が公開URLから読めていた。
    for (const f of ['Dockerfile', 'nginx.conf', '.dockerignore']) {
      expect(servedExcludedFileNames().has(f), `${f} が配信されてしまう`).toBe(true)
      expect(BUILD_CONFIG_FILES as readonly string[]).toContain(f)
    }
  })

  it('一元定義に、Koto の内部ファイルが入っている', () => {
    expect(excludedFileNames().has('.sakuraide.json')).toBe(true)
    expect(excludedFileNames().has('.DS_Store')).toBe(true)
  })

  it('一元定義に、Koto の内部フォルダと重いフォルダが入っている', () => {
    for (const name of ['.sakuraide', '.sakuraide-backup', '.sakura-cloud', '.git', 'node_modules']) {
      expect(excludedDirNames().has(name)).toBe(true)
    }
  })

  // ⚠️ ここは `expect(source).toContain('isSecretFile')` だけだった（2026-09-25 検分で実証）。
  // `isSecretFile` は **import 行**（ファイル先頭）にも出るので、copyTree の
  // `|| isSecretFile(e.name)` を丸ごと消しても緑のままだった。
  // **除外している行そのもの**を一意に指す（振る舞いの網は下の「偽のプロジェクトを実際に複製する」）。
  it('★★ 秘密ファイルの判定を、除外の行で実際に呼んでいる（import 行では通さない）', () => {
    at(source, 'EXCLUDE_NAMES.has(e.name) || isSecretFile(e.name)', '複製をスキップする行で isSecretFile を呼んでいない')
  })
})

// ── 秘密ファイルの流出を、振る舞いで固定する（2026-09-25 検分・掟10）──────────────
//
// 上の2件はどちらも **imageBuild.ts の文字列を読むだけ**だった。そして実際に、
// `|| isSecretFile(e.name)` を丸ごと落としても 20件すべて緑になった
// （`isSecretFile` が import 行に出るため）。**ソースを読む検査は、守りが消えたことを
// いちばん静かに見逃す。**
//
// `.env` が公開物に入る事故は 2026-08-05（`.sakuraide` 流出）・2026-08-09（`.env` 流出）・
// 2026-08-14（`.sakuraide.json` が公開URLから読めた）と**3回**起きている。
// ここでは偽のプロジェクトを実際に作り、`copyTree` に複製させて、
// **複製先に秘密ファイルが1件も無いこと**を見る。
describe('★★★ 秘密ファイルは公開イメージへ複製されない（偽のプロジェクトを実際に複製する）', () => {
  let tmp = ''
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koto-imagebuild-secret-')) })
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 消せなくてもよい */ } })

  /** 複製先にあるものを、根からの相対パスで全部並べる。 */
  function walk(dir: string, prefix = ''): string[] {
    const out: string[] = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel))
      else out.push(rel)
    }
    return out.sort()
  }

  /** 公開イメージに**絶対に入ってはいけない**もの（名前は SECRET_FILE_PATTERNS が唯一の定義）。 */
  const SECRETS = ['.env', '.env.local', '.env.production', 'id_rsa', 'server.pem', 'client.p12', '.netrc']

  it('★★★ .env・秘密鍵・証明書は、複製先に1件も無い（全階層）', () => {
    const src = path.join(tmp, 'project')
    const dest = path.join(tmp, 'stage-app')
    fs.mkdirSync(path.join(src, 'public', 'assets'), { recursive: true })
    fs.writeFileSync(path.join(src, 'server.js'), 'console.log(1)\n')
    fs.writeFileSync(path.join(src, 'public', 'index.html'), '<!doctype html><h1>ok</h1>')
    fs.writeFileSync(path.join(src, 'public', 'assets', 'logo.png'), Buffer.from([0x89, 0x50]))
    for (const name of SECRETS) fs.writeFileSync(path.join(src, name), 'SAKURA_SECRET=ほんもの\n')
    // **下の階層にもある**（全階層で外れること。浅いところだけ見ていると素通りする）
    fs.writeFileSync(path.join(src, 'public', '.env'), 'DEEP_SECRET=1\n')
    fs.writeFileSync(path.join(src, 'public', 'assets', 'id_rsa'), 'PRIVATE KEY\n')
    // Koto の内部ファイル（2026-08-14 に公開URLから読めていたもの）も一緒に見る
    fs.writeFileSync(path.join(src, '.sakuraide.json'), '{}')

    copyTree(src, dest)

    // ① 複製されたものを**全部**数え上げる（「入っていないはず」ではなく「これだけ」）
    expect(walk(dest)).toEqual(['public/assets/logo.png', 'public/index.html', 'server.js'])
    // ② 名指しでも見る（①の比較が緩くなっても落ちる）
    for (const rel of [...SECRETS, 'public/.env', 'public/assets/id_rsa', '.sakuraide.json']) {
      expect(fs.existsSync(path.join(dest, rel)), `${rel} が公開イメージへ複製されている`).toBe(false)
    }
    // ③ 中身が1バイトも出ていないこと（名前を変えて複製する形もここで落ちる）
    for (const rel of walk(dest)) {
      expect(fs.readFileSync(path.join(dest, rel), 'latin1')).not.toContain('SAKURA_SECRET')
    }
  })

  it('★★★ 除外の判定は、一元定義（isSecretFile）と同じ範囲である', () => {
    // 「ここだけ手で並べ直す」が過去3回の事故の形（掟10）。名前の集合そのものを突き合わせる。
    for (const name of SECRETS) expect(isSecretFile(name), `${name} を秘密と見ていない`).toBe(true)
    // 公開鍵・ふつうのファイルまで消していないこと（奪いすぎも事故）
    for (const name of ['id_rsa.pub', 'server.js', 'environment.js', 'index.html']) {
      expect(isSecretFile(name), `${name} を秘密と見てしまっている`).toBe(false)
    }
  })

  it('★★ 普通のファイルは、ちゃんと複製されている（全部消す変異で緑にしない）', () => {
    const src = path.join(tmp, 'p2')
    const dest = path.join(tmp, 'd2')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'server.js'), 'console.log(1)\n')
    fs.writeFileSync(path.join(src, '.env'), 'SECRET=1\n')

    copyTree(src, dest)

    expect(walk(dest)).toEqual(['server.js'])
  })
})

describe('起動方法の配線', () => {
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc', 'cloud.ts'), 'utf-8')

  // static 決め打ちに戻ると、Node のアプリでソースが丸見えになる
  it('内蔵ビルダーの呼び出しで、ランタイムを決め打ちしていない', () => {
    expect(ipc).not.toContain("runtime: 'static'")
    expect(ipc).toContain('detectRuntime')
  })

  it('動かせないと分かったら、公開せずに理由を返す', () => {
    expect(ipc).toContain("choice.kind === 'unsupported'")
  })
})

// 2026-08-14 実機。公開したアプリが起動せず、AppRun のログにこう出た:
//   Error: EACCES: permission denied, open '/app/koto-data.js'
//
// 手元の `koto-data.js` が `-rw-------`（0600）だった。`fs.copyFileSync` は
// **元の権限を引き継ぐ**ので、そのままイメージへ入り、コンテナの Node が
// 自分のファイルを読めずに落ちた。
//
// **原因は手元の権限なのに、症状は容器の中で出る。** 画面には「デプロイに失敗」
// としか出ず、ログを開くまで辿り着けない。手元がどうであれ、配るものは
// 誰でも読める形に揃える。
describe('公開イメージのファイル権限', () => {
  const source = fs.readFileSync(SRC, 'utf-8')

  // 最初は `chmod 0644` と固定で書いた。Ryosuke の点検で改めた（2026-08-14）:
  //   ・0755 の実行可能ファイルが 0644 になり、**実行できなくなる**（奪いすぎ）
  //   ・0400 の読み取り専用に**書き込みを与えてしまう**（与えすぎ）
  // 要るのは「コンテナの中の誰かが読めること」だけ。ビット単位で足すだけにする。
  // D-13 A（2026-09-16）: ファイルは「読みを足すだけ」から、
  // **「読みを足し、グループと他人の書き込みを落とす」**（`(mode | 0o444) & ~0o022`）へ変えた。
  // 足すだけではスティッキービットと合わせても「配ったものは変わらない」と言えない
  // （消して置き換えは防げるが、その場の上書きは防げない）。
  it('読みを足す（ファイル）', () => {
    expect(source).toContain('0o444')
  })

  // D-8（2026-09-16 実機・0.6.19-rc.1・専有型）。ランタイムログの全文:
  //   Error: EACCES: permission denied, mkdir '/app/data'
  // **専有型のコンテナは uid 951:gid 951 で動く**（マニュアル 技術概要「コンテナ実行環境仕様」）。
  // フォルダが `0o555`（読む・辿るだけ）だと、アプリは**自分のデータフォルダすら作れず**、
  // 1分ごとに再起動を繰り返す。**同じ像で共用型では動いていた**（共用型の uid は未確認なので、
  // 「root だから書けていた」とは書かない）。
  // **振る舞いの検査は tests/imageBuildPermissions.test.ts**（実際にコピーして mode を見る／
  // `stageAndTar` を通して layer.tar のヘッダの mode を見る）。
  // ここは「0o555 に戻っていないこと」だけをソースで固定する。
  // 2026-09-16 Ryosuke さんの問いで `0o777` → **`0o1777`**（スティッキービット）にした。
  // `0o777` だと像に最初から入っているファイルを**消して置き換え**られる（削除できるかは
  // 親フォルダの権限で決まるため、ファイルを 0o444 にしても防げない）。
  // スティッキーなら「新しく作るのは誰でもできるが、他人が作ったものは消せない」になる。
  it('★★ フォルダには書き込みとスティッキービットを足す（0o555 に戻すと EACCES で再起動を繰り返す・0o777 だと像のファイルを差し替えられる）', () => {
    expect(source).toContain('addPermission(destDir, 0o1777)')
    expect(source).not.toContain('addPermission(destDir, 0o555)')
    // 直す前の形（スティッキー無し）に戻っていないこと
    expect(source).not.toContain('addPermission(destDir, 0o777)')
  })

  it('権限を固定で上書きしない（実行ビットを落とさない）', () => {
    expect(source).not.toMatch(/chmodSync\([^,]+,\s*0o644\)/)
    expect(source).not.toMatch(/chmodSync\([^,]+,\s*0o755\)/)
    // 足す形になっていること
    expect(source).toMatch(/mode \| bits/)
  })

  // ⚠️ ここは `source.indexOf('isSecretFile')` を **-1 で守らずに** `toBeLessThan` へ渡していた
  // （2026-09-25 検分で実証）。当たっていたのは imageBuild.ts:20 の **import 行**で、import は
  // ファイル先頭なので `fs.copyFileSync` より必ず前にある＝**同語反復**。
  // 実証: `if (EXCLUDE_NAMES.has(e.name) || isSecretFile(e.name)) continue` から
  // `|| isSecretFile(e.name)` を落としても 20件すべて緑だった。
  // `.env` が公開物に入る事故は 2026-08-05・08-09・08-14 と3回起きている（掟10）。
  it('★★ 秘密ファイルは、権限を触る前に除外されている（除外の行そのものを指す）', () => {
    const guard = at(source, 'EXCLUDE_NAMES.has(e.name) || isSecretFile(e.name)', '秘密ファイルの除外が無い')
    const copy = at(source, 'fs.copyFileSync', '複製（copyFileSync）が見つからない')
    // 順序が逆だと「複製してから除外」になり、一瞬でも秘密が複製される
    expect(guard, '除外より先に複製している').toBeLessThan(copy)
  })

  it('権限を変えられなくても、公開そのものは止めない', () => {
    const start = at(source, 'function addPermission', 'addPermission が見つからない')
    expect(source.slice(start, start + 400)).toContain('catch')
  })
})

// ── 未確認の「所有者は root」を、説明として作り直さない（検分の指摘・2026-09-16・掟1）──────
//
// D-8 の是正の中で、スティッキービットの効き目の説明として
// 「像の中のファイルの所有者は root で、コンテナは uid 951 で動くので…」という断定を
// **新しく1つ増やしていた**。同じ文書群は共用型について「実行ユーザが未確認だから
// 『root だから書けていた』とは書かない」と決めたばかりで、そこで消した未確認の root 因果を
// 別の場所で復活させた形である。しかも**実測と食い違う**——`stageAndTar` の tar 呼び出しには
// `--owner`/`--numeric-owner` が無く `chown` もしないので、書庫にはビルドした人の uid が入る
// （実測: uid 欄 `000766`＝10進 502・`uname=r-yamaguchi`）。
// 振る舞いは tests/imageBuildPermissions.test.ts が固定している。ここでは
// **断定が文章として戻っていないこと**だけを見る（戻ると、直した理由ごと失われる）。
describe('imageBuild.ts: スティッキーの説明に未確認の root を持ち込まない（掟1）', () => {
  const source = fs.readFileSync(SRC, 'utf-8')

  it('★★「所有者は root」の断定が戻っていない', () => {
    expect(source).not.toContain('所有者は root')
    expect(source).not.toContain('ファイルの所有者は root')
  })

  it('★★ 代わりに「書庫に入るのはビルドした人の uid」と、その未確認の範囲が書いてある', () => {
    expect(source).toContain('ビルドした人の uid')
    // 「では 951 と一致したらどうなるのか」を未確認のまま残す（推測で埋めない）
    expect(source).toContain('951 だったときにどうなるかは未確認')
  })

  // D-13 A（2026-09-16）: ここは以前「『上書きもできない』と言い切らない」だった——
  // `addPermission` は足すだけで w を奪わず、手元が `0o666`/`0o777` のファイルは
  // **上書きできてしまった**ため。いまは `fileModeForImage` が他人の w を落とすので、
  // **言い切れる側に実装を寄せた**。ここでは「足すだけに戻っていないこと」と、
  // **実機での確認がまだであるという断りが消えていないこと**を見る（掟1）。
  it('★★ ファイルは「足すだけ」ではなく、他人の書き込みを落として設定する（D-13 A）', () => {
    expect(source).toContain('(mode | 0o444) & ~0o022')
    // 直す前の形（足すだけ）に戻っていないこと
    expect(source).not.toContain('addPermission(dest, 0o444)')
    expect(source).not.toContain('addPermission(marker, 0o444)')
    // 実行ビットを奪う形（固定で上書き）に化けていないこと
    expect(source).not.toMatch(/chmodSync\([^,]+,\s*0o444\)/)
  })

  it('★★ 実機で確かめていないことを、確かめたように書いていない（掟1）', () => {
    expect(source).toContain('実際のさくらのサーバーでの確認はこれから')
  })
})

// ── copyTree の守りが届かない範囲（node_modules）を、書庫の直前でそろえる（検分の指摘・2026-09-16）──
//
// `copyTree` が mode を決められるのは**手元から複製したファイルだけ**である。`node_modules` は
// 除外リストで複製されず、`stageAndTar` が copyTree の**あとに** `installDependencies`
// （`npm install`）で作り直すので、mode は npm とビルドした人の umask 任せだった。
// **振る舞いの検査は tests/imageBuildPermissions.test.ts**（npm を走らせずに、npm が作るのと
// 同じ形を置いて mode が変わることを見る）。ここでは**順序**——`installDependencies` のあと・
// `tar` の前に通っていること——だけをソースで固定する（順序が逆だと node_modules は素通りする）。
describe('公開イメージ: node_modules も書庫の直前でそろえる（imageBuild.ts の順序）', () => {
  const source = fs.readFileSync(SRC, 'utf-8')

  it('★★ stageAndTar は tar の直前に normalizeStageTree(appDir) を通す', () => {
    // ⚠️ `toContain('normalizeStageTree(appDir)')` だけでは**コメントにする変異を素通りさせた**
    // （実測・2026-09-16。`// normalizeStageTree(appDir)` も含んでしまう）。行頭からの**呼び出しの形**で見る。
    // 振る舞い側の網は tests/imageBuildPermissions.test.ts（書庫を読む4本）。
    const call = /\n {2}normalizeStageTree\(appDir\)\n/.exec(source)
    expect(call, 'normalizeStageTree(appDir) の呼び出しが（コメントではなく）見つからない').not.toBeNull()
    const callAt = call!.index
    const install = at(source, 'await installDependencies(appDir', 'installDependencies の呼び出しが見つからない')
    const tar = at(source, "runExecFile('tar', ['-cf', layer, '-C', stageDir, 'app'])", 'tar の呼び出しが見つからない')
    expect(callAt, 'npm install より前でそろえている（node_modules が素通りする）').toBeGreaterThan(install)
    expect(callAt, 'tar のあとでそろえている（書庫には古い mode が入る）').toBeLessThan(tar)
  })

  it('★★ そろえる中身は copyTree と同じ2つ（フォルダ 0o1777・ファイルは fileModeForImage）で、判断を複製していない', () => {
    const start = at(source, 'export function normalizeStageTree', 'normalizeStageTree の定義が見つからない')
    const end = source.indexOf('\n}', start)
    expect(end, 'normalizeStageTree の終わりが見つからない').toBeGreaterThan(start)
    const body = source.slice(start, end) // 関数の本体だけ（次のコメントを巻き込まない）
    expect(body).toContain('addPermission(dir, 0o1777)')
    expect(body).toContain('setImageFileMode(p)')
    // シンボリックリンクを辿ると、ステージングの外（利用者の持ち物）の mode を変えてしまう
    expect(body).toContain('isSymbolicLink()')
    // 別の式を書き下していない（fileModeForImage 以外の mode 計算を持ち込まない）
    expect(body).not.toContain('0o444')
  })

  it('★★「copyTree だけで配布物すべてを守れている」と読める書き方に戻っていない（守りの範囲を書く）', () => {
    expect(source).toContain('`copyTree` が通すのは「手元から複製したもの」だけである')
    expect(source).toContain('npm とビルドした人の umask 任せ')
    // chmod が失敗したら元の mode のまま入る——「必ず落ちている」と言い切らない（掟1）
    expect(source).toContain('元の mode のまま書庫に入る')
    expect(source).toContain('CAP_DAC_OVERRIDE')
  })
})
