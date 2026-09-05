// appSessionsStore.ts — 単独チャット（ChatApp）のセッション索引の唯一の持ち主（B'-3e-a）。
//
// ── なぜ（3e の設計・docs/roadmap.md「3e の設計」）───────────────────────────
// これまで ChatApp のセッション（Session[]＝id/title/messages/createdAt/model）は
// renderer が持ち、1.5秒デバウンスで `<workspace>/.sakuraide/chats/chat-app.json` へ
// **丸ごと**書き直していた（プロジェクト別チャットが B'-1 で追記式へ変わる前と同じ形）。
//
// ここでは「索引」（id/title/model/createdAt。メッセージは含めない）だけを持つ。メッセージ本文は
// 各セッションの**擬似 dir**（src/shared/appChatDirs.ts の sessionDir）を convStore.ts
// （プロジェクト別チャットの持ち主・B'-3c）へそのまま渡すことで、複製ゼロで追記式 chat.json v2 を
// 手に入れる。作法（メモリ＋1.5秒デバウンス＋atomic書き＋listener＋quit時flush）は
// learningStore.ts（B'-3d-1a）を手本にするが、こちらは workspaceDir を**引数で受け取る**
// （convStore.ts と同じ・グローバル状態を持たない。learningStore.ts は userData 直下の
// アプリ全体で1つのファイルなので違う作法だった）。
import * as fs from 'fs'
import * as path from 'path'
import { sessionDir, sessionsIndexPath, isValidSessionId, isValidWorkspaceDir } from '../shared/appChatDirs'
import { appChatPath } from './chatStore/paths'
import { applyConversationOps, flushConversations, dropConversation } from './chat/convStore'

/**
 * 外部（IPC）から渡ってくる workspaceDir の最後の砦（掟10・#16）。
 *
 * ── なぜここで止めるか ────────────────────────────────────────────
 * ipc/appSessions.ts は薄い配線（型注釈だけ）で workspaceDir を検証していない。
 * 相対パスや不正な値がそのまま渡ると、この下の fs 呼び出しが cwd 相対の思わぬ場所へ
 * 書きかねない（実際に「相対パス "undefined" が cwd 相対に書いた」事故があった）。
 * すべての公開関数（listSessions/createSession/renameSession/setSessionModel/deleteSession）
 * の入口で呼ぶ。
 */
function assertValidWorkspaceDir(dir: unknown): asserts dir is string {
  if (!isValidWorkspaceDir(dir)) throw new Error('不正なワークスペースパスです')
}

export type AppSessionMeta = {
  id: string
  title: string
  model: string
  createdAt: number
  /** この会話専用に作られたプロジェクトの絶対パス（掟11: チャットからの保存の流れ込み防止）。
   *  最初のファイル保存が行われるまでは無い（ensureSessionProject が最初の呼び出しで作る）。 */
  projectDir?: string
}

type Entry = {
  sessions: AppSessionMeta[]
  /** 保存待ちのデバウンスタイマー。無ければ「直前の内容が既に保存済み」（learningStore.ts と同じ）。 */
  timer: ReturnType<typeof setTimeout> | null
}

/** 保存のデバウンス（convStore.ts・learningStore.ts と同じ間隔）。 */
const DEBOUNCE_MS = 1500

/** 実体: workspaceDir → 索引（メモリ）。convStore.ts の Map と同じ形（projectDir 別ではなく
 *  workspaceDir 別。1ワークスペースに複数プロジェクトがあっても単独チャットの索引は1つ）。 */
const store = new Map<string, Entry>()

/** 索引が変わるたび呼ばれる通知先（ipc/appSessions.ts が appSessions:changed として
 *  renderer へ配線する）。learningStore.ts の listener と同じ形。テストでは差し替える。 */
let listener: ((workspaceDir: string, sessions: AppSessionMeta[]) => void) | null = null
export function setAppSessionsListener(fn: ((workspaceDir: string, sessions: AppSessionMeta[]) => void) | null): void {
  listener = fn
}

/** テスト用: メモリを空にする（タイマーも止める。convStore.resetConversations と同じ作法）。
 *  workspaceDir は呼び出し側が毎回渡す設計なので、learningStore.ts のような dirOverride は要らない。 */
export function resetAppSessionsStore(): void {
  for (const entry of store.values()) {
    if (entry.timer) clearTimeout(entry.timer)
  }
  store.clear()
}

function notify(workspaceDir: string, sessions: AppSessionMeta[]): void {
  listener?.(workspaceDir, sessions)
}

