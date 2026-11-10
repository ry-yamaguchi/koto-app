// publishMeta.ts — `.sakuraide.json` の publish 部分をマージ書き込みする純関数（一元定義・掟10）。
//
// ── なぜ一元化するか ──────────────────────────────────────────────────
// renderer（HanamiiPanel/VercelPanel/AppRunPanel）と main（hanamii:publish/vercel:publish/
// cloud:apply の3経路）の両方が「publish.* を既存キーを消さずにマージ書き込みする」処理を
// 必要とする。2026-09-07 の調査（roadmap #14）まで renderer 側の各パネルがほぼ同じ形の
// マージをバラバラに書いており（saveHanamiiMeta / saveVercelMeta / saveAppRunPublishRecord /
// publishPending.ts）、片方だけ直されて穴が空く事故の温床だった。ここに1箇所へ集め、
// renderer と main の両方がこの関数を呼ぶ（main 側は src/main/publishMetaFs.ts が
// ディスク読み書きを担い、この純関数を使う）。
//
// 2026-09-29: renderer は**もう .sakuraide.json を自分で書かない**。差分（patch）だけを main へ渡し、
// main が書く直前にディスクから読み直して `withMetaPatch` で当てる（入口は src/renderer/projectMeta.ts。
// 画面が開いたときの古い写しで全体を書き戻して、main が書いた記録を消す事故が起きたため）。
//
// electron/DOM には依存しない（node からも直接テストできる純粋関数のみ）。
// ⚠️ node の path/fs も import しない: shared は renderer からも import され、vite は node 組み込みを
// 空の shim にするため、実行時に `(void 0) is not a function` で死ぬ（appChatDirs.ts と同じ理由・
// 2026-09-02 実測）。この決まりは tests/appChatDirs.test.ts が src/shared 全体に対して固定している。
//
// PublishTargetKind は src/renderer/publishStatus.ts が唯一の定義（型のみの import・複製しない）。
// src/shared/teardownSupport.ts が既に同じ形でこの型を type-only import している（先例）。
import type { PublishTargetKind, PublishMeta } from '../renderer/publishStatus'

export type { PublishTargetKind }

/** 値がプレーンオブジェクトならその浅いコピーを、そうでなければ空オブジェクトを返す。
 *  null・undefined・配列・文字列・壊れた JSON をパースした結果など、何が来ても落ちないための土台。 */
function asRecord(x: unknown): Record<string, unknown> {
  if (x && typeof x === 'object' && !Array.isArray(x)) return { ...(x as Record<string, unknown>) }
  return {}
}

/**
 * `publish.targets[target]` に公開記録を差し込む。
 * 他のキー（他ターゲットの記録・`publish.hanamii.projectId`・`publish.pending`・
 * `publish` 以外のトップレベルキー）はすべて保つ（マージ書き込み）。
 */
export function withPublishRecord(
  meta: unknown,
  target: PublishTargetKind,
  rec: { publishedAt: string | null; url: string | null },
): Record<string, unknown> {
  const m = asRecord(meta)
  const publish = asRecord(m.publish)
  const targets = asRecord(publish.targets)
  return {
    ...m,
    publish: {
      ...publish,
      targets: { ...targets, [target]: rec },
    },
  }
}

/**
 * `publish.targets[target]`（📡 公開したもの一覧の1行）があるか（純関数）。値が真なら行（`{}` や日時の無い行も行）。null・false・無いは行ではない。
 * 壊れた meta（null・配列・文字列）でも落ちない。main の `hasPublishRecordFs`（自分のプロジェクト）と、
 * `main/cloud/bucketUsers.ts`（兄弟のプロジェクトが公開中か）が同じこれを通る——「行がある」の見方を1つにする。
 */
export function hasPublishRecordInMeta(meta: unknown, target: PublishTargetKind): boolean {
  const m = meta as { publish?: { targets?: Record<string, unknown> | null } | null } | null | undefined
  return !!m?.publish?.targets?.[target]
}

