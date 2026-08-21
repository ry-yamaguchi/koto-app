import { useEffect, useState } from 'react'
import { runSecurityCheck, SecurityCheckResult, CheckRecord, checkRecordKey, formatCheckRecord } from '../securityCheck'
import CopyButton from './CopyButton'

// 🛡 セキュリティチェックの節。公開フローの「事前チェック」の次に置く
// （2026-08-21 Ryosuke 指定。最初は上部バーに置いたが、公開の流れの中が自然）。
//
// 実体は公開直前の自動チェックと同じ runSecurityCheck ただ1つ（掟10）。
// どの公開先（AppRun / Vercel / HANAMII / レンタルサーバ）でも、この同じ部品を使う。
export default function SecurityCheckSection({ projectDir, apiKey }: { projectDir: string; apiKey: string }) {
  const [checking, setChecking] = useState(false)
  // 実況: 何をしているか（時間がかかるので、無言で待たせない・2026-08-21 Ryosuke 指摘）
  const [progress, setProgress] = useState('')
  const [result, setResult] = useState<SecurityCheckResult | null>(null)
  // 前回の確認（最新1件だけ）。**画面を閉じても残す**ので、いつ確認したかが分かる
  const [record, setRecord] = useState<CheckRecord | null>(null)

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
    setResult(null)
    try {
      const r = await runSecurityCheck(projectDir, apiKey, setProgress)
      setResult(r)
      // 実施できたときだけ記録する（省略・失敗は「確認した」ではない）
      if (r.verdict === 'ok' || r.verdict === 'warn') {
        const rec: CheckRecord = { at: new Date().toISOString(), verdict: r.verdict }
        try { window.localStorage.setItem(checkRecordKey(projectDir), JSON.stringify(rec)) } catch { /* 保存できなくても続ける */ }
        setRecord(rec)
      }
    } finally {
      setChecking(false)
      setProgress('')
    }
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-ink">🛡 簡易セキュリティチェック</p>
        <button
          onClick={() => { void run() }}
          disabled={checking}
          className="flex-none bg-overlay text-ink border border-line rounded-md px-3 py-1 text-xs font-medium hover:border-sakura disabled:opacity-40"
        >{checking ? '確認中…' : 'AIに確認してもらう'}</button>
      </div>
      {/* ── 免責は「押す前」に読める位置に置く（2026-08-21 Ryosuke 指摘）────────
          結果の中（{result && …}）にしか置いておらず、**実行前・実行中は
          最終的な確認がご自身であることが画面から消えていた**。
          文言も実態に合わせる（何を見るか／このあと選べること／責任の所在）。 */}
      <p className="text-[11px] text-ink-muted leading-relaxed">
        簡易的なセキュリティチェックを実施します。（秘密情報の書き込みや危険な記述がないか）<br />
        公開されるファイルを全部確認します（量が多いときは何回かに分けます）。<br />
        チェック後、修正するかどうか選択可能です。<br />
        なおAIによる簡易的な確認であるため、最終的にはご自身で確認してください。
      </p>

      {/* 前回の確認。**結果を表示していないときだけ**出す（同じことを二度書かない）。
          古い日付が残っていること自体が「そろそろ確認しよう」の材料になる */}
      {!result && !checking && formatCheckRecord(record) && (
        <p className="text-[11px] text-ink-muted">🕐 {formatCheckRecord(record)}</p>
      )}

      {checking && (
        <p className="text-xs text-ink-secondary">⏳ {progress || '準備しています…'}</p>
      )}

      {result && (
        <div className={`rounded-lg border p-3 space-y-2 ${result.verdict === 'warn' ? 'border-brand-red/60' : 'border-line'}`}>
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold text-ink flex-1">
              {result.verdict === 'ok' ? '✅ 問題なし' : result.verdict === 'warn' ? '⚠️ 要確認' : '⏭ 実施できませんでした'}
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
              <span className="ml-2 text-[11px] text-ink-muted">押すとチャットに移り、AIが直します</span>
            </span>
          )}
        </div>
      )}
    </section>
  )
}
