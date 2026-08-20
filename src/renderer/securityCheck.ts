// 公開前セキュリティチェック：プロジェクトの主要ファイルをAIがレビューし、
// 秘密情報の直書き・XSS・公開すべきでないファイル等を公開前に検出する。
// （開発時の「作りながら担保」を補完する、節目のチェック）

import { checkBeforeRequest, recordUsage, estimateTokens, getDefaultModel } from './usage'
import { isSecretFile } from '../shared/publishExclude'

export interface SecurityCheckResult {
  verdict: 'ok' | 'warn' | 'skip' // 問題なし / 要確認 / チェック未実施
  report: string
}

const MAX_FILES = 8
const MAX_CHARS_PER_FILE = 6000
// チェック対象（コード・設定ファイルを優先）
const TARGET_RE = /\.(html?|php|js|mjs|cjs|css|json|ya?ml|sh)$|(^|\/)(Dockerfile|\.htaccess)$/i
// 中身を読むまでもなく公開NGなファイル名。判定の中心は publishExclude.ts の isSecretFile
// （公開から除外する定義と同じものを使う）。名前に credentials / secret を含むものも足す。
const SECRET_HINT_RE = /credentials|secret/i

/** そのファイルが「名前だけで公開NGと分かる」ものか。中身は読まない。 */
function looksSecret(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? relPath
  return isSecretFile(base) || SECRET_HINT_RE.test(relPath)
}

/**
 * チェックにかけるファイルを選ぶ（純関数）。
 *
 * ── 秘密ファイルの中身は絶対にAIへ送らない（2026-08-09 の総点検で発覚）──────
 * 以前は TARGET_RE が `.env` にマッチしており、**`.env` の中身（APIキーやDBパスワード）が
 * さくらのAI Engine へ送信されていた**。名前だけで「公開NG」と判定できる（それが
 * secretFiles の役目）ので、中身を送る必要はまったく無い。
 *
 * 戻り値の targets は中身を読んで送るもの、secretFiles は**名前だけ**を伝えるもの。
 */
export function pickCheckTargets(files: readonly string[]): { targets: string[]; secretFiles: string[] } {
  const secretFiles = files.filter(f => looksSecret(f) && f !== '.sakuraide.json')
  const targets = files.filter(f => TARGET_RE.test(f) && !looksSecret(f)).slice(0, MAX_FILES)
  return { targets, secretFiles }
}

/**
 * AIの回答1行目から判定を決める（純関数）。
 *
 * **「要確認」を優先する。** 以前は `includes('問題なし')` だけを見ていたため、
 * 「判定: 要確認（一部は問題なし）」のような書き方をされると **ok** になっていた。
 * 迷ったら警告側に倒すのが、この種の判定の正しい既定である。
 */
export function judgeVerdict(report: string): 'ok' | 'warn' {
  const firstLine = report.split('\n')[0] ?? ''
  if (firstLine.includes('要確認')) return 'warn'
  return firstLine.includes('問題なし') ? 'ok' : 'warn'
}

export async function runSecurityCheck(projectDir: string, apiKey: string): Promise<SecurityCheckResult> {
  if (!apiKey) return { verdict: 'skip', report: 'APIキーが未設定のため、セキュリティチェックを省略しました。' }
  const budget = checkBeforeRequest(apiKey)
  if (!budget.allowed) return { verdict: 'skip', report: 'AI利用上限に達しているため、セキュリティチェックを省略しました。' }

  let files: string[] = []
  try { files = await window.electronAPI.fs.projectFiles(projectDir) } catch { /* 取得失敗は下でskip */ }

  // 機械的に分かる危険（.env等）は名前だけを指摘に含める。**中身は送らない。**
  const { targets, secretFiles } = pickCheckTargets(files)
  if (!targets.length && !secretFiles.length) {
    return { verdict: 'skip', report: 'チェック対象のコードファイルが見つかりませんでした。' }
  }

  const parts: string[] = []
  for (const f of targets) {
    try {
      const c = await window.electronAPI.fs.readFile(`${projectDir}/${f}`)
      parts.push(`--- ${f} ---\n${c.slice(0, MAX_CHARS_PER_FILE)}`)
    } catch { /* 読めないファイルはスキップ */ }
  }

  const userPrompt =
    '以下は公開予定のWebサイト/アプリのファイルです。公開前のセキュリティチェックをしてください。\n\n' +
    '観点：\n' +
    '- APIキー・パスワード・トークン等の秘密情報の直書き\n' +
    '- XSS（ユーザー入力をエスケープせずHTMLへ出力 等）\n' +
    '- 公開すべきでないファイルや個人情報の混入\n' +
    '- フォームの送信先・外部スクリプトの読み込み元が安全か\n' +
    '- その他、公開して問題になりうる点\n\n' +
    '出力形式（厳守）：\n' +
    '1行目: 「判定: 問題なし」または「判定: 要確認」\n' +
    '2行目以降: 指摘の箇条書き（最大5件、各行「ファイル名: 内容と対処」。問題なしの場合は確認した観点を1〜2行で）\n\n' +
    (secretFiles.length ? `※ 次のファイルは名前からして公開NGの可能性が高い: ${secretFiles.join(', ')}\n\n` : '') +
    parts.join('\n\n')

  const model = getDefaultModel()
  try {
    const res = await window.electronAPI.sakura.chat({
      apiKey,
      model,
      messages: [
        { role: 'system', content: 'あなたはWebセキュリティのレビュアーです。日本語のみで、指定された出力形式に厳密に従ってください。' },
        { role: 'user', content: userPrompt },
      ],
      // 800 では推論型モデル（gpt-oss / Kimi 等）が考えるだけで使い切り、
      // 判定を書き始める前に打ち切られる（2026-08-20 実機で、まとめ側で同じことが起きた）。
      maxTokens: 2048,
      temperature: 0.2,
    })
    const report = (res.content ?? '').trim()
    recordUsage(apiKey, model, res.usage?.prompt_tokens ?? estimateTokens(userPrompt), res.usage?.completion_tokens ?? estimateTokens(report))
    if (!report) return { verdict: 'skip', report: 'チェック結果を取得できませんでした。' }
    return { verdict: judgeVerdict(report), report }
  } catch (e: any) {
    // チェック失敗で公開を止めない（skip扱い。ユーザーには表示する）
    return { verdict: 'skip', report: `チェックに失敗しました（${e?.message ?? e}）。` }
  }
}
