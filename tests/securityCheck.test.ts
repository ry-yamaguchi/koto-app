import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { pickCheckTargets, judgeVerdict, checkpointsFor, buildCheckPrompt, extractCheckReport, splitIntoPieces, packBatches, pieceHeader, mergeCheckResults, checkRecordKey, formatCheckRecord, DATA_FILE_RE, classifyUnchecked, capList } from '../src/renderer/securityCheck'

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

describe('classifyUnchecked（検査対象・secretFiles の残りを dataLike / others に仕分ける）', () => {
  it('データっぽい拡張子は dataLike に入る（実測で完全素通りしていたもの）', () => {
    const files = ['dump.sql', 'backup.zip', 'site.bak', 'index.html']
    const { targets } = pickCheckTargets(files)
    const { dataLike } = classifyUnchecked(files, targets, [])
    expect(dataLike).toEqual(['dump.sql', 'backup.zip', 'site.bak'])
  })

  it('データっぽくない対象外ファイルは others に入る', () => {
    const files = ['README.md', 'メモ.txt', 'server.py', 'index.html']
    const { targets } = pickCheckTargets(files)
    const { others } = classifyUnchecked(files, targets, [])
    expect(others).toEqual(['README.md', 'メモ.txt', 'server.py'])
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
// 以前は1行目に「問題なし」が含まれるかだけを見ていたため、
// 「判定: 要確認（一部は問題なし）」のような書き方をされると ok になっていた。
describe('AIの回答から判定を決める', () => {
  it('問題なしなら ok', () => {
    expect(judgeVerdict('判定: 問題なし\n確認した観点: 秘密情報の直書き、XSS')).toBe('ok')
  })

  it('要確認なら warn', () => {
    expect(judgeVerdict('判定: 要確認\nindex.html: APIキーが直書きされています')).toBe('warn')
  })

  // ここが実害。両方の語が入っていたら警告側に倒す
  it('両方の語が入っていたら warn（安全側に倒す）', () => {
    expect(judgeVerdict('判定: 要確認（一部は問題なし）\n…')).toBe('warn')
    expect(judgeVerdict('判定: 問題なし。ただし要確認の点あり\n…')).toBe('warn')
  })

  it('形式に従わない回答は warn（判定できないものを ok にしない）', () => {
    expect(judgeVerdict('こんにちは')).toBe('warn')
    expect(judgeVerdict('')).toBe('warn')
  })

  it('2行目以降に問題なしと書かれていても、1行目で判断する', () => {
    expect(judgeVerdict('判定: 要確認\nstyle.css: 問題なし')).toBe('warn')
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
  it('アプリなら、サーバーで実行されると明言し、入口ファイル名を伝える', () => {
    const p = buildCheckPrompt({ mode: 'node', entry: 'server.js', secretFiles: [], parts: ['--- server.js ---\nconst http = ...'] })
    expect(p).toContain('サーバーで実行される')
    expect(p).toContain('入口は server.js')
    expect(p).toContain('命令の混入')
  })

  it('サイトなら、そのまま配信されると明言し、アプリ専用の観点は入れない', () => {
    const p = buildCheckPrompt({ mode: 'static', entry: null, secretFiles: [], parts: [] })
    expect(p).toContain('そのまま配信される')
    expect(p).not.toContain('命令の混入')
  })

  it('秘密ファイルは名前だけを伝える行に載る', () => {
    const p = buildCheckPrompt({ mode: 'static', entry: null, secretFiles: ['.env'], parts: [] })
    expect(p).toContain('公開NGの可能性が高い: .env')
  })

  it('出力形式（判定の1行目）を必ず要求する', () => {
    const p = buildCheckPrompt({ mode: 'node', entry: 'a.js', secretFiles: [], parts: [] })
    expect(p).toContain('「判定: 問題なし」または「判定: 要確認」')
  })

  // ── others（対象外・データ系でもないファイル名）の名前だけ判定（roadmap #17・案2）───
  it('others の名前を伝え、名前だけで疑いがあるものだけ指摘するよう指示する', () => {
    const p = buildCheckPrompt({ mode: 'static', entry: null, secretFiles: [], parts: [], others: ['server.py', 'メモ.txt'] })
    expect(p).toContain('server.py, メモ.txt')
    expect(p).toContain('名前から個人情報・秘密・残骸')
    expect(p).toContain('中身は見なくてよい')
  })

  // 中身は絶対に送らない（2026-08-09 の .env 事故の原則）。others に渡すのは名前一覧だけ
  // ── parts（実際のファイル内容）を空にしても、others の名前は独立に依頼文へ載る。
  it('others に渡すのは名前一覧だけ（parts が空でも名前は載る＝中身に依存しない）', () => {
    const p = buildCheckPrompt({ mode: 'static', entry: null, secretFiles: [], parts: [], others: ['customers.csv'] })
    expect(p).toContain('customers.csv')
    expect(buildCheckPrompt({ mode: 'static', entry: null, secretFiles: [], parts: [] })).not.toContain('customers.csv')
  })

  it('others が無ければ、その案内は入れない', () => {
    const p = buildCheckPrompt({ mode: 'static', entry: null, secretFiles: [], parts: [] })
    expect(p).not.toContain('名前から個人情報・秘密・残骸')
  })

  // ── 名前一覧の肥大防止（roadmap #17 追補）: others は capList(80) を通す ─────────
  it('others が80件を超えたら、依頼文では81件目以降を「ほかN件」にまとめる', () => {
    const others = Array.from({ length: 90 }, (_, i) => `f${i}.txt`)
    const p = buildCheckPrompt({ mode: 'static', entry: null, secretFiles: [], parts: [], others })
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
    expect(s).toContain('await runSecurityCheck(projectDir, apiKey, setProgress)')
    expect(s).toContain("new CustomEvent('sakura:fix-with-ai'")
    // 依頼文は「実際に修正しろ」と明言する（rc.1 は指示が弱く、AIが翻訳・再レビューだけで終わった）
    expect(s).toContain('実際に修正して解消してください')
    // 実体を持たない（独自のプロンプトや判定を書かない）
    expect(s).not.toContain('sakura.chat')
  })

  it('公開フローの4経路すべてに 🛡 節が居る（AppRun・Vercel・HANAMII・レンタル）', () => {
    for (const f of ['AppRunPanel.tsx', 'VercelPanel.tsx', 'HanamiiPanel.tsx', 'PublishModal.tsx']) {
      expect(read(`src/renderer/components/${f}`)).toContain('<SecurityCheckSection projectDir={projectDir} apiKey={apiKey} />')
    }
  })

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

  it('ビルド設定の除外は一元定義（BUILD_CONFIG_FILES）を呼び出しの形ごと使う', () => {
    const s = read('src/renderer/securityCheck.ts')
    // 名簿の丸ごと利用を、式の形ごと一意に指す（手書きの配列に替わったら落ちる）
    expect(s).toContain('(BUILD_CONFIG_FILES as readonly string[]).includes(base)')
  })

  it('PublishModal は各パネルへAPIキーを渡している', () => {
    const s = read('src/renderer/components/PublishModal.tsx')
    for (const name of ['AppRunPanel', 'VercelPanel', 'HanamiiPanel']) {
      expect(s).toContain(`<${name} projectDir={projectDir} apiKey={apiKey} onOpenCredentials={onOpenCredentials} />`)
    }
  })

  it('推論対策: 上限4096・目印方式・実況が実装に居る', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s).toContain('maxTokens: 4096')
    expect(s).toContain('extractCheckReport(raw)')
    // 実測で1分を超えることがある。短く言い切らない（2026-08-21 rc.3 実機）
    expect(s).toContain('少々時間がかかります')
    expect(s).not.toContain('30秒ほどかかります')
    // 生の応答をそのまま判定・表示に回さない（rc.1 の再発防止）
    expect(s).not.toContain('judgeVerdict(raw)')
  })

  it('全ファイル・全文を分けて確認し、結果をまとめている', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s).toContain('pieces.push(...splitIntoPieces(f, await window.electronAPI.fs.readFile(')
    expect(s).toContain('const { batches, skipped } = packBatches(pieces)')
    expect(s).toContain('mergeCheckResults(results, {')
  })

  // 2026-08-21 Ryosuke 指定: 利用量の歯止めは全体予算のブロックに一本化する。
  // この機能だけが回ごとに独自の判断を持つと、止まる条件が場所ごとに変わる。
  it('利用量の歯止めは全体予算のブロックだけ（開始時の1回。回ごとに独自判断しない）', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s.match(/checkBeforeRequest\(/g) ?? []).toHaveLength(1)
    expect(s).toContain('const budget = checkBeforeRequest(apiKey)')
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
    expect(s).toContain('await window.electronAPI.fs.projectFilesInfo(projectDir, { maxFiles: SECURITY_CHECK_MAX_FILES, publishView: true })')
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

  it('対象外ファイルを classifyUnchecked で仕分け、mergeCheckResults へ渡している', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s).toContain('const { dataLike, others } = classifyUnchecked(files, targets, secretFiles)')
    const at = s.indexOf('const merged = mergeCheckResults(results, {')
    const call = s.slice(at, s.indexOf('})', at))
    expect(call).toContain('dataLike,')
    expect(call).toContain('others,')
    expect(call).toContain('truncated,')
  })

  it('others は buildCheckPrompt へ渡り、中身（parts）とは別立てで名前だけ送られる', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s).toContain('others: i === 0 ? others : [],')
  })

  it('secretFiles・others の名前しか無いプロジェクトでも、最低1回はAIに渡す（黙って落とさない）', () => {
    const s = read('src/renderer/securityCheck.ts')
    expect(s).toContain("if (!batches.length && (secretFiles.length || others.length)) batches.push([])")
  })
})

