// hanamiiErrorCode.ts — HANAMII の latestDeployment.errorCode を、非エンジニア向けの日本語に直す表（唯一の定義・掟10）。
// main（Node）と renderer の両方から使う（electron にも Node にも依存しない）。
//
// 値の名前は原本（GET /api/v1/projects/:id の errorCode）、意味は名前と HANAMII のトラブルシューティングの表からの推定。
// 値ごとの意味は原本に書かれていないので、文は言い切らない。値は check_error・build_error・deploy_error・health_error・null。
// 表に無い値は推測で網羅せず、コードをそのまま見せる。

const ERROR_CODE_TEXT: Record<string, string> = {
  check_error: 'アップロードした内容の検証で問題が見つかったようです。必要なファイル（Node.js は package.json と scripts.start、Python は requirements.txt か pyproject.toml、PHP は composer.json と Dockerfile）がそろっているか確かめてください。',
  build_error: 'ビルドに失敗しました。直前に追加したライブラリ名の誤りや、package.json の記述ミスが典型的な原因です。',
  deploy_error: 'アプリの起動を確かめられなかったようです。起動のコマンド（package.json の scripts.start など）と、環境変数 PORT（未設定なら 8080）で待ち受けているかを確かめてください。',
  health_error: 'ヘルスチェックに応えなかったようです。ヘルスチェックのパスで、アプリが 200 を返すかを確かめてください。',
}

/**
 * deploy_error に足す一文（ヘルスチェックを有効にしているときだけ）。
 * 2026-11-10 の 0.6.28-rc.2 の実機の確かめで1回観察: ヘルスチェックのパスが 404 の公開し直しが、health_error ではなく deploy_error で返った。
 * HANAMII が健康確認の失敗を常に deploy_error にするとは言えないので、断定しない。
 */
export const HEALTH_CHECK_ALSO_SENTENCE = 'ヘルスチェックを有効にしている場合は、そのパスでアプリが 200 を返すかも確かめてください。'

/**
 * errorCode を日本語の説明に変える。空は ''、表に無い値は「エラーコード: <値>」。
 * `healthCheckEnabled`: そのプロジェクトのヘルスチェックを有効にしているか。true で deploy_error のときだけ一文を足す。
 * 呼ぶ側（main の公開の結果・【公開】の状態欄）が、自分の知っている設定を渡す。
 */
export function describeErrorCode(code: string | null | undefined, opts?: { healthCheckEnabled?: boolean }): string {
  if (!code) return ''
  if (!Object.prototype.hasOwnProperty.call(ERROR_CODE_TEXT, code)) return `エラーコード: ${code}`
  return code === 'deploy_error' && opts?.healthCheckEnabled === true ? ERROR_CODE_TEXT[code] + HEALTH_CHECK_ALSO_SENTENCE : ERROR_CODE_TEXT[code]
}
