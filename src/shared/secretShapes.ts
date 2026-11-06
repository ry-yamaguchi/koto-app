// secretShapes.ts — 秘密の「形」の唯一の定義（純関数。fs・electron・DOM に依存しない）。
//
// ── なぜ1か所に集めるか（掟10）────────────────────────────────────────
// 「これは秘密か」の判定は、更新ログの伏せ字・HANAMII の環境変数の🔒・公開前チェックの名前の判定と、
// 別々の場所に別々の書き方で置かれていた。複製すると片方だけ直され、抜けても誰も気づかない。
// 秘密の形を足す・直すときは、ここだけを直す。ここを通る入口は次のとおり。
//   - `findSecretShapes`   … コードの中の秘密を見つけて警告に使う（値は返さない）
//   - `maskSecretShapes`   … 外へ送る・保存する前に、値を伏せ字にする
//   - `looksSecretName`    … 変数名・環境変数名が秘密らしいか
//   - `looksSecretKeyName` … 入れ物の項目名が秘密らしいか（値ごと落とす所で使う）
//   - `isPlaceholder`      … 見本の値（YOUR_API_KEY など）か
//   - 更新ログの `redactSecrets` は、形で分かる分を `maskSecretShapes` から作る
//
// ── 伏せ字と警告は、わざと厳しさを変えている ──────────────────────────
// 伏せるほうは「迷ったら伏せる」（漏らすほうが害が大きい）。警告するほうは「迷ったら黙る」
// （誤検知が続くと、本物の警告が読まれなくなる）。だから警告には、見本の値・埋め込み式・
// 識別子のような値を除く条件が付き、伏せ字には付かない（付けると、警告しなかったものが送られる）。
// 伏せ字は名前の語も広く取り（`pass`・`salt`・`nonce`・`_KEY`・`authorization`）、警告しない書き方も伏せる:
// 引用符のない値（`KEY: 値`・`export KEY=値`・`SetEnv KEY 値`・日本語の見出し）、比較と既定値（`=== '値'`・`|| '値'`）、
// `users: { 名前: '値' }`。これらは `maskOnly` の形で、`findSecretShapes` は数えない。
// 伏せ字は完全ではない。形に当たらない固定の文字列は、そのまま残りうる。
//
// 値そのものは、どの関数の戻り値にも入れない（警告の文は `chat.json` に保存され、同じ秘密が2か所に残る）。
// 画面に出してよいのは、形の接頭辞（例: `ghp_…`）と文字数だけ。

/** 値の代わりに置く伏せ字。 */
const MASK = '***'

/** 秘密の種類。画面の文は種類ごとに決める。 */
export type SecretShapeKind =
  | 'private-key'        // 秘密鍵の本体
  | 'known-key'          // 形だけで分かるキー（GitHub・Anthropic・Bearer）
  | 'connection-string'  // 資格情報つきの接続文字列・URL
  | 'named-secret'       // 秘密らしい名前に、固定の文字列を入れている

export interface SecretFinding {
  kind: SecretShapeKind
  /** 1 始まりの行。複数行にまたがる秘密鍵は、BEGIN の行。 */
  line: number
  /** 値の文字数（画面に出してよい）。 */
  length: number
  /** 画面に出してよい見本。形の接頭辞だけ（例: `ghp_…`）。接頭辞のない種類は空。 */
  sample: string
}

// ── 見本の値と、値の形 ────────────────────────────────────────────────

/** 値でなく「ここに値が入る」という印（埋め込み式・伏せ字・同じ字の繰り返し）。 */
const TEMPLATE_RES: readonly RegExp[] = [
  /^(.)\1*$/,                         // xxxx・****・0000
  /^[xX*.•#_-]+$/,                    // x-x-x・....
  /^<[^>]*>$/,                        // <your-token>
  /^\$[A-Za-z_]\w*$/,                 // $DB_PASSWORD
  /^%[sd]$|^%\([^)]*\)s$/,            // %s・%(password)s
  /^\{[^{}]*\}$/,                     // {password}
  /\$\{[^}]*\}|\{\{[^}]*\}\}/,        // 埋め込み式。どこにあっても固定の文字列ではない
]

