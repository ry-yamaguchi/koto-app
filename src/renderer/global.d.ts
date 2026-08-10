interface FileEntry {
  name: string
  isDir: boolean
  path: string
}

// ── 📚 資料（さくらのAI Engine RAG API）の型。main 側 rag/parse.ts と一致させること ──
type RagDocumentStatus = 'pending' | 'processing' | 'available' | 'error' | 'deleted'
interface RagDocument {
  id: string
  name: string
  status: RagDocumentStatus | string
  tags: string[]
  model: string | null
  chunkSize: number | null
  chunkCount: number | null
  errorMessage: string | null
  content: string | null
  createdAt: string | null
  updatedAt: string | null
}
interface RagChunk {
  document: string | null
  chunkIndex: number | null
  content: string
  metadata: Record<string, unknown> | null
}
interface RagQueryHit {
  document: RagDocument | null
  chunkIndex: number | null
  distance: number | null
  content: string
  metadata: Record<string, unknown> | null
}
interface RagPageMeta {
  page: number | null
  pageSize: number | null
  totalPages: number | null
  count: number | null
  next: string | null
  previous: string | null
}

// ── さくらのクラウド連携（段階1）の型。main 側 cloud/spec.ts・planner.ts と一致させること ──
type CloudServiceSource =
  | { type: 'dockerfile'; context: string; image?: string; tag?: string }
  | { type: 'image'; ref: string }
interface CloudEnvSpec {
  version: number
  name: string
  provider: 'sakura-cloud'
  backend: 'apprun'
  region: string
  service: {
    source: CloudServiceSource
    port: number
    env: { name: string; value: string }[]
    secrets: { name: string; ref: string }[]
    scale: { min: number; max: number }
  }
  persistence: { objectStorage: { bucket: string }[] }
  guardrails: { ttlHours: number }
  // このプロジェクトの公開に使うクラウドキーのピン留め（任意）。EnvSpec の AuthSpec と一致させること。
  auth?: { keyId?: string; keyLabel?: string }
}
type CloudResourceKind = 'registry' | 'image' | 'apprun-app' | 'bucket'
interface CloudPlanAction {
  type: 'create' | 'update' | 'delete' | 'noop'
  kind: CloudResourceKind
  name: string
  stateful: boolean
  destructive: boolean
  description: string
}
interface CloudPlan {
  actions: CloudPlanAction[]
  hasDestructive: boolean
  hasStatefulDelete: boolean
}

// ── Claude頭脳モード（C2a/C2b）のストリームイベント型。main側 claude/events.ts の UiEvent と一致させること ──
type ClaudeUiEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'result'; costUsd: number; durationMs: number; isError: boolean }
  | { kind: 'error'; message: string }
  // C2b: open_preview ツールの副作用通知（renderer が従来の open_preview ツールと同じ処理で開く）
  | { kind: 'openPreview'; path: string }
  // C3: delegate_implementation の実行後（AI Engine 側の使用量を usage.ts へ記録するために使う）
  | { kind: 'delegated'; model: string; promptTokens: number; completionTokens: number }
  // Claude/委譲がファイルを書き込んだ直後（データ喪失バグ修正・2026-07-11）。
  // 開きタブをディスクから読み直す（stale tab のオートセーブ上書き防止）
  | { kind: 'fileWritten'; path: string }

// ── 「前の状態に戻す」（P2-⑧）の型。main 側 backup/plan.ts と一致させること ──
type BackupFileAction = 'overwrite' | 'create' | 'pre-restore'
interface BackupManifestFileEntry {
  path: string
  action: BackupFileAction
}
interface BackupSnapshotSummary {
  id: string
  createdAt: string
  /** この作業が何だったか（ユーザーの指示文の先頭・「手動で保存」など）。古い履歴には無い。 */
  label?: string
  /** この作業で変わったファイル数。 */
  fileCount: number
  files: BackupManifestFileEntry[]
  /** この時点に戻したときに変わるファイル数（対象以降を畳み込んだ累計）。 */
  restoreCount: number
  /** そのうち削除されるファイル数（この時点より後に新規作成されたもの）。 */
  deleteCount: number
}

