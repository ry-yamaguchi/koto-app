// imageCleanup.ts — コンテナレジストリに溜まった「古いイメージ」の一覧と片づけ（同梱 crane を使用）。
//
// ── なぜ要るか（2026-08-19 Ryosuke 指摘）────────────────────────────────
// 「公開しても古いイメージのまま反映されない」を直すため、公開のたびに新しいタグを
// 打つようにした（shared/publishTag.ts）。その副作用で、レジストリにタグが溜まる。
//
// ── 守り（掟5・掟10）──────────────────────────────────────────────────
//   ・**既定では消さない。** 公開のあとに走るのは「数えて知らせる」ところまで。
//   ・消すのは、利用者が確認ダイアログで了解したときだけ（cloud:cleanupImages）。
//   ・何を消すかの判断は shared/imageRetention.ts に**一元化**してある（テスト付き）。
//     ここは「レジストリに聞く」「消す」という機械的な部分だけを持つ。
//
// ── 削除は digest に対して行う（2026-08-19 実測にもとづく）──────────────
// ファイルを変えずに公開し直すと層も設定も同じになり、**別のタグが同じ実体を指す**。
// タグ名で消すと、レジストリによっては実体ごと消えて**残すはずのタグまで消える**。
// そこで「タグ→digest を引く → 残すタグが指す digest を除く → digest を消す」の順にする。
// 除外の判断も imageRetention.ts（digestsToDelete）に置いてある。
//
// ── 権限（掟1: 公式の記述と、実機で確かめたことを分けて書く）──────────────
// さくらの公式マニュアルは、レジストリの利用者権限を次のように定めている:
//   All        … イメージの新規追加、変更、**削除**、取得、イメージ一覧、イメージ詳細、タグ一覧の取得
//   Push & Pull… イメージの変更、取得
//   Pullのみ   … イメージの取得のみ
//   https://manual.sakura.ad.jp/cloud/appliance/container-registry/index.html
// Koto が自動作成する push 用ユーザーは **`readwrite`（Push & Pull）** である
// （ipc/cloud.ts の ensureRegistry）。
//
//   ✅ **一覧（crane ls）は readwrite のままで通る**
//      2026-08-19、sample-app.sakuracr.jp に対して実機で確認した
//      （タグ v20260819-183758 / -184422 / -184601 と latest が返った）。
//   ❓ **削除が readwrite で通るかは未確認。** マニュアルの区分どおりなら断られる。
//      消す対象が無かったため、実機で試せていない（docs/dev-plan.md の調査ステップ）。
//
// そこで、失敗したときは**生の応答をそのまま返す**（握りつぶさない）。
// 権限不足だと分かったら、コントロールパネルで「All」に変えてもらう案内を出す。

import { execFile } from 'child_process'
import * as fs from 'fs'
import { cranePath, builderAvailable, makeDockerConfigDir } from './imageBuild'
import { buildRef, validateImageName, validateRegistryServer } from './docker'
// 失敗の見分けは shared に一元化してある（掟10。テストは tests/registryTrouble.test.ts）。
import { looksLikePermissionProblem, looksLikeUnsupported } from '../../shared/registryTrouble'

/** crane 実行の上限（一覧・削除は軽いので、ビルドより短くてよい）。 */
const CLEANUP_TIMEOUT = 60000
const CLEANUP_MAX_BUFFER = 4 * 1024 * 1024
const OUTPUT_MAX = 4000

/** レジストリ認証（imageBuild と同じ形）。 */
export type RegistryAuth = { server: string; user: string; password: string }

function clip(s: unknown): string {
  return String(s ?? '').slice(0, OUTPUT_MAX)
}

/** 失敗の理由を短くまとめる（最後の非空行が原因のことが多い）。 */
function summarize(stderr: string, fallback: string): string {
  const t = (stderr || '').trim()
  if (!t) return fallback
  const lines = t.split(/\r?\n/).filter(l => l.trim().length > 0)
  return (lines[lines.length - 1] ?? t).slice(0, 300)
}

