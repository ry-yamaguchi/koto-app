// imageBuild.ts — Docker デーモン不要のイメージビルド＆プッシュ（同梱の crane を使用）。
//
// 人間が Docker を入れずに、IDE 同梱の crane バイナリだけで
//   「公開ベースイメージ ＋ プロジェクトのファイル層 ＋ 起動設定」
// を組み立ててコンテナレジストリ（さくら）へ push する。
//
// ※セキュリティ最重要:
//   - crane / tar は execFile（配列引数）でのみ実行する。シェル文字列連結は厳禁。
//   - レジストリのパスワードは argv に渡さない。一時ディレクトリの DOCKER_CONFIG/config.json
//     に base64(user:password) として書き、crane には環境変数 DOCKER_CONFIG で渡す。
//   - イメージ参照（ref）・レジストリサーバは docker.ts の検証関数を再利用して厳格検証する。
//   - 一時ディレクトリ（ステージング・layer.tar・DOCKER_CONFIG）は必ず後始末で削除する。

import { execFile } from 'child_process'
import { app } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { validateRegistryServer, buildRef } from './docker'
import { publishExcludedDirNames, servedExcludedFileNames, isSecretFile } from '../../shared/publishExclude'
import { planDependencies, nativeDepsMessageForBlocked } from '../../shared/deps'
import { MARKER_FILE, markerContent } from '../../shared/publishVerify'
import { installDependencies } from './npmInstall'
import { awaitLoginPath } from '../loginPath'

// ── 出力上限・タイムアウト（crane の build/push は時間がかかり得る） ──
const OUTPUT_MAX = 16000
const BUILD_TIMEOUT = 600000 // 10分
const MAX_BUFFER = 16 * 1024 * 1024

/** ステージングから除外するエントリ名（プロジェクト直下・全階層で除外）。 */
// **ファイル側の除外を取りこぼしていた。** NOISE_FILES だけを足していたため、
// KOTO_INTERNAL_FILES（`.sakuraide.json`）がイメージへ焼き込まれ、静的配信では
// ブラウザから読めていた（2026-08-14 実機で確認）。publishExclude.ts は
// 「同じリストを手で並べ直さない」ために作ったのに、ここが手で並べ直していた。
// **配信されるものを集める**ので、ビルド用の設定ファイルも外す（servedExcludedFileNames）。
// 2026-08-20 実測: /Dockerfile /nginx.conf /.dockerignore が公開URLから読めていた。
const EXCLUDE_NAMES = new Set([...publishExcludedDirNames(), ...servedExcludedFileNames()])

/** 出力を上限で切り詰める。 */
function clip(s: unknown): string {
  return String(s ?? '').slice(0, OUTPUT_MAX)
}

/** stderr を要約して短いメッセージにする（最後の非空行が原因のことが多い）。 */
function summarizeStderr(stderr: string): string {
  const t = (stderr || '').trim()
  if (!t) return 'イメージのビルドに失敗しました。'
  const lines = t.split(/\r?\n/).filter(l => l.trim().length > 0)
  const last = lines[lines.length - 1] ?? t
  return last.slice(0, 300)
}

/**
 * 同梱 crane バイナリの絶対パス。
 * - packaged: process.resourcesPath/bin/crane（electron-builder の extraResources）
 * - dev: app.getAppPath()/build/bin/crane（リポジトリ同梱）
 */
export function cranePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'crane')
    : path.join(app.getAppPath(), 'build', 'bin', 'crane')
}

