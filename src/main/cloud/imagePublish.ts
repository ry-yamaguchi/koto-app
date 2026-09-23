// imagePublish.ts — 「アプリを組み立ててレジストリへ反映する」段（D-2a で cloud:apply から切り出し）。
//
// 共用型（cloud:apply）だけでなく、専有型の「⑧ アプリを公開する」（D-2b/D-4）も同じ
// 「ビルド→レジストリへ push」が要る。複製せず、この関数を**両方から呼ぶ**（掟10）。
//
// 中身は cloud:apply の該当ブロックをそのまま移したもの。文言・順序・分岐・
// state.meta の更新は変えていない。
import * as fs from 'fs'
import * as path from 'path'
import type { EnvSpec, ServiceSource } from './spec'
import type { EnvState } from './state'
import { resolvePushRegistry } from './state'
import type { CloudCredentials } from './auth'
import { hasRegistryCredentials, loadRegistryCredentials, registryServer } from './registry-auth'
import { SakuraCloudClient, pickContainerRegistries } from './client'
import { buildRef, dockerAvailable, buildImage, loginRegistry, pushImage } from './docker'
import { builderAvailable, buildAndPush } from './imageBuild'
import { tagForPublish } from '../../shared/publishTag'
import { looksLikeRegistryProblem } from '../../shared/registryTrouble'
import { resolvePublishRoot } from '../publishRootFs'
import { missingDockerignoreLines } from '../../shared/publishExclude'
import { saveCloudState } from './specStore'
import { resolveBuildContext, detectRuntimeFor } from './buildContext'

export type PrepareAppImageInput = {
  projectDir: string
  spec: EnvSpec
  state: EnvState
  creds: CloudCredentials
  progress: (msg: string) => void
}

export type PrepareAppImageResult =
  | {
      ok: true
      ref: string
      server: string
      registryAuth: { server: string; username: string; password: string }
      tag: string
      image: string
      runtimeKind: string
    }
  | { ok: false; message: string; detail?: string; hint?: 'reset-registry' }

/**
 * 同梱の crane で「公開ベース＋ファイル層＋起動設定」を組み立てて、コンテナレジストリへ push する
 * （呼び出し側は `spec.service.source.type !== 'image'` のときだけ呼ぶこと）。
 */
