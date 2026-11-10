// 全テストの前に1回: HANAMII の削除を待つ側（main/hanamii/deletionWait.ts）の既定の sleep を、「呼ばれたら投げる」ものに替える。
// 偽の時計（tests/hanamiiTeardownFixtures.ts の fastHanamiiDeletionWait）を入れ忘れたテストが、本物の5秒・20秒の待ちで
// 黙って緑になる（testTimeout は30秒）のを防ぐ。偽の時計は sleep を差し替えるので、入れたテストには影響しない。
import { hanamiiDeletionWaitTuning } from '../../src/main/hanamii/deletionWait'

hanamiiDeletionWaitTuning.sleep = async (ms: number): Promise<void> => {
  throw new Error(`本物の sleep(${ms}ms) が呼ばれました。HANAMII の削除の待ちを通るテストは fastHanamiiDeletionWait() を入れてください。`)
}