/** 公開先の並び（定義順）。 */
export const TARGET_ORDER: readonly PublishTargetKind[] = ['hanamii', 'vercel', 'sakura-apprun', 'sakura-apprun-dedicated', 'sakura-rental']

/**
 * 公開記録（`.sakuraide.json` を JSON.parse した値）から、記録のある公開先を定義順で返す（純関数）。**形が読めなければ `null`**（空配列とは別の意味）。
 *
 *   ・`[]`   … 読めた結果、公開先の記録が1つも無かった（`publish` や `publish.targets` が無い場合を含む）
 *   ・`null` … 読めなかった（中身がオブジェクトでない・`publish`／`targets` が別の型だった）
 *
 * 記録を読めたかの判断は、この1つだけ。画面（`renderer/publishRecord.ts`）と main（`ipc/fsTrash.ts` の `trashProjectFs`）が同じこれを通る。
 * 形が違う記録を「公開先なし」と読んで、フォルダを移す側に倒さない。
 */
export function parsePublishTargets(meta: unknown): PublishTargetKind[] | null {
  if (!isPlainObject(meta)) return null
  const publish = meta.publish
  if (publish === undefined || publish === null) return []
  if (!isPlainObject(publish)) return null
  const targets = publish.targets
  if (targets === undefined || targets === null) return []
  if (!isPlainObject(targets)) return null
  return TARGET_ORDER.filter(t => !!targets[t])
}

/**
 * `publish.pending`（公開開始マーカー）を書く。公開処理の開始時、実際の公開API呼び出しの
 * 直前に呼ぶこと。他の `publish.*` のキー（targets 等）は保つ。
 */
export function withPendingPublish(meta: unknown, target: PublishTargetKind, startedAt: string): Record<string, unknown> {
  const m = asRecord(meta)
  const publish = asRecord(m.publish)
  return {
    ...m,
    publish: {
      ...publish,
      pending: { target, startedAt },
    },
  }
}

/**
 * `publish.pending` を取り除く。公開処理の終了時（成功/失敗どちらでも）、必ず呼ぶこと。
 * 他の `publish.*` のキーは保つ。pending が無ければ何も変えず、そのまま返す。
 */
export function withoutPendingPublish(meta: unknown): Record<string, unknown> {
  const m = asRecord(meta)
  const publish = asRecord(m.publish)
  if (!('pending' in publish)) return m
  const { pending: _pending, ...restPublish } = publish
  return { ...m, publish: restPublish }
}

/**
 * さくらのAppRun 専有型（roadmap #23）: `publish.apprunDedicated` に記録する内容。
 *
 * ── なぜここに置くか（段階②・掟10の一元化）───────────────────────────────
 * 段階①は `consentedAt`／`servicePrincipalId` だけを持っていたが、段階②で
 * クラスタ・ASG・ロードバランサの ID を追加で記録するようになった。
 * 「実際に作られたものを記録する」書き込みは main（apprunDedicatedApply.ts）と
 * renderer（AppRunDedicatedPanel.tsx の同意・リソースID保存）の両方から起きるため、
 * `withPublishRecord` 等と同じ形で1箇所にまとめる。
 *
 * 各 ID は「実際に作られたか」を表す。**成功した段だけ値を持つ**——途中で失敗しても、
 * 作れたところまでの ID は残す（2026-08-14「失敗しても、途中まで起きたことは記録する」）。
 * 破棄で消せたものは `null` に戻す（消せなかったものは値を残し、「残っている」と示せるようにする）。
 *
 * 「公開した事実」（📡 公開したもの一覧・③公開の公開状況に出す日時と URL）はここではなく、
 * 他の公開先と同じ `publish.targets['sakura-apprun-dedicated']` に `withPublishRecord` で書く（D-3）。
 * ここは資源の ID だけを持つ。
 */
