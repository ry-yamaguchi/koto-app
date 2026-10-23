// storageChoice — 【公開】の「💾 データの保存」で、保存場所の一覧の読み直しと、どれを選んでおくかを決める（掟10）。
//
// ── なぜ React の外の1つの部品にしたか（2026-10-20 実機・0.6.22-rc.3）─────────────
// 【公開】は保存場所の一覧を、開いたときに1回だけ読んでいた。【公開】を開いたまま設定の
// 「データの保存」で保存場所を作ると、画面の一覧は空のまま（古い写し）で、確認に
// 「どこに保存しますか」が出ず、既定が「新しく作る」に倒れた。そのまま「用意する（費用に同意）」を
// 押すと、すでに作った保存場所があるのに、もう1つ月額の保存場所を作りに行く
// （実機では 409 で止まったが、10月以外なら作れてしまう）。
//
// 最初の直し（711f363）は、読み直しの状態と規則（通し番号・読み直し中・既定の選び直し）を
// React の部品の中にばらばらに書いた。そのため、次の欠陥が残り、テストでも見つからなかった。
//   1. 読み直しに失敗すると、古い写し（既定は「新しく作る」）のまま「用意する」を押せた
//   2. 読み直しのたびに、利用者がいま選んでいる保存場所を既定で上書きした
//   3. 用意に成功したあと一覧を読み直さず、新しく作った保存場所が「見つかりません」と出た
//   4. 破棄で保存場所が消えても、【公開】は読み直さなかった
//   5. 順序の守りや alive を壊しても、文字列一致のテストは緑のままだった
//
// その検分で、さらに次の欠陥が見つかった（根は 1 つ: 「まだ一度も読めていない」状態を、押せる側に置いていた）。
//   6. 公開先のタブを切り替えると、一覧が空（既定は「新しく作る」）に戻り、読み直しが始まるまで「用意する」を押せた
//   7. 一覧を読めなかった理由（キー未登録など）を捨てていた
//   8. 追い越された読み直しが、最新の結果が当たる前に解決していた
// → まだ一度も読めていない間は押せない（`loaded`）・理由を持つ（`listError`）・追い越されたら最新を待つ。
//
// そこで、読み直しの状態と規則を **ここ1つ**にまとめ、偽の status で振る舞いを固定する。
// 画面（StorageNotice.tsx）は、この controller を通してだけ一覧を読み、選び、押せるかを決める。

/** 「新しく作る」を表す選択肢。既存の名前と区別する。 */
export const NEW_BUCKET = '\u0000new'

/**
 * 一覧から、既定で選んでおく保存場所を決める（純関数）。
 *
 * すでにある保存場所を選べば費用は増えないので、**「新しく作る」は一覧が空のときだけ**。
 * 記録にある保存場所が一覧にあればそれ、無ければ一覧の先頭。
 */
export function defaultBucketChoice(names: readonly string[], current: string): string {
  return names.includes(current) ? current : (names[0] ?? NEW_BUCKET)
}

export type BucketListState = {
  /** いまある保存場所の名前（最後に読めた一覧）。 */
  buckets: string[]
  /** 選んでいるもの。`NEW_BUCKET` か、保存場所の名前。 */
  chosen: string
  /** 確認を開いてから、利用者がラジオで選んだか。選んでいたら、読み直しで選びを動かさない。 */
  userPicked: boolean
  /** 読み直しの途中。 */
  loading: boolean
  /** この controller で、一度でも一覧を読めたか。**読めていない間は、一覧が空でも「空だと確かめた」ではない。** */
  loaded: boolean
  /**
   * 最後に読めた応答で、サイトの利用が始まっていると確かめられたか（`storage:status` の `siteReady === true`）。
   * **`false` の0件は「保存場所が無い」とは限らない**（利用開始前、または利用開始かどうかの問い合わせの失敗。`placementMissing`）。
   * 一覧が読めていない間（`loaded=false`）は `false`。
   */
  siteReady: boolean
  /** いちばん新しい読み直しが失敗した（例外・ok でない・形が違う）。 */
  listFailed: boolean
  /** いちばん新しい失敗の理由（画面に出す）。失敗していなければ空文字。 */
  listError: string
}

/** 何も読んでいない最初の状態。画面の最初の描画と、controller の初期値が同じものを使う。 */
export function emptyBucketList(): BucketListState {
  return { buckets: [], chosen: NEW_BUCKET, userPicked: false, loading: false, loaded: false, siteReady: false, listFailed: false, listError: '' }
}

