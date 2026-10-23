// DedicatedTeardownSection.tsx — 専有型タブ（AppRunDedicatedPanel）の「手順6 作ったものを削除する」の節と、その「すべて削除する」の流れ。
//
// 段階3B の 3B-6a。設計書: docs/teardown-unify-plan.md の 10.11.9（D1 手順6）。AppRunDedicatedPanel.tsx（3,000行を超える巨大ファイル）の
// 手順6の節だけを、ここへ切り出した（触った節は 400 行以下のモジュールへ。CLAUDE.md「調査のしかた」）。手本は SharedTeardownSection.tsx（S1）。
//
// 確認の文・窓を閉じる警告・キーの読み方・IPC の呼び形・進み具合の購読は、専有型の仕様書（teardown/targets/dedicated.ts）と
// 共通の流れ（teardown/flow.ts の runTeardownFlow）が受け持つ。この節が持つのは、押せる場所・節の見た目・画面の後始末の受け渡しだけ:
//   ・二重押しを止める（確認を待つ間も。state の更新を待たずに効く）
//   ・確認のあと（実行が始まる直前）だけ画面へ知らせる（やめたときは何も起きない）
//   ・プロジェクトが切り替わったら、前のプロジェクトの結果を画面へ渡さない（掟11）
// 📡 一覧の行（TeardownRow）・プロジェクトの削除と同じ流れを通るので、確認の文は入口によらず同じになる。
// **仕様書の invoke を直接呼ばない**（入口が迂回すると、確認も窓を閉じる警告もキーなしの失敗も飛ばせる。
// tests/dedicatedTeardownSection.test.ts が、確認を飛ばせないことと、この節の呼び形を固定する）。
//
// 公開の記録（📡 の行・publish.targets）は、**ここでも画面でも消さない**。消すのは main の apprunDedicated:teardown の1か所だけ
// （main の骨 teardownShell が、保存場所まで片づいた回だけ消す）。
//
// この節が import してよい専有型の部品は apprunDedicatedActions.ts の純関数だけ。**パネル本体（AppRunDedicatedPanel.tsx）は import しない**
// （パネル → 節 → パネルの循環になる）。「いまの構成と月額目安」の行（buildTeardownSummary）はパネルが持つ関数を呼ぶので、
// パネルが作って `summaryLines` で渡す。
//
// 結果は2つの出どころから、同じ結果欄の部品（TeardownResultView）で描く:
//   ・この画面が始めた削除の返り値 … onDone へ渡す（パネルが teardownView に入れる）
//   ・閉じて開き直したときの main の処理の記録 … パネルの記録の見張り（hooks/useDedicatedOpsWatch.ts）が resumedTeardownView で同じ形にして渡す
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useConfirmChoices } from '../useConfirmChoices'
import { runTeardownFlow, electronFlowDeps, teardownProgressText } from '../teardown/flow'
import { dedicatedTeardownSpec, DEDICATED_TEARDOWN_WORDS, DEDICATED_PANEL_KEY_MISSING_MESSAGE } from '../teardown/targets/dedicated'
import type { TeardownResumedNote } from '../teardown/watch'
import { shouldShowTeardownList, storageLeftoverNote } from '../apprunDedicatedActions'
import { PUBLISH_TARGET_CONSOLE } from '../publishStatus'
import { teardownDataNoteFor, dedicatedStorageLeftoverNames } from '../../shared/teardownSupport'
import type { TeardownView } from '../../shared/teardownResult'
import TeardownProgress from './teardown/TeardownProgress'
import TeardownResultView from './teardown/TeardownResultView'
import { CONTROL_PANEL_URL } from './ServicePrincipalSection'

/** 画面（AppRunDedicatedPanel）が、削除の流れに渡す口。 */
export type DedicatedTeardownPanel = {
  /** 押せない間（手順5・6・8・IP の取り直しのどれかが走っている）。パネルの panelBusy の答え。 */
  locked: boolean
  /**
   * 確認に「削除する」と答えたあと、実行が始まる直前。画面を「削除中」にして、前の結果を片づけ、記録の見張りへ「この画面が始めた」と伝える。
   * やめたときは呼ばれない。
   */
  onStart: () => void
  /**
   * 終わった（成功も失敗も、断られた回も）。結果を画面へ入れ、記録を取り直し、実行中の印を下ろす。
   * `stale` は、待っている間にプロジェクトが切り替わった回。**前のプロジェクトの結果を、いまの画面へ入れない**（実行中の印だけ下ろす）。
   */
  onDone: (view: TeardownView, stale: boolean) => Promise<void>
}

