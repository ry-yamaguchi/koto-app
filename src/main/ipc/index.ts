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
import { registerPublishImportHandlers } from './publishImport'
import { registerVpsHandlers } from './vps'
import { registerRagHandlers } from './rag'
import { registerTermHandlers } from './term'
import { registerBackupHandlers } from './backup'
import { registerGithubHandlers } from './github'
import { registerClaudeHandlers } from './claude'
import { registerChatStoreHandlers } from './chatStore'
import { registerUpdateHandlers } from './update'
import { registerMigrateHandlers } from './migrate'
import { registerLearningHandlers } from './learning'
import { registerUsageHandlers } from './usage'
import { registerApprovalHandlers } from './approval'
import { registerAppSessionsHandlers } from './appSessions'
import { registerChatTurnHandlers } from '../chat/turnRunner'

export type { IpcDeps } from './types'

export function registerAllHandlers(deps: IpcDeps) {
  registerWindowHandlers(deps)
  registerMigrateHandlers()
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
  registerPublishImportHandlers(deps)
  registerVpsHandlers(deps)
  registerRagHandlers(deps)
  registerTermHandlers(deps)
  registerBackupHandlers(deps)
  registerGithubHandlers(deps)
  registerClaudeHandlers(deps)
  registerChatStoreHandlers(deps)
  registerUpdateHandlers(deps)
  registerLearningHandlers(deps)
  registerUsageHandlers(deps)
  registerApprovalHandlers(deps)
  registerAppSessionsHandlers(deps)
  registerChatTurnHandlers(deps)
}
