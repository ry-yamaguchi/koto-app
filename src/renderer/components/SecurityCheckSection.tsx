import { useEffect, useRef, useState } from 'react'
import { runSecurityCheck, planAiCheck, aiCheckBudget, SecurityCheckResult, CheckRecord, checkRecordKey, formatCheckRecord } from '../securityCheck'
import { foldSecurity } from '../appRunFolding'
import { buildSecurityFixPrompt, fixItemsOf, mergeFixItems } from '../../shared/aiCheckFindings'
import { createRunGate, runScanFlow, runAiFlow } from '../securityCheckFlow'
import type { AiEstimate } from '../aiCheckEstimate'
import AiCheckEstimateBox from './AiCheckEstimateBox'
import CopyButton from './CopyButton'
import SecurityReportBody from './SecurityReportBody'
import { failureCopyNow } from '../failureCopy'
import OsvCheckBlock from './OsvCheckBlock'
import PublishScanResult from './PublishScanResult'
import { runPublishScanResult, type PublishScanOutcome } from '../publishScanRun'
import {
  PUBLISH_SCAN_PROGRESS, PUBLISH_SCAN_BUTTON_NO_AI, PUBLISH_SCAN_BUSY, PUBLISH_SCAN_NO_AI_NOTE,
} from '../publishScanWords'

