// vercelFit.ts — Vercel に「そもそも載る作りか」を、押す前に判断する（純ロジック）。
//
// ── なぜ要るか（2026-08-15）──────────────────────────────────────────
// Vercel の画面には**折りたたみの注意書き**しか無く（「常駐サーバは動きません」）、
// 公開ボタンには何の確認も無かった。押すとデプロイは**成功する**が、
// Node の常駐サーバは起動しないので、**ソースが丸見えのページ**が公開される。
// AppRun で同じことが起きている（内蔵ビルダーが static 決め打ちだった件）。
//
// **成功と表示されながら壊れている**のが、いちばん質の悪い失敗である。
// AppRun には「公開できるか確かめる」を付けた（v0.3.20）。Vercel にも要る。
//
// ── 判断の材料（推測しない）──────────────────────────────────────────
// ・ソースが自分でポートを待ち受けているか（`http.createServer` / `.listen(`）
// ・データの保存（koto-data）を使っているか
//   → **2026-09-24 に、Koto は Vercel へ保存場所の設定（KOTO_STORAGE_*）を渡せるようになった。**
//     それまでは渡す仕組みが無く、公開しても読み書きできないので `ng` で止めていた。
//     制約は Vercel 側ではなく Koto 側だったので、渡せるようにして止めるのをやめた。
//     ただし `koto-data` は Node の部品（`node:crypto`）で、**ブラウザでは動かない**。
//     呼べるのはサーバーレス関数（Next.js の API ルート等）の中からだけで、
//     **純粋な静的サイトには呼ぶ場所そのものが無い**。ここは隠さずに添える。
// ・Vercel が得意な作り（Next.js 等のビルド）か
//
// 判断はここ、走査は main（IO）。

import type { PreflightCheck } from './preflight'

/**
 * このソースは「自分でポートを待ち受ける常駐サーバ」か（純関数）。
 *
 * Vercel はリクエストのたびに関数を呼ぶ形（サーバーレス）なので、
 * 待ち受け続けるプログラムは動かない。
 */
