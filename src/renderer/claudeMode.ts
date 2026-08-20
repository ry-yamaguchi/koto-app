// claudeMode.ts — Claude頭脳モード（C2a）の renderer 側の小さな純粋ヘルパー群。
// useAiChat.ts から呼ばれる（掟7: チャット変更は useAiChat.ts のみを修正するが、
// historyCompact.ts / aiTools.ts と同様に独立した純粋ロジックは別モジュールへ切り出す）。

/** モードのオン/オフ（既定=オン）。'off' が明示されているときだけ Claude 経路を使わない。 */
export const CLAUDE_MODE_KEY = 'sakura_claude_mode'
/** 初回同意フラグ（コード・指示が Anthropic へ送信される旨への同意）。 */
export const CLAUDE_CONSENT_KEY = 'sakura_claude_consent'
/** 月別のコスト累計（USD）。`{ "2026-07": 0.1234 }` 形式で localStorage に保存する。 */
export const CLAUDE_USAGE_KEY = 'sakura_claude_usage_usd'
/** 選択中の Claude モデルID。localStorage に保存する。 */
export const CLAUDE_MODEL_KEY = 'sakura_claude_model'
/** 所見8（任意）: 警告のみのしきい値（USD）。未設定なら警告なし。送信のブロックはしない。 */
export const CLAUDE_WARN_USD_KEY = 'sakura_claude_warn_usd'

/** C2c: Claudeモデル選択の選択肢（IDは正確・変更しないこと）。
 *  現行ラインナップは 2026-07-29 に platform.claude.com/docs/en/about-claude/models/overview で確認
 *  （Opus 4.8 はレガシー入り→Opus 5 へ差し替え。前回 2026-07-11 は Sonnet 4.6→Sonnet 5・Fable 5 追加）。
 *  価格目安（$/1M 入力/出力）: Fable 5=$10/$50・Opus 5=$5/$25・
 *  Sonnet 5=$3/$15（2026-08-31まで導入価格$2/$10）・Haiku 4.5=$1/$5。
 *  モデル改廃の追従は定期メンテ項目（dev-plan.md）。コスト集計はSDKの実額（total_cost_usd）
 *  ベースなので、この表の価格が古くなっても集計は狂わない。
 *  **ただしSDK同梱CLIが知らないモデルIDはAPIには通るがコスト算出が狂いうるため、
 *  新モデルを足すときは claude-agent-sdk の更新とセットで行うこと**
 *  （2026-07-29 実測: 0.3.206 のCLIには `claude-opus-5` の文字列が無く、0.3.220 で入った）。
 *
 *  【役割の変更】起動時に claude:models（main側 listAnthropicModels）で実際の提供ラインナップを
 *  ライブ取得するようになったため、この固定表は一次情報ではなくなった。以後の役割は2つ:
 *   (1) ライブ取得できない場合（キー未登録・オフライン・API障害）のフォールバック
 *   (2) ライブ取得したモデルIDのうち既知のものに「（コーディング推奨）」等のおすすめ注記ラベルを
 *       与える注釈元（mergeClaudeModels() 参照）
 *  そのため、新モデルが出ても手で追記する緊急性は無くなった（ラベルが無ければ displayName で表示される）。 */
export const CLAUDE_MODELS: { id: string; label: string }[] = [
  { id: 'claude-fable-5', label: 'Claude Fable 5（最高性能・高価）' },
  { id: 'claude-opus-5', label: 'Claude Opus 5（コーディング推奨）' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5（バランス）' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5（低コスト・高速）' },
]

/** Claudeモデルの既定（未選択・不明IDのフォールバック先）。
 *  旧既定 `claude-opus-4-8` を保存済みの利用者は、getClaudeModel() のフォールバックにより
 *  自動的にここへ移る（提供終了IDで壊れないための既存の仕組み。2026-07-29 に実際に発動）。 */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5'

/** ライブ取得したClaudeモデル一覧（mergeClaudeModels()済み）のキャッシュキー。
 *  usage.ts の MODELS_CACHE_KEY（さくらのAI Engine版）と同じ作法: 起動直後はこのキャッシュ／
 *  CLAUDE_MODELS を初期値にし、ライブ取得に成功したときだけ差し替える。 */
