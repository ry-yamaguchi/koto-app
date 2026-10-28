// trashGuard.ts — 「ゴミ箱へ送ってよい場所か」の判断（純ロジック）。
//
// ── なぜ要るか（2026-08-20 セキュリティ点検）──────────────────────────
// `fs:trash` は**どんな絶対パスでも**ゴミ箱へ送れる作りだった。
// いまは画面側の守り（contextIsolation / sandbox / dangerouslySetInnerHTML なし /
// eval なし）が固いので**到達する道は無い**が、1枚目の守りに頼り切らない。
//
// ── 決めごと ────────────────────────────────────────────────────────
// ・ホームフォルダの**外**は送れない（`/` や `/Applications` を守る）
// ・ホーム直下（深さ1）も送れない（`~/Library` `~/Documents`、作業フォルダ自体を守る）
// ・深さ2以上なら送れる（`~/SAKURAIDE/プロジェクト` とその中身が対象）
//
// 消せる範囲を狭めすぎないこと。**プロジェクトごと削除**する機能があるので、
// 「いま開いているプロジェクトの中だけ」には狭められない。
//
// ── 0.6.24 E: 記録とプロジェクトのフォルダを、ファイル一覧から移さない・名前を変えない ──────────────
// ホームの深さ（canTrash）だけでは、深さ2以上の `.sakura-cloud/state.json` や、プロジェクトのフォルダ自体も送れた。
// 記録（公開の記録・履歴・チャット）を送る・名前を変えると、公開したものを Koto から破棄できなくなる（月額が続く）。
// プロジェクトのフォルダは、先に公開を破棄する流れ（プロジェクトの 🗑）を通さずに送れてしまう。
// `fileOpVerdict` が「そこが何か」を答える（ファイルを読むのは呼び手が作る `probe` だけ。ここは純関数）。
import { KOTO_INTERNAL_DIRS, KOTO_INTERNAL_FILES } from './publishExclude'
import { DATA_LAYER_LOCAL_DIR } from './objectStorage'

/** 判断の結果。ダメなときは**理由をそのまま画面に出せる文**にする。 */
export type TrashCheck = { ok: true } | { ok: false; reason: string }

/**
 * その場所をゴミ箱へ送ってよいか（純関数）。
 *
 * @param home ホームフォルダの絶対パス
 * @param target 送ろうとしている絶対パス
 * @param sep パス区切り（既定 '/'）
 */
export function canTrash(home: string, target: string, sep = '/'): TrashCheck {
  const h = String(home ?? '').replace(new RegExp(`${sep}+$`), '')
  const t = String(target ?? '').replace(new RegExp(`${sep}+$`), '')
  if (!h || !t) return { ok: false, reason: '場所が指定されていません' }
  // `..` を含む道は受けない（正規化前に弾く）
  if (t.split(sep).includes('..')) return { ok: false, reason: '不正な場所です' }
  if (t === h || !t.startsWith(h + sep)) {
    return { ok: false, reason: 'ゴミ箱へ送れるのは、ホームフォルダの中のものだけです' }
  }
  const depth = t.slice(h.length + 1).split(sep).filter(Boolean).length
  if (depth < 2) {
    return { ok: false, reason: 'ホームフォルダの直下は、まとめてゴミ箱へ送れません（中のファイルやプロジェクトを選んでください）' }
  }
  return { ok: true }
}

// ── 0.6.24 E-1: ファイル一覧の操作（ゴミ箱・名前の変更）の対象が何か ──────────────────────────────────

/**
 * Koto の記録の名前（`.sakuraide`・`.sakuraide-backup`・`.sakura-cloud`・`.sakuraide.json`）。
 * 公開物から外すもの（`publishExclude.ts` の `KOTO_INTERNAL_DIRS`・`KOTO_INTERNAL_FILES`）から、`.koto-data` だけを除いて作る
 * （`.koto-data` は利用者のアプリのデータで、ゴミ箱から戻せる。守りに入れない）。名前の一覧は tests/trashGuard.test.ts が書き下して突き合わせる。
 */
