import { describe, it, expect } from 'vitest'
import { publishButtonLabel, publishFailureHintText, dnsGuidanceLines, publishHeadline, showDnsGuidanceExpanded, containerStateSummary, ephemeralDataNote } from '../src/shared/publishLabels'

// 委譲仕様 UX-E・判断8: 公開ボタンの文言を1関数に一元化する。
// HANAMII「再公開する」・AppRun共用型「公開する（作成・更新）」・専有型/Vercel「公開する」の
// 3通りを「🚀 公開する」／「🚀 公開する（更新）」の2つに揃える。

describe('publishButtonLabel: 公開ボタンの文言（純関数）', () => {
  it('未公開（published=false）なら「🚀 公開する」', () => {
    expect(publishButtonLabel(false)).toBe('🚀 公開する')
  })

  it('公開済み（published=true）なら「🚀 公開する（更新）」', () => {
    expect(publishButtonLabel(true)).toBe('🚀 公開する（更新）')
  })
})

// D-4f: 専有型⑧の失敗表示に付ける hint:'reset-registry' の案内文（共用型タブへの誘導）。
describe('publishFailureHintText: 公開失敗の hint 案内文（純関数）', () => {
  it("hint:'reset-registry' なら、共用型タブへ誘導する1文を返す", () => {
    const text = publishFailureHintText('reset-registry')
    expect(text).toContain('共用型タブ')
    expect(text).toContain('レジストリを設定し直す')
  })

  it('hint が無い（undefined）なら null', () => {
    expect(publishFailureHintText(undefined)).toBeNull()
  })

  it('知らない hint 値（将来の追加を想定）なら null（推測で文言を出さない）', () => {
    expect(publishFailureHintText('something-else')).toBeNull()
  })
})

// D-4h（2026-09-16 実機で判明）: 専有型のロードバランサはホスト名でアプリを振り分けるため、
// IP を直接ブラウザで開くと 404 page not found になる（アプリの不調ではない）。
// https は DNS の A レコードを向けたあと、Let's Encrypt が証明書を発行するまで開けない
// （かかる時間は、実際のさくらのサーバーではまだ確認できていない・D-13 B／掟1）。
describe('dnsGuidanceLines: ⑧の DNS 案内文（純関数）', () => {
  it('IP を直接開くと 404 になること・ホスト名で開くことを含む', () => {
    const lines = dnsGuidanceLines('app.example.com')
    const joined = lines.join('\n')
    expect(joined).toContain('404 page not found')
    expect(joined).toContain('ホスト名')
  })

  // D-13 B（2026-09-16）: ここだけが所要時間を「数分で」と断定しており、README・使い方ガイド・
  // CHANGELOG・計画書（「発行にかかる時間は確認できていない」）と食い違っていた。
  // **画面の文言だけが断定している**状態は、利用者がいちばん早く読む場所なのでいちばん悪い。
  it('★★ https は「向けたあとに使えるようになる見込み」までにし、所要時間を断定しない（他の文書と揃える）', () => {
    const lines = dnsGuidanceLines('app.example.com')
    const joined = lines.join('\n')
    expect(joined).toContain('https')
    expect(joined).toContain('使えるようになる見込み')
    expect(joined).toContain('確認できていません')
    // 直す前の断定に戻っていないこと
    expect(joined, '所要時間を断定している').not.toContain('数分で使えるようになります')
    expect(joined).not.toContain('数分')
  })

  it('渡したホスト名がそのまま文中に反映される', () => {
    const lines = dnsGuidanceLines('my-app.example.jp')
    expect(lines.join('\n')).toContain('my-app.example.jp')
  })

  it('2行を返す（404 の注意・https の注意）', () => {
    expect(dnsGuidanceLines('app.example.com')).toHaveLength(2)
  })
})

// ── publishHeadline（D-7・2026-09-16 実機で判明）────────────────────────────
// 専有型の⑧で、公開の手続きは全段通ったのに、ロードバランサが 503 `no available server` を
// 返し続けていた（＝LB から見て健全なバックエンドが1つも登録されていない。コンテナ自体が
// 起動していたかは未確認＝docs/apprun-dedicated-plan.md 5-13）。それでも画面は
// 「✅ 公開しました」と出していた。**確かめていないことを「大丈夫」に倒さない。**
// 見出しの判断はここ（純関数）に置き、画面は描くだけ（掟10）。

