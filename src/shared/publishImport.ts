// publishImport.ts — 公開済みのものを「引き取る」ときの判断（純ロジック）。
//
// ── なぜ要るか（2026-08-22 Ryosuke 提案・dev-plan ④）─────────────────────
// PC の消失・プロジェクトの引き継ぎ・引っ越しでは、**手元にファイルが無い**。
// 公開されているものから中身を取り戻して、新しいプロジェクトとして受け入れる。
//
// ここには**判断だけ**を置く（取得・書き込みは呼び出し側）。
// 実測（2026-08-22〜23）で分かった形に合わせてある。生の応答は dev-plan ④ に記録。

/** 引き取りの候補（公開先をまたいで同じ形で見せる）。 */
export type ImportCandidate = {
  target: 'vercel' | 'sakura-apprun'
  /** 公開先での識別子（Vercel はデプロイID、AppRun はアプリID）。 */
  id: string
  /** 見出し（プロジェクト名／アプリ名）。 */
  name: string
  /** 公開URL（分かれば）。 */
  url: string | null
  /** いつのものか（ISO 文字列。分かれば）。 */
  at: string | null
  /** 補足（どこのものか・状態など。一覧の2行目に出す）。 */
  note: string
  /** **引き取れないもの**は理由を入れる（一覧には出すが、選ばせない）。 */
  blocked?: string
  /**
   * **このパソコンの Koto が、既にこれを公開している**ときのプロジェクト名。
   *
   * ── なぜ出すのか（2026-08-25 Ryosuke 指摘）──────────────────────────────
   * 「同じものを2つ持つ理由が無い」。それでも取り込めてしまうのは、
   * **手元に既にあることに気づけない**からで、気づけば起きない。
   * **止めはしない**（人には人の事情がある）。**気づかせる。**
   */
  managedBy?: { projectName: string; dir: string }
}

// ── 手元で既に管理しているもの ────────────────────────────────────────

/** ワークスペースの1プロジェクト分（キーもネットワークも使わずに読める範囲）。 */
export type LocalProject = {
  dir: string
  name: string
  /** `.sakuraide.json` の `publish`。 */
  publish?: unknown
  /** `.sakura-cloud/state.json`。 */
  apprunState?: unknown
}

/** 手元のプロジェクトが押さえている公開先（純関数）。 */
export type ManagedTargets = {
  /** AppRun のアプリID → プロジェクト。 */
  apprunAppIds: Record<string, { projectName: string; dir: string }>
  /** Vercel のプロジェクト名 → プロジェクト。 */
  vercelNames: Record<string, { projectName: string; dir: string }>
}

/**
 * 手元のプロジェクトから「もう管理している公開先」を集める（純関数）。
 *
 * **AppRun は state.json のアプリID**（名前ではない。名前は変えられるが ID は変わらない）。
 * **Vercel は `publish.vercel.name`**（公開先がこの名前で決まるため）。
 */
export function collectManagedTargets(projects: readonly LocalProject[]): ManagedTargets {
  const out: ManagedTargets = { apprunAppIds: {}, vercelNames: {} }
  for (const p of projects ?? []) {
    if (!p || typeof p.dir !== 'string' || !p.dir) continue
    const who = { projectName: p.name || p.dir.split('/').pop() || p.dir, dir: p.dir }
    const resources = (p.apprunState as { resources?: unknown } | null | undefined)?.resources
    if (Array.isArray(resources)) {
      for (const r of resources) {
        if (r && (r as any).kind === 'apprun-app' && typeof (r as any).id === 'string' && (r as any).id) {
          out.apprunAppIds[(r as any).id] = who
        }
      }
    }
    const vname = (p.publish as { vercel?: { name?: unknown } } | null | undefined)?.vercel?.name
    if (typeof vname === 'string' && vname) out.vercelNames[vname] = who
  }
  return out
}

/**
 * 候補に「もう手元にある」印をつける（純関数）。**並びも件数も変えない。**
 *
 * 選ばせないのではなく、選ぶ前に見えるようにするだけ（`blocked` にはしない）。
 */
export function markManagedCandidates(
  candidates: readonly ImportCandidate[], managed: ManagedTargets,
): ImportCandidate[] {
  return (candidates ?? []).map(c => {
    const who = c.target === 'sakura-apprun'
      ? managed?.apprunAppIds?.[c.id]
      : managed?.vercelNames?.[c.name]
    return who ? { ...c, managedBy: who } : c
  })
}

/** 「もう手元にある」ときの一言（純関数）。 */
export function managedNote(projectName: string): string {
  return `このパソコンの「${projectName}」が公開しているものです。`
}