/** 内蔵ビルダー（crane）が存在し実行可能か。 */
export function builderAvailable(): boolean {
  try {
    fs.accessSync(cranePath(), fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 対応ランタイム種別。 */
export type RuntimeId = 'static' | 'node'

/** ランタイム定義（ベースイメージ・起動設定）。cmd は port を受けて引数配列を返す。 */
type RuntimeDef = {
  base: string
  entrypoint: string
  /** 起動引数。`entry` は node ランタイムで実行するファイル（static では使わない）。 */
  cmd: (port: number, entry: string) => string[]
  workdir: string
}

/**
 * RUNTIME テーブル。
 * static = 公開 python イメージで http.server を起動し /app を配信する（静的/ファイル配信）。
 * 将来 node 等を追加できるよう、種別 → 定義のマップにしてある。
 */
const RUNTIME: Record<RuntimeId, RuntimeDef> = {
  static: {
    base: 'python:3.12-alpine',
    entrypoint: 'python',
    cmd: (port: number) => ['-m', 'http.server', String(port)],
    workdir: '/app',
  },
  // Node で実行する（2026-08-14）。**依存パッケージの無いアプリまで**が対象。
  // 何を起動するかは shared/runtimeDetect.ts が決め、ここは受け取って動かすだけ。
  node: {
    base: 'node:22-alpine',
    entrypoint: 'node',
    cmd: (_port: number, entry: string) => [entry],
    workdir: '/app',
  },
}

/**
 * **権限をビット単位で足すだけ**（`mode | bits`）。何も奪わない。
 * **いまはフォルダにだけ使う**（読み・辿る・**書き込み＋スティッキービット**＝`0o1777`。
 * フォルダに書き込みとスティッキービットを足した理由は copyTree のコメント参照・2026-09-16）。
 * `bits` の上位（`0o1000`＝スティッキー）も `mode | bits` でそのまま足せることは、
 * 一時フォルダで実測した（2026-09-16・`0o555` → `0o1777`）。
 *
 * ── なぜ「0644 に揃える」ではないのか（2026-08-14 Ryosuke の点検）────────
 * 最初は `chmod 0644` と書いたが、それは**実行ビットを落とす**（`0755` の
 * スクリプトが `0644` になって動かなくなる）。しかも元が `0400`（読み取り専用）
 * だったものに書き込みを与えてしまう。**必要のないものを奪い、必要のないものを
 * 与えていた。**
 *
 * ── ただし「足すだけ」ではファイルを守れない（D-13 A・2026-09-16）────────
 * ファイルにはもうこれを使わない。足すだけでは**他人の書き込みを落とせず**、
 * 手元が `0o666`/`0o777` のファイルは w を持ったまま像に入っていた（＝配ったものを
 * アプリが**その場で上書きできた**）。ファイルの mode は `fileModeForImage` が決め、
 * copyTree が `fs.chmodSync` で**設定する**（下のコメント参照）。
 *
 * これが効くのは**一時的なステージング（配る複製）のみ**で、利用者のファイルには
 * 触れない。秘密のファイルはこの前段（EXCLUDE_NAMES・isSecretFile）で
 * **そもそも複製されない**ので、ここで権限が緩むこともない。
 */
function addPermission(target: string, bits: number): void {
  try {
    const mode = fs.statSync(target).mode & 0o7777
    if ((mode & bits) === bits) return // すでに足りている
    fs.chmodSync(target, mode | bits)
  } catch { /* 変えられなくても続行（元のまま入る） */ }
}

/**
 * 像（イメージ）に入れる**ファイル**の mode を決める純関数（D-13 A・2026-09-16）。
 *
 * **式: `(mode | 0o444) & ~0o022`**
 *   ・`| 0o444` ＝ 誰でも**読める**ようにする（2026-08-14 の `EACCES`。手元が `0o600` の
 *     ファイルがそのまま像に入り、コンテナの Node が自分のファイルを読めずに落ちた）
 *   ・`& ~0o022` ＝ **グループと他人の書き込みだけを落とす**（`0o020`＝グループの w、
 *     `0o002`＝他人の w。r・x には触らない）
 *
 * **なぜ落とすのか。** スティッキービット（フォルダの `0o1777`）が止めるのは
 * 「**消して置き換える**」であって、「**その場の上書き**」ではない。足すだけの
 * `addPermission` では、手元が `0o666`/`0o777` のファイルは w を持ったまま像に入る。
 * コンテナは**所有者と違う実行ユーザ**で動くので、その場合は上書きできてしまう。
 * **削除（スティッキー）と上書き（mode）の両方がそろって初めて、「配ったものは変わらない」と
 * 言える。** 片方だけでは、README・使い方ガイド・CHANGELOG の説明が嘘になる。
 *
 * **実行ビット（`0o111`）は奪わない。** `0o755` のスクリプトや実行ファイルが動かなくなる
 * （2026-08-14 の「`chmod 0644` は奪いすぎ・与えすぎ」と同じ失敗をしない）。
 * **所有者の書き込み（`0o200`）にも触らない。** 像の中の所有者は**ビルドした人の uid** で
 * （`stageAndTar` は `--owner`/`--numeric-owner` を付けず `chown` もしない。実測・2026-09-16:
 * uid 欄 `000766`＝10進 502）、コンテナの実行ユーザ（専有型は uid 951）とは別の番号である。
 * **ビルドした人の uid がちょうど 951 だったときにどうなるかは未確認**（推測で書かない・掟1）。
 *
 * ⚠️ **実際のさくらのサーバーでの確認はこれからである。** 手元で確かめたのは、ステージングの
 * mode と layer.tar のヘッダの mode まで（`tests/imageBuildPermissions.test.ts`）。
 */
export function fileModeForImage(mode: number): number {
  return (mode | 0o444) & ~0o022
}

/**
 * 像に入れるファイルの mode を `fileModeForImage` の結果に**設定する**。
 * `addPermission` のように足すだけでは、他人の書き込みを**落とせない**（D-13 A）。
 */
function setImageFileMode(target: string): void {
  try {
    const mode = fs.statSync(target).mode & 0o7777
    const next = fileModeForImage(mode)
    if (next === mode) return // すでにその形
    fs.chmodSync(target, next)
  } catch { /* 変えられなくても続行（元のまま入る） */ }
}

/**
 * プロジェクト配下を再帰コピーする（EXCLUDE_NAMES を全階層で除外）。
 *
 * ── フォルダに書き込みを足す理由（2026-09-16 実機・0.6.19-rc.1・専有型）────────────
 * 専有型に公開したアプリが**1分ごとに再起動を繰り返していた**（コンテナIDが毎回変わる）。
 * コントロールパネルのランタイムログの全文はこれだけ:
 *   Error: EACCES: permission denied, mkdir '/app/data'
 *     at Object.mkdirSync (node:fs:1370:26)
 *     at Object.<anonymous> (/app/server.js:39:6)
 *   errno: -13, code: 'EACCES', syscall: 'mkdir', path: '/app/data'
 * アプリ（`public/server.js`）は起動時に `path.join(__dirname, 'data')` を作り、そこへ
 * SQLite のデータベースを置く。**専有型のコンテナは uid 951:gid 951 で動く**
 * （さくらのマニュアル「技術概要 → コンテナ実行環境仕様」に明記）ため、
 * `0o555`（読む・辿るだけ）のフォルダには**自分のデータフォルダすら作れない**。
 * 共用型では動いていた（**理由は未確認**。そちらのコンテナがどの uid で動くかは実測しておらず、
 * **共用型に公開したアプリがそもそも書き込みをしなかっただけ**かもしれない。
 * 「root だから書けていた」とは書かない・掟1）。
 *
 * そこで**フォルダにだけ書き込みとスティッキービットを足す**（`0o555` → `0o1777`）。
 *   ・**ファイルは他人が書けない形にする**（`fileModeForImage` ＝ `(mode | 0o444) & ~0o022`）。
 *     アプリのコードは像の中で書き換わらないほうがよい
 *   ・**所有者（uid/gid）は変えない。** 特定の番号に寄せると、番号の違う公開先で壊れる
 *   ・フォルダは `addPermission` で足すだけなので、既存の権限を奪わない
 *
 * ── なぜ `0o777` ではなくスティッキービット（`0o1777`）なのか（2026-09-16 Ryosuke さんの問い）──
 * `0o777` だと、**フォルダの中のファイルを消して置き換えられる**。ファイルを `0o444`
 * （読み取り専用）にしても、**そのファイルを消せるかどうかは親フォルダの権限で決まる**ので、
 * 書き込みのあるフォルダに置かれたアプリのコードは実質的に差し替え可能になる。
 * スティッキービット（`/tmp` と同じ）を立てると「**新しく作るのは誰でもできるが、
 * 他人が作ったものは消せない**」になる。
 *   ・**「他人」が誰かは、書庫に記録される uid で決まる。** `stageAndTar` は
 *     `tar -cf <layer> -C <stage> app` を `--owner`/`--numeric-owner` なしで呼び、`chown` もしない。
 *     つまり**書庫のヘッダに入るのは「ビルドした人の uid」**である（この機械での実測・2026-09-16:
 *     mode 欄 `001777`・uid 欄 `000766`＝10進 **502**・`uname=r-yamaguchi`。**root(0) ではない**）。
 *     コンテナは uid 951 で動くので、**番号が違う間は**アプリは像のファイルを消せない。
 *     **ビルドした人の uid がちょうど 951 だったときにどうなるかは未確認**（確かめていないので書かない・掟1）
 *   ・**削除・置き換えを止めるのはスティッキー、その場の上書きを止めるのは mode**——
 *     この2つがそろって初めて「配ったものは変わらない」と言える。以前は mode 側が
 *     `addPermission`（足すだけ）で、**手元が `0o666`/`0o777` のファイルは w を持ったまま
 *     像に入り、アプリから上書きできた**（D-13 A で `fileModeForImage` に直した）
 *   ・**書き換えたいデータは、最初から像に入れず**アプリが起動時に作るフォルダ
 *     （`/app/data` など）へ置くこと。像に入れたファイルは書き換えられない
 *   ・**実際のさくらのサーバーでの確認はこれから**（手元で確かめたのは、ステージングの mode と
 *     layer.tar のヘッダの mode まで。`tests/imageBuildPermissions.test.ts`）
 *   ・`addPermission` が `0o1000` を足せることは一時フォルダで実測した（2026-09-16・`0o555` → `0o1777`）
 *
 * ── この関数が守れる範囲（検分の指摘・2026-09-16）─────────────────────────────
 * **`copyTree` が通すのは「手元から複製したもの」だけである。** `node_modules` は
 * `EXCLUDE_NAMES`（`publishExcludedDirNames()`）で複製の対象から外れており、`stageAndTar` が
 * `copyTree` の**あとに** `installDependencies`（`npm install`）を走らせて作り直す。
 * つまり `node_modules` 配下の mode は **npm とビルドした人の umask 任せ**で、ここは一度も通らない
 * （umask が緩い機械では、他人の w を持ったファイルが書庫に入りうる）。
 * そこで **tar の直前にステージング全体をもう一度なめる**（`normalizeStageTree`）。
 * この関数だけを見て「配布物のすべてを守れている」と読まないこと。
 *
 * **像の中に書いたデータは、公開し直すと消える**（コンテナは使い捨てで、公開のたびに
 * 像から作り直される）。残したい入力は、共用型の「保存場所」のような仕組みが要る。
 *
 * tar に書き出すときに mode が保たれるかは実測で確かめた（2026-09-16）。
 * `tar -cf … -C <stage> app` の書庫は `drwxrwxrwt app/`・`-r--r--r-- app/sub/f.txt` となり、
 * **フォルダもファイルも mode がそのまま入る**（スティッキービットも `t` として残り、
 * `tar -xpf` で展開しても残る）ので、tar 側で直す必要は無い。
 * **ただしコメントは変異を止めない。** ここが像に効く唯一の段なので、
 * `tests/imageBuildPermissions.test.ts` の後半が `stageAndTar` を実際に通し、
 * **layer.tar のヘッダの mode 欄**を読んで固定している（検分の指摘・2026-09-16）。
 * 書庫の作り方を変えるときは、必ずその試験が緑のままか確かめること。
 *
 * export しているのはテスト（tests/imageBuildPermissions.test.ts）のため。一時フォルダへ
 * 実際にコピーさせて `fs.statSync` の mode を見る——ソースの文字列を読むだけの検査では
 * 「そう書いてあるか」しか分からない（掟10）。
 */
export function copyTree(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true })
  // フォルダは「読み＋辿る＋書き込み＋スティッキー」を足す（アプリが自分でフォルダ・ファイルを
  // 作れるように。ただし他人＝像に最初から入っているファイルは消せない・上のコメント参照）
  addPermission(destDir, 0o1777)
  const entries = fs.readdirSync(srcDir, { withFileTypes: true })
  for (const e of entries) {
    // 秘密ファイル（.env など）をイメージへ焼き込まない。2026-08-09 の総点検まで
    // ここには判定が無く、コンテナに .env がそのまま入っていた。
    if (EXCLUDE_NAMES.has(e.name) || isSecretFile(e.name)) continue
    const src = path.join(srcDir, e.name)
    const dest = path.join(destDir, e.name)
    if (e.isDirectory()) {
      copyTree(src, dest)
    } else if (e.isSymbolicLink()) {
      // シンボリックリンクは追従せずスキップ（外部参照・ループ回避）。
      continue
    } else if (e.isFile()) {
      fs.copyFileSync(src, dest)
      // **コンテナの中で読めるようにし、同時に他人が書けないようにする。**
      // copyFileSync は元の権限を引き継ぐ。手元で 0600 のファイルがあると、そのまま
      // イメージに入り、コンテナの Node が読めずに `EACCES` で起動に失敗する（2026-08-14 実機）。
      // 逆に手元が 0o666/0o777 のファイルは**書き込みを持ったまま**入り、コンテナから
      // その場で上書きできてしまう（D-13 A）。どちらも**原因は手元の権限なのに、症状は
      // 容器の中で出る**。判断は純関数 fileModeForImage に集約し、ここは設定するだけ。
      setImageFileMode(dest)
    }
  }
}

/**
 * **書庫にする直前に、ステージング全体の mode をもう一度そろえる**（検分の指摘・2026-09-16）。
 *
 * `copyTree` が mode を決められるのは「手元から複製したファイル」だけである。
 * `node_modules` は複製の対象から外れており（`EXCLUDE_NAMES`）、`stageAndTar` が copyTree の
 * **あとに** `installDependencies`（`npm install`）を走らせて作り直す。そのため
 * `node_modules` 配下は **npm とビルドした人の umask 任せ**で、
 *   ・ファイルは `fileModeForImage` を一度も通らない（umask が緩い機械では他人の w が残る）
 *   ・フォルダは npm が作る `0o755` のままで、アプリがその中にファイルを作れない
 *     （D-8 で `/app` 全体に与えたはずの「アプリは自分でフォルダを作れる」から外れる）
 * という抜けがあった。**ここが書庫に入る最後の段**なので、`copyTree` と同じ形にそろえる。
 *
 * **やることは copyTree と同じ2つだけ**（判断を複製しない・掟10）:
 *   ・フォルダ → `addPermission(dir, 0o1777)`（書き込み＋スティッキー）
 *   ・ファイル → `setImageFileMode`（`fileModeForImage` ＝ `(mode | 0o444) & ~0o022` を設定）
 * `copyTree` が通したものにもう一度当たるが、**どちらも「すでにその形なら何もしない」**ので
 * 二重に適用しても結果は変わらない。
 *
 * **シンボリックリンクは追従しない。** `node_modules/.bin` はリンクの塊で、`fs.chmodSync` は
 * リンク先の mode を変えてしまう（tar もリンクは mode を持たない形で書く）。
 *
 * ⚠️ **これでも残る穴**: `fs.chmodSync` が失敗したファイルは**元の mode のまま書庫に入る**
 * （`setImageFileMode`／`addPermission` はどちらも黙って続行する——権限を変えられないことで
 * 公開そのものを止めないため）。**「必ず落ちている」ではなく「落とそうとする」**である。
 * また、コンテナ側に `CAP_DAC_OVERRIDE` のような権限が残っていれば mode は素通りするが、
 * **専有型のコンテナがどうかは確かめていない**（推測で書かない・掟1）。
 *
 * export しているのはテスト（`tests/imageBuildPermissions.test.ts`）のため——`npm install` を
 * 通さずに、npm が作るのと同じ形（`0o755` のフォルダ・`0o666` のファイル）を置いて確かめる。
 */
export function normalizeStageTree(dir: string): void {
  // フォルダ自身を先にそろえる（読めないと readdir できないため、足すのが先）。
  addPermission(dir, 0o1777)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return // 読めないフォルダがあっても公開そのものは止めない（copyTree と同じ流儀）
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) continue // 追従しない（リンク先の mode を変えない）
    if (e.isDirectory()) normalizeStageTree(p)
    else if (e.isFile()) setImageFileMode(p)
  }
}

