import { app, BrowserWindow, dialog, shell, session, Menu } from 'electron'
import { execFileSync } from 'child_process'
import { findOtherKoto } from '../shared/singleInstance'
import type { MenuItemConstructorOptions } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { registerAllHandlers } from './ipc'
import { checkClaudeBinary } from './claude/client'
import { buildFeedbackUrl } from './feedback'
import { applyLoginPath } from './loginPath'
import { sendToWindow } from './windowSend'
import { initUpdater } from './updater'

const APP_NAME = 'Koto'
const SAKURA_AI_URL = 'https://ai.sakura.ad.jp/'
app.setName(APP_NAME)

let mainWindow: BrowserWindow | null = null
let hasUnsavedChanges = false
let forceQuit = false
// 実行中フラグ（AI応答・公開処理・VPS操作・プロジェクト作成）。renderer の activity.ts が
// win:busy で通知する。自動更新の再起動ゲート（isBusy()/busyLabel()・アプリごと終了するので
// AI応答も含めて見る）に使う。
let isBusy = false
let busyLabel = ''
// 「窓を閉じると本当に中断される」実行中フラグ（B'-3d-3）。公開処理・VPS操作・プロジェクト作成
// だけが対象（AI応答は main でターンが完走するようになったため対象外・activity.ts の
// blocksClose コメント参照）。終了確認ダイアログはこちらだけを見る。
let closeBlockingBusy = false
let closeBlockingLabel = ''

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    // 起動直後（レンダラ描画前）のウィンドウ背景。テーマ既定がライトのため白に合わせる
    // （ダーク選択済みユーザーは一瞬白が見えるが、Electron標準の挙動と同じ）。
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,            // レンダラをサンドボックス化（多層防御）
      webSecurity: true,
    }
  })

  // 初回ペイント可能になってから表示する（空ウィンドウのちらつき防止・体感起動を速く）
  mainWindow.once('ready-to-show', () => { mainWindow?.show() })

  // **閉じたら必ず null に戻す。** これを忘れると mainWindow に破棄済みの
  // BrowserWindow が残り、`mainWindow?.webContents` の `?.` をすり抜けて
  // 「Object has been destroyed」で main プロセスごと落ちる（2026-08-09 実機で発生）。
  // macOS はウィンドウを閉じてもアプリが常駐するため、この状態が普通に起きる。
  mainWindow.on('closed', () => { mainWindow = null })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    // mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  const wc = mainWindow.webContents

  // 新規ウィンドウ/ポップアップは開かせず、http(s) は既定ブラウザで開く
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // アプリ自身のURL以外への画面遷移を禁止（外部リンクはブラウザで開く）
  wc.on('will-navigate', (e, url) => {
    const isDev = process.env.NODE_ENV === 'development'
    const internal = isDev ? url.startsWith('http://localhost:5173') : url.startsWith('file://')
    if (!internal) {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) shell.openExternal(url)
    }
  })

  // WebView の作成を禁止
  wc.on('will-attach-webview', (e) => e.preventDefault())

  // 終了時の確認。① 実行中なら最優先で確認（中断されることを明示）→ ② 未保存の変更（既存ロジック）。
  //
  // ── B'-3d-3: ①が見るのは closeBlockingBusy だけ（isBusy 全体ではない）─────────────
  // AI応答は main でターンが完走するようになり、窓を閉じても中断されない（activity.ts の
  // blocksClose コメント参照）。isBusy（自動更新の再起動ゲート用・AI応答も含む）をそのまま
  // ここで見ると、「実際には中断されないのに中断すると警告する」誤りになるため、
  // 「本当に閉じると中断されるもの」だけを別に持つ closeBlockingBusy を見る。
  mainWindow.on('close', async (e) => {
    if (forceQuit) return

    // ① 実行中なら最優先で確認する（公開処理・VPS操作・プロジェクト作成の途中で閉じると中断される）
    if (closeBlockingBusy) {
      e.preventDefault()
      const { response } = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        buttons: ['中断して終了', 'キャンセル'],
        defaultId: 1,
        cancelId: 1,
        message: '処理を実行中です',
        detail: `${closeBlockingLabel || '処理'}が進行中です。いま閉じると中断されます。よろしいですか？`,
      })
      if (response === 1) return // キャンセル＝閉じない
      // 中断を承諾 → busyを解除して閉じ直す（次の再入で未保存確認に進む or そのまま終了）
      closeBlockingBusy = false
      mainWindow!.close()
      return
    }

    // ② 未保存の変更があれば確認ダイアログを出す
    if (!hasUnsavedChanges) return
    e.preventDefault()
    const { response } = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      buttons: ['保存して終了', '保存せずに終了', 'キャンセル'],
      defaultId: 0,
      cancelId: 2,
      message: '未保存の変更があります',
      detail: '保存していない編集内容を、保存してから終了しますか？',
    })
    if (response === 0) {
      // 保存してから終了：レンダラに全保存を依頼し、完了後に閉じる
      sendToWindow(mainWindow, 'app:save-all')
    } else if (response === 1) {
      forceQuit = true
      mainWindow!.close()
    }
    // response === 2（キャンセル）は何もしない
  })
}