/** crane を DOCKER_CONFIG つきで実行する（パスワードは argv に載せない）。 */
function runCrane(args: string[], cfgDir: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      cranePath(),
      args,
      {
        timeout: CLEANUP_TIMEOUT,
        maxBuffer: CLEANUP_MAX_BUFFER,
        env: { ...process.env, DOCKER_CONFIG: cfgDir },
      },
      (err: any, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

/** repo（`server/image`）を組み立てる。検証は docker.ts の関数を使い回す（掟10）。 */
function buildRepo(auth: RegistryAuth, image: string): string {
  return `${validateRegistryServer(auth.server)}/${validateImageName(image)}`
}

/** 一時 DOCKER_CONFIG を用意して fn を走らせ、必ず後始末する。 */
async function withAuth<T>(auth: RegistryAuth, fn: (cfgDir: string) => Promise<T>): Promise<T> {
  const cfgDir = makeDockerConfigDir(auth)
  try {
    return await fn(cfgDir)
  } finally {
    try { fs.rmSync(cfgDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/** タグ一覧の結果。**失敗しても握りつぶさない**（生の応答を detail に載せる）。 */
export type ListTagsResult =
  | { ok: true; tags: string[] }
  | { ok: false; message: string; detail: string; permission: boolean }

/**
 * レジストリのタグを一覧する（`crane ls <server>/<image>`）。
 * **何も変えない読み取り操作**なので、公開のあとに毎回呼んでよい。
 */
export async function listTags(opts: { auth: RegistryAuth; image: string }): Promise<ListTagsResult> {
  if (!builderAvailable()) {
    return { ok: false, message: '内蔵ビルダー（crane）が見つかりません', detail: '', permission: false }
  }
  let repo: string
  try {
    repo = buildRepo(opts.auth, opts.image)
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), detail: '', permission: false }
  }
  return withAuth(opts.auth, async cfgDir => {
    const r = await runCrane(['ls', repo], cfgDir)
    if (!r.ok) {
      const detail = clip(r.stderr || r.stdout)
      return {
        ok: false,
        message: summarize(r.stderr, 'イメージの一覧を取得できませんでした'),
        detail,
        permission: looksLikePermissionProblem(detail),
      }
    }
    const tags = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0)
    return { ok: true, tags }
  })
}

/**
 * タグ → digest を引く（`crane digest <ref>`）。
 * **引けなかったタグは結果に入れない**（分からないものを消さないため。imageRetention の
 * digestsToDelete が「digest が無いタグは消さない」側に倒してある）。
 */
export async function resolveDigests(opts: {
  auth: RegistryAuth
  image: string
  tags: readonly string[]
  onProgress?: (m: string) => void
}): Promise<Record<string, string>> {
  if (opts.tags.length === 0) return {}
  return withAuth(opts.auth, async cfgDir => {
    const out: Record<string, string> = {}
    for (const tag of opts.tags) {
      let ref: string
      try {
        ref = buildRef(opts.auth.server, opts.image, tag)
      } catch {
        continue // 形が不正なタグには触れない
      }
      const r = await runCrane(['digest', ref], cfgDir)
      const d = r.stdout.trim()
      if (r.ok && /^sha256:[0-9a-f]{64}$/.test(d)) out[tag] = d
    }
    return out
  })
}

/** 片づけの実行結果。 */
export type DeleteResult = {
  /** 実際に消えた digest。 */
  deleted: string[]
  /** 消せなかったもの（生の応答つき）。 */
  failed: Array<{ digest: string; message: string; detail: string }>
  /** 権限不足に見える失敗があったか（画面で案内を変えるため）。 */
  permission: boolean
  /** レジストリが削除に対応していないように見えたか。 */
  unsupported: boolean
}

/**
 * digest を指定してイメージを消す（`crane delete <server>/<image>@<digest>`）。
 *
 * **ここに来る digest は、すでに imageRetention.digestsToDelete を通っていること**
 * （残すタグが指す実体は除かれている）。この関数自体は選別をしない。
 */
export async function deleteDigests(opts: {
  auth: RegistryAuth
  image: string
  digests: readonly string[]
  onProgress?: (m: string) => void
}): Promise<DeleteResult> {
  const res: DeleteResult = { deleted: [], failed: [], permission: false, unsupported: false }
  if (opts.digests.length === 0) return res
  let repo: string
  try {
    repo = buildRepo(opts.auth, opts.image)
  } catch (e: any) {
    res.failed.push({ digest: '-', message: e?.message ?? String(e), detail: '' })
    return res
  }
  return withAuth(opts.auth, async cfgDir => {
    let done = 0
    for (const digest of opts.digests) {
      if (!/^sha256:[0-9a-f]{64}$/.test(digest)) continue // 形の怪しいものには触れない
      const r = await runCrane(['delete', `${repo}@${digest}`], cfgDir)
      done++
      opts.onProgress?.(`🧹 古いイメージを片づけています…（${done}/${opts.digests.length}）`)
      if (r.ok) {
        res.deleted.push(digest)
      } else {
        const detail = clip(r.stderr || r.stdout)
        res.failed.push({ digest, message: summarize(r.stderr, '削除できませんでした'), detail })
        if (looksLikePermissionProblem(detail)) res.permission = true
        if (looksLikeUnsupported(detail)) res.unsupported = true
      }
    }
    return res
  })
}