// ── AIの生の応答から報告を取り出す（目印方式・2026-08-21 rc.1 実機の再発防止）──
// 推論型モデルが maxTokens を考えるだけで使い切ると、本文の代わりに**英語の思考**が
// 届く（IPC 側の pickContent が空本文を推論で代替するため）。🗂 まとめと同じく、
// 目印「判定:」の最後の出現以降だけを受理し、思考を利用者に見せない。
describe('AIの生の応答から報告を取り出す（目印方式）', () => {
  it('英語の思考の後ろに報告があれば、最後の「判定:」以降だけを受理する', () => {
    const raw = 'We need act as web security reviewer. Then decide 判定: ok or not. Let me write.\n判定: 要確認\n- index.html: APIキーが直書きされています'
    expect(extractCheckReport(raw)).toBe('判定: 要確認\n- index.html: APIキーが直書きされています')
  })

  it('思考だけで切れた応答（rc.1 実機で起きた形）は不採用にする', () => {
    expect(extractCheckReport('We need act as web security reviewer. Must output Japanese only, strict format. Need analyze provided files...')).toBeNull()
  })

  it('全角コロン（判定：）でも受理する', () => {
    expect(extractCheckReport('前置きの文章\n判定： 問題なし\n確認した観点: 秘密情報・XSS')).toBe('判定： 問題なし\n確認した観点: 秘密情報・XSS')
  })

  it('報告だけの応答は、そのまま全体を受理する', () => {
    expect(extractCheckReport('判定: 問題なし\n確認した観点: 秘密情報の直書き、XSS')).toBe('判定: 問題なし\n確認した観点: 秘密情報の直書き、XSS')
  })
})