/** 値全体が見本の言葉。 */
const PLACEHOLDER_WHOLE_RE =
  /^(?:change[-_ ]?me|replace[-_ ]?me|password|passwd|pass|secret|token|api[-_ ]?key|apikey|key|example|sample|dummy|test|testing|todo|tbd|none|null|undefined|nil|redacted|placeholder)$/i
/** 区切りで挟まれた見本の言葉（YOUR_API_KEY_HERE・put-your-token-here・REPLACE_ME_123）。 */
const PLACEHOLDER_PART_RE =
  /(?:^|[-_ ])(?:here|placeholder|example|sample|dummy|change[-_ ]?me|replace[-_ ]?me|todo|tbd|redacted|your)(?:[-_ ]|$)/i

function isTemplateValue(v: string): boolean {
  return TEMPLATE_RES.some(re => re.test(v))
}

/**
 * 伏せ字の側で「別の所から読む印」だけか（警告の `isTemplateValue` より狭い）。`$DB_PASSWORD`・`$token` のような
 * 変数名だけは印。`$ecretPass2024` のように大小や数字が混ざる `$名前` は固定の文字列かもしれないので、印とは見ない。
 */
function isReferenceOnly(v: string): boolean {
  if (/^\$[A-Za-z_]\w*$/.test(v)) return /^\$(?:[A-Z_]+|[a-z_]+)$/.test(v)
  return isTemplateValue(v)
}

/**
 * 見本の値か（空・伏せ字・埋め込み式・`YOUR_API_KEY`・`changeme` など）。
 * 見本は秘密ではないので、警告にも伏せ字にも数えない。
 */
export function isPlaceholder(value: string): boolean {
  const v = String(value ?? '').trim()
  if (v === '') return true
  return isTemplateValue(v) || PLACEHOLDER_WHOLE_RE.test(v) || PLACEHOLDER_PART_RE.test(v)
}

/** 警告に数える値の最小の長さ。これより短いものは、秘密の名前の隣にあっても警告しない。 */
const MIN_VALUE_LENGTH = 8

/**
 * 秘密の値らしい形か（警告用。厳しめ）。名前が秘密らしいだけでは警告しない。
 * 空白や日本語を含む文・セレクタ・パス・URL・単語を区切り文字でつないだだけの識別子
 * （保存先のキー名 `refresh_token_key_v1` など）は除く。数字か記号が混ざっているものだけを数える。
 * 英字だけの値は警告に数えない（伏せ字では数える）。
 */