/**
 * 手順6の「すべて削除する」の流れ。`start` を押せる場所（ボタン）から呼ぶ。`confirmElement` は節の描画に置く（確認ダイアログ）。
 * `progressLocal` は、この画面が始めた削除に届いた最新の進み具合の1行（記録から読めるときは記録の文を使う）。
 */
export function useDedicatedPanelTeardown(projectDir: string, panel: DedicatedTeardownPanel): {
  start: () => Promise<void>
  confirmElement: ReactElement
  progressLocal: string | null
} {
  const { confirm, element: confirmElement } = useConfirmChoices()
  const [progressLocal, setProgressLocal] = useState<string | null>(null)
  /** 押してから終わるまでの二重押しを止める（確認を待つ間も。state の更新を待たずに効く）。 */
  const startedRef = useRef(false)
  const dirRef = useRef(projectDir)
  dirRef.current = projectDir
  // 画面の口は最新のものを使う（押してから終わるまでに、画面は何度も描き直される）。
  const panelRef = useRef(panel)
  panelRef.current = panel

  // 削除の進み具合のイベント（段が一覧から消えるまで待つ間、30秒ごとに1行）。購読の1行は仕様書の subscribeProgress。
  useEffect(() => {
    let unsubscribe = () => {}
    try { unsubscribe = dedicatedTeardownSpec.subscribeProgress?.(msg => setProgressLocal(msg)) ?? unsubscribe } catch { /* preload が無い環境 */ }
    return () => { unsubscribe() }
  }, [])

  const start = async () => {
    if (startedRef.current || panelRef.current.locked) return
    startedRef.current = true
    // 呼んだときのプロジェクト。切り替わったあとの結果は、いまの画面（別のプロジェクト）へ入れない。
    const stale = () => dirRef.current !== projectDir
    try {
      let view: TeardownView | null = null
      try {
        // 0.6.21: 手順6は見出し・ボタン・確認・進み具合・結果まで「削除」で揃える（1回の流れの中で名前を変えない）。
        // 確認の文・材料の読み方は共通の部品が作る（画面の写しはいつでも古いので、材料は押した時点の main の記録から読む）。
        const outcome = await runTeardownFlow(projectDir, dedicatedTeardownSpec, electronFlowDeps(projectDir, dedicatedTeardownSpec, {
          confirm,
          keyMissingMessage: DEDICATED_PANEL_KEY_MISSING_MESSAGE,
          // 実行が始まる直前（確認のあと）。IPC を呼ぶ前に「この画面が始めた」と記録の見張りへ伝える。前回の進み具合の行は消す。
          onStart: () => { setProgressLocal(null); panelRef.current.onStart() },
        }))
        if (!outcome.cancelled) view = dedicatedTeardownSpec.toView(outcome.result)
      } catch (e: any) {
        // 流れが投げた（IPC の例外）。文は素の message（専有型の流れに「破棄」を出さない）。
        view = dedicatedTeardownSpec.toView(dedicatedTeardownSpec.failure(e?.message ?? String(e)))
      }
      // やめた回は何も起きない（画面は動いていない）。
      if (view) await panelRef.current.onDone(view, stale())
    } finally {
      startedRef.current = false
    }
  }

  return { start, confirmElement, progressLocal }
}

/**
 * 手順6の節。パネルは、出す条件（`showButton` か結果がある）を満たすときだけ、この要素を置く。
 * 押せるか（`locked`）・実行中か（`tearingDown`）・記録が「削除が走っている」と言うか（`running`）は、パネルが決めて渡す。
 */