describe('publishHeadline: ⑧の公開結果の見出し（純関数・D-7）', () => {
  it('★★ no-backend（503＝アプリが応答していない）なら、「公開しました」と言わず警告に倒す', () => {
    const h = publishHeadline('no-backend')
    expect(h.tone).toBe('warn')
    expect(h.text).toBe('⚠️ 公開の手続きは通りましたが、アプリがまだ応答していません')
    expect(h.text).not.toContain('✅')
  })

  // B（D-7b・検分の指摘）: 画面（AppRunDedicatedPanel.tsx）は文言を素の <p> に流すだけで
  // Markdown を解釈しない。`**` が混ざると記号がそのまま画面に出る欠陥だった。
  it('★★ 返す text に ** を含まない（画面は Markdown を解釈しない）', () => {
    for (const verify of ['ok', 'stale', 'responding', 'no-backend', 'unreachable', undefined, null] as const) {
      expect(publishHeadline(verify).text).not.toContain('**')
    }
  })

  it('★ ok（応答を確認できた）なら「✅ 公開しました」', () => {
    expect(publishHeadline('ok')).toEqual({ text: '✅ 公開しました', tone: 'ok' })
  })

  it('★ stale / unreachable は、公開の手続き自体は通っているので見出しは「✅ 公開しました」のまま（一文は画面が添える）', () => {
    expect(publishHeadline('stale')).toEqual({ text: '✅ 公開しました', tone: 'ok' })
    expect(publishHeadline('unreachable')).toEqual({ text: '✅ 公開しました', tone: 'ok' })
  })

  it('★ 未確認（当てに行く先が無くてとばした）でも「✅ 公開しました」（とばした理由は warnings に載る）', () => {
    expect(publishHeadline(undefined)).toEqual({ text: '✅ 公開しました', tone: 'ok' })
    expect(publishHeadline(null)).toEqual({ text: '✅ 公開しました', tone: 'ok' })
  })

  // D-19: Node アプリなどで、根（/）へ当てて応答があった結果。**警告に倒すのは no-backend だけ**
  // （仕様 A）。中身の新しさまでは確かめていないことは、見出しではなく一文
  // （dedicatedVerifyMessage('responding')）のほうが断る。
  it('★★ responding（応答は確認できた・中身の新しさは未確認）は成功の見た目のまま', () => {
    expect(publishHeadline('responding')).toEqual({ text: '✅ 公開しました', tone: 'ok' })
  })
})

// ── showDnsGuidanceExpanded（D-7b・C・検分の指摘）────────────────────────────
// 2026-09-16 の実害は「応答しないアプリのために DNS を設定しに行った」こと。no-backend
// （503）のときは、DNS の案内より先にアプリの応答を確かめてもらうため、次の一手を1つに絞る。

describe('showDnsGuidanceExpanded: DNS の案内を最初から開いてよいか（純関数・D-7b・C）', () => {
  it('★★ no-backend のときだけ false（<details> に畳む）', () => {
    expect(showDnsGuidanceExpanded('no-backend')).toBe(false)
  })

  it('★ それ以外（ok/responding/stale/unreachable）・未確認（undefined/null）は true（開いたまま）', () => {
    expect(showDnsGuidanceExpanded('ok')).toBe(true)
    expect(showDnsGuidanceExpanded('responding')).toBe(true) // D-19: 応答しているので DNS へ進んでよい
    expect(showDnsGuidanceExpanded('stale')).toBe(true)
    expect(showDnsGuidanceExpanded('unreachable')).toBe(true)
    expect(showDnsGuidanceExpanded(undefined)).toBe(true)
    expect(showDnsGuidanceExpanded(null)).toBe(true)
  })
})

// ── containerStateSummary（D-8・2026-09-16 実機）────────────────────────────────
// verify が no-backend のときに引いた「いまのコンテナの様子」を1行にする。
// **状態の文字列は原本の値のまま出す**（勝手に日本語へ言い換えない・掟1。全ての値を実測していない）。
describe('containerStateSummary: いまのコンテナの様子（純関数・D-8）', () => {
  it('★0件なら「コンテナが1つも動いていません。」（空文字を返さない＝何も出ないと事故に戻る）', () => {
    expect(containerStateSummary([])).toBe('コンテナが1つも動いていません。')
  })

  // 検分の指摘（2026-09-16）: 以前は null/undefined も0件と同じ文に倒していた。それは
  // 「引けなかった」を「1つも動いていません」と**断定**することで、D-7 の `unknown-read-as-ok`
  // と同じ形。呼び出し側（publishAppFlow）は引けなければ containerStates を付けないので本来
  // ここへは来ないが、**間違って渡されたときにも嘘を言わない**ことを固定する。
  it('★★ 配列でない（＝引けていない）なら「1つも動いていません」と言い切らない', () => {
    expect(containerStateSummary(null)).toBe('いまのコンテナの様子を読み取れませんでした（何台動いているかは分かりません）。')
    expect(containerStateSummary(undefined)).toBe('いまのコンテナの様子を読み取れませんでした（何台動いているかは分かりません）。')
    expect(containerStateSummary(null)).not.toContain('1つも動いていません')
    expect(containerStateSummary(undefined)).not.toContain('1つも動いていません')
    // **「分からない」ことがその場で読めること。**「取得できませんでした」だけだと0件と同じに
    // 読まれうる（2026-09-16 の是正）。直す前の文面に戻っていないことも見る。
    expect(containerStateSummary(null)).toContain('分かりません')
    expect(containerStateSummary(null)).not.toBe('いまのコンテナの様子は取得できませんでした。')
    // 理由（応答の形が違う／HTTP が失敗した）までは断定しない——渡された null がどちらかは
    // この関数からは分からない。理由は呼び出し側が warnings に残す（掟1）。
    expect(containerStateSummary(null)).not.toContain('形')
  })

  it('1件なら「いまのコンテナの様子: state（status）」', () => {
    expect(containerStateSummary([{ state: 'running', status: 'healthy' }]))
      .toBe('いまのコンテナの様子: running（healthy）')
  })

  it('★状態の文字列は原本の値のまま（日本語へ言い換えない）', () => {
    const text = containerStateSummary([{ state: 'CrashLoopBackOff', status: 'restarting' }])
    expect(text).toContain('CrashLoopBackOff')
    expect(text).toContain('restarting')
    // 勝手な対訳（「再起動中」「異常」等）を足していないこと
    expect(text).not.toContain('再起動中')
    expect(text).not.toContain('異常')
  })

  it('複数（違う状態）は「・」で並べる', () => {
    expect(containerStateSummary([
      { state: 'running', status: 'healthy' },
      { state: 'CrashLoopBackOff', status: 'restarting' },
    ])).toBe('いまのコンテナの様子: running（healthy）・CrashLoopBackOff（restarting）')
  })

  it('複数（同じ状態）は「× 台数」にまとめる（台数が多いときに読めなくなるため）', () => {
    expect(containerStateSummary([
      { state: 'running', status: 'healthy' },
      { state: 'running', status: 'healthy' },
      { state: 'running', status: 'healthy' },
    ])).toBe('いまのコンテナの様子: running（healthy） × 3')
  })
})

