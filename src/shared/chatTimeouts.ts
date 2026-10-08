// chatTimeouts.ts — AI への問い合わせで「どれだけ待つか」の唯一の定義（掟10）。
//
// ── なぜ要るか（2026-09-23 実機・Ryosuke）─────────────────────────────
// チャットが「実際に変更が必要か確かめています… 308秒」で固まり、⏹ を押しても止まらず、
// Koto を終了する以外に抜ける手段が無かった。原因のひとつが「待ち時間に上限が無い」こと:
// engine.ts の sakuraClient は `new OpenAI({ apiKey, baseURL })` だけで timeout も maxRetries も
// 渡しておらず、同梱の openai 4.104.0 の既定は **timeout 600秒・再試行2回＝最悪およそ1,800秒**。
// さらに悪いことに、その600秒は**応答ヘッダが返った時点で解除される**
// （node_modules/openai/core.js の fetchWithTimeout・382-401行:
//  `this.fetch(...).finally(() => clearTimeout(timeout))`。undici の fetch はヘッダを受け取った
//  時点で解決するので、clearTimeout が走るのは**ヘッダ到着時**であって最初のチャンク到着時ではない）。
// node_modules/openai/streaming.js に setTimeout は**0件**なので、
// **ヘッダだけ返して黙られると永久に戻らない**。
// つまり実際の最悪の待ち時間は「ヘッダまで 120秒 ＋ そのあとの無音 90秒」になる。
//
// ── クライアント全体に一律の timeout を掛けてはいけない ─────────────────
// ストリーミングで計りたいのは「返事の**先頭**が届くまで」なので短くてよい。
// 一方、非ストリーミング（🗂 まとめ作り・delegate_implementation）は
// **生成が全部終わるまでが1回の通信**なので、同じ値にすると正常なまとめ作りが時間切れで壊れる。
// そのため値を分け、`client.chat.completions.create(body, { timeout, maxRetries })` の
// **第2引数（リクエストごとの設定）**で渡す（openai SDK の RequestOptions・node_modules/openai/core.d.ts で確認済み）。

/** ストリーミングで「応答ヘッダが返るまで」の上限（ミリ秒）。
 *  SDK の時計が見ているのはここまで（上のコメント参照）。ヘッダのあとの沈黙は
 *  STREAM_IDLE_TIMEOUT_MS と shared/streamIdle.ts が見る。 */
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = 120_000

/** 返事が始まったあと、次の文字が届かないまま待てる上限（ミリ秒）。
 *  推論（reasoning）の文字も「届いている」と数えるので、沈黙が長い推論モデルを切らない。 */
export const STREAM_IDLE_TIMEOUT_MS = 90_000

/** ストリーミングの再試行回数。1 にすることで最悪 120秒 × 2 ＝ およそ4分で必ず戻る。 */
export const STREAM_MAX_RETRIES = 1

/** 非ストリーミング（🗂 まとめ作り・delegate_implementation）の上限（ミリ秒）。
 *  生成が全部終わるまでが1回の通信なので、ストリーミングより長くする。 */
export const NON_STREAM_TIMEOUT_MS = 300_000

/** 非ストリーミングの再試行回数。 */
export const NON_STREAM_MAX_RETRIES = 1

/** delegate_implementation（main/claude/tools.ts）の上限（ミリ秒）。
 *
 *  ── なぜ 🗂 まとめ作りと値を分けるか（2026-09-23 検分の指摘4）───────────────
 *  どちらも「生成が全部終わるまでが1回の通信」だが、要求する出力量が**4倍違う**:
 *  まとめ作りは max_tokens=4096（shared/chatTurn.ts の runCompact）、delegate は
 *  max_tokens=16384（DELEGATE_MAX_TOKENS・複数ファイルの全文をJSONで返させる）。
 *  同じ 300秒を当てると、これまで openai の既定（1試行 600秒）で通っていた
 *  「大きめのファイルを委譲して書かせる」依頼が、混み合った日や遅いモデルで
 *  突然時間切れになる。出力量に合わせて上限も分ける。 */