export const CLAUDE_MODELS_CACHE_KEY = 'sakura_claude_models_cache'

/**
 * 起動時にライブ取得した Anthropic モデル一覧と、埋め込みの CLAUDE_MODELS（フォールバック＋推奨注記の
 * 注釈元）をマージする。fetched の順序（Anthropic APIが返す「新しいモデルが先頭」の順）をそのまま保つ。
 * 既知ID（CLAUDE_MODELS に同じIDがある）は推奨注記付きのラベルを維持し、未知IDは displayName を使う。
 * fetched が空（未取得・取得失敗）なら CLAUDE_MODELS をそのまま返す。
 */
export function mergeClaudeModels(fetched: { id: string; displayName: string }[]): { id: string; label: string }[] {
  if (!fetched.length) return CLAUDE_MODELS
  return fetched.map(m => {
    const known = CLAUDE_MODELS.find(k => k.id === m.id)
    return { id: m.id, label: known ? known.label : m.displayName }
  })
}

/** ライブ取得＋マージ済みのClaudeモデル一覧を localStorage へ保存する。空配列は保存しない（既存キャッシュを残す）。 */
export function cacheClaudeModels(list: { id: string; label: string }[]): void {
  if (!list.length) return
  localStorage.setItem(CLAUDE_MODELS_CACHE_KEY, JSON.stringify(list))
}

/** キャッシュ済みのClaudeモデル一覧を読む（破損データ耐性）。未保存・破損データなら CLAUDE_MODELS。 */
export function getCachedClaudeModels(): { id: string; label: string }[] {
  try {
    const raw = localStorage.getItem(CLAUDE_MODELS_CACHE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed) && parsed.length && parsed.every(m => m && typeof m.id === 'string' && typeof m.label === 'string')) {
      return parsed
    }
  } catch {
    // 破損データは CLAUDE_MODELS へフォールバック
  }
  return CLAUDE_MODELS
}

/**
 * 選択中の Claude モデルIDを読む。判定対象は available（省略時は getCachedClaudeModels()＝
 * ライブ取得済みならその一覧、未取得なら CLAUDE_MODELS）。保存済みIDがその中に無ければ
 * （提供終了・破損データ）DEFAULT_CLAUDE_MODEL へ、それも一覧に無ければ一覧の先頭IDへフォールバックする
 * （一覧が空のときのみ DEFAULT_CLAUDE_MODEL を返す）。
 */
export function getClaudeModel(available?: { id: string }[]): string {
  const list = available ?? getCachedClaudeModels()
  const saved = localStorage.getItem(CLAUDE_MODEL_KEY)
  if (saved && list.some(m => m.id === saved)) return saved
  if (list.some(m => m.id === DEFAULT_CLAUDE_MODEL)) return DEFAULT_CLAUDE_MODEL
  return list[0]?.id ?? DEFAULT_CLAUDE_MODEL
}

/** 選択中の Claude モデルIDを保存する。 */
export function setClaudeModel(id: string): void {
  localStorage.setItem(CLAUDE_MODEL_KEY, id)
}

/** モデルIDから短いラベル（例: 'Opus 5'）を作る。list（省略時は getCachedClaudeModels()）に
 *  無いIDはこれまでどおりそのまま返す。 */
export function claudeModelShortLabel(id: string, list?: { id: string; label: string }[]): string {
  const found = (list ?? getCachedClaudeModels()).find(m => m.id === id)
  if (!found) return id
  return found.label.replace(/^Claude\s+/, '').replace(/（[^）]*）$/, '')
}

/** Claude頭脳モードが有効か（設定で明示的に無効化されていないか）。 */
export function isClaudeModeEnabled(): boolean {
  return localStorage.getItem(CLAUDE_MODE_KEY) !== 'off'
}