/** 索引ファイルの中身を検証しつつ読む（壊れた/想定外の形は安全側で空扱い・掟1）。 */
function sanitizeIndex(raw: unknown): AppSessionMeta[] {
  if (!Array.isArray(raw)) return []
  const out: AppSessionMeta[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = (item as any).id
    if (typeof id !== 'string' || id === '') continue
    const title = (item as any).title
    const model = (item as any).model
    const createdAt = (item as any).createdAt
    const projectDir = (item as any).projectDir
    out.push({
      id,
      title: typeof title === 'string' ? title : '新しい会話',
      model: typeof model === 'string' ? model : '',
      createdAt: typeof createdAt === 'number' ? createdAt : Date.now(),
      ...(typeof projectDir === 'string' ? { projectDir } : {}),
    })
  }
  return out
}

function readIndexFile(workspaceDir: string): AppSessionMeta[] {
  try {
    const raw = fs.readFileSync(sessionsIndexPath(workspaceDir), 'utf-8')
    return sanitizeIndex(JSON.parse(raw))
  } catch {
    return []
  }
}

function writeIndexNow(workspaceDir: string, sessions: AppSessionMeta[]): void {
  const file = sessionsIndexPath(workspaceDir)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(sessions), 'utf-8')
    fs.renameSync(tmp, file) // クラッシュ時の破損防止（他ストアと同じ atomic write の作法）
  } catch {
    // 保存できなくても致命的ではない（次回また書き直すだけ）
  }
}

/**
 * 一度きりの移行（roadmap 3e 設計の5点）。
 *
 * 呼び出し元（ensureEntry）は「索引ファイルがまだ無い」ときにだけこれを呼ぶ＝索引ファイルの
 * **存在**が「移行済みか」の印（migrated フラグ相当）。旧ファイル（appChatPath）が
 * 無い/壊れていれば、移行はせず空の索引で始める（旧ファイルはそのまま残す・安全側）。
 */
function migrateLegacyIfPresent(workspaceDir: string): AppSessionMeta[] {
  const legacyPath = appChatPath(workspaceDir)
  let raw: string
  try {
    if (!fs.existsSync(legacyPath)) return []
    raw = fs.readFileSync(legacyPath, 'utf-8')
  } catch {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [] // 壊れたJSON → 移行しない・索引は空・旧ファイルはそのまま残す（5点目）
  }
  if (!Array.isArray(parsed)) return []

  const metas: AppSessionMeta[] = []
  for (const s of parsed as any[]) {
    if (!s || typeof s !== 'object') continue
    if (!isValidSessionId(s.id)) continue // 防御: 旧データが万一不正でも擬似dirを外へ出さない
    const dir = sessionDir(workspaceDir, s.id)
    // convStore が「実在するフォルダにしか保存しない」ガード（B'-3c）を持つため、
    // 擬似 dir を先に実際に掘っておく（無ければ以後の保存が黙って skip される）。
    fs.mkdirSync(dir, { recursive: true })
    const msgs = Array.isArray(s.messages) ? s.messages : []
    // 掟10: chat.json v2 の形式をここで複製して手書きしない。convStore の書き口を通す。
    //
    // ⚠️ 'append' ではなく 'replaceAll' を使う（chatConvClient.ts の loadConversationView が
    // 旧 localStorage を convStore へ移すときと同じ選び方）。'append' は applyToMessages 経由で
    // stamp() を呼ぶため、**まだ `at`（時刻）を持たない古いメッセージに「いま（移行した瞬間）」の
    // 時刻を付けてしまう**（tests/chatTime.test.ts が固定していた「古い会話に時刻を付けない」
    // 方針に反する）。'replaceAll' は entry.messages をそのまま差し替えるだけで stamp を経由しない
    // ため、`at` の有無を含めて旧データをそのまま持ち込める。保存は最後に flushConversations で
    // まとめて書き切る。
    applyConversationOps(dir, [{ kind: 'replaceAll', messages: msgs }])
    metas.push({
      id: s.id,
      title: typeof s.title === 'string' ? s.title : '新しい会話',
      model: typeof s.model === 'string' ? s.model : '',
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
    })
  }

  flushConversations() // ここまでの全セッションぶんの chat.json（v2）を確実に書き切る
  writeIndexNow(workspaceDir, metas)

  // 旧ファイルは削除せず、リネームで保険を残す（B'-1 の写しの作法）。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  try {
    fs.renameSync(legacyPath, `${legacyPath}.bak-${stamp}`)
  } catch {
    // リネームに失敗しても索引・chat.json は既に書けているので致命的ではない
  }

  return metas
}

