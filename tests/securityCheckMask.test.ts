import { describe, it, expect, beforeEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// 公開前セキュリティチェックが AI Engine へ送る本文に、秘密そのものが入らないこと。
//
// 以前は、コードに直書きした APIキーやパスワードが、伏せずにそのまま送られていた
// （ファイル名で分かる秘密〔.env など〕だけが守られていた）。
//
// ── 確かめる範囲 ───────────────────────────────────────────────────
// 確かめるのは、**伏せ字の対象にした形**だけ（下の SECRETS に書き下した形）。伏せ字は完全ではなく、形に当たらない
// 固定の文字列は残りうる。形を足すときは、secretShapes の表（tests/secretShapes.test.ts）と、ここの見本の両方に足す。
// 引用符つきの代入・既知のキー・接続文字列・秘密鍵のほか、引用符のない設定（yml・sh・.htaccess・md）、
// 比較と既定値、利用者表、決済の秘密キーを含む。
//
// ── このテストの流儀（掟10）──────────────────────────────────────────
// ソースの文字列を照合しない。**偽の fs と偽の `sakura.chat`** に実際に流し、
//   ・送られたすべての要求の本文に、秘密の値が（一部も）含まれないこと
//   ・送らないファイル（秘密らしい名前・ロックファイル・読む対象外）は、**読みにも行かない**こと
//     （＝読まれた道の一覧で見る。読めば送る可能性が生まれるので、読まないことを固定する）
// を見る。見本の秘密は、リポジトリの秘密検出に引っかからないよう、文字列を連結して組み立てる。
// ─────────────────────────────────────────────────────────────────────────────

type ChatArgs = { apiKey: string; model: string; messages: { role: string; content: any }[]; maxTokens?: number }

const store = new Map<string, string>()
const g = globalThis as any
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
}

// ── 見本の秘密（連結して作る）。「値」はそれぞれ、送られてはいけない部分 ─────────────
const GH_TOKEN = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const ANT_KEY = 'sk' + '-ant-' + 'api03-Ab1Cd2Ef3Gh4Ij5Kl6Mn7'
const BEARER = 'eyJhbGciOiJIUzI1NiJ9' + '.e30.' + 'Zk3p9Qw7Rt5Yu2'
const DB_PASS = 'Zk3p9Qw7Xv5Nm2'
const CONN_PASS = 'p4ss' + 'w0rd-Q9z7Lm'
const PHP_PASS = 'Qw8!zx0Lm5Rt'
// 引用符のない設定・比較・既定値・利用者表・メール送信・決済の秘密キー・WordPress の鍵
const YML_PASS = 'Yl7Mq2Wv9Zk4Xb'
const YML_ENV = 'Yl8Nr3Wc0Zd5Xe'
const SH_TOKEN = 'Sh4Tk9Vc2Xa7Ld'
const SH_PASS = 'Sh6Pw1Qz8Rb3Mn'
const HT_KEY = 'Ht5Ky0Jc7Vd2Qa'
const MD_PASS = 'Md3Ps8Lx6Wr1Gb'
const FALLBACK = 'fb-Hq4Zc9Lw2Nm7'
const COMPARE = 'cmp-Rt6Yb1Kd8Vx3'
const USERS_PW = 'usr-Ge2Mj7Pa5Qz9'
const MAIL_PASS = 'abcd efgh ijkl mnop'
const STRIPE_SECRET = 'sk' + '_live_' + '51AbCdEfGhIjKlMnOpQrStUv'
const WP_PASS = 'Wp9Dk4Hc1Xz6Lv'
const WP_NONCE = 'q8|Zk3!p9Qw7Xv5Nm2&Rt'
const WP_SALT = 'Ws2Ab8Cd4Ef6Gh'
/** 複数行の秘密鍵の本体（1行ずつ別の文字列。かたまりの境目をまたぐ長さにする）。 */
const PEM_LINES = Array.from({ length: 40 }, (_, i) =>
  `${String.fromCharCode(65 + (i % 26))}${i}Zk${i * 7}Qw${i * 13}Rt${i * 3}Yu${i * 11}Lp${i * 5}Mn${i * 17}Vb${i * 19}Xc`.padEnd(64, 'k').slice(0, 64))
