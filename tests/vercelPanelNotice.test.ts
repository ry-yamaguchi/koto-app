import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { askAiAboutNotice, askAiAboutFailure } from '../src/shared/askAi'

// 2026-09-24 検分の指摘2・3 を、ソースの配線と純関数の振る舞いで固定する。
//
// ・指摘3: 公開**成功**の notice が、失敗専用の枠（ErrorMessageBlock）に出ていた。
//   🤖ボタンは askAiAboutFailure を送るので、AI が「起きていない失敗」の原因探しを始め、
//   動いているものを直そうとする。→ 結果の枠（URL の近く）の PublishNoticeBlock へ分けた。
// ・指摘2: 「データは国外に置かれます」が残っていた。2026-09-24 から Koto は
//   さくらのオブジェクトストレージ（日本国内）の設定を Vercel へ渡すので、国外なのは
//   **アプリが動く場所**だけ。同じ画面の公開前チェックは「日本国内」と出すため、
//   直さないと利用者は正反対の2文を同時に読む。
//
// 掟10 の注意: ソースを読むテストは当て先が他の行に出ないか確かめること。
// ここでは「囲み（result の枠・関数の本体）ごと切り出してから見る」形にしている。

const ROOT = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

const vercelPanel = read('src/renderer/components/VercelPanel.tsx')
const publishModal = read('src/renderer/components/PublishModal.tsx')
const newProjectModal = read('src/renderer/components/NewProjectModal.tsx')

/**
 * `関数名(` から、**引数の括弧を閉じたあと**の波括弧が閉じるまでを切り出す
 * （当て先を関数の中だけに限る）。引数の分割代入 `({ notice })` から数え始めると
 * そこで閉じてしまうので、`)` を越えてから `{` を探す。
 */
function functionBody(src: string, header: string): string {
  const at = src.indexOf(header)
  expect(at, `${header} が見つからない`).toBeGreaterThan(-1)
  const afterArgs = src.indexOf(')', at)
  let depth = 0
  for (let i = src.indexOf('{', afterArgs); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1) }
  }
  throw new Error(`${header} の本体を切り出せない`)
}

/**
 * コメントを落とす。**画面に出る文言だけを見る**ため。
 * ソースのコメントには「直す前はこう書いてあった」を残してあるので、
 * それを拾うと「直したのに落ちる」テストになる。
 */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')          // /* … */ と {/* … */} の中身
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')      // 行コメント（https:// は残す）
}

describe('askAiAboutNotice: 成功のお知らせを相談する定型文（検分の指摘3）', () => {
  const text = askAiAboutNotice('Vercel', 'もう一度「公開する」を押してください。')

  it('★ 失敗ではなく成功として尋ねる（AI に「失敗の原因」を探させない）', () => {
    expect(text).toContain('Vercel への公開は成功しました。')
    expect(text).toContain('動いているものを直そうとしないでください')
    // askAiAboutFailure の文面（失敗の断定）が混ざっていないこと
    expect(text).not.toContain('次の失敗が出ました')
  })

  it('★ askAiAboutFailure とは別物の文面になる（取り違えたら落ちる）', () => {
    expect(text).not.toBe(askAiAboutFailure('公開', 'Vercel', 'もう一度「公開する」を押してください。'))
  })

  it('★ お知らせ本文は untrusted の囲みの中に入る（外部由来の語が指示として読まれない）', () => {
    expect(text).toMatch(/<<<KOTO-EXT-[\s\S]*もう一度「公開する」を押してください。[\s\S]*<<<END-KOTO-EXT-/)
  })
})

