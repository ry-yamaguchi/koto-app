// 公開先（target）ごとの「その環境でうまくいく構成」の知識をまとめる。
// IDEがこの知識を保持し、AIのシステムコンテキストに注入することで、
// 公開先に合わない作りを避けるよう促す。
// ※ .sakuraide.json のスキーマは変更しない。既存の `target` フィールドを読むだけ。

import { isChatUsable } from './claudeMode'

export type TargetId = 'local' | 'sakura-rental' | 'sakura-apprun' | 'sakura-apprun-dedicated' | 'sakura-vps' | 'sakura-cloud' | 'hanamii' | 'vercel' | 'other'

export interface TargetProfile {
  id: TargetId
  label: string
  summary: string
  recommended: string[]
  donts: string[]
  // IDE の【公開】から自動公開（ワンクリックでのアップロード／デプロイ）に対応しているか
  autoPublish: boolean
  // 公式サービスサイト（トップに近い安定URL）。UIでは補助的な参考リンクとしてのみ使う。
  serviceUrl?: string
}

export const TARGET_PROFILES: Record<TargetId, TargetProfile> = {
  local: {
    id: 'local',
    label: 'あとで決める',
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
      // 2026-09-08 さくらの開発者からの助言（roadmap #33）。
      // 「閉域網のDBアプライアンスにはアプリケーションから接続できないので、
      //  現状だとさくらのクラウドではオンデマンドDBを使うのが有力です」
      // これを知らないと、AI は「さくらのクラウドのDBアプライアンスを使う」形を
      // 提案してしまい、公開してから繋がらないことが分かる。
      'データベースが要るなら「さくらのオンデマンドDB」を選ぶ（さくらのクラウドの場合）',
    ],
    donts: [
      'コンテナ内のローカルファイルに永続データを保存しない（消えます）',
      'ポート番号をコードに固定で埋め込まない',
      'プロセスを跨いで状態を保持する前提にしない',
      // 同上。閉域網（プライベートネットワーク内）のDBは、AppRun のコンテナからは届かない。
      'さくらのクラウドの「閉域網のDBアプライアンス」に接続する前提で作らない（AppRun のコンテナからは接続できません）',
    ],
    autoPublish: true,
    serviceUrl: 'https://cloud.sakura.ad.jp/products/apprun-shared/',
  },
  'sakura-apprun-dedicated': {
    id: 'sakura-apprun-dedicated',
    label: 'さくらのAppRun 専有型',
    summary:
      '仮想サーバレベルで専有するAppRun。独自ドメイン・プライベートネットワーク接続・TCPなど共用型より自由度が高い一方、常時課金（最小構成でも月2万円超）でクラスタ／ASG／アプリ／バージョンの4階層を自分で構成する上級者向けサービス。IDEからクラスタの作成・削除と、アプリケーションの公開（独自ドメインが必要）まで行える。',
    recommended: [
      '独自ドメインや高可用性が必要な中〜大規模なシステム向け',
      '常時課金（動いていなくても課金される）であることを理解したうえで選ぶ',
      'サービスプリンシパルの用意はコントロールパネルでの手作業が必要',
    ],
    donts: [
      '共用型（さくらのAppRun）で足りる小規模用途には向かない（費用が桁違いに高い）',
      '公開には独自ドメインが必要で、公開したあとも常時課金が続く（不要になったらクラスタを削除する）',
      // 2026-09-08（roadmap #33）。専有型はスイッチ接続（プライベート）ができるので、
      // 原理的には閉域網のDBへ届く可能性がある。ただし **Koto は共有セグメント固定**
      // （upstream:'shared'・docs/apprun-dedicated-plan.md 5-5）で作るため、
      // Koto が作った構成からは共用型と同じく届かない。**確かめていないことを
      // 「できる」と書かない**——スイッチ接続での到達性は未検証。
      'Koto が作る構成は共有セグメント固定のため、閉域網のDBアプライアンスには接続できない（共用型と同じ。オンデマンドDB等を使う）',
    ],
    autoPublish: false,
    serviceUrl: 'https://cloud.sakura.ad.jp/products/apprun-dedicated/index.html',
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
    // W-108・W-118（2026-09-27・全画面を一度に言い換える決定）: 「PaaS」は通じない。
    // NewProjectModal.tsx の公開先メニュー・WorkflowBar.tsx の公開先表示にそのまま出る
    // （2026-09-27 再検分の指摘4: ここだけ直し漏れていた）。
    label: 'HANAMII（国産のクラウドサービス）',
    summary:
      'さくらのクラウド基盤上で動く国産のクラウドサービス。ソース一式を送ると HANAMII 側でビルドし、数十秒で公開でき、データは国内。AppRunと同様にコンテナで動き、静的サイト（Koto が小さなサーバを添える）・Node.js（Next.js のサーバ側を含む）・Python・PHP（Dockerfile が要る）を公開できる。状態は持たない前提。',
    recommended: [
      'Node.js は package.json に scripts.start が要る（HANAMII の決まり）。中身は本番用の起動コマンドにし、開発用の起動は避ける（Koto のすすめ）',
      'package.json・Procfile などは公開されるフォルダの直下に置く（public/ があればその中）',
      'Python は直下の Procfile に起動コマンドを書き、gunicorn・uvicorn なども requirements.txt に入れる',
      'PHP は composer.json と Dockerfile が要る（EXPOSE は待ち受けるポート）',
      '待ち受けポートは環境変数 PORT（未設定なら 8080）で受け取る（ハードコードしない）',
      '永続データは外部DB等に保存する',
    ],
    donts: [
      'コンテナ内のローカルファイルに永続データを保存しない（再起動で消える前提）',
      'ポート番号をコードに固定で埋め込まない',
      'dist/・build/ などのビルドの成果物を送る前提で作らない（ビルドは HANAMII 側）',
      'NEXT_PUBLIC_・VITE_ などで始まる変数に秘密を入れない（ブラウザから読める）',
    ],
    autoPublish: true,
    serviceUrl: 'https://hanamii.jp/',
  },
  vercel: {
    id: 'vercel',
    // W-108・W-118（同上）。
    label: 'Vercel（海外のクラウドサービス）',
    summary:
      // データの置き場所を事実に合わせた（2026-09-24）。Koto は公開のときに、さくらの
      // オブジェクトストレージ（国内）の設定を Vercel へ渡す。**アプリが動くのは国外だが、
      // データが置かれるのは国内**——「データは国外」は事実ではなくなった。
      '静的サイト／フロントエンド／サーバーレス関数向けの海外のクラウドサービス。Koto がプロジェクトのファイルをアップロードしてビルド・公開する。ポートをlistenする常駐サーバは動かせない（サーバーレス化が必要）。アプリが動くのは国外だが、データはさくらのオブジェクトストレージ（国内）に置かれる。',
    recommended: [
      '静的サイトやフロントエンド（Next.js等）に向く',
      'サーバー処理はサーバーレス関数として実装する',
      'データの保存（koto-data）は、ブラウザからではなくサーバーレス関数の中から呼ぶ',
    ],
    donts: [
      'ポートをlistenする常駐サーバは動かない',
      'データの保存をブラウザ側のコードから直接呼ばない（Node.js 用のモジュールなので動かない）',
      'アプリ自体を国内で動かしたい要件では他の公開先を選ぶ',
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

/** その公開先が【公開】からの自動公開に対応しているか。 */
export function isAutoPublishTarget(target?: string): boolean {
  return getTargetProfile(target).autoPublish
}

// 「準備中（今後のバージョンで対応予定）」のため、まだ公開先として選択させない target。
// 対応機能（VPSアップロード／さくらのクラウド構成など）が実装できたら、この集合から外すと選択UIに再び現れる。
//
// sakura-apprun-dedicated は方針が違う: クラスタ・ASG・LBの作成からアプリケーションの公開まで
// Koto から行える（実装済み）が、上級者向けで常時課金（最小構成でも月2万円超）のため、
// **公開先の一覧には出さない**。到達できるのは「📦 さくらのAppRun」を選んだ後のタブからだけ
// （PublishModal.tsx の共用型／専有型タブ）。選択肢として出す方針に変えるまでこの集合から外さないこと。
const COMING_SOON_TARGETS = new Set<TargetId>(['sakura-vps', 'sakura-cloud', 'sakura-apprun-dedicated'])
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

/** 公開先の環境制約が実質無い target（案内もボタンも出さない）。 */
const NO_CONSTRAINT_TARGETS = new Set<string>(['local', 'other'])

/**
 * その公開先に、作りを合わせる必要のある環境制約があるか。
 * `local`・`other`・未指定は無い。プロファイルに無い値（手で書いた・別の版が書いた公開先）も、
 * 合わせるべき前提を持たないので無い側に数える。
 */
export function hasTargetConstraint(target: string | null | undefined): boolean {
  if (!target || !Object.prototype.hasOwnProperty.call(TARGET_PROFILES, target)) return false
  return !NO_CONSTRAINT_TARGETS.has(target)
}

export interface ShouldOfferTargetCheckArgs {
  /** 変更後の公開先 */
  target: string | undefined
  /** 現在開いているプロジェクトのディレクトリ */
  projectDir: string | null | undefined
  /** さくらのAI Engine の APIキー */
  apiKey: string | null | undefined
  /** Claude が使える状態か */
  claudeActive: boolean
}

/**
 * 公開先を変えたあとの吹き出しに「この公開先で動くか AI に確かめる」ボタンを付けてよいかを判定する純粋関数。
 * 判定は表示するかどうかだけで、AI へは何も送らない（送るのはボタンを押したとき）。
 * キーは AI Engine と Claude のどちらかがあればよい（送り先は送信側が決める）。
 */
export function shouldOfferTargetCheck(args: ShouldOfferTargetCheckArgs): boolean {
  const { target, projectDir, apiKey, claudeActive } = args
  if (!hasTargetConstraint(target)) return false
  if (!projectDir) return false
  return isChatUsable(!!apiKey, claudeActive)
}
