// apprunDedicatedAppApply.ts — さくらのAppRun 専有型「アプリを公開する」（roadmap #23 ⑤・D-2b-1）の
// main 側の純関数フロー。createClusterFlow（apprunDedicatedApply.ts）と同じ型・同じ流儀:
//   - 各段の失敗は `stage` と生の message で止める（確認できないことを成功にしない）。
//   - POST でIDが取れた時点で、確認（GET）を待たずに記録する（2026-08-14「成功と読んだ応答は
//     結果を確かめるまで成功ではない」の逆側——確認できないことは「作られていない」の証明にもならない）。
//   - `opts.confirmed !== true` なら、API を一切呼ばずに中止する（掟10の3点セット）。
//
// **この段では作らない・扱わない**: クラスタ・ASG・ロードバランサ自体の作成/削除
// （apprunDedicatedApply.ts の createClusterFlow/teardownFlow の役目）。ここは、既に⑤で
// 作られたクラスタの上に「アプリケーション」を1つ公開する段取りだけを持つ。
//
// **D-2b-2 の範囲（今回は触らない）**: teardownFlow 先頭のアプリ削除・`appOnly`。
//
// 依存（複製しない・掟10）:
//   - src/main/cloud/apprunDedicated.ts の getCluster/patchClusterLoadBalancer/listApplications/
//     createApplication/getApplication/updateApplication/listApplicationVersions/
//     createApplicationVersion/deleteApplicationVersion/listLoadBalancerNodes
//   - src/shared/apprunDedicatedShapes.ts の readHasLetsEncryptEmail/readApplicationRows/
//     readApplicationId/readApplication/readVersionNumber/readVersionRows
//   - src/shared/apprunDedicatedApp.ts の validateAppSpec/buildApplicationCreateBody/
//     buildVersionCreateBody/buildActiveVersionBody/buildLetsEncryptPatchBody/versionsToDelete/
//     collectBareLbAddresses（readLoadBalancerNodeAddresses → bareIp。LB ノードの `address` は
//     `IP/24` のネットマスク付き＝2026-09-16 実測・5-13。A レコードに案内するのは素の IP だけ）
//   - src/main/publishMetaFs.ts の readApprunDedicatedFs/writeApprunDedicatedRecordFs
//   - src/shared/publishVerify.ts の verifyDelaysMs/dedicatedVerifyMode/dedicatedProbePath/
//     judgeDedicatedProbeBy/dedicatedVerifySettled
//     （D-7 の verify 段。「公開しました」と言う前に、アプリが本当に応答しているかを確かめる。
//      D-19 で静的配信以外＝Node にも効かせた——確かめ方の分岐は publishVerify.ts に置く）

import https from 'node:https'
import type { CloudCredentials } from './auth'
import {
  getCluster, patchClusterLoadBalancer, listApplications, createApplication, getApplication,
  updateApplication, listApplicationVersions, createApplicationVersion, deleteApplicationVersion,
  listLoadBalancerNodes, listApplicationContainers,
} from './apprunDedicated'
import { readApprunDedicatedFs, writeApprunDedicatedRecordFs } from '../publishMetaFs'
import {
  readHasLetsEncryptEmail, readClusterPorts, readApplicationRows, readApplicationId, readApplication,
  readVersionNumber, readVersionRows, readContainerStates,
} from '../../shared/apprunDedicatedShapes'
import {
  validateAppSpec, buildApplicationCreateBody, buildVersionCreateBody, buildActiveVersionBody,
  buildLetsEncryptPatchBody, versionsToDelete, collectBareLbAddresses, missingRequiredPorts,
  type ApprunDedicatedAppSpec,
} from '../../shared/apprunDedicatedApp'
import { DEFAULT_KEEP } from '../../shared/imageRetention'
import {
  verifyDelaysMs, dedicatedVerifyMode, dedicatedProbePath, judgeDedicatedProbeBy, dedicatedVerifySettled,
  type DedicatedProbe, type DedicatedVerifyOutcome,
} from '../../shared/publishVerify'

// ── 入力・出力の形 ────────────────────────────────────────────────────

/** publishAppFlow への入力。spec は⑤の入力欄そのまま（apprunDedicatedApp.ts）。 */
export type PublishAppInput = {
  spec: ApprunDedicatedAppSpec
  /** push 済みのコンテナイメージの参照（タグ付きref）。 */
  imageRef: string
  /** イメージ取得用のレジストリ資格情報（掟4: main は保存しない。引数で受け取るだけ）。 */
  registry: { username: string; password: string }
  /** クラスタに Let's Encrypt のメールが未設定のときだけ使う。未設定かつ無ければ止める。 */
  letsEncryptEmail?: string | null
  /**
   * D-7: 公開した像に焼き込んだ版の目印（`.koto-build` の中身になるタグ。imageBuild.ts の
   * `buildTag`＝`tagOfRef(ref)` と同じ値）。verify 段はこの値と、公開先から読んだ目印を突き合わせる。
   * **無ければ目印では確かめない**（何と比べればよいか分からないものを「一致した」に倒さない）。
   * D-19: ただし**確認そのものはとばさない**——根（`/`）へ当てて応答があるかだけを見る。
   */
  buildTag?: string | null
  /**
   * D-7: 公開した像の種類（`static` / `node` …。imagePublish.ts の `runtimeKind`）。
   * 目印 `.koto-build` が公開物の直下に出るのは静的配信だけ。
   * D-19: **静的配信以外でも確認はする**（根へ当てる）。この値が変えるのは
   * 「目印で中身の新しさまで見るか／応答があるかだけ見るか」＝`dedicatedVerifyMode` の選択だけで、
   * **確認するかどうかではない**（2026-09-16 の事故は Node アプリで起きた）。
   */
  runtimeKind?: string | null
}