// 全ドメインの IPC ハンドラを登録する（実体は src/main/ipc/ 配下。共有状態は deps で注入）。
registerAllHandlers({
  getMainWindow: () => mainWindow,
  setHasUnsavedChanges: (dirty: boolean) => { hasUnsavedChanges = dirty },
  requestQuitAfterSave: () => {
    forceQuit = true
    hasUnsavedChanges = false
    mainWindow?.close()
  },
  setBusy: (busy: boolean, label: string, closeBlocking: boolean, closeBlockingLabelArg: string) => {
    isBusy = busy
    busyLabel = label
    closeBlockingBusy = closeBlocking
    closeBlockingLabel = closeBlockingLabelArg
  },
  hasUnsavedChanges: () => hasUnsavedChanges,
  isBusy: () => isBusy,
  busyLabel: () => busyLabel,
})

// Content-Security-Policy（本番のみ。開発時はViteのHMRを壊さないため適用しない）
function applyCSP() {
  if (process.env.NODE_ENV === 'development') return
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
            "connect-src 'self' https://api.ai.sakura.ad.jp; " +
            "img-src 'self' data:; " +
            "style-src 'self' 'unsafe-inline'; " +
            "font-src 'self' data:; " +
            // Monaco の言語ワーカーが eval を使うため unsafe-eval を許可（その他は厳格に制限）
            "script-src 'self' 'unsafe-eval'; " +
            "worker-src 'self' blob:; " +
            "object-src 'none'; base-uri 'self'; frame-src 'none'",
        ],
      },
    })
  })
}

// ドキュメント表示用ウィンドウ（使い方ガイド・ライセンス一覧など）。
// docs/ 配下の HTML を表示する。パスは app.getAppPath() 基準で解決
// （開発時もパッケージ時(asar内)も loadFile が動く）。
// file をキーに開いているウィンドウを保持し、多重起動を防止する。
const docWindows = new Map<string, BrowserWindow>()

// 絶対パスの HTML をドキュメントウィンドウで開く（ウィンドウ生成＋安全処理の本体）。
// key をキーに開いているウィンドウを保持し、多重起動を防止する。
function openDocWindowAbs(absPath: string, key: string, title: string) {
  const existing = docWindows.get(key)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    title,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  docWindows.set(key, win)
  win.loadFile(absPath)
  // ドキュメント内の http(s) リンクはアプリ内に読み込まず、既定ブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) shell.openExternal(url)
    }
  })
  win.on('closed', () => { docWindows.delete(key) })
}

// docs/ 配下の HTML を表示する。パスは app.getAppPath() 基準で解決
// （開発時もパッケージ時(asar内)も loadFile が動く）。
function openDocWindow(file: string, title: string) {
  openDocWindowAbs(path.join(app.getAppPath(), file), file, title)
}

// Electron 同梱の Chromium 等のライセンス（asar の外＝packaged時は
// process.resourcesPath/licenses/、dev時は node_modules/electron/dist/ にある）を開く。
function openChromiumLicense() {
  const abs = app.isPackaged
    ? path.join(process.resourcesPath, 'licenses', 'LICENSES.chromium.html')
    : path.join(app.getAppPath(), 'node_modules/electron/dist/LICENSES.chromium.html')
  openDocWindowAbs(abs, 'chromium-license', 'Chromium 等のライセンス')
}