export function serverListens(sourceText: string): boolean {
  const t = String(sourceText ?? '')
  if (/\bhttps?2?\s*\.\s*createServer\s*\(/.test(t)) return true
  if (/\bcreateServer\s*\(/.test(t) && /\.listen\s*\(/.test(t)) return true
  // express / fastify / koa の定番
  if (/\b(app|server|fastify)\s*\.\s*listen\s*\(/.test(t)) return true
  return false
}

/** Vercel が得意な作り（ビルドして配るもの）か（純関数）。 */
export function looksLikeFramework(packageJson: unknown | null): boolean {
  const p = (packageJson ?? {}) as Record<string, unknown>
  const deps = { ...(p.dependencies as object ?? {}), ...(p.devDependencies as object ?? {}) }
  const names = Object.keys(deps)
  if (names.some(n => /^(next|nuxt|astro|vite|gatsby|react-scripts|@sveltejs\/kit|@remix-run\/)/.test(n))) return true
  const scripts = (p.scripts ?? {}) as Record<string, unknown>
  return typeof scripts.build === 'string' && scripts.build.trim().length > 0
}

/** 走査の結果（main が集める）。 */
export type VercelScan = {
  /** 解析済みの package.json（無ければ null）。 */
  packageJson: unknown | null
  /** 常駐サーバとして待ち受けているファイル（プロジェクトからの相対パス）。 */
  listens: readonly string[]
  /** データの保存（koto-data）を使っているファイル。 */
  usesData: readonly string[]
  /** 公開できるファイルが1つでもあるか。 */
  hasFiles: boolean
  /**
   * 自分でファイルに直接書いている場所（プロジェクトからの相対パス・2026-09-24 検分）。
   *
   * ── なぜ要るか ────────────────────────────────────────────────────
   * 保存場所（バケット）の有無だけで「データは残ります」と断定していた。ところが
   * `koto-data` へ書き直す途中のアプリ（3か所のうち1か所だけ直った等）では、
   * **ファイルに直接書いているぶんが公開のたびに消える**。同じ③公開の画面で、
   * 上の枠（storageNeed.ts の will-lose-data）は「⚠️ 残っています」と出し、
   * 下の確認は「✅ データは残ります」と出す——利用者は下を信じて公開する。
   *
   * ── なぜ `hasStorage` と違って任意（`?`）なのか ───────────────────────
   * **渡さなければ「分からない」として扱い、断定をやめる**（安全側へ倒れる）。
   * 渡し忘れても「データは残ります」と言い切らないので、黙って機能が外れることはない。
   * 渡せば、ファイル直書きが残っているかどうかまで言い切れる。
   */
  writesFiles?: readonly string[]
  /**
   * 入力されたデータを、**メモリ（変数・配列）だけに持っている**と思われるファイル
   * （プロジェクトからの相対パス・2026-10-01 rc.5 の実機）。推定である。
   *
   * ── なぜ Vercel でも「残らない」側に倒すのか ──────────────────────────
   * Vercel は関数を呼ぶたびに（あるいは入れ替わるたびに）新しい場所で動かす作り。モジュールの
   * 先頭に置いた配列・Map は、**別の呼び出しから見えないことがあり、入れ替われば消える**。
   * 動作確認では入れた名前が見えるので正常に見え、あとで消える——ファイル直書きと同じ
   * 「静かに壊れる形」なので、同じ枠（storage）で知らせる。判定は
   * `memoryKeepLines`（shared/memoryKeep.ts）で、storageNeed.ts の判断と**同じ信号**を使う。
   *
   * **koto-data を使っている（`usesData` がある）ときは、メモリを理由に警告しない**
   * （キャッシュの誤検知を避ける。storageNeed.ts の `memoryIsAProblem` と同じ向き）。
   *
   * `writesFiles` と同じく任意（`?`）: 渡さなければ「分からない」として何も言わない。
   * **ただし、渡し忘れると「✅ このアプリはデータの保存を使っていません」に戻る**——今回直した
   * 元の欠陥そのもの（メモリだけに持つアプリを ✅ で通す）。型は任意なので素通りする。
   * 渡し忘れの検知は tests/memoryKeepWiring.test.ts が持つ（vercel:preflight を実際に叩いて確かめる）。
   */
  keepsInMemory?: readonly string[]
  /**
   * 保存場所（さくらのオブジェクトストレージ）を**用意済みか**（2026-09-24 検分の指摘1・4・12）。
   *
   * これが無いと「データは残ります」と断言してしまう。実際には、用意していないプロジェクトでは
   * `issueStorageEnvFor` が `reason:'none'` を返し、**環境変数を1件も渡さないまま公開が成功する**
   * （`ipc/vercel.ts`）。そのとき `koto-data` は手元のフォルダ（`.koto-data`）へ落ちるので、
   * Vercel では書けたように見えて次の公開で消える。
   *
   * **任意（`?`）にしない。** 渡し忘れても型検査が素通りすると、機能が黙って外れる（掟10）。
   */
  hasStorage: boolean
}

/**
 * Vercel へ公開する前の確認（純関数）。
 *
 * **`ng` は「確実に壊れる」と分かったときだけ。** 判別できないものは `warn` にして
 * 通す（確かめられなかっただけで公開できないのは、壊れているのと同じ）。
 */
export function judgeVercelFit(scan: VercelScan): PreflightCheck[] {
  const checks: PreflightCheck[] = []
  const listens = scan.listens ?? []
  const usesData = scan.usesData ?? []
  // **3つの状態**を区別する: 渡されていない（分からない）／無い／残っている。
  // 「分からない」を「無い」に倒すと、また断定できないことを断定する（掟10）。
  const writesKnown = Array.isArray(scan.writesFiles)
  const writesFiles = writesKnown ? (scan.writesFiles as readonly string[]) : []
  const writesLeft = writesFiles.length > 0
  const writesWhere = writesFiles.slice(0, 2).join('、')
  const memoryFiles = Array.isArray(scan.keepsInMemory) ? (scan.keepsInMemory as readonly string[]) : []
  const memoryLeft = memoryFiles.length > 0
  const memoryWhere = memoryFiles.slice(0, 2).join('、')

  // ── 配るファイル ────────────────────────────────────────────────────
  checks.push(scan.hasFiles
    ? { id: 'files', label: '公開するファイル', status: 'ok', note: '公開できるファイルがあります。' }
    : {
        id: 'files', label: '公開するファイル', status: 'ng',
        note: '公開できるファイルが見つかりません。まず「① 作る」でファイルを作ってください。',
      })

  // ── アプリの作り ────────────────────────────────────────────────────
  if (listens.length > 0) {
    checks.push({
      id: 'runtime', label: 'アプリの作り', status: 'ng',
      note: `このアプリは、動き続けるサーバーとして作られています（${listens.slice(0, 2).join('、')}）。`
        + 'Vercel ではこの作りは動きません。'
        + '公開先を「さくらのAppRun」か「HANAMII」に変えると、この作りに対応しています。'
        + 'Vercel のままにするなら、横の「AIに相談する」から書き直しを頼んでください。',
      fix: 'ask-ai',
    })
  } else if (looksLikeFramework(scan.packageJson)) {
    checks.push({ id: 'runtime', label: 'アプリの作り', status: 'ok', note: 'Vercel が得意な作りです（ビルドして配ります）。' })
  } else if (!scan.packageJson) {
    checks.push({ id: 'runtime', label: 'アプリの作り', status: 'ok', note: '静的なファイルをそのまま配ります。' })
  } else {
    checks.push({
      id: 'runtime', label: 'アプリの作り', status: 'warn',
      note: '作りを判別できませんでした。公開したあと、ページが正しく表示されるか確かめてください。',
    })
  }

  // ── データの保存 ────────────────────────────────────────────────────
  if (usesData.length > 0) {
    // **止めない（2026-09-24）。** 保存場所の設定は公開のときに Koto が渡す（ipc/vercel.ts）。
    //
    // ── なぜ `ok` ではなく `warn` か ──────────────────────────────────
    // 残る制約が1つある: データの保存はブラウザからは使えず、サーバーレス関数の中から
    // 呼ぶ必要がある。**Koto にはそれが満たせているか確かめる手段が無い**
    // （`looksLikeFramework` は build スクリプトがあれば真になる緩い判定で、
    // 見分けを間違えると「公開できるはずのものを止める」か「動かないものを通す」の
    // どちらかになる。だから作りでは分けない）。
    // このファイルの決まりでは **`warn` は「判別できないもの」**（通すが、気になる点として出す）。
    // ✅ で出すと「何も気にしなくてよい」に読めるが、実際は利用者が確かめるべきことが残る。
    // `warn` は `summarizePreflight` で**公開を止めない**（canPublish は true のまま）ので、
    // 「通したうえで、できないことを隠さない」になる。
    //
    // ── 「残ります」と言ってよいのは、保存場所を用意してあるときだけ ──────
    // （2026-09-24 検分の指摘1・4・12）。用意していないプロジェクトでは環境変数が
    // 1件も渡らず、公開は成功したまま**データだけが毎回消える**。しかも画面のどこにも
    // 理由が出ないので、いちばん気づけない形になる。**status は warn のまま＝公開は止めない。**
    //
    // ── ファイル直書きが残っていたら「残ります」と言わない（2026-09-24 検分）──────
    // 書き直しの途中（koto-data も使うが fs.writeFileSync も残っている）アプリでは、
    // 保存場所を用意してあっても**ファイルに書いたぶんは公開のたびに消える**。
    // 隣の storageNeed.ts の will-lose-data と**同じ趣旨**を、ここでも言う。
    const storageNote = writesLeft
      ? 'ただし、ファイルに直接書いている箇所が残っているので'
        + (writesWhere ? `（${writesWhere}）` : '')
        + '、そこに書かれたデータは残りません（何もしなくても消えることがあります）。'
        + '上の「AIに書き直してもらう」から、残っている書き込みも koto-data へ書き直してください。'
        + (scan.hasStorage
          ? '保存場所は用意してあるので、koto-data へ書き直したぶんは、公開のときに Koto が設定を渡して残ります'
            + '（データが置かれるのは日本国内です）。'
          : 'さらに保存場所をまだ用意していないため、いまのままではどのデータも残りません。'
            + '上の「保存場所を用意する」から用意してください。'
            + '用意すると、公開のときに Koto が設定を渡します（データが置かれるのは日本国内です）。')
      : scan.hasStorage
        ? (writesKnown
          // ファイル直書きが残っていないと**確かめられた**ときだけ言い切る
          ? '公開のときに、さくらのオブジェクトストレージの設定を Koto が渡すので、データは残ります'
            + '（データが置かれるのは日本国内です）。'
          // 確かめていないので言い切らない（どちらに倒しても嘘になりうる）
          : '公開のときに、さくらのオブジェクトストレージの設定を Koto が渡すので、'
            + 'koto-data に保存したぶんは残ります（データが置かれるのは日本国内です）。'
            + 'ファイルに直接書いている箇所が残っていると、そこに書かれたぶんは公開のたびに消えます'
            + '（上の枠の案内も合わせて確かめてください）。')
        : '保存場所をまだ用意していないため、いまのままではデータは残りません'
          + '（何もしなくても消えることがあります）。'
          + '上の「保存場所を用意する」から用意してください。'
          + '用意すると、公開のときに Koto が設定を渡します（データが置かれるのは日本国内です）。'
    checks.push({
      id: 'storage', label: 'データの保存', status: 'warn',
      note: `このアプリはデータの保存を使っています（${usesData.slice(0, 2).join('、')}）。`
        + storageNote
        // 画面には素のテキストとして出る。**Markdown 記法は使わない**（v0.2.98 の教訓）。
        + 'ただし、ブラウザからは使えません。サーバーレス関数（Next.js の API ルートなど）の'
        + '中から呼んでください。ページの中（ブラウザ側）から直接呼んでいると動きません。'
        // 純粋な静的サイト（96行目で ok になる作り）には、呼ぶ場所そのものが無い。
        // 常駐サーバの分岐と同じく、**逃げ道を示す**（2026-09-24 検分の指摘8）。
        + 'サーバーレス関数が無いアプリ（ページだけのサイト）では、公開先を「さくらのAppRun」か'
        + '「HANAMII」に変えると、書き直さずにデータの保存が使えます。',
      fix: 'ask-ai',
    })
  } else if (writesLeft || memoryLeft) {
    // ── koto-data を一度も使わず、ファイルに直接書いているだけのアプリ（2026-09-24 検分）──
    // 「データの保存を使っていません」＝✅ で通すと、データの行が丸ごと緑になる。
    // Vercel は公開のたびに元へ戻るので、**書いたデータは残らない**。**止めはしない**
    // （静的なページとして使うぶんには壊れていない）が、黙らない。
    //
    // ── メモリだけに持つ形も、同じ枠で知らせる（2026-10-01 rc.5 の実機）──────────────
    // ファイルにも koto-data にも書かないので、これまでは「✅ データの保存を使っていません」で
    // 通っていた。サーバーレス関数の先頭に置いた配列は、入れ替われば消える（`keepsInMemory` の説明）。
    // ファイル直書きだけの回の文は、これまでと**一字も変えない**。
    const direct = 'ファイルに直接書いて保存している箇所があります' + (writesWhere ? `（${writesWhere}）` : '')
    const inMemory = '入力されたデータをプログラムの中（メモリ）だけに持っている箇所があるようです'
      + (memoryWhere ? `（${memoryWhere}）` : '')
    checks.push({
      id: 'storage', label: 'データの保存', status: 'warn',
      note: 'このアプリはデータの保存（koto-data）を使っていませんが、'
        + (writesLeft && memoryLeft ? `${direct}。また、${inMemory}` : writesLeft ? direct : inMemory)
        + '。'
        + (writesLeft
          ? 'そこに書かれたデータは残りません（何もしなくても消えることがあります）。'
          : 'Vercel では、アプリが動く場所が入れ替わったり複数に分かれたりするため、そこに持ったデータは残りません（何もしなくても消えることがあります）。')
        + '上の「AIに書き直してもらう」から koto-data へ書き直すと、データが残るようになります。',
      fix: 'ask-ai',
    })
  } else {
    checks.push({ id: 'storage', label: 'データの保存', status: 'ok', note: 'このアプリはデータの保存を使っていません。' })
  }

  return checks
}
