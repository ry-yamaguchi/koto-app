// SharedTeardownSection.tsx — 【公開】(AppRunPanel) の「🗑 破棄する（削除）」(S1・S2) の流れと、共用型の破棄の結果の表示。
//
// 段階2の2c。設計書: docs/teardown-unify-plan.md の 10.7.9（S1・S2）と、10.7.16 末尾の親の判断（2026-10-10）。
// AppRunPanel.tsx（1,000行を超える巨大ファイル）の破棄の節だけを、ここへ切り出した（触った節は 400 行以下のモジュールへ。CLAUDE.md「調査のしかた」）。
// 手本は HanamiiTeardownSection.tsx（H1）。
//
// 確認の文・選択（コンテナレジストリを消すか）・窓を閉じる警告・キーの読み方・IPC の呼び形は、共用型の仕様書（teardown/targets/shared.ts）と
// 共通の流れ（teardown/flow.ts の runTeardownFlow）が受け持つ。この節が持つのは、押したあとの画面の後始末の受け渡しだけ:
//   ・二重押しを止める（確認を待つ間も。state の更新を待たずに効く）
//   ・確認のあと（実行が始まる直前）だけ画面へ知らせる（やめたときは何も起きない）
//   ・プロジェクトが切り替わったら、前のプロジェクトの結果を画面へ渡さない（掟11）
// 📡 一覧の行（TeardownRow）・プロジェクトの削除と同じ流れを通るので、確認の文は入口によらず同じになる。
// **仕様書の invoke を直接呼ばない**（入口が迂回すると、確認も窓を閉じる警告もキーなしの失敗も飛ばせる。tests/sharedTeardownEntries.test.ts〔2d〕と
// tests/hanamiiTeardownEntries.test.ts が、流れを呼ぶのはこの節の1か所だけであることを固定する）。
//
// 公開の記録（📡 の行・publish.targets）は、**ここでも画面でも消さない**。消すのは main の cloud:teardown の1か所だけ
// （画面が書くと、main の記録と二重になり、失敗の回に行まで消える）。
//
// 結果は2つの出どころから、同じ結果欄の部品（SharedTeardownResultView）で描く:
//   ・この画面が始めた破棄の返り値 … onDone へ渡す（AppRunPanel が opResult に入れる）
//   ・閉じて開き直したときの main の処理の記録 … AppRunPanel の opResultFromRecord が resumedTeardownView で同じ形にする
import { useRef, type ReactElement } from 'react'
import { useConfirmChoices } from '../useConfirmChoices'
import { runTeardownFlow, electronFlowDeps } from '../teardown/flow'
import { sharedTeardownSpec, SHARED_TEARDOWN_WORDS, SHARED_KEY_MISSING_MESSAGE } from '../teardown/targets/shared'
import { PUBLISH_TARGET_CONSOLE } from '../publishStatus'
import type { TeardownView } from '../../shared/teardownResult'
import TeardownResultView from './teardown/TeardownResultView'
import { CONTROL_PANEL_URL } from './ServicePrincipalSection'

/** 結果欄の部品に、共用型の言葉と管理画面の行き先を渡す。その場の結果と、記録から読んだ結果で同じ。 */
export function SharedTeardownResultView({ view }: { view: TeardownView }) {
  return (
    <TeardownResultView
      view={view} notes={[]} words={SHARED_TEARDOWN_WORDS}
      retryHint="「🗑 破棄する（削除）」"
      serviceConsoleUrl={PUBLISH_TARGET_CONSOLE['sakura-apprun']} storageConsoleUrl={CONTROL_PANEL_URL}
      onAskAi={text => window.dispatchEvent(new CustomEvent('sakura:ask-ai', { detail: { text } }))}
    />
  )
}

/** 画面（AppRunPanel）が、破棄の流れに渡す2つの口。 */
export type SharedTeardownPanel = {
  /**
   * 確認に「破棄する」と答えたあと、実行が始まる直前。画面を「破棄中」にして、前の結果を片づけ、**始まった時刻**を返す
   * （終わったあと、この時刻以降の自分の記録を「出した」と控えるのに使う）。やめたときは呼ばれない。
   */
  onStart: () => number
  /**
   * 終わった（成功も失敗も、断られた回も）。`began` は、実行が始まっていれば（確認のあと）その時刻、始まる前に終わった回（記録を読めない・
   * 消すものが記録に無い）は null。`nothingToDo` は、消すものが記録に無かった回（失敗ではない。中立の知らせで出す）。
   * `stale` は、待っている間にプロジェクトが切り替わった回。**前のプロジェクトの結果を、いまの画面へ入れない**（実行中の印だけ下ろす）。
   */
  onDone: (view: TeardownView, began: { since: number } | null, nothingToDo: boolean, stale: boolean) => Promise<void>
}

/**
 * 【公開】(AppRunPanel) の 🗑（S1・S2）が使う、共用型の破棄の流れ。`start` を押せる場所（ボタン）から呼ぶ。
 * `confirmElement` は画面の本体の描画に置く（確認ダイアログ。選択つき）。
 */
export function useSharedTeardown(projectDir: string, panel: SharedTeardownPanel): { start: () => Promise<void>; confirmElement: ReactElement } {
  const { confirm, confirmWithChoices, element: confirmElement } = useConfirmChoices()
  /** 押してから終わるまでの二重押しを止める（確認を待つ間も。state の更新を待たずに効く）。 */
  const startedRef = useRef(false)
  const dirRef = useRef(projectDir)
  dirRef.current = projectDir
  // 画面の口は最新のものを使う（押してから終わるまでに、画面は何度も描き直される）。
  const panelRef = useRef(panel)
  panelRef.current = panel

  const start = async () => {
    if (startedRef.current) return
    startedRef.current = true
    // 呼んだときのプロジェクト。切り替わったあとの結果は、いまの画面（別のプロジェクト）へ入れない。
    const stale = () => dirRef.current !== projectDir
    let began: { since: number } | null = null
    try {
      let view: TeardownView | null = null
      let nothingToDo = false
      try {
        const outcome = await runTeardownFlow(projectDir, sharedTeardownSpec, electronFlowDeps(projectDir, sharedTeardownSpec, {
          confirm,
          confirmWithChoices,
          keyMissingMessage: SHARED_KEY_MISSING_MESSAGE,
          onStart: () => { began = { since: panelRef.current.onStart() } },
        }))
        if (!outcome.cancelled) {
          view = sharedTeardownSpec.toView(outcome.result)
          nothingToDo = outcome.nothingToDo === true
        }
      } catch (e: any) {
        view = sharedTeardownSpec.toView(sharedTeardownSpec.failure(`破棄処理でエラーが発生しました: ${e?.message ?? String(e)}`))
      }
      // やめた回は何も起きない（画面は動いていない）。
      if (view) await panelRef.current.onDone(view, began, nothingToDo, stale())
    } finally {
      startedRef.current = false
    }
  }

  return { start, confirmElement }
}