// 'image' は publishAppFlow 自身は返さない——IPC（ipc/apprunDedicated.ts の apprunDedicated:publishApp）が
// この関数の前に行う「イメージの組み立て→レジストリへ push」（cloud/imagePublish.ts の prepareAppImage）の
// 失敗を、同じ stage の語彙で画面へ返すための段（D-4）。画面の段ラベル（Record<PublishAppStage, string>）が
// 全段必須になるよう、ここに1つの union として置く。
export type PublishAppStage =
  | 'consent' | 'no-cluster' | 'invalid' | 'record' | 'lets-encrypt' | 'cluster-ports' | 'app-lookup'
  | 'name-taken' | 'app-create' | 'version-create' | 'activate' | 'cleanup' | 'lb-address' | 'image'
  // 'storage' は IPC（ipc/apprunDedicated.ts）が「保存場所の鍵を用意できなかった」ときに返す段。
  // 利用者の入力の誤りではないので 'invalid'（画面では「入力の検証」）に混ぜない（2026-09-23 検分の指摘12）。
  | 'storage' | 'done'

/**
 * その段で止まったとき、**いま発行した鍵を載せた版が1つも無い**と言い切れるか（純関数・2026-09-23 検分の指摘5・10）。
 *
 * 公開が途中で止まると、直前に発行した「バケットへ読み書きできる本物の鍵」が残る。
 * 片づけは**成功した公開のときにしか走らない**ので、ビルドが直らない間に何度も押した分だけ
 * 溜まっていく（実機で5件・storageKeys.ts 冒頭）。そこで**その場で取り消す**のだが、
 * **版が作られたあとは取り消してはいけない**——`version-create` の POST が通ったかは外から
 * 区別できず、`activate` は「切り替わりを確かめられなかった」だけで後から有効になりうる。
 * その鍵を消すと、**新しい版が動き出した瞬間に 403 で落ちる**（掟10「切り替わる前に、
 * 古いほうの足元を外さない」の裏返し）。**分からない側は残す**（孤児は次の成功で片づく）。
 */
export function stageLeftNoVersion(stage: PublishAppStage): boolean {
  switch (stage) {
    // ここで止まったときは、版（version）はまだ1つも作られていない
    case 'consent': case 'no-cluster': case 'invalid': case 'record': case 'lets-encrypt':
    case 'cluster-ports': case 'app-lookup': case 'name-taken': case 'app-create':
    case 'image': case 'storage':
      return true
    // 版が作られている（かもしれない）／公開は成立している
    case 'version-create': case 'activate': case 'cleanup': case 'lb-address': case 'done':
      return false
  }
}

export type PublishAppResult = {
  ok: boolean
  stage: PublishAppStage
  message: string
  applicationID?: string
  version?: number
  url?: string
  lbAddresses?: string[]
  /**
   * D-7: 公開のあと、アプリが本当に応答したか。**確認をとばしたときは付かない**（undefined）。
   * `ok` 以外でも `ok:true`（公開の手続き自体は通っている）のまま返す——画面が見出しで目立たせる。
   */
  verify?: DedicatedVerifyOutcome
  /**
   * D-8: `verify` が `no-backend` のときだけ引く「いまのコンテナの様子」
   * （`GET /applications/{id}/containers`）。**引けなかったときは付かない**（undefined）——
   * 0件（＝1つも動いていない）と区別するため。値は原本のまま（画面は containerStateSummary で描く）。
   * **「引けなかった」には、HTTP が 200 でも応答が原本の形でなかった場合を含む**
   * （`readContainerStates` が null。分からないものを0件として出さない）。
   */
  containerStates?: { state: string; status: string }[]
  /** 失敗ではないが利用者に伝えるべきこと（世代掃除・LBアドレス取得の失敗等）。公開自体は成功している。 */
  warnings?: string[]
}

function fail(stage: PublishAppStage, message: string, extra?: Partial<PublishAppResult>): PublishAppResult {
  return { ok: false, stage, message, ...extra }
}

export type PublishAppFlowOpts = {
  confirmed: boolean
  /** 各段の頭と、lb-address 段の待ちの間に呼ばれる進捗（画面向け）。省略可。 */
  progress?: (msg: string) => void
  /**
   * lb-address 段のポーリング間隔（既定 10 秒）。テストで短縮せず、代わりに `sleep` を偽物にする
   * （apprunDedicatedApply.ts の TeardownFlowOpts と同じ流儀・#39）。
   */
  intervalMs?: number
  /** lb-address 段の最長待ち時間（既定 3 分）。 */
  timeoutMs?: number
  /**
   * lb-address 段・verify 段がポーリングの合間に待つのに使う関数（既定は実際の setTimeout）。
   * **テストではここへ即時に解決する偽物を渡し、実際には待たずにループを回す。**
   */
  sleep?: (ms: number) => Promise<void>
  /**
   * D-7: verify 段が「公開先から1本取ってくる」処理（既定は下の `probeMarkerOverHttps`）。
   * 取りに行く先は `path` 引数のとおり——目印（`/.koto-build`）のことも、根（`/`）のこともある
   * （D-19。名前は D-7 から据え置き。**この段の唯一の出口**という意味で読むこと）。
   * **テストではここへ偽物を渡す**——実ネットワークにも自己署名証明書にも依存せずに、
   * 200／503／接続不能それぞれの判定を確かめられる。
   */
  probeMarker?: (args: { ip: string; host: string; path: string; timeoutMs: number }) => Promise<DedicatedProbe>
}

// lb-address 段の待ち（D-5・2026-09-16 実測）: クラスタ作成の約2分後の⑧では LB ノードのアドレスが
// まだ空で「見つかりませんでした」になり、数分後の probe では付いていた。**ノードのアドレスが付くまでに
// 時間がかかる**ので、空なら 10 秒おきに最長 3 分まで取り直す。それでも空なら従来の warning。
const LB_ADDRESS_DEFAULT_INTERVAL_MS = 10 * 1000
const LB_ADDRESS_DEFAULT_TIMEOUT_MS = 3 * 60 * 1000 // 3分

