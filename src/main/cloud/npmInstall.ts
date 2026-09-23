// npmInstall.ts — 依存ライブラリを、持っていける形で用意する（main の IO）。
//
// ── なぜ手元で入れるのか（改善案 1-5・2026-08-18）──────────────────────
// 内蔵ビルダーは Docker を使わない。`node:22-alpine` の上に**プロジェクトの
// ファイルを1層足す**だけなので、コンテナの中で `npm install` を走らせる場所が無い。
// だから**手元で入れて、その `node_modules` ごと持っていく**。
//
// ── 守り ────────────────────────────────────────────────────────────
// 1. `--ignore-scripts`。**ライブラリの後付けスクリプトを走らせない。**
//    公開のたびに、素性の分からないコードが利用者のパソコンで動くのは筋が悪い
//    （そして、走らせても macOS 用の部品ができるだけで、公開先では動かない）。
// 2. `--omit=dev`。動かすのに要らないものは持っていかない（重くなるだけ）。
// 3. 入れたあとに `.node` を探し、**中身を読んで種類を見分ける**。公開先で動く部品を
//    持つライブラリだけ通す（判断は shared/deps.ts の `blockReasonForPackage`）。
//    2026-09-17 までは「`.node` があれば断る」だったが、Koto は公開先の形を指定して
//    入れているので**最初から公開先で動く部品が入っていることがあり**、止めすぎていた。
//
//    ── ★ `--ignore-scripts` が守り3を盲目にしていた（2026-09-16・502 で実測）──
//    `.node` は**組み立てて**できる。`--ignore-scripts` は組み立てそのものを
//    止めているので、組み立てが要るライブラリ（例: better-sqlite3）を入れても
//    `.node` は1つもできず、守り3は「見つからない＝安全」と素通りしてしまう。
//    そこで `.node` の有無だけでなく、**「組み立てが要る」とライブラリ自身が
//    宣言しているか**（`binding.gyp`・`gypfile`・install系スクリプト）も見る
//    （`declaresNativeBuild`・`scanModules`）。
// 4. 引数は配列で渡す（シェル文字列にしない）。

import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import {
  declaresNativeBuild, isNativeBinary, packageOfNative, packageDirOfNative,
  nativeBinaryKind, blockReasonForPackage, primaryBlockReason,
  type NativeBinaryKind, type NativeBlockReason, type BlockedPackage,
} from '../../shared/deps'
import { awaitLoginPath, loginPathHintForMissingTool } from '../loginPath'

/**
 * 公開先の形（`imageBuild.ts` の土台イメージ `node:22-alpine` と crane の既定）。
 *
 * **古い npm は知らない指定を黙って無視する**（実測: 未知の指定でも終了コード0）ので、
 * 付けたままで壊れない。
 */
const TARGET_PLATFORM_ARGS = ['--os=linux', '--cpu=x64', '--libc=musl'] as const

/** npm の実行を待つ上限。ライブラリが多いと数分かかる。 */
const INSTALL_TIMEOUT = 10 * 60 * 1000
const MAX_BUFFER = 8 * 1024 * 1024

export type InstallResult = {
  ok: boolean
  /**
   * 持っていけないライブラリと、**それぞれの理由**（公開先で動く部品を持つものは入らない）。
   *
   * 名前だけでなく理由も1件ずつ持つ（検分の指摘・2026-09-17）。理由を1つに畳むと、
   * 理由が混ざったときに**当てはまらない説明を全部の名前に付けて**しまう。
   */
  nativeBlocked: BlockedPackage[]
  /** 失敗したときの出力（診断用・そのまま画面に出せる長さに切る）。 */
  log: string
  message?: string
}

/** npm が使えるか（PATH は main 起動時にログインシェルのものへ揃えてある）。 */
export function npmAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('npm', ['--version'], { timeout: 15000 }, err => resolve(!err))
  })
}

/** 持っていけないライブラリ1件（名前と理由）。定義は shared/deps.ts（掟10）。 */
export type { BlockedPackage }

