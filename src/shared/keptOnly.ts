// keptOnly.ts — 破棄の1回で「何も消さなかった」かを決める純関数。**定義はこの1か所**（掟10）。
//
// 保存場所だけが残る回（アプリ・コンテナレジストリは消さず、保存場所もデータごと残した回）は、結果の見出しを「破棄しました」と言うと事実と合わない。
// 共用型・専有型の破棄（main）と、確認を出さずに結果を組む画面は、どれもこの1つで判断する（別々に書くと、片方だけ直る日が来る）。
// 判断は安全側（「何も消さなかった」と言い切る側に倒さない）: 条件がひとつでも欠ける・読めない値が混じる回は偽。
//
// electron にも React にも依存しない（main からも renderer からも読まれる shared）。

/** 判断の材料。 */
export type KeptOnlyFacts = {
  /** 破棄が成功したか（失敗の回は、何が消えたか分からないので「何も消さなかった」と言わない）。 */
  ok: boolean
  /** アプリ・計算資源を消した回か（消す記録があった回を含む）。消していないと確かめられたときだけ false。 */
  removedApp: boolean
  /** コンテナレジストリを実際に消したか。消していないと確かめられたときだけ false（削除の要求を出したのに結果が分からない回は true で渡す）。 */
  removedRegistry: boolean
  /** 片づけた保存場所ごとの結果。`keptData` が真のものは、データにもバケットにも手を付けなかった（複製がいる・複製か確かめられなかった）。 */
  storage: ReadonlyArray<{ keptData?: unknown }>
}

/**
 * その破棄で、何も消さなかったか。真になるのは、`ok`・アプリを消していない・レジストリを消していない・保存場所が1件以上あり、全部が `keptData`（理由は問わない）のとき。
 * 保存場所が0件の回・1件でも消した回・1件でも `keptData` が真でない回は偽。
 */
export function keptOnlyOf(f: KeptOnlyFacts): boolean {
  return f.ok === true
    && f.removedApp === false
    && f.removedRegistry === false
    && f.storage.length > 0
    && f.storage.every(b => b.keptData === true)
}

/** 返り値へ足す項目。真のときだけキーごと付け、偽のときは何も付けない（`keptOnly: false` を書かない）。 */
export function keptOnlyField(f: KeptOnlyFacts): { keptOnly?: true } {
  return keptOnlyOf(f) ? { keptOnly: true as const } : {}
}

/**
 * 返り値（記録なら extra）の `keptOnly` を読む。真偽値の `true` だけを真と読む（文字列 `'true'`・数 `1`・その他は読まない）。
 * 成否や公開先で読むかどうかを決めるのは呼び手（`shared/teardownResult.ts`）。
 */
export function readKeptOnly(fields: unknown): boolean {
  return !!fields && typeof fields === 'object' && (fields as { keptOnly?: unknown }).keptOnly === true
}

/**
 * 返り値（記録なら extra）が、残した保存場所の名前（`keptBucketNames`。旧い形は `keptBucketName`）を1件以上持つか。専有型の見出しが「すべて削除しました」と言わないために読む。
 * 理由（ほかが使う・利用者のファイルがある・複製）は問わない。文字列でない名前・空の名前は数えない。
 */
export function readKeptStorage(fields: unknown): boolean {
  if (!fields || typeof fields !== 'object') return false
  const f = fields as { keptBucketName?: unknown; keptBucketNames?: unknown }
  const named = (x: unknown): boolean => typeof x === 'string' && x !== ''
  return named(f.keptBucketName) || (Array.isArray(f.keptBucketNames) && f.keptBucketNames.some(named))
}
