// editorTabs.ts — エディタのタブ（OpenFile）の組み立てと、保存の配線（renderer。React には依存しない）。
//
// 外（端末・Finder・ほかのエディタ・git）で書き換わったファイルを、タブが古い中身で上書きしない。
// タブは「ディスクはこうだったはず」という基準（diskContent）を持ち、保存は main の `fs:writeFileIfUnchanged` に
// その基準を渡して頼む。比べて書くかどうかを決めるのは main（読んでから書くまでを1つの処理で続ける）で、ここは決めない。
//
// 基準を作る・進める場所はこのファイルに集めた（App.tsx は呼ぶだけ）:
//   ・ディスクから読んだとき … loadOpenFile（タブの復元・AI の書き込みの反映・履歴からの復元もここを通る）
//   ・ディスクへ書いたとき   … saveTab（保存）・afterAiWrite（AI の反映）
// 基準を進めるのは、ディスクの中身を実際に読んだ・書いたときだけ。
//
// 書く入口（自動保存・⌘S・プレビュー前・終了時）は、どれも saveTab を通り、止めた印（syncMark）のあるタブは書かない。
// 印を外すのは、利用者が帯で選んだ操作（keepMyEdit・recreateTab・reloadTabFromDisk）か、書けたときだけ。

import { decideTabSync, mayWriteTab, type WriteIfUnchangedResult } from '../shared/editorSync'

/** 保存を止めた理由。main の答え（`fs:writeFileIfUnchanged` の reason）と同じ。 */
export type SaveBlock = Extract<WriteIfUnchangedResult, { ok: false }>['reason']

export interface OpenFile {
  path: string
  name: string
  content: string
  isDirty: boolean
  language: string
  /** 最後にディスクから読んだ・ディスクへ書いた中身。保存のとき「ディスクはこうだったはず」として main に渡す。 */
  diskContent: string
  /** 保存を止めた理由の印（外で変わった・消えた・読めない）。無ければ止まっていない。 */
  syncMark?: SaveBlock
}

const IMAGE_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
}

function imageMime(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXT[ext] ?? null
}

export function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', cs: 'csharp',
    cpp: 'cpp', c: 'c', h: 'c', rb: 'ruby', php: 'php',
    html: 'html', css: 'css', scss: 'scss', json: 'json',
    yaml: 'yaml', yml: 'yaml', md: 'markdown', sh: 'shell',
    sql: 'sql', kt: 'kotlin', swift: 'swift',
  }
  return map[ext] ?? 'plaintext'
}

/** ファイルを OpenFile として読み込む（画像は data URL にしてプレビュー表示用にする）。基準は読んだ中身。 */
export async function loadOpenFile(filePath: string): Promise<OpenFile> {
  const name = filePath.split('/').pop() ?? filePath
  const mime = imageMime(name)
  if (mime) {
    const b64 = await window.electronAPI.fs.readFileBase64(filePath)
    const content = `data:${mime};base64,${b64}`
    // 画像は書かない（編集も保存もしない）ので、基準は表示用の中身と同じにしておく
    return { path: filePath, name, content, isDirty: false, language: 'image', diskContent: content }
  }
  const content = await window.electronAPI.fs.readFile(filePath)
  return { path: filePath, name, content, isDirty: false, language: detectLanguage(name), diskContent: content }
}

/** 複数を順に読み込む（タブの復元）。移動・削除されて読めないものは飛ばす。 */
export async function loadOpenFiles(paths: string[]): Promise<OpenFile[]> {
  const files: OpenFile[] = []
  for (const p of paths) {
    try { files.push(await loadOpenFile(p)) } catch { /* 移動・削除されたファイルはスキップ */ }
  }
  return files
}

/**
 * ディスクから読み直したタブ `loaded` を、開いている同じパスのタブ `current` へ当てる。
 *   ・未保存の編集が無い … 読み直したタブで置き換える（捨てる編集が無い。印も外れる）
 *   ・未保存の編集があり、ディスクがその編集と同じ中身 … 同じく置き換える（編集はすでにディスクにある）
 *   ・未保存の編集があり、ディスクが基準のまま … 何も変わっていないので、そのまま残す（止めた印だけ外す）
 *   ・未保存の編集があり、ディスクが外で変わった … 編集は捨てず、外で変わった印を立てて残す（利用者が帯で選ぶ）
 * 印のあるタブは編集を画面の中だけに持っているので、ディスクの版で黙って置き換えると、その編集は 🕘 にも残らず消える。
 */
