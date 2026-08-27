// chat.json を「追記式」にするための純粋ロジック（fs / electron に依存しない。Vitest対象）。
// IO（ファイル読み書き・tmp+rename・追記・cache）は ipc/chatStore.ts 側の役目で、ここには置かない。
//
// これまでは 1.5 秒ごとに会話の配列を丸ごと書き直していた（209件・5.5MB の会話でも毎回全体を書く）。
// v2 では「前回書いた内容と今の会話を比べ、変わった行だけを追記する」形にして、書き込み量を減らす。
//
// ファイル形式（<project>/.sakuraide/chat.json。ファイル名・場所は変えない）:
//   - v1（これまで）: 配列まるごとの JSON。先頭の非空白文字が '['。
//   - v2（これから）: 1行1レコードの JSONL。
//       1行目            {"v":2}                      … バージョン印。読むときは無視する
//       以降のレコード    {"i":<番号>,"m":<メッセージ>}  … 番号 i の位置をこのメッセージにする
//                        {"n":<件数>}                  … 全体を n 件に切り詰める（元に戻す・removeLast）
//     v2 は末尾が壊れていても（クラッシュで書き込み途中に落ちても）手前までを読めるよう、
//     行ごとにパースし、壊れた行・知らない行は捨てて読み進める。
//
// ⚠️ v2 と認めるのは「最初の空でない行が JSON オブジェクトで v というキーを持つとき」だけ（v の値は
// 見ない）。これが無ければ null を返す（2026-08-27 仕様修正）。理由は2つ:
//   1. 壊れたファイル（先頭が '[' でも無い何か）を空の会話 { messages: [], lines: [] } に畳んでしまうと、
//      renderer 側の resolveChatSource（chatMigration.ts）が「ファイルから読めた（＝空の会話）」と見なし、
//      旧 localStorage への退避が働かなくなる。null であれば localStorage を見に行く経路が生きる。
//   2. v の**値**を条件にすると、将来 v3 を足したときに旧い（v2の）foldChatLog が「知らない値だから」と
//      null を返し、v3 で書いたファイルを丸ごと読めなくしてしまう。知らないレコードは無視する設計と
//      同じ考え方で、v キーの存在だけを見て、値には関知しない。

/** メッセージ1件を JSON 文字列にする（JSON.stringify は文字列中の改行を \n にエスケープするため、素の改行は含まない）。 */
export function serializeMessages(messages: any[]): string[] {
  return messages.map((m) => JSON.stringify(m))
}

/**
 * 先頭の非空白文字だけで v1（配列まるごとのJSON）かどうかを判定する（v1 は必ず '[' から始まる）。
 * foldChatLog の v1/v2 判定と同じ基準を、ipc/chatStore.ts の chat:loadProject からも使う
 * （v1 のまま cache してしまうと、次の保存が「追記」経路に入り、v1 ファイルへ v2 のJSONL行を
 *   そのまま書き足してしまい、丸ごと読めなくなる。cache するのは v2 のときだけにする）。
 */
export function isV1ChatLog(text: string): boolean {
  return text.trimStart()[0] === '['
}

