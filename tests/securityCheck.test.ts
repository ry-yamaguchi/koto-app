import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { pickCheckTargets, checkpointsFor, splitIntoPieces, packBatches, pieceHeader, mergeCheckResults, reportParts, checkRecordKey, formatCheckRecord, DATA_FILE_RE, ASSET_FILE_RE, classifyUnchecked, capList, type BatchResult } from '../src/renderer/securityCheck'
import { buildAiCheckPrompt, type PromptPiece } from '../src/shared/aiCheckPrompt'
import { extractLastFindingsJson, parseAiReply } from '../src/shared/aiCheckReply'
import type { AiFinding } from '../src/shared/aiCheckFindings'

// 2026-08-09 の総点検で見つかった2件の回帰テスト。
// 公開前セキュリティチェックは「守り」のコードなのに、テストが1件も無かった（掟10）。

// ── 秘密ファイルの中身をAIへ送らない ────────────────────────────────────
// 以前は対象の正規表現が `.env` にマッチしており、**中身（APIキーやDBパスワード）が
// さくらのAI Engine へ送信されていた**。名前だけで公開NGと判定できるので、送る必要はない。
describe('チェックにかけるファイルの選び方', () => {
  it('秘密ファイルは中身を送らず、名前だけを指摘に回す', () => {
    const { targets, secretFiles } = pickCheckTargets(['index.html', '.env', '.env.production'])
    expect(targets).toEqual(['index.html'])
    expect(secretFiles).toContain('.env')
    expect(secretFiles).toContain('.env.production')
  })

  it('秘密鍵や証明書も中身を送らない', () => {
    const { targets, secretFiles } = pickCheckTargets(['app.js', 'id_rsa', 'server.pem'])
    expect(targets).toEqual(['app.js'])
    expect(secretFiles).toEqual(['id_rsa', 'server.pem'])
  })

  it('名前に credentials / secret を含むものも指摘する', () => {
    const { secretFiles } = pickCheckTargets(['credentials.json', 'my-secret.txt', 'index.html'])
    expect(secretFiles).toContain('credentials.json')
    expect(secretFiles).toContain('my-secret.txt')
  })

  it('Koto 自身のメタ情報は指摘しない（利用者の秘密ではない）', () => {
    const { secretFiles } = pickCheckTargets(['.sakuraide.json'])
    expect(secretFiles).toEqual([])
  })

  it('普通のコード・設定ファイルは中身を見る', () => {
    const { targets } = pickCheckTargets(['index.html', 'style.css', 'script.js', '.htaccess', 'config.yaml'])
    expect(targets).toContain('index.html')
    expect(targets).toContain('.htaccess')
    expect(targets).toContain('config.yaml')
  })

  // ── Koto が管理するビルド設定は検査しない（2026-08-21 rc.2 実機・Ryosuke 指摘）──
  // AI が「COPY . で Dockerfile 等が公開される」と指摘したが、それは Koto 自身の
  // 責任範囲で、そのまま配信される公開先には入れない（v0.3.38 で 404 を実測済み）。
  // 利用者には直せない・Koto の設計と矛盾する助言になるため、対象から外す。
  it('Koto が管理するビルド設定（Dockerfile / nginx.conf / .dockerignore）は対象外', () => {
    const { targets, secretFiles } = pickCheckTargets(['index.html', 'Dockerfile', 'nginx.conf', '.dockerignore'])
    expect(targets).toEqual(['index.html'])
    expect(secretFiles).toEqual([])
  })

  // 2026-08-21 Ryosuke 指摘: 8件で切ると、**9件目以降は何度押しても見られない**。
  // 量の調整は「分けて複数回」で行い、対象からは落とさない。
  it('件数では落とさない（20個あれば20個とも対象にする）', () => {
    const many = Array.from({ length: 20 }, (_, i) => `page${i}.html`)
    expect(pickCheckTargets(many).targets).toHaveLength(20)
  })

  it('画像やフォントは対象外', () => {
    const { targets } = pickCheckTargets(['logo.png', 'font.woff2', 'index.html'])
    expect(targets).toEqual(['index.html'])
  })

  // ── 対象外ファイルの3分類化（2026-09-03 Ryosuke 決定・案1）─────────────────
  // md/txt/svg はテキストなのでAIが読める。メモに個人情報・接続情報が書かれる
  // 実例があるため、対象外のままにしない。svg もXMLテキストでスクリプト混入が
  // ありうるので同様に読む。
  it('md・txt・svg はテキストとして中身を確認する（対象外にしない）', () => {
    const { targets } = pickCheckTargets(['README.md', 'メモ.txt', 'icon.svg', 'logo.png'])
    expect(targets).toEqual(['README.md', 'メモ.txt', 'icon.svg'])
    expect(targets).not.toContain('logo.png')
  })
})

const readSrc = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

