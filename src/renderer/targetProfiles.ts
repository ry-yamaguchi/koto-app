// 公開先（target）ごとの「その環境でうまくいく構成」の知識をまとめる。
// IDEがこの知識を保持し、AIのシステムコンテキストに注入することで、
// 公開先に合わない作りを避けるよう促す。
// ※ .sakuraide.json のスキーマは変更しない。既存の `target` フィールドを読むだけ。

export type TargetId = 'local' | 'sakura-rental' | 'sakura-apprun' | 'sakura-vps' | 'sakura-cloud' | 'hanamii' | 'vercel' | 'other'

export interface TargetProfile {
  id: TargetId
  label: string
  summary: string
  recommended: string[]
  donts: string[]
  // IDE の ③公開 から自動公開（ワンクリックでのアップロード／デプロイ）に対応しているか
  autoPublish: boolean
  // 公式サービスサイト（トップに近い安定URL）。UIでは補助的な参考リンクとしてのみ使う。
  serviceUrl?: string
}

export const TARGET_PROFILES: Record<TargetId, TargetProfile> = {
  local: {
    id: 'local',
    label: 'ローカルのみ（公開先は未定）',
    summary: 'まだ公開先が決まっていない。手元で動けばよい。',
    recommended: [
      'まずは動くものを作ることを優先',
      '公開先が決まったら、その環境向けに構成を見直せる',
    ],
    donts: [
      '特定の公開先に強く依存した作りは、後で変更が必要になりやすいので避ける',
    ],
    autoPublish: false,
  },
  'sakura-rental': {
    id: 'sakura-rental',
    label: 'さくらのレンタルサーバ（PHP + MySQL）',
    summary:
      '静的HTML/CSS/JS と PHP が動く共有ホスティング。常駐型サーバ（Node.jsのlisten等）は動かせない。データベースはMySQL。公開ディレクトリは ~/www。',
    recommended: [
      '静的なHTML/CSS/JS を基本にする',
      '動的処理が必要なら PHP を使う',
      'データ保存が必要なら MySQL を使う',
      'エントリは index.html または index.php',
    ],
    donts: [
      'Node.js等でポートをlistenする常駐サーバを作らない（動きません）',
      'ビルドが必須の重いフレームワークは避ける（そのまま置けるものが無難）',
      'SQLite等のファイルDBに大量書き込みする前提にしない',
    ],
    autoPublish: true,
    serviceUrl: 'https://rs.sakura.ad.jp/',
  },
  'sakura-apprun': {
    id: 'sakura-apprun',
    label: 'さくらのAppRun（コンテナで公開）',
    summary:
      'Dockerコンテナを動かすPaaS。状態を持たない（ステートレス）前提。コンテナ内に保存したファイルは再起動で消える。',
    recommended: [
      'Dockerfile を用意する',
      '待ち受けポートは環境変数で受け取る（ハードコードしない）',
      'ヘルスチェックに応答できるようにする',
      '永続データはオブジェクトストレージや外部DBに保存する',
    ],
    donts: [
      'コンテナ内のローカルファイルに永続データを保存しない（消えます）',
      'ポート番号をコードに固定で埋め込まない',
      'プロセスを跨いで状態を保持する前提にしない',
    ],
    autoPublish: true,
    serviceUrl: 'https://cloud.sakura.ad.jp/products/apprun-shared/',
  },
  'sakura-vps': {
    id: 'sakura-vps',
    label: 'さくらのVPS',
    summary:
      '自由度の高い仮想サーバ。常駐プロセスもnginxも自分で構築できるが、サーバ構築・運用を自分で行う必要があり初心者には負担。',
    recommended: [
      '常駐サーバ（Node.js等）も動かせる',
      'nginx等のWebサーバやsystemdでの常駐化を自分で設定する',
      'ファイアウォール設定に注意する',
    ],
    donts: [
      'サーバ運用の知識が前提。初心者には設定の手間が大きい点に留意する',
    ],
    autoPublish: false,
    serviceUrl: 'https://vps.sakura.ad.jp/',
  },
  'sakura-cloud': {
    id: 'sakura-cloud',
    label: 'さくらのクラウド',
    summary: '最も自由度が高いIaaS。何でもできるが構築・運用の手間も最大。上級者向け。',
    recommended: [
      '要件に応じてサーバ・ネットワーク・DBを自由に構成できる',
    ],
    donts: [
      '構築・運用の負担が大きい。初心者には他の公開先（レンタルサーバ/AppRun）の方が向く',
    ],
    autoPublish: false,
    serviceUrl: 'https://cloud.sakura.ad.jp/',
  },
  hanamii: {
    id: 'hanamii',
    label: 'HANAMII（国産PaaS）',
    summary:
      'さくらのクラウド基盤上で動く国産PaaS。ビルド済みファイルをアップロードするだけで数十秒で公開でき、データは100%国内。AppRunと同様にコンテナで動くため、静的サイトも Node.js の常駐サーバも公開できる。状態は持たない前提。',
    recommended: [
      '静的サイト・Node.js/一般的なWebアプリを置ける',
      '待ち受けポートは環境変数で受け取る（ハードコードしない）',
      '永続データは外部DB等に保存する',
    ],
    donts: [
      'コンテナ内のローカルファイルに永続データを保存しない（再起動で消える前提）',
      'ポート番号をコードに固定で埋め込まない',
    ],
    autoPublish: true,
    serviceUrl: 'https://hanamii.jp/',
  },
  vercel: {
    id: 'vercel',
    label: 'Vercel（海外PaaS）',
    summary:
      '静的サイト／フロントエンド／サーバーレス関数向けの海外PaaS。IDEがプロジェクトのファイルをアップロードしてビルド・公開する。ポートをlistenする常駐サーバは動かせない（サーバーレス化が必要）。データは国外に置かれる。',
    recommended: [
      '静的サイトやフロントエンド（Next.js等）に向く',
      'サーバー処理はサーバーレス関数として実装する',
    ],
    donts: [
      'ポートをlistenする常駐サーバは動かない',
      'データを国内に置きたい要件では他の公開先を選ぶ',
    ],
    autoPublish: true,
    serviceUrl: 'https://vercel.com/',
  },
  other: {
    id: 'other',
    label: 'さくら以外の環境',
    summary: 'さくらインターネット以外の公開先。一般的な前提で作る。',
    recommended: [
      '特定環境に強く依存しない一般的な構成にする',
    ],
    donts: [
      '公開先が確定するまで、その環境固有の前提を入れすぎない',
    ],
    autoPublish: false,
  },
}

