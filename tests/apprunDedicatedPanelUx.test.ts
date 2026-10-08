import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computeDedicatedFormErrors,
  createBlockedReason,
  publishProgressStep,
  publishProgressView,
  PUBLISH_PROGRESS_STEPS,
  PUBLISH_STAGE_LABEL,
  PUBLISH_WAIT_NOTE,
  PUBLISH_STOP_NOTE,
} from '../src/renderer/components/AppRunDedicatedPanel'
import { panelBusyReason } from '../src/renderer/apprunDedicatedActions'
// 2026-09-24 検分の指摘4・7・10: ⑧の「途中で閉じても…」は、実際に閉じるときの警告と
// **同じ定義**から引く。片方だけ直して食い違う事故を落とすため、原本を読んで突き合わせる。
import { PUBLISH_STOP_NOTE_MAIN_RECORD, PUBLISH_CLOSE_WARNING, PUBLISH_QUIT_STOPS } from '../src/renderer/activity'

// B・D（2026-09-17 Ryosuke さん指摘／2026-09-24 再指摘）:
//
// > 占有型を公開する際に、クラスタ作成に必要な作業の何が足りていないのかボタンの付近
// > 書いてあると良い（B）
// > 公開するボタンを押した後に実行していることの表示はされているがもう少し目立つ
// > ようにするのはどうか？、またユーザーに待って欲しいことが伝わるようにして欲しい（D）

const panel = readFileSync(join(__dirname, '..', 'src/renderer/components/AppRunDedicatedPanel.tsx'), 'utf-8')
// D: 進行の1行は main の publishAppFlow が出す。**原本と突き合わせて**段の対応づけを固定する（掟1）。
const appApply = readFileSync(join(__dirname, '..', 'src/main/cloud/apprunDedicatedAppApply.ts'), 'utf-8')
// 指摘16: publishAppFlow より前（いちばん長く待たされる区間）の進行も原本と突き合わせる。
const imagePublish = readFileSync(join(__dirname, '..', 'src/main/cloud/imagePublish.ts'), 'utf-8')
const activity = readFileSync(join(__dirname, '..', 'src/renderer/activity.ts'), 'utf-8')

/** ⑤の入力がすべて空（＝何も入れていない）状態。 */
const emptyInput = {
  clusterName: '',
  resourceId: '',
  ports: [{ port: 80, protocol: 'http' as const }, { port: 443, protocol: 'https' as const }],
  zone: '',
  selectedWorkerPath: null,
  selectedLbPath: null,
  minNodes: 1,
  maxNodes: 1,
}

/** ⑤の入力がすべて揃った状態。 */
const fullInput = {
  ...emptyInput,
  clusterName: 'demo',
  resourceId: '111111111111',
  zone: 'tk1b',
  selectedWorkerPath: 'cloud/apprun/dedicated/worker/1vcpu_2gb',
  selectedLbPath: 'cloud/apprun/dedicated/lb/1vcpu_2gb_1',
}

// 欄を触った／「作成する」を押した後（＝足りないものを項目まで並べてよい状態）。
const REVEAL = true
// まだ何も触っていない初期表示（判断7・2026-09-11／2026-09-24 検分の指摘5）。
const INITIAL = false