export type ApprunDedicatedRecord = {
  /** ②で案内している、手作業で用意したサービスプリンシパルのID。 */
  servicePrincipalId?: string | null
  /** 費用に同意した日時（ISO文字列）。無ければ「同意していない」。 */
  consentedAt?: string | null
  /** 作られたクラスタのID。 */
  clusterID?: string | null
  /** 作られたオートスケーリンググループのID（クラスタの下）。 */
  asgID?: string | null
  /** 作られたロードバランサのID（ASGの下。クラスタとは別の資源＝5-6）。 */
  loadBalancerID?: string | null
  /** クラスタ・ASG・LBに共通で使った名前（作成時の入力）。 */
  name?: string | null
  /** ASG作成に使ったゾーン。 */
  zone?: string | null
  /** 選んだワーカプランの path（`/service_classes/worker` の値）。 */
  workerServiceClassPath?: string | null
  /** 選んだロードバランサプランの path（`/service_classes/lb` の値）。 */
  lbServiceClassPath?: string | null
  /** クラスタを作成した時刻（ISO文字列）。 */
  createdAt?: string | null

  // ── D-1（土台）: 段階③⑤「アプリを公開する」の記録（roadmap #23・12-2） ──────────────
  // クラスタ・ASG・LBと同じ方針（成功した段だけ値を持つ・null は「まだ/消せた」）。
  /** 作られたアプリケーションのID（POST /applications の応答）。 */
  applicationID?: string | null
  /** アプリケーション作成に使った名前（deriveApplicationName で作った値）。 */
  applicationName?: string | null
  /** 現在有効なバージョン番号（PUT /applications/{id} の activeVersion と同じ値）。 */
  activeVersion?: number | null
  /** 公開に使ったコンテナイメージの参照（push 先のタグ付きref）。 */
  imageRef?: string | null
  /** 独自ドメインのホスト名（exposedPorts[].host にそのまま渡す値）。 */
  hosts?: string[] | null
  /** アプリケーション内部でリッスンするポート（exposedPorts[].targetPort）。 */
  appPort?: number | null
  /** バージョン作成に使った cpu（mCPU）。 */
  appCpu?: number | null
  /** バージョン作成に使った memory（MB）。 */
  appMemory?: number | null
  /** バージョン作成に使った fixedScale。 */
  appFixedScale?: number | null
  /** ロードバランサノードのアドレス（DNSのAレコードに案内する値。readLoadBalancerNodeAddresses から）。 */
  lbAddresses?: string[] | null
  /** アプリケーションを最後に公開した時刻（ISO文字列）。 */
  appPublishedAt?: string | null

  // ── 2026-09-24: 保存場所（オブジェクトストレージ）の鍵 ────────────────────────
  /**
   * いまアプリへ渡してある、保存場所の鍵の**ID だけ**（共用型の `state.meta.storagePermissionId`
   * に当たるもの）。⑥の破棄で、保存場所を消したあとにこの鍵を無効にするために記録する。
   *
   * **秘密（secretKey）は絶対にここへ書かない**（掟4。シークレットは発行の応答でしか読めず、
   * main の中で公開の本文へ渡し切る）。記録が無い＝古いプロジェクトのときは、
   * **鍵の無効化だけ飛ばして破棄は続ける。**
   */
  storagePermissionId?: string | null

  /**
   * ⑥の破棄で**計算資源は消えたのに、保存場所だけが片づかなかった**ときのバケット名
   * （2026-09-24 検分の指摘1）。
   *
   * ⑥の「すべて削除する」ボタンは、記録に clusterID/asgID/loadBalancerID が1つでもある間しか
   * 画面に出ない。保存場所の一覧が 403 や一時的な通信失敗で落ちると、記録は空・ボタンは消え、
   * **バケットだけが残って月額が黙って続く**（Koto には保存場所を消す口がほかに無い）。
   * ここへバケット名を残しておけば、窓を閉じて開き直しても⑥をもう一度押せる
   * （＝共用型が state.json にバケットを残して破棄をやり直せるのと同じ形）。
   *
   * 片づけられたら null に戻す。
   *
   * 保存場所が2件以上あるときは**止まった1件だけ**を書く値ではなく、残りの全件の先頭1件（`storageLeftoverBuckets[0]`）。
   * 「消すものがあるか」の判断（`dedicatedTeardownHasWork`）はこの1件を見続ける。名前を言う側は下の全件を読む。
   */
  storageLeftoverBucket?: string | null
  /**
   * 同じ事実の**全件**（0.6.22 段階3B-2・押し直しの印を全件にする。HANAMII の `publish.hanamii.storageLeftoverBuckets` と同じ形）。
   * 保存場所が2件以上で途中で止まった回、残っている保存場所を全部の名前で言うために書く（1件だけ言うと、名前が出なかった
   * 保存場所の月額が黙って続く）。main は `storageLeftoverBucket`（先頭1件）と必ず同じ回に書き、片づけ切ったら両方を null に戻す。
   * 無い（旧い記録）ときは `storageLeftoverBucket` の1件だけを言う（`dedicatedStorageLeftoverNames`）。
   */
  storageLeftoverBuckets?: string[] | null
}