const PEM_HEAD = '-----BEGIN RSA ' + 'PRIVATE KEY-----'
const PEM_TAIL = '-----END RSA ' + 'PRIVATE KEY-----'
const PEM = [PEM_HEAD, ...PEM_LINES, PEM_TAIL].join('\n')

/** 送られてはいけない値。どれも、一部（12文字の窓）でも本文に現れてはならない。 */
const SECRETS: Record<string, string> = {
  'GitHub のトークン': GH_TOKEN,
  'Anthropic のキー': ANT_KEY,
  'Bearer のトークン': BEARER,
  'パスワードの代入': DB_PASS,
  '接続文字列のパスワード': CONN_PASS,
  'PHP の define': PHP_PASS,
  '秘密鍵の本体（全部の行）': PEM,
  'yml の 名前: 値': YML_PASS,
  'yml の - 名前=値': YML_ENV,
  'sh の export 名前=値': SH_TOKEN,
  'sh の引数 名前=値': SH_PASS,
  '.htaccess の SetEnv 名前 値': HT_KEY,
  'md の日本語の見出し': MD_PASS,
  '環境変数 || 既定値': FALLBACK,
  '比較 === 値': COMPARE,
  '利用者表 users': USERS_PW,
  'メール送信の pass': MAIL_PASS,
  '決済の秘密キー（位置引数）': STRIPE_SECRET,
  'PHP の $pass': WP_PASS,
  'WordPress の NONCE_KEY': WP_NONCE,
  'WordPress の AUTH_SALT': WP_SALT,
}

/** 値を12文字ずつの窓にする。「1文字も無い」を、窓のどれも本文に無いことで見る。 */
function windows(value: string, size = 12): string[] {
  if (value.length <= size) return [value]
  const out: string[] = []
  for (let i = 0; i + size <= value.length; i++) out.push(value.slice(i, i + size))
  return out
}

/** server.js: 秘密を全部持つ。秘密鍵は1つ目のかたまり（6,000字）の境目をまたぐ位置に置く。 */
function serverJs(): string {
  const filler = Array.from({ length: 200 }, (_, i) => `// 手順 ${i}: 注文を受けて在庫を確かめる`).join('\n')
  return [
    "const express = require('express')",
    `const GITHUB_TOKEN = '${GH_TOKEN}'`,
    `const anthropic = { key: '${ANT_KEY}' }`,
    `const headers = { Authorization: 'Bearer ${BEARER}' }`,
    `const DB_PASSWORD = "${DB_PASS}"`,
    `const url = 'mysql://app:${CONN_PASS}@db.example.com:3306/shop'`,
    `define('DB_PASSWORD', '${PHP_PASS}');`,
    filler,
    `const pem = \`${PEM}\``,
    "app.listen(3000)",
  ].join('\n')
}

/** 読む道の一覧と、出た要求。 */
let readPaths: string[] = []
let sent: string[] = []