/**
 * 読み直したあとに選んでおくものを決める（純関数）。
 *
 * - 利用者が選んでいて、その選びがまだ有効（「新しく作る」か、一覧にある）→ そのまま（利用者の選びを守る）
 * - それ以外 → 既定（`defaultBucketChoice`: 記録が一覧にあればそれ・無ければ先頭・空なら「新しく作る」）
 */
export function nextChoice(o: {
  names: readonly string[]
  recorded: string
  previous: string
  userPicked: boolean
}): string {
  if (o.userPicked && (o.previous === NEW_BUCKET || o.names.includes(o.previous))) return o.previous
  return defaultBucketChoice(o.names, o.recorded)
}

/**
 * 「用意する（費用に同意）」を押せるか（純関数）。**押せるかの判定はここ1つ。**
 *
 * まだ一度も一覧を読めていない間・読み直している間・いちばん新しい読み直しが失敗したままのときは押せない。
 * どれも画面の一覧が古い（または空の初期値）かもしれず、そのまま押すと、すでにある保存場所を
 * 見落として月額の保存場所を新しく作りに行く。
 * **`siteReady` は見ない**（新しい利用者は本当に利用開始前で、「用意する（利用開始の同意）」を押せる必要がある）。
 */
export function canPrepare(s: BucketListState, busy: boolean): boolean {
  return !busy && s.loaded && !s.loading && !s.listFailed
}

/**
 * このプロジェクトの記録にある保存場所が、**一覧に無いと確かめられているか**（純関数）。**判定はここ1つ**（掟10）。
 *
 * 見るのは `loaded`（一度でも読めたか）であって、`buckets.length > 0` ではない。
 * 一覧が読めて0件だったなら、「保存場所が1つも無い」と確かめられている（破棄でバケットごと消えた直後は、まさにこの形。
 * 2026-10-22 rc.4 の実機で、0件のとき黄色い注意が出ず、消えた保存場所が「用意済み」と出続けた）。
 * 逆に、まだ読めていない間は一覧が空でも「無い」と確かめていないので言わない（`loaded`）。
 * 読み直しが失敗したままのときも、古い一覧で「見つかりません」と言わない（`listFailed`）。
 * 記録が無ければ、見つからないものも無い。
 *
 * **`siteReady` が true のときだけ言う**（2026-10-22 rc.5 の検分）。`storage:status`（src/main/ipc/cloud.ts）は、
 * サイトの利用開始を確かめる問い合わせ（`isSiteReady`）が false なら、一覧を引かずに `{ ok: true, siteReady: false, buckets: [] }` を返す。
 * その false は「利用開始前」だけでなく、403・429・5xx などの問い合わせの失敗でも返る（応答が ok でないだけで false）。
 * つまり、この0件は「読めて0件」と同じ形に見えても、「無いと確かめた」ではない。
 * 保存場所の記録があるのに利用開始前、ということは普通ない（記録は、利用開始と保存場所の作成を済ませたあとにできる）
 * ＝一時的な失敗の可能性が高いので、「無い」と言わない（言うと、あるものを「選び直してください」と誤って促す）。
 * なお **`canPrepare` は `siteReady` を見ない**（新しい利用者は本当に利用開始前で、「用意する（利用開始の同意）」を押せる必要がある）。
 */
export function placementMissing(placementBucket: string | null | undefined, s: BucketListState): boolean {
  return !!placementBucket && s.loaded && !s.listFailed && s.siteReady === true && !s.buckets.includes(placementBucket)
}

/** 理由が取れなかったときの文。 */
const LIST_UNREADABLE = '保存場所の一覧を読めませんでした。'
/** 応答の形が違うときの文。 */
const LIST_SHAPE_WRONG = '保存場所の一覧の形が想定と違います。'

/** 失敗の理由（`message`）を取り出す。無い・空なら、決まった文。 */
function reasonFrom(message: unknown): string {
  return typeof message === 'string' && message.trim().length > 0 ? message : LIST_UNREADABLE
}

type BucketReading = { names: string[]; siteReady: boolean } | { error: string }

/**
 * `window.electronAPI.storage.status()` の戻りから、保存場所の名前の一覧を取り出す。
 * **形が違えば失敗（推測しない）**。`{ ok: true, buckets: [{ name }] }` だけを読めたことにする。
 * `siteReady` は `=== true` のときだけ true（無い・形が違う・false は、利用開始を確かめられていない＝false。`placementMissing`）。
 * 失敗には理由を付ける（`{ ok: false, message }` なら message。形が違えば決まった文）。
 */