// ── 名前だけで秘密と分かるものを、中身を送らずに扱う（名前の定義は looksSecretByName の1か所）──
// サービスアカウントの鍵（service-account.json など）は、以前は名前の判定に当たらず、
// 中身を読んで AI Engine へ送っていた。ロックファイルは読んでも指摘が出ず、枠を食うだけなので送らない。
describe('名前だけで秘密と分かるもの・ロックファイルの扱い', () => {
  it('★ サービスアカウントの鍵は、中身を送らず名前だけを指摘に回す', () => {
    const files = ['index.html', 'service-account.json', 'serviceAccountKey.json', 'firebase/firebase-service-account.json', 'service_account_prod.json']
    const { targets, secretFiles } = pickCheckTargets(files)
    expect(targets).toEqual(['index.html'])
    expect(secretFiles).toEqual(['service-account.json', 'serviceAccountKey.json', 'firebase/firebase-service-account.json', 'service_account_prod.json'])
  })

  it('★ 入口ファイルの名前が秘密らしくても、対象に戻さない（入口は先頭に置くだけで、名前の判定は先）', () => {
    const { targets, secretFiles } = pickCheckTargets(['index.html', 'credentials.js', 'service-account.json'], 'credentials.js')
    expect(targets).toEqual(['index.html'])
    expect(secretFiles).toEqual(['credentials.js', 'service-account.json'])
  })

  it('通す例: サービスアカウントの話をしているだけの文書・普通の設定は、中身を見る', () => {
    const { targets, secretFiles } = pickCheckTargets(['docs/service-accounts.md', 'accounts.json', 'service.json', 'config.json'])
    expect(targets).toEqual(['docs/service-accounts.md', 'accounts.json', 'service.json', 'config.json'])
    expect(secretFiles).toEqual([])
  })

  it('★ 依存の一覧（ロックファイル）は対象から外す。入口の指定があっても対象に戻らない', () => {
    const files = ['index.html', 'package.json', 'package-lock.json', 'sub/package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'server.js']
    const { targets, secretFiles } = pickCheckTargets(files, 'server.js')
    expect(targets).toEqual(['server.js', 'index.html', 'package.json'])
    // 秘密ではないので、名前だけの指摘にも回さない
    expect(secretFiles).toEqual([])
  })

  it('通す例: 名前がロックファイルに似ているだけのものは、対象から外さない', () => {
    const { targets } = pickCheckTargets(['package.json', 'my-package-lock.json', 'lock.json', 'locks.yaml', 'package-lock.json.md'])
    expect(targets).toEqual(['package.json', 'my-package-lock.json', 'lock.json', 'locks.yaml', 'package-lock.json.md'])
  })

  it('ロックファイルは、対象から外れても存在は others の名前に残る（黙って落とさない）', () => {
    const files = ['index.html', 'package-lock.json', 'pnpm-lock.yaml']
    const { targets, secretFiles } = pickCheckTargets(files)
    expect(classifyUnchecked(files, targets, secretFiles).others).toEqual(['package-lock.json', 'pnpm-lock.yaml'])
  })

  it('名前の判定は publishExclude.ts の looksSecretByName を呼ぶ（手元に正規表現を持たない）', () => {
    const s = readSrc('src/renderer/securityCheck.ts')
    expect(s).toContain("import { looksSecretByName } from '../shared/publishExclude'")
    // 公開される秘密らしい名前の判定（looksSecretButPublished）は、合成の側が唯一の定義を呼ぶ
    const merge = readSrc('src/renderer/aiCheckMerge.ts')
    expect(merge).toContain("import { looksSecretButPublished } from '../shared/publishExclude'")
    expect(merge).toContain('return secretFiles.filter(looksSecretButPublished)')
    expect(s).toContain("const secretFiles = files.filter(f => looksSecretByName(f) && f !== '.sakuraide.json')")
    expect(s).toContain('let targets = files.filter(f => TARGET_RE.test(f) && !looksSecretByName(f) && !LOCKFILE_RE.test(f) && !isKotoBuildConfig(f))')
    expect(s).toContain('if (entry && files.includes(entry) && !looksSecretByName(entry)) {')
    // 直す前の形（手元の定義）に戻っていない
    expect(s).not.toContain('SECRET_HINT_RE')
    expect(s).not.toContain('function looksSecret(')
    expect(s).not.toContain('looksSecret(f)')
    expect(s).not.toContain('isSecretFile')
  })
})

// ── 外へ送る前の伏せ字（かたまりを作る splitIntoPieces が唯一の関所）───────────
// 送る本文の振る舞い（偽の sakura.chat に流す）は tests/securityCheckMask.test.ts。
// ここは、純関数の単位と、配線の形を固定する。
describe('かたまりを作る前に、秘密に見える値を伏せる', () => {
  const TOKEN = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
  const PEM_HEAD = '-----BEGIN RSA ' + 'PRIVATE KEY-----'
  const PEM_TAIL = '-----END RSA ' + 'PRIVATE KEY-----'

  it('★ かたまりの本文に、秘密の値は残らない（行数は保つ）', () => {
    const content = ['const a = 1', `const t = "${TOKEN}"`, 'const DB_PASSWORD = "Zk3p9Qw7Xv5Nm2"', 'const b = 2'].join('\n')
    const [piece] = splitIntoPieces('server.js', content)
    expect(piece.text).not.toContain(TOKEN)
    expect(piece.text).not.toContain('Zk3p9Qw7Xv5Nm2')
    expect(piece.text).toContain('const DB_PASSWORD = "***"')
    expect(piece.text.split('\n')).toHaveLength(4)
    expect(piece.text).toContain('const b = 2')
  })

  it('★ 分けるより前に伏せる: かたまりの境目をまたぐ秘密鍵も、本体が残らない', () => {
    const body = Array.from({ length: 6 }, (_, i) => `Qw${i}Zk9Xv7Lm3Kp5Wr${i}Yu2Tn8Bc4`).join('\n')
    const content = ['x'.repeat(40), PEM_HEAD, body, PEM_TAIL, 'y'.repeat(40)].join('\n')
    // 小さな上限で分ける。伏せる前の本文では、BEGIN と END が別々のかたまりに入る長さにする
    const chunk = 100
    expect(content.indexOf(PEM_HEAD)).toBeLessThan(chunk)
    expect(content.indexOf(PEM_TAIL)).toBeGreaterThan(chunk)
    const text = splitIntoPieces('k.js', content, chunk).map(p => p.text).join('')
    for (const line of body.split('\n')) expect(text, line).not.toContain(line)
    expect(text).not.toContain(PEM_HEAD)
    expect(text).toContain('y'.repeat(40))
  })

  it('通す例: 秘密に見えない普通のコードは、1文字も変わらない', () => {
    const content = ['const express = require("express")', 'const port = process.env.PORT || 3000', 'const password = process.env.DB_PASSWORD', 'const name = "太郎"'].join('\n')
    expect(splitIntoPieces('a.js', content).map(p => p.text).join('')).toBe(content)
  })

  it('配線: 伏せる呼びが splitIntoPieces にあり、素の本文のまま分ける形に戻っていない', () => {
    const s = readSrc('src/renderer/securityCheck.ts')
    expect(s).toContain("import { maskSecretShapes } from '../shared/secretShapes'")
    expect(s).toContain('let rest = maskSecretShapes(content)')
    expect(s).not.toContain('let rest = content')
    // 本番の呼び出しは、読んだ中身をそのまま splitIntoPieces へ渡す（かたまりを作る道はこの1つ）
    expect(s).toContain("if (r.state === 'text') pieces.push(...splitIntoPieces(f, r.content))")
    expect((s.match(/splitIntoPieces\(/g) ?? []).length).toBe(2) // 定義1・呼び出し1
  })
})

describe('伏せ字を AI に伝える一文', () => {
  const base = { mode: 'node' as const, entry: 'server.js', split: false, secretFiles: [] as string[], others: [] as string[] }
  const piece = (): PromptPiece => ({ file: 'server.js', part: 1, total: 1, startLine: 1, text: 'const k = "***"' })

  it('本文があるとき、*** の意味を伝える。本物の秘密とは限らないことも添える', () => {
    const p = buildAiCheckPrompt({ ...base, pieces: [piece()] })
    expect(p).toContain('*** に置き換えてお渡ししています')
    expect(p).toContain('*** の所に本物の秘密が書かれていたとは限りません')
    expect(p).toContain('本物の秘密の直書きに見えるものだけを指摘してください')
    // 直す前の言い方（*** の右側は全部、固定の秘密の値）に戻っていない
    expect(p).not.toContain('固定の値が書かれていました')
    expect(p).not.toContain('秘密の直書きとして指摘してください')
  })

  it('本文が無い（名前だけを渡す）ときは、言わない', () => {
    const p = buildAiCheckPrompt({ ...base, secretFiles: ['.env'], pieces: [] })
    expect(p).not.toContain('*** に置き換えて')
  })
})

describe('依頼文に載せる秘密らしい名前の数（毎回の要求に入るので上限がある）', () => {
  const base = { mode: 'static' as const, entry: null, split: false, secretFiles: [] as string[], others: [] as string[], pieces: [] as PromptPiece[] }
  const names = (n: number) => Array.from({ length: n }, (_, i) => `secrets/s${i}.txt`)

  it('★ 20件までは全部載せる。21件目以降は「ほかN件」にまとめる（件数は残る）', () => {
    const exact = buildAiCheckPrompt({ ...base, secretFiles: names(20) })
    expect(exact).toContain('secrets/s19.txt')
    expect(exact).not.toContain('ほか')
    const none = buildAiCheckPrompt(base)
    const many = buildAiCheckPrompt({ ...base, secretFiles: names(2000) })
    const line = many.split('\n').find(l => l.startsWith('※ 次のファイルは名前からして公開NGの可能性が高い'))!
    expect(line).toContain('secrets/s0.txt')
    expect(line).toContain('secrets/s19.txt')
    expect(line).toContain('ほか1980件')
    expect(line).not.toContain('secrets/s20.txt')
    // 名前の数が増えても、依頼文は増えない（2000件ぶんの名前が載れば3万字を超える）
    expect(many.length - none.length).toBeLessThan(2000)
  })

  it('対照: 少なければそのまま（「ほか0件」のような注記は付けない）', () => {
    const p = buildAiCheckPrompt({ ...base, secretFiles: ['credentials.json', 'service-account.json'] })
    expect(p).toContain('名前からして公開NGの可能性が高い: credentials.json, service-account.json\n')
    expect(p).not.toContain('ほか')
  })
})

// ── 対象外ファイルの「素通り」をふさぐ（roadmap #17・2026-09-03 Ryosuke 発見・案2）───
// pickCheckTargets の対象外（txt/csv/sql/db/bak/log/zip/py 等）は、公開されるのに検査もされず
// 「確認していない」ことすら報告されていなかった（実測: customers.csv・dump.sql・app.db・
// backup.zip・server.py が完全素通り）。ここではその仕分けを固定する。
describe('DATA_FILE_RE（公開先で丸見えになると危険度が高い拡張子の一元定義）', () => {
  it('止める例: データベースの書き出し・バックアップ・残骸っぽい拡張子は対象にする', () => {
    for (const f of ['dump.sql', 'backup.zip', 'site.bak', 'app.db', 'export.csv', 'data.tsv', 'app.sqlite3', 'access.log', 'archive.tar.gz', 'index.html~', 'config.js.orig']) {
      expect(DATA_FILE_RE.test(f)).toBe(true)
    }
  })

  // 止めすぎると狼少年になる（CLAUDE.md 掟10）。README.md やメモを毎回警告しない。
  it('通す例: md/txt/py 等は対象にしない（止めすぎない）', () => {
    for (const f of ['README.md', 'メモ.txt', 'server.py', 'index.html', 'app.js']) {
      expect(DATA_FILE_RE.test(f)).toBe(false)
    }
  })
})

describe('classifyUnchecked（検査対象・secretFiles の残りを dataLike / assets / others に仕分ける）', () => {
  it('データっぽい拡張子は dataLike に入る（実測で完全素通りしていたもの）', () => {
    const files = ['dump.sql', 'backup.zip', 'site.bak', 'index.html']
    const { targets } = pickCheckTargets(files)
    const { dataLike } = classifyUnchecked(files, targets, [])
    expect(dataLike).toEqual(['dump.sql', 'backup.zip', 'site.bak'])
  })

  // 2026-09-03 3分類化: md/txt は TARGET_RE 側で中身を読むようになったため、
  // others に残るのは拡張子から判定できない・資産でもないファイルだけになる。
  it('データっぽくも資産でもない対象外ファイルは others に入る（md/txt は targets へ移動済み）', () => {
    const files = ['test001', 'server.py', 'index.html']
    const { targets } = pickCheckTargets(files)
    const { others } = classifyUnchecked(files, targets, [])
    expect(others).toEqual(['test001', 'server.py'])
  })

  it('検査対象（targets）はどちらにも入らない', () => {
    const files = ['index.html', 'app.js', 'dump.sql', 'server.py']
    const { targets } = pickCheckTargets(files)
    const { dataLike, others } = classifyUnchecked(files, targets, [])
    expect(dataLike).not.toContain('index.html')
    expect(dataLike).not.toContain('app.js')
    expect(others).not.toContain('index.html')
    expect(others).not.toContain('app.js')
  })

  it('secretFiles（.env 等）はどちらにも入らない（二重に指摘しない）', () => {
    const files = ['.env', 'index.html']
    const { targets, secretFiles } = pickCheckTargets(files)
    const { dataLike, others } = classifyUnchecked(files, targets, secretFiles)
    expect(dataLike).not.toContain('.env')
    expect(others).not.toContain('.env')
  })

  it('Koto のビルド設定（Dockerfile 等）は対象外（targets と同じ理由。利用者には直せない）', () => {
    const files = ['Dockerfile', 'nginx.conf', '.dockerignore', 'index.html']
    const { targets, secretFiles } = pickCheckTargets(files)
    const { dataLike, others } = classifyUnchecked(files, targets, secretFiles)
    expect(dataLike).toEqual([])
    expect(others).toEqual([])
  })

  // ── 3分類の追加テスト（2026-09-03 Ryosuke 決定・案1）───────────────────────
  it('画像・フォント・音声・動画は assets に入る（名指ししない「表示用の資産」）', () => {
    const files = ['logo.png', 'photo.jpg', 'font.woff2', 'font2.ttf', 'movie.mp4', 'audio.mp3', 'index.html']
    const { targets } = pickCheckTargets(files)
    const { assets, dataLike, others } = classifyUnchecked(files, targets, [])
    expect(assets).toEqual(['logo.png', 'photo.jpg', 'font.woff2', 'font2.ttf', 'movie.mp4', 'audio.mp3'])
    expect(dataLike).toEqual([])
    expect(others).toEqual([])
  })

  it('データっぽい拡張子は assets ではなく dataLike のまま（DATA_FILE_RE が先勝ち）', () => {
    const files = ['dump.sql', 'backup.csv', 'index.html']
    const { targets } = pickCheckTargets(files)
    const { dataLike, assets } = classifyUnchecked(files, targets, [])
    expect(dataLike).toEqual(['dump.sql', 'backup.csv'])
    expect(assets).toEqual([])
  })

  it('残骸っぽい名前・拡張子なし・pdf は others に入る（assets ではない）', () => {
    const files = ['test001', 'notes.pdf', 'index.html']
    const { targets } = pickCheckTargets(files)
    const { others, assets } = classifyUnchecked(files, targets, [])
    expect(others).toEqual(['test001', 'notes.pdf'])
    expect(assets).toEqual([])
  })

  it('svg・md・txt はどの分類にも入らず targets に入る（テキストなのでAIが読む）', () => {
    const files = ['icon.svg', 'README.md', 'メモ.txt', 'index.html']
    const { targets } = pickCheckTargets(files)
    expect(targets).toEqual(['icon.svg', 'README.md', 'メモ.txt', 'index.html'])
    const { dataLike, assets, others } = classifyUnchecked(files, targets, [])
    expect(dataLike).toEqual([])
    expect(assets).toEqual([])
    expect(others).toEqual([])
  })
})

// ── ASSET_FILE_RE（表示用の資産ファイルの一元定義。2026-09-03 案1）─────────
describe('ASSET_FILE_RE（表示用の資産ファイルの一元定義）', () => {
  it('止める例（＝資産と認識する）: 画像・フォント・音声・動画', () => {
    for (const f of [
      'logo.png', 'photo.jpeg', 'photo.jpg', 'anim.gif', 'pic.webp', 'a.avif', 'favicon.ico', 'x.bmp', 'y.tiff', 'z.tif',
      'font.woff', 'font.woff2', 'font.ttf', 'font.otf', 'font.eot',
      'song.mp3', 'audio.wav', 'audio.ogg', 'audio.m4a', 'movie.mp4', 'clip.webm', 'clip.mov', 'clip.avi',
    ]) {
      expect(ASSET_FILE_RE.test(f)).toBe(true)
    }
  })

  // svg・pdf は資産扱いにしない（svg は中身を読む＝targets、pdf は名前だけ判定＝others）
  it('通す例（＝資産ではない）: svg・pdf・コード・データファイル', () => {
    for (const f of ['icon.svg', 'doc.pdf', 'index.html', 'dump.sql', 'README.md']) {
      expect(ASSET_FILE_RE.test(f)).toBe(false)
    }
  })
})

// ── 名前一覧の肥大防止（roadmap #17 追補・2026-09-03）──────────────────────
// projectFilesInfo の上限を 200 → 5,000 に緩和したため、dataLike・others をそのまま
// 依頼文・報告文へ埋め込むと文言が際限なく膨らむ。件数そのものでは絞らず（黙って落とさない）、
// 表示件数だけを capList で抑え、超過分は「ほかN件」で必ず件数を残す。
describe('capList（名前一覧の肥大防止）', () => {
  it('上限以下ならそのまま（「ほか」は付けない）', () => {
    expect(capList(['a', 'b', 'c'], 5)).toEqual(['a', 'b', 'c'])
  })

  it('ちょうど上限なら「ほか」を付けない（境界値）', () => {
    expect(capList(['a', 'b'], 2)).toEqual(['a', 'b'])
  })

  it('超過分は「ほかN件」の1行にまとめる', () => {
    const names = Array.from({ length: 10 }, (_, i) => `f${i}.txt`)
    expect(capList(names, 3)).toEqual(['f0.txt', 'f1.txt', 'f2.txt', 'ほか7件'])
  })

  it('空配列は空配列のまま', () => {
    expect(capList([], 10)).toEqual([])
  })
})

// ── 判定は「要確認」を優先する ──────────────────────────────────────────
// 以前は1行目に「問題なし」が含まれるかだけを見ており、「判定: 要確認（一部は問題なし）」のような
// 書き方をされると ok になっていた。いまは AI の文を判定に使わない。判定は、指摘（重さ）・読めなかった回・
// 読み取れなかった指摘から Koto が決める（回ごとの表は tests/aiCheckMerge.test.ts）。
describe('AIの回答から判定を決める（合成 mergeCheckResults）', () => {
  const info = { files: 2, batches: 1, skipped: [] as string[], partial: [] as string[] }
  const noteOnly = aiF({ kind: 'other', severity: 'note', file: 'z.html', line: 9, note: '補足です' })

  it('指摘が無ければ ok（「念のため」だけでも ok）', () => {
    expect(mergeCheckResults([okR()], info).verdict).toBe('ok')
    expect(mergeCheckResults([okR([noteOnly])], info).verdict).toBe('ok')
  })

  it('重さが now・should の指摘があれば warn', () => {
    expect(mergeCheckResults([okR([nowF('index.html', 3)])], info).verdict).toBe('warn')
    expect(mergeCheckResults([okR([aiF()])], info).verdict).toBe('warn')
  })

  // ここが実害だった。両方の語が入っていたら警告側に倒す。いまは、AI の説明に「問題なし」と書かれていても、
  // 指摘があれば警告のまま（AI の文は判定に使わない）
  it('指摘の説明に「問題なし」と書かれていても warn（安全側に倒す）', () => {
    const m = mergeCheckResults([okR([aiF({ note: '問題なし、ただし要確認の点あり' })])], info)
    expect(m.verdict).toBe('warn')
    expect(m.report.split('\n')[0]).toBe('判定: 要確認')
  })

  it('形式に従わない返事（読み取れない回）は ok にしない（全部がそうなら skip・混ざれば warn）', () => {
    expect(mergeCheckResults([failR(['a.html'])], info).verdict).toBe('skip')
    expect(mergeCheckResults([okR(), failR(['b.html'])], info).verdict).toBe('warn')
  })

  it('1回目が問題なしでも、あとの回の指摘で warn（順序によらない）', () => {
    expect(mergeCheckResults([okR(), okR([nowF('b.js', 2)])], info).verdict).toBe('warn')
    expect(mergeCheckResults([okR([nowF('b.js', 2)]), okR()], info).verdict).toBe('warn')
  })
})

// ── サイトとアプリで観点を変える（2026-08-21 Ryosuke 提案）────────────────
// 静的サイトの危険は「露出」、アプリの危険は「入力の悪用」。的外れな指摘は
// 利用者を混乱させるので、アプリ専用の観点をサイトに混ぜないことも固定する。
describe('検査の観点は種別で変わる', () => {
  it('共通: 秘密の直書き・混入・XSS はどちらの種別でも見る', () => {
    for (const mode of ['static', 'node'] as const) {
      const all = checkpointsFor(mode).join('\n')
      expect(all).toContain('秘密情報の直書き')
      expect(all).toContain('個人情報の混入')
      expect(all).toContain('XSS')
    }
  })

  it('サイト: 送信先・読み込み元を見る。アプリ専用の観点は混ぜない', () => {
    const all = checkpointsFor('static').join('\n')
    expect(all).toContain('フォームの送信先')
    expect(all).not.toContain('命令の混入')
    expect(all).not.toContain('認証')
    expect(all).not.toContain('スタックトレース')
  })

  it('アプリ: 入力の悪用・認証の無い操作・エラーの漏れを見る', () => {
    const all = checkpointsFor('node').join('\n')
    expect(all).toContain('命令の混入')
    expect(all).toContain('パス遡り')
    expect(all).toContain('認証')
    expect(all).toContain('スタックトレース')
  })
})

describe('AIへの依頼文', () => {
  const base = { mode: 'static' as const, entry: null as string | null, split: false, secretFiles: [] as string[], others: [] as string[], pieces: [] as PromptPiece[] }

  it('アプリなら、サーバーで実行されると明言し、入口ファイル名を伝える', () => {
    const p = buildAiCheckPrompt({ ...base, mode: 'node', entry: 'server.js', pieces: [{ file: 'server.js', part: 1, total: 1, startLine: 1, text: 'const http = ...' }] })
    expect(p).toContain('サーバーで実行される')
    expect(p).toContain('入口は server.js')
    expect(p).toContain('命令の混入')
  })

  it('サイトなら、そのまま配信されると明言し、アプリ専用の観点は入れない', () => {
    const p = buildAiCheckPrompt(base)
    expect(p).toContain('そのまま配信される')
    expect(p).not.toContain('命令の混入')
  })

  it('秘密ファイルは名前だけを伝える行に載る', () => {
    const p = buildAiCheckPrompt({ ...base, secretFiles: ['.env'] })
    expect(p).toContain('公開NGの可能性が高い: .env')
  })

  it('出力形式（JSON の形・種類の一覧・JSON 以外を書かせない）を必ず要求する', () => {
    const p = buildAiCheckPrompt({ ...base, mode: 'node', entry: 'a.js' })
    expect(p).toContain('{"findings":[{"file":"ファイル名","line":行番号,"kind":"種類","quote":"その行の中身","note":"何が問題かを1文で"}]}')
    expect(p).toContain('- kind は次のどれか1つ')
    expect(p).toContain('JSON 以外の文章（思考の経過・英語のメモ）は書かない')
    // 直す前の形（1行目の「判定」）を要求していない
    expect(p).not.toContain('判定: 問題なし')
    expect(p).not.toContain('判定: 要確認')
    expect(p).not.toContain('報告以外の文章')
  })

  // ── others（対象外・データ系でもないファイル名）の名前だけ判定（roadmap #17・案2）───
  it('others の名前を伝え、名前だけで疑いがあるものだけ指摘するよう指示する', () => {
    const p = buildAiCheckPrompt({ ...base, others: ['server.py', 'メモ.txt'] })
    expect(p).toContain('server.py, メモ.txt')
    expect(p).toContain('名前から個人情報・秘密・残骸')
    expect(p).toContain('中身は見なくてよい')
  })

  // 中身は絶対に送らない（2026-08-09 の .env 事故の原則）。others に渡すのは名前一覧だけ
  // ── pieces（実際のファイル内容）を空にしても、others の名前は独立に依頼文へ載る。
  it('others に渡すのは名前一覧だけ（pieces が空でも名前は載る＝中身に依存しない）', () => {
    const p = buildAiCheckPrompt({ ...base, others: ['customers.csv'] })
    expect(p).toContain('customers.csv')
    expect(buildAiCheckPrompt(base)).not.toContain('customers.csv')
  })

  it('others が無ければ、その案内は入れない', () => {
    const p = buildAiCheckPrompt(base)
    expect(p).not.toContain('名前から個人情報・秘密・残骸')
  })

  // ── 名前一覧の肥大防止（roadmap #17 追補）: others は capList(80) を通す ─────────
  it('others が80件を超えたら、依頼文では81件目以降を「ほかN件」にまとめる', () => {
    const others = Array.from({ length: 90 }, (_, i) => `f${i}.txt`)
    const p = buildAiCheckPrompt({ ...base, others })
    expect(p).toContain('ほか10件')
    expect(p).not.toContain('f89.txt') // 81件目以降は個別には出さない
    expect(p).toContain('f79.txt') // 80件目までは出す
  })
})

describe('アプリの入口ファイルの扱い', () => {
  it('入口は必ず先頭で検査する（サーバーコードこそ本丸）', () => {
    const many = Array.from({ length: 20 }, (_, i) => `page${i}.html`)
    const { targets } = pickCheckTargets([...many, 'server.js'], 'server.js')
    expect(targets[0]).toBe('server.js')
    expect(targets).toHaveLength(21)
  })

  it('入口の指定があっても、実在しなければ足さない', () => {
    const { targets } = pickCheckTargets(['index.html'], 'server.js')
    expect(targets).toEqual(['index.html'])
  })

  it('入口の指定が無ければ従来どおり', () => {
    expect(pickCheckTargets(['index.html']).targets).toEqual(['index.html'])
  })
})

// ── 配線（ソースを読んで固定）──────────────────────────────────────────
// electron に依存するファイルは import できないため、ソースを読んで確かめる
// （publishRootWiring.test.ts と同じ流儀）。当て先は呼び出しの形ごと一意に指す（掟10）。
describe('セキュリティチェックの配線', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

  it('🛡 節（SecurityCheckSection）は共通実装 runSecurityCheck を呼び、修正は fix-with-ai へ送る', () => {
    const s = read('src/renderer/components/SecurityCheckSection.tsx')
    // 送る口は流れ（securityCheckFlow.ts）の1か所で呼び、中断の受け口と実況を必ず渡す
    const flow = read('src/renderer/securityCheckFlow.ts')
    expect(flow).toContain('await a.deps.runSecurityCheck(started, a.apiKey, a.on.progress, a.on.abortReady)')
    expect(s).toContain('abortReady: (abort) => { abortRef.current = abort },')
    expect(s).toContain('progress: setProgress,')
    // 直す前の3引数の形（＝中断の受け口を渡していない形）が戻ってきたら落ちる
    expect(flow).not.toContain('runSecurityCheck(started, a.apiKey, a.on.progress)')
    // 送る文は buildSecurityFixPrompt の1か所で組む（指摘のファイル・行・種類だけから作る。AI の文・報告は入れない）。
    // 呼び出しの形ごと一意に指し、報告を渡す直す前の形が戻ってきたら落ちる
    expect(s).toContain('const fixPrompt = buildSecurityFixPrompt(mergeFixItems(scan?.fixItems ?? [], fixItemsOf(result?.findings ?? [])))')
    expect(s).toContain("window.dispatchEvent(new CustomEvent('sakura:fix-with-ai', { detail: { text: fixPrompt } }))")
    expect(s).toContain('{fixPrompt !== null && !checking && (')
    expect(s).not.toContain('buildFixPrompt')
    expect(s).not.toContain('detail: { text: result.report }')
    expect(s).not.toContain('${result.report}')
    expect(s).not.toContain('実際に修正して解消してください')
    // 実体を持たない（独自のプロンプトや判定を書かない）
    expect(s).not.toContain('sakura.chat')
  })

  // 2026-09-04 Ryosuke 指摘A: 公開画面は番号付きの手順で並んでいるのに、この節だけ
  // 無番号で浮いて見える。番号体系を持つ3画面（AppRun・HANAMII・Vercel）は stepNo を
  // 渡し、番号体系の無い PublishModal（公開先選択）は渡さない（現状維持）。
  // 呼び出しの形ごと一意に指す（掟10: 「どこかにある」だけでは直し忘れを捕まえられない）。
  // 公開先ごとの 🛡 節の置き場所は tests/securityPlacementTable.test.ts（表は tests/securityPlacements.ts）。

  it('公開時に自動では走らせない（2026-08-21 Ryosuke 指定。入口は手動の 🛡 節だけ）', () => {
    expect(read('src/renderer/components/PublishModal.tsx')).not.toContain('runSecurityCheck(')
  })

  it('🛡 節は「簡易」を名乗り、自動実行をうたわない', () => {
    const s = read('src/renderer/components/SecurityCheckSection.tsx')
    expect(s).toContain('簡易セキュリティチェック')
    expect(s).toContain('最終的にはご自身で確認してください')
    expect(s).not.toContain('自動で走ります')
  })

  // 2026-08-21 Ryosuke 指摘: 免責が結果の中にしか無く、**押す前には見えなかった**。
  // 「結果が出る前から読める」ことまで固定する（文字列の存在だけでは足りない）。
  it('免責は、結果を待たずに読める位置にある（説明文の側）', () => {
    const s = read('src/renderer/components/SecurityCheckSection.tsx')
    const disclaimer = s.indexOf('最終的にはご自身で確認してください')
    const resultBlock = s.indexOf('{result && (')
    expect(disclaimer).toBeGreaterThan(-1)
    expect(resultBlock).toBeGreaterThan(-1)
    expect(disclaimer).toBeLessThan(resultBlock)
  })

  // ── 中止の導線（2026-09-25 検分の指摘6 の残り・S6）────────────────────────
  // 受け口（onAbortReady）と、押されたときに本当に止まる振る舞いは
  // tests/securityCheckStop.test.ts が偽 client で固定してある（出た要求の一覧と順序）。
  // ここで守るのは**その手前**——画面に押すところが実在すること。
  // 押せない中断は無いのと同じで、直す前は onAbortReady の本番の呼び出し元が0件だった。
  // .tsx は DOM 無しでは描けないので、当て先を**呼び出しの形ごと一意に**指す（掟10）。
  it('★ 確認中は「中止する」を画面に出し、受け取った中断関数を呼ぶ', () => {
    const s = read('src/renderer/components/SecurityCheckSection.tsx')

    // (1) 押したときの動きが、受け取った中断関数を実際に呼ぶ形であること
    expect(s).toContain('function stop() {')
    expect(s).toContain('abortRef.current?.()')

    // (2) ボタンが stop に繋がっていること（別の関数へ繋ぎ替わったら落ちる）
    const btn = s.indexOf('onClick={stop}')
    expect(btn).toBeGreaterThan(-1)
    // (3) そのボタンは「AI の確認が走っている間だけ」出す条件の中に居る（点検の間・押せない時に出さない）
    const guard = s.lastIndexOf('{aiRunning && mine && (', btn)
    expect(guard).toBeGreaterThan(-1)
    expect(s.slice(guard, btn)).not.toContain('</button>') // 別のボタンを挟んでいない
    // (4) 文言は素のテキスト・日本語（掟5）。利用者が「中止」と読める語であること
    const label = s.slice(btn, s.indexOf('</button>', btn))
    expect(label).toContain('中止する')
    expect(label).toContain('中止しています…')

    // (5) 中断関数を useState で持たない。useState は関数を「更新関数」と解釈して
    //    **その場で呼ぶ**ので、押していないのに中止が走る（いちばん見つけにくい形）
    expect(s).toContain('const abortRef = useRef<(() => void) | null>(null)')
    expect(s).not.toContain('setAbort(abort)')
  })

  it('★ 中止した本人に「失敗しました」と読めるものを見せない', () => {
    const s = read('src/renderer/components/SecurityCheckSection.tsx')
    // 押したことを覚えておき、結果の見出しを中止用に切り替えている
    expect(s).toContain("{result.verdict === 'warn' ? '⚠️ 要確認' : aborted ? '⏹ 中止しました' : '⏭ 実施できませんでした'}")
    expect(s).not.toContain('チェックに失敗しました')
    // 途中までを「確認した」ことにしない、と画面にも書いてある
    expect(s).toContain('途中までの結果は「確認した」ことにはしません')
  })

  it('ビルド設定の除外は一元定義（BUILD_CONFIG_FILES）を呼び出しの形ごと使う', () => {
    const s = read('src/shared/publishScanTargets.ts')
    // 名簿の丸ごと利用を、式の形ごと一意に指す（手書きの配列に替わったら落ちる）
    expect(s).toContain('(BUILD_CONFIG_FILES as readonly string[]).includes(base)')
  })

  it('PublishModal は各パネルへAPIキーを渡している', () => {
    const s = read('src/renderer/components/PublishModal.tsx')
    for (const name of ['AppRunPanel', 'VercelPanel', 'HanamiiPanel']) {
      // AppRunPanel には、そのタブが目の前に出ているか（visible）も渡す（2026-09-30）ので、閉じ括弧までは見ない
      expect(s).toContain(`<${name} projectDir={projectDir} apiKey={apiKey} onOpenCredentials={onOpenCredentials}`)
    }
  })

  it('推論対策: 上限4096・目印方式・実況が実装に居る', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s).toContain('maxTokens: 4096')
    expect(s).toContain('const parsed = parseAiReply(raw, { pieces: sentPieces, names: sentNames })')
    // 旧い目印方式（「判定:」の読み取り）が戻っていない
    expect(s).not.toContain('extractCheckReport(')
    expect(s).not.toContain('judgeVerdict(')
    // 実測で1分を超えることがある。短く言い切らない（2026-08-21 rc.3 実機）
    expect(s).toContain('少々時間がかかります')
    expect(s).not.toContain('30秒ほどかかります')
    // 生の応答をそのまま判定・表示に回さない（rc.1 の再発防止）
    expect(s).not.toContain('judgeVerdict(raw)')
    expect(s).not.toContain('buildCheckPrompt(')
  })

  it('全ファイル・全文を分けて確認し、結果をまとめている', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s).toContain('pieces.push(...splitIntoPieces(f, r.content))')
    expect(s).toContain('const { batches, skipped, partial } = packBatches(orderPiecesForPacking(pieces, entry))')
    expect(s).toContain('const merged = mergeCheckResults(results, {')
    // 計画（読むだけ）と実行（送る）が分かれ、runSecurityCheck は両方を通る
    expect(s).toContain('export async function planAiCheck(')
    expect(s).toContain('export async function runAiCheck(')
    expect(s).toContain('const plan = await planAiCheck(projectDir, onProgress)')
  })

  // 2026-08-21 Ryosuke 指定: 利用量の歯止めは全体予算のブロックに一本化する。
  // この機能だけが回ごとに独自の判断を持つと、止まる条件が場所ごとに変わる。
  it('利用量の歯止めは全体予算のブロックだけ（開始時の1回。回ごとに独自判断しない）', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s.match(/checkBeforeRequest\(/g) ?? []).toHaveLength(1)
    expect(s).toContain('const budget = checkBeforeRequest(apiKey)')
    // 呼び元は aiCheckBudget(apiKey) だけ（checkBeforeRequest を直に呼ぶ口を増やさない）
    expect(s).toContain('export function aiCheckBudget(apiKey: string) {')
    expect(s.match(/const budget = aiCheckBudget\(apiKey\)/g) ?? []).toHaveLength(2)
  })

  it('★ AI を呼ぶ口（sakura.chat の呼び出し）は、コメントを除いて securityCheck.ts の1か所だけ', () => {
    const code = read('src/renderer/securityCheck.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
    expect(code.match(/sakura\.chat\(/g) ?? []).toHaveLength(1)
  })

  it('種別の見分けは runtimeDetect に一元化（独自に package.json を解釈しない）', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s).toContain('detectRuntime({ packageJson, fileNames: files.filter(f => !f.includes(')
    expect(s).not.toContain('scripts.start') // 入口の推定ロジックを複製しない
  })

  // ── 対象外ファイルの「素通り」対策の配線（roadmap #17・案2）─────────────────
  it('IPCの3点セット（fs:projectFilesInfo）が揃っている（掟6）', () => {
    const main = read('src/main/ipc/fs.ts')
    const preload = read('src/main/preload.ts')
    const dts = read('src/renderer/global.d.ts')
    expect(main).toContain("ipcMain.handle('fs:projectFilesInfo', async (_, dir: string, opts?: { maxFiles?: number; publishView?: boolean }) =>")
    expect(main).toContain('projectFilesInfoFs(dir, opts))')
    expect(preload).toContain('projectFilesInfo: (dir: string, opts?: { maxFiles?: number; publishView?: boolean }) =>')
    expect(preload).toContain("ipcRenderer.invoke('fs:projectFilesInfo', dir, opts)")
    expect(dts).toContain('projectFilesInfo(dir: string, opts?: { maxFiles?: number; publishView?: boolean }): Promise<{ files: string[]; truncated: boolean }>')
  })

  it('既存の fs:projectFiles は互換のため残っている', () => {
    const main = read('src/main/ipc/fs.ts')
    expect(main).toContain("ipcMain.handle('fs:projectFiles', async (_, dir: string, maxFiles = 200) => projectFilesFs(dir, maxFiles))")
  })

  it('一覧の打ち切りを捨てない、正直な一覧（projectFilesInfo）を使っている', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s).toContain('await window.electronAPI.fs.projectFilesInfo(root, { maxFiles: SECURITY_CHECK_MAX_FILES, publishView: true })')
    expect(s).not.toContain('await window.electronAPI.fs.projectFiles(projectDir)')
  })

  // ── 一覧取得は「公開と同じ除外定義」を使う（roadmap #17 追補・2026-09-03）─────────
  // 以前の既定の走査（WALK_IGNORE_DIRS＋ドット始まり全除外）は、実際の公開経路
  // （vercel/client.ts の collectDeployFiles・imageBuild.ts の copyTree）が除外しない
  // dist/build/out 等を黙って視界の外に置いていた。publishView: true でその穴をふさぐ。
  it('publishView: true で公開と同じ除外定義を使い、200件の上限を流用しない', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s).toContain('publishView: true')
    expect(s).toContain('const SECURITY_CHECK_MAX_FILES = 5000')
    // 200 を既定のまま流用していないこと（呼び出しの形ごと確認済みの上のテストと対）
    expect(s).not.toContain('fs.projectFilesInfo(projectDir)')
  })

  it('対象外ファイルを classifyUnchecked で仕分け（3分類）、mergeCheckResults へ渡している', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s).toContain('const { dataLike, assets, others } = classifyUnchecked(files, targets, secretFiles)')
    const at = s.indexOf('const merged = mergeCheckResults(results, {')
    expect(at).toBeGreaterThan(-1)
    const call = s.slice(at, s.indexOf('})', at))
    expect(call).toContain('dataLike: plan.dataLike,')
    expect(call).toContain('assets: plan.assets,')
    expect(call).toContain('others: plan.others,')
    expect(call).toContain('truncated: plan.truncated,')
    expect(call).toContain('skipped: plan.skipped,')
    expect(call).toContain('partial: plan.partial,')
    // 名前だけで見つけた秘密らしいファイルと、読めなかったファイルも合成へ渡る（渡し忘れると警告にも報告にも出ない）
    expect(call).toContain('secretFiles: plan.secretFiles,')
    expect(call).toContain('unreadable: plan.unreadable,')
    // 利用量の警告（warning）も合成へ渡る（捨てない）
    expect(call).toContain('warning,')
  })

  it('others・secretFiles は buildAiCheckPrompt へ渡り、中身（pieces）とは別立てで名前だけ送られる（毎回。1回目だけの形には戻さない）', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s).toMatch(/return buildAiCheckPrompt\(\{\s*mode: plan\.mode,\s*entry: plan\.entry,\s*split: plan\.split,[\s\S]*?secretFiles: plan\.secretFiles,\s*others: plan\.others,\s*pieces: \[\.\.\.batch\],\s*\}\)/)
    expect(s).not.toContain('others: i === 0 ? others : [],')
    expect(s).not.toContain('secretFiles: i === 0 ? secretFiles : [],')
    expect(s).not.toContain('buildCheckPrompt(')
    // 依頼文を作るのは promptForBatch の1か所（計画の数え方と実行の送り方が同じ関数を通る）
    expect(s.match(/buildAiCheckPrompt\(/g) ?? []).toHaveLength(1)
    expect(s.match(/promptForBatch\(/g) ?? []).toHaveLength(3) // 定義1・計画1・実行1
  })

  it('secretFiles・others の名前しか無いプロジェクトでも、最低1回はAIに渡す（黙って落とさない）', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s).toContain("if (!batches.length && (secretFiles.length || others.length)) batches.push([])")
  })
})

