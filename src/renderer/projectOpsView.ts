// projectOpsView.ts — main の「処理の記録」（src/main/projectOps.ts）を、画面が**読む・「見た」と伝える・誰の持ち場か決める**
// ための、唯一の部品（React に依存しない）。掟10: 定義は1か所。
//
// ── なぜ1か所か（2026-09-30 検分の指摘2）──────────────────────────────────────────────
// 記録を読んで「見た」と伝える処理が、5つの画面に**別々に**書かれていた:
//   PublishModal（結果を確認しました）・HANAMII／Vercel の useProjectOpsView・AppRunPanel の ackUpToFor／ackSeen・
//   専有型の watchDedicatedOps。しかも「見た」の意味も、ack の範囲の決め方も、projectDir の比べ方
//   （normDir／trimSlash／trimTrailingSlash）も、画面ごとに違った。HanamiiPanel 自身のコメントが
//   「同じ読み方を複製すると片方だけ直されて見逃す穴になる」と書いていたのに、複製されていた。
//   そして「再生されても表示だけなら無害」という前提が HANAMII の画面にだけ当てはまらず、
//   古い破棄の再生が新しい公開の記録を消した（src/main/publishMetaFs.ts の settleHanamiiTeardownFs）。
//
// ── 「見た」とは（すべての画面でこの1つの約束）──────────────────────────────────────────
//   記録の結果を、**持ち場の画面が利用者の目に出した**こと。持ち場の無い記録（別の公開先のもの・
//   開いている画面が出さないもの）は、利用者が「確認しました」を押したこと（PublishModal の上部）。
//   出したら main へ `ack(projectDir, upToStartedAt)` で伝える。ack は「その記録**まで**」をまとめて見たことにする
//   累積の印なので、**どこまで伝えてよいかは `ackUpToFor` の1か所で決める**:
//     「連続した先頭から、見せたところまで」。1つでも見せていない記録（別の公開先のもの・出している最中のもの）が
//     挟まったら、それより新しいものは、自分のものでも伝えない
//     ——伝えると、その持ち場の画面が出すはずの結果や、誰も見ていない警告（月額が続く）が黙って消える。
//     伝えなかった分は、次に開いたとき同じ結果をもう一度出す（**見逃すより、二度見えるほうを選ぶ**）。
//   ack のタイミングだけは画面の性質で違う（出した直後／隠れるタブは閉じるとき／利用者が押したとき）が、
//   それは各画面が「いつ呼ぶか」を決めるだけで、範囲の決め方はここを通る。
//
// ── 警告つきの記録は、パネルは「見た」と伝えない（2026-09-30 検分）─────────────────────────────
//   「見逃してはいけない知らせ」（月額が続く・まだ動いていない・確かめていない…）を持つ記録は、パネルが結果の欄へ**出した**だけでは
//   見たことにならない。パネルは公開ボタンのずっと下（①〜④の下・⑥⑧の節の中）に結果を出すので、利用者がスクロールせずに閉じると、
//   出した瞬間に main へ「見た」と伝えたぶん、二度と出なくなった。隠れているタブのパネルが持っていた分も同じ。
//   だから警告つきの記録は、**利用者が上部の「結果を確認しました」を押したとき**（PublishModal）にだけ見たことにする
//   （作者の決定 ②「閉じて開き直しても、『確認しました』を押すまで出る」）。パネルの ack の範囲を決めるここ（ackUpToFor）で、
//   警告つきの記録を必ず止める——各画面が別々に除外を書くと、1つの画面だけ抜けて警告が黙って消える。
//   警告の無い記録（成功・警告の無い失敗）は、これまでどおり、パネルが出したら見たことにする。
//
// ── 再生に耐えること ────────────────────────────────────────────────────────────────
//   記録は、閉じて開き直すたびに**もう一度**届く（見られていないものは残る）。画面が記録を受けて行う後始末は、
//   **再生されても無害**でなければならない（記録をディスクへ書かない・いまのディスクの状態から表示を決める）。
//   ディスクの記録（.sakuraide.json）を書き換える後始末は、main が操作の中（鍵の中）で1回だけ行う。

// ── 持ち場（どのパネルが、どの記録を出すか）──────────────────────────────────────────────

type OwnedRecord = { target?: string; handler?: string } | null | undefined

/** 専有型の公開先（記録の target）。 */
export const DEDICATED_TARGET = 'sakura-apprun-dedicated'

