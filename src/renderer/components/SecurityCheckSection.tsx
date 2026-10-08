import { useEffect, useRef, useState } from 'react'
import { runSecurityCheck, SecurityCheckResult, CheckRecord, checkRecordKey, formatCheckRecord } from '../securityCheck'
import { foldSecurity } from '../appRunFolding'
import CopyButton from './CopyButton'

// 🛡 セキュリティチェックの節。公開フローの「事前チェック」の次に置く
// （2026-08-21 Ryosuke 指定。最初は上部バーに置いたが、公開の流れの中が自然）。
//
// 実体は runSecurityCheck ただ1つ（掟10）。押したときだけ実行する（手動のみ）。
// 公開時の自動実行は 2026-08-21 に作者の指摘で廃止した（コミット 94e0c08。毎回は不要）。
// 公開はこの確認の最中でも押せる（任意の確認のため。押したときだけ実行する、という上の決定の帰結）。
// どの公開先（AppRun / Vercel / HANAMII / レンタルサーバ）でも、この同じ部品を使う。
// stepNo: 呼び出し元の画面の番号体系に乗せるための見出し番号（例 '④'）。
// 渡されなければ従来どおり番号なし（PublishModal は番号体系を持たない画面のため未指定・2026-09-04 Ryosuke 指摘）。
export default function SecurityCheckSection({ projectDir, apiKey, stepNo }: { projectDir: string; apiKey: string; stepNo?: string }) {
  const [checking, setChecking] = useState(false)
  // 実況: 何をしているか（時間がかかるので、無言で待たせない・2026-08-21 Ryosuke 指摘）
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<SecurityCheckResult | null>(null)
  // 前回の確認（最新1件だけ）。**画面を閉じても残す**ので、いつ確認したかが分かる
  const [record, setRecord] = useState<CheckRecord | null>(null)

  // ── 中止（2026-09-25 検分の指摘6・S6）────────────────────────────────
  // runSecurityCheck は**最初の await より前に**中断関数を渡してくる（securityCheck.ts の
  // onAbortReady）。ここで受けておかないと、利用者は最悪で「およそ600秒 × かたまりの数」
  // のあいだ、どうやっても止められない。
  //
  // ⚠️ 受け口を useState で持たないこと。useState は関数を渡すと「更新関数」と解釈して
  // **その場で呼んでしまう**（setStop(abort) が abort() を走らせる）。押していないのに
  // 中止が走る、いちばん見つけにくい形になる。だから ref に置く。
  // 画面に出す・消すの判定は checking（と stopping）で足りる。
  const abortRef = useRef<(() => void) | null>(null)
  // 押したあと、実際に止まるまでのあいだ（通信が切れるまで）の表示用
  const [stopping, setStopping] = useState(false)
  // 「中止した」のか「そもそも実施できなかった」のかを取り違えないための印。
  // 押した本人に「実施できませんでした」とだけ見せると、失敗したように読める
  const [aborted, setAborted] = useState(false)

  useEffect(() => {
    setResult(null) // 別プロジェクトの結果を見せない
    try {
      const raw = window.localStorage.getItem(checkRecordKey(projectDir))
      setRecord(raw ? JSON.parse(raw) as CheckRecord : null)
    } catch { setRecord(null) }
  }, [projectDir])

  async function run() {
    if (checking) return
    setChecking(true)
    setStopping(false)
    setAborted(false)
    setResult(null)
    try {
      const r = await runSecurityCheck(projectDir, apiKey, setProgress, (abort) => { abortRef.current = abort })
      setResult(r)
      // 実施できたときだけ記録する（省略・失敗は「確認した」ではない）
      if (r.verdict === 'ok' || r.verdict === 'warn') {
        const rec: CheckRecord = { at: new Date().toISOString(), verdict: r.verdict }
        try { window.localStorage.setItem(checkRecordKey(projectDir), JSON.stringify(rec)) } catch { /* 保存できなくても続ける */ }
        setRecord(rec)
      }
    } finally {
      abortRef.current = null
      setChecking(false)
      setStopping(false)
      setProgress('')
    }
  }

  /** 「中止する」を押したとき。いま待っている問い合わせを切り、残りのかたまりへ進ませない。 */
  function stop() {
    if (!checking) return
    setStopping(true)
    setAborted(true)
    abortRef.current?.()
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-ink">{stepNo ? `${stepNo} ` : ''}🛡 簡易セキュリティチェック</p>
        <div className="flex-none flex items-center gap-2">
          {/* ── 中止（2026-09-25 検分の指摘6・S6）────────────────────────
              受け口（onAbortReady）と、押されたときに本当に止まる振る舞いは
              securityCheck.ts 側にあったが、**押すところが画面に無かった**。
              押せない中断は無いのと同じなので、確認中はここに必ず出す。 */}
          {checking && (
            <button
              onClick={stop}
              disabled={stopping}
              className="bg-overlay text-ink border border-line rounded-md px-3 py-1 text-xs font-medium hover:border-brand-red disabled:opacity-40"
            >{stopping ? '中止しています…' : '⏹ 中止する'}</button>
          )}
          <button
            onClick={() => { void run() }}
            disabled={checking}
            className="bg-overlay text-ink border border-line rounded-md px-3 py-1 text-xs font-medium hover:border-sakura disabled:opacity-40"
          >{checking ? '確認中…' : 'AIに確認してもらう'}</button>
        </div>
      </div>
      {/* ── 免責は「押す前」に読める位置に置く（2026-08-21 Ryosuke 指摘）────────
          結果の中（{result && …}）にしか置いておらず、**実行前・実行中は
          最終的な確認がご自身であることが画面から消えていた**。
          文言も実態に合わせる（何を見るか／このあと選べること／責任の所在）。 */}
      <p className="text-[11px] text-ink-muted leading-relaxed">
        簡易的なセキュリティチェックを実施します。（秘密情報の書き込みや危険な記述がないか）<br />
        公開されるファイルを、原則すべて確認します（量が多いときは何回かに分けます。確認しきれなかったファイルは、結果に名前を出します）。<br />
        チェック後、修正するかどうか選択可能です。<br />
        なおAIによる簡易的な確認であるため、最終的にはご自身で確認してください。
      </p>

      {/* 前回の確認。**結果を表示していないときだけ**出す（同じことを二度書かない）。
          古い日付が残っていること自体が「そろそろ確認しよう」の材料になる */}
      {!result && !checking && formatCheckRecord(record) && (
        <p className="text-[11px] text-ink-muted">🕐 {formatCheckRecord(record)}</p>
      )}

      {checking && (
        <>
          <p className="text-xs text-ink-secondary">⏳ {progress || '準備しています…'}</p>
          {/* 待たされている人に、止められることを字で伝える（ボタンだけだと気づかれない） */}
          <p className="text-[11px] text-ink-muted">
            {stopping
              ? '中止しています。いま問い合わせている分が切れるまで、少し待ってください。'
              : '時間がかかるときは「⏹ 中止する」で止められます。途中までの結果は「確認した」ことにはしません。'}
          </p>
        </>
      )}

      {/* ── 全部✅なら1行に畳む（判断6・利用者目線レビュー・2026-09-11）──────────────
          ③事前チェック（AppRunPanel.tsx）の「preflight.checks.every(c => c.status === 'ok')」
          と同じ型を横展開する。判断そのものは foldSecurity に一元化してある（掟10）。 */}
      {result && (
        foldSecurity(result) ? (
          <details className="rounded-lg border border-line p-3">
            <summary className="cursor-pointer select-none text-xs font-semibold text-ink hover:text-sakura">
              ✅ 問題なし（内訳を見る）
            </summary>
            <div className="mt-2 space-y-2">
              {result.mode && (
                <p className="text-[11px] text-ink-muted">
                  {result.mode === 'node' ? 'アプリとして検査（サーバーで実行される前提）' : 'サイトとして検査（ファイルがそのまま見える前提）'}
                </p>
              )}
              <div className="flex items-center justify-end">
                <CopyButton text={result.report} title="チェック結果をコピー" />
              </div>
              <pre className="text-xs text-ink-secondary whitespace-pre-wrap select-text max-h-52 overflow-y-auto font-sans">{result.report}</pre>
            </div>
          </details>
        ) : (
          <div className={`rounded-lg border p-3 space-y-2 ${result.verdict === 'warn' ? 'border-brand-red/60' : 'border-line'}`}>
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-ink flex-1">
                {result.verdict === 'warn' ? '⚠️ 要確認' : aborted ? '⏹ 中止しました' : '⏭ 実施できませんでした'}
                {result.mode && (
                  <span className="ml-2 font-normal text-ink-muted">
                    {result.mode === 'node' ? 'アプリとして検査（サーバーで実行される前提）' : 'サイトとして検査（ファイルがそのまま見える前提）'}
                  </span>
                )}
              </p>
              <CopyButton text={result.report} title="チェック結果をコピー" />
            </div>
            {/* 結果は目印方式で「判定＋指摘（最大5件）」だけに絞ってある（＝要約）。
                思考の文章は securityCheck 側で捨てるので、ここには届かない */}
            <pre className="text-xs text-ink-secondary whitespace-pre-wrap select-text max-h-52 overflow-y-auto font-sans">{result.report}</pre>
            {result.verdict === 'warn' && (
              <span className="block">
                <button
                  onClick={() => {
                    // 指摘の全文＋「実際に修正しろ」の明確な指示をチャットへ（そのまま送信される）。
                    // rc.1 では指示が弱く、AIが翻訳・再レビューだけで終わった（2026-08-21 実機）
                    window.dispatchEvent(new CustomEvent('sakura:fix-with-ai', { detail: { text: `簡易セキュリティチェックで次の指摘がありました。該当するファイルを実際に修正して解消してください。直せない項目があれば、その理由と対処方法を教えてください。\n\n${result.report}` } }))
                  }}
                  className="sakura-gradient text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
                >🛠 AIに修正させる</button>
                {/* W-104: 「AIが直します」は言い切りすぎ。応答中は入力欄に置かれるだけで、
                    自動では送られない・直せない項目もあることを添える（決定: 案2）。 */}
                <span className="ml-2 text-[11px] text-ink-muted">押すとチャットに移り、AIに直すよう頼みます（AIが応答中のときは入力欄に入るので、終わってから送信してください）</span>
              </span>
            )}
          </div>
        )
      )}
    </section>
  )
}
