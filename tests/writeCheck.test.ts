import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findingsInWrite } from '../src/shared/writeCheck'
import type { WriteFinding, WriteFindingKind } from '../src/shared/securityFindings'

// 見本のキーは文字列の連結で組み立てる（実在しない値）
const GH_BODY = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const GH = 'gh' + 'p_' + GH_BODY
const PEM_HEAD = '-----BEGIN RSA ' + 'PRIVATE KEY-----'
const PEM_TAIL = '-----END RSA ' + 'PRIVATE KEY-----'
const PEM_BODY = 'MIIEowIBAAKCAQEAx9Zk3p9Qw7Rt5Yu2Xx0LmNoPqRsTuVwXyZ'
const PEM = [PEM_HEAD, PEM_BODY, PEM_TAIL].join('\n')

const kindsOf = (path: string, after: string, before: string | null = null): WriteFindingKind[] =>
  findingsInWrite({ path, before, after }).map(f => f.kind)

// ── 警告する（WARN）／通す（QUIET）。同じ関数に両方を回す ─────────────────
interface Case { label: string; path?: string; text: string }
interface Warn extends Case { kinds: WriteFindingKind[] }

const WARN: Warn[] = [
  { label: '既知の形のキーが固定の文字列', text: `const t = "${GH}"`, kinds: ['known-key'] },
  { label: '名前が秘密らしく、8文字以上の固定の文字列', text: 'const password = "hunter22222"', kinds: ['named-secret'] },
  { label: '接続文字列に資格情報', text: 'mysql://app:Zk3p9Qw7@db.example.com:3306/shop', kinds: ['connection-string'] },
  { label: '秘密鍵の本体', text: PEM, kinds: ['private-key'] },
  { label: '入力を ${} で exec に入れている', path: 'app.js', text: 'exec(`ls ${req.query.dir}`)', kinds: ['input-to-command'] },
  { label: '持ち主つき（child_process.exec）の呼びも対象', path: 'app.js', text: 'child_process.exec(`ls ${req.query.dir}`)', kinds: ['input-to-command'] },
  { label: '入力を連結して execSync に入れている', path: 'app.js', text: "execSync('ping ' + req.body.host)", kinds: ['input-to-command'] },
  { label: '入力をそのまま spawn に渡している', path: 'app.ts', text: 'spawn(req.params.cmd)', kinds: ['input-to-command'] },
  { label: '入力を res.send の HTML に入れている', path: 'server.js', text: 'res.send(`<h1>${req.query.name}</h1>`)', kinds: ['input-to-html'] },
  { label: '入力を innerHTML に入れている', path: 'page.js', text: 'el.innerHTML = location.hash', kinds: ['input-to-html'] },
  { label: '入力欄の値を outerHTML に連結している', path: 'page.tsx', text: "box.outerHTML = '<b>' + nameInput.value + '</b>'", kinds: ['input-to-html'] },
  { label: '入力を document.write に入れている', path: 'page.html', text: 'document.write(new URLSearchParams(location.search).get("q") + location.search)', kinds: ['input-to-html'] },
  { label: '入力を insertAdjacentHTML に入れている', path: 'page.vue', text: "list.insertAdjacentHTML('beforeend', `<li>${req.body.item}</li>`)", kinds: ['input-to-html'] },
  { label: '入力を path.join でファイルを開く', path: 'server.js', text: "fs.readFile(path.join(dir, req.params.name), cb)", kinds: ['input-to-path'] },
  { label: '入力を連結して sendFile に渡している', path: 'server.mjs', text: "res.sendFile(__dirname + '/files/' + req.query.f)", kinds: ['input-to-path'] },
  { label: '入力を writeFileSync のパスに使っている', path: 'save.cjs', text: 'fs.writeFileSync(`./uploads/${req.body.name}`, data)', kinds: ['input-to-path'] },
  { label: '入力を createReadStream のパスに使っている', path: 'app.svelte', text: 'fs.createReadStream(path.join(root, searchParams.get("f")))', kinds: ['input-to-path'] },
  { label: '入力を連結して HTML に出す（長さ・数にしない）', path: 'page.js', text: "out.innerHTML = '<p>' + input.value + '</p>'", kinds: ['input-to-html'] },
  { label: '入力を連結して ping に渡す', path: 'server.js', text: "exec('ping ' + req.query.host)", kinds: ['input-to-command'] },
  { label: '入力を連結してファイルを開く', path: 'server.js', text: "fs.readFile('./f/' + req.query.name, cb)", kinds: ['input-to-path'] },
  { label: '数にした入力と、そのままの入力が同じ行にある', path: 'page.js', text: 'out.innerHTML = Number(numInput.value) + otherInput.value', kinds: ['input-to-html'] },
  { label: 'config.js（名前の先頭が example ではない・テストのパスでもない）のパスワード', path: 'src/config.js', text: "const password = 'Passw0rd123'", kinds: ['named-secret'] },
  { label: 'example.js は見本のファイルではない', path: 'example.js', text: "const password = 'hunter22222'", kinds: ['named-secret'] },
  { label: 'テストのファイルでも、既知の形のキーは出す', path: 'tests/auth.test.js', text: `const t = "${GH}"`, kinds: ['known-key'] },
  { label: 'テストのファイルでも、接続文字列の資格情報は出す', path: 'a.spec.ts', text: 'mysql://app:Zk3p9Qw7@db.example.com:3306/shop', kinds: ['connection-string'] },
  { label: 'seed は通さない（本番の初期パスワードになることがある）', path: 'db/seed.js', text: "User.create({ email: 'a@example.com', password: 'admin12345' })", kinds: ['named-secret'] },
]

