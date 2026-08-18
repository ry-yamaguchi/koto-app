// vercelFit.ts — Vercel に「そもそも載る作りか」を、押す前に判断する（純ロジック）。
//
// ── なぜ要るか（2026-08-15）──────────────────────────────────────────
// Vercel の画面には**折りたたみの注意書き**しか無く（「常駐サーバは動きません」）、
// 公開ボタンには何の確認も無かった。押すとデプロイは**成功する**が、
// Node の常駐サーバは起動しないので、**ソースが丸見えのページ**が公開される。
// AppRun で同じことが起きている（内蔵ビルダーが static 決め打ちだった件）。
//
// **成功と表示されながら壊れている**のが、いちばん質の悪い失敗である。
// AppRun には「公開できるか確かめる」を付けた（v0.3.20）。Vercel にも要る。
//
// ── 判断の材料（推測しない）──────────────────────────────────────────
// ・ソースが自分でポートを待ち受けているか（`http.createServer` / `.listen(`）
// ・データの保存（koto-data）を使っているか
//   → **Koto は Vercel へ保存場所の設定（KOTO_STORAGE_*）を渡す仕組みを持たない。**
//     渡せない以上、公開しても読み書きできない。これは正直に止める。
// ・Vercel が得意な作り（Next.js 等のビルド）か
//
// 判断はここ、走査は main（IO）。

import type { PreflightCheck } from './preflight'

/**
 * このソースは「自分でポートを待ち受ける常駐サーバ」か（純関数）。
 *
 * Vercel はリクエストのたびに関数を呼ぶ形（サーバーレス）なので、
 * 待ち受け続けるプログラムは動かない。
 */
export function serverListens(sourceText: string): boolean {
  const t = String(sourceText ?? '')
  if (/\bhttps?2?\s*\.\s*createServer\s*\(/.test(t)) return true
  if (/\bcreateServer\s*\(/.test(t) && /\.listen\s*\(/.test(t)) return true
  // express / fastify / koa の定番
  if (/\b(app|server|fastify)\s*\.\s*listen\s*\(/.test(t)) return true
  return false
}

/** Vercel が得意な作り（ビルドして配るもの）か（純関数）。 */
export function looksLikeFramework(packageJson: unknown | null): boolean {
  const p = (packageJson ?? {}) as Record<string, unknown>
  const deps = { ...(p.dependencies as object ?? {}), ...(p.devDependencies as object ?? {}) }
  const names = Object.keys(deps)
  if (names.some(n => /^(next|nuxt|astro|vite|gatsby|react-scripts|@sveltejs\/kit|@remix-run\/)/.test(n))) return true
  const scripts = (p.scripts ?? {}) as Record<string, unknown>
  return typeof scripts.build === 'string' && scripts.build.trim().length > 0
}

/** 走査の結果（main が集める）。 */
export type VercelScan = {
  /** 解析済みの package.json（無ければ null）。 */
  packageJson: unknown | null
  /** 常駐サーバとして待ち受けているファイル（プロジェクトからの相対パス）。 */
  listens: readonly string[]
  /** データの保存（koto-data）を使っているファイル。 */
  usesData: readonly string[]
  /** 公開できるファイルが1つでもあるか。 */
  hasFiles: boolean
}

/**
 * Vercel へ公開する前の確認（純関数）。
 *
 * **`ng` は「確実に壊れる」と分かったときだけ。** 判別できないものは `warn` にして
 * 通す（確かめられなかっただけで公開できないのは、壊れているのと同じ）。
 */
export function judgeVercelFit(scan: VercelScan): PreflightCheck[] {
  const checks: PreflightCheck[] = []
  const listens = scan.listens ?? []
  const usesData = scan.usesData ?? []

  // ── 配るファイル ────────────────────────────────────────────────────
  checks.push(scan.hasFiles
    ? { id: 'files', label: '公開するファイル', status: 'ok', note: '公開できるファイルがあります。' }
    : {
        id: 'files', label: '公開するファイル', status: 'ng',
        note: '公開できるファイルが見つかりません。まず「① 作る」でファイルを作ってください。',
      })

  // ── アプリの作り ────────────────────────────────────────────────────
  if (listens.length > 0) {
    checks.push({
      id: 'runtime', label: 'アプリの作り', status: 'ng',
      note: `このアプリは自分でポートを待ち受ける常駐サーバです（${listens.slice(0, 2).join('、')}）。`
        + 'Vercel はリクエストのたびに処理を呼ぶ仕組みなので、待ち受け続けるプログラムは動きません。'
        + '公開先を「さくらのAppRun」か「HANAMII」に変えると、いまのまま動きます。'
        + 'Vercel のままにするなら、サーバーレス関数の形に書き直す必要があります。',
      fix: 'ask-ai',
    })
  } else if (looksLikeFramework(scan.packageJson)) {
    checks.push({ id: 'runtime', label: 'アプリの作り', status: 'ok', note: 'Vercel が得意な作りです（ビルドして配ります）。' })
  } else if (!scan.packageJson) {
    checks.push({ id: 'runtime', label: 'アプリの作り', status: 'ok', note: '静的なファイルをそのまま配ります。' })
  } else {
    checks.push({
      id: 'runtime', label: 'アプリの作り', status: 'warn',
      note: '作りを判別できませんでした。公開したあと、ページが正しく表示されるか確かめてください。',
    })
  }

  // ── データの保存 ────────────────────────────────────────────────────
  if (usesData.length > 0) {
    checks.push({
      id: 'storage', label: 'データの保存', status: 'ng',
      note: `このアプリはデータの保存を使っています（${usesData.slice(0, 2).join('、')}）。`
        + 'Koto は Vercel へ保存場所の設定を渡す仕組みをまだ持っていないため、'
        + '公開しても読み書きできません（保存したつもりで消えます）。'
        + '公開先を「さくらのAppRun」にすると、いまのデータのまま動きます。',
      fix: 'ask-ai',
    })
  } else {
    checks.push({ id: 'storage', label: 'データの保存', status: 'ok', note: 'このアプリはデータの保存を使っていません。' })
  }

  return checks
}
