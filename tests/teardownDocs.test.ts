import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEDICATED_TEARDOWN_WORDS, dnsRecordNote } from '../src/renderer/teardown/targets/dedicated'
import { HANAMII_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/hanamii'
import { SHARED_TEARDOWN_WORDS } from '../src/renderer/teardown/targets/shared'
import { adoptedRegistryNote, sharedRegistryNote, unknownOriginRegistryNote } from '../src/shared/cloudCost'

// ── 段階3B（3B-8）: 文書が実物と食い違わないことの固定（CLAUDE.md 掟9） ─────────────────────────────────────────────
// 設計書 docs/teardown-unify-plan.md の 10.11.16 の 1〜7・9・10。専有型を共通の部品へ載せ替えたあと、文書が言うこと
// （ボタンの名前・DNS の A レコードの1行・保存場所だけ残った回は行を残す・3つの公開先で共通・CLAUDE.md の表・
//  DNS の計画書が指す場所・削減の一覧・ロードバランサの記録）を、**実物の文から引いて**突き合わせる。
// 文書の文を実装と別々に書くと、片方だけ直されても誰も気づかない（掟9・掟10「複製すると片方だけ直される」）。
// 3A の既存の固定（README・ガイドの「進み具合は削除の画面に出ない」「注意だけ更新」の引用）は tests/projectDeleteEntries.test.ts の F-9。

const ROOT = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')
const README = read('README.md')
const GUIDE = read('docs/usage-guide.html')
const CLAUDE = read('CLAUDE.md')
const DNS_PLAN = read('docs/dns-assist-plan.md')
const ROADMAP = read('docs/roadmap.md')
const DECISIONS = read('docs/wording-decisions.md')
const DEDICATED_PLAN = read('docs/apprun-dedicated-plan.md')

const DOCS = [['README.md', README], ['docs/usage-guide.html', GUIDE]] as const

describe('D10: README・ガイドが引く DNS の A レコードの1行は、仕様書の dnsRecordNote と同じ文', () => {
  const withHost = dnsRecordNote({ loadBalancerID: 'lb1', hosts: ['app.example.com'] })!
  const nameless = dnsRecordNote({ loadBalancerID: 'lb1' })!

  it('★★ ホスト名つきの文（例の app.example.com 入り）を、README にもガイドにも1文字も変えずに引いている', () => {
    expect(withHost).toContain('🌐 DNS に app.example.com の A レコードがあれば')
    for (const [name, doc] of DOCS) expect(doc, name).toContain(`「${withHost}」`)
  })

  it('★★ ホスト名が無い回の文の書き出しも、実物と同じ（文の続きは「…」で省く）', () => {
    const head = nameless.slice(0, nameless.indexOf('、DNS の管理画面で'))
    expect(head).toBe('🌐 独自ドメインの DNS に、このロードバランサを指す A レコードがあれば')
    for (const [name, doc] of DOCS) expect(doc, name).toContain(`「${head}、…」`)
  })

  it('★ 「割り当てられるかは確かめていません」と、Koto は DNS を読まず変更もしないことを、README にもガイドにも言う（確かめていないことを断定しない）', () => {
    for (const [name, doc] of DOCS) {
      expect(doc, name).toContain('実際に割り当てられるかは確かめていません')
      expect(doc, name).toContain('Koto は DNS を読まず、変更もしません')
    }
  })
})

describe('ボタンの名前: 専有型の行は「🗑 削除」、共用型・HANAMII は「🗑 破棄」（言葉の rowButton）', () => {
  it('★★ 言葉の rowButton が、README・ガイドの言う名前と同じ', () => {
    expect(DEDICATED_TEARDOWN_WORDS.rowButton).toBe('🗑 削除')
    expect(HANAMII_TEARDOWN_WORDS.rowButton).toBe('🗑 破棄')
    expect(SHARED_TEARDOWN_WORDS.rowButton).toBe('🗑 破棄')
    expect(README).toContain('専有型の行のボタンは「🗑 削除」で')
    expect(GUIDE).toContain('専有型の行のボタンは「🗑 削除」で')
    expect(README).toContain('**🗑 破棄**（専有型は **🗑 削除**）')
    expect(GUIDE).toContain('<b>🗑 破棄</b>（さくらのAppRun 専有型は <b>🗑 削除</b>）')
    expect(README).toContain('そこの 🗑 削除は、手順6「すべて削除する」と**同じ削除**')
    expect(GUIDE).toContain('「公開したもの一覧」の 🗑 削除で削除します')
  })

  it('★★ 専有型を「🗑 破棄」と呼ぶ直す前の言い方が戻っていない（README・ガイド）', () => {
    for (const [name, doc] of DOCS) {
      expect(doc, `${name}: 専有型の一覧の行を「🗑 破棄」と呼んでいる`).not.toContain('そこの 🗑 破棄は、手順6')
      expect(doc, `${name}: 専有型の行の 🗑 を「同じ削除です」だけで済ませ、ボタンの名前を言わない`).not.toContain('専有型の行の 🗑 は、専有型タブの手順6')
      expect(doc, `${name}: 「🗑 破棄」が専有型にも出ると言っている`).not.toContain('さくらのAppRun（共用型・専有型）と HANAMII に出ます')
      expect(doc, `${name}: 共用型・HANAMII の方が専有型に合わせる言い方に戻っている`).not.toMatch(/共用型と HANAMII の 🗑 も、専有型と同じ形/)
    }
    expect(GUIDE, '一覧の 🗑 破棄で削除する、と専有型を指している').not.toContain('「公開したもの一覧」の 🗑 破棄で削除します')
  })
})

describe('D1: 保存場所だけが残った回は、📡 の行を残す（README・ガイドが言うことと、画面の文が同じ）', () => {
  const modal = read('src/renderer/components/PublishedListModal.tsx')

  it('★★ 行を残し、その行のボタンをもう一度押すと残った保存場所だけを削除する、と README・ガイドと画面の案内が同じことを言う', () => {
    expect(modal).toContain('保存場所だけが残りました。この行の「${dedicatedTeardownSpec.words.rowButton}」をもう一度押すと、残った保存場所だけを削除します。')
    expect(README).toContain('アプリなどは消えて保存場所だけが残ったときは行を残すので、その行の 🗑 削除をもう一度押すと、残った保存場所だけを削除します')
    expect(GUIDE).toContain('アプリなどは消えて保存場所だけが残ったときは<b>行を残す</b>ので、その行の <b>🗑 削除</b>をもう一度押すと、残った保存場所だけを削除します')
    for (const [name, doc] of DOCS) expect(doc, name).toContain('保存場所が2つ以上あって途中で止まったときは、残った保存場所を全部の名前で出します')
  })

  it('★★ 「保存場所だけが残っても行は消える」と言う直す前の文が戻っていない', () => {
    for (const [name, doc] of DOCS) {
      expect(doc, name).not.toContain('保存場所だけが残ったときも行は消えますが')
      expect(doc, name).not.toContain('そこから手順6を押し直せます')
    }
  })

  it('★ 行を残す例に、HANAMII だけでなく専有型を挙げている（README・ガイド）', () => {
    expect(README).toContain('たとえば HANAMII のプロジェクトや専有型のクラスタは削除できたのに保存場所を削除できなかったとき')
    expect(GUIDE).toContain('たとえば HANAMII のプロジェクトや専有型のクラスタは削除できたのに、保存場所だけ削除できなかったとき')
  })
})

describe('3つの公開先で共通（README・ガイド・CLAUDE.md の表）', () => {
  it('★★ README・ガイドの見出しは「3つで共通の形」。ただし進み具合が削除の画面に出ないという 3A の約束の文は残っている', () => {
    expect(README).toContain('**さくらのAppRun 共用型・専有型と HANAMII の 🗑 は、3つで共通の形です。**')
    expect(GUIDE).toContain('<b>共用型・専有型・HANAMII の 🗑 は、3つで共通の形</b>')
    for (const [name, doc] of DOCS) {
      expect(doc, name).toContain('、破棄している間にウィンドウを閉じようとしたときの警告、結果が同じに出ます。ただし進み具合は、プロジェクトの削除の画面には出ません')
    }
  })

  /** CLAUDE.md の掟10の表で、「破棄の流れ」の行（1行）。 */
  const row = CLAUDE.split('\n').filter(l => l.startsWith('| 破棄の流れ（'))
  const cells = (row[0] ?? '').split(' | ')

  it('★★ 表に「破棄の流れ」の行が1つだけあり、3つの公開先で共通の1つと言う。手本の名前と「3B まで」「手本を直したら」は残っていない', () => {
    expect(row).toHaveLength(1)
    expect(cells.length).toBeGreaterThanOrEqual(3)
    expect(row[0]).toContain('**3つの公開先で共通の1つ**')
    expect(row[0]).toContain('記録を消すのは破棄が最後まで済んだ（保存場所まで片づいた）回だけ（D1）')
    for (const old of ['dedicatedTeardownFlow', '3B まで', '手本を直したら', '手本が同じ形で並んでいる', '共用型・HANAMII は共通の部品、専有型は']) {
      expect(row[0], `直す前の言い方「${old}」が残っている`).not.toContain(old)
    }
    // 専有型だけの事実は残す（手順6と 📡 の 🗑 は同じ・公開の記録を消す規則・「消すものがあるか」の判断）
    for (const keep of ['shouldForgetPublishRecord', 'dedicatedTeardownHasWork', '手順6と 📡 の 🗑 は同じこれ']) expect(row[0], keep).toContain(keep)
  })

  it('★★ 表が挙げる src のファイル・ディレクトリ・3つの IPC のファイル・テストは、実際にある（挙げて無いものが無い）', () => {
    const where = cells[1]
    const tests = cells[2]
    // リンクの宛先（src/…）
    const linked = [...where.matchAll(/\]\((src\/[^)]+)\)/g)].map(m => m[1])
    expect(linked.sort()).toEqual([
      'src/main/cloud/teardownShell.ts', 'src/renderer/components/teardown/', 'src/renderer/teardown/', 'src/shared/teardownResult.ts',
    ])
    for (const rel of linked) expect(existsSync(join(ROOT, rel)), rel).toBe(true)
    // 共通の部品のファイル（`flow.ts` など。teardown/ の中）と、targets/{dedicated,shared,hanamii}.ts
    for (const f of ['flow.ts', 'confirm.ts', 'facts.ts', 'watch.ts']) {
      expect(where, f).toContain(`\`${f}\``)
      expect(existsSync(join(ROOT, 'src/renderer/teardown', f)), f).toBe(true)
    }
    expect(where).toContain('`targets/{dedicated,shared,hanamii}.ts`')
    for (const f of ['dedicated', 'shared', 'hanamii']) expect(existsSync(join(ROOT, `src/renderer/teardown/targets/${f}.ts`)), f).toBe(true)
    // 3つの IPC
    for (const f of ['apprunDedicatedTeardown', 'cloudTeardown', 'hanamiiTeardown']) {
      expect(where, f).toContain(`ipc/${f}.ts`)
      expect(existsSync(join(ROOT, `src/main/ipc/${f}.ts`)), f).toBe(true)
    }
    // テスト
    const tested = [...tests.matchAll(/`(tests\/[A-Za-z0-9]+\.test\.ts)`/g)].map(m => m[1])
    expect(tested).toEqual([
      'tests/teardownFlowCommon.test.ts', 'tests/teardownShell.test.ts', 'tests/dedicatedTeardownShell.test.ts', 'tests/hanamiiTeardownEntries.test.ts',
      'tests/sharedTeardownEntries.test.ts', 'tests/dedicatedTeardownEntries.test.ts', 'tests/dedicatedTeardownEntriesF.test.ts',
    ])
    for (const rel of tested) expect(existsSync(join(ROOT, rel)), rel).toBe(true)
  })
})

