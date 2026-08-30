import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { ASK_PATHS } from '../src/shared/chatTurnRpc'

// B'-3d-1b: 予算・利用実績（usage.check/usage.record）と compactWarnOnce の持ち主が
// renderer の localStorage / ask から main（usageStore.ts・モジュール内 Set）へ移った配線を
// 固定する（tests/learningWiring.test.ts と同じ readCode 流儀）。
//
// ⚠️ コメントを外してから判定する（tests/untrustedBlockWiring.test.ts 冒頭の説明を読んだうえで
// 書いている: このテストファイル自身の中で `\n` を書く箇所は、ソースの生テキストとしての
// `\n`（バックスラッシュ+n の2文字）と、実際の改行とを区別する。ここでは対象ソース側に
// `\n` を含む文字列リテラルの一致判定が無いため、その罠には触れない。念のため各 must/mustNot
// は実装直後に `grep -n` 相当で対象ファイル内に実在すること／存在しないことを確認済み
// （掟10: 当て先が他の行に出ないかの確認）。

const readCode = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

describe('turnRunner.ts: usage.*/compactWarnOnce はもう bridge.ask ではない', () => {
  const src = readCode('src/main/chat/turnRunner.ts')

  it("bridge.ask('usage.check' / bridge.ask('usage.record' / bridge.ask('compactWarnOnce' が残っていない", () => {
    expect(src).not.toContain("bridge.ask('usage.check'")
    expect(src).not.toContain("bridge.ask('usage.record'")
    expect(src).not.toContain("bridge.ask('compactWarnOnce'")
  })

  it('usageStore（main）+ shared/usageBudget（純関数）から直接呼んでいる', () => {
    expect(src).toContain("import { hashKey } from '../../shared/usageBudget'")
    expect(src).toContain("import { checkBeforeRequest, recordUsage } from '../usageStore'")
    expect(src).toContain('check: () => checkBeforeRequest(hashKey(payload.spec.apiKey)),')
    expect(src).toContain('record: (model, promptTokens, completionTokens) => recordUsage(hashKey(payload.spec.apiKey), model, promptTokens, completionTokens),')
  })

  it('compactWarnOnce が Set ベースで main に直接持たれている', () => {
    expect(src).toContain('const compactWarned = new Set<string>()')
    expect(src).toContain('if (compactWarned.has(key)) return false')
    expect(src).toContain('compactWarned.add(key)')
    expect(src).toContain('export function resetCompactWarnedForTest(): void {')
  })
})

describe('shared/chatTurnRpc.ts: ASK_PATHS から usage.*/compactWarnOnce が消え、9本になっている', () => {
  const src = readCode('src/shared/chatTurnRpc.ts')

  it('3つの ask path 文字列がどれも残っていない', () => {
    expect(src).not.toContain("'usage.check'")
    expect(src).not.toContain("'usage.record'")
    expect(src).not.toContain("'compactWarnOnce'")
  })

  it('ASK_PATHS は9本（B\'-3d-1a で12本→本ステップでさらに3本減って9本）', () => {
    expect(ASK_PATHS).toHaveLength(9)
    expect(ASK_PATHS).toEqual([
      'executeTool', 'approveToolCall', 'buildSystemPrompt', 'getHistory', 'onUserMessage',
      'buildRagBlock', 'getSearchConfig', 'fetchPagesBlock', 'autoSearchBlock',
    ])
  })
})

describe('renderer/chatTurnBridge.ts: dispatchAsk に usage.*/compactWarnOnce の case が無い', () => {
  const src = readCode('src/renderer/chatTurnBridge.ts')

  it("case 'usage.check' / case 'usage.record' / case 'compactWarnOnce' が残っていない", () => {
    expect(src).not.toContain("case 'usage.check'")
    expect(src).not.toContain("case 'usage.record'")
    expect(src).not.toContain("case 'compactWarnOnce'")
  })
})

