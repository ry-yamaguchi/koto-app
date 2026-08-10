// newProjectRequest.ts — 新規プロジェクト作成をチャットへ依頼するときの依頼文を組み立てる（純粋関数・Vitest対象）。
//
// 背景（2026-07-31 全面切替）: これまで新規プロジェクトの雛形生成は NewProjectModal 内で
// 一問一答のAI呼び出しを行い、返ってきたJSONをKoto側で書き込んでいた。しかしこの方式には
//  - モーダルで待たされる（チャットの様子が見えない）
//  - 失敗しても「やり直して」と言い直せない（案内ファイルを読んで新規作成をやり直すしかない）
//  - 1回の応答に全ファイルを詰め込む必要があり、出力上限で切れると失敗する
//    （2026-07-14 の Kimi 400 Unterminated string と同型の失敗）
//  - ツール非対応モデルの自動切替などチャット経路の既存機能が使えない
//  - 雛形生成の経路がモーダル用・チャット用の2本立てになる（どちらかが古くなる事故の温床）
// という問題があったため、モーダルは「.sakuraide.json だけのプロジェクトを作る」ところまでにし、
// 実際のファイル生成はこの関数が作る依頼文を IDE のチャットへ流し込んで行わせる方式に切り替えた。
//
// sitePrompt/targetPrompt（公開先ごとの構成指示）は、AI呼び出し方式だった頃からの資産をそのまま
// 再利用する。同じ文面を2箇所に持たないよう、この移設が「唯一の定義」になる。

import type { TargetId } from './targetProfiles'

// サイトの種類（NewProjectModal.tsx の選択肢と共有。定義をここへ一本化し、二重管理を避ける）。
export const SITE_TYPES: { id: string; label: string; hint: string }[] = [
  { id: 'lp', label: 'LP（1枚もの）', hint: '商品・サービス紹介の1ページ' },
  { id: 'shop', label: '会社・お店', hint: 'ホーム/紹介/アクセス/お問い合わせ' },
  { id: 'portfolio', label: 'ポートフォリオ', hint: '作品・実績の紹介' },
  { id: 'blog', label: 'ブログ風', hint: 'お知らせ・記事一覧' },
]

/** Webサイト依頼時の追加指示（公開先別の構成も含む）。旧 buildScaffoldPrompt からの移設。 */
function sitePrompt(siteType: string, target: TargetId): string {
  const type = SITE_TYPES.find(s => s.id === siteType)
  let p =
    `\n\n【種別: Webサイト（${type?.label ?? siteType}）重要・最優先で従うこと】\n` +
    `- 静的なWebサイト（HTML/CSS/必要最小限のJS）として作る。フレームワークやビルドツールは使わない\n` +
    (siteType === 'lp'
      ? `- 1ページ構成（index.html）。ヒーロー・特徴・お問い合わせ導線のセクションを持つLPにする\n`
      : `- 複数ページ構成（index.html / about.html / contact.html など必要なページ）にし、全ページ共通のナビゲーションを付ける\n`) +
    `- スマホ対応（レスポンシブ）にする\n` +
    `- 文章は要望に合わせた自然な日本語の下書きを入れる（ダミーの「Lorem ipsum」は禁止）\n` +
    `- 画像ファイルは作れないので、配色・CSSグラデーション・絵文字で見栄えを作る\n` +
    `- お問い合わせは mailto リンクを基本にする`
  if (target === 'sakura-rental') {
    p +=
      `\n【公開先: さくらのレンタルサーバ】\n` +
      `- サイト一式を public/ に置く（サーバの ~/www に配置される）\n` +
      `- public/.htaccess（HTTPS強制・DirectoryIndex）を含める\n` +
      `- deploy.sh（rsync で public/ → ~/www へ同期）を含める\n` +
      `- PHP/MySQL は要望にない限り使わない（静的サイトとして公開する）`
  } else if (target === 'sakura-apprun') {
    p +=
      `\n【公開先: さくらのAppRun】\n` +
      `- nginx:alpine で静的サイトを配信する Dockerfile を含める（ポート8080で待ち受け、linux/amd64）\n` +
      `- .dockerignore を含める（公開は IDE の【③公開】→さくらのAppRun が自動で行うため deploy.sh は不要）`
  }
  return p
}

