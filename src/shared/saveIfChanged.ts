// saveIfChanged.ts — 「値が変わっていなければ書かない。書けなかったら、書いたことにしない」の純関数
// （electron・DOM 非依存。Vitest 対象）。
//
// AppRunDedicatedPanel の手順2（サービスプリンシパルID）が使う。欄は onBlur・候補を選んだとき・手順5で作るとき、
// と複数の入口から保存するので、**判断（書く・書かない・失敗したら戻す）は1つにする**（掟10）。
//
// ── 3つの決まり ───────────────────────────────────────────────────────
// 1. 値が変わっていなければ書かない（2026-09-23 検分の指摘6）。ファイルへ書くと 'sakura-meta-changed' →
//    状態の取り直し（クラウドへの GET）が走り、手順8「公開中: …」が触っていないのに一瞬消えて出し直される。
// 2. **書けなかったら「保存済み」の印を元へ戻す**（2026-10-06 検分の指摘）。印を「書く前」に進めたまま
//    失敗すると、以後の保存が「変わっていない」として書かれず、自動で入れた ID が作成のあとも記録に残らない。
//    印を書く前に進めるのは、同じ値の保存が同時に2本走ったとき（欄を離れる＋作成の入口）に、
//    1回しか書かないため。失敗したら戻し、**次の保存で同じ値をもう一度書こうとする**。
//    ただし、失敗を待っている間に別の値へ進んでいたら（印が自分の値でなくなっていたら）、その印は触らない。
// 3. **保存を始めたプロジェクトから離れていたら、画面にも印にも触らない**（2026-10-07 検分の指摘・掟11 環境の独立）。
//    印（と画面の失敗の知らせ）は「いま開いているプロジェクト」のもの。プロジェクトを切り替える前に始めた保存が、
//    切り替えたあとで失敗したとき、前のプロジェクトの失敗を新しいプロジェクトの画面に出したり、
//    新しいプロジェクトの印を前の値へ巻き戻したりしない。`isStale`（既定は常に false）が true を返したら、そうする。

/** 最後に保存した（か、記録から読んだ）値を覚えておく入れ物（React の ref と同じ形）。 */
export interface SavedMark<T> { current: T }

/**
 * `next` が覚えている値と違うときだけ `write(next)` を呼ぶ。
 * 書けなかったときは印を元へ戻して、**同じ例外を投げ直す**（握りつぶすかどうかは呼び出し側が決める）。
 * 変わっていなければ何も呼ばない（`write` は一度も呼ばれない）。
 *
 * `isStale` が、失敗を受け止めた時点で true なら（保存を始めたプロジェクトから離れた）、印は戻さない
 * （いまの印は別のプロジェクトのもの）。例外は投げ直す。
 */
export async function saveIfChanged<T>(
  saved: SavedMark<T>,
  next: T,
  write: (v: T) => Promise<unknown>,
  isStale: () => boolean = () => false,
): Promise<void> {
  // 始める時点ですでに別のプロジェクトへ切り替わっていたら、書かない・印も変えない（2026-10-07 検分）。
  // 書くと、前のプロジェクトの ID が新しいプロジェクトの記録に入りうる（掟11）
  if (isStale()) return
  if (next === saved.current) return // 値が変わっていない＝書かない
  const previous = saved.current
  saved.current = next // 書く前に進める（同じ値の保存が同時に走っても1回だけ書く）
  try {
    await write(next)
  } catch (e) {
    // 書けなかった＝書いたことにしない。ただし別のプロジェクトへ移っていたら、その印は新しいプロジェクトのもの
    if (!isStale() && saved.current === next) saved.current = previous
    throw e
  }
}

/** `saveAndReport` の結果。画面は `stale` でなければ、`error` をそのまま知らせの状態にする。 */
export type SaveReport =
  | { stale: true }
  | { stale: false; error: string | null }

/**
 * `saveIfChanged` を呼んで、画面に出す知らせを決める（失敗しても投げない）。
 *
 * - 書けた・書かなかった（変わっていない）: `{ stale: false, error: null }`＝知らせを消す
 * - 書けなかった: `{ stale: false, error: メッセージ }`＝知らせを出す（印は元へ戻る）
 * - **保存を始めたプロジェクトから離れていた**（`isStale()` が true）: `{ stale: true }`＝**何もしない**。
 *   知らせを出しも消しもしない（いまの画面は別のプロジェクトのもの）。印も戻さない。
 *
 * 判定は成功・失敗のどちらでも、結果を受け取った時点で行う（待っている間に切り替わりうるため）。
 */
export async function saveAndReport<T>(
  saved: SavedMark<T>,
  next: T,
  write: (v: T) => Promise<unknown>,
  isStale: () => boolean,
): Promise<SaveReport> {
  try {
    await saveIfChanged(saved, next, write, isStale)
    return isStale() ? { stale: true } : { stale: false, error: null }
  } catch (e: any) {
    return isStale() ? { stale: true } : { stale: false, error: e?.message ?? String(e) }
  }
}
