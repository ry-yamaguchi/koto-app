// spec.ts — 環境スペック（env.json）の型と純粋な検証・既定生成ロジック。
//
// ※重要: このモジュールは electron に依存しない純ロジックである（IO・API呼び出し無し）。
//   esbuild 単体でテストできるよう、import は型と標準ライブラリのみに限定すること。
//
// ※セキュリティ規約: secrets は「値」を一切持たない。ref 文字列（例 "keychain:myapp/DB_PASS"）
//   のみを保持し、実際の秘密値はOSキーチェーン等から実行時に解決する想定（env.json には平文を書かない）。

/** ビルド方式。
 *  - 'builtin': IDE同梱ビルダー（crane）で「ベース＋ファイル」を組み立てる。Docker不要（既定）。
 *  - 'docker' : ユーザーのDockerfileを Docker でビルド（任意のRUN等が可能・Docker導入が必要＝エキスパート）。 */
export type BuilderMode = 'builtin' | 'docker'

/** サービスのソース定義。Dockerfile からビルドするか、既存イメージ参照のいずれか。 */
export type ServiceSource =
  // dockerfile: context（ビルドコンテキスト）に加え、ビルド成果物のイメージ名/タグを任意で持つ。
  // image/tag は後方互換のため任意（無くても従来通り有効）。段階3でビルド/プッシュに用いる。
  // builder: ビルド方式（既定 'builtin'＝Docker不要）。'docker' でエキスパート（自前Dockerfile）。
  | { type: 'dockerfile'; context: string; image?: string; tag?: string; builder?: BuilderMode }
  | { type: 'image'; ref: string }

/** 環境変数（平文の値を持つ。秘密でないもののみ）。 */
export type EnvVar = { name: string; value: string }

/**
 * 秘密参照。値そのものは持たず、解決先を示す ref 文字列のみを保持する。
 * 例: { name: 'DB_PASS', ref: 'keychain:myapp/DB_PASS' }
 */
export type SecretRef = { name: string; ref: string }

/** スケール設定（AppRun の最小/最大インスタンス数）。 */
export type ScaleSpec = { min: number; max: number }

/** サービス（AppRunアプリ）の定義。 */
export type ServiceSpec = {
  source: ServiceSource
  port: number
  env: EnvVar[]
  secrets: SecretRef[]
  scale: ScaleSpec
}

/** オブジェクトストレージのバケット定義（ステートフル資源）。 */
/**
 * 永続データの置き場所。
 *
 * `shared` が既定（true）。**課金がバケット単位**なので、既定では1つのバケットを
 * 共有し `prefix` で分ける（src/shared/objectStorage.ts）。分離したい場合だけ
 * `shared: false` にする（そのぶん月額が増える）。
 */
export type BucketSpec = {
  bucket: string
  /** 共有バケット内の置き場所（`projects/<名前>/`）。専用でも付ける。 */
  prefix?: string
  /** ほかのプロジェクトと共有するか。**既定 true。** */
  shared?: boolean
  /**
   * 費用の同意を取った日時（ISO文字列）。
   *
   * **これが無いバケットは用意しない**（src/shared/objectStorage.ts の
   * `consentedBuckets`）。バケットは1つにつき月額が発生するので、
   * 「書いてあるから作る」ではなく「同意したから作る」にしてある。
   */
  consentedAt?: string
}

/** 永続化（ステートフル）リソースの定義。 */
export type PersistenceSpec = { objectStorage: BucketSpec[] }

/** ガードレール（TTL・予算）。段階1では値の保持のみ（強制は段階2以降）。 */
// 料金上限(monthlyBudgetYen)は持たない：公開環境の課金はIDE経由でなくクラウド稼働で発生し、
// 課金APIは確定済み月次のみ＝IDEが実効的に守れないため（詳細は memory: cloud-feature-north-star）。
// 消し忘れ防止は TTL（期限。超過したら破棄を促す）で担保する。
export type GuardrailsSpec = { ttlHours: number }

