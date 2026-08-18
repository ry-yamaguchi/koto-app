#!/usr/bin/env node
// dmg-notarize.mjs — 配布用 DMG に署名・公証・staple する。
//
// ── なぜ要るか（2026-08-11）────────────────────────────────────────────
// **electron-builder は DMG を公証しない。** 公証に出すのは .app だけで
// （`app-builder-lib/out/macPackager.js` が `notarizeIfProvided(appPath)` しか
// 呼ばない）、DMG は署名すらされない（`dmg.sign` の既定が false）。
// しかも `dmg.sign: true` にしても **codesign が走るだけで公証はされない**
// （`dmg-builder/out/dmg.js` の 44行目〜）。設定だけでは塞げない穴である。
//
// その結果、v0.3.1 の DMG は Gatekeeper の判定に落ちる:
//
//   $ spctl -a -t open --context context:primary-signature -v Koto-0.3.1-arm64.dmg
//   rejected  (source=no usable signature)
//
// 中身の .app は署名・公証・staple すべて済んでいるので、`ditto` で設置してしまえば
// 何の問題も起きない。**開発中にこれが表に出なかったのはそのため。**
// だが利用者が最初にするのは「DMG をダウンロードして開く」で、そこで止まる。
// 署名・公証にかけた作業（B-1）の効果が、入口の1画面で消えることになる。
//
// ── なぜ electron-builder の「後ろ」で動くのか ─────────────────────────
// 最初は afterAllArtifactBuild（ビルド後フック）に置いたが、**動かせなかった**。
// electron-builder の順序がこうなっているため:
//
//   1. DMG ができる → **この時点の**ハッシュを計算（updateInfoBuilder.js の hashFile）
//   2. afterAllArtifactBuild が呼ばれる ← まだ latest-mac.yml が無い
//      （あるのは前の版の yml。触ると前の版を壊す）
//   3. ビルド完了後に latest-mac.yml が書き出される（PublishManager.awaitTasks）
//
// 署名すると DMG の中身が変わって 1 のハッシュが古くなるので、**3 の後**に
// まとめてやるしかない。だから npm script の `dist` の最後に置いてある。
//
// ── 使い方 ────────────────────────────────────────────────────────────
// 通常は `KOTO_SIGN=1 … npm run dist` の最後から `--auto` で呼ばれる。
// 未署名ビルドでは何もしない。
//
// うまくいかなかったときは、まず**やり直しが要るのかを確かめる**（資格情報が要らない）:
//
//   node scripts/dmg-notarize.mjs --verify-only release/Koto-0.3.2-arm64.dmg
//
// 本当にやり直すときだけ（**staple 済みのものに掛けるとチケットが剥がれる**）:
//
//   APPLE_KEYCHAIN_PROFILE=koto node scripts/dmg-notarize.mjs release/Koto-0.3.2-arm64.dmg
//
// 資格情報の渡し方は electron-builder.config.js と同じ3通り・同じ優先順位。

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 純粋ロジック（tests/dmgNotarize.test.ts で固定） ──────────────────

/** ビルド成果物から DMG だけを取り出す。 */
export function pickDmgs(artifactPaths) {
  return (artifactPaths || []).filter((p) => typeof p === 'string' && p.endsWith('.dmg'))
}

/**
 * `security find-identity -v -p codesigning` の出力から Developer ID Application を選ぶ。
 *
 * **曖昧なときは黙って選ばない。** 証明書を更新した直後は同じ名前のものが2枚あり、
 * 古い方で署名すると公証で落ちる（気づくのは数分後）。ここで止めて理由を出す。
 */
export function pickSigningIdentity(findIdentityOutput, teamId) {
  const found = []
  for (const line of String(findIdentityOutput || '').split('\n')) {
    const m = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application: [^"]+)"/i)
    if (m) found.push({ hash: m[1], name: m[2] })
  }
  if (found.length === 0) {
    throw new Error(
      'Developer ID Application の証明書がキーチェーンに見つかりません。\n' +
        '  `security find-identity -v -p codesigning` で確認してください。'
    )
  }
  const narrowed = teamId ? found.filter((f) => f.name.includes(`(${teamId})`)) : found
  if (narrowed.length === 0) {
    throw new Error(
      `Team ID ${teamId} の Developer ID Application が見つかりません。見つかったのは:\n` +
        found.map((f) => `  - ${f.name}`).join('\n')
    )
  }
  if (narrowed.length > 1) {
    throw new Error(
      'Developer ID Application が複数あり、どれで署名すべきか決められません:\n' +
        narrowed.map((f) => `  - ${f.name}`).join('\n') +
        '\n  APPLE_TEAM_ID を指定して絞り込んでください。'
    )
  }
  return narrowed[0]
}

