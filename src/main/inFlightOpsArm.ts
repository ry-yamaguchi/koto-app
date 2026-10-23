// inFlightOpsArm.ts — 起動したときの読み戻し。前の Koto が途中で止まった回を引き継ぎ、書く口をつなぐ。設計書 10.13.5。
//
// main.ts の `app.whenReady()` の中、窓を作る前に**1か所だけ**、`isPrimaryInstance`（鍵を取れて、動いている別の Koto も無い）のときだけ呼ぶ。
// `registerAllHandlers` の中には置かない: あとから起動して自分で終了する側の Koto でも走り、動いているほうの記録を「止まった」に書き換えてしまう。
//
// ── 何があっても投げない ────────────────────────────────────────────────────
// 全体を try で包む。失敗したら**口をつながずに**終わる（この起動では時間の持ち越しが効かないだけ。窓は出る）。読むファイルは
// 1MB を超えていれば読まない（inFlightOpsStore.ts）。`exists`・`hasWork` が投げたら、その項目は残す側に倒して続ける（`adoptAtStartup`）。
// 順番: (1) 読む (2) 整える (3) 書き戻す (4) projectOps へ止まった回を渡す (5) will-quit を登録する (6) 口をつなぐ（つなぐのは最後。ここまでで投げたら書かない）。
// 窓が無いうちは画面から操作が始まらないので、(1)〜(6) の途中で操作が走ることは無い。
import { adoptAtStartup, type InFlightTarget } from '../shared/inFlightOps'
import { dedicatedTeardownHasWork } from '../shared/teardownSupport'
import { loadInFlightOps, writeInFlightOps } from './inFlightOpsStore'
import { adoptStoppedOps, flushInFlightOps, setInFlightSink } from './projectOps'
import { hasPublishRecordFs, readApprunDedicatedFs } from './publishMetaFs'

export type ArmInFlightDeps = {
  /** Koto の版（走り始めた回の記録に写す）。 */
  version: string
  /** プロジェクトのフォルダがあるか（本物は `fs.existsSync`）。 */
  exists: (key: string) => boolean
  /** その公開先に、続けるもの（消すもの）が記録にあるか。本物は `inFlightHasWork`。 */
  hasWork: (key: string, target: InFlightTarget) => boolean
  /** 終了の直前（`app.on('will-quit')`）に呼ばれる関数を登録する。electron の `app` は main.ts が持つので、ここへは渡される。 */
  onWillQuit: (fn: () => void) => void
  /** テスト用: 起動時の時刻。 */
  now?: () => number
}

/**
 * 続けるものが記録にあるか（本物）。専有型は手順6のボタンの出し分けと同じ答え（`dedicatedTeardownHasWork`）、
 * ほかは公開の記録（📡 の行）があるか。読めない `.sakuraide.json` は false（読めない記録からは何も続けられない）。
 * これで、同じパスに作り直したフォルダの古い記録と、すでに消し終わっていた回の知らせが出なくなる。
 */
export function inFlightHasWork(projectDir: string, target: InFlightTarget): boolean {
  if (target === 'unknown') return false
  return target === 'sakura-apprun-dedicated' ? dedicatedTeardownHasWork(readApprunDedicatedFs(projectDir)) : hasPublishRecordFs(projectDir, target)
}

/** 読み戻して口をつなぐ。つないだら true。**投げない**（失敗したら口をつながずに false）。 */
export function armInFlightOps(deps: ArmInFlightDeps): boolean {
  try {
    const now = (deps.now ?? Date.now)()
    const adopted = adoptAtStartup(loadInFlightOps(), now, { exists: deps.exists, hasWork: deps.hasWork })
    writeInFlightOps(adopted) // 書けなくても続ける（running が残っても、次の起動で同じ startedAt の回は1つに畳まれる）
    adoptStoppedOps(adopted.stopped, now)
    // will-quit の登録を口をつなぐ前に置く: 登録が投げても、口は半端につながらない（書き切りは、口がつながっていなければ何もしない）。
    deps.onWillQuit(() => {
      try { flushInFlightOps(Date.now()) } catch { /* 終了を止めない */ }
    })
    setInFlightSink(writeInFlightOps, { version: deps.version })
    return true
  } catch {
    return false
  }
}