// macOS 画面上部のアプリケーションメニュー（ヘルプ含む）
function buildMenu() {
  const isMac = process.platform === 'darwin'
  const isDev = process.env.NODE_ENV === 'development'

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: '',
    copyright: '© 2026 meryo',
  })

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: APP_NAME,
          submenu: [
            { role: 'about', label: `${APP_NAME} について` },
            { type: 'separator' },
            // macOS では ⌘, が設定の定位置。以前はここが「認証情報」だったが、
            // 設定（⚙️）が画面の中にしか無く、メニューから探した利用者が辿り着けなかった
            // （2026-08-11 Ryosuke 指摘）。⌘, は設定に譲り、認証情報はその下に置く。
            {
              label: '設定…',
              accelerator: 'CmdOrCtrl+,',
              click: () => sendToWindow(mainWindow, 'menu:open-settings'),
            },
            {
              label: '認証情報（APIキー）…',
              accelerator: 'CmdOrCtrl+Shift+,',
              click: () => sendToWindow(mainWindow, 'menu:open-credentials'),
            },
            { type: 'separator' },
            { role: 'hide', label: `${APP_NAME} を隠す` },
            { role: 'hideOthers', label: 'ほかを隠す' },
            { role: 'unhide', label: 'すべて表示' },
            { type: 'separator' },
            { role: 'quit', label: `${APP_NAME} を終了` },
          ],
        } as MenuItemConstructorOptions]
      : []),
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '取り消す' },
        { role: 'redo', label: 'やり直す' },
        { type: 'separator' },
        { role: 'cut', label: 'カット' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: 'ペースト' },
        { role: 'selectAll', label: 'すべて選択' },
      ],
    },
    {
      label: '表示',
      submenu: [
        // 「公開したもの一覧」: プロジェクトを開いていなくても見られるようメニューへ置く
        // （サービス側の障害時に「何を公開していたか」を確認する用途・2026-07-31 ユーザー要望）。
        { label: '公開したもの一覧…', click: () => sendToWindow(mainWindow, 'menu:open-published') },
        { type: 'separator' },
        { role: 'reload', label: '再読み込み' },
        ...(isDev ? [{ role: 'toggleDevTools', label: '開発者ツール' } as MenuItemConstructorOptions] : []),
        { type: 'separator' },
        { role: 'resetZoom', label: '実際のサイズ' },
        { role: 'zoomIn', label: '拡大' },
        { role: 'zoomOut', label: '縮小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'フルスクリーン' },
      ],
    },
    {
      label: 'ウインドウ',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: 'ズーム' },
        { role: 'close', label: '閉じる' },
      ],
    },
    {
      role: 'help',
      label: 'ヘルプ',
      submenu: [
        { label: '使い方ガイド', click: () => openDocWindow('docs/usage-guide.html', '使い方ガイド') },
        { label: 'オープンソースライセンス', click: () => openDocWindow('docs/third-party-licenses.html', 'オープンソースライセンス') },
        { label: 'Chromium 等のライセンス（Electron同梱）', click: () => openChromiumLicense() },
        { type: 'separator' },
        { label: `${APP_NAME} について`, click: () => app.showAboutPanel() },
        { label: `バージョン ${app.getVersion()}（ベータ提供中）`, enabled: false },
        { type: 'separator' },
        // A-2: フィードバック導線。リポジトリは private だが友人は協力者として Issues を使える想定（roadmap.md A-2）。
        { label: 'フィードバックを送る…', click: () => shell.openExternal(buildFeedbackUrl(app.getVersion(), os.release(), process.arch)) },
        { label: 'さくらのAI Engine を開く', click: () => shell.openExternal(SAKURA_AI_URL) },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Dock アイコン（macOS・開発時も反映）
function setDockIcon() {
  if (process.platform !== 'darwin' || !app.dock) return
  try {
    const iconPath = path.join(app.getAppPath(), 'build', 'icon.png')
    if (fs.existsSync(iconPath)) app.dock.setIcon(iconPath)
  } catch { /* アイコン設定失敗は無視 */ }
}

// C系 C1-4: パッケージ版から Agent SDK のネイティブバイナリが実行できるかの検証ゲート。
// 通常起動では実行せず、smoke-test.mjs が SMOKE_CLAUDE_BINARY_CHECK=1 を付けて起動したときだけ動く。
async function runClaudeBinarySmokeCheckIfRequested() {
  if (process.env.SMOKE_CLAUDE_BINARY_CHECK !== '1') return
  try {
    const r = await checkClaudeBinary()
    if (r.ok) console.log(`[claude-binary-check] ok ${r.version}`)
    else console.log(`[claude-binary-check] fail ${r.message}`)
  } catch (e: any) {
    console.log(`[claude-binary-check] fail ${e?.message ?? String(e)}`)
  }
}

// GUI（Finder/Dock）起動では PATH が最小限になり、Homebrew等で入れた node/npm/docker が
// 「入っているのに見つからない」状態になる。ウィンドウ生成より前に一度だけ補正する（loginPath.ts 参照）。
// これで proc:run（AIのrun_command）・ターミナル・shell:which の3か所がまとめて直る。
const pathFix = applyLoginPath()
console.log(`[login-path] ${pathFix.ok ? 'ok' : 'skip'}${pathFix.message ? ` (${pathFix.message})` : ''} PATH=${process.env.PATH}`)

// ── 同じ保存領域で2つ動かさない（2026-08-19 の事故）──────────────────────
// Koto の設定とAPIキー（中央ストア）は **localStorage（leveldb）** にある。
// 同じ保存領域を2つのアプリが同時に開くと壊れうる。実際、2026-08-19 に
// スモークテストが利用者と同じ領域でアプリを起動して**強制終了**し、
// leveldb が作り直されて **APIキーが全部消えた**（復元手段は無かった）。
//
// **黙って前の窓を出さない。** 「別の版を試しているつもりで、古い版を見ている」
// のは、この一週間ずっと直してきた「成功に見えて壊れている」と同じ形になる。
// 後から起動したほうは、何が起きたかを伝えて終了する。
/**
 * 同じ保存領域を使う別の Koto が動いていないか、**こちらから見に行く**。
 *
 * `requestSingleInstanceLock` は互いに名乗り合う仕組みなので、**相手が古い版だと
 * 効かない**（2026-08-19 実測: 守りの無い版が先に動いていると、こちらの鍵の要求は
 * 通ってしまい二重起動になる。逆に古い版を後から起動すると、そちらが異常終了した）。
 * 判断は shared/singleInstance.ts。**読めなければ通す**（追加の守りであって唯一の砦ではない）。
 */
function anotherKotoIsRunning(): boolean {
  try {
    const ps = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 3000 })
    const dir = app.getPath('userData')
    const other = findOtherKoto({ psOutput: ps, myPid: process.pid, myUserDataDir: dir })
    // **判断をログに残す。** 効いているかどうかを、あとから推測しないで済むように
    // （[login-path] と同じ流儀。2026-08-19、効かない理由が分からず時間を溶かした）
    console.log(`[single-instance] userData=${dir} other=${other ? other.pid : 'none'}`)
    return other !== null
  } catch (e: any) {
    console.log(`[single-instance] 確認できませんでした: ${e?.message ?? e}`)
    return false
  }
}

