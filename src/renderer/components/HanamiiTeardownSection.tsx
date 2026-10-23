// HanamiiTeardownSection.tsx — 【公開】(HanamiiPanel) の「🗑 この公開を破棄する」(H1) と、破棄の結果の表示。
//
// 段階1の1c。設計書: docs/teardown-unify-plan.md の 10.4.4 の H1。HanamiiPanel.tsx（1,000行を超える巨大ファイル）の
// 破棄の節だけを、ここへ切り出した（触った節は 400 行以下のモジュールへ。CLAUDE.md「調査のしかた」）。
//
// 確認の文・窓を閉じる警告・キーの読み方・IPC の呼び形は、公開先ごとの仕様書（teardown/targets/hanamii.ts）と
// 共通の流れ（teardown/flow.ts の runTeardownFlow）が受け持つ。この節が持つのは、押せる場所と、画面の後始末だけ。
// 📡 一覧の行（TeardownRow）と同じ流れを通るので、確認の文は入口によらず同じになる（Sidebar も段階1の1dで同じ流れに載る）。
// **仕様書の invoke を直接呼ばない**（入口が迂回すると、確認も窓を閉じる警告もキーなしの失敗も飛ばせる。
// tests/hanamiiTeardownSection.test.ts・tests/hanamiiTeardownSectionResult.test.ts が、確認を飛ばせないことと、この節の呼び形を固定している）。
//
// 結果は2つの出どころから出る:
//   ・main が記録した結果（閉じて開き直しても出る）… HanamiiPanel が自分の記録の監視（useProjectOpsView）で持ち、
//     終わった記録を HanamiiOpResult → HanamiiTeardownResult（ここ）で描く。**手本の手順6と同じ形**: 画面は記録の監視を持ち続け、
//     破棄は流れを直接呼ぶ。
//   ・記録が作られない断り方（消すものが記録に無い・記録を読めない・トークンが無い・別の操作が走っている・例外）… この節が
//     その場で `refused` に持って出す。
// どちらも同じ結果欄の部品（TeardownResultView）で描く。
//
// 公開の記録（📡 の行・projectId）は、**ここでも画面でも消さない**。消すのは main の hanamii:teardown の1か所だけ
// （画面が書くと、記録の再生で新しい公開の記録まで消える。HanamiiPanel の showTornDown のコメント）。
import { useRef, useState } from 'react'
import { useConfirm } from '../useConfirm'
import { runTeardownFlow, electronFlowDeps } from '../teardown/flow'
import { hanamiiTeardownSpec, HANAMII_TEARDOWN_WORDS, HANAMII_KEY_MISSING_MESSAGE } from '../teardown/targets/hanamii'
import type { useProjectOpsView } from '../hooks/useProjectOpsView'
import { PUBLISH_TARGET_CONSOLE } from '../publishStatus'
import { clockText } from '../../shared/opsText'
import { isStoppedByQuit, stoppedWhenText } from '../../shared/inFlightOps'
import { resumedTeardownView, type TeardownView } from '../../shared/teardownResult'
import TeardownResultView from './teardown/TeardownResultView'
import { CONTROL_PANEL_URL } from './ServicePrincipalSection'

/** 結果欄の部品に、HANAMII の言葉と管理画面の行き先を渡す。その場の結果（refused）と記録から読んだ結果で同じ。 */
function HanamiiTeardownView({ view }: { view: TeardownView }) {
  return (
    <TeardownResultView
      view={view} notes={[]} words={HANAMII_TEARDOWN_WORDS}
      retryHint="「🗑 この公開を破棄する」"
      serviceConsoleUrl={PUBLISH_TARGET_CONSOLE.hanamii} storageConsoleUrl={CONTROL_PANEL_URL}
      onAskAi={text => window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text } }))}
    />
  )
}

/**
 * 終わった HANAMII の破棄1件（main の処理の記録）を、結果として出す。HanamiiPanel の HanamiiOpResult が、
 * 削除の記録をここへ渡す（公開の記録は HanamiiOpResult が描く）。
 */
export function HanamiiTeardownResult({ rec }: { rec: ProjectOpRecordShape }) {
  // 「Koto の終了で止まりました」の知らせは、記録の startedAt が識別子（始まった時刻ではない）。最後に分かった時刻で言い、「に始まった操作」とは言わない。
  const caption = isStoppedByQuit(rec.result) ? stoppedWhenText(rec.finishedAt) : `${clockText(rec.startedAt)} に始まった操作`
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-ink-muted">🗑 破棄の結果（{caption}）</p>
      <HanamiiTeardownView view={resumedTeardownView('hanamii', rec.result)} />
    </div>
  )
}