describe('DNS の計画書（0.6.23）は、消えた手本ではなく新しい場所を指す。D10 の1行と D2 を二重にしない', () => {
  it('★★ 消した手本の名前（単語の境界つき）が出ない。新しい場所の名前が出る', () => {
    for (const old of [/\bdedicatedTeardownFlow\b/, /\bbuildDedicatedTeardownConfirm\b/, /\brunDedicatedTeardown\b/, /\buseDedicatedTeardown\b/, /\bteardownConfirmMessage\b/]) {
      expect(DNS_PLAN, `消した手本の名前 ${old} が残っている`).not.toMatch(old)
    }
    for (const now of ['dnsRecordNote', 'DEDICATED_TEARDOWN_SHELL', 'src/main/ipc/apprunDedicatedTeardown.ts', 'runTeardownFlow', 'targets/dedicated.ts']) {
      expect(DNS_PLAN, now).toContain(now)
    }
    expect(DNS_PLAN, '「いまの手順6には DNS の案内が1行も無い」は D10 が入って事実でなくなった').not.toContain('いまの手順6には DNS の案内が1行も無い')
  })

  it('★★ Koto が書いた A があるとき、dnsRecordNote は D2 の文に差し替える（同じ事実を確認に2回言わない）', () => {
    expect(DNS_PLAN).toContain('`dnsRecordNote` は D2 の文（その A を名指しして消す）に**差し替える**')
  })
})