function warnAlreadyRunningAndQuit(): void {
  dialog.showMessageBoxSync({
    type: 'warning',
    title: 'Koto はすでに起動しています',
    message: 'Koto はすでに起動しています。',
    detail: '同じ設定を2つのアプリが同時に使うと、APIキーなどの保存が壊れることがあります。'
      + '先に起動している Koto を終了してから、開き直してください。',
    buttons: ['閉じる'],
  })
  app.quit()
}

const gotLock = app.requestSingleInstanceLock()
console.log(`[single-instance] lock=${gotLock}`)
if (!gotLock || anotherKotoIsRunning()) {
  app.whenReady().then(warnAlreadyRunningAndQuit)
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return  // 上で終了処理に入っている
  applyCSP(); buildMenu(); setDockIcon(); createWindow(); runClaudeBinarySmokeCheckIfRequested()
  // 自動更新。既定は「ダウンロードだけして、次回起動時に適用」（勝手に再起動しない）。
  // 配信元が未公開・オフラインでも、状態が error になるだけでアプリの動作には影響しない。
  initUpdater({ getMainWindow: () => mainWindow, autoCheck: true })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
// Dock やアイコンのクリックで飛ぶ。**準備前にも飛ぶ**ので、そのまま窓を作ると
// `Cannot create BrowserWindow before app is ready` で落ちる（2026-08-19 実機）。
// 二重起動で終了しようとしている側でも飛ぶため、鍵を持っていないときも作らない。
app.on('activate', () => {
  if (!app.isReady() || !app.hasSingleInstanceLock()) return
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