describe('VercelPanel: 成功の notice を失敗の枠に入れない（検分の指摘3）', () => {
  // 2026-09-29: notice は画面の状態ではなく、main の処理の記録（result.warnings）から出すようになった
  // （閉じて開き直しても見逃さない）。**画面に出る様子そのもの**は tests/ops-hanamiiVercel-vercel.test.ts が
  // 偽の react で動かして固定している。ここは「失敗の枠に入れない」構造（どの枝で何を出すか）を見る。
  it('★ publish() は notice を画面の状態へ入れない・失敗の欄（setMsg）にも入れない（記録の warnings から出す）', () => {
    const body = functionBody(vercelPanel, 'const publish = async () =>')
    expect(body).not.toContain('r.notice')
    expect(body).not.toContain('setNotice')
    expect(vercelPanel).not.toContain('const [notice, setNotice]')
    expect(vercelPanel).not.toContain('setMsg(r.notice')
  })

  it('★ notice（記録の warnings）は、成功の記録の枠（URL の近く）に PublishNoticeBlock で出す。失敗の枠は混ざらない', () => {
    const body = functionBody(vercelPanel, 'function VercelOpResult(')
    // 失敗の記録（!res.ok）の枝と、成功の記録の枝を分ける
    const okAt = body.indexOf('const readyState =')
    expect(okAt, '成功の記録の枝が見つからない').toBeGreaterThan(-1)
    const failBranch = body.slice(body.indexOf('if (!res.ok) {'), okAt)
    const okBranch = body.slice(okAt)
    expect(okBranch).toContain('<PublishNoticeBlock key={i} notice={opWarningText(n)} />')
    expect(okBranch, '成功の枝に失敗の枠が紛れている').not.toContain('<ErrorMessageBlock')
    expect(failBranch).toContain('<ErrorMessageBlock')
    expect(failBranch, '失敗の枝に成功のお知らせ（🤖 次にすべきことを聞く）が紛れている').not.toContain('<PublishNoticeBlock')
    // URL の近く（同じ枠の中）: URL のリンクのあとに出す
    expect(okBranch.indexOf('🌐 {res.url}')).toBeLessThan(okBranch.indexOf('<PublishNoticeBlock'))
  })

  it('★ ErrorMessageBlock を出すのは、失敗の記録（VercelOpResult の失敗の枝）と局所の失敗（msg）だけ', () => {
    const uses = vercelPanel.match(/<ErrorMessageBlock[^/]*\/>/g) ?? []
    expect(uses).toEqual([
      '<ErrorMessageBlock msg={msg} detail={msgDetail} />',
      "<ErrorMessageBlock msg={res.message ?? '公開に失敗しました'} detail={res.detail ?? ''} />",
    ])
    expect(vercelPanel).toContain('{msg && <ErrorMessageBlock msg={msg} detail={msgDetail} />}')
  })

  it('★ お知らせの🤖ボタンは askAiAboutNotice を送る（askAiAboutFailure ではない）', () => {
    const body = functionBody(vercelPanel, 'function PublishNoticeBlock(')
    expect(body).toContain("askAiAboutNotice('Vercel', notice)")
    expect(body).not.toContain('askAiAboutFailure')
  })

  it('★ 失敗の枠のほうは従来どおり askAiAboutFailure を送る（取り違えていない）', () => {
    const body = functionBody(vercelPanel, 'function ErrorMessageBlock(')
    expect(body).toContain("askAiAboutFailure('公開', 'Vercel', msg, detail)")
    expect(body).not.toContain('askAiAboutNotice')
  })
})

describe('Vercel の説明文: 国外なのはアプリが動く場所だけ（検分の指摘2）', () => {
  it.each([
    ['VercelPanel.tsx（🔰 初めて公開する方へ）', vercelPanel],
    ['PublishModal.tsx（公開先を選ぶ画面）', publishModal],
    ['NewProjectModal.tsx（新規作成で公開先を選ぶ）', newProjectModal],
  ])('★ %s は「データは国外」と書かない', (_name, src) => {
    const shown = withoutComments(src)
    expect(shown).not.toContain('データは国外')
    expect(shown).not.toContain('データが国外')
  })

  it('★ 🔰 の注意書きは「動くのは国外・データは日本国内」と書く', () => {
    const at = vercelPanel.indexOf('function VercelFirstTimeGuide(')
    expect(at).toBeGreaterThan(-1)
    const body = vercelPanel.slice(at)
    expect(body).toContain('アプリが動くのは国外（Vercelの海外サーバ）です')
    expect(body).toContain('さくらのオブジェクトストレージ（日本国内）に置かれます')
    // 逃げ道（国内で「動かし」たい人向け）は残す
    expect(body).toContain('HANAMII')
  })

  // W-29（2026-09-27 決定・案2）: 「データは国内」を条件なしで言い切らず、VercelPanel.tsx:467
  // にある条件つきの文（「データの保存を使う場合、…日本国内」）に揃える。
  it('★ 公開先を選ぶ画面も同じことを言う（同じ画面で正反対の2文を読ませない）', () => {
    expect(publishModal).toContain('アプリが動くのは国外です。データの保存を使う場合、そのデータはさくらのオブジェクトストレージ（日本国内）に置かれます。')
  })
})
