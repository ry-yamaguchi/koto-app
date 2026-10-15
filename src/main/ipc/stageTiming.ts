// 段ごとの所要時間（どこにどれくらい時間がかかったか）の IPC（stageTiming:*）と、保存の配線。
//
// 持ち主は src/main/projectOps.ts（記録・メモリ）と src/main/stageTimingStore.ts（保存・この Mac の Koto の保存領域）。
// ここは薄い配線だけ（掟6: main／preload.ts／renderer/global.d.ts の3点セットを同時に更新する）:
//   ・うまくいった操作が終わったとき、projectOps の口（setStageTimingSink）から段の所要時間を受けて保存する
//   ・画面が段ごとの目安を読む口（stageTiming:estimates）を1本だけ持つ
//
// 目安の決め方は shared/stageEstimate.ts（この Mac で測れたら最近5回の中央値・それまでは開発時の実測・無ければ無し）。
import { app, ipcMain } from 'electron'
import { setStageTimingSink } from '../projectOps'
import { loadStageTimings, recordStageTimings } from '../stageTimingStore'
import { estimatesFor } from '../../shared/stageEstimate'

export function registerStageTimingHandlers(): void {
  // 保存するのは、うまくいった操作の、終わった段の所要時間だけ（projectOps が ok:true のときだけ呼ぶ）。
  // 日付・Koto の版・ゾーンを添える。プロジェクトの場所や名前は渡さない（渡す口が無い）。
  setStageTimingSink(entry => {
    let version = ''
    try { version = app.getVersion() } catch { /* 版が分からなくても記録は残す */ }
    recordStageTimings({
      at: new Date(entry.finishedAt).toISOString(),
      version,
      zone: entry.zone,
      stages: entry.stages,
    })
  })

  // 段ごとの目安（目安のある段だけ）。引数は取らない（画面から段の名前などを受け取らない）。
  ipcMain.handle('stageTiming:estimates', () => estimatesFor(loadStageTimings()))
}