// ── AIの返事の読み取り（JSON・2026-08-21 rc.1 実機の再発防止の形を引き継ぐ）──
// 推論型モデルが maxTokens を考えるだけで使い切ると、本文の代わりに**英語の思考**が
// 届く（IPC 側の pickContent が空本文を推論で代替するため）。以前は目印「判定:」の最後の出現以降を
// 受理していた。いまは findings を持つ JSON の塊だけを受理し、思考を利用者に見せない。
// 読み方の細部は tests/aiCheckReply.test.ts。ここは、旧い目印方式の形が読めなくなったことも含めて固定する。
describe('AIの返事の読み取り（JSON の塊だけを受理する）', () => {
  const sent = { pieces: [{ file: 'index.html', startLine: 1, lines: ['<p>x</p>'], served: true }], names: [] }

  it('英語の思考の後ろに JSON があれば、最後の塊だけを受理する', () => {
    const raw = 'We need act as web security reviewer. Then decide {"findings": maybe}. Let me write.\n{"findings":[]}'
    expect(extractLastFindingsJson(raw)).toEqual({ findings: [] })
    expect(parseAiReply(raw, sent)).toMatchObject({ state: 'ok', findings: [] })
  })

  it('思考だけで切れた応答（rc.1 実機で起きた形）は不採用にする', () => {
    const raw = 'We need act as web security reviewer. Must output Japanese only, strict format. Need analyze provided files...'
    expect(extractLastFindingsJson(raw)).toBeNull()
    expect(parseAiReply(raw, sent)).toEqual({ state: 'unreadable' })
  })

  it('JSON のあとにぶら下がった英語の思考は、結果に入らない（実機で出た形）', () => {
    const raw = '{"findings":[]}\n\nWait, the format for no issues? The instruction says "問題なしの場合'
    expect(extractLastFindingsJson(raw)).toEqual({ findings: [] })
    expect(parseAiReply(raw, sent)).toMatchObject({ state: 'ok', findings: [] })
  })

  it('前後どちらにも思考がある応答から、JSON だけを取り出す', () => {
    const raw = 'We need to review. {"findings": is decided later.\n{"findings":[]}\n\nWe should double check the format here.'
    expect(extractLastFindingsJson(raw)).toEqual({ findings: [] })
  })

  it('★ 旧い形の返事（「判定:」で始まる文）は読まない。どの書き方でも読めない回になる', () => {
    for (const raw of [
      '判定: 問題なし\n確認した観点: 秘密情報の直書き、XSS',
      '判定： 問題なし\n確認した観点: 秘密情報・XSS',
      '判定: 要確認\nindex.html: APIキーが直書きされています\nscript.js: 入力をそのまま出力しています',
      '判定: 要確認\n1. index.html: 危険\n・script.js: 危険\n* style.css: 危険',
      '申し訳ありません、うまく答えられませんでした。',
      '',
    ]) expect(parseAiReply(raw, sent), raw).toEqual({ state: 'unreadable' })
  })
})