// ── 報告の「後ろ側」も切る（2026-08-21 rc.3 実機・Ryosuke 報告）────────────
// 報告を書き終えたあとに思考へ戻る応答があり、利用者向けの文の末尾に
// `Wait, the bullet format for no issues?…` がぶら下がっていた。
describe('報告のあとに続く思考を切る', () => {
  it('報告の末尾にぶら下がった英語の思考を落とす（実機で出た形）', () => {
    const raw = [
      '判定: 問題なし',
      '- 全ファイル: APIキーの直書きは確認されませんでした。',
      '',
      'Wait, the bullet format for no issues? The instruction says "問題なしの場合',
    ].join('\n')
    expect(extractCheckReport(raw)).toBe('判定: 問題なし\n- 全ファイル: APIキーの直書きは確認されませんでした。')
  })

  it('「ファイル名: …」で始まる行は、箇条書きでなくても報告として残す', () => {
    const raw = '判定: 要確認\nindex.html: APIキーが直書きされています\nscript.js: 入力をそのまま出力しています'
    expect(extractCheckReport(raw)).toBe(raw)
  })

  it('番号付き・記号付きの箇条書きも残す', () => {
    const raw = '判定: 要確認\n1. index.html: 危険\n・script.js: 危険\n* style.css: 危険'
    expect(extractCheckReport(raw)).toBe(raw)
  })

  it('前後どちらにも思考がある応答から、報告だけを取り出す', () => {
    const raw = 'We need to review. 判定: is decided later.\n判定: 要確認\n- app.js: 入力をそのまま実行しています\n\nWe should double check the format here.'
    expect(extractCheckReport(raw)).toBe('判定: 要確認\n- app.js: 入力をそのまま実行しています')
  })
})

