import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 掟6: IPC は main／preload.ts／renderer/global.d.ts の3点セットを同時に更新する。
// projectOps:get・projectOps:ack と押し出し projectOps:changed（src/main/ipc/projectOps.ts）が、
// 3つとも揃い、起動時の登録（ipc/index.ts の registerAllHandlers）から呼ばれていることを固定する。
// 振る舞い（get・ack・押し出しが実際に動くこと）は tests/projectOpsHandlers.test.ts が本物のハンドラで固定している。
// ここは「配線が切れていない」ことだけを、当て先が他の行に出ないよう関数の本体・ブロックごとに切り出して見る。

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf-8')
const codeOnly = (src: string) => src.split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')

describe('IPC の3点セット（掟6）: projectOps:get / projectOps:ack / projectOps:changed', () => {
  const ipc = codeOnly(read('src/main/ipc/projectOps.ts'))
  const preload = codeOnly(read('src/main/preload.ts'))
  const dts = read('src/renderer/global.d.ts')

  /** `projectOps: {` から、閉じの `  },`（preload の2段インデント）までを切り出す。 */
  const preloadBlock = (() => {
    const at = preload.indexOf('  projectOps: {')
    expect(at, 'preload に projectOps が無い').toBeGreaterThan(0)
    return preload.slice(at, preload.indexOf('\n  },', at))
  })()

  it('main: 2つの ipcMain.handle と、押し出し（sendToWindow で projectOps:changed）', () => {
    expect(ipc).toContain("ipcMain.handle('projectOps:get'")
    expect(ipc).toContain("ipcMain.handle('projectOps:ack'")
    expect(ipc).toContain("sendToWindow(deps.getMainWindow(), 'projectOps:changed', { projectDir, ...snapshot })")
  })

  it('preload: get・ack は invoke、onChanged は購読して解除関数を返す', () => {
    expect(preloadBlock).toContain("get: (projectDir: string) => ipcRenderer.invoke('projectOps:get', projectDir)")
    expect(preloadBlock).toContain("ack: (projectDir: string, upToStartedAt?: number) => ipcRenderer.invoke('projectOps:ack', projectDir, upToStartedAt)")
    expect(preloadBlock).toContain("ipcRenderer.on('projectOps:changed', handler)")
    expect(preloadBlock).toContain("return () => ipcRenderer.removeListener('projectOps:changed', handler)")
  })

  it('global.d.ts: window.electronAPI.projectOps の3つの口（型は main の定義を import して使う）', () => {
    const at = dts.indexOf('    projectOps: {')
    expect(at, 'global.d.ts に projectOps が無い').toBeGreaterThan(0)
    const block = dts.slice(at, dts.indexOf('\n    }\n', at))
    expect(block).toContain('get(projectDir: string): Promise<ProjectOpsSnapshotShape>')
    expect(block).toContain('ack(projectDir: string, upToStartedAt?: number): Promise<')
    expect(block).toContain('onChanged(cb: (p: { projectDir: string } & ProjectOpsSnapshotShape) => void): () => void')
    expect(dts).toContain("type ProjectOpsSnapshotShape = import('../main/projectOps').ProjectOpsSnapshot")
    expect(dts).toContain("type ProjectOpRecordShape = import('../main/projectOps').ProjectOpRecord")
  })

  it('ipc/index.ts: registerAllHandlers の本体から registerProjectOpsHandlers(deps) が呼ばれている（import だけでは呼ばれない）', () => {
    const index = codeOnly(read('src/main/ipc/index.ts'))
    expect(index).toContain("import { registerProjectOpsHandlers } from './projectOps'")
    const body = index.slice(index.indexOf('export function registerAllHandlers'))
    expect(body).toContain('  registerProjectOpsHandlers(deps)\n')
  })
})

describe('進捗の送り口は1つ（progressReporter）: renderer へ進捗を送っていた5本は、送り口をこれに通している', () => {
  // 進捗を event.sender.send で送っていた5本（cloud:apply・vercel:publish・専有型の teardown／publishApp／teardownApp）が、
  // 直接 send せず progressReporter を通す（記録の更新と renderer への通知を1か所に）。直接 send に戻ると、
  // 画面は進み具合を読めなくなる（記録が更新されない）。
  // cloud.ts には鍵の外の cloud:cleanupImages があり、あれは記録の対象外（9本に入らない）なので、ハンドラごとに切り出して見る。
  const blockOf = (file: string, channel: string): string => {
    const src = codeOnly(read(file))
    const at = src.indexOf(`ipcMain.handle('${channel}'`)
    expect(at, `${file} に ${channel} が無い`).toBeGreaterThan(0)
    const next = src.indexOf("\n  ipcMain.handle('", at + 10)
    return src.slice(at, next > 0 ? next : undefined)
  }
  const SENDERS: Array<[string, string, string]> = [
    ['src/main/ipc/cloud.ts', 'cloud:apply', "progressReporter(projectDir, msg => event.sender.send('cloud:apply-progress', msg))"],
    ['src/main/ipc/vercel.ts', 'vercel:publish', "progressReporter(projectDir, m => event.sender.send('vercel:progress', m))"],
    ['src/main/ipc/apprunDedicated.ts', 'apprunDedicated:teardown', "progressReporter(projectDir, msg => event.sender.send('apprunDedicated:teardown-progress', msg))"],
    ['src/main/ipc/apprunDedicated.ts', 'apprunDedicated:publishApp', "progressReporter(projectDir, msg => event.sender.send('apprunDedicated:publish-progress', msg))"],
    ['src/main/ipc/apprunDedicated.ts', 'apprunDedicated:teardownApp', "progressReporter(projectDir, msg => event.sender.send('apprunDedicated:teardown-progress', msg))"],
  ]
  for (const [file, channel, call] of SENDERS) {
    it(`${channel}: 進捗は ${call.slice(0, 40)}… を通し、直接 send しない`, () => {
      const block = blockOf(file, channel)
      expect(block).toContain(`const progress = ${call}`)
      // event.sender.send はその1行にしか無い（try { event.sender.send(...) } の直接送信が残っていない）
      expect(block.split('event.sender.send(').length - 1).toBe(1)
    })
  }
})