function applyDisk(current: OpenFile, loaded: OpenFile): OpenFile {
  if (!current.isDirty || loaded.language === 'image') return loaded
  const verdict = decideTabSync({ baseline: current.diskContent, content: current.content, isDirty: true, disk: loaded.diskContent })
  if (verdict === 'adopt') return loaded
  if (verdict === 'unchanged') {
    const { syncMark: _mark, ...rest } = current
    return rest
  }
  return current.syncMark === 'changed' ? current : { ...current, syncMark: 'changed' }
}

/** 読み込んだタブを当てる（開いていなければ末尾に足す）。AI が書いたファイルの反映・プロジェクト切替後の表示で使う。未保存の編集は捨てない（applyDisk）。 */
export function upsertLoaded(files: OpenFile[], file: OpenFile): OpenFile[] {
  if (files.some(f => f.path === file.path)) return files.map(f => f.path === file.path ? applyDisk(f, file) : f)
  return [...files, file]
}

/**
 * AI の反映（利用者が押した「反映」）でファイルを書いたあとの一覧。開いているタブは中身を差し替え、
 * 基準も書いた中身へ進める。印は外す（書いたので、止める理由が無くなった）。
 */
export function afterAiWrite(files: OpenFile[], full: string, content: string): OpenFile[] {
  const ex = files.find(f => f.path === full)
  if (ex) {
    const { syncMark: _mark, ...rest } = ex
    return files.map(f => f.path === full ? { ...rest, content, isDirty: false, diskContent: content } : f)
  }
  const name = full.split('/').pop() ?? full
  return [...files, { path: full, name, content, isDirty: false, language: detectLanguage(name), diskContent: content }]
}

/** 履歴からの復元で書き換わったタブをディスクから読み直す。読めなければ入れない（据え置き＝基準も古いまま）。 */
export async function reloadOpenFiles(files: OpenFile[], restoredAbs: Set<string>): Promise<Map<string, OpenFile>> {
  const reloaded = new Map<string, OpenFile>()
  for (const f of files) {
    if (!restoredAbs.has(f.path)) continue
    try { reloaded.set(f.path, await loadOpenFile(f.path)) } catch { /* 読めなければ据え置き */ }
  }
  return reloaded
}

/**
 * 復元の結果を一覧へ当てる。消えたファイルのタブは閉じ、読み直したタブは読み直した中身（と基準）で置き換える。
 * 未保存の編集があるタブは、閉じも置き換えもしない: 消えたものは消えた印で残し、読み直したものは applyDisk の約束に従う。
 */
export function applyReloaded(files: OpenFile[], deletedAbs: Set<string>, reloaded: Map<string, OpenFile>): OpenFile[] {
  return files.flatMap(f => {
    if (deletedAbs.has(f.path)) return f.isDirty ? markTab([f], f.path, 'missing') : []
    const next = reloaded.get(f.path)
    return [next ? applyDisk(f, next) : f]
  })
}

// ── 保存 ──────────────────────────────────────────────────────────────────

/**
 * 保存の結果。書いた（ok）か、書かずに止めた理由か。
 * `closed` は、保存の間にタブが閉じられた回（作り直しでは、作り直しを待つタブでない回）。
 */
export type SaveResult = { ok: true } | { ok: false; reason: SaveBlock | 'closed' }

/** 書くのに失敗した（権限・空き容量）回は、今までどおり例外のまま投げる。結果の型は、その失敗も足せる形にしてある。 */
type SaveOutcome = { ok: true } | { ok: false; reason: SaveBlock }

const BLOCKS: readonly SaveBlock[] = ['changed', 'missing', 'unreadable']

/**
 * main の答えを読む。**書いたと読めるのは `ok: true` のときだけ**。形の違う答え・知らない理由は、
 * 書けたと確かめられないので「読めない」（書いていない）に倒す。
 */
export function readSaveOutcome(raw: unknown): SaveOutcome {
  const r = raw as { ok?: unknown; reason?: unknown } | null | undefined
  if (r?.ok === true) return { ok: true }
  const reason = BLOCKS.find(b => b === r?.reason)
  return { ok: false, reason: reason ?? 'unreadable' }
}

