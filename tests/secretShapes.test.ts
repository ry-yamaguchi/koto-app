import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  findSecretShapes, maskSecretShapes, looksSecretName, looksSecretKeyName, isPlaceholder, type SecretFinding,
} from '../src/shared/secretShapes'
import { redactSecrets } from '../src/shared/updateLog'

// 秘密の「形」の唯一の定義（src/shared/secretShapes.ts）の試験。
// 警告する例（WARN）と通す例（QUIET）を**対で**同じ関数に流す（掟10。commandGuard.test.ts の DANGEROUS／SAFE と同じ作り）。
// このファイルの見本は、リポジトリの秘密検出に引っかからないよう、文字列を連結して組み立てている。

const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

// ── 見本（連結して組み立てる）──────────────────────────────────────────
const GH_BODY = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' // 36字
const GH = 'gh' + 'p_' + GH_BODY                      // 40字
const PAT_BODY = '11ABCDEFG0AbCdEfGhIjKl_mNoPqRsTuVwXyZ0123456789'
const PAT = 'github' + '_pat_' + PAT_BODY
const ANT_BODY = 'api03-Ab1Cd2Ef3Gh4Ij5Kl6Mn7'
const ANT = 'sk' + '-ant-' + ANT_BODY
const JWT_BODY = 'eyJhbGciOiJIUzI1NiJ9.e30.Zk3p9Qw7Rt5Yu2'
const PEM_HEAD = '-----BEGIN RSA ' + 'PRIVATE KEY-----'
const PEM_TAIL = '-----END RSA ' + 'PRIVATE KEY-----'
const PEM_BODY = ['MIIEowIBAAKCAQEA0Z3VS5JJcds3xfnAAAA', 'BBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ']
const PEM = [PEM_HEAD, ...PEM_BODY, PEM_TAIL].join('\n')
const PUBLIC_PEM = ['-----BEGIN PUBLIC' + ' KEY-----', 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A', '-----END PUBLIC' + ' KEY-----'].join('\n')
const GOOGLE_KEY = 'AI' + 'za' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'
const STRIPE_PUBLISHABLE = 'pk' + '_live_' + '51HabcdEfGhIjKlMnOpQ'
const MAPBOX_PUBLIC = 'pk' + '.eyJ1IjoiYWJjIn0.abc123'
const STRIPE_BODY = '51AbCdEfGhIjKlMnOpQrStUv'
const STRIPE_SECRET = 'sk' + '_live_' + STRIPE_BODY
const STRIPE_RESTRICTED = 'rk' + '_test_' + STRIPE_BODY

const f = (kind: SecretFinding['kind'], line: number, length: number, sample = ''): SecretFinding => ({ kind, line, length, sample })

// ── 警告する（WARN）──────────────────────────────────────────────────
interface Warn { label: string; text: string; expected: SecretFinding[]; leaks: string[] }
const WARN: Warn[] = [
  { label: 'GitHub のトークンが、引用符の中の固定の文字列', text: `const t = "${GH}"`, expected: [f('known-key', 1, 40, 'ghp_…')], leaks: [GH_BODY] },
  { label: '引用符が無くても、形で分かる（シェルの export）', text: `export GITHUB_TOKEN=${GH}`, expected: [f('known-key', 1, 40, 'ghp_…')], leaks: [GH_BODY] },
  { label: 'GitHub の細かい権限のトークン', text: `token: '${PAT}'`, expected: [f('known-key', 1, PAT.length, 'github_pat_…')], leaks: [PAT_BODY] },
  { label: 'Anthropic のキー', text: `const k = '${ANT}'`, expected: [f('known-key', 1, ANT.length, 'sk-ant-…')], leaks: [ANT_BODY] },
  { label: '決済の秘密キー（名前の無い位置引数でも、形で分かる）', text: `const stripe = require('stripe')('${STRIPE_SECRET}')`, expected: [f('known-key', 1, STRIPE_SECRET.length, 'sk_live_…')], leaks: [STRIPE_BODY] },
  { label: '決済の制限つきキー（テスト用）', text: `STRIPE_KEY=${STRIPE_RESTRICTED}`, expected: [f('known-key', 1, STRIPE_RESTRICTED.length, 'rk_test_…')], leaks: [STRIPE_BODY] },
  { label: '名前が秘密らしく、重ねて既知の形でもある（既知の形として1件）', text: `const token = "${GH}"`, expected: [f('known-key', 1, 40, 'ghp_…')], leaks: [GH_BODY] },
  { label: 'Bearer のあとに固定のトークン', text: `headers: { Authorization: 'Bearer ${JWT_BODY}' }`, expected: [f('known-key', 1, JWT_BODY.length)], leaks: [JWT_BODY] },
  { label: 'パスワードらしい名前に、8文字以上の固定の文字列', text: 'const password = "hunter22222"', expected: [f('named-secret', 1, 11)], leaks: ['hunter22222'] },
  { label: '単語に数字が付いただけの弱いパスワード', text: 'const password = "sunshine99"', expected: [f('named-secret', 1, 10)], leaks: ['sunshine99'] },
  { label: 'JSON の apiKey', text: '{ "apiKey": "Zk3p9Qw7Rt5Yu2" }', expected: [f('named-secret', 1, 14)], leaks: ['Zk3p9Qw7Rt5Yu2'] },
  { label: '大文字の環境変数名の代入', text: "DB_PASSWORD = 'S3cureP@ss99'", expected: [f('named-secret', 1, 12)], leaks: ['S3cureP@ss99'] },
  { label: 'PHP の変数', text: '$password = "Qw8!zx0Lm";', expected: [f('named-secret', 1, 9)], leaks: ['Qw8!zx0Lm'] },
  { label: 'PHP の配列', text: "'secret' => 'abcd1234efgh',", expected: [f('named-secret', 1, 12)], leaks: ['abcd1234efgh'] },
  { label: 'PHP の define', text: "define('DB_PASSWORD', 'p4ssw0rd-x9');", expected: [f('named-secret', 1, 11)], leaks: ['p4ssw0rd-x9'] },
  { label: 'プロパティへの代入', text: 'this.clientSecret = "c1ient5ecretXYZ"', expected: [f('named-secret', 1, 15)], leaks: ['c1ient5ecretXYZ'] },
  { label: 'ブラウザ向けのキーと同じ接頭辞でも、サーバー側の名前なら警告する', text: `const GEMINI_API_KEY = "${GOOGLE_KEY}"`, expected: [f('named-secret', 1, GOOGLE_KEY.length)], leaks: [GOOGLE_KEY] },
  { label: '接続文字列に資格情報（mysql）', text: 'mysql://app:Zk3p9Qw7@db.example.com:3306/shop', expected: [f('connection-string', 1, 8)], leaks: ['Zk3p9Qw7'] },
  { label: '接続文字列に資格情報（user:pass の形）', text: 'mysql://user:pass@host', expected: [f('connection-string', 1, 4)], leaks: [':pass@'] },
  { label: '接続文字列に資格情報（user が空の redis）', text: 'redis://:Zk3p9Qw7@cache:6379', expected: [f('connection-string', 1, 8)], leaks: ['Zk3p9Qw7'] },
  { label: '接続文字列に資格情報（mongodb+srv）', text: 'mongodb+srv://u:p4ssw0rd@cluster0.example.net/db', expected: [f('connection-string', 1, 8)], leaks: ['p4ssw0rd'] },
  { label: 'https の URL に資格情報', text: 'https://user:pw12345678@example.test/x', expected: [f('connection-string', 1, 10)], leaks: ['pw12345678'] },
  { label: 'パスワードに @ が入っている', text: 'https://user:p@ssw0rd@github.com/x/y', expected: [f('connection-string', 1, 8)], leaks: ['p@ssw0rd'] },
  { label: '秘密鍵の本体（BEGIN から END まで・BEGIN の行を返す）', text: ['// 鍵', 'const pem = `', PEM, '`'].join('\n'), expected: [f('private-key', 3, PEM.length)], leaks: PEM_BODY },
]

// ── 通す（QUIET）──────────────────────────────────────────────────────
// mask: 警告はしないが、伏せ字は警告より広いので伏せる（見本の値と短い値以外は残さない）
interface Quiet { label: string; text: string; mask?: true }
const QUIET: Quiet[] = [
  { label: '環境変数から読むだけ（JS）', text: 'const k = process.env.API_KEY' },
  { label: '環境変数から読むだけ（Python）', text: 'api_key = os.environ["API_KEY"]' },
  { label: '環境変数から読むだけ（PHP）', text: "$key = getenv('API_KEY');" },
  { label: '環境変数が無いときの空の値', text: "const token = process.env.TOKEN || ''" },
  { label: '正しい書き方（リクエストの値を渡すだけ）', text: 'password: req.body.password,' },
  { label: '正しい書き方（apiKey を環境変数から）', text: 'const apiKey = process.env.API_KEY' },
  { label: '見本 YOUR_API_KEY', text: 'const apiKey = "YOUR_API_KEY"' },
  { label: '見本（数字が混ざる）', text: 'const apiKey = "YOUR_API_KEY_HERE_12345"' },
  { label: '見本 xxxx の繰り返し', text: 'const secret = "xxxxxxxxxxxx"' },
  { label: '伏せ字', text: 'const password = "************"' },
  { label: '空の値', text: 'const password = ""' },
  { label: '見本 changeme', text: 'const password = "changeme"' },
  { label: '見本 REPLACE_ME_123', text: 'const token = "REPLACE_ME_123"' },
  { label: '見本 <…>', text: 'const token = "<your-api-token-1>"' },
  { label: '見本 {{…}}', text: 'password: "{{ DB_PASSWORD }}"' },
  { label: 'シェルの変数', text: 'password: "$DB_PASSWORD"' },
  { label: '埋め込み式', text: 'const password = `${process.env.DB_PASSWORD}`' },
  { label: 'GitHub の形の見本（xxxx）', text: `const t = "${'gh' + 'p_' + 'x'.repeat(36)}"`, mask: true },
  { label: 'Anthropic の形の見本', text: `const k = "${'sk' + '-ant-' + 'X'.repeat(24)}"`, mask: true },
  { label: '資格情報の無い接続文字列', text: 'mysql://db.example.com:3306/shop' },
  { label: 'user だけで password の無い接続文字列', text: 'postgres://app@db.example.com/shop' },
  { label: '接続文字列の埋め込み式', text: 'const url = `mysql://${user}:${pass}@${host}/db`' },
  { label: 'https の埋め込み式', text: 'fetch(`https://${user}:${token}@api.example.com/v1`)' },
  { label: '公開鍵（BEGIN PUBLIC KEY）', text: PUBLIC_PEM },
  { label: '公開鍵の1行（.pub）', text: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDexample user@host' },
  { label: 'パスワード入力欄', text: '<input type="password" name="password" autocomplete="current-password">' },
  { label: 'ラベル文字「パスワード」', text: '<label for="pw">パスワード</label>' },
  { label: 'placeholder="パスワード"', text: '<input placeholder="パスワード">' },
  { label: '名前が似ているだけ（入力欄を取る）', text: "const passwordInput = document.querySelector('#pw')" },
  { label: '名前が似ているだけ（tokenizer）', text: 'tokenizer = new Tokenizer()' },
  { label: '名前が似ているだけ（セレクタの文字列）', text: "const passwordInput = '#password-input-1'" },
  { label: '名前が似ているだけ（tokenKey）', text: "const tokenKey = 'koto-token-key-2'", mask: true },
  { label: '名前が秘密でない', text: 'const title = "hunter22222abc"' },
  { label: 'key という一般的な名前（React の key）', text: '<li key="item-1234-abcd">' },
  { label: '保存先のキー名（識別子の形）', text: "const AUTH_TOKEN = 'koto_auth_token'", mask: true },
  { label: '保存先のキー名（版の数字が付く識別子）', text: "const REFRESH_TOKEN_KEY = 'refresh_token_key_v1'", mask: true },
  { label: '表示名のラベル（連番つきの識別子）', text: "const SECRET_NAME = 'my-secret-name-1'", mask: true },
  { label: '日本語の文', text: 'password: "パスワードを入力してください"', mask: true },
  { label: 'Bearer を説明する文', text: '// Bearer authentication を使う', mask: true },
  { label: 'Bearer のあとが埋め込み式', text: 'headers.Authorization = `Bearer ${token}`' },
  { label: '決済の公開可能キー', text: `const stripeApiKey = "${STRIPE_PUBLISHABLE}"`, mask: true },
  { label: '決済の公開可能キー（名前なし）', text: `const stripe = Stripe("${STRIPE_PUBLISHABLE}")` },
  { label: 'Firebase の web 設定', text: `const firebaseConfig = { apiKey: "${GOOGLE_KEY}" }`, mask: true },
  { label: '地図の JavaScript 用のキー', text: `const MAPS_API_KEY = "${GOOGLE_KEY}"`, mask: true },
  { label: '地図の公開トークン', text: `const mapboxToken = "${MAPBOX_PUBLIC}"`, mask: true },
  // 引用符のない値・比較・既定値の形を足したあとも、読み出しは変えない
  { label: '読み出し（識別子の camelCase）', text: 'password: hashedPassword,' },
  { label: '読み出し（識別子の camelCase・トークン）', text: 'token: sessionToken,' },
  { label: '読み出し（定数名の SCREAMING_SNAKE）', text: 'secret: SECRET_KEY' },
  { label: '読み出し（メンバー参照）', text: 'const password = form.password.value' },
  { label: '値がファイルの場所（Docker の secrets）', text: 'POSTGRES_PASSWORD_FILE: /run/secrets/db_password' },
  { label: '値が URL', text: 'TOKEN_URL=https://auth.example.com/oauth/token' },
  { label: '値が別の所から読む印（GitHub Actions）', text: 'token: ${{ secrets.GITHUB_TOKEN }}' },
  { label: '読み出し（PHP のリクエスト）', text: "$token = $_GET['token'];" },
  { label: '読み出し（Python のフォーム）', text: "password = request.form['password']" },
  { label: '比較の相手が名前（引用符なし）', text: 'if (req.body.password !== confirmPassword) {' },
  { label: '比較の左が秘密の名前でない', text: "if (field === 'password') {" },
  { label: '既定値が空', text: "const apiKey = process.env.API_KEY || ''" },
  { label: '既定値が見本', text: "const password = process.env.DB_PASSWORD ?? 'changeme'" },
  { label: 'URL のパスワードが変数名だけ（シェル）', text: 'https://deploy:$DEPLOY_TOKEN@git.example.com/repo.git' },
  { label: '接続文字列のパスワードが変数名だけ（小文字）', text: 'postgres://app:$password@db.example.com/shop' },
  { label: '読み出し（小文字だけの関数の呼び出し）', text: 'token: fetchtoken(db)' },
  { label: '読み出し（小文字だけの添字）', text: 'const secret = lookupsecret[name]' },
  { label: '値が YAML の別名', text: 'password: *shared_password_anchor' },
  { label: '値が YAML のタグ', text: 'password: !vault_encrypted_value' },
  { label: '値が変数の印（バッチファイル）', text: 'SET PASSWORD=%DB_PASSWORD_VALUE%' },
  { label: '名前が似ているだけ（引用符なしの key）', text: 'sort key: created-at-desc-1' },
  { label: '名前が似ているだけ（引用符なしの passenger）', text: 'passenger: window-seat-aisle-1' },
  { label: '短い値（引用符なし）', text: 'password: abc123' },
  { label: '利用者表の値が短い', text: "users: { admin: 'ab12', guest: 'x' }" },
]

describe('findSecretShapes — 警告する例（WARN）', () => {
  for (const w of WARN) {
    it(w.label, () => {
      const found = findSecretShapes(w.text)
      expect(found).toEqual(w.expected)
      // 値は返さない（見本は形の接頭辞だけ）
      const out = JSON.stringify(found)
      for (const leak of w.leaks) expect(out).not.toContain(leak)
    })
  }
})

describe('findSecretShapes — 通す例（QUIET）', () => {
  for (const q of QUIET) {
    it(q.label, () => {
      expect(findSecretShapes(q.text)).toEqual([])
    })
  }

  it('空・未定義でも落ちない', () => {
    expect(findSecretShapes('')).toEqual([])
    expect(findSecretShapes(undefined as unknown as string)).toEqual([])
  })
})

describe('findSecretShapes — 行・順序・重なり', () => {
  it('行番号は1始まりで、出てきた順に返す', () => {
    const text = ['const a = 1', `const t = "${GH}"`, '', 'const password = "hunter22222"', 'mysql://app:Zk3p9Qw7@db/x'].join('\n')
    expect(findSecretShapes(text).map(x => [x.kind, x.line])).toEqual([
      ['known-key', 2], ['named-secret', 4], ['connection-string', 5],
    ])
  })

  it('秘密鍵は、ほかの形より先に当てる（BEGIN の行だけを潰して本体を残さない）', () => {
    const text = 'Authorization: Bearer ' + PEM
    expect(findSecretShapes(text).map(x => x.kind)).toEqual(['private-key'])
    const masked = maskSecretShapes(text)
    for (const body of PEM_BODY) expect(masked).not.toContain(body)
  })

  it('改行が CRLF でも行番号は同じ', () => {
    expect(findSecretShapes(['x', 'const password = "hunter22222"'].join('\r\n'))[0].line).toBe(2)
  })

  it('同じ行に2つあれば2件', () => {
    const text = `a = "${GH}"; b = "${ANT}"`
    expect(findSecretShapes(text).map(x => x.sample)).toEqual(['ghp_…', 'sk-ant-…'])
  })

  it('同じ入力に何度かけても同じ結果（正規表現の状態を持ち越さない）', () => {
    const text = `const t = "${GH}"\nconst password = "hunter22222"`
    const first = findSecretShapes(text)
    expect(findSecretShapes(text)).toEqual(first)
    expect(findSecretShapes(text)).toEqual(first)
  })

  it('長い1行（圧縮したファイル）でも時間がかからない', () => {
    const start = Date.now()
    findSecretShapes('a'.repeat(300_000))
    findSecretShapes('a.b-'.repeat(100_000))
    findSecretShapes('"password"='.repeat(20_000))
    expect(Date.now() - start).toBeLessThan(5000)
  })
})

describe('maskSecretShapes', () => {
  for (const w of WARN) {
    it(`WARN を伏せる: ${w.label}`, () => {
      const masked = maskSecretShapes(w.text)
      for (const leak of w.leaks) expect(masked).not.toContain(leak)
      expect(masked.split('\n').length).toBe(w.text.split('\n').length)
      // 伏せたあとに見つかるものは残らず、もう一度かけても変わらない
      expect(findSecretShapes(masked)).toEqual([])
      expect(maskSecretShapes(masked)).toBe(masked)
    })
  }

  for (const q of QUIET) {
    it(`QUIET は ${q.mask ? '警告より広く伏せる' : '変えない'}: ${q.label}`, () => {
      const masked = maskSecretShapes(q.text)
      if (q.mask) expect(masked).not.toBe(q.text)
      else expect(masked).toBe(q.text)
    })
  }

  it('値だけを伏せ、名前と引用符は残す', () => {
    expect(maskSecretShapes('const password = "hunter22222"')).toBe('const password = "***"')
    expect(maskSecretShapes("define('DB_PASSWORD', 'p4ssw0rd-x9');")).toBe("define('DB_PASSWORD', '***');")
    expect(maskSecretShapes(`headers: { Authorization: 'Bearer ${JWT_BODY}' }`)).toBe("headers: { Authorization: 'Bearer ***' }")
    expect(maskSecretShapes('https://user:pw12345678@example.test/x')).toBe('https://***@example.test/x')
    expect(maskSecretShapes('mysql://app:Zk3p9Qw7@db.example.com:3306/shop')).toBe('mysql://***@db.example.com:3306/shop')
  })

  it('秘密鍵は、行数を保って1つの *** にする（既定）', () => {
    const text = ['a', PEM, 'b'].join('\n')
    const masked = maskSecretShapes(text)
    expect(masked.split('\n')).toEqual(['a', '***', '', '', '', 'b'])
    // 行数を保たない指定では、改行も残さない
    expect(maskSecretShapes(text, { keepLines: false })).toBe('a\n***\nb')
  })

  it('名前を見て決める形は、指定すれば伏せない', () => {
    expect(maskSecretShapes('const password = "hunter22222"', { byName: false })).toBe('const password = "hunter22222"')
    expect(maskSecretShapes(`const t = "${GH}"`, { byName: false })).toBe('const t = "***"')
  })

  it('空・未定義でも落ちない', () => {
    expect(maskSecretShapes('')).toBe('')
    expect(maskSecretShapes(undefined as unknown as string)).toBe('')
  })
})

// ── 伏せるだけの形（MASK_ONLY）──────────────────────────────────────────
// 警告は迷ったら黙るが、AI Engine へ送る本文は迷ったら伏せる。引用符のない値（yml・sh・.htaccess・md・txt では普通の書き方）、
// 比較と既定値、利用者表、警告の名前に無い語（pass・salt・nonce・_KEY）、`$` で始まるパスワードの URL。
// 警告（findSecretShapes）は数えない。値そのものは、どれも伏せたあとの文に残らない。
const SECRET_VALUE = 'Zk3p9Qw7Xv5Nm2'
const S3 = 'S3cretPassw0rd'
interface MaskOnly { label: string; text: string; masked: string; leak: string }
const MASK_ONLY: MaskOnly[] = [
  // 引用符のない値（yml・env 風・sh・Dockerfile・.htaccess・md）
  { label: 'yml: 名前: 値', text: `POSTGRES_PASSWORD: ${SECRET_VALUE}`, masked: 'POSTGRES_PASSWORD: ***', leak: SECRET_VALUE },
  { label: 'yml: 行頭の - と 名前=値', text: `    - MYSQL_ROOT_PASSWORD=${SECRET_VALUE}`, masked: '    - MYSQL_ROOT_PASSWORD=***', leak: SECRET_VALUE },
  { label: 'yml: 行末の注釈は残す', text: `password: ${SECRET_VALUE} # 変更すること`, masked: 'password: *** # 変更すること', leak: SECRET_VALUE },
  { label: 'sh: export 名前=値', text: `export API_TOKEN=${SECRET_VALUE}`, masked: 'export API_TOKEN=***', leak: SECRET_VALUE },
  { label: 'sh: コマンドの引数の中', text: `docker run -e DB_PASSWORD=${SECRET_VALUE} image`, masked: 'docker run -e DB_PASSWORD=*** image', leak: SECRET_VALUE },
  { label: 'Dockerfile: ENV 名前=値', text: `ENV DB_PASSWORD=${SECRET_VALUE}`, masked: 'ENV DB_PASSWORD=***', leak: SECRET_VALUE },
  { label: 'Dockerfile: ENV 名前 値（空白区切り）', text: `ENV DB_PASSWORD ${SECRET_VALUE}`, masked: 'ENV DB_PASSWORD ***', leak: SECRET_VALUE },
  { label: '.htaccess: SetEnv 名前 値', text: `SetEnv SECRET_KEY ${SECRET_VALUE}`, masked: 'SetEnv SECRET_KEY ***', leak: SECRET_VALUE },
  { label: '.htaccess: SetEnv 名前 "値"', text: `SetEnv SECRET_KEY "${SECRET_VALUE}"`, masked: 'SetEnv SECRET_KEY "***"', leak: SECRET_VALUE },
  { label: 'md: API_KEY=値', text: 'API_KEY=abcd1234efgh5678ijkl', masked: 'API_KEY=***', leak: 'abcd1234efgh5678ijkl' },
  { label: 'md: 英字だけのパスワード', text: 'password: mysecretpassword', masked: 'password: ***', leak: 'mysecretpassword' },
  { label: 'md: 日本語の見出し', text: `管理画面のパスワード: ${S3}`, masked: '管理画面のパスワード: ***', leak: S3 },
  { label: 'md: 日本語の「は」と文末', text: `パスワードは ${S3} です`, masked: 'パスワードは *** です', leak: S3 },
  { label: 'md: 日本語の括弧つき', text: `パスワードは「${S3}」です。`, masked: 'パスワードは「***」です。', leak: S3 },
  { label: 'md: 全角のコロン', text: `暗証番号：${SECRET_VALUE}`, masked: '暗証番号：***', leak: SECRET_VALUE },
  { label: 'md: 合言葉（画面の言葉の見張りを避けて分けて書いた語も効く）', text: `合言葉は ${S3}`, masked: '合言葉は ***', leak: S3 },
  { label: 'Authorization の Basic（方式の名前は残す）', text: 'Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==', masked: 'Authorization: Basic ***', leak: 'dXNlcjpwYXNzd29yZDEyMw' },
  { label: 'Authorization の値（引用符つき）', text: 'headers: { "Authorization": "Basic dXNlcjpwYXNzd29yZDEyMw==" }', masked: 'headers: { "Authorization": "***" }', leak: 'dXNlcjpwYXNzd29yZDEyMw' },
  // 比較と既定値（警告の対象外）
  { label: '既定値: 環境変数 || 固定の文字列', text: `const DB_PASSWORD = process.env.DB_PASSWORD || '${S3}'`, masked: "const DB_PASSWORD = process.env.DB_PASSWORD || '***'", leak: S3 },
  { label: '既定値: 環境変数 ?? 固定の文字列', text: `const jwt = process.env.JWT_SECRET ?? "${S3}"`, masked: 'const jwt = process.env.JWT_SECRET ?? "***"', leak: S3 },
  { label: '既定値: 名前の無い環境変数の読み出しのあと', text: `const password = req.body.pw || '${S3}'`, masked: "const password = req.body.pw || '***'", leak: S3 },
  { label: '既定値: Python の or', text: `password = os.environ.get('PW') or '${S3}'`, masked: "password = os.environ.get('PW') or '***'", leak: S3 },
  { label: '比較: ===', text: `if (req.body.password === '${S3}') {`, masked: "if (req.body.password === '***') {", leak: S3 },
  { label: '比較: PHP の配列の添字', text: `if ($_POST['password'] === '${S3}') {`, masked: "if ($_POST['password'] === '***') {", leak: S3 },
  { label: '比較: !=', text: `if (token != "${S3}") return`, masked: 'if (token != "***") return', leak: S3 },
  { label: '添字への代入', text: `config['password'] = '${S3}';`, masked: "config['password'] = '***';", leak: S3 },
  // 利用者表
  { label: '利用者表: 1行', text: `app.use(basicAuth({ users: { admin: '${S3}' } }))`, masked: "app.use(basicAuth({ users: { admin: '***' } }))", leak: S3 },
  { label: '利用者表: 複数の利用者・複数行', text: `users: {\n  admin: '${S3}',\n  bob: "hunter2xx99",\n}`, masked: "users: {\n  admin: '***',\n  bob: \"***\",\n}", leak: S3 },
  { label: '利用者表: JSON', text: `{ "users": { "alice": "${S3}" } }`, masked: '{ "users": { "alice": "***" } }', leak: S3 },
  // 警告の名前に無い語
  { label: '名前: $pass', text: `$pass = '${S3}';`, masked: "$pass = '***';", leak: S3 },
  { label: '名前: $dbpass', text: `$dbpass = "${S3}";`, masked: '$dbpass = "***";', leak: S3 },
  { label: '名前: DB_PASS の define', text: `define('DB_PASS', '${S3}');`, masked: "define('DB_PASS', '***');", leak: S3 },
  { label: '名前: WordPress の NONCE_KEY（記号を含む値）', text: "define( 'NONCE_KEY', 'q8|Zk3!p9Qw7Xv5Nm2&Rt' );", masked: "define( 'NONCE_KEY', '***' );", leak: 'q8|Zk3!p9Qw7Xv5Nm2&Rt' },
  { label: '名前: WordPress の LOGGED_IN_KEY', text: "define('LOGGED_IN_KEY', 'q8|Zk3!p9Qw7Xv5Nm2&Rt');", masked: "define('LOGGED_IN_KEY', '***');", leak: 'q8|Zk3!p9Qw7Xv5Nm2&Rt' },
  { label: '名前: WordPress の AUTH_SALT', text: "define('AUTH_SALT', 'q8|Zk3!p9Qw7Xv5Nm2&Rt');", masked: "define('AUTH_SALT', '***');", leak: 'q8|Zk3!p9Qw7Xv5Nm2&Rt' },
  { label: '名前: メール送信の pass（利用者名は残す）', text: "auth: { user: 'me@gmail.com', pass: 'abcd efgh ijkl mnop' }", masked: "auth: { user: 'me@gmail.com', pass: '***' }", leak: 'abcd efgh ijkl mnop' },
  { label: '名前: camelCase の Key', text: `const encryptionKey = "${SECRET_VALUE}"`, masked: 'const encryptionKey = "***"', leak: SECRET_VALUE },
  // URL・接続文字列で、パスワードが `$` で始まる固定の文字列
  { label: 'URL: $ で始まるパスワード', text: 'fetch failed https://deploy:$ecretPass2024@git.example.com/repo.git', masked: 'fetch failed https://***@git.example.com/repo.git', leak: 'ecretPass2024' },
  { label: '接続文字列: $ で始まるパスワード', text: "const url = 'postgres://app:$ecretPw2024@db.example.com:5432/app'", masked: "const url = 'postgres://***@db.example.com:5432/app'", leak: 'ecretPw2024' },
]

describe('maskSecretShapes — 伏せるだけの形（警告はしない）', () => {
  for (const c of MASK_ONLY) {
    it(c.label, () => {
      const masked = maskSecretShapes(c.text)
      expect(masked).toBe(c.masked)
      expect(masked).not.toContain(c.leak)
      // 警告は黙る（警告は迷ったら黙る。伏せ字だけが広い）
      expect(findSecretShapes(c.text)).toEqual([])
      // もう一度かけても変わらない
      expect(maskSecretShapes(masked)).toBe(masked)
      expect(masked.split('\n').length).toBe(c.text.split('\n').length)
    })
  }

  it('★ ログの伏せ字（byName: false）には、名前を見る形を持ち込まない', () => {
    for (const c of MASK_ONLY.filter(x => !x.text.includes('://'))) {
      expect(maskSecretShapes(c.text, { byName: false }), c.label).toBe(c.text)
    }
  })

  it('★ ログ（redactSecrets）は、`$` で始まるパスワードの URL も伏せる。変数名だけの URL は残す', () => {
    expect(redactSecrets('fetch failed https://deploy:$ecretPass2024@git.example.com/repo.git')).toBe('fetch failed https://***@git.example.com/repo.git')
    expect(redactSecrets('connect postgres://app:$ecretPw2024@db.example.com/shop failed')).toBe('connect postgres://***@db.example.com/shop failed')
    expect(redactSecrets('https://deploy:$DEPLOY_TOKEN@git.example.com/repo.git')).toBe('https://deploy:$DEPLOY_TOKEN@git.example.com/repo.git')
  })

  it('決済の秘密キーは、名前の無い位置引数でも伏せる。公開可能キーは警告しない', () => {
    expect(maskSecretShapes(`const stripe = require('stripe')('${STRIPE_SECRET}')`)).toBe("const stripe = require('stripe')('***')")
    expect(maskSecretShapes(`Stripe("${STRIPE_PUBLISHABLE}")`)).toBe(`Stripe("${STRIPE_PUBLISHABLE}")`)
  })

  it('長い1行・値の長い入力でも時間がかからない', () => {
    const start = Date.now()
    maskSecretShapes('a='.repeat(100_000))
    maskSecretShapes('password='.repeat(30_000))
    maskSecretShapes('password: ' + 'a'.repeat(300_000) + '(')
    maskSecretShapes('token=' + 'x'.repeat(300) + '"\n').length
    maskSecretShapes('users: {'.repeat(20_000))
    maskSecretShapes('password = x || '.repeat(20_000))
    expect(Date.now() - start).toBeLessThan(5000)
  })
})

describe('isPlaceholder', () => {
  it('見本の値', () => {
    const samples = [
      '', '   ', 'xxxx', 'XXXXXXXX', '********', '0000', 'x-x-x-x',
      'YOUR_API_KEY', 'your_password', 'your-secret-key', 'put-your-token-here', 'REPLACE_ME_123',
      'changeme', 'CHANGE_ME', 'change-me', 'password', 'example', 'dummy',
      '<token>', '<your-api-token-1>', '${DB_PASSWORD}', 'abc${x}', '{{ PASSWORD }}', '{password}', '$DB_PASS', '%s', '%(password)s',
    ]
    for (const s of samples) expect(isPlaceholder(s), JSON.stringify(s)).toBe(true)
    expect(isPlaceholder(undefined as unknown as string)).toBe(true)
  })

  it('本物の値に見えるものは見本にしない（迷ったら警告する側）', () => {
    const real = ['hunter22222', 'Zk3p9Qw7', GH, 'p@ssw0rd', 'correct-horse-battery', 'mysecretpassword99', 'S3cureP@ss99']
    for (const s of real) expect(isPlaceholder(s), s).toBe(false)
  })
})

describe('looksSecretName', () => {
  // HANAMII の環境変数の🔒の候補が使っていた判定。共有へ移しても結果を変えない
  const LEGACY = /KEY|SECRET|TOKEN|PASS|PWD|CREDENTIAL|PRIVATE|APIKEY/i
  const NAMES = [
    'API_KEY', 'OPENAI_API_KEY', 'SESSION_SECRET', 'GITHUB_TOKEN', 'DB_PASSWORD', 'ADMIN_PASS', 'PWD', 'GOOGLE_CREDENTIALS',
    'PRIVATE_KEY', 'APIKEY', 'apiKey', 'clientSecret', 'KEYBOARD', 'PASSENGER_COUNT', 'MONKEY',
    'PORT', 'NODE_ENV', 'DATABASE_URL', 'HOST', 'DEBUG', '', 'x',
  ]

  it('秘密らしい名前', () => {
    for (const n of ['API_KEY', 'OPENAI_API_KEY', 'SESSION_SECRET', 'GITHUB_TOKEN', 'DB_PASSWORD', 'ADMIN_PASS', 'PWD', 'PRIVATE_KEY', 'apiKey']) {
      expect(looksSecretName(n), n).toBe(true)
    }
  })

  it('秘密らしくない名前', () => {
    for (const n of ['PORT', 'NODE_ENV', 'DATABASE_URL', 'HOST', 'DEBUG', '']) expect(looksSecretName(n), n).toBe(false)
    expect(looksSecretName(undefined as unknown as string)).toBe(false)
  })

  it('もとの判定と、どの名前でも同じ答え', () => {
    for (const n of NAMES) expect(looksSecretName(n), n).toBe(LEGACY.test(n))
  })
})

describe('looksSecretKeyName（値ごと落とす項目名）', () => {
  // main の結果の写し（projectOps）が持っていた判定。共有へ移しても結果を変えない
  const LEGACY = /token|secret|password|passwd|api[-_]?key|access[-_]?key|authorization|credential/i
  const NAMES = [
    'token', 'accessToken', 'tokenizer', 'secret', 'clientSecret', 'password', 'passwd', 'apiKey', 'api_key', 'api-key', 'accessKey', 'access-key',
    'Authorization', 'authorization', 'credential', 'credentials',
    'key', 'pass', 'pwd', 'salt', 'nonce', 'keyboard', 'name', 'projectId', 'logUrl', '', 'x',
  ]

  it('落とす名前', () => {
    for (const n of ['token', 'accessToken', 'clientSecret', 'password', 'apiKey', 'api_key', 'access-key', 'Authorization', 'credentials']) {
      expect(looksSecretKeyName(n), n).toBe(true)
    }
  })

  it('落とさない名前（結果の写しが使う項目）', () => {
    for (const n of ['projectId', 'logUrl', 'deployState', 'key', 'name', '']) expect(looksSecretKeyName(n), n).toBe(false)
    expect(looksSecretKeyName(undefined as unknown as string)).toBe(false)
  })

  it('もとの判定と、どの名前でも同じ答え', () => {
    for (const n of NAMES) expect(looksSecretKeyName(n), n).toBe(LEGACY.test(n))
  })
})

describe('redactSecrets は、形で分かる分を共有の形の一覧から伏せる', () => {
  // もとの実装（規則(1)〜(4)）の写し。共有へ移す前と同じ答えを返すことの基準にする
  function legacyRedact(text: string): string {
    return String(text ?? '')
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***')
      .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, '***')
      .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '***')
      .replace(/sk-ant-[A-Za-z0-9_-]{16,}/g, '***')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1***')
      .replace(/(https?:\/\/)[^/\s]+@/gi, '$1***@')
      .replace(/((?:access_|api[-_]?|auth|private[-_]?)?(?:token|key|secret|password|passwd|pwd)["'\s]*[:=]["'\s]*)([^\s"'&,}]{8,})/gi, '$1***')
  }

  const CORPUS = [
    'GET https://user:p@ssw0rd@github.com/x/y',
    '?access_token=abcdefgh12345678',
    '"api_key": "abcdefgh12345678"',
    'Authorization: Bearer abcdefgh12345678',
    'password=hunter22222',
    `なにか ${GH} なにか`,
    `なにか ${PAT} なにか`,
    `なにか ${ANT} なにか`,
    `key: ${PEM}`,
    `${PEM}\nAAAA`,
    'https://github.com/ry-yamaguchi/koto-app/releases/download/v0.3.3/latest-mac.yml',
    'Found version 0.3.3 (url: Koto-0.3.3-arm64-mac.zip)',
    'sha512 checksum mismatch, expected TAk9g2z+mtQ2xtZUa3skK7aW245F6YNYeXQug/x86Oi5',
    'net::ERR_INTERNET_DISCONNECTED',
    'const password = "abc 12345678"',
    'https://example.com/path?token=abcdefghij&x=1',
    'ssh://git@github.com/x/y と git@github.com:x/y.git',
    '',
  ]

  it('もとの実装と同じ答え（共有の一覧に移しても、ログの書き方を変えない）', () => {
    for (const s of CORPUS) expect(redactSecrets(s), s).toBe(legacyRedact(s))
  })

  it('一覧に足した形は、ログにも効く（http 以外の接続文字列・PGP の秘密鍵）', () => {
    expect(redactSecrets('connect mysql://app:Zk3p9Qw7@db.example.com/shop failed')).not.toContain('Zk3p9Qw7')
    expect(redactSecrets('connect mysql://app:Zk3p9Qw7@db.example.com/shop failed')).toContain('mysql://***@db.example.com')
    const pgp = ['-----BEGIN PGP ' + 'PRIVATE KEY BLOCK-----', 'lQOYBGabcdef', '-----END PGP ' + 'PRIVATE KEY BLOCK-----'].join('\n')
    expect(redactSecrets(`x ${pgp} y`)).not.toContain('lQOYBGabcdef')
  })

  it('名前を見て決める形は共有の一覧からは伏せない（ログは粗い(4)が受け持つ）', () => {
    // 空白で切れる値は(4)が伏せない。共有の「名前つき」の形（引用符の中を丸ごと）がログに入り込んでいないことを見る
    expect(maskSecretShapes('const password = "abc 12345678"')).toBe('const password = "***"')
    expect(redactSecrets('const password = "abc 12345678"')).toBe('const password = "abc 12345678"')
  })
})