/**
 * `spctl` の判定を読む。
 *
 * ── なぜ関数にするか（2026-08-11 の失敗）──────────────────────────────
 * spctl は判定を **stderr** に書く。stdout は空である。ここで stdout だけを見て
 * いたため、**完全に仕上がった v0.3.2 の DMG を「拒否されました」で止めた**
 * （しかもエラー本文が空で、原因が読み取れなかった）。
 *
 * 判定は「終了コード0 かつ accepted と書いてある」の**両方**で見る。
 * 出力が空のときは通さない。**読めなかったものを「たぶん大丈夫」にしない**
 * ——ここを緩めると、今度は本当に拒否される DMG を配ることになる。
 */
export function judgeGatekeeper({ status, text }) {
  if (status !== 0) return false
  const t = String(text || '')
  if (/rejected/i.test(t)) return false
  return /accepted/i.test(t)
}

/**
 * notarytool へ渡す資格情報の引数を組み立てる。
 *
 * electron-builder.config.js と**同じ優先順位**（キーチェーン → APIキー → App用パスワード）。
 * 順番がずれると「設定したつもりの方法と違う方法で認証して落ちる」ため、揃えてある。
 *
 * ⚠️ 戻り値の args には秘密が入る。**ログに出さないこと**（method だけを出す）。
 */
export function notarytoolCredentialArgs(env) {
  const e = env || {}
  if (e.APPLE_KEYCHAIN_PROFILE) {
    return { method: 'キーチェーンのプロファイル', args: ['--keychain-profile', e.APPLE_KEYCHAIN_PROFILE] }
  }
  if (e.APPLE_API_KEY && e.APPLE_API_KEY_ID && e.APPLE_API_ISSUER) {
    return {
      method: 'App Store Connect API キー',
      args: ['--key', e.APPLE_API_KEY, '--key-id', e.APPLE_API_KEY_ID, '--issuer', e.APPLE_API_ISSUER],
    }
  }
  if (e.APPLE_ID && e.APPLE_APP_SPECIFIC_PASSWORD && e.APPLE_TEAM_ID) {
    return {
      method: 'Apple ID ＋ App用パスワード',
      args: ['--apple-id', e.APPLE_ID, '--password', e.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', e.APPLE_TEAM_ID],
    }
  }
  throw new Error(
    '公証の資格情報がありません。次のいずれかを設定してください:\n' +
      '  ① APPLE_KEYCHAIN_PROFILE（推奨。notarytool store-credentials で作る）\n' +
      '  ② APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER\n' +
      '  ③ APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID'
  )
}

/**
 * latest-mac.yml の DMG のエントリ（sha512・size）を書き換える。
 *
 * ── なぜ要るか ────────────────────────────────────────────────────
 * latest-mac.yml は electron-builder が **DMG を署名する前**に書いている
 * （afterAllArtifactBuild はビルド完了後に呼ばれる）。署名と staple で DMG の
 * 中身は変わるので、書き換えないと記録された sha512 が実物と食い違う。
 *
 * 自動更新そのものは壊れない（macOS の更新は zip を使う。electron-updater の
 * `MacUpdater` が `findFile(files, "zip", ["pkg", "dmg"])` で dmg を明示的に
 * 除外している）。それでも**配る記録が実物と違う状態を残さない**。
 *
 * 見つからなければ throw する。electron-builder が yml の形を変えたときに、
 * 黙って何もしないより止まったほうがよい（掟10）。
 */
export function updateDmgEntry(ymlText, { url, sha512, size }) {
  const lines = String(ymlText).split('\n')
  const head = lines.findIndex((l) => l.trim() === `- url: ${url}`)
  if (head < 0) {
    throw new Error(`latest-mac.yml に ${url} のエントリが見つかりません。`)
  }
  let replacedSha = false
  let replacedSize = false
  for (let i = head + 1; i < lines.length; i++) {
    // 次のエントリ（`- url:`）や字下げの浅い行に来たら、このエントリは終わり
    if (/^\s*-\s/.test(lines[i]) || !/^\s+\S/.test(lines[i])) break
    const sha = lines[i].match(/^(\s*sha512:\s*).*$/)
    if (sha) {
      lines[i] = `${sha[1]}${sha512}`
      replacedSha = true
      continue
    }
    const sz = lines[i].match(/^(\s*size:\s*).*$/)
    if (sz) {
      lines[i] = `${sz[1]}${size}`
      replacedSize = true
    }
  }
  if (!replacedSha || !replacedSize) {
    throw new Error(
      `latest-mac.yml の ${url} のエントリに ` +
        `${!replacedSha ? 'sha512' : ''}${!replacedSha && !replacedSize ? ' と ' : ''}${!replacedSize ? 'size' : ''}` +
        ' がありません。'
    )
  }
  return lines.join('\n')
}

/** electron-builder と同じ形式（sha512 の base64）でハッシュを取る。 */
export function sha512Base64(filePath) {
  return createHash('sha512').update(readFileSync(filePath)).digest('base64')
}

// ── 実行 ──────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts })
}