export const KOTO_RECORD_NAMES: readonly string[] =
  [...KOTO_INTERNAL_DIRS, ...KOTO_INTERNAL_FILES].filter(n => n.toLowerCase() !== DATA_LAYER_LOCAL_DIR.toLowerCase())

const RECORD_NAMES_LOWER = new Set(KOTO_RECORD_NAMES.map(n => n.toLowerCase()))

/** その名前（1つの段）が記録の名前か。大文字小文字は区別しない（macOS の既定は区別しない。`.SAKURA-CLOUD` も同じ実体）。 */
export function isRecordName(name: string): boolean {
  return RECORD_NAMES_LOWER.has(String(name ?? '').toLowerCase())
}

/**
 * 対象が何か。
 *  - `'record'`: パスの途中の段のどれかが記録の名前（記録そのもの・記録のフォルダの中）
 *  - `'project'`: 直下に `.sakuraide.json`（ファイル）か `.sakura-cloud`（フォルダ）があり、直下の子にはプロジェクトが無い（プロジェクトの根）
 *  - `'workspace'`: 直下の子のどれかに、その印がある（プロジェクトが入っているフォルダ）。**自分に印があっても同じ**（R2-c）
 *  - `'unknown'`: 調べられなかった（ENOENT 以外の失敗）。自分の印・直下の子の一覧・子の印のどれでも。**呼び手は断る**
 *  - `'plain'`: そのほか（ふつうのファイル・フォルダ・そもそも無いもの）
 */
export type FileOpVerdict = 'plain' | 'record' | 'project' | 'workspace' | 'unknown'

/**
 * 対象を調べる口（main が実フォルダで作る。**投げない約束**。調べられなければ `'unknown'`）。対象は呼び手が決めて閉じ込める。
 * ENOENT（無い）は「無い」と答え、それ以外の失敗（権限・I/O）は `'unknown'`。
 */
export type FileOpProbe = {
  /** 対象そのもの。実フォルダ `'dir'`・ファイルやリンク `'other'`・無い `'missing'`。 */
  kindOfSelf(): 'dir' | 'other' | 'missing' | 'unknown'
  /** 対象（`child` を渡せば、その直下の子）の直下に `.sakuraide.json`（ファイル）か `.sakura-cloud`（フォルダ）があるか。 */
  hasProjectMarker(child?: string): boolean | 'unknown'
  /** 対象の直下の、実フォルダの子の名前（リンクは数えない。ゴミ箱へ送ってもリンクの先は動かない）。 */
  childDirs(): readonly string[] | 'unknown'
}

/**
 * ゴミ箱・名前の変更の対象が何かを答える（純関数）。`segments` は対象の絶対パスの各段。
 * 記録の名前は fs を読まずに決める。それ以外は `probe` で調べ、**調べられなかった・probe が投げた回は `'unknown'`**（`'plain'` に倒さない）。
 */
export function fileOpVerdict(args: { segments: readonly string[]; probe: FileOpProbe }): FileOpVerdict {
  try {
    if (args.segments.some(isRecordName)) return 'record'
    const self = args.probe.kindOfSelf()
    if (self === 'unknown') return 'unknown'
    if (self !== 'dir') return 'plain' // ファイル・リンク・無いもの。中を調べる相手がいない
    const own = args.probe.hasProjectMarker()
    if (own === 'unknown') return 'unknown'
    // **自分に印があっても、直下の子を調べる**（R2-c）。印は、開いたフォルダで公開先を選ぶだけで書かれる。そのフォルダを「プロジェクト」と答えると、
    // 中の子のプロジェクトの記録ごと移り、子の専有型の止めも走っている操作の確かめも通らない。
    const kids = args.probe.childDirs()
    if (kids === 'unknown') return 'unknown'
    let unreadable = false
    for (const kid of kids) {
      const m = args.probe.hasProjectMarker(kid)
      if (m === 'unknown') unreadable = true
      else if (m) return 'workspace'
    }
    if (unreadable) return 'unknown'
    return own ? 'project' : 'plain'
  } catch {
    return 'unknown'
  }
}