const QUIET: Case[] = [
  { label: 'process.env で読むだけ', text: 'const t = process.env.GITHUB_TOKEN' },
  { label: '見本の値', text: 'const apiKey = "YOUR_API_KEY"' },
  { label: '資格情報の無い接続文字列', text: 'mysql://db.example.com:3306/shop' },
  { label: '公開鍵', text: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx9Zk3p9Qw7\n-----END PUBLIC KEY-----' },
  { label: '固定のコマンド', path: 'app.js', text: "exec('ls -la')" },
  { label: '入力を引数の配列で渡す', path: 'app.js', text: "spawn('ls', ['-la', req.query.dir])" },
  { label: '入力を引数の配列で渡す（execFile 風の spawn）', path: 'app.js', text: "spawn('convert', [req.body.file, 'out.png'])" },
  { label: '入力を正規表現に当てるだけ（/re/.exec）', path: 'app.js', text: 'const m = /id=(\\d+)/.exec(req.query.s)' },
  { label: '入力を変数の正規表現に当てるだけ（.exec）', path: 'app.js', text: 'const m = pattern.exec(location.search)\nconst n = re.exec(searchParams.get("x"))' },
  { label: '第1引数が配列で始まる形', path: 'app.js', text: 'spawn([req.query.cmd])' },
  { label: 'innerHTML の代入の後ろの別の文に入力がある', path: 'page.js', text: 'el.innerHTML = tpl; v = nameInput.value' },
  { label: '環境変数で読む（os.environ・getenv）', path: 'config.js', text: 'password = os.environ["PW"]\nconst k = getenv(\'API_KEY\')' },
  { label: '見本の値・空・changeme', path: 'config.js', text: 'const a = "xxxx"\nconst b = ""\nconst pw = "changeme"' },
  { label: '公開鍵のファイル .pub', path: 'id_rsa.pub', text: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7vbqajDhA user@host' },
  { label: 'ブラウザ向けに公開してよいキー（いまの挙動の固定）', path: 'firebase.js', text: 'const cfg = { apiKey: "AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6" }' },
  { label: '入力を textContent に入れる', path: 'page.js', text: 'el.textContent = req.query.name' },
  { label: 'innerHTML に固定の文字列', path: 'page.js', text: "el.innerHTML = '<p>こんにちは</p>'" },
  { label: 'エスケープの関数を通す', path: 'page.js', text: 'el.innerHTML = escapeHtml(location.hash)' },
  { label: 'res.send にエスケープの関数を通す', path: 'server.js', text: 'res.send(`<h1>${escapeHtml(req.query.name)}</h1>`)' },
  { label: 'res.send に固定の HTML', path: 'server.js', text: "res.send('<h1>固定</h1>')" },
  { label: 'path.basename を通す', path: 'server.js', text: 'fs.readFile(path.join(dir, path.basename(req.params.name)), cb)' },
  { label: '固定のファイル名', path: 'server.js', text: "fs.readFile(path.join(__dirname, 'data.json'), cb)" },
  { label: '入力と出口が別の行（流れは追わない）', path: 'server.js', text: 'const dir = req.query.dir\nexec(dir)' },
  { label: '入力が文字列の中にあるだけ', path: 'app.js', text: "exec('echo req.query.x')" },
  { label: 'コメントの行', path: 'app.js', text: '// exec(`ls ${req.query.dir}`)' },
  { label: 'type="password" の入力欄', path: 'form.html', text: '<input type="password" name="pw" placeholder="パスワード">' },
  { label: '名前が似ているだけの変数', path: 'app.js', text: "const passwordInput = document.querySelector('#pw')\nconst tokenizer = new Tokenizer()" },
  { label: '読み出しの形', path: 'app.js', text: 'const o = { password: req.body.password }\nconst apiKey = process.env.API_KEY' },
  { label: '対象外の拡張子では危ない書き方を見ない', path: 'notes.md', text: 'exec(`ls ${req.query.dir}`)' },
  { label: '見本のファイル .env.example', path: '.env.example', text: `TOKEN=${GH}` },
  { label: '見本のファイル *.sample', path: 'config/db.sample', text: 'password = "hunter22222"' },
  { label: '見本のファイル *.template', path: 'a/b.template', text: `const t = "${GH}"` },
  { label: '見本のファイル *.dist（大文字小文字を区別しない）', path: 'settings.DIST', text: `const t = "${GH}"` },
  { label: '見本のファイル *.example', path: 'x.js.example', text: `const t = "${GH}"` },
  { label: '見本のファイル config.example.js（見本の後ろに拡張子）', path: 'config.example.js', text: "const password = 'Passw0rd!x'" },
  { label: '見本のファイル config.sample.json', path: 'config.sample.json', text: '{"apiKey": "abcd1234efgh5678"}' },
  { label: '見本のファイル .env.template', path: '.env.template', text: `TOKEN=${GH}` },
  { label: '数にして使う入力（Number）', path: 'page.js', text: 'out.innerHTML = Number(numInput.value) + Number(otherInput.value)' },
  { label: '数にして使う入力（parseFloat）', path: 'page.js', text: 'result.innerHTML = parseFloat(amountInput.value) * 1.1' },
  { label: '入力の長さだけを使う', path: 'page.js', text: "counter.innerHTML = input.value.length + ' / 100'" },
  { label: '入力を条件にするだけの三項演算子', path: 'page.js', text: "msg.innerHTML = input.value ? 'あり' : 'なし'" },
  { label: '数にした入力を res.send の HTML に入れる', path: 'server.js', text: 'res.send(`<p>${Number(req.query.n)}</p>`)' },
  { label: '数にした入力をファイル名に使う', path: 'server.js', text: 'fs.readFileSync(`./data/${parseInt(req.params.id)}.json`)' },
  { label: '数にした入力をコマンドに使う', path: 'server.js', text: 'exec(`sleep ${Number(req.query.s)}`)' },
  { label: '入力の長さを HTML に入れる', path: 'server.js', text: "res.send('<p>' + req.body.length + '</p>')" },
  { label: 'テストのファイルの見本のパスワード（.test.）', path: 'auth.test.js', text: "const password = 'password123'" },
  { label: 'テストのファイルの見本のキー名つきの値（.spec.）', path: 'src/a.spec.ts', text: "apiKey = 'test-api-key-12345'; token = 'fake-token-abc123'" },
  { label: 'tests/ の下の見本のパスワード', path: 'tests/fixtures.js', text: "const x = { password: 'Passw0rd123' }" },
  { label: '__tests__/ の下の見本のパスワード', path: 'src/__tests__/login.js', text: "const password = 'hunter22222'" },
  { label: 'fixtures/ の下の見本のパスワード', path: 'fixtures/user.js', text: "const password = 'hunter22222'" },
]

describe('findingsInWrite — 警告する例（WARN）', () => {
  for (const w of WARN) {
    it(w.label, () => {
      expect(kindsOf(w.path ?? 'src/config.js', w.text)).toEqual(w.kinds)
    })
  }
})

describe('findingsInWrite — 通す例（QUIET）', () => {
  for (const q of QUIET) {
    it(q.label, () => {
      expect(findingsInWrite({ path: q.path ?? 'src/config.js', before: null, after: q.text })).toEqual([])
    })
  }
})

describe('findingsInWrite — 秘密の形は secretShapes の結果をそのまま写す', () => {
  it('種類・行・文字数・見本が揃う', () => {
    const f = findingsInWrite({ path: 'a.js', before: null, after: `x\nconst t = "${GH}"` })
    expect(f).toEqual([{ kind: 'known-key', line: 2, length: 40, sample: 'ghp_…' }])
  })
  it('危ない書き方には文字数も見本も付かない', () => {
    const f = findingsInWrite({ path: 'a.js', before: null, after: 'exec(`ls ${req.query.d}`)' })
    expect(f).toEqual([{ kind: 'input-to-command', line: 1 }])
  })
  it('秘密は拡張子によらず見る', () => {
    expect(kindsOf('notes.txt', `t = "${GH}"`)).toEqual(['known-key'])
  })
})

describe('findingsInWrite — 差分', () => {
  const line = `const t = "${GH}"`
  it('before に同じ行があれば出さない', () => {
    expect(findingsInWrite({ path: 'a.js', before: `x\n${line}\n`, after: `y\n${line}\nz` })).toEqual([])
  })
  it('空白だけ違っても出さない', () => {
    expect(findingsInWrite({ path: 'a.js', before: `    ${line}   `, after: `${line}` })).toEqual([])
  })
  it('字下げ・行末の空白が after 側にだけ付いても出さない', () => {
    expect(findingsInWrite({ path: 'a.js', before: line, after: `    ${line}  ` })).toEqual([])
  })
  it('CRLF と LF の違いだけでも出さない', () => {
    expect(findingsInWrite({ path: 'a.js', before: `x\n${line}\n`, after: `x\r\n${line}\r\n` })).toEqual([])
  })
  it('新しい行は出る', () => {
    const f = findingsInWrite({ path: 'a.js', before: 'const a = 1', after: `const a = 1\n${line}` })
    expect(f.map(x => x.line)).toEqual([2])
  })
  it('before が null（新しいファイル）なら全部が対象', () => {
    expect(findingsInWrite({ path: 'a.js', before: null, after: line })).toHaveLength(1)
  })
  it('before が空の文字列でも、新しい行は出る', () => {
    expect(findingsInWrite({ path: 'a.js', before: '', after: line })).toHaveLength(1)
  })
  it('危ない書き方にも差分を当てる', () => {
    const risky = 'exec(`ls ${req.query.dir}`)'
    expect(findingsInWrite({ path: 'a.js', before: risky, after: `// 新規\n${risky}` })).toEqual([])
    expect(findingsInWrite({ path: 'a.js', before: 'x', after: risky })).toHaveLength(1)
  })
  it('複数行の秘密鍵は BEGIN の行で比べる', () => {
    expect(findingsInWrite({ path: 'k.js', before: `const pem = \`\n${PEM}\n\``, after: `// 先頭に追加\nconst pem = \`\n${PEM}\n\`` })).toEqual([])
    expect(findingsInWrite({ path: 'k.js', before: 'x', after: PEM })).toHaveLength(1)
  })
})

describe('findingsInWrite — 行番号と並び・上限', () => {
  it('行の順に並び、行番号は 1 始まり', () => {
    const after = ['a', 'exec(`ls ${req.query.d}`)', `const t = "${GH}"`, 'el.innerHTML = location.hash'].join('\n')
    const f = findingsInWrite({ path: 'a.js', before: null, after })
    expect(f.map(x => [x.line, x.kind])).toEqual([[2, 'input-to-command'], [3, 'known-key'], [4, 'input-to-html']])
  })
  it('1ファイルの戻りは 200 件まで', () => {
    const after = Array.from({ length: 260 }, (_, i) => `el${i}.innerHTML = location.hash`).join('\n')
    const f = findingsInWrite({ path: 'a.js', before: null, after })
    expect(f).toHaveLength(200)
    expect(f[0].line).toBe(1)
    expect(f[199].line).toBe(200)
  })
})

describe('findingsInWrite — 値を出さない', () => {
  it('戻り値に見本のキーの本体が含まれない', () => {
    const out = JSON.stringify(findingsInWrite({ path: 'a.js', before: null, after: `const t = "${GH}"\nconst password = "hunter22222"\n${PEM}` }))
    expect(out).not.toContain(GH_BODY)
    expect(out).not.toContain('hunter22222')
    expect(out).not.toContain(PEM_BODY)
  })
})

describe('writeCheck.ts は秘密の判定を自前で持たない', () => {
  const src = readFileSync(join(__dirname, '..', 'src/shared/writeCheck.ts'), 'utf-8')
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  it('secretShapes から findSecretShapes を呼ぶ', () => {
    expect(code).toContain("import { findSecretShapes } from './secretShapes'")
    expect(code).toContain('findSecretShapes(after)')
  })
  it('import するのは secretShapes と型だけ', () => {
    const imports = code.split('\n').filter(l => /^import /.test(l))
    expect(imports).toEqual([
      "import { findSecretShapes } from './secretShapes'",
      "import { TEST_PATH_QUIET_KINDS, type WriteFinding } from './securityFindings'",
      "import { WRITE_CHECK_MAX_LINE_CHARS } from './writeCheckLimits'",
    ])
  })
  it('秘密の形の正規表現が現れない', () => {
    const rest = code.replace(/import[^\n]*secretShapes'/g, '').replace(/findSecretShapes/g, '')
    for (const re of [/ghp_/, /github_pat_/, /sk-ant/, /sk_live/, /PRIVATE KEY/, /password/i, /passwd/i, /secret/i, /BEGIN /, /AKIA/, /Bearer/])
      expect(rest).not.toMatch(re)
  })
  it('当て先が他の行に出ない（呼びは1か所だけ）', () => {
    expect(code.match(/findSecretShapes\(/g)).toHaveLength(1)
  })
})

describe('型', () => {
  it('WriteFinding の形', () => {
    const f: WriteFinding = { kind: 'input-to-path', line: 1 }
    expect(f.length).toBeUndefined()
  })
})