/**
 * crane に渡す一時 DOCKER_CONFIG ディレクトリを作る（絶対パスを返す）。
 *
 * **パスワードを argv に載せない**ための仕掛け。`ps` 等のプロセス一覧に出てしまうため、
 * base64(user:password) を 0600 のファイルに書き、`DOCKER_CONFIG` 環境変数で渡す。
 *
 * **呼び出し側が必ず削除すること**（finally で `fs.rmSync(dir, { recursive: true, force: true })`）。
 * 片づけ（imageCleanup.ts）も同じ仕掛けを使うので、ここ1箇所に置く（掟10）。
 */
export function makeDockerConfigDir(auth: { server: string; user: string; password: string }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-dcfg-'))
  const authB64 = Buffer.from(`${auth.user}:${auth.password}`, 'utf-8').toString('base64')
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ auths: { [auth.server]: { auth: authB64 } } }),
    { mode: 0o600 }
  )
  return dir
}

/** execFile を Promise でラップ（タイムアウト・出力上限つき）。 */
function runExecFile(
  cmd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv }
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      cmd,
      args,
      { timeout: BUILD_TIMEOUT, maxBuffer: MAX_BUFFER, env: opts?.env },
      (err: any, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

/**
 * プロジェクトのファイルを `app/` 配下に置いた tar（層）を作る。
 * - contextAbs 配下を一時ステージングディレクトリの `app/` へコピー（EXCLUDE_NAMES を除外）。
 * - `tar -cf <layer> -C <stageDir> app` で層 tar を作る。
 * 戻り値: layer tar の絶対パス（作業用 tmp ディレクトリ内）。
 * ※呼び出し側が後始末でその tmp ディレクトリを削除すること。
 */
/** ステージングした app/ の package.json を読む（無い・壊れていれば null）。 */
function readPackageJson(appDir: string): unknown {
  try {
    const p = path.join(appDir, 'package.json')
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null
  } catch {
    return null
  }
}

export async function stageAndTar(
  contextAbs: string,
  opts?: { onProgress?: (m: string) => void; buildTag?: string },
): Promise<string> {
  if (typeof contextAbs !== 'string' || !path.isAbsolute(contextAbs)) {
    throw new Error('ビルドコンテキストは絶対パスである必要があります')
  }
  let st: fs.Stats
  try {
    st = fs.statSync(contextAbs)
  } catch {
    throw new Error('ビルドコンテキストのパスが存在しません')
  }
  if (!st.isDirectory()) {
    throw new Error('ビルドコンテキストはディレクトリである必要があります')
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-img-'))
  const stageDir = path.join(tmpDir, 'stage')
  const appDir = path.join(stageDir, 'app')
  const layer = path.join(tmpDir, 'layer.tar')

  copyTree(contextAbs, appDir)

  // ── 版の目印を1つ混ぜる（2026-08-19 実機・Ryosuke 報告）──────────────────
  // 公開が「✅ 完了」と出ても、**古い中身が配られ続けている**ことがあった。
  // デプロイのAPIが 200 を返したことも、アプリが起動したことも、
  // 「中身が新しい」証拠にはならない。**公開のあとにこの目印を読みに行く**。
  if (opts?.buildTag) {
    try {
      const marker = path.join(appDir, MARKER_FILE)
      fs.writeFileSync(marker, markerContent(opts.buildTag))
      // 目印も「最初から入っているファイル」なので、他のファイルと同じ形にする（D-13 A）。
      setImageFileMode(marker)
    } catch { /* 目印を置けなくても公開そのものは成立する（確認ができないだけ） */ }
  }

  // ── 依存ライブラリを用意して、一緒に持っていく（改善案 1-5・2026-08-18）──
  // コンテナの中で入れる場所が無い（Docker を使わないので）ため、**手元で入れて
  // node_modules ごと層に含める**。持っていけない部品（組み立て済みのネイティブ部品・
  // または「組み立てが要る」と宣言しているのにまだ組み立てられていないもの。
  // `--ignore-scripts` が組み立てを止めるので、後者は `.node` が無いまま素通りしうる
  // ——2026-09-16 の 502 はこの形。判断は shared/deps.ts と npmInstall.ts の
  // scanModules に一元化してある）があれば、**黙って持っていかずに断る**
  // （公開できたのに起動しない、を防ぐ）。
  const deps = planDependencies(readPackageJson(appDir))
  if (deps.kind === 'install') {
    const r = await installDependencies(appDir, opts?.onProgress)
    if (!r.ok) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      throw new Error(r.message ?? 'ライブラリを用意できませんでした')
    }
    if (r.nativeBlocked.length > 0) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      // **理由ごとに書き分ける**（名前と理由をそのまま渡す）。理由を1つに畳んで
      // 名前を全部並べると、当てはまらない説明を付けてしまう（検分の指摘・2026-09-17）。
      throw new Error(nativeDepsMessageForBlocked(r.nativeBlocked))
    }
    opts?.onProgress?.(`📚 ライブラリ ${deps.names.length}件を用意しました`)
  }

  // ── 書庫にする直前に、ステージング全体の mode をそろえる（検分の指摘・2026-09-16）──
  // `copyTree` が mode を決められるのは**手元から複製したファイルだけ**で、直前の
  // `installDependencies` が作った `node_modules` は一度も通っていない（npm と umask 任せ）。
  // ここが像に入る最後の段なので、フォルダ（`0o1777`）とファイル（`fileModeForImage`）を
  // もう一度そろえる。**すでにその形なら何もしない**ので、copyTree の分に当たっても変わらない。
  normalizeStageTree(appDir)

  // tar -cf <layer> -C <stageDir> app  → 中身が app/... となる層 tar を作る。
  const r = await runExecFile('tar', ['-cf', layer, '-C', stageDir, 'app'])
  if (!r.ok) {
    // 失敗時はこの tmp を片付けてから throw（呼び出し側へは tmp パスを返さない）。
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw new Error(`ファイル層の作成に失敗しました: ${summarizeStderr(r.stderr)}`)
  }
  return layer
}

