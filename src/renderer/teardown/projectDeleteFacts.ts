// teardown/projectDeleteFacts.ts — プロジェクトの削除の材料を、ダイアログを開いたときに1回読む。
//
// 段階3A（3A-4b）。設計書: docs/teardown-unify-plan.md の 10.9.4 の(2)。判断（止めるか・先に何を破棄するか）は projectDeletePlan.ts の純関数。
// ここは読むだけ（外へ要求を出さない・何も書かない）。**投げない**: 読めなかった材料は、安全な空の値に倒す（公開の記録が読めなかったことは unreadable で返す）。
//
//   targets / unreadable … 公開先（旧い記録だけの公開先も数える。読めなかった回は、読めた分）。publishRecord.ts の読み口
//   dedicated            … 専有型の記録（apprunDedicated.state。読めなければ null）
//   placements           … 保存場所の全件（読めなければ []）
//   running              … いま main が走らせている操作（readRunningOp。聞けなければ null）。**公開の記録より先に聞く**（下の注）
//   sharedLeftover       … 共用型の行が無いのに、共用型の記録に消すものがある（10.9.18 の E）。レジストリの名前・由来・借り手と保存場所（月額を言ってよいかは由来と借り手で決まる）。
//                           読めなかったら null にして unreadable を立てる
//   sharedRegistry       … 共用型の行があるときの、共用型の記録のコンテナレジストリ（名前・由来〔owned・adopted・unknown〕・使っているほかのプロジェクト）。
//                           「公開も一緒に破棄する」を外したときに、月額が続くと言ってよいかの材料（判断は projectDeletePlan.ts の ownRegistryBillingNote）。
//                           記録にレジストリが無い・読めなかったら null（言わない）。行は読めているので、読めなかったことで unreadable は立てない
// 共用型の記録は、行の有無に関わらず 1 回だけ読む（readSharedTeardownRecord。新しい IPC は作らない）。
// コンテナレジストリの名前（cloud.registryName）は読まない（選ぶのは続く確認。10.9.18 の D）。
// 専有型のパネルの部品（apprunDedicatedActions.ts・AppRunDedicatedPanel.tsx ほか）は import しない（10.3.1）。

import { readPublishTargetsWithLegacyChecked } from '../publishRecord'
import { readRunningOp } from '../projectMeta'
import { readSharedTeardownRecord, sharedTeardownHasWork } from './targets/shared'
import type { DedicatedResourceIds, ProjectDeleteFacts, SharedLeftover, SharedRegistry } from './projectDeletePlan'

export async function readProjectDeleteFacts(dir: string): Promise<ProjectDeleteFacts> {
  // **走っているかを先に聞き、公開の記録は後で読む。この順序が要る**（projectMeta.ts の loadPublishSnapshot と同じ。2026-09-29）。
  // 記録を先に読むと、その直後に初回の公開が終わったとき、読んだ写しには公開先の行が無いのに、走っているかの答えは「走っていない」になり、
  // 「公開なし・走っていない」と読んでフォルダを移せてしまう（移す直前の確認は runningOp しか聞かない）。先に聞けば、終わったあとに読んだ記録には行がある。
  const running = await readRunningOp(dir)

  const read = await readPublishTargetsWithLegacyChecked(dir)
  const targets = read.targets
  let unreadable = read.unreadable

  let dedicated: DedicatedResourceIds = null
  try { dedicated = (await window.electronAPI.apprunDedicated.state(dir)) ?? null } catch { /* 読めなくても削除はできる（targets 側の判断は残る） */ }

  let placements: ProjectDeleteFacts['placements'] = []
  try {
    const r = await window.electronAPI.storage.placement(dir)
    if (r.ok) {
      const all = r.placements ?? (r.placement ? [r.placement] : [])
      placements = all.map(p => ({ bucket: p.bucket, prefix: p.prefix, shared: p.shared }))
    }
  } catch { /* 読めなくても削除はできる（消えるものが増えるわけではない） */ }

  let sharedLeftover: SharedLeftover | null = null
  let sharedRegistry: SharedRegistry | null = null
  const hasSharedRow = targets.includes('sakura-apprun')
  try {
    const rec = await readSharedTeardownRecord(dir)
    if (hasSharedRow) {
      if (rec.registryName) sharedRegistry = { registryName: rec.registryName, origin: rec.registryOrigin, users: rec.registryUsers }
    } else if (sharedTeardownHasWork(rec)) {
      sharedLeftover = { registryName: rec.registryName, registryOrigin: rec.registryOrigin, registryUsers: rec.registryUsers, placements: rec.placements }
    }
  } catch {
    // 行が無い回: 共用型の記録が読めなかった。消すものがあるか分からないので、公開の記録が読めないときの注意を出す。
    // 行がある回: 行は読めているので注意は出さない。レジストリのことは分からないまま（sharedRegistry は null）で、月額は言わない。
    if (!hasSharedRow) unreadable = true
  }

  return { targets, unreadable, dedicated, placements, running, sharedLeftover, sharedRegistry }
}
