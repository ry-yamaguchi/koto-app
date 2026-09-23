import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { excludedFileNames, excludedDirNames, servedExcludedFileNames, BUILD_CONFIG_FILES } from '../src/shared/publishExclude'

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

  it('秘密ファイルの判定も通している（.env をイメージへ焼かない）', () => {
    expect(source).toContain('isSecretFile')
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

  it('秘密ファイルは、権限を触る前に除外されている', () => {
    // isSecretFile の判定が copyFileSync より前にあること（順序が逆だと
    // 「複製してから除外」になり、一瞬でも秘密が複製される）
    expect(source.indexOf('isSecretFile')).toBeLessThan(source.indexOf('fs.copyFileSync'))
  })

  it('権限を変えられなくても、公開そのものは止めない', () => {
    const at = source.indexOf('function addPermission')
    expect(source.slice(at, at + 400)).toContain('catch')
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
    const at = call!.index
    const install = source.indexOf('await installDependencies(appDir')
    const tar = source.indexOf("runExecFile('tar', ['-cf', layer, '-C', stageDir, 'app'])")
    expect(install, 'installDependencies の呼び出しが見つからない').toBeGreaterThan(0)
    expect(tar, 'tar の呼び出しが見つからない').toBeGreaterThan(0)
    expect(at, 'npm install より前でそろえている（node_modules が素通りする）').toBeGreaterThan(install)
    expect(at, 'tar のあとでそろえている（書庫には古い mode が入る）').toBeLessThan(tar)
  })

  it('★★ そろえる中身は copyTree と同じ2つ（フォルダ 0o1777・ファイルは fileModeForImage）で、判断を複製していない', () => {
    const at = source.indexOf('export function normalizeStageTree')
    expect(at).toBeGreaterThan(0)
    const body = source.slice(at, source.indexOf('\n}', at)) // 関数の本体だけ（次のコメントを巻き込まない）
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
