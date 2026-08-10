// plan.ts — 「前の状態に戻す」機能（P2-⑧）の純ロジック。
//
// ※重要: このモジュールは electron にも fs にも依存しない純関数の集まりである。
//   スナップショット（作業単位のバックアップ）のマニフェスト生成・ローテーション対象の算出・
//   復元計画（どのファイルをコピー/削除するか）だけをここに切り出し、IO は ipc/backup.ts 側で行う。
//
// スナップショット形式: `.sakuraide-backup/<ISO日時（コロン等をハイフン化）>/<プロジェクト相対パス>`
//   スナップショットdir直下に `_manifest.json` を置く: { createdAt, label?, files: [{ path, action }] }
//   action: 'overwrite'（上書き前の旧内容を退避） / 'create'（新規作成＝復元時は削除すべき）
//         / 'pre-restore'（復元操作の直前に現状を退避したもの。overwrite/createと同じ構造で扱える）
//
// ── 復元の意味（2026-08-05 に変更。重要） ─────────────────────────────────────
// 以前は「そのスナップショットに記録されたファイルだけ」を戻していた。これは直近の作業を取り消す
// 分には正しいが、「3つ前の状態に戻したい」ときに破綻する: 対象より後の作業が別のファイルを
// 触っていると、古い内容と新しい内容が混ざった状態になる（利用者からの指摘で判明）。
// 現在は computeRestorePlanTo() で、対象スナップショット以降のすべてを新しい方から畳み込み、
// **その時点のプロジェクトの状態そのもの**へ戻す。

export const MAX_SNAPSHOTS = 50

/** バックアップ配下のフォルダ名（プロジェクト直下からの相対）。 */
export const BACKUP_DIRNAME = '.sakuraide-backup'
/** マニフェストのファイル名（スナップショットdir直下）。 */
export const MANIFEST_FILENAME = '_manifest.json'
/** 履歴一覧に出す見出し（ユーザーの指示文など）の最大文字数。 */
export const MAX_LABEL_LENGTH = 60

export type BackupAction = 'overwrite' | 'create' | 'pre-restore'

export type ManifestFileEntry = {
  /** プロジェクトルートからの相対パス。 */
  path: string
  action: BackupAction
}

export type Manifest = {
  createdAt: string
  /** この作業が何だったか（ユーザーの指示文の先頭・「手動で保存」など）。古い版には無い。 */
  label?: string
  files: ManifestFileEntry[]
}

/** 一覧表示用に整形したスナップショット情報。 */
export type SnapshotSummary = {
  id: string
  createdAt: string
  label?: string
  /** このスナップショット自身が記録しているファイル数（＝この作業で変わったファイル数）。 */
  fileCount: number
  files: ManifestFileEntry[]
  /** この時点に戻したときに書き戻されるファイル数（対象以降を畳み込んだ累計）。 */
  restoreCount: number
  /** そのうち「削除される」ファイル数（この時点より後に新規作成されたもの）。 */
  deleteCount: number
}

/** ISO日時をディレクトリ名として安全な文字列にする（write_file の既存実装と同じ規則）。 */
export function isoToSnapshotId(iso: string): string {
  return iso.replace(/[:.]/g, '-')
}

/** ディレクトリ名（ISO日時の変換形）が新しい形式のスナップショットIDとして妥当かどうか。
 *  旧形式（`<相対パス>.<stamp>` をそのままファイルとして .sakuraide-backup 直下に置く形）は
 *  ディレクトリではなくファイルとして存在する、または `_manifest.json` を持たないため、
 *  ここでは「ディレクトリ名の形」だけを判定する（実際の存在確認は ipc 側で行う）。 */
export function looksLikeSnapshotId(name: string): boolean {
  // 例: 2026-07-06T21-15-00-000Z
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(name)
}

/**
 * スナップショットID（ディレクトリ名）を ISO日時に戻す。妥当な形でなければ null。
 *
 * ── なぜ必要か（2026-08-05・CIの失敗から判明） ────────────────────────────────
 * 一覧の並び順は createdAt、復元の畳み込みは id を見ている。この2つは別の時計だった:
 *   id        = 作業を始めた瞬間（renderer の send / agent の起動時に採番）
 *   createdAt = その作業で最初にファイルを書いた瞬間（マニフェスト作成時に new Date()）
 * AIの応答に時間がかかると両者は数十秒ずれ、その間にユーザーが手動保存すると
 * 「一覧の並び」と「どこまで巻き戻るか」が食い違う。createdAt を id から導けば常に一致する。
 * 表示上も「いつ頼んだか」になり、見出し（当時の指示文）と時刻の意味が揃う。
 */
export function snapshotIdToIso(id: string): string | null {
  if (!looksLikeSnapshotId(id)) return null
  // 2026-08-05T12-00-05-000Z → 2026-08-05T12:00:05.000Z（isoToSnapshotId の逆変換）
  const iso = id.replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
    (_, date, h, m, s, ms) => `${date}${h}:${m}:${s}.${ms}`
  )
  return Number.isNaN(new Date(iso).getTime()) ? null : iso
}

