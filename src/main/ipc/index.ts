// 全ドメインの IPC ハンドラを一括登録する入口。main.ts はこれだけを呼ぶ。
// deps（mainWindow・未保存状態など main.ts の共有状態）は types.ts の IpcDeps 型で受ける。
import type { IpcDeps } from './types'
import { registerWindowHandlers } from './window'
import { registerShellHandlers } from './shell'
import { registerWebHandlers } from './web'
import { registerRemoteHandlers } from './remote'
import { registerFsHandlers } from './fs'
import { registerSakuraHandlers } from './sakura'
import { registerSecureHandlers } from './secure'
import { registerCloudKeysHandlers } from './cloudKeys'
import { registerCloudHandlers } from './cloud'
import { registerHanamiiHandlers } from './hanamii'
import { registerVercelHandlers } from './vercel'
import { registerVpsHandlers } from './vps'
import { registerRagHandlers } from './rag'
import { registerTermHandlers } from './term'
import { registerBackupHandlers } from './backup'
import { registerGithubHandlers } from './github'
import { registerClaudeHandlers } from './claude'
import { registerChatStoreHandlers } from './chatStore'

export type { IpcDeps } from './types'

export function registerAllHandlers(deps: IpcDeps) {
  registerWindowHandlers(deps)
  registerShellHandlers(deps)
  registerWebHandlers(deps)
  registerRemoteHandlers(deps)
  registerFsHandlers(deps)
  registerSakuraHandlers(deps)
  registerSecureHandlers(deps)
  registerCloudKeysHandlers(deps)
  registerCloudHandlers(deps)
  registerHanamiiHandlers(deps)
  registerVercelHandlers(deps)
  registerVpsHandlers(deps)
  registerRagHandlers(deps)
  registerTermHandlers(deps)
  registerBackupHandlers(deps)
  registerGithubHandlers(deps)
  registerClaudeHandlers(deps)
  registerChatStoreHandlers(deps)
}