// ── Vercel ────────────────────────────────────────────────────────────

/** Vercel のファイルツリーの節（実測した形）。 */
export type VercelTreeNode = {
  name: string
  type: string
  uid?: string
  children?: VercelTreeNode[]
}

/** 平らにしたファイル1件。 */
export type FlatFile = { path: string; uid: string }

/**
 * ツリーを平らにする（純関数）。
 *
 * `type: 'file'` かつ `uid` を持つものだけを取る。`lambda` `middleware` `symlink`
 * などは中身を取れない／取っても意味が無いので落とす（実測では全件 `file` だった）。
 */
export function flattenVercelTree(nodes: readonly VercelTreeNode[] | undefined, prefix = ''): FlatFile[] {
  const out: FlatFile[] = []
  for (const n of nodes ?? []) {
    if (!n || typeof n.name !== 'string') continue
    const p = prefix ? `${prefix}/${n.name}` : n.name
    if (n.type === 'directory') out.push(...flattenVercelTree(n.children, p))
    else if (n.type === 'file' && typeof n.uid === 'string' && n.uid) out.push({ path: p, uid: n.uid })
  }
  return out
}

/**
 * 最上位が**単一のディレクトリ**なら、その1階層を剥がす（純関数）。
 *
 * ── なぜ要るか（2026-08-23 実測）──────────────────────────────────────
 * Vercel から返るパスは `src/README.md` `src/images/hero.jpg` … だが、
 * **Koto は `src/` を付けずに送っている**（`collectDeployFiles` の relPath は
 * `README.md`）。`src/` は **Vercel 側が付けた包み**なので、剥がさずに取り込むと
 * 余計な階層ができる。
 *
 * ただし「常に `src`」と決めつけない（別の作られ方では違うかもしれない）。
 * **最上位がただ1つのディレクトリのときだけ**剥がし、剥がした名前を返して
 * 記録に残せるようにする。ファイルが最上位に1つでもあれば剥がさない。
 */
export function stripSingleRoot(files: readonly FlatFile[]): { files: FlatFile[]; stripped: string | null } {
  if (!files.length) return { files: [], stripped: null }
  const tops = new Set<string>()
  for (const f of files) {
    const i = f.path.indexOf('/')
    if (i <= 0) return { files: [...files], stripped: null } // 最上位に素のファイルがある＝包みではない
    tops.add(f.path.slice(0, i))
  }
  if (tops.size !== 1) return { files: [...files], stripped: null }
  const root = [...tops][0]
  return { files: files.map(f => ({ ...f, path: f.path.slice(root.length + 1) })), stripped: root }
}

/**
 * Git 由来か（純関数）。
 *
 * **判定は `gitSource` の有無だけで行う。** 応答の `source` は公式に
 * 「推測にすぎず権威ある値ではない。**これを使って動作を分岐させるな**」と
 * 明記されている（実測では、そもそも存在しなかった）。
 */
export function isGitBacked(detail: unknown): boolean {
  const gs = (detail as any)?.gitSource
  return !!gs && typeof gs === 'object'
}

/** Git 由来のとき、どこから取ればよいかを日本語で伝える（純関数）。 */
export function gitSourceHint(detail: unknown): string | null {
  const gs = (detail as any)?.gitSource
  if (!gs || typeof gs !== 'object') return null
  const repo = [gs.org ?? gs.owner, gs.repo].filter(Boolean).join('/')
  const branch = gs.ref ?? gs.branch
  const where = repo ? `${repo}${branch ? `（${branch}）` : ''}` : 'つないである リポジトリ'
  return `これは ${where} から公開されています。Vercel には組み立てたあとのものしかないので、`
    + `**元のファイルはそちらから取ってください**（そのほうが、直せる形のまま手に入ります）。`
}

