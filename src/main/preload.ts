import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { TurnStartPayload, TurnAsk, TurnEvent, TurnAnswer } from '../shared/chatTurnRpc'

contextBridge.exposeInMainWorld('electronAPI', {
  fs: {
    readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
    writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:writeFile', path, content),
    // AI専用：プロジェクト内に閉じ込めた読み書き（rel はルートからの相対パス）
    readFileInProject: (projectDir: string, rel: string) => ipcRenderer.invoke('fs:readFileInProject', projectDir, rel),
    writeFileInProject: (projectDir: string, rel: string, content: string) => ipcRenderer.invoke('fs:writeFileInProject', projectDir, rel, content),
    openDialog: (opts?: { filters?: { name: string; extensions: string[] }[] }) => ipcRenderer.invoke('fs:openDialog', opts),
    readDir: (path: string) => ipcRenderer.invoke('fs:readDir', path),
    pickDirectory: () => ipcRenderer.invoke('fs:pickDirectory'),
    exists: (path: string) => ipcRenderer.invoke('fs:exists', path),
    readFileBase64: (path: string) => ipcRenderer.invoke('fs:readFileBase64', path),
    // Finder からドロップされた File の絶対パスを得る（Electronの公式API）
    pathForFile: (file: File) => webUtils.getPathForFile(file),
    /** チャットに添付した画像（data URL）を、そのままプロジェクトへ入れる。 */
    importImageData: (projectDir: string, name: string, dataUrl: string, purpose?: 'app' | 'material') =>
      ipcRenderer.invoke('fs:importImageData', { projectDir, name, dataUrl, purpose }),
    /** 手元のファイルをプロジェクトへ複製する。purpose 未指定は 'app'（アプリで使う）。 */
    importFile: (src: string, projectDir: string, purpose?: 'app' | 'material') => ipcRenderer.invoke('fs:importFile', { src, projectDir, purpose }),
    trash: (p: string) => ipcRenderer.invoke('fs:trash', p),
    rename: (oldPath: string, newName: string) => ipcRenderer.invoke('fs:rename', oldPath, newName),
    // フォルダ監視。変更があるたび cb を呼ぶ。戻り値で監視解除。
    watchDir: (dir: string, cb: () => void) => {
      let id: number | null = null
      let ch = ''
      const handler = () => cb()
      ipcRenderer.invoke('fs:watch', dir).then((wid: number) => {
        if (wid >= 0) {
          id = wid
          ch = `fs:changed:${wid}`
          ipcRenderer.on(ch, handler)
        }
      })
      return () => {
        if (id !== null) {
          ipcRenderer.removeListener(ch, handler)
          ipcRenderer.invoke('fs:unwatch', id)
        }
      }
    },
    homeDir: () => ipcRenderer.invoke('fs:homeDir'),
    projectFiles: (dir: string) => ipcRenderer.invoke('fs:projectFiles', dir),
    // AIの search_in_files ツール用：プロジェクト内の全文検索（単純な部分一致）
    searchInProject: (projectDir: string, query: string, pathPattern?: string) =>
      ipcRenderer.invoke('fs:searchInProject', projectDir, query, pathPattern),
    // プロジェクトの最終変更時刻（③公開の「公開状況」で、公開後にコードが変わっていないかの判定に使う）
    latestChangeAt: (projectDir: string) => ipcRenderer.invoke('fs:latestChangeAt', projectDir),
    // 「📡 公開したもの一覧」用: ワークスペース配下の全プロジェクトの公開記録を集める（キー不要・オフライン可）
    publishedRecords: (workspaceDir: string) => ipcRenderer.invoke('fs:publishedRecords', workspaceDir),
    createProject: (
      parentDir: string,
      name: string,
      files: { path: string; content: string }[],
      allowExisting = false,
      withPublishDir = false
    ) => ipcRenderer.invoke('project:create', parentDir, name, files, allowExisting, withPublishDir),
    /** `public/` の形へ移す必要があるか調べる（何も変えない）。 */
    migrateCheck: (projectDir: string) => ipcRenderer.invoke('project:migrateCheck', projectDir),
    /** 実際に移す。失敗したら移した分を元へ戻す。 */
    migrate: (projectDir: string, snapshotId: string) => ipcRenderer.invoke('project:migrate', projectDir, snapshotId),
  },
  term: {
    create: (cwd?: string) => ipcRenderer.invoke('term:create', cwd),
    write: (id: number, data: string) => ipcRenderer.invoke('term:write', id, data),
    resize: (id: number, cols: number, rows: number) => ipcRenderer.invoke('term:resize', id, cols, rows),
    destroy: (id: number) => ipcRenderer.invoke('term:destroy', id),
    onData: (id: number, cb: (data: string) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: string) => cb(data)
      ipcRenderer.on(`term:data:${id}`, handler)
      return () => ipcRenderer.removeListener(`term:data:${id}`, handler)
    },
    onExit: (id: number, cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.once(`term:exit:${id}`, handler)
      return () => ipcRenderer.removeListener(`term:exit:${id}`, handler)
    }
  },
  web: {
    // URLのページ本文を取得（AIに渡す用）。opts.maxChars省略時は既定12000（AIの文脈用の上限）のまま。
    // 資料化用途（RAG書庫行き）は呼び出し側が maxChars を明示的に大きくして渡す。
    fetchPage: (url: string, opts?: { maxChars?: number }) => ipcRenderer.invoke('web:fetch', url, opts),
    // Web検索（Tavily / Brave。AIの search_web ツール用）
    search: (provider: 'tavily' | 'brave', key: string, query: string) =>
      ipcRenderer.invoke('web:search', { provider, key, query }),
  },
  shell: {
    openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p),
    showInFolder: (p: string) => ipcRenderer.invoke('shell:showInFolder', p),
    which: (cmd: string) => ipcRenderer.invoke('shell:which', cmd),
  },
  proc: {
    // AIのrun_commandツール用（プロジェクト内でコマンド実行）
    run: (cwd: string, command: string) => ipcRenderer.invoke('proc:run', { cwd, command }),
  },
  remote: {
    // さくらのレンタルサーバ：SSH/SCP によるリモート操作（読み取りは確認不要・書き込みは呼び出し側で確認）
    test: (host: string, account: string) => ipcRenderer.invoke('remote:test', { host, account }),
    list: (host: string, account: string, path?: string) => ipcRenderer.invoke('remote:list', { host, account, path }),
    download: (host: string, account: string, remotePath: string, localPath: string) =>
      ipcRenderer.invoke('remote:download', { host, account, remotePath, localPath }),
    upload: (host: string, account: string, remotePath: string, localPath: string) =>
      ipcRenderer.invoke('remote:upload', { host, account, remotePath, localPath }),
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:version'),
    onOpenCredentials: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('menu:open-credentials', handler)
      return () => ipcRenderer.removeListener('menu:open-credentials', handler)
    },
    // 「表示 → 公開したもの一覧…」（menu:open-published）。onOpenCredentials と同じ作法。
    onOpenPublished: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('menu:open-published', handler)
      return () => ipcRenderer.removeListener('menu:open-published', handler)
    },
    // 「Koto → 設定…」（⌘,）。設定が画面の中にしか無かったのを、macOS の定位置からも開けるようにした。
    onOpenSettings: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('menu:open-settings', handler)
      return () => ipcRenderer.removeListener('menu:open-settings', handler)
    },
  },
  // 永続データ（storage:*）。値は読まず、扱いだけを調べる。
  storage: {
    /** プロジェクトのデータの扱いを調べる（③公開で保存場所の要否を出す）。 */
    scan: (projectDir: string) => ipcRenderer.invoke('storage:scan', projectDir),
    /** koto-data.js が要るなら置く（既にあれば触らない）。 */
    ensureLayer: (projectDir: string) => ipcRenderer.invoke('storage:ensureLayer', projectDir),
    /** 保存場所の状況（設定画面用）。費用の判断材料をまとめて返す。 */
    status: () => ipcRenderer.invoke('storage:status'),
    /** 保存場所を新しく作る。**呼ぶ前に費用の同意を得ること。** */
    createBucket: (name: string) => ipcRenderer.invoke('storage:createBucket', name),
    /** このプロジェクトの保存場所の設定（用意済みかどうか）。 */
    placement: (projectDir: string) => ipcRenderer.invoke('storage:placement', projectDir),
    /**
     * 保存場所を用意する（サイトの利用開始＋バケット作成＋env.json へ記録）。
     * **課金に直結するので、呼ぶ前に必ず金額を見せて同意を得ること。**
     */
    prepare: (projectDir: string, opts?: { mode?: 'shared' | 'dedicated'; bucket?: string }) =>
      ipcRenderer.invoke('storage:prepare', projectDir, opts),
  },
  // 自動更新（update:*）。判定は main 側（shared/updatePolicy.ts）に集約してあり、
  // renderer は状態を受け取って表示し、押されたら apply を呼ぶだけ。
  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    apply: () => ipcRenderer.invoke('update:apply'),
    /** 更新ログを Finder で表示する（「更新されない」を追える唯一の入口）。 */
    openLog: () => ipcRenderer.invoke('update:openLog'),
    /** 更新の進み具合を購読する（解除関数を返す）。 */
    onState: (cb: (state: unknown) => void) => {
      const handler = (_e: unknown, state: unknown) => cb(state)
      ipcRenderer.on('update:state', handler)
      return () => ipcRenderer.removeListener('update:state', handler)
    },
  },
  sakura: {
    models: (apiKey: string) => ipcRenderer.invoke('sakura:models', apiKey),
    chat: (args: { apiKey: string; model: string; messages: any[]; maxTokens?: number; temperature?: number }) =>
      ipcRenderer.invoke('sakura:chat', args),
    // ストリーミング: onChunk で逐次受け取り、完了時に { usage, aborted?, toolCalls? } を resolve。
    // onStart には「停止」用の関数を渡す（呼ぶと進行中の応答を中断）。
    chatStream: (
      args: { apiKey: string; model: string; messages: any[]; maxTokens?: number; tools?: any[] },
      onChunk: (delta: string) => void,
      onStart?: (abort: () => void) => void,
      /** 推論モデルの「思考」の差分（reasoning_content）。届いた分をそのまま渡す。
       *  本文が出るまで沈黙する推論モデルで、進行中の唯一の手がかりになる（2026-08-03）。 */
      onReasoning?: (delta: string) => void,
    ) => new Promise<{ usage: any; aborted?: boolean; toolCalls?: any[] | null; reasoningText?: string | null }>((resolve, reject) => {
      const id = Math.random().toString(36).slice(2)
      const chunkCh = `sakura:chat-chunk:${id}`
      const doneCh = `sakura:chat-done:${id}`
      const errCh = `sakura:chat-error:${id}`
      const reasonCh = `sakura:chat-reasoning:${id}`
      const onC = (_: any, d: string) => onChunk(d)
      const onR = (_: any, d: string) => onReasoning?.(d)
      const onD = (_: any, info: { usage: any; aborted?: boolean; toolCalls?: any[] | null; reasoningText?: string | null }) => { cleanup(); resolve(info) }
      const onE = (_: any, msg: string) => { cleanup(); reject(new Error(msg)) }
      function cleanup() {
        ipcRenderer.removeListener(chunkCh, onC)
        ipcRenderer.removeListener(doneCh, onD)
        ipcRenderer.removeListener(errCh, onE)
        ipcRenderer.removeListener(reasonCh, onR)
      }
      ipcRenderer.on(reasonCh, onR)
      ipcRenderer.on(chunkCh, onC)
      ipcRenderer.on(doneCh, onD)
      ipcRenderer.on(errCh, onE)
      onStart?.(() => { ipcRenderer.invoke('sakura:chat-abort', id) })
      ipcRenderer.invoke('sakura:chat-stream', { id, ...args }).catch(onE as any)
    }),
  },
  secure: {
    available: () => ipcRenderer.invoke('secure:available'),
    encrypt: (plain: string) => ipcRenderer.invoke('secure:encrypt', plain),
    decrypt: (b64: string) => ipcRenderer.invoke('secure:decrypt', b64),
  },
  cloud: {
    // 認証情報（アクセストークン＋トークンシークレット）の保存・状態・疎通テスト
    saveKey: (token: string, secret: string) => ipcRenderer.invoke('cloud:saveKey', token, secret),
    clearKey: () => ipcRenderer.invoke('cloud:clearKey'),
    hasKey: () => ipcRenderer.invoke('cloud:hasKey'),
    // 保存済みのトークン/シークレットを読み戻す（未保存なら null）。
    // セキュリティ注記: クラウドのトークン/シークレットをレンダラへ返す。
    // AI EngineのAPIキーが既にレンダラで扱われているのと同じトラストレベル
    // （自社・サンドボックス済みレンダラ）であり許容する。
    loadKey: () => ipcRenderer.invoke('cloud:loadKey'),
    testConnection: () => ipcRenderer.invoke('cloud:testConnection'),
    // 環境スペック（.sakura-cloud/env.json）の読み書き・既定生成
    loadEnv: (projectDir: string) => ipcRenderer.invoke('cloud:loadEnv', projectDir),
    saveEnv: (projectDir: string, spec: any) => ipcRenderer.invoke('cloud:saveEnv', projectDir, spec),
    scaffoldEnv: (projectDir: string, name: string) => ipcRenderer.invoke('cloud:scaffoldEnv', projectDir, name),
    /** 公開する前に「本当に通るか」をまとめて確かめる。**何も作らず、何も変えない。** */
    preflight: (projectDir: string) => ipcRenderer.invoke('cloud:preflight', projectDir),
    // 差分プラン算出（ドライラン・API呼び出し無し）
    plan: (projectDir: string) => ipcRenderer.invoke('cloud:plan', projectDir),
    // 段階2a: 構築/破棄の実行（破壊操作は confirmed:true の明示確認が必須）
    apply: (projectDir: string, opts?: { confirmed?: boolean }) => ipcRenderer.invoke('cloud:apply', projectDir, opts),
    teardown: (projectDir: string, opts?: { confirmed?: boolean; deleteRegistry?: boolean }) => ipcRenderer.invoke('cloud:teardown', projectDir, opts),
    // 破棄画面に出すレジストリ名（パスワードは返らない）
    registryName: (projectDir: string) => ipcRenderer.invoke('cloud:registryName', projectDir),
    checkExpiry: (projectDir: string) => ipcRenderer.invoke('cloud:checkExpiry', projectDir),
    // 公開済みか（state.json に apprun-app リソースがあるか）の軽量チェック。APIキー不要。
    isPublished: (projectDir: string) => ipcRenderer.invoke('cloud:isPublished', projectDir),
    // 構築の前提チェック（内蔵ビルダー / レジストリ認証の有無）。
    checkPrereqs: (projectDir: string) => ipcRenderer.invoke('cloud:checkPrereqs', projectDir),
    // コンテナレジストリを自動作成（無ければ作成・あれば再利用）し push 用認証を保存する。
    ensureRegistry: (projectDir: string) => ipcRenderer.invoke('cloud:ensureRegistry', projectDir),
    // デプロイ済み AppRun アプリの公開URLを取得する。
    appUrl: (projectDir: string) => ipcRenderer.invoke('cloud:appUrl', projectDir),
    appHealth: (projectDir: string) => ipcRenderer.invoke('cloud:appHealth', projectDir),
    // さくら側にあるものの棚卸し（**何も作らず、何も消さない**）。
    inventory: (projects: unknown) => ipcRenderer.invoke('cloud:inventory', projects),
    // 限定公開（アクセス制限＝パケットフィルタ）。デプロイ済みアプリの許可IPを読み書きする。
    getAccessLimit: (projectDir: string) => ipcRenderer.invoke('cloud:getAccessLimit', projectDir),
    setAccessLimit: (projectDir: string, payload: { isEnabled: boolean; ips: Array<{ ip: string; prefix: number }> }) => ipcRenderer.invoke('cloud:setAccessLimit', projectDir, payload),
    myIp: () => ipcRenderer.invoke('cloud:myIp'),
    // ビルド方式の切替（標準=builtin / エキスパート=docker）。
    setBuilderMode: (projectDir: string, mode: 'builtin' | 'docker') => ipcRenderer.invoke('cloud:setBuilderMode', projectDir, mode),
    // 当月の利用額（コスト実額）を取得する。
    cost: () => ipcRenderer.invoke('cloud:cost'),
    // 古いイメージの片づけ。**confirmed を付けない呼び出しは「一覧を見るだけ」**で、何も消さない。
    cleanupImages: (projectDir: string, opts?: { confirmed?: boolean; keep?: number }) =>
      ipcRenderer.invoke('cloud:cleanupImages', projectDir, opts),
    // 段階3b: 構築（apply）の進捗メッセージ購読。戻り値の関数を呼ぶと購読解除。
    onApplyProgress: (cb: (msg: string) => void) => {
      const handler = (_: Electron.IpcRendererEvent, msg: string) => cb(msg)
      ipcRenderer.on('cloud:apply-progress', handler)
      return () => ipcRenderer.removeListener('cloud:apply-progress', handler)
    },
  },
  hanamii: {
    // 方式B: トークンは中央ストア（認証情報）から renderer が読んで引数で渡す。
    testConnection: (token: string) => ipcRenderer.invoke('hanamii:testConnection', token),
    listWorkspaces: (token: string) => ipcRenderer.invoke('hanamii:listWorkspaces', token),
    publish: (projectDir: string, opts: { token: string; workspaceId: string; projectId?: string; name: string; envs?: Array<{ key: string; value: string; type?: 'plain' | 'secret' }>; healthCheck?: { enabled: boolean; path: string; port: number | null }; withStorage?: boolean }) => ipcRenderer.invoke('hanamii:publish', projectDir, opts),
    // 古い鍵の片づけ（**動いたと確かめてから呼ぶこと**）。ほかの公開先の鍵には触れない。
    cleanUpKeys: (opts: { projectName: string; keepId: string }) => ipcRenderer.invoke('hanamii:cleanUpKeys', opts),
    status: (projectId: string, token: string) => ipcRenderer.invoke('hanamii:status', projectId, token),
    // A-5: env/ヘルスチェックの変更を再公開（ビルドし直し）なしで反映する高速経路。
    restart: (projectId: string, opts: { token: string; envs?: Array<{ key: string; value: string; type?: 'plain' | 'secret' }>; healthCheck?: { enabled: boolean; path: string; port: number | null } }) =>
      ipcRenderer.invoke('hanamii:restart', projectId, opts),
    teardown: (projectId: string, token: string) => ipcRenderer.invoke('hanamii:teardown', projectId, token),
    detectEnvKeys: (projectDir: string) => ipcRenderer.invoke('hanamii:detectEnvKeys', projectDir),
    logs: (token: string, projectId: string, opts?: { limit?: number; since?: string }) =>
      ipcRenderer.invoke('hanamii:logs', token, projectId, opts),
  },
  // 公開済みのものを引き取る（dev-plan ④）。**読み取りと、選んだあとの取り込みだけ。**
  import: {
    list: (args: { target: 'vercel' | 'sakura-apprun'; token?: string; teamId?: string }) =>
      ipcRenderer.invoke('import:list', args),
    inspect: (args: { target: 'vercel' | 'sakura-apprun'; id: string; token?: string; teamId?: string }) =>
      ipcRenderer.invoke('import:inspect', args),
    // intent は AppRun の「引き継ぎ」に使う（'update' のときだけ .sakura-cloud/ を書く）。
    run: (args: {
      target: 'vercel' | 'sakura-apprun'; id: string; destDir: string
      token?: string; teamId?: string; intent?: 'update' | 'fork' | 'undecided'
    }) => ipcRenderer.invoke('import:run', args),
    /** 取り込みの進み具合（画面に実況を出す）。戻り値は購読解除。 */
    onProgress: (cb: (message: string) => void) => {
      const h = (_: unknown, p: { message: string }) => cb(p?.message ?? '')
      ipcRenderer.on('import:progress', h)
      return () => ipcRenderer.removeListener('import:progress', h)
    },
  },

  vercel: {
    // 方式B: トークン/チームIDは中央ストア（認証情報）から renderer が読んで引数で渡す。main には保存しない。
    testConnection: (token: string, teamId?: string) => ipcRenderer.invoke('vercel:testConnection', token, teamId),
    // 公開する前の確認（何も作らず、何も送らない）。
    preflight: (projectDir: string) => ipcRenderer.invoke('vercel:preflight', projectDir),
    // アップロード→デプロイ作成→READYまでポーリングを一括で行い、完了後に結果を返す。
    publish: (projectDir: string, opts: { token: string; teamId?: string; name: string }) =>
      ipcRenderer.invoke('vercel:publish', projectDir, opts),
    // 公開中の進捗（収集/アップロード n/N/ビルド中…）。戻り値の関数で購読解除する。
    onProgress: (cb: (msg: string) => void) => {
      const h = (_e: unknown, m: string) => cb(m)
      ipcRenderer.on('vercel:progress', h)
      return () => ipcRenderer.removeListener('vercel:progress', h)
    },
  },
  github: {
    // 方式B: トークンは中央ストア（認証情報）から renderer が読んで引数で渡す。
    test: (token: string) => ipcRenderer.invoke('github:test', token),
    createRepo: (token: string, name: string) => ipcRenderer.invoke('github:createRepo', token, name),
    save: (projectDir: string, token: string, repoFullName: string, message?: string) =>
      ipcRenderer.invoke('github:save', projectDir, token, repoFullName, message),
    status: (token: string, repoFullName: string) => ipcRenderer.invoke('github:status', token, repoFullName),
  },
  claude: {
    // 方式B: キーは中央ストア（認証情報）から renderer が読んで引数で渡す。main には保存しない。
    test: (token: string) => ipcRenderer.invoke('claude:test', token),
    // Agent SDK のネイティブCLIバイナリがパッケージから実行できるか確認する（開発者向け・スモークテスト用）。
    binaryCheck: () => ipcRenderer.invoke('claude:binaryCheck'),
    // Claudeモデル一覧のライブ取得（起動時に実際の提供ラインナップを取得する）。方式B: キーは
    // renderer が使う瞬間に読んで渡す（main には保存しない）。失敗時はrenderer側でキャッシュ/既定へフォールバック。
    models: (token: string) => ipcRenderer.invoke('claude:models', token),
    // Claude頭脳モード（C2）: query() を開始する。応答本体は onStream の連続イベントで届く。
    // aiEngineKey は search_docs ツール用（C2b・方式B: renderer が使う瞬間に読んで渡す）。
    // model は C2c（Claudeモデル選択）: renderer が claudeMode.ts の getClaudeModel() を読んで渡す。
    // images は C2d（画像添付ターンをClaude自身に直接処理させる。data URL配列・空配列可）。
    chatStart: (projectDir: string, apiKey: string, prompt: string, images: string[], snapshotId: string, resumeSessionId: string | null, aiEngineKey: string | null, model: string) =>
      ipcRenderer.invoke('claude:chatStart', projectDir, apiKey, prompt, images, snapshotId, resumeSessionId, aiEngineKey, model),
    // 進行中の Claude セッションを中断する。
    chatCancel: () => ipcRenderer.invoke('claude:chatCancel'),
    // ストリームイベント購読。戻り値の関数を呼ぶと購読解除（term.onData と同じパターン）。
    onStream: (cb: (event: any) => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: any) => cb(event)
      ipcRenderer.on('claude:stream', handler)
      return () => ipcRenderer.removeListener('claude:stream', handler)
    },
  },
  vps: {
    // さくらのVPS 公開機能 V1a（①接続の2ルート）。方式B: 秘密鍵・パスワードは renderer が
    // 中央ストア（認証情報）／state から読んで引数で渡す。main には保存しない。
    generateKeypair: () => ipcRenderer.invoke('vps:generateKeypair'),
    buildStartupScript: (publicKey: string) => ipcRenderer.invoke('vps:buildStartupScript', publicKey),
    scanHostKey: (host: string, port: number) => ipcRenderer.invoke('vps:scanHostKey', host, port),
    testConnection: (host: string, port: number, user: string, privateKey: string, fingerprint: string) =>
      ipcRenderer.invoke('vps:testConnection', host, port, user, privateKey, fingerprint),
    // ルートB（既存VPS）: 初回のみパスワードで鍵を設置する。sshd強化は含まない（別途 hardenSshd を呼ぶ）。
    installKeyWithPassword: (host: string, port: number, user: string, password: string, publicKey: string) =>
      ipcRenderer.invoke('vps:installKeyWithPassword', host, port, user, password, publicKey),
    // 鍵認証の疎通確認（testConnection）が取れた後にだけ呼ぶこと（締め出し防止・順序保証）。
    hardenSshd: (host: string, port: number, user: string, privateKey: string, fingerprint: string) =>
      ipcRenderer.invoke('vps:hardenSshd', host, port, user, privateKey, fingerprint),
  },
  registry: {
    // コンテナレジストリ認証情報（レジストリ名・ユーザー名・パスワード）の保存・状態・読戻し・削除。
    // cloud:* と同じ方式。レジストリサーバは `${name}.sakuracr.jp`。
    saveKey: (name: string, user: string, password: string) =>
      ipcRenderer.invoke('registry:saveKey', name, user, password),
    clearKey: () => ipcRenderer.invoke('registry:clearKey'),
    hasKey: () => ipcRenderer.invoke('registry:hasKey'),
    // 保存済みの name/user/password を読み戻す（未保存なら null）。
    // セキュリティ注記: レジストリ資格情報をレンダラへ返す。クラウドのトークン/シークレットと
    // 同じトラストレベル（自社・サンドボックス済みレンダラ）であり許容する。
    loadKey: () => ipcRenderer.invoke('registry:loadKey'),
  },
  rag: {
    // 📚 資料（さくらのAI Engine RAG API）。方式B: apiKey は認証情報の中央ストアから renderer が読んで引数で渡す。
    list: (apiKey: string, opts?: { page?: number; pageSize?: number; name?: string; tag?: string }) =>
      ipcRenderer.invoke('rag:list', apiKey, opts),
    get: (apiKey: string, id: string) => ipcRenderer.invoke('rag:get', apiKey, id),
    upload: (apiKey: string, args: { filePath?: string; content?: string; filename: string; name?: string; tags?: string[] }) =>
      ipcRenderer.invoke('rag:upload', apiKey, args),
    update: (apiKey: string, id: string, fields: { name?: string; tags?: string[] }) =>
      ipcRenderer.invoke('rag:update', apiKey, id, fields),
    delete: (apiKey: string, id: string) => ipcRenderer.invoke('rag:delete', apiKey, id),
    chunks: (apiKey: string, documentId: string, opts?: { page?: number; pageSize?: number }) =>
      ipcRenderer.invoke('rag:chunks', apiKey, documentId, opts),
    query: (apiKey: string, args: { query: string; tags?: string[]; topK?: number; threshold?: number }) =>
      ipcRenderer.invoke('rag:query', apiKey, args),
    chat: (apiKey: string, args: { query: string; chatModel: string; tags?: string[] }) =>
      ipcRenderer.invoke('rag:chat', apiKey, args),
    // R3: Webから作った資料のローカル控えフォルダ（userData/knowledge）の絶対パスを取得（無ければ作成）
    knowledgeDir: () => ipcRenderer.invoke('rag:knowledgeDir'),
  },
  win: {
    // 未保存状態をメインプロセスに通知（終了時の警告に使う）
    setDirty: (dirty: boolean) => ipcRenderer.send('win:dirty', dirty),
    // 実行中状態をメインプロセスに通知（終了時の「実行中です」警告に使う）。label は実行中の処理名。
    setBusy: (busy: boolean, label: string) => ipcRenderer.send('win:busy', busy, label),
    // 「保存して終了」選択時にメインから呼ばれる
    onSaveAll: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('app:save-all', handler)
      return () => ipcRenderer.removeListener('app:save-all', handler)
    },
    // 全保存完了後に終了を実行
    quitAfterSave: () => ipcRenderer.invoke('win:quit-after-save'),
  },
  backup: {
    // ファイルを上書きする直前に呼ぶ（旧内容をこの作業のスナップショットへ退避する）。
    // label は履歴一覧の見出し（ユーザーの指示文・「手動で保存」など）。省略可。
    snapshotBeforeWrite: (projectDir: string, snapshotId: string, rel: string, newContent: string, label?: string) =>
      ipcRenderer.invoke('backup:snapshotBeforeWrite', projectDir, snapshotId, rel, newContent, label),
    // 「🕘 履歴」モーダル用の一覧（新しい順）
    list: (projectDir: string) => ipcRenderer.invoke('backup:list', projectDir),
    // 指定した時点へ復元（対象以降を畳み込んで戻す。現状は新スナップショットへ退避してから上書き）
    restore: (projectDir: string, snapshotId: string) => ipcRenderer.invoke('backup:restore', projectDir, snapshotId),
  },
  chat: {
    // IDEのプロジェクト別チャット履歴（<project>/.sakuraide/chat.json）
    // ⚠️ B'-3c で持ち主が main（convStore.ts）へ移り、ChatPanel はもう呼ばない
    // （下の load/ops に置き換わった）。後方互換のため形は変えずに残す。
    loadProject: (projectDir: string) => ipcRenderer.invoke('chat:loadProject', projectDir),
    saveProject: (projectDir: string, json: string) => ipcRenderer.invoke('chat:saveProject', projectDir, json),
    // 単独チャット（ChatApp）のセッション一覧（<workspace>/.sakuraide/chats/chat-app.json）
    loadApp: (workspaceDir: string) => ipcRenderer.invoke('chat:loadApp', workspaceDir),
    saveApp: (workspaceDir: string, json: string) => ipcRenderer.invoke('chat:saveApp', workspaceDir, json),
    // B'-3c: IDEのプロジェクト別チャットの持ち主（main の convStore.ts）を呼ぶ。
    // 読み込みは chatConvClient.ts の loadConversationView、書き換えは makeConvClient が使う。
    load: (projectDir: string) => ipcRenderer.invoke('chat:load', projectDir),
    ops: (projectDir: string, ops: unknown[], opts?: { flushNow?: boolean }) => ipcRenderer.invoke('chat:ops', projectDir, ops, opts),
    /** B-1a: main の convStore が会話を1件当てるたびに届く通知（画面更新経路の押し出し口）。
     *  renderer 発の書き換え（chat:ops）・main のターンの出来事・🕘「元に戻す」の記録、
     *  すべてこれ1本に集約されている（chat:appended は廃止）。
     *  fs.watchDir と同じ作法で購読解除関数を返す。対象を絞る id 登録は不要（単発の broadcast。
     *  受け手は projectDir が一致するものだけを拾う＝app.onOpenCredentials と同じ簡潔な形）。 */
    onApplied: (cb: (p: { projectDir: string; op: unknown; length: number }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, p: { projectDir: string; op: unknown; length: number }) => cb(p)
      ipcRenderer.on('chat:applied', handler)
      return () => ipcRenderer.removeListener('chat:applied', handler)
    },
  },
  // モデルの「ツール対応」「画像対応」学習キャッシュ（B'-3d-1a）。持ち主は main の
  // learningStore.ts（userData/learning.json）。renderer は起動時に get() で写しを作り、
  // onChanged() の押し出しで最新化する（src/renderer/learningMirror.ts）。
  learning: {
    get: () => ipcRenderer.invoke('learning:get'),
    record: (kind: 'tool' | 'vision', model: string, supported: boolean) =>
      ipcRenderer.invoke('learning:record', kind, model, supported),
    forget: (kind: 'tool' | 'vision', model?: string) => ipcRenderer.invoke('learning:forget', kind, model),
    /** 旧 renderer/localStorage からの片道移行。何度呼んでも安全（main 側が「新しい at だけ勝つ」）。 */
    migrate: (payload: { toolSupport?: unknown; visionSupport?: unknown }) => ipcRenderer.invoke('learning:migrate', payload),
    /** main が学習記録を変えるたび届く通知（chat.onApplied と同じ作法・購読解除関数を返す）。 */
    onChanged: (cb: (snapshot: { toolSupport: unknown; visionSupport: unknown }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, snapshot: { toolSupport: unknown; visionSupport: unknown }) => cb(snapshot)
      ipcRenderer.on('learning:changed', handler)
      return () => ipcRenderer.removeListener('learning:changed', handler)
    },
  },
  // 予算設定・利用実績（B'-3d-1b）。持ち主は main の usageStore.ts（userData/usage.json）。
  // renderer は起動時に get() で写しを作り、onChanged() の押し出しで最新化する
  // （src/renderer/usageMirror.ts）。usage:check は無い（main のターンは usageStore を直接
  // 呼び、renderer 側の読み取りもミラーに対して shared/usageBudget.ts の純関数を直接呼ぶ）。
  usage: {
    get: () => ipcRenderer.invoke('usage:get'),
    record: (fp: string, model: string, promptTokens: number, completionTokens: number) =>
      ipcRenderer.invoke('usage:record', fp, model, promptTokens, completionTokens),
    setSettings: (raw: unknown) => ipcRenderer.invoke('usage:setSettings', raw),
    /** 消すときは { clear: true } を渡す（undefined は IPC で「省略」と区別しにくいため）。 */
    setKeyLimit: (fp: string, limit: number | null | { clear: true }) => ipcRenderer.invoke('usage:setKeyLimit', fp, limit),
    reset: () => ipcRenderer.invoke('usage:reset'),
    /** 旧 renderer/localStorage からの片道移行。main 側の migrated フラグが縛るため、
     *  何度呼んでも二重計上しない（ただし二重に呼んでよいことを保証するのは main 側の責務）。 */
    migrate: (payload: { settings?: unknown; months?: unknown }) => ipcRenderer.invoke('usage:migrate', payload),
    /** main が設定・実績を変えるたび届く通知（learning.onChanged と同じ作法・購読解除関数を返す）。 */
    onChanged: (cb: (snapshot: { settings: unknown; months: unknown }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, snapshot: { settings: unknown; months: unknown }) => cb(snapshot)
      ipcRenderer.on('usage:changed', handler)
      return () => ipcRenderer.removeListener('usage:changed', handler)
    },
  },
  // AI Engine 経路の1ターンを main で走らせる（B'-3b・土台の入れ替え その1）。
  // renderer 側の配線（useAiChat.ts 等）はまだこの API を呼ばない（その2で行う）。
  chatTurn: {
    // main からの出来事（chatTurn:event:{turnId}）と問い合わせ（chatTurn:ask:{turnId}）を購読し、
    // 問い合わせには handlers.onAsk の結果を chatTurn:answer で返す。sakura.chatStream の
    // 「onXxx を購読して invoke が終わったら必ず解除する」流儀と同じにしてある。
    start: (
      payload: TurnStartPayload,
      handlers: {
        onEvent: (ev: unknown) => void
        onActivity: () => void
        onAsk: (path: string, args: unknown[]) => Promise<unknown> | unknown
      },
    ): Promise<{ ok: boolean; endedWithError?: boolean }> => {
      const { turnId } = payload
      const eventCh = `chatTurn:event:${turnId}`
      const askCh = `chatTurn:ask:${turnId}`
      const onEvent = (_: Electron.IpcRendererEvent, ev: TurnEvent) => {
        if (ev.type === 'emit') handlers.onEvent(ev.ev)
        else handlers.onActivity()
      }
      const onAsk = (_: Electron.IpcRendererEvent, ask: TurnAsk) => {
        Promise.resolve()
          .then(() => handlers.onAsk(ask.path, ask.args))
          .then(
            (result) => {
              const a: TurnAnswer = { turnId, callId: ask.callId, ok: true, result }
              ipcRenderer.invoke('chatTurn:answer', a)
            },
            (e: any) => {
              const a: TurnAnswer = { turnId, callId: ask.callId, ok: false, error: String(e?.message ?? e) }
              ipcRenderer.invoke('chatTurn:answer', a)
            },
          )
      }
      ipcRenderer.on(eventCh, onEvent)
      ipcRenderer.on(askCh, onAsk)
      return (ipcRenderer.invoke('chatTurn:start', payload) as Promise<{ ok: boolean; endedWithError?: boolean }>).finally(() => {
        ipcRenderer.removeListener(eventCh, onEvent)
        ipcRenderer.removeListener(askCh, onAsk)
      })
    },
    abort: (turnId: string) => ipcRenderer.invoke('chatTurn:abort', turnId),
  },
})