/**
 * `publish`（`.sakuraide.json` の `publish`）から、②で記録してあるサービスプリンシパルIDを読む。
 * 形が違えば（`publish` が無い・`apprunDedicated` が無い・文字列でない）null。**読むだけ**で、
 * 前後の空白も落とさない（形の判定は呼び出し側＝servicePrincipalCandidates.ts の
 * `resourceIdFormatOk`）。`fs:publishedRecords` が返す `publish` をそのまま渡せる。
 */
export function servicePrincipalIdOf(publish: unknown): string | null {
  const v = asRecord(asRecord(publish).apprunDedicated).servicePrincipalId
  return typeof v === 'string' ? v : null
}

/**
 * `publish.apprunDedicated` へパッチをマージ書き込みする（他のキー・他の publish.* は保つ）。
 * 段階①からある `consentedAt`／`servicePrincipalId` の書き込みも、段階②のID記録も、
 * 必ずこの1箇所を通す（同じ形のマージを別々に書かない・掟10）。
 */
export function withApprunDedicatedRecord(meta: unknown, patch: Partial<ApprunDedicatedRecord>): Record<string, unknown> {
  const m = asRecord(meta)
  const publish = asRecord(m.publish)
  const existing = asRecord(publish.apprunDedicated)
  return {
    ...m,
    publish: {
      ...publish,
      apprunDedicated: { ...existing, ...patch },
    },
  }
}

/**
 * HANAMII 固有: `publish.hanamii.projectId` を保つ/更新する。
 * HANAMII は初回公開で projectId が発行され、これを保存しないまま次回公開すると
 * 新規プロジェクトとして二重作成されうる。`publish.hanamii` の他のキー
 * （workspaceId・envs・healthCheck・name 等）は保つ。
 *
 * 記録にある projectId と**違う**空でない projectId を書くとき（再公開で新しいプロジェクトができた回）は、
 * 「保存場所だけが残った」印（`storageLeftoverBuckets`）を null にする。その印は、消えた前のプロジェクトについてのもの。
 * 残すと、生きた新しいプロジェクトの破棄が「前回の破棄で消えた」と読まれる。
 * 同じ ID の書き直し・null（空）の書き込みは、「保存場所だけが残った」印を保つ。印が無い記録には、印のキーを足さない。
 * **受け付けの印（`deletionAccepted`）は、空でない projectId を書くとき（公開の成功）に、同じ ID でも外す。** null の書き込みは保つ。
 */