/**
 * 専有型のパネル（⑤作成・⑥すべて削除・⑧公開）が受け持つ IPC と、その種類。
 * 📡 一覧の「アプリだけ破棄」（apprunDedicated:teardownApp）は**含めない**——一覧の持ち場で、パネルは出さない。
 * `dedicatedOpKind`（apprunDedicatedActions.ts）はこの表を引く（複製しない）。
 */
export const DEDICATED_PANEL_HANDLERS: Readonly<Record<string, 'create' | 'teardown' | 'publish'>> = Object.freeze({
  'apprunDedicated:create': 'create',
  'apprunDedicated:teardown': 'teardown',
  'apprunDedicated:publishApp': 'publish',
})

/** HANAMII の画面（HanamiiPanel）の記録か。公開・破棄が入る。 */
export const isHanamiiOp = (r: OwnedRecord): boolean => !!r && r.target === 'hanamii'
/** Vercel の画面（VercelPanel）の記録か。 */
export const isVercelOp = (r: OwnedRecord): boolean => !!r && r.target === 'vercel'
/** さくらのAppRun 共用型の画面（AppRunPanel）の記録か。専有型は別のパネル。 */
export const isSharedTypeOp = (r: OwnedRecord): boolean => !!r && r.target === 'sakura-apprun'
/** 専有型の画面（AppRunDedicatedPanel）の⑤⑥⑧の記録か。 */
export const isDedicatedPanelOp = (r: OwnedRecord): boolean =>
  !!r && r.target === DEDICATED_TARGET && typeof r.handler === 'string'
  && Object.prototype.hasOwnProperty.call(DEDICATED_PANEL_HANDLERS, r.handler)

/**
 * いま**目の前に出ている**公開先の画面（PublishModal の target）が、この記録を自分の画面に出すか。
 * 出すなら、モーダルの上部（公開先によらず出す結果・進み具合）では**重ねて出さない**（二重表示の解消）。
 * 出す画面が無い公開先（レンタルサーバ・VPS・公開先の選択・読み込み中）は false ＝ 上部が出す。
 * 隠れているタブ（共用型を見ているときの専有型）の画面は、目の前に無いので「出す」に数えない。
 */
export function visiblePanelShows(target: string | null | undefined, rec: OwnedRecord): boolean {
  switch (target) {
    case 'hanamii': return isHanamiiOp(rec)
    case 'vercel': return isVercelOp(rec)
    case 'sakura-apprun': return isSharedTypeOp(rec)
    case DEDICATED_TARGET: return isDedicatedPanelOp(rec)
    default: return false
  }
}

/**
 * **見逃してはいけない知らせ**（月額が続く・まだ動いていない・確かめていない…）を持つ記録か。
 * 持つ記録は、パネルが「見た」と伝えない（上の「警告つきの記録は、パネルは『見た』と伝えない」）。
 */
export function holdsWarning(rec: { result?: { warnings?: unknown } | null } | null | undefined): boolean {
  const w = rec?.result?.warnings
  return Array.isArray(w) && w.length > 0
}

// ── 読む ──────────────────────────────────────────────────────────────────────────

/** 記録の projectDir は main が正規化した形（末尾の / なし）。画面が持つ形と比べる前に揃える（掟11）。 */
export const normDir = (p: unknown): string => String(p ?? '').replace(/[\\/]+$/, '')

/** window.electronAPI.projectOps と同じ形（テストでは偽物を渡す）。 */
export interface ProjectOpsApi {
  get(projectDir: string): Promise<ProjectOpsSnapshotShape>
  ack(projectDir: string, upToStartedAt?: number): Promise<unknown>
  onChanged(cb: (p: { projectDir: string } & ProjectOpsSnapshotShape) => void): () => void
}

/**
 * 終わって、まだ見られていない記録を、**古い順**に（同じ記録は1つ）。
 * 欠けた・壊れた写しでも落ちない（走っているものは入れない）。
 */
