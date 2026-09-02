// runPlan.ts — 「② 試す」の実行方法の判定（純粋ロジック・Vitest対象）。
//
// ── なぜ切り出したか（2026-09-01 Ryosuke の調査依頼）─────────────────────
// 従来の判定は WorkflowBar.tsx の handleRun に埋め込まれ、**静的ファイル優先**
// （index.html → public/index.html → … → server.js → package.json）だった。
// このため server.js＋index.html を持つ Node アプリ（AppRun 向け kickoff が作る標準形。
// 実例: ScheduleAPP）では、サーバーを起動せず index.html を file:// で直接開いてしまい、
// fetch('/api/…') が全部失敗して「動かない」ように見えた。
//
// ここでは順序を**「サーバーの実体があればサーバー優先」**へ反転する:
// アプリは静的アセット（index.html）も持つのが普通だが、静的サイトが server.js や
// scripts.start を持つことはまず無い——ファイルの実体で判定するなら、サーバーの実体の
// ほうが「どう試すべきか」の強い証拠である。静的サイトは従来どおり index.html に落ちる。
//
// package.json は **scripts.start があるときだけ** npm start にする（従来は存在だけで
// npm start に進み、start の無い package.json が転がっているだけで失敗していた。
// 無ければ静的判定へ落ちる＝挙動は安全側にしか変わらない）。
//
// ── needsInstall（2026-09-01 実機・Ryosuke の追加調査）─────────────────────
// 上記の「サーバー優先」判定だけを直した v0.5.1 を、実機で ScheduleAPP
// （server.js・package.json に express+helmet）に対して試したところ、
// **node_modules に helmet が欠けており `node server.js` が即クラッシュ**した。
// それでも従来のコードは「コマンドを実行した」時点でサーバーが起動したものとみなし、
// 1.5秒後に問答無用でブラウザを開いていたため、利用者には「接続が拒否されました」
// という画面だけが見え、何が起きているか分からなかった。
// ここでは node-server / npm-start に needsInstall を持たせ、依存が欠けている
// ときは呼び出し側（WorkflowBar.tsx）が `npm install` を挟んでから起動できるようにする。

import { PUBLISH_DIR } from '../shared/publishRoot'

export type RunPlan =
  | { kind: 'node-server'; needsInstall: boolean }   // node server.js（http://localhost:8080 を開く）
  | { kind: 'python'; entry: 'main.py' | 'app.py' }  // python3 <entry>（ポート不定・自動では開かない）
  | { kind: 'npm-start'; needsInstall: boolean }     // npm start（scripts.start があるときだけ）
  | { kind: 'php'; docroot: 'publish' | 'root' }     // php -S（publish＝PUBLISH_DIR 配下・root＝直下）
  | { kind: 'open'; rel: string }                    // 静的: このファイルをブラウザで開く
  | { kind: 'none' }                                 // 該当なし（ヒントを表示）

export interface RunPlanIo {
  exists(rel: string): Promise<boolean>
  /** package.json の中身を読む（scripts.start の確認用）。読めなければ throw でよい。 */
  readFile(rel: string): Promise<string>
}

/** package.json に scripts.start があるか。壊れたJSON・読めない場合は false（安全側）。 */
async function hasNpmStart(io: RunPlanIo): Promise<boolean> {
  if (!(await io.exists('package.json'))) return false
  try {
    const parsed = JSON.parse(await io.readFile('package.json'))
    return typeof parsed?.scripts?.start === 'string' && parsed.scripts.start.trim() !== ''
  } catch {
    return false
  }
}

/**
 * dependencies のいずれかが node_modules に入っていない（＝ `npm install` が要る）か。
 * package.json が無い・壊れている・dependencies が無い/空のときは false（安全側・hasNpmStart と同じ流儀）。
 * devDependencies は見ない（実行に要るのは dependencies だけ）。node_modules 自体が丸ごと無い場合も、
 * 個々の `node_modules/<名前>` が存在しないことになるので同じ判定式でまかなえる。
 */
async function needsInstall(io: RunPlanIo): Promise<boolean> {
  if (!(await io.exists('package.json'))) return false
  let deps: unknown
  try {
    deps = JSON.parse(await io.readFile('package.json'))?.dependencies
  } catch {
    return false
  }
  if (!deps || typeof deps !== 'object') return false
  const names = Object.keys(deps)
  if (names.length === 0) return false
  for (const name of names) {
    // スコープ付き（@scope/name）もそのまま node_modules/@scope/name として確認できる
    if (!(await io.exists(`node_modules/${name}`))) return true
  }
  return false
}

/** 優先順位順にファイルの実体を確認し、「② 試す」の実行方法を決める。 */
export async function planRun(io: RunPlanIo): Promise<RunPlan> {
  // 1〜4. サーバーの実体（アプリ）を最優先
  if (await io.exists('server.js')) return { kind: 'node-server', needsInstall: await needsInstall(io) }
  if (await io.exists('main.py')) return { kind: 'python', entry: 'main.py' }
  if (await io.exists('app.py')) return { kind: 'python', entry: 'app.py' }
  if (await hasNpmStart(io)) return { kind: 'npm-start', needsInstall: await needsInstall(io) }
  // 5〜6. PHP（ビルトインサーバで配信。レンタルサーバ向け構成）。フォルダ名は定数で（掟10・publishRootWiring）
  if (await io.exists(`${PUBLISH_DIR}/index.php`)) return { kind: 'php', docroot: 'publish' }
  if (await io.exists('index.php')) return { kind: 'php', docroot: 'root' }
  // 7〜8. 静的サイト: ブラウザで直接開く
  if (await io.exists('index.html')) return { kind: 'open', rel: 'index.html' }
  if (await io.exists(`${PUBLISH_DIR}/index.html`)) return { kind: 'open', rel: `${PUBLISH_DIR}/index.html` }
  return { kind: 'none' }
}