/** `scanModules` が1回の走査で集めるもの。 */
export type ModuleScan = {
  /**
   * 見つかった `.node` の相対パス（`root` の親、つまりアプリ直下からの相対）。
   *
   * **これは診断用の一覧で、`limit` が掛かるのはここだけ**（検分の指摘・2026-09-17）。
   * 判定に使う `binaryKinds` / `declaredNative` / `blocked` は打ち切らない。
   */
  nativeBinaries: string[]
  /** 「組み立てが要る」と宣言しているライブラリの名前。 */
  declaredNative: string[]
  /** ライブラリごとに見つかった `.node` の種類（重複なし）。 */
  binaryKinds: Record<string, NativeBinaryKind[]>
  /** 持っていけないライブラリ（名前順）。**公開先で動く部品を持つものは入らない。** */
  blocked: BlockedPackage[]
}

/**
 * 中身を読む上限。これを超えるファイルは読まずに `'unknown'`（＝通さない）とする。
 *
 * 根拠: 手元の `node_modules` で見かける `.node` は数MB規模（例: sharp の部品は
 * 数百KB〜数MB）。64MB はそれより2桁大きく、**普通の部品はすべて読める**一方、
 * 壊れた・異常に大きいファイルでメモリを食い潰さない。
 */
const MAX_NATIVE_READ_BYTES = 64 * 1024 * 1024

/**
 * `.node` の中身を読んで種類を見分ける。
 *
 * **読めなかった・大きすぎるものは `'unknown'`**（分からないものを通さない・掟10）。
 */
function kindOfNativeFile(fullPath: string): NativeBinaryKind {
  try {
    const st = fs.statSync(fullPath)
    if (!st.isFile() || st.size > MAX_NATIVE_READ_BYTES) return 'unknown'
    return nativeBinaryKind(fs.readFileSync(fullPath))
  } catch {
    return 'unknown'
  }
}

/**
 * `node_modules` を1回の深さ優先探索で走査し、`.node`（組み立て済みの部品）と、
 * 「組み立てが要る」と自分で宣言しているライブラリ（`declaresNativeBuild`）の**両方**を集める。
 *
 * ── なぜ両方を見るか（2026-09-16・502 で実測）─────────────────────────
 * `--ignore-scripts` は組み立てを止める守りなので、組み立てが要るライブラリを
 * 入れても `.node` は1つもできない。`.node` の有無だけを見る守りは、この場合
 * 「無い＝安全」と誤判定してすり抜ける。だから `.node` の探索と同じ1回の走査で、
 * **ライブラリ自身の宣言**（`binding.gyp`・`gypfile`・install系スクリプト）も見る。
 *
 * ── 断るかどうかは「ライブラリ単位」で決める（改善案 1-7・案3・2026-09-17）──
 * `.node` を1つ見つけただけで断るのは**止めすぎ**だった。`node-gyp-build` を使う
 * ライブラリは各OS用の部品を全部同梱して実行時に選ぶので、お使いのパソコン用が
 * 入っていても**公開先用が同梱されていれば動く**。そこで `.node` の**中身を読んで
 * 種類を見分け**、ライブラリごとに集めてから判断する（判断は `blockReasonForPackage`）。
 *
 * ── 件数上限は「診断用の一覧」だけに掛ける（検分の指摘・2026-09-17）─────────
 * 以前は `.node` を **50件見つけた時点で走査を打ち切って**いた。各OS用の部品を同梱する
 * ライブラリは1つで9〜14個の `.node` を持つので、数個並べば 50 に届く。打ち切ると
 * ①その先にある「お使いのパソコン用しか無いライブラリ」が種類を見られずに**素通り**し
 * ②同じライブラリの公開先用が打ち切りの外に落ちて**動くものを誤って断る**。
 * そこで**上限は `nativeBinaries`（画面に出すパスの一覧）だけ**に掛け、
 * 種類の集計と走査そのものは最後まで続ける（集計は Map なのでライブラリ数ぶんしか増えない）。
 *
 * @param root  `node_modules` フォルダの絶対パス
 * @param limit `nativeBinaries`（診断用のパス一覧）の件数上限。**判定には掛からない**
 */
