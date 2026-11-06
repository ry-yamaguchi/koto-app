// editorSync.ts — エディタのタブと、ディスクのファイルの食い違いを判断する純関数（electron・DOM 非依存。Vitest 対象）。
//
// 外（端末・Finder・ほかのエディタ・git）で書き換わったファイルを、タブが知らずに古い中身で上書きしない。
// 判断をここ1か所に集め、書く口（main の `fs:writeFileIfUnchanged`）も画面もこの表を通る（掟10）。
//
// 言葉:
//   baseline … 最後に読んだ・書いた中身（タブが「ディスクはこうだったはず」と覚えているもの）
//   content  … いまエディタにある中身
//   disk     … いまディスクにある中身。ファイルが無いときは null

/** タブとディスクの関係。 */
export type TabSyncVerdict =
  | 'missing'   // ディスクにファイルが無い（外で消えた・移された）
  | 'unchanged' // ディスクは覚えていたとおり（外の変更なし）
  | 'adopt'     // ディスクがすでにエディタの中身と同じ（外で同じ中身になった）。基準だけ進めればよい
  | 'reload'    // 外で変わっていて、エディタに未保存の編集が無い。外の中身へ読み直してよい
  | 'conflict'  // 外で変わっていて、未保存の編集もある。利用者が選ぶまで書かない

export interface TabSyncInput {
  baseline: string
  content: string
  isDirty: boolean
  disk: string | null
}

/**
 * 判断は次の順（上から最初に当たったもの）。順を入れ替えると答えが変わる。
 *   1. disk が null          → missing
 *   2. disk が baseline と同じ → unchanged
 *   3. disk が content と同じ  → adopt
 *   4. 未保存の編集が無い      → reload
 *   5. それ以外               → conflict
 */
export function decideTabSync({ baseline, content, isDirty, disk }: TabSyncInput): TabSyncVerdict {
  if (disk === null) return 'missing'
  if (disk === baseline) return 'unchanged'
  if (disk === content) return 'adopt'
  if (!isDirty) return 'reload'
  return 'conflict'
}

/** 書く前の判断。 */
export type WriteVerdict =
  | 'write'    // 書いてよい
  | 'skip'     // 書かなくてよい（ディスクがすでに書きたい中身と同じ）
  | 'conflict' // 書かない（外で変わった・消えた。利用者が選ぶまで書かない）

/**
 * 保存の直前に、いまのディスク `disk` へ `content` を書いてよいかを答える。上の `decideTabSync` と同じ表から導く
 * （保存するのは未保存の編集があるときなので `isDirty: true` で引く）。
 *
 * `baseline` が null は「無いときだけ作る」形（外で消えたタブを自分の内容で作り直す）。ファイルが無いときだけ書き、
 * あれば（その間に外で作られた）書かない。
 */
export function mayWriteTab({ baseline, content, disk }: { baseline: string | null; content: string; disk: string | null }): WriteVerdict {
  if (baseline === null) return disk === null ? 'write' : 'conflict'
  const verdict = decideTabSync({ baseline, content, isDirty: true, disk })
  if (verdict === 'unchanged') return 'write'
  if (verdict === 'adopt') return 'skip'
  return 'conflict' // missing・conflict（reload は isDirty: true では出ない）
}

/**
 * `fs:writeFileIfUnchanged` の答え。
 *   ok:true                 … 書いた（ディスクがすでに同じ中身で、書く必要が無かった回も含む）
 *   reason:'changed'        … 外で変わっていたので書いていない。`disk` はいまのディスクの中身
 *   reason:'missing'        … ファイルが無い（ENOENT）ので書いていない
 *   reason:'unreadable'     … ファイルはあるが読めない（権限・フォルダなど）ので書いていない
 */
export type WriteIfUnchangedResult =
  | { ok: true }
  | { ok: false; reason: 'changed' | 'missing' | 'unreadable'; disk?: string }
