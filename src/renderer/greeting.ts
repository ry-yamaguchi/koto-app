// greeting.ts — プロジェクトを開いたときの最初のあいさつ。
//
// 判断（出すか・何を出すか）は decideGreeting、実行は runGreeting に分けてある。どちらも React と window に
// 触れない。外へ出る動作（上限の確認・AI への要求・利用量の記録・吹き出しの更新）は runGreeting の ports で
// 受け取るので、偽の ports を流して「呼ばれた要求の一覧」を検査できる。
//
// あいさつは利用者の操作なしに AI へ要求を送る道なので、止める判断は decideGreeting の1か所に置く。
// プロジェクトを開く入口がいくつあっても、ここを通らない限り AI へは何も飛ばない。

import type { Op } from './chatConvClient'
import { IDE_CONTEXT } from './aiContext'
import { formatChatError } from '../shared/aiToolsCore'
import { stripRemoteHead } from '../shared/failureText'

/** AI Engine のキーが無く Claude だけのときに出す固定の一言。AI へは何も送らない。 */
export const GREETING_FIXED_TEXT = 'こんにちは！つくりたいものを日本語で教えてください。'

/** あいさつ用に AI へ送る依頼文。吹き出しには出さない（hidden）。 */
export const GREETING_KICKOFF =
  'これからこのプロジェクトの開発を始めます。まず、把握した内容（プロジェクトの目的と構成）を1〜2文で要約し、' +
  '続けて「次に何をしたいか」を私に1つ質問してください。この最初の返答ではコードは出力せず、まず会話で確認してください。'

/** あいさつの返答の上限（トークン）。 */
export const GREETING_MAX_TOKENS = 700

/** AI の返事が届かなかったとき。定型の時間切れ文は「もう一度お試しください」で終わるので、あいさつ用の短い1文にする。 */
export const GREETING_TIMED_OUT_TEXT =
  '⏱ AIからの返事が届かなかったので、あいさつは省きました。つくりたいものを、そのまま送ってください。'

/** あいさつの生成に失敗したとき。生のエラーは出さず、原因はログにだけ残す。 */
export const GREETING_FAILED_TEXT = '（あいさつを準備できませんでした。つくりたいものを教えてください。）'

// ── 判断 ─────────────────────────────────────────────────────────────────────

export interface GreetingInput {
  /** AI Engine のキーか Claude のキーのどちらかで、チャットが使える。 */
  chatUsable: boolean
  /** AI Engine のキーがある。無く Claude だけのときは固定の一言になる。 */
  hasApiKey: boolean
  projectDir: string | null | undefined
  /** いま持っているプロジェクトの文脈がどのフォルダのものか（まだ無ければ null）。 */
  ctxDir: string | null | undefined
  messagesLength: number
  /**
   * そのプロジェクトの会話の読み込みが済み、messages がその会話を映している。
   * 読み込み前の messages は前のプロジェクトのもの（または空）で、空と読むと、保存済みの会話があるプロジェクトへ
   * あいさつを送り、その会話を置き換えてしまう。
   */
  conversationLoaded: boolean
  isLoading: boolean
  /** この画面であいさつを済ませた（または済ませたことにした）フォルダ。まだ無ければ ''。 */
  greetedDir: string
  /** 設定「プロジェクトを開いたとき AI があいさつする」。 */
  enabled: boolean
  /** 新規作成の依頼がこのフォルダ向けに保留中。この依頼だけを送るので、あいさつは出さない。 */
  newProjectPending: boolean
}

export type GreetingAction = 'none' | 'fixed' | 'ai'

export interface GreetingDecision {
  action: GreetingAction
  /**
   * 「この画面であいさつが済んだ」印（greetedDir）を付けるか。
   * あいさつの条件がそろった回は、オフで何も出さなくても付ける。付けないと、オフの間に会話を
   * クリアしてからオンへ戻した瞬間にあいさつが出てしまう。
   */
  markGreeted: boolean
}

const NONE: GreetingDecision = { action: 'none', markGreeted: false }

/** あいさつを出すか、何を出すかを決める。出力は 'none'（出さない）・'fixed'（固定の一言）・'ai'（AI に頼む）。 */
export function decideGreeting(i: GreetingInput): GreetingDecision {
  if (i.greetedDir === i.projectDir) return NONE
  if (!i.conversationLoaded) return NONE
  if (!i.chatUsable) return NONE
  if (!i.projectDir) return NONE
  if (!i.ctxDir || i.ctxDir !== i.projectDir) return NONE
  if (i.messagesLength > 0 || i.isLoading) return NONE
  if (i.newProjectPending) return NONE
  if (!i.enabled) return { action: 'none', markGreeted: true }
  return { action: i.hasApiKey ? 'ai' : 'fixed', markGreeted: true }
}

// ── 実行 ─────────────────────────────────────────────────────────────────────

export interface GreetingStreamRequest {
  apiKey: string
  model: string
  messages: { role: string; content: string }[]
  maxTokens: number
}