/**
 * 認証（このプロジェクトの公開に使うクラウドキーのピン留め）。
 * AppRun に専用のAPIキーは無く、さくらのクラウド IaaS のAPIキー（token+secret）で操作する。
 * ここには秘密値は持たず、認証情報（CredentialsModal）側の登録キーを指す id/label のみを保持する。
 */
export type AuthSpec = { keyId?: string; keyLabel?: string }

/** 環境スペック（.sakura-cloud/env.json のスキーマ）。 */
export type EnvSpec = {
  version: number
  name: string
  provider: 'sakura-cloud'
  backend: 'apprun'
  region: string
  service: ServiceSpec
  persistence: PersistenceSpec
  guardrails: GuardrailsSpec
  // このプロジェクトの公開に使うクラウドキーのピン留め（任意）。未設定なら「使用中」キーを使う。
  auth?: AuthSpec
}

/** 名前・バケット名の制約: 小文字英数字とハイフン、先頭末尾は英数字、3〜40文字。 */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/

/** イメージタグの制約: 英数字・ドット・アンダースコア・ハイフンのみ、1〜128文字。 */
export const TAG_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/** validateSpec の戻り値。成功なら ok:true と正規化済みの spec、失敗なら ok:false と errors。 */
export type ValidateResult =
  | { ok: true; spec: EnvSpec }
  | { ok: false; errors: string[] }

// ── 内部ヘルパー（純関数・IO無し） ───────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

/**
 * validateSpec — 任意の入力を EnvSpec として検証する純関数（IO無し）。
 * 必須項目・型・値域（port 1-65535、scale.min<=max、name/bucket は NAME_PATTERN）を検査し、
 * すべて満たせば ok:true と spec を返す。1つでも違反があれば ok:false と日本語の errors 配列を返す。
 */