function readBucketList(reply: unknown): BucketReading {
  if (!reply || typeof reply !== 'object') return { error: LIST_SHAPE_WRONG }
  const r = reply as { ok?: unknown; message?: unknown; buckets?: unknown; siteReady?: unknown }
  if (r.ok === false) return { error: reasonFrom(r.message) }
  if (r.ok !== true || !Array.isArray(r.buckets)) return { error: LIST_SHAPE_WRONG }
  const names: string[] = []
  for (const b of r.buckets) {
    const name = b && typeof b === 'object' ? (b as { name?: unknown }).name : undefined
    if (typeof name !== 'string' || name.length === 0) return { error: LIST_SHAPE_WRONG }
    names.push(name)
  }
  return { names, siteReady: r.siteReady === true }
}

export type BucketListController = {
  get(): BucketListState
  /**
   * 一覧を読み直す。いちばん新しい読み直しの結果だけを当てる。失敗なら `listFailed` と `listError`（一覧と選びは変えない）。
   * **解決するのは、いちばん新しい読み直しの結果が当たったあと**（追い越された読み直しは、最新の完了を待つ）。
   */
  reload(): Promise<void>
  /** 確認を開く。利用者の選びを手放し（`userPicked=false`）、読み直して既定から選び直す。 */
  openConfirm(): Promise<void>
  /** 利用者がラジオで選んだ。 */
  pick(name: string): void
  /** これ以後に返った読み直しは何も当てない（プロジェクトの切り替え・アンマウント）。 */
  dispose(): void
}

export function createBucketListController(o: {
  /** `window.electronAPI.storage.status` */
  status: () => Promise<unknown>
  /** いまの記録の保存場所（無ければ空文字）。**読み直しの結果を当てる時点で読む**（開いている間に変わるため）。 */
  recorded: () => string
  onChange: (s: BucketListState) => void
  initial?: Partial<BucketListState>
}): BucketListController {
  let state: BucketListState = { ...emptyBucketList(), ...o.initial }
  /** 読み直しの通し番号。もっと新しい読み直しが始まったら、古い結果は捨てる。 */
  let seq = 0
  let disposed = false

  const emit = (patch: Partial<BucketListState>) => {
    state = { ...state, ...patch }
    o.onChange(state)
  }

  /** いちばん新しく始めた読み直し。追い越された読み直しが、これの完了を待つ。 */
  let latest: Promise<void> = Promise.resolve()

  function reload(): Promise<void> {
    if (disposed) return Promise.resolve()
    const mine = ++seq
    emit({ loading: true })
    const run = (async (): Promise<void> => {
      let reading: BucketReading
      try {
        reading = readBucketList(await o.status())
      } catch (e) {
        reading = { error: reasonFrom((e as { message?: unknown } | null | undefined)?.message) }
      }
      if (disposed) return
      if (mine !== seq) {
        // 後から始まった読み直しがある: 自分の結果は当てない（loading にも触らない）。
        // ただし、解決するのは最新の結果が当たったあと（呼んだ側は、そのあとに一覧を読む）
        await latest
        return
      }
      if ('error' in reading) {
        // **失敗を黙って「新しく作る」に倒さない。** 一覧と選びは前のまま、押せなくする
        emit({ listFailed: true, listError: reading.error, loading: false })
        return
      }
      const names = reading.names
      const chosen = nextChoice({
        names, recorded: o.recorded(), previous: state.chosen, userPicked: state.userPicked,
      })
      emit({
        buckets: names,
        siteReady: reading.siteReady,
        chosen,
        // 利用者の選びが一覧から消えて既定へ戻ったら、利用者の選びではなくなる
        // （残すと、次の読み直しで「新しく作る」に居座り、あとから増えた保存場所を選ばない）
        userPicked: state.userPicked && chosen === state.chosen,
        loaded: true,
        listFailed: false,
        listError: '',
        loading: false,
      })
    })()
    latest = run
    return run
  }

  return {
    get: () => state,
    reload,
    async openConfirm() {
      if (disposed) return
      state = { ...state, userPicked: false }
      await reload()
    },
    pick(name) {
      if (disposed) return
      emit({ chosen: name, userPicked: true })
    },
    dispose() { disposed = true },
  }
}
