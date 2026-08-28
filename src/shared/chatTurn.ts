// chatTurn.ts — AI Engine 経路の1ターン（予算チェック〜vision判断〜まとめ〜ストリーミング〜
// エージェントループ）を、React / window / electron に依存しない形に切り出したもの（B'-3a）。
//
// ── なぜ（B'-3）───────────────────────────────────────────────
// これまでは useAiChat.ts の send() の中に、この一連の処理がそのままぶら下がっていた。
// 次の段（B'-3b）でこのループを main プロセスで動かす。切り出した時点でループの振る舞い
// （出来事の並び）を node のテストで固定できるので、「main へ移しても何も変わらない」ことを
// 同じテストで保証できる。
//
// このリリースでは、まだ renderer（useAiChat.ts）から呼ばれる。利用者から見える振る舞いは
// 1ミリも変えていない——外部への接点（画面更新・API呼び出し・使用量記録・ツール実行など）を
// すべて「差し込み口（ports）」にして、呼び出し側（useAiChat.ts）が本物の実装から組み立てて渡す。
//
// 大原則: 対象コードはコピーして、識別子の置き換えだけを行っている。ロジックの「改善」は
// 一切していない。おかしいと思う箇所があってもそのまま移し、報告に書く。
// コメントもそのまま持ってきている（このリポジトリのコメントは「なぜ」を記録した資産）。

import { type ChatEvent } from './chatEvents'

// メッセージの形（renderer の ChatMessage と構造的に同じ。shared から renderer を import しない）
export type TurnMessage = {
  role: 'user' | 'assistant'
  content: string
  hidden?: boolean // AIへの内部指示など、画面に出さないメッセージ
  toolNote?: boolean // ツール実行状況の表示専用バブル。AIへは送らない（結果が伴わずモデルが混乱するため）
  images?: string[] // ユーザーが添付した画像（data URL）
  /** Claudeが請求・クレジット不足等で使えないとき、「さくらのAI Engineに切り替えて同じ内容を送り直す」
   *  ボタンをこのバブルに出すためのペイロード（ユーザー要望2026-07-12・確認方式のフォールバック）。 */
  offerAiEngineFallback?: { text: string; images?: string[] }
  /** ツール実行の回数上限で中断したとき、「続ける」ボタンをこのバブルに出す
   *  （従来は利用者が「続けて」と手入力する必要があった・ユーザー要望2026-07-23）。 */
  offerContinue?: boolean
  /** 推論モデル（Kimi K2.7 / gpt-oss 等）が本文を出す前に流してくる「思考」。
   *  待っている間に「いま何をしているか」を見せるための表示専用（2026-08-03 ユーザー要望）。
   *  **AIへは送り返さない**（費用が増え、モデルも混乱する）。**履歴ファイルにも保存しない**
   *  （本文の何倍にもなり chat.json が膨らむため。chatStorage.ts の保存時に落とす）。 */
  thinking?: string
  /** 🗂 これまでのやり取りのまとめ（content がまとめ本文）。
   *  会話が長くなったとき、古いぶんを**捨てずに**1件へ畳んだもの。
   *  画面には「🗂 ここまでの内容をまとめました」とだけ出し、本文は折りたたむ（CompactNote.tsx）。
   *  AIへは、この1件だけを履歴の先頭に置いて送る（historyCompact.ts）。 */
  summary?: { upTo: number; mark: string }
  /** そのやり取りがあった時刻（ISO 8601）。**古い会話には無い**（あとから付けない）。 */
  at?: string
}

// APIへ送る1メッセージ（tool_calls / tool 結果を含む OpenAI 互換形）。useAiChat.ts の ApiMsg と同じ形。
type ApiMsg = { role: string; content: any; tool_calls?: any[]; tool_call_id?: string }

// ストリーミング1回の要求と結果（window.electronAPI.sakura.chatStream と同じ形）
export type StreamRequest = { apiKey: string; model: string; messages: any[]; maxTokens: number; tools?: any[] }
// ⚠️ 仕様書は usage を `{...} | undefined` としていたが、実体（global.d.ts の sakura.chatStream /
// sakura.chat）は `{...} | null` を返す。呼び出し側（window.electronAPI.sakura.*）の実際の型に合わせた。
export type StreamResult = { usage?: { prompt_tokens?: number; completion_tokens?: number } | null; aborted?: boolean; toolCalls?: any[] | null; reasoningText?: string | null }

/** ターンの入力（送信の瞬間に確定する値）。 */
export type EngineTurnSpec = {
  rawText: string
  images: string[]
  assetBlock: string
  apiKey: string
  model: string
  models: { id: string }[]
  maxRounds: number
  toolsProjectDir: string | null
  errorPrefix: string
  twoStageVision: boolean
  routedModel: string | null
  hasRag: boolean
  turnOpts: Record<string, unknown>
  snapshotId: string
  snapshotLabel: string
}

/** まとめ直す範囲（renderer の historyCompact.ts の CompactPlan と構造的に同じもの。名前は import しない）。 */
export type CompactPlanLike = { base: string | null; from: number; to: number; mark: string }