describe('AIへの依頼文（指摘の絞り込み・切り詰めの申し送り）', () => {
  const base = { mode: 'static' as const, entry: null, split: false, secretFiles: [] as string[], others: [] as string[], pieces: [] as PromptPiece[] }

  it('問題の無い確認結果や、体裁の助言を指摘欄に書かせない', () => {
    const p = buildAiCheckPrompt(base)
    expect(p).toContain('問題が無ければ {"findings":[]} とだけ出力する')
    expect(p).toContain('セキュリティに関係しない指摘')
    expect(p).toContain('JSON 以外の文章（思考の経過・英語のメモ）は書かない')
  })

  it('分けて渡すときは「途中で切れている」と書かないよう伝える', () => {
    const p = buildAiCheckPrompt({ ...base, split: true })
    expect(p).toContain('「途中で切れている」「全文を確認せよ」とは書かないでください')
    expect(p).toContain('ほかの部分は別の回に確認します')
  })

  it('分けていないときは、その申し送りを入れない（余計な前提を渡さない）', () => {
    const p = buildAiCheckPrompt(base)
    expect(p).not.toContain('複数回に分けて')
  })
})


// ── 全ファイル・全文を分けて確認する（2026-08-21 rc.5 の設計見直し）─────────
// 以前は「先頭8ファイル・各6000文字」で、9個目以降と6000文字超の部分は
// **何度押しても一度も見られなかった**（landingTEST の menu.html は
// 9,309文字のうち 3,309文字＝36% が対象外だった）。
describe('長いファイルを分ける', () => {
  it('上限以下なら分けない', () => {
    const pieces = splitIntoPieces('a.html', 'x'.repeat(100), 6000)
    expect(pieces).toHaveLength(1)
    expect(pieces[0]).toMatchObject({ file: 'a.html', part: 1, total: 1 })
  })

  it('分けても中身は1文字も落とさない（つなぐと元に戻る）', () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const pieces = splitIntoPieces('big.css', content, 1000)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.map(p => p.text).join('')).toBe(content)
  })

  it('できるだけ行の切れ目で分ける（行の途中で切らない）', () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    for (const p of splitIntoPieces('a.js', content, 200).slice(0, -1)) {
      expect(p.text.endsWith('\n')).toBe(true)
    }
  })

  it('改行の無い長い1行でも、必ず上限内に収める（無限に膨らませない）', () => {
    for (const p of splitIntoPieces('min.js', 'x'.repeat(5000), 1000)) {
      expect(p.text.length).toBeLessThanOrEqual(1000)
    }
  })

  it('分かれたファイルの見出しには何分割目かを書く', () => {
    const pieces = splitIntoPieces('menu.html', 'x'.repeat(2500), 1000)
    expect(pieceHeader(pieces[0])).toBe('--- menu.html（1/3）---')
    expect(pieceHeader(splitIntoPieces('a.html', 'x', 1000)[0])).toBe('--- a.html ---')
  })
})