describe('配線（ソースの形）', () => {
  function listSourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const ent of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${ent.name}`
      if (ent.isDirectory()) out.push(...listSourceFiles(rel))
      else if (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx')) out.push(rel)
    }
    return out.sort()
  }

  it('更新ログの redactSecrets は、共有の一覧を呼び、形の正規表現を自分では持たない', () => {
    const src = read('src/shared/updateLog.ts')
    expect(src).toContain("import { maskSecretShapes } from './secretShapes'")
    expect(src).toContain("return maskSecretShapes(String(text ?? ''), { keepLines: false, byName: false })")
    // 直す前の形（規則(1)〜(3)の正規表現）に戻っていない
    expect(src).not.toContain('gh[pousr]_')
    expect(src).not.toContain('github_pat_[')
    expect(src).not.toContain('sk-ant-[')
    expect(src).not.toContain('(Bearer\\s+)')
    expect(src).not.toContain('(https?:\\/\\/)[^/\\s]+@')
    expect(src).not.toContain('PRIVATE KEY-----[\\s\\S]*?')
  })

  it('HANAMII の環境変数の🔒は、共有の looksSecretName を呼ぶ', () => {
    const src = read('src/renderer/components/HanamiiPanel.tsx')
    expect(src).toContain("import { looksSecretName } from '../../shared/secretShapes'")
    expect(src).toContain("onClick={() => setEnvs(prev => [...prev, { key: k, value: '', secret: looksSecretName(k) }])}")
    expect(src).toContain(">＋ {k}{looksSecretName(k) ? ' 🔒' : ''}</button>")
    // 直す前の形（画面の中の双子）に戻っていない
    expect(src).not.toContain('guessSecret')
    expect(src).not.toContain('KEY|SECRET|TOKEN|PASS|PWD|CREDENTIAL|PRIVATE|APIKEY')
  })

  it('secretShapes を読み込む src は、次の8つだけ（呼び元を書き下す。足すときはここも足す）', () => {
    const importers = listSourceFiles('src')
      .filter(file => file !== 'src/shared/secretShapes.ts')
      .filter(file => /from '[./]*(?:[\w./-]*\/)?secretShapes'/.test(read(file)))
    expect(importers).toEqual(['src/main/hanamii/client.ts', 'src/main/ipc/hanamii.ts', 'src/main/projectOps.ts', 'src/renderer/components/HanamiiPanel.tsx', 'src/renderer/securityCheck.ts', 'src/shared/failureDetail.ts', 'src/shared/failureText.ts', 'src/shared/updateLog.ts'])
  })

  it('秘密の形の正規表現は、secretShapes.ts のほかのどの src にも無い', () => {
    const shapes = [
      'gh[pousr]_', 'github_pat_[', 'sk-ant-[', 'BEGIN [A-Z ]*PRIVATE KEY', 'KEY|SECRET|TOKEN|PASS|PWD|CREDENTIAL|PRIVATE|APIKEY',
      // 値ごと落とす項目名（main の結果の写しが持っていた）と、決済の秘密キーの形
      'token|secret|password|passwd|api[-_]?key|access[-_]?key|authorization|credential', '[sr]k_(?:live|test)_',
    ]
    for (const file of listSourceFiles('src')) {
      if (file === 'src/shared/secretShapes.ts') continue
      const src = read(file)
      for (const s of shapes) expect(src.includes(s), `${file}: ${s}`).toBe(false)
    }
  })
})

// ── 名前の無い位置引数の秘密（0.6.26）────────────────────────────────────
// 見本は連結で組み立てる（リポジトリの秘密検出に当てないため）。
describe('位置引数の秘密も、送る前に1文字も残さず伏せる', () => {
  const sendgrid = 'SG' + '.abcdefghijklmnopqrstuv.' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg'
  const slack = 'xox' + 'b-123456789012-1234567890123-' + 'AbCdEfGhIjKlMnOpQrStUvWx'
  const jwtSecret = 'myS3cret' + 'JwtKey2024'
  const aws = 'AKIA' + 'IOSFODNN7ABCDEFG'
  const google = 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'
  const openai = 'sk-' + 'proj-Ab12Cd34Ef56Gh78Ij90Kl12'
  const npm = 'npm' + '_abcdefghijklmnopqrstuvwxyz0123456789'
  const ghp = 'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789'
  const hnm = 'hnm' + '_Ab12Cd34Ef56Gh78Ij90Kl12Mn34'

  const CASES: Array<{ name: string; code: string; secret: string; keep: string[] }> = [
    { name: 'SendGrid', code: `sgMail.setApiKey('${sendgrid}')`, secret: sendgrid, keep: ['sgMail.setApiKey('] },
    { name: 'Slack', code: `const web = new WebClient('${slack}')`, secret: slack, keep: ['const web = new WebClient('] },
    { name: 'jwt.sign', code: `const t = jwt.sign(payload, '${jwtSecret}', { expiresIn: '1h' })`, secret: jwtSecret, keep: ['jwt.sign(payload, ', "{ expiresIn: '1h' })"] },
    { name: 'jwt.sign の第1引数が波括弧', code: `jwt.sign({ id: u.id, role: { n: 'a' } }, "${jwtSecret}")`, secret: jwtSecret, keep: ['jwt.sign({ id: u.id, role: { n: \'a\' } }, '] },
    { name: 'jwt.verify', code: `jwt.verify(token, '${jwtSecret}', cb)`, secret: jwtSecret, keep: ['jwt.verify(token, '] },
    { name: 'createHmac', code: `crypto.createHmac('sha256', '${jwtSecret}').update(body)`, secret: jwtSecret, keep: ["crypto.createHmac('sha256', ", '.update(body)'] },
    { name: 'createCipheriv', code: `crypto.createCipheriv('aes-256-cbc', '${jwtSecret}', iv)`, secret: jwtSecret, keep: ["createCipheriv('aes-256-cbc', ", ', iv)'] },
    { name: 'Python jwt.encode', code: `jwt.encode(payload, "${jwtSecret}", algorithm="HS256")`, secret: jwtSecret, keep: ['jwt.encode(payload, ', 'algorithm="HS256")'] },
    { name: 'Python hmac.new', code: `hmac.new(b"${jwtSecret}", msg, hashlib.sha256)`, secret: jwtSecret, keep: ['hmac.new(b', ', msg, hashlib.sha256)'] },
    { name: 'AWS アクセスキー ID', code: `new Client('${aws}')`, secret: aws, keep: ['new Client('] },
    { name: 'Google API キー', code: `init('${google}')`, secret: google, keep: ['init('] },
    { name: 'OpenAI', code: `new OpenAI('${openai}')`, secret: openai, keep: ['new OpenAI('] },
    { name: 'npm', code: `//registry/:_x=${npm} # メモ`, secret: npm, keep: ['# メモ'] },
    { name: 'GitHub', code: `login('${ghp}')`, secret: ghp, keep: ['login('] },
    { name: 'HANAMII のトークン', code: `Authorization は Bearer なしでも ${hnm} を送る`, secret: hnm, keep: ['Authorization は Bearer なしでも ', ' を送る'] },
  ]

  for (const c of CASES) {
    it(`${c.name}: 値が1文字も残らず、まわりのコードは読める`, () => {
      const out = maskSecretShapes(c.code)
      expect(out).not.toContain(c.secret)
      // 値の一部（先頭・末尾の8字）も残らない
      expect(out).not.toContain(c.secret.slice(0, 8))
      expect(out).not.toContain(c.secret.slice(-8))
      expect(out).toContain('***')
      for (const k of c.keep) expect(out, k).toContain(k)
      // もう一度かけても変わらない
      expect(maskSecretShapes(out)).toBe(out)
    })
  }

  it('見本の言葉・環境変数の読み出し・無関係な呼び出しは伏せない', () => {
    const QUIET = [
      "jwt.sign(payload, 'secret')",
      'jwt.sign(payload, process.env.JWT_SECRET)',
      "jwt.sign(payload, `${secret}`)",
      "crypto.createHmac('sha256', key)",
      "crypto.createHash('sha256').update('hunter2abc')",
      "logger.sign(payload, 'someOrdinaryText123')",
      "const a = 'sk-learn-pipeline-wrapper'",
      "const b = 'task-1234567890123456789012345'",
      "const c = 'SG.foo.bar'",
      "const d = 'AKIA-not-a-key'",
      "const e = 'npm_install_script'",
      "const f = 'xoxo-hugs'",
      "const g = 'hnm_token'",
      "const h = 'hnm_' + suffix",
      'HANAMII のトークンは hnm_ で始まります',
    ]
    for (const code of QUIET) expect(maskSecretShapes(code), code).toBe(code)
  })

  it('新しい既知のキーは警告にも数える。Google のキーは警告せず、送りもしない', () => {
    const kinds = (code: string) => findSecretShapes(code).map(f => f.kind)
    expect(kinds(`x('${sendgrid}')`)).toEqual(['known-key'])
    expect(kinds(`x('${slack}')`)).toEqual(['known-key'])
    expect(kinds(`x('${aws}')`)).toEqual(['known-key'])
    expect(kinds(`x('${openai}')`)).toEqual(['known-key'])
    expect(kinds(`x('${npm}')`)).toEqual(['known-key'])
    expect(kinds(`x('${hnm}')`)).toEqual(['known-key'])
    expect(kinds(`x('${google}')`)).toEqual([])
  })

  it('公開前チェックが AI へ送る本文は、位置引数の秘密も伏せてから分ける', async () => {
    const { splitIntoPieces } = await import('../src/renderer/securityCheck')
    const body = `sgMail.setApiKey('${sendgrid}')\nnew WebClient('${slack}')\njwt.sign(p, '${jwtSecret}', { expiresIn: '1h' })\n`
    const sent = splitIntoPieces('server.js', body).map(p => p.text).join('')
    for (const s of [sendgrid, slack, jwtSecret]) expect(sent).not.toContain(s.slice(4, 14))
    expect(sent).toContain("expiresIn: '1h'")
  })
})
