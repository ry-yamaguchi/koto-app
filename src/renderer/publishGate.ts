// publishGate.ts — 「🚀 公開する」を押したときに、公開前チェック（preflight）の結果で
// 公開を始めるかどうかを判断する（純関数・IO無し・掟10）。
//
// ── なぜ要るか（判断5・利用者目線レビュー・2026-09-11）────────────────────────
// これまで③「公開できるか確かめる」は独立したボタンで、押さない限り ng（確実に失敗する）が
// 分からないまま「🚀 公開する」が実行できた。startApply は plan だけを取り直しており、
// preflight（src/shared/preflight.ts）を一度も呼んでいなかった。
//
// **止めるのは「確実に失敗する」（ng）ときだけ。** これは preflight 自身の方針
// （`summarizePreflight` の「迷ったら通す側に倒す」）をそのまま踏襲する——ここで新しい
// 判断基準を作らない。`canPublish` が既にその判断を持っているので、ここでの仕事は
// 「押す前に呼ぶかどうか」と「呼んだ結果をどう使うか」だけに絞る。
//
// preflight 自体が失敗した（`ok: false`。IPCやネットワークの例外）ときは、**止めない**。
// 確かめられなかっただけで公開できないのは、利用者にとって「壊れている」のと同じである
// （src/shared/preflight.ts と同じ理由）。ただし黙って進めるのではなく、理由を残す。

/** window.electronAPI.cloud.preflight(...) の戻り値のうち、判断に使う分だけ。 */
export type PublishGatePreflight = {
  /** 確認そのものが成功したか（false は IPC/ネットワーク等の例外）。 */
  ok: boolean
  /** `ng` が1つも無いか（`summarizePreflight` が決める）。 */
  canPublish: boolean
  /** 見出しに出る一言（`ng` があれば「このままでは公開できません（…）」等）。 */
  summary: string
  message?: string
}

export function shouldBlockPublish(preflight: PublishGatePreflight): { block: boolean; reason?: string } {
  // 確認そのものが失敗した（IPC例外・ネットワーク等）。**通す**が、黙って進めない。
  if (preflight.ok === false) {
    return {
      block: false,
      reason: preflight.message || preflight.summary || '公開前の確認ができませんでした。確認できないまま公開を進めます。',
    }
  }
  // ng が1つでもあれば（canPublish===false）止める。理由は summary をそのまま使う
  // （「このままでは公開できません（…）」——preflight.ts が既に利用者向けの文にしてある）。
  if (preflight.canPublish === false) {
    return { block: true, reason: preflight.summary }
  }
  // warn だけ・checks が空、はどちらも canPublish===true。止めない（掟：迷ったら通す側）。
  return { block: false }
}