describe('B: ⑤が押せないとき、足りないものが名前で出る', () => {
  it('★ 足りないものが名前で出る（何を入れればよいか分かる言葉で）', () => {
    const r = createBlockedReason(computeDedicatedFormErrors({ ...fullInput, clusterName: '' }), '', REVEAL)
    expect(r.kind).toBe('input')
    expect(r.items).toEqual(['クラスタ名を入力してください'])
  })

  it('★ 足りないものが複数あれば、複数出る（最初の1つで止めない）', () => {
    const r = createBlockedReason(computeDedicatedFormErrors(emptyInput), '', REVEAL)
    expect(r.kind).toBe('input')
    expect(r.items).toEqual([
      'クラスタ名を入力してください',
      '②でサービスプリンシパルIDを入力してください',
      'ゾーンを入力してください',
      'ワーカプランを選んでください',
      'ロードバランサプランを選んでください',
    ])
    expect(r.headline).toContain('あと5つ')
  })

  it('★ 何も触っていない初期表示では、項目を並べない（いきなり赤字を出さない・検分の指摘5）', () => {
    const r = createBlockedReason(computeDedicatedFormErrors(emptyInput), '', INITIAL)
    expect(r.kind).toBe('input')
    expect(r.items).toEqual([]) // 5項目を開いた瞬間から並べない
    expect(r.tone).toBe('info') // 見出しも ⚠️ ではなく控えめに
    expect(r.heading).not.toContain('⚠️')
    // それでも「何をすれば押せるのか」は分かる（件数と次の一手）
    expect(r.headline).toBe('あと5つ、入力が足りません（上の欄を埋めてください）。')
  })

  it('★ 触ったあと（送信後）は ⚠️ で項目まで並べる', () => {
    const r = createBlockedReason(computeDedicatedFormErrors(emptyInput), '', REVEAL)
    expect(r.tone).toBe('warn')
    expect(r.heading).toBe('⚠️ 「クラスタを作成する」を押すには、あと少し入力が要ります。')
  })

  it('★ 判断は既にある computeDedicatedFormErrors を使う（欄が増えても取りこぼさない）', () => {
    const errors = computeDedicatedFormErrors(emptyInput)
    const r = createBlockedReason(errors, '', REVEAL)
    // 判定が出した不足を、1つも落とさずに並べていること（並べる順の定義から漏れた欄は黙って消える）
    expect(r.items.length).toBe(Object.keys(errors).length)
    for (const msg of Object.values(errors)) expect(r.items).toContain(msg as string)
  })

  it('★ 「ほかの操作の最中」と「入力が足りない」を言い分ける', () => {
    const busy = panelBusyReason({ creating: false, tearingDown: true, publishing: false, lbRefreshing: false })
    const r = createBlockedReason(computeDedicatedFormErrors(emptyInput), busy, REVEAL)
    expect(r.kind).toBe('busy')
    expect(r.heading).toBe('⚠️ いまは「クラスタを作成する」を押せません。')
    expect(r.headline).toBe('いま⑥の削除を実行中です。終わるまでお待ちください。')
    // ほかの操作の最中は、入力の不足を並べない（直しても押せないため、次の一手にならない）
    expect(r.items).toEqual([])
  })

  it('★ 入力が足りないときの説明は、肯定だけで書く（打ち消しを重ねない・検分の指摘15）', () => {
    const r = createBlockedReason(computeDedicatedFormErrors({ ...fullInput, zone: '' }), '', REVEAL)
    expect(r.headline).toBe('あと1つ、入力が足りません。')
    // 起きていないことの否定（「ほかの操作の最中ではありません」）は添えない
    expect(r.headline).not.toContain('ほかの操作')
  })

  it('入力が揃っていて、ほかの操作も走っていなければ何も出さない', () => {
    const r = createBlockedReason(computeDedicatedFormErrors(fullInput), '', REVEAL)
    expect(r).toEqual({ kind: 'none', tone: 'none', heading: '', headline: '', items: [] })
  })

  it('★ 同じ一文がボタンの上と下に2回出ない（検分の指摘9）', () => {
    // ボタンの上の全体表示（generalErrors）は、押せない理由が項目を並べているときは描かない
    expect(panel).toContain('{createBlocked.items.length === 0 && generalErrors.map((msg, i) => (')
  })

  it('★ 画面はボタンのすぐ下で、純関数の結果を描くだけ（掟10）', () => {
    expect(panel).toContain('const createBlocked = createBlockedReason(errors, panelBusyReason({ creating, tearingDown, publishing, lbRefreshing }), revealCreateItems)')
    expect(panel).toContain('const revealCreateItems = submitted || Object.keys(touched).length > 0')
    // W-96（2026-09-27 決定）: 「ASG」「LB」は略さず「オートスケーリンググループ」「ロードバランサ」と書く
    const at = panel.indexOf(">{creating ? 'クラスタ→オートスケーリンググループ→ロードバランサの順で作成しています…' : 'クラスタを作成する'}</button>")
    expect(at).toBeGreaterThan(0)
    const below = panel.slice(at, at + 1600)
    expect(below).toContain('{!creating && createBlocked.kind !== \'none\' && (')
    // 見出しも純関数が決める（画面で文言を組み立てない・掟10）
    expect(below).toContain('{createBlocked.heading}')
    expect(below).toContain('{createBlocked.headline}')
    expect(below).toContain('{createBlocked.items.map((msg, i) => (<li key={i}>・{msg}</li>))}')
  })
})