/** 純粋関数の束。呼び出し側が本物の実装（renderer の各モジュール）から組み立てて渡す。 */
export type TurnHelpers = {
  formatChatError(msg: string): string
  condenseReasoning(text: string): string
  hasTextToolMarkup(text: string): boolean
  stripToolMarkup(text: string): string
  unexecutedToolWarning(sawMarkup: boolean, usedTools: boolean): string | null
  claimsFileChange(text: string): boolean
  unexecutedChangeWarning(claims: boolean, wrote: boolean): string | null
  // ⚠️ 仕様書は (name, argsJson) の2引数としていたが、実体（aiTools.ts）は
  // isToolArgsComplete(args) の1引数。呼び出し側（tc.function?.arguments のみ渡す）に合わせた。
  isToolArgsComplete(argsJson: string | undefined | null): boolean
  isToolUnsupportedError(msg?: string): boolean
  isImageUnsupportedError(msg?: string): boolean
  toolStatusLabel(name: string, argsJson: string): string
  modelLabel(id: string): string
  // ⚠️ 仕様書は string | null としていたが、実体（usage.ts）は候補が無くても既定モデルの
  // 文字列を返すため null にならない。呼び出し側（isKnownToolCapable(best) に渡す）に合わせた。
  pickBestModel(ids: string[]): string
  writingTools: readonly string[]           // WRITING_TOOLS
  extractUrls(text: string): string[]
  wantsWebSearch(text: string): boolean
  toolsFor(projectDir: string | null, hasSearch: boolean, hasRag: boolean): any[]
  planSend(history: TurnMessage[]): { role: string; content: string }[]
  planCompact(history: TurnMessage[]): CompactPlanLike | null
  // ⚠️ 仕様書は compactPrompt の第2引数・compactSource の返り値を string としていたが、
  // 実体（historyCompact.ts）は「本文列（メッセージの配列）」を受け渡す
  // （compactPrompt が内部で transcript() に変換する）。実装に合わせた。
  compactPrompt(base: string | null, source: TurnMessage[]): { system: string; user: string }
  acceptSummary(text: string): string | null
  compactSource(history: TurnMessage[], from: number, to: number): TurnMessage[]
  // ⚠️ 仕様書のTurnHelpers一覧に無いが、エージェントループ本体
  // （apiMessages の system プロンプト組み立て）が使っており、抜けると移せない。
  // aiContext.ts の同名関数をそのまま束ねたもの（純粋関数・renderer 依存無し）。
  searchStatusContext(hasSearch: boolean): string
}

/** 副作用の差し込み口。
 *
 * ── T | Promise<T> について（B'-3b）────────────────────────────────
 * main 実装の ports は IPC 往復（async）になる。そこで、元々は同期だったメンバーの
 * 返り値を `T | Promise<T>` にし、呼び出し側（本文）で必ず `await` する形にした
 * （同期値をそのまま返す renderer の実装は変更不要。`await 値` は値をそのまま返すため）。
 * `emit` / `setAbort` / `notifyActivity` は fire-and-forget のままなので対象外
 *（main 実装は wc.send）。 */
export type EngineTurnPorts = {
  emit(ev: ChatEvent<TurnMessage>): void
  chatStream(req: StreamRequest, onDelta: (d: string) => void, onAbortReady: (abort: () => void) => void, onThinking: (d: string) => void): Promise<StreamResult>
  chatOnce(req: { apiKey: string; model: string; messages: any[]; maxTokens: number }): Promise<{ content?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } | null }>
  getHistory(): TurnMessage[] | Promise<TurnMessage[]>
  buildSystemPrompt(): string | Promise<string>
  onUserMessage?(text: string, isFirst: boolean): void | Promise<void>
  approveToolCall?(name: string, args: string, scope?: { projectDir?: string | null; writeRoot?: string | null }): Promise<string | null>
  executeTool(name: string, argsJson: string, opts: Record<string, unknown>): Promise<string>
  buildRagBlock?: ((text: string) => Promise<string>) | undefined
  getSearchConfig(): Promise<unknown | null>
  fetchPagesBlock(urls: string[]): Promise<string>
  autoSearchBlock(text: string, search: unknown | null): Promise<string>
  notifyActivity(): void
  setAbort(fn: (() => void) | null): void
  usage: {
    check(): { allowed: boolean; message?: string } | Promise<{ allowed: boolean; message?: string }>
    record(model: string, promptTokens: number, completionTokens: number): void | Promise<void>
    estimate(text: string): number | Promise<number>
  }
  toolSupport: {
    shouldSendTools(model: string): boolean | Promise<boolean>
    isKnownToolCapable(model: string): boolean | Promise<boolean>
    record(model: string, supported: boolean): void | Promise<void>
  }
  vision: {
    shouldTryDirect(model: string): boolean | Promise<boolean>
    record(model: string, supported: boolean): void | Promise<void>
    defaultModel(): string | Promise<string>
  }
  /** 「まとめ失敗の警告は1度だけ」の印。初回だけ true を返し、以後 false。 */
  compactWarnOnce(): boolean | Promise<boolean>
  h: TurnHelpers
}

/**
 * Array.prototype.find の非同期版（B'-3b）。
 *
 * ── なぜ要るか ──────────────────────────────────────────────────
 * ports.toolSupport.isKnownToolCapable / shouldSendTools が `T | Promise<T>` になったため、
 * `ids.find(id => ports.toolSupport.isKnownToolCapable(id))` のように述語の中で呼ぶと、
 * 素の `.find()` は Promise を（常に truthy として）誤判定してしまう。
 * 先頭から順に await しながら最初の一致を返す、同じ選び方をする代わり。
 */