describe('AIへの依頼文（指摘の絞り込み・切り詰めの申し送り）', () => {
  it('問題の無い確認結果や、体裁の助言を指摘欄に書かせない', () => {
    const p = buildCheckPrompt({ mode: 'static', entry: null, secretFiles: [], parts: [] })
    expect(p).toContain('問題がある項目だけ')
    expect(p).toContain('セキュリティに関係しない指摘')
    expect(p).toContain('報告以外の文章（思考の経過・英語のメモ）は書かない')
  })

  it('分けて渡すときは「途中で切れている」と書かないよう伝える', () => {
    const p = buildCheckPrompt({ mode: 'static', entry: null, secretFiles: [], parts: [], split: true })
    expect(p).toContain('「途中で切れている」「全文を確認せよ」とは書かないでください')
    expect(p).toContain('ほかの部分は別の回に確認します')
  })

  it('分けていないときは、その申し送りを入れない（余計な前提を渡さない）', () => {
    const p = buildCheckPrompt({ mode: 'static', entry: null, secretFiles: [], parts: [] })
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
    ({ file, part: 1, total: 1, text: 'x'.repeat(len) })

  it('上限を超えないように束を分ける', () => {
    const { batches } = packBatches([piece('a', 900), piece('b', 900), piece('c', 900)], 2000, 6)
    expect(batches).toHaveLength(2)
    expect(batches[0].map(p => p.file)).toEqual(['a', 'b'])
    expect(batches[1].map(p => p.file)).toEqual(['c'])
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
      { file: 'big.html', part: 1, total: 2, text: 'x'.repeat(900) },
      { file: 'big.html', part: 2, total: 2, text: 'x'.repeat(900) },
    ]
    const { skipped } = packBatches(pieces, 1000, 1)
    expect(skipped).toEqual([])
  })
})

describe('複数回の結果をまとめる', () => {
  const info = { files: 9, batches: 2, skipped: [] as string[] }

  it('1回でも「要確認」なら全体で「要確認」（安全側に倒す）', () => {
    const m = mergeCheckResults([
      { verdict: 'ok', report: '判定: 問題なし\n- a.html: 問題ありませんでした' },
      { verdict: 'warn', report: '判定: 要確認\n- b.js: APIキーが直書きされています' },
    ], info)
    expect(m.verdict).toBe('warn')
    // 「要確認」の中に「問題ありませんでした」を混ぜない
    expect(m.report).toContain('- b.js: APIキーが直書きされています')
    expect(m.report).not.toContain('問題ありませんでした')
  })

  // ⚠️ 順番を変えても倒れること。**「最後の回で決める」実装でも通る**テストしか
  // 書いておらず、ミューテーション試験で素通りした（2026-08-21・掟10 と同じ形）。
  it('「要確認」が最初の回でも、全体で「要確認」になる', () => {
    const m = mergeCheckResults([
      { verdict: 'warn', report: '判定: 要確認\n- b.js: APIキーが直書きされています' },
      { verdict: 'ok', report: '判定: 問題なし\n- a.html: 問題ありませんでした' },
    ], info)
    expect(m.verdict).toBe('warn')
    expect(m.report).toContain('- b.js: APIキーが直書きされています')
  })

  it('「要確認」が真ん中の回でも、全体で「要確認」になる', () => {
    const m = mergeCheckResults([
      { verdict: 'ok', report: '判定: 問題なし\n- a.html: 問題ありませんでした' },
      { verdict: 'warn', report: '判定: 要確認\n- b.js: 危険' },
      { verdict: 'ok', report: '判定: 問題なし\n- c.css: 問題ありませんでした' },
    ], info)
    expect(m.verdict).toBe('warn')
  })

  it('1回でも実施できていれば、失敗した回に引きずられない（skip は判定を左右しない）', () => {
    const m = mergeCheckResults([
      { verdict: 'ok', report: '判定: 問題なし\n- a.html: 問題なし' },
      { verdict: 'skip', report: 'チェックに失敗しました（timeout）。' },
    ], info)
    expect(m.verdict).toBe('ok')
  })

  it('全部問題なしなら、確認した件数と回数を添えて「問題なし」', () => {
    const m = mergeCheckResults([
      { verdict: 'ok', report: '判定: 問題なし\n- 全ファイル: 秘密情報はありません' },
      { verdict: 'ok', report: '判定: 問題なし\n- 全ファイル: 秘密情報はありません' },
    ], info)
    expect(m.verdict).toBe('ok')
    expect(m.report).toContain('（9個のファイルを2回に分けて確認しました）')
    // 同じ指摘は1度だけ
    expect(m.report.match(/秘密情報はありません/g)).toHaveLength(1)
  })

  it('確認できなかったファイルは、結果の中で名指しで伝える', () => {
    const m = mergeCheckResults(
      [{ verdict: 'ok', report: '判定: 問題なし\n- a.html: 問題なし' }],
      { files: 30, batches: 6, skipped: ['x.html', 'y.js'] },
    )
    expect(m.report).toContain('※ 量が多いため、次のファイルは確認していません: x.html, y.js')
  })

  it('全部が実施できなかったときは skip のまま（問題なしと言わない）', () => {
    const m = mergeCheckResults([{ verdict: 'skip', report: 'チェックに失敗しました（timeout）。' }], info)
    expect(m.verdict).toBe('skip')
    expect(m.report).toContain('チェックに失敗しました')
  })

  it('1回だけのときは「回に分けて」と言わない', () => {
    const m = mergeCheckResults(
      [{ verdict: 'ok', report: '判定: 問題なし\n- a.html: 問題なし' }],
      { files: 3, batches: 1, skipped: [] },
    )
    expect(m.report).toContain('（3個のファイルを確認しました）')
    expect(m.report).not.toContain('回に分けて')
  })
})

// ── 対象外ファイルの正直化を合成する（roadmap #17・案2・mergeCheckResults の拡張）───
// dataLike / others / truncated を渡さない既存呼び出し（上のテスト群）は、
// 挙動が1文字も変わらないことも合わせて確かめる（新しい任意項目は既定で無害）。
describe('対象外ファイルの正直化を合成する（mergeCheckResults の拡張）', () => {
  const okReport = { verdict: 'ok' as const, report: '判定: 問題なし\n- 全ファイル: 問題ありませんでした' }
  const warnReport = { verdict: 'warn' as const, report: '判定: 要確認\n- app.js: APIキーが直書きされています' }

  it('dataLike が1件でもあれば、AIが「問題なし」でも全体は「要確認」になる（安全側）', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], dataLike: ['dump.sql'], others: [] })
    expect(m.verdict).toBe('warn')
    expect(m.report.split('\n')[0]).toBe('判定: 要確認')
    expect(m.report).toContain('dump.sql: 公開するとデータの中身が丸見えになる種類のファイルです（中身は確認していません）。公開が不要なら公開されるフォルダから移動してください')
  })

  it('複数件の dataLike は1行にまとめる', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], dataLike: ['dump.sql', 'backup.zip'], others: [] })
    expect(m.report).toContain('dump.sql、backup.zip: 公開するとデータの中身が丸見えになる種類のファイルです')
  })

  it('固定文は指摘欄の先頭（AIの指摘より前）に入る', () => {
    const m = mergeCheckResults([warnReport], { files: 1, batches: 1, skipped: [], dataLike: ['dump.sql'], others: [] })
    const dataLikeIdx = m.report.indexOf('dump.sql: 公開すると')
    const aiIdx = m.report.indexOf('app.js: APIキーが直書きされています')
    expect(dataLikeIdx).toBeGreaterThan(-1)
    expect(aiIdx).toBeGreaterThan(-1)
    expect(dataLikeIdx).toBeLessThan(aiIdx)
  })

  it('others だけなら判定はAIのまま。末尾に「確認していない」一覧が必ず出る', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], dataLike: [], others: ['server.py', 'メモ.txt'] })
    expect(m.verdict).toBe('ok')
    expect(m.report).toContain('※ 中身を確認していないファイル: server.py, メモ.txt')
  })

  it('末尾の「確認していない」一覧は dataLike・others の両方を含む', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], dataLike: ['dump.sql'], others: ['server.py'] })
    expect(m.report).toContain('※ 中身を確認していないファイル: dump.sql, server.py')
  })

  // ── 名前一覧の肥大防止（roadmap #17 追補）: dataLike は capList(20)、
  // 末尾の「確認していない」一覧（dataLike+others）は capList(50) を通す ─────────
  it('dataLike が20件を超えたら、指摘欄の固定文では21件目以降を「ほかN件」にまとめる（末尾一覧は別枠なので含めない）', () => {
    const dataLike = Array.from({ length: 25 }, (_, i) => `d${i}.sql`)
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], dataLike, others: [] })
    const fixedLine = m.report.split('\n').find(l => l.endsWith('公開が不要なら公開されるフォルダから移動してください'))
    expect(fixedLine).toContain('ほか5件')
    expect(fixedLine).not.toContain('d24.sql')
    expect(fixedLine).toContain('d19.sql') // 20件目までは出す
  })

  it('末尾の「確認していないファイル」一覧は、dataLike+others 合算で50件を超えたら「ほかN件」にまとめる', () => {
    const dataLike = Array.from({ length: 30 }, (_, i) => `d${i}.sql`)
    const others = Array.from({ length: 30 }, (_, i) => `o${i}.txt`)
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], dataLike, others })
    expect(m.report).toContain('※ 中身を確認していないファイル:')
    expect(m.report).toContain('ほか10件')
    expect(m.report).not.toContain('o29.txt')
  })

  it('dataLike・others が無ければ「確認していないファイル」は書かない（狼少年にしない）', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [] })
    expect(m.report).not.toContain('確認していないファイル')
  })

  it('truncated（一覧打ち切り）は判定を要確認に倒し、専用の文言を明示する', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [], dataLike: [], others: [], truncated: true })
    expect(m.verdict).toBe('warn')
    expect(m.report).toContain('※ ファイルが多いため一覧は途中までです。チェックも全体の一部にとどまります')
  })

  it('truncated が無ければ、その文言は入れない', () => {
    const m = mergeCheckResults([okReport], { files: 1, batches: 1, skipped: [] })
    expect(m.report).not.toContain('一覧は途中までです')
  })

  it('AIが未実施（skip）でも、dataLike があれば機械的な理由で「要確認」にする', () => {
    const m = mergeCheckResults([], { files: 0, batches: 0, skipped: [], dataLike: ['dump.sql'], others: [] })
    expect(m.verdict).toBe('warn')
    expect(m.report).toContain('dump.sql: 公開するとデータの中身が丸見えになる種類のファイルです')
  })

  it('AIが未実施で、機械的な理由（dataLike・truncated）も無ければ、従来どおり skip のまま', () => {
    const m = mergeCheckResults([{ verdict: 'skip', report: 'チェックに失敗しました（timeout）。' }], { files: 0, batches: 0, skipped: [], dataLike: [], others: ['server.py'] })
    expect(m.verdict).toBe('skip')
    expect(m.report).toBe('チェックに失敗しました（timeout）。')
  })
})