describe('D: 公開中は、いま何をしているかと待ってほしいことが出る', () => {
  it('★ いま何をしているかを段の日本語で出す（PUBLISH_STAGE_LABEL を使う）', () => {
    const v = publishProgressView('バージョンを作成しています…')
    expect(v.stageLabel).toBe(PUBLISH_STAGE_LABEL['version-create'])
    expect(v.detail).toBe('バージョンを作成しています…')
    expect(v.heading).toBe('⏳ 公開しています')
  })

  it('★ 段が進んだことが分かる（いくつ中のいくつか）', () => {
    // いちばん最初に出るのは「保存場所の鍵の用意」（指摘16 で段に数えるようにした）
    const first = publishProgressView('🔑 保存場所の鍵を用意しています…')
    const later = publishProgressView('新しいバージョンを有効化しています…')
    expect(first.stepText).toBe(`1／${PUBLISH_PROGRESS_STEPS.length} 段目（進み方によっては飛ぶ段もあります）`)
    expect(later.stepText).toBe(`${PUBLISH_PROGRESS_STEPS.indexOf('activate') + 1}／${PUBLISH_PROGRESS_STEPS.length} 段目（進み方によっては飛ぶ段もあります）`)
    // 段は進む向きにしか動かない（並びが逆転していないこと）
    expect(PUBLISH_PROGRESS_STEPS.indexOf('activate')).toBeGreaterThan(PUBLISH_PROGRESS_STEPS.indexOf('version-create'))
  })

  it('★ 待ってほしいことが伝わる（所要時間は断定しない）', () => {
    const v = publishProgressView('バージョンを作成しています…')
    // 画面を閉じても公開は最後まで進み、開き直すと進み具合と結果が出る（処理の記録・2026-09-29）ので、「開いたまま待て」とは言わない
    expect(v.waitNote).toBe('⏳ 数分かかることがあります。開いたまま待たなくても、公開は進みます。')
    expect(v.waitNote).not.toContain('開いたままお待ちください')
    // 実測していないので「3分で終わります」のような断定はしない
    expect(v.waitNote).toContain('ことがあります')
  })

  it('★ 途中で閉じるとどうなるかを、「何を閉じるのか」まで言い分ける（検分の指摘4・7・10）', () => {
    const v = publishProgressView('バージョンを作成しています…')
    // 実際に閉じようとしたときに出る警告と**同じ定義**から引く（2か所で別々に書かない・掟10）
    expect(v.stopNote).toBe(PUBLISH_STOP_NOTE_MAIN_RECORD)
    expect(activity).toContain('export const PUBLISH_STOP_NOTE_MAIN_RECORD')
    // この公開の画面を閉じるだけなら、公開は進み**記録も残る**（記録は main が書く）
    expect(v.stopNote).toContain('この公開の画面を閉じても、公開は最後まで進みます')
    expect(v.stopNote).toContain('公開の記録は Koto が残す')
    // Koto 自体を終了したときは別の話（課金の歯止めに関わるので必ず伝える）
    expect(v.stopNote).toContain('Koto 自体を終了すると、処理は途中で止まり、作られたものが記録に残らないことがあります')
    // 「終了すると止まる」の一文は、窓を閉じる警告と**同じ定義**（PUBLISH_QUIT_STOPS）から引く（正反対の案内が並ばない）
    expect(v.stopNote).toContain(PUBLISH_QUIT_STOPS)
    expect(PUBLISH_CLOSE_WARNING.detail).toContain(PUBLISH_QUIT_STOPS)
    // 専有型の公開も、共通の1つの警告文を使う（「公開の記録も Koto に残りません」とは言わない）
    expect(PUBLISH_CLOSE_WARNING.detail).not.toContain('公開の記録も Koto に残りません')
    expect(panel).toContain("beginActivity('専有型アプリの公開', { closeWarning: PUBLISH_CLOSE_WARNING })")
  })

  it('★ 公開の本筋で出る進行の1行は、すべて段に対応づいている（原本と突き合わせ）', () => {
    // アポストロフィを含む行（"Let's Encrypt の設定を確認しています…"）を取りこぼさない文字クラス。
    // 直す前は [^'"`$]+ でアポストロフィを弾き、15本中13本しか見ていなかった（検分の指摘14）。
    const pick = (src: string) =>
      [...src.matchAll(/progress\(\s*(['"`])((?:(?!\1)[^$])+)\1\s*\)/g)].map(m => m[2])
    // 取りこぼしそのものを落とす: 原本の progress( の本数と、拾えた本数＋補間ありの本数を合わせる。
    const countCalls = (src: string) => [...src.matchAll(/progress\(/g)].length
    const countInterpolated = (src: string) => [...src.matchAll(/progress\(\s*[`'"][^`'"]*\$\{/g)].length

    const literals = pick(appApply)
    expect(literals.length).toBe(countCalls(appApply) - countInterpolated(appApply))
    expect(literals).toContain("Let's Encrypt の設定を確認しています…") // 取りこぼしていた1行
    for (const msg of literals) {
      expect(publishProgressStep(msg), `段に対応づいていない進行の1行: ${msg}`).not.toBeNull()
    }
    // 経過時間が入る行（テンプレート文字列）も、前方一致で拾えること
    expect(publishProgressStep('ロードバランサの IP が付くのを待っています（2分経過）…')).toBe('lb-address')

    // 検分の指摘16: いちばん長く待たされる区間（イメージの組み立て・push）も段に数える。
    for (const msg of pick(imagePublish)) {
      expect(publishProgressStep(msg), `段に対応づいていないイメージの1行: ${msg}`).toBe('image')
    }
    expect(publishProgressStep('📦 イメージを組み立てています…（server.js で起動）')).toBe('image')
    expect(publishProgressStep('🔑 保存場所の鍵を用意しています…')).toBe('storage')
  })

  it('★ イメージの組み立て・push の間も、段の名前と「何段目か」が出る（検分の指摘16）', () => {
    const v = publishProgressView('📤 レジストリへプッシュしています…')
    expect(v.stageLabel).toBe(PUBLISH_STAGE_LABEL['image'])
    expect(v.stepText).toBe(`${PUBLISH_PROGRESS_STEPS.indexOf('image') + 1}／${PUBLISH_PROGRESS_STEPS.length} 段目（進み方によっては飛ぶ段もあります）`)
    const s = publishProgressView('🔑 保存場所の鍵を用意しています…')
    expect(s.stageLabel).toBe(PUBLISH_STAGE_LABEL['storage'])
    // 走る順（鍵 → イメージ → publishAppFlow）どおりに並んでいる
    expect(PUBLISH_PROGRESS_STEPS.indexOf('storage')).toBeLessThan(PUBLISH_PROGRESS_STEPS.indexOf('image'))
    expect(PUBLISH_PROGRESS_STEPS.indexOf('image')).toBeLessThan(PUBLISH_PROGRESS_STEPS.indexOf('no-cluster'))
  })

  it('段の外の1行（公開のあとの後片づけ）には番号を振らない（分からないものを断定しない）', () => {
    const v = publishProgressView('🧹 古い鍵を片づけています…')
    expect(v.stageLabel).toBeNull()
    expect(v.stepText).toBeNull()
    // それでも、いま届いている1行と待ってほしいことは出す
    expect(v.detail).toBe('🧹 古い鍵を片づけています…')
    expect(v.waitNote).toBe(PUBLISH_WAIT_NOTE)
    expect(v.stopNote).toBe(PUBLISH_STOP_NOTE)
  })

  it('進行がまだ届いていなくても、待ってほしいことは出す（押した直後に無言にしない）', () => {
    const v = publishProgressView(null)
    expect(v.detail).toBe('')
    expect(v.heading).toBe('⏳ 公開しています')
    expect(v.waitNote).toBe(PUBLISH_WAIT_NOTE)
  })

  it('★ 画面は公開中だけ、その枠を描く（判断は純関数・画面は描くだけ）', () => {
    const at = panel.indexOf('{publishing && (() => {')
    expect(at).toBeGreaterThan(0)
    const block = panel.slice(at, panel.indexOf('})()}', at))
    expect(block).toContain('const v = publishProgressView(publishProgress)')
    expect(block).toContain('{v.heading}')
    expect(block).toContain('{v.stageLabel}{v.stepText ? `（${v.stepText}）` : \'\'}')
    expect(block).toContain('{v.detail}')
    expect(block).toContain('{v.waitNote}')
    expect(block).toContain('{v.stopNote}')
  })
})
