import { app, BrowserWindow, dialog, shell, session, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { registerAllHandlers } from './ipc'
import { checkClaudeBinary } from './claude/client'
import { buildFeedbackUrl } from './feedback'
import { applyLoginPath } from './loginPath'
import { sendToWindow } from './windowSend'

const APP_NAME = 'Koto'
const SAKURA_AI_URL = 'https://ai.sakura.ad.jp/'
app.setName(APP_NAME)

let mainWindow: BrowserWindow | null = null
let hasUnsavedChanges = false
let forceQuit = false
// 実行中フラグ（AI応答・公開処理・VPS操作・プロジェクト作成）。renderer の activity.ts が
// win:busy で通知する。終了時、未保存確認より先にこちらを確認する（実行中の中断は実害が大きいため）。
let isBusy = false
let busyLabel = ''

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
  mainWindow.on('close', async (e) => {
    if (forceQuit) return

    // ① 実行中なら最優先で確認する（AI応答・公開処理・VPS操作・プロジェクト作成の途中で閉じると中断される）
    if (isBusy) {
      e.preventDefault()
      const { response } = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        buttons: ['中断して終了', 'キャンセル'],
        defaultId: 1,
        cancelId: 1,
        message: '処理を実行中です',
        detail: `${busyLabel || '処理'}が進行中です。いま閉じると中断されます。よろしいですか？`,
      })
      if (response === 1) return // キャンセル＝閉じない
      // 中断を承諾 → busyを解除して閉じ直す（次の再入で未保存確認に進む or そのまま終了）
      isBusy = false
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
  setBusy: (busy: boolean, label: string) => { isBusy = busy; busyLabel = label },
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
            {
              label: '認証情報（APIキー）…',
              accelerator: 'CmdOrCtrl+,',
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
        { label: `バージョン ${app.getVersion()}（正式版前）`, enabled: false },
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

app.whenReady().then(() => { applyCSP(); buildMenu(); setDockIcon(); createWindow(); runClaudeBinarySmokeCheckIfRequested() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