describe('renderer/hooks/useAiChat.ts: handlers に usage.*/compactWarnOnce が渡っていない', () => {
  const src = readCode('src/renderer/hooks/useAiChat.ts')

  it('usageCheck: / usageRecord: / compactWarnOnce: ports.compactWarnOnce の受け渡しが無い', () => {
    expect(src).not.toContain('usageCheck:')
    expect(src).not.toContain('usageRecord:')
    // ⚠️ 'compactWarnOnce:' 単独では buildPorts 側の定義（compactWarnOnce: () => {）にも
    // 当たってしまう（それは残ってよい・compactNow が使う）。handlers への受け渡し
    // （compactWarnOnce: ports.compactWarnOnce,）だけを狙い撃つ（掟10: 当て先の確認）。
    expect(src).not.toContain('compactWarnOnce: ports.compactWarnOnce,')
  })

  it('buildPorts の usage / compactWarnOnce メンバー自体は残っている（compactNow が使う）', () => {
    expect(src).toContain('usage: {')
    expect(src).toContain('compactWarnOnce: () => {')
  })
})

describe('main/ipc/index.ts: registerUsageHandlers が登録されている', () => {
  const src = readCode('src/main/ipc/index.ts')

  it('import と呼び出しの両方がある', () => {
    expect(src).toContain("import { registerUsageHandlers } from './usage'")
    expect(src).toContain('registerUsageHandlers(deps)')
  })
})

describe('main/ipc/usage.ts: before-quit フラッシュがある', () => {
  const src = readCode('src/main/ipc/usage.ts')

  it("app.on('before-quit', () => flushUsageNow()) がある", () => {
    expect(src).toContain("app.on('before-quit', () => flushUsageNow())")
  })
})

describe('preload.ts / global.d.ts: usage の3点セットがある', () => {
  const preload = readCode('src/main/preload.ts')
  const dts = readCode('src/renderer/global.d.ts')

  it('preload.ts が usage:* を invoke している', () => {
    expect(preload).toContain("get: () => ipcRenderer.invoke('usage:get')")
    expect(preload).toContain("record: (fp: string, model: string, promptTokens: number, completionTokens: number) =>")
    expect(preload).toContain("ipcRenderer.invoke('usage:record', fp, model, promptTokens, completionTokens)")
    expect(preload).toContain("setSettings: (raw: unknown) => ipcRenderer.invoke('usage:setSettings', raw)")
    expect(preload).toContain("setKeyLimit: (fp: string, limit: number | null | { clear: true }) => ipcRenderer.invoke('usage:setKeyLimit', fp, limit)")
    expect(preload).toContain("reset: () => ipcRenderer.invoke('usage:reset')")
    expect(preload).toContain("migrate: (payload: { settings?: unknown; months?: unknown }) => ipcRenderer.invoke('usage:migrate', payload)")
    expect(preload).toContain("ipcRenderer.on('usage:changed', handler)")
  })

  it('global.d.ts に usage の型宣言がある', () => {
    expect(dts).toContain('record(fp: string, model: string, promptTokens: number, completionTokens: number): Promise<void>')
    expect(dts).toContain('setKeyLimit(fp: string, limit: number | null | { clear: true }): Promise<void>')
    expect(dts).toContain('migrate(payload: { settings?: unknown; months?: unknown }): Promise<void>')
  })
})

describe('App.tsx: primeUsageMirror() を呼んでいる', () => {
  const src = readCode('src/renderer/App.tsx')

  it("import と呼び出しの両方がある", () => {
    expect(src).toContain("import { primeUsageMirror } from './usageMirror'")
    expect(src).toContain('primeUsageMirror()')
  })
})

describe('renderer/usage.ts: recordUsage が旧 localStorage 直書きへ戻っていない', () => {
  const src = readCode('src/renderer/usage.ts')

  it('USAGE_KEY 直接参照の writeStore が無い（main のミラー経由になっている）', () => {
    expect(src).not.toContain('USAGE_KEY')
    expect(src).not.toContain('function writeStore')
    expect(src).not.toContain("localStorage.setItem('sakura_usage_by_month'")
    expect(src).not.toContain("localStorage.setItem('sakura_budget_settings'")
  })

  it('recordUsage はミラーの楽観更新＋ IPC fire-and-forget の形になっている', () => {
    expect(src).toContain('applyRecordToMirror(fp, model, promptTokens, completionTokens)')
    expect(src).toContain('window.electronAPI.usage.record(fp, model, promptTokens, completionTokens)')
  })
})