describe('roadmap・wording-decisions・専有型の計画書の注記', () => {
  it('★ roadmap: 0.6.22 の行に「段階3B が済んだ」。実機はまだ。複製したフォルダの件は 0.6.23', () => {
    expect(ROADMAP).toContain('段階3B（専有型の載せ替え・二重の解消）も済んだ')
    expect(ROADMAP).toContain('実際の画面・キー・さくらのクラウドでは、まだ一度も通していない')
    expect(ROADMAP, '3B はもう「残り」ではない').not.toContain('**残りは段階3B**')
    expect(ROADMAP, '複製したフォルダの件を 0.6.22 で扱うと言っている').not.toContain('0.6.22 の破棄の統一と一緒に扱う')
    expect(ROADMAP).toContain('複製したフォルダから元のクラスタを消せる（0.6.23 で3つの公開先まとめて')
    expect(ROADMAP).toContain('3B の外の別の単位として 0.6.22 に入れる')
  })

  it('★ wording-decisions: 📡 の専有型の行のボタンは 3B で「🗑 削除」にした。鍵の案内は3つとも名前だけ（ID の末尾は添えない）', () => {
    expect(DECISIONS).toContain('0.6.22 段階3B で「🗑 削除」にした')
    expect(DECISIONS, '3B で「にする」と未来形のまま').not.toContain('段階3B で「🗑 削除」にする')
    expect(DECISIONS).toContain('パーミッションの ID の末尾は添えない')
  })

  it('★ 専有型の計画書: 履歴の本文は直さず、3B の注記だけを足した', () => {
    expect(DEDICATED_PLAN).toContain('⑥の `buildTeardownSummary` にアプリの行（「アプリ『name』（バージョン n）→ 先に削除」）')
    expect(DEDICATED_PLAN).toContain('0.6.22 段階3B-6b（T022）でこの行は消した')
    expect(DEDICATED_PLAN).toContain('0.6.22 段階3B: 共通の部品（`src/renderer/teardown/`・main の骨 `teardownShell`）へ載せ替えた')
    expect(DEDICATED_PLAN).toContain('保存場所まで片づいたか〔`ok`〕')
  })
})