export function withHanamiiProjectId(meta: unknown, projectId: string | null): Record<string, unknown> {
  const m = asRecord(meta)
  const publish = asRecord(m.publish)
  const hanamii = asRecord(publish.hanamii)
  const replaced = typeof projectId === 'string' && projectId !== '' && projectId !== hanamii.projectId
  const staleMark = replaced && hanamii.storageLeftoverBuckets != null
  // 受け付けの印は、空でない projectId を書くとき（公開が成功したとき）に外す。別のプロジェクトに替わった回はもちろん、**同じ projectId への公開し直しでも**:
  // 公開し直したという新しい意思を、古い削除の確認で上書きしない（残すと、続きの自動の確かめが生きたプロジェクトへ DELETE を送る）。
  // null（空）の書き込みは、印を保つ。
  const staleAccepted = typeof projectId === 'string' && projectId !== '' && hanamii.deletionAccepted != null
  const { deletionAccepted: _dropped, ...hanamiiKept } = hanamii
  return {
    ...m,
    publish: {
      ...publish,
      hanamii: { ...(staleAccepted ? hanamiiKept : hanamii), projectId, ...(staleMark ? { storageLeftoverBuckets: null } : {}) },
    },
  }
}

/**
 * HANAMII 固有: `publish.hanamii.storageLeftoverBuckets`（前回の破棄で、プロジェクトは消えたが保存場所だけが残った印）を書く。
 *
 * - 配列 … 残っている保存場所の名前（全件）。**空配列は「プロジェクトは消えた・残りの名前は分からない」**（設定が読めなかった回）。
 *   名前は文字列だけを残し、空文字と重複は落とす（並びは保つ）。
 * - null … 印を消す（全部片づいた回・「一覧から削除」は `withoutPublishTarget` が消す）。
 * `publish.hanamii` のほかの項目（projectId・workspaceId・envs 等）は保つ。
 * 書く先は main の `markHanamiiStorageLeftoverFs`（この純関数を呼ぶ）だけ。
 */
export function withHanamiiStorageLeftover(meta: unknown, buckets: readonly string[] | null): Record<string, unknown> {
  const m = asRecord(meta)
  const publish = asRecord(m.publish)
  const hanamii = asRecord(publish.hanamii)
  const names = buckets === null
    ? null
    : Array.from(new Set(buckets.filter((b): b is string => typeof b === 'string' && b !== '')))
  // 保存場所だけが残った＝HANAMII のプロジェクトは消えた。受け付けの印は役目を終えた（残りの保存場所は、この印が引き継ぐ）。
  const { deletionAccepted: _accepted, ...hanamiiKept } = hanamii
  return {
    ...m,
    publish: {
      ...publish,
      hanamii: { ...hanamiiKept, storageLeftoverBuckets: names },
    },
  }
}

/**
 * HANAMII の「受け付けの印」（`publish.hanamii.deletionAccepted`）。利用者が確認したうえで、HANAMII が削除を受け付けた（202）ことの証。
 * 次に Koto を開いたとき、**この印があり、印の projectId が記録の projectId と一致するプロジェクトだけ**、削除の続きを自動で確かめる。
 * `shownPlacements` は、確認で見せた保存場所の組（続きで消してよいのは、この組だけ）。
 * 書く先は main の `writeHanamiiAcceptedMarkFs` の1つ。
 */
export type HanamiiDeletionAcceptedMark = {
  projectId: string
  /** 受け付けられた時刻（ISO）。 */
  acceptedAt: string
  /** 確認で見せた保存場所の組（`keepData: true` は「消しません」と見せたもの）。 */
  shownPlacements: Array<{ bucket: string; prefix: string; keepData?: true }>
  /** HANAMII が「確認が要る」と答えたか（202 の本文の `project.requiresReview === true`）。 */
  requiresReview: boolean
  operationId?: string
}

/**
 * 記録から受け付けの印を読む（純関数）。**形が違うもの（項目の欠け・型違い・壊れた組）は null**（印なし＝自動の続きをしない側に倒す）。
 * 画面（続きの探し方）と main（続きの入口）が同じこれを通る。
 */