export interface GreetingPorts {
  /** 要求の前の上限の確認。allowed が偽なら AI へは何も送らない。warning は、止めない設定で上限を超えたときの知らせ。 */
  checkBeforeRequest(apiKey: string): { allowed: boolean; warning?: string }
  /** AI へ要求を送り、返事を少しずつ onDelta へ渡す。onAbort には中断用の関数が先に渡る。 */
  chatStream(
    req: GreetingStreamRequest,
    onDelta: (delta: string) => void,
    onAbort: (abort: () => void) => void,
  ): Promise<{ usage: { prompt_tokens?: number; completion_tokens?: number } | null; timedOut?: 'first' | 'idle' }>
  /** 利用量の記録。 */
  recordUsage(apiKey: string, model: string, promptTokens: number, completionTokens: number): void
  /** 利用量が返らなかったときの見積もり。 */
  estimateTokens(text: string): number
  /** 会話への書き換え。 */
  applyOp(op: Op): void
  /** あいさつの生成中かどうか（画面の「考えています」の表示）。 */
  setLoading(loading: boolean): void
  /** ⏹ 停止で呼ぶ中断関数の登録。終わったら null で外す。 */
  setAbort(abort: (() => void) | null): void
  /** 失敗の原因をログにだけ残す（吹き出しには出さない）。 */
  warn(detail: string): void
  /** いま開いているプロジェクト。返事を待つ間に切り替わったかを見るため、値でなく呼ぶたびに返す。 */
  currentDir(): string | null | undefined
}

export interface GreetingRun {
  apiKey: string
  model: string
  /** そのプロジェクトの文脈（ファイル一覧など）。まだ無ければ ''。 */
  projectContext: string
  /** あいさつを始めたプロジェクト。返事を待つ間に別のプロジェクトが開かれたら、会話へは何も当てない。 */
  dir: string
}

/**
 * あいさつを実行する。decideGreeting が 'fixed' か 'ai' を返した回にだけ呼ぶ。
 *
 * - キーが無い: 固定の一言を出すだけ。上限の確認も AI への要求もしない。
 * - 上限に達していて止める設定: 何も出さず、何も送らない。
 * - 止めない設定で上限を超えている: あいさつは出し、終わったあとに知らせを付け足す。
 *   途中の吹き出しの差し替えで消えないよう、控えておいて最後（finally）に出す。
 * - 利用量は、返事が最後まで来た回（時間切れを含む）にだけ記録する。例外で終わった回は記録しない。
 * - 会話への書き換えは、始めたプロジェクトがまだ開いているときだけ当てる（吹き出し・時間切れ文・失敗文・
 *   あとから足す知らせのすべて）。切り替わっていたら捨てる。開いているプロジェクトの会話を、
 *   別のプロジェクトのあいさつで置き換えないため。読み込み表示・中断の登録・利用量の記録は切り替わっても続ける。
 *   開いていない間に届いた分も、返事の全文を毎回送り直すので、戻ってくれば全文が出る。
 */
export async function runGreeting(run: GreetingRun, ports: GreetingPorts): Promise<void> {
  const { apiKey, model, projectContext, dir } = run
  const emit = (op: Op): void => { if (ports.currentDir() === dir) ports.applyOp(op) }
  if (!apiKey) {
    emit({ kind: 'replaceAll', messages: [{ role: 'assistant', content: GREETING_FIXED_TEXT }] })
    return
  }
  const budget = ports.checkBeforeRequest(apiKey)
  if (!budget.allowed) return
  const budgetWarning = budget.warning
  ports.setLoading(true)
  const kickoff = GREETING_KICKOFF
  const sys = IDE_CONTEXT + (projectContext ? '\n\n' + projectContext : '')
  try {
    let text = ''
    // 吹き出しの差し替えは append ではなく replaceAll にする。時刻の刻印を付ける経路を通ると、
    // この吹き出しにだけ時刻表示が新しく出てしまう。
    emit({ kind: 'replaceAll', messages: [{ role: 'user', content: kickoff, hidden: true }, { role: 'assistant', content: '' }] })
    // 時間切れは例外ではなく timedOut で返るので、受け取らないと空の吹き出しのまま終わる。
    const { usage, timedOut } = await ports.chatStream(
      {
        apiKey,
        model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: kickoff }],
        maxTokens: GREETING_MAX_TOKENS,
      },
      (delta) => {
        text += delta
        emit({ kind: 'replaceAll', messages: [{ role: 'user', content: kickoff, hidden: true }, { role: 'assistant', content: text }] })
      },
      (abort) => { ports.setAbort(abort) },
    )
    if (timedOut) {
      emit({ kind: 'replaceAll', messages: [{ role: 'assistant', content: GREETING_TIMED_OUT_TEXT }] })
    }
    ports.recordUsage(apiKey, model, usage?.prompt_tokens ?? ports.estimateTokens(sys + kickoff), usage?.completion_tokens ?? ports.estimateTokens(text))
  } catch (e: any) {
    ports.warn(formatChatError(stripRemoteHead(e), 'sakura', e))
    emit({ kind: 'replaceAll', messages: [{ role: 'assistant', content: GREETING_FAILED_TEXT }] })
  } finally {
    ports.setAbort(null)
    ports.setLoading(false)
    if (budgetWarning) emit({ kind: 'append', msg: { role: 'assistant', toolNote: true, content: budgetWarning } })
  }
}
