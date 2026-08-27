// adopt.ts — よそで公開されている AppRun アプリを、このプロジェクトが**引き継ぐ**ための
// 設定を組み立てる（純ロジック・IO 無し）。dev-plan ④ 第4段階。
//
// ── 何を解いているのか ────────────────────────────────────────────────
// インポートしただけのプロジェクトから公開すると、**別の新しいアプリ**が作られる。
// 公開のアドレス（URL）が変わり、イメージの置き場が1つ増えて月額が上乗せされる。
// 原因はただ1つ、`.sakura-cloud/state.json` に**アプリのIDが無い**こと
// （`apply.ts` の update は `findRef` で id を引き、無ければ飛ばす）。
//
// インポートの時点で id は手元にある。**書けば引き継げる。**
//
// ── ⚠️ 引き継ぎで初めて分かったこと（2026-08-25）──────────────────────
// 再デプロイ（PATCH）は `components` を**丸ごと差し替える**。つまり
// **spec に書いていない項目は Koto の既定値で上書きされる**。Koto が作った
// アプリなら既定値は元の値と同じなので何も起きないが、**よそで作られたアプリでは
// 別の値**でありうる。そのまま送ると、動いているアプリの入れ物の名前が変わり、
// メモリが半分になり、健康診断の場所が `/` に戻る。**URL は保てても中身が壊れる。**
//
// だから引き継ぎでは、実物から読んだ設定を spec 側へ**書き写してから**渡す。
//
// ── 書かないもの ──────────────────────────────────────────────────────
// - **`meta.registryName`** … ここに古いレジストリ名を書くと、破棄が
//   **利用者の元のレジストリを消す**（2026-08-06 の「別プロジェクトのレジストリを
//   消した」事故と同じ形）。Koto が新しく作ったものだけを、作ったときに記録する。
// - **レジストリの ref** … Koto が新しく作る。古いレジストリのパスワードは要らない
//   （`buildPatchBody` が `components` を丸ごと差し替えるので、新しいレジストリを
//   指す形で更新できる）。

import type { AdoptionPreview, AppRunSettings } from '../../shared/publishImport'
import type { EnvSpec } from './spec'
import { normalizeSpecName, validateSpec } from './spec'
import { registrySubdomainLabel, type EnvState } from './state'

/** 引き継ぎで組み立てるものの入力。 */
export type AdoptInput = {
  /** 公開先での名前（AppRun のアプリ名）。 */
  appName: string
  /** AppRun のアプリID。**これが state に入って初めて引き継げる。** */
  appId: string
  /** 実物から読んだ公開設定。 */
  settings: AppRunSettings
  /**
   * いま使っているイメージの置き場（`sample-app.sakuracr.jp` の形）。
   *
   * **これを記録するのが引き継ぎの半分。** 書いておかないと、次の公開は
   * 「アプリ全体に1つだけある接続情報」——**最後にレジストリを用意した別プロジェクトのもの**
   * ——を使い、**関係のない置き場へイメージが入る**（`cloud.ts` の `resolvePushRegistry`）。
   * もとの置き場は誰にも使われないまま月220円がかかり続ける。
   */
  imageServer?: string | null
  /** 地域（既定 is1a）。 */
  region?: string
}

/**
 * 引き継げないときの理由（純関数）。**分からないものを既定値で埋めない**（掟1）。
 *
 * ポートは健康診断の宛先でもある。読めないまま既定の 8080 を入れて再デプロイすると、
 * **動いているアプリが健康診断に落ちる**。分からないなら引き継がない。
 */
export function adoptionBlocker(settings: AppRunSettings): string | null {
  if (typeof settings?.port !== 'number' || !(settings.port > 0)) {
    return '公開されていたときのポートが読み取れませんでした。このアプリは引き継げません（別のアプリとして公開することはできます）。'
  }
  return null
}

/**
 * 引き継ぐ前に伝えること（純関数）。**「できる」とだけ言わない。**
 *
 * 引き継ぐと、次の公開は**いま動いているアプリそのもの**を書き換える。
 * URL も月額も変わらない代わりに、**間違えたときに壊れるのは本物**になる。
 */