/**
 * 保存の答えを一覧へ当てる。`expected` は保存のとき main に渡した基準。null は「無いときだけ作る」形（外で消えたタブの作り直し）。
 *   ・書けた … 基準を書いた中身へ進め、印を外す。未保存の印（isDirty）を戻すのは、タブの中身が保存した中身のままのときだけ
 *     （書いている間に打った文字は、まだディスクに無い）。
 *   ・書かずに止めた … 印を立てる。中身・基準・未保存の印は変えない。同じ印がすでにあれば一覧をそのまま返す
 *     （同じ答えで描き直さない＝自動保存のやり直しの連鎖を起こさない）。
 * 保存している間にタブの基準が別の読み込みで進んでいたとき（`expected` と違う）は、その読み込みを優先して何もしない。
 * 作り直し（`expected` が null）では、タブが「消えた」印のままのときだけ当てる。
 */
export function settleSave(files: OpenFile[], path: string, saved: string, expected: string | null, outcome: SaveOutcome): OpenFile[] {
  const tab = files.find(f => f.path === path)
  if (!tab) return files
  if (expected === null ? tab.syncMark !== 'missing' : tab.diskContent !== expected) return files
  if (!outcome.ok) {
    if (tab.syncMark === outcome.reason) return files
    return files.map(f => f === tab ? { ...f, syncMark: outcome.reason } : f)
  }
  const { syncMark: _mark, ...rest } = tab
  const next: OpenFile = { ...rest, diskContent: saved, isDirty: tab.content === saved ? false : tab.isDirty }
  return files.map(f => f === tab ? next : f)
}

/** 保存の処理が App のタブの一覧とやり取りする口。 */
export interface SaveDeps {
  /** いまのタブの一覧（更新を待たない最新）。 */
  getFiles(): OpenFile[]
  updateFiles(update: (prev: OpenFile[]) => OpenFile[]): void
  /** 書く前の退避（🕘）。失敗しても保存は止めない（呼ぶ側が握りつぶす）。 */
  beforeWrite(path: string, content: string): Promise<void>
}

// 同じファイルの保存は順に行う。続けて2回頼むと、2回目は1回目が書いた中身を知らないまま基準を渡し、
// 外で変わっていないのに「変わった」と止めてしまうため（1回目が終わってから基準を読む）。
// 帯の操作（読み直して基準を進める・作り直す）も同じ列に並べ、保存と入り混じらないようにする。
const saveChains = new Map<string, Promise<unknown>>()

function inChain<T>(filePath: string, job: () => Promise<T>): Promise<T> {
  const prev = saveChains.get(filePath) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(job)
  saveChains.set(filePath, run)
  const forget = () => { if (saveChains.get(filePath) === run) saveChains.delete(filePath) }
  run.then(forget, forget)
  return run
}

/**
 * タブの中身を保存する。退避（🕘）→ 基準を渡して `fs:writeFileIfUnchanged` の順。
 * 外で変わった・消えた・読めない回は書かず、印を立てて返す（黙って上書きしない）。
 * 書くものが無いタブ（未保存の編集も止めた印も無い）には、何も頼まず ok を返す。
 */
export function saveTab(deps: SaveDeps, filePath: string, content: string): Promise<SaveResult> {
  return inChain(filePath, () => saveNow(deps, filePath, content))
}

/** 保存するものがあるタブか。未保存の編集があるか、止めた印がある（印のあるタブは「もう一度保存する」で書き直す）。 */
export function hasUnsaved(tab: Pick<OpenFile, 'isDirty' | 'syncMark'>): boolean {
  return tab.isDirty || !!tab.syncMark
}

/** 退避の前に、ディスクの中身を読む。消えた・読めない回は null（どちらも書かずに止まる側）。 */
async function readDiskText(filePath: string): Promise<string | null> {
  try { return await window.electronAPI.fs.readFile(filePath) } catch { return null }
}

/**
 * `knownDisk` は、直前に読んだディスクの中身（null は読めなかった）。渡されなければここで読む。
 * 退避の可否を決めるためだけに読む（書くかどうかを決めるのは、書く直前に読み直す main）。
 */
async function saveNow(deps: SaveDeps, filePath: string, content: string, knownDisk?: string | null): Promise<SaveResult> {
  const first = deps.getFiles().find(f => f.path === filePath)
  if (!first) return { ok: false, reason: 'closed' }
  // 未保存の編集が無く印も無いタブには書くものが無い。頼むと、外で変わっただけのタブに「自分の編集を保存する」の帯が出る
  if (!hasUnsaved(first)) return { ok: true }
  // 退避（🕘）は書けそうなときだけ。書かずに止める回に残すと、保存していないのに「自分で編集して保存」の履歴ができる
  const disk = knownDisk !== undefined ? knownDisk : await readDiskText(filePath)
  if (mayWriteTab({ baseline: first.diskContent, content, disk }) !== 'conflict') await deps.beforeWrite(filePath, content)
  // 基準は書く直前に読む（退避を待つ間に読み直されていることがある）
  const tab = deps.getFiles().find(f => f.path === filePath)
  if (!tab) return { ok: false, reason: 'closed' }
  const expected = tab.diskContent
  const outcome = readSaveOutcome(await window.electronAPI.fs.writeFileIfUnchanged(filePath, content, expected))
  deps.updateFiles(files => settleSave(files, filePath, content, expected, outcome))
  return outcome
}