export const DELEGATE_TIMEOUT_MS = 600_000

/** delegate_implementation の再試行回数（1回だけやり直す＝最悪およそ20分）。 */
export const DELEGATE_MAX_RETRIES = 1

/** モデル一覧の取得（⚙️ 設定の「接続テスト」・モデル選択）の上限（ミリ秒）。
 *
 *  ここには ⏹ に相当する止め方が無いので、短く切る。SDK の既定のままだと
 *  AI Engine が黙ったときに最悪およそ1,800秒（600秒×3）返ってこない。 */
export const MODELS_TIMEOUT_MS = 30_000

/** モデル一覧の取得の再試行回数。 */
export const MODELS_MAX_RETRIES = 1

/**
 * openai SDK が投げた「時間切れ」かどうか（唯一の定義・掟10）。
 *
 * ── なぜ `/timed out/i` では駄目か（2026-09-23 検分の指摘8・14）──────────────
 * 同梱の 4.104.0 は error クラスに `name` を設定しないので `err.name` は 'Error' のまま。
 * よって構成子名で見る（node_modules/openai/core.js:328 が APIConnectionTimeoutError を投げる）。
 * message 側を広く `/timed out/i` で見ると、**さくら側や途中の gateway が返す
 * 504 Gateway Timeout の本文**にその語が含まれるだけで一致してしまい、
 * 数秒で返ってきたサーバの失敗を「120秒待っても始まらなかった」と誤って説明して
 * 本当の原因を隠す。SDK の既定文言は正確に 'Request timed out.'
 * （node_modules/openai/error.js:88-92 で確認）なので、message を見るときは完全一致にする。
 */
export function isSdkTimeoutError(err: any): boolean {
  if (err?.constructor?.name === 'APIConnectionTimeoutError') return true
  return /^request timed out\.?$/i.test(String(err?.message ?? '').trim())
}

/**
 * 時間切れの種類＝**実際にどちらの時計で切れたか**（2026-09-25 検分の指摘27）。
 *
 * 待ち時間の見張りは2つあり、上限も別々なので、種類も分けないと文言の秒数が嘘になる:
 *   'first'        … 応答ヘッダすら返らなかった。SDK の時計（STREAM_FIRST_CHUNK_TIMEOUT_MS
 *                     ×（STREAM_MAX_RETRIES+1）＝およそ240秒）で切れた。
 *   'first-silent' … つながったのに1文字も届かなかった。SDK の時計はヘッダ到着で解除済みなので、
 *                     切ったのは無音の見張り（STREAM_IDLE_TIMEOUT_MS＝90秒・shared/streamIdle.ts）。
 *                     **実機の症状「ヘッダだけ返して黙る」は必ずこれ**。
 *   'idle'         … 返事が始まったあと途中で止まった。同じく無音の見張り（90秒）。
 *
 * 直す前は 'first-silent' を 'first' に混ぜていたため、90秒しか待っていない人の画面に
 * 「120秒×2回（合計およそ240秒）」と出ていた（engine.ts の timedOut の作り方も参照）。
 */
export type StreamTimeoutKind = 'first' | 'first-silent' | 'idle'

/** 秒に直して文中に出す（値を変えたら文言の数字も自動で追随する＝一元定義）。 */
function sec(ms: number): number {
  return Math.round(ms / 1000)
}

/**
 * 時間切れのときに画面へ出す文（利用者向けの日本語）。
 *
 * ⏹ で止めたときの「（⏹ 停止しました）」とは**必ず違う言葉**にする——
 * 押してもいないのに「停止しました」と出ると、利用者が自分の操作と取り違える。
 */