function looksLikeSecretValue(v: string): boolean {
  if (v.length < MIN_VALUE_LENGTH || isPlaceholder(v)) return false
  if (!/^[\x21-\x7e]+$/.test(v)) return false
  if (/^[#.][\w-]+$/.test(v) || /^[./~]/.test(v) || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false
  if (IDENTIFIER_RE.test(v)) return false
  return /\d/.test(v) || /[^A-Za-z0-9_-]/.test(v)
}

/** 小文字の単語を `-`・`_` でつないだ識別子（末尾に版・連番の1〜2桁だけ付いてよい）。`sunshine99` は当たらない。 */
const IDENTIFIER_RE = /^[a-z]+(?:[-_][a-z]+)*(?:[-_]v?\d{1,2}|v\d{1,2})?$/

/**
 * ブラウザへ渡すことが前提のキーか。決済の公開可能キー・地図の JavaScript 用・Firebase の web 設定は、
 * 公開されても困らない値なので、名前から警告する型では数えない（伏せ字では数える）。
 */
function isBrowserSafeKey(name: string, value: string): boolean {
  if (/^pk_(?:live|test)_/.test(value)) return true
  if (/^pk\.eyJ/.test(value)) return true
  return /^AIza/.test(value) && (/(?:^|\.)apiKey$/.test(name) || /maps|firebase/i.test(name))
}

// ── 名前 ──────────────────────────────────────────────────────────────

/**
 * 変数名・環境変数名が秘密らしいか（広め）。外れても利用者が直せる所（HANAMII の🔒の候補など）で使う。
 * 警告には、これより厳しい `SECRET_ASSIGN_NAME_RE` を使う（`key`・`tokenizer` の類で警告しない）。
 */
export function looksSecretName(name: string): boolean {
  return /KEY|SECRET|TOKEN|PASS|PWD|CREDENTIAL|PRIVATE|APIKEY/i.test(String(name ?? ''))
}

/**
 * 警告の対象にする名前（厳しめ）。秘密を表す語の直後が英字でないものだけ（`tokenizer`・`passwordInput`・
 * `tokenKey` は当たらない。`DB_PASSWORD`・`apiKey`・`clientSecret` は当たる）。`i` で大文字小文字を区別しないので、
 * 語の直後の大文字も「英字」に数える。
 */
const SECRET_ASSIGN_NAME_RE =
  /(?:password|passwd|pwd|secret[_-]?key|secret|token|api[_-]?key|private[_-]?key|credentials?|access[_-]?key|auth[_-]?key)(?![a-z])/i

/**
 * 入れ物の項目名が秘密らしいか（値ごと落とす所で使う）。**語の直後を見ない**（`tokenizer` も落とす。
 * 落としすぎて困る所ではない）。main の結果の写しが、項目ごと落とすかを決めるのに使う。
 */
export function looksSecretKeyName(name: string): boolean {
  return /token|secret|password|passwd|api[-_]?key|access[-_]?key|authorization|credential/i.test(String(name ?? ''))
}

/**
 * 伏せ字にする名前に足す語（警告の名前には無い）。`$pass`・`DB_PASS`・WordPress の `NONCE_KEY`・`LOGGED_IN_KEY`・`AUTH_SALT`、
 * メール送信の `pass:`、`Authorization` の項目。語の直後が英字なら当たらない（`passenger`・`passwordInput`）。
 */
const MASK_EXTRA_NAME_RE = /(?:pass|salt|nonce|authorization|[_-]key)(?![a-z])/i
/** 小文字から続く `Key`（`tokenKey`・`encryptionKey`）。`i` を付けない（`monkey` を拾わない）。 */
const MASK_CAMEL_KEY_RE = /[a-z]Key(?![a-z])/

/** 伏せ字にする名前か。警告の名前より広い。 */
function maskableName(name: string): boolean {
  return SECRET_ASSIGN_NAME_RE.test(name) || MASK_EXTRA_NAME_RE.test(name) || MASK_CAMEL_KEY_RE.test(name)
}

// ── 形の一覧 ──────────────────────────────────────────────────────────
// 並びが優先順位。先に当たったものが範囲を取り、後ろの形は重なる所を見ない（警告が二重にならない）。
// 伏せ字も同じ順に当てる。**秘密鍵を最初に置く**のは、あとの形が BEGIN の行だけを潰して本体を残さないため。

interface SecretShapeBase {
  /** テストと切り分けのための名前。 */
  id: string
  kind: SecretShapeKind
  /** 必ず `g` 付き。 */
  re: RegExp
  /** 一致の全体を置き換える伏せ字。null なら伏せない（見本の値など）。 */
  mask(m: RegExpMatchArray, keepLines: boolean): string | null
  /** 名前を見て決める形（`name = "値"`）か。更新ログの伏せ字は、名前を見る形を使わない。 */
  byName?: boolean
}

/** 警告にも伏せ字にも使う形。 */
interface WarnShape extends SecretShapeBase {
  maskOnly?: false
  /** 秘密の値の部分（長さを数え、警告に数えるかを決める）。 */
  valueOf(m: RegExpMatchArray): string
  /** 画面に出してよい見本。値そのものは入れない。 */
  sampleOf(m: RegExpMatchArray): string
  /** 警告に数えるか。 */
  reports(m: RegExpMatchArray): boolean
}

/** 伏せ字だけに使う形。警告に数える項目（値・見本・数えるか）を持たない。警告は迷ったら黙るので、`findSecretShapes` は使わない。 */
interface MaskOnlyShape extends SecretShapeBase {
  maskOnly: true
}

type SecretShape = WarnShape | MaskOnlyShape

function countNewlines(s: string): number {
  return s.split('\n').length - 1
}

/** 既知の接頭辞で始まるキー。接頭辞のあとが見本（xxxx など）なら警告しない。 */
function knownKey(id: string, re: RegExp, prefixLength: (token: string) => number): SecretShape {
  return {
    id,
    kind: 'known-key',
    re,
    valueOf: m => m[0],
    sampleOf: m => `${m[0].slice(0, prefixLength(m[0]))}…`,
    reports: m => !isPlaceholder(m[0].slice(prefixLength(m[0]))),
    mask: () => MASK,
  }
}

/** 値だけを伏せる。`m[0]` が「…値 + 閉じの引用符」で終わる形（名前つきの代入）用。 */
function maskQuotedValue(m: RegExpMatchArray, value: string): string {
  return `${m[0].slice(0, m[0].length - value.length - 1)}${MASK}${m[0].slice(-1)}`
}

/** 名前つきの代入で、名前が警告の対象か。 */
function assignedSecret(name: string, value: string): boolean {
  return SECRET_ASSIGN_NAME_RE.test(name) && looksLikeSecretValue(value) && !isBrowserSafeKey(name, value)
}

/** 伏せ字にする値か。警告より広い（見本の値と短い値だけを残す）。`Bearer ***` のような伏せた跡だけのものも、もう一度伏せない。 */
function maskableValue(value: string): boolean {
  return value.length >= MIN_VALUE_LENGTH && !isPlaceholder(value) && !/^[A-Za-z]+ \*\*\*$/.test(value)
}

/** 資格情報を値として見るための、`user:pass` の password 側。コロンが無ければ空。 */
function passwordOf(userinfo: string): string {
  const i = userinfo.indexOf(':')
  return i < 0 ? '' : userinfo.slice(i + 1)
}

/** 引用符で囲んだ値を、名前つきの形（`name = "値"`）と同じ条件で伏せる。`nameAt`・`valueAt` は正規表現の組の番号。 */
function maskNamedQuoted(nameAt: number, valueAt: number): (m: RegExpMatchArray) => string | null {
  return m => (maskableName(m[nameAt]) && maskableValue(m[valueAt]) ? maskQuotedValue(m, m[valueAt]) : null)
}

// ── 引用符のない値（yml・sh・.htaccess・md・txt では、これが普通の書き方）──────────────────
// 値は「空白・引用符・括弧で切れる ASCII の1かたまり」。先頭は変数の印（`$` `%`）・別名（`*` `&`）などを除く。
// 括弧を開く形（`getenv(`・`os.environ[`）は呼び出し・読み出しなので、かたまりが `(` `[` `{` で終わるときは当てない。

/** 引用符なしの値の1かたまり（8〜256字）。先頭の字を除く。 */
const BARE_REST = String.raw`(?:(?![\s"'\x60<>()\[\]{}])[\x21-\x7e]){7,255}`
/** かたまりの先頭の字。 */
const BARE_FIRST = String.raw`(?![\s"'\x60<>()\[\]{}$%*&|!])[\x21-\x7e]`
/** かたまりの終わり: 空白・閉じの括弧や引用符・ASCII でない字（日本語の文）・文末。呼び出しや読み出しの `(` `[` `{` は含めない。 */
const BARE_END = String.raw`(?=[\s"'\x60<>)\]}]|[^\x00-\x7f]|$)`
/** 名前に秘密らしい語が無ければ、値を見る前に捨てる（長い入力で時間をかけない）。 */
const SECRET_WORD_AHEAD = String.raw`(?=[\w$.-]{0,63}?(?:pass|pwd|secret|token|key|credential|salt|nonce|authorization))`

/** 識別子の書き方（読み出しの名前）。英字だけで、単語を大文字・`_` でつないだもの。`password: hashedPassword`・`secret: SECRET_KEY`。 */
const BARE_IDENTIFIER_RE = /^(?:[a-z]+(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]+)+|[a-z]+(?:_[a-z]+)+|[A-Z]+(?:_[A-Z]+)+)$/

/** 引用符なしで書かれた、固定の値に見えるか。見本・短い値・パス・URL・読み出し（`req.body.password`）・識別子は除く。 */
function bareLiteral(v: string): boolean {
  return maskableValue(v)
    && !/^(?:\.{0,2}\/|~\/)/.test(v)
    && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)
    && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)
    && !BARE_IDENTIFIER_RE.test(v)
}