// verify 段（D-7・2026-09-16 実機）の問い合わせ1本あたりの上限。
const VERIFY_TIMEOUT_MS = 10 * 1000
// 応答本文は目印（版の名前1行）しか要らない。壊れた・巨大な応答で記憶を食わないよう頭だけ読む。
const VERIFY_BODY_LIMIT = 4096

/**
 * ロードバランサの IP へ、**ホスト名を名乗って** `https://<ip><path>` を GET する（D-7）。
 * `path` は目印（`/.koto-build`）か、根（`/`）——どちらかは呼び出し側が決める（D-19）。
 *
 * ── なぜ `node:https` なのか（2026-09-16 実測）────────────────────────────
 * 専有型のロードバランサ（Traefik）は**ホスト名でアプリを振り分ける**。80 番には何も
 * 載っていないので `http://<IP>/` は 404 で、443 に**ホスト名を名乗って**当てると通る。
 * Node の `fetch` では `Host` ヘッダも SNI（servername）も指定できないため、ここだけ
 * `node:https` の `request` を使う（掟10の例外ではなく、`fetch` では書けない要件）。
 *
 * ── なぜ証明書の検証を切る（rejectUnauthorized:false）のか ─────────────────
 * ①DNS がまだ向いていない間、クラスタが出しているのは `CN=TRAEFIK DEFAULT CERT` の
 *   **仮証明書**だけである（Let's Encrypt は DNS が向いてから HTTP-01 で発行される）。
 *   検証を入れると、公開直後は必ず失敗し、**確認そのものが成立しない**。
 * ②宛先の IP は、Koto 自身がさくらの API から取った値（`lbAddresses`）であって、
 *   外から与えられた宛先ではない。
 * ③送るのは**秘密を含まない GET 1本**だけである。
 * **秘密（トークン・Cookie・本文）は絶対に送らない。** ヘッダは `Host` だけ、本文は無し。
 */
export function probeMarkerOverHttps(
  args: { ip: string; host: string; path: string; timeoutMs: number },
): Promise<DedicatedProbe> {
  return new Promise<DedicatedProbe>(resolve => {
    let settled = false
    const done = (r: DedicatedProbe) => { if (!settled) { settled = true; resolve(r) } }
    try {
      const req = https.request({
        hostname: args.ip,           // 宛先はロードバランサの IP（DNS はまだ向いていない）
        port: 443,
        path: args.path,
        method: 'GET',
        servername: args.host,       // SNI はホスト名（これが無いと振り分けに乗らない）
        headers: { Host: args.host }, // ← 送るヘッダはこれだけ。秘密は載せない
        rejectUnauthorized: false,   // 理由は上のコメント（仮証明書しか無い時期に確認したい）
        timeout: args.timeoutMs,
      }, res => {
        let body = ''
        res.setEncoding('utf-8')
        res.on('data', (c: string) => { if (body.length < VERIFY_BODY_LIMIT) body += c })
        res.on('end', () => done({ reached: true, status: res.statusCode ?? 0, body }))
        res.on('error', () => done({ reached: false }))
      })
      req.on('timeout', () => { req.destroy(); done({ reached: false }) })
      req.on('error', () => done({ reached: false }))
      req.end()
    } catch {
      done({ reached: false }) // 接続できないことは「動いていない」の証明にはしない（unreachable）
    }
  })
}

/** 経過時間(ms)を画面向けの「N秒経過」「N分経過」にする（1分未満は秒、1分以上は分に丸める）。 */
function formatLbWaitElapsed(ms: number): string {
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)}秒経過`
  return `${Math.max(1, Math.round(ms / 60000))}分経過`
}

// ── A（2026-09-17）: クラスタの公開ポート（80/http・443/https）が欠けているときの文言 ──────
// ⑤の入力検査（AppRunDedicatedPanel.tsx の errors.ports）と語調を揃えるが、ここに出る時点で
// クラスタは既にある（⑤の詳細設定ではなく、コントロールパネルでの直し方を案内する）。
function formatPortNames(missing: { port: number; protocol: string }[]): string {
  return missing.map(p => `${p.port}（${p.protocol}）`).join('・')
}

function clusterPortsMissingMessage(missing: { port: number; protocol: string }[]): string {
  const names = formatPortNames(missing)
  return `このクラスタには「${names}」が設定されていません。独自ドメインの証明書（https）を自動で受け取るために必要です。さくらのコントロールパネルで、クラスタの待ち受けポートに${names}を足してから、もう一度お試しください。`
}

// PATCH（Let's Encrypt のメール設定）のあとに欠けていたときは、直前の操作のせいかもしれないと
// 利用者が気づける文言にする（PATCH のコメント自身が「ports を省けば無変更のはず・未確認」と
// 書いている。さくら側が置き換えていれば、80/443 が失われうる）。
function clusterPortsMissingAfterPatchMessage(missing: { port: number; protocol: string }[]): string {
  const names = formatPortNames(missing)
  return `Let's Encrypt のメールを設定したあと、クラスタの待ち受けポート（${names}）が見当たりません。さくらのコントロールパネルで確認し、足してから、もう一度お試しください。`
}

const CLUSTER_PORTS_UNKNOWN_WARNING =
  'クラスタの待ち受けポートを確認できませんでした。80（http）・443（https）が設定されているか、念のためさくらのコントロールパネルでご確認ください。'
const CLUSTER_PORTS_UNKNOWN_AFTER_PATCH_WARNING =
  "Let's Encrypt のメールを設定したあと、クラスタの待ち受けポートを確認できませんでした。80（http）・443（https）が設定されているか、念のためさくらのコントロールパネルでご確認ください。"