async function findAsync<T>(items: readonly T[], pred: (item: T) => boolean | Promise<boolean>): Promise<T | undefined> {
  for (const item of items) {
    if (await pred(item)) return item
  }
  return undefined
}

/** まったく同じツール呼び出し（名前＋引数）がこの回数だけ連続したら暴走とみなして中断する。
 *  周回数の上限（maxRounds）を 5→25 に引き上げた代わりの歯止め（2026-07-23）。
 *  2 = 「同じ呼び出しが3回目に入ったら止める」（1回の再試行は正常な挙動として許容する）。 */
export const REPEAT_LIMIT = 2

/** まとめ作りの結果。手動で押したときは**理由も見せる**ので、失敗を文言で返す。 */
type CompactOutcome = { msg: TurnMessage } | { error: string }

/**
 * 決めた範囲を1件の「まとめ」に畳む（**元の会話は消さない**）。
 *
 * ── なぜ（2026-08-20 Ryosuke 指摘）────────────────────────────────
 * これまでは直近ぶんだけを送り、それより前は黙って捨てていた。
 * 長い相談ほど「さっき決めたこと」を忘れ、利用者からは物覚えを失ったように見える。
 *
 * ・**まとめは「いま選んでいるモデル」で作る**（利用者の知らない経路・料金を使わない）。
 * ・**黙ってやらない。** 会話に「🗂 ここまでの内容をまとめました」を残す。
 * ・**失敗しても送信は止めない。** まとめが無いだけで、従来どおり動く。
 */
export async function runCompact(
  spec: Pick<EngineTurnSpec, 'apiKey' | 'model'>,
  ports: EngineTurnPorts,
  history: TurnMessage[],
  plan: CompactPlanLike,
): Promise<CompactOutcome> {
  const { apiKey, model } = spec
  if (!apiKey || !model) return { error: 'さくらのAI Engine のキーが登録されていないため、まとめを作れません。' }
  // 予算の上限に達しているときは作らない（まとめのために上限を超えない）。
  if (!(await ports.usage.check()).allowed) {
    return { error: '今月のさくらのAI Engine の利用額が上限に達しているため、まとめを作れません（上限は ⚙️ 設定で変えられます）。' }
  }
  // 材料には**書き込み・実行の実況も混ぜる**（どのファイルを変えたかは本文に残らない）。
  const { system, user } = ports.h.compactPrompt(plan.base, ports.h.compactSource(history, plan.from, plan.to))
  ports.emit({ kind: 'status', value: '🗂 これまでの内容をまとめています…' })
  try {
    const res = await ports.chatOnce({
      apiKey,
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      // 推論型モデルは考えるだけで上限に達し、本文にたどり着けないことがある
      // （2026-08-20 実機: 2048 では思考の途中で打ち切られていた）。余裕を持たせる。
      maxTokens: 4096,
    })
    await ports.usage.record(
      model,
      res.usage?.prompt_tokens ?? (await ports.usage.estimate(system + user)),
      res.usage?.completion_tokens ?? (await ports.usage.estimate(res.content ?? '')),
    )
    const text = ports.h.acceptSummary(res.content ?? '')
    if (!text) return { error: `「${ports.h.modelLabel(model)}」から空の返事が返ってきました。別のモデルでお試しください。` }
    return { msg: { role: 'assistant', content: text, summary: { upTo: plan.to, mark: plan.mark } } }
  } catch (e: any) {
    return { error: ports.h.formatChatError(e?.message ?? String(e)) }
  } finally {
    ports.emit({ kind: 'status', value: '' })
  }
}

/** 送るものが予算を超えていたら、送信の前に自動で畳む。**自動の失敗は黙る**（利用者は
 *  そもそも「まとめが要る状態」を知らないため）。ただし**実際に送れなくなったときは1度だけ伝える**。 */
async function compactIfNeeded(
  spec: Pick<EngineTurnSpec, 'apiKey' | 'model'>,
  ports: EngineTurnPorts,
  history: TurnMessage[],
): Promise<TurnMessage | null> {
  const plan = ports.h.planCompact(history)
  if (!plan) return null
  const r = await runCompact(spec, ports, history, plan)
  if ('msg' in r) return r.msg
  // ここへ来た時点で、送る量は予算を超えている＝**古いやり取りの一部が送れていない**。
  // 黙って忘れられるより、やり直せる手があることを1度だけ伝える。
  if (await ports.compactWarnOnce()) {
    ports.emit({
      kind: 'append',
      msg: {
        role: 'assistant', toolNote: true,
        content: `⚠️ ${r.error}
そのため、古いやり取りの一部はAIへ送れていません。上の【🗂 まとめる】でやり直せます。`,
      },
    })
  }
  return null
}

/**
 * AI Engine 経路の1ターン（send() の AI Engine 部分）。
 *
 * @param aiOnlyNote は spec.assetBlock として渡されている（画面には出さず、AI にだけ添える一言）。
 */
