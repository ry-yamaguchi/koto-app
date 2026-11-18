// openPreviewBridge.ts — Claude の open_preview を、renderer が「存在を確かめて開いた」結果が返るまで待たせる橋。
//
// なぜ要るか: これまで onOpenPreview は知らせを投げるだけで、道具は確かめる前に「開きました」と返していた
// （無いファイルでも成功と伝わる）。知らせに id と送信時のプロジェクトを載せて renderer へ送り、
// renderer が結果の文を claude:openPreviewResult で返すまで道具の返事を待つ。
// 開く先は送信時のプロジェクト（知らせが届いた時点で見ているプロジェクトではない）。

export type OpenPreviewNotice = {
  kind: 'openPreview'
  id: string
  path: string
  /** 送信時のプロジェクト直下（退避と記録の根）。 */
  projectDir: string
  /** 送信時の作業フォルダ（public/ があればそれ）。 */
  writeRoot: string
}

/** renderer が返さないときに待つ上限。 */
export const OPEN_PREVIEW_TIMEOUT_MS = 15000

export const OPEN_PREVIEW_UNCONFIRMED = 'エラー: 開けたか確かめられませんでした'

const pending = new Map<string, (result: string) => void>()
let seq = 0

/** 1ターン分の橋を作る。send は renderer への知らせの送信（失敗したら例外）。 */
export function createOpenPreviewBridge(opts: {
  projectDir: string
  writeRoot: string
  send: (notice: OpenPreviewNotice) => void
  timeoutMs?: number
}) {
  const mine = new Set<string>()
  return {
    request(relPath: string): Promise<string> {
      const id = `openPreview-${Date.now().toString(36)}-${++seq}`
      return new Promise<string>(resolve => {
        const done = (result: string) => {
          if (!pending.delete(id)) return
          mine.delete(id)
          clearTimeout(timer)
          resolve(result)
        }
        const timer = setTimeout(() => done(OPEN_PREVIEW_UNCONFIRMED), opts.timeoutMs ?? OPEN_PREVIEW_TIMEOUT_MS)
        pending.set(id, done)
        mine.add(id)
        try {
          opts.send({ kind: 'openPreview', id, path: relPath, projectDir: opts.projectDir, writeRoot: opts.writeRoot })
        } catch {
          done(OPEN_PREVIEW_UNCONFIRMED)
        }
      })
    },
    /** 中断・終了のとき、待っている分を「確かめられなかった」で解く。 */
    cancelAll() {
      for (const id of [...mine]) pending.get(id)?.('エラー: 中断されました')
    },
  }
}

/** renderer からの結果の受け口。知らない id は無視する。 */
export function answerOpenPreview(id: unknown, result: unknown): boolean {
  if (typeof id !== 'string') return false
  const done = pending.get(id)
  if (!done) return false
  done(typeof result === 'string' ? result : OPEN_PREVIEW_UNCONFIRMED)
  return true
}
