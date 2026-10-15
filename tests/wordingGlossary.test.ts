// tests/wordingGlossary.test.ts — 画面の言葉の見張り（0.6.21・作者の決定 2026-10-01）
//
// 作者の指摘: 「平易にすることを重視するあまりに、システムでは使わないような言葉を使っている部分は
// 探し出して修正して欲しい」。普通のサービス（さくらのクラウドのコントロールパネル・AWS・Vercel など）の
// 画面で標準の用語があるものは、たとえ（合言葉・鍵・頭脳・窓・目印…）で言い換えず、その用語で言う。
// 揃え方の正は docs/wording-decisions.md の冒頭の節「作者の決定（2026-10-01）」の表。
//
// ここは**利用者の目に入る文**に、表で直した言い方が戻っていないことを見張る。
//   対象: src の .ts / .tsx の**すべて**（renderer・main・shared。main から画面へ返す文も含む）・
//         README.md・docs/usage-guide.html
//         （0.6.21 の検分: 最初は対象を components・*Text*・publishLabels・main/ipc に絞っていたため、
//          直した文の約4割しか守れていなかった。main/cloud・main/claude・shared・renderer の直下を戻しても
//          全テストが通った。対象は絞らず、例外は下の ALLOWED_LINES に理由つきで書く）
//   除く: コメント（`//`・`/* … */`・JSX の `{/* … */}`・HTML の `<!-- … -->`）。
//         コメントや変数名・ログは利用者の目に入らないので、旧い言い方が残っていてもよい。
//
// 禁じる語は、いずれも「普通の日本語として自然なものは残す」という原則から外れる（たとえ・メモ書き・
// 内輪の呼び名）ものだけ。たとえば「保存場所」「手順」「最新版」「中身を確かめる」は残すので、ここには書かない。
// 新しく画面の文を足して引っかかったら、まず表の言い方に直す。どうしても必要な普通の言い方なら、
// その行だけを RULES の allow（例外）に足す（語ごと消さない）。

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { IDE_CONTEXT, CHAT_CONTEXT } from '../src/renderer/aiContext'

const ROOT = join(__dirname, '..')

// ── 対象のファイル ──────────────────────────────────────────────────────────

/** ディレクトリの下の .ts / .tsx を、サブフォルダも含めて全部（並びは固定）。 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const ent of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`
    if (ent.isDirectory()) out.push(...listSourceFiles(rel))
    else if (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx')) out.push(rel)
  }
  return out.sort()
}

const TARGET_FILES: string[] = [
  ...listSourceFiles('src'),
  'README.md',
  'docs/usage-guide.html',
]

/**
 * 丸数字の見張りだけが追加で見る、ユーザーのプロジェクトへコピーされるテンプレート（.js / .cjs）。
 * 実行時のエラー文が利用者の目に入る（例: 保存場所の許可が通らなかったときの案内）。
 */
const TEMPLATE_FILES: string[] = ['templates/koto-data.js', 'templates/koto-data.cjs']

// ── コメントを除く（行数は保つ）────────────────────────────────────────────────

function blankKeepingNewlines(m: string): string {
  return m.replace(/[^\n]/g, '')
}

/**
 * コメントを取り除く（行番号がずれないよう、改行は残す）。
 * ・ts / tsx: `/* … *\/`（JSX の `{/* … *\/}` を含む）と、行頭または空白のあとの `//` から行末まで
 * ・html / md: `<!-- … -->`
 * 文字列の中の `//`（`https://…`）は、直前が空白でないので消えない。
 */
export function stripComments(file: string, text: string): string {
  if (file.endsWith('.html') || file.endsWith('.md')) {
    return text.replace(/<!--[\s\S]*?-->/g, blankKeepingNewlines)
  }
  return text
    .replace(BLOCK_COMMENT, blankKeepingNewlines)
    .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead)
}

/**
 * `/* … *\/` の始まり。**直前が行頭・空白・`(` `{` `[` `,` `;` のときだけ**コメントの始まりとみなす。
 * 文字列の中の `*\/*`（`Accept: 'text/html,…,*\/*;q=0.5'`）や `'src/**\/*.ts'` の `/*` は、直前が `*` や英字なので
 * 始まりにならない。前は正規表現がこれをコメントの始まりと取り違え、次の `*\/` までの30行を読み飛ばしていた
 * （src/main/ipc/web.ts・画面に出る文を含む範囲）。JSX の `{/*` は直前が `{` なので始まりになる。
 */
