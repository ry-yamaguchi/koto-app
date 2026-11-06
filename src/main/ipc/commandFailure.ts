// 外部コマンド（crane・tar・ssh など）の失敗を、画面に出せる形の Error にする。
// execFile の失敗の message は「Command failed: <コマンドと引数すべて>\n<stderr>」で、
// 引数に渡した値（ユーザー名・パス）がそのまま入る。画面と控えに出すのは stderr だけにする。
// 返す Error は failureText / withFailureDetail にそのまま渡せる（errno の符号は code に残す）。

export function commandFailureOf(e: unknown): Error {
  const err = (e && typeof e === 'object' ? e : {}) as { stderr?: unknown; code?: unknown; killed?: unknown; signal?: unknown; message?: unknown }
  const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf-8').trim() : ''
  // tar など手元のファイルを扱う道具は errno の符号を持たず、stderr の文だけで知らせる。空き不足と権限は符号にして、手元のファイルの失敗と見分けられるようにする
  const code = typeof err.code === 'string' ? err.code
    : /No space left on device/i.test(stderr) ? 'ENOSPC'
    : /Permission denied/i.test(stderr) ? 'EACCES'
    : undefined
  let message = stderr
  if (!message) {
    if (err.killed || err.signal) message = 'timed out (command was terminated)'
    else if (code) message = code
    else message = 'command failed'
  }
  return Object.assign(new Error(message), code ? { code } : {})
}