// ── 書く入口の共通の約束 ────────────────────────────────────────────────────

/**
 * 自動保存が書いてよいタブ。未保存で、止めた印が無いもの。
 * 印のあるタブは、利用者が帯で選ぶまで自動では書かない（外の版を黙って上書きしない。同じ答えを周期ごとに繰り返さない）。
 * 印は中身を見ずに「あるか」だけで判断する（知らない値の印も、書かない側）。
 */
export function autosaveTargets(files: OpenFile[]): OpenFile[] {
  return files.filter(f => f.isDirty && !f.syncMark)
}

/** プレビュー前の保存が使う口。 */
export interface PreviewDeps {
  save(path: string, content: string): Promise<SaveResult>
  open(path: string): Promise<unknown>
}

/**
 * ブラウザでプレビューする。未保存の編集がある・止めた印があるタブは、先に保存を頼み（待つ）、書かずに止まったら開かない
 * （外の版を見せない）。どちらも無いタブは、保存を頼まずにそのまま開く（開くのはディスクの版。編集が無いので、先に書くものが無い）。
 * 開いたかどうかを返す。
 */
export async function previewTab(tab: Pick<OpenFile, 'path' | 'content' | 'isDirty' | 'syncMark'>, deps: PreviewDeps): Promise<boolean> {
  if (hasUnsaved(tab)) {
    const saved = await deps.save(tab.path, tab.content)
    if (!saved.ok) return false
  }
  await deps.open(tab.path)
  return true
}

/** 終了時の保存が使う口。 */
export interface QuitDeps extends SaveDeps {
  /** 保存できなかったタブがあるとき、終了せずに利用者へ知らせる。 */
  notifyUnsaved(unsaved: OpenFile[]): void
  /** 全部保存できたときだけ呼ぶ。 */
  quit(): Promise<unknown>
}

/**
 * 未保存のタブをすべて saveTab で保存し、保存したあとも未保存のまま残ったタブを返す。
 * 外で変わった・消えた・読めない（印が立つ）、書くのに失敗した、保存の間に打った文字が残った、のどれもここに残る。
 * 書くのに失敗した回（権限・空き容量）は投げずに受ける（そのタブは未保存のまま残る）。
 */
export async function saveAllDirty(deps: SaveDeps): Promise<OpenFile[]> {
  const dirty = deps.getFiles().filter(f => f.isDirty)
  await Promise.all(dirty.map(f => saveTab(deps, f.path, f.content).catch(() => undefined)))
  return deps.getFiles().filter(f => f.isDirty)
}

/**
 * 「保存して終了」。未保存のタブをすべて保存し（saveAllDirty）、全部書けたときだけ終了する。
 * 保存できなかったタブがあれば終了せず、そのタブを知らせる（黙って断られて編集を失わない）。終了したかを返す。
 */
export async function saveAllAndQuit(deps: QuitDeps): Promise<boolean> {
  const unsaved = await saveAllDirty(deps)
  if (unsaved.length > 0) {
    deps.notifyUnsaved(unsaved)
    return false
  }
  await deps.quit()
  return true
}

/** プロジェクトを切り替える前の保存が使う口。 */
export interface LeaveDeps extends SaveDeps {
  /** 保存できなかったタブがあるとき、捨ててよいか利用者に確かめる。true なら捨てる。 */
  confirmDiscard(unsaved: OpenFile[]): Promise<boolean>
}

/**
 * プロジェクトを切り替える前の保存。切り替えるとタブはまるごと入れ替わる（画面の中だけにある編集は消え、🕘 にも残らない）ので、
 * 未保存のタブを先に保存し（saveAllDirty）、保存できなかったものが残れば、捨ててよいかを確かめる。切り替えてよいかを返す。
 * 確かめる前に保存するので、確認が出るのは編集を本当に捨てることになるときだけ。答えが true でなければ切り替えない。
 */