/** ファイルの中身を畳んで、いまの会話にする。未保存・読めない → null。 */
export function foldChatLog(text: string | null): { messages: any[]; lines: string[] } | null {
  if (text === null) return null
  if (text.trim() === '') return null // 空文字列・空白のみは「未保存」と同じ扱い

  if (isV1ChatLog(text)) {
    // v1: 配列まるごとの JSON
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return null // 壊れた JSON
    }
    if (!Array.isArray(parsed)) return null // 配列でなければ不正
    return { messages: parsed, lines: serializeMessages(parsed) }
  }

  // v2 と認めるのは「最初の空でない行が JSON オブジェクトで v というキーを持つとき」だけ。
  // それ以外（壊れたファイル・v1でもv2でもない何か）は null にする（理由は本ファイル冒頭コメント）。
  const rawLines = text.split('\n')
  let bodyStart = -1
  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx].trim()
    if (line === '') continue // 先頭の空行はヘッダ探しの対象外として飛ばす
    let header: unknown
    try {
      header = JSON.parse(line)
    } catch {
      return null // 最初の空でない行が JSON として壊れている＝v2として認めない
    }
    if (typeof header !== 'object' || header === null || Array.isArray(header)) return null // オブジェクトでない
    if (!('v' in (header as Record<string, unknown>))) return null // JSONオブジェクトだが v を持たない
    bodyStart = idx + 1
    break
  }
  if (bodyStart === -1) return null // 空でない行が1つも無い（text.trim()===''で通常ここには来ない防御）

  // ここから本文（ヘッダの次行以降）。1行ずつ畳み込み、分かる範囲だけ復元する
  const messages: any[] = []
  for (let idx = bodyStart; idx < rawLines.length; idx++) {
    const line = rawLines[idx].trim()
    if (line === '') continue // 空行は飛ばす

    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      continue // クラッシュ等で末尾の行が途中で切れた場合。捨てて続ける（ここで止めない）
    }
    if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) continue // オブジェクトでない行は捨てる

    const r = rec as Record<string, unknown>

    if ('v' in r) continue // バージョン印の行（2行目以降に紛れても）。無視する

    if ('i' in r && 'm' in r) {
      const i = r.i
      // i が現在の件数より大きい行は捨てる（穴を開けない）。i === messages.length は末尾への追加として許す
      if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i <= messages.length) {
        messages[i] = r.m // 同じ i を複数回書いた場合はあとに読んだほうで上書きされる（あとの勝ち）
      }
      continue
    }

    if ('n' in r) {
      const n = r.n
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0) {
        messages.length = Math.min(n, messages.length)
      }
      continue
    }

    // v・i+m・n のどれにも当てはまらない行は無視する（将来レコード種別を増やしても旧版が壊れないように）
  }

  // ヘッダ行だけ（本文が1件も無い）でも null にはしない。null は「ファイルが無い/読めない」の意味に予約する
  return { messages, lines: serializeMessages(messages) }
}

/** v2 のファイル全体を作る（初回書き込み・書き直し用）。lines は messages を1件ずつ JSON にしたもの。 */
export function rewriteChatLog(lines: string[]): string {
  const out: string[] = [JSON.stringify({ v: 2 })]
  lines.forEach((line, i) => {
    // line は既に JSON 文字列なのでそのまま埋め込む（JSON.stringify に通すと二重にエスケープされてしまう）
    out.push(`{"i":${i},"m":${line}}`)
  })
  return out.map((l) => l + '\n').join('')
}

/** 前回書いた内容(prevLines)といまの会話(nextLines)を比べ、追記する行だけ作る。変化が無ければ空文字列。 */
export function appendChatLog(prevLines: string[], nextLines: string[]): string {
  const records: string[] = []

  // 件数が減った（元に戻す・removeLast）ときは、差分より先に切り詰めレコードを置く。
  // 先に置かないと、あとの {"i":...} で書いた値が n による切り詰めで消されてしまう
  if (nextLines.length < prevLines.length) {
    records.push(`{"n":${nextLines.length}}`)
  }

  for (let i = 0; i < nextLines.length; i++) {
    if (prevLines[i] !== nextLines[i]) {
      // nextLines[i] は既に JSON 文字列なのでそのまま埋め込む（二重に文字列化しない）
      records.push(`{"i":${i},"m":${nextLines[i]}}`)
    }
  }

  if (records.length === 0) return '' // 変化なし＝書かない

  return records.map((r) => r + '\n').join('')
}

/** 無駄が増えすぎたら書き直す（fileBytes: 追記後のファイル総量, contentBytes: いまの会話の中身の総量）。 */
export function shouldRewrite(fileBytes: number, contentBytes: number): boolean {
  // 無駄が中身の2倍を超えたら書き直す。小さい会話で毎回書き直さないよう 64KB の下駄を履かせる
  return fileBytes > contentBytes * 2 + 65536
}

/**
 * cache（Map）へ「最近使った順」で入れる。上限を超えたら、いちばん古く使ったものを1件捨てる。
 * Map は挿入順を保つ性質を利用する: 既にある key を一度 delete してから set し直すと、
 * その key が「最近使った」ものとして末尾（＝最新）に移る。先頭（＝ Map.keys() の最初）が
 * 常に「いちばん古く使ったもの」になるので、それだけを捨てればよい。
 *
 * プロジェクトを切り替えるたびに前の会話が cache に残り続け、開いたぶんだけ main のメモリが
 * 増え続けていた（2026-08-27 指摘。実測 landingTEST 5.5MB / newproject 1.6MB）のを防ぐ。
 * 捨てられた項目は次の保存で「cache 無し→書き直し」に落ちるだけなので、動作は壊れない。
 */
export function touchCache<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) {
    const oldestKey = map.keys().next().value
    if (oldestKey === undefined) break // limit が 0 以下などで空になったら止める
    map.delete(oldestKey)
  }
}