// ── ephemeralDataNote（D-8・2026-09-16）───────────────────────────────────────
// 像のフォルダに書き込みを与えた（copyTree の 0o1777）ので、アプリは自分でフォルダ・ファイルを
// 作れる。ただしコンテナは使い捨てで、書いたデータは残らない。**併記しないと
// 「入力が保存できる」と誤解させる。**
//
// 検分の指摘（2026-09-16）: 最初の文面は消える条件を**公開し直したとき**だけに限っていた。
// だが同じ日の実機で、コンテナは `EACCES` で**自分で1分ごとに再起動していた**（5-13）。
// コンテナが入れ替われば公開し直さなくても像から作り直される＝データは消える。
// **事実より弱い約束をしない。** 台数を2以上にするとコンテナごとに別のデータになる点も要る。
describe('ephemeralDataNote: 書いたデータは残らない（純関数・D-8）', () => {
  it('★ 消える条件を「公開し直したとき」だけに限らない（再起動でも消える・台数2以上は別のデータ）', () => {
    const text = ephemeralDataNote()
    expect(text).toContain('公開し直した')
    expect(text).toContain('再起動') // ← ここが抜けると「公開し直さなければ残る」と読まれる
    expect(text).toContain('台数を2以上')
    expect(text).toContain('保存場所')
    expect(text.length).toBeGreaterThan(0)
  })

  it('★★「公開し直すと消えます」だけの弱い約束に戻っていない', () => {
    const text = ephemeralDataNote()
    // 直す前の文面そのもの（これに戻ると、再起動で消えることを伝えられなくなる）
    expect(text).not.toBe('アプリが自分のフォルダに書いたデータは、公開し直すと消えます（入力を残したいときは、共用型の「保存場所」のような仕組みが要ります）。')
  })

  it('素の <p> に流すので Markdown の記号（**）を含まない', () => {
    expect(ephemeralDataNote()).not.toContain('**')
  })

  // ── D-13 E（2026-09-16）: 「再起動」が利用者の操作だと読めてしまう ─────────────────
  // 非エンジニアは「コンテナが再起動したときも作り直されます」を
  // **「自分が再起動しなければ残る」**と読む。実際は利用者が何もしなくても入れ替わる
  // （2026-09-16 の実機では1分ごとに入れ替わっていた）。主語をはっきりさせる。
  it('★★ 入れ替わるのに利用者の操作が要らないことを、はっきり書く', () => {
    const text = ephemeralDataNote()
    expect(text, '「自分が再起動しなければ残る」と読まれる').toContain('あなたが何もしなくても')
  })

  // 頻度（1分ごと）は `EACCES` の不具合によるもので、いつもそうなるとは確かめていない（掟1）。
  it('★★ 確かめていない頻度（1分ごと）を、いつもそうであるかのように書かない', () => {
    expect(ephemeralDataNote()).not.toContain('1分ごと')
  })

  // ── D-13 F（2026-09-16）: 共用型の公開画面からも同じ1文を出す ──────────────────
  // 末尾が「共用型の『保存場所』のような仕組みが要ります」だと、共用型の画面で読んだときに
  // 自分がいる場所を指してしまう。どちらの画面で読んでも通じる言い方にする。
  it('★★ 共用型の画面で読んでも通じる（「共用型の保存場所」という専有型目線の言い方をしない）', () => {
    const text = ephemeralDataNote()
    expect(text).not.toContain('共用型の「保存場所」')
    expect(text).toContain('保存場所')
  })
})