export async function saveBeforeLeave(deps: LeaveDeps): Promise<boolean> {
  const unsaved = await saveAllDirty(deps)
  if (unsaved.length === 0) return true
  return (await deps.confirmDiscard(unsaved)) === true
}

// ── 帯の操作（利用者が選んだとき）──────────────────────────────────────────

/** 「自分の編集を保存する」が使う口。保存の口に、履歴の時点を新しく始める操作を足したもの。 */
export interface KeepDeps extends SaveDeps {
  /** 次の退避を新しい時点から始める（5分間は同じ時点にまとめるため、空にしないと外の版が履歴に残らない）。 */
  resetSnapshotGroup(): void
}

/**
 * 「自分の編集を保存する」。外の版を履歴（🕘）に残してから、自分の中身で上書きする。
 * 順序: 履歴の時点を新しくする → 外の版を読み直す → 読み直した版を基準にする → 退避（外の版が残る）→ 基準を渡して書く。
 * 読み直したあとにさらに変わっていれば、main が書かずに止め、帯に戻る（その版が上書きで消えない）。
 * 読み直せなかった回（消えた・読めない）は基準を変えず、ふつうの保存へ進む（main が理由を言い分けて止める）。
 */
export function keepMyEdit(deps: KeepDeps, filePath: string): Promise<SaveResult> {
  return inChain<SaveResult>(filePath, async () => {
    if (!deps.getFiles().some(f => f.path === filePath)) return { ok: false, reason: 'closed' }
    deps.resetSnapshotGroup()
    let current: string | null = null
    try { current = await window.electronAPI.fs.readFile(filePath) } catch { /* 読めない回は下のふつうの保存で理由が分かる */ }
    if (current !== null) {
      const disk = current
      deps.updateFiles(files => files.map(f => f.path === filePath ? { ...f, diskContent: disk } : f))
    }
    const tab = deps.getFiles().find(f => f.path === filePath)
    if (!tab) return { ok: false, reason: 'closed' }
    return saveNow(deps, filePath, tab.content, current)
  })
}

/**
 * 「自分の内容で作り直す」。外で消えた・移されたタブを、自分の内容で作り直す。
 * **無いときだけ書く**（基準に null を渡す）。その間に外で作られていたら書かず、衝突の帯に戻る。
 * 履歴への退避はしない（退避する元の中身が無い）。
 */
export function recreateTab(deps: Pick<SaveDeps, 'getFiles' | 'updateFiles'>, filePath: string): Promise<SaveResult> {
  return inChain<SaveResult>(filePath, async () => {
    const tab = deps.getFiles().find(f => f.path === filePath)
    if (!tab || tab.syncMark !== 'missing') return { ok: false, reason: 'closed' }
    const content = tab.content
    const outcome = readSaveOutcome(await window.electronAPI.fs.writeFileIfUnchanged(filePath, content, null))
    deps.updateFiles(files => settleSave(files, filePath, content, null, outcome))
    return outcome
  })
}

/** タブに止めた印を立てる（同じ印がすでにあれば一覧をそのまま返す）。 */
function markTab(files: OpenFile[], path: string, reason: SaveBlock): OpenFile[] {
  const tab = files.find(f => f.path === path)
  if (!tab || tab.syncMark === reason) return files
  return files.map(f => f === tab ? { ...f, syncMark: reason } : f)
}

/**
 * 「外の内容を読み込む」。ディスクから読み直し、タブをその中身と基準で置き換える（未保存の編集は捨てる。確認は呼ぶ側が済ませる）。
 * 読めなかった回は、タブをそのまま残し（編集を捨てない）、消えたのか読めないのかを印にする。
 * 分けるのは main に聞く（`fs:readCheck`。保存の口と同じ分類で、ファイルが無い `ENOENT` だけが「消えた」。例外の文面は読まない）。
 * 保存と同じ列に並べる（保存の最中に読み直して、保存の答えと入れ違いにならないため）。
 */
export function reloadTabFromDisk(deps: Pick<SaveDeps, 'updateFiles'>, filePath: string): Promise<boolean> {
  return inChain(filePath, async () => {
    try {
      const file = await loadOpenFile(filePath)
      deps.updateFiles(files => files.some(f => f.path === filePath) ? files.map(f => f.path === filePath ? file : f) : files)
      return true
    } catch {
      let kind: unknown = 'unreadable'
      try { kind = await window.electronAPI.fs.readCheck(filePath) } catch { /* 分からなければ「読めない」側 */ }
      deps.updateFiles(files => markTab(files, filePath, kind === 'missing' ? 'missing' : 'unreadable'))
      return false
    }
  })
}