export function streamTimeoutMessage(kind: StreamTimeoutKind): string {
  if (kind === 'first') {
    // ── なぜ「×N回」と書くか（2026-09-23 検分の指摘7）────────────────────
    // node_modules/openai/core.js の makeRequest（322-331行）は、fetch が時間切れで失敗したとき
    // **`retriesRemaining` の判定を APIConnectionTimeoutError への変換より先**に行う。
    // つまり STREAM_MAX_RETRIES=1 だと「120秒で1回目が切れる → 再試行 → もう120秒」で、
    // 利用者が実際に待つのはおよそ240秒。画面の経過秒カウンタもその数字を出しているので、
    // 「120秒待っても」とだけ書くと**数字が食い違って見える**。試行回数まで文に出す。
    //
    // ── ここは「つながらなかった」ときだけの文（2026-09-25 検分の指摘27/28）──────
    // ヘッダは返ったのに1文字も届かない症状（実機でいちばん多い）は 'first-silent' へ分けた。
    // 以前はそれもこの文で説明していたため、**90秒しか待っていない人の画面に
    // 「合計およそ240秒」**と出て、直前まで数えていた経過秒と食い違っていた。
    // あわせて「実際に待った時間は、画面に出ていた秒数のとおりです」も落とす——
    // この文はあいさつの生成（ChatPanel.tsx の greetLoading）でも出るが、そこでは
    // 経過秒が一度も描画されない（elapsedSec は emit の loading:true でしか動かない）。
    // **画面に無いものを「出ていた」と言わない。**
    return '⏱ AIからの返事が1文字も始まらないまま待ち時間の上限に達したため、この問い合わせを打ち切りました。'
      + `返事が始まるのを待てるのは${sec(STREAM_FIRST_CHUNK_TIMEOUT_MS)}秒×${STREAM_MAX_RETRIES + 1}回`
      + `（合計およそ${sec(STREAM_FIRST_CHUNK_TIMEOUT_MS * (STREAM_MAX_RETRIES + 1))}秒）までです。`
      + '混み合っているだけのことも多いので、もう一度お試しください。'
  }
  if (kind === 'first-silent') {
    // ── ヘッダだけ返して黙られた（2026-09-25 検分の指摘27）──────────────────
    // 利用者が実際に待ったのは**無音の上限（90秒）だけ**。SDK の時計はヘッダ到着で
    // 解除されているので、120秒・240秒はこの人には一度も関係していない（engine.ts の
    // 'first-silent'）。「返事を始めかけた」のような**画面に現れない出来事**の言葉は使わず、
    // 見えたとおり（つながった／でも何も出ない）で書く。
    return `⏱ AIにはつながりましたが、返事が1文字も届かないまま${sec(STREAM_IDLE_TIMEOUT_MS)}秒たったため、ここで打ち切りました。`
      + 'まだ何も届いていないので、残っている内容はありません。'
      + '混み合っているだけのことも多いので、もう一度お試しください。'
  }
  return `⏱ AIの返事が途中で${sec(STREAM_IDLE_TIMEOUT_MS)}秒以上止まったため、`
    + 'ここで打ち切りました。途中までの内容はそのまま残しています。もう一度お試しください。'
}

/** 🗂 まとめ作りが時間切れで終わったときに画面へ出す文（利用者向けの日本語）。
 *
 *  手動の【🗂 まとめる】は、この文をそのまま吹き出しに出す（useAiChat.ts）。
 *  直す前は openai の 'Request timed out.' が英語のまま画面に出ていた（検分の指摘1）。 */
export function compactTimeoutMessage(): string {
  return `⏱ 🗂 まとめ作りが${sec(NON_STREAM_TIMEOUT_MS)}秒×${NON_STREAM_MAX_RETRIES + 1}回`
    + `（合計およそ${sec(NON_STREAM_TIMEOUT_MS * (NON_STREAM_MAX_RETRIES + 1))}秒）試しても終わらなかったため、いったん中止しました。`
    + '混み合っているだけのことも多いので、もう一度お試しください。'
}

/** delegate_implementation が時間切れで終わったときに、AI（Claude）へ返す文。
 *  ツールの戻り値はそのまま画面にも出るので、利用者向けの日本語で書く（検分の指摘4）。 */
export function delegateTimeoutMessage(): string {
  return `エラー: 委譲先のAIからの返事が${sec(DELEGATE_TIMEOUT_MS)}秒×${DELEGATE_MAX_RETRIES + 1}回試しても`
    + '返ってこなかったため、委譲を打ち切りました。タスクを小さく分けて再度お試しください。'
}