// ── AI の利用量を使う場面の一覧（2026-08-21 Ryosuke 提案）────────────────
// 「AIリソースを何に使うのか」を利用者が見られるようにした。実装（AI を呼ぶ
// 経路）と文書がずれると、いちばん困る種類の嘘になるので、対応を固定する。
describe('AIの利用量を使う場面の一覧', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')

  it('使い方ガイドに一覧があり、AI を呼ぶ6つの場面が載っている', () => {
    const g = read('docs/usage-guide.html')
    expect(g).toContain('AIの利用量を使うところ')
    for (const scene of ['AIチャット（① 作る）', '画像を読む', '最初のあいさつ', '🗂 まとめ', '🛡 簡易セキュリティチェック', '公開先を変えたときの確認']) {
      expect(g).toContain(scene)
    }
  })

  it('一覧は「上限に達すると全部止まる」ことと、Claude は別勘定であることを書いている', () => {
    const g = read('docs/usage-guide.html')
    expect(g).toContain('上限に達すると、上のすべての場面で AI の呼び出しを止めます')
    expect(g).toContain('Anthropic 側の利用料')
  })

  it('AI を呼ぶ実装は、一覧に挙げた3ファイルの中だけにある', () => {
    // 増えたらここが落ちる → 一覧の更新を促す（掟9: 文書と実物を一致させる）
    const callers = ['src/renderer/hooks/useAiChat.ts', 'src/renderer/components/ChatPanel.tsx', 'src/renderer/securityCheck.ts']
    for (const f of callers) expect(read(f)).toMatch(/sakura\.chat(Stream)?\(/)
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
    expect(formatCheckRecord({ at, verdict: 'ok' })).toBe('前回の確認: 8/21 20:05 ✅ 問題なし')
  })

  it('要確認は「修正の提案あり」と分かるように表示する', () => {
    const at = new Date(2026, 7, 21, 9, 30).toISOString()
    expect(formatCheckRecord({ at, verdict: 'warn' })).toBe('前回の確認: 8/21 09:30 ⚠️ 要確認（修正の提案あり）')
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
    expect(s).toContain("if (r.verdict === 'ok' || r.verdict === 'warn') {")
    expect(s).toContain('window.localStorage.setItem(checkRecordKey(projectDir), JSON.stringify(rec))')
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