/** 未ロードの workspaceDir なら、索引ファイル（無ければ移行）から読んでメモリへ載せる。 */
function ensureEntry(workspaceDir: string): Entry {
  let entry = store.get(workspaceDir)
  if (entry) return entry
  const idxPath = sessionsIndexPath(workspaceDir)
  const sessions = fs.existsSync(idxPath) ? readIndexFile(workspaceDir) : migrateLegacyIfPresent(workspaceDir)
  entry = { sessions, timer: null }
  store.set(workspaceDir, entry)
  return entry
}

function scheduleSave(workspaceDir: string, entry: Entry): void {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    writeIndexNow(workspaceDir, entry.sessions)
  }, DEBOUNCE_MS)
}

/** 一覧（main が list の初回に一度きりの移行を行う。roadmap 3e 設計の4点目）。 */
export function listSessions(workspaceDir: string): AppSessionMeta[] {
  assertValidWorkspaceDir(workspaceDir)
  return [...ensureEntry(workspaceDir).sessions]
}

/** 新規セッションを索引の先頭へ足す（renderer の `setSessions(prev => [s, ...prev])` と同じ並び）。
 *  擬似 dir も先に掘っておく（次の送信が convStore へ保存されるために必須）。 */
export function createSession(workspaceDir: string, meta: AppSessionMeta): void {
  assertValidWorkspaceDir(workspaceDir)
  if (!isValidSessionId(meta?.id)) return
  const entry = ensureEntry(workspaceDir)
  fs.mkdirSync(sessionDir(workspaceDir, meta.id), { recursive: true })
  entry.sessions = [
    { id: meta.id, title: meta.title, model: meta.model, createdAt: meta.createdAt },
    ...entry.sessions.filter(s => s.id !== meta.id),
  ]
  scheduleSave(workspaceDir, entry)
  notify(workspaceDir, entry.sessions)
}

export function renameSession(workspaceDir: string, id: string, title: string): void {
  assertValidWorkspaceDir(workspaceDir)
  if (!isValidSessionId(id) || typeof title !== 'string') return
  const entry = ensureEntry(workspaceDir)
  const target = entry.sessions.find(s => s.id === id)
  if (!target || target.title === title) return
  entry.sessions = entry.sessions.map(s => s.id === id ? { ...s, title } : s)
  scheduleSave(workspaceDir, entry)
  notify(workspaceDir, entry.sessions)
}

export function setSessionModel(workspaceDir: string, id: string, model: string): void {
  assertValidWorkspaceDir(workspaceDir)
  if (!isValidSessionId(id) || typeof model !== 'string') return
  const entry = ensureEntry(workspaceDir)
  const target = entry.sessions.find(s => s.id === id)
  if (!target || target.model === model) return
  entry.sessions = entry.sessions.map(s => s.id === id ? { ...s, model } : s)
  scheduleSave(workspaceDir, entry)
  notify(workspaceDir, entry.sessions)
}

/** セッションを削除する: 索引から消し、擬似 dir を再帰削除し、convStore のキャッシュも落とす。 */
export function deleteSession(workspaceDir: string, id: string): void {
  assertValidWorkspaceDir(workspaceDir)
  if (!isValidSessionId(id)) return
  const entry = ensureEntry(workspaceDir)
  if (!entry.sessions.some(s => s.id === id)) return
  const dir = sessionDir(workspaceDir, id)
  dropConversation(dir) // 先に convStore のメモリ/保存待ちタイマーを落とす（消した後に書こうとしない）
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // 消せなくても索引からは外す（次回の一覧に残り続けない方を優先）
  }
  entry.sessions = entry.sessions.filter(s => s.id !== id)
  scheduleSave(workspaceDir, entry)
  notify(workspaceDir, entry.sessions)
}