export async function prepareAppImage(input: PrepareAppImageInput): Promise<PrepareAppImageResult> {
  const { projectDir, spec, state, creds, progress } = input
  // 呼び出し側（cloud:apply の if 条件）が image 以外のソースのときだけ呼ぶ前提。
  // 型のためのナローイングで、振る舞いは変えない。
  const source = spec.service.source as Extract<ServiceSource, { type: 'dockerfile' }>
  const builderMode = source.builder ?? 'builtin' // 既定は内蔵（Docker不要）

  // 1. 共通の前提: レジストリ認証情報。
  const regCreds = loadRegistryCredentials()
  if (!hasRegistryCredentials() || !regCreds) {
    return { ok: false, message: 'コンテナレジストリの認証情報が未登録です（認証情報で登録、または「レジストリを自動作成」してください）' }
  }

  // 1b. push 先が**このプロジェクトのレジストリ**かを確かめる。
  // 接続情報はアプリ共通に1つだけで、最後に「↻ ユーザー再設定」を押したプロジェクトの
  // もので上書きされる。突き合わせないと、別プロジェクトのレジストリへ push してしまい、
  // 向こうを破棄したときにこちらのイメージが消える（2026-08-09 の実機検証で発覚）。
  const push = resolvePushRegistry(state.meta?.registryName, regCreds.name)
  if ('error' in push) {
    if (push.error === 'no-credentials') {
      return { ok: false, message: 'コンテナレジストリの認証情報が未登録です（「🛠 レジストリを自動作成」を押してください）' }
    }
    return {
      ok: false,
      // renderer はこの印を見て「レジストリを設定し直す」ボタンを出す。
      // 平常時にそのボタンを常設すると誤爆の元になるため、必要なときだけ出す（2026-08-09）。
      hint: 'reset-registry' as const,
      message: `このプロジェクトはコンテナレジストリ『${push.recorded}』を使う設定ですが、`
        + `いまは別のレジストリ『${push.credential}』の接続情報が入っています`
        + `（別のプロジェクトで公開の準備をしたためです）。`
        + `下の「レジストリを設定し直す」を押してから、もう一度公開してください。`
        + `このまま公開すると、別のプロジェクトのレジストリにこのアプリのイメージが入ってしまいます。`,
    }
  }
  // 記録が無いプロジェクトは、いま使っているレジストリを自分のものとして記録する
  // （次回からは上の突き合わせが効く）。
  if (push.adopt) {
    try {
      saveCloudState(projectDir, { ...state, meta: { ...state.meta, registryName: push.use } })
      state.meta = { ...state.meta, registryName: push.use }
    } catch { /* 記録できなくても公開は続行（次回また採用を試みる） */ }
  }

  // 1c. **記録があることと、実在することは別。**（2026-08-14 実機）
  // コントロールパネルでレジストリを削除すると、Koto は手元の認証情報だけを見て
  // 「レジストリ登録 ✓」と表示し、組み立ての最後で push に失敗する。
  // 原因が画面に出ないうえ、回復のボタンも出ないので袋小路になる。
  try {
    const probe = new SakuraCloudClient({ credentials: creds, dryRun: false })
    const listedNow = await probe.listContainerRegistries(spec.region)
    if (listedNow.dryRun === false && listedNow.ok) {
      const names = pickContainerRegistries(listedNow.data).map(r => r.subdomainLabel)
      if (names.length > 0 && !names.includes(push.use)) {
        return {
          ok: false,
          hint: 'reset-registry' as const,
          message: `このプロジェクトが使うコンテナレジストリ『${push.use}』が見つかりません`
            + '（コントロールパネルで削除された可能性があります）。'
            + '下の「レジストリを設定し直す」を押してから、もう一度公開してください。',
        }
      }
    }
  } catch { /* 確認できなくても公開は試す（本当の失敗は下で拾う） */ }

  let contextAbs: string
  try {
    // 公開の起点は`public/`（無ければプロジェクト直下）。
    // env.json の context は、その根からの相対として解決する。
    contextAbs = resolveBuildContext(resolvePublishRoot(projectDir), source.context)
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
  if (!source.image || !source.tag) {
    return { ok: false, message: 'env.json の service.source に image と tag を設定してください（イメージのビルドに必要です）' }
  }

  // 2. レジストリサーバ＋image＋tag から完全な参照を組み立てる（検証込み）。
  //
  // ── 公開のたびに違うタグを付ける（2026-08-19 実機・Ryosuke 報告）────────
  // 「試すと画像が出るのに、公開すると出ない」。実測すると公開先には
  // **画像を入れる前の古いページ**が出ていた（`images/` は 404）。
  // 毎回 `…:latest` という**同じ名前**を渡していたため、中身が変わっても
  // AppRun 側からは同じイメージに見えていた。名前を変えれば必ず取りに行く。
  const server = registryServer(regCreds.name)
  const publishRefTag = tagForPublish(source.tag, new Date())
  const image = source.image
  let ref: string
  try {
    ref = buildRef(server, source.image, publishRefTag)
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }

  let runtimeKind = 'static'

  // 3. ビルド方式で分岐。
  if (builderMode === 'docker') {
    // ── エキスパート: ユーザーのDockerfileを Docker でビルド（Docker導入が必要・任意のRUN可） ──
    // D-7b（検分の指摘・E）: ここで runtimeKind を再代入しないと 'static' のまま返ってしまい、
    // 利用者の Dockerfile で作った像（版の目印 `.koto-build` を持たない）でも canVerify が true になる。
    // 目印が無いので 404 → 確認の判定が「まだ古い内容が表示されています」と誤報する余地があった。
    // 'docker' にすれば canVerify（runtime === 'static' だけを見る）が false になり、確認をとばす。
    runtimeKind = 'docker'
    if (!(await dockerAvailable())) {
      return { ok: false, message: 'Docker が見つかりません（エキスパートモードには Docker のインストールが必要です。標準モードなら Docker は不要です）' }
    }
    if (!fs.existsSync(path.join(contextAbs, 'Dockerfile'))) {
      return { ok: false, message: 'Dockerfile が見つかりません（エキスパートモードはビルドコンテキストに Dockerfile が必要です）' }
    }
    // ── 公開物に Koto の内部フォルダ・秘密を入れない（2026-09-23 検分・4回目の穴）──
    // この経路だけは Koto がファイルを集めない。`docker build <公開の根>` が
    // コンテキストを丸ごと読むので、publishExcludedDirNames / zipExcludePatterns /
    // rsyncExcludeArgs のどれも効かない。**除外は .dockerignore でしか効かない。**
    // 利用者や AI が自分で書いた Dockerfile（`COPY . .`）だと、手元のデータ
    // （.koto-data）やチャット履歴がイメージに焼き込まれ、レジストリへ push される。
    // 足りない行は Koto が書き足してから組み立てる（**黙ってやらず、進捗に出す**）。
    const dockerignorePath = path.join(contextAbs, '.dockerignore')
    let dockerignoreText = ''
    try { dockerignoreText = fs.readFileSync(dockerignorePath, 'utf-8') } catch { /* 無ければ新しく作る */ }
    const missingIgnores = missingDockerignoreLines(dockerignoreText)
    if (missingIgnores.length > 0) {
      try {
        const head = dockerignoreText && !dockerignoreText.endsWith('\n') ? `${dockerignoreText}\n` : dockerignoreText
        fs.writeFileSync(
          dockerignorePath,
          `${head}\n# Koto が追加: 公開物に入れないもの（手元のデータ・履歴・秘密）\n${missingIgnores.join('\n')}\n`,
          'utf-8',
        )
        progress(`🛡️ .dockerignore に除外を追加しました（${missingIgnores.join(' / ')}）`)
      } catch {
        return {
          ok: false,
          message: '公開を中止しました。`.dockerignore` を書き換えられないため、手元のデータ（.koto-data）や'
            + 'チャット履歴がコンテナのイメージに入ってしまう恐れがあります。'
            + `次の行を ${dockerignorePath} に追加してから、もう一度お試しください: ${missingIgnores.join(' / ')}`,
        }
      }
    }
    progress('🐳 Dockerfile からイメージをビルドしています…')
    const b = await buildImage(contextAbs, ref)
    // 所見12: 生ログの行き止まりを避け、主文は「原因の見当＋次の行動」に。生ログは detail へ
    // （renderer 側が折りたたみ「詳細を見る」で表示。原因究明に役立つ実績があるため捨てない）。
    if (!b.ok) {
      return {
        ok: false,
        message: 'アプリの組み立て（Dockerビルド）に失敗しました。よくある原因: Dockerfile の記述ミス、存在しないライブラリ名、対応していないベースイメージ。チャットでAIにエラー内容を貼って相談することもできます。',
        detail: b.log,
      }
    }
    progress('🔑 レジストリにログインしています…')
    const lg = await loginRegistry(server, regCreds.user, regCreds.password)
    if (!lg.ok) {
      return {
        ok: false,
        hint: 'reset-registry' as const,
        message: 'レジストリへのログインに失敗しました。下の「レジストリを設定し直す」で push 用のパスワードを作り直してから、もう一度お試しください。',
        detail: lg.message ?? '',
      }
    }
    progress('📤 レジストリへプッシュしています…')
    const ps = await pushImage(ref)
    if (!ps.ok) {
      return {
        ok: false,
        message: 'レジストリへの反映（プッシュ）に失敗しました。インターネット接続を確認して、もう一度お試しください。',
        detail: ps.log,
      }
    }
    progress('📤 レジストリへ反映しました')
  } else {
    // ── 標準: 同梱 crane で「公開ベース＋ファイル層＋起動設定」を組み立てて push（Docker不要） ──
    if (!builderAvailable()) {
      return { ok: false, message: '内蔵ビルダーが見つかりません（再インストールしてください）' }
    }
    // **何で動かすかを決める。** 長らく static 決め打ちで、Node のアプリを
    // 公開してもソースの一覧が出るだけだった（2026-08-14 実機で発覚）。
    // 判断は shared/runtimeDetect.ts に集約（掟10）。
    const choice = detectRuntimeFor(contextAbs)
    runtimeKind = choice.kind
    if (choice.kind === 'unsupported') {
      // **黙って static で公開しない。** 動かないうえにソースが丸見えになる
      return { ok: false, message: choice.reason }
    }
    progress(choice.kind === 'node' ? `📦 イメージを組み立てています…（${choice.entry} で起動）` : '📦 イメージを組み立てています…')
    const built = await buildAndPush({
      contextAbs,
      ref,
      port: spec.service.port,
      runtime: choice.kind,
      ...(choice.kind === 'node' ? { entry: choice.entry } : {}),
      registryAuth: { server, user: regCreds.user, password: regCreds.password },
      // ライブラリの用意は数分かかることがある。**黙って待たせない**
      onProgress: progress,
    })
    // 所見12: 生ログ（stderr要約）の行き止まりを避け、主文は「原因の見当＋次の行動」に。
    // 生ログは detail へ（renderer 側が折りたたみ「詳細を見る」で表示）。
    if (!built.ok) {
      const detail = [built.message, built.log].filter(Boolean).join('\n')
      // **回復の導線を、この経路にも出す。**（2026-08-14）
      // これまで印を付けていたのは Docker の経路だけで、既定の使い方をしている
      // 人だけが「直し方の分からない失敗」に取り残されていた
      const registryTrouble = looksLikeRegistryProblem(detail)
      return {
        ok: false,
        ...(registryTrouble ? { hint: 'reset-registry' as const } : {}),
        message: registryTrouble
          ? 'イメージの置き場（コンテナレジストリ）へ反映できませんでした。'
            + '削除された、または接続情報が古い可能性があります。'
            + '下の「レジストリを設定し直す」を押してから、もう一度お試しください。'
          : 'アプリの組み立てに失敗しました。よくある原因: package.json の記述ミス、存在しないライブラリ名、対応していないベースイメージ。チャットでAIにエラー内容を貼って相談することもできます。',
        detail,
      }
    }
    progress('📤 レジストリへ反映しました')
  }

  return {
    ok: true,
    ref,
    server,
    registryAuth: { server, username: regCreds.user, password: regCreds.password },
    tag: publishRefTag,
    image,
    runtimeKind,
  }
}