/**
 * 記録済みのクラスタの上に、アプリケーション（独自ドメイン）を1つ公開する。
 * 13段（consent→verify→containers→done）。各段の頭で `opts.progress` を1回呼ぶ（画面向け）。
 * containers 段（D-8）は verify が `no-backend` のときだけ通る。
 */
export async function publishAppFlow(
  auth: CloudCredentials, projectDir: string, input: PublishAppInput,
  opts: PublishAppFlowOpts, baseUrl?: string,
): Promise<PublishAppResult> {
  const progress = (msg: string) => opts.progress?.(msg)
  // 失敗ではないが利用者に伝えるべきこと（5段目のポート未確認・世代掃除・LBアドレス取得の失敗等）。
  // 5段目から使うため、ここで宣言する（以前は cleanup 段の直前で宣言していた）。
  const warnings: string[] = []

  // 1. consent: 確認ダイアログを通ったか。**ここより先で fetch を一切呼ばない。**
  if (opts.confirmed !== true) {
    return fail('consent', '確認ダイアログを通っていません')
  }

  // 2. no-cluster: 記録にクラスタ・ASG・LBが揃っていなければ、そもそも公開できる土台が無い。
  progress('クラスタの記録を確認しています…')
  const record = readApprunDedicatedFs(projectDir)
  const clusterID = record.clusterID ?? null
  const asgID = record.asgID ?? null
  const loadBalancerID = record.loadBalancerID ?? null
  if (!clusterID || !asgID || !loadBalancerID) {
    return fail('no-cluster', '⑤でクラスタを作ってから、アプリを公開してください。')
  }

  // 3. invalid: ⑤の入力を検証する（validateAppSpec が「最後の砦」）。
  progress('入力を確認しています…')
  const validation = validateAppSpec(input.spec)
  if (!validation.ok) {
    return fail('invalid', validation.message)
  }
  const spec = input.spec

  // 4. record: 記録ファイルへ書き込めるかを、最初のPOSTより前に確かめる（createClusterFlow の
  //   1.8 と同じ方針。記録なしで課金資源を増やさない）。
  //   B（2026-09-17）: **値は進めない**（空パッチ＝既存値の書き戻しで、書き込めるかだけ確かめる）。
  //   以前はここで hosts/appPort 等を新しい値へ書き換えていたため、後段（version-create 等）が
  //   途中で失敗しても「まだ公開されていない新しいホスト名」が記録に残り、画面が誤って
  //   「公開中: https://（新しい・未公開のホスト名）/」と出す事故があった。これらの値は
  //   実際に効く（＝反映される）のが「バージョンの有効化」なので、9段目（activate）が
  //   確認できたあとにまとめて書く。
  progress('記録に書き込んでいます…')
  if (!writeApprunDedicatedRecordFs(projectDir, {})) {
    return fail('record', '記録ファイル（.sakuraide.json）に書き込めないため公開を始めません。フォルダの権限を確認してください。')
  }

  // 5. lets-encrypt: 独自ドメインの https は useLetsEncrypt:true 固定（apprunDedicatedApp.ts）
  //   なので、クラスタに Let's Encrypt のメールが無ければ、ここで案内するか設定する。
  progress("Let's Encrypt の設定を確認しています…")
  const clusterRes = await getCluster(auth, clusterID, baseUrl)
  if (!clusterRes.ok) {
    return fail('lets-encrypt', `クラスタの情報を取得できませんでした: ${clusterRes.message}`)
  }
  // A（2026-09-17）: 実際に載せるクラスタの公開ポート（80/http・443/https）を、ここで初めて
  // 確かめる。**新しい API 呼び出しは要らない**——直前の getCluster の応答をそのまま読む。
  // 判定は既存の純関数 missingRequiredPorts（apprunDedicatedApp.ts）を使い回す（掟10）。
  // 読めた（配列だった）ときだけ判定する。読めなかった（null）ときは「分からない」を
  // 「大丈夫」にも「ダメ」にも倒さず、warnings に1行残して先へ進む——応答の形が変わっただけで
  // 公開そのものを塞がないため。
  const clusterPorts = readClusterPorts(clusterRes.data)
  if (clusterPorts !== null) {
    const missingPorts = missingRequiredPorts(clusterPorts)
    if (missingPorts.length > 0) {
      return fail('cluster-ports', clusterPortsMissingMessage(missingPorts))
    }
  } else {
    warnings.push(CLUSTER_PORTS_UNKNOWN_WARNING)
  }
  // null（分からない）も false と同じ扱いにする（掟10「分からないものを都合よく倒さない」）。
  if (readHasLetsEncryptEmail(clusterRes.data) !== true) {
    if (!input.letsEncryptEmail) {
      // ⑧が出る状態（クラスタあり）では⑤の入力欄は畳まれて無いので、案内先は⑧のメール欄
      //（README・usage-guide・⑤の説明文と同じ）。
      return fail('lets-encrypt', "⑧の Let's Encrypt のメール欄に入力してから、アプリを公開してください。")
    }
    const patchRes = await patchClusterLoadBalancer(auth, clusterID, buildLetsEncryptPatchBody(input.letsEncryptEmail), baseUrl)
    if (!patchRes.ok) {
      return fail('lets-encrypt', `Let's Encrypt のメールアドレスの設定に失敗しました: ${patchRes.message}`)
    }
    const verifyRes = await getCluster(auth, clusterID, baseUrl)
    if (!verifyRes.ok) {
      return fail('lets-encrypt', `Let's Encrypt のメールアドレスの設定を確認できませんでした: ${verifyRes.message}`)
    }
    if (readHasLetsEncryptEmail(verifyRes.data) !== true) {
      return fail('lets-encrypt', "Let's Encrypt のメールアドレスの設定を確認できませんでした（応答に反映されていません）。")
    }
    // A（2026-09-17）: PATCH は ports を送らないため無変更のはずだが、そのコードのコメント自身が
    // 「未確認」と書いている（buildLetsEncryptPatchBody）。さくら側が置き換えてしまえば 80/443 が
    // 失われうるので、再取得の応答でも改めて読む。**欠けていても自動で書き戻さない**——未確認の
    // 前提の上に修復動作を重ねない。検知して人に返すまでで十分。
    const patchedPorts = readClusterPorts(verifyRes.data)
    if (patchedPorts !== null) {
      const missingAfterPatch = missingRequiredPorts(patchedPorts)
      if (missingAfterPatch.length > 0) {
        return fail('cluster-ports', clusterPortsMissingAfterPatchMessage(missingAfterPatch))
      }
    } else {
      warnings.push(CLUSTER_PORTS_UNKNOWN_AFTER_PATCH_WARNING)
    }
  }

  // 6. app-lookup: 記録にIDがあれば実在確認（404なら記録から外して新規へ）。無ければ、
  //   同名アプリが無いかを一覧で確かめる——**同名がある＝別プロジェクトのアプリかもしれない
  //   ので再利用しない**（name-taken）。
  progress('アプリケーションを確認しています…')
  let applicationID: string | null = record.applicationID ?? null
  if (applicationID) {
    const appRes = await getApplication(auth, applicationID, baseUrl)
    if (appRes.ok) {
      // 実在確認できた。このIDをそのまま再利用する（新規作成はしない）。
    } else if (appRes.status === 404) {
      if (!writeApprunDedicatedRecordFs(projectDir, { applicationID: null })) {
        return fail('record', '記録ファイルへの書き込みに失敗しました。')
      }
      applicationID = null
    } else {
      return fail('app-lookup', `アプリケーションの状態を確認できませんでした: ${appRes.message}`)
    }
  }
  if (!applicationID) {
    const listRes = await listApplications(auth, clusterID, undefined, baseUrl)
    if (!listRes.ok) {
      return fail('app-lookup', `既存のアプリケーションを確認できませんでした: ${listRes.message}`)
    }
    const duplicate = readApplicationRows(listRes.data).find(r => r.name === spec.name)
    if (duplicate) {
      return fail('name-taken', `アプリ名『${spec.name}』は既にあります。別の名前にしてください。`)
    }
  }

  // 7. app-create: 新規のときだけ作成する（既存を再利用するときはスキップ）。
  //   **取れた時点で記録する**（getApplication の確認を待たない。createClusterFlow と同じ方針）。
  if (!applicationID) {
    progress('アプリケーションを作成しています…')
    const createRes = await createApplication(auth, buildApplicationCreateBody({ name: spec.name, clusterID }), baseUrl)
    if (!createRes.ok) {
      return fail('app-create', `アプリケーションの作成に失敗しました: ${createRes.message}`)
    }
    const newID = readApplicationId(createRes.data)
    if (!newID) {
      return fail('app-create', 'アプリケーションを作成しましたが、応答からIDを取り出せませんでした（手動で確認してください）。')
    }
    // B（2026-09-17）: applicationName は「作成に使った名前」＝applicationID を書く段と同じ扱い
    // （以前は4段目で先に書いていたが、それだと新規作成に失敗しても新しい名前だけが残っていた）。
    if (!writeApprunDedicatedRecordFs(projectDir, { applicationID: newID, applicationName: spec.name })) {
      return fail('app-create', `アプリケーションは作成されました（ID『${newID}』）が、記録に書き込めませんでした。このIDを控えて、コントロールパネルで確認してください。`, { applicationID: newID })
    }
    applicationID = newID
  }
  const appID = applicationID // ここから先は非nullが確定している。

  // 8. version-create: 毎回 registryPasswordAction:'new'（Kotoのpush用資格情報は変わりうる・
  //   'keep' の意味は原本に無いため）。
  progress('バージョンを作成しています…')
  const versionRes = await createApplicationVersion(
    auth, appID,
    buildVersionCreateBody(spec, input.imageRef, { username: input.registry.username, password: input.registry.password, action: 'new' }),
    baseUrl,
  )
  if (!versionRes.ok) {
    return fail('version-create', `バージョンの作成に失敗しました: ${versionRes.message}`, { applicationID: appID })
  }
  const version = readVersionNumber(versionRes.data)
  if (version === null) {
    return fail('version-create', 'バージョンを作成しましたが、応答から番号を取り出せませんでした（手動で確認してください）。', { applicationID: appID })
  }
  if (!writeApprunDedicatedRecordFs(projectDir, { imageRef: input.imageRef })) {
    return fail('version-create', `バージョン『${version}』は作成されましたが、記録に書き込めませんでした。`, { applicationID: appID, version })
  }

  // 9. activate: 新しいバージョンが既に有効（バージョン作成で自動的に有効になるかは未確認・
  //   報告に明記）でなければ切り替える。**切り替えたら、もう一度 getApplication で一致を
  //   確かめてから記録する**（一致しなければ記録は残したまま止める）。
  progress('新しいバージョンを有効化しています…')
  const app1Res = await getApplication(auth, appID, baseUrl)
  if (!app1Res.ok) {
    return fail('activate', `アプリケーションの状態を確認できませんでした: ${app1Res.message}`, { applicationID: appID, version })
  }
  const app1 = readApplication(app1Res.data)
  if (!app1) {
    return fail('activate', 'アプリケーションの応答を読み取れませんでした。', { applicationID: appID, version })
  }
  if (app1.activeVersion !== version) {
    const putRes = await updateApplication(auth, appID, buildActiveVersionBody(version), baseUrl)
    if (!putRes.ok) {
      return fail('activate', `バージョンの有効化に失敗しました: ${putRes.message}`, { applicationID: appID, version })
    }
    const app2Res = await getApplication(auth, appID, baseUrl)
    if (!app2Res.ok) {
      return fail('activate', `有効化を確認できませんでした: ${app2Res.message}`, { applicationID: appID, version })
    }
    const app2 = readApplication(app2Res.data)
    if (!app2 || app2.activeVersion !== version) {
      return fail('activate', `有効化を確認できませんでした（バージョン『${version}』が一致しません）。`, { applicationID: appID, version })
    }
  }
  // B（2026-09-17）: hosts/appPort/appCpu/appMemory/appFixedScale は「実際に効くのは版」なので、
  // activeVersion/appPublishedAt と同じタイミング（＝有効化の一致が確認できたあと）で記録する。
  // 途中の段（version-create 失敗等）で止まったときに、まだ公開されていない新しい値だけが
  // 記録に残る事故（B）を防ぐ——4段目（record）からはここへ移した。
  if (!writeApprunDedicatedRecordFs(projectDir, {
    activeVersion: version,
    appPublishedAt: new Date().toISOString(),
    hosts: [spec.host],
    appPort: spec.port,
    appCpu: spec.cpu,
    appMemory: spec.memory,
    appFixedScale: spec.fixedScale,
  })) {
    return fail('activate', `バージョン『${version}』は有効化されましたが、記録に書き込めませんでした。`, { applicationID: appID, version })
  }

  // 10. cleanup: 古いバージョンを掃除する。**失敗しても続行**（公開そのものは成功している）。
  progress('古いバージョンを片付けています…')
  const versionsRes = await listApplicationVersions(auth, appID, undefined, baseUrl)
  if (!versionsRes.ok) {
    warnings.push(`古いバージョンの一覧を取得できませんでした（掃除をスキップしました）: ${versionsRes.message}`)
  } else {
    const rows = readVersionRows(versionsRes.data)
    const toDelete = versionsToDelete(rows, version, DEFAULT_KEEP)
    for (const v of toDelete) {
      const delRes = await deleteApplicationVersion(auth, appID, v, baseUrl)
      if (!delRes.ok) warnings.push(`バージョン『${v}』の削除に失敗しました: ${delRes.message}`)
    }
  }

  // 11. lb-address: DNSのAレコードに案内するIPを集める。**取れなくても続行**（公開は成功している）。
  //   アドレスは素の IP（bareIp。`59.106.222.212/24` → `59.106.222.212`）。応答が ok で空なら
  //   **10 秒おき・最長 3 分**まで取り直す（D-5・2026-09-16 実測「付くまで数分かかる」）。
  //   取得自体の失敗（HTTP エラー）は待たずに従来どおり warning にする。
  //   経過時間は実時間ではなく「回した回数 × intervalMs」で数える（waitUntilGone と同じ。テストで
  //   sleep を偽物にすれば 1 ミリ秒も待たずにループの動きを確かめられる）。
  //
  // ── B（D-19・2026-09-16）: **確かめられなかった IP を、現在のものとして残さない** ──────
  // 直す前は「取れたときだけ記録に書く」だったので、**取れなかったときに前の値がそのまま残った**。
  // 記録の `lbAddresses` は「いまのクラスタのロードバランサの IP」であり、画面（⑧）はそれを
  // 「DNS の A レコード」として出す。前のクラスタの IP が残っていれば、利用者は**間違った先へ
  // DNS を向ける**——公開できたつもりで、他人の IP かもしれない先を指すことになる。
  // そこで、この段で**確認できなかったとき（HTTP 失敗・時間切れ）は記録を null にする**。
  // 画面は既にその形を持っている（「IP がまだ取れていません」＋「🔄 IP を取り直す」）。
  // 「分からない」を「前の値」で埋めない（掟1・掟10の `unknown-read-as-ok` と同じ形）。
  progress('ロードバランサのアドレスを取得しています…')
  const intervalMs = opts.intervalMs ?? LB_ADDRESS_DEFAULT_INTERVAL_MS
  const timeoutMs = opts.timeoutMs ?? LB_ADDRESS_DEFAULT_TIMEOUT_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let lbAddresses: string[] = []
  let lbElapsedMs = 0
  // B（D-19）: 確認できなかったときに記録から古い値を消す（前のクラスタの IP を現在のものとして
  // 見せない）。**消せなかったこと自体も黙らせない**——記録に嘘が残ったまま画面に出るため。
  const clearRecordedLbAddresses = () => {
    if (!writeApprunDedicatedRecordFs(projectDir, { lbAddresses: null })) {
      warnings.push('ロードバランサの IP を確認できませんでしたが、記録から古い IP を消せませんでした。⑧に出ている IP は古い可能性があります（「🔄 IP を取り直す」で確かめてください）。')
    }
  }
  for (;;) {
    const lbNodesRes = await listLoadBalancerNodes(auth, clusterID, asgID, loadBalancerID, undefined, baseUrl)
    if (!lbNodesRes.ok) {
      warnings.push(`ロードバランサノードのアドレスを取得できませんでした: ${lbNodesRes.message}`)
      clearRecordedLbAddresses()
      break
    }
    lbAddresses = collectBareLbAddresses(lbNodesRes.data)
    if (lbAddresses.length > 0) {
      if (!writeApprunDedicatedRecordFs(projectDir, { lbAddresses })) {
        warnings.push('ロードバランサノードのアドレスを記録できませんでした。')
      }
      break
    }
    if (lbElapsedMs >= timeoutMs) {
      warnings.push('ロードバランサノードのアドレスが見つかりませんでした。IP が付くまで数分かかることがあります。⑧の「🔄 IP を取り直す」で取り直せます。')
      clearRecordedLbAddresses()
      break
    }
    await sleep(intervalMs)
    lbElapsedMs += intervalMs
    progress(`ロードバランサの IP が付くのを待っています（${formatLbWaitElapsed(lbElapsedMs)}）…`)
  }

  // 12. verify: **「公開しました」と言う前に、アプリが本当に応答しているかを確かめる**（D-7）。
  //
  // 2026-09-16 実機（0.6.19-rc.1）: ここまで全段が通っても、ロードバランサが
  // 503 `no available server` を返し続けていた（＝LB から見て健全なバックエンドが1つも
  // 登録されていない。**コンテナ自体が起動していたかは、いまも未確認**——同じ日のコンパネは
  // 「稼働コンテナ 1・アクティブ」と表示していた＝docs/apprun-dedicated-plan.md 5-13）。
  // **同じ日の別の時刻（10:34〜10:57）のランタイムログ（D-8）で説明はつく**: コンテナは
  // `/app/data` を作れず（`EACCES`）1分ごとに再起動を繰り返していた（像のフォルダが読み取り
  // 専用だったのが原因）。**ただし 503 の観測は 08:35 前後で、時刻の突き合わせはしていないので
  // 断定はしない**（計画書 5-13・roadmap・publishVerify.ts と同じ基準・掟1・検分の指摘 2026-09-16）。
  // それでも Koto は「✅ 公開しました」と出し、利用者は応答しないアプリのために DNS を設定しに行った。
  //
  // ── A（D-19・2026-09-16）: **Node アプリでも確かめる** ─────────────────────────
  // 直す前は `canVerify`（＝静的配信だけ）で門を作っていたため、**Node アプリでは確認そのものを
  // とばしていた**。ところが今日の事故のアプリは Node（`public/server.js`）だった——
  // **守りたかった場面をまるごととばしていた**。確かめ方を2つに分ける（dedicatedVerifyMode）:
  //   ・静的配信＋版が分かる → 目印（`.koto-build`）を取りに行き、**中身が新しいか**まで見る
  //   ・それ以外（Node 等）  → **根（`/`）へ当てて、応答があるか**だけを見る。503 は `no-backend`
  //     （今日の失敗そのもの）、400 以上のそれ以外（404・502・504 …）は `error-status`、
  //     2xx・3xx が `responding`。**`ok` とは呼ばない**
  // D-19b（同日の検分）: 直した直後は「503 以外はすべて `responding`」だったため、**LB がホスト名を
  // 振り分けられずに 404 を返している**ときでも「✅ アプリが応答することを確認しました」を出し、
  // しかも1回目でループを打ち切っていた。いまは失敗応答では止めず、取り直す（dedicatedVerifySettled）。
  // **とばしてよいのは、当てに行く先が無いときだけ**（IP が無い・ホスト名が無い＝下の else）。
  // とばしたときは warnings に1行残す（README・使い方ガイドの約束・D-14 A の検分）。
  const url = `https://${spec.host}/`
  let verify: DedicatedVerifyOutcome | undefined
  const markerTag = String(input.buildTag ?? '').trim()
  if (lbAddresses.length > 0 && spec.host) {
    const mode = dedicatedVerifyMode(input.runtimeKind, markerTag)
    progress('🩺 アプリが応答するか確かめています…')
    // F（D-7b・検分の指摘）: この段全体を try/catch で囲む。probe が例外を投げると、
    // 元は publishAppFlow ごと throw し、呼び出し側（IPC）の catch で { ok:false, stage:'invalid' }
    // に化けていた——**公開の手続き自体はここまで全部通っているのに「失敗しました」と表示される**。
    // 確かめられなかっただけなので unreachable 扱いにし、warnings に1行残す（黙って握りつぶさない）。
    try {
      const probe = opts.probeMarker ?? probeMarkerOverHttps
      const delays = verifyDelaysMs()
      // 届いたことがある結果（stale / no-backend）は覚えておく。あとの1回がたまたま
      // つながらなくても、**「届いていた」事実を「確かめられなかった」に薄めない**。
      let reachedOutcome: DedicatedVerifyOutcome | null = null
      for (let i = 0; i <= delays.length; i++) {
        // キャッシュに騙されないよう、毎回違う問い合わせにする（共用型の verifyPublished と同じ）
        const one = await probe({
          ip: lbAddresses[0], host: spec.host,
          path: dedicatedProbePath(mode, Date.now()), timeoutMs: VERIFY_TIMEOUT_MS,
        })
        const outcome = judgeDedicatedProbeBy(mode, one, markerTag)
        // 確かめたいことが確かめられたら、そこで止める（marker なら ok・root なら responding）。
        if (dedicatedVerifySettled(outcome)) { reachedOutcome = outcome; break }
        if (outcome !== 'unreachable') reachedOutcome = outcome
        if (i < delays.length) {
          progress('🩺 アプリが応答するか確かめています…')
          await sleep(delays[i])
        }
      }
      verify = reachedOutcome ?? 'unreachable'
    } catch (e: any) {
      verify = 'unreachable'
      warnings.push(`応答の確認中にエラーが発生したため、確認できませんでした（公開自体は完了しています）: ${e?.message ?? String(e)}`)
    }
  } else {
    // ── D-14 A（2026-09-16 の検分）: **黙ってとばさない** ────────────────────────
    // ここは「当てに行く先が無い」入口。IP が取れなかった／ホスト名が無いときは
    // `verify` が付かないまま先へ進み、画面は「✅ 公開しました」を出していた。
    // **確かめずに成功を名乗る**（D-7 で最初に直した欠陥）が、別の道から戻ってきた形である。
    // **どちらの理由でとばしたのか**を1行残す。
    // D-19 以降、**とばす道はここしか無い**（像の種類ではとばさない）。
    warnings.push(lbAddresses.length === 0
      ? 'ロードバランサの IP が取れなかったため、応答の確認をとばしました（当てに行く先が分からないためです）。⑧の「🔄 IP を取り直す」で IP を取り直し、公開先を開いて表示されるかご自身で確かめてください。'
      : 'ホスト名が分からないため、応答の確認をとばしました。公開先を開いて、表示されるかご自身で確かめてください。')
  }

  // 12.5 containers: **応答していないと分かったときだけ**、いまのコンテナの様子を1回引く（D-8）。
  //
  // 2026-09-16 実機: verify が `no-backend`（503）になったとき、Koto は「アプリがまだ応答して
  // いません。ランタイムログを見てください」としか言えなかった。実際にはコンテナが
  // `/app/data` を作れずに1分ごとに再起動を繰り返していた（5-13）。
  // **`ok` のときは引かない**——動いていると分かっているものに、余計な GET を足さない。
  // 引けなくても `ok:true` のまま続ける（warnings に1行だけ残す。確認の道具であって公開の条件ではない）。
  // D-19b（検分）: `error-status`（404・502・504 …）ではここを引かない。**503 と違って
  // 「後ろに健全なコンテナがいない」とは分かっていない**（LB がホスト名を振り分けられていない
  // だけのことも、アプリ自身が 404 を返しているだけのこともある）。コンテナの様子を並べると
  // 「動いています」が答えになり、**原因をコンテナ側だと思わせる**——確かめていない筋へ
  // 誘導しないため、ここは 503 のときだけにしておく（掟1）。
  let containerStates: { state: string; status: string }[] | undefined
  if (verify === 'no-backend') {
    progress('コンテナの様子を確認しています…')
    try {
      const containersRes = await listApplicationContainers(auth, appID, baseUrl)
      if (containersRes.ok) {
        // **200 でも「読めた」とは限らない。** 応答が原本の形でなければ readContainerStates は
        // null を返す。そこを空配列（＝0件）に倒すと、画面が「1つも動いていない」と**断定**する
        // ことになる（D-7 の `unknown-read-as-ok` と同じ形）。読めなかったときは
        // 「取得できなかった」側へ倒し、containerStates を付けない。
        const states = readContainerStates(containersRes.data)
        if (states) {
          containerStates = states
        } else {
          warnings.push('コンテナの様子を取得できませんでした: 応答の形が原本と違うため読み取れませんでした。')
        }
      } else {
        warnings.push(`コンテナの様子を取得できませんでした: ${containersRes.message}`)
      }
    } catch (e: any) {
      warnings.push(`コンテナの様子を取得できませんでした: ${e?.message ?? String(e)}`)
    }
  }

  // 13. done
  progress('完了しました')
  const message = lbAddresses.length > 0
    ? `公開しました。DNS の A レコードを次の IP に向けてください: ${lbAddresses.join(', ')}`
    : '公開しました。ロードバランサのアドレスを取得できなかったため、⑧の「🔄 IP を取り直す」で取り直すか、コントロールパネルで確認してから DNS の A レコードを向けてください。'

  return {
    // D-7: verify が `ok` でなくても `ok:true` のまま返す（公開の手続き自体は通っているため）。
    // **ただし画面は publishHeadline で必ず目立たせる**（shared/publishLabels.ts）。
    ok: true, stage: 'done', message, applicationID: appID, version, url,
    ...(lbAddresses.length > 0 ? { lbAddresses } : {}),
    ...(verify ? { verify } : {}),
    // D-8: 引けたときだけ載せる（0件＝1つも動いていない、と「引けなかった」を区別する）
    ...(containerStates ? { containerStates } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

// ── ⑧「🔄 IP を取り直す」（D-5）────────────────────────────────────────────────
//
// 公開の lb-address 段で IP が空のまま終わったとき（付くまで数分かかる・5-13）に、画面から
// LB ノードの一覧だけを引き直して、素の IP を記録（`lbAddresses`）へ書く。GET が 1 回と記録の
// 書き込みだけ——**何も作らない・待たない**（待つのは publishAppFlow の lb-address 段の役目。
// ここは押した瞬間の状態を返す）。IPC `apprunDedicated:lbAddresses` がこれを呼ぶ。

export type RefreshLbAddressesResult = { ok: true; lbAddresses: string[] } | { ok: false; message: string }

/**
 * 記録の clusterID/asgID/loadBalancerID で `listLoadBalancerNodes` を 1 回引き、素の IP の配列を
 * 記録して返す。空なら記録は触らず ok:false（前に取れていた IP を空で上書きしない）。
 */
export async function refreshLbAddresses(
  auth: CloudCredentials, projectDir: string, baseUrl?: string,
): Promise<RefreshLbAddressesResult> {
  const record = readApprunDedicatedFs(projectDir)
  const clusterID = record.clusterID ?? null
  const asgID = record.asgID ?? null
  const loadBalancerID = record.loadBalancerID ?? null
  if (!clusterID || !asgID || !loadBalancerID) {
    return { ok: false, message: '⑤でクラスタを作ってから、IP を取り直してください。' }
  }
  const lbNodesRes = await listLoadBalancerNodes(auth, clusterID, asgID, loadBalancerID, undefined, baseUrl)
  if (!lbNodesRes.ok) {
    return { ok: false, message: `ロードバランサノードのアドレスを取得できませんでした: ${lbNodesRes.message}` }
  }
  const lbAddresses = collectBareLbAddresses(lbNodesRes.data)
  if (lbAddresses.length === 0) {
    return { ok: false, message: 'ロードバランサの IP がまだ付いていません。数分待ってから、もう一度「🔄 IP を取り直す」を押してください。' }
  }
  if (!writeApprunDedicatedRecordFs(projectDir, { lbAddresses })) {
    return { ok: false, message: `IP は取れました（${lbAddresses.join(', ')}）が、記録ファイル（.sakuraide.json）に書き込めませんでした。フォルダの権限を確認してください。` }
  }
  return { ok: true, lbAddresses }
}