export function hanamiiDeletionAcceptedOf(meta: unknown): HanamiiDeletionAcceptedMark | null {
  const raw = asRecord(asRecord(asRecord(meta).publish).hanamii).deletionAccepted
  if (!isPlainObject(raw)) return null
  const { projectId, acceptedAt, shownPlacements, requiresReview, operationId } = raw
  if (typeof projectId !== 'string' || projectId === '') return null
  if (typeof acceptedAt !== 'string' || acceptedAt === '') return null
  if (typeof requiresReview !== 'boolean') return null
  if (!Array.isArray(shownPlacements)) return null
  const shown: HanamiiDeletionAcceptedMark['shownPlacements'] = []
  for (let i = 0; i < shownPlacements.length; i++) {
    const e: unknown = shownPlacements[i]
    if (!isPlainObject(e)) return null
    const { bucket, prefix, keepData } = e
    if (typeof bucket !== 'string' || typeof prefix !== 'string') return null
    if (keepData !== undefined && typeof keepData !== 'boolean') return null
    shown.push(keepData === true ? { bucket, prefix, keepData: true } : { bucket, prefix })
  }
  if (operationId !== undefined && operationId !== null && typeof operationId !== 'string') return null
  return {
    projectId, acceptedAt, shownPlacements: shown, requiresReview,
    ...(typeof operationId === 'string' && operationId !== '' ? { operationId } : {}),
  }
}

/** `publish.hanamii.deletionAccepted` を書く（null で外す。外すときはキーごと消す）。`publish.hanamii` のほかの項目は保つ。 */
export function withHanamiiDeletionAccepted(meta: unknown, mark: HanamiiDeletionAcceptedMark | null): Record<string, unknown> {
  const m = asRecord(meta)
  const publish = asRecord(m.publish)
  const { deletionAccepted: _old, ...hanamiiKept } = asRecord(publish.hanamii)
  return { ...m, publish: { ...publish, hanamii: mark === null ? hanamiiKept : { ...hanamiiKept, deletionAccepted: mark } } }
}

/** プレーンオブジェクトか（配列・null・文字列・数値は「葉」として置き換える側に回す）。 */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x)
}

/**
 * 公開の記録（.sakuraide.json）へ**差分（patch）だけ**を当てる純関数（2026-09-29・掟10の一元化）。
 *
 * ── なぜ「全体を渡さず、差分だけ渡す」形にするか ──────────────────────────────
 * 以前は PublishModal.saveMeta が、**画面を開いたときに一度だけ読んだ写し**を材料に
 * .sakuraide.json 全体を書き戻していた。ダイアログを開いている間に main が書いた記録
 * （専有型の資源ID・publish.targets・HANAMII の projectId）は写しに入っていないので、
 * **書き戻すたびに消えた**。専有型のクラスタの記録が消えると⑥で破棄できず、月額22,000円が
 * 止められなくなる（掟10「画面が持っている写しは、いつでも古い」と同じ形）。
 *
 * 差分だけを受ける関数にすれば、**画面が編集しない項目は、書く直前にディスクから読んだ値が正**になる
 * （呼び出し側が古い写しを渡す口が、そもそも無い）。読み直して当てて書くのは main の
 * `mergeMetaPatchFs`（1回の同期処理＝ほかの main の書き込みと交錯しない）。
 *
 * ── 当て方 ───────────────────────────────────────────────────────────────────
 * ・両側がプレーンオブジェクトなら、キーごとに再帰してマージする（patch に無いキーはディスクのまま）
 * ・それ以外（配列・文字列・数値・boolean・null）は patch の値で**置き換える**（null は「値を null にする」）
 * ・patch の値が `undefined` のキーは**取り除く**（「消す」の明示。JSON.stringify が undefined を落とす
 *   のに頼らず、返す meta からも確実に消す）
 * ・`__proto__` のキーは読み飛ばす
 * どちらの引数も壊れた値（null・配列・文字列）が来ても落ちない（asRecord と同じ）。
 */
