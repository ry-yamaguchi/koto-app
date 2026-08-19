// singleInstance.ts — もう1つの Koto が同じ保存領域を使っていないか（純ロジック）。
//
// ── なぜ Electron の仕掛けだけでは足りないか（2026-08-19 実機）──────────
// `app.requestSingleInstanceLock()` は**互いに名乗り合う**仕組みなので、
// **相手が古い版だと効かない**。実際にこうなった:
//
//   ・rc（守りあり）が先 → 正式版（守りなし）を起動 → **正式版が異常終了**
//     （守りが無いので何も確かめずに同じ保存領域を開き、競合して落ちた）
//   ・正式版（守りなし）が先 → rc を起動 → **鍵は誰も握っていないので rc も開く**
//     → 二重起動。今日キーが消えたのと同じ形
//
// 相手が名乗らないなら、**こちらから見に行く**。動いているプロセスの一覧から
// 「同じ保存領域を使う別の Koto」を探す。判断はここ、`ps` の実行は main。

/** `ps -ax -o pid=,command=` の1行から、Koto 本体を見分ける（純関数）。 */
export function parsePsLine(line: string): { pid: number; command: string } | null {
  const m = /^\s*(\d+)\s+(.*)$/.exec(String(line ?? ''))
  if (!m) return null
  return { pid: Number(m[1]), command: m[2] }
}

/**
 * その行は「Koto の本体プロセス」か（純関数）。
 *
 * **画面や補助のプロセス（Koto Helper）は数えない。** 1つのアプリが複数持つので、
 * 数えると必ず二重起動に見えてしまう。
 */
export function isKotoMain(command: string): boolean {
  const c = String(command ?? '')
  return /\/Koto\.app\/Contents\/MacOS\/Koto(\s|$)/.test(c) && !/Koto Helper/.test(c)
}

/** そのプロセスが使っている保存領域（指定が無ければ null＝既定の場所）。 */
export function userDataDirOf(command: string): string | null {
  const m = /--user-data-dir=("([^"]*)"|(\S+))/.exec(String(command ?? ''))
  return m ? (m[2] ?? m[3] ?? null) : null
}

/**
 * 同じ保存領域を使う別の Koto を探す（純関数）。
 *
 * **見つからないことを「大丈夫」と読み替えない。** `ps` が読めなかったときは
 * 呼び出し側が空文字を渡すことになるが、そのときは何も見つからない＝通す。
 * ここは**追加の守り**であって、これが唯一の砦ではない（Electron の仕掛けが本体）。
 */
export function findOtherKoto(opts: {
  psOutput: string
  myPid: number
  /** 自分が使っている保存領域（絶対パス）。 */
  myUserDataDir: string
}): { pid: number } | null {
  for (const line of String(opts.psOutput ?? '').split('\n')) {
    const row = parsePsLine(line)
    if (!row || row.pid === opts.myPid || !isKotoMain(row.command)) continue
    const dir = userDataDirOf(row.command)
    // 指定なし＝既定の保存領域。自分も既定なら同じ場所を使っている
    const same = dir === null ? isDefaultDir(opts.myUserDataDir) : dir === opts.myUserDataDir
    if (same) return { pid: row.pid }
  }
  return null
}

/** 既定の保存領域か（`--user-data-dir` を渡していない側との突き合わせに使う）。 */
export function isDefaultDir(dir: string): boolean {
  return /\/Application Support\/Koto\/?$/.test(String(dir ?? ''))
}