export function validateSpec(obj: unknown): ValidateResult {
  const errors: string[] = []

  if (!isObject(obj)) {
    return { ok: false, errors: ['スペックがオブジェクトではありません'] }
  }

  // version
  if (!isInt(obj.version) || obj.version < 1) {
    errors.push('version は 1 以上の整数である必要があります')
  }

  // name
  if (!isString(obj.name)) {
    errors.push('name は文字列である必要があります')
  } else if (!NAME_PATTERN.test(obj.name)) {
    errors.push('name は小文字英数字とハイフンのみ・先頭末尾は英数字・3〜40文字にしてください')
  }

  // provider
  if (obj.provider !== 'sakura-cloud') {
    errors.push("provider は 'sakura-cloud' である必要があります")
  }

  // backend
  if (obj.backend !== 'apprun') {
    errors.push("backend は 'apprun' である必要があります")
  }

  // region
  if (!isString(obj.region) || obj.region.length === 0) {
    errors.push('region は空でない文字列である必要があります')
  }

  // service
  const service = obj.service
  if (!isObject(service)) {
    errors.push('service はオブジェクトである必要があります')
  } else {
    // service.source
    const source = service.source
    if (!isObject(source)) {
      errors.push('service.source はオブジェクトである必要があります')
    } else if (source.type === 'dockerfile') {
      if (!isString(source.context) || source.context.length === 0) {
        errors.push('service.source.context（Dockerfileのビルドコンテキスト）は空でない文字列である必要があります')
      }
      // image/tag は任意（後方互換）。存在する場合のみ形式を検証する。
      if ('image' in source && source.image !== undefined) {
        if (!isString(source.image) || !NAME_PATTERN.test(source.image)) {
          errors.push('service.source.image は小文字英数字とハイフンのみ・先頭末尾は英数字・3〜40文字にしてください')
        }
      }
      if ('tag' in source && source.tag !== undefined) {
        if (!isString(source.tag) || !TAG_PATTERN.test(source.tag)) {
          errors.push('service.source.tag は英数字・ドット・アンダースコア・ハイフンのみ・1〜128文字にしてください')
        }
      }
      // builder（ビルド方式）は任意。存在する場合は 'builtin' か 'docker'。
      if ('builder' in source && source.builder !== undefined) {
        if (source.builder !== 'builtin' && source.builder !== 'docker') {
          errors.push("service.source.builder は 'builtin' または 'docker' である必要があります")
        }
      }
    } else if (source.type === 'image') {
      if (!isString(source.ref) || source.ref.length === 0) {
        errors.push('service.source.ref（イメージ参照）は空でない文字列である必要があります')
      }
    } else {
      errors.push("service.source.type は 'dockerfile' または 'image' である必要があります")
    }

    // service.port
    if (!isInt(service.port) || service.port < 1 || service.port > 65535) {
      errors.push('service.port は 1〜65535 の整数である必要があります')
    }

    // service.env
    if (!Array.isArray(service.env)) {
      errors.push('service.env は配列である必要があります')
    } else {
      service.env.forEach((e, i) => {
        if (!isObject(e) || !isString(e.name) || !isString(e.value)) {
          errors.push(`service.env[${i}] は { name: string, value: string } である必要があります`)
        }
      })
    }

    // service.secrets — 値は持たず ref のみ
    if (!Array.isArray(service.secrets)) {
      errors.push('service.secrets は配列である必要があります')
    } else {
      service.secrets.forEach((s, i) => {
        if (!isObject(s) || !isString(s.name) || !isString(s.ref)) {
          errors.push(`service.secrets[${i}] は { name: string, ref: string } である必要があります`)
        } else if ('value' in s) {
          // 平文の値を env.json に書くことは規約違反
          errors.push(`service.secrets[${i}] に value を含めることはできません（ref のみ許可）`)
        }
      })
    }

    // service.scale
    const scale = service.scale
    if (!isObject(scale)) {
      errors.push('service.scale はオブジェクトである必要があります')
    } else {
      if (!isInt(scale.min) || scale.min < 0) {
        errors.push('service.scale.min は 0 以上の整数である必要があります')
      }
      if (!isInt(scale.max) || scale.max < 1) {
        errors.push('service.scale.max は 1 以上の整数である必要があります')
      }
      if (isInt(scale.min) && isInt(scale.max) && scale.min > scale.max) {
        errors.push('service.scale.min は service.scale.max 以下である必要があります')
      }
    }
  }

  // persistence
  const persistence = obj.persistence
  if (!isObject(persistence)) {
    errors.push('persistence はオブジェクトである必要があります')
  } else if (!Array.isArray(persistence.objectStorage)) {
    errors.push('persistence.objectStorage は配列である必要があります')
  } else {
    const seen = new Set<string>()
    persistence.objectStorage.forEach((b, i) => {
      if (!isObject(b) || !isString(b.bucket)) {
        errors.push(`persistence.objectStorage[${i}] は { bucket: string } である必要があります`)
      } else if (!NAME_PATTERN.test(b.bucket)) {
        errors.push(`persistence.objectStorage[${i}].bucket は小文字英数字とハイフンのみ・先頭末尾は英数字・3〜40文字にしてください`)
      } else if (seen.has(b.bucket)) {
        errors.push(`persistence.objectStorage に重複したバケット名があります: ${b.bucket}`)
      } else {
        // 任意フィールド。**型が違うものは通さない**（prefix が壊れると隣の
        // プロジェクトのデータに届き、shared が壊れると破棄の判断が変わる）。
        if (b.prefix !== undefined && (!isString(b.prefix) || !b.prefix.endsWith('/'))) {
          errors.push(`persistence.objectStorage[${i}].prefix は「/」で終わる文字列である必要があります`)
        }
        if (b.shared !== undefined && typeof b.shared !== 'boolean') {
          errors.push(`persistence.objectStorage[${i}].shared は true/false である必要があります`)
        }
        if (b.consentedAt !== undefined && !isString(b.consentedAt)) {
          errors.push(`persistence.objectStorage[${i}].consentedAt は文字列である必要があります`)
        }
        seen.add(b.bucket)
      }
    })
  }

  // guardrails
  const guardrails = obj.guardrails
  if (!isObject(guardrails)) {
    errors.push('guardrails はオブジェクトである必要があります')
  } else {
    if (!isInt(guardrails.ttlHours) || guardrails.ttlHours < 0) {
      errors.push('guardrails.ttlHours は 0 以上の整数である必要があります')
    }
    // monthlyBudgetYen は廃止。古い env.json に残っていても無視する（検証しない）。
  }

  // auth（任意）。存在する場合のみ緩く検証する。必須ではない。
  if ('auth' in obj && obj.auth !== undefined) {
    if (!isObject(obj.auth)) {
      errors.push('auth はオブジェクトである必要があります')
    } else {
      if ('keyId' in obj.auth && obj.auth.keyId !== undefined && !isString(obj.auth.keyId)) {
        errors.push('auth.keyId は文字列である必要があります')
      }
      if ('keyLabel' in obj.auth && obj.auth.keyLabel !== undefined && !isString(obj.auth.keyLabel)) {
        errors.push('auth.keyLabel は文字列である必要があります')
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  // ここまで来たら全フィールドが検証済み。EnvSpec として確定できる。
  return { ok: true, spec: obj as unknown as EnvSpec }
}

/** defaultSpec の入力。 */
export type DefaultSpecInput = { name: string; hasDockerfile: boolean; port?: number }

/**
 * defaultSpec — プロジェクト情報から既定の EnvSpec を生成する純関数（IO無し）。
 * Dockerfile があれば source=dockerfile、無ければ image の雛形（後で差し替え前提）にする。
 * 保存場所は既定では持たない（費用が発生するため。同意を得てから足す）。secrets は空（ref のみを後から追加する設計）。
 */
/**
 * プロジェクト名を NAME_PATTERN に合う形へ正規化する（純関数）。
 * 大文字→小文字・不正文字→ハイフン・連続/先頭末尾ハイフン整理・3〜40文字に収める。
 * フォルダ名が HelloWorld / 日本語 等でも「公開の設定を作成」が失敗しないようにするための救済。
 */
export function normalizeSpecName(raw: string): string {
  let s = (raw ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  if (s.length > 40) s = s.slice(0, 40).replace(/-+$/g, '')
  if (s.length < 3) s = s ? `${s}-app`.slice(0, 40) : 'app'
  return s
}

export function defaultSpec(input: DefaultSpecInput): EnvSpec {
  const port = input.port ?? 8080
  // フォルダ名由来の name をそのまま使うと大文字・記号で NAME_PATTERN 検証に落ちるため必ず正規化する
  input = { ...input, name: normalizeSpecName(input.name) }
  // 既定は「プロジェクトからビルド」。内蔵ビルダー(crane)を使うので Dockerfile は不要。
  // Dockerfile がある人は env.json の builder を 'docker'（エキスパート）に変えれば自前ビルドも可能。
  const source: ServiceSource = {
    type: 'dockerfile',
    context: '.',
    image: input.name,
    tag: 'latest',
    builder: 'builtin',
  }
  return {
    version: 1,
    name: input.name,
    provider: 'sakura-cloud',
    backend: 'apprun',
    region: 'is1a',
    service: {
      source,
      port,
      env: [{ name: 'NODE_ENV', value: 'production' }],
      // secrets は値を持たず ref のみ。既定では空にしておく。
      secrets: [],
      scale: { min: 0, max: 1 },
    },
    // **既定では保存場所を要求しない。** バケットは1つにつき月額が発生するので、
    // 「新しいプロジェクトを作ったら課金が始まる」ことがあってはならない。
    // 永続データが要ると分かった時点（③公開の案内）で、費用に同意してから足す。
    persistence: {
      objectStorage: [],
    },
    // ttlHours=0 は「期限なし（継続運用）」。AppRun は通常の実行環境なので既定は期限なし。
    // 使い捨てにしたい場合のみ、公開パネルから期限を設定する。
    guardrails: { ttlHours: 0 },
  }
}