// 🛡 セキュリティチェックの節。公開フローの「事前チェック」の次に置く
// （2026-08-21 Ryosuke 指定。最初は上部バーに置いたが、公開の流れの中が自然）。
//
// 流れは securityCheckFlow.ts（依存は引数）。ここは状態を持って、押されたら流れを呼ぶだけ。
// 【ファイルを点検する】は Koto の点検だけ（キーがあれば続けて送る前の見積りを作る）。
// 【AIに確認してもらう】は、見積りの枠の中のボタンを押したときだけ AI の確認が始まる。
// 公開時の自動実行は 2026-08-21 に作者の指摘で廃止した（コミット 94e0c08。毎回は不要）。
// 公開はこの確認の最中でも押せる（任意の確認のため。押したときだけ実行する、という上の決定の帰結）。
// どの公開先（AppRun / Vercel / HANAMII / レンタルサーバ）でも、この同じ部品を使う。
// stepNo: 呼び出し元の画面の番号体系に乗せるための見出し番号（例 '手順4'）。
// 渡されなければ従来どおり番号なし（PublishModal は番号体系を持たない画面のため未指定・2026-09-04 Ryosuke 指摘）。
export default function SecurityCheckSection({ projectDir, apiKey, stepNo }: { projectDir: string; apiKey: string; stepNo?: string }) {
  // 点検が走っている間／AI の確認が走っている間（どちらも、押し直しは gate が止める）
  const [scanning, setScanning] = useState(false)
  const [aiRunning, setAiRunning] = useState(false)
  const checking = scanning || aiRunning
  // 走らせたプロジェクト。別のプロジェクトへ替えたら、進み具合と中止の口は出さない（走らせた側の持ち物）
  const [runDir, setRunDir] = useState<string | null>(null)
  const mine = checking && runDir === projectDir
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
  const abortRef = useRef<(() => void) | null>(null)
  // 押したあと、実際に止まるまでのあいだ（通信が切れるまで）の表示用
  const [stopping, setStopping] = useState(false)
  // 「中止した」のか「そもそも実施できなかった」のかを取り違えないための印。
  // 押した本人に「実施できませんでした」とだけ見せると、失敗したように読める
  const [aborted, setAborted] = useState(false)
  // Koto が自分で読んで点検した結果（AI は使わない）。押した時点のプロジェクトのものだけ置く
  const [scan, setScan] = useState<PublishScanOutcome | null>(null)
  // 送る前の見積り（点検を押した時点のもの。送るときに計画し直すので、数は変わりうる）
  const [estimate, setEstimate] = useState<AiEstimate | null>(null)
  // 走っている間の押し直しを止める札（点検と AI の確認で1つ）
  const gateRef = useRef(createRunGate())
  const dirRef = useRef(projectDir)
  dirRef.current = projectDir
  const isCurrent = (dir: string) => dirRef.current === dir

  useEffect(() => {
    // 別プロジェクトの結果・見積りを見せない
    setResult(null)
    setScan(null)
    setEstimate(null)
    try {
      const raw = window.localStorage.getItem(checkRecordKey(projectDir))
      setRecord(raw ? JSON.parse(raw) as CheckRecord : null)
    } catch { setRecord(null) }
  }, [projectDir])

  /** 【ファイルを点検する】。Koto の点検だけ。キーがあれば、続けて見積りを作る（AI は呼ばない）。 */
  function runScan() {
    void runScanFlow({
      projectDir, apiKey,
      gate: gateRef.current,
      isCurrent,
      deps: {
        runScan: (dir) => runPublishScanResult(dir, 'publish'),
        planAiCheck: (dir) => planAiCheck(dir),
        aiCheckBudget,
      },
      on: {
        start: () => {
          setRunDir(projectDir)
          setScanning(true)
          setStopping(false)
          setAborted(false)
          setResult(null)
          setScan(null)
          setEstimate(null)
          setProgress(PUBLISH_SCAN_PROGRESS)
        },
        scan: setScan,
        estimate: setEstimate,
        finish: () => { setScanning(false); setRunDir(null); setProgress('') },
      },
    })
  }

  /** 見積りの枠の【AIに確認してもらう】。ここからだけ AI の確認が始まる。 */
  function runAi() {
    void runAiFlow({
      projectDir, apiKey, estimate,
      gate: gateRef.current,
      isCurrent,
      deps: {
        runSecurityCheck,
        writeRecord: (dir, rec) => window.localStorage.setItem(checkRecordKey(dir), JSON.stringify(rec)),
      },
      on: {
        start: () => {
          setRunDir(projectDir)
          setAiRunning(true)
          setStopping(false)
          setAborted(false)
          setResult(null)
          setProgress('')
        },
        progress: setProgress,
        abortReady: (abort) => { abortRef.current = abort },
        result: (r, rec) => {
          setResult(r)
          if (rec) setRecord(rec)
        },
        finish: () => {
          abortRef.current = null
          setAiRunning(false)
          setRunDir(null)
          setStopping(false)
          setProgress('')
        },
      },
    })
  }

  /** 「中止する」を押したとき。いま待っている問い合わせを切り、残りのかたまりへ進ませない。 */
  function stop() {
    if (!aiRunning) return
    setStopping(true)
    setAborted(true)
    abortRef.current?.()
  }

  // 修正の依頼文は buildSecurityFixPrompt の1か所で組む。Koto の点検の指摘（行のあるもの）と AI の確認の指摘を、
  // 同じ ファイル:行 は点検のほうを残して1つにする
  const fixPrompt = buildSecurityFixPrompt(mergeFixItems(scan?.fixItems ?? [], fixItemsOf(result?.findings ?? [])))

  return (
    <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-ink">{stepNo ? `${stepNo} ` : ''}🛡 簡易セキュリティチェック</p>
        <div className="flex-none flex items-center gap-2">
          {/* ── 中止（2026-09-25 検分の指摘6・S6）────────────────────────
              受け口（onAbortReady）と、押されたときに本当に止まる振る舞いは
              securityCheck.ts 側にあったが、**押すところが画面に無かった**。
              押せない中断は無いのと同じなので、確認中はここに必ず出す。 */}
          {aiRunning && mine && (
            <button
              onClick={stop}
              disabled={stopping}
              className="bg-overlay text-ink border border-line rounded-md px-3 py-1 text-xs font-medium hover:border-brand-red disabled:opacity-40"
            >{stopping ? '中止しています…' : '⏹ 中止する'}</button>
          )}
          <button
            onClick={runScan}
            disabled={checking}
            className="bg-overlay text-ink border border-line rounded-md px-3 py-1 text-xs font-medium hover:border-sakura disabled:opacity-40"
          >{scanning ? PUBLISH_SCAN_BUSY : PUBLISH_SCAN_BUTTON_NO_AI}</button>
        </div>
      </div>
      {/* ── 免責は「押す前」に読める位置に置く（2026-08-21 Ryosuke 指摘）────────
          結果の中（{result && …}）にしか置いておらず、**実行前・実行中は
          最終的な確認がご自身であることが画面から消えていた**。
          文言も実態に合わせる（何を見るか／このあと選べること／責任の所在）。 */}
      <p className="text-[11px] text-ink-muted leading-relaxed">
        {apiKey ? (
          <>
            秘密情報の書き込みや危険な記述がないかを、Koto の点検と AI の確認で調べます。<br />
            公開されるファイルを、原則すべて確認します（確認しきれなかったファイルは、結果に名前を出します）。<br />
            AI の確認では、ファイルの中身をさくらのAI Engine へ送ります。パスワードなどに見えるものは伏せて送ります。<br />
            チェック後、修正するかどうか選択可能です。<br />
            簡易的な確認であるため、最終的にはご自身で確認してください。
          </>
        ) : (
          <>
            秘密情報の書き込みや危険な記述がないかを、Koto が点検します。<br />
            公開されるファイルを、原則すべて確認します（確認しきれなかったファイルは、結果に名前を出します）。<br />
            簡易的な確認であるため、最終的にはご自身で確認してください。
          </>
        )}
      </p>

      {/* 前回の確認。**結果を表示していないときだけ**出す（同じことを二度書かない）。
          古い日付が残っていること自体が「そろそろ確認しよう」の材料になる */}
      {!result && !checking && formatCheckRecord(record) && (
        <p className="text-[11px] text-ink-muted">🕐 {formatCheckRecord(record)}</p>
      )}

      {mine && (
        <>
          <p className="text-xs text-ink-secondary">⏳ {progress || '準備しています…'}</p>
          {/* 待たされている人に、止められることを字で伝える（ボタンだけだと気づかれない） */}
          {aiRunning && (
            <p className="text-[11px] text-ink-muted">
              {stopping
                ? '中止しています。少しお待ちください。'
                : '時間がかかるときは「⏹ 中止する」で AI の確認を止められます。途中までの結果は「確認した」ことにはしません。'}
            </p>
          )}
        </>
      )}

      {scan && <PublishScanResult view={scan.view} />}
      {scan && !apiKey && <p className="text-[11px] text-ink-muted">{PUBLISH_SCAN_NO_AI_NOTE}</p>}
      {/* 送る前の見積り。キーが無い・消えたときは出さない（描く時点の apiKey を見る） */}
      {estimate && apiKey && (
        <AiCheckEstimateBox estimate={estimate} running={aiRunning && mine} disabled={checking} onRun={runAi} />
      )}

      {/* ── 全部✅なら1行に畳む（判断6・利用者目線レビュー・2026-09-11）──────────────
          手順3 事前チェック（AppRunPanel.tsx）の「preflight.checks.every(c => c.status === 'ok')」
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
              <SecurityReportBody result={result} />
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
              {/* 実施できなかった（失敗の文）ときだけ、版と日時を添える。要確認の報告にはスタンプを付けない */}
              <CopyButton text={result.report} title="チェック結果をコピー" getText={result.verdict === 'skip' && !aborted ? () => failureCopyNow(result.report) : undefined} />
            </div>
            {/* 結果は目印方式で「判定＋指摘（最大5件）」だけに絞ってある（＝要約）。
                思考の文章は securityCheck 側で捨てるので、ここには届かない */}
            <SecurityReportBody result={result} />
          </div>
        )
      )}
      {/* 修正のボタンは、点検と AI の確認の2つの枠の下に1つだけ */}
      {fixPrompt !== null && !checking && (
        <span className="block">
          <button
            onClick={() => {
              // 指摘のファイル・行・種類だけから作った依頼文をチャットへ（そのまま送信される）。
              // 組み立ては buildSecurityFixPrompt の1か所（AI の文・引用・値は入れようがない）
              window.dispatchEvent(new CustomEvent('sakura:fix-with-ai', { detail: { text: fixPrompt } }))
            }}
            className="sakura-gradient text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:opacity-90"
          >🛠 AIに修正させる</button>
          {/* W-104: 「AIが直します」は言い切りすぎ。応答中は入力欄に置かれるだけで、
              自動では送られない・直せない項目もあることを添える（決定: 案2）。 */}
          <span className="ml-2 text-[11px] text-ink-muted">押すとチャットに移り、AIに直すよう頼みます（AIが応答中のときは入力欄に入るので、終わってから送信してください）</span>
        </span>
      )}
      <OsvCheckBlock projectDir={projectDir} />
    </section>
  )
}