/** target 値からプロファイルを返す。未知・未指定は 'local' を返す。 */
export function getTargetProfile(target?: string): TargetProfile {
  if (target && Object.prototype.hasOwnProperty.call(TARGET_PROFILES, target)) {
    return TARGET_PROFILES[target as TargetId]
  }
  return TARGET_PROFILES.local
}

/** その公開先が ③公開 からの自動公開に対応しているか。 */
export function isAutoPublishTarget(target?: string): boolean {
  return getTargetProfile(target).autoPublish
}

// 「準備中（今後のバージョンで対応予定）」のため、まだ公開先として選択させない target。
// 対応機能（VPSアップロード／さくらのクラウド構成など）が実装できたら、この集合から外すと選択UIに再び現れる。
const COMING_SOON_TARGETS = new Set<TargetId>(['sakura-vps', 'sakura-cloud'])
/** その target を現時点で公開先として選択肢に出してよいか（準備中＝false で非表示にする）。 */
export function isAvailableTarget(target?: string): boolean {
  return !COMING_SOON_TARGETS.has(target as TargetId)
}

/** AI注入用の簡潔な日本語テキスト（トークン節約のため要点のみ）を作る。 */
export function profileToContext(p: TargetProfile): string {
  return (
    `【公開先の前提: ${p.label}】\n` +
    `${p.summary}\n` +
    `- 推奨: ${p.recommended.join(' / ')}\n` +
    `- 避ける: ${p.donts.join(' / ')}\n` +
    'これらに反する作りは避け、必要なら公開先に合う形を提案してください。'
  )
}

/** 公開先の環境制約が実質無い target（診断しても意味がない）。 */
const NO_CONSTRAINT_TARGETS = new Set<string>(['local', 'other'])

export interface ShouldAutoCheckTargetArgs {
  /** 変更後の公開先（sakura-target-changed の detail.target） */
  target: string | undefined
  /** さくらのAI Engine の APIキー */
  apiKey: string | null | undefined
  /** 現在開いているプロジェクトのディレクトリ */
  projectDir: string | null | undefined
  /** 送信パイプラインが実行中か（あいさつ含む） */
  isLoading: boolean
  /** 直前に自動診断を行った target（重複発火・多重送信の防止） */
  lastCheckedTarget: string | null | undefined
}

/**
 * 公開先切替時に「AIへ自動で適合チェックを依頼してよいか」を判定する純粋関数。
 * true を返す場合のみ、チャット欄から診断依頼メッセージを自動送信する。
 * false の場合は、呼び出し側が従来どおりの軽い案内バブル（or 何もしない）にフォールバックする。
 */
export function shouldAutoCheckTarget(args: ShouldAutoCheckTargetArgs): boolean {
  const { target, apiKey, projectDir, isLoading, lastCheckedTarget } = args
  if (!target) return false
  if (NO_CONSTRAINT_TARGETS.has(target)) return false // 環境制約が無いので診断不要
  if (!apiKey) return false
  if (!projectDir) return false
  if (isLoading) return false // 実行中の会話を邪魔しない
  if (target === lastCheckedTarget) return false // 同一targetへの重複発火を防ぐ
  return true
}