/**
 * 所見6: Claude頭脳モードのオン/オフを保存する（唯一の書き込み口）。
 * false のとき 'off' を保存（isClaudeModeEnabled が false を返すようになる）。
 * true のときは 'on' を明示保存する（キー削除でも既定=オンは再現できるが、値を残して意図を明確にする）。
 * 保存後は 'sakura:credentials-changed' を dispatch し、StatusBar/ChatPanel/ChatApp 等の
 * 頭脳表示・判定を即座に更新させる（CredentialsModal の認証情報変更と同じ購読先を再利用する）。
 */
export function setClaudeMode(enabled: boolean): void {
  localStorage.setItem(CLAUDE_MODE_KEY, enabled ? 'on' : 'off')
  window.dispatchEvent(new Event('sakura:credentials-changed'))
}

/**
 * isClaudeUsageBlockedError — Claudeが「キーは有効だが利用できない」状態（クレジット不足・請求設定の問題・
 * 利用枠超過など）のエラーメッセージか判定する。ネットワーク断や一時的なレート制限（429）とは区別する
 * （それらは待てば直るが、これは請求側の対処が要る＝別の頭脳への切替を提案すべき状態）。
 *
 * 検出対象は2経路の文言:
 *  (1) SDKストリームの error は main 側 events.ts の describeAssistantError() で**日本語化してから**
 *      renderer に届く。billing_error → 「請求設定に問題があります（Anthropic Console を確認してください）。」
 *      → 「請求設定に問題」で拾う。**events.ts の billing_error の文言を変えたらここも追随すること（相互参照）。**
 *  (2) chatStart の .catch で来る例外は英語の原文のことがある（credit balance/billing 等）→ 英語語でも拾う。
 * ※ aiTools.ts の formatChatError の 402/billing 分岐とも語を揃える（案内文と検出条件を一致させる）。
 */
export function isClaudeUsageBlockedError(message: string): boolean {
  if (typeof message !== 'string' || !message) return false
  return /\b402\b|billing|credit balance|insufficient|payment|quota|請求設定に問題|クレジット|残高/i.test(message)
}

/** チャット利用不可時（isChatUsable=false）に案内画面へ出す文言。ChatPanel/ChatApp 共通。 */
export const CHAT_NO_KEY_MESSAGE = 'APIキーが登録されていません。'
/** 上の案内に続けて示すボタン誘導文。「さくらのAI Engine」「Claude」どちらのキーでも利用開始できる旨を伝える。 */
export const CHAT_NO_KEY_HINT = '右上の 🔑 ボタンから「さくらのAI Engine」または「Claude」のキーを登録してください。'

/**
 * isChatUsable — チャット画面を表示してよいか（さくらのAI EngineキーまたはClaudeキーのいずれかがあれば利用可）。
 * false の場合は CHAT_NO_KEY_MESSAGE の案内画面を表示する（ChatPanel/ChatApp 共通のゲート判定・ユーザー指摘
 * 2026-07-12: モードB＝Claudeキーのみの利用者が、AI Engineキー必須の旧ゲートでチャットへ到達できなかった）。
 */
export function isChatUsable(hasApiKey: boolean, claudeReady: boolean): boolean {
  return hasApiKey || claudeReady
}

/**
 * claudeNoProjectGuidance — プロジェクト未選択（toolsProjectDir 無し＝単独チャット、またはIDEモードで
 * プロジェクト未オープン）で送信しようとしたときの案内文。Claudeはプロジェクトのツール（ファイル操作等）を
 * 前提とするためここでは使えない。AI Engineキーがあれば従来どおりそちらで送信できるため案内不要（null）。
 * AI Engineキーが無く（モードB）Claudeだけが使える状態のときだけ、行き止まりにせず案内する。
 */
export function claudeNoProjectGuidance(hasProjectDir: boolean, hasApiKey: boolean, claudeReady: boolean): string | null {
  if (hasProjectDir || hasApiKey || !claudeReady) return null
  return 'Claudeモードは、プロジェクトを開いた画面（IDEモード）でご利用ください。'
}