export default function HanamiiTeardownSection({ projectDir, locked, ops, onStart, onFinished, onTornDown }: {
  /** いま開いているプロジェクト。破棄は最長で数分かかり、その間に別のプロジェクトへ切り替わりうる（掟11）。 */
  projectDir: string
  /**
   * 押せない間。**main の鍵**（この画面が頼んだ公開・破棄・開き直した画面が記録で知った操作・別の公開先の操作）だけで止める。
   * HANAMII 側の状態が BUILDING のままだからといって止めない: 公開が「待つ時間のうちに動かなかった（pending）」で終わると
   * 状態は BUILDING のまま残り、↻ で取り直しても変わらないことがある。そのとき、止まったままの版をこの画面から破棄できなくなる。
   * main の鍵とは関係ない理由で、押せない理由も出さずに止めてはいけない（2026-09-30 検分）。
   */
  locked: boolean
  /** 記録の監視（HanamiiPanel が持つ）。流れのあとに記録を読み直し、この破棄の結果が記録に残ったかを見るのに使う。 */
  ops: Pick<ReturnType<typeof useProjectOpsView>, 'sync' | 'didFinishSince'>
  /** 確認のあと、実行が始まる直前（画面を「破棄中」にして、前の結果を片づける）。やめたときは呼ばれない。 */
  onStart: () => void
  /** 始めた破棄が終わった（成功も失敗も）。画面の「破棄中」を下ろす。 */
  onFinished: () => void
  /** 破棄が済んだ。画面の表示だけを消えた状態にする（記録の片づけは main が済ませている）。 */
  onTornDown: () => void | Promise<void>
}) {
  const { confirm, element: confirmElement } = useConfirm()
  /** 記録が作られない断り方の結果。どのプロジェクトのものかを持ち、別のプロジェクトの画面には出さない（掟11）。 */
  const [refused, setRefused] = useState<{ dir: string; view: TeardownView } | null>(null)
  /** 押してから終わるまでの二重押しを止める（state の更新を待たずに効く）。 */
  const startedRef = useRef(false)
  const dirRef = useRef(projectDir)
  dirRef.current = projectDir

  const start = async () => {
    if (startedRef.current || locked) return
    startedRef.current = true
    // 呼んだときのプロジェクト。切り替わったあとの結果は、いまの画面（別のプロジェクト）へ入れない。
    const stale = () => dirRef.current !== projectDir
    // main が動き出したか（確認のあと）。動いたなら記録が残る。動く前の断り（記録を読めない・消すものが無い・トークンが無い）は残らない。
    let began = false
    let askedAt = 0
    /** この破棄の結果が記録に残っていないときだけ、その場の結果として出す（記録にあれば、記録のほうが出す）。 */
    const showIfUnrecorded = (view: TeardownView) => {
      if (!began || !ops.didFinishSince('hanamii:teardown', askedAt)) setRefused({ dir: projectDir, view })
    }
    try {
      const outcome = await runTeardownFlow(projectDir, hanamiiTeardownSpec, electronFlowDeps(projectDir, hanamiiTeardownSpec, {
        confirm,
        keyMissingMessage: HANAMII_KEY_MISSING_MESSAGE,
        onStart: () => { began = true; askedAt = Date.now(); setRefused(null); onStart() },
      }))
      if (outcome.cancelled || stale()) return
      const r = outcome.result
      // 消せたら、画面の表示を消えた状態にする。設定の projectId と公開の記録の片づけは main が済ませている。
      // 保存場所だけ残った回（appDeleted で ok が false）は、記録も projectId も残る——残さないと 🗑 が消えて、もう一度押す場所が無くなる。
      if (r.ok) await onTornDown()
      if (began) await ops.sync()
      if (!r.ok) showIfUnrecorded(hanamiiTeardownSpec.toView(r))
    } catch (e: any) {
      if (stale()) return
      if (began) await ops.sync()
      showIfUnrecorded(hanamiiTeardownSpec.toView(hanamiiTeardownSpec.failure(`破棄処理でエラーが発生しました: ${e?.message ?? String(e)}`)))
    } finally {
      startedRef.current = false
      if (began && !stale()) onFinished()
    }
  }

  return (
    <div className="space-y-2">
      <button
        onClick={() => { void start() }}
        disabled={locked}
        className="text-xs text-ink-muted hover:text-brand-red disabled:opacity-40"
      >🗑 この公開を破棄する</button>
      {refused && refused.dir === projectDir && <HanamiiTeardownView view={refused.view} />}
      {confirmElement}
    </div>
  )
}