const FILES: Record<string, string> = {
  'package.json': '{ "name": "shop", "main": "server.js", "dependencies": { "express": "4.18.2" } }',
  'server.js': '',
  'index.html': '<h1>shop</h1>',
  // ↓ 引用符のない設定（yml・sh・.htaccess・md は、こう書くのが普通）と、比較・既定値・利用者表
  'docker-compose.yml': ['services:', '  db:', '    image: postgres:16', '    environment:', `      POSTGRES_PASSWORD: ${YML_PASS}`, '  app:', '    environment:', `      - MYSQL_ROOT_PASSWORD=${YML_ENV}`].join('\n'),
  'deploy.sh': ['#!/bin/sh', `export API_TOKEN=${SH_TOKEN}`, `docker run -e DB_PASSWORD=${SH_PASS} shop`].join('\n'),
  '.htaccess': `SetEnv SECRET_KEY ${HT_KEY}`,
  'README.md': `# shop\n\n管理画面のパスワード: ${MD_PASS}\n`,
  'wp-config.php': ['<?php', `$pass = '${WP_PASS}';`, `define( 'NONCE_KEY', '${WP_NONCE}' );`, `define('AUTH_SALT', '${WP_SALT}');`].join('\n'),
  'auth.js': [
    `const JWT = process.env.JWT_SECRET || '${FALLBACK}'`,
    `app.post('/login', (req, res) => { if (req.body.password === '${COMPARE}') ok(res) })`,
    `app.use(basicAuth({ users: { admin: '${USERS_PW}' } }))`,
    `nodemailer.createTransport({ auth: { user: 'me@gmail.com', pass: '${MAIL_PASS}' } })`,
    `const stripe = require('stripe')('${STRIPE_SECRET}')`,
  ].join('\n'),
  // ↓ 送らないファイル。中身に目印を入れておき、読みに行かれたら・送られたら気づく
  '.env': 'LEAK_ENV_MARKER=Zq9Xv7Lm3Kp5Wr1',
  'credentials.json': '{"LEAK_CREDENTIALS_MARKER": "Zq9Xv7Lm3Kp5Wr2"}',
  'config/secrets/app.js': 'module.exports = { LEAK_SECRETDIR_MARKER: "Zq9Xv7Lm3Kp5Wr3" }',
  'service-account.json': '{"LEAK_SERVICEACCOUNT_MARKER": "Zq9Xv7Lm3Kp5Wr4"}',
  'firebase/serviceAccountKey.json': '{"LEAK_FIREBASEKEY_MARKER": "Zq9Xv7Lm3Kp5Wr5"}',
  'package-lock.json': '{"LEAK_LOCKFILE_MARKER": "Zq9Xv7Lm3Kp5Wr6", "lockfileVersion": 3}',
  'sub/pnpm-lock.yaml': 'LEAK_PNPMLOCK_MARKER: Zq9Xv7Lm3Kp5Wr7',
  'yarn.lock': 'LEAK_YARNLOCK_MARKER Zq9Xv7Lm3Kp5Wr8',
  'customers.csv': 'LEAK_CSV_MARKER,Zq9Xv7Lm3Kp5Wr9',
  'server.py': 'LEAK_PY_MARKER = "Zq9Xv7Lm3Kp5Wra"',
}
const NOT_SENT = [
  'LEAK_ENV_MARKER', 'LEAK_CREDENTIALS_MARKER', 'LEAK_SECRETDIR_MARKER', 'LEAK_SERVICEACCOUNT_MARKER',
  'LEAK_FIREBASEKEY_MARKER', 'LEAK_LOCKFILE_MARKER', 'LEAK_PNPMLOCK_MARKER', 'LEAK_YARNLOCK_MARKER',
  'LEAK_CSV_MARKER', 'LEAK_PY_MARKER',
]