describe('1回ぶんずつの束に詰める', () => {
  const piece = (file: string, len: number): ReturnType<typeof splitIntoPieces>[number] =>
    ({ file, part: 1, total: 1, startLine: 1, text: 'x'.repeat(len) })

  it('上限を超えないように束を分ける', () => {
    const { batches } = packBatches([piece('a', 900), piece('b', 900), piece('c', 900)], 2000, 6)
    expect(batches).toHaveLength(2)
    expect(batches[0].map(p => p.file)).toEqual(['a', 'b'])
    expect(batches[1].map(p => p.file)).toEqual(['c'])
  })

  it('行番号の分も数える（行の短いファイルは、番号の分だけ早く束が分かれる）', () => {
    const lines = (file: string, n: number): ReturnType<typeof splitIntoPieces>[number] =>
      ({ file, part: 1, total: 1, startLine: 1, text: 'ab\n'.repeat(n) })
    // 本文だけなら 30 + 30 = 60 字で 1 束に収まるが、各行に「N| 」が付くと 90 字を超える
    const { batches } = packBatches([lines('a', 10), lines('b', 10)], 80, 6)
    expect(batches).toHaveLength(2)
  })

  it('1つで上限を超えるかたまりも捨てない（単独の束にする）', () => {
    const { batches, skipped } = packBatches([piece('huge', 5000)], 2000, 6)
    expect(batches).toHaveLength(1)
    expect(skipped).toEqual([])
  })

  it('回数の上限を超えたぶんは「確認していない」と明示する（黙って落とさない）', () => {
    const { batches, skipped } = packBatches([piece('a', 900), piece('b', 900), piece('c', 900)], 1000, 2)
    expect(batches).toHaveLength(2)
    expect(skipped).toEqual(['c'])
  })

  it('一部でも確認できたファイルは「確認していない」に入れない', () => {
    const pieces = [
      { file: 'big.html', part: 1, total: 2, startLine: 1, text: 'x'.repeat(900) },
      { file: 'big.html', part: 2, total: 2, startLine: 1, text: 'x'.repeat(900) },
    ]
    const { skipped } = packBatches(pieces, 1000, 1)
    expect(skipped).toEqual([])
  })
})