export function adoptionWarnings(settings: AppRunSettings): string[] {
  const notes: string[] = []
  const keys = settings?.secretKeys ?? []
  if (keys.length) {
    // ⚠️ Koto は秘密の値を送る口を持たない（`buildComponents` は env だけを載せる）。
    // PATCH は components を丸ごと差し替えるので、**いま設定されている秘密は残らない**。
    notes.push(`⚠️ このアプリには秘密の値が ${keys.length} 件（${keys.join(', ')}）設定されていますが、`
      + '**Koto からは秘密を送れません**。引き継いで公開すると、その設定は失われます。'
      + '秘密でなくてよい値なら `.sakura-cloud/env.json` の env に書けます。'
      + '本当に秘密のままにしたい値があるなら、引き継がずに「別物として公開する」を選んでください。')
  }
  // ⚠️ **「破棄すると本物のアプリが消える」はここに書かない**（2026-08-25 Ryosuke 指摘）。
  // 引き継いだかどうかに関係なく、Koto の破棄はそのプロジェクトが公開したものを消す。
  // **普通の意味**であり、すぐ上の「公開すると、いま動いているアプリが置き換わります」から
  // そのまま出てくる話でもある。しかも押すのは何ヶ月も先で、そのときに読むのは
  // 破棄の確認ダイアログのほう（消えるものを名指ししてある）。
  // **新しい情報の無い一行は、隣の本当に読ませたい行を薄めるだけ**（8/24 の戒め）。
  return notes
}

/**
 * 引き継いだプロジェクトの `.sakura-cloud/env.json`（純関数）。
 *
 * **実物から読んだ値を書き写す。** 書き漏らした項目は、次の再デプロイで
 * Koto の既定値に上書きされる（このファイル冒頭の理由）。
 */
export function adoptedSpec(input: AdoptInput): EnvSpec {
  const s = input.settings
  const name = normalizeSpecName(input.appName)
  const port = typeof s.port === 'number' && s.port > 0 ? s.port : 8080
  // 規模は API が返さないことがある。**そのときだけ**既定（0〜1）に倒す。
  // 再デプロイ（PATCH）はこれを送らないので、動いているアプリの規模は変わらない。
  const min = typeof s.minScale === 'number' && s.minScale >= 0 ? s.minScale : 0
  const maxRaw = typeof s.maxScale === 'number' && s.maxScale >= 1 ? s.maxScale : 1
  const max = maxRaw < min ? min : maxRaw
  return {
    version: 1,
    name,
    provider: 'sakura-cloud',
    backend: 'apprun',
    region: input.region ?? 'is1a',
    service: {
      source: { type: 'dockerfile', context: '.', image: name, tag: 'latest', builder: 'builtin' },
      port,
      // 公開されていた環境変数は**そのまま引き継ぐ**。落とすと、次の再デプロイで
      // 動いているアプリから消える（components を丸ごと差し替えるため）。
      env: (s.env ?? []).map(e => ({ name: e.key, value: e.value })),
      // 秘密は値が返ってこないので持てない。**空にしておく**（ref を捏造しない）。
      secrets: [],
      scale: { min, max },
      ...(s.componentName ? { componentName: s.componentName } : {}),
      ...(s.maxCpu ? { cpu: s.maxCpu } : {}),
      ...(s.maxMemory ? { memory: s.maxMemory } : {}),
      ...(s.probePath ? { probePath: s.probePath } : {}),
    },
    // インポートしたものに保存場所は付けない（バケットは1つにつき月額が発生する）。
    persistence: { objectStorage: [] },
    // 引き継ぎは継続運用が前提。期限は付けない。
    guardrails: { ttlHours: 0 },
  }
}

/**
 * 引き継いだプロジェクトの `.sakura-cloud/state.json`（純関数）。
 *
 * **これが本体。** `apply.ts` の update はここの id を引いて PATCH する。
 * `key` は `apprun-app:<spec名>` で、`planner.ts` が spec.name から作る要求キーと
 * 一致していなければ引けない（`adoptedSpec` と同じ正規化を通すこと）。
 */
export function adoptedState(input: AdoptInput): EnvState {
  const name = normalizeSpecName(input.appName)
  const registryName = registryLabelFromServer(input.imageServer)
  return {
    name,
    backend: 'apprun',
    resources: [{ kind: 'apprun-app', id: input.appId, stateful: false, key: `apprun-app:${name}` }],
    // ── 置き場の名前は**書く**（2026-08-25 に方針を改めた）───────────────────
    // 当初は「書くと破棄が利用者の置き場を消せるようになる」ので書かない方針にしていた。
    // だが書かないと、次の公開が**別プロジェクトの置き場**へイメージを入れてしまい、
    // 画面で言っている「月額は増えません」も当たらない（もとの置き場が遊んだまま課金される）。
    //
    // **書いたうえで、借り物である印（`registryAdopted`）をつける。** 破棄は
    // その印を見て「置き場も削除する」を既定オフにする。2つの心配は、これ1つで済む。
    ...(registryName ? { meta: { registryName, registryAdopted: true } } : {}),
  }
}


/**
 * イメージ参照のサーバー名から、**さくらのコンテナレジストリ**の名前を取り出す（純関数）。
 *
 * ⚠️ **さくら以外は null を返す。** Docker Hub などから引いているアプリの
 * `docker.io/...` を名前として記録すると、次の公開で「`docker` という置き場」を
 * 探しに行き、見つからずに**その名前で新しい置き場を作ってしまう**。
 */