export function scanModules(root: string, limit = 50): ModuleScan {
  const nativeBinaries: string[] = []
  /**
   * 持ち主の**フォルダ** → 見つかった `.node` の種類。
   *
   * 名前ではなくフォルダで持つ（検分の指摘・2026-09-17）。npm は版が食い違う依存を
   * 入れ子の `node_modules` に別コピーとして置くので、名前で合流させると
   * 「別コピーに公開先用があるから通す」という**通しすぎ**になる。
   */
  const kindsByDir = new Map<string, Set<NativeBinaryKind>>()
  /** 「組み立てが要る」と宣言しているライブラリの**フォルダ**（同上）。 */
  const declaredDirs = new Set<string>()
  // `root` の親（アプリ直下）から見た相対パスにする。こうすると相対パスに必ず
  // `node_modules` が入るので、`packageOfNative` の「`node_modules` の次（1つ or
  // スコープ付きは2つ）が持ち主の名前」という規則をそのまま使い回せる。
  const appDir = path.dirname(root)
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

    // ── そのフォルダが「ライブラリのフォルダ」（package.json がある）か ─────────
    // package.json が読めない・壊れているフォルダは黙って飛ばす（落ちない）。
    // ただし binding.gyp は package.json の中身に関係なく独立した目印なので、
    // 壊れていても pkgJson=null のまま declaresNativeBuild に渡す（それでも判定できる）。
    if (entries.some(e => e.isFile() && e.name === 'package.json')) {
      let pkgJson: unknown = null
      try { pkgJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) } catch { pkgJson = null }
      const hasBindingGyp = entries.some(e => e.isFile() && e.name === 'binding.gyp')
      if (declaresNativeBuild(pkgJson, hasBindingGyp)) {
        declaredDirs.add(packageDirOfNative(path.relative(appDir, dir)))
      }
    }

    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (!isNativeBinary(e.name)) continue
      const rel = path.relative(appDir, full)
      // **上限を掛けるのはこの一覧だけ**（診断用）。種類の集計は必ず最後まで続ける。
      if (nativeBinaries.length < limit) nativeBinaries.push(rel)
      const ownerDir = packageDirOfNative(rel)
      const set = kindsByDir.get(ownerDir) ?? new Set<NativeBinaryKind>()
      set.add(kindOfNativeFile(full))
      kindsByDir.set(ownerDir, set)
    }
  }
  walk(root, 0)

  // ── コピー単位（フォルダ単位）で「持っていけるか」を決める（判断は shared/deps.ts）──
  // **`.node` の有無を先に見る**こと。binding.gyp を持ちつつ公開先用の部品を同梱している
  // ライブラリを、組み立て前と誤判定しないため（`blockReasonForPackage` がその順で見る）。
  // 画面に出すのは名前なので、判定のあとで名前へまとめる（同じ名前の別コピーが両方
  // 引っかかったら、理由は `primaryBlockReason` で1つに寄せる）。
  const binaryKinds: Record<string, NativeBinaryKind[]> = {}
  const reasonsByName = new Map<string, Set<NativeBlockReason>>()
  const declaredNames = new Set<string>()
  for (const d of declaredDirs) declaredNames.add(packageOfNative(d))
  for (const dir of new Set([...kindsByDir.keys(), ...declaredDirs])) {
    const kinds = Array.from(kindsByDir.get(dir) ?? []).sort()
    const name = packageOfNative(dir)
    if (kinds.length > 0) {
      binaryKinds[name] = Array.from(new Set([...(binaryKinds[name] ?? []), ...kinds])).sort()
    }
    const reason = blockReasonForPackage(kinds, declaredDirs.has(dir))
    if (!reason) continue
    const set = reasonsByName.get(name) ?? new Set<NativeBlockReason>()
    set.add(reason)
    reasonsByName.set(name, set)
  }
  const blocked: BlockedPackage[] = Array.from(reasonsByName.keys()).sort()
    .map(name => ({ name, reason: primaryBlockReason(Array.from(reasonsByName.get(name) ?? [])) }))
  return {
    nativeBinaries,
    declaredNative: Array.from(declaredNames).sort(),
    binaryKinds,
    blocked,
  }
}