const aiF = (o: Partial<AiFinding> = {}): AiFinding => ({
  kind: 'input-to-html', severity: 'should', certainty: 'ai', file: 'a.html', line: 3, note: '', quote: '', ...o,
})
const okR = (findings: AiFinding[] = [], files: string[] = ['a.html']): BatchResult =>
  ({ state: 'ok', findings, malformed: 0, cut: 0, files })
const failR = (files: string[] = [], report = 'チェックに失敗しました（timeout）。'): BatchResult =>
  ({ state: 'failed', report, files })
const nowF = (file: string, line: number): AiFinding => aiF({ kind: 'secret-exposed', severity: 'now', file, line })

describe('複数回の結果をまとめる', () => {
  const info = { files: 9, batches: 2, skipped: [] as string[], partial: [] as string[] }

  it('1回でも「要確認」なら全体で「要確認」（安全側に倒す）', () => {
    const m = mergeCheckResults([okR(), okR([nowF('b.js', 2)])], info)
    expect(m.verdict).toBe('warn')
    expect(m.report).toContain('b.js:2')
    // 「要確認」の中に「問題は見つかりませんでした」を混ぜない
    expect(m.report).not.toContain('確認した範囲では')
  })

  // ⚠️ 順番を変えても倒れること。**「最後の回で決める」実装でも通る**テストしか
  // 書いておらず、ミューテーション試験で素通りした（2026-08-21・掟10 と同じ形）。
  it('「要確認」が最初の回でも、全体で「要確認」になる', () => {
    const m = mergeCheckResults([okR([nowF('b.js', 2)]), okR()], info)
    expect(m.verdict).toBe('warn')
    expect(m.report).toContain('b.js:2')
  })

  it('「要確認」が真ん中の回でも、全体で「要確認」になる', () => {
    const m = mergeCheckResults([okR(), okR([nowF('b.js', 2)]), okR()], info)
    expect(m.verdict).toBe('warn')
  })

  // 以前は「1回でも実施できていれば、失敗した回に引きずられない」と固定していた（skip を無視して ok）。
  // 読めなかった回のファイルは確認できていないので、ほかの回が ok でも「✅ 問題なし」にしない。
  it('★ 読めなかった回（failed）が混ざるなら、ほかの回が ok でも「要確認」（迷ったら警告）', () => {
    const m = mergeCheckResults([okR(), failR(['b.html'])], info)
    expect(m.verdict).toBe('warn')
    expect(m.report.split('\n')[0]).toBe('判定: 要確認')
    expect(m.report).toContain('※ AIが確認できなかった回があります（2回中1回）。もう一度お試しください')
    // 全部のファイルを確認したような件数は書かない
    expect(m.report).not.toContain('個のファイルを')
    // 失敗の理由（外部の応答の文が入りうる）は、混ぜた結果には出さない
    expect(m.report).not.toContain('timeout')
  })

  it('全部問題なしなら、確認した件数と回数を添えて「問題なし」', () => {
    const m = mergeCheckResults([okR(), okR()], info)
    expect(m.verdict).toBe('ok')
    expect(m.report).toContain('（9個のファイルを2回に分けて確認しました）')
    // 「問題は見つかりませんでした」は1度だけ
    expect(m.report.match(/確認した範囲では、問題は見つかりませんでした。/g)).toHaveLength(1)
  })

  it('同じ指摘は、回をまたいでも1度だけ', () => {
    const m = mergeCheckResults([okR([nowF('b.js', 2)]), okR([nowF('b.js', 2)])], info)
    expect(m.report.match(/b\.js:2/g)).toHaveLength(1)
    expect(m.findings).toHaveLength(1)
  })

  it('量が多くて確認しなかったファイルは、結果の中で名指しで伝える。その回は「問題なし」にしない', () => {
    const m = mergeCheckResults([okR()], { files: 30, batches: 6, skipped: ['x.html', 'y.js'], partial: [] })
    expect(m.report).toContain('※ 量が多いため、次のファイルは確認していません: x.html, y.js')
    expect(m.verdict).toBe('warn')
  })

  it('全部が実施できなかったときは skip のまま（問題なしと言わない）', () => {
    const m = mergeCheckResults([failR(['a.html'])], info)
    expect(m.verdict).toBe('skip')
    expect(m.report).toContain('チェックに失敗しました')
  })

  it('1回だけのときは「回に分けて」と言わない', () => {
    const m = mergeCheckResults([okR()], { files: 3, batches: 1, skipped: [], partial: [] })
    expect(m.report).toContain('（3個のファイルを確認しました）')
    expect(m.report).not.toContain('回に分けて')
  })
})