function setupWindow(chat: (args: ChatArgs) => Promise<any>) {
  FILES['server.js'] = serverJs()
  g.window = {
    dispatchEvent: () => true,
    electronAPI: {
      fs: {
        exists: async () => false, // public/ は無い（公開の根はプロジェクト直下）
        projectFilesInfo: async () => ({ files: Object.keys(FILES), truncated: false }),
        readFile: async (p: string) => {
          readPaths.push(p)
          const rel = p.replace(/^\/proj\//, '')
          if (!(rel in FILES)) throw new Error('無い')
          return FILES[rel]
        },
      },
      sakura: { chat },
    },
  }
}

const OK_REPLY = { content: '判定: 問題なし\n- 特に問題は見つかりませんでした', usage: { prompt_tokens: 1, completion_tokens: 1 } }

beforeEach(() => {
  readPaths = []
  sent = []
  store.clear()
})

async function run() {
  setupWindow(async (args) => {
    sent.push(args.messages.map(m => String(m.content)).join('\n'))
    return OK_REPLY
  })
  const { runSecurityCheck } = await import('../src/renderer/securityCheck')
  return runSecurityCheck('/proj', 'key-1')
}

describe('AI Engine へ送る本文に、伏せ字の対象にした形の秘密は入らない', () => {
  it('★ 送った全要求の本文に、秘密の値が（12文字の窓のどれも）含まれない', async () => {
    // 前提: 伏せる前の本文では、秘密鍵の BEGIN が最初のかたまり（6,000字）の中、END が次のかたまりの中にある。
    // 分けてから伏せる順に変えると、BEGIN と END が泣き別れて鍵の本体が残る
    const raw = serverJs()
    expect(raw.indexOf(PEM_HEAD)).toBeLessThan(6000)
    expect(raw.indexOf(PEM_TAIL)).toBeGreaterThan(6000)
    await run()
    const all = sent.join('\n')
    for (const [label, value] of Object.entries(SECRETS)) {
      for (const w of windows(value)) {
        expect(all.includes(w), `${label} の一部「${w.slice(0, 4)}…」が送られた`).toBe(false)
      }
    }
  })

  it('★ 秘密鍵の枠（BEGIN / END）の行そのものも残らない', async () => {
    await run()
    const all = sent.join('\n')
    expect(all).not.toContain(PEM_HEAD)
    expect(all).not.toContain(PEM_TAIL)
  })

  it('対照: 伏せたのは値だけで、コードの形（名前・後ろの行）は読める', async () => {
    await run()
    const all = sent.join('\n')
    expect(all).toContain('const DB_PASSWORD = "***"')
    expect(all).toContain('const GITHUB_TOKEN = ')
    expect(all).toContain("const express = require('express')")
    // 秘密鍵のあとの行も、境目をまたいで届いている
    expect(all).toContain('app.listen(3000)')
  })

  it('★ 引用符のない設定は、名前と区切りを残して値だけを伏せる（yml・sh・.htaccess・md）', async () => {
    await run()
    const all = sent.join('\n')
    for (const line of [
      'POSTGRES_PASSWORD: ***', '- MYSQL_ROOT_PASSWORD=***', 'export API_TOKEN=***', 'docker run -e DB_PASSWORD=*** shop',
      'SetEnv SECRET_KEY ***', '管理画面のパスワード: ***', "$pass = '***';", "define( 'NONCE_KEY', '***' );",
      "process.env.JWT_SECRET || '***'", "req.body.password === '***'", "users: { admin: '***' }", "pass: '***'", "require('stripe')('***')",
    ]) expect(all, line).toContain(line)
    // 伏せなかった所（秘密でない設定）は読める
    expect(all).toContain('image: postgres:16')
    expect(all).toContain("user: 'me@gmail.com'")
  })

  it('秘密に見える値を伏せて渡したことを、AI にも伝える（*** を見本の値と読んで見逃さない）', async () => {
    await run()
    expect(sent[0]).toContain('*** に置き換えてお渡ししています')
  })

  it('★ *** の所が本物の秘密とは限らないことも伝える（公開してよいキーまで指摘させない）', async () => {
    await run()
    expect(sent[0]).toContain('*** の所に本物の秘密が書かれていたとは限りません')
    expect(sent[0]).toContain('ブラウザ向けの公開キー')
    expect(sent[0]).toContain('本物の秘密の直書きに見えるものだけを指摘してください')
    // 直す前の断定（右側は全部、固定の値）に戻っていない
    expect(sent[0]).not.toContain('固定の値が書かれていました')
    expect(sent[0]).not.toContain('秘密の直書きとして指摘してください')
  })
})

describe('送らないファイルは、読みにも行かない・本文にも出ない', () => {
  it('★ 秘密らしい名前・ロックファイル・読む対象外のファイルは、中身を読まない', async () => {
    await run()
    // 読んだのは、検査の対象（コード・設定）だけ。package.json は種別の見分けと対象の両方で読まれる
    expect([...new Set(readPaths)].sort()).toEqual([
      '/proj/.htaccess', '/proj/README.md', '/proj/auth.js', '/proj/deploy.sh', '/proj/docker-compose.yml',
      '/proj/index.html', '/proj/package.json', '/proj/server.js', '/proj/wp-config.php',
    ])
  })

  it('★ 送らないファイルの中身は、どの要求にも含まれない', async () => {
    await run()
    const all = sent.join('\n')
    for (const marker of NOT_SENT) expect(all, marker).not.toContain(marker)
  })

  it('送らないファイルも、名前は伝わる（黙って落とさない）', async () => {
    await run()
    const first = sent[0]
    // 秘密らしい名前は「名前からして公開NG」の行に、読まない種類は「中身を確認していない」の行に載る
    expect(first).toContain('service-account.json')
    expect(first).toContain('firebase/serviceAccountKey.json')
    expect(first).toContain('credentials.json')
    expect(first).toContain('package-lock.json')
  })
})