/**
 * claudeConsentDeclinedGuidance — Claude利用の初回同意ダイアログをキャンセルしたときの案内文。
 * AI Engineキーがある（モードA）場合は従来どおり黙ってAI Engine経路へフォールバックするため null（案内不要）。
 * AI Engineキーが無い（モードB）場合はフォールバック先が無く空キーのまま送信してしまうため、中断を明示する。
 */
export function claudeConsentDeclinedGuidance(hasApiKey: boolean): string | null {
  if (hasApiKey) return null
  return 'キャンセルしたので送信を中止しました。'
}

/** 初回同意済みか。 */
export function hasClaudeConsent(): boolean {
  return localStorage.getItem(CLAUDE_CONSENT_KEY) === '1'
}

/** 同意したことを記録する（次回以降ダイアログを出さない）。 */
export function recordClaudeConsent(): void {
  localStorage.setItem(CLAUDE_CONSENT_KEY, '1')
}

/** 指定日時（既定=現在）の月キー（'YYYY-MM'）。src/renderer/usage.ts の thisMonth() と同じ規則。 */
export function claudeMonthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 月別コスト累計ストアへ加算した「新しいストア」を返す純粋関数（引数は変更しない）。
 * 4桁（0.0001 USD単位）に丸める。costUsd が負値やNaNのときは加算しない。
 */
export function addClaudeMonthlyCost(store: Record<string, number>, monthKey: string, costUsd: number): Record<string, number> {
  const add = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0
  const prev = typeof store[monthKey] === 'number' ? store[monthKey] : 0
  const next = Math.round((prev + add) * 10000) / 10000
  return { ...store, [monthKey]: next }
}

/**
 * 所見8: localStorage の月別コスト累計ストアを安全に読み込む（破損データ耐性）。
 * 未保存・JSON破損・オブジェクトでない場合は空のストアを返す（recordClaudeCost と共通のパースロジック）。
 */