/**
 * ステージングした `app/` の中で依存ライブラリを用意する。
 *
 * **package.json が無い、または依存が無いときは何もしない**（呼び出し側で判断済みでも、
 * ここでも確かめる。無駄に npm を走らせない）。
 */
export async function installDependencies(
  appDir: string,
  onProgress?: (message: string) => void,
): Promise<InstallResult> {
  const pkgPath = path.join(appDir, 'package.json')
  if (!fs.existsSync(pkgPath)) return { ok: true, nativeBlocked: [], log: '' }

  // D-18 C: PATH がまだ決まっていなければ、決まるまで待つ（決まっていれば 0 コスト）。
  // 待たないと、起動直後の公開で npm を「入っていない」と誤判定しうる。
  await awaitLoginPath()

  if (!(await npmAvailable())) {
    // D-18 D: PATH の取得に失敗していたなら、**それが原因かもしれない**と添える
    // （直っていないときだけ。loginPathHintForMissingTool は普段は空文字を返す）。
    // 「入っているはずの npm が見つからない」は、印が無いと原因に辿り着けない。
    const hint = loginPathHintForMissingTool()
    return {
      ok: false, nativeBlocked: [], log: '',
      message: 'このアプリはライブラリを使っていますが、それを用意する道具（npm）が見つかりませんでした。'
        + 'Node.js をインストールしてから、もう一度お試しください。'
        + (hint ? `\n${hint}` : ''),
    }
  }

  onProgress?.('📚 ライブラリを用意しています…（時間がかかることがあります）')
  const r = await new Promise<{ ok: boolean; out: string }>(resolve => {
    execFile(
      'npm',
      [
        'install',
        '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error',
        // ── **公開先の形で入れる**（2026-08-18 実測で発覚）────────────────
        // 何も指定しないと、npm は**このパソコンの形**（macOS / arm64）に合う
        // 部品を選ぶ。実測: `esbuild` を入れると `@esbuild/darwin-arm64` が入り、
        // 中身は **Mach-O（macOS 用の実行ファイル）**だった。`.node` ではないので
        // 見つける仕掛けにも掛からず、**そのまま公開されて起動しない**。
        // 公開先（Alpine Linux / amd64）を指定すると `@esbuild/linux-x64`（ELF）が入る。
        ...TARGET_PLATFORM_ARGS,
        // 同じものを何度も取りに行かない（2回目以降はキャッシュから。実測 0.3秒）
        '--prefer-offline',
      ],
      { cwd: appDir, timeout: INSTALL_TIMEOUT, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}`.trim() }),
    )
  })
  const log = r.out.slice(0, 4000)
  if (!r.ok) {
    return {
      ok: false, nativeBlocked: [], log,
      message: 'ライブラリを用意できませんでした。package.json に書かれた名前が正しいか、'
        + 'インターネットに繋がっているかを確かめてください。',
    }
  }

  const modules = path.join(appDir, 'node_modules')
  // 判断（どのライブラリを断るか・その理由）は `scanModules` が
  // `blockReasonForPackage`（shared/deps.ts）に通して済ませてある。
  // **ここに条件を書き写さない**（掟10・一元定義）。**理由も1件ずつそのまま返す**
  // （1つに畳むと、理由が混ざったときに当てはまらない説明を全部に付けてしまう）。
  const nativeBlocked = fs.existsSync(modules) ? scanModules(modules).blocked : []
  return { ok: true, nativeBlocked, log }
}