export function registryLabelFromServer(server: string | null | undefined): string | null {
  const host = String(server ?? '').split('/')[0].trim().toLowerCase()
  if (!host.endsWith(REGISTRY_HOST_SUFFIX)) return null
  const label = host.slice(0, -REGISTRY_HOST_SUFFIX.length)
  return label || null
}

/** さくらのコンテナレジストリのホスト名の末尾（`registryServer()` が組み立てる形）。 */
const REGISTRY_HOST_SUFFIX = '.sakuracr.jp'

/**
 * 引き継いだあと、**次の公開で月額が増えるか**（純関数）。
 *
 * ── なぜ「増えない」と言い切れないのか（2026-08-25）──────────────────────
 * 引き継いでも、イメージを push するレジストリは Koto が用意する。
 * `cloud:ensureRegistry` は**公開名から作った名前で既存を探し、あれば再利用する**
 * （パスワードは付け替えるので、古いパスワードは要らない）。
 * つまり **いまのアプリのレジストリ名と一致すれば増えず、違えば1つ増える**。
 *
 * 一致するかどうかは、インポートの時点で分かる（イメージ参照にサーバー名が入っている）。
 * **押す前に、増えるか増えないかをはっきり言う。**
 */
export function adoptionRegistryReuse(opts: { appName: string; imageServer: string | null | undefined }): {
  /** 次の公開で、いまのレジストリをそのまま使うか。 */
  reuses: boolean
  /** 読み取れなかったときに Koto が探しにいく名前。 */
  wanted: string
  /** いまのアプリが使っているレジストリの名前（さくら以外・読めなければ null）。 */
  current: string | null
} {
  const wanted = registrySubdomainLabel(normalizeSpecName(opts.appName))
  const current = registryLabelFromServer(opts.imageServer)
  // 読み取れたら state へ記録する。`registryLookupNames` は**記録した名前を先に試す**ので、
  // 名前が公開名と違っていても、いまの置き場がそのまま見つかる（＝増えない）。
  // 読み取れないとき（さくら以外のレジストリ）は、公開名から作った名前で探すしかない。
  if (current) return { reuses: true, wanted, current }
  return { reuses: false, wanted, current: null }
}

/**
 * インポートの画面へ渡す「引き継ぎの見立て」（純関数）。
 * **押す前に見せるためのもの**なので、判断に要ることだけを揃える。
 * 形は `shared/publishImport.ts` の `AdoptionPreview`（画面と共有する）。
 */
export function adoptionPreview(opts: {
  appName: string
  settings: AppRunSettings
  imageServer: string | null | undefined
}): AdoptionPreview {
  const blocker = adoptionBlocker(opts.settings)
  return {
    canAdopt: !blocker,
    blocker,
    specName: normalizeSpecName(opts.appName),
    appName: opts.appName,
    reusesRegistry: adoptionRegistryReuse({ appName: opts.appName, imageServer: opts.imageServer }).reuses,
    warnings: adoptionWarnings(opts.settings),
  }
}


/**
 * 引き継ぎで書くファイルを、**中身まで**組み立てる（純関数・IO 無し）。
 *
 * ── なぜ「書く」から切り離すのか（掟10）────────────────────────────────
 * 書き込みは electron を抱えた IPC の中にあり、テストから呼べない。中身の判断まで
 * そこに置くと、**実際に何が書かれるのかを固定できない**。組み立てはここでやり、
 * 呼び出し側は `rel` と `content` を並べて書くだけにする。
 *
 * **書く前に検証を通す。** 壊れた `env.json` を置くと、③公開の画面がエラーで
 * 開かなくなり、利用者からは原因が見えない。
 */
export function adoptedFiles(input: AdoptInput):
  | { ok: true; files: { rel: string; content: string }[] }
  | { ok: false; reason: string } {
  const blocked = adoptionBlocker(input.settings)
  if (blocked) return { ok: false, reason: blocked }
  const v = validateSpec(adoptedSpec(input))
  if (!v.ok) {
    // **勝手に直さない。** ここで既定値へ丸めると、動いているアプリの設定が
    // 静かに書き換わる（健康診断の場所・入れ物の名前）。断って、行き先を添える（掟1）。
    return {
      ok: false,
      reason: `このアプリの設定は、Koto がそのまま引き継げない形でした（${v.errors.join(' / ')}）。`
        + '「別のアプリとして公開する」なら取り込めます。',
    }
  }
  const json = (o: unknown) => JSON.stringify(o, null, 2) + '\n'
  return {
    ok: true,
    files: [
      { rel: 'env.json', content: json(v.spec) },
      { rel: 'state.json', content: json(adoptedState(input)) },
    ],
  }
}