export async function runEngineTurn(spec: EngineTurnSpec, ports: EngineTurnPorts): Promise<void> {
  const {
    rawText, images, assetBlock, apiKey, model, models, maxRounds, toolsProjectDir,
    errorPrefix, twoStageVision, routedModel, hasRag, turnOpts, snapshotId, snapshotLabel,
  } = spec
  const hasImages = images.length > 0

  // 利用上限チェック
  const budget = await ports.usage.check()
  if (!budget.allowed) {
    const userMsg: TurnMessage = { role: 'user', content: rawText.trim() }
    const budgetMsg: TurnMessage = { role: 'assistant', content: `🛑 ${budget.message}` }
    ports.emit({ kind: 'append', msg: userMsg })
    ports.emit({ kind: 'append', msg: budgetMsg })
    return
  }

  // 画像があり選択中モデルが画像非対応な場合の扱い：
  // - twoStageVision 有効時は「視覚モデルで読み取り→本来のモデルで実行」の2段階にする（ツールを使えるようにするため）。
  // - 無効時（従来）は、このターンだけvisionモデルに丸ごと切り替える。
  // ── まず今のモデルで試す（2026-08-19 Ryosuke 提案）────────────────────
  // 名前の一覧（isVisionModel）で決め打ちすると、**一覧に載っていない対応モデルは
  // 永久に二段構え**になり、1回分よけいに時間と費用がかかる。
  // ツール対応と同じで、**未確認は楽観的にそのまま渡し、結果から学習する**。
  // 既知で非対応のときだけ二段構えにする。
  const needsVisionHandoff = hasImages && !(await ports.vision.shouldTryDirect(model))
  const twoStage = needsVisionHandoff && twoStageVision
  let useModel = needsVisionHandoff && !twoStage ? await ports.vision.defaultModel() : model
  // B: この会話で既にツール作業へ割り振り済みなら、最初からツール対応モデルで実行（再試行を省く）
  if (!hasImages && routedModel && !(await ports.toolSupport.shouldSendTools(model))) useModel = routedModel
  const switched = useModel !== model

  const text = rawText.trim() || (hasImages ? 'この画像について教えてください。' : '')
  const historyBefore = await ports.getHistory()
  const isFirst = historyBefore.length === 0
  const userMsg: TurnMessage = { role: 'user', content: text, images: hasImages ? images : undefined }
  ports.emit({ kind: 'append', msg: userMsg })
  await ports.onUserMessage?.(text, isFirst)
  ports.emit({ kind: 'loading', value: true })

  // 会話が長くなっていたら、ここで古いぶんをまとめる（送信に使う履歴もこれに差し替える）。
  // 先にユーザーの吹き出しを出してから行うので、待っている間も「送れている」ことが分かる。
  let history = historyBefore
  const summaryMsg = await compactIfNeeded(spec, ports, historyBefore)
  if (summaryMsg) {
    ports.emit({ kind: 'append', msg: { role: 'assistant', content: summaryMsg.content, summary: summaryMsg.summary } })
    history = [...historyBefore, summaryMsg]
  }

  const systemPrompt = await ports.buildSystemPrompt()
  // 費用の見積りは「実際に送るもの」で行う（まとめたのに元の全文で数えると合わない）。
  // 送る履歴は1度だけ組み立てて使い回す（下のエージェントループでも同じものを使う）。
  const pastMessages = ports.h.planSend(history)
  const inputText = systemPrompt + pastMessages.map(m => m.content).join('\n') + text + assetBlock

  try {
    const search = await ports.getSearchConfig() // Web検索設定（未設定なら検索ツールは出さない）
    // ユーザーのメッセージにURLがあれば、IDEがページ本文を取得してこのターンだけAIに添付する
    const pagesBlock = await ports.fetchPagesBlock(ports.h.extractUrls(text))
    // 実際にIDEが検索するときだけ「🔍 Web検索中…」を出す（autoSearchBlock の起動条件と一致させる）
    const willSearch = !!search && ports.h.extractUrls(text).length === 0 && ports.h.wantsWebSearch(text)
    if (willSearch) ports.emit({ kind: 'status', value: '🔍 Web検索中…' })
    const searchBlock = await ports.autoSearchBlock(text, search)
    ports.emit({ kind: 'status', value: '' })
    // 📚 資料の自動注入（設定されていれば）。searchBlock と同じ「取得中はstatusNoteを出す」パターン。
    if (ports.buildRagBlock) ports.emit({ kind: 'status', value: '📚 資料を確認しています…' })
    const ragBlock = ports.buildRagBlock ? await ports.buildRagBlock(text) : ''
    ports.emit({ kind: 'status', value: '' })

    // 現在ターンの content（画像があればOpenAI互換のマルチモーダル配列）
    const apiText = text + assetBlock + pagesBlock + searchBlock + ragBlock
    let userContent: any = hasImages
      ? [
          ...(apiText ? [{ type: 'text', text: apiText }] : []),
          ...images.map(url => ({ type: 'image_url', image_url: { url } })),
        ]
      : apiText

    /**
     * 画像を「文章」にする（視覚モデルに読み取らせる）。
     *
     * 二段構えの1段目で使うほか、**ツールを扱えないモデルに当たって
     * 差し替えるとき**にも使う（2026-08-19）。画像をそのまま渡している
     * ターンは、文章にしてからでないと差し替えられない（画像が失われる）。
     *
     * @returns 読み取れた説明文。失敗・中断なら null
     */
    const readImagesAsText = async (): Promise<string | null> => {
      const visionModel = await ports.vision.defaultModel()
      ports.emit({ kind: 'status', value: '🖼 画像を読み取っています…' })
      const visionMessages: ApiMsg[] = [
        { role: 'system', content: 'あなたは画像読み取り係です。添付画像の内容を客観的に詳しく説明してください（画面の構成要素、表示されている文言やエラーメッセージ、状態、気になる点）。修正案や次の行動の提案は書かないでください。' },
        {
          role: 'user',
          content: [
            ...(text ? [{ type: 'text', text }] : []),
            ...images.map(url => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ]
      let acc = ''
      const { usage: u, aborted } = await ports.chatStream(
        { apiKey, model: visionModel, messages: visionMessages, maxTokens: 1024, tools: undefined },
        (delta) => { ports.notifyActivity(); acc += delta },
        (abortFn) => { ports.setAbort(abortFn) },
        () => { ports.notifyActivity() },
      )
      ports.emit({ kind: 'status', value: '' })
      await ports.usage.record(visionModel, u?.prompt_tokens ?? (await ports.usage.estimate(text)), u?.completion_tokens ?? (await ports.usage.estimate(acc)))
      if (aborted || !acc.trim()) return null
      return acc
    }

    if (twoStage) {
      // 2段階visionハンドオフ：まず視覚モデルに画像だけ読み取らせ（ツール無し）、
      // その説明文を本来のモデル（ツール使用可）へのプレーンテキストとして渡す。
      const visionModel = await ports.vision.defaultModel()
      ports.emit({ kind: 'append', msg: { role: 'assistant', content: `🖼 画像を「${ports.h.modelLabel(visionModel)}」で読み取り、「${ports.h.modelLabel(useModel)}」で実行します。`, toolNote: true } })
      ports.emit({ kind: 'status', value: '🖼 画像を読み取っています…' })
      const visionMessages: ApiMsg[] = [
        { role: 'system', content: 'あなたは画像読み取り係です。添付画像の内容を客観的に詳しく説明してください（画面の構成要素、表示されている文言やエラーメッセージ、状態、気になる点）。修正案や次の行動の提案は書かないでください。' },
        {
          role: 'user',
          content: [
            ...(text ? [{ type: 'text', text }] : []),
            ...images.map(url => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ]
      let descAcc = ''
      const { usage: visionUsage, aborted: visionAborted } = await ports.chatStream(
        { apiKey, model: visionModel, messages: visionMessages, maxTokens: 1024, tools: undefined },
        (delta) => { ports.notifyActivity(); descAcc += delta }, // 差分は表示しない（statusNoteのみ表示のまま）
        (abortFn) => { ports.setAbort(abortFn) },
        // 画像読み取り（2段階処理の1段目）は statusNote だけを見せる作りなので、思考は表示しない。
        // 停滞判定のリセットだけ行う（推論モデルが読み取り役のときに「止まった」と誤表示しないため）。
        () => { ports.notifyActivity() },
      )
      ports.emit({ kind: 'status', value: '' })
      await ports.usage.record(
        visionModel,
        visionUsage?.prompt_tokens ?? (await ports.usage.estimate(text)),
        visionUsage?.completion_tokens ?? (await ports.usage.estimate(descAcc)),
      )
      if (visionAborted) {
        ports.emit({ kind: 'replaceLast', msg: { role: 'assistant', content: '（⏹ 停止しました）' } })
        return
      }
      if (!descAcc.trim()) {
        ports.emit({ kind: 'replaceLast', msg: { role: 'assistant', content: '（画像の読み取りに失敗しました。もう一度お試しください）' } })
        return
      }
      userContent = apiText + '\n\n# 添付画像の内容（AIによる読み取り）\n' + descAcc
    } else if (switched) {
      // 自動切替をユーザーに知らせる（画面のみ・AIには送らない）
      ports.emit({
        kind: 'append',
        msg: hasImages
          ? { role: 'assistant', content: `🖼 画像があるため、このメッセージは「${ports.h.modelLabel(useModel)}」で処理します。` }
          : { role: 'assistant', content: `🔀 ツール作業のため「${ports.h.modelLabel(useModel)}」で実行します。`, toolNote: true },
      })
    }

    // 1回分のストリーミングを実行して本文を返す（吹き出しを1つ追加して流し込む）
    const streamOnce = async (apiMessages: ApiMsg[], noTools = false): Promise<{ content: string; aborted?: boolean; toolCalls?: any[] | null; toolFailed?: boolean; hadToolMarkup?: boolean }> => {
      let acc = ''
      let thinkingAcc = '' // 推論モデルの思考（表示専用。APIにも履歴にも渡さない）
      ports.emit({ kind: 'append', msg: { role: 'assistant', content: '' } })
      const { usage, aborted, toolCalls, reasoningText } = await ports.chatStream(
        // maxTokens=16384: 推論型モデル（Kimi 等）は推論でトークンを消費してから write_file の引数として
        // ファイル全文を吐くため、4096 だと引数JSONが途中で切れて 400 になっていた（2026-07-14）。
        // 上限を超えるモデルは main 側（sakura.ts）が context-limit を検出して自動で縮めて再試行する。
        { apiKey, model: useModel, messages: apiMessages, maxTokens: 16384, tools: (!noTools && (await ports.toolSupport.shouldSendTools(useModel))) ? ports.h.toolsFor(toolsProjectDir, !!search, hasRag) : undefined },
        (delta) => {
          ports.notifyActivity()
          acc += delta
          ports.emit({ kind: 'replaceLast', msg: { role: 'assistant', content: acc, thinking: thinkingAcc || undefined } })
        },
        (abortFn) => { ports.setAbort(abortFn) },
        (delta) => {
          // 思考も「進行中」の証拠なので停滞判定をリセットする（従来は本文の到着だけを見ていたため、
          // 思考中の推論モデルが「⏳ 時間がかかっています」と表示され、止まったように見えていた）。
          ports.notifyActivity()
          thinkingAcc += delta
          ports.emit({ kind: 'replaceLast', msg: { role: 'assistant', content: acc, thinking: thinkingAcc } })
        },
      )
      if (aborted) {
        acc += '\n\n（⏹ 停止しました）'
        ports.emit({ kind: 'replaceLast', msg: { role: 'assistant', content: acc, thinking: thinkingAcc || undefined } })
      }
      // 失敗の兆候：本文もツール呼び出しも無い（reasoningフォールバックがaccを書き換える前に判定する）
      const toolFailed = !acc.trim() && !toolCalls?.length
      // 推論型モデル対策：本文が空でツール呼び出しも無い場合、reasoningに出た回答を本文として使う
      if (!acc.trim() && !toolCalls?.length && reasoningText?.trim()) {
        acc = ports.h.condenseReasoning(reasoningText)
        ports.emit({ kind: 'replaceLast', msg: { role: 'assistant', content: acc, thinking: thinkingAcc || undefined } })
      }
      // テキスト形式のツール呼び出し（Kimi 等が本文に吐く特殊トークン）を除去して生マークアップを見せない
      const hadToolMarkup = ports.h.hasTextToolMarkup(acc)
      if (hadToolMarkup) {
        acc = ports.h.stripToolMarkup(acc)
        ports.emit({ kind: 'replaceLast', msg: { role: 'assistant', content: acc, thinking: thinkingAcc || undefined } })
      }
      // 利用量を記録（usageが無ければ文字数から見積り）
      await ports.usage.record(
        useModel,
        usage?.prompt_tokens ?? (await ports.usage.estimate(inputText)),
        usage?.completion_tokens ?? (await ports.usage.estimate(acc)),
      )
      return { content: acc, aborted, toolCalls, toolFailed, hadToolMarkup }
    }

    // エージェントループ：ツール呼び出しがあれば実行して結果を返し、続きを生成
    let apiMessages: ApiMsg[] = [
      { role: 'system', content: systemPrompt + ports.h.searchStatusContext(!!search) },
      // 過去ターンはテキストのみで送る（画像は再送しない）。長くなった会話は、
      // 古いぶんが「まとめ」に畳まれた形で先頭に入る（historyCompact.ts）。
      ...pastMessages,
      { role: 'user', content: userContent },
    ]

    let retriedNoTools = false
    /** 画像を受け取れず、視覚モデルへ回したか（1回だけ）。 */
    let triedVisionFallback = false
    let routed = false
    let sawToolMarkup = false
    let usedTools = false // このターンで実際にツールを実行したか
    let wroteFiles = false // **ファイルを書き換えたか**（読み取りだけでは変わっていない）
    let askedToActuallyWrite = false // 「実際に変更して」と促したのは1回だけ
    // 暴走検出: まったく同じツール呼び出し（名前＋引数）が連続したら、周回数の上限を待たずに中断する。
    // 周回数の上限を引き上げた（5→25）ぶん、無意味なループを早く止める歯止めをここで持つ。
    let lastCallSig = ''
    let repeatCount = 0
    for (let round = 0; round <= maxRounds; round++) {
      let r
      try {
        r = await streamOnce(apiMessages)
      } catch (e: any) {
        // サーバがツール非対応で 400 を返す等 → ツールを外して1回だけ再試行（通常チャットとして応答させる）。
        // 400で判明した以上は既知の事実として記録し、次回以降このモデルへは無駄な400を出さない。
        if ((await ports.toolSupport.shouldSendTools(useModel)) && !retriedNoTools && ports.h.isToolUnsupportedError(e?.message)) {
          await ports.toolSupport.record(useModel, false)
          retriedNoTools = true
          ports.emit({ kind: 'removeLast' })
          r = await streamOnce(apiMessages, /* noTools */ true)
        } else if (hasImages && !triedVisionFallback && ports.h.isImageUnsupportedError(e?.message)) {
          // ── 画像を受け付けなかった（2026-08-19）────────────────────────
          // **その事実を記録して、次回からは最初から二段構えにする。**
          // 混雑や通信の失敗は記録しない（isImageUnsupportedError が弾く）。
          // 今回は視覚モデルへ回して、利用者の手を止めない。
          await ports.vision.record(useModel, false)
          triedVisionFallback = true
          ports.emit({ kind: 'removeLast' })
          const fallback = await ports.vision.defaultModel()
          ports.emit({
            kind: 'append',
            msg: {
              role: 'assistant',
              content: `🖼 「${ports.h.modelLabel(useModel)}」は画像を受け取れませんでした。`
                + `「${ports.h.modelLabel(fallback)}」で読み取ります（次からは最初からそうします）。`,
              toolNote: true,
            },
          })
          useModel = fallback
          r = await streamOnce(apiMessages)
        } else {
          throw e
        }
      }
      if (r.aborted) break
      // 成功の記録：構造化ツール呼び出しが返った＝ツール対応の決定的証拠。次回以降は迷わず送る。
      if (r.toolCalls?.length) await ports.toolSupport.record(useModel, true)
      // 画像を渡して本文が返った＝**このモデルは画像を受け取れる**という証拠。
      // 次回からは二段構えを挟まない（2026-08-19）
      if (hasImages && !twoStage && !triedVisionFallback && r.content.trim()) await ports.vision.record(useModel, true)
      // 自己修復：ツールを送ったのに本文もツール呼び出しも無い（=ツール非対応/暴走の兆候）。
      // ツール無しで1回だけ再試行し、通常のテキスト応答を得る。
      // ここでは非対応と記録しない：本文もツール呼び出しも無いのは一時的な失敗（暴走・タイムアウト等）の
      // 可能性もあり、非対応と断定できないため（記録は400のような決定的な証拠があるときだけ行う）。
      if ((await ports.toolSupport.shouldSendTools(useModel)) && r.toolFailed && !retriedNoTools) {
        retriedNoTools = true
        ports.emit({ kind: 'removeLast' })
        ports.emit({ kind: 'status', value: '応答をやり直しています…' })
        r = await streamOnce(apiMessages, /* noTools */ true)
        ports.emit({ kind: 'status', value: '' })
        if (r.aborted) break
      }
      if (r.hadToolMarkup) sawToolMarkup = true
      // モデル割り振り：テキスト形式のツールコールを吐いた＝構造化ツールを扱えない
      // → そのターンだけツール対応モデルに切り替え、正規の構造化ツールで実際に実行する。
      // 切替は必ず明示する（黙ってすり替えない）。画像ターンは vision 優先のため除外。
      // **構造化ツール呼び出しが1件でも返っていれば切り替えない**: そのモデルは実際に動いており、
      // 本文に混じったマークアップは stripToolMarkup で除去済みの見た目の問題にすぎない。
      // ここを分けないと、動いているモデルを「非対応」と誤って記録し、勝手に別モデルへ移してしまう。
      // ── 画像ターンでも切り替える（2026-08-19 実機・Ryosuke 報告）──────────
      // 「画像ターンは vision 優先」として除外していたが、**二段構えで画像が
      // 文章になっていれば、あとはただのテキスト依頼**であり、切り替えても
      // 画像は失われない。除外したままだと、ツールを扱えないモデルが
      // 「差し替えました」と書くだけで**ファイルは変わらない**（実機で発生）。
      // 画像をそのまま渡している（配列の）ターンだけは、切り替えると画像を
      // 落としてしまうので従来どおり見送る。
      let imageIsText = typeof userContent === 'string'
      // 画像をそのまま渡しているターンでも、**先に文章にしてから**差し替える
      //（2026-08-19 実機: Kimi は画像を直接読めるので二段構えにならず、
      //  ツールを扱えないまま「差し替えました」とだけ答えていた）
      if (r.hadToolMarkup && !r.toolCalls?.length && !routed && hasImages && !imageIsText) {
        const desc = await readImagesAsText()
        if (desc) {
          userContent = apiText + '\n\n# 添付画像の内容（AIによる読み取り）\n' + desc
          apiMessages[apiMessages.length - 1] = { role: 'user', content: userContent }
          imageIsText = true
        }
      }
      if (r.hadToolMarkup && !r.toolCalls?.length && !routed && (!hasImages || imageIsText)) {
        // ツールを送っていた（=構造化ツールを扱えないという決定的な証拠）場合だけ非対応を記録する。
        if (await ports.toolSupport.shouldSendTools(useModel)) await ports.toolSupport.record(useModel, false)
        const ids = models.map(m => m.id)
        const best = ports.h.pickBestModel(ids)
        // 切替先は「既知で対応」を優先し、無ければ「既知で非対応ではない（未確認）」モデルを試す。
        // 直前に非対応と記録した useModel 自身と、既知で非対応のモデルは避ける。
        const capable = (await ports.toolSupport.isKnownToolCapable(best))
          ? best
          : ((await findAsync(ids, id => ports.toolSupport.isKnownToolCapable(id)))
            ?? (await findAsync(ids, async id => id !== useModel && (await ports.toolSupport.shouldSendTools(id))))
            ?? best)
        if (capable !== useModel) {
          routed = true
          useModel = capable
          ports.emit({ kind: 'routed', value: capable }) // B: この会話では以降もこのモデルで実行（再試行を省く）
          ports.emit({ kind: 'removeLast' }) // 試行の吹き出しを除去
          // 切替を明示（表示のみ・APIへは送らない）
          ports.emit({ kind: 'append', msg: { role: 'assistant', content: `🔀 この作業にはツールが必要なため、「${ports.h.modelLabel(capable)}」に切り替えて実行します。`, toolNote: true } })
          continue // 同じ依頼(apiMessages)を、ツール対応モデル＋構造化ツールで正規ループ実行
        }
      }
      const tcs = r.toolCalls ?? []
      if (!tcs.length) {
        // 最終応答。空ならその旨を表示（空の吹き出しを残さない）
        if (!r.content.trim()) {
          ports.emit({
            kind: 'replaceLast',
            msg: {
              role: 'assistant', content: sawToolMarkup
                ? '（このモデルはツール（ファイル参照など）が必要な操作に対応していません。モデルを「Qwen3-Coder」などに切り替えてお試しください）'
                : '（応答が空でした。もう一度送るか、モデルを変えてお試しください）',
            },
          })
        } else {
          // ── 「変えた」と言っているのに、書き込みが1度も走っていない ──────────
          // 2026-08-19 実機（Ryosuke）: 会話には「📄 ファイルを読んでいます」だけが出て、
          // 「✏️ 保存しています」は無いのに「✅ 反映しました」と答えていた。
          // 読み取りは正しく実行できているので**ツール非対応ではない**。
          // 言っただけである。まず**実際にやらせる**（1回だけ促す）。
          if (ports.h.claimsFileChange(r.content) && !wroteFiles && !askedToActuallyWrite
              && toolsProjectDir && (await ports.toolSupport.shouldSendTools(useModel))) {
            askedToActuallyWrite = true
            ports.emit({ kind: 'removeLast' }) // 事実と違う報告は残さない
            ports.emit({ kind: 'append', msg: { role: 'assistant', content: '⚠️ 変更が実行されていなかったので、やり直しています…', toolNote: true } })
            apiMessages.push({ role: 'assistant', content: r.content })
            apiMessages.push({
              role: 'user',
              content: '（Koto より）いまの返事ではファイルは実際には変更されていません。'
                + '説明や手順を書かず、write_file または edit_file を使って、いますぐ変更を実行してください。',
            })
            continue
          }
          // 促してもやらなかった場合は、**黙って成功に見せない**
          const warn = ports.h.unexecutedChangeWarning(ports.h.claimsFileChange(r.content), wroteFiles)
            ?? ports.h.unexecutedToolWarning(sawToolMarkup, usedTools)
          if (warn) ports.emit({ kind: 'replaceLast', msg: { role: 'assistant', content: `${r.content}\n\n${warn}` } })
        }
        break
      }
      usedTools = true
      // ツール引数のJSONが途中で切れていないか検証する。推論型モデルが write_file の引数として
      // 大きなファイル内容を吐く途中で出力上限に達すると引数が未終端になり、これをそのまま実行/送り返すと
      // サーバーが「400 Unterminated string」で失敗する（2026-07-14 Kimi K2.6 で発生）。事前に検出して中断する。
      if (tcs.some(tc => !ports.h.isToolArgsComplete(tc.function?.arguments))) {
        ports.emit({
          kind: 'replaceLast',
          msg: {
            role: 'assistant',
            content: (r.content ? r.content + '\n\n' : '') +
              '⚠️ ファイルの内容が大きすぎて、AIの一度の出力に収まりませんでした。\n' +
              '・変更を小さめに分けて依頼する（例: 「まず○○の部分だけ直して」）\n' +
              '・別のモデル（Qwen3-Coder など）に切り替えて試す\n' +
              'のいずれかをお試しください。',
          },
        })
        break
      }
      const note = tcs.map(tc => ports.h.toolStatusLabel(tc.function?.name ?? '', tc.function?.arguments ?? '')).join('\n')
      // 暴走検出: 同じツールを同じ引数で REPEAT_LIMIT 回連続で呼んだら中断する
      // （周回数の上限まで無駄に回して費用と時間を使うのを防ぐ）。
      const sig = JSON.stringify(tcs.map(tc => [tc.function?.name ?? '', tc.function?.arguments ?? '']))
      repeatCount = sig === lastCallSig ? repeatCount + 1 : 0
      lastCallSig = sig
      if (repeatCount >= REPEAT_LIMIT) {
        ports.emit({
          kind: 'replaceLast',
          msg: {
            role: 'assistant',
            content: (r.content ? r.content + '\n\n' : '') +
              '⚠️ AIが同じ操作を繰り返しているため中断しました。\n' +
              '・依頼をもう少し具体的に伝える\n' +
              '・別のモデル（Qwen3-Coder など）に切り替える\n' +
              'のいずれかをお試しください。',
          },
        })
        break
      }
      if (round === maxRounds) {
        // ツール実行の上限に達した。空の吹き出しを残さず理由を表示し、ワンクリックで続けられるようにする
        ports.emit({
          kind: 'replaceLast',
          msg: {
            role: 'assistant',
            content: (r.content ? r.content + '\n\n' : '') + '（作業が長くなったのでいったん区切りました。続きから再開できます）',
            offerContinue: true,
          },
        })
        break
      }
      // 本文が空（ツール呼び出しのみ）の吹き出しは、実行状況の表示に置き換える
      ports.emit({ kind: 'replaceLast', msg: { role: 'assistant', content: r.content ? r.content + '\n\n' + note : note, toolNote: true } })
      apiMessages = [...apiMessages, { role: 'assistant', content: r.content ?? '', tool_calls: tcs }]
      for (const tc of tcs) {
        const toolName = tc.function?.name ?? ''
        const toolArgs = tc.function?.arguments ?? ''
        // 実行前の承認フック（ChatPanel の write_file/run_command 確認UIなど）。
        // 文字列が返ったら実行せず、その文字列をツール結果としてAIへ返す。
        if (ports.approveToolCall) {
          const denial = await ports.approveToolCall(toolName, toolArgs, turnOpts as { projectDir?: string | null; writeRoot?: string | null })
          if (denial !== null) {
            apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: denial })
            continue
          }
        }
        const result = await ports.executeTool(toolName, toolArgs, { ...turnOpts, search, snapshotId, snapshotLabel })
        if ((ports.h.writingTools as readonly string[]).includes(toolName)) wroteFiles = true
        apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result })
      }
      if (!(await ports.usage.check()).allowed) break // 上限到達時はループを止める
    }
  } catch (err: any) {
    ports.emit({ kind: 'append', msg: { role: 'assistant', content: errorPrefix + ports.h.formatChatError(err?.message ?? String(err)) } })
  } finally {
    ports.setAbort(null)
    ports.emit({ kind: 'loading', value: false })
    ports.emit({ kind: 'status', value: '' })
  }
}