export function withMetaPatch(meta: unknown, patch: unknown): Record<string, unknown> {
  const base = asRecord(meta)
  if (!isPlainObject(patch)) return base
  const out: Record<string, unknown> = { ...base }
  for (const key of Object.keys(patch)) {
    if (key === '__proto__') continue
    const value = patch[key]
    if (value === undefined) { delete out[key]; continue }
    const current = out[key]
    out[key] = isPlainObject(value) && isPlainObject(current) ? withMetaPatch(current, value) : cloneLeaf(value)
  }
  return out
}

/** patch の値を、ディスクの値と参照を共有しない形で取り込む（配列・入れ子のプレーンオブジェクト）。 */
function cloneLeaf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneLeaf)
  if (isPlainObject(value)) return withMetaPatch({}, value)
  return value
}

/**
 * 公開記録から1つの公開先を取り除く（破棄・削除に成功したとき／「記録を片づける」用の純関数）。
 *
 * ── なぜここ（shared）にあるか（2026-09-29）──────────────────────────────────
 * 以前は renderer/publishStatus.ts にあり、renderer が**自分の持つ写し**に当てて書き戻していた。
 * 書き戻しを main の1か所（`forgetPublishTargetFs`）へ集めたので、main からも使える
 * shared に置く（publishStatus.ts からは再エクスポートしている＝既存の呼び出しは変わらない）。
 *
 * ── 消すのは「その公開先の記録」だけ ─────────────────────────────────────────
 * 2026-08-06 の点検で判明: 公開したときは publish.targets へ記録するのに、**Koto 自身で破棄しても
 * 記録が残っていた**。その結果「📡 公開したもの一覧」に、もう存在しない公開が出続ける。
 * 消すのは targets の該当エントリだけ。**publish.apprunDedicated（専有型の資源ID）・
 * publish.pending・他の公開先の記録には触れない**（専有型の資源IDが消えると、⑥で破棄できず、
 * 月額22,000円が止められなくなる）。publish.lastPublishedAt / url は
 * 「最後に公開したときの情報」として残す（履歴としての意味がある）。
 */
export function withoutPublishTarget(
  publish: PublishMeta | null | undefined, target: PublishTargetKind,
): PublishMeta {
  const base = publish ?? {}
  const targets = { ...(base.targets ?? {}) }
  delete targets[target]
  const next: PublishMeta = { ...base, targets }
  // ── 行を復活させる手がかりも一緒に消す（2026-08-15）──────────────────
  // buildPublishStatusRows は、targets に無くても
  //   ・hanamii.projectId があれば hanamii の行
  //   ・lastPublishedAt + host があればレンタルサーバの行
  // を**作り直す**（古いプロジェクトの救済）。消し残すと、片づけたのに一覧へ
  // 戻ってきて「効いていない」ように見える。
  // 破棄の導線（📡 公開したもの一覧）はここしか通らないので、ここで消す。
  // HANAMII の「保存場所だけが残った印」（storageLeftoverBuckets）も一緒に消す。残すと、行も projectId も無いのに
  // 印だけが残り、次に同じ記録へ projectId が入ったとき（公開し直し）、確認が「プロジェクトはすでに削除されています」と言い違える。
  // 受け付けの印（deletionAccepted）も一緒に消す: 行ごと片づけた回に、続きの自動の確かめを残さない。
  if (target === 'hanamii') {
    const { deletionAccepted: _accepted, ...hanamiiKept } = base.hanamii ?? {}
    next.hanamii = { ...hanamiiKept, projectId: null, storageLeftoverBuckets: null }
  }
  if (target === 'sakura-rental') {
    next.lastPublishedAt = undefined
    next.host = undefined
  }
  return next
}

/** meta 全体から1つの公開先の記録を取り除く（`publish` 以外のキーは保つ）。 */
export function withoutPublishTargetInMeta(meta: unknown, target: PublishTargetKind): Record<string, unknown> {
  const m = asRecord(meta)
  return { ...m, publish: withoutPublishTarget(m.publish as PublishMeta | null | undefined, target) }
}