/** デプロイの一覧を、引き取りの候補に整える（純関数）。同じプロジェクトは**最新の1件だけ**。 */
export function vercelCandidates(deployments: readonly any[]): ImportCandidate[] {
  const byProject = new Map<string, any>()
  for (const d of deployments ?? []) {
    const key = String(d?.projectId ?? d?.name ?? d?.uid ?? '')
    if (!key) continue
    const cur = byProject.get(key)
    if (!cur || Number(d?.created ?? 0) > Number(cur?.created ?? 0)) byProject.set(key, d)
  }
  return [...byProject.values()]
    .sort((a, b) => Number(b?.created ?? 0) - Number(a?.created ?? 0))
    .map(d => {
      const at = Number(d?.created ?? 0)
      // どこのものか（Full Account のトークンでは個人の一覧にチームのものも出る）
      const slug = typeof d?.inspectorUrl === 'string' ? (d.inspectorUrl.split('/')[3] ?? '') : ''
      const state = String(d?.state ?? d?.readyState ?? '')
      return {
        target: 'vercel' as const,
        id: String(d?.uid ?? d?.id ?? ''),
        name: String(d?.name ?? '(名前なし)'),
        url: typeof d?.url === 'string' ? `https://${d.url}` : null,
        at: at ? new Date(at).toISOString() : null,
        note: [slug ? `${slug} のプロジェクト` : '', state && state !== 'READY' ? `状態: ${state}` : '']
          .filter(Boolean).join(' / '),
        ...(state && state !== 'READY' ? { blocked: '公開が完了していないため引き取れません' } : {}),
      }
    })
}

// ── さくらのAppRun ─────────────────────────────────────────────────────

/**
 * アプリの詳細から、取り出すイメージの参照を得る（純関数）。
 * 実測（2026-08-22）で `components[0].deploy_source.container_registry.image` に
 * `landingtest.sakuracr.jp/landingtest:v20260821-231947` の形で入っていた。
 */
export function appRunImageRef(detail: unknown): { image: string; server: string; username: string } | null {
  const c = (detail as any)?.components
  const reg = Array.isArray(c) ? c[0]?.deploy_source?.container_registry : null
  if (!reg || typeof reg.image !== 'string' || !reg.image) return null
  return {
    image: reg.image,
    server: typeof reg.server === 'string' ? reg.server : reg.image.split('/')[0],
    username: typeof reg.username === 'string' ? reg.username : '',
  }
}

/** 引き取った公開設定（記録に残し、次の公開でそのまま使う）。 */
export type AppRunSettings = {
  port: number | null
  minScale: number | null
  maxScale: number | null
  maxCpu: string | null
  maxMemory: string | null
  timeoutSeconds: number | null
  env: { key: string; value: string }[]
  probePath: string | null
  /** 秘密は**返ってこない**（実測: 空配列）。入れ直しが要る鍵の名前だけ拾う。 */
  secretKeys: string[]
  /**
   * 中の入れ物（component）の名前。Koto が作るものは `main` だが、
   * **よそで作られたアプリは違う名前**でありうる。
   *
   * ── なぜ拾うのか（2026-08-25・第4段階の設計中に判明）────────────────────
   * 引き継いだあとの公開は PATCH で `components` を**丸ごと差し替える**。
   * 名前まで差し替えると、動いているアプリの入れ物が別物に置き換わる。
   * **元のまま送り返せるように控える。**
   */
  componentName: string | null
}

/**
 * 引き継ぎ（dev-plan ④ 第4段階）の見立て。**押す前に見せるためのもの。**
 *
 * 組み立てるのは main の `cloud/adopt.ts`（spec と state を知っている側）。
 * 型だけここに置いて、画面（`renderer/importProject.ts`）と**同じ形**を共有する。
 */
export type AdoptionPreview = {
  /** 引き継げるか。 */
  canAdopt: boolean
  /** 引き継げない理由（`canAdopt` が false のときだけ）。 */
  blocker: string | null
  /** Koto の中での公開名（正規化ずみ）。 */
  specName: string
  /** さくら側のアプリ名。`specName` と違うことがある（大文字・記号を含む名前）。 */
  appName: string
  /** 次の公開で、いまのレジストリをそのまま使うか（＝月額が増えないか）。 */
  reusesRegistry: boolean
  /** 引き継ぐ前に伝えること。 */
  warnings: string[]
}

/** アプリの詳細から、戻せる公開設定を取り出す（純関数）。 */
export function appRunSettings(detail: unknown): AppRunSettings {
  const d = detail as any
  const c = Array.isArray(d?.components) ? d.components[0] : null
  const env = Array.isArray(c?.env)
    ? c.env.filter((e: any) => typeof e?.key === 'string').map((e: any) => ({ key: e.key, value: typeof e.value === 'string' ? e.value : '' }))
    : []
  const secretKeys = Array.isArray(c?.secret)
    ? c.secret.filter((s: any) => typeof s?.key === 'string').map((s: any) => s.key)
    : []
  return {
    componentName: typeof c?.name === 'string' && c.name ? c.name : null,
    port: typeof d?.port === 'number' ? d.port : null,
    minScale: typeof d?.min_scale === 'number' ? d.min_scale : null,
    maxScale: typeof d?.max_scale === 'number' ? d.max_scale : null,
    maxCpu: typeof c?.max_cpu === 'string' ? c.max_cpu : null,
    maxMemory: typeof c?.max_memory === 'string' ? c.max_memory : null,
    timeoutSeconds: typeof d?.timeout_seconds === 'number' ? d.timeout_seconds : null,
    env,
    probePath: typeof c?.probe?.http_get?.path === 'string' ? c.probe.http_get.path : null,
    secretKeys,
  }
}