// ── 対象外ファイルの正直化を合成する（roadmap #17・案2・mergeCheckResults の拡張）───
// dataLike / others / truncated を渡さない既存呼び出し（上のテスト群）は、
// 挙動が1文字も変わらないことも合わせて確かめる（新しい任意項目は既定で無害）。
describe('対象外ファイルの正直化を合成する（mergeCheckResults の拡張）', () => {
  const okReport = okR()
  const warnReport = okR([nowF('app.js', 5)])

  it('dataLike が1件でもあれば、AIが「問題なし」でも全体は「要確認」になる（安全側）', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], partial: [], dataLike: ['dump.sql'], others: [] })
    expect(m.verdict).toBe('warn')
    expect(m.report.split('\n')[0]).toBe('判定: 要確認')
    expect(m.report).toContain('dump.sql: 公開するとデータの中身を誰でも見られるようになる種類のファイルです（中身は確認していません）。公開が不要なら公開されるフォルダから移動してください')
    expect(m.report).not.toContain('丸見え') // 0.6.21: 直す前の言い方は戻さない
  })

  it('複数件の dataLike は1行にまとめる', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], partial: [], dataLike: ['dump.sql', 'backup.zip'], others: [] })
    expect(m.report).toContain('dump.sql、backup.zip: 公開するとデータの中身を誰でも見られるようになる種類のファイルです')
  })

  it('固定文は指摘欄の先頭（AIの指摘より前）に入る', () => {
    const m = mergeCheckResults([warnReport], { files: 1, batches: 1, skipped: [], partial: [], dataLike: ['dump.sql'], others: [] })
    const dataLikeIdx = m.report.indexOf('dump.sql: 公開すると')
    const aiIdx = m.report.indexOf('app.js:5')
    expect(dataLikeIdx).toBeGreaterThan(-1)
    expect(aiIdx).toBeGreaterThan(-1)
    expect(dataLikeIdx).toBeLessThan(aiIdx)
  })

  it('others だけなら判定はAIのまま。末尾に「確認できない種類」一覧が必ず出る', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], partial: [], dataLike: [], others: ['server.py', 'メモ.txt'] })
    expect(m.verdict).toBe('ok')
    expect(m.report).toContain('※ 中身を確認できない種類のファイルです（名前だけで判定しました）: server.py, メモ.txt')
  })

  it('末尾の「確認できない種類」一覧は others だけ（dataLike は警告行と二重になるので含めない・assets も含めない）', () => {
    // 2026-09-03 Ryosuke 指摘の反映: dataLike（dump.sql）は上の警告行が名指し済みなので末尾に重複させない
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], partial: [], dataLike: ['dump.sql'], others: ['server.py'], assets: ['logo.png'] })
    expect(m.report).toContain('※ 中身を確認できない種類のファイルです（名前だけで判定しました）: server.py')
    const tail = m.report.split('※ 中身を確認できない種類のファイルです')[1]
    expect(tail).not.toContain('dump.sql')
    expect(m.report).not.toContain('logo.png')
  })

  // ── 名前一覧の肥大防止（roadmap #17 追補）: dataLike は capList(20)、
  // 末尾の「確認していない」一覧（dataLike+others）は capList(50) を通す ─────────
  it('dataLike が20件を超えたら、指摘欄の固定文では21件目以降を「ほかN件」にまとめる（末尾一覧は別枠なので含めない）', () => {
    const dataLike = Array.from({ length: 25 }, (_, i) => `d${i}.sql`)
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], partial: [], dataLike, others: [] })
    const fixedLine = m.report.split('\n').find(l => l.endsWith('公開が不要なら公開されるフォルダから移動してください'))
    expect(fixedLine).toContain('ほか5件')
    expect(fixedLine).not.toContain('d24.sql')
    expect(fixedLine).toContain('d19.sql') // 20件目までは出す
  })

  it('末尾の「確認できない種類」一覧は、others が50件を超えたら「ほかN件」にまとめる', () => {
    const others = Array.from({ length: 60 }, (_, i) => `o${i}.txt`)
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], partial: [], dataLike: [], others })
    expect(m.report).toContain('※ 中身を確認できない種類のファイルです（名前だけで判定しました）:')
    expect(m.report).toContain('ほか10件')
    expect(m.report).not.toContain('o59.txt')
  })

  it('others が無ければ「確認できない種類」の一覧は書かない（狼少年にしない）', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], partial: [] })
    expect(m.report).not.toContain('確認できない種類のファイル')
  })

  // ── assets（表示用の資産）は名指ししない（2026-09-03 Ryosuke 決定・案1）───────
  it('assets が1件以上あれば、末尾に件数だけの1行を出す（ファイル名は出さない）', () => {
    const m = mergeCheckResults([okReport], {
      files: 1, batches: 1, skipped: [], partial: [],
      dataLike: ['dump.sql'], others: ['server.py'],
      assets: ['logo.png', 'font.woff2', 'movie.mp4'],
    })
    expect(m.report).toContain('※ 画像・フォント・音声など 3 件は、中身の確認の対象外です')
    // ファイル名は報告のどの行にも出ない（当て先が他行に漏れないかも確認・掟10）
    expect(m.report).not.toContain('logo.png')
    expect(m.report).not.toContain('font.woff2')
    expect(m.report).not.toContain('movie.mp4')
  })

  it('assets が無ければ、その注記は入れない', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], partial: [] })
    expect(m.report).not.toContain('中身の確認の対象外です')
  })

  it('assets の注記は「確認していないファイル」一覧より前（末尾側だが、その手前）に入る', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], partial: [], dataLike: [], others: ['server.py'], assets: ['logo.png'] })
    const assetsIdx = m.report.indexOf('画像・フォント・音声など')
    const uncheckedIdx = m.report.indexOf('確認できない種類のファイルです（名前だけで判定しました）')
    expect(assetsIdx).toBeGreaterThan(-1)
    expect(uncheckedIdx).toBeGreaterThan(-1)
    expect(assetsIdx).toBeLessThan(uncheckedIdx)
  })

  // assets だけがあって dataLike/others/AIの指摘が無い場合、資産の存在自体は正常なので
  // 判定を要確認に倒さない（forceWarn に含めない）
  it('assets だけがあり dataLike・others が無ければ、判定は要確認にしない（資産の存在は正常）', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], partial: [], dataLike: [], others: [], assets: ['logo.png', 'font.woff2'] })
    expect(m.verdict).toBe('ok')
    expect(m.report).toContain('※ 画像・フォント・音声など 2 件は、中身の確認の対象外です')
    // dataLike/others が無いので「確認していないファイル」一覧自体は出さない
    expect(m.report).not.toContain('確認していないファイル（名前だけで判定しました）')
  })

  it('AIが要確認でも、assets の1行は指摘（AIの指摘）とは独立して末尾に出る', () => {
    const m = mergeCheckResults([warnReport], { files: 1, batches: 1, skipped: [], partial: [], dataLike: [], others: [], assets: ['logo.png'] })
    expect(m.verdict).toBe('warn')
    expect(m.report).toContain('app.js:5')
    expect(m.report).toContain('※ 画像・フォント・音声など 1 件は、中身の確認の対象外です')
  })

  it('truncated（一覧打ち切り）は判定を要確認に倒し、専用の文言を明示する', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], partial: [], dataLike: [], others: [], truncated: true })
    expect(m.verdict).toBe('warn')
    // 2026-10-09 画面の文を短くする（T107）: 「一覧は途中までです。チェックも…」の重ねを1つにした。
    expect(m.report).toContain('※ ファイルが多いため、チェックは一部のファイルにとどまります')
    expect(m.report).not.toContain('一覧は途中までです')
  })

  it('truncated が無ければ、その文言は入れない', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], partial: [] })
    expect(m.report).not.toContain('一覧は途中までです')
  })

  it('AIが未実施（回が無い）でも、dataLike があれば機械的な理由で「要確認」にする', () => {
    const m = mergeCheckResults([], { files: 0, batches: 0, skipped: [], partial: [], dataLike: ['dump.sql'], others: [] })
    expect(m.verdict).toBe('warn')
    expect(m.report).toContain('dump.sql: 公開するとデータの中身を誰でも見られるようになる種類のファイルです')
  })

  it('AIが未実施で、機械的な理由（dataLike・truncated）も無ければ、従来どおり skip のまま', () => {
    const m = mergeCheckResults([failR()], { files: 0, batches: 0, skipped: [], partial: [], dataLike: [], others: ['server.py'] })
    expect(m.verdict).toBe('skip')
    expect(m.report).toBe('チェックに失敗しました（timeout）。')
  })
})