/**
 * イメージ参照からタグだけを取り出す（純関数）。
 *
 * `example.sakuracr.jp/app:v20260819-182300` → `v20260819-182300`
 * ポート付きのサーバ（`host:5000/app:tag`）でも、**最後の `:` の後ろ**を見る。
 * `/` を含む場合はタグではない（`host:5000/app` のような形）ので空にする。
 */
export function tagOfRef(ref: string): string {
  const at = String(ref ?? '').lastIndexOf(':')
  if (at < 0) return ''
  const tail = ref.slice(at + 1)
  return tail.includes('/') ? '' : tail
}

/** buildAndPush の入力。 */
export type BuildAndPushOptions = {
  /** ビルドコンテキストの絶対パス（プロジェクト内に閉じ込め済みであること）。 */
  contextAbs: string
  /** push 先の完全なイメージ参照（呼び出し側で buildRef 済みでもよいが、ここでも検証する）。 */
  ref: string
  /** 公開するポート（http.server 等の待受ポート）。 */
  port: number
  /** ランタイム種別（既定 static）。 */
  runtime?: RuntimeId
  /** node ランタイムで起動するファイル（例 'server.js'）。 */
  entry?: string
  /** レジストリ認証情報（server/user/password）。config.json に base64(user:password) を書く。 */
  registryAuth: { server: string; user: string; password: string }
  /** 進捗の通知（ライブラリの用意は時間がかかるので、黙って待たせない）。 */
  onProgress?: (message: string) => void
  /**
   * テスト/オフライン用: 指定すると crane の push（-t）の代わりに `-o <outFile>` でローカル出力する。
   * 実レジストリへ push せずに引数組み立てと層構築を検証できる。
   */
  outFile?: string
}