/** アプリの一覧を、引き取りの候補に整える（純関数）。 */
export function appRunCandidates(apps: readonly any[]): ImportCandidate[] {
  return (apps ?? [])
    .filter(a => a && (a.id || a.uid))
    .map(a => ({
      target: 'sakura-apprun' as const,
      id: String(a.id ?? a.uid),
      name: String(a.name ?? '(名前なし)'),
      url: typeof a.public_url === 'string' ? a.public_url : null,
      at: typeof a.created_at === 'string' ? a.created_at : null,
      note: String(a.status ?? ''),
    }))
    .sort((x, y) => String(y.at ?? '').localeCompare(String(x.at ?? '')))
}

/**
 * イメージの中の、**公開されている中身**が入っていそうな場所（純関数）。
 * 前にあるものほど優先。見つからなければ、呼び出し側が一覧を見せて選ばせる。
 */
export const IMAGE_CONTENT_ROOTS = ['usr/share/nginx/html', 'app', 'srv', 'var/www/html', 'var/www'] as const

/** tar の中身の一覧から、公開物の根を選ぶ（純関数）。 */
export function pickImageContentRoot(names: readonly string[]): string | null {
  for (const root of IMAGE_CONTENT_ROOTS) {
    if (names.some(n => n.startsWith(root + '/'))) return root
  }
  return null
}

// ── 共通 ──────────────────────────────────────────────────────────────

/**
 * 引き取ったファイルの置き場所（純関数）。
 * **公開されていたものは、公開される場所へ置く**（③ の設計に合わせて `public/` の中）。
 */
export function importedFilePath(publishDir: string, relPath: string): string {
  return `${publishDir}/${relPath}`
}

/**
 * 引き取り先のフォルダ名（純関数）。
 *
 * **新規プロジェクトの名前の規則に合わせる**（NewProjectModal の `NAME_OK` と同じ
 * 半角英数字・`.`・`-`・`_` のみ）。ここで緩い名前を作ると、引き取りだけが
 * 通ってしまい、あとの画面（公開名・イメージのタグ）で弾かれる。
 * 日本語の名前などは全部落ちて既定名になるが、**利用者が名前欄で直せる**。
 */
export function importFolderName(name: string): string {
  const cleaned = String(name ?? '').trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return cleaned || 'imported-project'
}

/**
 * イメージの中から取り込んだファイルの、プロジェクト内での相対パス（純関数）。
 *
 * tar の一覧は `usr/share/nginx/html/index.html` の形で来る。根を剥がしたうえで
 * **公開される場所**へ置いたときの位置に直す。ディレクトリ（末尾 `/`）は除く。
 */
export function importedRelPathsFromTar(names: readonly string[], root: string, publishDir: string): string[] {
  const prefix = root + '/'
  const out: string[] = []
  for (const n of names ?? []) {
    if (!n.startsWith(prefix) || n.endsWith('/')) continue
    const rel = n.slice(prefix.length)
    if (rel) out.push(importedFilePath(publishDir, rel))
  }
  return out
}

/**
 * 🕘 履歴の起点をつくる上限（**黙って打ち切らない**）。
 *
 * ── なぜ上限が要るか（2026-08-24）──────────────────────────────────────
 * 起点は取り込んだファイルを丸ごともう1部写すので、**ディスクが倍**になる。
 * サイトなら数十件だが、AppRun のイメージには `node_modules` ごと入っていることがあり、
 * 数万件になりうる。そこまで写すと取り込み自体が終わらない。
 *
 * ただし **8/21 の失敗（先頭8ファイルしか見ずに黙っていた）を繰り返さない**。
 * 上限に当たったら作らないだけでなく、**当たった事実を利用者に言う**。
 */
export const HISTORY_ORIGIN_MAX_FILES = 2000

/** 起点を作らなかった理由（作るなら null）。純関数。 */
export function historyOriginSkipReason(fileCount: number): string | null {
  if (fileCount <= HISTORY_ORIGIN_MAX_FILES) return null
  return `ファイルが多いため（${fileCount} 件）、🕘 履歴の起点は作りませんでした`
    + `（${HISTORY_ORIGIN_MAX_FILES} 件まで）。取り込んだファイルはそのまま入っています。`
}
