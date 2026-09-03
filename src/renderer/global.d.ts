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

/** 引き取りの候補（shared/publishImport.ts の ImportCandidate と同じ形）。 */
type ImportCandidate = {
  target: 'vercel' | 'sakura-apprun'
  id: string
  name: string
  url: string | null
  at: string | null
  note: string
  blocked?: string
  /** **このパソコンの Koto が既に公開している**ときのプロジェクト（画面側でつける印）。 */
  managedBy?: { projectName: string; dir: string }
}
/** 引き取れる AppRun の公開設定（shared/publishImport.ts の AppRunSettings と同じ形）。 */
/** 引き継ぎ（dev-plan ④ 第4段階）の見立て。main の cloud/adopt.ts が組む。 */
type AppRunAdoptionPreview = {
  canAdopt: boolean
  blocker: string | null
  /** Koto の中での公開名。さくら側のアプリ名と違うことがある。 */
  specName: string
  appName: string
  /** 次の公開で、いまのレジストリをそのまま使うか（＝月額が増えないか）。 */
  reusesRegistry: boolean
  warnings: string[]
}
type AppRunImportSettings = {
  /** 中の入れ物（component）の名前。再デプロイで**元のまま送り返す**ために要る。 */
  componentName: string | null
  port: number | null
  minScale: number | null
  maxScale: number | null
  maxCpu: string | null
  maxMemory: string | null
  timeoutSeconds: number | null
  env: { key: string; value: string }[]
  probePath: string | null
  secretKeys: string[]
}
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
      /**
       * チャットに添付した画像（data URL）を、そのままプロジェクトへ入れる。
       * 元ファイルの場所を追わないので、**貼り付けた画像**でも入れられる。
       */
      importImageData(projectDir: string, name: string, dataUrl: string, purpose?: 'app' | 'material'): Promise<{ ok: boolean; rel?: string; message?: string }>
      /**
       * 手元のファイルをプロジェクトへ複製し、**プロジェクトからの相対パス**を返す。
       * `purpose` 未指定は 'app'（アプリで使う。公開されます）。
       * 'material' は「素材（公開しません）」へ入れる。
       */
      importFile(src: string, projectDir: string, purpose?: 'app' | 'material'): Promise<string>
      trash(p: string): Promise<void>
      rename(oldPath: string, newName: string): Promise<string>
      watchDir(dir: string, cb: () => void): () => void
      homeDir(): Promise<string>
      projectFiles(dir: string): Promise<string[]>
      /**
       * 同上＋一覧そのものが打ち切られたか（`maxFiles` 既定200件を超えた・深さ上限を超えた等）。
       * 公開前セキュリティチェックが「部分検査を完全検査の顔で報告しない」ために使う。
       *
       * `opts.publishView`（既定 false）: true のとき、除外規則を**公開と同じ定義**
       * （`src/shared/publishExclude.ts` の publishExcludedDirNames/excludedFileNames）に差し替える。
       * 既定（false）は従来どおり fs:projectFiles と同じ除外規則のまま（roadmap #17 追補）。
       */
      projectFilesInfo(dir: string, opts?: { maxFiles?: number; publishView?: boolean }): Promise<{ files: string[]; truncated: boolean }>
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
      /**
       * `public/` の形へ移す必要があるか調べる（**何も変えない**）。
       * `plan.move` が移すもの、`plan.keep` が直下に残すもの。
       */
      migrateCheck(projectDir: string): Promise<{ needed: boolean; plan: { move: string[]; keep: string[] } }>
      /**
       * 実際に移す。**途中で失敗したら移した分を元へ戻す**（`restored` で分かる）。
       * `snapshotOk` は 🕘 履歴に「移す直前」を残せたか。
       */
      migrate(projectDir: string, snapshotId: string): Promise<{
        ok: boolean; moved: string[]; restored: boolean; snapshotOk?: boolean; message?: string
      }>
      /**
       * 未使用ファイルの検出（roadmap #18・**静的サイトのみ対応**。何も変えない）。
       * `unused` は projectFilesInfo(publishView:true) の一覧のうち、どこからも参照が
       * 見つからなかったもの（相対パスは公開の根＝resolvePublishRoot からの相対）。
       * `supported: false` は静的サイト以外（Node/PHP 等・動的参照は誤検知しやすいため対象外）。
       */
      unusedCheck(projectDir: string): Promise<{ supported: boolean; unused: string[] }>
      /**
       * 未使用ファイルを「素材（公開しません）」へ移す。**同名衝突が1件でもあれば全体を中止する**
       * （中途半端に動かさない）。移す前に 🕘 履歴へ退避するので、あとから元に戻せる。
       * `snapshotOk` はその退避を残せたか。
       */
      moveToMaterials(projectDir: string, files: string[]): Promise<{
        ok: boolean; moved: string[]; snapshotOk: boolean; message?: string
      }>
      /** withPublishDir: 最初から public/ を掘るか（改善1・2026-08-29。NewProjectModal.tsx が判断する）。 */
      createProject(
        parentDir: string,
        name: string,
        files: { path: string; content: string }[],
        allowExisting?: boolean,
        withPublishDir?: boolean
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
      portOpen(port: number): Promise<boolean>
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
      /** 「Koto → 設定…」（⌘,）メニューの購読（解除関数を返す）。 */
      onOpenSettings(cb: () => void): () => void
    }
    /** 永続データ（保存場所）。値は読まず、扱いだけを調べる。 */
    storage: {
      scan(projectDir: string): Promise<{ ok: boolean; usesDataLayer: boolean; usedBy: string[]; writesFiles: string[]; message?: string }>
      ensureLayer(projectDir: string): Promise<{ ok: boolean; placed: boolean; message?: string }>
      status(): Promise<{ ok: boolean; siteId?: string; siteName?: string; s3Endpoint?: string; siteReady: boolean; buckets: { name: string }[]; suggested?: string; message?: string }>
      createBucket(name: string): Promise<{ ok: boolean; bucket?: string; message?: string }>
      placement(projectDir: string): Promise<{ ok: boolean; placement: { bucket: string; prefix: string; shared: boolean; consentedAt: string } | null; message?: string }>
      /** **課金に直結する。** 呼ぶ前に金額を見せて同意を得ること。 */
      prepare(projectDir: string, opts?: { mode?: 'shared' | 'dedicated'; bucket?: string }): Promise<{
        ok: boolean
        placement?: { bucket: string; prefix: string; shared: boolean }
        siteName?: string
        startedSite?: boolean
        dataLayerPlaced?: boolean
        note?: string
        message?: string
      }>
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
      /** 更新ログを Finder で表示する。 */
      openLog(): Promise<{ ok: boolean; path: string; message?: string }>
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
      /** 復号できなかったときは **null**（未登録の '' と混ぜないこと）。 */
      decrypt(b64: string): Promise<string | null>
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
      /**
       * `hint: 'app-unhealthy'` は「公開はできたが、アプリが起動しなかった」。
       * そのとき `logUrl`（コンパネのログ）と `askAi`（相談の文面）が付く。
       */
      /** `pending: true` は「失敗ではなく、まだ確認できていない」（起動に時間がかかっている）。 */
      /** `verifyNote`: 公開先の中身が本当に新しくなったかの確認結果（確認できたときだけ入る）。 */
      apply(projectDir: string, opts?: { confirmed?: boolean }): Promise<{ ok: boolean; executed?: string[]; skipped?: string[]; message?: string; detail?: string; hint?: string; pending?: boolean; logUrl?: string; askAi?: string; verifyNote?: string; staleImages?: { total: number; removable: number; keep: number } }>
      /** deleteRegistry: false でコンテナレジストリを残す（月額課金は続く）。未指定は削除する。 */
      /** `keptBucketName` は「破棄したのに残った保存場所」。残っていれば月額も続く。 */
      /**
       * 公開する前の確認（改善案 1-2）。**何も作らず、何も変えない。**
       * `canPublish` が false なら、押しても失敗すると分かっている。
       */
      preflight(projectDir: string): Promise<{
        ok: boolean
        canPublish: boolean
        summary: string
        /** `fix: 'ai-fix'` のときは `fixPrompt` を AI に送って直させる（押したら直しにいく）。 */
        checks: { id: string; label: string; status: 'ok' | 'warn' | 'ng'; note: string; fix?: 'reset-registry' | 'ask-ai' | 'ai-fix'; fixPrompt?: string; unusedFiles?: string[] }[]
        message?: string
      }>
      teardown(projectDir: string, opts?: { confirmed?: boolean; deleteRegistry?: boolean }): Promise<{ ok: boolean; executed?: string[]; skipped?: string[]; keptBucketName?: string | null; message?: string }>
      /** 破棄画面に出すレジストリ名（保存済み資格情報の名前のみ。パスワードは返らない）。 */
      registryName(projectDir: string): Promise<{
        ok: boolean; name: string | null
        /** その置き場を Koto が作ったのではない（引き継ぎで借りている）か。 */
        adopted?: boolean
      }>
      checkExpiry(projectDir: string): Promise<{ ok: boolean; expired?: boolean; createdAt?: string | null; ttlHours?: number | null; message?: string }>
      // 公開済みか（state.json に apprun-app リソースがあるか）の軽量チェック。APIキー不要。
      isPublished(projectDir: string): Promise<{ ok: boolean; published?: boolean; message?: string }>
      // 構築の前提チェック（内蔵ビルダー / レジストリ認証の有無）
      checkPrereqs(projectDir: string): Promise<{ sourceType: 'dockerfile' | 'image' | null; builderMode: 'builtin' | 'docker'; builder?: boolean; docker?: boolean; dockerfile?: boolean; registry: boolean; message?: string }>
      // 環境スペックのビルド方式を切り替える（標準=builtin / エキスパート=docker）。
      setBuilderMode(projectDir: string, mode: 'builtin' | 'docker'): Promise<{ ok: boolean; message?: string }>
      /**
       * 古いイメージの片づけ。**confirmed を付けなければ何も消さず、計画だけ返す**
       * （画面はそれを確認ダイアログに出してから、confirmed で呼び直す）。
       */
      cleanupImages(projectDir: string, opts?: { confirmed?: boolean; keep?: number }): Promise<{
        ok: boolean
        dryRun?: boolean
        plan?: { remove: string[]; keep: string[]; untouched: string[] }
        currentTag?: string | null
        keep?: number
        deleted?: string[]
        failed?: Array<{ digest: string; message: string; detail: string }>
        sharedWithKept?: string[]
        message?: string
        detail?: string
        hint?: string
      }>
      // 直近に確定した請求額（コスト実額・円）と対象月(asOf, 例 "2026年5月")を取得する。
      cost(): Promise<{ ok: boolean; amountYen?: number; asOf?: string; message?: string }>
      // コンテナレジストリを自動作成（無ければ作成・あれば再利用）し push 用認証を保存する。
      ensureRegistry(projectDir: string): Promise<{ ok: boolean; server?: string; created?: boolean; message?: string }>
      // デプロイ済み AppRun アプリの公開URLを取得する（未デプロイ時は url:null）。
      appUrl(projectDir: string): Promise<{ ok: boolean; url?: string | null; message?: string }>
      /**
       * いまアプリが動いているかを、もう一度聞く（**何も作らず、何も変えない**）。
       * `ok` は「聞けたか」、`healthy` は「動いているか」。
       */
      appHealth(projectDir: string): Promise<{
        ok: boolean
        healthy?: boolean
        pending?: boolean
        note?: string
        detail?: string
        logUrl?: string
        askAi?: string
        message?: string
      }>
      /**
       * さくら側にあるものの棚卸し（**何も作らず、何も消さない**）。
       * `project` が null の行は「このパソコンの Koto に心当たりがない」もの。
       * `partial` は引けなかった種類（**黙って0件にしない**）。
       */
      inventory(projects: unknown): Promise<{
        ok: boolean
        rows?: Array<{
          kind: 'apprun-app' | 'registry' | 'bucket'
          id: string
          name: string
          project: string | null
          dir: string | null
          monthlyYen: number
          note: string
        }>
        totalYen?: number
        notice?: string
        partial?: string[]
        message?: string
      }>
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
      publish(projectDir: string, opts: { token: string; workspaceId: string; projectId?: string; name: string; envs?: Array<{ key: string; value: string; type?: 'plain' | 'secret' }>; healthCheck?: { enabled: boolean; path: string; port: number | null }; withStorage?: boolean }): Promise<{ ok: boolean; projectId?: string | null; deploymentId?: string | null; storagePermissionId?: string; storageProjectName?: string; message?: string; detail?: string }>
      /**
       * この公開先の古い鍵を片づける（**動いたと確かめてから呼ぶこと**）。
       * ほかの公開先（AppRun）の鍵には触れない。
       */
      cleanUpKeys(opts: { projectName: string; keepId: string }): Promise<{ ok: boolean; deleted?: number; message?: string }>
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
    /** 公開済みのものを引き取る（dev-plan ④）。読み取りと、選んだあとの取り込みだけ。 */
    import: {
      /** 引き取りの候補を一覧する。 */
      list(args: { target: 'vercel' | 'sakura-apprun'; token?: string; teamId?: string }): Promise<
        { ok: true; candidates: ImportCandidate[] } | { ok: false; message: string }>
      /** 取り込む前に、何が起きるかを調べる（Git 由来ならここで断る）。 */
      inspect(args: { target: 'vercel' | 'sakura-apprun'; id: string; token?: string; teamId?: string }): Promise<
        | {
            ok: true; fileCount?: number; stripped?: string | null; files?: string[]; image?: string
            settings?: AppRunImportSettings; secretKeys?: string[]
            /** 引き継ぎの見立て（AppRun のみ）。**押す前に**URLと月額がどうなるかを言うため。 */
            adopt?: AppRunAdoptionPreview
          }
        | { ok: false; gitBacked?: boolean; message: string }>
      /** 取り込む（ここで初めてディスクへ書く）。 */
      run(args: {
        target: 'vercel' | 'sakura-apprun'; id: string; destDir: string
        token?: string; teamId?: string
        /** `'update'` のときだけ AppRun のアプリを引き継ぐ（`.sakura-cloud/` を書く）。 */
        intent?: 'update' | 'fork' | 'undecided'
      }): Promise<
        | {
            ok: true; fileCount: number; failed?: string[]; stripped?: string | null; settings?: AppRunImportSettings
            /** 取り込んだ直後の「戻れる起点」（🕘 履歴）。作れなかったときは null。 */
            historySnapshotId?: string | null
            /** 起点を作らなかった・作れなかった理由（**黙って省かない**）。 */
            historyNote?: string | null
            /** AppRun を引き継げたか（次の公開が、いま動いているアプリを更新する）。 */
            adopted?: boolean
            /** 引き継げなかった理由（**黙って省かない**）。 */
            adoptNote?: string | null
          }
        | { ok: false; message: string }>
      /** 取り込みの実況。戻り値を呼ぶと購読を解除する。 */
      onProgress(cb: (message: string) => void): () => void
    }

    vercel: {
      /** 疎通テスト。`warn: true` は「トークンは有効だが、公開する範囲が見えていない」。 */
      testConnection(token: string, teamId?: string): Promise<{ ok: boolean; warn?: boolean; status?: number; message?: string }>
      /**
       * 公開する前の確認（**何も作らず、何も送らない**）。
       * `canPublish` が false なら、公開しても壊れると分かっている。
       */
      preflight(projectDir: string): Promise<{
        ok: boolean
        canPublish?: boolean
        summary?: string
        checks?: { id: string; label: string; status: 'ok' | 'warn' | 'ng'; note: string; fix?: 'reset-registry' | 'ask-ai' | 'ai-fix'; fixPrompt?: string; unusedFiles?: string[] }[]
        message?: string
      }>
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
      // 実行中状態をメインプロセスに通知。busy/label は「何かしら実行中か」（自動更新の再起動
      // ゲートに使う）、closeBlockingBusy/closeBlockingLabel は「閉じると本当に中断されるか」
      // （終了時の「実行中です」警告に使う。B'-3d-3: AI応答は main で完走するため対象外）。
      setBusy(busy: boolean, label: string, closeBlockingBusy: boolean, closeBlockingLabel: string): void
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
      // ⚠️ B'-3c で持ち主が main（src/main/chat/convStore.ts）へ移り、ChatPanel はもう
      // loadProject/saveProject を呼ばない（下の load/ops に置き換わった）。
      loadProject(projectDir: string): Promise<{ ok: boolean; json: string | null; message?: string }>
      saveProject(projectDir: string, json: string): Promise<{ ok: boolean; message?: string }>
      loadApp(workspaceDir: string): Promise<{ ok: boolean; json: string | null; message?: string }>
      saveApp(workspaceDir: string, json: string): Promise<{ ok: boolean; message?: string }>
      /** B'-3c: IDEのプロジェクト別チャットの読み込み。ファイルが無ければ messages は null
       *  （空配列と区別する。src/renderer/chatConvClient.ts の旧localStorage移行判定に使う）。 */
      load(projectDir: string): Promise<
        | { ok: true; messages: import('../shared/chatTurn').TurnMessage[] | null }
        | { ok: false; messages: null; message: string }
      >
      /** B'-3c: 会話への書き換え（src/renderer/chatConvClient.ts の Op と同じ形）を main へ送る。 */
      ops(projectDir: string, ops: unknown[], opts?: { flushNow?: boolean }): Promise<{ ok: true } | { ok: false; message: string }>
      /**
       * B-1a: main の convStore が会話を1件当てるたびに届く通知（画面更新経路の押し出し口）。
       * renderer 発の書き換え（上の ops）・main のターンの出来事（chatTurn.start）・
       * 🕘「元に戻す」の記録、すべてこれ1本に集約されている（chat:appended は廃止）。
       * op は当てた1件そのもの、length は当てた直後の件数
       * （画面側の同期照合に使う・src/shared/chatEvents.ts の viewSyncDecision）。
       * 購読解除関数を返す（fs.watchDir と同じ作り）。
       */
      onApplied(cb: (p: {
        projectDir: string
        op: import('../shared/chatEvents').ChatEvent<import('../shared/chatTurn').TurnMessage>
          | { kind: 'replaceAll'; messages: import('../shared/chatTurn').TurnMessage[] }
        length: number
      }) => void): () => void
    }
    /**
     * モデルの「ツール対応」「画像対応」学習キャッシュ（B'-3d-1a）。持ち主は main の
     * src/main/learningStore.ts（userData/learning.json）。renderer は起動時に get() で
     * 写しを作り、onChanged() の押し出しで最新化する（src/renderer/learningMirror.ts）。
     */
    learning: {
      get(): Promise<{
        toolSupport: import('../shared/modelLearning').LearnStore
        visionSupport: import('../shared/modelLearning').LearnStore
      }>
      record(kind: 'tool' | 'vision', model: string, supported: boolean): Promise<void>
      forget(kind: 'tool' | 'vision', model?: string): Promise<void>
      /** 旧 renderer/localStorage からの片道移行。main 側が「新しい at だけ勝つ」ため、
       *  何度呼んでも安全（primeLearningMirror が起動のたび呼ぶ）。 */
      migrate(payload: { toolSupport?: unknown; visionSupport?: unknown }): Promise<void>
      /** main が学習記録を変えるたび届く通知（chat.onApplied と同じ作法）。
       *  購読解除関数を返す（fs.watchDir と同じ作り）。 */
      onChanged(cb: (snapshot: {
        toolSupport: import('../shared/modelLearning').LearnStore
        visionSupport: import('../shared/modelLearning').LearnStore
      }) => void): () => void
    }
    /**
     * 単独チャット（ChatApp）のセッション索引（B'-3e-a）。持ち主は main の
     * src/main/appSessionsStore.ts（`<workspace>/.sakuraide-app-chat/sessions.json`）。
     * メッセージ本文は含まない（各セッションの擬似 dir を chat.load/chat.ops（convStore.ts）へ
     * そのまま渡す。src/shared/appChatDirs.ts の sessionDir・renderer/chatConvClient.ts を再利用する）。
     */
    appSessions: {
      list(workspaceDir: string): Promise<{ id: string; title: string; model: string; createdAt: number }[]>
      create(workspaceDir: string, meta: { id: string; title: string; model: string; createdAt: number }): Promise<void>
      rename(workspaceDir: string, id: string, title: string): Promise<void>
      setModel(workspaceDir: string, id: string, model: string): Promise<void>
      delete(workspaceDir: string, id: string): Promise<void>
      /** main が索引を変えるたび届く通知（learning.onChanged と同じ作法）。購読解除関数を返す。 */
      onChanged(cb: (p: { workspaceDir: string; sessions: { id: string; title: string; model: string; createdAt: number }[] }) => void): () => void
    }
    /**
     * 予算設定（sakura_budget_settings）・利用実績（sakura_usage_by_month）（B'-3d-1b）。
     * 持ち主は main の src/main/usageStore.ts（userData/usage.json）。renderer は起動時に
     * get() で写しを作り、onChanged() の押し出しで最新化する（src/renderer/usageMirror.ts）。
     * usage:check は無い（main のターンは usageStore を直接呼び、renderer 側の読み取りも
     * ミラーに対して shared/usageBudget.ts の純関数を直接呼ぶ・IPC 往復を必要としない）。
     */
    usage: {
      get(): Promise<{
        settings: import('../shared/usageBudget').BudgetSettings
        months: import('../shared/usageBudget').UsageStore
      }>
      record(fp: string, model: string, promptTokens: number, completionTokens: number): Promise<void>
      setSettings(raw: unknown): Promise<void>
      /** 消すときは { clear: true } を渡す（undefined は IPC で「省略」と区別しにくいため）。 */
      setKeyLimit(fp: string, limit: number | null | { clear: true }): Promise<void>
      reset(): Promise<void>
      /** 旧 renderer/localStorage からの片道移行。main 側の migrated フラグが縛るため、
       *  何度呼んでも二重計上しない。 */
      migrate(payload: { settings?: unknown; months?: unknown }): Promise<void>
      /** main が設定・実績を変えるたび届く通知（learning.onChanged と同じ作法）。
       *  購読解除関数を返す。 */
      onChanged(cb: (snapshot: {
        settings: import('../shared/usageBudget').BudgetSettings
        months: import('../shared/usageBudget').UsageStore
      }) => void): () => void
    }
    /**
     * 承認（approveToolCall）の main 一元化＋駐機（B'-3d-3）。持ち主は main の
     * src/main/chat/approvalStore.ts（メモリのみ）。要否判定・文面組み立ては main
     * （turnRunner.ts）が src/shared/approvalPlan.ts の純関数で行う。renderer は
     * 「渡された文面のダイアログを出して答えるだけ」の純UI（ChatPanel.tsx）。
     */
    approval: {
      /** 承認待ち一覧（画面が（再）起動したときの取りこぼし回収＝駐機の再提示に使う）。 */
      list(): Promise<{ id: string; dir: string | null; label: string }[]>
      /** 許可=true／拒否=false で回答する。知らない id・二重回答は false（無視）。 */
      answer(id: string, approved: boolean): Promise<boolean>
      /** main が一覧を変えるたび届く通知（learning.onChanged と同じ作法）。購読解除関数を返す。 */
      onChanged(cb: (list: { id: string; dir: string | null; label: string }[]) => void): () => void
    }
    /**
     * AI Engine 経路の1ターンを main で走らせる（B'-3b・土台の入れ替え その1）。
     * renderer 側の配線（useAiChat.ts 等）はまだこの API を呼ばない（その2で行う）。
     */
    chatTurn: {
      /**
       * `payload.spec` は直列化可能な形（`import('../shared/chatTurn').EngineTurnSpec`）。
       * main からの出来事は `handlers.onEvent`（emit）/ `handlers.onActivity` に届く。
       * main からの問い合わせは `handlers.onAsk(path, args)` を呼び、その結果（reject なら
       * エラー文言）を main へ返す。返り値の Promise は、そのターンが終わるまで解決しない。
       */
      start(
        payload: import('../shared/chatTurnRpc').TurnStartPayload,
        handlers: {
          onEvent: (ev: unknown) => void
          onActivity: () => void
          onAsk: (path: string, args: unknown[]) => Promise<unknown> | unknown
        },
      ): Promise<{ ok: boolean; endedWithError?: boolean }>
      /** 進行中のターンを止める（turnId が無ければ何もしない）。 */
      abort(turnId: string): Promise<void>
    }
  }
}