/** buildAndPush の結果。 */
export type BuildAndPushResult = { ok: boolean; log: string; message?: string }

/**
 * crane の argv を組み立てる純関数（テスト容易性のため分離）。
 * outFile が指定されれば push（-t）の代わりに `-o <outFile>` でローカル tar 出力する。
 */
export function buildCraneArgs(opts: {
  base: string
  layer: string
  workdir: string
  entrypoint: string
  cmd: string[]
  port: number
  ref: string
  outFile?: string
  /** イメージに焼く環境変数（node アプリに待受ポートを伝えるため）。 */
  env?: Record<string, string>
}): string[] {
  const args = [
    'mutate',
    opts.base,
    '--append', opts.layer,
    '--workdir', opts.workdir,
    '--entrypoint', opts.entrypoint,
    '--cmd', opts.cmd.join(','),
    '--exposed-ports', String(opts.port),
  ]
  // **待受ポートを伝えないと繋がらない。** よくある `process.env.PORT || 3000` は
  // 3000 で待ち、AppRun は 8080 へ繋ぎに行く（2026-08-14）
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push('--env', `${k}=${v}`)
  if (opts.outFile) {
    // ローカル出力（オフライン検証用）。push しない。
    args.push('-o', opts.outFile)
  } else {
    // レジストリへ push。
    args.push('-t', opts.ref)
  }
  return args
}