/**
 * DMG を1つ、署名 → 公証 → staple → 検証する。
 *
 * **最後の検証まで通らなければ throw する。** 「公証したつもりで弾かれるものを配る」
 * のが、いちばん高くつく失敗なので、途中経過ではなく Gatekeeper の判定で確かめる。
 */
export function notarizeDmg(dmgPath, env = process.env) {
  if (!existsSync(dmgPath)) throw new Error(`DMG が見つかりません: ${dmgPath}`)

  const identity = pickSigningIdentity(
    run('security', ['find-identity', '-v', '-p', 'codesigning']),
    env.APPLE_TEAM_ID
  )
  const cred = notarytoolCredentialArgs(env)

  console.log(`\n🔏 DMG に署名します: ${basename(dmgPath)}`)
  console.log(`   証明書: ${identity.name}`)
  // 名前ではなくハッシュで署名する。証明書を更新した直後は同名のものが2枚あり、
  // 名前だと codesign が "ambiguous" で落ちる。
  run('codesign', ['--force', '--sign', identity.hash, '--timestamp', dmgPath])

  console.log(`📮 公証に出します（${cred.method}）。数分かかります…`)
  // ⚠️ cred.args には秘密が入るのでログに出さない。
  const out = run('xcrun', ['notarytool', 'submit', dmgPath, '--wait', ...cred.args])
  process.stdout.write(out)
  if (!/status:\s*Accepted/i.test(out)) {
    // notarytool は Invalid でも終了コード0を返すことがあるので、本文で確かめる。
    throw new Error('公証が Accepted になりませんでした（上の出力を確認してください）。')
  }

  console.log('📎 公証チケットを DMG に貼り付けます…')
  run('xcrun', ['stapler', 'staple', dmgPath])

  verifyDmg(dmgPath)
  syncUpdateRecord(dmgPath)
}

/**
 * できあがった DMG が本当に Gatekeeper を通るかを確かめる。**何も書き換えない。**
 *
 * 署名や公証をやり直さないので、何度でも安全に実行できる。
 * 逆に notarizeDmg() は `codesign --force` から始まるため、**staple 済みの DMG に
 * かけ直すとチケットが剥がれ、公証からやり直しになる**。仕上がっているものの確認は
 * 必ずこちらを使うこと（`--verify-only`）。
 */
export function verifyDmg(dmgPath) {
  if (!existsSync(dmgPath)) throw new Error(`DMG が見つかりません: ${dmgPath}`)

  // Apple が公証済み DMG の検証手順として案内しているコマンド。
  // ⚠️ spctl は判定を **stderr** に書き、stdout には何も出さない。
  //    2026-08-11、ここで stdout だけを見ていたため、**成功した v0.3.2 のビルドを
  //    「Gatekeeper に拒否されました」で止めた**（本文が空のまま）。両方を読む。
  const res = spawnSync('spctl', [
    '-a', '-t', 'open', '--context', 'context:primary-signature', '-v', dmgPath,
  ], { encoding: 'utf8' })
  const all = `${res.stdout || ''}${res.stderr || ''}`.trim()
  if (!judgeGatekeeper({ status: res.status, text: all })) {
    throw new Error(`Gatekeeper に拒否されました（exit=${res.status}）:\n${all || '（出力なし）'}`)
  }

  // チケットが本体に貼られているか（オフラインでも通るために要る）
  const st = spawnSync('xcrun', ['stapler', 'validate', dmgPath], { encoding: 'utf8' })
  if (st.status !== 0) {
    throw new Error(
      `公証チケットが貼られていません:\n${`${st.stdout || ''}${st.stderr || ''}`.trim()}`
    )
  }

  console.log(`✅ ${basename(dmgPath)} — 署名・公証・staple すべて確認しました`)
  console.log(`   ${all.split('\n').join('\n   ')}`)
}

/**
 * `latest-mac.yml` の記録を、署名後の実物に合わせる。
 *
 * **確認（verifyDmg）とは分けてある。** 一緒にしていたとき、過去の版の DMG を
 * `--verify-only` で確認しただけで「エントリが見つかりません」と落ちた
 * （yml は今の版のものなので、当然入っていない）。確認は何も書き換えない。
 */
