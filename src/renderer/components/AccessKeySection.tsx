import type { ReactNode } from 'react'
import ConnectionChecklist, { type ConnectionCheckItem } from './ConnectionChecklist'

// AccessKeySection.tsx — 公開先パネル4つ（AppRun 共用型・専有型・HANAMII・Vercel）の
// ①「キー」節を1つの見た目に揃える（委譲仕様 UX-E・判断8）。
//
// ── これまでの重複（UX-E 着手前に確認した事実）──────────────────────────────
// AppRun 共用型（AppRunPanel.tsx）の①APIキー・🔌接続テスト・ConnectionChecklist と、
// 専有型（AppRunDedicatedPanel.tsx）の①は**ほぼ同文の複製**だった。HANAMII・Vercel も
// 「認証情報に登録済み／認証情報を開く」「認証情報を開いて登録」という、
// 共用型・専有型とは違う言い回しを別々に持っていた（掟10違反：定義が4箇所に散っていた）。
//
// ── ここで決めること・決めないこと ──────────────────────────────────────
// ここは**見た目と文言だけ**を一元化する。conn/connMsg/connChecks の状態そのもの
// （いつ何を確かめ、いつリセットするか）は各パネルに残す——ここは「渡された状態をどう見せるか」
// だけを知っていて、「いつ確かめ直すか」は一切知らない（掟10: 判断の置き場所を混ぜない）。
//
// 認証情報ボタンは HANAMII/Vercel 方式（未登録なら大きく「認証情報を登録する」、
// 登録済みなら文字リンク「認証情報を開く」）に統一する。AppRun 系が持っていた
// 「🔑 認証情報で登録・切替」という常設ボタン1つの形はここでは使わない。

export type AccessKeyTestState = 'idle' | 'testing' | 'ok' | 'ng'

export interface AccessKeyTest {
  /** 🔌 接続テストを実行する（GETのみ・何も作らない想定）。 */
  run: () => void | Promise<void>
  state: AccessKeyTestState
  /** 内訳（ConnectionChecklist に渡す）。無ければチェックリストは出さない。 */
  checks?: ConnectionCheckItem[]
  /** checks で個別に出せない全体エラー（認証情報未保存など）。checks が無いときだけ表示する。 */
  message?: string
  /** ConnectionChecklist の下に添える注記（サービスごとに文言が違う）。 */
  note?: string
}

export interface AccessKeySectionProps {
  /** 「①」等、見出しに付ける番号。 */
  stepNo: string
  /** サービス名（例「さくらのクラウド」「HANAMII」「Vercel」）。 */
  serviceTitle: string
  /** 各サービス公式の語（例「APIキー」「APIトークン」「トークン」）。 */
  keyLabel: string
  /** 認証情報に登録済みか。 */
  registered: boolean
  /** 登録済みのときに出す短い印（例「使用中のキー: xxxx…」）。省略可。 */
  summary?: string
  onOpenCredentials: () => void
  /** 接続テストがあれば「🔌 接続テスト」ボタンと ConnectionChecklist を出す。無ければ何も出さない。 */
  test?: AccessKeyTest
  /**
   * 各パネル固有の補助表示（複数キーの選択セレクタ・権限についての注記・
   * 「共用型と同じキーです」等）。認証情報ボタンの下、接続テストの上に差し込む。
   */
  children?: ReactNode
}

/**
 * 表示の分岐だけを切り出した純関数（テスト対象・JSX の if/三項をここへ寄せる）。
 *
 * - 未登録なら大きなボタン（'register'）、登録済みなら文字リンク（'open'）。
 * - test が無ければ「🔌 接続テスト」のボタン自体を出さない（showTest=false）。
 *
 * JSX 側はこの結果をそのまま出し分けるだけにし、分岐の条件式を2箇所（関数とJSX）に
 * 書かない——複製すると片方だけ直され、抜けても誰も気づかない（掟10）。
 */
export type AccessKeyView = {
  credentialsButton: 'register' | 'open'
  showTest: boolean
}

export function accessKeyView(props: Pick<AccessKeySectionProps, 'registered' | 'test'>): AccessKeyView {
  return {
    credentialsButton: props.registered ? 'open' : 'register',
    showTest: !!props.test,
  }
}

export default function AccessKeySection({
  stepNo, serviceTitle, keyLabel, registered, summary, onOpenCredentials, test, children,
}: AccessKeySectionProps) {
  const view = accessKeyView({ registered, test })
  return (
    <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
      <p className="text-sm font-semibold text-ink">{stepNo} {keyLabel}</p>
      <p className="text-[11px] text-ink-muted leading-relaxed">
        Koto が {serviceTitle} へ代わりにアクセスするための合言葉です。
      </p>

      {view.credentialsButton === 'open' ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-brand-green font-semibold">✓ 認証情報に {serviceTitle} {keyLabel}が登録済み</span>
            <button onClick={onOpenCredentials} className="text-xs text-ink-muted hover:text-ink">認証情報を開く</button>
          </div>
          {summary && <p className="text-[11px] text-ink-secondary">{summary}</p>}
        </div>
      ) : (
        <button
          onClick={onOpenCredentials}
          className="sakura-gradient text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90"
        >🔑 認証情報を登録する</button>
      )}

      {children}

      {view.showTest && test && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => void test.run()}
            disabled={test.state === 'testing' || !registered}
            title={registered ? '' : '先に認証情報を登録してください'}
            className="bg-overlay text-ink border border-line rounded-lg px-3 py-2 text-sm font-medium hover:border-sakura disabled:opacity-40"
          >🔌 接続テスト</button>
          <span className="flex-1 text-xs text-right">
            {test.state === 'ok' && (
              <span className="text-brand-green font-semibold">
                {test.checks && test.checks.length > 0 ? '✅ すべて確認できました' : '✅ 通じました'}
              </span>
            )}
            {test.state === 'ng' && (
              <span className="text-brand-yellow font-semibold">{ngSummary(test.checks)}</span>
            )}
            {test.state === 'testing' && <span className="text-ink-secondary">確認中…</span>}
          </span>
        </div>
      )}
      {test?.checks && <ConnectionChecklist items={test.checks} note={test.note} />}
      {/* checks（内訳）で個別に出せない全体エラーのみ表示する。checks があっても、
          内訳とは別に「認証情報が保存されていません」等の全体メッセージが来ることがある
          （例: main の cloud:testConnection は未登録時に checks と message の両方を返す）ため、
          checks の有無では出し分けない——各項目の詳細は上のチェックリストで、全体の要点はここで。 */}
      {test && test.state === 'ng' && test.message && (
        <p className="text-xs text-white bg-brand-red-fill rounded-lg px-3 py-2 leading-relaxed">
          {test.message}
        </p>
      )}
    </section>
  )
}

/**
 * 接続テストNG時の要約文言。全項目が失敗していれば「すべての項目で」、
 * 一部だけなら「一部の権限が」、内訳が無ければ「通じませんでした」（roadmap #35 で揃えた区別）。
 * 確認していないことを確認できたと言わない（言い過ぎない）ための純粋な文言判定。
 */
function ngSummary(checks?: ConnectionCheckItem[]): string {
  if (!checks || checks.length === 0) return '⚠️ 通じませんでした'
  const allFailed = checks.every(c => !c.ok)
  return allFailed ? '⚠️ すべての項目で確認できませんでした' : '⚠️ 一部の権限が確認できませんでした'
}
