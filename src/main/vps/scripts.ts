// scripts.ts — さくらのVPS 公開機能: 固定スクリプトテンプレート集（純粋・electron非依存）。
// docs/vps-plan.md §2.1/§4/§6・「決定事項（2026-07-18）」準拠。
//
// 設計方針（不変条件）:
// - 変数として埋め込むのは validate.ts の検証を通した値のみ（ここでも assertSafeForShell で最終防衛する）。
// - 秘密情報（パスワード等）は一切埋め込まない。関数のシグネチャ自体にパスワード引数を持たせない
//   （公式マニュアルが「パスワードを含む値はスクリプトと実行ログに残留する」と警告しているため）。
// - すべて冪等（再実行しても壊れない）。ユーザー作成は `id -u ... || useradd ...`、
//   authorized_keys は毎回このIDEが払い出した鍵の内容で上書きする（このIDE専用の鍵なので安全）。
// - sshd の設定変更は必ず `sshd -t` で検証してから reload する（設定ミスで締め出されるのを防ぐ）。

import { isValidPublicKey, isValidUsername, assertSafeForShell } from './validate'

export interface KeyIdentity {
  /** `ssh-ed25519 AAAA... [comment]` 形式の公開鍵。validate.isValidPublicKey を通った値のみ許可。 */
  publicKey: string
  /** sudo可・初期構築と保守のみを行う管理ユーザー（既定 'sakura-admin'）。 */
  adminUser: string
  /** sudo不可・`/srv/app` 所有・日常デプロイ専用ユーザー（既定 'deploy'）。 */
  deployUser: string
}

/** 3値すべてを検証し、シェルへ渡す前の最終防衛（assertSafeForShell）まで通す。1つでも不正なら例外。 */
function assertKeyIdentity({ publicKey, adminUser, deployUser }: KeyIdentity): void {
  if (!isValidPublicKey(publicKey)) throw new Error('公開鍵の形式が不正です（ssh-ed25519 のみ許可）')
  if (!isValidUsername(adminUser)) throw new Error('管理ユーザー名の形式が不正です')
  if (!isValidUsername(deployUser)) throw new Error('デプロイユーザー名の形式が不正です')
  if (adminUser === deployUser) throw new Error('管理ユーザーとデプロイユーザーは別名にしてください')
  assertSafeForShell(publicKey)
  assertSafeForShell(adminUser)
  assertSafeForShell(deployUser)
}

/**
 * 1ユーザー分の「作成（冪等）＋鍵設置」コマンド群を生成する内部ヘルパー。
 * - ユーザーが存在しなければ作成する（存在すれば何もしない＝冪等）。
 * - isAdmin なら sudo グループへ追加する（deploy 側では呼ばない＝sudo不可を維持）。
 * - authorized_keys はこのIDEが払い出した公開鍵の内容だけで毎回上書きする（このIDE専用アカウントの
 *   鍵ファイルのため、他の鍵を消してしまう心配がない＝冪等かつ安全）。
 * - homeOwnerPath を渡すと、そのディレクトリを作成しユーザー所有にする（deploy の `/srv/app` 用）。
 */
function userSetupCommands(user: string, publicKey: string, isAdmin: boolean, homeOwnerPath?: string): string[] {
  const cmds: string[] = [
    `id -u ${user} >/dev/null 2>&1 || useradd -m -s /bin/bash ${user}`,
  ]
  if (isAdmin) cmds.push(`usermod -aG sudo ${user}`)
  cmds.push(
    `install -d -m 700 -o ${user} -g ${user} /home/${user}/.ssh`,
    `printf '%s\\n' '${publicKey}' > /home/${user}/.ssh/authorized_keys`,
    `chmod 600 /home/${user}/.ssh/authorized_keys`,
    `chown ${user}:${user} /home/${user}/.ssh/authorized_keys`,
  )
  if (homeOwnerPath) {
    cmds.push(
      `mkdir -p ${homeOwnerPath}`,
      `chown ${user}:${user} ${homeOwnerPath}`,
    )
  }
  return cmds
}

/**
 * sshd 強化コマンド（パスワード認証無効化＋PermitRootLogin no＋鍵認証を明示的に有効化）。
 * `sshd -t` で構文検証してから reload する順序を必ず守る（検証に失敗すれば `set -e` 相当で停止し、
 * 壊れた設定は決して反映されない＝締め出し防止）。
 * ルートB（既存VPS）では「鍵認証の疎通確認が取れた後にだけ」呼び出すこと（呼び出し側の責務）。
 */
export function buildHardenSshdCommands(): string[] {
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    'install -d -m 755 /etc/ssh/sshd_config.d',
    "cat > /etc/ssh/sshd_config.d/99-koto-hardening.conf <<'KOTOEOF'",
    'PasswordAuthentication no',
    'PermitRootLogin no',
    'PubkeyAuthentication yes',
    'KOTOEOF',
    'sshd -t',
    '(systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || service ssh reload)',
  ]
}

/**
 * ルートB用: パスワードSSHセッションで実行する固定コマンド列（配列で返す）。
 * 内容はルートA（buildStartupScript）とほぼ同じ「2ユーザー作成＋鍵設置」だが、
 * sshd のパスワード認証無効化は**含めない**（鍵認証の疎通確認が取れるまで無効化しない、という
 * 順序保証のため。無効化は疎通確認後に buildHardenSshdCommands() を別途呼び出す）。
 */
export function buildInstallKeyCommands(identity: KeyIdentity): string[] {
  assertKeyIdentity(identity)
  const { publicKey, adminUser, deployUser } = identity
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    ...userSetupCommands(adminUser, publicKey, true),
    ...userSetupCommands(deployUser, publicKey, false, '/srv/app'),
  ]
}

/**
 * ルートA用: さくらのVPS コントロールパネルの「マイスクリプト」に貼るbashスクリプトを文字列で返す。
 * サーバ新規追加／OS再インストール時にのみ実行される（公式マニュアル準拠）。
 *
 * - 2ユーザー作成＋鍵設置（buildInstallKeyCommands と同じ内容）に加え、
 *   まっさらな状態であることが保証されているため、その場で sshd 強化まで行ってよい
 *   （buildHardenSshdCommands と同じ内容を埋め込む＝DRY）。
 * - 秘密情報は一切埋め込まない（公開鍵のみ）。
 * - 冪等（再実行しても壊れない）。
 */
export function buildStartupScript(identity: KeyIdentity): string {
  assertKeyIdentity(identity)
  const { publicKey, adminUser, deployUser } = identity
  const harden = buildHardenSshdCommands().slice(2) // 先頭の shebang / set -euo pipefail は下で1回だけ書くため除く
  const lines = [
    '#!/bin/bash',
    '# Koto（さくらのVPS 公開機能）が生成した初期設定スクリプトです。',
    '# さくらのVPS コントロールパネルの「マイスクリプト」に登録し、',
    '# サーバ新規追加・OS再インストール時に選択してください（稼働中のサーバでは実行されません）。',
    '# 秘密情報（パスワード等）は一切含まれません（公開鍵のみ）。何度実行しても安全です（冪等）。',
    'set -eu',
    ...userSetupCommands(adminUser, publicKey, true),
    ...userSetupCommands(deployUser, publicKey, false, '/srv/app'),
    ...harden,
  ]
  return lines.join('\n') + '\n'
}
