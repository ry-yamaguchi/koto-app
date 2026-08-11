// electron-builder.config.js — パッケージ設定。
//
// 本体の設定は **package.json の build に置いたまま**（唯一の定義）で、
// ここは「署名・公証をするかどうか」だけを上に重ねる。設定を2箇所に分けると、
// 片方だけ直されて食い違う（掟10 と同じ理由）。
//
// ── 署名の切り替え ────────────────────────────────────────────────────
// 既定は**未署名**。これまでどおりの動作で、Apple Developer Program が無くてもビルドできる。
// 次の環境変数がすべて揃っているときだけ署名し、公証する。
//
//   KOTO_SIGN=1                      … 署名を有効にする明示のスイッチ
//   APPLE_TEAM_ID=XXXXXXXXXX         … Developer ポータルの Team ID
//   APPLE_ID=you@example.com         … Apple Account
//   APPLE_APP_SPECIFIC_PASSWORD=…    … appleid.apple.com で作る「App用パスワード」
//
// 使い方（証明書とキーチェーンが用意できてから）:
//   KOTO_SIGN=1 APPLE_TEAM_ID=… APPLE_ID=… APPLE_APP_SPECIFIC_PASSWORD=… npm run dist
//
// ⚠️ **初めて署名したリリースでは、利用者の保存済みAPIキーが復号できなくなる。**
//    未署名の間は実行ファイルの署名の実体が Electron 配布物のもので、同じ Electron
//    バージョンなら CDHash が変わらず、キーチェーンから「同じアプリ」と見なされていた。
//    署名を始めると CDHash が変わるため、この前提が崩れる。掟2 が Electron 更新に
//    ついて定めているのと同じ現象なので、**単独リリースにし、CHANGELOG に
//    「APIキーの再登録が必要」と明記する**こと。

const base = require('./package.json').build

// 公証の資格情報は3通りある（app-builder-lib の MacTargetHelper.getNotarizeOptions と同じ判定）。
// **上から順に見られる**ので、混ぜて設定しない。
const env = process.env
const creds = {
  // ① キーチェーンのプロファイル（推奨）
  //    `xcrun notarytool store-credentials` で一度保存すれば、以後はパスワードを
  //    コマンドに書かなくてよい（シェルの履歴にも残らない）。
  keychain: !!env.APPLE_KEYCHAIN_PROFILE,
  // ② App Store Connect API キー
  apiKey: !!(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER),
  // ③ Apple ID ＋ App用パスワード
  password: !!(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID),
}
const hasCreds = creds.keychain || creds.apiKey || creds.password

const sign = env.KOTO_SIGN === '1' && hasCreds

if (env.KOTO_SIGN === '1' && !sign) {
  // 「署名したつもりで未署名のものを配る」のがいちばん危ないので、黙って続行しない。
  console.error('❌ KOTO_SIGN=1 ですが、公証の資格情報がありません。次のいずれかを設定してください:')
  console.error('   ① APPLE_KEYCHAIN_PROFILE（推奨。notarytool store-credentials で作る）')
  console.error('   ② APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER')
  console.error('   ③ APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID')
  process.exit(1)
}

// ③ を使うときは APPLE_ID と APPLE_APP_SPECIFIC_PASSWORD の両方が要る。
// 片方だけだと electron-builder は署名まで済ませてから公証で落ちる（数分を無駄にする）。
if (env.KOTO_SIGN === '1' && !creds.keychain && !creds.apiKey) {
  if (!!env.APPLE_ID !== !!env.APPLE_APP_SPECIFIC_PASSWORD) {
    console.error('❌ APPLE_ID と APPLE_APP_SPECIFIC_PASSWORD は両方そろえてください。')
    process.exit(1)
  }
}

// package.json の mac.identity は null（＝署名しない）。署名するときは
// **キーを消して**キーチェーンの Developer ID Application を自動で探させる。
// スキーマ上 identity は null か文字列しか許されず、undefined を入れると弾かれる
// （2026-08-09 実機で確認）。名前を直書きしないのは、証明書を更新したときに
// 黙って見つからなくなるのを避けるため。
const { identity: _ignored, ...macBase } = base.mac

// ── DMG の公証はここでは**やらない**（2026-08-11 の教訓）─────────────
// electron-builder が公証に出すのは .app だけで、DMG は署名すらされない。
// その対処は `scripts/dmg-notarize.mjs` にあるが、**afterAllArtifactBuild では
// 動かせない**。順序がこうなっているため:
//
//   1. DMG ができる → electron-builder が**この時点の**ハッシュを計算
//      （app-builder-lib/out/publish/updateInfoBuilder.js の hashFile）
//   2. afterAllArtifactBuild が呼ばれる ← ここではまだ latest-mac.yml が無い
//      （あるのは**前の版**の yml。触ると前の版を壊す）
//   3. ビルド完了後に latest-mac.yml が書き出される
//      （PublishManager.awaitTasks → writeUpdateInfoFiles）
//
// 署名すると DMG の中身が変わり 1 のハッシュが古くなるので、**3 の後**に
// 署名・公証・staple と yml の訂正をまとめてやる必要がある。
// そのため npm script の `dist` の最後に置いてある。

module.exports = {
  ...base,
  mac: sign
    ? {
        ...macBase,
        hardenedRuntime: true, // 公証の必須条件
        gatekeeperAssess: false, // ビルド中の Gatekeeper 評価は不要（公証で担保する）
        entitlements: 'build/entitlements.mac.plist',
        entitlementsInherit: 'build/entitlements.mac.inherit.plist',
        // electron-builder 26 では boolean。false が「公証しない」で、true が有効。
        // 資格情報は環境変数から読まれる（APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID）。
        // ※ scheme.json の説明文は "Whether to disable…" と紛らわしいが、
        //   実装（MacTargetHelper.notarizeIfProvided）は `notarize === false` のときだけ飛ばす。
        notarize: true,
      }
    : {
        ...macBase,
        identity: null, // 未署名（これまでどおり）
      },
}

console.log(sign ? '🔏 署名・公証つきでビルドします' : '📦 未署名でビルドします（KOTO_SIGN=1 で署名）')