// ── コンテナレジストリを最初から消す設定にしない場面: 文書が、実物の断りと同じことを言う（掟9・2026-10-19） ─────────────────
// 断りは3つ（借りたもの・作ったか分からないもの・ほかのプロジェクトが使っているもの）。ガイドは引き継ぎの節ではなく、破棄を説明する
// 「公開をやめる」の節で言う（引き継ぎをしていない人も辿り着く）。お金の結果（入れずに破棄すると月額220円が続く）も、そこと更新履歴で言う。
describe('コンテナレジストリの既定オフの断り: ガイド・README・更新履歴が、実物の文と同じことを言う', () => {
  const CHANGELOG = read('CHANGELOG.md')
  const between = (doc: string, from: string, to: string): string => {
    const a = doc.indexOf(from)
    const b = doc.indexOf(to, a)
    expect(a, from).toBeGreaterThanOrEqual(0)
    expect(b, to).toBeGreaterThan(a)
    return doc.slice(a, b)
  }
  const STOP = between(GUIDE, '公開をやめる（🗑 破棄・🗑 削除）', '<h2>簡易セキュリティチェック')
  const IMPORT = between(GUIDE, '<h2>公開しているものをインポートする</h2>', '<h2>AIと一緒に作る</h2>')
  const UNRELEASED = between(CHANGELOG, '## [0.6.22]', '\n## [')
  const entry = UNRELEASED.split('\n').find(l => l.includes('コンテナレジストリを、最初から消す設定にしないようにしました'))!

  it('★★ ガイドの「公開をやめる」が、3つの断りの文を、実物の書き出しのまま引いている', () => {
    const adopted = 'このプロジェクトのために作ったものではありません'
    const unknown = 'このプロジェクトのために作ったか分かりません'
    expect(adoptedRegistryNote('x')).toContain(adopted)
    expect(unknownOriginRegistryNote('x')).toContain(unknown)
    expect(sharedRegistryNote('x', ['a'])).toContain('ほかのプロジェクト（a）も、このコンテナレジストリ『x』を使っています。')
    expect(STOP).toContain(`「${adopted}」`)
    expect(STOP).toContain(`「${unknown}」`)
    expect(STOP).toContain('「ほかのプロジェクト（…）も、このコンテナレジストリ『…』を使っています」')
    // 旧い断り（借りたものを Koto が作ったものではないと言う文）は、どこにも残さない
    for (const [name, doc] of [...DOCS, ['CHANGELOG.md', CHANGELOG]] as const) expect(doc, name).not.toContain('Koto が作ったものではありません')
  })

  it('★★ 「作ったか分からない」の説明は、引き継ぎの節ではなく「公開をやめる」にある。0.3.43 より前に作ったものがここに入ることも言う', () => {
    expect(IMPORT).not.toContain('作ったか分かりません')
    expect(IMPORT).toContain('「公開」の「公開をやめる」')
    expect(STOP).toContain('0.3.43 より前に Koto が作ったコンテナレジストリも、印が無いのでここに入ります')
  })

  it('★★ お金の結果を言う: チェックを入れずに破棄すると、月額220円（税込）が続く（ガイドにも更新履歴にも）', () => {
    expect(STOP).toContain('チェックを入れずに破棄すると、コンテナレジストリの月額220円（税込）が続きます')
    expect(entry).toContain('0.3.43 より前に Koto が作ったコンテナレジストリも、記録に印が無いのでここに入ります')
    expect(entry).toContain('入れずに破棄すると、コンテナレジストリの月額220円（税込）が続きます')
  })

  it('★ 最初からオンなのは「作ったと記録にあり、同じフォルダのほかのプロジェクトが使っていないもの」だけ。README・ガイド・更新履歴で同じ', () => {
    const on = 'Koto がこのプロジェクトのために作ったと記録にあり、同じフォルダのほかのプロジェクトが使っていないものだけ'
    expect(README).toContain(on)
    expect(STOP).toContain(on)
    expect(entry).toContain(on)
    expect(STOP).toContain('別のフォルダにあるプロジェクトは調べません')
    expect(entry).toContain('別のフォルダにあるプロジェクトは調べません')
  })
})