export function unseenOf(snap: Partial<ProjectOpsSnapshotShape> | null | undefined): ProjectOpRecordShape[] {
  const list = [...(Array.isArray(snap?.earlier) ? snap!.earlier : []), ...(snap?.last ? [snap.last] : [])]
  const seen = new Set<number>()
  const out: ProjectOpRecordShape[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object' || r.running === true || typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt)) continue
    if (seen.has(r.startedAt)) continue
    seen.add(r.startedAt)
    out.push(r)
  }
  return out.sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * どこまでを「見た」と伝えてよいか（`ack` の第2引数。伝えられるものが無ければ null）。**この1か所だけが決める。**
 *
 * 古い順に並べて、**連続した先頭から、`isShown` が true の間**の最後の記録の startedAt。
 * 見せていない記録が1つでも挟まれば、そこで止まる（それより新しいものは、自分のものでも伝えない）。
 * **警告つきの記録（`holdsWarning`）は、`isShown` が true でも見せていない扱い**で、そこで止まる——パネルは警告つきの記録を
 * 見たことにしない（利用者が上部の「結果を確認しました」を押したときだけ見たことになる。上の説明）。
 * 上部の「結果を確認しました」は、この関数を通らず、見せた記録の startedAt をそのまま伝える。
 */
export function ackUpToFor(
  unseen: readonly ProjectOpRecordShape[], isShown: (r: ProjectOpRecordShape) => boolean,
): number | null {
  let upTo: number | null = null
  for (const r of [...unseen].sort((a, b) => a.startedAt - b.startedAt)) {
    if (!isShown(r) || holdsWarning(r)) break
    upTo = r.startedAt
  }
  return upTo
}

/** いまの記録を1回読んで、終わってまだ見られていないものを返す（読めなければ空）。走っている間の購読は watchProjectOps。 */
export async function readUnseenOps(api: Pick<ProjectOpsApi, 'get'>, projectDir: string): Promise<ProjectOpRecordShape[]> {
  try { return unseenOf(await api.get(projectDir)) } catch { return [] }
}

/** 「見た」と伝える。失敗しても画面は止めない（結果は次に開いたときにまた出るだけで、失われない）。 */
export function sendAck(api: Pick<ProjectOpsApi, 'ack'>, projectDir: string, upToStartedAt: number): void {
  try { void Promise.resolve(api.ack(projectDir, upToStartedAt)).catch(() => {}) } catch { /* 伝えられなくても、次に開いたとき見える */ }
}

/**
 * **呼ぶ時点の記録を読み直して**、`isShown` の分だけ「見た」と伝える（古い写しで判断しない）。
 * 隠れうる画面（AppRunPanel）が、閉じたとき・次の操作を始めたときに呼ぶ。何度呼んでも壊れない。
 */
export function ackShown(api: Pick<ProjectOpsApi, 'get' | 'ack'>, projectDir: string, isShown: (r: ProjectOpRecordShape) => boolean): void {
  try {
    void Promise.resolve(api.get(projectDir))
      .then(s => {
        const upTo = ackUpToFor(unseenOf(s), isShown)
        if (upTo !== null) return api.ack(projectDir, upTo)
      })
      .catch(() => {})
  } catch { /* 読めなくても画面は止めない */ }
}

export interface OpsWatch {
  /**
   * 記録を聞き直す（押し出しが1つ届かなかったときの保険）。応答が画面へ届いたら解決する（届かなければ何もしない）。
   * 聞いている間により新しい押し出しが届いたら、その応答は使わない。
   */
  refresh(): Promise<void>
  /** 外す（アンマウント）。以降は何も届けない。 */
  stop(): void
}

/**
 * 開いたとき記録を1回読み、開いている間は押し出し（onChanged）を受ける。**5つの画面が共通で使う。**
 *
 * - 押し出しは毎回そのプロジェクトの**全体の写し**。届いたものでそのまま置き換える。
 * - **別のプロジェクトの知らせは無視する**（掟11。`normDir` で揃えて比べる）。
 * - **問い合わせ（get）の応答が届く前に押し出しが先に届いていたら、応答は捨てる**
 *   （古い写しで新しいものを戻さない・すでに見られた記録を出し直さない）。
 */
export function watchProjectOps(
  api: ProjectOpsApi,
  projectDir: string,
  onSnapshot: (snap: ProjectOpsSnapshotShape) => void,
): OpsWatch {
  let stopped = false
  /** 押し出しが届くたびに進める。問い合わせを出した時点から進んでいたら、その応答は古い。 */
  let pushSeq = 0
  let off: () => void = () => {}
  try {
    off = api.onChanged(p => {
      if (stopped || !p || normDir(p.projectDir) !== normDir(projectDir)) return
      pushSeq++
      onSnapshot(p)
    })
  } catch { /* 押し出しを受けられなくても、下の問い合わせだけで動く */ }
  const ask = async (): Promise<void> => {
    const seq = pushSeq
    try {
      const s = await api.get(projectDir)
      if (!stopped && seq === pushSeq && s) onSnapshot(s)
    } catch { /* 聞けなかったときは、いまの表示のまま */ }
  }
  void ask()
  return {
    refresh: () => (stopped ? Promise.resolve() : ask()),
    stop() { stopped = true; try { off() } catch { /* 解除の失敗は無視 */ } },
  }
}