/**
 * 会話のタイトルから、専用プロジェクトのフォルダ名を作る（掟10・単体テスト可能に export）。
 *
 * 手順: NUL と '/' を除去 → 前後空白を trim → 先頭のドット（連続分すべて）を除去 →
 * 20文字で切る → 末尾に残った空白を落とす → それでも空なら既定名「チャット」。
 *
 * ── なぜ手厚く削るか ──────────────────────────────────────────────
 * title は利用者が会話中に自由に打った文字列（最初のメッセージの先頭40文字・titleFromMessage）
 * がそのまま来る。フォルダ名としてそのまま使うと、`/` を含めば意図しない階層を作りかねず、
 * 先頭が `.` だと隠しフォルダになってしまう（Finder 等で見えなくなる＝利用者が迷う）。
 *
 * ── 20文字（2026-09-04 実機・Ryosuke 決定）────────────────────────────
 * 最初は30文字だったが、実機で「ハイブリッド思考モードの切り替えた場合と通常の場合とわかりや」
 * という**日本語が途中で終わる長いフォルダ名**ができた。フォルダ名は Finder・ファイルツリー・
 * ターミナルのどこでも短いほうが扱いやすく、20文字なら語の区切りに当たりやすい
 * （上の例は「ハイブリッド思考モードの切り替えた場合」になる）。**この数字は見た目の都合**で、
 * 一意性は名前の衝突回避（ensureSessionProject の「-2」）が別に担保している。
 */
export function sanitizeChatProjectName(title: string): string {
  let s = typeof title === 'string' ? title : ''
  s = s.replace(/\0/g, '').replace(/\//g, '')
  s = s.trim()
  s = s.replace(/^\.+/, '')
  s = s.slice(0, 20)
  s = s.trimEnd() // 切った位置が空白だと、末尾に空白の残るフォルダ名になる
  return s || 'チャット'
}

/**
 * チャット（ChatApp）の会話1件専用のプロジェクトを用意する（2026-09-04 Ryosuke 決定・
 * applyAiFile の base = root ?? currentDir が「IDEで最後に開いていた無関係なプロジェクト」へ
 * 書き込んでいた不具合の修正。掟11: 環境の独立）。
 *
 * 既にそのセッションへ projectDir が紐付いていて、実際にまだ存在するなら**作り直さず**それを返す
 * （同じ会話での2回目以降の保存を同じプロジェクトへ集める）。無ければ、タイトルから作った名前
 * （衝突したら「名前-2」…）で `<projectWorkspaceDir>/<名前>/public` を掘り、索引へ記録する。
 *
 * workspaceDir・projectWorkspaceDir はどちらも他の公開関数と同じ検証（assertValidWorkspaceDir）を
 * 通す。失敗は throw ではなく { ok:false, message } で返す（呼び出し元の IPC ハンドラで
 * renderer を落とさないため）。
 */
export function ensureSessionProject(
  workspaceDir: string,
  id: string,
  projectWorkspaceDir: string,
  title: string,
): { ok: boolean; projectDir?: string; created?: boolean; name?: string; message?: string } {
  try {
    assertValidWorkspaceDir(workspaceDir)
    assertValidWorkspaceDir(projectWorkspaceDir)
  } catch (e: any) {
    return { ok: false, message: e?.message ?? '不正なワークスペースパスです' }
  }
  if (!isValidSessionId(id)) return { ok: false, message: '不正な会話IDです' }

  const entry = ensureEntry(workspaceDir)
  const target = entry.sessions.find(s => s.id === id)
  if (!target) return { ok: false, message: 'この会話がまだ登録されていません。少し待ってからもう一度お試しください' }

  // 既にこのセッション専用のプロジェクトがあり、実在するなら作り直さない。
  if (target.projectDir && fs.existsSync(target.projectDir)) {
    return { ok: true, projectDir: target.projectDir, created: false, name: path.basename(target.projectDir) }
  }

  const base = sanitizeChatProjectName(title)
  let name = base
  let dir = path.join(projectWorkspaceDir, name)
  for (let n = 2; fs.existsSync(dir); n++) {
    name = `${base}-${n}`
    dir = path.join(projectWorkspaceDir, name)
  }

  try {
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true }) // public/ 構成で始める（IDE の作業フォルダの作法）
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'プロジェクトの作成に失敗しました' }
  }

  entry.sessions = entry.sessions.map(s => s.id === id ? { ...s, projectDir: dir } : s)
  scheduleSave(workspaceDir, entry)
  notify(workspaceDir, entry.sessions) // rename 等と同じく、変更のたび appSessions:changed が飛ぶ

  return { ok: true, projectDir: dir, created: true, name }
}

/** 保存待ちを即座に書き切る（quit 時・テスト用。learningStore.flushLearningNow と同じ作法）。 */
export function flushAppSessions(): void {
  for (const [workspaceDir, entry] of store) {
    if (!entry.timer) continue
    clearTimeout(entry.timer)
    entry.timer = null
    writeIndexNow(workspaceDir, entry.sessions)
  }
}