/** 文末の記号（`,` `;` `.` `:`）は値に含めない。 */
const TRAILING_PUNCT_RE = /[,;.:]+$/

/**
 * 引用符なしの値を伏せる。`m[0]` が「…値」で終わる形用。`valueAt` の組が値のかたまり、`nameAt` が名前の組
 * （日本語の見出しのように、名前が決まった語の形では渡さない）。文末の記号は残す。
 */
function maskBare(m: RegExpMatchArray, valueAt: number, nameAt?: number): string | null {
  const raw = m[valueAt]
  const value = raw.replace(TRAILING_PUNCT_RE, '')
  if ((nameAt !== undefined && !maskableName(m[nameAt])) || !bareLiteral(value)) return null
  return `${m[0].slice(0, m[0].length - raw.length)}${MASK}${raw.slice(value.length)}`
}

/** 引用符で囲んだ値の組（`: '値'`・`=> "値"`）。 */
const QUOTED_PAIR_RE = /((?::|=>)\s*)(["'`])((?:\\.|(?!\2)[^\\\n]){0,2048})\2/g

/**
 * 呼び出しの第1引数（カンマの手前まで）。引用符の文字列と、2段までの括弧・波括弧・角括弧のかたまりは1つとして読む
 * （`{ id: u.id, role: 'a' }` の中のカンマで切らない）。
 */
const CALL_FIRST_ARG = String.raw`(?:[^,(){}\[\]"'\x60]|"[^"\n]*"|'[^'\n]*'|\((?:[^()]|\([^()]*\))*\)|\{(?:[^{}]|\{[^{}]*\})*\}|\[(?:[^\[\]]|\[[^\[\]]*\])*\])+?`

const SECRET_SHAPES: readonly SecretShape[] = [
  {
    id: 'private-key',
    kind: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
    valueOf: m => m[0],
    sampleOf: () => '',  // 鍵の本体は、先頭の数文字でも出さない
    reports: () => true,
    mask: (m, keepLines) => (keepLines ? MASK + '\n'.repeat(countNewlines(m[0])) : MASK),
  },
  knownKey('github-token', /gh[pousr]_[A-Za-z0-9]{16,}/g, () => 4),
  knownKey('github-fine-grained', /github_pat_[A-Za-z0-9_]{20,}/g, () => 'github_pat_'.length),
  knownKey('anthropic-key', /sk-ant-[A-Za-z0-9_-]{16,}/g, () => 'sk-ant-'.length),
  // 決済の秘密キー・制限つきキー（`sk_live_…`・`rk_test_…`）。公開可能キー `pk_…` は含まない
  knownKey('stripe-secret', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, () => 'sk_live_'.length),
  // 名前の無い位置引数（`setApiKey('SG.…')`・`new WebClient('xoxb-…')`）でも、形だけで分かる既知のキー（0.6.26）。
  // 接頭辞と長さ・字種を決めて当てる（普通の単語や識別子を伏せない）
  knownKey('sendgrid-key', /(?<![\w.])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, () => 'SG.'.length),
  knownKey('slack-token', /(?<![\w-])xox[abposr]-[A-Za-z0-9-]{10,}/g, () => 'xoxb-'.length),
  knownKey('aws-access-key-id', /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, () => 'AKIA'.length),
  // OpenAI。`sk-` のあとに数字が混ざるものだけ（`sk-learn-…` のような識別子を拾わない）。sk-ant- は上で先に取られる
  knownKey('openai-key', /(?<![\w-])sk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g, () => 'sk-'.length),
  knownKey('npm-token', /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g, () => 'npm_'.length),
  {
    // Google の API キー（`AIza…`）。地図・Firebase の web 設定は公開してよいので警告しない（isBrowserSafeKey と同じ考え）が、送りはしない
    id: 'google-api-key',
    kind: 'known-key',
    maskOnly: true,
    re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
    mask: () => MASK,
  },
  {
    id: 'bearer',
    kind: 'known-key',
    re: /(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
    valueOf: m => m[0].slice(m[1].length).replace(/=+$/, ''),
    sampleOf: () => '',
    // 「Bearer authentication」のような文を警告しないよう、値の形も見る
    reports: m => looksLikeSecretValue(m[0].slice(m[1].length).replace(/=+$/, '')),
    mask: m => `${m[1]}${MASK}`,
  },
  {
    // http(s) の資格情報。`user:pass@` だけでなく、トークン1つだけを user に置く形もある。
    // `[^/\s]+` は**貪欲に**取る。パスワードに @ が入っていると（p@ssw0rd）最初の @ で切れて後半が残る
    id: 'url-credential',
    kind: 'connection-string',
    re: /(https?:\/\/)([^/\s]+)@/gi,
    valueOf: m => (m[2].includes(':') ? passwordOf(m[2]) : m[2]),
    sampleOf: () => '',
    reports: m => (m[2].includes(':')
      ? passwordOf(m[2]) !== '' && !isTemplateValue(passwordOf(m[2]))
      : m[2].length >= 16 && /^[\w-]+$/.test(m[2]) && looksLikeSecretValue(m[2])),
    // 埋め込み式（`${user}:${pass}@`）は値ではないので伏せない。伏せると、読む側が資格情報があると取り違える。
    // ただし `$ecretPass2024` のように固定の文字列かもしれない `$名前` は伏せる（isReferenceOnly）
    mask: m => (isReferenceOnly(m[2].includes(':') ? passwordOf(m[2]) : m[2]) ? null : `${m[1]}${MASK}@`),
  },
  {
    // http(s) 以外の接続文字列（mysql・postgres・redis・mongodb など。`ユーザー:パスワード@ホスト` の形）。
    // パスワードの無いもの（ユーザーだけ）は資格情報に数えない
    id: 'connection-string',
    kind: 'connection-string',
    re: /(?<![\w+.-])((?!https?:)[a-z][a-z0-9+.-]{1,31}:\/\/)([^/\s:@]*):([^/\s]+)@/gi,
    valueOf: m => m[3],
    sampleOf: () => '',
    reports: m => !isTemplateValue(m[3]),
    mask: m => (isReferenceOnly(m[3]) ? null : `${m[1]}${MASK}@`),
  },
  {
    // name = "値"・"name": "値"・'name' => '値'・$name = "値"。引用符で囲んだ固定の文字列だけ（読み出しは数えない）
    id: 'named-secret',
    kind: 'named-secret',
    byName: true,
    re: /(?<![\w$.-])["']?([$A-Za-z_][\w$.-]{0,63})["']?\s*(?::|=>|=)\s*(["'`])((?:\\.|(?!\2)[^\\\n]){0,2048})\2/g,
    valueOf: m => m[3],
    sampleOf: () => '',
    reports: m => assignedSecret(m[1], m[3]),
    mask: m => (maskableName(m[1]) && maskableValue(m[3]) ? maskQuotedValue(m, m[3]) : null),
  },
  {
    // define('DB_PASSWORD', '値')
    id: 'named-secret-define',
    kind: 'named-secret',
    byName: true,
    re: /\bdefine\(\s*(["'])([A-Za-z_]\w{0,63})\1\s*,\s*(["'`])((?:\\.|(?!\3)[^\\\n]){0,2048})\3/g,
    valueOf: m => m[4],
    sampleOf: () => '',
    reports: m => assignedSecret(m[2], m[4]),
    mask: m => (maskableName(m[2]) && maskableValue(m[4]) ? maskQuotedValue(m, m[4]) : null),
  },
  {
    // 比較と、秘密らしい名前の読み出しのあとの既定値: `process.env.X || '値'`・`req.body.password === '値'`・
    // `$_POST['password'] === '値'`・`config['password'] = '値'`。警告は黙る（比較や既定値は直書きとは限らない）が、送れば値が漏れるので伏せる
    id: 'named-secret-wide',
    kind: 'named-secret',
    byName: true,
    maskOnly: true,
    re: /(?<![\w$.-])["']?([$A-Za-z_][\w$.-]{0,63})["']?\]?\s*(?:\|\|=?|\?\?=?|[!=]==?|=>|:|=)\s*(["'`])((?:\\.|(?!\2)[^\\\n]){0,2048})\2/g,
    mask: maskNamedQuoted(1, 3),
  },
  {
    // 秘密らしい名前への代入で、右が読み出し・左が既定値: `password = req.body.pw || '値'`・`password = os.environ.get('PW') or '値'`。
    // 左の名前に秘密らしい語が無いものは当てない（右の読み出しの名前を、上の形が見る）
    id: 'named-secret-default',
    kind: 'named-secret',
    byName: true,
    maskOnly: true,
    re: new RegExp(
      String.raw`(?<![\w$.-])["']?${SECRET_WORD_AHEAD}([$A-Za-z_][\w$.-]{0,63})["']?\s*(?::|=>|=)[ \t]*[^\n;]{1,120}?\s*(?:\|\||\?\?|\bor\b)\s*(["'\x60])((?:\\.|(?!\2)[^\\\n]){0,2048})\2`,
      'gi',
    ),
    mask: maskNamedQuoted(1, 3),
  },
  {
    // `users: { admin: '値' }`（express-basic-auth などの利用者表）。名前が利用者名なので、名前では見分けられない
    id: 'named-secret-users',
    kind: 'named-secret',
    byName: true,
    maskOnly: true,
    re: /\b(?:users|accounts)["']?[ \t]*[:=][ \t]*\{([^{}]{0,2048})\}/gi,
    mask: m => {
      const inner = m[1].replace(QUOTED_PAIR_RE, (all: string, lead: string, q: string, v: string) => (maskableValue(v) ? `${lead}${q}${MASK}${q}` : all))
      return inner === m[1] ? null : `${m[0].slice(0, m[0].length - m[1].length - 1)}${inner}}`
    },
  },
  {
    // 署名・HMAC・暗号の呼び出しで、鍵の位置にある文字列: `jwt.sign(payload, '値', …)`・`jwt.verify(token, '値')`・
    // `crypto.createHmac('sha256', '値')`・`createCipheriv('aes-256-cbc', '値', iv)`。名前が無いので位置で見分ける。
    // 一覧の呼び出しだけで、任意の関数の引数は伏せない。短い値も伏せる（`hunter2`）。見本の言葉・埋め込み式は残す
    id: 'signing-key-argument',
    kind: 'named-secret',
    byName: true,
    maskOnly: true,
    re: new RegExp(
      String.raw`(\b(?:(?:jwt|jsonwebtoken|jws)\.(?:sign|verify|encode|decode)|createHmac|createCipheriv|createDecipheriv)\(\s*${CALL_FIRST_ARG}\s*,\s*)(["'\x60])((?:\\.|(?!\2)[^\\\n]){1,2048})\2`,
      'g',
    ),
    mask: m => (isPlaceholder(m[3]) ? null : maskQuotedValue(m, m[3])),
  },
  {
    // Python の `hmac.new(b'値', msg, hashlib.sha256)`（鍵が第1引数）
    id: 'signing-key-hmac-new',
    kind: 'named-secret',
    byName: true,
    maskOnly: true,
    re: /(\bhmac\.new\(\s*b?)(["'])((?:\\.|(?!\2)[^\\\n]){1,2048})\2/g,
    mask: m => (isPlaceholder(m[3]) ? null : maskQuotedValue(m, m[3])),
  },
  {
    // 引用符のない `名前: 値`・`名前=値`（yml・.env 風・sh の export・Dockerfile の ENV・md のメモ）
    id: 'named-secret-bare',
    kind: 'named-secret',
    byName: true,
    maskOnly: true,
    re: new RegExp(
      String.raw`(?<![\w$.-])["']?${SECRET_WORD_AHEAD}([$A-Za-z_][\w$.-]{0,63})["']?[ \t]*(?::|=>|=)[ \t]*(?:(?:Basic|Digest)[ \t]+)?(${BARE_FIRST}${BARE_REST})${BARE_END}`,
      'gi',
    ),
    mask: m => maskBare(m, 2, 1),
  },
  {
    // 空白で区切る形: Dockerfile の `ENV 名前 値`・.htaccess の `SetEnv 名前 値`（値は引用符で囲んでもよい）
    id: 'named-secret-spaced',
    kind: 'named-secret',
    byName: true,
    maskOnly: true,
    re: new RegExp(
      String.raw`^[ \t]*(?:ENV|ARG|SetEnv)[ \t]+${SECRET_WORD_AHEAD}([$A-Za-z_][\w$.-]{0,63})[ \t]+(?:(["'])([^"'\n]{8,256})\2|(${BARE_FIRST}${BARE_REST})${BARE_END})`,
      'gim',
    ),
    mask: m => {
      if (m[2] !== undefined) return maskableName(m[1]) && maskableValue(m[3]) ? maskQuotedValue(m, m[3]) : null
      return maskBare(m, 4, 1)
    },
  },
  {
    // 日本語の見出し: `パスワード: 値`・`パスワードは 値 です`（md・txt のメモ）。値は ASCII の1かたまり。
    // 画面の言葉の見張りが旧い言い方を探すので、「合言葉」はここでは分けて書く
    id: 'named-secret-ja',
    kind: 'named-secret',
    byName: true,
    maskOnly: true,
    re: new RegExp(
      String.raw`(?:パスワード|パスコード|暗証番号|合言${'葉'}|あいことば|シークレット|トークン|秘密鍵|秘密キー|APIキー|アクセスキー|認証キー)[ \t]*(?:[:：=＝]|は[ \t]*[:：]?)[ \t]*[「『“]?(${BARE_FIRST}${BARE_REST})${BARE_END}`,
      'g',
    ),
    mask: m => maskBare(m, 1),
  },
]

// ── 検出 ──────────────────────────────────────────────────────────────

/** 各行の先頭の位置。 */
function lineStartsOf(src: string): number[] {
  const starts = [0]
  for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/** 位置が何行目か（1 始まり）。 */
function lineAt(starts: readonly number[], index: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= index) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/**
 * テキストの中の秘密を、種類・行・文字数・見本で返す（純関数）。**値そのものは返さない。**
 * 並びは出てきた順。見つからなければ空配列。読み出し（`process.env.X`）・見本の値・
 * 公開してよいキーは数えない。
 */
export function findSecretShapes(text: string): SecretFinding[] {
  const src = String(text ?? '')
  const starts = lineStartsOf(src)
  const taken: Array<[number, number]> = []
  const found: Array<SecretFinding & { at: number }> = []
  for (const shape of SECRET_SHAPES) {
    if (shape.maskOnly) continue
    for (const m of src.matchAll(shape.re)) {
      const at = m.index ?? 0
      const end = at + m[0].length
      if (taken.some(([a, b]) => at < b && a < end)) continue
      // 見本と判断したものも範囲は取る。内側の判断を、外側の形が覆し直さない
      taken.push([at, end])
      if (!shape.reports(m)) continue
      found.push({ kind: shape.kind, line: lineAt(starts, at), length: shape.valueOf(m).length, sample: shape.sampleOf(m), at })
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ at: _at, ...f }) => f)
}

// ── 伏せ字 ────────────────────────────────────────────────────────────

export interface MaskOptions {
  /** 行数を保つか。既定は保つ（行番号が変わらない）。1行にまとめたいログは false。 */
  keepLines?: boolean
  /** 名前を見て決める形（`password = "値"`）も伏せるか。既定は伏せる。 */
  byName?: boolean
}

function replaceMatches(text: string, re: RegExp, replacer: (m: RegExpMatchArray) => string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0
    out += text.slice(last, at) + replacer(m)
    last = at + m[0].length
  }
  return out + text.slice(last)
}

/**
 * 値を伏せ字（`***`）に置き換える（純関数）。**警告より広く伏せる**（見本の値と短い値以外は残さない）。
 * 既定では行数を保つ。秘密鍵は、複数行のぶんの改行を残して1つの `***` にする。
 * もう一度かけても結果は変わらない。
 */
export function maskSecretShapes(text: string, options: MaskOptions = {}): string {
  const keepLines = options.keepLines ?? true
  const byName = options.byName ?? true
  let out = String(text ?? '')
  for (const shape of SECRET_SHAPES) {
    if (shape.byName && !byName) continue
    out = replaceMatches(out, shape.re, m => shape.mask(m, keepLines) ?? m[0])
  }
  return out
}