/** アプリ依頼時、公開先ごとの追加指示。旧 buildScaffoldPrompt からの移設。 */
function targetPrompt(target: TargetId): string {
  switch (target) {
    case 'sakura-rental':
      return (
        `\n\n【公開先: さくらのレンタルサーバ（重要・最優先で従うこと）】\n` +
        `- 実行環境は「PHP 8系 + MySQL + Apache」。Node.js/常駐プロセスは使えない。サーバ側コードは必ずPHPにする\n` +
        `- 公開ファイルは public/ に置く（サーバの ~/www に配置）。DB設定など非公開は app/ に置く（~/app）\n` +
        `- public/.htaccess（HTTPS強制・DirectoryIndex・キャッシュ）と public/.user.ini（PHP設定）を含める\n` +
        `- app/db.php（PDOでMySQL接続）と app/config.sample.php（接続情報の雛形）を含める\n` +
        `- deploy.sh（rsyncで public/→~/www、app/→~/app へ同期）を含める\n` +
        `- README.md に公開手順（MySQL作成→config.php作成→deploy.sh実行→独自ドメイン+無料SSL）を日本語で詳しく書く\n` +
        `- レンタルサーバで使える機能（PHP/MySQL/cron/メール/SSL）を活かした実装にする`
      )
    case 'sakura-apprun':
      return (
        `\n\n【公開先: さくらのAppRun（重要・最優先で従うこと）】\n` +
        `- コンテナをサーバレス実行する環境。必ず Dockerfile を含め、コンテナ化する\n` +
        `- アプリは環境変数 PORT（既定 8080）で待ち受ける。0.0.0.0 でリッスンする\n` +
        `- Dockerfile は linux/amd64 前提。.dockerignore も含める\n` +
        `- README.md に公開手順（IDE の【③公開】→さくらのAppRun から、Docker不要でそのまま公開）を日本語で書く\n` +
        `- ヘルスチェック用に /healthz を用意する。スタックは要望に合わせて選んでよい（Node/Python等）`
      )
    case 'hanamii':
      return (
        `\n\n【公開先: HANAMII（重要・最優先で従うこと）】\n` +
        `- さくらのクラウド基盤上の国産PaaS。コンテナとして実行される\n` +
        `- 言語マニフェスト（Node なら package.json、Python なら requirements.txt 等）を必ず含める\n` +
        `- アプリは環境変数 PORT（既定 8080）で待ち受ける。0.0.0.0 でリッスンする\n` +
        `- Dockerfile を含める場合は必ず「EXPOSE 8080」を書く（HANAMII は待ち受けポートを EXPOSE で判定する）\n` +
        `- 永続データはコンテナ内のローカルファイルに保存しない（再起動で消える前提）\n` +
        `- README.md に公開手順（IDE の【③公開】→ HANAMII から公開）を日本語で書く`
      )
    case 'sakura-vps':
      return `\n\n【公開先: さくらのVPS】サーバ内で完結する構成にし、起動方法・systemd例・必要パッケージをREADMEに日本語で記載する。`
    case 'sakura-cloud':
      return `\n\n【公開先: さくらのクラウド】さくらのクラウドの各サービス利用を前提に、推奨構成と構築手順の概要をREADMEに日本語で記載する。`
    default:
      return ''
  }
}

export interface NewProjectRequestArgs {
  kind: 'site' | 'app' | 'blank'
  name: string
  /** kind==='site' のときの種別ID（SITE_TYPES の id）。 */
  siteType?: string
  /** kind==='app' のときのベース表示名（例: 'React'）。 */
  templateLabel?: string
  /** kind==='app' のときのベース補足（例: 'Vite + React + TypeScript'）。 */
  templateHint?: string
  target: string
  description: string
}