const BLOCK_COMMENT = /(?<![^\s({[,;])\/\*[\s\S]*?\*\//g

// ── 禁じる語 ────────────────────────────────────────────────────────────────

type Rule = {
  /** 画面や文書に出てはいけない言い方。 */
  word: string | RegExp
  /** 代わりに言う言い方（表の「揃える先」）。失敗したときの案内に使う。 */
  instead: string
  /** この行だけは普通の使い方なので許す（行ごと）。 */
  allow?: RegExp[]
}

const RULES: Rule[] = [
  // ── 作者が名指しした言い方（2026-10-01）───────────────────────────────────
  {
    word: '合言葉',
    instead: '物の名前（APIキー／APIトークン）。説明は「Koto が〇〇にアクセスするために必要な情報です」',
    // 利用者が作るアプリの「合言葉」機能の話は、Koto の言葉ではないので許す
    allow: [/アプリの「?合言葉」?/, /利用者のアプリ[^。\n]*合言葉/],
  },
  { word: '頭脳', instead: '使う AI（「Claudeモード」「IDEモードで使う AI」）' },
  { word: 'イメージの置き場', instead: 'コンテナレジストリ' },
  { word: '記録を片づける', instead: '一覧から削除' },
  { word: 'まっさら', instead: '空のプロジェクト' },
  { word: '保管場所', instead: 'リポジトリ（GitHub）' },
  // 保存場所のアクセスキーを扱う API の名前は「パーミッション」（コントロールパネルの画面名）。「権限」「アクセスキーの一覧」と言わない
  { word: /権限を作れませんでした|権限を削除できませんでした|アクセスキーの一覧を取得できませんでした/, instead: 'パーミッションを作れませんでした／削除できませんでした／パーミッションの一覧を取得できませんでした' },
  // 0.6.21（検分）: 同じ操作を別の名前で呼ばない（公開中の通知は「環境変数を Vercel に登録」）
  { word: /Koto が設定を渡|設定を Koto が渡/, instead: '環境変数を Vercel に登録する' },
  { word: '常時動く', instead: '常時起動' },
  // 手順6の見出しは「手順6 作ったものを削除する」。手順6は案内・確認・進み具合まで「削除」と言う（0.6.21・1回の流れで名前を変えない）
  // （丸数字の「⑥」は 2026-10-07 の作者の決定で「手順6」になった。丸数字そのものは下の「丸数字を使わない」の見張りが守る）
  { word: /手順6から破棄|手順6で破棄|手順6「すべて削除する」から破棄|専有型クラスタを破棄|専有型クラスタの破棄|クラスタの作成・破棄/, instead: '手順6で削除してください／専有型クラスタを削除します' },
  // 表記は空白なし（画面の既存の書き方に揃えた・0.6.21）
  { word: /IDE モード|Claude モード/, instead: 'IDEモード／Claudeモード（空白なし）' },
  // 「＝（メモ書きの形）→ 文として書く」は語では守れない（費用の式・1ドル＝…のように正しく使う所がある）。
  // 画面の文の書き方は検分で見る。
  { word: '古い鍵', instead: '古いアクセスキー' },
  { word: '新しい鍵', instead: '新しいアクセスキー' },
  { word: '保存場所の鍵', instead: '保存場所のアクセスキー' },
  { word: 'アプリの鍵', instead: 'アプリのアクセスキー' },
  { word: '通じました', instead: '接続できました' },
  { word: '通じませんでした', instead: '接続できませんでした' },
  { word: '入れもの', instead: 'コンテナ' },
  { word: '入れ物', instead: 'コンテナ' },
  { word: '秘密の値', instead: 'シークレット（環境変数の種類は「シークレット環境変数」）' },
  // 「様子を見る」のような一般の言い方もあり得るが、いま画面と文書には1つも無い。
  // 一般の言い方が要るようになったら、その行を allow に足す。
  { word: '様子', instead: '状態' },

  // ── 揃え方の表（親が決めた正）のうち、いま対象の中に1つも残っていないもの ──────────
  {
    word: /片づけ|片付け/, instead: '削除（実際に消すとき）',
    // 利用者の目に入らない、ログだけの文（console・log()・記録ファイルの書き込みに添える内部の名前）
    allow: [
      /\[cache-limit\]/,                                     // main/browserCacheLimit.ts のログ
      /console\.(log|warn|error)\(|writeMetaRaw\(|updateMetaFs\(/, // main/publishMetaFs.ts のログ用ラベル
    ],
  },
  { word: '掃除', instead: '削除' },
  { word: '実在確認', instead: '存在確認' },
  { word: '作ったものを壊す', instead: '作ったものを削除する' },
  { word: '資源', instead: 'リソース' },
  { word: '版の目印', instead: 'バージョン情報のファイル（.koto-build）' },
  { word: '起動のしかた', instead: '最小スケール' },
  { word: 'すぐ返す', instead: '常時起動' },
  // 「取り直す」そのものは普通の日本語（「状態を取り直します」）。直したのは、IP の再取得ボタンまわりの言い方
  { word: /IP を取り直|IP の取り直/, instead: '再取得（「🔄 IP を再取得」）' },
  { word: /新しい版|前の版|別の版|古い版|お使いの版/, instead: 'バージョン' },
  { word: '指紋', instead: 'フィンガープリント' },
  { word: '委譲', instead: '任せる' },
  { word: '現れません', instead: '見つかりません' },
  { word: /手続きは通り|手続き自体は通っ/, instead: '処理は完了しました' },
  { word: '名指し', instead: '名前を出す／名前を並べる' },
  { word: '段目', instead: 'ステップ（「ステップ 3／14」）' },
  { word: '部品', instead: 'データ保存用のファイル（koto-data）／ネイティブモジュール' },
  { word: '道具', instead: 'ツール' },
  { word: '雑音', instead: 'OS が自動で作るファイル' },
  { word: '司令塔', instead: '作業全体の進め方を決める（役）' },
  { word: '歯止め', instead: '仕組み／前の確認／除外' },
  { word: '心当たりがありません', instead: 'Koto の記録にありません' },
  { word: '＝課金が続きます', instead: '残っている間は課金が続きます' },
  { word: /とばしま/, instead: 'スキップしました／行いませんでした' },
  { word: /つなぐ|つながりました|繋ぎます|繋がっ|繋がる/, instead: '接続（サービス同士は「連携」）' },
  // SSH の公開鍵・秘密鍵・ホスト鍵・鍵認証は標準の用語なので、「鍵」そのものは禁じない
]

type Violation = { file: string; line: number; word: string; instead: string; text: string }

/** 1つのファイルの本文から、禁じる語が使われている行を探す。 */
export function findViolations(file: string, rawText: string, rules: readonly Rule[] = RULES): Violation[] {
  const out: Violation[] = []
  const stripped = stripComments(file, rawText).split('\n')
  const original = rawText.split('\n')
  stripped.forEach((line, i) => {
    for (const rule of rules) {
      const hit = typeof rule.word === 'string' ? line.includes(rule.word) : rule.word.test(line)
      if (!hit) continue
      if (rule.allow?.some(a => a.test(line))) continue
      out.push({
        file, line: i + 1,
        word: typeof rule.word === 'string' ? rule.word : rule.word.source,
        instead: rule.instead,
        text: (original[i] ?? '').trim().slice(0, 120),
      })
    }
  })
  return out
}

function violationsOf(rule: Rule): Violation[] {
  const out: Violation[] = []
  for (const file of TARGET_FILES) {
    out.push(...findViolations(file, readFileSync(join(ROOT, file), 'utf-8'), [rule]))
  }
  return out
}

const describeViolations = (vs: Violation[]) =>
  vs.map(v => `${v.file}:${v.line} 「${v.word}」→「${v.instead}」: ${v.text}`).join('\n')

// ── 見張り本体 ────────────────────────────────────────────────────────────────

describe('画面の言葉の見張り: 対象の取り方が正しい（空を走査して「問題なし」にならない）', () => {
  it('★ 対象に、主なファイルが入っている', () => {
    for (const must of [
      'src/renderer/components/AppRunDedicatedPanel.tsx',
      'src/renderer/components/AccessKeySection.tsx',
      'src/shared/publishLabels.ts',
      'src/shared/storageNoticeText.ts',
      'src/main/ipc/hanamii.ts',
      'src/main/ipc/cloud.ts',
      // 0.6.21（検分）: 以前は対象の外だったところ（直した文があるのに戻しても気づけなかった）
      'src/main/cloud/apprunDedicatedApply.ts',
      'src/main/cloud/apprunDedicatedAppApply.ts',
      'src/main/cloud/objectStorage.ts',
      'src/main/claude/tools.ts',
      'src/main/projectOps.ts',
      'src/main/vps/ssh.ts',
      'src/shared/inventory.ts',
      'src/shared/cloudCost.ts',
      'src/shared/updatePolicy.ts',
      'src/shared/apprunDedicatedApp.ts',
      'src/shared/teardownSupport.ts',
      'src/renderer/activity.ts',
      'src/renderer/securityCheck.ts',
      'src/renderer/apprunDedicatedActions.ts',
      'README.md',
      'docs/usage-guide.html',
    ]) {
      expect(TARGET_FILES, `${must} が対象に入っていない`).toContain(must)
    }
    // src の .ts / .tsx は 273 ファイルある（サブフォルダも含めて全部）。絞り込みに戻っていないこと
    expect(TARGET_FILES.length).toBeGreaterThan(200)
    for (const dir of ['src/main/', 'src/shared/', 'src/renderer/components/', 'src/renderer/hooks/']) {
      expect(TARGET_FILES.some(f => f.startsWith(dir)), `${dir} が対象に入っていない`).toBe(true)
    }
  })

  it('★ コメントは除く（行番号は保つ）。文字列の中の // は消さない', () => {
    const src = [
      'const a = 1 // 頭脳（行末のコメント）',
      '/* 合言葉',
      '   複数行のコメント */',
      '{/* JSX のコメント 様子 */}',
      "const url = 'https://example.com/x' // 通じました",
      "const s = '保管場所'",
      '// 行頭のコメント 入れもの',
    ].join('\n')
    const stripped = stripComments('x.tsx', src)
    expect(stripped.split('\n').length, '行数がずれている').toBe(src.split('\n').length)
    expect(stripped).not.toContain('頭脳')
    expect(stripped).not.toContain('合言葉')
    expect(stripped).not.toContain('様子')
    expect(stripped).not.toContain('通じました')
    expect(stripped).not.toContain('入れもの')
    expect(stripped).toContain("'https://example.com/x'")
    expect(stripped).toContain("const s = '保管場所'")
    // 文字列の中の `*/*`・`/*` は、コメントの始まりではない（前は次の `*/` までの何十行も読み飛ばしていた）
    const mime = [
      "headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.5' },",
      "const a = '頭脳（画面に出る文）'",
      "const glob = 'src/**/*.ts'",
      "const b = '様子（画面に出る文）'",
      '/* コメント 入れもの */',
      "const c = '通じました（画面に出る文）'",
    ].join('\n')
    const mimeStripped = stripComments('x.ts', mime)
    expect(mimeStripped).toContain("'頭脳（画面に出る文）'")
    expect(mimeStripped).toContain("'様子（画面に出る文）'")
    expect(mimeStripped).toContain("'通じました（画面に出る文）'")
    expect(mimeStripped).not.toContain('入れもの')
    expect(mimeStripped.split('\n').length).toBe(mime.split('\n').length)
    // 本物のコメント（行頭・JSX の {/* ・式の途中の /* ）は消える
    const real = stripComments('x.tsx', "f(/* 頭脳 */ 1)\n{/* 様子 */}\n  /** 入れもの\n   * 合言葉 */\nconst s = '残る'")
    expect(real).not.toContain('頭脳')
    expect(real).not.toContain('様子')
    expect(real).not.toContain('入れもの')
    expect(real).not.toContain('合言葉')
    expect(real).toContain("'残る'")
    const html = stripComments('x.html', '<p>本文</p><!-- 頭脳\n頭脳 -->\n<p>まっさら</p>')
    expect(html).not.toContain('頭脳')
    expect(html).toContain('まっさら')
    expect(html.split('\n').length).toBe(3)
  })

  it('★ コメントの除き方が暴走していない（1つの /* … */ が長すぎるのは、文字列の中の /* を拾った疑い）', () => {
    const tooLong: string[] = []
    for (const file of TARGET_FILES) {
      if (file.endsWith('.md') || file.endsWith('.html')) continue
      const text = readFileSync(join(ROOT, file), 'utf-8')
      for (const m of text.matchAll(BLOCK_COMMENT)) {
        const lines = m[0].split('\n').length
        if (lines > 80) tooLong.push(`${file}: ${lines}行`)
      }
    }
    expect(tooLong).toEqual([])
  })

  it('★ 検出器は、旧い言い方を実際に見つけ、普通の使い方は見つけない（変異試験の代わりの自己検査）', () => {
    // 見つける
    for (const bad of [
      "const t = 'Koto があなたの代わりにアクセスするための合言葉です'",
      '<p>チャットの頭脳を選ぶ</p>',
      "label: '📄 まっさら'",
      "title: '記録を片づける'",
      'msg = `保存場所の鍵を用意しています…`',
      "'🔄 IP を取り直す'",
      'この版が動いた。新しい版が動いたことを確かめました',
    ]) {
      expect(findViolations('x.tsx', bad).length, `見つけられていない: ${bad}`).toBeGreaterThan(0)
    }
    // 見つけない（コメント・SSH の鍵・利用者のアプリの合言葉・普通の言い方）
    for (const ok of [
      '// 合言葉・頭脳・まっさら（コメントなので許す）',
      "const m = 'ホスト鍵のフィンガープリントが記録済みの値と一致しません'",
      "const m = 'SSH 秘密鍵がありません（鍵認証）'",
      '利用者のアプリの合言葉の機能は、データごと引き継ぎます',
      "const m = '保存場所のアクセスキーを用意しています…'",
      "const m = '最新版に更新しました（arm64 版）'",
      "const m = '🔄 IP を再取得'",
    ]) {
      expect(findViolations('x.tsx', ok), `誤って見つけている: ${ok}`).toEqual([])
    }
  })
})

describe('画面の言葉の見張り: 表で直した言い方が、利用者の目に入る文に戻っていない（0.6.21）', () => {
  for (const rule of RULES) {
    const name = typeof rule.word === 'string' ? rule.word : rule.word.source
    it(`「${name}」は使わない（「${rule.instead}」と言う）`, () => {
      const vs = violationsOf(rule)
      expect(vs, `旧い言い方が戻っている:\n${describeViolations(vs)}`).toEqual([])
    })
  }
})

// ── 0.6.21（作者 2026-10-03）: 使う技術の「空」→「指定しない」 ─────────────────────────
// 新規作成の「📄 空のプロジェクト」と、同じ画面の「使う技術」の選択肢「空」が、2つの意味で並んでいた。
describe('使う技術の選択肢は「指定しない」（「空のプロジェクト」と取り違えない）', () => {
  const modal = readFileSync(join(__dirname, '..', 'src/renderer/components/NewProjectModal.tsx'), 'utf-8')
  it('★ 選択肢の名前と、見出しの案内が「指定しない」', () => {
    expect(modal).toContain("{ id: 'blank', label: '指定しない', hint: '最小構成（README のみ）'")
    expect(modal).toContain('使う技術（わからなければ「指定しない」のままで大丈夫です）')
    // 直す前の形に戻らない
    expect(modal).not.toContain("{ id: 'blank', label: '空',")
    expect(modal).not.toContain('わからなければ「空」のままで')
  })
})

// ── 0.6.21（作者の決定 2026-10-07）: 丸数字（①〜⑳）を使わない ─────────────────────────────
//
// 作者の指摘: 「丸印の数字は非常に見難いので使わないで欲しい」。決まったこと:
//   ・画面の手順は「手順1」「手順2」…（半角の数字・「手順」と数字のあいだに空白なし。見出しは数字のあとに半角の空白1つ）
//   ・文の中で手順を指すときも「手順N」（「③でプランを…」→「手順3でプランを…」・「⑤⑥」→「手順5・6」）
//   ・画面上部の3つのボタン（WorkflowBar）は数字なしの「作る」「試す」「公開」。ほかの画面・AI への指示でも「【試す】」「【公開】」と呼ぶ
//   ・手順ではない列挙は「(1)」「(2)」（半角の括弧と数字）
// ここは**利用者の目に入る文**（コメントを除く src の .ts / .tsx 全部・README.md・docs/usage-guide.html・
// koto-data のテンプレート）に丸数字が戻っていないことを見張る。
// 除く: コメント（上の stripComments と同じ）・CHANGELOG.md（過去の版の記録）・docs の内部文書。
//
// 例外は、**旧い呼び方を「真似しない」と AI に教えるために、わざと丸数字を書いている行**だけ（下の理由つき）。
// 丸数字のたぐい全部（①〜⑳・⓪・⓫〜⓴・㉑〜㊿・❶〜❿・➀〜➓・⑴〜⒇・⒈〜⒛）。①〜⑳ だけだと、⓪ や ㉑ 以降が戻っても通ってしまう（0.6.21 検分）。
const CIRCLED_CHARS = '\u2460-\u249B\u24EA-\u24FF\u2776-\u2793\u3251-\u325F\u32B1-\u32BF'
const CIRCLED_RE = new RegExp(`[${CIRCLED_CHARS}]`)
const CIRCLED_RULE: Rule = {
  word: CIRCLED_RE,
  instead: '「手順1」「手順2」…（列挙は「(1)」「(2)」・画面上部の3つのボタンは数字なしの「作る」「試す」「公開」）',
  allow: [
    // src/renderer/aiContext.ts: 「過去のやり取りに『② 試す』のような丸数字の古い呼び方が残っていても真似しない」と AI に伝える行
    /丸数字の古い呼び方/,
    // src/shared/aiToolsCore.ts: 会話の履歴に残っている旧い案内（【② 試す】【③ 公開】）も、繰り返し案内の抑止の照合に通す正規表現
    /const GUIDANCE_RE\s*=/,
  ],
}

// 決めた書式の揺れ（0.6.21 検分）: 「手順」と数字のあいだに空白を入れない・数字は半角・見出しは数字のあと半角の空白1つ。
// 丸数字だけを見張っていると、将来の直しで「手順 5」「手順５」「手順5クラスタを作る」「手順5: …」が入っても素通りする。
const STEP_FORMAT_RULES: Rule[] = [
  {
    // 「手順 5」（空白あり）・「手順５」（全角数字）・「手順5　クラスタ」（数字のあとが全角空白）
    word: /手順[ \u3000]+[0-9０-９]|手順[０-９]|手順[0-9]+\u3000/,
    instead: '「手順5」（半角の数字・「手順」と数字のあいだに空白なし・見出しは数字のあと半角の空白1つ）',
  },
  {
    // 「手順5クラスタを作る」（見出しで数字と名前のあいだの空白が無い）。助詞（で・の・を…）・区切り・「側」「以降」などは対象外
    word: /手順[0-9]+(?![側以内中全直前後目番])[ァ-ヶA-Za-z\u4E00-\u9FFF]/,
    instead: '見出しは「手順5 クラスタを作る」（数字のあと半角の空白1つ）',
  },
  {
    // 「手順5: …」（コロンで続ける形は使わない。名前は空白で続ける）
    word: /手順[0-9]+[:：]/,
    instead: '「手順5 クラスタを作る」（コロンを付けない）',
  },
]

const CIRCLED_TARGET_FILES: string[] = [...TARGET_FILES, ...TEMPLATE_FILES]

describe('丸数字の見張り: 対象の取り方が正しい', () => {
  it('★ 対象に、src の renderer・main/cloud・shared の直下と、README・使い方ガイド・テンプレートが入っている', () => {
    for (const must of [
      'src/renderer/aiContext.ts',
      'src/renderer/targetProfiles.ts',
      'src/renderer/importProject.ts',
      'src/main/cloud/storageForTarget.ts',
      'src/main/cloud/apprunDedicatedApply.ts',
      'src/shared/teardownSupport.ts',
      'src/shared/publishVerify.ts',
      'src/shared/aiToolsCore.ts',
      'src/renderer/components/WorkflowBar.tsx',
      'README.md',
      'docs/usage-guide.html',
      'templates/koto-data.js',
      'templates/koto-data.cjs',
    ]) {
      expect(CIRCLED_TARGET_FILES, `${must} が対象に入っていない`).toContain(must)
    }
    // CHANGELOG は過去の版の記録なので対象に入れない
    expect(CIRCLED_TARGET_FILES).not.toContain('CHANGELOG.md')
  })

  it('★ 検出器は、文字列・JSX の文の丸数字を見つけ、コメントの丸数字と例外の行は見つけない', () => {
    const find = (file: string, text: string) => findViolations(file, text, [CIRCLED_RULE])
    // 見つける（画面に出る文・AI への指示・README・ガイド）
    for (const [file, bad] of [
      ['x.tsx', '<p className="text-sm">① APIキー</p>'],
      ['x.tsx', "const msg = 'さくらのクラウドAPIキーが未登録です。①で登録してください。'"],
      ['x.ts', "return `専有型タブの⑥で削除してください。`"],
      ['x.ts', "const note = '画面上部の【② 試す】ボタンで確かめてください'"],
      ['x.js', "+ 'Koto の「③ 公開」から保存場所を用意し直すか'"],
      ['README.md', '**⑤ クラスタを作る**'],
      ['x.html', '<b>② サービスプリンシパルの ID は…</b>'],
    ] as const) {
      expect(find(file, bad).length, `見つけられていない: ${bad}`).toBeGreaterThan(0)
    }
    // 見つけない（コメント・例外の行・丸数字を使わない言い方）
    for (const [file, ok] of [
      ['x.tsx', '// ① 開発者向けのコメント'],
      ['x.tsx', '{/* ⑤ クラスタを作る */}'],
      ['x.ts', '/** ⑥ すべて削除（コメント） */'],
      ['x.html', '<!-- ② コメント -->'],
      ['x.ts', "'- **過去のやり取りに「② 試す」「③ 公開」のような丸数字の古い呼び方が残っていても、真似しないこと。**'"],
      ['x.ts', 'const GUIDANCE_RE = /画面上部の【(?:[②③]|試す】|公開】)/'],
      ['x.tsx', '<p className="text-sm">手順1 APIキー</p>'],
      ['x.ts', "const msg = '(1) Koto の設定で公開する'"],
    ] as const) {
      expect(find(file, ok), `誤って見つけている: ${ok}`).toEqual([])
    }
  })

  it('★ 例外の行が、実際にそのファイルに1つずつ存在する（直した・消したのに例外だけ残る、を防ぐ）', () => {
    const aiContext = readFileSync(join(ROOT, 'src/renderer/aiContext.ts'), 'utf-8')
    const aiToolsCore = readFileSync(join(ROOT, 'src/shared/aiToolsCore.ts'), 'utf-8')
    const hits = (text: string, re: RegExp) => text.split('\n').filter(l => re.test(l)).length
    expect(hits(aiContext, /丸数字の古い呼び方/), 'aiContext.ts の「旧い呼び方を真似しない」行').toBeGreaterThan(0)
    expect(hits(aiToolsCore, /const GUIDANCE_RE\s*=/), 'aiToolsCore.ts の GUIDANCE_RE').toBe(1)
  })
})

describe('手順の書式の見張り: 検出器が書式の揺れを見つけ、決めた形は見つけない', () => {
  const find = (file: string, text: string) => findViolations(file, text, STEP_FORMAT_RULES)

  it('★ 丸数字は ⓪・㉑〜㊿・❶〜❿ も見つける（①〜⑳ だけだと素通りする）', () => {
    for (const c of ['⓪', '⑩', '⑳', '㉑', '㊿', '❶', '❿', '⓫', '➀', '➊', '⑴']) {
      expect(CIRCLED_RE.test(c), `丸数字を見つけられていない: ${c}`).toBe(true)
    }
    for (const c of ['手順1', '(1)', '1', '１', 'A', '→', '・']) {
      expect(CIRCLED_RE.test(c), `丸数字でないものを見つけている: ${c}`).toBe(false)
    }
  })

  it('★ 「手順 5」（空白）・「手順５」（全角）・「手順5クラスタ」（空白なし）・「手順5:」（コロン）を見つける', () => {
    for (const [file, bad] of [
      ['x.tsx', '<p className="text-sm">手順 5 クラスタを作る</p>'],
      ['x.tsx', '<p className="text-sm">手順５ クラスタを作る</p>'],
      ['x.tsx', '<p className="text-sm">手順5　クラスタを作る</p>'],
      ['x.tsx', '<p className="text-sm">手順5クラスタを作る</p>'],
      ['x.tsx', '<p className="text-sm">手順1APIトークン</p>'],
      ['x.tsx', '<p className="text-sm">手順6作ったものを削除する</p>'],
      ['x.ts', "const msg = '手順5: クラスタを作る'"],
      ['x.html', '<h2>手順３ 公開</h2>'],
    ] as const) {
      expect(find(file, bad).length, `見つけられていない: ${bad}`).toBeGreaterThan(0)
    }
  })

  it('★ 決めた形（「手順5 クラスタを作る」・「手順3でプランを…」・「手順5・6」・「手順1〜3」・「手順5側」・コメント）は見つけない', () => {
    for (const [file, ok] of [
      ['x.tsx', '<p className="text-sm">手順5 クラスタを作る</p>'],
      ['x.tsx', '<p className="text-sm">手順1 APIトークン</p>'],
      ['x.tsx', '<p className="text-sm">手順4 🧹 使われていないファイルの確認</p>'],
      ['x.ts', "const msg = '手順3でプランを取得できたら、手順5へ進みます'"],
      ['x.ts', "const msg = '手順5・6を順に行います（手順1〜3は済んでいます）'"],
      ['x.ts', "const msg = '手順10の次に手順11があります'"],
      ['x.ts', "const msg = '手順5側の設定と、手順8以降の設定は別です'"],
      ['x.ts', "const msg = '共用型タブの手順8「ログ・メトリクス」を開きます'"],
      ['x.ts', '// 手順5クラスタを作る（コメントは対象外）'],
      ['x.tsx', '{/* 手順 5: 開発者向けのコメント */}'],
    ] as const) {
      expect(find(file, ok), `誤って見つけている: ${ok}`).toEqual([])
    }
  })
})

describe('手順の書式の見張り: 利用者の目に入る文に、書式の揺れが無い（作者の決定 2026-10-07）', () => {
  it('★ src の .ts / .tsx 全部・README.md・docs/usage-guide.html・テンプレートに、「手順 5」「手順５」「手順5クラスタ」「手順5:」が無い（コメントを除く）', () => {
    const vs: Violation[] = []
    for (const file of CIRCLED_TARGET_FILES) {
      vs.push(...findViolations(file, readFileSync(join(ROOT, file), 'utf-8'), STEP_FORMAT_RULES))
    }
    expect(vs, `手順の書式が揺れている:\n${describeViolations(vs)}`).toEqual([])
  })
})

describe('丸数字の見張り: 利用者の目に入る文に丸数字（①〜⑳など）が無い（作者の決定 2026-10-07）', () => {
  it('★ src の .ts / .tsx 全部・README.md・docs/usage-guide.html・テンプレートに、丸数字が無い（コメントを除く）', () => {
    const vs: Violation[] = []
    for (const file of CIRCLED_TARGET_FILES) {
      vs.push(...findViolations(file, readFileSync(join(ROOT, file), 'utf-8'), [CIRCLED_RULE]))
    }
    expect(vs, `丸数字が戻っている（「手順N」・列挙は「(N)」・3つのボタンは数字なしにする）:\n${describeViolations(vs)}`).toEqual([])
  })

  it('★ 画面上部の3つのボタン（WorkflowBar）の名前は、数字なしの「作る」「試す」「公開」', () => {
    const bar = readFileSync(join(ROOT, 'src/renderer/components/WorkflowBar.tsx'), 'utf-8')
    const text = stripComments('WorkflowBar.tsx', bar)
    for (const label of ['作る', '試す', '公開']) {
      expect(text, `WorkflowBar に「${label}」のボタン名が無い`).toContain(`<span className="text-xs font-semibold text-ink">${label}</span>`)
    }
    expect(text).not.toMatch(/[①-⑳]\s*(作る|試す|公開)/)
  })

  it('★ 3つのボタンに、数字のバッジ（ボタン名の左の「1」「2」「3」）を付けない（並び順で順番が分かる・作者の決定 2026-10-07）', () => {
    const bar = readFileSync(join(ROOT, 'src/renderer/components/WorkflowBar.tsx'), 'utf-8')
    const text = stripComments('WorkflowBar.tsx', bar)
    // <span …>1</span> のように、数字だけを入れた span（バッジ）が無い
    expect(text, 'WorkflowBar に数字だけのバッジ（<span>1</span> など）が戻っている').not.toMatch(/<span[^>]*>\s*[0-9０-９]\s*<\/span>/)
    // バッジの見た目（ピンクの角丸の小さな四角）の指定も無い。3つのボタンの並びの中に、数字を入れる枠を作らない
    expect(text, 'WorkflowBar にバッジの見た目の指定が戻っている').not.toContain('rounded-md w-4 h-4')
  })

  it('★ 使い方ガイドの3つの章の見出し（AIと一緒に作る・試す・公開する）にも、数字のバッジを付けない', () => {
    const guide = readFileSync(join(ROOT, 'docs/usage-guide.html'), 'utf-8')
    const text = stripComments('docs/usage-guide.html', guide)
    expect(text, '使い方ガイドの見出しに数字のバッジ（class="num"）が戻っている').not.toMatch(/class="num"/)
    expect(text, '使い方ガイドに h2 .num の指定が残っている（使われていない CSS）').not.toContain('h2 .num')
    // h2 が数字で始まらない（「1 AIと一緒に作る」のような見出しにしない）
    expect(text, '使い方ガイドの見出しが数字で始まっている').not.toMatch(/<h2[^>]*>\s*[0-9０-９]/)
  })
})

describe('AI への指示: 旧い丸数字の呼び方を真似させず、いまの呼び方を教える（作者の決定 2026-10-07）', () => {
  for (const [name, ctx] of [['IDE_CONTEXT（IDEモード）', IDE_CONTEXT], ['CHAT_CONTEXT（チャットモード）', CHAT_CONTEXT]] as const) {
    it(`★ ${name} に「過去のやり取りに丸数字の古い呼び方が残っていても真似しない」「いまは試す・公開（数字なし）・手順N」と書いてある`, () => {
      expect(ctx).toContain('過去のやり取りに「② 試す」「③ 公開」のような丸数字の古い呼び方が残っていても、真似しないこと')
      expect(ctx).toContain('いまの呼び方は「試す」「公開」（数字なし）')
      expect(ctx).toContain('「手順1」「手順2」')
    })

    it(`★ ${name} の、画面を案内する文は【試す】【公開】（数字なし）で呼び、丸数字つきの呼び方で案内していない`, () => {
      // 旧い呼び方の例として挙げている1行（上の「真似しないこと」）を除いて、丸数字が無い
      const rest = ctx.split('\n').filter(l => !l.includes('丸数字の古い呼び方')).join('\n')
      expect(rest, '案内の文に丸数字が戻っている').not.toMatch(CIRCLED_RE)
    })
  }
})