export function getClaudeMonthlyCostStore(): Record<string, number> {
  try {
    const raw = localStorage.getItem(CLAUDE_USAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    // 破損データは空ストアとして扱う
  }
  return {}
}

/** 所見8: 今月（claudeMonthKey()）のClaude利用額累計（USD）。記録が無ければ0。 */
export function getClaudeCostThisMonth(): number {
  const store = getClaudeMonthlyCostStore()
  const v = store[claudeMonthKey()]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** 所見8: USD→円の概算換算レート。実際の請求はAnthropicの為替レート・請求通貨によるため、
 *  あくまで目安表示用の固定値。 */
export const USD_JPY_APPROX = 150

/** 所見8: USD概算額を円に換算する（概算・実際の請求はAnthropicのレート/通貨による）。 */
export function approxJpyFromUsd(usd: number, rate: number = USD_JPY_APPROX): number {
  const safe = Number.isFinite(usd) && usd > 0 ? usd : 0
  return safe * rate
}

/** 所見8（任意）: 警告のみのしきい値（USD）を読む。未設定・不正値は null（警告なし）。 */
export function getClaudeWarnUsd(): number | null {
  const raw = localStorage.getItem(CLAUDE_WARN_USD_KEY)
  if (raw == null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 所見8（任意）: 警告のみのしきい値（USD）を保存する。null/0以下/非数を渡すと未設定（キー削除）に戻す。 */
export function setClaudeWarnUsd(usd: number | null): void {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) {
    localStorage.removeItem(CLAUDE_WARN_USD_KEY)
    return
  }
  localStorage.setItem(CLAUDE_WARN_USD_KEY, String(usd))
}

/**
 * 所見8（任意）: 今月のClaude利用額（USD）が警告しきい値を超えているか（警告のみ・送信はブロックしない）。
 * しきい値未設定（null）のときは常に false。
 */
export function isOverClaudeWarnThreshold(costUsdThisMonth: number, warnUsd: number | null): boolean {
  if (warnUsd == null || !Number.isFinite(warnUsd) || warnUsd <= 0) return false
  return costUsdThisMonth > warnUsd
}

/** localStorage の月別コスト累計を読み込み、加算して書き戻す（副作用あり）。 */
export function recordClaudeCost(costUsd: number): void {
  const store = getClaudeMonthlyCostStore()
  const next = addClaudeMonthlyCost(store, claudeMonthKey(), costUsd)
  localStorage.setItem(CLAUDE_USAGE_KEY, JSON.stringify(next))
}

/**
 * ターン末尾の小さなフッタ文言。ブランディング制約: 「Claude Code」表記は使用禁止（「Claude」のみ可）。
 * C2c: 使用したモデルの短いラベルを付記する（例: `🤖 Powered by Claude (Opus 4.8)・$0.1234`）。
 * 後方互換は不要（C2b までの「モデル名なし」形式は置き換える）。
 *
 * costUsd が0以下・非有限（NaN等）のときは `$0.0000` ではなく「利用額を取得できませんでした」と表示する。
 * 理由: SDK同梱CLIが知らない新モデルID（CLAUDE_MODELS.md冒頭コメント参照）で送信すると、
 * SDKの実額集計（total_cost_usd）が0のまま返ってくることがあり、「$0.0000」だと無料だったと誤解させるため。
 */
export function claudeCostFooter(costUsd: number, modelId: string): string {
  const label = claudeModelShortLabel(modelId)
  if (!Number.isFinite(costUsd) || costUsd <= 0) {
    return `🤖 Powered by Claude (${label})・利用額を取得できませんでした`
  }
  return `🤖 Powered by Claude (${label})・$${costUsd.toFixed(4)}`
}

/**
 * MCP修飾名（mcp__<server名>__<tool名>）から素のツール名を取り出す。非MCP名はそのまま返す。
 * C2b: IDE固有ツールは SDK により mcp__ide__fetch_url 等へ修飾されるため、
 * 修飾名でも素の名前でも同じラベルになるよう claudeToolLabel の前段で正規化する。
 */
export function claudeBareToolName(name: string): string {
  const m = /^mcp__.+?__(.+)$/.exec(name)
  return m ? m[1] : name
}

/**
 * ツール実行中表示の1行。aiTools.ts の toolStatusLabel と同じ絵文字・文言を踏襲する:
 * Read=📄, Edit/Write=✏️, Bash=⚡, Glob/Grep=🔍, fetch_url/open_preview=🌐, search_docs=📚。
 */
export function claudeToolLabel(name: string, detail: string): string {
  const bare = claudeBareToolName(name)
  const suffix = detail ? `… ${detail}` : '…'
  if (bare === 'Read') return `📄 ファイルを読んでいます${suffix}`
  if (bare === 'Edit') return `✏️ ファイルを編集しています${suffix}`
  if (bare === 'Write') return `✏️ ファイルを保存しています${suffix}`
  if (bare === 'Bash') return `⚡ コマンドを実行しています${suffix}`
  if (bare === 'Glob') return `🔍 ファイルを検索しています${suffix}`
  if (bare === 'Grep') return `🔍 内容を検索しています${suffix}`
  // C2b: IDE固有MCPツール（絵文字・文言は aiTools.ts の toolStatusLabel と同じ）
  if (bare === 'fetch_url') return `🌐 ページを取得しています${suffix}`
  if (bare === 'search_docs') return `📚 資料を検索しています${detail ? `… 「${detail}」` : '…'}`
  if (bare === 'open_preview') return `🌐 プレビューを開いています${suffix}`
  // 所見20: 頻出SDKツール（マッピング外だと英語名が生表示されていた）を日本語化する。
  if (bare === 'Task') return `🧩 作業を分担しています${suffix}`
  if (bare === 'WebSearch') return `🌐 Web検索をしています${suffix}`
  if (bare === 'WebFetch') return `🌐 ページを取得しています${suffix}`
  if (bare === 'TodoWrite' || bare === 'TodoRead') return `📝 作業メモを整理しています${suffix}`
  // C3: AI Engine への実装委譲ツール（所見18: 「委譲」は硬いので「任せる」に）。
  if (bare === 'delegate_implementation') return `🤝 さくらのAI Engineに作業を任せています${suffix}`
  // 所見20: 未知ツールは英語名を出さず、非エンジニアにも分かる汎用文言に丸める。
  return '🔧 作業しています…'
}