interface Window {
  electronAPI: {
    fs: {
      readFile(path: string): Promise<string>
      writeFile(path: string, content: string): Promise<void>
      readFileInProject(projectDir: string, rel: string): Promise<string>
      writeFileInProject(projectDir: string, rel: string, content: string): Promise<void>
      openDialog(opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<string | null>
      readDir(path: string): Promise<FileEntry[]>
      pickDirectory(): Promise<string | null>
      exists(path: string): Promise<boolean>
      readFileBase64(path: string): Promise<string>
      pathForFile(file: File): string
      importFile(src: string, projectDir: string): Promise<string>
      trash(p: string): Promise<void>
      rename(oldPath: string, newName: string): Promise<string>
      watchDir(dir: string, cb: () => void): () => void
      homeDir(): Promise<string>
      projectFiles(dir: string): Promise<string[]>
      // AIの search_in_files ツール用：プロジェクト内の全文検索（単純な部分一致・大文字小文字は区別しない）
      searchInProject(projectDir: string, query: string, pathPattern?: string): Promise<{
        ok: boolean
        matches: { path: string; line: number; text: string }[]
        scanned: number
        truncated: boolean
        message?: string
      }>
      // プロジェクトの最終変更時刻（③公開の「公開状況」で、公開後にコードが変わっていないかの判定に使う）
      latestChangeAt(projectDir: string): Promise<{ ok: boolean; latest: string | null; files: number; message?: string }>
      /** 「📡 公開したもの一覧」用: ワークスペース配下の全プロジェクトの公開記録（ローカルの記録であり、
       *  各サービスの現在の状態ではない）。publish は .sakuraide.json の publish、apprunState は
       *  .sakura-cloud/state.json（AppRunのレガシー救済用）。 */
      publishedRecords(workspaceDir: string): Promise<{
        ok: boolean
        projects: { dir: string; name: string; publish: unknown; apprunState: unknown }[]
        message?: string
      }>
      createProject(
        parentDir: string,
        name: string,
        files: { path: string; content: string }[],
        allowExisting?: boolean
      ): Promise<{ root: string; merged: boolean; skipped: string[] }>
    }
    term: {
      create(cwd?: string): Promise<number>
      write(id: number, data: string): Promise<void>
      resize(id: number, cols: number, rows: number): Promise<void>
      destroy(id: number): Promise<void>
      onData(id: number, cb: (data: string) => void): () => void
      onExit(id: number, cb: () => void): () => void
    }
    web: {
      // opts.maxChars省略時は既定12000（AIの文脈に渡す用の上限）。資料化用途は大きい値を明示指定する。
      fetchPage(url: string, opts?: { maxChars?: number }): Promise<{ url: string; title: string; content: string }>
      search(provider: 'tavily' | 'brave', key: string, query: string): Promise<{ title: string; url: string; description: string }[]>
    }
    shell: {
      openPath(p: string): Promise<string>
      showInFolder(p: string): Promise<void>
      which(cmd: string): Promise<string | null>
    }
    proc: {
      run(cwd: string, command: string): Promise<{ code: number; timedOut: boolean; stdout: string; stderr: string }>
    }
    remote: {
      test(host: string, account: string): Promise<{ ok: boolean; message?: string }>
      list(host: string, account: string, path?: string): Promise<{ ok: boolean; path?: string; entries?: { name: string; isDir: boolean }[]; message?: string }>
      download(host: string, account: string, remotePath: string, localPath: string): Promise<{ ok: boolean; localPath?: string; message?: string }>
      upload(host: string, account: string, remotePath: string, localPath: string): Promise<{ ok: boolean; backedUp: boolean; backupPath?: string | null; message?: string }>
    }
    app: {
      getVersion(): Promise<string>
      onOpenCredentials(cb: () => void): () => void
      /** 「表示 → 公開したもの一覧…」メニューの購読（解除関数を返す）。 */
      onOpenPublished(cb: () => void): () => void
    }
    /** 自動更新。判定は main 側（shared/updatePolicy.ts）にあり、ここは表示と操作のみ。 */
    update: {
      /** いまの状態を取る（画面を開いた直後に一度）。 */
      state(): Promise<import('../shared/updatePolicy').UpdateState>
      /** 手動で確認する。 */
      check(): Promise<import('../shared/updatePolicy').UpdateState>
      /** いますぐ再起動して適用する。作業中なら断られ、理由が返る。 */
      apply(): Promise<import('../shared/updatePolicy').ApplyDecision>
      /** 状態の変化を購読する（解除関数を返す）。 */
      onState(cb: (state: import('../shared/updatePolicy').UpdateState) => void): () => void
    }
    sakura: {
      models(apiKey: string): Promise<string[]>
      chat(args: { apiKey: string; model: string; messages: { role: string; content: any }[]; maxTokens?: number; temperature?: number }): Promise<{ content: string; usage: { prompt_tokens?: number; completion_tokens?: number } | null }>
      chatStream(
        args: { apiKey: string; model: string; messages: { role: string; content: any; tool_calls?: any[]; tool_call_id?: string }[]; maxTokens?: number; tools?: any[] },
        onChunk: (delta: string) => void,
        onStart?: (abort: () => void) => void,
        /** 推論モデルの「思考」の差分。届いた分をそのまま渡す（進行中の表示に使う）。 */
        onReasoning?: (delta: string) => void,
      ): Promise<{ usage: { prompt_tokens?: number; completion_tokens?: number } | null; aborted?: boolean; toolCalls?: any[] | null; reasoningText?: string | null }>
    }
    secure: {
      available(): Promise<boolean>
      encrypt(plain: string): Promise<string | null>
      decrypt(b64: string): Promise<string>
    }
    cloud: {
      saveKey(token: string, secret: string): Promise<{ ok: boolean; message?: string }>
      clearKey(): Promise<{ ok: boolean; message?: string }>
      hasKey(): Promise<boolean>
      // 保存済みのトークン/シークレットを読み戻す（未保存なら null）
      loadKey(): Promise<{ token: string; secret: string } | null>
      testConnection(): Promise<{ ok: boolean; checks: { apprun: { ok: boolean; status?: number; message?: string }; registry: { ok: boolean; status?: number; message?: string }; billing: { ok: boolean; status?: number; message?: string } }; message?: string }>
      loadEnv(projectDir: string): Promise<{ ok: true; spec: CloudEnvSpec | null } | { ok: false; errors: string[] }>
      saveEnv(projectDir: string, spec: CloudEnvSpec): Promise<{ ok: true; spec: CloudEnvSpec } | { ok: false; errors: string[] }>
      scaffoldEnv(projectDir: string, name: string): Promise<{ ok: true; spec: CloudEnvSpec } | { ok: false; errors: string[] }>
      plan(projectDir: string): Promise<{ ok: true; plan: CloudPlan } | { ok: false; errors: string[] }>
      // 段階2a: 構築/破棄の実行（破壊操作は confirmed:true が必須）。
      // detail は失敗時の生ログ（stderr要約等・診断用。renderer側で折りたたみ表示する・所見12）。
      apply(projectDir: string, opts?: { confirmed?: boolean }): Promise<{ ok: boolean; executed?: string[]; skipped?: string[]; message?: string; detail?: string }>
      /** deleteRegistry: false でコンテナレジストリを残す（月額課金は続く）。未指定は削除する。 */
      teardown(projectDir: string, opts?: { confirmed?: boolean; deleteRegistry?: boolean }): Promise<{ ok: boolean; executed?: string[]; skipped?: string[]; message?: string }>
      /** 破棄画面に出すレジストリ名（保存済み資格情報の名前のみ。パスワードは返らない）。 */
      registryName(projectDir: string): Promise<{ ok: boolean; name: string | null }>
      checkExpiry(projectDir: string): Promise<{ ok: boolean; expired?: boolean; createdAt?: string | null; ttlHours?: number | null; message?: string }>
      // 公開済みか（state.json に apprun-app リソースがあるか）の軽量チェック。APIキー不要。
      isPublished(projectDir: string): Promise<{ ok: boolean; published?: boolean; message?: string }>
      // 構築の前提チェック（内蔵ビルダー / レジストリ認証の有無）
      checkPrereqs(projectDir: string): Promise<{ sourceType: 'dockerfile' | 'image' | null; builderMode: 'builtin' | 'docker'; builder?: boolean; docker?: boolean; dockerfile?: boolean; registry: boolean; message?: string }>
      // 環境スペックのビルド方式を切り替える（標準=builtin / エキスパート=docker）。
      setBuilderMode(projectDir: string, mode: 'builtin' | 'docker'): Promise<{ ok: boolean; message?: string }>
      // 直近に確定した請求額（コスト実額・円）と対象月(asOf, 例 "2026年5月")を取得する。
      cost(): Promise<{ ok: boolean; amountYen?: number; asOf?: string; message?: string }>
      // コンテナレジストリを自動作成（無ければ作成・あれば再利用）し push 用認証を保存する。
      ensureRegistry(projectDir: string): Promise<{ ok: boolean; server?: string; created?: boolean; message?: string }>
      // デプロイ済み AppRun アプリの公開URLを取得する（未デプロイ時は url:null）。
      appUrl(projectDir: string): Promise<{ ok: boolean; url?: string | null; message?: string }>
      // 限定公開（アクセス制限＝パケットフィルタ）。デプロイ済みアプリの許可IPを読み書きする。
      getAccessLimit(projectDir: string): Promise<{ ok: boolean; deployed?: boolean; isEnabled?: boolean; ips?: Array<{ ip: string; prefix: number }>; message?: string }>
      setAccessLimit(projectDir: string, payload: { isEnabled: boolean; ips: Array<{ ip: string; prefix: number }> }): Promise<{ ok: boolean; message?: string }>
      myIp(): Promise<{ ok: boolean; ip?: string; message?: string }>
      // 段階3b: 構築（apply）の進捗メッセージ購読。戻り値の関数を呼ぶと購読解除。
      onApplyProgress(cb: (msg: string) => void): () => void
    }
    // HANAMII（国産PaaS）連携。トークンは中央ストア（認証情報）から renderer が渡す（方式B）。
    hanamii: {
      testConnection(token: string): Promise<{ ok: boolean; status?: number; message?: string }>
      listWorkspaces(token: string): Promise<{ ok: boolean; workspaces?: Array<{ id: string; name: string; role: string }>; message?: string }>
      // detail は失敗時の生API応答（JSON短縮・診断用。renderer側で折りたたみ表示する・所見11）。
      publish(projectDir: string, opts: { token: string; workspaceId: string; projectId?: string; name: string; envs?: Array<{ key: string; value: string; type?: 'plain' | 'secret' }>; healthCheck?: { enabled: boolean; path: string; port: number | null } }): Promise<{ ok: boolean; projectId?: string | null; deploymentId?: string | null; message?: string; detail?: string }>
      status(projectId: string, token: string): Promise<{ ok: boolean; url?: string | null; readyState?: string | null; errorCode?: string | null; runtime?: { status: string | null; detail: string | null; syncedAt: string | null }; message?: string }>
      // A-5: env/ヘルスチェックの変更を再公開（ビルドし直し）なしで反映する高速経路（PATCH /env・PUT /health-check → POST /restart）。
      // detail は失敗時の生API応答（診断用）。noop=true は HANAMII 側で変更がなく再起動が不要だった場合。
      restart(projectId: string, opts: { token: string; envs?: Array<{ key: string; value: string; type?: 'plain' | 'secret' }>; healthCheck?: { enabled: boolean; path: string; port: number | null } }): Promise<{ ok: boolean; noop?: boolean; message?: string; detail?: string }>
      teardown(projectId: string, token: string): Promise<{ ok: boolean; message?: string }>
      detectEnvKeys(projectDir: string): Promise<{ ok: boolean; keys: string[]; message?: string }>
      // デプロイログ取得（JSON形式）。limit 既定100・最大500。
      logs(token: string, projectId: string, opts?: { limit?: number; since?: string }): Promise<{ ok: boolean; logs?: Array<{ timestamp: string; message: string }>; message?: string }>
    }
    // Vercel（海外PaaS）連携。トークン/チームIDは中央ストア（認証情報）から renderer が渡す（方式B）。
    vercel: {
      testConnection(token: string, teamId?: string): Promise<{ ok: boolean; status?: number; message?: string }>
      // ファイルアップロード→デプロイ作成→READYまでのポーリングを main 側で一括して行い、完了後に結果を返す
      // （MVP: 途中経過は返さない。detail は失敗時の生API応答＝JSON短縮・診断用）。
      publish(projectDir: string, opts: { token: string; teamId?: string; name: string }): Promise<{ ok: boolean; deploymentId?: string | null; url?: string | null; readyState?: string | null; message?: string; detail?: string }>
      // 公開中の進捗メッセージを購読する。戻り値の関数で購読解除。
      onProgress(cb: (msg: string) => void): () => void
    }
    // GitHub保存（バックアップ・共有・P3-⑬）。トークンは中央ストア（認証情報）から renderer が渡す（方式B）。
    github: {
      test(token: string): Promise<{ ok: boolean; login?: string; message?: string }>
      createRepo(token: string, name: string): Promise<{ ok: boolean; repoFullName?: string; message?: string }>
      save(projectDir: string, token: string, repoFullName: string, message?: string): Promise<{
        ok: boolean
        commitSha?: string
        savedCount?: number
        excluded?: Array<{ path: string; reason: 'env' | 'size' }>
        message?: string
      }>
      status(token: string, repoFullName: string): Promise<{ ok: boolean; login?: string; message?: string }>
    }
    // Claude（Anthropic API）連携（C系 C1）。キーは中央ストア（認証情報）から renderer が渡す（方式B）。
    claude: {
      test(token: string): Promise<{ ok: boolean; modelCount?: number; message?: string }>
      // Agent SDK のネイティブCLIバイナリがパッケージから実行できるか確認する（開発者向け・スモークテスト用）。
      binaryCheck(): Promise<{ ok: boolean; version?: string; path?: string; message?: string }>
      // Claudeモデル一覧のライブ取得（GET /v1/models）。起動時に実際の提供ラインナップを取得し、
      // renderer側の埋め込み表（claudeMode.ts CLAUDE_MODELS）を置き換えるために使う（useClaudeModels フック）。
      models(token: string): Promise<{ ok: boolean; models?: { id: string; displayName: string; createdAt: string }[]; message?: string }>
      // Claude頭脳モード（C2a/C2b）: query() を開始する。ハンドラは即 {ok:true} を返し、
      // 応答本体は onStream の連続イベント（claude:stream）として届く。
      // aiEngineKey は search_docs ツール用（方式B: renderer が使う瞬間に読んで渡す。無ければ null）。
      // model は C2c（Claudeモデル選択）: claudeMode.ts の getClaudeModel() で選んだモデルID。
      // images は C2d: ユーザーが添付した画像（data URL配列・空配列可）。1枚以上あればClaude自身が
      // 直接画像を読む（main側 agent.ts がストリーミング入力モードへ切り替える）。
      chatStart(projectDir: string, apiKey: string, prompt: string, images: string[], snapshotId: string, resumeSessionId: string | null, aiEngineKey: string | null, model: string): Promise<{ ok: boolean }>
      // 進行中の Claude セッションを中断する。
      chatCancel(): Promise<{ ok: boolean }>
      // ストリームイベント購読。戻り値の関数を呼ぶと購読解除。
      onStream(cb: (event: ClaudeUiEvent) => void): () => void
    }
    registry: {
      saveKey(name: string, user: string, password: string): Promise<{ ok: boolean; message?: string }>
      clearKey(): Promise<{ ok: boolean; message?: string }>
      hasKey(): Promise<boolean>
      // 保存済みの name/user/password を読み戻す（未保存なら null）
      loadKey(): Promise<{ name: string; user: string; password: string } | null>
    }
    // さくらのVPS 公開機能 V1a（①接続の2ルート）。方式B: 秘密鍵・パスワードは中央ストア（認証情報）／
    // renderer側stateから渡す（main には保存しない）。AIチャットのツールには一切公開しない（docs/vps-plan.md §2.5）。
    vps: {
      generateKeypair(): Promise<{ ok: boolean; publicKey?: string; privateKey?: string; message?: string }>
      // ルートA用: コンパネ「マイスクリプト」に貼る初期設定スクリプトを生成する（公開鍵のみ埋め込み・秘密情報なし）。
      buildStartupScript(publicKey: string): Promise<{ ok: boolean; script?: string; message?: string }>
      // ホスト鍵の指紋を取得する（TOFU用）。呼び出し側が .sakuraide.json へ記録する。
      scanHostKey(host: string, port: number): Promise<{ ok: boolean; fingerprint?: string; keyLine?: string; message?: string }>
      // 鍵認証で疎通確認する。fingerprint は記録済みの既知の値（不一致なら接続を中断してエラーになる）。
      testConnection(host: string, port: number, user: string, privateKey: string, fingerprint: string): Promise<{ ok: boolean; message?: string }>
      // ルートB用: 初回のみパスワードで鍵を設置する（sshd強化は含まない）。成功時は fingerprint（今回判明した
      // ホスト鍵指紋。呼び出し側が初回記録に使う）を返す。
      installKeyWithPassword(host: string, port: number, user: string, password: string, publicKey: string): Promise<{ ok: boolean; fingerprint?: string; message?: string }>
      // 鍵認証の疎通確認（testConnection）が取れた後にだけ呼ぶこと（締め出し防止・順序保証）。
      hardenSshd(host: string, port: number, user: string, privateKey: string, fingerprint: string): Promise<{ ok: boolean; message?: string }>
    }
    // 📚 資料（さくらのAI Engine RAG API）。apiKey は認証情報の中央ストアから renderer が渡す（方式B）。
    rag: {
      list(apiKey: string, opts?: { page?: number; pageSize?: number; name?: string; tag?: string }): Promise<{ ok: boolean; meta?: RagPageMeta; documents?: RagDocument[]; error?: string }>
      get(apiKey: string, id: string): Promise<{ ok: boolean; document?: RagDocument | null; error?: string }>
      upload(apiKey: string, args: { filePath?: string; content?: string; filename: string; name?: string; tags?: string[] }): Promise<{ ok: boolean; document?: RagDocument | null; error?: string }>
      update(apiKey: string, id: string, fields: { name?: string; tags?: string[] }): Promise<{ ok: boolean; document?: RagDocument | null; error?: string }>
      delete(apiKey: string, id: string): Promise<{ ok: boolean; error?: string }>
      chunks(apiKey: string, documentId: string, opts?: { page?: number; pageSize?: number }): Promise<{ ok: boolean; meta?: RagPageMeta; chunks?: RagChunk[]; error?: string }>
      query(apiKey: string, args: { query: string; tags?: string[]; topK?: number; threshold?: number }): Promise<{ ok: boolean; hits?: RagQueryHit[]; error?: string }>
      chat(apiKey: string, args: { query: string; chatModel: string; tags?: string[] }): Promise<{ ok: boolean; answer?: string; sources?: RagQueryHit[]; error?: string }>
      // R3: Webから作った資料のローカル控えフォルダ（userData/knowledge）の絶対パスを取得（無ければ作成）
      knowledgeDir(): Promise<string>
    }
    win: {
      setDirty(dirty: boolean): void
      // 実行中状態をメインプロセスに通知（終了時の「実行中です」警告に使う）。label は実行中の処理名。
      setBusy(busy: boolean, label: string): void
      onSaveAll(cb: () => void): () => void
      quitAfterSave(): Promise<void>
    }
    // 「前の状態に戻す」（P2-⑧）。作業単位のスナップショット一覧・復元。
    backup: {
      snapshotBeforeWrite(projectDir: string, snapshotId: string, rel: string, newContent: string, label?: string): Promise<{ ok: boolean; backedUp: boolean; message?: string }>
      list(projectDir: string): Promise<{ ok: boolean; snapshots: BackupSnapshotSummary[]; message?: string }>
      restore(projectDir: string, snapshotId: string): Promise<{ ok: boolean; restored?: string[]; deleted?: string[]; failed?: string[]; preRestoreSnapshotId?: string; message?: string }>
    }
    // チャット履歴のファイル保存。IDEのプロジェクト別は `<project>/.sakuraide/chat.json`、
    // 単独チャット（ChatApp）は `<workspace>/.sakuraide/chats/chat-app.json`。JSON文字列をそのまま読み書きする。
    chat: {
      loadProject(projectDir: string): Promise<{ ok: boolean; json: string | null; message?: string }>
      saveProject(projectDir: string, json: string): Promise<{ ok: boolean; message?: string }>
      loadApp(workspaceDir: string): Promise<{ ok: boolean; json: string | null; message?: string }>
      saveApp(workspaceDir: string, json: string): Promise<{ ok: boolean; message?: string }>
    }
  }
}