// ── 結果の行は、すべて Koto が組み立てた文字のまま描く（AI の文を Markdown として描かない）──────────
// 結果の文には、AI の説明（note）やファイル名が入る。** や ` を解釈すると、太字・コードになり、
// 実在しない名前に見える。分け方は mergeCheckResults が決める（画面は parts を見るだけ）。
describe('結果の行は、すべて ai: false で持つ（mergeCheckResults の parts）', () => {
  const ok = okR([aiF({ file: 'a.js', line: 2, note: '**全ファイル** の `a.js` は安全ではありません' })])
  const warn = okR([nowF('b.js', 4)])

  it('★ report は parts を改行でつないだものと一致する（コピーに渡る全文は変わらない）', () => {
    const infos = [
      { files: 3, batches: 1, skipped: [] as string[], partial: [] as string[] },
      { files: 9, batches: 2, skipped: ['x.html'], partial: [], dataLike: ['d**a.csv'], others: ['`x`.txt'], assets: ['l.png'], truncated: true },
      { files: 1, batches: 1, skipped: [], partial: [], assets: ['l.png'] },
    ]
    for (const info of infos) for (const results of [[ok], [warn], [ok, warn], []]) {
      const m = mergeCheckResults(results, info)
      expect(m.parts.map(p => p.text).join('\n')).toBe(m.report)
      expect(m.parts.every(p => p.text !== '')).toBe(true)
    }
  })

  it('★ すべて ai: false。Koto の行（判定・件数・確認しなかった名前・打ち切り・資産・確認できない種類）も AI の note も文字のまま', () => {
    const m = mergeCheckResults([ok], {
      files: 9, batches: 2, skipped: ['s**t.html'], partial: [], partial: [], dataLike: ['d**a.csv'], others: ['`x`.txt'], assets: ['l.png'], truncated: true,
    })
    expect(m.parts.every(p => p.ai === false)).toBe(true)
    const text = m.parts.map(p => p.text).join('\n')
    for (const line of [
      '判定: 要確認',
      '（9個のファイルを2回に分けて確認しました）',
      '※ 量が多いため、次のファイルは確認していません: s**t.html',
      'd**a.csv: 公開するとデータの中身を誰でも見られるようになる種類のファイルです',
      '※ ファイルが多いため、チェックは一部のファイルにとどまります',
      '※ 画像・フォント・音声など 1 件は、中身の確認の対象外です',
      '※ 中身を確認できない種類のファイルです（名前だけで判定しました）: `x`.txt',
      '　**全ファイル** の `a.js` は安全ではありません',
    ]) expect(text, line).toContain(line)
  })

  it('AI の指摘が無い（AI 未実施で機械的に要確認になった）ときも、ai: true は無い', () => {
    const m = mergeCheckResults([], { files: 0, batches: 0, skipped: [], partial: [], dataLike: ['dump.sql'], others: [] })
    expect(m.verdict).toBe('warn')
    expect(m.parts.some(p => p.ai)).toBe(false)
  })

  it('実施できなかった結果（skip）は、全体が Koto の文（失敗の理由には外部の応答の文が入りうる）', () => {
    const m = mergeCheckResults([failR(['a.html'], 'チェックに失敗しました（**timeout**）。')], { files: 1, batches: 1, skipped: [], partial: [] })
    expect(m.parts).toEqual([{ text: 'チェックに失敗しました（**timeout**）。', ai: false }])
    expect(mergeCheckResults([], { files: 0, batches: 0, skipped: [], partial: [] }).parts).toEqual([{ text: 'チェックを実施できませんでした。', ai: false }])
  })

  it('★ parts を持たない結果（Koto が早期に返す一言）は、全体を Koto の文として扱う（解釈しない側に倒す）', () => {
    expect(reportParts({ report: 'APIキーが未設定のため、セキュリティチェックを省略しました。' }))
      .toEqual([{ text: 'APIキーが未設定のため、セキュリティチェックを省略しました。', ai: false }])
    expect(reportParts({ report: 'x', parts: [] })).toEqual([{ text: 'x', ai: false }])
    expect(reportParts({ report: 'a\nb', parts: [{ text: 'a', ai: false }, { text: 'b', ai: true }] }))
      .toEqual([{ text: 'a', ai: false }, { text: 'b', ai: true }])
  })

  it('runSecurityCheck は mergeCheckResults の parts を結果に載せたまま返す（mode だけ足す）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/securityCheck.ts'), 'utf-8')
    expect(src).toContain('return { ...merged, mode }')
  })
})

// ── AI の利用量を使う場面の一覧（2026-08-21 Ryosuke 提案）────────────────
// 「AIリソースを何に使うのか」を利用者が見られるようにした。実装（AI を呼ぶ
// 経路）と文書がずれると、いちばん困る種類の嘘になるので、対応を固定する。
describe('AIの利用量を使う場面の一覧', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

  it('使い方ガイドに一覧があり、AI を呼ぶ6つの場面が載っている', () => {
    const g = read('docs/usage-guide.html')
    // D-14（2026-09-16）: 見出しは「AIの利用量を使うところ」（「利用量を使う」は主述が合わない）
    // から「AIの利用量がかかる場面」へ直した。固定するのは**一覧が在ること**なので、新しい文言で見る。
    expect(g).toContain('AIの利用量がかかる場面')
    for (const scene of ['AIチャット（作る）', '画像を読む', '最初のあいさつ', '🗂 まとめ', '🛡 簡易セキュリティチェック', '公開先を変えたあとの確認']) {
      expect(g).toContain(scene)
    }
  })

  it('一覧は「上限に達すると全部止まる」ことと、Claude は別勘定であることを書いている', () => {
    const g = read('docs/usage-guide.html')
    // D-14: 「AI の呼び出しを止めます」は書き手側の言い方だったので、読み手側の言い方へ直した。
    // 固定するのは**上限に達したら AI を使わなくなること**が書いてあるかどうか。
    expect(g).toContain('上限に達すると、ここに挙げた場面では AI を使わなくなります')
    expect(g).toContain('Anthropic 側の利用料')
  })

  it('AI を呼ぶ実装は、一覧に挙げた3ファイルとちょうど一致する（src/renderer を走査して導く）', () => {
    // 増えたらここが落ちる → 一覧の更新を促す（掟9: 文書と実物を一致させる）。減っても落ちる
    const listed = ['src/renderer/components/ChatPanel.tsx', 'src/renderer/hooks/useAiChat.ts', 'src/renderer/securityCheck.ts']
    const root = path.join(__dirname, '..', 'src/renderer')
    const found: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) { walk(full); continue }
        if (!/\.tsx?$/.test(e.name)) continue
        // コメントだけの行は数えない（呼び出しの形が書いてあるだけのものを拾わない）
        const code = fs.readFileSync(full, 'utf-8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
        if (/sakura\.chat(Stream)?\(/.test(code)) found.push(path.relative(path.join(__dirname, '..'), full).split(path.sep).join('/'))
      }
    }
    walk(root)
    expect(found.sort()).toEqual(listed)
  })
})

// ── 前回の確認（2026-08-21 Ryosuke 提案）──────────────────────────────
// 公開の画面を閉じると結果が消え、**最後にいつ確認したのか分からなくなる**。
// 最新1件だけを残す。古い日付が残っていること自体が判断の材料になる。
describe('前回の確認の記録', () => {
  it('置き場所はプロジェクトごとに分かれる', () => {
    expect(checkRecordKey('/a/proj1')).not.toBe(checkRecordKey('/a/proj2'))
    expect(checkRecordKey('/a/proj1')).toContain('/a/proj1')
  })

  it('問題なしは日時つきで表示する', () => {
    const at = new Date(2026, 7, 21, 20, 5).toISOString()
    expect(formatCheckRecord({ at, verdict: 'ok' })).toBe('前回の AI の確認: 8/21 20:05 ✅ 問題なし')
  })

  it('要確認は、そのまま「要確認」と表示する（修正の依頼が出ない回もあるので、提案ありとは言わない）', () => {
    const at = new Date(2026, 7, 21, 9, 30).toISOString()
    expect(formatCheckRecord({ at, verdict: 'warn' })).toBe('前回の AI の確認: 8/21 09:30 ⚠️ 要確認')
  })

  it('記録が無い・壊れているときは何も出さない（嘘の日付を出さない）', () => {
    expect(formatCheckRecord(null)).toBeNull()
    expect(formatCheckRecord(undefined)).toBeNull()
    expect(formatCheckRecord({ at: 'こわれた', verdict: 'ok' })).toBeNull()
    expect(formatCheckRecord({ at: new Date().toISOString(), verdict: 'skip' as any })).toBeNull()
  })
})

describe('前回の確認の配線', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

  it('実施できたときだけ記録する（省略・失敗は「確認した」ではない）', () => {
    const s = read('src/renderer/components/SecurityCheckSection.tsx')
    expect(read('src/renderer/securityCheckFlow.ts')).toContain("if (r.verdict === 'ok' || r.verdict === 'warn') {")
    expect(s).toContain('window.localStorage.setItem(checkRecordKey(dir), JSON.stringify(rec))')
  })

  it('置き場所は共通の関数から取る（画面側で文字列を組み立てない）', () => {
    const s = read('src/renderer/components/SecurityCheckSection.tsx')
    expect(s).toContain('window.localStorage.getItem(checkRecordKey(projectDir))')
    expect(s).not.toContain('koto_seccheck') // 直書きが復活したら落ちる
  })

  it('プロジェクトを切り替えたら読み直す（前のプロジェクトの記録を見せない）', () => {
    const s = read('src/renderer/components/SecurityCheckSection.tsx')
    const effect = s.slice(s.indexOf('useEffect(() => {'), s.indexOf('}, [projectDir])'))
    expect(effect).toContain('setResult(null)')
    expect(effect).toContain('checkRecordKey(projectDir)')
  })
})