export function syncUpdateRecord(dmgPath) {
  const yml = join(dirname(dmgPath), 'latest-mac.yml')
  if (!existsSync(yml)) {
    throw new Error(`${yml} がありません。electron-builder が書く前に呼んでいないか確認してください。`)
  }
  const updated = updateDmgEntry(readFileSync(yml, 'utf8'), {
    url: basename(dmgPath),
    sha512: sha512Base64(dmgPath),
    size: statSync(dmgPath).size,
  })
  writeFileSync(yml, updated)
  console.log('📝 latest-mac.yml の記録を実物に合わせました')
}

/**
 * `release/` から、いま作った版の DMG を選ぶ。
 *
 * **他の版を巻き込まない。** release/ には過去の版がすべて残してある
 * （docs/release-flow.md「過去版を残す」）。版で絞らずに `*.dmg` を拾うと、
 * 何十個もの古い DMG を公証に出しにいくことになる。
 */
export function dmgsForVersion(fileNames, version) {
  const prefix = `Koto-${version}-`
  return (fileNames || [])
    .filter((n) => n.startsWith(prefix) && n.endsWith('.dmg'))
    // ── 試作（-rc.N）を巻き込まない（2026-08-18 実機）────────────────────
    // `Koto-0.3.34-` は **`Koto-0.3.34-rc.1-arm64.dmg` にも一致する**。
    // そのため v0.3.34 の署名ビルドが、release/ に残っていた**未署名の rc**まで
    // 公証に出し、`Invalid` で ❌ を出した（中の .app が署名されていないので当然）。
    // 数分の待ち時間と、**成功しているのに失敗に見える表示**を生む。
    // 版のうしろに来てよいのは**アーキテクチャ1語だけ**（`arm64.dmg` など）。
    .filter((n) => !n.slice(prefix.length, -'.dmg'.length).includes('-'))
    .sort()
}

/** ビルド成果物すべてに対して実行する。 */
export function notarizeAllDmgs(artifactPaths, env = process.env) {
  const dmgs = pickDmgs(artifactPaths)
  if (dmgs.length === 0) return
  for (const dmg of dmgs) {
    try {
      notarizeDmg(dmg, env)
    } catch (e) {
      // .app と .zip はすでに完成している。DMG だけやり直せることを伝える
      // （ここで再ビルドさせると、.app の公証にもう一度数分かかる）。
      console.error(`\n❌ DMG の公証に失敗しました: ${basename(dmg)}`)
      console.error(String(e.message || e))
      console.error(
        '\n.app と .zip はできています。まず**やり直しが要るのか**を確かめてください:\n' +
          `  node scripts/dmg-notarize.mjs --verify-only ${dmg}\n` +
          '\nこれで accepted と出るなら DMG は仕上がっています（止めたのは確認工程の側）。\n' +
          '本当にやり直すときだけ:\n' +
          `  APPLE_KEYCHAIN_PROFILE=<プロファイル名> node scripts/dmg-notarize.mjs ${dmg}\n`
      )
      throw e
    }
  }
}

// 直接実行されたとき（DMG だけのやり直し・確認用）
if (process.argv[1] && process.argv[1].endsWith('dmg-notarize.mjs')) {
  const argv = process.argv.slice(2)
  const verifyOnly = argv.includes('--verify-only')
  const auto = argv.includes('--auto')
  let targets = argv.filter((a) => !a.startsWith('--'))

  // `npm run dist` の最後から呼ばれる形。未署名ビルドでは何もしない。
  if (auto) {
    if (process.env.KOTO_SIGN !== '1') {
      console.log('📦 未署名ビルドなので DMG の公証はしません（KOTO_SIGN=1 で有効）')
      process.exit(0)
    }
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    // pathname だとパスに空白があったとき %20 のままになる。必ず fileURLToPath を通す
    const dir = fileURLToPath(new URL('../release/', import.meta.url))
    targets = dmgsForVersion(readdirSync(dir), version).map((n) => join(dir, n))
    if (targets.length === 0) {
      console.error(`❌ release/ に Koto-${version}-*.dmg がありません。`)
      process.exit(1)
    }
  }

  if (targets.length === 0) {
    console.error('使い方: node scripts/dmg-notarize.mjs [--auto|--verify-only] <DMGのパス> [...]')
    console.error('  --auto        … package.json の版の DMG を release/ から探す（dist の最後から呼ばれる）')
    console.error('  --verify-only … 署名・公証はやり直さず、仕上がりの確認だけをする（資格情報が要らない）')
    process.exit(1)
  }
  if (verifyOnly) {
    try {
      for (const t of targets) verifyDmg(t)
    } catch (e) {
      console.error(`\n❌ ${String(e.message || e)}`)
      process.exit(1)
    }
    process.exit(0)
  }
  try {
    for (const t of targets) notarizeDmg(t)
  } catch (e) {
    console.error(`\n❌ ${String(e.message || e)}`)
    process.exit(1)
  }
}