/**
 * buildAndPush — Docker 不要で「公開ベース ＋ ファイル層 ＋ 起動設定」を組み立ててレジストリへ push する。
 *
 * 手順:
 *  1. ref / server を docker.ts の検証関数で検証。
 *  2. stageAndTar でプロジェクトのファイル層（app/ 配下）を作る。
 *  3. 一時 DOCKER_CONFIG ディレクトリに config.json を書く（push 先の認証）。
 *  4. crane mutate <base> --append <layer> ... -t <ref> を DOCKER_CONFIG 付きで実行。
 *  5. 後始末（ステージング tmp ・DOCKER_CONFIG tmp）を必ず削除。
 */
export async function buildAndPush(opts: BuildAndPushOptions): Promise<BuildAndPushResult> {
  // D-18 C: PATH がまだ決まっていなければ、決まるまで待つ（決まっていれば 0 コスト）。
  // ここから先で起動するのは crane（同梱・PATH に依らない）・`tar`・`npm` で、
  // このうち `npm` は最小限の PATH では見つからない（`installDependencies` は
  // `stageAndTar` の中から呼ばれる）。**組み立てを始める前**に一度だけ待つ。
  await awaitLoginPath()

  const runtime = RUNTIME[opts.runtime ?? 'static']
  if (!runtime) {
    return { ok: false, log: '', message: '未対応のランタイム種別です' }
  }
  // **起動するファイルが分からないまま node で組み立てない。**
  // entrypoint だけのイメージができ、起動して即終了する（原因が分かりにくい）
  if (opts.runtime === 'node' && !opts.entry) {
    return { ok: false, log: '', message: '起動するファイルが決まっていません' }
  }
  if (!builderAvailable()) {
    return { ok: false, log: '', message: '内蔵ビルダー（crane）が見つかりません' }
  }

  // 1. 検証（不正なら例外 → 失敗扱い）。
  let ref: string
  try {
    validateRegistryServer(opts.registryAuth.server)
    // ref は呼び出し側で buildRef 済みの想定だが、念のため形式確認はしない＝そのまま使う。
    // ただし -t に渡す ref は呼び出し側が buildRef で組み立てる前提。ここでは空チェックのみ。
    if (typeof opts.ref !== 'string' || opts.ref.length === 0) {
      throw new Error('イメージ参照（ref）が空です')
    }
    ref = opts.ref
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
      throw new Error('ポート番号が不正です（1〜65535）')
    }
    if (
      typeof opts.registryAuth.user !== 'string' || opts.registryAuth.user.length === 0 ||
      typeof opts.registryAuth.password !== 'string' || opts.registryAuth.password.length === 0
    ) {
      throw new Error('レジストリのユーザー名／パスワードが空です')
    }
  } catch (e: any) {
    return { ok: false, log: '', message: e?.message ?? String(e) }
  }

  let layer: string | null = null
  let layerTmpDir: string | null = null
  let cfgDir: string | null = null
  try {
    // 2. ファイル層（app/ 配下）を作る。
    try {
      layer = await stageAndTar(opts.contextAbs, {
        onProgress: opts.onProgress,
        // 版の目印は ref のタグをそのまま使う（公開のあとに読みに行く）
        buildTag: tagOfRef(opts.ref),
      })
      layerTmpDir = path.dirname(layer)
    } catch (e: any) {
      return { ok: false, log: '', message: e?.message ?? String(e) }
    }

    // 3. 一時 DOCKER_CONFIG ディレクトリに config.json を書く（push 先の認証）。
    //    ベース（docker.io）は公開のため認証不要。-t 先（さくら）の auths のみ載せる。
    cfgDir = makeDockerConfigDir(opts.registryAuth)

    // 4. crane 実行。
    const args = buildCraneArgs({
      base: runtime.base,
      layer,
      workdir: runtime.workdir,
      entrypoint: runtime.entrypoint,
      cmd: runtime.cmd(opts.port, opts.entry ?? ''),
      port: opts.port,
      ref,
      env: { PORT: String(opts.port) },
      ...(opts.outFile ? { outFile: opts.outFile } : {}),
    })
    const r = await runExecFile(cranePath(), args, {
      env: { ...process.env, DOCKER_CONFIG: cfgDir },
    })
    if (!r.ok) {
      return { ok: false, log: clip(r.stdout), message: summarizeStderr(r.stderr) }
    }
    return { ok: true, log: clip(r.stdout + r.stderr) }
  } catch (e: any) {
    return { ok: false, log: '', message: e?.message ?? String(e) }
  } finally {
    // 5. 後始末（ステージング tmp ・DOCKER_CONFIG tmp を削除。パスワード入り config.json も消える）。
    if (layerTmpDir) {
      try { fs.rmSync(layerTmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    if (cfgDir) {
      try { fs.rmSync(cfgDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}