export default function DedicatedTeardownSection({
  projectDir, locked, showButton, tearingDown, running, runningRecord, nowMs,
  apprunState, appRecord, summaryLines, view, notes, onStart, onDone,
}: {
  /** いま開いているプロジェクト。削除は最長で数分かかり、その間に別のプロジェクトへ切り替わりうる（掟11）。 */
  projectDir: string
  /** 押せない間。 */
  locked: boolean
  /** 消すものが記録にあるか、削除が走っている（shouldShowTeardownButton）。出ていなければ、結果だけを描く。 */
  showButton: boolean
  /** この画面が始めた削除か、記録が走っていると言う削除がある。 */
  tearingDown: boolean
  /** 記録（projectOps）が「手順6の削除が走っている」と言っているか。 */
  running: boolean
  runningRecord: ProjectOpRecordShape | null
  nowMs: number
  /** `apprunDedicated:state` の返り値（記録の資源の ID・保存場所の残り）。 */
  apprunState: ApprunDedicatedRecordShape | null
  /** `apprunDedicated:appStatus` の record（アプリの名前・バージョン）。APIキーが無いときは null。 */
  appRecord: ApprunDedicatedRecordShape | null
  /** 「いまの構成と月額目安」の行。パネルの buildTeardownSummary の結果（記録に資源が無いときは空＝この欄を出さない）。 */
  summaryLines: string[]
  /** 結果（この画面が始めた削除の返り値・開き直したときの記録から読んだもの）。 */
  view: TeardownView | null
  /** 閉じて開き直したあとの結果に添える知らせ（見逃してはいけない警告）。 */
  notes: TeardownResumedNote[]
  onStart: () => void
  onDone: (view: TeardownView, stale: boolean) => Promise<void>
}) {
  const { start, confirmElement, progressLocal } = useDedicatedPanelTeardown(projectDir, { locked, onStart, onDone })

  /**
   * このプロジェクトの保存場所（用意していなければ0件）。2026-09-24。
   *
   * **確認ダイアログに名前を出すために要る。** 手順6の削除で保存場所の中身も消える。名指ししない確認は嘘になる（掟5）。
   * 読み方は共用型 AppRunPanel.tsx とまったく同じ（storage:placement・`sakura:storage-prepared`）。
   *
   * 1件ではなく**全件**を持つ（2026-09-25 検分の指摘23・37）。手順6は `teardownStorageForProject` を通って**同意済みの保存場所を全件**
   * 片づけるので、先頭1件（placements[0]）の別名は置かない（置くと、次に文面を書く人がまた1件だけで組み立てる）。
   */
  const [placements, setPlacements] = useState<{ bucket: string; prefix: string; shared: boolean }[]>([])
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await window.electronAPI.storage.placement(projectDir)
        // placements は main が必ず返す。古い形しか返らなかったときのために placement 1件へ落ちる道も残す——**黙って0件にしない**（消えるものが隠れる）。
        if (alive && r.ok) setPlacements(r.placements ?? (r.placement ? [r.placement] : []))
      } catch { /* 読めなくても公開・削除そのものはできる */ }
    }
    void load()
    // この画面を開いたあとに用意されることがある（【公開】の案内から）。取り直さないと、確認が保存場所を知らないまま「消えません」と受け取れる文面になる。
    const onPrepared = () => { void load() }
    window.addEventListener('sakura:storage-prepared', onPrepared)
    return () => { alive = false; window.removeEventListener('sakura:storage-prepared', onPrepared) }
  }, [projectDir])

  const leftoverNote = storageLeftoverNote(dedicatedStorageLeftoverNames(apprunState))

  return (
    <section className="rounded-xl border border-brand-red/70 bg-surface p-4 space-y-3">
      <p className="text-sm font-semibold text-ink">手順6 作ったものを削除する</p>

      {showButton && (
        <>
          <p className="text-xs font-semibold text-brand-red leading-relaxed">
            ⚠️ 消さない限り課金が続きます。この操作は元に戻せません。
          </p>
          {/* 2026-09-24 検分の指摘1: 計算資源が消えたあとに保存場所だけが残ったときも、
              手順6を押し直して片づけられるようにする（窓を開き直しても記録から復元できる）。 */}
          {leftoverNote && (
            <p className="text-xs font-semibold text-brand-red leading-relaxed select-text">
              🗄️ {leftoverNote}
            </p>
          )}
          {/* 2026-09-24（案2）: 保存場所を使っているなら、押す前にデータのことも言う
              （共用型 AppRunPanel.tsx の破棄画面と同じ一元定義・同じ見た目）。 */}
          {/* 2026-09-25 検分の指摘23・37: 消える保存場所は全件を並べる（1件も隠さない）。 */}
          {placements.map((p, i) => (
            <p key={`${p.bucket}-${i}`} className="text-xs text-brand-red leading-relaxed select-text">💾 {teardownDataNoteFor({ target: 'sakura-apprun-dedicated', placement: p })}</p>
          ))}
          {summaryLines.length > 0 && (
            /* 3b: いまの構成と月額目安（利用者目線レビュー・判断不要）。計算は複製せずパネルの buildTeardownSummary の結果をそのまま使う（掟10）。
               クラスタの情報が材料なので、クラスタ・ASG・LB のどれかがあるときだけ（無いときは行が空で渡る）。 */
            <div className="rounded-lg border border-line bg-overlay p-3 space-y-0.5">
              <p className="text-[11px] font-semibold text-ink-secondary">いまの構成と月額目安</p>
              {summaryLines.map((line, i) => (
                <p key={i} className="text-xs text-ink-secondary select-text">{line}</p>
              ))}
            </div>
          )}
          {/* 何を消すかの一覧。ボタンと同じ判断（shouldShowTeardownList・dedicatedTeardownHasWork から保存場所の印だけを除く）で出す
              ——アプリのIDだけの記録でも、ボタンがあるのに一覧が無い、にしない（2026-10-08 検分）。アプリの行は
              appStatus（APIキーが要る）が無くても、記録（apprunState）から出す。 */}
          {shouldShowTeardownList(apprunState) && (
            <ul className="text-xs text-ink-secondary leading-relaxed list-disc pl-5">
              {(appRecord?.applicationID ?? apprunState?.applicationID) && (
                <li>アプリ『{appRecord?.applicationName ?? apprunState?.applicationName ?? appRecord?.applicationID ?? apprunState?.applicationID}』（バージョン {appRecord?.activeVersion ?? apprunState?.activeVersion ?? '不明'}）</li>
              )}
              {apprunState?.loadBalancerID && <li>ロードバランサ『{apprunState.loadBalancerID}』</li>}
              {apprunState?.asgID && <li>オートスケーリンググループ『{apprunState.asgID}』</li>}
              {apprunState?.clusterID && <li>クラスタ『{apprunState.clusterID}』</li>}
            </ul>
          )}
          <button
            onClick={() => { void start() }}
            disabled={locked}
            className="bg-brand-red-fill text-white rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-40"
          >{tearingDown ? DEDICATED_TEARDOWN_WORDS.running : 'すべて削除する'}</button>
          {/* 進み具合（各段が一覧から消えるまで待つ文・待っている段の目安・始まってからの時間・閉じても進むこと）。📡 の行と同じ部品。 */}
          {tearingDown && (
            <TeardownProgress
              words={DEDICATED_TEARDOWN_WORDS}
              progress={teardownProgressText({ running, runningRecord, local: progressLocal })}
              running={running} runningRecord={runningRecord} nowMs={nowMs}
            />
          )}
        </>
      )}

      {/* 閉じて開き直したとき（2026-09-29）の知らせ（警告）と、結果（すべて削除しました／削除中です／残っているもの）。
          📡 の行の結果と同じ部品。入口ごとに違うのは、押し直す場所の呼び方（手順6）と、失敗のときの「🤖 AIに相談する」を出すかだけ。 */}
      <TeardownResultView
        view={view}
        notes={notes}
        words={DEDICATED_TEARDOWN_WORDS}
        retryHint="手順6"
        serviceConsoleUrl={PUBLISH_TARGET_CONSOLE['sakura-apprun-dedicated']}
        storageConsoleUrl={CONTROL_PANEL_URL}
        onAskAi={text => window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text } }))}
      />
      {confirmElement}
    </section>
  )
}