/**
 * 既存と衝突しないスナップショットIDを作る（見つからなければ1ミリ秒ずつ進める）。
 *
 * ── なぜ必要か（2026-08-05・CIの失敗から判明した実害のあるバグ） ──────────────
 * スナップショットIDは日時（ミリ秒まで）そのもの。「元に戻す」は実行前に現状を退避するが、
 * **同じミリ秒のうちに2回実行すると退避先のディレクトリが同一**になり、
 * 2回目の退避が1回目の退避内容を上書きして消してしまう。
 * その結果「戻しすぎたのでやり直す」が、やり直したい内容ではなく戻した後の内容を書き戻す。
 * 人手の操作では起きにくいが、CI（高速なLinux）では実際に再現した。
 * 退避は「やり直せること」を保証する仕組みなので、ここが壊れると被害が大きい。
 *
 * exists は「そのIDのスナップショットが既にあるか」を返す関数（IO は呼び出し側の責任）。
 */
export function nextFreeSnapshotId(iso: string, exists: (id: string) => boolean): string {
  let t = new Date(iso).getTime()
  if (Number.isNaN(t)) t = Date.now()
  // 1秒ぶん試して空きが無いことは現実には起こらないが、無限ループにはしない
  for (let i = 0; i < 1000; i++) {
    const id = isoToSnapshotId(new Date(t + i).toISOString())
    if (!exists(id)) return id
  }
  throw new Error('履歴の保存先を確保できませんでした（短時間に多すぎる操作が行われました）')
}

/** マニフェストの中身が最低限の形を満たしているか（壊れたJSON・旧形式の取りこぼし対策）。
 *  label は後から足したフィールドなので、無くても・文字列でなくても弾かない（無視する）。 */
export function isValidManifest(v: any): v is Manifest {
  return !!v && typeof v.createdAt === 'string' && Array.isArray(v.files) &&
    v.files.every((f: any) => f && typeof f.path === 'string' && (f.action === 'overwrite' || f.action === 'create' || f.action === 'pre-restore'))
}

/** 履歴の見出しを1行に整える（改行・連続空白を畳み、長すぎれば省略記号を付ける）。 */
export function normalizeSnapshotLabel(raw: string | null | undefined): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > MAX_LABEL_LENGTH ? s.slice(0, MAX_LABEL_LENGTH) + '…' : s
}

/** 一覧表示用に、新しい順（createdAt降順）でソートする。
 *  createdAt が同一のとき（旧版が作った履歴などで起こり得る）は id で決める。
 *  id は ISO 由来なので文字列比較が時系列順になり、環境によって並びが変わらない。 */
export function sortSnapshotsDesc(snapshots: SnapshotSummary[]): SnapshotSummary[] {
  return [...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}

/**
 * ローテーション対象（削除すべきスナップショットID）を算出する。
 * ids は新しい順・古い順どちらで渡してもよい（内部でソートする）。
 * 直近 keep 件を残し、それより古いものを「削除すべきID」として返す。
 */
export function rotationTargets(ids: string[], keep: number = MAX_SNAPSHOTS): string[] {
  if (ids.length <= keep) return []
  // ID は ISO由来のディレクトリ名なので文字列比較で時系列順になる
  const sorted = [...ids].sort() // 昇順（古い→新しい）
  const excess = sorted.length - keep
  return sorted.slice(0, excess)
}

/** ID付きのマニフェスト（畳み込み計算の入力）。 */
export type SnapshotRecord = { id: string; manifest: Manifest }

export type RestoreStep = {
  path: string
  /** 'restore' = 退避内容をプロジェクトへ書き戻す / 'delete' = その時点では存在しなかったので削除する。 */
  op: 'restore' | 'delete'
  /** op:'restore' のとき、退避内容を取り出すスナップショットID。 */
  fromSnapshotId: string
}

/**
 * 「targetId の時点の状態に戻す」ための復元計画を算出する。
 *
 * target 以降（target 自身を含み、それより新しいもの全部）を**古い順**に走査し、
 * ファイルごとに最初に見つかった記録を採用する。スナップショットは「その作業をする直前の内容」を
 * 持っているので、最も古い記録＝target 時点の内容になる。
 * - action:'overwrite' | 'pre-restore' → そのスナップショットの退避ファイルを書き戻す
 * - action:'create'                    → target 時点には存在しなかった＝削除する
 *
 * all に targetId が含まれていなければ空配列を返す（呼び出し側でエラーにする）。
 */
export function computeRestorePlanTo(all: SnapshotRecord[], targetId: string): RestoreStep[] {
  const sorted = [...all].sort((a, b) => a.id.localeCompare(b.id)) // 古い→新しい
  const from = sorted.findIndex(s => s.id === targetId)
  if (from < 0) return []
  const chosen = new Map<string, RestoreStep>()
  for (const snap of sorted.slice(from)) {
    for (const f of snap.manifest.files) {
      if (chosen.has(f.path)) continue // 既に「より古い記録」を採用済み
      chosen.set(f.path, {
        path: f.path,
        op: f.action === 'create' ? 'delete' : 'restore',
        fromSnapshotId: snap.id,
      })
    }
  }
  return [...chosen.values()]
}

/**
 * 復元前の「現状退避」用マニフェストを組み立てる。
 * 復元計画が触る各ファイルについて、現状（existsMap）を見て action を決める
 * （現状に存在すれば 'pre-restore'、存在しなければ 'create' 扱いとして記録し、
 * 「戻しすぎたので元に戻す」ときも正しく削除できるようにする）。
 */
export function buildPreRestoreManifest(
  paths: string[], existsMap: Record<string, boolean>, now: string, label?: string
): Manifest {
  const files: ManifestFileEntry[] = paths.map(p => ({
    path: p,
    action: existsMap[p] ? 'pre-restore' : 'create',
  }))
  const normalized = normalizeSnapshotLabel(label)
  return normalized ? { createdAt: now, label: normalized, files } : { createdAt: now, files }
}
