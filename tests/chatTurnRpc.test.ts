import { describe, it, expect } from 'vitest'
import { ASK_PATHS, type AskPath } from '../src/shared/chatTurnRpc'
import type { EngineTurnPorts, TurnHelpers } from '../src/shared/chatTurn'

// ASK_PATHS の表が、chatTurn.ts の EngineTurnPorts と過不足なく対応していることを固定する
// （B'-3b・仕様書テスト2）。
//
// ── なぜこの形か ─────────────────────────────────────────────────────
// EngineTurnPorts のうち main が直接持つもの（emit/setAbort/notifyActivity/chatStream/
// chatOnce/usage.estimate/h、B'-3d-1a で main 化した toolSupport.*/vision.*、B'-3d-1b で
// main 化した usage.check/usage.record/compactWarnOnce を含む）**以外**は、全部 ASK_PATHS に
// 載っていなければならない（載っていないと turnRunner.ts は ask のしようがなく main 実装が
// 組めない）。逆に ASK_PATHS に載っているのに EngineTurnPorts に無い名前があっても事故のもとになる。
//
// 下のダミー実装は EngineTurnPorts 型で宣言してあるので、EngineTurnPorts にメンバーが
// 増えたのにここへ足し忘れると `npx tsc -p tsconfig.main.json --noEmit`（またはエディタの
// 型チェック）がコンパイルエラーにする。そのうえで、実際に全メンバーを呼び出して
// 「asked（ASK_PATHS 対象）」「direct（main が直接持つ）」に振り分け、**ASK_PATHS の中身とは
// 独立に書いたこの呼び出し列**と突き合わせる（掟10: ASK_PATHS から1つ消すミューテーション試験で、
// ASK_PATHS 自身から期待値を作っていないことを確かめてある）。

/**
 * main が直接持つもの（仕様書のリストそのまま）。ここに無いものは全部 ASK_PATHS のはず。
 *
 * B'-3d-1a: toolSupport.shouldSendTools / toolSupport.isKnownToolCapable / toolSupport.record /
 * vision.shouldTryDirect / vision.record / vision.defaultModel の6つは、学習キャッシュの
 * 持ち主が main の learningStore.ts へ移ったことで ASK_PATHS から direct 側へ移った。
 *
 * B'-3d-1b: usage.check / usage.record / compactWarnOnce の3つは、予算・利用実績の持ち主が
 * main の usageStore.ts（＋モジュール内 Set）へ移ったことで ASK_PATHS から direct 側へ移った
 * （ASK_PATHS は 12本 → 9本）。
 *
 * B'-3d-2b: executeTool は、本体（shared/toolExecCore.ts の executeToolCore）を main が
 * 直呼びするようになったことで ASK_PATHS から direct 側へ移った（ASK_PATHS は 9本 → 8本）。
 */
const DIRECT_PATHS = [
  'emit', 'setAbort', 'notifyActivity', 'chatStream', 'chatOnce', 'usage.estimate', 'h',
  'toolSupport.shouldSendTools', 'toolSupport.isKnownToolCapable', 'toolSupport.record',
  'vision.shouldTryDirect', 'vision.record', 'vision.defaultModel',
  'usage.check', 'usage.record', 'compactWarnOnce',
  'executeTool',
]

describe('ASK_PATHS ⇄ EngineTurnPorts', () => {
  it('EngineTurnPorts の全メンバーのうち、direct 以外は ASK_PATHS に、direct は DIRECT_PATHS に、過不足なく載っている', async () => {
    const seen: string[] = []
    const mark = (path: string) => (..._args: any[]) => { seen.push(path); return undefined }

    const dummyH = {} as TurnHelpers // h 自体は「direct」の1メンバーとして扱う（呼び出さない）

    // turnRunner.ts が実際に組み立てる mainPorts と同じ形を、EngineTurnPorts 型で宣言する。
    const ports: EngineTurnPorts = {
      emit: mark('emit'),
      chatStream: mark('chatStream'),
      chatOnce: mark('chatOnce'),
      getHistory: mark('getHistory'),
      buildSystemPrompt: mark('buildSystemPrompt'),
      onUserMessage: mark('onUserMessage'),
      approveToolCall: mark('approveToolCall'),
      executeTool: mark('executeTool'),
      buildRagBlock: mark('buildRagBlock'),
      getSearchConfig: mark('getSearchConfig'),
      fetchPagesBlock: mark('fetchPagesBlock'),
      autoSearchBlock: mark('autoSearchBlock'),
      notifyActivity: mark('notifyActivity'),
      setAbort: mark('setAbort'),
      usage: {
        check: mark('usage.check'),
        record: mark('usage.record'),
        estimate: mark('usage.estimate'),
      },
      toolSupport: {
        shouldSendTools: mark('toolSupport.shouldSendTools'),
        isKnownToolCapable: mark('toolSupport.isKnownToolCapable'),
        record: mark('toolSupport.record'),
      },
      vision: {
        shouldTryDirect: mark('vision.shouldTryDirect'),
        record: mark('vision.record'),
        defaultModel: mark('vision.defaultModel'),
      },
      compactWarnOnce: mark('compactWarnOnce'),
      h: dummyH,
    }

    // 呼べるものは全部呼ぶ（h は関数ではないので呼ばない＝'h' は下で手動加算する）。
    ports.emit({} as any)
    await ports.chatStream({} as any, () => {}, () => {}, () => {})
    await ports.chatOnce({} as any)
    await ports.getHistory()
    await ports.buildSystemPrompt()
    await ports.onUserMessage?.('text', true)
    await ports.approveToolCall?.('name', 'args')
    await ports.executeTool('name', 'args', {})
    await ports.buildRagBlock?.('text')
    await ports.getSearchConfig()
    await ports.fetchPagesBlock([])
    await ports.autoSearchBlock('text', null)
    ports.notifyActivity()
    ports.setAbort(null)
    await ports.usage.check()
    await ports.usage.record('model', 0, 0)
    await ports.usage.estimate('text')
    await ports.toolSupport.shouldSendTools('model')
    await ports.toolSupport.isKnownToolCapable('model')
    await ports.toolSupport.record('model', true)
    await ports.vision.shouldTryDirect('model')
    await ports.vision.record('model', true)
    await ports.vision.defaultModel()
    await ports.compactWarnOnce()
    seen.push('h') // h は呼び出しではなく値なので、ここで手動計上する

    const direct = seen.filter((p) => DIRECT_PATHS.includes(p))
    const asked = seen.filter((p) => !DIRECT_PATHS.includes(p))

    // direct（この呼び出し列側）と DIRECT_PATHS（仕様書のリスト）が一致する
    expect(direct.slice().sort()).toEqual(DIRECT_PATHS.slice().sort())
    // asked（この呼び出し列側。ASK_PATHS の中身を1文字も参照していない）と ASK_PATHS の中身が一致する
    expect(asked.slice().sort()).toEqual((ASK_PATHS as readonly string[]).slice().sort())
    // 重複が無いこと（同じ名前を2回書いていないか）
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('AskPath 型は ASK_PATHS の要素と一致する（型レベルの往復）', () => {
    // 型注釈が通ること自体が確認（実行時のアサーションは無い）。
    // B'-3d-2b: executeTool は main 直呼びになり ASK_PATHS から外れたため、
    // 別の（今も ask のままの）path で型の往復を確認する。
    const p: AskPath = 'approveToolCall'
    expect(ASK_PATHS).toContain(p)
  })

  it('ASK_PATHS に重複が無い', () => {
    expect(new Set(ASK_PATHS).size).toBe(ASK_PATHS.length)
  })
})