/**
 * buildNewProjectRequest — 新規プロジェクトの初期ファイル一式をチャットに作ってもらうための依頼文を組み立てる。
 * kind==='blank'（まっさら）は依頼を送らない設計のため null を返す（呼び出し側は dispatch をスキップする）。
 *
 * プロジェクトフォルダ自体は呼び出し側（NewProjectModal.tsx）が .sakuraide.json だけを含む状態で
 * 既に作成済み・オープン済みであることを前提にした文面にする（この関数はその前提を明示するだけで、
 * フォルダ作成やIPC呼び出しは一切行わない＝純粋関数）。
 */
export function buildNewProjectRequest(args: NewProjectRequestArgs): string | null {
  const { kind, name, siteType, templateLabel, templateHint, target, description } = args
  if (kind === 'blank') return null

  const t = target as TargetId
  const desc = description.trim()

  const whatLine =
    kind === 'site'
      ? `作るもの: Webサイト（${SITE_TYPES.find(s => s.id === siteType)?.label ?? siteType ?? ''}）`
      : `作るもの: アプリ（ベース: ${templateLabel ?? ''}${templateHint ? `／${templateHint}` : ''}）`

  const wantLine =
    kind === 'site'
      ? `要望: ${desc || '特になし。種別に合った標準的な構成でよい。'}`
      : `要望: ${desc || '特になし。ベースに沿った最小限の雛形でよい。'}`

  const stackGuide = kind === 'site' ? sitePrompt(siteType ?? 'lp', t) : targetPrompt(t)

  return (
    `新規プロジェクト「${name}」のフォルダは作成済みで、いまこのプロジェクトを開いています。\n` +
    `ここから初期ファイル一式を作成してください。\n\n` +
    `プロジェクト名: ${name}\n` +
    `${whatLine}\n` +
    `${wantLine}` +
    stackGuide +
    `\n\n【必ず守ること】\n` +
    `- write_file / edit_file で実際にファイルを作成すること（説明するだけで終わらせないこと）\n` +
    `- README.md を必ず含めること\n` +
    `- 一通り作り終えるまで途中で止めないこと。完成したら、次に何をすればよいかを一言添えること`
  )
}

// ── 依頼の受け渡し（モジュールスコープの一時退避） ──────────────────────────────
// NewProjectModal.tsx は作成直後に window.dispatchEvent(new CustomEvent('sakura-new-project-request', ...))
// で ChatPanel.tsx へ依頼を渡す（sakura-target-changed と同じ作法）。しかし「初めてのプロジェクト作成」では
// ChatPanel がまだマウントされておらず（IDEモード表示は mode==='ide' && currentDir が条件のため、
// 最初のプロジェクトが作られるまで ChatPanel 自体が存在しない）、その瞬間に発火した CustomEvent は
// 受け手不在のまま失われてしまう。ここへも同じ内容を退避しておき、ChatPanel が後からマウントされた
// タイミングで拾い直せるようにする（Electron のレンダラは1ページのまま切り替わるため、
// モジュールスコープの値はプロジェクト作成→ChatPanelのマウントをまたいで生き続ける）。
let pendingNewProjectRequest: { dir: string; prompt: string } | null = null

/** 依頼を退避する（NewProjectModal.tsx が作成直後・dispatchEvent と同じタイミングで呼ぶ）。 */
export function stashNewProjectRequest(dir: string, prompt: string): void {
  pendingNewProjectRequest = { dir, prompt }
}

/**
 * dir が一致する保留中の依頼があれば取り出して消費する（一度取り出すと消える＝二重送信防止の一助）。
 * 一致しない場合は null を返し、保留中の内容はそのまま残す（別プロジェクトへ切り替わっただけの可能性があるため）。
 */
export function takeNewProjectRequest(dir: string): string | null {
  if (pendingNewProjectRequest && pendingNewProjectRequest.dir === dir) {
    const prompt = pendingNewProjectRequest.prompt
    pendingNewProjectRequest = null
    return prompt
  }
  return null
}
